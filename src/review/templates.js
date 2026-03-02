const CHECKLIST_ITEMS = [
  {
    key: "naming",
    label: "Naming variable/fungsi jelas",
  },
  {
    key: "remote_validation",
    label: "RemoteEvent validasi input di server",
    failRules: [
      "missing-remote-validation",
      "fire-server-direction",
      "trust-client-economy",
      "trust-client-damage",
      "trust-client-teleport",
      "trust-client-inventory",
      "trust-client-datastore",
      "missing-rate-limit",
    ],
  },
  {
    key: "datastore_guard",
    label: "DataStore write dibungkus pcall",
    failRules: ["datastore-without-pcall", "trust-client-datastore"],
  },
  {
    key: "loop_wait",
    label: "Loop berat pakai task.wait()",
    failRules: ["while-true-no-wait", "wait-vs-task-wait"],
  },
  {
    key: "frame_loop_safety",
    label: "Frame-loop (RenderStepped/Heartbeat) punya gating dan minim kerja berat",
    failRules: ["frame-loop-heavy-risk"],
  },
  {
    key: "disconnect",
    label: "Event connection dibersihkan saat tidak dipakai",
    failRules: ["missing-disconnect"],
  },
  {
    key: "findfirstchild_nil",
    label: "Nil-check sebelum akses object yang bisa nil (Character/Humanoid/HRP/FindFirstChild)",
    failRules: ["possible-nil-index", "unsafe-findfirstchild-chain", "possible-nil-character-access"],
  },
  {
    key: "getservice",
    label: "Hindari repeated GetService di hot path",
    failRules: ["repeated-getservice"],
  },
];

function truncate(text, maxLength = 120) {
  if (!text) return "";
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}

function formatChecklistRow(status, label, note) {
  const mark = status === "pass" ? "[x]" : status === "fail" ? "[ ]" : status === "unknown" ? "[?]" : "[—]";
  return `- ${mark} ${label}${note ? ` (${note})` : ""}`;
}

function firstFindingByRules(findings, rules) {
  return findings.find((finding) => rules.includes(finding.rule));
}

function buildChecklistMessage(findings = [], facts = {}) {
  const rows = CHECKLIST_ITEMS.map((item) => {
    if (item.key === "naming") {
      return formatChecklistRow("na", item.label, "N/A - perlu human review");
    }

    if (item.key === "remote_validation") {
      if (!facts.hasOnServerEvent) {
        if (facts.inputMayBeTruncated) {
          return formatChecklistRow("unknown", item.label, "Unknown - input terindikasi terpotong");
        }
        return formatChecklistRow("na", item.label, "N/A - tidak ada OnServerEvent");
      }

      const finding = firstFindingByRules(findings, item.failRules);
      if (finding) {
        const evidence = truncate(finding.evidence || finding.message);
        return formatChecklistRow("fail", item.label, `FAIL - line ${finding.line}: ${finding.rule}; ${evidence}`);
      }

      return formatChecklistRow("pass", item.label, "PASS - validasi remote terdeteksi");
    }

    if (item.key === "loop_wait") {
      if (!facts.hasLoop) {
        if (facts.inputMayBeTruncated) {
          return formatChecklistRow("unknown", item.label, "Unknown - input terindikasi terpotong");
        }
        return formatChecklistRow("na", item.label, "N/A - tidak ada loop");
      }

      const finding = firstFindingByRules(findings, item.failRules);
      if (finding) {
        return formatChecklistRow("fail", item.label, `FAIL - line ${finding.line}: ${finding.rule}`);
      }

      return formatChecklistRow("pass", item.label, "PASS");
    }

    if (item.key === "datastore_guard") {
      const hasDataStoreCall = Boolean(facts.signals?.hasSetAsync);
      if (!hasDataStoreCall) {
        if (facts.inputMayBeTruncated) {
          return formatChecklistRow("unknown", item.label, "Unknown - input terindikasi terpotong");
        }
        return formatChecklistRow("na", item.label, "N/A - tidak ada SetAsync/UpdateAsync");
      }

      const finding = firstFindingByRules(findings, item.failRules);
      if (finding) {
        const evidence = truncate(finding.evidence || finding.message);
        return formatChecklistRow("fail", item.label, `FAIL - line ${finding.line}: ${finding.rule}; ${evidence}`);
      }

      return formatChecklistRow("pass", item.label, "PASS - DataStore write terjaga pcall");
    }

    if (item.key === "disconnect") {
      if (!facts.hasAnyConnect) {
        if (facts.inputMayBeTruncated) {
          return formatChecklistRow("unknown", item.label, "Unknown - input terindikasi terpotong");
        }
        return formatChecklistRow("na", item.label, "N/A - tidak ada connect");
      }

      if (!facts.hasDynamicConnect) {
        return formatChecklistRow("na", item.label, "N/A - tidak ada connect dinamis");
      }

      const finding = firstFindingByRules(findings, item.failRules);
      if (finding) {
        return formatChecklistRow("fail", item.label, `FAIL - line ${finding.line}: ${finding.rule}`);
      }

      return formatChecklistRow("pass", item.label, "PASS");
    }

    if (item.key === "frame_loop_safety") {
      const hasFrameLoop = Boolean(facts.signals?.hasFrameLoopConnect);
      if (!hasFrameLoop) {
        if (facts.inputMayBeTruncated) {
          return formatChecklistRow("unknown", item.label, "Unknown - input terindikasi terpotong");
        }
        return formatChecklistRow("na", item.label, "N/A - tidak ada frame-loop connect");
      }

      const finding = firstFindingByRules(findings, item.failRules);
      if (finding) {
        if (finding.severity === "low") {
          return formatChecklistRow("pass", item.label, `PASS - advisory line ${finding.line}: ${finding.rule}`);
        }
        const evidence = truncate(finding.evidence || finding.message);
        return formatChecklistRow("fail", item.label, `FAIL - line ${finding.line}: ${finding.rule}; ${evidence}`);
      }

      return formatChecklistRow("pass", item.label, "PASS");
    }

    if (item.key === "findfirstchild_nil") {
      if (!facts.hasFindFirstChild && !facts.hasCharacterAccess) {
        if (facts.inputMayBeTruncated) {
          return formatChecklistRow("unknown", item.label, "Unknown - input terindikasi terpotong");
        }
        return formatChecklistRow("na", item.label, "N/A - tidak ada FindFirstChild/Character access");
      }

      const finding = firstFindingByRules(findings, item.failRules);
      if (finding) {
        return formatChecklistRow("fail", item.label, `FAIL - line ${finding.line}: ${finding.rule}`);
      }

      return formatChecklistRow("pass", item.label, "PASS");
    }

    if (item.key === "getservice") {
      if (!Number.isFinite(facts.getServiceCount) || facts.getServiceCount < 3) {
        if (facts.inputMayBeTruncated) {
          return formatChecklistRow("unknown", item.label, "Unknown - input terindikasi terpotong");
        }
        return formatChecklistRow("na", item.label, "N/A - tidak berulang/hot path");
      }

      const finding = firstFindingByRules(findings, item.failRules);
      if (finding) {
        return formatChecklistRow("fail", item.label, `FAIL - line ${finding.line}: ${finding.rule}`);
      }

      return formatChecklistRow("pass", item.label, "PASS");
    }

    return formatChecklistRow("na", item.label, "N/A");
  });

  return ["**Checklist Review (Level 1)**", ...rows].join("\n");
}

function buildDraftFromFinding(finding) {
  const lineSuffix = ` (line ${finding.line})`;

  if (finding.rule === "trust-client-economy") {
    const argName = finding.meta?.argName || "amount";
    return {
      problem: `Client bisa mengontrol nilai ekonomi lewat argumen \`${argName}\`${lineSuffix}.`,
      suggestion:
        "Jangan percaya angka dari client. Validasi type/range/finite, tambah rate-limit, dan idealnya server hitung reward final.",
    };
  }

  if (finding.rule === "trust-client-damage") {
    return {
      problem: `Client mengontrol input damage dan mencapai sink combat${lineSuffix}.`,
      suggestion: "Hitung damage murni dari state server (weapon, jarak, cooldown, hit-confirm server).",
    };
  }

  if (finding.rule === "trust-client-teleport") {
    return {
      problem: `Client mengontrol movement/teleport sink${lineSuffix}.`,
      suggestion: "Whitelist destination di server dan validasi state sebelum teleport/movement update.",
    };
  }

  if (finding.rule === "trust-client-inventory") {
    return {
      problem: `Client mengontrol sink inventory/item${lineSuffix}.`,
      suggestion: "Validasi itemId/qty/ownership/stock sepenuhnya di server untuk cegah dupe.",
    };
  }

  if (finding.rule === "trust-client-datastore") {
    return {
      problem: `Client input mengalir ke DataStore write${lineSuffix}.`,
      suggestion: "Sanitasi dan derive data di server sebelum SetAsync/UpdateAsync.",
    };
  }

  if (finding.rule === "datastore-without-pcall") {
    return {
      problem: `DataStore write dipanggil tanpa pcall guard${lineSuffix}.`,
      suggestion: "Bungkus SetAsync/UpdateAsync dengan pcall dan log error agar flow tidak crash saat throttle.",
    };
  }

  if (finding.rule === "missing-rate-limit") {
    return {
      problem: `Remote sensitif belum punya rate-limit${lineSuffix}.`,
      suggestion: "Gunakan cooldown minimal atau token bucket per-user.",
    };
  }

  if (finding.rule === "possible-nil-index") {
    const varName = finding.meta?.varName || "value";
    return {
      problem: `${varName} berpotensi nil lalu diakses langsung${lineSuffix}.`,
      suggestion: "Tambahkan guard `if var then ... end` atau WaitForChild jika wajib ada.",
    };
  }

  if (finding.rule === "possible-nil-character-access") {
    return {
      problem: `Akses Character/Humanoid/HRP tanpa guard terdeteksi${lineSuffix}.`,
      suggestion:
        "Ambil Character dengan fallback `CharacterAdded:Wait()`, lalu cek Humanoid/HRP via FindFirstChild atau WaitForChild sebelum dipakai.",
    };
  }

  if (finding.rule === "frame-loop-heavy-risk") {
    return {
      problem: `Frame loop callback berpotensi berat/tanpa gating${lineSuffix}.`,
      suggestion:
        "Tambahkan guard cepat (mis. `if not flyEnabled then return end`) dan hindari FindFirstChild/GetChildren berulang di tiap frame.",
    };
  }

  return {
    problem: finding.message,
    suggestion: "Perbaiki sesuai warning lalu retest.",
  };
}

function buildSuggestedPatch(findings = []) {
  if (findings.length === 0) {
    return "-- Tidak ada patch otomatis. Lanjutkan human review.";
  }

  const top = findings[0];

  if (["trust-client-economy", "missing-remote-validation", "missing-rate-limit"].includes(top.rule)) {
    return [
      "local CONFIG = _G.GameConfig or {}",
      "local MAX_AMOUNT = CONFIG.MaxGiveMoneyPerCall or 100",
      "local TOKENS_PER_SECOND = CONFIG.TokensPerSecond or 2",
      "local BUCKET_SIZE = CONFIG.BucketSize or 5",
      "",
      "local buckets = {}",
      "local function allowRequest(userId, now)",
      "    local b = buckets[userId] or { tokens = BUCKET_SIZE, last = now }",
      "    local elapsed = now - b.last",
      "    b.tokens = math.min(BUCKET_SIZE, b.tokens + elapsed * TOKENS_PER_SECOND)",
      "    b.last = now",
      "    if b.tokens < 1 then",
      "        buckets[userId] = b",
      "        return false",
      "    end",
      "    b.tokens -= 1",
      "    buckets[userId] = b",
      "    return true",
      "end",
      "",
      "giveMoney.OnServerEvent:Connect(function(player, amount)",
      "    if typeof(amount) ~= \"number\" then return end",
      "    if amount ~= amount or amount == math.huge or amount == -math.huge then return end",
      "",
      "    amount = math.floor(amount)",
      "    if amount <= 0 or amount > MAX_AMOUNT then return end",
      "",
      "    if not allowRequest(player.UserId, os.clock()) then return end",
      "",
      "    local leaderstats = player:FindFirstChild(\"leaderstats\")",
      "    if not leaderstats then return end",
      "    local cash = leaderstats:FindFirstChild(\"Cash\")",
      "    if not cash or not cash:IsA(\"IntValue\") then return end",
      "",
      "    cash.Value += amount",
      "end)",
    ].join("\n");
  }

  if (top.rule === "trust-client-damage") {
    return [
      "damageRemote.OnServerEvent:Connect(function(player, targetId)",
      "    local target = Players:GetPlayerByUserId(targetId)",
      "    if not target or not target.Character then return end",
      "",
      "    if not canAttackServer(player, target) then return end",
      "    local damage = computeServerDamage(player, target)",
      "    local hum = target.Character:FindFirstChildOfClass(\"Humanoid\")",
      "    if not hum then return end",
      "    hum:TakeDamage(damage)",
      "end)",
    ].join("\n");
  }

  if (top.rule === "trust-client-teleport") {
    return [
      "teleportRemote.OnServerEvent:Connect(function(player, destinationId)",
      "    local destination = TeleportPoints:FindFirstChild(destinationId)",
      "    if not destination then return end",
      "    if not canTeleportServer(player, destination) then return end",
      "    if player.Character then",
      "        player.Character:PivotTo(destination.CFrame)",
      "    end",
      "end)",
    ].join("\n");
  }

  if (top.rule === "trust-client-inventory") {
    return [
      "inventoryRemote.OnServerEvent:Connect(function(player, itemId, qty)",
      "    if typeof(itemId) ~= \"string\" or typeof(qty) ~= \"number\" then return end",
      "    qty = math.floor(qty)",
      "    if qty <= 0 or qty > 10 then return end",
      "    if not canGrantItemServer(player, itemId, qty) then return end",
      "    grantItemServer(player, itemId, qty)",
      "end)",
    ].join("\n");
  }

  if (top.rule === "trust-client-datastore") {
    return [
      "saveRemote.OnServerEvent:Connect(function(player, payload)",
      "    local safePayload = sanitizePayloadServer(payload)",
      "    if not safePayload then return end",
      "    local ok, err = pcall(function()",
      "        DataStore:SetAsync(tostring(player.UserId), safePayload)",
      "    end)",
      "    if not ok then warn(\"SetAsync failed:\", err) end",
      "end)",
    ].join("\n");
  }

  if (top.rule === "datastore-without-pcall") {
    return [
      "local ok, err = pcall(function()",
      "    store:SetAsync(\"cash_\" .. tostring(player.UserId), cash.Value)",
      "end)",
      "if not ok then",
      "    warn(\"SetAsync failed:\", err)",
      "end",
    ].join("\n");
  }

  if (top.rule === "possible-nil-character-access") {
    return [
      "local function getCharacterSafe(player)",
      "    return player.Character or player.CharacterAdded:Wait()",
      "end",
      "",
      "local function getHRPSafe(player)",
      "    local char = getCharacterSafe(player)",
      "    if not char then return nil end",
      "    return char:FindFirstChild(\"HumanoidRootPart\")",
      "end",
      "",
      "RunService.RenderStepped:Connect(function()",
      "    if not flyEnabled then return end",
      "    local hrp = getHRPSafe(player)",
      "    if not hrp then return end",
      "    hrp.Velocity = Vector3.new(0, 50, 0)",
      "end)",
    ].join("\n");
  }

  if (top.rule === "frame-loop-heavy-risk") {
    return [
      "local cachedHRP = nil",
      "",
      "RunService.RenderStepped:Connect(function()",
      "    if not flyEnabled then return end",
      "    local char = player.Character or player.CharacterAdded:Wait()",
      "    if not cachedHRP or cachedHRP.Parent ~= char then",
      "        cachedHRP = char:FindFirstChild(\"HumanoidRootPart\")",
      "    end",
      "    if not cachedHRP then return end",
      "    cachedHRP.Velocity = Vector3.new(0, 50, 0)",
      "end)",
    ].join("\n");
  }

  return [
    `-- Suggested patch untuk rule: ${top.rule}`,
    "-- Terapkan validasi input, guard nil, dan rate-limit sesuai konteks.",
  ].join("\n");
}

function buildRemediationChecklist(findings = []) {
  const lines = ["**Remediation Checklist**"];
  const hasRemoteInputRisk = findings.some((finding) =>
    [
      "trust-client-economy",
      "trust-client-damage",
      "trust-client-teleport",
      "trust-client-inventory",
      "trust-client-datastore",
      "missing-rate-limit",
      "missing-remote-validation",
    ].includes(finding.rule),
  );

  if (hasRemoteInputRisk) {
    lines.push("- [ ] Test amount negatif");
    lines.push("- [ ] Test spam event (>=10x/detik)");
    lines.push("- [ ] Test NaN / +inf / -inf");
    lines.push("- [ ] Test player tanpa leaderstats/Cash");
  } else {
    lines.push("- [ ] Test script saat join awal (state object belum lengkap)");
    lines.push("- [ ] Test saat respawn/reset karakter");
  }

  if (findings.some((finding) => finding.rule === "trust-client-damage")) {
    lines.push("- [ ] Test damage exploit (nilai sangat besar / negatif)");
  }

  if (findings.some((finding) => finding.rule === "trust-client-teleport")) {
    lines.push("- [ ] Test teleport ke destination tidak valid");
  }

  if (findings.some((finding) => finding.rule === "trust-client-inventory")) {
    lines.push("- [ ] Test dupe item via spam quantity");
  }

  if (findings.some((finding) => finding.rule === "possible-nil-character-access")) {
    if (hasRemoteInputRisk) {
      lines.push("- [ ] Test saat join awal ketika Character belum spawn");
      lines.push("- [ ] Test saat respawn cepat (Character/HRP sempat nil)");
    }
  }

  if (findings.some((finding) => ["datastore-without-pcall", "trust-client-datastore"].includes(finding.rule))) {
    lines.push("- [ ] Simulasikan DataStore error/throttle dan pastikan script tidak crash");
    lines.push("- [ ] Verifikasi retry/logging berjalan saat SetAsync gagal");
  }

  if (findings.some((finding) => finding.rule === "frame-loop-heavy-risk")) {
    lines.push("- [ ] Test FPS drop saat fitur aktif >30 detik");
    lines.push("- [ ] Test callback tetap ringan saat karakter respawn");
  }

  return lines.join("\n");
}

function buildServerAuthoritativeSnippet(findings = []) {
  const hasEconomy = findings.some((finding) => finding.rule === "trust-client-economy");
  if (!hasEconomy) return "";

  return [
    "**Server-Authoritative Redesign (Opsional, Lebih Aman)**",
    "```lua",
    "-- Client: giveMoney:FireServer(\"ClaimDaily\")",
    "-- Server menentukan reward berdasarkan action, bukan angka dari client",
    "local rewards = { ClaimDaily = 50 }",
    "",
    "giveMoney.OnServerEvent:Connect(function(player, action)",
    "    if typeof(action) ~= \"string\" then return end",
    "    local amount = rewards[action]",
    "    if not amount then return end",
    "",
    "    -- validasi cooldown sepenuhnya di server",
    "    if not canClaimDailyServer(player) then return end",
    "",
    "    local leaderstats = player:FindFirstChild(\"leaderstats\")",
    "    if not leaderstats then return end",
    "    local cash = leaderstats:FindFirstChild(\"Cash\")",
    "    if not cash or not cash:IsA(\"IntValue\") then return end",
    "",
    "    cash.Value += amount",
    "end)",
    "```",
  ].join("\n");
}

function buildFeedbackTemplate(findings = []) {
  if (findings.length === 0) {
    return [
      "**Template Feedback**",
      "Masalah:",
      "Dampak:",
      "Saran:",
      "Contoh:",
    ].join("\n");
  }

  const severityRank = { critical: 0, high: 1, medium: 2, low: 3 };
  const rulePriority = {
    "trust-client-economy": 0,
    "trust-client-damage": 1,
    "trust-client-teleport": 2,
    "trust-client-inventory": 3,
    "trust-client-datastore": 4,
    "datastore-without-pcall": 5,
    "missing-rate-limit": 6,
    "missing-remote-validation": 7,
    "possible-nil-index": 8,
    "possible-nil-character-access": 9,
    "frame-loop-heavy-risk": 10,
  };

  const topFindings = [...findings]
    .sort((a, b) => {
      const severityDiff = (severityRank[a.severity] ?? 99) - (severityRank[b.severity] ?? 99);
      if (severityDiff !== 0) return severityDiff;

      const ruleDiff = (rulePriority[a.rule] ?? 99) - (rulePriority[b.rule] ?? 99);
      if (ruleDiff !== 0) return ruleDiff;

      return a.line - b.line;
    })
    .slice(0, 2);

  const lines = ["**Template Feedback (Auto Draft)**"];

  topFindings.forEach((finding, index) => {
    const draft = buildDraftFromFinding(finding);
    lines.push(`${index + 1}. Masalah: ${draft.problem}`);
    lines.push(`   Kategori Dampak: ${finding.impactCategory}`);
    lines.push(`   Dampak: ${finding.impactText}`);
    lines.push(
      `   Detection confidence: ${finding.detectionConfidenceLabel} (${finding.detectionConfidence.toFixed(2)})`,
    );
    lines.push(`   Patch confidence: ${finding.patchConfidenceLabel} (${finding.patchConfidence.toFixed(2)})`);
    lines.push(`   Saran: ${draft.suggestion}`);
    if (finding.evidence) {
      lines.push(`   Bukti: ${truncate(finding.evidence, 140)}`);
    }
  });

  lines.push("**Suggested Patch**");
  lines.push("```lua");
  lines.push(buildSuggestedPatch(topFindings));
  lines.push("```");

  const redesignSnippet = buildServerAuthoritativeSnippet(topFindings);
  if (redesignSnippet) {
    lines.push(redesignSnippet);
  }

  lines.push(buildRemediationChecklist(topFindings));

  lines.push("**Template Manual (opsional edit)**");
  lines.push("Masalah:");
  lines.push("Dampak:");
  lines.push("Saran:");
  lines.push("Contoh:");

  return lines.join("\n");
}

module.exports = {
  buildChecklistMessage,
  buildFeedbackTemplate,
};
