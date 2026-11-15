// Cross-process coordination for provider OAuth files.
//
// Codex rotates refresh tokens in auth.json. A provider-scoped lock must cover
// both preparation and the lifetime of the Codex process; a Promise queue would
// only protect one Node process and would not cover lifecycle/supervisor Runs.

import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const NATIVE_OAUTH_LOCK_VERSION = 1;
export const NATIVE_OAUTH_LOCK_FILE = '.ragent-native-oauth.lock';
export const NATIVE_OAUTH_LOCK_WAIT_MS = 120_000;
export const NATIVE_OAUTH_LOCK_POLL_MS = 100;
export const NATIVE_OAUTH_LOCK_STALE_FILE_MS = 30_000;

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeLockPath(value) {
  const path = trimString(value);
  if (!path || path.includes('\0') || /[\r\n]/.test(path)) return '';
  return path;
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is not inspectable by this user.
    return error?.code === 'EPERM';
  }
}

async function readLockOwner(lockPath) {
  try {
    const text = await readFile(lockPath, 'utf8');
    const owner = JSON.parse(text);
    if (!owner || owner.version !== NATIVE_OAUTH_LOCK_VERSION) return null;
    const token = trimString(owner.token);
    const pid = Number(owner.pid);
    if (!token || !Number.isInteger(pid) || pid <= 0) return null;
    return { ...owner, token, pid };
  } catch {
    return null;
  }
}

async function isReclaimableLock(lockPath, readOwnerImpl = readLockOwner) {
  const owner = await readOwnerImpl(lockPath);
  if (owner) return !isProcessAlive(owner.pid);
  try {
    const info = await stat(lockPath);
    return Date.now() - info.mtimeMs >= NATIVE_OAUTH_LOCK_STALE_FILE_MS;
  } catch {
    return false;
  }
}

async function reclaimLock(lockPath) {
  // Rename is atomic and prevents deleting a newly-created owner's lock file
  // in the small interval between an owner check and cleanup.
  const quarantinePath = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
  try {
    await rename(lockPath, quarantinePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  await unlink(quarantinePath).catch(() => {});
  return true;
}

async function writeLockOwner(lockPath, owner) {
  // The lock file is created with wx before this write. No other acquirer may
  // modify it while the owner PID remains alive, so a small direct write avoids
  // replacing the inode and keeps adoption working across Windows filesystems.
  await writeFile(lockPath, `${JSON.stringify(owner)}\n`, { mode: 0o660 });
}

function createLockHandle(lockPath, token) {
  let released = false;
  return {
    path: lockPath,
    token,
    async release() {
      if (released) return;
      released = true;
      const owner = await readLockOwner(lockPath);
      if (!owner || owner.token !== token) return;
      await unlink(lockPath).catch((error) => {
        if (error?.code !== 'ENOENT') throw error;
      });
    },
  };
}

export async function acquireNativeOAuthLock(lockPath, {
  mkdirImpl = mkdir,
  openImpl = open,
  readOwnerImpl = readLockOwner,
  reclaimImpl = reclaimLock,
  writeOwnerImpl = writeLockOwner,
  waitMs = NATIVE_OAUTH_LOCK_WAIT_MS,
  pollMs = NATIVE_OAUTH_LOCK_POLL_MS,
  nowImpl = Date.now,
  pid = process.pid,
  token = randomUUID(),
} = {}) {
  const normalizedPath = normalizeLockPath(lockPath);
  if (!normalizedPath) throw new Error('Native OAuth lock path is required');
  if (typeof mkdirImpl === 'function') {
    await mkdirImpl(dirname(normalizedPath), { recursive: true, mode: 0o770 });
  }
  const startedAt = nowImpl();
  const deadline = Number.isFinite(Number(waitMs)) && Number(waitMs) >= 0
    ? startedAt + Number(waitMs)
    : Number.POSITIVE_INFINITY;
  const owner = {
    version: NATIVE_OAUTH_LOCK_VERSION,
    token,
    pid,
    startedAt: new Date(startedAt).toISOString(),
  };

  while (true) {
    let handle = null;
    try {
      handle = await openImpl(normalizedPath, 'wx', 0o660);
      await handle.close();
      await writeOwnerImpl(normalizedPath, owner);
      return createLockHandle(normalizedPath, token);
    } catch (error) {
      await handle?.close().catch(() => {});
      if (error?.code !== 'EEXIST') throw error;
    }

    if (await isReclaimableLock(normalizedPath, readOwnerImpl)) {
      await reclaimImpl(normalizedPath).catch((error) => {
        if (error?.code !== 'ENOENT') throw error;
      });
      continue;
    }
    if (nowImpl() >= deadline) {
      const timeoutError = new Error('Timed out waiting for the native OAuth refresh lock');
      timeoutError.code = 'NATIVE_OAUTH_LOCK_TIMEOUT';
      throw timeoutError;
    }
    await sleep(Math.max(1, Number(pollMs) || NATIVE_OAUTH_LOCK_POLL_MS));
  }
}

export async function adoptNativeOAuthLock(lockPath, token, {
  readOwnerImpl = readLockOwner,
  writeOwnerImpl = writeLockOwner,
  pid = process.pid,
  nowImpl = Date.now,
} = {}) {
  const normalizedPath = normalizeLockPath(lockPath);
  const normalizedToken = trimString(token);
  if (!normalizedPath || !normalizedToken) {
    throw new Error('Native OAuth lock handoff is incomplete');
  }
  const owner = await readOwnerImpl(normalizedPath);
  if (!owner || owner.token !== normalizedToken) {
    const error = new Error('Native OAuth lock handoff is no longer valid');
    error.code = 'NATIVE_OAUTH_LOCK_HANDOFF_INVALID';
    throw error;
  }
  await writeOwnerImpl(normalizedPath, {
    ...owner,
    pid,
    adoptedAt: new Date(nowImpl()).toISOString(),
  });
  return createLockHandle(normalizedPath, normalizedToken);
}

export function nativeOAuthLockPath(providerHomeRoot) {
  const root = normalizeLockPath(providerHomeRoot);
  return root ? join(root, NATIVE_OAUTH_LOCK_FILE) : '';
}
