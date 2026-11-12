import { randomBytes } from 'node:crypto';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BYTES = 1024 * 1024;
const ID = /^[a-f0-9]{64}$/;

function cleanModels(models) {
  if (!Array.isArray(models) || !models.length || models.length > 5000) return null;
  const output = [];
  const seen = new Set();
  for (const model of models) {
    const id = typeof model?.id === 'string' ? model.id.trim() : '';
    if (!id || id.length > 256 || /[\0\r\n]/.test(id) || seen.has(id)) return null;
    seen.add(id);
    const label = typeof model.label === 'string' ? model.label.trim() : '';
    const effortLevels = Array.isArray(model.effortLevels)
      ? model.effortLevels.filter((v) => typeof v === 'string' && /^[a-z0-9_-]{1,32}$/.test(v)).slice(0, 32) : [];
    const defaultEffort = effortLevels.includes(model.defaultEffort) ? model.defaultEffort : '';
    const inputModalities = Array.isArray(model.inputModalities)
      ? model.inputModalities.filter((v) => typeof v === 'string' && /^[a-z0-9_-]{1,32}$/.test(v)).slice(0, 32) : [];
    output.push({ id, label: label && label.length <= 256 && !/[\0\r\n]/.test(label) ? label : id,
      effortLevels, defaultEffort, ...(inputModalities.length ? { inputModalities } : {}),
      ...(typeof model.supportsPersonality === 'boolean' ? { supportsPersonality: model.supportsPersonality } : {}),
      ...(model.isDefault === true ? { isDefault: true } : {}), catalogSource: 'upstream' });
  }
  return output;
}

function cachePath(configDir, key) {
  if (typeof configDir !== 'string' || !configDir || !ID.test(key || '')) return '';
  return join(configDir, 'model-catalog-cache', `${key}.json`);
}

/** Only account-bound, previously discovered metadata is persisted. */
export async function readPersistentCodexCatalog(configDir, key, now = Date.now()) {
  const path = cachePath(configDir, key);
  if (!path) return null;
  try {
    const file = await open(path, 'r');
    let content;
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > MAX_BYTES) return null;
      content = await file.readFile('utf8');
    } finally { await file.close(); }
    const parsed = JSON.parse(content);
    if (parsed?.version !== 1 || parsed.key !== key || !Number.isSafeInteger(parsed.at)
        || parsed.at > now || now - parsed.at > MAX_AGE_MS) return null;
    const models = cleanModels(parsed.models);
    return models ? { at: parsed.at, models } : null;
  } catch { return null; }
}

export async function writePersistentCodexCatalog(configDir, key, entry) {
  const path = cachePath(configDir, key);
  const models = cleanModels(entry?.models);
  if (!path || !Number.isSafeInteger(entry?.at) || !models) return false;
  const directory = join(configDir, 'model-catalog-cache');
  const temp = join(directory, `.${key}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
  try {
    const text = JSON.stringify({ version: 1, key, at: entry.at, models });
    if (Buffer.byteLength(text) > MAX_BYTES) return false;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = await open(temp, 'wx', 0o600);
    try { await file.writeFile(text, 'utf8'); } finally { await file.close(); }
    await rename(temp, path);
    return true;
  } catch { return false; }
  finally { await unlink(temp).catch(() => {}); }
}
