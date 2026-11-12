// Locate a legacy thread only inside the caller's already-authorized managed
// Codex home. Never accept a rollout pathname from the client or follow links.
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_HEADER_BYTES = 128 * 1024;

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
    const buffer = Buffer.alloc(MAX_HEADER_BYTES);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const newline = buffer.indexOf(10, 0);
    if (newline < 0 || newline >= bytesRead) return false;
    try {
      const item = JSON.parse(buffer.toString('utf8', 0, newline));
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
