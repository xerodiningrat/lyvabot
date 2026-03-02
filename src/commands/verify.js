const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  MessageFlags,
  ChannelType,
} = require("discord.js");

const VERIFY_BUTTON_PREFIX = "verify:grant:";
const DEFAULT_EMBED_TITLE = "Verifikasi Member";
const DEFAULT_EMBED_DESCRIPTION = "Klik tombol di bawah untuk verifikasi dan dapat akses server.";

function resolveRoleId(interaction) {
  const optionRole = interaction.options.getRole("role");
  if (optionRole) return optionRole.id;
  const envRole = String(process.env.VERIFY_DEFAULT_ROLE_ID || "").trim();
  return envRole || "";
}

function buildVerifyPanel(roleId, title, description) {
  const embed = new EmbedBuilder()
    .setTitle(title || DEFAULT_EMBED_TITLE)
    .setDescription(description || DEFAULT_EMBED_DESCRIPTION)
    .setColor(0x22c55e);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${VERIFY_BUTTON_PREFIX}${roleId}`)
      .setLabel("Verify")
      .setStyle(ButtonStyle.Success),
  );

  return { embeds: [embed], components: [row] };
}

async function getGuildMember(interaction) {
  if (!interaction.guild) return null;
  if (interaction.member && typeof interaction.member.roles?.add === "function") {
    return interaction.member;
  }
  return interaction.guild.members.fetch(interaction.user.id).catch(() => null);
}

const data = new SlashCommandBuilder()
  .setName("verify")
  .setDescription("Sistem verifikasi user dengan tombol role")
  .addSubcommand((sub) =>
    sub
      .setName("panel")
      .setDescription("Kirim panel verifikasi ke channel")
      .addRoleOption((opt) =>
        opt.setName("role").setDescription("Role yang diberikan saat user klik Verify").setRequired(false),
      )
      .addChannelOption((opt) =>
        opt
          .setName("channel")
          .setDescription("Channel target panel")
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(false),
      )
      .addStringOption((opt) =>
        opt.setName("title").setDescription("Judul panel verifikasi").setRequired(false),
      )
      .addStringOption((opt) =>
        opt.setName("description").setDescription("Deskripsi panel verifikasi").setRequired(false),
      ),
  )
  .addSubcommand((sub) => sub.setName("status").setDescription("Cek status verifikasi kamu"));

async function runPanel(interaction) {
  const canManage =
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ||
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
  if (!canManage) {
    await interaction.reply({
      flags: MessageFlags.Ephemeral,
      content: "Hanya admin server yang bisa membuat panel verifikasi.",
    });
    return;
  }

  const roleId = resolveRoleId(interaction);
  if (!roleId) {
    await interaction.reply({
      flags: MessageFlags.Ephemeral,
      content: "Role verifikasi belum di-set. Isi opsi `role` atau set `VERIFY_DEFAULT_ROLE_ID` di env.",
    });
    return;
  }

  const targetChannel = interaction.options.getChannel("channel") || interaction.channel;
  if (!targetChannel || typeof targetChannel.send !== "function") {
    await interaction.reply({
      flags: MessageFlags.Ephemeral,
      content: "Channel target tidak valid.",
    });
    return;
  }

  const title = interaction.options.getString("title") || DEFAULT_EMBED_TITLE;
  const description = interaction.options.getString("description") || DEFAULT_EMBED_DESCRIPTION;
  await targetChannel.send(buildVerifyPanel(roleId, title, description));

  await interaction.reply({
    flags: MessageFlags.Ephemeral,
    content: `Panel verifikasi berhasil dikirim ke <#${targetChannel.id}> untuk role <@&${roleId}>.`,
  });
}

async function runStatus(interaction) {
  const roleId = String(process.env.VERIFY_DEFAULT_ROLE_ID || "").trim();
  if (!roleId) {
    await interaction.reply({
      flags: MessageFlags.Ephemeral,
      content: "Status belum tersedia karena `VERIFY_DEFAULT_ROLE_ID` belum di-set.",
    });
    return;
  }

  const member = await getGuildMember(interaction);
  const isVerified = Boolean(member?.roles?.cache?.has(roleId));
  await interaction.reply({
    flags: MessageFlags.Ephemeral,
    content: isVerified ? "Status: kamu sudah terverifikasi." : "Status: kamu belum terverifikasi.",
  });
}

async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  if (sub === "panel") {
    await runPanel(interaction);
    return;
  }
  if (sub === "status") {
    await runStatus(interaction);
  }
}

async function handleButton(interaction) {
  if (!interaction.isButton()) return false;
  const customId = String(interaction.customId || "");
  if (!customId.startsWith(VERIFY_BUTTON_PREFIX)) return false;

  const roleId = customId.slice(VERIFY_BUTTON_PREFIX.length).trim();
  if (!roleId) {
    await interaction.reply({
      flags: MessageFlags.Ephemeral,
      content: "Role verifikasi tidak valid.",
    });
    return true;
  }

  if (!interaction.guild) {
    await interaction.reply({
      flags: MessageFlags.Ephemeral,
      content: "Tombol ini hanya bisa dipakai di server.",
    });
    return true;
  }

  const member = await getGuildMember(interaction);
  if (!member || !member.roles || !member.roles.add) {
    await interaction.reply({
      flags: MessageFlags.Ephemeral,
      content: "Gagal membaca data member.",
    });
    return true;
  }

  if (member.roles.cache.has(roleId)) {
    await interaction.reply({
      flags: MessageFlags.Ephemeral,
      content: "Kamu sudah terverifikasi.",
    });
    return true;
  }

  try {
    await member.roles.add(roleId, "User clicked verify button");
    await interaction.reply({
      flags: MessageFlags.Ephemeral,
      content: "Verifikasi berhasil. Role sudah ditambahkan.",
    });
  } catch (error) {
    await interaction.reply({
      flags: MessageFlags.Ephemeral,
      content:
        "Gagal menambahkan role. Cek permission `Manage Roles` dan pastikan role bot lebih tinggi dari role verifikasi.",
    });
  }

  return true;
}

module.exports = {
  data,
  execute,
  handleButton,
};
