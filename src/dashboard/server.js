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
    @import url("https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap");
    :root {
      --bg: #f4f7fc;
      --bg-soft: #fdfefe;
      --panel: #ffffff;
      --line: #dde4ef;
      --text: #10213f;
      --muted: #62748b;
      --brand: #ff7a00;
      --brand2: #2274e6;
      --accent: #0ea765;
      --danger: #ef4444;
    }
    * { box-sizing: border-box; margin: 0; }
    body {
      font-family: "Plus Jakarta Sans", "Segoe UI", sans-serif;
      color: var(--text);
      background:
        radial-gradient(1000px 520px at 8% -20%, #ffe8d1 0%, transparent 60%),
        radial-gradient(1000px 520px at 100% -20%, #ddebff 0%, transparent 55%),
        var(--bg);
      min-height: 100vh;
      padding: 16px;
    }
    .wrap { max-width: 1360px; margin: 0 auto; }
    .layout {
      display: grid;
      grid-template-columns: 240px minmax(0, 1fr);
      gap: 12px;
      align-items: start;
    }
    .panel {
      border: 1px solid var(--line);
      border-radius: 16px;
      background: var(--panel);
      box-shadow: 0 12px 28px rgba(18, 34, 65, 0.08);
    }
    .sidebar { padding: 14px; position: sticky; top: 16px; display: grid; gap: 10px; }
    .logo {
      border-radius: 12px;
      border: 1px solid #ffd6b0;
      padding: 12px;
      background: linear-gradient(135deg, #ff9f43, #ff6a00);
    }
    .logo h2 { font-size: 20px; font-weight: 800; color: #fff; }
    .logo p { margin-top: 4px; font-size: 12px; color: #ffe7d2; }
    .menu { display: grid; gap: 8px; }
    .menu button {
      width: 100%;
      text-align: left;
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 10px 11px;
      background: #fff;
      color: #2a456f;
      font-weight: 700;
      cursor: pointer;
    }
    .menu button.active {
      background: #fff2e6;
      border-color: #ffc490;
      color: #9d4f00;
    }
    .content { display: grid; gap: 12px; }
    .section { display: none; }
    .section.active { display: block; }
    .hero { padding: 18px; display: grid; gap: 10px; }
    .title { font-size: 32px; font-weight: 800; letter-spacing: .2px; color: #143662; }
    .sub { color: var(--muted); font-size: 14px; line-height: 1.55; }
    .row { display: flex; gap: 8px; flex-wrap: wrap; }
    a.btn, button.btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      border: 0;
      border-radius: 10px;
      padding: 10px 13px;
      color: #fff;
      text-decoration: none;
      font-weight: 700;
      cursor: pointer;
      background: var(--brand);
    }
    a.btn:hover, button.btn:hover { filter: brightness(.96); }
    a.btn.secondary, button.btn.secondary { background: var(--brand2); }
    a.btn.alt, button.btn.alt { background: var(--accent); }
    a.btn.small {
      padding: 7px 10px;
      border-radius: 9px;
      font-size: 12px;
    }
    button.btn.copy { background: var(--brand2); color: #fff; }
    button.btn.copy.ok { background: var(--accent); }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0,1fr)); gap: 10px; }
    .stat { padding: 12px; border: 1px solid var(--line); border-radius: 12px; background: #fff; }
    .stat .k { color: var(--muted); font-size: 11px; font-weight: 700; }
    .stat .v { font-size: 22px; font-weight: 800; margin-top: 5px; color: #173a67; }
    .features { padding: 14px; display: grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap: 10px; }
    .feature { border: 1px solid var(--line); border-radius: 12px; padding: 12px; background: #fff; }
    .feature h3 { font-size: 14px; margin-bottom: 6px; color: #1c3f6b; }
    .feature p { color: var(--muted); font-size: 13px; line-height: 1.45; }
    .catalog { padding: 14px; display: grid; gap: 10px; }
    .search {
      width: 100%;
      padding: 11px 12px;
      border-radius: 10px;
      border: 1px solid var(--line);
      background: #fff;
      color: var(--text);
      outline: none;
    }
    .search:focus { border-color: #ffbf88; box-shadow: 0 0 0 3px #ffe8d3; }
    .card-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
    }
    .asset-card {
      border: 1px solid var(--line);
      border-radius: 12px;
      overflow: hidden;
      background: #fff;
      display: grid;
      grid-template-rows: 160px auto;
    }
    .thumb {
      width: 100%;
      height: 160px;
      object-fit: cover;
      background: #f5f7fb;
      border-bottom: 1px solid var(--line);
    }
    .asset-body {
      padding: 10px;
      display: grid;
      gap: 8px;
    }
    .asset-name {
      font-size: 14px;
      font-weight: 800;
      line-height: 1.3;
      word-break: break-word;
      color: #1b3b64;
    }
    .asset-meta { color: var(--muted); font-size: 12px; line-height: 1.45; }
    .asset-actions { display: flex; flex-wrap: wrap; gap: 6px; }
    .empty { color: var(--muted); font-size: 13px; padding: 12px; border: 1px dashed #ccd8ea; border-radius: 10px; background: #fbfdff; }
    .review-grid {
      padding: 14px;
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }
    .card {
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 12px;
      background: #fff;
    }
    .card h4 { font-size: 14px; margin-bottom: 6px; color: #1b3f6e; }
    .card p, .card li { color: var(--muted); font-size: 13px; line-height: 1.45; }
    .card ul { margin-left: 18px; display: grid; gap: 4px; }
    @media (max-width: 960px) {
      .layout { grid-template-columns: 1fr; }
      .sidebar { position: static; }
      .grid { grid-template-columns: repeat(2, minmax(0,1fr)); }
      .features { grid-template-columns: 1fr; }
      .card-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .review-grid { grid-template-columns: 1fr; }
    }
    @media (max-width: 560px) {
      .grid { grid-template-columns: 1fr; }
      .card-grid { grid-template-columns: 1fr; }
      .title { font-size: 26px; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="layout">
      <aside class="panel sidebar">
        <div class="logo">
          <h2>LYVA HUB</h2>
          <p>Member tools dan free asset Roblox</p>
        </div>
        <div class="menu">
          <button class="active" data-target="section-home">Home</button>
          <button data-target="section-pc">Asset PC</button>
          <button data-target="section-hp">Asset HP</button>
          <button data-target="section-review">Review</button>
        </div>
        <div class="row">
          <a class="btn small" href="${safePromo}" target="_blank" rel="noreferrer">Website</a>
          ${hasDiscord ? `<a class="btn small secondary" href="${safeDiscord}" target="_blank" rel="noreferrer">Discord</a>` : ""}
        </div>
      </aside>

      <main class="content">
        <section class="panel section active" id="section-home">
          <div class="hero">
            <div class="title">${safeTitle}</div>
            <div class="sub">Etalase digital ala marketplace: pilih kategori, lihat kartu produk, lalu download asset atau copy ID langsung.</div>
            <div class="row">
              <a class="btn" href="${safePromo}" target="_blank" rel="noreferrer">Promo LYVA</a>
              ${hasDiscord ? `<a class="btn secondary" href="${safeDiscord}" target="_blank" rel="noreferrer">Masuk Discord</a>` : ""}
              <a class="btn alt" href="/dashboard">Admin Dashboard</a>
            </div>
            <div class="grid" id="statGrid"></div>
          </div>
          <div class="features">
            <div class="feature">
              <h3>Review Script Roblox</h3>
              <p>Pakai command /review paste atau /review ai, hasil review fokus security, performa, dan patch.</p>
            </div>
            <div class="feature">
              <h3>Free Asset Download</h3>
              <p>File .rbxm/.lua bisa di-download langsung dari web. Tiap asset tampil bentuk card + foto/thumbnail fitur.</p>
            </div>
            <div class="feature">
              <h3>Studio Lite ID</h3>
              <p>Asset HP dipisah ke halaman sendiri, lengkap dengan ID dan tombol copy cepat.</p>
            </div>
          </div>
        </section>

        <section class="panel section" id="section-pc">
          <div class="catalog">
            <input id="searchPcInput" class="search" placeholder="Cari asset PC..." />
            <div id="pcGrid" class="card-grid"></div>
          </div>
        </section>

        <section class="panel section" id="section-hp">
          <div class="catalog">
            <input id="searchHpInput" class="search" placeholder="Cari asset HP / studio lite..." />
            <div id="hpGrid" class="card-grid"></div>
          </div>
        </section>

        <section class="panel section" id="section-review">
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
    const pcGrid = document.getElementById("pcGrid");
    const hpGrid = document.getElementById("hpGrid");
    const searchPcInput = document.getElementById("searchPcInput");
    const searchHpInput = document.getElementById("searchHpInput");
    const menuButtons = Array.from(document.querySelectorAll(".menu button"));
    const sections = Array.from(document.querySelectorAll(".section"));

    let state = { pcAssets: [], hpAssets: [], summary: {} };

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
        '<text x="32" y="188" fill="#fff" font-size="34" font-family="Nunito,Segoe UI,sans-serif" font-weight="800">' +
        text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") +
        "</text></svg>";
      return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
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

    function renderPcAssets() {
      const q = String(searchPcInput.value || "").trim().toLowerCase();
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
      const q = String(searchHpInput.value || "").trim().toLowerCase();
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
      renderStats();
      renderPcAssets();
      renderHpAssets();
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
