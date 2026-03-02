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
    :root {
      --bg: #0b1220;
      --panel: #121a2b;
      --panel-2: #1b2640;
      --line: #2c3a5e;
      --text: #e6edf7;
      --muted: #9fb0d1;
      --brand: #22c55e;
      --brand-2: #38bdf8;
      --warn: #f59e0b;
      --danger: #ef4444;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;
      color: var(--text);
      background: radial-gradient(1200px 600px at 10% -20%, #1f325f 0%, var(--bg) 55%);
      min-height: 100vh;
    }
    .wrap { max-width: 1100px; margin: 0 auto; padding: 24px; }
    .title {
      margin: 0 0 8px;
      font-size: 28px;
      letter-spacing: .4px;
    }
    .sub { margin: 0 0 24px; color: var(--muted); }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 12px;
      margin-bottom: 16px;
    }
    .card, .panel {
      background: linear-gradient(180deg, var(--panel) 0%, var(--panel-2) 100%);
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 14px;
      box-shadow: 0 8px 24px rgba(0,0,0,.18);
    }
    .metric { font-size: 24px; font-weight: 700; margin: 6px 0 0; }
    .muted { color: var(--muted); font-size: 13px; }
    .row { display: flex; gap: 10px; flex-wrap: wrap; }
    button {
      border: 0;
      border-radius: 10px;
      padding: 10px 14px;
      font-weight: 600;
      cursor: pointer;
      color: #09111f;
      background: var(--brand);
    }
    button.secondary { background: var(--brand-2); }
    button.warn { background: var(--warn); }
    button.danger { background: var(--danger); color: #fff; }
    input {
      width: 100%;
      padding: 10px 12px;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: #0f1729;
      color: var(--text);
    }
    .actions { display: grid; gap: 10px; }
    .log {
      margin-top: 10px;
      font-size: 13px;
      color: var(--muted);
      white-space: pre-wrap;
      background: #0d1424;
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 10px;
      min-height: 70px;
    }
    .login {
      max-width: 420px;
      margin: 8vh auto 0;
    }
    .hidden { display: none; }
    .pill {
      display: inline-block;
      padding: 4px 8px;
      border-radius: 999px;
      font-size: 12px;
      border: 1px solid var(--line);
      color: var(--muted);
    }
  </style>
</head>
<body>
  <div class="wrap">
    <h1 class="title">${safeName}</h1>
    <p class="sub">Dashboard bot untuk cek status dan kontrol command sync.</p>

    <section id="loginView" class="panel login ${authed ? "hidden" : ""}">
      <h2 style="margin-top:0;">Login Dashboard</h2>
      <p class="muted">Masuk pakai akun dashboard yang ada di .env</p>
      <div style="display:grid; gap:10px;">
        <input id="username" placeholder="Username" autocomplete="username" />
        <input id="password" type="password" placeholder="Password" autocomplete="current-password" />
        <button id="btnLogin">Masuk</button>
      </div>
      <div id="loginMsg" class="log"></div>
    </section>

    <section id="appView" class="${authed ? "" : "hidden"}">
      <div class="grid" id="statsGrid"></div>
      <div class="panel">
        <h3 style="margin-top:0;">Aksi Bot</h3>
        <div class="actions">
          <div class="row">
            <button id="btnRefresh" class="secondary">Refresh Data</button>
            <button id="btnSyncAll">Sync Commands Semua Guild</button>
            <button id="btnClearGlobal" class="warn">Clear Global Commands</button>
            <button id="btnLogout" class="danger">Logout</button>
          </div>
          <div class="row">
            <input id="guildIdInput" placeholder="Guild ID untuk sync 1 guild (opsional)" />
            <button id="btnSyncOne">Sync 1 Guild</button>
          </div>
        </div>
        <div id="actionLog" class="log"></div>
      </div>
    </section>
  </div>

  <script>
    const isAuthed = ${authed ? "true" : "false"};
    const loginView = document.getElementById("loginView");
    const appView = document.getElementById("appView");
    const statsGrid = document.getElementById("statsGrid");
    const actionLog = document.getElementById("actionLog");

    function log(message) {
      const now = new Date().toLocaleTimeString();
      actionLog.textContent = "[" + now + "] " + message + "\\n" + actionLog.textContent;
    }

    function loginLog(message) {
      const box = document.getElementById("loginMsg");
      box.textContent = message;
    }

    function card(label, value, sub) {
      const el = document.createElement("div");
      el.className = "card";
      el.innerHTML = '<div class="muted">' + label + '</div><div class="metric">' + value + '</div><div class="muted">' + (sub || "") + '</div>';
      return el;
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
        statsGrid.innerHTML = "";
        const uptime = data.bot.uptimeSec ? Math.floor(data.bot.uptimeSec / 60) + " menit" : "0 menit";
        statsGrid.appendChild(card("Bot Status", data.bot.ready ? "Online" : "Offline", data.bot.tag || "-"));
        statsGrid.appendChild(card("Guild Join", String(data.bot.guildCount), "Command loaded: " + data.bot.commandCount));
        statsGrid.appendChild(card("Uptime", uptime, "Node: " + data.system.nodeVersion));
        statsGrid.appendChild(card("AI Hari Ini", "$" + data.ai.totalCostUSD.toFixed(4), "Req: " + data.ai.totalRequests));
        statsGrid.appendChild(card("Free Asset File", String(data.assets.fileCount), "Mobile ID: " + data.assets.mobileCount));
        statsGrid.appendChild(card("History Finding", String(data.reviewHistory.totalEntries), "Updated: " + data.reviewHistory.lastUpdatedLabel));
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
      totalCostUSD: Number(day.totalCostUSD || 0),
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
