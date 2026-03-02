const {
  SlashCommandBuilder,
  MessageFlags,
  PermissionFlagsBits,
  AttachmentBuilder,
} = require("discord.js");
const { listAssets, resolveAssetByQuery, searchAssets, saveAssetFromUrl } = require("../assets/library");
const {
  listMobileAssets,
  addMobileAsset,
  resolveMobileAsset,
  searchMobileAssets,
} = require("../assets/mobile-library");

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

function formatListMessage(items) {
  if (items.length === 0) {
    return "Belum ada free asset di library.\nAdmin bisa upload lewat `/asset upload`.";
  }

  const lines = ["**Daftar Free Asset Roblox**"];
  items.forEach((item, index) => {
    lines.push(
      `${index + 1}. \`${item.fileName}\` | type: ${item.type} | size: ${item.sizeLabel} | key: \`${item.id}\``,
    );
  });
  lines.push("");
  lines.push("Ambil file: `/asset get name:<key atau nama file>`");
  return lines.join("\n");
}

function formatMobileListMessage(items) {
  if (items.length === 0) {
    return "Belum ada free asset mobile (ID).\nAdmin bisa tambah lewat `/asset addid`.";
  }

  const lines = ["**Daftar Free Asset Mobile (ID)**"];
  items.forEach((item, index) => {
    lines.push(`${index + 1}. \`${item.name}\` | id: \`${item.id}\` | key: \`${item.key}\` | type: ${item.kind}`);
  });
  lines.push("");
  lines.push("Ambil ID: `/asset getid name:<nama/key/id>`");
  return lines.join("\n");
}

async function sendPublicResult(interaction, payload) {
  const channel = interaction.channel;
  if (channel && typeof channel.send === "function") {
    await channel.send(payload);
    return true;
  }
  return false;
}

function collectUploadAttachments(interaction) {
  const optionNames = ["file", "file2", "file3", "file4", "file5", "file6", "file7", "file8", "file9", "file10"];
  return optionNames
    .map((name) => interaction.options.getAttachment(name))
    .filter(Boolean);
}

function formatUploadSummary(success, failed, skipped = 0) {
  const lines = [];
  if (success.length > 0) {
    lines.push(`Upload berhasil: ${success.length} file.`);
    success.forEach((item, index) => {
      lines.push(`${index + 1}. \`${item.fileName}\` | ${item.type} | ${item.sizeLabel}`);
    });
  }
  if (failed.length > 0) {
    lines.push("");
    lines.push(`Upload gagal: ${failed.length} file.`);
    failed.forEach((item, index) => {
      lines.push(`${index + 1}. \`${item.name}\` - ${item.reason}`);
    });
  }
  if (skipped > 0) {
    lines.push("");
    lines.push(`Lewatkan ${skipped} file karena batas maksimal 10 file per proses.`);
  }
  lines.push("");
  lines.push("Gunakan `/asset list` untuk lihat semua asset.");
  return lines.join("\n");
}

async function runList(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const items = await listAssets();
  const sent = await sendPublicResult(interaction, {
    content: withPromo(formatListMessage(items)),
  });
  if (sent) {
    await interaction.editReply("List asset sudah dikirim ke channel.");
    return;
  }

  await interaction.editReply(withPromo(formatListMessage(items)));
}

async function runGet(interaction) {
  const query = interaction.options.getString("name", true);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const result = await resolveAssetByQuery(query);
  if (!result.match) {
    const suggest =
      result.suggestions.length > 0
        ? `\nSaran:\n- ${result.suggestions.map((item) => `\`${item.fileName}\``).join("\n- ")}`
        : "";
    const notFoundMessage = withPromo(
      `Asset tidak ditemukan untuk query: \`${query}\`. Total asset tersedia: ${result.total}.${suggest}`,
    );
    const sent = await sendPublicResult(interaction, { content: notFoundMessage });
    if (sent) {
      await interaction.editReply("Hasil pencarian sudah dikirim ke channel.");
      return;
    }
    await interaction.editReply(notFoundMessage);
    return;
  }

  const asset = result.match;
  const file = new AttachmentBuilder(asset.fullPath, { name: asset.fileName });
  const sent = await sendPublicResult(interaction, {
    content: withPromo(`Mengirim file: \`${asset.fileName}\` (${asset.sizeLabel})`),
    files: [file],
  });
  if (sent) {
    await interaction.editReply(`File \`${asset.fileName}\` sudah dikirim ke channel.`);
    return;
  }

  await interaction.editReply({
    content: withPromo(`Mengirim file: \`${asset.fileName}\` (${asset.sizeLabel})`),
    files: [file],
  });
}

async function runUpload(interaction) {
  const canUpload =
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ||
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
  if (!canUpload) {
    await interaction.reply({
      flags: MessageFlags.Ephemeral,
      content: "Hanya admin server (Administrator/Manage Server) yang bisa upload asset.",
    });
    return;
  }

  const files = collectUploadAttachments(interaction);
  const customName = interaction.options.getString("name");
  if (files.length === 0) {
    await interaction.reply({
      flags: MessageFlags.Ephemeral,
      content: "Minimal upload 1 file.",
    });
    return;
  }
  if (files.length > 1 && customName) {
    await interaction.reply({
      flags: MessageFlags.Ephemeral,
      content: "Field `name` hanya bisa dipakai saat upload 1 file. Untuk multi-upload, kosongkan `name`.",
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const success = [];
  const failed = [];

  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    try {
      const saved = await saveAssetFromUrl({
        url: file.url,
        sourceName: file.name || "asset",
        customName: files.length === 1 ? customName || "" : "",
      });
      success.push(saved);
    } catch (error) {
      failed.push({
        name: file.name || "unknown",
        reason: error?.message || "unknown error",
      });
    }
  }

  const uploadMessage = withPromo(formatUploadSummary(success, failed));
  const sent = await sendPublicResult(interaction, {
    content: uploadMessage,
  });
  if (sent) {
    await interaction.editReply(
      `Selesai upload. Berhasil: ${success.length}, gagal: ${failed.length}. Hasil sudah dikirim ke channel.`,
    );
    return;
  }

  await interaction.editReply(uploadMessage);
}

async function resolveSourceMessage(interaction, messageId = "") {
  const channel = interaction.channel;
  if (!channel || !channel.messages?.fetch) return null;

  const trimmed = String(messageId || "").trim();
  if (trimmed) {
    const byId = await channel.messages.fetch(trimmed).catch(() => null);
    return byId;
  }

  const recent = await channel.messages.fetch({ limit: 20 }).catch(() => null);
  if (!recent) return null;
  return recent.find((msg) => msg.author?.id === interaction.user.id && msg.attachments?.size > 0) || null;
}

async function runUploadMsg(interaction) {
  const canUpload =
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ||
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
  if (!canUpload) {
    await interaction.reply({
      flags: MessageFlags.Ephemeral,
      content: "Hanya admin server (Administrator/Manage Server) yang bisa upload asset.",
    });
    return;
  }

  const messageId = interaction.options.getString("message_id") || "";
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const sourceMessage = await resolveSourceMessage(interaction, messageId);
  if (!sourceMessage) {
    await interaction.editReply(
      "Pesan sumber tidak ditemukan. Kirim file dulu ke channel, lalu jalankan `/asset uploadmsg` (opsional isi `message_id`).",
    );
    return;
  }

  const allAttachments = [...sourceMessage.attachments.values()];
  if (allAttachments.length === 0) {
    await interaction.editReply("Pesan sumber tidak punya attachment file.");
    return;
  }

  const attachments = allAttachments.slice(0, 10);
  const skipped = Math.max(0, allAttachments.length - attachments.length);
  const success = [];
  const failed = [];

  for (const file of attachments) {
    try {
      const saved = await saveAssetFromUrl({
        url: file.url,
        sourceName: file.name || "asset",
        customName: "",
      });
      success.push(saved);
    } catch (error) {
      failed.push({
        name: file.name || "unknown",
        reason: error?.message || "unknown error",
      });
    }
  }

  const summary = withPromo(formatUploadSummary(success, failed, skipped));
  const sent = await sendPublicResult(interaction, { content: summary });
  if (sent) {
    await interaction.editReply(
      `Import dari pesan selesai. Berhasil: ${success.length}, gagal: ${failed.length}${skipped > 0 ? `, lewatkan: ${skipped}` : ""}.`,
    );
    return;
  }

  await interaction.editReply(summary);
}

async function runMobileList(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const items = await listMobileAssets();
  const sent = await sendPublicResult(interaction, {
    content: withPromo(formatMobileListMessage(items)),
  });
  if (sent) {
    await interaction.editReply("List asset mobile (ID) sudah dikirim ke channel.");
    return;
  }
  await interaction.editReply(withPromo(formatMobileListMessage(items)));
}

async function runMobileAdd(interaction) {
  const canUpload =
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ||
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
  if (!canUpload) {
    await interaction.reply({
      flags: MessageFlags.Ephemeral,
      content: "Hanya admin server (Administrator/Manage Server) yang bisa menambah asset ID.",
    });
    return;
  }

  const name = interaction.options.getString("name", true);
  const id = interaction.options.getString("id", true);
  const kind = interaction.options.getString("kind") || "model";

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const row = await addMobileAsset({
      name,
      id,
      kind,
      createdBy: interaction.user.id,
    });

    const msg = withPromo(
      `Asset mobile tersimpan.\nNama: \`${row.name}\`\nID: \`${row.id}\`\nKey: \`${row.key}\`\nType: ${row.kind}\nGunakan \`/asset getid name:${row.key}\` untuk ambil ID.`,
    );
    const sent = await sendPublicResult(interaction, { content: msg });
    if (sent) {
      await interaction.editReply(`Asset ID \`${row.name}\` berhasil ditambah dan diumumkan di channel.`);
      return;
    }
    await interaction.editReply(msg);
  } catch (error) {
    await interaction.editReply(`Gagal simpan asset ID: ${error.message || "unknown error"}`);
  }
}

async function runMobileGet(interaction) {
  const query = interaction.options.getString("name", true);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const result = await resolveMobileAsset(query);
  if (!result.match) {
    const suggest =
      result.suggestions.length > 0
        ? `\nSaran:\n- ${result.suggestions.map((item) => `\`${item.name}\` (\`${item.id}\`)`).join("\n- ")}`
        : "";
    const msg = withPromo(
      `Asset mobile tidak ditemukan untuk query: \`${query}\`. Total data: ${result.total}.${suggest}`,
    );
    const sent = await sendPublicResult(interaction, { content: msg });
    if (sent) {
      await interaction.editReply("Hasil pencarian asset mobile sudah dikirim ke channel.");
      return;
    }
    await interaction.editReply(msg);
    return;
  }

  const item = result.match;
  const msg = withPromo(
    [
      `**Asset Mobile Ditemukan**`,
      `Nama: \`${item.name}\``,
      `ID: \`${item.id}\``,
      `Type: ${item.kind}`,
      `Key: \`${item.key}\``,
      "",
      `Copy cepat: \`rbxassetid://${item.id}\``,
      `Link Roblox: https://www.roblox.com/library/${item.id}`,
    ].join("\n"),
  );

  const sent = await sendPublicResult(interaction, { content: msg });
  if (sent) {
    await interaction.editReply(`Asset mobile \`${item.name}\` sudah dikirim ke channel.`);
    return;
  }
  await interaction.editReply(msg);
}

const data = new SlashCommandBuilder()
  .setName("asset")
  .setDescription("Library free asset Roblox (.rbxm/.rbxmx/.lua/.luau/.txt)")
  .addSubcommand((sub) => sub.setName("list").setDescription("Lihat daftar free asset yang tersedia"))
  .addSubcommand((sub) =>
    sub
      .setName("get")
      .setDescription("Request dan kirim file asset")
      .addStringOption((opt) =>
        opt
          .setName("name")
          .setDescription("Key atau nama file asset dari `/asset list`")
          .setRequired(true)
          .setAutocomplete(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("upload")
      .setDescription("Upload free asset ke library (admin only)")
      .addAttachmentOption((opt) =>
        opt
          .setName("file")
          .setDescription("File 1 (.rbxm/.rbxmx/.lua/.luau/.txt)")
          .setRequired(true),
      )
      .addAttachmentOption((opt) =>
        opt
          .setName("file2")
          .setDescription("File 2 (opsional)")
          .setRequired(false),
      )
      .addAttachmentOption((opt) =>
        opt
          .setName("file3")
          .setDescription("File 3 (opsional)")
          .setRequired(false),
      )
      .addAttachmentOption((opt) =>
        opt
          .setName("file4")
          .setDescription("File 4 (opsional)")
          .setRequired(false),
      )
      .addAttachmentOption((opt) =>
        opt
          .setName("file5")
          .setDescription("File 5 (opsional)")
          .setRequired(false),
      )
      .addAttachmentOption((opt) =>
        opt
          .setName("file6")
          .setDescription("File 6 (opsional)")
          .setRequired(false),
      )
      .addAttachmentOption((opt) =>
        opt
          .setName("file7")
          .setDescription("File 7 (opsional)")
          .setRequired(false),
      )
      .addAttachmentOption((opt) =>
        opt
          .setName("file8")
          .setDescription("File 8 (opsional)")
          .setRequired(false),
      )
      .addAttachmentOption((opt) =>
        opt
          .setName("file9")
          .setDescription("File 9 (opsional)")
          .setRequired(false),
      )
      .addAttachmentOption((opt) =>
        opt
          .setName("file10")
          .setDescription("File 10 (opsional)")
          .setRequired(false),
      )
      .addStringOption((opt) =>
        opt
          .setName("name")
          .setDescription("Nama custom (hanya untuk upload 1 file)")
          .setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("uploadmsg")
      .setDescription("Import banyak file dari 1 pesan attachment (admin only)")
      .addStringOption((opt) =>
        opt
          .setName("message_id")
          .setDescription("ID pesan sumber (opsional, kosongkan untuk auto cari pesan terakhirmu)")
          .setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("addid")
      .setDescription("Tambah free asset mobile berbasis ID (admin only)")
      .addStringOption((opt) => opt.setName("name").setDescription("Nama asset").setRequired(true))
      .addStringOption((opt) => opt.setName("id").setDescription("Roblox Asset ID (angka)").setRequired(true))
      .addStringOption((opt) =>
        opt
          .setName("kind")
          .setDescription("Jenis asset")
          .setRequired(false)
          .addChoices(
            { name: "model", value: "model" },
            { name: "script", value: "script" },
            { name: "decal", value: "decal" },
            { name: "audio", value: "audio" },
            { name: "animation", value: "animation" },
            { name: "other", value: "other" },
          ),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName("listid").setDescription("Lihat daftar free asset mobile berbasis ID"),
  )
  .addSubcommand((sub) =>
    sub
      .setName("getid")
      .setDescription("Ambil info asset mobile (ID)")
      .addStringOption((opt) =>
        opt
          .setName("name")
          .setDescription("Nama/key/id asset mobile")
          .setRequired(true)
          .setAutocomplete(true),
      ),
  );

async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  if (sub === "list") {
    await runList(interaction);
    return;
  }
  if (sub === "get") {
    await runGet(interaction);
    return;
  }
  if (sub === "upload") {
    await runUpload(interaction);
    return;
  }
  if (sub === "uploadmsg") {
    await runUploadMsg(interaction);
    return;
  }
  if (sub === "addid") {
    await runMobileAdd(interaction);
    return;
  }
  if (sub === "listid") {
    await runMobileList(interaction);
    return;
  }
  if (sub === "getid") {
    await runMobileGet(interaction);
  }
}

async function autocomplete(interaction) {
  const sub = interaction.options.getSubcommand();
  const focused = interaction.options.getFocused(true);
  if (focused.name !== "name") {
    await interaction.respond([]);
    return;
  }

  const query = String(focused.value || "");
  let choices = [];
  if (sub === "get") {
    const items = await searchAssets(query, 25);
    choices = items.slice(0, 25).map((item) => {
      const labelBase = `${item.fileName} | ${item.type} | ${item.sizeLabel}`;
      const name = labelBase.length > 100 ? `${labelBase.slice(0, 97)}...` : labelBase;
      const value = item.id.length > 100 ? item.fileName : item.id;
      return { name, value };
    });
  } else if (sub === "getid") {
    const items = await searchMobileAssets(query, 25);
    choices = items.slice(0, 25).map((item) => {
      const labelBase = `${item.name} | id:${item.id} | ${item.kind}`;
      const name = labelBase.length > 100 ? `${labelBase.slice(0, 97)}...` : labelBase;
      const value = item.key.length > 100 ? item.id : item.key;
      return { name, value };
    });
  }

  await interaction.respond(choices);
}

module.exports = {
  data,
  execute,
  autocomplete,
};
