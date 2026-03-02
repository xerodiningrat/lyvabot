const fs = require("fs/promises");
const path = require("path");

const HISTORY_PATH = path.join(process.cwd(), "data", "review-history.json");

async function readHistory() {
  try {
    const raw = await fs.readFile(HISTORY_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return { entries: {} };
    }

    return {
      entries: parsed.entries && typeof parsed.entries === "object" ? parsed.entries : {},
    };
  } catch {
    return { entries: {} };
  }
}

async function writeHistory(payload) {
  await fs.mkdir(path.dirname(HISTORY_PATH), { recursive: true });
  await fs.writeFile(HISTORY_PATH, JSON.stringify(payload, null, 2), "utf8");
}

function buildKey({ guildId, userId, filename, rule }) {
  return [guildId || "noguild", userId || "nouser", (filename || "script.lua").toLowerCase(), rule].join("::");
}

async function recordFindingHistory({ guildId, userId, filename, findings }) {
  const history = await readHistory();
  const now = new Date().toISOString();

  const decorated = findings.map((finding) => {
    const key = buildKey({ guildId, userId, filename, rule: finding.rule });
    const prev = history.entries[key] || null;
    const previousCount = prev?.count || 0;
    const nextCount = previousCount + 1;

    history.entries[key] = {
      guildId: guildId || "noguild",
      userId: userId || "nouser",
      filename: filename || "script.lua",
      rule: finding.rule,
      count: nextCount,
      lastSeen: now,
      lastLine: finding.line,
    };

    return {
      ...finding,
      historyCount: nextCount,
      seenBefore: previousCount > 0,
    };
  });

  await writeHistory(history);

  const repeated = decorated.filter((item) => item.seenBefore);
  if (repeated.length === 0) {
    return {
      findings: decorated,
      summary: "History: belum ada issue serupa untuk file/user ini.",
    };
  }

  const top = [...repeated].sort((a, b) => b.historyCount - a.historyCount)[0];
  return {
    findings: decorated,
    summary: `History: ${repeated.length} issue type sudah pernah muncul; paling sering \`${top.rule}\` (${top.historyCount}x).`,
  };
}

module.exports = {
  recordFindingHistory,
};
