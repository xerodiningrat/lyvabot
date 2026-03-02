const { splitCodeBlocks } = require("./split");

function recoverCollapsedLuaLines(source) {
  let text = source;

  if (text.includes("\n")) {
    return text;
  }

  text = text.replace(/;\s*/g, ";\n");

  if (/^\s*--/.test(text)) {
    const probes = [
      /\blocal\b/,
      /\bfunction\b/,
      /\bif\b/,
      /\bfor\b/,
      /\bwhile\b/,
      /\brepeat\b/,
      /\breturn\b/,
      /\bgame:GetService\b/,
      /\.OnServerEvent\b/,
      /\bFindFirstChild\b/,
      /\bWaitForChild\b/,
    ];

    const searchFrom = 3;
    let splitAt = -1;
    for (const probe of probes) {
      const sliced = text.slice(searchFrom);
      const match = sliced.match(probe);
      if (!match || typeof match.index !== "number") continue;
      const index = match.index + searchFrom;
      if (splitAt === -1 || index < splitAt) splitAt = index;
    }

    if (splitAt > 0) {
      text = `${text.slice(0, splitAt).trimEnd()}\n${text.slice(splitAt).trimStart()}`;
    }
  }

  return text;
}

function normalizeCodeInput(source = "") {
  let normalized = String(source ?? "");
  normalized = normalized.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  const fencedMatch = normalized.match(/^\s*```[a-zA-Z0-9_-]*\n([\s\S]*?)\n?```\s*$/);
  if (fencedMatch) {
    normalized = fencedMatch[1];
  }

  if (!normalized.includes("\n")) {
    normalized = normalized.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n").replace(/\\t/g, "\t");
  }

  normalized = recoverCollapsedLuaLines(normalized);

  return normalized;
}

function toPreviewLines(source, maxLines = 30, maxCharsPerLine = 180) {
  const normalized = normalizeCodeInput(source);
  const originalLines = normalized.split("\n");

  const clippedLines = originalLines.slice(0, maxLines).map((line) => {
    if (line.length <= maxCharsPerLine) return line;
    return `${line.slice(0, maxCharsPerLine - 3)}...`;
  });

  if (originalLines.length > maxLines) {
    clippedLines.push(`... [truncated ${originalLines.length - maxLines} lines]`);
  }

  return clippedLines;
}

function toNumberedLines(source, options = {}) {
  const {
    maxLines = Number.POSITIVE_INFINITY,
    maxCharsPerLine = Number.POSITIVE_INFINITY,
  } = options;

  const lines = Number.isFinite(maxLines)
    ? toPreviewLines(source, maxLines, maxCharsPerLine)
    : normalizeCodeInput(source).split("\n");

  const digits = String(lines.length).length;

  return lines
    .map((line, index) => `${String(index + 1).padStart(digits, "0")} | ${line}`)
    .join("\n");
}

function formatCodeForDiscord(source, language = "lua") {
  const numbered = toNumberedLines(source, { maxLines: 30, maxCharsPerLine: 180 });
  return splitCodeBlocks(numbered, language, 1900);
}

module.exports = {
  formatCodeForDiscord,
  normalizeCodeInput,
  toNumberedLines,
};
