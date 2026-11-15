import { lstat, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

const expectedPrefixes = new Set([
  'ragent-approval-deadline-',
  'ragent-session-deadline-',
  'ragent-app-deadline-',
  'ragent-token-deadline-',
  'ragent-run-approval-deadline-',
]);

function samePath(left, right) {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export async function makeDeadlineTempRoot(prefix) {
  if (!expectedPrefixes.has(prefix)) throw new Error('Unexpected deadline fixture prefix');
  const parent = await realpath(tmpdir());
  const root = await mkdtemp(join(parent, prefix));
  const name = basename(root);
  if (!samePath(dirname(root), parent) || !name.startsWith(prefix) || name.includes(sep)) {
    throw new Error('Temporary deadline fixture root escaped its parent');
  }
  return {
    root,
    async cleanup() {
      const info = await lstat(root);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Deadline fixture root changed type');
      const canonical = await realpath(root);
      const rel = relative(parent, canonical);
      if (!samePath(canonical, root) || !samePath(dirname(canonical), parent)
        || rel !== name || !name.startsWith(prefix)) {
        throw new Error('Deadline fixture root changed identity');
      }
      await rm(root, { recursive: true, force: true });
    },
  };
}
