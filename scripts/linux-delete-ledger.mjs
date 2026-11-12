/**
 * Standalone durable one-shot ledger prototype for Linux delete capabilities.
 * Not wired to production. The directory is chosen by trusted root setup, not
 * a request. Root and root-equivalent processes are trusted; records must not
 * be removed while any capability could be replayed.
 */
import { constants } from 'node:fs';
import { lstat, open, statfs } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { posix as path } from 'node:path';
import { assertLinuxRootControlledDirectory } from '../chat/linux-target-key-store.mjs';

// Initial implementation is restricted to the Linux ext-family filesystem
// magic. This does not prove that the backing storage is physically local or
// that its hardware honors flushes; deployment must verify those properties.
const EXT_SUPER_MAGIC = 0xef53n;

function validId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.:@-]{1,256}$/.test(value);
}

async function syncAncestors(directory) {
  let current = path.dirname(directory);
  for (;;) {
    const handle = await open(current, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await handle.sync(); } finally { await handle.close(); }
    if (current === '/') break;
    current = path.dirname(current);
  }
}

/**
 * The caller must first verify the signed owner capability. A successful
 * result means an exclusive marker and its directory have both been synced.
 * Any existing marker is consumed, even if its contents are incomplete.
 */
export async function claimLinuxDeleteNonce({ directory, nonce, capabilityId, runId, selectionHash } = {}) {
  const unavailable = { state: 'unavailable', code: 'LINUX_DELETE_LEDGER_UNAVAILABLE' };
  if (process.platform !== 'linux' || process.geteuid?.() !== 0 ||
      typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{24,128}$/.test(nonce) ||
      !validId(capabilityId) || !validId(runId) || !/^[a-f0-9]{64}$/.test(selectionHash || '')) return unavailable;
  let dir, file;
  try {
    await assertLinuxRootControlledDirectory(directory);
    const entry = await lstat(directory, { bigint: true });
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== 0n || entry.gid !== 0n ||
        (entry.mode & 0o7777n) !== 0o700n || (await statfs(directory, { bigint: true })).type !== EXT_SUPER_MAGIC) return unavailable;
    dir = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const opened = await dir.stat({ bigint: true });
    if (opened.dev !== entry.dev || opened.ino !== entry.ino || opened.uid !== 0n || opened.gid !== 0n ||
        (opened.mode & 0o7777n) !== 0o700n) return unavailable;
    const nonceDigest = createHash('sha256').update(nonce, 'utf8').digest('hex');
    const marker = path.join(directory, `${nonceDigest}.json`);
    try {
      file = await open(marker, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    } catch (error) {
      if (error.code === 'EEXIST') return { state: 'consumed', code: 'LINUX_DELETE_NONCE_CONSUMED' };
      throw error;
    }
    await file.chown(0, 0);
    await file.chmod(0o600);
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== 0 || stat.gid !== 0 || stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o600) return unavailable;
    await file.writeFile(`${JSON.stringify({ version: 1, nonceDigest, capabilityId, runId, selectionHash, at: new Date().toISOString() })}\n`, 'utf8');
    await file.sync();
    await file.close();
    file = null;
    await dir.sync();
    await syncAncestors(directory);
    await dir.close();
    dir = null;
    return { state: 'claimed' };
  } catch {
    // Do not remove a partially created marker. A caller must never execute
    // unless the durable claim above returned 'claimed'.
    return unavailable;
  } finally {
    if (file) await file.close().catch(() => {});
    if (dir) await dir.close().catch(() => {});
  }
}
