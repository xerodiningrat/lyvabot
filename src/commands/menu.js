const {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
} = require("discord.js");

const PROMO_TEXT_DEFAULT =
  "TOP UP TERMURAH ALL GAME DAN ENTERTEMENRT DAN CHAT GPT PREMIUN BISA KUNJUNGI https://lyvaindonesia.com";
const PROMO_URL_DEFAULT = "https://lyvaindonesia.com";

const PANEL_CUSTOM_IDS = {
  REVIEW: "menu:review",
  ASSET_FILE: "menu:asset-file",
  ASSET_MOBILE: "menu:asset-mobile",
  QUICK_TEST: "menu:quick-test",
};

const data = new SlashCommandBuilder()
  .setName("menu")
  .setDescription("Tampilkan panel tombol untuk cek semua fitur bot");

function getPromoText() {
  const value = String(process.env.MENU_PROMO_TEXT || "").trim();
  return value || PROMO_TEXT_DEFAULT;
}

function getPromoUrl() {
  const value = String(process.env.MENU_PROMO_URL || "").trim();
  return value || PROMO_URL_DEFAULT;
}

function buildPanel() {
  const promoText = getPromoText();
  const promoUrl = getPromoUrl();

  const embed = new EmbedBuilder()
    .setTitle("LYVA Control Center")
    .setDescription(
      [
        "Panel cepat untuk akses semua fitur utama bot.",
        "",
        "Pilih menu di bawah untuk mulai.",
      ].join("\n"),
    )
    .addFields(
      {
        name: "Review Roblox",
        value: "`/review paste` | `/review ai` | `/review debug`",
        inline: false,
      },
      {
        name: "Free Asset",
        value: "`/asset list` | `/asset get` | `/asset upload`",
        inline: false,
      },
      {
        name: "Mobile Asset ID",
        value: "`/asset listid` | `/asset getid` | `/asset addid`",
        inline: false,
      },
      {
        name: "Promo",
        value: promoText,
        inline: false,
      },
    )
    .setColor(0x0ea5e9)
    .setFooter({ text: "LYVA INDONESIA • Modern Roblox Utility Bot" });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(PANEL_CUSTOM_IDS.REVIEW)
      .setLabel("Review")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(PANEL_CUSTOM_IDS.ASSET_FILE)
      .setLabel("Asset File")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(PANEL_CUSTOM_IDS.ASSET_MOBILE)
      .setLabel("Asset ID")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(PANEL_CUSTOM_IDS.QUICK_TEST)
      .setLabel("Tes Cepat")
      .setStyle(ButtonStyle.Danger),
  );

  const promoRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Kunjungi LyvaIndonesia.com").setURL(promoUrl),
  );

  return { embeds: [embed], components: [row, promoRow] };
}

async function execute(interaction) {
  await interaction.reply(buildPanel());
}

function getButtonContent(customId) {
  const promoText = getPromoText();

  if (customId === PANEL_CUSTOM_IDS.REVIEW) {
    return [
      "**Review Commands**",
      "- `/review paste` -> review rule-based Level 1 + 2",
      "- `/review ai` -> review AI Level 3",
      "- `/review debug` -> debug analyzer (admin)",
      "",
      promoText,
    ].join("\n");
  }

  if (customId === PANEL_CUSTOM_IDS.ASSET_FILE) {
    return [
      "**Asset File Commands**",
      "- `/asset upload` -> upload file asset (admin)",
      "- `/asset list` -> lihat daftar file asset",
      "- `/asset get` -> ambil file (bisa autocomplete)",
      "",
      promoText,
    ].join("\n");
  }

  if (customId === PANEL_CUSTOM_IDS.ASSET_MOBILE) {
    return [
      "**Asset ID Mobile Commands**",
      "- `/asset addid` -> simpan nama + id asset (admin)",
      "- `/asset listid` -> lihat daftar asset ID mobile",
      "- `/asset getid` -> ambil id asset mobile (autocomplete)",
      "",
      promoText,
    ].join("\n");
  }

  if (customId === PANEL_CUSTOM_IDS.QUICK_TEST) {
    return [
      "**Quick Test**",
      "1. Jalankan `/asset list`",
      "2. Jalankan `/asset listid`",
      "3. Jalankan `/review paste` dengan script test",
      "4. Jalankan `/review ai` untuk cek mode AI",
      "",
      promoText,
    ].join("\n");
  }

  return "";
}

async function handleButton(interaction) {
  if (!interaction.isButton()) return false;
  if (!String(interaction.customId || "").startsWith("menu:")) return false;

  const content = getButtonContent(interaction.customId);
  if (!content) {
    await interaction.reply({
      flags: MessageFlags.Ephemeral,
      content: "Tombol tidak dikenali.",
    });
    return true;
  }

  await interaction.reply({
    flags: MessageFlags.Ephemeral,
    content,
  });
  return true;
}

module.exports = {
  data,
  execute,
  handleButton,
};
