const fs = require("fs/promises");
const path = require("path");

const USAGE_PATH = path.join(process.cwd(), "data", "ai-usage.json");

function toPositiveNumber(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

function round6(value) {
  return Math.round(Number(value || 0) * 1_000_000) / 1_000_000;
}

function getTodayKey() {
  return new Date().toISOString().slice(0, 10);
}

function getLimits() {
  return {
    dailyBudgetUSD: toPositiveNumber(process.env.AI_DAILY_BUDGET_USD, 5),
    maxRequestsPerDay: Math.floor(toPositiveNumber(process.env.AI_MAX_REQUESTS_PER_DAY, 250)),
    maxRequestsPerUserPerDay: Math.floor(toPositiveNumber(process.env.AI_MAX_REQUESTS_PER_USER_PER_DAY, 3)),
  };
}

async function readUsageFile() {
  try {
    const raw = await fs.readFile(USAGE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { days: {} };
    if (!parsed.days || typeof parsed.days !== "object") return { days: {} };
    return parsed;
  } catch {
    return { days: {} };
  }
}

async function writeUsageFile(payload) {
  await fs.mkdir(path.dirname(USAGE_PATH), { recursive: true });
  await fs.writeFile(USAGE_PATH, JSON.stringify(payload, null, 2), "utf8");
}

function ensureDayBucket(store, dayKey) {
  if (!store.days[dayKey] || typeof store.days[dayKey] !== "object") {
    store.days[dayKey] = {
      totalRequests: 0,
      totalCostUSD: 0,
      users: {},
    };
  }

  if (!store.days[dayKey].users || typeof store.days[dayKey].users !== "object") {
    store.days[dayKey].users = {};
  }

  return store.days[dayKey];
}

function ensureUserBucket(day, userId) {
  const key = String(userId || "unknown");
  if (!day.users[key] || typeof day.users[key] !== "object") {
    day.users[key] = { requests: 0, costUSD: 0 };
  }
  return day.users[key];
}

function snapshot(day, user, limits) {
  const used = Number(day.totalCostUSD || 0);
  const remaining = Math.max(0, limits.dailyBudgetUSD - used);

  return {
    dailyBudgetUSD: limits.dailyBudgetUSD,
    totalCostUSD: round6(used),
    remainingBudgetUSD: round6(remaining),
    totalRequests: Number(day.totalRequests || 0),
    userRequests: Number(user.requests || 0),
    userCostUSD: round6(Number(user.costUSD || 0)),
    maxRequestsPerDay: limits.maxRequestsPerDay,
    maxRequestsPerUserPerDay: limits.maxRequestsPerUserPerDay,
  };
}

async function checkAIBudget({ userId, estimatedCostUSD = 0 }) {
  const store = await readUsageFile();
  const limits = getLimits();
  const dayKey = getTodayKey();
  const day = ensureDayBucket(store, dayKey);
  const user = ensureUserBucket(day, userId);
  const estimate = Math.max(0, Number(estimatedCostUSD || 0));
  const view = snapshot(day, user, limits);

  if (day.totalRequests >= limits.maxRequestsPerDay) {
    return {
      ok: false,
      limitType: "global_requests",
      reason: `Batas request AI harian tercapai (${limits.maxRequestsPerDay}/hari).`,
      snapshot: view,
    };
  }

  if (user.requests >= limits.maxRequestsPerUserPerDay) {
    return {
      ok: false,
      limitType: "user_requests",
      reason: `Batas request AI user ini tercapai (${limits.maxRequestsPerUserPerDay}/hari).`,
      snapshot: view,
    };
  }

  if (day.totalCostUSD + estimate > limits.dailyBudgetUSD) {
    return {
      ok: false,
      limitType: "daily_budget",
      reason: `Estimasi biaya request ini melewati budget harian ($${limits.dailyBudgetUSD.toFixed(2)}).`,
      snapshot: view,
    };
  }

  return {
    ok: true,
    limitType: "",
    reason: "",
    snapshot: view,
  };
}

async function recordAIUsage({
  userId,
  estimatedCostUSD = 0,
  actualCostUSD = null,
  usage = null,
  model = "unknown",
}) {
  const store = await readUsageFile();
  const limits = getLimits();
  const dayKey = getTodayKey();
  const day = ensureDayBucket(store, dayKey);
  const user = ensureUserBucket(day, userId);

  const billedCost = Number.isFinite(Number(actualCostUSD)) ? Number(actualCostUSD) : Number(estimatedCostUSD || 0);
  const safeCost = Math.max(0, billedCost);

  day.totalRequests += 1;
  day.totalCostUSD = round6(Number(day.totalCostUSD || 0) + safeCost);
  user.requests += 1;
  user.costUSD = round6(Number(user.costUSD || 0) + safeCost);

  day.lastUsage = {
    at: new Date().toISOString(),
    model,
    costUSD: round6(safeCost),
    promptTokens: usage?.promptTokens ?? null,
    completionTokens: usage?.completionTokens ?? null,
    totalTokens: usage?.totalTokens ?? null,
  };

  await writeUsageFile(store);
  return snapshot(day, user, limits);
}

function formatBudgetSummary(view) {
  if (!view) return "";
  return [
    `Budget today: $${view.totalCostUSD.toFixed(4)} / $${view.dailyBudgetUSD.toFixed(2)} (sisa $${view.remainingBudgetUSD.toFixed(4)})`,
    `Requests: ${view.totalRequests}/${view.maxRequestsPerDay} (user ${view.userRequests}/${view.maxRequestsPerUserPerDay})`,
  ].join(" | ");
}

module.exports = {
  checkAIBudget,
  recordAIUsage,
  formatBudgetSummary,
};
