const http = require("http");
const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");
const { Routes } = require("discord.js");
const { listAssets, saveAssetBuffer, ASSET_DEDUPE_LOG_PATH } = require("../assets/library");
const { listMobileAssets, addMobileAsset } = require("../assets/mobile-library");

const SESSION_COOKIE = "lyva_dash_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24;
const MAX_JSON_BYTES = toInt(process.env.DASHBOARD_MAX_JSON_BYTES, 35 * 1024 * 1024);
const MAX_UPLOAD_FILES = toInt(process.env.DASHBOARD_MAX_UPLOAD_FILES, 10);
const MAX_UPLOAD_BYTES_PER_FILE = toInt(process.env.DASHBOARD_MAX_UPLOAD_BYTES_PER_FILE, 15 * 1024 * 1024);
const SELF_UPDATE_ENABLED = process.env.DASHBOARD_ALLOW_SELF_UPDATE === "true";
const SELF_UPDATE_BRANCH = String(process.env.DASHBOARD_REPO_BRANCH || "main").trim();
const SELF_UPDATE_APP_DIR = String(process.env.DASHBOARD_APP_DIR || process.cwd()).trim();
const SELF_UPDATE_LOG_PATH = String(
  process.env.DASHBOARD_SELF_UPDATE_LOG_PATH || path.join(process.cwd(), "data", "dashboard-self-update.log"),
).trim();
const MEMBER_PAGE_TITLE = String(process.env.MEMBER_PAGE_TITLE || "LYVA Member Hub").trim();
const MEMBER_DISCORD_URL = String(process.env.MEMBER_DISCORD_URL || "").trim();
const MEMBER_PROMO_URL = String(process.env.MEMBER_PROMO_URL || "https://lyvaindonesia.com").trim();
const PUBLIC_PREVIEW_DIR = path.join(process.cwd(), "assets", "previews");
const PUBLIC_PREVIEW_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

function toInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function readCookies(cookieHeader = "") {
  const cookies = {};
  String(cookieHeader || "")
    .split(";")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .forEach((pair) => {
      const idx = pair.indexOf("=");
      if (idx === -1) return;
      const key = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      cookies[key] = decodeURIComponent(value);
    });
  return cookies;
}

function readJsonBody(req, maxBytes = MAX_JSON_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error(`Payload terlalu besar. Maks ${Math.floor(maxBytes / (1024 * 1024))} MB.`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        if (!text) {
          resolve({});
          return;
        }
        resolve(JSON.parse(text));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendHtml(res, status, html) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function sendBinary(res, status, buffer, headers = {}) {
  res.writeHead(status, headers);
  res.end(buffer);
}

function safeSingleQuote(value) {
  return String(value || "").replace(/'/g, "'\\''");
}

async function ensureParentDir(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

function isSafeBranchName(branch) {
  return /^[A-Za-z0-9._/-]+$/.test(branch);
}

async function appendSelfUpdateLog(message) {
  await ensureParentDir(SELF_UPDATE_LOG_PATH);
  await fs.appendFile(SELF_UPDATE_LOG_PATH, `${message}\n`, "utf8");
}

async function readSelfUpdateLogTail(maxLines = 120) {
  try {
    const raw = await fs.readFile(SELF_UPDATE_LOG_PATH, "utf8");
    const lines = raw.split(/\r?\n/).filter(Boolean);
    return lines.slice(Math.max(0, lines.length - maxLines)).join("\n");
  } catch {
    return "";
  }
}

async function readAssetDedupeLogTail(maxLines = 120) {
  try {
    const raw = await fs.readFile(ASSET_DEDUPE_LOG_PATH, "utf8");
    const lines = raw.split(/\r?\n/).filter(Boolean);
    return lines.slice(Math.max(0, lines.length - maxLines)).join("\n");
  } catch {
    return "";
  }
}

async function triggerSelfUpdate() {
  if (!SELF_UPDATE_ENABLED) {
    throw new Error("Self update belum diaktifkan. Set DASHBOARD_ALLOW_SELF_UPDATE=true.");
  }
  if (!isSafeBranchName(SELF_UPDATE_BRANCH)) {
    throw new Error("DASHBOARD_REPO_BRANCH tidak valid.");
  }

  const startedAt = new Date().toISOString();
  await appendSelfUpdateLog(`[${startedAt}] self-update requested via dashboard`);

  const script = `#!/usr/bin/env bash
set -e
{
  echo "[${startedAt}] start update"
  cd '${safeSingleQuote(SELF_UPDATE_APP_DIR)}'
  git pull --ff-only origin '${safeSingleQuote(SELF_UPDATE_BRANCH)}'
  npm ci
  npm run deploy:guild || true
  pm2 restart lyva-bot --update-env
  pm2 save
  echo "[$(date -Iseconds)] update done"
} >> '${safeSingleQuote(SELF_UPDATE_LOG_PATH)}' 2>&1`;

  const scriptPath = path.join(process.cwd(), "data", "dashboard-self-update.sh");
  await ensureParentDir(scriptPath);
  await fs.writeFile(scriptPath, script, { encoding: "utf8", mode: 0o700 });

  const child = spawn("bash", [scriptPath], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  return {
    startedAt,
    branch: SELF_UPDATE_BRANCH,
    appDir: SELF_UPDATE_APP_DIR,
    logPath: SELF_UPDATE_LOG_PATH,
  };
}

function sanitizeText(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function toAssetContentType(fileName) {
  const ext = String(path.extname(fileName || "")).toLowerCase();
  if (ext === ".rbxm" || ext === ".rbxmx") return "application/octet-stream";
  if (ext === ".lua" || ext === ".luau" || ext === ".txt") return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

function toImageContentType(fileName) {
  const ext = String(path.extname(fileName || "")).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "application/octet-stream";
}

function toCanonicalAssetKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[^a-z0-9]/g, "");
}

async function loadPreviewLookup() {
  await fs.mkdir(PUBLIC_PREVIEW_DIR, { recursive: true });
  const entries = await fs.readdir(PUBLIC_PREVIEW_DIR, { withFileTypes: true });
  const map = new Map();

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = String(path.extname(entry.name || "")).toLowerCase();
    if (!PUBLIC_PREVIEW_EXTENSIONS.has(ext)) continue;
    const base = path.basename(entry.name, ext);
    const key = toCanonicalAssetKey(base);
    if (!key || map.has(key)) continue;
    map.set(key, entry.name);
  }
  return map;
}

function findPreviewFileName(previewLookup, candidates = []) {
  for (const candidate of candidates) {
    const key = toCanonicalAssetKey(candidate);
    if (!key) continue;
    if (previewLookup.has(key)) return previewLookup.get(key);
  }
  return "";
}

function buildPage({ appName, authed }) {
  const safeName = sanitizeText(appName || "LYVA Dashboard");
  return `<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safeName}</title>
  <style>
    @import url("https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800;900&display=swap");
    :root {
      --bg: #0c1221;
      --bg-2: #121b32;
      --panel: #151f37;
      --panel-soft: #192546;
      --line: #2a3b69;
      --text: #e9f0ff;
      --muted: #95a7d4;
      --brand: #22c55e;
      --brand-2: #38bdf8;
      --warn: #f59e0b;
      --danger: #ef4444;
      --purple: #7c3aed;
    }
    * { box-sizing: border-box; margin: 0; }
    body {
      font-family: "Nunito", "Segoe UI", Tahoma, sans-serif;
      color: var(--text);
      background:
        radial-gradient(1200px 600px at 8% -20%, #2f3f7a 0%, transparent 60%),
        radial-gradient(1000px 600px at 110% 0%, #173e66 0%, transparent 55%),
        var(--bg);
      min-height: 100vh;
    }
    .wrap { max-width: 1320px; margin: 0 auto; padding: 18px; }
    .hidden { display: none !important; }
    .panel {
      background: linear-gradient(180deg, var(--panel) 0%, var(--panel-soft) 100%);
      border: 1px solid var(--line);
      border-radius: 16px;
      box-shadow: 0 14px 34px rgba(0, 0, 0, 0.24);
    }
    .login-shell {
      max-width: 420px;
      margin: 9vh auto 0;
      padding: 18px;
      display: grid;
      gap: 12px;
    }
    .login-shell h2 {
      font-size: 24px;
      font-weight: 800;
      letter-spacing: 0.2px;
    }
    .sub { color: var(--muted); font-size: 14px; line-height: 1.5; }
    input {
      width: 100%;
      padding: 12px 14px;
      border: 1px solid var(--line);
      border-radius: 11px;
      background: #0f1730;
      color: var(--text);
      outline: none;
    }
    input:focus { border-color: #4f79d6; box-shadow: 0 0 0 3px rgba(79, 121, 214, .2); }
    button {
      border: 0;
      border-radius: 12px;
      padding: 11px 14px;
      font-weight: 800;
      letter-spacing: .2px;
      cursor: pointer;
      color: #0b1220;
      background: var(--brand);
      transition: transform .15s ease, filter .15s ease;
    }
    button:hover { filter: brightness(1.05); transform: translateY(-1px); }
    button.secondary { background: var(--brand-2); }
    button.warn { background: var(--warn); }
    button.danger { background: var(--danger); color: #fff; }
    .log {
      margin-top: 4px;
      font-size: 13px;
      color: var(--muted);
      white-space: pre-wrap;
      background: #0e172c;
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 12px;
      min-height: 82px;
    }
    .app-shell {
      display: grid;
      grid-template-columns: 250px minmax(0, 1fr);
      gap: 14px;
    }
    .sidebar {
      padding: 16px;
      min-height: calc(100vh - 36px);
      position: sticky;
      top: 18px;
      display: grid;
      grid-template-rows: auto auto 1fr auto;
      gap: 14px;
    }
    .brand-box {
      background: linear-gradient(135deg, #21408a, #7c3aed);
      border-radius: 14px;
      padding: 14px;
    }
    .brand-title { font-weight: 900; font-size: 18px; }
    .brand-sub { color: #dce7ff; font-size: 13px; margin-top: 4px; }
    .nav {
      display: grid;
      gap: 6px;
    }
    .nav-item {
      border: 1px solid var(--line);
      border-radius: 10px;
      background: #101a33;
      color: #d5e3ff;
      padding: 9px 11px;
      font-weight: 700;
      font-size: 13px;
    }
    .status-box {
      border: 1px dashed #4868b8;
      border-radius: 12px;
      padding: 10px;
      background: #101a32;
    }
    .topbar {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 12px;
    }
    .title {
      font-size: 26px;
      font-weight: 900;
      line-height: 1.2;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      border-radius: 999px;
      border: 1px solid var(--line);
      background: #101a33;
      color: #c9d8f8;
      font-size: 12px;
      font-weight: 700;
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: #9ca3af;
    }
    .dot.online { background: #22c55e; }
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
      margin-bottom: 12px;
    }
    .kpi-card {
      border-radius: 14px;
      padding: 12px;
      border: 1px solid var(--line);
      background: linear-gradient(180deg, #121e39 0%, #1b284a 100%);
    }
    .kpi-label { color: #a8badf; font-size: 12px; font-weight: 700; }
    .kpi-value { font-size: 24px; font-weight: 900; margin-top: 6px; letter-spacing: .2px; }
    .kpi-sub { color: #89a0d2; font-size: 12px; margin-top: 5px; }
    .content-grid {
      display: grid;
      grid-template-columns: 1.2fr .8fr;
      gap: 12px;
    }
    .block { padding: 14px; }
    .block h3 {
      font-size: 15px;
      margin-bottom: 10px;
      color: #d6e4ff;
      letter-spacing: .2px;
    }
    .row { display: flex; flex-wrap: wrap; gap: 9px; margin-bottom: 9px; }
    .row input { flex: 1; min-width: 180px; }
    .mini-chart {
      margin-top: 4px;
      display: grid;
      gap: 9px;
    }
    .bar-row { display: grid; grid-template-columns: 140px 1fr auto; gap: 8px; align-items: center; }
    .bar-label { font-size: 12px; color: #a4b8e5; font-weight: 700; }
    .bar {
      height: 9px;
      border-radius: 999px;
      background: #0f1a34;
      border: 1px solid #263a67;
      overflow: hidden;
    }
    .bar-fill {
      height: 100%;
      background: linear-gradient(90deg, #38bdf8, #7c3aed);
      width: 0%;
      transition: width .3s ease;
    }
    .bar-val { font-size: 12px; color: #9cb2dd; min-width: 70px; text-align: right; }
    .footer-note { font-size: 12px; color: #8ea5d4; }
    .upload-box {
      display: grid;
      gap: 9px;
      margin-top: 2px;
    }
    .upload-box input[type="file"] {
      background: #0c1730;
      border: 1px dashed #4a67ae;
      border-radius: 12px;
      padding: 10px;
      color: #afc2ef;
    }
    .asset-list {
      display: grid;
      gap: 7px;
      max-height: 290px;
      overflow: auto;
      margin-top: 6px;
      padding-right: 4px;
    }
    .asset-item {
      border: 1px solid #2b3f71;
      border-radius: 10px;
      padding: 9px 10px;
      background: #0e1932;
      font-size: 12px;
      color: #d8e5ff;
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 10px;
      align-items: center;
    }
    .asset-item small {
      color: #98b0e2;
      font-size: 11px;
    }
    @media (max-width: 1100px) {
      .kpi-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .content-grid { grid-template-columns: 1fr; }
    }
    @media (max-width: 840px) {
      .app-shell { grid-template-columns: 1fr; }
      .sidebar { min-height: auto; position: static; }
      .kpi-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <section id="loginView" class="panel login-shell ${authed ? "hidden" : ""}">
      <h2>${safeName}</h2>
      <p class="muted">Masuk pakai akun dashboard yang ada di .env</p>
      <div style="display:grid; gap:10px;">
        <input id="username" placeholder="Username" autocomplete="username" />
        <input id="password" type="password" placeholder="Password" autocomplete="current-password" />
        <button id="btnLogin">Masuk</button>
      </div>
      <div id="loginMsg" class="log"></div>
    </section>

    <section id="appView" class="${authed ? "" : "hidden"}">
      <div class="app-shell">
        <aside class="panel sidebar">
          <div class="brand-box">
            <div class="brand-title">${safeName}</div>
            <div class="brand-sub">Control panel bot Discord</div>
          </div>
          <div class="nav">
            <div class="nav-item">Overview</div>
            <div class="nav-item">Guild Commands</div>
            <div class="nav-item">AI Usage</div>
            <div class="nav-item">Asset Library</div>
          </div>
          <div class="status-box">
            <div class="sub">Status Runtime</div>
            <div id="sideStatus" style="font-size:18px;font-weight:900;margin-top:4px;">-</div>
            <div id="sideNode" class="sub" style="margin-top:2px;">Node -</div>
          </div>
          <div class="footer-note">
            Private mode dan budget AI tetap diatur lewat environment untuk keamanan.
          </div>
        </aside>

        <main>
          <div class="topbar">
            <div>
              <div class="title">Dashboard</div>
              <div class="sub" style="margin-top:3px;">Monitor bot, sinkronisasi command, dan cek penggunaan harian.</div>
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
              <div class="pill"><span id="dotReady" class="dot"></span><span id="pillReady">Bot -</span></div>
              <div class="pill"><span>Guild:</span><strong id="pillGuilds">0</strong></div>
              <div class="pill"><span>Uptime:</span><strong id="pillUptime">0m</strong></div>
            </div>
          </div>

          <div class="kpi-grid" id="statsGrid"></div>

          <div class="content-grid">
            <section class="panel block">
              <h3>Aksi Bot</h3>
              <div class="row">
                <button id="btnRefresh" class="secondary">Refresh Data</button>
                <button id="btnSyncAll">Sync Semua Guild</button>
                <button id="btnClearGlobal" class="warn">Clear Global</button>
                <button id="btnLogout" class="danger">Logout</button>
              </div>
              <div class="row">
                <input id="guildIdInput" placeholder="Guild ID untuk sync 1 guild" />
                <button id="btnSyncOne">Sync 1 Guild</button>
              </div>
              <div class="row">
                <button id="btnSelfUpdate" class="secondary">Update dari GitHub</button>
                <button id="btnSelfUpdateLog" class="secondary">Lihat Log Update</button>
              </div>
              <div id="actionLog" class="log"></div>
            </section>

            <section class="panel block">
              <h3>System Pulse</h3>
              <div class="mini-chart" id="pulseBars"></div>
              <div id="pulseNote" class="sub" style="margin-top:10px;"></div>
            </section>

            <section class="panel block">
              <h3>Asset Upload (Multi File)</h3>
              <div class="upload-box">
                <input id="assetFilesInput" type="file" multiple accept=".rbxm,.rbxmx,.lua,.luau,.txt" />
                <div class="row">
                  <button id="btnUploadFiles">Upload Semua File Terpilih</button>
                  <button id="btnReloadAssets" class="secondary">Refresh List Asset</button>
                  <button id="btnDedupeLog" class="secondary">Log Hapus Duplikat</button>
                </div>
                <div id="uploadLog" class="log"></div>
                <div id="assetList" class="asset-list"></div>
              </div>
            </section>

            <section class="panel block">
              <h3>Studio Lite ID</h3>
              <div class="upload-box">
                <div class="row">
                  <input id="studioLiteFeatureInput" placeholder="Nama fitur (contoh: Fly UI, Speed UI)" />
                  <input id="studioLiteIdInput" placeholder="Asset ID (angka)" />
                </div>
                <div class="row">
                  <button id="btnAddStudioLite">Tambah Studio Lite ID</button>
                  <button id="btnReloadStudioLite" class="secondary">Refresh List Studio Lite</button>
                </div>
                <div id="studioLiteLog" class="log"></div>
                <div id="studioLiteList" class="asset-list"></div>
              </div>
            </section>
          </div>
        </main>
      </div>
    </section>
  </div>

  <script>
    const isAuthed = ${authed ? "true" : "false"};
    const dashboardMaxUploadFiles = ${MAX_UPLOAD_FILES};
    const dashboardMaxUploadBytesPerFile = ${MAX_UPLOAD_BYTES_PER_FILE};
    const loginView = document.getElementById("loginView");
    const appView = document.getElementById("appView");
    const statsGrid = document.getElementById("statsGrid");
    const actionLog = document.getElementById("actionLog");
    const pulseBars = document.getElementById("pulseBars");
    const pulseNote = document.getElementById("pulseNote");
    const uploadLogBox = document.getElementById("uploadLog");
    const assetListBox = document.getElementById("assetList");
    const assetFilesInput = document.getElementById("assetFilesInput");
    const studioLiteLogBox = document.getElementById("studioLiteLog");
    const studioLiteListBox = document.getElementById("studioLiteList");
    const studioLiteFeatureInput = document.getElementById("studioLiteFeatureInput");
    const studioLiteIdInput = document.getElementById("studioLiteIdInput");

    function log(message) {
      if (!actionLog) return;
      const now = new Date().toLocaleTimeString();
      actionLog.textContent = "[" + now + "] " + message + "\\n" + actionLog.textContent;
    }

    function loginLog(message) {
      const box = document.getElementById("loginMsg");
      box.textContent = message;
    }

    function uploadLog(message) {
      if (!uploadLogBox) return;
      const now = new Date().toLocaleTimeString();
      uploadLogBox.textContent = "[" + now + "] " + message + "\\n" + uploadLogBox.textContent;
    }

    function studioLiteLog(message) {
      if (!studioLiteLogBox) return;
      const now = new Date().toLocaleTimeString();
      studioLiteLogBox.textContent = "[" + now + "] " + message + "\\n" + studioLiteLogBox.textContent;
    }

    function card(label, value, sub, tone) {
      const el = document.createElement("div");
      el.className = "kpi-card";
      const color = tone || "#e9f0ff";
      el.innerHTML =
        '<div class="kpi-label">' +
        label +
        "</div>" +
        '<div class="kpi-value" style="color:' +
        color +
        ';">' +
        value +
        "</div>" +
        '<div class="kpi-sub">' +
        (sub || "-") +
        "</div>";
      return el;
    }

    function ratio(value, max) {
      const n = Number(value || 0);
      const m = Number(max || 1);
      if (!Number.isFinite(n) || !Number.isFinite(m) || m <= 0) return 0;
      return Math.max(0, Math.min(100, Math.round((n / m) * 100)));
    }

    function pulseRow(label, val, max, suffix) {
      const pct = ratio(val, max);
      const row = document.createElement("div");
      row.className = "bar-row";
      row.innerHTML =
        '<div class="bar-label">' +
        label +
        "</div>" +
        '<div class="bar"><div class="bar-fill" style="width:' +
        pct +
        '%"></div></div>' +
        '<div class="bar-val">' +
        val +
        (suffix || "") +
        "</div>";
      return row;
    }

    async function api(path, options = {}) {
      const response = await fetch(path, {
        method: options.method || "GET",
        headers: { "Content-Type": "application/json" },
        body: options.body ? JSON.stringify(options.body) : undefined,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || ("HTTP " + response.status));
      }
      return data;
    }

    function fileToBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = String(reader.result || "");
          const commaIndex = result.indexOf(",");
          resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
        };
        reader.onerror = () => reject(new Error("Gagal membaca file: " + file.name));
        reader.readAsDataURL(file);
      });
    }

    async function refreshAssetList() {
      if (!assetListBox) return;
      try {
        const data = await api("/api/assets/list");
        const items = Array.isArray(data.items) ? data.items : [];
        if (items.length === 0) {
          assetListBox.innerHTML = '<div class="sub">Belum ada asset.</div>';
          return;
        }

        assetListBox.innerHTML = items
          .slice(0, 50)
          .map((item) =>
            '<div class="asset-item"><div><div>' +
              item.fileName +
              "</div><small>type: " +
              item.type +
              " | size: " +
              item.sizeLabel +
              '</small></div><small>' +
              item.id +
              "</small></div>",
          )
          .join("");
      } catch (error) {
        assetListBox.innerHTML = '<div class="sub">Gagal load list: ' + error.message + "</div>";
      }
    }

    async function refreshStudioLiteList() {
      if (!studioLiteListBox) return;
      try {
        const data = await api("/api/mobile/list?kind=studio-lite");
        const items = Array.isArray(data.items) ? data.items : [];
        if (items.length === 0) {
          studioLiteListBox.innerHTML = '<div class="sub">Belum ada data Studio Lite ID.</div>';
          return;
        }

        studioLiteListBox.innerHTML = items
          .slice(0, 100)
          .map((item) =>
            '<div class="asset-item"><div><div>' +
              item.name +
              "</div><small>id: " +
              item.id +
              " | key: " +
              item.key +
              '</small></div><small>' +
              item.kind +
              "</small></div>",
          )
          .join("");
      } catch (error) {
        studioLiteListBox.innerHTML = '<div class="sub">Gagal load Studio Lite list: ' + error.message + "</div>";
      }
    }

    async function addStudioLiteId() {
      const feature = String(studioLiteFeatureInput?.value || "").trim();
      const assetId = String(studioLiteIdInput?.value || "").trim();
      if (!feature || !assetId) {
        studioLiteLog("Isi Nama Fitur dan Asset ID dulu.");
        return;
      }

      try {
        const data = await api("/api/mobile/add", {
          method: "POST",
          body: {
            name: feature,
            id: assetId,
            kind: "studio-lite",
          },
        });
        studioLiteLog("Berhasil simpan: " + data.item.name + " (id " + data.item.id + ").");
        if (studioLiteFeatureInput) studioLiteFeatureInput.value = "";
        if (studioLiteIdInput) studioLiteIdInput.value = "";
        await refreshStudioLiteList();
      } catch (error) {
        studioLiteLog("Gagal simpan Studio Lite ID: " + error.message);
      }
    }

    async function uploadSelectedFiles() {
      const allSelected = assetFilesInput?.files ? Array.from(assetFilesInput.files) : [];
      const list = allSelected.slice(0, dashboardMaxUploadFiles);
      if (list.length === 0) {
        uploadLog("Pilih file dulu.");
        return;
      }

      if (allSelected.length > dashboardMaxUploadFiles) {
        uploadLog(
          "File dipilih " +
            allSelected.length +
            ", diproses " +
            dashboardMaxUploadFiles +
            " pertama sesuai limit dashboard.",
        );
      }

      uploadLog("Mulai upload " + list.length + " file (mode sequential)...");
      let successCount = 0;
      let failedCount = 0;

      for (let i = 0; i < list.length; i += 1) {
        const file = list[i];
        try {
          if (Number(file.size || 0) > dashboardMaxUploadBytesPerFile) {
            failedCount += 1;
            uploadLog(
              "[" +
                (i + 1) +
                "/" +
                list.length +
                "] " +
                file.name +
                " gagal: ukuran > " +
                Math.floor(dashboardMaxUploadBytesPerFile / (1024 * 1024)) +
                "MB.",
            );
            continue;
          }

          const contentBase64 = await fileToBase64(file);
          const res = await api("/api/assets/upload", {
            method: "POST",
            body: { files: [{ name: file.name, contentBase64 }] },
          });

          const oneSuccess = Array.isArray(res.success) ? res.success.length : 0;
          const oneFailed = Array.isArray(res.failed) ? res.failed.length : 0;
          successCount += oneSuccess;
          failedCount += oneFailed;

          if (oneSuccess > 0) {
            const firstSuccess = res.success[0] || {};
            const deletedList = Array.isArray(firstSuccess.deletedExistingList)
              ? firstSuccess.deletedExistingList
              : firstSuccess.deletedExisting
                ? [firstSuccess.deletedExisting]
                : [];
            if (deletedList.length > 0) {
              const deletedNames = deletedList.map((item) => item.fileName).join(", ");
              uploadLog(
                "[" +
                  (i + 1) +
                  "/" +
                  list.length +
                  "] " +
                  file.name +
                  " replace duplicate: hapus " +
                  deletedNames +
                  ", lalu simpan baru.",
              );
            } else {
              uploadLog("[" + (i + 1) + "/" + list.length + "] " + file.name + " berhasil.");
            }
          } else {
            const reason = oneFailed > 0 ? res.failed[0]?.reason || "unknown error" : "unknown error";
            uploadLog("[" + (i + 1) + "/" + list.length + "] " + file.name + " gagal: " + reason);
          }
        } catch (error) {
          failedCount += 1;
          uploadLog("[" + (i + 1) + "/" + list.length + "] " + file.name + " gagal: " + error.message);
        }
      }

      uploadLog("Upload selesai. Berhasil: " + successCount + ", gagal: " + failedCount + ".");
      if (assetFilesInput) assetFilesInput.value = "";
      await refreshAssetList();
      await refreshSummary();
    }

    async function loadDedupeLog() {
      try {
        const data = await api("/api/assets/dedupe-log");
        const tail = String(data.tail || "").trim();
        if (!tail) {
          uploadLog("Belum ada log hapus duplikat.");
          return;
        }
        uploadLog("Log hapus duplikat terbaru:\\n" + tail);
      } catch (error) {
        uploadLog("Gagal ambil log duplikat: " + error.message);
      }
    }

    async function refreshSummary() {
      try {
        const data = await api("/api/summary");
        const isReady = Boolean(data.bot.ready);
        const uptimeMinutes = data.bot.uptimeSec ? Math.floor(data.bot.uptimeSec / 60) : 0;

        const dot = document.getElementById("dotReady");
        const pillReady = document.getElementById("pillReady");
        const pillGuilds = document.getElementById("pillGuilds");
        const pillUptime = document.getElementById("pillUptime");
        const sideStatus = document.getElementById("sideStatus");
        const sideNode = document.getElementById("sideNode");
        const btnSelfUpdate = document.getElementById("btnSelfUpdate");
        if (dot) dot.className = isReady ? "dot online" : "dot";
        if (pillReady) pillReady.textContent = isReady ? "Bot Online" : "Bot Offline";
        if (pillGuilds) pillGuilds.textContent = String(data.bot.guildCount || 0);
        if (pillUptime) pillUptime.textContent = uptimeMinutes + "m";
        if (sideStatus) sideStatus.textContent = isReady ? "ONLINE" : "OFFLINE";
        if (sideNode) sideNode.textContent = "Node " + (data.system.nodeVersion || "-");
        if (btnSelfUpdate) {
          btnSelfUpdate.disabled = !data.system.selfUpdateEnabled;
          btnSelfUpdate.style.opacity = data.system.selfUpdateEnabled ? "1" : "0.5";
        }

        statsGrid.innerHTML = "";
        statsGrid.appendChild(card("Bot Identity", data.bot.tag || "-", "ID: " + (data.bot.id || "-"), "#7dd3fc"));
        statsGrid.appendChild(card("Guild Join", String(data.bot.guildCount || 0), "Commands: " + (data.bot.commandCount || 0), "#22c55e"));
        statsGrid.appendChild(card("AI Cost Today", "$" + Number(data.ai.totalCostUSD || 0).toFixed(4), "Req: " + Number(data.ai.totalRequests || 0), "#f59e0b"));
        statsGrid.appendChild(card("Asset Library", String(data.assets.fileCount || 0), "Mobile IDs: " + Number(data.assets.mobileCount || 0), "#a78bfa"));
        statsGrid.appendChild(card("Review History", String(data.reviewHistory.totalEntries || 0), "Last: " + (data.reviewHistory.lastUpdatedLabel || "-"), "#38bdf8"));
        statsGrid.appendChild(card("Private Mode", data.system.privateOnlyMode ? "ON" : "OFF", "Node: " + (data.system.nodeVersion || "-"), "#eab308"));
        statsGrid.appendChild(card("Daily Budget", "$" + Number(data.ai.dailyBudgetUSD || 0).toFixed(2), "Remain: $" + Number(data.ai.remainingBudgetUSD || 0).toFixed(2), "#f87171"));
        statsGrid.appendChild(card("Uptime", uptimeMinutes + " menit", "Local now: " + new Date(data.system.nowSec * 1000).toLocaleString("id-ID"), "#c4b5fd"));

        if (pulseBars) {
          pulseBars.innerHTML = "";
          pulseBars.appendChild(pulseRow("Guild", Number(data.bot.guildCount || 0), Math.max(1, Number(data.bot.guildCount || 0), 10), ""));
          pulseBars.appendChild(pulseRow("Commands", Number(data.bot.commandCount || 0), 12, ""));
          pulseBars.appendChild(pulseRow("Asset Files", Number(data.assets.fileCount || 0), Math.max(10, Number(data.assets.fileCount || 0)), ""));
          pulseBars.appendChild(pulseRow("AI Requests", Number(data.ai.totalRequests || 0), Math.max(1, Number(data.ai.maxRequestsPerDay || 250)), ""));
          pulseBars.appendChild(pulseRow("AI Budget", Number(data.ai.totalCostUSD || 0).toFixed(2), Math.max(1, Number(data.ai.dailyBudgetUSD || 5)), "$"));
        }
        if (pulseNote) {
          pulseNote.textContent =
            "Budget " +
            Number(data.ai.totalCostUSD || 0).toFixed(4) +
            " / " +
            Number(data.ai.dailyBudgetUSD || 0).toFixed(2) +
            " USD, sisa " +
            Number(data.ai.remainingBudgetUSD || 0).toFixed(4) +
            " USD.";
        }

        log("Data dashboard diperbarui.");
        await refreshAssetList();
        await refreshStudioLiteList();
      } catch (error) {
        log("Gagal refresh: " + error.message);
      }
    }

    async function doLogin() {
      const username = document.getElementById("username").value.trim();
      const password = document.getElementById("password").value;
      try {
        await api("/api/login", { method: "POST", body: { username, password } });
        loginView.classList.add("hidden");
        appView.classList.remove("hidden");
        await refreshSummary();
      } catch (error) {
        loginLog("Login gagal: " + error.message);
      }
    }

    async function doLogout() {
      try {
        await api("/api/logout", { method: "POST", body: {} });
      } catch {}
      location.reload();
    }

    async function syncAll() {
      try {
        const data = await api("/api/actions/sync-all", { method: "POST", body: {} });
        log("Sync all selesai. Success: " + data.success + ", failed: " + data.failed);
        await refreshSummary();
      } catch (error) {
        log("Sync all gagal: " + error.message);
      }
    }

    async function syncOne() {
      const guildId = document.getElementById("guildIdInput").value.trim();
      if (!guildId) {
        log("Isi Guild ID dulu.");
        return;
      }
      try {
        await api("/api/actions/sync-guild", { method: "POST", body: { guildId } });
        log("Sync guild berhasil: " + guildId);
        await refreshSummary();
      } catch (error) {
        log("Sync guild gagal: " + error.message);
      }
    }

    async function clearGlobal() {
      try {
        await api("/api/actions/clear-global", { method: "POST", body: {} });
        log("Global commands berhasil dibersihkan.");
      } catch (error) {
        log("Clear global gagal: " + error.message);
      }
    }

    async function triggerSelfUpdate() {
      try {
        const data = await api("/api/actions/self-update", { method: "POST", body: {} });
        log("Self update dimulai. Branch: " + data.branch + ". Cek log update untuk progress.");
      } catch (error) {
        log("Self update gagal start: " + error.message);
      }
    }

    async function loadSelfUpdateLog() {
      try {
        const data = await api("/api/actions/self-update-log");
        if (data.tail && data.tail.trim()) {
          log("Log update terbaru:\\n" + data.tail);
        } else {
          log("Belum ada log update.");
        }
      } catch (error) {
        log("Gagal ambil log update: " + error.message);
      }
    }

    document.getElementById("btnLogin")?.addEventListener("click", doLogin);
    document.getElementById("btnRefresh")?.addEventListener("click", refreshSummary);
    document.getElementById("btnSyncAll")?.addEventListener("click", syncAll);
    document.getElementById("btnSyncOne")?.addEventListener("click", syncOne);
    document.getElementById("btnClearGlobal")?.addEventListener("click", clearGlobal);
    document.getElementById("btnLogout")?.addEventListener("click", doLogout);
    document.getElementById("btnSelfUpdate")?.addEventListener("click", triggerSelfUpdate);
    document.getElementById("btnSelfUpdateLog")?.addEventListener("click", loadSelfUpdateLog);
    document.getElementById("btnUploadFiles")?.addEventListener("click", uploadSelectedFiles);
    document.getElementById("btnReloadAssets")?.addEventListener("click", refreshAssetList);
    document.getElementById("btnDedupeLog")?.addEventListener("click", loadDedupeLog);
    document.getElementById("btnAddStudioLite")?.addEventListener("click", addStudioLiteId);
    document.getElementById("btnReloadStudioLite")?.addEventListener("click", refreshStudioLiteList);
    document.getElementById("studioLiteIdInput")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") addStudioLiteId();
    });
    document.getElementById("password")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") doLogin();
    });

    if (isAuthed) {
      refreshSummary();
    }
  </script>
</body>
</html>`;
}

function buildMemberPage({ title = MEMBER_PAGE_TITLE, promoUrl = MEMBER_PROMO_URL, discordUrl = MEMBER_DISCORD_URL }) {
  const safeTitle = sanitizeText(title || "LYVA Member Hub");
  const safePromo = sanitizeText(promoUrl || "#");
  const safeDiscord = sanitizeText(discordUrl || "#");
  const hasDiscord = Boolean(discordUrl);

  return `<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safeTitle}</title>
  <style>
    @import url("https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@500;600;700&family=Sora:wght@400;500;600;700;800&display=swap");
    :root {
      --bg: #f4f7fd;
      --bg-soft: #f9fbff;
      --panel: #ffffff;
      --line: #dbe3f1;
      --text: #132949;
      --muted: #667ea2;
      --brand: #1f36b8;
      --brand2: #f1577d;
      --accent: #15b37d;
      --danger: #ef4444;
      --shadow: 0 15px 30px rgba(19, 39, 80, 0.08);
    }
    * { box-sizing: border-box; margin: 0; }
    body {
      font-family: "Sora", "Segoe UI", sans-serif;
      color: var(--text);
      background:
        radial-gradient(930px 430px at 100% -15%, #d9e4ff 0%, transparent 58%),
        radial-gradient(850px 420px at -10% 0%, #ffe0e9 0%, transparent 56%),
        var(--bg);
      min-height: 100vh;
      padding: 4px;
    }
    .wrap {
      max-width: 1900px;
      margin: 0 auto;
      border: 1px solid var(--line);
      border-radius: 16px;
      overflow: hidden;
      box-shadow: var(--shadow);
      background: #f7f9ff;
    }
    .layout {
      display: grid;
      grid-template-columns: 84px minmax(0, 1fr);
    }
    .panel {
      border: 1px solid var(--line);
      border-radius: 14px;
      background: var(--panel);
      box-shadow: var(--shadow);
    }
    .sidebar {
      padding: 10px 0;
      position: sticky;
      top: 4px;
      display: grid;
      gap: 6px;
      justify-items: center;
      align-content: start;
      min-height: calc(100vh - 10px);
      border-right: 1px solid var(--line);
      border-radius: 0;
      box-shadow: none;
      background: #f9fbff;
    }
    .logo-pill {
      width: 44px;
      height: 44px;
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: linear-gradient(145deg, #2443d8, #f1577d);
      color: #fff;
      font-family: "Chakra Petch", "Sora", sans-serif;
      font-weight: 700;
      font-size: 17px;
      border: 0;
      padding: 0;
      margin-bottom: 8px;
    }
    .menu {
      display: grid;
      gap: 6px;
      width: 100%;
    }
    .menu button {
      width: 100%;
      border: 0;
      border-left: 4px solid transparent;
      border-radius: 0;
      padding: 10px 4px;
      background: transparent;
      color: #36507a;
      font-weight: 600;
      cursor: pointer;
      font-size: 12px;
      line-height: 1.3;
      text-align: center;
      display: grid;
      justify-items: center;
      gap: 7px;
    }
    .menu button::before {
      content: attr(data-icon);
      width: 26px;
      height: 26px;
      border-radius: 7px;
      border: 1px solid #cad5ea;
      background: #fff;
      display: grid;
      place-items: center;
      font-family: "Chakra Petch", "Sora", sans-serif;
      font-size: 12px;
      font-weight: 700;
    }
    .menu button.active {
      background: #edf1ff;
      border-left-color: var(--brand);
      color: var(--brand);
    }
    .content { display: grid; gap: 14px; padding: 0 24px 24px; }
    .install-strip {
      border-bottom: 1px solid var(--line);
      background: linear-gradient(90deg, rgba(241, 87, 125, 0.1), rgba(31, 54, 184, 0.1)), #eaf0fb;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 14px;
      padding: 10px 20px;
      font-size: 14px;
      color: #2e4467;
    }
    .install-strip .close {
      border: 0;
      background: transparent;
      font-size: 18px;
      cursor: pointer;
      color: #304764;
      line-height: 1;
    }
    .topbar {
      border: 1px solid var(--line);
      border-radius: 0 0 12px 12px;
      box-shadow: none;
      min-height: 74px;
      background: var(--panel);
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 18px;
      flex-wrap: wrap;
      padding: 10px 24px;
    }
    .brand-wrap {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      min-width: 250px;
      font-family: "Chakra Petch", "Sora", sans-serif;
      font-weight: 700;
      color: #1b2f73;
      text-transform: uppercase;
      font-size: 23px;
      line-height: 1;
    }
    .brand-mark {
      width: 34px;
      height: 34px;
      border-radius: 9px;
      background: linear-gradient(145deg, #233ec8, #f1577d);
      color: #fff;
      display: grid;
      place-items: center;
      font-size: 15px;
      font-weight: 700;
    }
    .search-wrap {
      flex: 1;
      min-width: 280px;
      max-width: 680px;
      position: relative;
    }
    .search-wrap input {
      width: 100%;
      border: 1px solid #ccd6ea;
      border-radius: 999px;
      padding: 12px 44px 12px 16px;
      font-size: 14px;
      outline: none;
    }
    .search-wrap span {
      position: absolute;
      right: 15px;
      top: 10px;
      color: #687fa5;
      font-size: 18px;
      line-height: 1;
      pointer-events: none;
    }
    .search-wrap input:focus {
      border-color: #97acd5;
      box-shadow: 0 0 0 3px #e9efff;
    }
    .top-actions {
      display: inline-flex;
      gap: 10px;
      align-items: center;
      flex-wrap: wrap;
    }
    .section { display: none; animation: up 0.35s ease both; }
    .section.active { display: block; }
    .hero {
      padding: 18px;
      border: 1px solid var(--line);
      border-radius: 20px;
      background: linear-gradient(145deg, #f0f3ff, #f5f8ff);
      position: relative;
      overflow: hidden;
      display: grid;
      gap: 12px;
    }
    .hero::before, .hero::after {
      content: "";
      position: absolute;
      width: 34vw;
      min-width: 240px;
      max-width: 520px;
      height: 74%;
      top: 11%;
      border-radius: 24px;
      transform: skewX(-25deg);
      background: linear-gradient(180deg, rgba(179, 194, 232, 0.2), rgba(179, 194, 232, 0.05));
      z-index: 0;
      pointer-events: none;
    }
    .hero::before { left: -6%; }
    .hero::after { right: -6%; }
    .hero-banner {
      position: relative;
      z-index: 1;
      border-radius: 0;
      border: 0;
      background: transparent;
      min-height: 0;
      display: grid;
      grid-template-columns: 1fr minmax(0, 1.6fr) 1fr;
      gap: 12px;
      padding: 0;
      align-items: center;
    }
    .hero-slide {
      min-height: 220px;
      border-radius: 18px;
      border: 1px solid #ccdaf4;
      overflow: hidden;
      background-size: cover;
      background-position: center;
      position: relative;
      opacity: 0.72;
      transform: scale(0.95);
      transition: all 0.35s ease;
    }
    .hero-slide.main {
      min-height: 258px;
      opacity: 1;
      transform: scale(1);
      box-shadow: 0 14px 30px rgba(18, 32, 80, 0.23);
    }
    .hero-slide::before {
      content: "";
      position: absolute;
      inset: 0;
      background: linear-gradient(180deg, rgba(10, 19, 45, 0.25), rgba(10, 19, 45, 0.64));
    }
    .hero-copy {
      position: absolute;
      left: 14px;
      right: 14px;
      bottom: 12px;
      z-index: 2;
      color: #fff;
      display: grid;
      gap: 4px;
    }
    .hero-copy .kicker {
      color: #d8e0ff;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      font-weight: 600;
    }
    .hero-copy h2, .hero-copy h3 {
      margin: 0;
      font-family: "Chakra Petch", "Sora", sans-serif;
      line-height: 1.08;
    }
    .hero-copy h2 { font-size: 28px; }
    .hero-copy h3 { font-size: 18px; }
    .hero-copy p { margin: 0; font-size: 12px; color: #dbe4ff; }
    .hero-btn {
      margin-top: 6px;
      width: fit-content;
      border: 0;
      border-radius: 999px;
      padding: 8px 15px;
      background: var(--brand2);
      color: #fff;
      text-decoration: none;
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
    }
    .hero-dots {
      position: relative;
      z-index: 1;
      margin: 0 auto;
      display: flex;
      justify-content: center;
      gap: 6px;
    }
    .hero-dot {
      width: 32px;
      height: 6px;
      border-radius: 999px;
      border: 0;
      background: #b5bfd4;
      cursor: pointer;
    }
    .hero-dot.active { background: var(--brand2); }
    .title {
      margin: 10px 0 4px;
      display: flex;
      align-items: center;
      gap: 10px;
      font-family: "Chakra Petch", "Sora", sans-serif;
      font-size: 38px;
      color: #142f62;
    }
    .title::before {
      content: "!";
      width: 28px;
      height: 28px;
      border-radius: 999px;
      background: #ff6c73;
      color: #fff;
      display: inline-grid;
      place-items: center;
      font-weight: 700;
      font-size: 16px;
    }
    .sub { color: var(--muted); font-size: 14px; line-height: 1.55; }
    .row { display: flex; gap: 8px; flex-wrap: wrap; }
    a.btn, button.btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      border: 0;
      border-radius: 10px;
      min-height: 34px;
      padding: 8px 12px;
      color: #fff;
      text-decoration: none;
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
      background: var(--brand);
    }
    a.btn:hover, button.btn:hover { filter: brightness(.96); }
    a.btn.secondary, button.btn.secondary { background: var(--brand2); }
    a.btn.alt, button.btn.alt { background: var(--accent); }
    a.btn.small {
      border-radius: 999px;
      min-height: 0;
      padding: 7px 10px;
    }
    button.btn.copy.ok { background: var(--accent); }
    .grid {
      margin-top: 4px;
      display: grid;
      gap: 10px;
      grid-template-columns: repeat(4, minmax(0, 1fr));
    }
    .stat {
      border: 1px solid #d8e1f3;
      border-radius: 14px;
      background: #fff;
      padding: 12px;
    }
    .stat .k {
      color: #7d8fb1;
      font-size: 11px;
      text-transform: uppercase;
      font-weight: 600;
    }
    .stat .v {
      margin-top: 6px;
      font-family: "Chakra Petch", "Sora", sans-serif;
      font-size: 24px;
      color: #152f5f;
      font-weight: 700;
      line-height: 1;
    }
    .category-pills {
      margin: 12px 0 6px;
      display: flex;
      flex-wrap: wrap;
      gap: 9px;
    }
    .cat-pill {
      border: 1px solid #c6d2e9;
      border-radius: 999px;
      padding: 9px 15px;
      background: #fff;
      color: #385174;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s ease;
    }
    .cat-pill.active {
      background: linear-gradient(140deg, #1d39c4, #f1577d);
      color: #fff;
      border-color: transparent;
      box-shadow: 0 9px 18px rgba(44, 58, 152, 0.26);
    }
    .catalog { border: 1px solid var(--line); border-radius: 16px; background: #fff; box-shadow: var(--shadow); padding: 16px; display: grid; gap: 12px; }
    .search {
      width: 100%;
      max-width: 420px;
      padding: 10px 14px;
      border-radius: 999px;
      border: 1px solid #cad5ea;
      background: #fff;
      color: var(--text);
      outline: none;
      font-size: 14px;
    }
    .search:focus { border-color: #96a8d2; box-shadow: 0 0 0 3px #e9efff; }
    .card-grid, .popular-grid {
      display: grid;
      gap: 14px;
      grid-template-columns: repeat(5, minmax(0, 1fr));
    }
    .asset-card {
      border: 1px solid #d9e3f3;
      border-radius: 14px;
      overflow: hidden;
      background: #fff;
      display: grid;
      grid-template-rows: 176px auto;
      box-shadow: 0 11px 20px rgba(24, 41, 80, 0.06);
    }
    .thumb {
      width: 100%;
      height: 176px;
      object-fit: cover;
      display: block;
      background: #edf2fb;
      border-bottom: 1px solid #dbe4f4;
    }
    .asset-body {
      padding: 11px 12px 13px;
      display: grid;
      gap: 8px;
    }
    .asset-name {
      font-family: "Chakra Petch", "Sora", sans-serif;
      font-size: 24px;
      line-height: 1.18;
      color: #132d5a;
      min-height: 56px;
      word-break: break-word;
      font-weight: 700;
    }
    .asset-meta { color: #6e82a8; font-size: 12px; line-height: 1.45; min-height: 33px; }
    .asset-actions { display: flex; flex-wrap: wrap; gap: 6px; }
    .empty { color: #66799d; font-size: 13px; padding: 14px; border: 1px dashed #ced9ed; border-radius: 12px; background: #fafdff; }
    .hide { display: none !important; }
    @keyframes up {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .review-grid {
      border: 1px solid var(--line);
      border-radius: 16px;
      background: #fff;
      box-shadow: var(--shadow);
      padding: 14px;
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
    }
    .card {
      border: 1px solid #d9e3f3;
      border-radius: 12px;
      padding: 12px;
      background: #fbfcff;
    }
    .card h4 { font-size: 16px; color: #203b72; }
    .card p, .card li { color: #63779e; font-size: 13px; line-height: 1.45; }
    .card ul { margin-left: 18px; display: grid; gap: 4px; }
    @media (max-width: 1280px) {
      .card-grid, .popular-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
      .asset-name { font-size: 20px; min-height: 46px; }
    }
    @media (max-width: 1060px) {
      .wrap { border-radius: 0; }
      .layout { grid-template-columns: 1fr; }
      .sidebar {
        position: static;
        min-height: 0;
        grid-template-columns: 60px repeat(4, minmax(0, 1fr));
        align-items: center;
        padding: 8px;
        border-right: 0;
        border-bottom: 1px solid var(--line);
      }
      .logo-pill { margin: 0; }
      .menu { grid-template-columns: repeat(4, minmax(0, 1fr)); }
      .menu button {
        border-left: 0;
        border-bottom: 3px solid transparent;
        border-radius: 0;
        padding: 10px 2px;
      }
      .menu button.active { border-bottom-color: var(--brand); }
      .content { padding: 0 12px 12px; }
      .topbar { padding: 10px 12px; gap: 10px; }
      .brand-wrap { min-width: 0; font-size: 19px; }
      .hero-banner { grid-template-columns: 1fr; }
      .hero-slide { min-height: 180px; opacity: 1; transform: scale(1); }
      .hero-slide.main { min-height: 210px; }
      .hero-slide.side { display: none; }
      .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .card-grid, .popular-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .review-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (max-width: 760px) {
      body { padding: 0; }
      .install-strip { padding: 8px 10px; gap: 8px; font-size: 12px; }
      .top-actions { width: 100%; justify-content: flex-end; }
      .card-grid, .popular-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .title { font-size: 28px; }
      .review-grid { grid-template-columns: 1fr; }
    }
    @media (max-width: 460px) {
      .sidebar { grid-template-columns: 1fr 1fr; }
      .menu { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .grid, .card-grid, .popular-grid { grid-template-columns: 1fr; }
      .asset-name { font-size: 18px; min-height: 0; }
      .top-actions { justify-content: flex-start; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="layout">
      <aside class="sidebar">
        <div class="logo-pill">LY</div>
        <div class="menu">
          <button class="active" data-target="section-home" data-icon="H">Home</button>
          <button data-target="section-pc" data-icon="T">Transaksi</button>
          <button data-target="section-hp" data-icon="P">Promo</button>
          <button data-target="section-review" data-icon="G">Hadiahku</button>
        </div>
      </aside>

      <main class="content">
        <div id="installStrip" class="install-strip">
          <button id="closeInstallStrip" class="close" type="button">x</button>
          <span>Top up cepat dengan instal aplikasi ${safeTitle} di komputer kamu</span>
          <a class="btn small" href="${safePromo}" target="_blank" rel="noreferrer">Install</a>
        </div>

        <div class="topbar">
          <div class="brand-wrap">
            <div class="brand-mark">L</div>
            <div>${safeTitle}</div>
          </div>
          <div class="search-wrap">
            <input id="globalSearchInput" placeholder="Cari asset, key, atau fitur..." />
            <span>o</span>
          </div>
          <div class="top-actions">
            ${hasDiscord ? `<a class="btn small secondary" href="${safeDiscord}" target="_blank" rel="noreferrer">Discord</a>` : `<span class="btn small secondary">ID</span>`}
            <a class="btn small" href="/dashboard">Masuk</a>
          </div>
        </div>

        <section class="section active" id="section-home">
          <div class="hero">
            <div class="hero-banner">
              <article id="heroLeft" class="hero-slide side">
                <div class="hero-copy">
                  <div class="kicker" data-role="kicker"></div>
                  <h3 data-role="title"></h3>
                  <p data-role="meta"></p>
                </div>
              </article>
              <article id="heroMain" class="hero-slide main">
                <div class="hero-copy">
                  <div class="kicker" data-role="kicker"></div>
                  <h2 data-role="title"></h2>
                  <p data-role="meta"></p>
                  <a href="#" class="hero-btn" data-role="action">Lihat Sekarang</a>
                </div>
              </article>
              <article id="heroRight" class="hero-slide side">
                <div class="hero-copy">
                  <div class="kicker" data-role="kicker"></div>
                  <h3 data-role="title"></h3>
                  <p data-role="meta"></p>
                </div>
              </article>
            </div>
            <div id="heroDots" class="hero-dots"></div>
            <div class="grid" id="statGrid"></div>
          </div>
          <div id="categoryPills" class="category-pills"></div>
          <div class="title">Lagi Populer</div>
          <div id="popularGrid" class="popular-grid"></div>
        </section>

        <section class="section" id="section-pc">
          <div class="catalog">
            <input id="searchPcInput" class="search" placeholder="Cari asset PC..." />
            <div id="pcGrid" class="card-grid"></div>
          </div>
        </section>

        <section class="section" id="section-hp">
          <div class="catalog">
            <input id="searchHpInput" class="search" placeholder="Cari asset HP / studio lite..." />
            <div id="hpGrid" class="card-grid"></div>
          </div>
        </section>

        <section class="section" id="section-review">
          <div class="review-grid">
            <div class="card">
              <h4>Cara Review Script</h4>
              <ul>
                <li>/review paste: rule-based cepat dan stabil.</li>
                <li>/review ai: tambahan insight AI (kalau kuota ada).</li>
                <li>Fokus deteksi exploit Roblox (remote trust, nil check, loop berat).</li>
              </ul>
            </div>
            <div class="card">
              <h4>Tips Biar Aman</h4>
              <ul>
                <li>Jangan percaya input client langsung untuk economy/damage.</li>
                <li>Pakai validasi tipe + range + rate limit.</li>
                <li>Pakai pcall untuk DataStore agar tidak crash.</li>
              </ul>
            </div>
            <div class="card">
              <h4>Quick Commands</h4>
              <p>/asset list, /asset get, /review paste, /review ai, /menu</p>
            </div>
            <div class="card">
              <h4>Butuh Script/Asset Baru?</h4>
              <p>Request di Discord, nanti asset bisa dimasukkan ke library lalu otomatis muncul di halaman web ini.</p>
            </div>
          </div>
        </section>
      </main>
    </div>
  </div>

  <script>
    const statGrid = document.getElementById("statGrid");
    const popularGrid = document.getElementById("popularGrid");
    const categoryPills = document.getElementById("categoryPills");
    const pcGrid = document.getElementById("pcGrid");
    const hpGrid = document.getElementById("hpGrid");
    const searchPcInput = document.getElementById("searchPcInput");
    const searchHpInput = document.getElementById("searchHpInput");
    const globalSearchInput = document.getElementById("globalSearchInput");
    const installStrip = document.getElementById("installStrip");
    const closeInstallStrip = document.getElementById("closeInstallStrip");
    const heroLeft = document.getElementById("heroLeft");
    const heroMain = document.getElementById("heroMain");
    const heroRight = document.getElementById("heroRight");
    const heroDots = document.getElementById("heroDots");
    const menuButtons = Array.from(document.querySelectorAll(".menu button"));
    const sections = Array.from(document.querySelectorAll(".section"));
    const categories = [
      { id: "all", label: "Lagi Populer" },
      { id: "pc", label: "Top Up Langsung" },
      { id: "hp", label: "Baru Rilis" },
      { id: "studio", label: "Top Up Login" },
      { id: "script", label: "Voucher" },
      { id: "model", label: "Pulsa" },
      { id: "misc", label: "Entertainment" },
    ];

    let state = { pcAssets: [], hpAssets: [], summary: {}, activeCategory: "all", heroItems: [], slideIndex: 0, slideTimer: null };

    function stat(label, value) {
      const el = document.createElement("div");
      el.className = "stat";
      el.innerHTML = '<div class="k">' + label + '</div><div class="v">' + value + "</div>";
      return el;
    }

    function renderStats() {
      statGrid.innerHTML = "";
      statGrid.appendChild(stat("Total Asset File", String(state.summary.fileCount || 0)));
      statGrid.appendChild(stat("Total Mobile ID", String(state.summary.mobileCount || 0)));
      statGrid.appendChild(stat("Studio Lite ID", String(state.summary.studioLiteCount || 0)));
      statGrid.appendChild(stat("Bot Command", String(state.summary.commandHint || "/review /asset")));
    }

    function fallbackThumb(label, hue) {
      const text = String(label || "LYVA").slice(0, 22);
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360">' +
        '<defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1">' +
        '<stop offset="0%" stop-color="hsl(' + hue + ',65%,52%)"/>' +
        '<stop offset="100%" stop-color="hsl(' + ((hue + 48) % 360) + ',70%,38%)"/>' +
        '</linearGradient></defs>' +
        '<rect width="640" height="360" fill="url(#g)"/>' +
        '<text x="32" y="188" fill="#fff" font-size="34" font-family="Chakra Petch,Sora,sans-serif" font-weight="700">' +
        text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") +
        "</text></svg>";
      return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
    }

    function normalize(text) {
      return String(text || "").trim().toLowerCase();
    }

    function toPcPopular(item) {
      return {
        source: "pc",
        title: item.baseName || item.fileName || "Asset PC",
        meta: "Type: " + (item.type || "-") + " | Size: " + (item.sizeLabel || "-"),
        imageUrl: item.imageUrl || "",
        href: item.downloadUrl || "#",
        copyId: "",
        ext: item.ext || "",
        type: item.type || "",
        kind: "",
      };
    }

    function toHpPopular(item) {
      return {
        source: "hp",
        title: item.name || "Asset HP",
        meta: "ID: " + (item.id || "-") + " | Kind: " + (item.kind || "-"),
        imageUrl: item.imageUrl || "",
        href: "#",
        copyId: item.id || "",
        ext: "",
        type: "",
        kind: item.kind || "",
      };
    }

    function allPopularItems() {
      return state.pcAssets.map(toPcPopular).concat(state.hpAssets.map(toHpPopular));
    }

    function matchCategory(item, categoryId) {
      if (categoryId === "pc") return item.source === "pc";
      if (categoryId === "hp") return item.source === "hp";
      if (categoryId === "studio") return item.source === "hp" && normalize(item.kind) === "studio-lite";
      if (categoryId === "script") return normalize(item.type).includes("script") || normalize(item.ext).includes("lua");
      if (categoryId === "model") return normalize(item.ext).includes("rbxm");
      if (categoryId === "misc") return !normalize(item.ext).includes("rbxm") && !normalize(item.ext).includes("lua");
      return true;
    }

    function matchSearch(item, query) {
      if (!query) return true;
      const blob = String(item.title || "") + " " + String(item.meta || "") + " " + String(item.type || "") + " " + String(item.kind || "");
      return normalize(blob).includes(query);
    }

    function createEl(tag, className, text) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (typeof text === "string") node.textContent = text;
      return node;
    }

    function createPcCard(item) {
      const card = createEl("article", "asset-card");
      const img = createEl("img", "thumb");
      img.loading = "lazy";
      img.src = item.imageUrl || fallbackThumb(item.baseName || item.fileName || "Asset PC", 215);
      img.alt = item.baseName || item.fileName || "Asset";
      img.onerror = () => {
        img.src = fallbackThumb(item.baseName || item.fileName || "Asset PC", 215);
      };

      const body = createEl("div", "asset-body");
      body.appendChild(createEl("div", "asset-name", item.baseName || item.fileName || "Unnamed Asset"));
      body.appendChild(createEl("div", "asset-meta", "type: " + (item.type || "-") + " | size: " + (item.sizeLabel || "-")));
      const actions = createEl("div", "asset-actions");
      const download = createEl("a", "btn small", "Download");
      download.href = item.downloadUrl || "#";
      actions.appendChild(download);
      body.appendChild(actions);

      card.appendChild(img);
      card.appendChild(body);
      return card;
    }

    function createHpCard(item) {
      const card = createEl("article", "asset-card");
      const img = createEl("img", "thumb");
      img.loading = "lazy";
      img.src = item.imageUrl || fallbackThumb(item.name || "Asset HP", 145);
      img.alt = item.name || "Asset HP";
      img.onerror = () => {
        img.src = fallbackThumb(item.name || "Asset HP", 145);
      };

      const body = createEl("div", "asset-body");
      body.appendChild(createEl("div", "asset-name", item.name || "Unnamed Mobile Asset"));
      body.appendChild(createEl("div", "asset-meta", "ID: " + (item.id || "-") + " | kind: " + (item.kind || "-")));
      const actions = createEl("div", "asset-actions");
      const copyBtn = createEl("button", "btn small copy", "Copy ID");
      copyBtn.type = "button";
      copyBtn.dataset.copyId = item.id || "";
      actions.appendChild(copyBtn);
      body.appendChild(actions);

      card.appendChild(img);
      card.appendChild(body);
      return card;
    }

    function createPopularCard(item) {
      const card = createEl("article", "asset-card");
      const img = createEl("img", "thumb");
      img.loading = "lazy";
      img.src = item.imageUrl || fallbackThumb(item.title || "Asset", item.source === "hp" ? 145 : 215);
      img.alt = item.title || "Asset";
      img.onerror = () => {
        img.src = fallbackThumb(item.title || "Asset", item.source === "hp" ? 145 : 215);
      };

      const body = createEl("div", "asset-body");
      body.appendChild(createEl("div", "asset-name", item.title || "Unnamed Asset"));
      body.appendChild(createEl("div", "asset-meta", item.meta || "-"));
      const actions = createEl("div", "asset-actions");
      if (item.copyId) {
        const copyBtn = createEl("button", "btn small copy", "Copy ID");
        copyBtn.type = "button";
        copyBtn.dataset.copyId = item.copyId;
        actions.appendChild(copyBtn);
      } else {
        const download = createEl("a", "btn small", "Download");
        download.href = item.href || "#";
        actions.appendChild(download);
      }
      body.appendChild(actions);
      card.appendChild(img);
      card.appendChild(body);
      return card;
    }

    function renderCategoryPills() {
      categoryPills.innerHTML = "";
      categories.forEach((item) => {
        const pill = createEl("button", "cat-pill" + (state.activeCategory === item.id ? " active" : ""), item.label);
        pill.type = "button";
        pill.addEventListener("click", () => {
          state.activeCategory = item.id;
          renderCategoryPills();
          renderPopularGrid();
        });
        categoryPills.appendChild(pill);
      });
    }

    function renderPopularGrid() {
      const q = normalize(globalSearchInput?.value || "");
      const list = allPopularItems().filter((item) => matchCategory(item, state.activeCategory) && matchSearch(item, q));
      popularGrid.innerHTML = "";
      if (list.length === 0) {
        popularGrid.appendChild(createEl("div", "empty", "Belum ada item populer."));
        return;
      }
      list.slice(0, 20).forEach((item) => popularGrid.appendChild(createPopularCard(item)));
    }

    function setHeroCard(el, item, center) {
      if (!el || !item) return;
      const bg = item.imageUrl || fallbackThumb(item.title || "LYVA", center ? 226 : 205);
      el.style.backgroundImage = "url('" + bg + "')";
      const kicker = el.querySelector('[data-role="kicker"]');
      const title = el.querySelector('[data-role="title"]');
      const meta = el.querySelector('[data-role="meta"]');
      if (kicker) kicker.textContent = item.source === "hp" ? "mobile id" : "asset pc";
      if (title) title.textContent = item.title || "Untitled";
      if (meta) meta.textContent = item.meta || "";
      if (center) {
        const action = el.querySelector('[data-role="action"]');
        if (!action) return;
        if (item.copyId) {
          action.href = "#";
          action.dataset.copyId = item.copyId;
          action.textContent = "Copy ID";
        } else {
          action.href = item.href || "#";
          action.removeAttribute("data-copy-id");
          action.textContent = "Download";
        }
      }
    }

    function renderHeroDots() {
      heroDots.innerHTML = "";
      state.heroItems.forEach((_, idx) => {
        const dot = createEl("button", "hero-dot" + (idx === state.slideIndex ? " active" : ""));
        dot.type = "button";
        dot.addEventListener("click", () => {
          state.slideIndex = idx;
          renderHero();
          startHeroSlider();
        });
        heroDots.appendChild(dot);
      });
    }

    function renderHero() {
      if (!state.heroItems.length) return;
      const total = state.heroItems.length;
      const current = ((state.slideIndex % total) + total) % total;
      const left = (current - 1 + total) % total;
      const right = (current + 1) % total;
      setHeroCard(heroLeft, state.heroItems[left], false);
      setHeroCard(heroMain, state.heroItems[current], true);
      setHeroCard(heroRight, state.heroItems[right], false);
      renderHeroDots();
    }

    function startHeroSlider() {
      if (state.slideTimer) clearInterval(state.slideTimer);
      state.slideTimer = setInterval(() => {
        if (!state.heroItems.length) return;
        state.slideIndex = (state.slideIndex + 1) % state.heroItems.length;
        renderHero();
      }, 4300);
    }

    function renderPcAssets() {
      const qLocal = String(searchPcInput.value || "").trim().toLowerCase();
      const qGlobal = String(globalSearchInput?.value || "").trim().toLowerCase();
      const q = qLocal || qGlobal;
      const list = state.pcAssets.filter((item) => {
        if (!q) return true;
        return (String(item.fileName || "") + " " + String(item.baseName || "") + " " + String(item.id || "") + " " + String(item.type || ""))
          .toLowerCase()
          .includes(q);
      });

      pcGrid.innerHTML = "";
      if (list.length === 0) {
        pcGrid.appendChild(createEl("div", "empty", "Belum ada asset PC."));
        return;
      }
      list.forEach((item) => pcGrid.appendChild(createPcCard(item)));
    }

    function renderHpAssets() {
      const qLocal = String(searchHpInput.value || "").trim().toLowerCase();
      const qGlobal = String(globalSearchInput?.value || "").trim().toLowerCase();
      const q = qLocal || qGlobal;
      const list = state.hpAssets.filter((item) => {
        if (!q) return true;
        return (String(item.name || "") + " " + String(item.id || "") + " " + String(item.key || "") + " " + String(item.kind || ""))
          .toLowerCase()
          .includes(q);
      });

      hpGrid.innerHTML = "";
      if (list.length === 0) {
        hpGrid.appendChild(createEl("div", "empty", "Belum ada asset HP / Studio Lite."));
        return;
      }
      list.forEach((item) => hpGrid.appendChild(createHpCard(item)));
    }

    async function loadCatalog() {
      const res = await fetch("/api/public/catalog");
      const data = await res.json();
      state.pcAssets = Array.isArray(data.pcAssets) ? data.pcAssets : [];
      state.hpAssets = Array.isArray(data.hpAssets) ? data.hpAssets : [];
      state.summary = data.summary || {};
      state.heroItems = allPopularItems().slice(0, 8);
      if (!state.heroItems.length) {
        state.heroItems = [
          {
            source: "pc",
            title: "Special Discount",
            meta: "Katalog lagi kosong",
            imageUrl: "",
            href: "#",
            copyId: "",
          },
        ];
      }
      renderStats();
      renderCategoryPills();
      renderPopularGrid();
      renderPcAssets();
      renderHpAssets();
      renderHero();
      startHeroSlider();
    }

    function setSection(sectionId) {
      menuButtons.forEach((btn) => {
        const active = btn.dataset.target === sectionId;
        btn.classList.toggle("active", active);
      });
      sections.forEach((section) => {
        section.classList.toggle("active", section.id === sectionId);
      });
    }

    menuButtons.forEach((btn) => {
      btn.addEventListener("click", () => setSection(btn.dataset.target));
    });
    searchPcInput.addEventListener("input", renderPcAssets);
    searchHpInput.addEventListener("input", renderHpAssets);
    globalSearchInput?.addEventListener("input", () => {
      renderPopularGrid();
      renderPcAssets();
      renderHpAssets();
    });
    closeInstallStrip?.addEventListener("click", () => {
      installStrip?.classList.add("hide");
    });
    document.addEventListener("click", async (event) => {
      const target = event.target.closest("[data-copy-id]");
      if (!target) return;
      const idValue = String(target.dataset.copyId || "").trim();
      if (!idValue) return;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(idValue);
        } else {
          const temp = document.createElement("textarea");
          temp.value = idValue;
          document.body.appendChild(temp);
          temp.select();
          document.execCommand("copy");
          temp.remove();
        }
        target.classList.add("ok");
        target.textContent = "Copied";
        setTimeout(() => {
          target.classList.remove("ok");
          target.textContent = "Copy ID";
        }, 1200);
      } catch {
        target.textContent = "Copy gagal";
      }
    });
    loadCatalog().catch(() => {
      popularGrid.innerHTML = '<div class="empty">Gagal load katalog.</div>';
      pcGrid.innerHTML = '<div class="empty">Gagal load asset PC.</div>';
      hpGrid.innerHTML = '<div class="empty">Gagal load asset HP.</div>';
    });
  </script>
</body>
</html>`;
}

async function readJsonFileSafe(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function getTodayKey() {
  return new Date().toISOString().slice(0, 10);
}

function pruneSessions(sessionStore) {
  const now = Date.now();
  for (const [token, session] of sessionStore.entries()) {
    if (!session || session.expireAt <= now) {
      sessionStore.delete(token);
    }
  }
}

function makeSession(sessionStore) {
  const token = crypto.randomBytes(24).toString("hex");
  sessionStore.set(token, { createdAt: Date.now(), expireAt: Date.now() + SESSION_TTL_MS });
  return token;
}

function isAuthed(req, sessionStore) {
  pruneSessions(sessionStore);
  const cookies = readCookies(req.headers.cookie || "");
  const token = cookies[SESSION_COOKIE];
  if (!token) return false;
  return sessionStore.has(token);
}

function clearSession(res) {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
}

async function collectSummary({ client, commands }) {
  const aiUsagePath = path.join(process.cwd(), "data", "ai-usage.json");
  const historyPath = path.join(process.cwd(), "data", "review-history.json");
  const aiStore = await readJsonFileSafe(aiUsagePath, { days: {} });
  const historyStore = await readJsonFileSafe(historyPath, { entries: {} });
  const assets = await listAssets().catch(() => []);
  const mobileAssets = await listMobileAssets().catch(() => []);

  const day = aiStore?.days?.[getTodayKey()] || {};
  const dailyBudgetUSD = Number(process.env.AI_DAILY_BUDGET_USD || 5);
  const maxRequestsPerDay = Number(process.env.AI_MAX_REQUESTS_PER_DAY || 250);
  const totalCostUSD = Number(day.totalCostUSD || 0);
  const entries = historyStore?.entries && typeof historyStore.entries === "object" ? historyStore.entries : {};
  const lastSeenList = Object.values(entries)
    .map((item) => item?.lastSeen)
    .filter(Boolean)
    .sort()
    .reverse();
  const lastSeen = lastSeenList[0] || "";

  return {
    bot: {
      ready: client.isReady(),
      tag: client.user?.tag || "",
      id: client.user?.id || "",
      uptimeSec: client.uptime ? Math.floor(client.uptime / 1000) : 0,
      guildCount: client.guilds.cache.size,
      commandCount: commands.length,
    },
    ai: {
      totalRequests: Number(day.totalRequests || 0),
      totalCostUSD,
      dailyBudgetUSD,
      remainingBudgetUSD: Math.max(0, dailyBudgetUSD - totalCostUSD),
      maxRequestsPerDay,
    },
    assets: {
      fileCount: assets.length,
      mobileCount: mobileAssets.length,
    },
    reviewHistory: {
      totalEntries: Object.keys(entries).length,
      lastUpdatedLabel: lastSeen ? new Date(lastSeen).toLocaleString("id-ID") : "-",
    },
    system: {
      nowSec: nowSec(),
      nodeVersion: process.version,
      privateOnlyMode: process.env.PRIVATE_ONLY_MODE !== "false",
      selfUpdateEnabled: SELF_UPDATE_ENABLED,
    },
  };
}

async function uploadDashboardAssets(filePayloads) {
  const rawFiles = Array.isArray(filePayloads) ? filePayloads : [];
  if (rawFiles.length === 0) {
    throw new Error("Tidak ada file yang dikirim.");
  }

  const files = rawFiles.slice(0, MAX_UPLOAD_FILES);
  const success = [];
  const failed = [];

  for (const file of files) {
    const name = String(file?.name || "").trim();
    const contentBase64 = String(file?.contentBase64 || "").trim();
    try {
      if (!name) {
        throw new Error("Nama file kosong.");
      }
      if (!contentBase64) {
        throw new Error("Konten file kosong.");
      }

      const buffer = Buffer.from(contentBase64, "base64");
      if (!buffer.length) {
        throw new Error("Konten base64 tidak valid.");
      }
      if (buffer.length > MAX_UPLOAD_BYTES_PER_FILE) {
        throw new Error(`Ukuran file > ${Math.floor(MAX_UPLOAD_BYTES_PER_FILE / (1024 * 1024))} MB.`);
      }

      const saved = await saveAssetBuffer({
        sourceName: name,
        customName: "",
        buffer,
      });

      success.push({
        fileName: saved.fileName,
        type: saved.type,
        sizeLabel: saved.sizeLabel,
        deletedExisting: saved.deletedExisting || null,
        deletedExistingList: Array.isArray(saved.deletedExistingList) ? saved.deletedExistingList : [],
      });
    } catch (error) {
      failed.push({
        name: name || "unknown",
        reason: error?.message || "unknown error",
      });
    }
  }

  return {
    success,
    failed,
    skipped: Math.max(0, rawFiles.length - files.length),
  };
}

function startDashboard({ client, rest, clientId, getCommandsBody, syncGuildCommands }) {
  const enabled = process.env.DASHBOARD_ENABLED === "true";
  if (!enabled) {
    console.log("Dashboard: disabled (DASHBOARD_ENABLED!=true).");
    return null;
  }

  const username = String(process.env.DASHBOARD_USERNAME || "").trim();
  const password = String(process.env.DASHBOARD_PASSWORD || "").trim();
  if (!username || !password) {
    console.log("Dashboard: disabled (DASHBOARD_USERNAME / DASHBOARD_PASSWORD belum di-set).");
    return null;
  }

  const host = String(process.env.DASHBOARD_HOST || "127.0.0.1").trim();
  const port = toInt(process.env.DASHBOARD_PORT, 3001);
  const appName = String(process.env.DASHBOARD_TITLE || "LYVA Bot Dashboard").trim();
  const sessions = new Map();

  const server = http.createServer(async (req, res) => {
    try {
      const method = String(req.method || "GET").toUpperCase();
      const url = new URL(req.url || "/", "http://localhost");
      const authed = isAuthed(req, sessions);

      if (method === "GET" && (url.pathname === "/" || url.pathname === "/member")) {
        sendHtml(
          res,
          200,
          buildMemberPage({
            title: MEMBER_PAGE_TITLE,
            promoUrl: MEMBER_PROMO_URL,
            discordUrl: MEMBER_DISCORD_URL,
          }),
        );
        return;
      }

      if (method === "GET" && url.pathname === "/dashboard") {
        sendHtml(res, 200, buildPage({ appName, authed }));
        return;
      }

      if (method === "GET" && url.pathname === "/api/public/catalog") {
        const assets = await listAssets().catch(() => []);
        const mobile = await listMobileAssets().catch(() => []);
        const previewLookup = await loadPreviewLookup().catch(() => new Map());
        const studioLiteCount = mobile.filter((item) => String(item.kind || "").toLowerCase() === "studio-lite").length;
        const pcAssets = assets.map((item) => {
          const previewFileName = findPreviewFileName(previewLookup, [item.fileName, item.baseName, item.id]);
          return {
            id: item.id,
            fileName: item.fileName,
            baseName: item.baseName,
            ext: item.ext,
            type: item.type,
            sizeBytes: item.sizeBytes,
            sizeLabel: item.sizeLabel,
            updatedAt: item.updatedAt,
            imageUrl: previewFileName ? `/api/public/asset-preview?file=${encodeURIComponent(previewFileName)}` : "",
            downloadUrl: `/api/public/assets/download?file=${encodeURIComponent(item.fileName)}`,
          };
        });
        const hpAssets = mobile.map((item) => {
          const previewFileName = findPreviewFileName(previewLookup, [item.name, item.key, item.id]);
          return {
            key: item.key,
            name: item.name,
            id: item.id,
            kind: item.kind,
            updatedAt: item.updatedAt,
            imageUrl: previewFileName ? `/api/public/asset-preview?file=${encodeURIComponent(previewFileName)}` : "",
          };
        });
        sendJson(res, 200, {
          ok: true,
          pcAssets,
          hpAssets,
          assets: pcAssets,
          mobile: hpAssets,
          summary: {
            fileCount: pcAssets.length,
            mobileCount: hpAssets.length,
            studioLiteCount,
            commandHint: "/review /asset",
          },
        });
        return;
      }

      if (method === "GET" && url.pathname === "/api/public/asset-preview") {
        const previewName = String(url.searchParams.get("file") || "").trim();
        if (!previewName) {
          sendJson(res, 400, { ok: false, error: "Parameter file wajib diisi." });
          return;
        }
        const safeName = path.basename(previewName);
        if (safeName !== previewName) {
          sendJson(res, 400, { ok: false, error: "Nama file preview tidak valid." });
          return;
        }
        const ext = String(path.extname(safeName)).toLowerCase();
        if (!PUBLIC_PREVIEW_EXTENSIONS.has(ext)) {
          sendJson(res, 400, { ok: false, error: "Format preview tidak didukung." });
          return;
        }

        const previewPath = path.join(PUBLIC_PREVIEW_DIR, safeName);
        let buffer;
        try {
          buffer = await fs.readFile(previewPath);
        } catch {
          sendJson(res, 404, { ok: false, error: "Preview tidak ditemukan." });
          return;
        }
        sendBinary(res, 200, buffer, {
          "Content-Type": toImageContentType(safeName),
          "Content-Length": String(buffer.length),
          "Cache-Control": "public, max-age=300",
        });
        return;
      }

      if (method === "GET" && url.pathname === "/api/public/assets/download") {
        const fileName = String(url.searchParams.get("file") || "").trim();
        if (!fileName) {
          sendJson(res, 400, { ok: false, error: "Parameter file wajib diisi." });
          return;
        }

        const assets = await listAssets().catch(() => []);
        const selected = assets.find((item) => item.fileName === fileName);
        if (!selected) {
          sendJson(res, 404, { ok: false, error: "Asset tidak ditemukan." });
          return;
        }

        const buffer = await fs.readFile(selected.fullPath);
        sendBinary(res, 200, buffer, {
          "Content-Type": toAssetContentType(selected.fileName),
          "Content-Length": String(buffer.length),
          "Content-Disposition": `attachment; filename="${encodeURIComponent(selected.fileName)}"`,
          "Cache-Control": "no-store",
        });
        return;
      }

      if (method === "POST" && url.pathname === "/api/login") {
        const body = await readJsonBody(req);
        const inputUser = String(body.username || "").trim();
        const inputPass = String(body.password || "");
        if (inputUser !== username || inputPass !== password) {
          sendJson(res, 401, { ok: false, error: "Username/password salah." });
          return;
        }

        const token = makeSession(sessions);
        res.setHeader(
          "Set-Cookie",
          `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=86400; SameSite=Lax`,
        );
        sendJson(res, 200, { ok: true });
        return;
      }

      if (method === "POST" && url.pathname === "/api/logout") {
        clearSession(res);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (!authed) {
        sendJson(res, 401, { ok: false, error: "Unauthorized" });
        return;
      }

      if (method === "GET" && url.pathname === "/api/summary") {
        const commands = getCommandsBody();
        const summary = await collectSummary({ client, commands });
        sendJson(res, 200, summary);
        return;
      }

      if (method === "GET" && url.pathname === "/api/assets/list") {
        const items = await listAssets();
        sendJson(res, 200, { ok: true, items });
        return;
      }

      if (method === "GET" && url.pathname === "/api/mobile/list") {
        const kindFilter = String(url.searchParams.get("kind") || "").trim().toLowerCase();
        const items = await listMobileAssets();
        const filtered = kindFilter ? items.filter((item) => String(item.kind || "").toLowerCase() === kindFilter) : items;
        sendJson(res, 200, { ok: true, items: filtered });
        return;
      }

      if (method === "POST" && url.pathname === "/api/mobile/add") {
        const body = await readJsonBody(req, MAX_JSON_BYTES);
        const name = String(body.name || "").trim();
        const id = String(body.id || "").trim();
        const kind = String(body.kind || "studio-lite").trim().toLowerCase();
        if (!name || !id) {
          sendJson(res, 400, { ok: false, error: "name dan id wajib diisi." });
          return;
        }

        const item = await addMobileAsset({
          name,
          id,
          kind,
          createdBy: "dashboard",
        });
        sendJson(res, 200, { ok: true, item });
        return;
      }

      if (method === "GET" && url.pathname === "/api/assets/dedupe-log") {
        const tail = await readAssetDedupeLogTail(120);
        sendJson(res, 200, { ok: true, tail });
        return;
      }

      if (method === "POST" && url.pathname === "/api/assets/upload") {
        const body = await readJsonBody(req, MAX_JSON_BYTES);
        const result = await uploadDashboardAssets(body.files);
        sendJson(res, 200, { ok: true, ...result });
        return;
      }

      if (method === "POST" && url.pathname === "/api/actions/self-update") {
        const result = await triggerSelfUpdate();
        sendJson(res, 200, { ok: true, ...result });
        return;
      }

      if (method === "GET" && url.pathname === "/api/actions/self-update-log") {
        const tail = await readSelfUpdateLogTail(120);
        sendJson(res, 200, { ok: true, tail });
        return;
      }

      if (method === "POST" && url.pathname === "/api/actions/sync-all") {
        let success = 0;
        let failed = 0;
        const failedGuilds = [];

        for (const guild of client.guilds.cache.values()) {
          try {
            await syncGuildCommands(guild.id);
            success += 1;
          } catch (error) {
            failed += 1;
            failedGuilds.push({
              guildId: guild.id,
              reason: error?.message || String(error),
            });
          }
        }

        sendJson(res, 200, { ok: true, success, failed, failedGuilds });
        return;
      }

      if (method === "POST" && url.pathname === "/api/actions/sync-guild") {
        const body = await readJsonBody(req);
        const guildId = String(body.guildId || "").trim();
        if (!guildId) {
          sendJson(res, 400, { ok: false, error: "guildId wajib diisi." });
          return;
        }

        await syncGuildCommands(guildId);
        sendJson(res, 200, { ok: true, guildId });
        return;
      }

      if (method === "POST" && url.pathname === "/api/actions/clear-global") {
        if (!rest || !clientId) {
          sendJson(res, 400, { ok: false, error: "REST client belum siap." });
          return;
        }
        await rest.put(Routes.applicationCommands(clientId), { body: [] });
        sendJson(res, 200, { ok: true });
        return;
      }

      sendJson(res, 404, { ok: false, error: "Not found" });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error?.message || "Internal error" });
    }
  });

  server.listen(port, host, () => {
    console.log(`Dashboard active at http://${host}:${port}`);
  });

  return server;
}

module.exports = {
  startDashboard,
};




