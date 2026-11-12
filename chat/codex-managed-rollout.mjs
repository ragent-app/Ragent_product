// Locate a legacy thread only inside the caller's already-authorized managed
// Codex home. Never accept a rollout pathname from the client or follow links.
import { lstat, open, readFile, readdir, realpath } from 'node:fs/promises';
import { join, relative, isAbsolute, resolve } from 'node:path';

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Session metadata can contain long developer instructions. Bound the read,
// but allow normal multi-hundred-kilobyte headers from existing sessions.
const MAX_HEADER_BYTES = 4 * 1024 * 1024;

export function codexRolloutAccountId(auth) {
  const tokens = auth?.tokens || {};
  return ['account_id', 'accountId', 'account_uuid', 'accountUuid', 'user_id', 'userId']
    .map((key) => typeof tokens[key] === 'string' ? tokens[key].trim() : '').find(Boolean) || '';
}

async function entries(directory) {
  try {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return [];
    return await readdir(directory, { withFileTypes: true });
  }
  catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
}

async function matchesHeader(path, threadId) {
  const file = await open(path, 'r');
  try {
    const chunks = [];
    let size = 0;
    let newline = -1;
    while (size < MAX_HEADER_BYTES && newline < 0) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, MAX_HEADER_BYTES - size));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, size);
      if (!bytesRead) break;
      const part = buffer.subarray(0, bytesRead);
      newline = part.indexOf(10);
      chunks.push(newline < 0 ? part : part.subarray(0, newline));
      size += bytesRead;
    }
    if (newline < 0) return false;
    try {
      const item = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      return item?.type === 'session_meta' && String(item?.payload?.id || '').toLowerCase() === threadId;
    } catch { return false; }
  } finally { await file.close(); }
}

/** Returns one verified rollout or null; ambiguous matches fail closed. */
export async function findManagedCodexRollout(home, id) {
  const threadId = typeof id === 'string' ? id.trim().toLowerCase() : '';
  if (!THREAD_ID.test(threadId) || typeof home !== 'string' || !isAbsolute(home)) return null;
  let root;
  try {
    const stat = await lstat(home);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    root = await realpath(home);
  }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  const found = [];
  async function files(directory) {
    for (const entry of await entries(directory)) {
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.toLowerCase().endsWith(`-${threadId}.jsonl`)) continue;
      const file = join(directory, entry.name);
      const canonical = await realpath(file);
      const suffix = relative(root, canonical);
      if (!suffix || suffix === '..' || suffix.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(suffix)) continue;
      if (await matchesHeader(canonical, threadId)) found.push(canonical);
    }
  }
  await files(join(root, 'archived_sessions'));
  const sessions = join(root, 'sessions');
  for (const year of await entries(sessions)) {
    if (!year.isDirectory() || year.isSymbolicLink() || !/^\d{4}$/.test(year.name)) continue;
    const yearPath = join(sessions, year.name);
    for (const month of await entries(yearPath)) {
      if (!month.isDirectory() || month.isSymbolicLink() || !/^\d{2}$/.test(month.name)) continue;
      const monthPath = join(yearPath, month.name);
      for (const day of await entries(monthPath)) {
        if (day.isDirectory() && !day.isSymbolicLink() && /^\d{2}$/.test(day.name)) await files(join(monthPath, day.name));
      }
    }
  }
  if (found.length > 1) throw Object.assign(new Error('Multiple managed Codex rollouts match this thread'), { code: 'CODEX_ROLLOUT_AMBIGUOUS' });
  return found[0] || null;
}

// The roots must come from the account-home registry, never from a client.
// Recheck auth at lookup time: a provider home may have been relogged since it
// was recorded, in which case its history belongs to the newly selected owner.
export async function findAccountCodexRollout(homeRoots, accountId, threadId) {
  const expected = typeof accountId === 'string' ? accountId.trim() : '';
  if (!expected || !Array.isArray(homeRoots)) {
    throw Object.assign(new Error('Verified account rollout sources are required'), { code: 'CODEX_ROLLOUT_ACCOUNT_UNVERIFIED' });
  }
  const matches = new Set();
  for (const root of new Set(homeRoots)) {
    if (typeof root !== 'string' || !isAbsolute(root)) {
      throw Object.assign(new Error('Invalid account rollout source'), { code: 'CODEX_ROLLOUT_SOURCE_INVALID' });
    }
    const home = join(root, 'codex');
    const authPath = join(home, 'auth.json');
    let auth;
    try {
      const rootStat = await lstat(root);
      const homeStat = await lstat(home);
      const canonicalRoot = await realpath(root);
      const sameRoot = process.platform === 'win32'
        ? canonicalRoot.toLowerCase() === resolve(root).toLowerCase()
        : canonicalRoot === resolve(root);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !homeStat.isDirectory() || homeStat.isSymbolicLink() || !sameRoot) throw new Error('Invalid account home');
    } catch (error) {
      throw Object.assign(new Error('Could not verify an account rollout source'), { code: 'CODEX_ROLLOUT_SOURCE_INVALID', cause: error });
    }
    try {
      const stat = await lstat(authPath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid auth file');
      auth = JSON.parse(await readFile(authPath, 'utf8'));
    } catch (error) {
      throw Object.assign(new Error('Could not verify the account of a rollout source'), { code: 'CODEX_ROLLOUT_ACCOUNT_UNVERIFIED', cause: error });
    }
    const actual = codexRolloutAccountId(auth);
    if (!actual) throw Object.assign(new Error('Could not verify the account of a rollout source'), { code: 'CODEX_ROLLOUT_ACCOUNT_UNVERIFIED' });
    if (actual !== expected) throw Object.assign(new Error('A rollout source is now bound to another account'), { code: 'CODEX_ROLLOUT_ACCOUNT_MISMATCH' });
    const found = await findManagedCodexRollout(home, threadId);
    if (found) matches.add(found);
  }
  if (matches.size > 1) throw Object.assign(new Error('Multiple account rollouts match this thread'), { code: 'CODEX_ROLLOUT_AMBIGUOUS' });
  return matches.values().next().value || null;
}
