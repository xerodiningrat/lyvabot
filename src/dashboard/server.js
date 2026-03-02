const http = require("http");
const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const { Routes } = require("discord.js");
const { listAssets } = require("../assets/library");
const { listMobileAssets } = require("../assets/mobile-library");

const SESSION_COOKIE = "lyva_dash_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24;

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

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
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
              <div id="actionLog" class="log"></div>
            </section>

            <section class="panel block">
              <h3>System Pulse</h3>
              <div class="mini-chart" id="pulseBars"></div>
              <div id="pulseNote" class="sub" style="margin-top:10px;"></div>
            </section>
          </div>
        </main>
      </div>
    </section>
  </div>

  <script>
    const isAuthed = ${authed ? "true" : "false"};
    const loginView = document.getElementById("loginView");
    const appView = document.getElementById("appView");
    const statsGrid = document.getElementById("statsGrid");
    const actionLog = document.getElementById("actionLog");
    const pulseBars = document.getElementById("pulseBars");
    const pulseNote = document.getElementById("pulseNote");

    function log(message) {
      if (!actionLog) return;
      const now = new Date().toLocaleTimeString();
      actionLog.textContent = "[" + now + "] " + message + "\\n" + actionLog.textContent;
    }

    function loginLog(message) {
      const box = document.getElementById("loginMsg");
      box.textContent = message;
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
        if (dot) dot.className = isReady ? "dot online" : "dot";
        if (pillReady) pillReady.textContent = isReady ? "Bot Online" : "Bot Offline";
        if (pillGuilds) pillGuilds.textContent = String(data.bot.guildCount || 0);
        if (pillUptime) pillUptime.textContent = uptimeMinutes + "m";
        if (sideStatus) sideStatus.textContent = isReady ? "ONLINE" : "OFFLINE";
        if (sideNode) sideNode.textContent = "Node " + (data.system.nodeVersion || "-");

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

    document.getElementById("btnLogin")?.addEventListener("click", doLogin);
    document.getElementById("btnRefresh")?.addEventListener("click", refreshSummary);
    document.getElementById("btnSyncAll")?.addEventListener("click", syncAll);
    document.getElementById("btnSyncOne")?.addEventListener("click", syncOne);
    document.getElementById("btnClearGlobal")?.addEventListener("click", clearGlobal);
    document.getElementById("btnLogout")?.addEventListener("click", doLogout);
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
    },
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

      if (method === "GET" && url.pathname === "/") {
        sendHtml(res, 200, buildPage({ appName, authed }));
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
