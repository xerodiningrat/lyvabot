const DEFAULT_OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const AI_MAX_CODE_CHARS = Number(process.env.AI_MAX_CODE_CHARS || 6000);
const AI_MAX_OUTPUT_TOKENS = Number(process.env.AI_MAX_OUTPUT_TOKENS || 500);
const AI_INPUT_COST_PER_1M_USD = Number(process.env.AI_INPUT_COST_PER_1M_USD || 0.15);
const AI_OUTPUT_COST_PER_1M_USD = Number(process.env.AI_OUTPUT_COST_PER_1M_USD || 0.6);

function buildOpenAIError({ status, bodyText, errorObj }) {
  const code = errorObj?.code || null;
  const type = errorObj?.type || null;
  const message = errorObj?.message || bodyText || `OpenAI request gagal (${status})`;
  const error = new Error(message);
  error.status = status;
  error.openaiCode = code;
  error.openaiType = type;
  return error;
}

function normalizeSeverity(value) {
  const sev = String(value || "medium").toLowerCase();
  if (["critical", "high", "medium", "low", "info"].includes(sev)) return sev;
  return "medium";
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function clipText(value, max = 300) {
  const text = String(value || "").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

function tokenEstimateFromChars(chars) {
  return Math.ceil(Math.max(0, Number(chars || 0)) / 4);
}

function estimateAIRequestCostUSD({ codeChars = 0, promptOverheadChars = 2400, outputTokens = AI_MAX_OUTPUT_TOKENS } = {}) {
  const inputTokensEstimated = tokenEstimateFromChars(Number(codeChars || 0) + Number(promptOverheadChars || 0));
  const outputTokensEstimated = Math.max(64, Math.floor(Number(outputTokens || AI_MAX_OUTPUT_TOKENS)));
  const inputCost = (inputTokensEstimated / 1_000_000) * AI_INPUT_COST_PER_1M_USD;
  const outputCost = (outputTokensEstimated / 1_000_000) * AI_OUTPUT_COST_PER_1M_USD;

  return {
    inputTokensEstimated,
    outputTokensEstimated,
    estimatedCostUSD: inputCost + outputCost,
  };
}

function calculateActualCostUSD(usage) {
  if (!usage || typeof usage !== "object") return null;
  const promptTokens = Number(usage.prompt_tokens || 0);
  const completionTokens = Number(usage.completion_tokens || 0);
  if (!Number.isFinite(promptTokens) || !Number.isFinite(completionTokens)) {
    return null;
  }

  const inputCost = (promptTokens / 1_000_000) * AI_INPUT_COST_PER_1M_USD;
  const outputCost = (completionTokens / 1_000_000) * AI_OUTPUT_COST_PER_1M_USD;
  return inputCost + outputCost;
}

function trimCodeForAI(source, maxChars = AI_MAX_CODE_CHARS) {
  const text = String(source || "");
  if (text.length <= maxChars) {
    return { code: text, truncated: false, originalChars: text.length };
  }

  const headChars = Math.floor(maxChars * 0.65);
  const tailChars = maxChars - headChars;
  const trimmed = [
    text.slice(0, headChars),
    "",
    "-- [AI INPUT TRUNCATED: middle section omitted for token budget]",
    "",
    text.slice(Math.max(0, text.length - tailChars)),
  ].join("\n");

  return {
    code: trimmed,
    truncated: true,
    originalChars: text.length,
  };
}

function summarizeRuleFindings(findings = []) {
  if (!Array.isArray(findings) || findings.length === 0) {
    return "No rule-based findings.";
  }

  return findings
    .slice(0, 10)
    .map((finding, index) => {
      const severity = String(finding.severity || "medium").toUpperCase();
      const line = Number.isFinite(finding.line) ? finding.line : "?";
      const rule = finding.rule || "unknown-rule";
      const message = clipText(finding.message || "", 180);
      return `${index + 1}. [${severity}] line ${line} ${rule} - ${message}`;
    })
    .join("\n");
}

function toFiniteScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}

function normalizeFinding(item, index) {
  const payload = item && typeof item === "object" ? item : {};
  return {
    severity: normalizeSeverity(payload.severity),
    title: clipText(payload.title || payload.rule || `Finding ${index + 1}`, 120),
    line: Number.isFinite(Number(payload.line)) ? Number(payload.line) : null,
    impact: clipText(payload.impact || payload.dampak || payload.evidence || "", 220),
    suggestion: clipText(payload.suggestion || payload.saran || payload.fix || "", 260),
    confidence: toFiniteScore(payload.confidence),
  };
}

function normalizeAIResponse(parsed, meta = {}) {
  const obj = parsed && typeof parsed === "object" ? parsed : {};
  const findings = toArray(obj.findings || obj.issues).map(normalizeFinding).slice(0, 8);
  const tests = toArray(obj.test_plan || obj.tests || obj.remediation_checklist)
    .map((item) => clipText(item, 160))
    .filter(Boolean)
    .slice(0, 8);

  return {
    summary: clipText(obj.summary || obj.ringkasan || "AI tidak mengembalikan ringkasan.", 360),
    findings,
    suggestedPatch: String(obj.suggested_patch || obj.patch || "").trim(),
    testPlan: tests,
    notes: clipText(obj.notes || "", 280),
    model: meta.model || DEFAULT_OPENAI_MODEL,
    codeTruncatedForAI: Boolean(meta.codeTruncatedForAI),
    originalChars: Number.isFinite(meta.originalChars) ? meta.originalChars : null,
    usage: meta.usage || null,
    actualCostUSD: Number.isFinite(Number(meta.actualCostUSD)) ? Number(meta.actualCostUSD) : null,
    estimatedCostUSD: Number.isFinite(Number(meta.estimatedCostUSD)) ? Number(meta.estimatedCostUSD) : null,
    outputTokenCap: Number.isFinite(Number(meta.outputTokenCap)) ? Number(meta.outputTokenCap) : AI_MAX_OUTPUT_TOKENS,
  };
}

function buildMessages({ filename, code, codeTruncatedForAI, originalChars, ruleSummary, signalSummary, issueContext }) {
  const system = [
    "You are a senior Roblox Luau code reviewer.",
    "Focus on: security/exploit risk, correctness/runtime safety, performance, and practical remediation.",
    "Respond in Indonesian.",
    "Output HARUS JSON VALID SAJA, tanpa markdown, tanpa teks tambahan.",
    "Jika ragu, isi string kosong tetapi tetap JSON valid.",
    "Schema JSON WAJIB:",
    "{\"summary\":\"\",\"findings\":[{\"severity\":\"\",\"title\":\"\",\"line\":0,\"evidence\":\"\",\"fix\":\"\"}],\"patch\":\"\",\"notes\":\"\"}",
    "Patch harus ringkas dan runnable Luau.",
    "Guardrails wajib:",
    "- Jangan membuat event :Connect baru jika handler sudah ada.",
    "- Jangan memindahkan while loop ke dalam handler event.",
    "- Jangan menghapus logic yang tidak terkait issue.",
    "- Patch harus berupa replacement block yang bermasalah, bukan rewrite seluruh file.",
    "- Jika ada DataStore SetAsync/UpdateAsync, gunakan pcall.",
    "- Untuk remote sensitif, tambahkan validasi + rate-limit.",
  ].join("\n");

  const user = [
    `File: ${filename}`,
    `Code chars provided to AI: ${code.length}${codeTruncatedForAI ? ` (truncated from ${originalChars})` : ""}`,
    "",
    "Signal scan summary:",
    signalSummary || "N/A",
    "",
    "Rule-based findings summary:",
    ruleSummary,
    "",
    "Issue context:",
    issueContext || "N/A",
    "",
    "Code:",
    "```lua",
    code,
    "```",
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

function salvageJsonObject(content) {
  const text = String(content || "").trim();
  if (!text) return null;

  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) {
    return null;
  }

  const candidate = text.slice(first, last + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function parseAIJson(content) {
  const raw = String(content || "");
  try {
    return JSON.parse(raw);
  } catch {
    const salvaged = salvageJsonObject(raw);
    if (salvaged) {
      return salvaged;
    }

    return {
      summary: "Model tidak mengembalikan JSON valid. Menampilkan output mentah.",
      findings: [],
      patch: "",
      notes: clipText(raw, 800),
    };
  }
}

async function requestOpenAIReview({
  apiKey,
  model = DEFAULT_OPENAI_MODEL,
  filename,
  code,
  ruleFindings = [],
  signalSummary = "",
  issueContext = "",
  timeoutMs = 45000,
}) {
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY belum di-set.");
  }

  const prepared = trimCodeForAI(code);
  const estimatedUsage = estimateAIRequestCostUSD({
    codeChars: prepared.code.length,
    promptOverheadChars: 2600,
    outputTokens: AI_MAX_OUTPUT_TOKENS,
  });
  const messages = buildMessages({
    filename,
    code: prepared.code,
    codeTruncatedForAI: prepared.truncated,
    originalChars: prepared.originalChars,
    ruleSummary: summarizeRuleFindings(ruleFindings),
    signalSummary,
    issueContext,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: AI_MAX_OUTPUT_TOKENS,
        response_format: { type: "json_object" },
        messages,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const bodyText = await response.text();
      let parsedErr = null;
      try {
        parsedErr = JSON.parse(bodyText);
      } catch {
        parsedErr = null;
      }

      const err = buildOpenAIError({
        status: response.status,
        bodyText: clipText(bodyText, 700),
        errorObj: parsedErr?.error,
      });
      throw err;
    }

    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("OpenAI response tidak punya content.");
    }

    const parsed = parseAIJson(content);

    return normalizeAIResponse(parsed, {
      model,
      codeTruncatedForAI: prepared.truncated,
      originalChars: prepared.originalChars,
      usage: payload?.usage || null,
      actualCostUSD: calculateActualCostUSD(payload?.usage || null),
      estimatedCostUSD: estimatedUsage.estimatedCostUSD,
      outputTokenCap: AI_MAX_OUTPUT_TOKENS,
    });
  } finally {
    clearTimeout(timer);
  }
}

function formatAIReviewReport(report) {
  const lines = ["**AI Review (Level 3)**"];
  lines.push(`Model: ${report.model}`);
  if (report.codeTruncatedForAI && Number.isFinite(report.originalChars)) {
    lines.push(`Catatan input AI: kode dipotong untuk token budget (original ${report.originalChars} chars).`);
  }
  lines.push(`Summary: ${report.summary}`);

  if (report.findings.length > 0) {
    lines.push("Temuan:");
    report.findings.forEach((finding, index) => {
      const sev = finding.severity.toUpperCase();
      const line = Number.isFinite(finding.line) ? ` line ${finding.line}` : "";
      lines.push(`${index + 1}. [${sev}] ${finding.title}${line}`);
      if (finding.impact) lines.push(`   Dampak: ${finding.impact}`);
      if (finding.suggestion) lines.push(`   Saran: ${finding.suggestion}`);
      if (Number.isFinite(finding.confidence)) lines.push(`   Confidence: ${finding.confidence.toFixed(2)}`);
    });
  } else {
    lines.push("Temuan: tidak ada temuan spesifik dari AI.");
  }

  if (report.suggestedPatch) {
    lines.push("Suggested Patch:");
    lines.push("```lua");
    lines.push(report.suggestedPatch);
    lines.push("```");
  }

  if (report.testPlan.length > 0) {
    lines.push("Test Plan:");
    report.testPlan.forEach((item) => lines.push(`- ${item}`));
  }

  if (report.notes) {
    lines.push(`Notes: ${report.notes}`);
  }

  return lines.join("\n");
}

function splitLongMessage(text, maxLength = 1800) {
  const raw = String(text || "");
  if (raw.length <= maxLength) return [raw];

  const chunks = [];
  const paragraphs = raw.split("\n");
  let current = "";

  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n${paragraph}` : paragraph;
    if (candidate.length <= maxLength) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push(current);
      current = "";
    }

    if (paragraph.length <= maxLength) {
      current = paragraph;
      continue;
    }

    let start = 0;
    while (start < paragraph.length) {
      chunks.push(paragraph.slice(start, start + maxLength));
      start += maxLength;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

function countRegexMatches(text, regex) {
  const matches = String(text || "").match(regex);
  return matches ? matches.length : 0;
}

function hasRule(findings, ruleId) {
  return Array.isArray(findings) && findings.some((finding) => finding?.rule === ruleId);
}

function validatePatchSafety({ patch, findings = [], originalCode = "" } = {}) {
  const issues = [];
  const text = String(patch || "");
  const source = String(originalCode || "");

  if (!text.trim()) {
    issues.push("Patch kosong.");
  }

  const onServerConnectCount = countRegexMatches(text, /\.OnServerEvent\s*:\s*Connect\s*\(/g);
  if (onServerConnectCount > 1) {
    issues.push("Patch menambah lebih dari satu OnServerEvent:Connect.");
  }

  if (/OnServerEvent[\s\S]{0,1200}while\s+true\s+do/i.test(text)) {
    issues.push("Patch menaruh while true do di dalam handler OnServerEvent.");
  }

  const hasDataStoreRisk = hasRule(findings, "trust-client-datastore");
  if (hasDataStoreRisk && /(SetAsync|UpdateAsync)\s*\(/.test(text) && !/pcall\s*\(/.test(text)) {
    issues.push("Patch DataStore belum pakai pcall.");
  }

  const hasRemoteRisk = [
    "trust-client-economy",
    "trust-client-damage",
    "trust-client-teleport",
    "trust-client-inventory",
    "missing-rate-limit",
    "missing-remote-validation",
  ].some((rule) => hasRule(findings, rule));
  if (
    hasRemoteRisk &&
    /OnServerEvent\s*:\s*Connect\s*\(/.test(text) &&
    !/(cooldown|rate.?limit|bucket|tokens?|os\.clock|tick\s*\()/i.test(text)
  ) {
    issues.push("Patch remote sensitif belum menunjukkan rate-limit/cooldown.");
  }

  if (/while\s+true\s+do/i.test(text) && /while\s+true\s+do/i.test(source) && !/task\.wait\s*\(/i.test(text)) {
    issues.push("Patch masih mengandung while true tanpa task.wait().");
  }

  return {
    ok: issues.length === 0,
    issues,
  };
}

module.exports = {
  requestOpenAIReview,
  formatAIReviewReport,
  splitLongMessage,
  estimateAIRequestCostUSD,
  validatePatchSafety,
};
