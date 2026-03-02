const RULE_PROFILES = {
  "trust-client-economy": {
    impactCategory: "Security/Economy Exploit",
    impactText:
      "Client bisa memalsukan nilai currency (amount besar/spam) sehingga ekonomi game rusak dan progres pemain tidak valid.",
    detectionConfidence: 0.95,
    patchConfidence: 0.78,
  },
  "trust-client-damage": {
    impactCategory: "Security/Combat Exploit",
    impactText:
      "Client bisa memanipulasi damage sehingga memicu one-shot/god-mode dan merusak fairness combat.",
    detectionConfidence: 0.9,
    patchConfidence: 0.76,
  },
  "trust-client-teleport": {
    impactCategory: "Security/Movement Exploit",
    impactText:
      "Client bisa memaksa teleport/perubahan posisi untuk bypass progression, area restriction, atau anti-cheat.",
    detectionConfidence: 0.86,
    patchConfidence: 0.72,
  },
  "trust-client-inventory": {
    impactCategory: "Security/Inventory Exploit",
    impactText:
      "Client bisa memanipulasi item/quantity sehingga berisiko dupe item dan inkonsistensi inventory.",
    detectionConfidence: 0.87,
    patchConfidence: 0.74,
  },
  "trust-client-datastore": {
    impactCategory: "Security/Data Integrity",
    impactText:
      "Client input mengalir ke DataStore write sehingga data persistent pemain bisa dirusak atau disalahgunakan.",
    detectionConfidence: 0.84,
    patchConfidence: 0.69,
  },
  "datastore-without-pcall": {
    impactCategory: "Reliability/Data Persistence",
    impactText:
      "SetAsync/UpdateAsync tanpa pcall berisiko error/throttle yang memutus flow save dan bisa bikin data tidak konsisten.",
    detectionConfidence: 0.9,
    patchConfidence: 0.88,
  },
  "missing-rate-limit": {
    impactCategory: "Security/Abuse",
    impactText:
      "Remote event sensitif tanpa rate-limit/cooldown bisa di-spam untuk abuse dan meningkatkan beban server.",
    detectionConfidence: 0.83,
    patchConfidence: 0.8,
  },
  "missing-remote-validation": {
    impactCategory: "Security/Input Validation",
    impactText:
      "Argumen client belum divalidasi lengkap (type/range/finite) sehingga mudah dieksploitasi.",
    detectionConfidence: 0.8,
    patchConfidence: 0.77,
  },
  "possible-nil-index": {
    impactCategory: "Reliability/Runtime Error",
    impactText: "Akses property pada nilai nil berisiko memicu runtime error dan menghentikan flow script.",
    detectionConfidence: 0.88,
    patchConfidence: 0.9,
  },
  "unsafe-findfirstchild-chain": {
    impactCategory: "Reliability/Runtime Error",
    impactText: "Chain langsung dari FindFirstChild berisiko nil access saat object tidak ditemukan.",
    detectionConfidence: 0.77,
    patchConfidence: 0.88,
  },
  "possible-nil-character-access": {
    impactCategory: "Reliability/Runtime Error",
    impactText:
      "Akses langsung Character/Humanoid/HumanoidRootPart tanpa guard bisa memicu error saat respawn/loading.",
    detectionConfidence: 0.86,
    patchConfidence: 0.9,
  },
  "frame-loop-heavy-risk": {
    impactCategory: "Performance/Frame Stability",
    impactText:
      "Callback per-frame (RenderStepped/Heartbeat/Stepped) tanpa gating/heavy call berisiko menurunkan FPS dan menambah jitter.",
    detectionConfidence: 0.78,
    patchConfidence: 0.8,
  },
  "missing-disconnect": {
    impactCategory: "Performance/Memory Leak",
    impactText: "Event connection di scope dinamis tanpa cleanup bisa menumpuk dan menyebabkan memory leak.",
    detectionConfidence: 0.74,
    patchConfidence: 0.82,
  },
  "while-true-no-wait": {
    impactCategory: "Performance/CPU Stall",
    impactText: "Loop tanpa jeda dapat membuat thread freeze dan CPU usage tinggi.",
    detectionConfidence: 0.92,
    patchConfidence: 0.9,
  },
  "wait-vs-task-wait": {
    impactCategory: "Performance/Scheduling",
    impactText: "Penggunaan wait() cenderung kurang presisi dibanding task.wait().",
    detectionConfidence: 0.85,
    patchConfidence: 0.93,
  },
  "repeated-getservice": {
    impactCategory: "Performance/Micro-Optimization",
    impactText: "GetService berulang di hot path menambah overhead yang seharusnya bisa di-cache.",
    detectionConfidence: 0.72,
    patchConfidence: 0.96,
  },
  "fire-server-direction": {
    impactCategory: "Correctness/Networking",
    impactText: "FireServer dari script server menandakan arah komunikasi event salah.",
    detectionConfidence: 0.9,
    patchConfidence: 0.85,
  },
};

const RULE_PACKS = {
  security: new Set([
    "trust-client-economy",
    "trust-client-damage",
    "trust-client-teleport",
    "trust-client-inventory",
    "trust-client-datastore",
    "datastore-without-pcall",
    "missing-rate-limit",
    "missing-remote-validation",
    "fire-server-direction",
  ]),
  performance: new Set([
    "missing-disconnect",
    "while-true-no-wait",
    "wait-vs-task-wait",
    "repeated-getservice",
    "frame-loop-heavy-risk",
  ]),
  style: new Set([
    "unsafe-findfirstchild-chain",
    "possible-nil-index",
    "possible-nil-character-access",
  ]),
};

function findLineNumbers(source, regex) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const lineNumbers = [];

  lines.forEach((line, index) => {
    regex.lastIndex = 0;
    if (regex.test(line)) {
      lineNumbers.push(index + 1);
    }
  });

  return lineNumbers;
}

function countMatches(text, regex) {
  const matches = text.match(regex);
  return matches ? matches.length : 0;
}

function stripInlineComment(line) {
  return line.replace(/--.*$/, "");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeDotChain(value) {
  return String(value || "")
    .replace(/\s*\.\s*/g, ".")
    .replace(/\s+/g, " ")
    .trim();
}

function toLooseDotPattern(value) {
  return escapeRegExp(normalizeDotChain(value)).replace(/\\\./g, "\\s*\\.\\s*");
}

function countLines(text) {
  if (!text) return 0;
  return String(text).split(/\r\n|\r|\n/).length;
}

function getPreviewChunks(text, chunkSize = 200) {
  const value = String(text || "");
  return {
    first: value.slice(0, chunkSize),
    last: value.slice(Math.max(0, value.length - chunkSize)),
  };
}

function escapePreview(text) {
  return String(text || "")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
}

function sanitizeParamName(raw) {
  if (!raw) return "";
  let value = raw.trim();
  value = value.replace(/^\.\.\./, "");
  value = value.split(":")[0].trim();
  value = value.replace(/\?$/, "");
  const match = value.match(/[A-Za-z_][A-Za-z0-9_]*/);
  return match ? match[0] : "";
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

function confidenceLabel(score) {
  if (score >= 0.85) return "High";
  if (score >= 0.6) return "Medium";
  return "Low";
}

function buildFinding({
  severity,
  line,
  rule,
  message,
  meta = {},
  evidence = "",
  detectionConfidence = null,
  patchConfidence = null,
}) {
  return {
    severity,
    line,
    rule,
    message,
    meta,
    evidence,
    detectionConfidence,
    patchConfidence,
  };
}

function enrichFinding(finding) {
  const profile = RULE_PROFILES[finding.rule] || {};
  const detectionConfidence = clamp01(
    Number.isFinite(finding.detectionConfidence)
      ? finding.detectionConfidence
      : profile.detectionConfidence ?? 0.65,
  );
  const patchConfidence = clamp01(
    Number.isFinite(finding.patchConfidence)
      ? finding.patchConfidence
      : profile.patchConfidence ?? 0.7,
  );

  return {
    ...finding,
    impactCategory: finding.impactCategory || profile.impactCategory || "Quality",
    impactText: finding.impactText || profile.impactText || "Perlu review manual untuk menilai dampak konkret.",
    detectionConfidence,
    detectionConfidenceLabel: confidenceLabel(detectionConfidence),
    patchConfidence,
    patchConfidenceLabel: confidenceLabel(patchConfidence),
  };
}

function summarizeFindings(findings) {
  if (findings.length === 0) {
    return "No high-risk pattern detected by current rules; continue manual review.";
  }

  const top = findings[0];
  const map = {
    "trust-client-economy": "Client-controlled amount used to modify currency sink (exploit risk).",
    "trust-client-damage": "Client-controlled damage reaches combat sink (exploit risk).",
    "trust-client-teleport": "Client-controlled movement reaches teleport/position sink.",
    "trust-client-inventory": "Client-controlled item/qty reaches inventory sink (dupe risk).",
    "trust-client-datastore": "Client-controlled value reaches DataStore write sink.",
    "datastore-without-pcall": "DataStore write detected without pcall guard.",
    "missing-rate-limit": "Sensitive remote event detected without clear rate limiting.",
    "missing-remote-validation": "Client argument validation is incomplete before sensitive use.",
    "possible-nil-character-access": "Direct Character/Humanoid access found without clear nil guard.",
    "frame-loop-heavy-risk": "Per-frame callback may run heavy work without clear gating.",
  };

  return map[top.rule] || `${top.rule} detected at line ${top.line}.`;
}

function getDepthInfo(lines) {
  let depth = 0;
  const depthBefore = [];
  const depthAfter = [];

  lines.forEach((line) => {
    const cleaned = stripInlineComment(line);
    depthBefore.push(depth);

    const openCount =
      countMatches(cleaned, /\bfunction\b/g) +
      countMatches(cleaned, /\bthen\b/g) +
      countMatches(cleaned, /\bdo\b/g) +
      countMatches(cleaned, /\brepeat\b/g);
    const closeCount = countMatches(cleaned, /\bend\b/g) + countMatches(cleaned, /\buntil\b/g);

    depth = Math.max(0, depth + openCount - closeCount);
    depthAfter.push(depth);
  });

  return { depthBefore, depthAfter };
}

function isDynamicConnectLine(line, depthBeforeLine) {
  if (!/:Connect\s*\(/.test(line)) {
    return false;
  }

  if (/\.On(Server|Client)Event\s*:\s*Connect\s*\(/.test(line)) {
    return false;
  }

  if (depthBeforeLine > 0) {
    return true;
  }

  return /\b(for|while|repeat)\b[\s\S]*:Connect\s*\(/.test(line);
}

function hasGuardBetween(lines, fromIndex, toIndex, varName) {
  const safeVar = escapeRegExp(varName);
  const guardPatterns = [
    new RegExp(`\\bif\\s+${safeVar}\\s+then\\b`),
    new RegExp(`\\bif\\s+not\\s+${safeVar}\\s+then\\b`),
    new RegExp(`\\bif\\s+${safeVar}\\s*~=\\s*nil\\s+then\\b`),
    new RegExp(`\\bif\\s+${safeVar}\\s*==\\s*nil\\s+then\\b`),
    new RegExp(`\\bassert\\s*\\(\\s*${safeVar}(\\s*[,\\)])`),
  ];

  for (let index = fromIndex; index <= toIndex; index += 1) {
    const line = stripInlineComment(lines[index]);
    if (guardPatterns.some((pattern) => pattern.test(line))) {
      return true;
    }
  }

  return false;
}

function findPossibleNilIndexFindings(lines) {
  const findings = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = stripInlineComment(lines[i]);
    const assignMatch = line.match(
      /^\s*(?:local\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*.*:FindFirstChild\(\s*["']?([^"')]+)?["']?\s*\)/,
    );

    if (!assignMatch) continue;

    const varName = assignMatch[1];
    const childName = assignMatch[2] || "UnknownChild";
    const varRegex = escapeRegExp(varName);
    const usagePattern = new RegExp(`\\b${varRegex}\\s*[\\.:\\[]`);
    const reassignmentPattern = new RegExp(`^\\s*(?:local\\s+)?${varRegex}\\s*=`);

    const maxScanLine = Math.min(lines.length - 1, i + 12);
    for (let j = i + 1; j <= maxScanLine; j += 1) {
      const lookAhead = stripInlineComment(lines[j]);
      if (reassignmentPattern.test(lookAhead)) break;
      if (!usagePattern.test(lookAhead)) continue;

      const inlineGuard = /^\s*if\b/.test(lookAhead) && new RegExp(`\\b${varRegex}\\b`).test(lookAhead);
      if (inlineGuard) continue;

      const guarded = hasGuardBetween(lines, i + 1, j - 1, varName);
      if (!guarded) {
        findings.push(
          buildFinding({
            severity: "high",
            line: j + 1,
            rule: "possible-nil-index",
            message: `${varName} bisa nil dari FindFirstChild, tetapi diakses langsung tanpa nil-check.`,
            evidence: lookAhead.trim(),
            meta: { varName, childName },
          }),
        );
      }
      break;
    }
  }

  return findings;
}

function hasCharacterGuardNearby(lines, lineIndex, rootExpr) {
  const rootPattern = toLooseDotPattern(rootExpr);
  const currentLine = stripInlineComment(lines[lineIndex] || "");

  const sameLineGuardPattern = new RegExp(
    `\\bif\\b[^\\n]*\\b${rootPattern}\\s*\\.\\s*Character\\b[^\\n]*\\band\\b[^\\n]*\\b${rootPattern}\\s*\\.\\s*Character\\s*\\.\\s*(?:Humanoid|HumanoidRootPart)\\b`,
  );
  if (sameLineGuardPattern.test(currentLine)) {
    return true;
  }

  const start = Math.max(0, lineIndex - 6);
  const guardPatterns = [
    new RegExp(`\\bif\\s+${rootPattern}\\s*\\.\\s*Character\\s+then\\b`),
    new RegExp(`\\bif\\s+not\\s+${rootPattern}\\s*\\.\\s*Character\\s+then\\b`),
    new RegExp(`\\bif\\s+${rootPattern}\\s*\\.\\s*Character\\s*~=\\s*nil\\s+then\\b`),
    new RegExp(
      `\\bif\\b[^\\n]*\\b${rootPattern}\\s*\\.\\s*Character\\b[^\\n]*\\band\\b[^\\n]*\\b${rootPattern}\\s*\\.\\s*Character\\s*\\.\\s*(?:Humanoid|HumanoidRootPart)\\b`,
    ),
    new RegExp(`\\b${rootPattern}\\s*\\.\\s*CharacterAdded\\s*:\\s*Wait\\s*\\(`),
    new RegExp(`\\b${rootPattern}\\s*\\.\\s*Character\\s+or\\s+${rootPattern}\\s*\\.\\s*CharacterAdded\\s*:\\s*Wait\\s*\\(`),
  ];

  for (let i = start; i <= lineIndex; i += 1) {
    const line = stripInlineComment(lines[i] || "");
    if (guardPatterns.some((pattern) => pattern.test(line))) {
      return true;
    }
  }

  return false;
}

function findPossibleNilCharacterAccessFindings(lines) {
  const findings = [];
  const directAccessPattern =
    /\b((?:[A-Za-z_][A-Za-z0-9_]*)(?:\s*\.\s*[A-Za-z_][A-Za-z0-9_]*){0,5})\s*\.\s*Character\s*\.\s*(HumanoidRootPart|Humanoid)\b/g;

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i] || "";
    const line = stripInlineComment(rawLine);
    directAccessPattern.lastIndex = 0;

    let match;
    while ((match = directAccessPattern.exec(line)) !== null) {
      const rootExpr = normalizeDotChain(match[1]);
      const partName = match[2];
      if (hasCharacterGuardNearby(lines, i, rootExpr)) {
        continue;
      }

      findings.push(
        buildFinding({
          severity: "high",
          line: i + 1,
          rule: "possible-nil-character-access",
          message: `Akses langsung \`${rootExpr}.Character.${partName}\` tanpa guard/Wait berisiko nil runtime error.`,
          evidence: line.trim(),
          meta: { rootExpr, partName },
        }),
      );
      break;
    }
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = stripInlineComment(lines[i] || "");
    const aliasMatch = line.match(
      /^\s*(?:local\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([A-Za-z_][A-Za-z0-9_]*(?:\s*\.\s*[A-Za-z_][A-Za-z0-9_]*){0,5})\s*\.\s*Character\b/,
    );
    if (!aliasMatch) continue;

    const aliasName = aliasMatch[1];
    const rootExpr = normalizeDotChain(aliasMatch[2]);
    if (/CharacterAdded\s*:\s*Wait\s*\(/.test(line)) continue;

    const safeAlias = escapeRegExp(aliasName);
    const aliasAccessPattern = new RegExp(`\\b${safeAlias}\\s*\\.\\s*(HumanoidRootPart|Humanoid)\\b`);
    const maxScan = Math.min(lines.length - 1, i + 14);

    for (let j = i + 1; j <= maxScan; j += 1) {
      const lookAhead = stripInlineComment(lines[j] || "");
      if (!aliasAccessPattern.test(lookAhead)) continue;

      const guarded = hasGuardBetween(lines, i + 1, j - 1, aliasName);
      if (guarded) break;

      findings.push(
        buildFinding({
          severity: "high",
          line: j + 1,
          rule: "possible-nil-character-access",
          message: `\`${aliasName}\` berasal dari \`${rootExpr}.Character\` dan dipakai sebagai ${aliasName}.Humanoid*/HRP tanpa nil-check.`,
          evidence: lookAhead.trim(),
          meta: { aliasName, rootExpr },
        }),
      );
      break;
    }
  }

  return findings;
}

function findRemoteHandlers(lines, depthBefore, depthAfter) {
  const handlers = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = stripInlineComment(lines[i]);
    if (!/\.OnServerEvent\s*:\s*(?:Connect|ConnectParallel)\s*\(/.test(line)) {
      continue;
    }

    let functionMatch = line.match(/function\s*\(([^)]*)\)/);
    if (!functionMatch) {
      for (let j = i + 1; j <= Math.min(lines.length - 1, i + 6); j += 1) {
        const nextLine = stripInlineComment(lines[j]);
        functionMatch = nextLine.match(/function\s*\(([^)]*)\)/);
        if (functionMatch) break;
      }
    }

    const rawParams = functionMatch
      ? functionMatch[1]
          .split(",")
          .map((item) => sanitizeParamName(item))
          .filter(Boolean)
      : [];

    const startDepth = depthBefore[i];
    let endIndex = i;
    for (let j = i; j < lines.length; j += 1) {
      if (j > i && depthAfter[j] === startDepth) {
        endIndex = j;
        break;
      }
      endIndex = j;
    }

    handlers.push({
      line: i + 1,
      endLine: endIndex + 1,
      params: rawParams,
      body: lines.slice(i, endIndex + 1).map((entry) => stripInlineComment(entry)).join("\n"),
      firstLine: lines[i]?.trim() || "OnServerEvent handler",
    });
  }

  return handlers;
}

function findEvidenceLine(body, patterns) {
  const bodyLines = body
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of bodyLines) {
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      if (pattern.test(line)) {
        return line;
      }
    }
  }

  return "";
}

function buildTaintedAliases(body, sourceVar, maxDepth = 2) {
  const tainted = new Set([sourceVar]);
  const lines = body.split("\n");
  let depth = 0;

  while (depth < maxDepth) {
    let changed = false;
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      const assignMatch = line.match(/^(?:local\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/);
      if (!assignMatch) continue;

      const lhs = assignMatch[1];
      const rhs = assignMatch[2];
      if (tainted.has(lhs)) continue;

      const rhsUsesTainted = [...tainted].some((name) => {
        const safe = escapeRegExp(name);
        return new RegExp(`\\b${safe}\\b`).test(rhs);
      });

      if (rhsUsesTainted) {
        tainted.add(lhs);
        changed = true;
      }
    }

    if (!changed) break;
    depth += 1;
  }

  return [...tainted];
}

function detectSinksForArg(body, argName) {
  const currency = "(?:cash|coin|coins|money|gold|gem|gems|currency|token|credit|point|points)";

  const taintedVars = buildTaintedAliases(body, argName, 2);

  const findings = [];
  taintedVars.forEach((taintedVar) => {
    const safeVar = escapeRegExp(taintedVar);
    const sinkDefs = [
      {
        rule: "trust-client-economy",
        severity: "critical",
        detectionConfidence: 0.95,
        patterns: [
          new RegExp(`${currency}[^\\n]*\\.Value\\s*(?:\\+=|=)\\s*[^\\n]*\\b${safeVar}\\b`, "i"),
          new RegExp(`\\.Value\\s*(?:\\+=|=)\\s*[^\\n]*\\b${safeVar}\\b[^\\n]*${currency}`, "i"),
          new RegExp(`\\.Value\\s*=\\s*[^\\n]*\\.Value\\s*[+\\-*/]\\s*\\b${safeVar}\\b`, "i"),
        ],
        message: (arg) =>
          `Argumen client \`${arg}\` dipakai langsung untuk update ekonomi (.Value). Server seharusnya menentukan nilai final.`,
      },
      {
        rule: "trust-client-damage",
        severity: "critical",
        detectionConfidence: 0.9,
        patterns: [
          new RegExp(`TakeDamage\\s*\\(\\s*${safeVar}\\b`, "i"),
          new RegExp(`\\bHealth\\b\\s*[+\\-*/]?=\\s*[^\\n]*\\b${safeVar}\\b`, "i"),
          new RegExp(`\\bDamage\\b[^\\n]*\\b${safeVar}\\b`, "i"),
        ],
        message: (arg) =>
          `Argumen client \`${arg}\` dipakai langsung untuk damage/health logic. Server harus hitung damage sendiri.`,
      },
      {
        rule: "trust-client-teleport",
        severity: "high",
        detectionConfidence: 0.86,
        patterns: [
          new RegExp(`PivotTo\\s*\\([^\\n]*\\b${safeVar}\\b`, "i"),
          new RegExp(`MoveTo\\s*\\([^\\n]*\\b${safeVar}\\b`, "i"),
          new RegExp(`SetPrimaryPartCFrame\\s*\\([^\\n]*\\b${safeVar}\\b`, "i"),
          new RegExp(`\\.(?:CFrame|Position|WalkSpeed|JumpPower|HipHeight)\\s*=\\s*[^\\n]*\\b${safeVar}\\b`, "i"),
          new RegExp(`CFrame\\.new\\s*\\([^\\n]*\\b${safeVar}\\b`, "i"),
        ],
        message: (arg) => `Argumen client \`${arg}\` memengaruhi movement/teleport sink. Batasi dengan validasi server-side.`,
      },
      {
        rule: "trust-client-inventory",
        severity: "critical",
        detectionConfidence: 0.87,
        patterns: [
          new RegExp(`(Inventory|Backpack|Item|Tool|Count|Quantity|Stack|GiveItem|AddItem|RemoveItem)[^\\n]*\\b${safeVar}\\b`, "i"),
          new RegExp(`\\b${safeVar}\\b[^\\n]*(Inventory|Backpack|Item|Tool|Count|Quantity|Stack|GiveItem|AddItem|RemoveItem)`, "i"),
        ],
        message: (arg) => `Argumen client \`${arg}\` dipakai di flow inventory/item. Cek anti-dupe dan validasi server-side.`,
      },
      {
        rule: "trust-client-datastore",
        severity: "high",
        detectionConfidence: 0.84,
        patterns: [
          new RegExp(`SetAsync\\s*\\([^\\n]*\\b${safeVar}\\b`, "i"),
          new RegExp(`UpdateAsync\\s*\\([^\\n]*\\b${safeVar}\\b`, "i"),
        ],
        message: (arg) => `Argumen client \`${arg}\` mengalir ke DataStore write sink. Validasi ketat sebelum persist data.`,
      },
    ];

    sinkDefs.forEach((def) => {
      const evidence = findEvidenceLine(body, def.patterns);
      if (!evidence) return;

      findings.push({
        rule: def.rule,
        severity: def.severity,
        message: def.message(argName),
        evidence,
        detectionConfidence: def.detectionConfidence,
        taintedVar,
      });
    });
  });

  return findings;
}

function analyzeRemoteHandlers(handlers) {
  const findings = [];

  handlers.forEach((handler) => {
    if (handler.params.length < 2) {
      return;
    }

    const clientArgs = handler.params.slice(1);
    const body = handler.body;

    const hasRateClock = /\b(os\.clock|tick|time)\s*\(/.test(body);
    const hasRateState = /\b(lastCall|last_call|cooldown|rateLimit|rate_limit|throttle|spam|bucket|tokens?)\b/i.test(body);
    const hasRateUserKey = /\bplayer\.UserId\b/.test(body);
    const hasRateReturn = /\bif\b[\s\S]{0,250}\breturn\b/.test(body) && /(cooldown|lastCall|rate|spam|bucket|token)/i.test(body);
    const hasRateLimit = (hasRateClock && hasRateState && hasRateReturn) || (hasRateClock && hasRateUserKey && hasRateState);

    clientArgs.forEach((argName) => {
      const safeArg = escapeRegExp(argName);
      const hasTypeCheck = new RegExp(`typeof\\s*\\(\\s*${safeArg}\\s*\\)`).test(body);
      const hasRangeCheck = new RegExp(`\\b${safeArg}\\b\\s*(<=|>=|<|>|==|~=)`).test(body);
      const hasSanitize = new RegExp(`\\b${safeArg}\\b\\s*=\\s*(math\\.floor|math\\.clamp|tonumber)\\s*\\(`).test(body);
      const hasFiniteGuard =
        new RegExp(`\\b${safeArg}\\b\\s*~=\\s*${safeArg}\\b`).test(body) ||
        /math\.huge/.test(body) ||
        /isfinite/i.test(body);

      const sinkHits = detectSinksForArg(body, argName);
      sinkHits.forEach((hit) => {
        findings.push(
          buildFinding({
            severity: hit.severity,
            line: handler.line,
            rule: hit.rule,
            message: hit.message,
            evidence: hit.evidence,
            meta: { argName, taintedVar: hit.taintedVar || argName },
            detectionConfidence: hit.detectionConfidence,
          }),
        );
      });

      if (sinkHits.length > 0 && !hasRateLimit) {
        findings.push(
          buildFinding({
            severity: "high",
            line: handler.line,
            rule: "missing-rate-limit",
            message: `OnServerEvent memakai \`${argName}\` untuk aksi sensitif tanpa rate limit/cooldown yang jelas.`,
            evidence: handler.firstLine,
            meta: { argName },
            detectionConfidence: 0.83,
          }),
        );
      }

      const validationComplete = hasTypeCheck && (hasRangeCheck || hasSanitize) && hasFiniteGuard;
      if (!validationComplete) {
        findings.push(
          buildFinding({
            severity: sinkHits.length > 0 ? "high" : "medium",
            line: handler.line,
            rule: "missing-remote-validation",
            message: `Validasi argumen client \`${argName}\` belum lengkap (type/range/NaN-infinite guard). Tambah validasi sebelum dipakai.`,
            evidence: `typeCheck=${hasTypeCheck}, rangeOrSanitize=${hasRangeCheck || hasSanitize}, finiteGuard=${hasFiniteGuard}`,
            meta: { argName },
            detectionConfidence: sinkHits.length > 0 ? 0.9 : 0.7,
          }),
        );
      }
    });
  });

  return findings;
}

function isDatastoreCallGuardedByPcall(lines, callIndex) {
  const start = Math.max(0, callIndex - 8);
  const end = Math.min(lines.length - 1, callIndex + 2);
  const snippet = lines.slice(start, end + 1).map((line) => stripInlineComment(line)).join("\n");

  if (/pcall\s*\(\s*function[\s\S]*?(SetAsync|UpdateAsync)\s*\(/i.test(snippet)) {
    return true;
  }

  if (/pcall\s*\(\s*[A-Za-z_][A-Za-z0-9_]*\s*\)/.test(snippet)) {
    return true;
  }

  return false;
}

function findDatastoreWithoutPcallFindings(lines) {
  const findings = [];
  const callPattern = /\b(SetAsync|UpdateAsync)\s*\(/;

  for (let i = 0; i < lines.length; i += 1) {
    const line = stripInlineComment(lines[i] || "");
    const match = line.match(callPattern);
    if (!match) continue;

    const guarded = isDatastoreCallGuardedByPcall(lines, i);
    if (guarded) continue;

    const method = match[1];
    findings.push(
      buildFinding({
        severity: "high",
        line: i + 1,
        rule: "datastore-without-pcall",
        message: `${method} terdeteksi tanpa pcall guard. Gunakan pcall untuk handle error/throttle DataStore.`,
        evidence: line.trim(),
        detectionConfidence: 0.9,
      }),
    );
  }

  return findings;
}

function findRemoteFallbackFindings(normalized, lines) {
  const findings = [];
  const handlerPattern =
    /\.OnServerEvent\s*:\s*(?:Connect|ConnectParallel)\s*\(\s*function\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*,\s*([A-Za-z_][A-Za-z0-9_]*)/gi;

  let match;
  while ((match = handlerPattern.exec(normalized)) !== null) {
    const argName = match[2];
    const safeArg = escapeRegExp(argName);
    const line = normalized.slice(0, match.index).split("\n").length;

    const economyPattern = new RegExp(
      `\\b(?:cash|coin|coins|money|gold|gem|gems|currency|token|credit|point|points)\\b[^\\n]{0,140}\\.Value\\s*(?:\\+=|=)\\s*[^\\n]*\\b${safeArg}\\b`,
      "i",
    );
    const economyPatternReverse = new RegExp(
      `\\.Value\\s*(?:\\+=|=)\\s*[^\\n]*\\b${safeArg}\\b[^\\n]*\\b(?:cash|coin|coins|money|gold|gem|gems|currency|token|credit|point|points)\\b`,
      "i",
    );
    const hasEconomySink = economyPattern.test(normalized) || economyPatternReverse.test(normalized);

    if (hasEconomySink) {
      findings.push(
        buildFinding({
          severity: "critical",
          line,
          rule: "trust-client-economy",
          message: `Fallback detect: argumen client \`${argName}\` dipakai untuk update ekonomi.`,
          evidence: lines[line - 1]?.trim() || "OnServerEvent handler",
          meta: { argName, source: "fallback-heuristic" },
          detectionConfidence: 0.84,
        }),
      );
    }

    const hasRateLimit =
      /\b(cooldown|rateLimit|rate_limit|throttle|bucket|tokens?|lastCall|last_call)\b/i.test(normalized) &&
      /\b(os\.clock|tick|time)\s*\(/.test(normalized);
    if ((hasEconomySink || new RegExp(`\\b${safeArg}\\b`).test(normalized)) && !hasRateLimit) {
      findings.push(
        buildFinding({
          severity: "high",
          line,
          rule: "missing-rate-limit",
          message: `Fallback detect: OnServerEvent dengan argumen \`${argName}\` belum menunjukkan rate-limit/cooldown.`,
          evidence: lines[line - 1]?.trim() || "OnServerEvent handler",
          meta: { argName, source: "fallback-heuristic" },
          detectionConfidence: 0.75,
        }),
      );
    }
  }

  return findings;
}

function collectSignals(normalized, strippedLines) {
  const hasLocalPlayer =
    /\bLocalPlayer\b/.test(normalized) ||
    /\bPlayers\s*\.\s*LocalPlayer\b/.test(normalized) ||
    /\bPlayers\s*:\s*GetPlayers\s*\(/.test(normalized);
  const hasRunService = /\bRunService\b/.test(normalized) || /game:GetService\(\s*["']RunService["']\s*\)/.test(normalized);
  const hasRenderSteppedConnect = /\bRenderStepped\s*:\s*Connect\s*\(/.test(normalized);
  const hasHeartbeatConnect = /\bHeartbeat\s*:\s*Connect\s*\(/.test(normalized);
  const hasSteppedConnect = /\bStepped\s*:\s*Connect\s*\(/.test(normalized);
  const hasFrameLoopConnect = hasRenderSteppedConnect || hasHeartbeatConnect || hasSteppedConnect;
  const hasCharacter = strippedLines.some((line) => /\bCharacter\b/.test(line));
  const hasHumanoid = strippedLines.some((line) => /\bHumanoid\b/.test(line));
  const hasHRP = strippedLines.some((line) => /\bHumanoidRootPart\b/.test(line));
  const hasFindFirstChild = strippedLines.some((line) => /:FindFirstChild\s*\(/.test(line));
  const hasWaitForChild = strippedLines.some((line) => /:WaitForChild\s*\(/.test(line));
  const hasOnServerEvent = strippedLines.some((line) => /\.OnServerEvent\s*:\s*(Connect|ConnectParallel)\s*\(/.test(line));
  const hasSetAsync = strippedLines.some((line) => /\b(SetAsync|UpdateAsync)\s*\(/.test(line));
  const hasValuePlusEq = strippedLines.some((line) => /\.Value\s*\+=/.test(line));
  const hasCharacterAccess = strippedLines.some((line) =>
    /\.Character\.(HumanoidRootPart|Humanoid)\b/.test(normalizeDotChain(line)),
  );

  return {
    hasLocalPlayer,
    hasRunService,
    hasRenderSteppedConnect,
    hasHeartbeatConnect,
    hasSteppedConnect,
    hasFrameLoopConnect,
    hasCharacter,
    hasHumanoid,
    hasHRP,
    hasFindFirstChild,
    hasWaitForChild,
    hasOnServerEvent,
    hasSetAsync,
    hasValuePlusEq,
    hasCharacterAccess,
  };
}

function findFrameLoopHandlers(lines, depthBefore, depthAfter) {
  const handlers = [];
  const framePattern = /\b(RenderStepped|Heartbeat|Stepped)\s*:\s*Connect\s*\(/;

  for (let i = 0; i < lines.length; i += 1) {
    const line = stripInlineComment(lines[i] || "");
    const eventMatch = line.match(framePattern);
    if (!eventMatch) continue;

    const startDepth = depthBefore[i];
    let endIndex = i;
    for (let j = i; j < lines.length; j += 1) {
      if (j > i && depthAfter[j] === startDepth) {
        endIndex = j;
        break;
      }
      endIndex = j;
    }

    const bodyLines = lines.slice(i, endIndex + 1).map((entry) => stripInlineComment(entry));
    handlers.push({
      event: eventMatch[1],
      line: i + 1,
      firstLine: (lines[i] || "").trim(),
      body: bodyLines.join("\n"),
      bodyLines,
    });
  }

  return handlers;
}

function analyzeFrameLoopHandlers(handlers) {
  const findings = [];
  const heavyPatterns = [
    /:FindFirstChild\s*\(/,
    /:WaitForChild\s*\(/,
    /GetChildren\s*\(/,
    /GetDescendants\s*\(/,
    /GetPartsInPart\s*\(/,
    /GetPartBoundsInBox\s*\(/,
    /Raycast\s*\(/,
    /for\s+\w+\s*,\s*\w+\s+in\s+pairs\s*\(/,
  ];

  handlers.forEach((handler) => {
    const body = handler.body;
    const hasGate = /\bif\b[^\n]{0,180}\bthen\b/.test(body) || /\bif\s+not\b[^\n]{0,120}\breturn\b/.test(body);
    const heavyLine = handler.bodyLines.find((line) => heavyPatterns.some((pattern) => pattern.test(line)));
    const hasHeavyWork = Boolean(heavyLine);

    if (!hasHeavyWork && hasGate) return;

    findings.push(
      buildFinding({
        severity: hasHeavyWork ? "medium" : "low",
        line: handler.line,
        rule: "frame-loop-heavy-risk",
        message: hasHeavyWork
          ? `${handler.event}:Connect berisi operasi berat per-frame. Cache object dan minimalkan kerja di callback.`
          : `${handler.event}:Connect tidak menunjukkan gating yang jelas. Tambahkan guard (mis. if not fly then return).`,
        evidence: heavyLine ? heavyLine.trim() : handler.firstLine,
      }),
    );
  });

  return findings;
}

function normalizeRuleId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
}

function parseIgnoreRulesFromText(text) {
  if (!text) return [];

  return text
    .split(/[,\s]+/)
    .map((item) => normalizeRuleId(item))
    .filter(Boolean);
}

function parseInlineIgnoreRules(lines) {
  const ignored = new Set();
  const inlinePattern = /--\s*lyva:ignore\s+([a-z0-9_\-,\s]+)/i;

  lines.forEach((line) => {
    const match = line.match(inlinePattern);
    if (!match) return;

    const parsed = parseIgnoreRulesFromText(match[1]);
    parsed.forEach((ruleId) => ignored.add(ruleId));
  });

  return ignored;
}

function collectIgnoredRules(options = {}, lines = []) {
  const fromOptions = new Set((options.ignoredRules || []).map((rule) => normalizeRuleId(rule)));
  const fromInline = parseInlineIgnoreRules(lines);
  fromInline.forEach((ruleId) => fromOptions.add(ruleId));
  return fromOptions;
}

function isRuleIncludedByPack(rule, selectedPack) {
  const pack = String(selectedPack || "all").toLowerCase();
  if (pack === "all") return true;

  const ruleSet = RULE_PACKS[pack];
  if (!ruleSet) return true;
  return ruleSet.has(rule);
}

function getActiveRules(selectedPack = "all", ignoredRules = []) {
  const ignoredSet = new Set((ignoredRules || []).map((rule) => normalizeRuleId(rule)));
  const allRules = Object.keys(RULE_PROFILES).map((rule) => normalizeRuleId(rule));
  return allRules.filter((rule) => isRuleIncludedByPack(rule, selectedPack) && !ignoredSet.has(rule));
}

function applyFindingFilters(findings, { selectedPack = "all", ignoredRules = new Set() } = {}) {
  return findings.filter((finding) => {
    const normalizedRule = normalizeRuleId(finding.rule);
    if (ignoredRules.has(normalizedRule)) return false;
    return isRuleIncludedByPack(normalizedRule, selectedPack);
  });
}

function dedupeFindings(findings) {
  const seen = new Set();
  return findings.filter((finding) => {
    const key = `${finding.rule}:${finding.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sortFindings(findings) {
  return [...findings].sort((a, b) => {
    const severityRank = { critical: 0, high: 1, medium: 2, low: 3 };
    if (severityRank[a.severity] !== severityRank[b.severity]) {
      return severityRank[a.severity] - severityRank[b.severity];
    }
    return a.line - b.line;
  });
}

function detectInputTruncationSignals(lines) {
  return lines.some((rawLine) => {
    const line = String(rawLine || "").trim();
    if (!line) return false;
    if (/^\.\.\.$/.test(line)) return true;
    if (/^\.\.\.\s*\[\s*truncated/i.test(line)) return true;
    if (/\[\s*truncated\s+\d+\s+lines?\s*\]/i.test(line)) return true;
    if (/^…+$/.test(line)) return true;

    if (/^--/.test(line)) return false;
    if (/"[^"]*\.\.\.[^"]*"/.test(line) || /'[^']*\.\.\.[^']*'/.test(line)) return false;

    return /\.\.\.\s*$/.test(line) && line.length > 10;
  });
}

function analyzeCode(source, fileName = "script.lua", options = {}) {
  const rawInput = String(options.rawSource ?? source ?? "");
  const normalized = String(source || "").replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const strippedLines = lines.map((line) => stripInlineComment(line));
  const selectedPack = String(options.pack || "all").toLowerCase();
  const ignoredRules = collectIgnoredRules(options, lines);

  const findings = [];
  const { depthBefore, depthAfter } = getDepthInfo(lines);
  const signals = collectSignals(normalized, strippedLines);
  const hasLoop = strippedLines.some((line) => /\b(while|for|repeat)\b/.test(line));
  const inputMayBeTruncated = detectInputTruncationSignals(lines);
  const inputStats = {
    rawChars: rawInput.length,
    rawLines: countLines(rawInput),
    analyzedChars: normalized.length,
    analyzedLines: normalized.length > 0 ? lines.length : 0,
    analysisTruncated: inputMayBeTruncated,
    rawFirst200: escapePreview(getPreviewChunks(rawInput, 200).first),
    rawLast200: escapePreview(getPreviewChunks(rawInput, 200).last),
    analyzedFirst200: escapePreview(getPreviewChunks(normalized, 200).first),
    analyzedLast200: escapePreview(getPreviewChunks(normalized, 200).last),
  };

  const waitLines = findLineNumbers(normalized, /(^|[^.\w])wait\s*\(/g);
  waitLines.forEach((line) => {
    findings.push(
      buildFinding({
        severity: "medium",
        line,
        rule: "wait-vs-task-wait",
        message: "Gunakan task.wait() daripada wait() untuk scheduling yang lebih konsisten.",
        evidence: lines[line - 1]?.trim() || "",
      }),
    );
  });

  const whileTrueRegex = /while\s+true\s+do([\s\S]*?)end/g;
  let whileMatch;
  while ((whileMatch = whileTrueRegex.exec(normalized)) !== null) {
    const block = whileMatch[1] || "";
    if (!/task\.wait\s*\(|wait\s*\(/.test(block)) {
      const line = normalized.slice(0, whileMatch.index).split("\n").length;
      findings.push(
        buildFinding({
          severity: "high",
          line,
          rule: "while-true-no-wait",
          message: "while true do tanpa wait berisiko freeze/stall thread.",
          evidence: lines[line - 1]?.trim() || "",
        }),
      );
    }
  }

  const connectLines = findLineNumbers(normalized, /:Connect\s*\(/g);
  const dynamicConnectLine = connectLines.find((lineNumber) => {
    const index = lineNumber - 1;
    return isDynamicConnectLine(lines[index], depthBefore[index]);
  });

  if (dynamicConnectLine && !/:Disconnect\s*\(/.test(normalized)) {
    findings.push(
      buildFinding({
        severity: "medium",
        line: dynamicConnectLine,
        rule: "missing-disconnect",
        message: "Connect terdeteksi di scope dinamis tanpa pola Disconnect. Cek potensi leak connection berulang.",
        evidence: lines[dynamicConnectLine - 1]?.trim() || "",
      }),
    );
  }

  const fireServerLines = findLineNumbers(normalized, /:FireServer\s*\(/g);
  const serverLikeName = /server|serverscriptservice|handler/i.test(fileName);
  if (fireServerLines.length > 0 && serverLikeName) {
    fireServerLines.forEach((line) => {
      findings.push(
        buildFinding({
          severity: "high",
          line,
          rule: "fire-server-direction",
          message: "Kemungkinan FireServer dipanggil dari script server. FireServer harus dari LocalScript/client.",
          evidence: lines[line - 1]?.trim() || "",
        }),
      );
    });
  }

  const getServiceMatches = [...normalized.matchAll(/game:GetService\(\s*["']([A-Za-z0-9_]+)["']\s*\)/g)];
  const getServiceCount = getServiceMatches.length;
  const serviceCounter = new Map();
  getServiceMatches.forEach((match) => {
    const service = match[1];
    serviceCounter.set(service, (serviceCounter.get(service) || 0) + 1);
  });

  for (const [service, count] of serviceCounter.entries()) {
    if (count >= 3) {
      const regex = new RegExp(`game:GetService\\(\\s*["']${service}["']\\s*\\)`, "g");
      const serviceLines = findLineNumbers(normalized, regex);
      findings.push(
        buildFinding({
          severity: "low",
          line: serviceLines[0] || 1,
          rule: "repeated-getservice",
          message: `GetService("${service}") dipanggil ${count}x. Pertimbangkan cache ke local variable.`,
          evidence: lines[(serviceLines[0] || 1) - 1]?.trim() || "",
        }),
      );
    }
  }

  const unsafeFindFirstChildLines = findLineNumbers(normalized, /FindFirstChild\([^)]*\)\s*[\.:\[]/g);
  unsafeFindFirstChildLines.forEach((line) => {
    findings.push(
      buildFinding({
        severity: "medium",
        line,
        rule: "unsafe-findfirstchild-chain",
        message: "FindFirstChild langsung di-chain. Tambah nil-check sebelum akses property/method.",
        evidence: lines[line - 1]?.trim() || "",
      }),
    );
  });

  findings.push(...findPossibleNilIndexFindings(lines));
  findings.push(...findPossibleNilCharacterAccessFindings(lines));
  findings.push(...findDatastoreWithoutPcallFindings(lines));

  const remoteHandlers = findRemoteHandlers(lines, depthBefore, depthAfter);
  findings.push(...analyzeRemoteHandlers(remoteHandlers));
  findings.push(...findRemoteFallbackFindings(normalized, lines));
  const frameLoopHandlers = findFrameLoopHandlers(lines, depthBefore, depthAfter);
  findings.push(...analyzeFrameLoopHandlers(frameLoopHandlers));
  if (
    signals.hasLocalPlayer &&
    signals.hasFrameLoopConnect &&
    !findings.some((finding) => finding.rule === "frame-loop-heavy-risk")
  ) {
    findings.push(
      buildFinding({
        severity: "low",
        line: frameLoopHandlers[0]?.line || 1,
        rule: "frame-loop-heavy-risk",
        message:
          "Frame loop client terdeteksi. Pastikan callback punya gating (if fly then), cache referensi, dan hindari operasi berat tiap frame.",
        evidence: frameLoopHandlers[0]?.firstLine || "RenderStepped/Heartbeat/Stepped connect",
      }),
    );
  }

  const hasOnServerEventPattern = /\.OnServerEvent\s*:\s*(?:Connect|ConnectParallel)\s*\(/.test(normalized);

  const deduped = dedupeFindings(findings).map(enrichFinding);
  const filtered = sortFindings(
    applyFindingFilters(deduped, {
      selectedPack,
      ignoredRules,
    }),
  );

  const facts = {
    hasAnyConnect: connectLines.length > 0,
    hasDynamicConnect: Boolean(dynamicConnectLine),
    hasFindFirstChild: signals.hasFindFirstChild,
    hasCharacterAccess: signals.hasCharacterAccess,
    hasLoop,
    hasOnServerEvent: remoteHandlers.length > 0 || hasOnServerEventPattern,
    hasWaitForChild: signals.hasWaitForChild,
    getServiceCount,
    selectedPack,
    ignoredRuleCount: ignoredRules.size,
    inputMayBeTruncated,
    signals,
    inputStats,
  };

  const signalHints = [];
  if (signals.hasFrameLoopConnect && signals.hasLocalPlayer && !signals.hasCharacter && !signals.hasHRP) {
    signalHints.push(
      "Fly-like frame loop terdeteksi (LocalPlayer + frame connect), tetapi token Character/HRP tidak ditemukan.",
    );
  }
  if (signals.hasCharacter && !signals.hasCharacterAccess) {
    signalHints.push("Token Character ada, tetapi chain Character.Humanoid/HRP literal tidak terlihat.");
  }

  const whyNoMatch = [];
  const actionableHints = [];
  if (inputMayBeTruncated) {
    actionableHints.push("Pastikan code lengkap (hindari `...`/truncated snippet).");
    actionableHints.push("Jika code panjang, upload file `.lua/.luau/.txt` agar tidak kepotong.");
  }
  if (signals.hasFrameLoopConnect && signals.hasLocalPlayer && !signals.hasCharacter && !signals.hasHRP) {
    actionableHints.push("Jika pakai alias (contoh `local char = player.Character`), pastikan assignment alias ikut disubmit.");
    actionableHints.push("Jalankan `/review debug` untuk verifikasi token `Character/HRP` benar-benar terbaca analyzer.");
  }

  if (filtered.length === 0) {
    if (inputMayBeTruncated) {
      whyNoMatch.push("Input terindikasi terpotong (truncated markers detected).");
    }
    if (signalHints.length > 0) {
      whyNoMatch.push(...signalHints);
    }
    if (selectedPack !== "all") {
      whyNoMatch.push(`Pack '${selectedPack}' mungkin memfilter rule yang relevan.`);
    }
  }

  return {
    facts,
    findings: filtered,
    meta: {
      selectedPack,
      ignoredRules: [...ignoredRules],
      inputMayBeTruncated,
      signals,
      inputStats,
      signalHints,
      whyNoMatch,
      actionableHints,
      rulesLoaded: Object.keys(RULE_PROFILES).length,
    },
  };
}

function collectFindings(source, fileName = "script.lua", options = {}) {
  return analyzeCode(source, fileName, options).findings;
}

function formatSignalScan(signals = {}) {
  const toMark = (value) => (value ? "true" : "false");
  return [
    "**Signal Scan**",
    `- hasLocalPlayer: ${toMark(signals.hasLocalPlayer)}`,
    `- hasRunService: ${toMark(signals.hasRunService)}`,
    `- hasRenderSteppedConnect: ${toMark(signals.hasRenderSteppedConnect)}`,
    `- hasHeartbeatConnect: ${toMark(signals.hasHeartbeatConnect)}`,
    `- hasSteppedConnect: ${toMark(signals.hasSteppedConnect)}`,
    `- hasOnServerEvent: ${toMark(signals.hasOnServerEvent)}`,
    `- hasSetAsync: ${toMark(signals.hasSetAsync)}`,
    `- hasValuePlusEq: ${toMark(signals.hasValuePlusEq)}`,
    `- hasCharacter: ${toMark(signals.hasCharacter)}`,
    `- hasHumanoid: ${toMark(signals.hasHumanoid)}`,
    `- hasHRP: ${toMark(signals.hasHRP)}`,
    `- hasFindFirstChild: ${toMark(signals.hasFindFirstChild)}`,
    `- hasWaitForChild: ${toMark(signals.hasWaitForChild)}`,
  ].join("\n");
}

function formatDebugReport(analysis) {
  const signals = analysis?.meta?.signals || analysis?.facts?.signals || {};
  const whyNoMatch = Array.isArray(analysis?.meta?.whyNoMatch) ? analysis.meta.whyNoMatch : [];
  const signalHints = Array.isArray(analysis?.meta?.signalHints) ? analysis.meta.signalHints : [];
  const actionableHints = Array.isArray(analysis?.meta?.actionableHints) ? analysis.meta.actionableHints : [];
  const stats = analysis?.meta?.inputStats || analysis?.facts?.inputStats || null;
  const rulesLoaded = Number.isFinite(analysis?.meta?.rulesLoaded) ? analysis.meta.rulesLoaded : Object.keys(RULE_PROFILES).length;
  const activePack = analysis?.meta?.selectedPack || "all";
  const ignoredRules = Array.isArray(analysis?.meta?.ignoredRules) ? analysis.meta.ignoredRules : [];
  const appliedRules = getActiveRules(activePack, ignoredRules);

  const lines = ["**Debug Mode (Rule Engine)**", formatSignalScan(signals)];
  if (stats) {
    lines.push("Input stats:");
    lines.push(
      `- rawChars=${stats.rawChars}, rawLines=${stats.rawLines}, analyzedChars=${stats.analyzedChars}, analyzedLines=${stats.analyzedLines}, analysisTruncated=${stats.analysisTruncated}`,
    );
    lines.push(`- rawFirst200: ${stats.rawFirst200}`);
    lines.push(`- rawLast200: ${stats.rawLast200}`);
    lines.push(`- analyzedFirst200: ${stats.analyzedFirst200}`);
    lines.push(`- analyzedLast200: ${stats.analyzedLast200}`);
  }
  lines.push(`Rules loaded: ${rulesLoaded}`);
  lines.push(`Pack: ${activePack}`);
  lines.push(`Ignored rules: ${ignoredRules.length > 0 ? ignoredRules.join(", ") : "-"}`);
  lines.push(`Applied rules (${appliedRules.length}): ${appliedRules.join(", ")}`);
  lines.push(`Findings count: ${analysis?.findings?.length || 0}`);
  if (signalHints.length > 0) {
    lines.push("Signal hints:");
    signalHints.forEach((hint) => lines.push(`- ${hint}`));
  }
  if (whyNoMatch.length > 0) {
    lines.push("Why no match:");
    whyNoMatch.forEach((reason) => lines.push(`- ${reason}`));
  }
  if (actionableHints.length > 0) {
    lines.push("Actionable hints:");
    actionableHints.forEach((hint) => lines.push(`- ${hint}`));
  }

  return lines.join("\n");
}

function formatFindings(findings, context = {}) {
  const pack = context.selectedPack || "all";
  const ignoredRules = Array.isArray(context.ignoredRules) ? context.ignoredRules : [];
  const inputMayBeTruncated = Boolean(context.inputMayBeTruncated);
  const signalHints = Array.isArray(context.signalHints) ? context.signalHints : [];
  const whyNoMatch = Array.isArray(context.whyNoMatch) ? context.whyNoMatch : [];
  const actionableHints = Array.isArray(context.actionableHints) ? context.actionableHints : [];

  if (findings.length === 0) {
    const info = [`Pack: ${pack}`];
    if (ignoredRules.length > 0) {
      info.push(`Ignored: ${ignoredRules.join(", ")}`);
    }
    if (inputMayBeTruncated) {
      info.push("Input: possible truncation detected");
    }
    return [
      "**Rule Check (Level 2)**",
      ...info,
      inputMayBeTruncated
        ? "Summary: Detection is inconclusive because input appears truncated. Submit full raw code/file for accurate analysis."
        : "Summary: No high-risk pattern detected by active rules; continue manual review.",
      ...(signalHints.length > 0 ? signalHints.map((hint) => `Hint: ${hint}`) : []),
      ...(whyNoMatch.length > 0 ? whyNoMatch.map((reason) => `Why-no-match: ${reason}`) : []),
      ...(actionableHints.length > 0 ? actionableHints.map((hint) => `Actionable-hint: ${hint}`) : []),
    ].join("\n");
  }

  const lines = ["**Rule Check (Level 2)**", `Pack: ${pack}`];
  if (ignoredRules.length > 0) {
    lines.push(`Ignored: ${ignoredRules.join(", ")}`);
  }
  if (inputMayBeTruncated) {
    lines.push("Input: possible truncation detected");
  }
  lines.push(`Summary: ${summarizeFindings(findings)}`);

  findings.forEach((finding, index) => {
    lines.push(`${index + 1}. [${finding.severity.toUpperCase()}] line ${finding.line} - ${finding.rule}`);
    lines.push(`   ${finding.message}`);
    lines.push(`   Impact: ${finding.impactCategory} - ${finding.impactText}`);
    lines.push(
      `   Detection confidence: ${finding.detectionConfidenceLabel} (${finding.detectionConfidence.toFixed(2)})`,
    );
    lines.push(`   Patch confidence: ${finding.patchConfidenceLabel} (${finding.patchConfidence.toFixed(2)})`);
    if (finding.evidence) {
      lines.push(`   Evidence: ${finding.evidence}`);
    }
    if (Number.isFinite(finding.historyCount) && finding.historyCount > 1) {
      lines.push(`   History: issue type ini sudah muncul ${finding.historyCount}x pada submission sebelumnya.`);
    }
  });

  return lines.join("\n");
}

module.exports = {
  analyzeCode,
  collectFindings,
  formatFindings,
  formatSignalScan,
  formatDebugReport,
};
