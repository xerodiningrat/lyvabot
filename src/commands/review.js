const { SlashCommandBuilder, ChannelType, PermissionFlagsBits, MessageFlags } = require("discord.js");
const { formatCodeForDiscord, normalizeCodeInput } = require("../review/formatter");
const { analyzeCode, formatFindings, formatSignalScan, formatDebugReport } = require("../review/rules");
const { buildChecklistMessage, buildFeedbackTemplate } = require("../review/templates");
const { recordFindingHistory } = require("../review/history");
const {
  requestOpenAIReview,
  formatAIReviewReport,
  splitLongMessage,
  estimateAIRequestCostUSD,
  validatePatchSafety,
} = require("../review/ai");
const { checkAIBudget, recordAIUsage } = require("../review/ai-usage");

const DEFAULT_PROMO_MESSAGE = [
  "========== PROMO SPESIAL LYVA INDONESIA ==========",
  "MAU CHATGPT PREMIUM TANPA LIMIT CUMAN 30 RIBUAN?",
  "BELI SEKARANG: https://lyvaindonesia.com/",
  "==================================================",
].join("\n");

function getPromoMessage() {
  const value = String(process.env.PROMO_MESSAGE || "").trim();
  return value || DEFAULT_PROMO_MESSAGE;
}

function withPromo(content = "") {
  const promo = getPromoMessage();
  const body = String(content || "").trim();
  return body ? `${promo}\n\n${body}` : promo;
}

function extractFirstLuaCodeBlock(markdownText = "") {
  const match = String(markdownText || "").match(/```lua\n([\s\S]*?)```/i);
  if (!match) return "";
  return String(match[1] || "").trim();
}

function buildIssueFocusedInput(source, findings = [], options = {}) {
  const radius = Number(options.radius || 6);
  const maxSnippets = Number(options.maxSnippets || 3);
  const maxChars = Number(options.maxChars || 4500);
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
      context: "Tidak ada finding spesifik dari rule engine; kirim konteks awal script.",
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
    joined = joined.slice(0, maxChars - 80) + "\n\n-- [TRUNCATED FOR AI INPUT]";
  }

  return {
    code: joined,
    context: `Perbaiki hanya blok issue berikut: ${contexts.join("; ")}`,
    snippetCount: blocks.length,
  };
}

const data = new SlashCommandBuilder()
  .setName("review")
  .setDescription("Roblox code review workflow")
  .addSubcommand((sub) =>
    sub
      .setName("paste")
      .setDescription("Buat thread review dari potongan kode")
      .addStringOption((opt) =>
        opt
          .setName("code")
          .setDescription("Tempel kode Lua/Roblox (opsional jika upload file)")
          .setRequired(false),
      )
      .addAttachmentOption((opt) =>
        opt
          .setName("file")
          .setDescription("Upload file .lua/.luau/.txt (opsional)")
          .setRequired(false),
      )
      .addStringOption((opt) =>
        opt
          .setName("filename")
          .setDescription("Nama file opsional, contoh: CombatServer.lua")
          .setRequired(false),
      )
      .addStringOption((opt) =>
        opt
          .setName("pack")
          .setDescription("Pilih paket rule")
          .addChoices(
            { name: "all", value: "all" },
            { name: "security", value: "security" },
            { name: "performance", value: "performance" },
            { name: "style", value: "style" },
          )
          .setRequired(false),
      )
      .addStringOption((opt) =>
        opt
          .setName("ignore_rules")
          .setDescription("Abaikan rule tertentu, pisahkan koma. Contoh: missing-rate-limit")
          .setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("ai")
      .setDescription("AI review untuk ringkasan dan saran patch")
      .addStringOption((opt) =>
        opt
          .setName("code")
          .setDescription("Kode yang ingin direview AI (opsional jika upload file)")
          .setRequired(false),
      )
      .addAttachmentOption((opt) =>
        opt
          .setName("file")
          .setDescription("Upload file .lua/.luau/.txt (opsional)")
          .setRequired(false),
      )
      .addStringOption((opt) =>
        opt
          .setName("filename")
          .setDescription("Nama file opsional, contoh: CombatServer.lua")
          .setRequired(false),
      )
      .addStringOption((opt) =>
        opt
          .setName("pack")
          .setDescription("Pilih paket rule untuk konteks AI")
          .addChoices(
            { name: "all", value: "all" },
            { name: "security", value: "security" },
            { name: "performance", value: "performance" },
            { name: "style", value: "style" },
          )
          .setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("debug")
      .setDescription("Debug mode analyzer (admin only)")
      .addStringOption((opt) =>
        opt
          .setName("code")
          .setDescription("Tempel kode Lua/Roblox (opsional jika upload file)")
          .setRequired(false),
      )
      .addAttachmentOption((opt) =>
        opt
          .setName("file")
          .setDescription("Upload file .lua/.luau/.txt (opsional)")
          .setRequired(false),
      )
      .addStringOption((opt) =>
        opt
          .setName("filename")
          .setDescription("Nama file opsional, contoh: FlyClient.lua")
          .setRequired(false),
      )
      .addStringOption((opt) =>
        opt
          .setName("pack")
          .setDescription("Pilih paket rule")
          .addChoices(
            { name: "all", value: "all" },
            { name: "security", value: "security" },
            { name: "performance", value: "performance" },
            { name: "style", value: "style" },
          )
          .setRequired(false),
      )
      .addStringOption((opt) =>
        opt
          .setName("ignore_rules")
          .setDescription("Abaikan rule tertentu, pisahkan koma. Contoh: frame-loop-heavy-risk")
          .setRequired(false),
      ),
  );

async function resolveDestinationThread(interaction, filename) {
  const activeChannel = interaction.channel;

  if (!activeChannel || !interaction.guild) {
    return {
      error: "Command ini hanya bisa dipakai di server Discord (bukan DM).",
    };
  }

  if (activeChannel.isThread()) {
    return { thread: activeChannel };
  }

  const threadManager = activeChannel.threads;
  if (!threadManager || typeof threadManager.create !== "function") {
    return {
      error: "Channel ini tidak mendukung thread. Jalankan command di text channel server yang bisa bikin thread.",
    };
  }

  let me = interaction.guild.members.me;
  if (!me) {
    me = await interaction.guild.members.fetchMe().catch(() => null);
  }

  const permissions = me ? activeChannel.permissionsFor(me) : null;
  const missing = [];

  if (!permissions?.has(PermissionFlagsBits.ViewChannel)) missing.push("ViewChannel");
  if (!permissions?.has(PermissionFlagsBits.SendMessages)) missing.push("SendMessages");
  if (!permissions?.has(PermissionFlagsBits.CreatePublicThreads)) missing.push("CreatePublicThreads");
  if (!permissions?.has(PermissionFlagsBits.SendMessagesInThreads)) missing.push("SendMessagesInThreads");

  if (missing.length > 0) {
    return {
      error: `Bot belum punya permission yang cukup di channel ini: ${missing.join(", ")}.`,
    };
  }

  try {
    const thread = await threadManager.create({
      name: `Review: ${filename}`.slice(0, 100),
      autoArchiveDuration: 1440,
      type: ChannelType.PublicThread,
      reason: `Code review requested by ${interaction.user.tag}`,
    });

    return { thread };
  } catch {
    return {
      error: "Gagal membuat thread di channel ini. Cek permission bot dan pastikan channel mendukung public thread.",
    };
  }
}

async function parseCodeInput(interaction) {
  const rawCode = interaction.options.getString("code");
  const attachment = interaction.options.getAttachment("file");
  const filenameOption = interaction.options.getString("filename");
  const pack = interaction.options.getString("pack") || "all";
  const ignoreRulesInput = interaction.options.getString("ignore_rules") || "";
  let code = rawCode || "";
  let filename = filenameOption || "Script.lua";

  const ignoredRules = ignoreRulesInput
    .split(/[,\s]+/)
    .map((item) => item.trim().toLowerCase().replace(/_/g, "-"))
    .filter(Boolean);

  if (attachment) {
    const allowed = [".lua", ".luau", ".txt"];
    const attachmentName = attachment.name || "upload.txt";
    const lowerName = attachmentName.toLowerCase();
    const isAllowed = allowed.some((ext) => lowerName.endsWith(ext));

    if (!isAllowed) {
      return { ok: false, error: "Format file belum didukung. Gunakan .lua, .luau, atau .txt." };
    }

    const response = await fetch(attachment.url);
    if (!response.ok) {
      return { ok: false, error: "Gagal download file attachment. Coba upload ulang." };
    }

    code = await response.text();
    if (!filenameOption) {
      filename = attachmentName;
    }
  }

  const fullCode = normalizeCodeInput(code);
  if (!fullCode.trim()) {
    return { ok: false, error: "Isi `code` atau upload `file` dulu sebelum review." };
  }

  return {
    ok: true,
    rawCode: String(code || ""),
    fullCode,
    filename,
    pack,
    ignoredRules,
  };
}

async function runPaste(interaction) {
  const parsed = await parseCodeInput(interaction);
  if (!parsed.ok) {
    await interaction.reply({
      flags: MessageFlags.Ephemeral,
      content: withPromo(parsed.error),
    });
    return;
  }
  const { rawCode, fullCode, filename, pack, ignoredRules } = parsed;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const destination = await resolveDestinationThread(interaction, filename);
  if (!destination.thread) {
    await interaction.editReply(withPromo(destination.error));
    return;
  }

  const thread = destination.thread;

  const codeBlocks = formatCodeForDiscord(fullCode, "lua");
  const fullLines = fullCode.split("\n");
  const previewTruncated = fullLines.length > 30 || fullLines.some((line) => line.length > 180);
  await thread.send(withPromo(`**Code Submission**\nFile: \`${filename}\`\nRequested by: <@${interaction.user.id}>`));

  for (const block of codeBlocks) {
    await thread.send(block);
  }

  if (previewTruncated) {
    await thread.send("Catatan: preview code dipotong untuk tampilan Discord, tapi rule analysis tetap pakai full code input.");
  }

  const analysis = analyzeCode(fullCode, filename, {
    pack,
    ignoredRules,
    rawSource: rawCode,
  });
  let findings = analysis.findings;
  let historySummary = "";

  try {
    const history = await recordFindingHistory({
      guildId: interaction.guildId,
      userId: interaction.user.id,
      filename,
      findings,
    });
    findings = history.findings;
    historySummary = history.summary;
  } catch (historyError) {
    console.error("Failed to write finding history", historyError);
  }

  await thread.send(formatSignalScan(analysis.meta.signals));
  await thread.send(buildChecklistMessage(findings, analysis.facts));
  await thread.send(formatFindings(findings, analysis.meta));
  if (historySummary) {
    await thread.send(historySummary);
  }
  await thread.send(buildFeedbackTemplate(findings));

  await interaction.editReply(withPromo(`Thread review dipakai: <#${thread.id}>`));
}

async function runDebug(interaction) {
  const canDebug =
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ||
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
  if (!canDebug) {
    await interaction.reply({
      flags: MessageFlags.Ephemeral,
      content: withPromo("Mode debug hanya untuk admin server (Administrator/Manage Server)."),
    });
    return;
  }

  const parsed = await parseCodeInput(interaction);
  if (!parsed.ok) {
    await interaction.reply({
      flags: MessageFlags.Ephemeral,
      content: withPromo(parsed.error),
    });
    return;
  }

  const analysis = analyzeCode(parsed.fullCode, parsed.filename, {
    pack: parsed.pack,
    ignoredRules: parsed.ignoredRules,
    rawSource: parsed.rawCode,
  });

  const response = [
    formatDebugReport(analysis),
    "",
    formatFindings(analysis.findings, analysis.meta),
  ].join("\n");

  await interaction.reply({
    flags: MessageFlags.Ephemeral,
    content: withPromo(response.length > 1850 ? `${response.slice(0, 1847)}...` : response),
  });
}

async function runAI(interaction) {
  const parsed = await parseCodeInput(interaction);
  if (!parsed.ok) {
    await interaction.reply({
      flags: MessageFlags.Ephemeral,
      content: withPromo(parsed.error),
    });
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    await interaction.reply({
      flags: MessageFlags.Ephemeral,
      content: withPromo(
        "OPENAI_API_KEY belum di-set. Tambahkan `OPENAI_API_KEY=...` di `.env`, restart bot, lalu jalankan `/review ai` lagi.",
      ),
    });
    return;
  }

  const estimate = estimateAIRequestCostUSD({
    codeChars: parsed.fullCode.length,
  });
  const budgetGate = await checkAIBudget({
    userId: interaction.user.id,
    estimatedCostUSD: estimate.estimatedCostUSD,
  });
  if (!budgetGate.ok) {
    if (budgetGate.limitType === "user_requests") {
      await interaction.reply({
        flags: MessageFlags.Ephemeral,
        content: withPromo(
          "ANDA SUDAH MENCAPAI LIMIT MAU CHAT GPT TANPA LIMIT BISA BELI DI https://lyvaindonesia.com CUMAN 30 RIBUAN AJA MAU CHATGPT PREMIUM TANPA LIMIT CUMAN 30 RIBUAN? Beli di https://lyvaindonesia.com/",
        ),
      });
      return;
    }

    await interaction.reply({
      flags: MessageFlags.Ephemeral,
      content: withPromo(`AI request ditolak oleh limiter harian. ${budgetGate.reason}`),
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const analysis = analyzeCode(parsed.fullCode, parsed.filename, {
    pack: parsed.pack || "all",
    ignoredRules: parsed.ignoredRules || [],
    rawSource: parsed.rawCode,
  });
  const focused = buildIssueFocusedInput(parsed.fullCode, analysis.findings, {
    radius: 6,
    maxSnippets: 3,
    maxChars: 4200,
  });

  try {
    const aiResult = await requestOpenAIReview({
      apiKey,
      model: process.env.OPENAI_MODEL || undefined,
      filename: parsed.filename,
      code: focused.code,
      ruleFindings: analysis.findings,
      signalSummary: formatSignalScan(analysis.meta.signals),
      issueContext: focused.context,
    });

    const patchCheck = validatePatchSafety({
      patch: aiResult.suggestedPatch,
      findings: analysis.findings,
      originalCode: parsed.fullCode,
    });
    if (!patchCheck.ok) {
      const fallbackTemplate = buildFeedbackTemplate(analysis.findings);
      const fallbackPatch = extractFirstLuaCodeBlock(fallbackTemplate);
      if (fallbackPatch) {
        aiResult.suggestedPatch = fallbackPatch;
      }
      const reason = patchCheck.issues.join("; ");
      aiResult.notes = `Patch AI dibatasi guardrail dan diganti fallback rule-based. Reason: ${reason}`;
    }

    await recordAIUsage({
      userId: interaction.user.id,
      estimatedCostUSD: estimate.estimatedCostUSD,
      actualCostUSD: aiResult.actualCostUSD,
      usage: aiResult.usage
        ? {
            promptTokens: Number(aiResult.usage.prompt_tokens || 0),
            completionTokens: Number(aiResult.usage.completion_tokens || 0),
            totalTokens: Number(aiResult.usage.total_tokens || 0),
          }
        : null,
      model: aiResult.model || process.env.OPENAI_MODEL || "gpt-4o-mini",
    });

    const aiReport = formatAIReviewReport(aiResult);
    const ruleContext = formatFindings(analysis.findings, analysis.meta);
    const composed = [
      aiReport,
      "",
      `AI Input Mode: focused issue snippets (${focused.snippetCount} block)`,
      "",
      "**Rule Context (Level 2)**",
      ruleContext,
    ].join("\n");
    const chunks = splitLongMessage(withPromo(composed), 1800);

    await interaction.editReply(chunks[0] || "AI review selesai, tapi output kosong.");
    for (let i = 1; i < chunks.length; i += 1) {
      await interaction.followUp({
        flags: MessageFlags.Ephemeral,
        content: chunks[i],
      });
    }
  } catch (error) {
    console.error("AI review failed", error);
    const status = Number(error?.status);
    const code = String(error?.openaiCode || "");
    const type = String(error?.openaiType || "");
    let message = `Gagal menjalankan AI review: ${error.message || "unknown error"}`;

    if (status === 429 && (code === "insufficient_quota" || type === "insufficient_quota")) {
      message =
        "AI review gagal: kuota OpenAI habis (`insufficient_quota`). Cek billing/usage di OpenAI Dashboard lalu coba lagi.";
    } else if (status === 429) {
      message = "AI review kena rate limit (429). Coba lagi beberapa saat.";
    } else if (status === 401) {
      message = "AI review gagal: API key tidak valid atau tidak punya akses model.";
    } else if (status === 403) {
      message = "AI review gagal: akses API ditolak (403). Cek project/key permissions.";
    }

    await interaction.editReply(withPromo(message));
  }
}

async function execute(interaction) {
  const sub = interaction.options.getSubcommand();

  if (sub === "paste") {
    await runPaste(interaction);
    return;
  }

  if (sub === "ai") {
    await runAI(interaction);
    return;
  }

  if (sub === "debug") {
    await runDebug(interaction);
  }
}

module.exports = {
  data,
  execute,
};

