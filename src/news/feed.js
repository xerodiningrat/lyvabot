const fs = require("fs/promises");
const path = require("path");

const NEWS_FEED_PATH = path.join(process.cwd(), "data", "discord-news-feed.json");
const PREVIEW_DIR = path.join(process.cwd(), "assets", "previews");
const MAX_NEWS_ITEMS = Math.max(20, Number(process.env.DISCORD_NEWS_MAX_ITEMS || 120));
const ASSET_CHANNEL_IDS = parseIds(process.env.DISCORD_ASSET_CHANNEL_IDS || "");
const PROMO_CHANNEL_IDS = parseIds(process.env.DISCORD_PROMO_CHANNEL_IDS || "");
const TRACKED_CHANNEL_IDS = mergeIdSets(
  parseIds(process.env.DISCORD_NEWS_CHANNEL_IDS || ""),
  ASSET_CHANNEL_IDS,
  PROMO_CHANNEL_IDS,
);
const DEFAULT_TRACK_NAME_RE = /(asset|promo|promosi|berita|news|update)/i;

let writeQueue = Promise.resolve();

function parseIds(raw) {
  return new Set(
    String(raw || "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
  );
}

function mergeIdSets(...sets) {
  const merged = new Set();
  for (const set of sets) {
    for (const v of set) merged.add(v);
  }
  return merged;
}

function isImageLikeUrl(url) {
  const normalized = String(url || "").toLowerCase();
  return /\.(png|jpe?g|webp|gif)(\?|#|$)/i.test(normalized);
}

function toImageExt(contentType, fallbackUrl) {
  const ct = String(contentType || "").toLowerCase();
  if (ct.includes("image/png")) return ".png";
  if (ct.includes("image/jpeg") || ct.includes("image/jpg")) return ".jpg";
  if (ct.includes("image/webp")) return ".webp";
  if (ct.includes("image/gif")) return ".gif";
  const fromUrl = String(fallbackUrl || "").toLowerCase();
  if (fromUrl.includes(".png")) return ".png";
  if (fromUrl.includes(".jpg") || fromUrl.includes(".jpeg")) return ".jpg";
  if (fromUrl.includes(".webp")) return ".webp";
  if (fromUrl.includes(".gif")) return ".gif";
  return "";
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function readFeed() {
  try {
    const raw = await fs.readFile(NEWS_FEED_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const items = Array.isArray(parsed?.items) ? parsed.items : [];
    return { items };
  } catch {
    return { items: [] };
  }
}

async function writeFeedAtomic(payload) {
  await ensureDir(path.dirname(NEWS_FEED_PATH));
  const tmp = `${NEWS_FEED_PATH}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
  await fs.rename(tmp, NEWS_FEED_PATH);
}

function withLock(fn) {
  writeQueue = writeQueue.then(fn, fn);
  return writeQueue;
}

function normalizeText(text) {
  return String(text || "").replace(/\r/g, "").trim();
}

function shortLine(text, maxLen) {
  const cleaned = normalizeText(text).replace(/\s+/g, " ");
  if (cleaned.length <= maxLen) return cleaned;
  return `${cleaned.slice(0, maxLen).trim()}...`;
}

function pickPrimaryText(message) {
  const content = normalizeText(message?.content || "");
  if (content) return content;
  const embeds = Array.isArray(message?.embeds) ? message.embeds : [];
  for (const embed of embeds) {
    const title = normalizeText(embed?.title || "");
    const desc = normalizeText(embed?.description || "");
    if (title && desc) return `${title}\n${desc}`;
    if (title) return title;
    if (desc) return desc;
  }
  return "";
}

function pickImageCandidate(message) {
  if (!message) return "";
  const attachments = message.attachments ? [...message.attachments.values()] : [];
  for (const att of attachments) {
    const ct = String(att.contentType || "").toLowerCase();
    if (ct.startsWith("image/")) return String(att.url || att.proxyURL || "");
    const n = String(att.name || "").toLowerCase();
    if (/\.(png|jpe?g|webp|gif)$/.test(n)) return String(att.url || att.proxyURL || "");
  }

  const embeds = Array.isArray(message.embeds) ? message.embeds : [];
  for (const embed of embeds) {
    const imageUrl = String(embed?.image?.url || "");
    if (imageUrl) return imageUrl;
    const thumbUrl = String(embed?.thumbnail?.url || "");
    if (thumbUrl) return thumbUrl;
  }
  return "";
}

async function persistImageToPreview(imageUrl, messageId) {
  const url = String(imageUrl || "").trim();
  if (!url) return "";
  if (!/^https?:\/\//i.test(url)) return "";
  if (!isImageLikeUrl(url)) return "";

  try {
    const res = await fetch(url, {
      headers: {
        "user-agent": "LyvaNewsBot/1.0 (+https://lyvaindonesia.my.id)",
      },
    });
    if (!res.ok) return "";

    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > 8 * 1024 * 1024) return "";

    const ext = toImageExt(res.headers.get("content-type"), url);
    if (!ext) return "";

    await ensureDir(PREVIEW_DIR);
    const fileName = `news-${String(messageId || Date.now())}${ext}`;
    const absPath = path.join(PREVIEW_DIR, fileName);
    await fs.writeFile(absPath, buf);
    return fileName;
  } catch {
    return "";
  }
}

function channelLooksTracked(channel) {
  if (!channel) return false;

  const id = String(channel.id || "");
  const parentId = String(channel.parentId || channel.parent?.id || "");
  if (TRACKED_CHANNEL_IDS.size > 0) {
    return TRACKED_CHANNEL_IDS.has(id) || (parentId ? TRACKED_CHANNEL_IDS.has(parentId) : false);
  }

  const name = String(channel.name || "");
  if (DEFAULT_TRACK_NAME_RE.test(name)) return true;

  const parentName = String(channel.parent?.name || "");
  if (DEFAULT_TRACK_NAME_RE.test(parentName)) return true;

  return false;
}

function toSourceTag(channelName) {
  const name = String(channelName || "").toLowerCase();
  if (/(promo|promosi)/.test(name)) return "PROMO";
  if (/asset/.test(name)) return "ASSET";
  return "UPDATE";
}

function toSourceTagFromChannel(channel) {
  const id = String(channel?.id || "");
  const parentId = String(channel?.parentId || channel?.parent?.id || "");
  if (id && PROMO_CHANNEL_IDS.has(id)) return "PROMO";
  if (parentId && PROMO_CHANNEL_IDS.has(parentId)) return "PROMO";
  if (id && ASSET_CHANNEL_IDS.has(id)) return "ASSET";
  if (parentId && ASSET_CHANNEL_IDS.has(parentId)) return "ASSET";
  return toSourceTag(String(channel?.name || ""));
}

function toMessageUrl(message) {
  const guildId = String(message?.guildId || "");
  const channelId = String(message?.channelId || "");
  const messageId = String(message?.id || "");
  if (!guildId || !channelId || !messageId) return "";
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

async function upsertNewsEntry(message, { force = false } = {}) {
  if (!message || !message.id) return false;
  if (!force && !channelLooksTracked(message.channel)) return false;

  const primaryText = pickPrimaryText(message);
  const imageCandidate = pickImageCandidate(message);

  const channelName = String(message?.channel?.name || "");
  const sourceTag = toSourceTagFromChannel(message?.channel);
  const titleSeed = primaryText || imageCandidate || `Update ${sourceTag} dari ${channelName || "channel"}`;
  const title = shortLine(titleSeed.split("\n")[0], 74) || `Update ${sourceTag}`;
  const body = shortLine(primaryText, 380);
  const author =
    normalizeText(
      message?.member?.displayName ||
      message?.author?.globalName ||
      message?.author?.username ||
      "LYVA TEAM",
    ) || "LYVA TEAM";

  const imageFile = await persistImageToPreview(imageCandidate, message.id);

  const entry = {
    id: String(message.id),
    channelId: String(message.channelId || ""),
    channelName,
    guildId: String(message.guildId || ""),
    sourceTag,
    title,
    body,
    author,
    imageFile,
    imageUrlExternal: imageCandidate || "",
    messageUrl: toMessageUrl(message),
    createdAt: new Date(message.createdTimestamp || Date.now()).toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await withLock(async () => {
    const feed = await readFeed();
    const items = Array.isArray(feed.items) ? feed.items : [];
    const idx = items.findIndex((item) => String(item.id) === entry.id);
    if (idx >= 0) {
      const prev = items[idx];
      items[idx] = {
        ...prev,
        ...entry,
        imageFile: entry.imageFile || prev.imageFile || "",
      };
    } else {
      items.unshift(entry);
    }

    items.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    feed.items = items.slice(0, MAX_NEWS_ITEMS);
    await writeFeedAtomic(feed);
  });

  return true;
}

async function listNewsFeed(limit = 40) {
  const feed = await readFeed();
  const items = Array.isArray(feed.items) ? feed.items : [];
  return items.slice(0, Math.max(1, Number(limit) || 40));
}

async function ingestDiscordMessage(message) {
  return upsertNewsEntry(message);
}

async function backfillNewsFromClient(client, perChannelLimit = 20) {
  if (!client) return { scannedChannels: 0, upserts: 0 };
  let scannedChannels = 0;
  let upserts = 0;
  const limit = Math.max(5, Math.min(50, Number(perChannelLimit) || 20));

  for (const guild of client.guilds.cache.values()) {
    await guild.channels.fetch().catch(() => null);
    const channels = [...guild.channels.cache.values()];

    for (const channel of channels) {
      if (!channelLooksTracked(channel)) continue;
      if (typeof channel.isTextBased !== "function" || !channel.isTextBased()) continue;
      if (!channel.messages || typeof channel.messages.fetch !== "function") continue;

      scannedChannels += 1;
      const messages = await channel.messages.fetch({ limit }).catch(() => null);
      if (!messages) continue;

      for (const msg of messages.values()) {
        const ok = await upsertNewsEntry(msg, { force: true }).catch(() => false);
        if (ok) upserts += 1;
      }
    }
  }

  return { scannedChannels, upserts };
}

module.exports = {
  ingestDiscordMessage,
  backfillNewsFromClient,
  listNewsFeed,
  channelLooksTracked,
};
