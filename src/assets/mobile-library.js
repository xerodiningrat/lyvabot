const fs = require("fs/promises");
const path = require("path");

const MOBILE_ASSET_DB = path.join(process.cwd(), "data", "mobile-assets.json");

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function sanitizeKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function normalizeAssetId(value) {
  const raw = String(value || "").trim();
  const digits = raw.replace(/[^\d]/g, "");
  if (!digits) {
    throw new Error("Asset ID harus angka.");
  }
  if (digits.length < 3 || digits.length > 20) {
    throw new Error("Asset ID tidak valid.");
  }
  return digits;
}

async function readDb() {
  try {
    const raw = await fs.readFile(MOBILE_ASSET_DB, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { items: [] };
    if (!Array.isArray(parsed.items)) return { items: [] };
    return { items: parsed.items };
  } catch {
    return { items: [] };
  }
}

async function writeDb(payload) {
  await fs.mkdir(path.dirname(MOBILE_ASSET_DB), { recursive: true });
  await fs.writeFile(MOBILE_ASSET_DB, JSON.stringify(payload, null, 2), "utf8");
}

function scoreQuery(item, query) {
  const q = normalizeText(query);
  if (!q) return 0;
  const key = normalizeText(item.key);
  const name = normalizeText(item.name);
  const id = normalizeText(item.id);
  if (key === q || name === q || id === q) return 100;
  if (key.startsWith(q) || name.startsWith(q) || id.startsWith(q)) return 80;
  if (key.includes(q) || name.includes(q) || id.includes(q)) return 50;
  return 0;
}

async function listMobileAssets() {
  const db = await readDb();
  return [...db.items].sort((a, b) => a.name.localeCompare(b.name));
}

async function addMobileAsset({ name, id, kind = "model", createdBy = "" }) {
  const cleanName = String(name || "").trim();
  if (!cleanName) {
    throw new Error("Nama asset wajib diisi.");
  }

  const cleanId = normalizeAssetId(id);
  const key = sanitizeKey(cleanName) || `asset-${cleanId}`;
  const db = await readDb();
  const now = new Date().toISOString();
  const idx = db.items.findIndex((item) => item.key === key || item.id === cleanId);

  const row = {
    key,
    name: cleanName,
    id: cleanId,
    kind: String(kind || "model").trim().toLowerCase(),
    createdAt: idx >= 0 ? db.items[idx].createdAt || now : now,
    updatedAt: now,
    createdBy: idx >= 0 ? db.items[idx].createdBy || createdBy : createdBy,
  };

  if (idx >= 0) {
    db.items[idx] = row;
  } else {
    db.items.push(row);
  }

  await writeDb(db);
  return row;
}

async function resolveMobileAsset(query) {
  const items = await listMobileAssets();
  const scored = items
    .map((item) => ({ item, score: scoreQuery(item, query) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name));

  return {
    match: scored[0]?.item || null,
    suggestions: scored.slice(0, 10).map((entry) => entry.item),
    total: items.length,
  };
}

async function searchMobileAssets(query, limit = 25) {
  const items = await listMobileAssets();
  const q = normalizeText(query);
  const max = Math.max(1, Math.min(25, Number(limit) || 25));
  if (!q) return items.slice(0, max);

  return items
    .map((item) => ({ item, score: scoreQuery(item, q) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name))
    .slice(0, max)
    .map((entry) => entry.item);
}

module.exports = {
  MOBILE_ASSET_DB,
  listMobileAssets,
  addMobileAsset,
  resolveMobileAsset,
  searchMobileAssets,
};
