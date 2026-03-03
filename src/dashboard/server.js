const http = require("http");
const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");
const { Routes } = require("discord.js");
const { listAssets, saveAssetBuffer, ASSET_DEDUPE_LOG_PATH } = require("../assets/library");
const { listMobileAssets, addMobileAsset } = require("../assets/mobile-library");
const { listNewsFeed } = require("../news/feed");
const { normalizeCodeInput, formatCodeForDiscord } = require("../review/formatter");
const { analyzeCode, formatFindings, formatSignalScan } = require("../review/rules");
const { buildChecklistMessage, buildFeedbackTemplate } = require("../review/templates");
const { requestOpenAIReview, formatAIReviewReport } = require("../review/ai");

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
const MEMBER_PROMO_URL = String(process.env.MEMBER_PROMO_URL || "https://lyvaindonesia.my.id").trim();
const MEMBER_SITE_URL = String(process.env.MEMBER_SITE_URL || "https://lyvaindonesia.my.id").trim();
const MEMBER_OLD_HOST = String(process.env.MEMBER_OLD_HOST || "dashboard.lyvaindonesia.my.id").trim().toLowerCase();
const MEMBER_ADSENSE_CLIENT = String(process.env.MEMBER_ADSENSE_CLIENT || "").trim();
const MEMBER_AD_SLOT_TOP = String(process.env.MEMBER_AD_SLOT_TOP || "").trim();
const MEMBER_AD_SLOT_SIDEBAR = String(process.env.MEMBER_AD_SLOT_SIDEBAR || "").trim();
const MEMBER_AD_SLOT_BOTTOM = String(process.env.MEMBER_AD_SLOT_BOTTOM || "").trim();
const PUBLIC_PREVIEW_DIR = path.join(process.cwd(), "assets", "previews");
const PUBLIC_PREVIEW_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const PUBLIC_REVIEW_MAX_CHARS = toInt(process.env.PUBLIC_REVIEW_MAX_CHARS, 12000);
const PUBLIC_REVIEW_MAX_JSON_BYTES = toInt(process.env.PUBLIC_REVIEW_MAX_JSON_BYTES, 512 * 1024);
const PUBLIC_REVIEW_AI_ENABLED = process.env.PUBLIC_REVIEW_AI_ENABLED !== "false";
const PUBLIC_REVIEW_LIMIT_WINDOW_MS = toInt(process.env.PUBLIC_REVIEW_LIMIT_WINDOW_MS, 60 * 1000);
const PUBLIC_REVIEW_LIMIT_PER_WINDOW = toInt(process.env.PUBLIC_REVIEW_LIMIT_PER_WINDOW, 6);

function toInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function normalizeAdSenseClientId(value) {
  let client = String(value || "").trim();
  if (!client) return "";
  if (/^\d{6,}$/.test(client)) {
    client = `ca-pub-${client}`;
  }
  if (!/^ca-pub-\d{6,}$/.test(client)) {
    return "";
  }
  return client;
}

function normalizeAdSlot(value) {
  const slot = String(value || "").trim().replace(/[^0-9]/g, "");
  if (!slot) return "";
  if (!/^\d{6,}$/.test(slot)) return "";
  return slot;
}

function clipReviewOutput(text, max = 18000) {
  const value = String(text || "").trim();
  if (value.length <= max) return value;
  return `${value.slice(0, max - 32)}\n\n... [output dipotong]`;
}

function buildIssueFocusedInput(source, findings = [], options = {}) {
  const radius = Number(options.radius || 6);
  const maxSnippets = Number(options.maxSnippets || 3);
  const maxChars = Number(options.maxChars || 4200);
  const text = String(source || "");
  const lines = text.replace(/\r\n/g, "\n").split("\n");

  const severityRank = { critical: 0, high: 1, medium: 2, low: 3 };
  const ordered = [...(Array.isArray(findings) ? findings : [])]
    .sort((a, b) => {
      const sevA = severityRank[String(a?.severity || "medium").toLowerCase()] ?? 9;
      const sevB = severityRank[String(b?.severity || "medium").toLowerCase()] ?? 9;
      if (sevA !== sevB) return sevA - sevB;
      return (a?.line || 999999) - (b?.line || 999999);
    })
    .slice(0, maxSnippets);

  if (ordered.length === 0) {
    const fallbackLines = lines.slice(0, Math.min(80, lines.length)).join("\n");
    return {
      code: fallbackLines,
      context: "Tidak ada finding spesifik dari local engine; kirim konteks awal script.",
      snippetCount: 0,
    };
  }

  const blocks = [];
  const contexts = [];
  const used = new Set();

  ordered.forEach((finding, index) => {
    const lineNum = Number(finding?.line || 1);
    const center = Math.max(1, Math.min(lines.length, lineNum));
    const start = Math.max(1, center - radius);
    const end = Math.min(lines.length, center + radius);
    const key = `${start}:${end}`;
    if (used.has(key)) return;
    used.add(key);

    const snippet = lines.slice(start - 1, end).join("\n");
    const title = `-- [ISSUE ${index + 1}] ${String(finding?.rule || "unknown-rule")} line ${center}`;
    blocks.push(`${title}\n${snippet}`);
    contexts.push(`${index + 1}. ${String(finding?.rule || "unknown-rule")} (line ${center})`);
  });

  let joined = blocks.join("\n\n");
  if (joined.length > maxChars) {
    joined = `${joined.slice(0, maxChars - 80)}\n\n-- [TRUNCATED FOR AI INPUT]`;
  }

  return {
    code: joined,
    context: `Perbaiki hanya blok issue berikut: ${contexts.join("; ")}`,
    snippetCount: blocks.length,
  };
}

function checkPublicReviewRateLimit(store, key) {
  const now = Date.now();
  const slot = store.get(key) || { count: 0, resetAt: now + PUBLIC_REVIEW_LIMIT_WINDOW_MS };
  if (now >= slot.resetAt) {
    slot.count = 0;
    slot.resetAt = now + PUBLIC_REVIEW_LIMIT_WINDOW_MS;
  }
  slot.count += 1;
  store.set(key, slot);
  return {
    ok: slot.count <= PUBLIC_REVIEW_LIMIT_PER_WINDOW,
    count: slot.count,
    resetAt: slot.resetAt,
  };
}

function buildAdsTxtContent() {
  const adClient = normalizeAdSenseClientId(MEMBER_ADSENSE_CLIENT);
  if (!adClient) return "";
  const sellerId = adClient.replace(/^ca-pub-/i, "");
  if (!sellerId) return "";
  return `google.com, pub-${sellerId}, DIRECT, f08c47fec0942fa0\n`;
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
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    Pragma: "no-cache",
  });
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
    .page-loader {
      position: fixed;
      inset: 0;
      z-index: 99999;
      background: #000;
      display: grid;
      place-items: center;
      transition: opacity .25s ease;
    }
    .page-loader.is-hidden {
      opacity: 0;
      pointer-events: none;
    }
    #load {
      position: relative;
      width: 600px;
      height: 36px;
      overflow: visible;
      user-select: none;
      cursor: default;
    }
    #load div {
      position: absolute;
      width: 20px;
      height: 36px;
      opacity: 0;
      font-family: Helvetica, Arial, sans-serif;
      animation: move 2s linear infinite;
      transform: rotate(180deg);
      color: #35c4f0;
      font-size: 26px;
      font-weight: 700;
    }
    #load div:nth-child(2) { animation-delay: 0.2s; }
    #load div:nth-child(3) { animation-delay: 0.4s; }
    #load div:nth-child(4) { animation-delay: 0.6s; }
    #load div:nth-child(5) { animation-delay: 0.8s; }
    #load div:nth-child(6) { animation-delay: 1s; }
    #load div:nth-child(7) { animation-delay: 1.2s; }
    @keyframes move {
      0% { left: 0; opacity: 0; }
      35% { left: 41%; transform: rotate(0deg); opacity: 1; }
      65% { left: 59%; transform: rotate(0deg); opacity: 1; }
      100% { left: 100%; transform: rotate(-180deg); opacity: 0; }
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
  <div id="pageLoader" class="page-loader" aria-label="Memuat halaman">
    <div id="load">
      <div>G</div>
      <div>N</div>
      <div>I</div>
      <div>D</div>
      <div>A</div>
      <div>O</div>
      <div>L</div>
    </div>
  </div>
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
    function hidePageLoader() {
      const el = document.getElementById("pageLoader");
      if (!el) return;
      el.classList.add("is-hidden");
      setTimeout(() => {
        if (el && el.parentNode) el.parentNode.removeChild(el);
      }, 260);
    }

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
    hidePageLoader();
    window.addEventListener("load", hidePageLoader);
  </script>
</body>
</html>`;
}

function buildMemberPage({
  title = MEMBER_PAGE_TITLE,
  promoUrl = MEMBER_PROMO_URL,
  discordUrl = MEMBER_DISCORD_URL,
  siteUrl = MEMBER_SITE_URL,
}) {
  const safeTitle = sanitizeText(title || "LYVA Member Hub");
  const hasDiscord = Boolean(discordUrl);
  const promoJs = JSON.stringify(String(promoUrl || "#"));
  const discordJs = JSON.stringify(String(discordUrl || ""));
  const siteJs = JSON.stringify(String(siteUrl || ""));
  const adClient = normalizeAdSenseClientId(MEMBER_ADSENSE_CLIENT);
  const adSlotTop = normalizeAdSlot(MEMBER_AD_SLOT_TOP);
  const adSlotSidebar = normalizeAdSlot(MEMBER_AD_SLOT_SIDEBAR);
  const adSlotBottom = normalizeAdSlot(MEMBER_AD_SLOT_BOTTOM);
  const adClientJs = JSON.stringify(adClient);
  const adSlotTopJs = JSON.stringify(adSlotTop);
  const adSlotSidebarJs = JSON.stringify(adSlotSidebar);
  const adSlotBottomJs = JSON.stringify(adSlotBottom);
  const adSenseScript = adClient
    ? `<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(adClient)}" crossorigin="anonymous"></script>`
    : "";
  const adSenseMeta = adClient
    ? `<meta name="google-adsense-account" content="${sanitizeText(adClient)}" />`
    : "";

  return `<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  ${adSenseMeta}
  <title>${safeTitle}</title>
  ${adSenseScript}
  <style>
    @import url("https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&family=Poppins:wght@400;500;600;700&display=swap");
    :root {
      --bg: #f2f5fb;
      --panel: #ffffff;
      --line: #d8e0ef;
      --text: #15264a;
      --muted: #6f829f;
      --brand: #212bb1;
      --brand-soft: #edf1ff;
      --accent: #2f68d5;
      --shadow: 0 12px 30px rgba(20, 36, 74, 0.08);
      --radius: 14px;
    }
    * { box-sizing: border-box; margin: 0; }
    html, body { min-height: 100%; width: 100%; }
    #app { min-height: 100vh; }
    body {
      font-family: "Poppins", "Segoe UI", sans-serif;
      font-size: 14px;
      color: var(--text);
      overflow-x: hidden;
      background:
        radial-gradient(900px 420px at 110% -20%, #dfe8ff 0%, transparent 55%),
        radial-gradient(900px 420px at -20% -10%, #f8dfe9 0%, transparent 55%),
        var(--bg);
    }
    .page-loader {
      position: fixed;
      inset: 0;
      z-index: 99999;
      background: #000;
      display: grid;
      place-items: center;
      transition: opacity .25s ease;
    }
    .page-loader.is-hidden {
      opacity: 0;
      pointer-events: none;
    }
    #load {
      position: relative;
      width: 600px;
      height: 36px;
      overflow: visible;
      user-select: none;
      cursor: default;
    }
    #load div {
      position: absolute;
      width: 20px;
      height: 36px;
      opacity: 0;
      font-family: Helvetica, Arial, sans-serif;
      animation: move 2s linear infinite;
      transform: rotate(180deg);
      color: #35c4f0;
      font-size: 26px;
      font-weight: 700;
    }
    #load div:nth-child(2) { animation-delay: 0.2s; }
    #load div:nth-child(3) { animation-delay: 0.4s; }
    #load div:nth-child(4) { animation-delay: 0.6s; }
    #load div:nth-child(5) { animation-delay: 0.8s; }
    #load div:nth-child(6) { animation-delay: 1s; }
    #load div:nth-child(7) { animation-delay: 1.2s; }
    @keyframes move {
      0% { left: 0; opacity: 0; }
      35% { left: 41%; transform: rotate(0deg); opacity: 1; }
      65% { left: 59%; transform: rotate(0deg); opacity: 1; }
      100% { left: 100%; transform: rotate(-180deg); opacity: 0; }
    }
    a { color: inherit; }

    .page {
      max-width: 1400px;
      margin: 0 auto;
      padding: 8px 14px 0;
      min-height: 100vh;
      display: flex;
    }

    .main {
      min-width: 0;
      display: grid;
      align-content: start;
      width: 100%;
      flex: 1;
    }
    .main-inner {
      width: 100%;
      max-width: 1180px;
      margin: 0 auto;
      padding: 10px 16px 0;
      display: flex;
      flex-direction: column;
      gap: 12px;
      min-height: 100vh;
    }

    .install {
      border: 1px solid var(--line);
      border-radius: 12px;
      background: linear-gradient(90deg, rgba(33, 43, 177, 0.14), rgba(241, 87, 125, 0.14)), #eef2fb;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
      min-height: 48px;
      padding: 8px 12px;
      color: #2d466f;
      font-size: 14px;
    }
    .install-close {
      border: 0;
      background: transparent;
      color: #2d4468;
      font-size: 18px;
      cursor: pointer;
      line-height: 1;
    }

    .topbar {
      border: 1px solid var(--line);
      border-radius: 12px;
      background: var(--panel);
      min-height: 72px;
      padding: 10px 16px;
      display: flex;
      align-items: center;
      gap: 14px;
      flex-wrap: wrap;
    }
    .brand {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      min-width: 250px;
      font-family: "Outfit", "Poppins", sans-serif;
      font-size: 22px;
      font-weight: 700;
      color: #1a3175;
      text-transform: uppercase;
    }
    .brand-mark {
      width: 34px;
      height: 34px;
      border-radius: 9px;
      display: grid;
      place-items: center;
      color: #fff;
      background: linear-gradient(145deg, #2443d8, #f1577d);
      font-weight: 700;
      font-size: 15px;
    }

    .search {
      flex: 1;
      min-width: 260px;
      max-width: 640px;
      position: relative;
    }
    .search input {
      width: 100%;
      border: 1px solid #cad6ec;
      border-radius: 999px;
      padding: 12px 42px 12px 16px;
      outline: none;
      font-size: 14px;
      color: #284065;
      background: #fff;
    }
    .search input:focus {
      border-color: #9aadd6;
      box-shadow: 0 0 0 3px #e9efff;
    }
    .search .ico {
      position: absolute;
      right: 14px;
      top: 10px;
      color: #7286ab;
      width: 18px;
      height: 18px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      line-height: 1;
    }

    .actions {
      display: inline-flex;
      gap: 8px;
      align-items: center;
      margin-left: auto;
    }
    .btn {
      border: 1px solid var(--brand);
      border-radius: 999px;
      padding: 8px 16px;
      font-size: 14px;
      font-weight: 700;
      text-decoration: none;
      white-space: nowrap;
      cursor: pointer;
      line-height: 1.2;
    }
    .btn.primary { background: var(--brand); color: #fff; }
    .btn.outline { background: #fff; color: var(--brand); }
    .btn.light { border-color: #cfdbf2; color: #37527e; }

    .game-strip {
      border-radius: 12px;
      background: #1a22a5;
      padding: 8px 10px;
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }
    .game-strip a {
      color: #fff;
      text-decoration: none;
      font-size: 12px;
      font-weight: 600;
      border-radius: 999px;
      padding: 7px 10px;
    }
    .game-strip a:hover { background: rgba(255, 255, 255, 0.13); }
    .section-tabs {
      border: 1px solid var(--line);
      border-radius: 12px;
      background: #fff;
      padding: 8px 10px;
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .tab-btn {
      border: 1px solid #cfd9ee;
      border-radius: 999px;
      background: #fff;
      color: #35507d;
      font-size: 12px;
      font-weight: 600;
      min-height: 34px;
      padding: 7px 13px;
      cursor: pointer;
      line-height: 1.2;
    }
    .tab-btn.active {
      border-color: var(--brand);
      background: var(--brand-soft);
      color: var(--brand);
    }

    .section { display: none; }
    .section.active { display: block; }

    .news {
      border: 1px solid var(--line);
      border-radius: 16px;
      background: #fff;
      padding: 14px;
      display: grid;
      grid-template-columns: minmax(0, 1fr) 330px;
      gap: 14px;
      align-items: start;
      box-shadow: var(--shadow);
    }
    .news-main {
      min-width: 0;
      padding-right: 12px;
      border-right: 1px solid #e0e7f4;
      display: grid;
      align-content: start;
      grid-auto-rows: max-content;
      gap: 12px;
    }
    .bread {
      font-size: 12px;
      color: #7b8eaa;
      overflow-wrap: anywhere;
    }
    .tag {
      width: fit-content;
      border-radius: 6px;
      background: #1a22a5;
      color: #fff;
      font-size: 11px;
      font-weight: 700;
      padding: 6px 9px;
      text-transform: uppercase;
    }
    .news-title {
      font-family: "Poppins", "Outfit", sans-serif;
      font-size: clamp(16px, 1.3vw, 26px);
      line-height: 1.2;
      letter-spacing: -0.01em;
      color: #122249;
      font-weight: 700;
      max-width: 100%;
      overflow-wrap: break-word;
    }
    .meta {
      color: #6e83a6;
      font-size: 11px;
      line-height: 1.5;
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    }
    .meta-author {
      color: #163374;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.01em;
    }
    .meta-dot {
      color: #9aa8bf;
    }
    .share {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .share-btn {
      min-width: 88px;
      border-radius: 3px;
      border: 0;
      padding: 6px 8px;
      color: #fff;
      text-decoration: none;
      font-size: 9px;
      font-weight: 600;
      background: #2f68d5;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
    }
    .share-btn.facebook { background: #1c69d4; }
    .share-btn.twitter { background: #50a1e4; }
    .share-btn.linkedin { background: #00689f; }
    .share-btn.share-more {
      min-width: 32px;
      width: 32px;
      padding: 6px 0;
      background: #f2f4f8;
      color: #9ca8bc;
      border: 1px solid #dfe4ef;
    }
    .share-ico {
      font-size: 9px;
      line-height: 1;
      font-weight: 700;
    }
    .cover {
      width: 100%;
      max-height: 250px;
      object-fit: cover;
      border: 1px solid #dce5f4;
      border-radius: 0;
      background: #edf2fb;
    }
    .body {
      font-size: 13px;
      color: #314b72;
      line-height: 1.6;
      display: grid;
      gap: 8px;
    }
    .post-extra {
      margin-top: 8px;
      padding-top: 14px;
      border-top: 1px solid #e1e7f3;
      display: grid;
      gap: 18px;
    }
    .extra-share {
      display: grid;
      gap: 8px;
    }
    .extra-share-title {
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.02em;
      color: #2c3a55;
      text-transform: uppercase;
    }
    .extra-share-list {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .extra-pill {
      min-width: 70px;
      height: 30px;
      border-radius: 3px;
      border: 0;
      color: #fff;
      font-size: 11px;
      font-weight: 600;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      text-decoration: none;
      padding: 0 10px;
    }
    .extra-pill.fb { background: #1c69d4; }
    .extra-pill.tw { background: #50a1e4; }
    .extra-pill.in { background: #00689f; }
    .extra-pill.wa { background: #22b455; }
    .extra-pill.mail { background: #101318; }
    .extra-pill.tg { background: #168fd8; }
    .author-box {
      display: grid;
      gap: 8px;
    }
    .author-name {
      font-family: "Poppins", "Outfit", sans-serif;
      font-size: 18px;
      font-weight: 700;
      color: #152b57;
    }
    .author-bio {
      font-size: 13px;
      line-height: 1.7;
      color: #3b4f74;
      max-width: 820px;
    }
    .related-wrap {
      display: grid;
      gap: 10px;
    }
    .related-head {
      font-size: 16px;
      font-weight: 700;
      color: #1a2d56;
      border-bottom: 1px solid #dfe6f4;
      padding-bottom: 7px;
      text-transform: uppercase;
    }
    .related-head span {
      color: #2f3cd8;
    }
    .related-grid {
      display: grid;
      gap: 10px;
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
    .related-card {
      text-decoration: none;
      color: inherit;
      display: grid;
      gap: 6px;
      min-width: 0;
    }
    .related-card img {
      width: 100%;
      height: 95px;
      border-radius: 10px;
      object-fit: cover;
      background: #edf2fb;
    }
    .related-title {
      font-size: 12px;
      font-weight: 600;
      line-height: 1.35;
      color: #263a62;
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .related-date {
      font-size: 11px;
      color: #8b9bb8;
    }

    .news-side {
      min-width: 0;
      display: grid;
      align-content: start;
      gap: 12px;
      overflow: hidden;
      position: sticky;
      top: 14px;
      max-height: calc(100vh - 24px);
      overflow-y: auto;
      padding-right: 2px;
    }
    .side-heading {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-top: 2px;
    }
    .side-heading .line {
      flex: 1;
      height: 1px;
      background: #d8dfeb;
    }
    .side-title {
      font-family: "Poppins", "Outfit", sans-serif;
      font-size: 16px;
      line-height: 1.12;
      color: #263245;
      letter-spacing: -0.005em;
      font-weight: 700;
      white-space: nowrap;
    }
    .side-title.latest-heading {
      font-size: 18px;
      font-weight: 700;
    }
    .side-title.topup-heading {
      font-size: 18px;
      font-weight: 700;
    }
    .latest-list {
      display: grid;
      gap: 0;
    }
    .latest-item {
      border: 0;
      background: #fff;
      padding: 12px 0;
      display: grid;
      grid-template-columns: 96px minmax(0, 1fr);
      gap: 10px;
      text-decoration: none;
      color: inherit;
      min-width: 0;
      max-width: 100%;
      box-sizing: border-box;
      border-bottom: 1px solid #e4e9f2;
    }
    .latest-item img {
      width: 96px;
      height: 60px;
      border: 0;
      border-radius: 8px;
      object-fit: cover;
      background: #edf2fb;
    }
    .latest-copy {
      min-width: 0;
      overflow: hidden;
      display: grid;
      gap: 4px;
      align-content: start;
    }
    .latest-title {
      font-size: 13px;
      font-weight: 600;
      color: #212a39;
      line-height: 1.3;
      overflow-wrap: anywhere;
      word-break: break-word;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .latest-date {
      font-size: 11px;
      color: #9ba7bc;
    }
    .topics {
      display: grid;
      gap: 12px;
    }
    .topics a {
      border: 1px solid #2642cb;
      border-radius: 18px;
      text-decoration: none;
      color: #242d3d;
      text-align: center;
      padding: 10px 10px;
      font-size: 12px;
      font-weight: 500;
      line-height: 1.2;
      background: #fff;
    }
    .ad-wrap {
      width: 100%;
      max-width: 100%;
      border: 1px solid #d8e2f2;
      border-radius: 10px;
      background: #f8fbff;
      padding: 8px;
      overflow: hidden;
    }
    .ad-wrap .adsbygoogle {
      width: 100%;
      max-width: 100%;
    }
    .ad-main-top {
      margin-top: 2px;
    }
    .ad-main-bottom {
      margin-top: 10px;
    }
    .ad-side {
      margin-top: 4px;
    }

    .panel {
      border: 1px solid var(--line);
      border-radius: 16px;
      background: #fff;
      padding: 16px;
      box-shadow: var(--shadow);
      display: grid;
      gap: 12px;
    }
    .head {
      font-family: "Poppins", "Outfit", sans-serif;
      font-size: 25px;
      color: #1a3263;
      letter-spacing: -0.01em;
    }
    .search-inline {
      width: 100%;
      max-width: 460px;
      border: 1px solid #cad6ec;
      border-radius: 999px;
      padding: 10px 14px;
      outline: none;
      font-size: 14px;
      color: #294267;
    }
    .search-inline:focus {
      border-color: #99add6;
      box-shadow: 0 0 0 3px #e9efff;
    }

    .asset-grid {
      display: grid;
      gap: 14px;
      grid-template-columns: repeat(4, minmax(0, 1fr));
    }
    .asset-card {
      border: 1px solid #d9e3f3;
      border-radius: 14px;
      background: #fff;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      height: auto;
      min-width: 0;
    }
    .asset-thumb {
      width: 100%;
      height: 128px;
      flex: 0 0 128px;
      object-fit: cover;
      background: #eef3fb;
      border-bottom: 1px solid #dce6f5;
    }
    .asset-body {
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 7px;
      min-width: 0;
    }
    .asset-name {
      font-family: "Poppins", "Outfit", sans-serif;
      font-size: 14px;
      line-height: 1.2;
      color: #132d5a;
      font-weight: 700;
      overflow-wrap: anywhere;
      word-break: break-word;
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .asset-meta {
      font-size: 11px;
      color: #6d82a7;
      line-height: 1.35;
      overflow-wrap: anywhere;
      display: -webkit-box;
      -webkit-line-clamp: 1;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .asset-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: auto;
    }
    .action {
      border: 0;
      border-radius: 10px;
      min-height: 30px;
      padding: 6px 10px;
      background: #1d39bf;
      color: #fff;
      text-decoration: none;
      font-size: 11px;
      font-weight: 700;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: fit-content;
    }
    .action.ok { background: #16a267; }
    .asset-actions .action {
      max-width: 100%;
    }

    .cards {
      display: grid;
      gap: 12px;
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .card {
      border: 1px solid #d9e3f3;
      border-radius: 12px;
      background: #fbfcff;
      padding: 12px;
      display: grid;
      gap: 7px;
      min-width: 0;
    }
    .card h4 {
      font-size: 16px;
      color: #213a72;
      font-weight: 700;
    }
    .card p,
    .card li {
      font-size: 13px;
      color: #60759c;
      line-height: 1.45;
      overflow-wrap: anywhere;
    }
    .card ul { margin-left: 18px; display: grid; gap: 4px; }

    .review-chat {
      border: 1px solid #d8e3f5;
      border-radius: 12px;
      background: #f9fbff;
      padding: 12px;
      display: grid;
      gap: 10px;
      min-height: 520px;
    }
    .review-toolbar {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
    }
    .review-mode-btn {
      border: 1px solid #cfdbf2;
      border-radius: 999px;
      background: #fff;
      color: #34517c;
      font-size: 12px;
      font-weight: 700;
      padding: 7px 11px;
      cursor: pointer;
    }
    .review-mode-btn.active {
      border-color: #2130b4;
      background: #2130b4;
      color: #fff;
    }
    .review-file {
      border: 1px solid #cfdbf2;
      border-radius: 10px;
      padding: 8px 10px;
      min-width: 180px;
      max-width: 260px;
      font-size: 12px;
      color: #2d466f;
      outline: none;
      background: #fff;
    }
    .review-chat-log {
      border: 1px solid #d8e3f5;
      border-radius: 12px;
      background: #fff;
      padding: 10px;
      min-height: 330px;
      max-height: 420px;
      overflow: auto;
      display: grid;
      gap: 8px;
      align-content: start;
    }
    .chat-bubble {
      border-radius: 10px;
      padding: 10px 12px;
      max-width: min(920px, 100%);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      line-height: 1.5;
      font-size: 13px;
    }
    .chat-user {
      justify-self: end;
      background: #2130b4;
      color: #fff;
    }
    .chat-bot {
      justify-self: start;
      background: #eef3ff;
      color: #1f3666;
      border: 1px solid #d4def3;
    }
    .chat-meta {
      font-size: 11px;
      font-weight: 700;
      margin-bottom: 5px;
      opacity: 0.85;
    }
    .review-form {
      display: grid;
      gap: 8px;
    }
    .review-input {
      width: 100%;
      min-height: 130px;
      border: 1px solid #cdd9f0;
      border-radius: 12px;
      padding: 10px 12px;
      font-size: 13px;
      line-height: 1.5;
      font-family: "Consolas", "Fira Code", monospace;
      resize: vertical;
      outline: none;
      background: #fff;
      color: #17305d;
    }
    .review-input:focus {
      border-color: #9db2de;
      box-shadow: 0 0 0 3px #ebf1ff;
    }
    .review-send {
      justify-self: end;
      min-width: 160px;
      border: 0;
      border-radius: 999px;
      background: #2130b4;
      color: #fff;
      font-size: 13px;
      font-weight: 700;
      min-height: 38px;
      padding: 8px 14px;
      cursor: pointer;
    }
    .review-send:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }

    .empty {
      border: 1px dashed #cfd9eb;
      border-radius: 12px;
      background: #fbfdff;
      padding: 14px;
      font-size: 13px;
      color: #66799d;
    }
    .site-footer {
      margin-top: auto;
      width: auto;
      margin-left: calc(50% - 50vw);
      margin-right: calc(50% - 50vw);
      border-radius: 0;
      overflow: hidden;
      background: #030711;
      color: #edf2ff;
      border-top: 1px solid #101728;
      border-bottom: 1px solid #101728;
      border-left: 0;
      border-right: 0;
    }
    .site-footer a {
      color: #ffffff;
      text-decoration: none;
    }
    .footer-top {
      padding: 22px max(18px, calc((100vw - 1180px) / 2));
      display: grid;
      gap: 18px;
      grid-template-columns: 1.4fr 1fr 1fr 1.2fr;
    }
    .footer-col {
      display: grid;
      align-content: start;
      gap: 10px;
      min-width: 0;
    }
    .footer-brand {
      font-family: "Outfit", "Poppins", sans-serif;
      font-size: 26px;
      font-weight: 800;
      letter-spacing: 0.01em;
    }
    .footer-text {
      font-size: 13px;
      line-height: 1.7;
      color: #c3cce4;
      max-width: 360px;
    }
    .footer-social {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .footer-social a {
      width: 34px;
      height: 34px;
      border-radius: 999px;
      background: #1e2434;
      display: grid;
      place-items: center;
      font-size: 13px;
      font-weight: 700;
    }
    .footer-title {
      font-size: 14px;
      font-weight: 700;
      text-transform: uppercase;
      line-height: 1.3;
    }
    .footer-promo {
      display: grid;
      gap: 10px;
    }
    .footer-promo-item {
      display: grid;
      grid-template-columns: 86px minmax(0, 1fr);
      gap: 8px;
      text-decoration: none;
      border-bottom: 1px solid #202942;
      padding-bottom: 10px;
    }
    .footer-promo-item img {
      width: 86px;
      height: 56px;
      border-radius: 8px;
      object-fit: cover;
      background: #10182e;
    }
    .footer-promo-title {
      font-size: 13px;
      font-weight: 600;
      line-height: 1.4;
      color: #eff3ff;
    }
    .footer-date {
      font-size: 11px;
      color: #8f9dbc;
    }
    .footer-list {
      margin: 0;
      padding-left: 18px;
      display: grid;
      gap: 6px;
      font-size: 13px;
      color: #e9efff;
    }
    .footer-bottom {
      border-top: 1px solid #1a2236;
      min-height: 52px;
      display: grid;
      place-items: center;
      font-size: 13px;
      color: #93a0bc;
      text-align: center;
      padding: 10px max(18px, calc((100vw - 1180px) / 2));
    }
    .hide { display: none !important; }

    @media (max-width: 1320px) {
      .asset-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .side-title { font-size: 15px; }
      .side-title.latest-heading { font-size: 17px; }
      .side-title.topup-heading { font-size: 17px; }
      .topics a { font-size: 12px; }
      .footer-top { grid-template-columns: 1fr 1fr; }
    }
    @media (max-width: 1080px) {
      .main-inner { padding: 8px 10px 0; }
      .news {
        grid-template-columns: 1fr;
        gap: 12px;
      }
      .news-main {
        border-right: 0;
        padding-right: 0;
      }
      .side-title { font-size: 15px; }
      .side-title.latest-heading { font-size: 16px; }
      .side-title.topup-heading { font-size: 16px; }
      .topics a { font-size: 12px; }
      .news-side {
        position: static;
        top: auto;
        max-height: none;
        overflow: visible;
        padding-right: 0;
      }
      .asset-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .cards { grid-template-columns: 1fr; }
      .review-chat {
        min-height: 0;
      }
      .review-chat-log {
        min-height: 260px;
        max-height: 360px;
      }
      .related-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .footer-top { grid-template-columns: 1fr 1fr; }
    }
    @media (max-width: 760px) {
      .install {
        font-size: 12px;
        gap: 8px;
        padding: 8px;
      }
      .actions {
        width: 100%;
        justify-content: flex-start;
        margin-left: 0;
      }
      .brand { min-width: 0; font-size: 19px; }
      .game-strip { padding: 8px 8px; }
      .game-strip a { font-size: 12px; padding: 6px 9px; }
      .news-title { font-size: 18px; }
      .side-title { font-size: 14px; }
      .side-title.latest-heading { font-size: 15px; }
      .side-title.topup-heading { font-size: 15px; }
      .latest-title { font-size: 12px; }
      .topics a { font-size: 12px; padding: 9px 10px; }
      .related-grid { grid-template-columns: 1fr; }
      .footer-top { grid-template-columns: 1fr; }
      .asset-grid {
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 8px;
      }
      .asset-card {
        border-radius: 10px;
        min-height: 0;
      }
      .asset-thumb {
        height: 72px;
        flex-basis: 72px;
      }
      .asset-body {
        padding: 8px;
        gap: 5px;
      }
      .asset-name {
        font-size: 11px;
      }
      .asset-meta {
        font-size: 10px;
        -webkit-line-clamp: 1;
      }
      .action {
        width: 100%;
        min-height: 26px;
        font-size: 10px;
        padding: 4px 8px;
        border-radius: 8px;
      }
      .review-send {
        width: 100%;
        justify-self: stretch;
      }
    }
    @media (max-width: 460px) {
      .asset-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .asset-card {
        min-height: 0;
      }
      .asset-thumb {
        height: 64px;
        flex-basis: 64px;
      }
      .asset-name { font-size: 10px; }
      .asset-meta { font-size: 9px; }
      .action {
        min-height: 24px;
        font-size: 9px;
        padding: 3px 6px;
      }
      .latest-item { grid-template-columns: 92px minmax(0, 1fr); }
      .latest-item img { width: 92px; height: 60px; }
      .news-title { font-size: 16px; }
      .share-btn { min-width: 82px; }
      .topics a { font-size: 12px; }
    }
  </style>
</head>
<body>
  <div id="pageLoader" class="page-loader" aria-label="Memuat halaman">
    <div id="load">
      <div>G</div>
      <div>N</div>
      <div>I</div>
      <div>D</div>
      <div>A</div>
      <div>O</div>
      <div>L</div>
    </div>
  </div>
  <div id="app" style="padding:16px;font-family:Arial,sans-serif;color:#1f2f52;">Memuat halaman...</div>

  <script
    crossorigin
    src="https://unpkg.com/react@18/umd/react.production.min.js"
    onerror="this.onerror=null;this.src='https://cdn.jsdelivr.net/npm/react@18/umd/react.production.min.js';"
  ></script>
  <script
    crossorigin
    src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"
    onerror="this.onerror=null;this.src='https://cdn.jsdelivr.net/npm/react-dom@18/umd/react-dom.production.min.js';"
  ></script>
  <script>
    function hidePageLoader() {
      const el = document.getElementById("pageLoader");
      if (!el) return;
      el.classList.add("is-hidden");
      setTimeout(() => {
        if (el && el.parentNode) el.parentNode.removeChild(el);
      }, 260);
    }

    if (location.protocol !== "https:" && !/^(localhost|127\\.0\\.0\\.1)$/i.test(location.hostname)) {
      location.replace("https://" + location.host + location.pathname + location.search + location.hash);
    }

    function showFatal(msg) {
      hidePageLoader();
      const rootEl = document.getElementById("app");
      if (!rootEl) return;
      rootEl.innerHTML = "<div style='padding:16px;font-family:Arial,sans-serif;color:#1f2f52'>"
        + "<b>Terjadi kendala saat memuat halaman.</b><br/>"
        + String(msg || "Unknown error")
        + "<br/><br/>Coba refresh (Ctrl+F5)."
        + "</div>";
    }

    window.addEventListener("error", (ev) => {
      if (!ev) return;
      showFatal(ev.message || "Script error");
    });

    window.addEventListener("unhandledrejection", (ev) => {
      const reason = ev && ev.reason ? (ev.reason.message || String(ev.reason)) : "Promise rejected";
      showFatal(reason);
    });

    if (!window.React || !window.ReactDOM || !window.ReactDOM.createRoot) {
      showFatal("Library frontend tidak berhasil dimuat.");
    } else {
    const { useEffect, useMemo, useState } = window.React;
    const createRoot = window.ReactDOM.createRoot;
    const h = React.createElement;
    const PROMO_URL = ${promoJs};
    const BOT_INSTALL_URL = "https://discord.com/oauth2/authorize?client_id=1477645558746447894";
    const DISCORD_URL = ${discordJs};
    const SITE_URL = ${siteJs};
    const HAS_DISCORD = ${hasDiscord ? "true" : "false"};
    const ADSENSE_CLIENT = ${adClientJs};
    const ADS_SLOT_TOP = ${adSlotTopJs};
    const ADS_SLOT_SIDEBAR = ${adSlotSidebarJs};
    const ADS_SLOT_BOTTOM = ${adSlotBottomJs};
    const ADSENSE_ENABLED = Boolean(ADSENSE_CLIENT);
    const BRAND_NAME = "LYVA INDONESIA";

    const SECTIONS = [
      { id: "home", label: "Home" },
      { id: "asset", label: "Asset" },
      { id: "review", label: "Review AI" },
      { id: "hadiah", label: "Hadiahku" },
    ];

    const GAME_TAGS = [
      "Mobile Legends", "Free Fire", "Honor of Kings", "PUBG Mobile", "Roblox", "Genshin Impact", "Valorant",
    ];

    const TOPUP_TAGS = [
      "MLBB",
      "Free Fire",
      "Genshin Impact",
      "Koin Tiktok Gift Card",
      "Honkai Star Rail",
      "Bigo Live",
      "Steam Wallet",
      "Valorant",
      "Roblox",
    ];
    const FOOTER_OVERSEAS = ["Malaysia", "Philippines", "Singapore", "USA"];
    const FOOTER_TRUSTED = ["Joytify US", "Joytify Brazil", "Itemku"];
    const FOOTER_TOPUP = ["Top Up Mobile Legends", "Top Up Free Fire", "Top Up Roblox"];

    function getSiteOrigin() {
      let raw = String(SITE_URL || "").trim();
      while (raw.endsWith("/")) raw = raw.slice(0, -1);
      if (raw) return raw;
      raw = String(location.origin || "").trim();
      while (raw.endsWith("/")) raw = raw.slice(0, -1);
      return raw;
    }

    function toSiteUrl(pathname = "/") {
      const origin = getSiteOrigin();
      const path = String(pathname || "/");
      const normalizedPath = path.startsWith("/") ? path : ("/" + path);
      return origin + normalizedPath;
    }

    function publicPromoUrl() {
      const raw = String(PROMO_URL || "").trim();
      if (!raw || raw === "#") return toSiteUrl("/");
      if (/dashboard\\.lyvaindonesia\\.my\\.id/i.test(raw)) return toSiteUrl("/");
      return raw;
    }

    function botInstallUrl() {
      return BOT_INSTALL_URL;
    }

    function shareHref(kind, articleTitle) {
      const targetUrl = toSiteUrl("/");
      const encodedUrl = encodeURIComponent(targetUrl);
      const encodedTitle = encodeURIComponent(String(articleTitle || "").trim());
      if (kind === "facebook") return "https://www.facebook.com/sharer/sharer.php?u=" + encodedUrl;
      if (kind === "twitter") return "https://twitter.com/intent/tweet?url=" + encodedUrl + "&text=" + encodedTitle;
      if (kind === "linkedin") return "https://www.linkedin.com/sharing/share-offsite/?url=" + encodedUrl;
      if (kind === "whatsapp") return "https://wa.me/?text=" + encodeURIComponent(String(articleTitle || "").trim() + " " + targetUrl);
      if (kind === "email") return "mailto:?subject=" + encodedTitle + "&body=" + encodedUrl;
      if (kind === "telegram") return "https://t.me/share/url?url=" + encodedUrl + "&text=" + encodedTitle;
      return targetUrl;
    }

    function normalize(text) {
      return String(text || "").trim().toLowerCase();
    }

    function prettyTitle(text, fallback) {
      const source = String(text || "").trim();
      if (!source) return String(fallback || "Asset");
      const noExt = source.replace(/\\.[a-z0-9]{1,6}$/i, "");
      const normalized = noExt
        .replace(/[_-]+/g, " ")
        .replace(/\\s+/g, " ")
        .trim();
      if (!normalized) return String(fallback || "Asset");
      return normalized.length > 54 ? normalized.slice(0, 54).trim() + "..." : normalized;
    }

    function escapeXml(text) {
      return String(text || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
    }

    function fallbackThumb(label, hue) {
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540">' +
          '<defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1">' +
            '<stop offset="0%" stop-color="hsl(' + hue + ',70%,52%)"/>' +
            '<stop offset="100%" stop-color="hsl(' + ((hue + 54) % 360) + ',68%,40%)"/>' +
          '</linearGradient></defs>' +
          '<rect width="960" height="540" fill="url(#g)"/>' +
        '</svg>';
      return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
    }

    function dateLabel(value) {
      const date = value ? new Date(value) : new Date();
      if (!Number.isFinite(date.getTime())) {
        return new Date().toLocaleDateString("id-ID", { day: "2-digit", month: "2-digit", year: "numeric" });
      }
      return date.toLocaleDateString("id-ID", { day: "2-digit", month: "2-digit", year: "numeric" });
    }

    function mapCatalog(data) {
      const pc = Array.isArray(data?.pcAssets) ? data.pcAssets : [];
      const hp = Array.isArray(data?.hpAssets) ? data.hpAssets : [];
      const news = Array.isArray(data?.newsFeed) ? data.newsFeed : [];

      const newsItems = news.map((item) => ({
        source: "news",
        title: prettyTitle(item.title, "Update terbaru"),
        meta: (item.sourceTag || "UPDATE") + " - " + (item.author || "LYVA TEAM"),
        imageUrl: item.imageUrl || "",
        actionLabel: item.messageUrl ? "Lihat sumber" : "",
        actionHref: item.messageUrl || "#",
        copyId: "",
        type: item.sourceTag || "UPDATE",
        ext: "",
        date: dateLabel(item.createdAt),
        newsTag: item.sourceTag || "UPDATE",
        newsBody: String(item.body || "").trim(),
        author: item.author || "LYVA TEAM",
        createdAt: item.createdAt || "",
      }));

      const items = newsItems
        .concat(pc.map((item) => ({
          source: "asset",
          title: prettyTitle(item.baseName || item.fileName, "Asset"),
          meta: "Asset file - " + (item.type || "library"),
          imageUrl: item.imageUrl || "",
          actionLabel: "Download",
          actionHref: item.downloadUrl || "#",
          copyId: "",
          type: item.type || "",
          ext: item.ext || "",
          date: dateLabel(),
        })))
        .concat(hp.map((item) => ({
          source: "review",
          title: prettyTitle(item.name, "Review AI"),
          meta: "Review AI - " + (item.kind || "template"),
          imageUrl: item.imageUrl || "",
          actionLabel: "Copy ID",
          actionHref: "#",
          copyId: item.id || "",
          kind: item.kind || "",
          date: dateLabel(),
        })));

      return items;
    }

    function buildArticle(item, idx) {
      const labelDate = item?.date || dateLabel();
      const title = item?.title || "Artikel terbaru";
      const sourceTag =
        item?.source === "review"
          ? "REVIEW AI"
          : item?.source === "news"
            ? String(item?.newsTag || "UPDATE")
            : "ASSET";
      const cover = item?.imageUrl || fallbackThumb(title, item?.source === "review" ? 168 : item?.source === "news" ? 210 : 220);
      const readLabel = (4 + (idx % 4)) + " Mins Read";
      const newsBody = String(item?.newsBody || "").trim();
      const parsedNewsBody = newsBody
        ? newsBody.split(/\\n+/).map((line) => line.trim()).filter(Boolean).slice(0, 3)
        : [];

      return {
        tag: sourceTag,
        title,
        author: item?.author || "LYVA TEAM",
        date: labelDate,
        readLabel,
        breadcrumb: "Home > " + sourceTag + " > " + title,
        cover,
        body: parsedNewsBody.length
          ? parsedNewsBody
          : [
              "Artikel ini merangkum pembaruan terbaru yang lagi ramai di komunitas.",
              "Masuk ke menu Asset untuk lihat file terbaru, atau Review AI untuk analisa script otomatis.",
              "Semua update di halaman ini diambil langsung dari katalog sehingga konten selalu sinkron.",
            ],
      };
    }

    function socialIcon(kind) {
      if (kind === "facebook") {
        return h("svg", { viewBox: "0 0 24 24", width: "8", height: "8", fill: "currentColor", "aria-hidden": "true" },
          h("path", { d: "M13.5 22v-8h2.6l.4-3h-3V9c0-.9.3-1.5 1.6-1.5h1.7V4.8c-.3 0-1.3-.1-2.4-.1-2.4 0-4 1.4-4 4.2V11H8v3h2.4v8h3.1z" }),
        );
      }
      if (kind === "twitter") {
        return h("svg", { viewBox: "0 0 24 24", width: "8", height: "8", fill: "currentColor", "aria-hidden": "true" },
          h("path", { d: "M18.2 4h2.9l-6.3 7.2L22 20h-5.6l-4.4-5.6L7 20H4.1l6.8-7.8L4 4h5.7l4 5.1L18.2 4zm-1 14.3h1.6L9.5 5.6H7.8l9.4 12.7z" }),
        );
      }
      if (kind === "linkedin") {
        return h("svg", { viewBox: "0 0 24 24", width: "8", height: "8", fill: "currentColor", "aria-hidden": "true" },
          h("path", { d: "M6.4 8.5a1.8 1.8 0 1 1 0-3.6 1.8 1.8 0 0 1 0 3.6zM4.9 9.8H8v9.4H4.9V9.8zm5 0h2.9v1.3h.1c.4-.8 1.4-1.6 2.9-1.6 3.1 0 3.7 2 3.7 4.7v5h-3.1V15c0-1 0-2.4-1.5-2.4S13.3 13.8 13.3 15v4.2h-3.4V9.8z" }),
        );
      }
      return h("span", { className: "share-ico", "aria-hidden": "true" }, ">");
    }

    function AdSlot({ slot, className = "", minHeight = 0 }) {
      const adRef = React.useRef(null);

      useEffect(() => {
        if (!ADSENSE_ENABLED || !slot) return;
        const node = adRef.current;
        if (!node) return;
        if (node.dataset.loaded === "1") return;
        try {
          (window.adsbygoogle = window.adsbygoogle || []).push({});
          node.dataset.loaded = "1";
        } catch {}
      }, [slot]);

      if (!ADSENSE_ENABLED || !slot) return null;

      const classes = "ad-wrap" + (className ? " " + className : "");
      const style = minHeight > 0
        ? { display: "block", minHeight: String(minHeight) + "px" }
        : { display: "block" };

      return h("div", { className: classes },
        h("ins", {
          ref: adRef,
          className: "adsbygoogle",
          style,
          "data-ad-client": ADSENSE_CLIENT,
          "data-ad-slot": slot,
          "data-ad-format": "auto",
          "data-full-width-responsive": "true",
        }),
      );
    }

    function TopLayout({ query, setQuery, hideInstall, setHideInstall, section, setSection }) {
      const dashboardUrl = toSiteUrl("/dashboard");
      const promoUrl = publicPromoUrl();
      const installUrl = botInstallUrl();
      return h(React.Fragment, null,
        h("div", { className: "install" + (hideInstall ? " hide" : "") },
          h("button", { className: "install-close", onClick: () => setHideInstall(true), type: "button" }, "x"),
          h("span", null, "Install Bot Discord Lyva Indonesia untuk akses update asset dan artikel terbaru."),
          h("a", { className: "btn primary", href: installUrl, target: "_blank", rel: "noreferrer" }, "Install Bot Discord Lyva Indonesia"),
        ),
        h("header", { className: "topbar" },
          h("div", { className: "brand" },
            h("span", { className: "brand-mark" }, "L"),
            h("span", null, BRAND_NAME),
          ),
          h("label", { className: "search" },
            h("input", {
              value: query,
              onChange: (e) => setQuery(e.target.value),
              placeholder: "Cari artikel, asset, atau topik...",
            }),
            h("span", { className: "ico", "aria-hidden": "true" },
              h("svg", { viewBox: "0 0 24 24", width: "18", height: "18", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round" },
                h("circle", { cx: "11", cy: "11", r: "7" }),
                h("line", { x1: "16.65", y1: "16.65", x2: "21", y2: "21" }),
              ),
            ),
          ),
          h("div", { className: "actions" },
            HAS_DISCORD
              ? h("a", { className: "btn light", href: DISCORD_URL, target: "_blank", rel: "noreferrer" }, "Discord")
              : h("span", { className: "btn light" }, "ID"),
            h("a", { className: "btn primary", href: dashboardUrl }, "Masuk"),
            h("a", { className: "btn outline", href: promoUrl, target: "_blank", rel: "noreferrer" }, "Daftar"),
          ),
        ),
        h("nav", { className: "game-strip" },
          GAME_TAGS.map((tag) => h("a", { href: "#", key: tag, onClick: (e) => e.preventDefault() }, tag)),
        ),
        h("div", { className: "section-tabs" },
          SECTIONS.map((item) => h("button", {
            key: item.id,
            type: "button",
            className: "tab-btn" + (section === item.id ? " active" : ""),
            onClick: () => setSection(item.id),
          }, item.label)),
        ),
      );
    }

    function NewsSection({ items }) {
      const [selected, setSelected] = useState(0);

      const articles = useMemo(() => {
        if (!items.length) {
          return [buildArticle({ source: "asset", title: "Belum ada artikel" }, 0)];
        }
        return items.slice(0, 8).map((item, idx) => buildArticle(item, idx));
      }, [items]);

      const current = articles[Math.max(0, Math.min(selected, articles.length - 1))];
      const latestArticles = articles.slice(0, 3).map((item, idx) => ({ item, idx }));
      const relatedArticles = articles
        .map((item, idx) => ({ item, idx }))
        .filter(({ idx }) => idx !== selected)
        .slice(0, 3);
      const promoUrl = publicPromoUrl();

      return h("section", { className: "section active" },
        h("div", { className: "news" },
          h("article", { className: "news-main" },
            h("div", { className: "bread" }, current.breadcrumb),
            h("div", { className: "tag" }, current.tag),
            h("h1", { className: "news-title" }, current.title),
            h("div", { className: "meta" },
              h("span", { className: "meta-author" }, "By " + current.author),
              h("span", { className: "meta-dot" }, "|"),
              h("span", null, current.date),
              h("span", { className: "meta-dot" }, "|"),
              h("span", null, current.readLabel),
            ),
            h("div", { className: "share" },
              h("a", { className: "share-btn facebook", href: shareHref("facebook", current.title), target: "_blank", rel: "noreferrer noopener" }, socialIcon("facebook"), h("span", null, "Facebook")),
              h("a", { className: "share-btn twitter", href: shareHref("twitter", current.title), target: "_blank", rel: "noreferrer noopener" }, socialIcon("twitter"), h("span", null, "Twitter")),
              h("a", { className: "share-btn linkedin", href: shareHref("linkedin", current.title), target: "_blank", rel: "noreferrer noopener" }, socialIcon("linkedin"), h("span", null, "LinkedIn")),
              h("a", { className: "share-btn share-more", href: promoUrl, target: "_blank", rel: "noreferrer noopener", "aria-label": "Bagikan" }, socialIcon("share")),
            ),
            h(AdSlot, { slot: ADS_SLOT_TOP, className: "ad-main-top", minHeight: 90 }),
            h("img", { className: "cover", src: current.cover, alt: current.title }),
            h("div", { className: "body" }, current.body.map((line, i) => h("p", { key: i }, line))),
            h("div", { className: "post-extra" },
              h("div", { className: "extra-share" },
                h("div", { className: "extra-share-title" }, "Share."),
                h("div", { className: "extra-share-list" },
                  h("a", { className: "extra-pill fb", href: shareHref("facebook", current.title), target: "_blank", rel: "noreferrer noopener" }, "Facebook"),
                  h("a", { className: "extra-pill tw", href: shareHref("twitter", current.title), target: "_blank", rel: "noreferrer noopener" }, "X"),
                  h("a", { className: "extra-pill in", href: shareHref("linkedin", current.title), target: "_blank", rel: "noreferrer noopener" }, "LinkedIn"),
                  h("a", { className: "extra-pill wa", href: shareHref("whatsapp", current.title), target: "_blank", rel: "noreferrer noopener" }, "WhatsApp"),
                  h("a", { className: "extra-pill mail", href: shareHref("email", current.title) }, "Email"),
                  h("a", { className: "extra-pill tg", href: shareHref("telegram", current.title), target: "_blank", rel: "noreferrer noopener" }, "Telegram"),
                ),
              ),
              h("div", { className: "author-box" },
                h("div", { className: "author-name" }, "Lyva Team"),
                h("p", { className: "author-bio" }, "SEO Content Writer dengan pengalaman lebih dari 2 tahun dalam penulisan digital, khususnya di topik seputar game seperti Free Fire, Mobile Legends, dan Honor of Kings. Saat ini, saya fokus menulis konten SEO-friendly yang informatif dan engaging, dengan Honkai, Honor of Kings, dan Free Fire sebagai game favorit saya."),
              ),
              h("div", { className: "related-wrap" },
                h("div", { className: "related-head" }, "RELATED ", h("span", null, "POSTS")),
                h("div", { className: "related-grid" },
                  relatedArticles.map(({ item, idx }) => h("a", {
                    href: "#",
                    className: "related-card",
                    key: item.title + idx,
                    onClick: (e) => {
                      e.preventDefault();
                      setSelected(idx);
                    },
                  },
                    h("img", { src: item.cover, alt: item.title }),
                    h("div", { className: "related-title" }, item.title),
                    h("div", { className: "related-date" }, item.date || dateLabel()),
                  )),
                ),
              ),
            ),
            h(AdSlot, { slot: ADS_SLOT_BOTTOM, className: "ad-main-bottom", minHeight: 120 }),
          ),
          h("aside", { className: "news-side" },
            h("div", { className: "side-heading" }, h("span", { className: "line" }), h("h3", { className: "side-title latest-heading" }, "ARTIKEL TERBARU"), h("span", { className: "line" })),
            h("div", { className: "latest-list" },
              latestArticles.map(({ item, idx }) => h("a", {
                href: "#",
                className: "latest-item",
                key: item.title + idx,
                onClick: (e) => {
                  e.preventDefault();
                  setSelected(idx);
                },
              },
                h("img", { src: item.cover, alt: item.title }),
                h("div", { className: "latest-copy" },
                  h("div", { className: "latest-title" }, item.title),
                  h("div", { className: "latest-date" }, item.date || dateLabel()),
                ),
              )),
            ),
            h("div", { className: "side-heading" }, h("span", { className: "line" }), h("h3", { className: "side-title topup-heading" }, "MAU TOP UP APA?"), h("span", { className: "line" })),
            h("div", { className: "topics" },
              TOPUP_TAGS.map((topic) => h("a", { href: promoUrl, key: topic, target: "_blank", rel: "noreferrer noopener" }, topic)),
            ),
            h(AdSlot, { slot: ADS_SLOT_SIDEBAR, className: "ad-side", minHeight: 250 }),
          ),
        ),
      );
    }

    function SiteFooter({ articles }) {
      const promoItems = (Array.isArray(articles) ? articles : []).slice(0, 2);
      const promoUrl = publicPromoUrl();
      const socialLinks = [
        { label: "f", href: "https://www.facebook.com" },
        { label: "X", href: "https://x.com" },
        { label: "ig", href: "https://www.instagram.com" },
        { label: "tt", href: "https://www.tiktok.com" },
        { label: "rss", href: toSiteUrl("/") },
      ];

      return h("footer", { className: "site-footer" },
        h("div", { className: "footer-top" },
          h("div", { className: "footer-col" },
            h("div", { className: "footer-brand" }, "LYVA MEMBER HUB"),
            h("p", { className: "footer-text" }, "Berita dan artikel game menarik hanya di Lyva Indonesia. Temukan informasi terkini dan guide terlengkap dari game-game populer seperti Mobile Legends, Free Fire, Genshin Impact, dan sebagainya."),
            h("div", { className: "footer-social" },
              socialLinks.map((item) => h("a", {
                key: item.label,
                href: item.href,
                target: "_blank",
                rel: "noreferrer noopener",
                "aria-label": item.label,
              }, item.label)),
            ),
          ),
          h("div", { className: "footer-col" },
            h("div", { className: "footer-title" }, "PROMO LYVA INDONESIA"),
            h("div", { className: "footer-promo" },
              promoItems.map((item, idx) => h("a", {
                href: promoUrl,
                target: "_blank",
                rel: "noreferrer noopener",
                className: "footer-promo-item",
                key: item.title + idx,
              },
                h("img", { src: item.cover, alt: item.title }),
                h("div", null,
                  h("div", { className: "footer-promo-title" }, item.title),
                  h("div", { className: "footer-date" }, item.date || dateLabel()),
                ),
              )),
            ),
          ),
          h("div", { className: "footer-col" },
            h("div", { className: "footer-title" }, "LYVA INDONESIA OVERSEAS BLOGS"),
            h("p", { className: "footer-text" }, FOOTER_OVERSEAS.join(", ")),
          ),
          h("div", { className: "footer-col" },
            h("div", { className: "footer-title" }, "OTHER TRUSTED TOP UP PLATFORMS"),
            h("p", { className: "footer-text" }, FOOTER_TRUSTED.join(", ")),
            h("div", { className: "footer-title" }, "TOP UP GAMES TERPOPULER"),
            h("ul", { className: "footer-list" },
              FOOTER_TOPUP.map((item) => h("li", { key: item },
                h("a", { href: promoUrl, target: "_blank", rel: "noreferrer noopener" }, item),
              )),
            ),
          ),
        ),
        h("div", { className: "footer-bottom" }, "© " + String(new Date().getFullYear()) + " LYVA INDONESIA - All Rights Reserved."),
      );
    }

    function AssetSection({ items, query }) {
      const [copied, setCopied] = useState("");

      const list = useMemo(() => {
        const q = normalize(query);
        return items.filter((item) => {
          if (item.source !== "asset") return false;
          if (!q) return true;
          return normalize(item.title + " " + item.meta + " " + (item.type || "") + " " + (item.ext || "")).includes(q);
        });
      }, [items, query]);

      const onCopy = async (value) => {
        const text = String(value || "").trim();
        if (!text) return;
        try {
          if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
          } else {
            const area = document.createElement("textarea");
            area.value = text;
            document.body.appendChild(area);
            area.select();
            document.execCommand("copy");
            area.remove();
          }
          setCopied(text);
          setTimeout(() => setCopied(""), 1200);
        } catch {
          setCopied("");
        }
      };

      return h("section", { className: "section active" },
        h("div", { className: "panel" },
          h("h3", { className: "head" }, "Asset Library"),
          h("div", { className: "asset-grid" },
            list.length
              ? list.map((item, idx) => h("article", { className: "asset-card", key: item.title + idx },
                  h("img", {
                    className: "asset-thumb",
                    src: item.imageUrl || fallbackThumb(item.title, 220),
                    alt: item.title,
                    onError: (e) => {
                      e.currentTarget.src = fallbackThumb(item.title, 220);
                    },
                  }),
                  h("div", { className: "asset-body" },
                    h("div", { className: "asset-name" }, item.title),
                    h("div", { className: "asset-meta" }, item.meta),
                    h("div", { className: "asset-actions" },
                      item.copyId
                        ? h("button", {
                            className: "action" + (copied === item.copyId ? " ok" : ""),
                            onClick: () => onCopy(item.copyId),
                            type: "button",
                          }, copied === item.copyId ? "Copied" : "Copy ID")
                        : h("a", { className: "action", href: item.actionHref || "#" }, item.actionLabel || "Download"),
                    ),
                  ),
                ))
              : h("div", { className: "empty" }, "Belum ada asset yang cocok."),
          ),
        ),
      );
    }

    function ReviewSection() {
      const [mode, setMode] = useState("paste");
      const [filename, setFilename] = useState("Script.lua");
      const [code, setCode] = useState("");
      const [busy, setBusy] = useState(false);
      const [messages, setMessages] = useState([
        {
          role: "bot",
          title: "Lyva Review",
          content:
            "Tempel script Luau/Roblox kamu di bawah, pilih mode review, lalu klik Kirim. Mode Review Paste = local engine + checklist + template feedback, Local Engine = analyzer cepat, AI Review = analisa AI + context local engine.",
        },
      ]);
      const logRef = React.useRef(null);

      useEffect(() => {
        if (!logRef.current) return;
        logRef.current.scrollTop = logRef.current.scrollHeight;
      }, [messages, busy]);

      async function submitReview() {
        const fullCode = String(code || "").trim();
        if (!fullCode || busy) return;

        setMessages((prev) =>
          prev.concat({
            role: "user",
            title: "Kamu",
            content: fullCode.length > 2500 ? (fullCode.slice(0, 2500) + " ... [input dipotong di tampilan]") : fullCode,
          }),
        );
        setBusy(true);

        try {
          const response = await fetch("/api/public/review", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              mode,
              filename: String(filename || "Script.lua").trim() || "Script.lua",
              code: fullCode,
            }),
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok || !data?.ok) {
            throw new Error(data?.error || "Gagal memproses review.");
          }
          const modeLabel = mode === "ai" ? "AI Review" : mode === "local" ? "Local Engine" : "Review Paste";
          setMessages((prev) =>
            prev.concat({
              role: "bot",
              title: modeLabel,
              content: String(data.output || "Review selesai, tapi output kosong."),
            }),
          );
          setCode("");
        } catch (error) {
          setMessages((prev) =>
            prev.concat({
              role: "bot",
              title: "Error",
              content: String(error?.message || "Terjadi error saat review."),
            }),
          );
        } finally {
          setBusy(false);
        }
      }

      return h("section", { className: "section active" },
        h("div", { className: "panel" },
          h("h3", { className: "head" }, "Review AI"),
          h("div", { className: "review-chat" },
            h("div", { className: "review-toolbar" },
              h("button", {
                type: "button",
                className: "review-mode-btn" + (mode === "paste" ? " active" : ""),
                onClick: () => setMode("paste"),
              }, "Review Paste"),
              h("button", {
                type: "button",
                className: "review-mode-btn" + (mode === "local" ? " active" : ""),
                onClick: () => setMode("local"),
              }, "Local Engine"),
              h("button", {
                type: "button",
                className: "review-mode-btn" + (mode === "ai" ? " active" : ""),
                onClick: () => setMode("ai"),
              }, "AI Review"),
              h("input", {
                className: "review-file",
                value: filename,
                onChange: (e) => setFilename(e.target.value),
                placeholder: "Nama file, contoh: CombatServer.lua",
              }),
            ),
            h("div", { className: "review-chat-log", ref: logRef },
              messages.map((msg, idx) =>
                h("div", { key: msg.role + idx, className: "chat-bubble " + (msg.role === "user" ? "chat-user" : "chat-bot") },
                  h("div", { className: "chat-meta" }, msg.title),
                  h("div", null, msg.content),
                ),
              ),
              busy
                ? h("div", { className: "chat-bubble chat-bot" },
                    h("div", { className: "chat-meta" }, "Lyva Review"),
                    h("div", null, "Memproses script kamu..."),
                  )
                : null,
            ),
            h("div", { className: "review-form" },
              h("textarea", {
                className: "review-input",
                value: code,
                onChange: (e) => setCode(e.target.value),
                placeholder: "Tempel script Luau/Roblox di sini...",
                onKeyDown: (e) => {
                  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                    e.preventDefault();
                    submitReview();
                  }
                },
              }),
              h("button", {
                type: "button",
                className: "review-send",
                disabled: busy || !String(code || "").trim(),
                onClick: submitReview,
              }, busy ? "Memproses..." : "Kirim Script"),
            ),
          ),
        ),
      );
    }

    function HadiahSection() {
      return h("section", { className: "section active" },
        h("div", { className: "panel" },
          h("h3", { className: "head" }, "Hadiahku"),
          h("div", { className: "cards" },
            h("article", { className: "card" }, h("h4", null, "Bonus Member"), h("p", null, "Akses artikel premium, update asset lebih awal, dan event komunitas mingguan.")),
            h("article", { className: "card" }, h("h4", null, "Status Akun"), h("p", null, "Verifikasi akun untuk membuka fitur eksklusif dan notifikasi update otomatis.")),
            h("article", { className: "card" }, h("h4", null, "Support"), h("p", null, "Butuh bantuan? Tim support siap bantu melalui Discord atau dashboard admin.")),
            h("article", { className: "card" }, h("h4", null, "Keamanan"), h("p", null, "Akses sensitif dipantau otomatis dan proteksi akun selalu aktif.")),
          ),
        ),
      );
    }

    function App() {
      const [section, setSection] = useState("home");
      const [query, setQuery] = useState("");
      const [hideInstall, setHideInstall] = useState(false);
      const [items, setItems] = useState([]);

      useEffect(() => {
        let alive = true;
        fetch("/api/public/catalog")
          .then((res) => res.json())
          .then((data) => {
            if (!alive) return;
            setItems(mapCatalog(data));
          })
          .catch(() => {
            if (!alive) return;
            setItems([]);
          });
        return () => {
          alive = false;
        };
      }, []);

      const filteredItems = useMemo(() => {
        const q = normalize(query);
        if (!q) return items;
        return items.filter((item) => normalize(item.title + " " + item.meta + " " + (item.type || "") + " " + (item.kind || "")).includes(q));
      }, [items, query]);

      const footerArticles = useMemo(() => {
        if (!filteredItems.length) {
          return [buildArticle({ source: "asset", title: "Belum ada artikel" }, 0)];
        }
        return filteredItems.slice(0, 4).map((item, idx) => buildArticle(item, idx));
      }, [filteredItems]);

      return h("div", { className: "page" },
        h("main", { className: "main" },
          h("div", { className: "main-inner" },
            h(TopLayout, { query, setQuery, hideInstall, setHideInstall, section, setSection }),
            section === "home" ? h(NewsSection, { items: filteredItems }) : null,
            section === "asset" ? h(AssetSection, { items: filteredItems, query }) : null,
            section === "review" ? h(ReviewSection) : null,
            section === "hadiah" ? h(HadiahSection) : null,
            h(SiteFooter, { articles: footerArticles }),
          ),
        ),
      );
    }

    class RenderBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }
      static getDerivedStateFromError(error) {
        return { error: error || new Error("Render failed") };
      }
      componentDidCatch(error) {
        showFatal(error?.message || "Render error");
      }
      render() {
        if (this.state.error) {
          return h("div", {
            style: {
              padding: "16px",
              fontFamily: "Arial,sans-serif",
              color: "#1f2f52",
              background: "#fff",
              border: "1px solid #d8e0ef",
              borderRadius: "10px",
            },
          }, "Terjadi error saat render halaman. Coba refresh (Ctrl+F5).");
        }
        return this.props.children;
      }
    }

    createRoot(document.getElementById("app")).render(h(RenderBoundary, null, h(App)));
    requestAnimationFrame(hidePageLoader);
    window.addEventListener("load", hidePageLoader);
    }
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
  const publicReviewRateStore = new Map();

  const server = http.createServer(async (req, res) => {
    try {
      const method = String(req.method || "GET").toUpperCase();
      const isPageMethod = method === "GET" || method === "HEAD";
      const url = new URL(req.url || "/", "http://localhost");
      const authed = isAuthed(req, sessions);
      const requestHost = String(req.headers.host || "").split(":")[0].trim().toLowerCase();
      const forwardedProto = String(req.headers["x-forwarded-proto"] || "")
        .split(",")[0]
        .trim()
        .toLowerCase();
      const isHttpsRequest = forwardedProto === "https" || Boolean(req.socket && req.socket.encrypted);
      const isLocalHost = /^(localhost|127\.0\.0\.1)$/i.test(requestHost);
      const requestPath = url.pathname + url.search;

      if (
        isPageMethod &&
        (url.pathname === "/" || url.pathname === "/member" || url.pathname === "/dashboard") &&
        requestHost &&
        !isLocalHost &&
        !isHttpsRequest
      ) {
        res.writeHead(301, { Location: `https://${requestHost}${requestPath}` });
        res.end();
        return;
      }

      if (
        MEMBER_OLD_HOST &&
        requestHost === MEMBER_OLD_HOST &&
        (url.pathname === "/" || url.pathname === "/member")
      ) {
        const targetBase = String(MEMBER_SITE_URL || "").trim().replace(/\/+$/g, "");
        if (targetBase) {
          res.writeHead(301, { Location: targetBase + url.pathname + url.search });
          res.end();
          return;
        }
      }

      if (isPageMethod && url.pathname === "/ads.txt") {
        const adsTxt = buildAdsTxtContent();
        if (!adsTxt) {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("ads.txt is not configured.\n");
          return;
        }

        const headers = {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "public, max-age=3600",
        };
        if (method === "HEAD") {
          res.writeHead(200, headers);
          res.end();
          return;
        }
        sendBinary(res, 200, Buffer.from(adsTxt, "utf8"), headers);
        return;
      }

      if (isPageMethod && (url.pathname === "/" || url.pathname === "/member")) {
        sendHtml(
          res,
          200,
          buildMemberPage({
            title: MEMBER_PAGE_TITLE,
            promoUrl: MEMBER_PROMO_URL,
            discordUrl: MEMBER_DISCORD_URL,
            siteUrl: MEMBER_SITE_URL,
          }),
        );
        return;
      }

      if (isPageMethod && url.pathname === "/dashboard") {
        sendHtml(res, 200, buildPage({ appName, authed }));
        return;
      }

      if (method === "GET" && url.pathname === "/api/public/catalog") {
        const assets = await listAssets().catch(() => []);
        const mobile = await listMobileAssets().catch(() => []);
        const newsFeed = await listNewsFeed(50).catch(() => []);
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
        const publicNews = Array.isArray(newsFeed)
          ? newsFeed.map((item) => ({
              id: item.id,
              sourceTag: item.sourceTag || "UPDATE",
              title: item.title || "Update terbaru",
              body: item.body || "",
              author: item.author || "LYVA TEAM",
              createdAt: item.createdAt || new Date().toISOString(),
              messageUrl: item.messageUrl || "",
              imageUrl: item.imageFile
                ? `/api/public/asset-preview?file=${encodeURIComponent(item.imageFile)}`
                : String(item.imageUrlExternal || ""),
            }))
          : [];
        sendJson(res, 200, {
          ok: true,
          newsFeed: publicNews,
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

      if (method === "POST" && url.pathname === "/api/public/review") {
        const clientIp = String(req.headers["x-forwarded-for"] || "")
          .split(",")[0]
          .trim() ||
          String(req.socket?.remoteAddress || "anon");
        const gate = checkPublicReviewRateLimit(publicReviewRateStore, clientIp);
        if (!gate.ok) {
          sendJson(res, 429, {
            ok: false,
            error: "Terlalu banyak request. Coba lagi sebentar.",
          });
          return;
        }

        const body = await readJsonBody(req, PUBLIC_REVIEW_MAX_JSON_BYTES);
        const mode = ["paste", "local", "ai"].includes(String(body.mode || "").toLowerCase())
          ? String(body.mode || "").toLowerCase()
          : "paste";
        const filenameRaw = String(body.filename || "Script.lua").trim();
        const filename = filenameRaw ? filenameRaw.slice(0, 80) : "Script.lua";
        const rawCode = String(body.code || "");
        const fullCode = normalizeCodeInput(rawCode);

        if (!fullCode.trim()) {
          sendJson(res, 400, { ok: false, error: "Script kosong. Tempel script dulu." });
          return;
        }
        if (fullCode.length > PUBLIC_REVIEW_MAX_CHARS) {
          sendJson(res, 400, {
            ok: false,
            error: `Script terlalu panjang. Maksimal ${PUBLIC_REVIEW_MAX_CHARS} karakter.`,
          });
          return;
        }

        const analysis = analyzeCode(fullCode, filename, {
          pack: "all",
          ignoredRules: [],
          rawSource: rawCode,
        });

        let output = "";
        if (mode === "local") {
          output = [formatSignalScan(analysis.meta.signals), "", formatFindings(analysis.findings, analysis.meta)].join("\n");
        } else if (mode === "ai") {
          if (!PUBLIC_REVIEW_AI_ENABLED) {
            sendJson(res, 403, { ok: false, error: "Mode AI sementara dimatikan oleh admin." });
            return;
          }
          const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
          if (!apiKey) {
            sendJson(res, 400, { ok: false, error: "OPENAI_API_KEY belum diset di server." });
            return;
          }

          const focused = buildIssueFocusedInput(fullCode, analysis.findings, {
            radius: 6,
            maxSnippets: 3,
            maxChars: 4200,
          });
          let aiResult;
          try {
            aiResult = await requestOpenAIReview({
              apiKey,
              model: process.env.OPENAI_MODEL || undefined,
              filename,
              code: focused.code,
              ruleFindings: analysis.findings,
              signalSummary: formatSignalScan(analysis.meta.signals),
              issueContext: focused.context,
            });
          } catch (error) {
            const status = Number(error?.status || 0);
            if (status === 429) {
              sendJson(res, 429, { ok: false, error: "AI sedang sibuk/rate limit. Coba lagi sebentar." });
              return;
            }
            if (status === 401 || status === 403) {
              sendJson(res, 500, { ok: false, error: "Kunci API AI di server bermasalah." });
              return;
            }
            sendJson(res, 500, { ok: false, error: `AI error: ${error?.message || "unknown"}` });
            return;
          }
          output = [
            formatAIReviewReport(aiResult),
            "",
            `AI Input Mode: focused issue snippets (${focused.snippetCount} block)`,
            "",
            "**Rule Context (Local Engine)**",
            formatFindings(analysis.findings, analysis.meta),
          ].join("\n");
        } else {
          const codeBlocks = formatCodeForDiscord(fullCode, "lua");
          const codePreview = codeBlocks.slice(0, 2).join("\n\n");
          output = [
            codePreview,
            "",
            formatSignalScan(analysis.meta.signals),
            "",
            buildChecklistMessage(analysis.findings, analysis.facts),
            "",
            formatFindings(analysis.findings, analysis.meta),
            "",
            buildFeedbackTemplate(analysis.findings),
          ].join("\n");
        }

        sendJson(res, 200, {
          ok: true,
          mode,
          filename,
          usedChars: fullCode.length,
          output: clipReviewOutput(output),
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

      if (isPageMethod && url.pathname === "/robots.txt") {
        const siteBase = String(MEMBER_SITE_URL || "").trim().replace(/\/+$/g, "");
        const robotsTxt = [
          "User-agent: *",
          "Allow: /",
          siteBase ? `Sitemap: ${siteBase}/sitemap.xml` : "",
          "",
        ]
          .filter(Boolean)
          .join("\n");

        const headers = {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "public, max-age=3600",
        };
        if (method === "HEAD") {
          res.writeHead(200, headers);
          res.end();
          return;
        }
        sendBinary(res, 200, Buffer.from(robotsTxt, "utf8"), headers);
        return;
      }

      if (isPageMethod && url.pathname === "/sitemap.xml") {
        const siteBase = String(MEMBER_SITE_URL || "").trim().replace(/\/+$/g, "");
        if (!siteBase) {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("sitemap is not configured.\n");
          return;
        }
        const today = new Date().toISOString().slice(0, 10);
        const urls = ["/", "/member", "/ads.txt"]
          .map((pathName) => `<url><loc>${sanitizeText(siteBase + pathName)}</loc><lastmod>${today}</lastmod></url>`)
          .join("");
        const xml =
          '<?xml version="1.0" encoding="UTF-8"?>' +
          '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
          urls +
          "</urlset>";

        const headers = {
          "Content-Type": "application/xml; charset=utf-8",
          "Cache-Control": "public, max-age=3600",
        };
        if (method === "HEAD") {
          res.writeHead(200, headers);
          res.end();
          return;
        }
        sendBinary(res, 200, Buffer.from(xml, "utf8"), headers);
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






