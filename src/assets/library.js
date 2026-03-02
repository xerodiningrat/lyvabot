const fs = require("fs/promises");
const path = require("path");

const ASSETS_DIR = path.join(process.cwd(), "assets", "free");
const ALLOWED_EXTENSIONS = new Set([".rbxm", ".rbxmx", ".lua", ".luau", ".txt"]);
const ASSET_DUPLICATE_POLICY = String(process.env.ASSET_DUPLICATE_POLICY || "replace").trim().toLowerCase();
const ASSET_DEDUPE_LOG_PATH = path.join(process.cwd(), "data", "asset-dedupe.log");

function normalizeName(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function sanitizeBaseName(value) {
  return String(value || "")
    .trim()
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function toDuplicateKey(baseName) {
  return sanitizeBaseName(baseName)
    .toLowerCase()
    .replace(/[-_]+/g, "");
}

function toAssetType(ext) {
  if (ext === ".rbxm" || ext === ".rbxmx") return "model";
  if (ext === ".lua" || ext === ".luau") return "script";
  return "text";
}

function formatBytes(bytes) {
  const n = Number(bytes || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

async function ensureAssetsDir() {
  await fs.mkdir(ASSETS_DIR, { recursive: true });
}

async function appendDedupeLog({ deletedFileName, oldSizeBytes = 0, newSourceName = "", policy = "replace" }) {
  const stamp = new Date().toISOString();
  const line = `[${stamp}] delete-duplicate policy=${policy} removed="${deletedFileName}" oldSize=${formatBytes(oldSizeBytes)} newSource="${newSourceName}"`;
  await fs.mkdir(path.dirname(ASSET_DEDUPE_LOG_PATH), { recursive: true });
  await fs.appendFile(ASSET_DEDUPE_LOG_PATH, `${line}\n`, "utf8");
}

function buildAssetRecord(fileName, stats) {
  const ext = path.extname(fileName).toLowerCase();
  const baseName = path.basename(fileName, ext);
  return {
    id: sanitizeBaseName(baseName).toLowerCase(),
    fileName,
    baseName,
    ext,
    type: toAssetType(ext),
    sizeBytes: Number(stats.size || 0),
    sizeLabel: formatBytes(stats.size || 0),
    updatedAt: stats.mtime,
    fullPath: path.join(ASSETS_DIR, fileName),
  };
}

async function listAssets() {
  await ensureAssetsDir();
  const entries = await fs.readdir(ASSETS_DIR, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => ALLOWED_EXTENSIONS.has(path.extname(name).toLowerCase()));

  const results = [];
  for (const fileName of files) {
    const fullPath = path.join(ASSETS_DIR, fileName);
    const stats = await fs.stat(fullPath);
    results.push(buildAssetRecord(fileName, stats));
  }

  return results.sort((a, b) => a.fileName.localeCompare(b.fileName));
}

function scoreAssetQuery(asset, query) {
  const q = normalizeName(query);
  if (!q) return 0;
  const file = normalizeName(asset.fileName);
  const base = normalizeName(asset.baseName);
  const id = normalizeName(asset.id);
  if (file === q || base === q || id === q) return 100;
  if (file.startsWith(q) || base.startsWith(q) || id.startsWith(q)) return 80;
  if (file.includes(q) || base.includes(q) || id.includes(q)) return 50;
  return 0;
}

async function resolveAssetByQuery(query) {
  const items = await listAssets();
  const scored = items
    .map((item) => ({ item, score: scoreAssetQuery(item, query) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.item.fileName.localeCompare(b.item.fileName));

  return {
    match: scored[0]?.item || null,
    suggestions: scored.slice(0, 8).map((entry) => entry.item),
    total: items.length,
  };
}

async function searchAssets(query, limit = 25) {
  const items = await listAssets();
  const q = normalizeName(query);
  const max = Math.max(1, Math.min(25, Number(limit) || 25));

  if (!q) {
    return items.slice(0, max);
  }

  return items
    .map((item) => ({ item, score: scoreAssetQuery(item, q) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.item.fileName.localeCompare(b.item.fileName))
    .slice(0, max)
    .map((entry) => entry.item);
}

function buildTargetFileName(sourceName, customName) {
  const sourceExt = path.extname(String(sourceName || "")).toLowerCase();
  const customRaw = String(customName || "").trim();
  const customExt = path.extname(customRaw).toLowerCase();
  const ext = customExt || sourceExt;

  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error("Format file tidak didukung. Gunakan .rbxm, .rbxmx, .lua, .luau, atau .txt.");
  }

  const base = sanitizeBaseName(customExt ? path.basename(customRaw, customExt) : customRaw);
  const sourceBase = sanitizeBaseName(path.basename(String(sourceName || "asset"), sourceExt));
  const finalBase = base || sourceBase || "asset";
  return `${finalBase}${ext}`;
}

async function getAvailableName(fileName) {
  const ext = path.extname(fileName);
  const base = path.basename(fileName, ext);
  let candidate = fileName;
  let counter = 1;

  while (true) {
    try {
      await fs.access(path.join(ASSETS_DIR, candidate));
      candidate = `${base}-${counter}${ext}`;
      counter += 1;
    } catch {
      return candidate;
    }
  }
}

async function saveAssetFromUrl({ url, sourceName, customName }) {
  if (!url) {
    throw new Error("URL file tidak valid.");
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error("Gagal download file asset dari attachment.");
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  return saveAssetBuffer({ sourceName, customName, buffer });
}

async function saveAssetBuffer({ sourceName, customName, buffer, duplicatePolicy = ASSET_DUPLICATE_POLICY }) {
  if (!buffer) {
    throw new Error("Buffer file tidak valid.");
  }

  await ensureAssetsDir();
  const desiredName = buildTargetFileName(sourceName, customName);
  let fileName = desiredName;
  const deletedExistingList = [];
  const policy = String(duplicatePolicy || "replace").toLowerCase();

  if (policy === "replace") {
    const desiredExt = path.extname(desiredName).toLowerCase();
    const desiredBase = path.basename(desiredName, desiredExt);
    const desiredKey = toDuplicateKey(desiredBase);

    const entries = await fs.readdir(ASSETS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const existingName = entry.name;
      const existingExt = path.extname(existingName).toLowerCase();
      if (existingExt !== desiredExt) continue;
      if (!ALLOWED_EXTENSIONS.has(existingExt)) continue;

      const existingBase = path.basename(existingName, existingExt);
      if (toDuplicateKey(existingBase) !== desiredKey) continue;

      const existingPath = path.join(ASSETS_DIR, existingName);
      try {
        const stats = await fs.stat(existingPath);
        await fs.unlink(existingPath);
        const deletedItem = {
          fileName: existingName,
          sizeBytes: Number(stats.size || 0),
          sizeLabel: formatBytes(stats.size || 0),
        };
        deletedExistingList.push(deletedItem);
        await appendDedupeLog({
          deletedFileName: existingName,
          oldSizeBytes: deletedItem.sizeBytes,
          newSourceName: sourceName,
          policy,
        });
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
      }
    }
  } else {
    fileName = await getAvailableName(desiredName);
  }

  const fullPath = path.join(ASSETS_DIR, fileName);
  await fs.writeFile(fullPath, buffer);
  const stats = await fs.stat(fullPath);
  const record = buildAssetRecord(fileName, stats);
  return {
    ...record,
    duplicatePolicyApplied: policy,
    deletedExisting: deletedExistingList[0] || null,
    deletedExistingList,
  };
}

module.exports = {
  ASSETS_DIR,
  ASSET_DEDUPE_LOG_PATH,
  ALLOWED_EXTENSIONS,
  listAssets,
  resolveAssetByQuery,
  searchAssets,
  saveAssetFromUrl,
  saveAssetBuffer,
};
