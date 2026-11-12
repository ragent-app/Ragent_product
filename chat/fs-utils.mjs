import { constants } from 'fs';
import { access, lstat, mkdir, open, readFile, rm, stat, writeFile } from 'fs/promises';
import { dirname, resolve } from 'path';
import { renameWithWindowsRetry } from '../lib/windows-file-replace.mjs';

export async function pathExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(path) {
  await mkdir(path, { recursive: true });
}

export async function statOrNull(path) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

export async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

// Read JSON without collapsing corruption into a caller-provided fallback.
// Session read paths use this variant so a broken metadata/event file cannot
// masquerade as an empty conversation. The legacy readJson helper remains
// intentionally permissive for best-effort maintenance and migration jobs.
export async function readJsonStrict(path) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw Object.assign(new Error(`JSON file not found: ${path}`), {
        code: 'JSON_NOT_FOUND',
        path,
        cause: error,
      });
    }
    throw Object.assign(new Error(`JSON file could not be read: ${path}`), {
      code: 'JSON_READ_FAILED',
      path,
      cause: error,
    });
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw Object.assign(new Error(`JSON file is malformed: ${path}`), {
      code: 'JSON_MALFORMED',
      path,
      cause: error,
    });
  }
}

// Two concurrent writes to the same target in the same process and
// millisecond would previously share a tmp file name (`${path}.tmp-${pid}-${Date.now()}`);
// the first rename succeeds, the second fails with ENOENT and silently drops
// the write. A per-process sequence guarantees a unique tmp name per call.
let atomicWriteSeq = 0;
const runAtomicReplace = createKeyedTaskQueue();

function replaceAtomically(tempPath, path, signal, beforeReplace) {
  const key = process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
  // Windows may reject simultaneous replacements of the same destination.
  // Shared by JSON/text writers; independent destinations remain concurrent.
  return runAtomicReplace(key, () => renameWithWindowsRetry(tempPath, path, { signal, beforeAttempt: beforeReplace }));
}

function atomicTempPath(path) {
  return `${path}.tmp-${process.pid}-${Date.now()}-${atomicWriteSeq++}`;
}

export async function writeJsonAtomic(path, value, { mode, spaces = 2, durable = false, signal, beforeReplace, preserveOwner = false, prepareHandle } = {}) {
  await ensureDir(dirname(path));
  const tempPath = atomicTempPath(path);
  const data = JSON.stringify(value, null, spaces);
  // A root lifecycle broker can update a Run owned by the unprivileged
  // control service. Atomic rename otherwise replaces its 0600 file with a
  // root-owned one, making the Run invisible to the control plane.
  let owner = null;
  if (preserveOwner && process.platform !== 'win32' && process.getuid?.() === 0) {
    owner = await lstat(path);
    if (!owner.isFile()) throw new Error('Cannot preserve ownership of a non-regular file');
  }
  if (durable || owner || prepareHandle) {
    let handle;
    let ownsTemp = false;
    try {
      handle = await open(tempPath, 'wx', mode ?? 0o600);
      ownsTemp = true;
      await handle.writeFile(data, 'utf8');
      if (owner) await handle.chown(owner.uid, owner.gid);
      if (prepareHandle) await prepareHandle(handle);
      if (durable) await handle.sync();
      await handle.close();
      handle = null;
      await replaceAtomically(tempPath, path, signal, beforeReplace);
      ownsTemp = false;
    } finally {
      if (handle) await handle.close().catch(() => {});
      if (ownsTemp) await rm(tempPath, { force: true }).catch(() => {});
    }
    // The file is synced before atomic replacement. Directory-entry survival
    // across power loss is a separate platform guarantee, not claimed here.
    return;
  }
  // NOTE: the {mode} option must be passed as the single options object (3-arg
  // form); writeFile(path, data, 'utf8', {mode}) silently ignores mode.
  await writeFile(tempPath, data, mode ? { encoding: 'utf8', mode } : 'utf8');
  try { await replaceAtomically(tempPath, path, signal, beforeReplace); }
  catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function writeTextAtomic(path, value, { mode, durable = false, signal, prepareHandle } = {}) {
  await ensureDir(dirname(path));
  const tempPath = atomicTempPath(path);
  if (durable || prepareHandle) {
    let handle;
    let ownsTemp = false;
    try {
      handle = await open(tempPath, 'wx', mode ?? 0o600);
      ownsTemp = true;
      await handle.writeFile(value, 'utf8');
      if (prepareHandle) await prepareHandle(handle);
      if (durable) await handle.sync();
      await handle.close();
      handle = null;
      await replaceAtomically(tempPath, path, signal);
      ownsTemp = false;
    } finally {
      if (handle) await handle.close().catch(() => {});
      if (ownsTemp) await rm(tempPath, { force: true }).catch(() => {});
    }
    return;
  }
  await writeFile(tempPath, value, mode ? { encoding: 'utf8', mode } : 'utf8');
  try { await replaceAtomically(tempPath, path, signal); }
  catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function removePath(path) {
  await rm(path, { recursive: true, force: true });
}

export function createSerialTaskQueue() {
  let pending = Promise.resolve();
  return async function run(task) {
    const next = pending.catch(() => {}).then(task);
    pending = next;
    try {
      return await next;
    } finally {
      if (pending === next) {
        pending = Promise.resolve();
      }
    }
  };
}

export function createKeyedTaskQueue() {
  const pendingByKey = new Map();
  return async function run(key, task) {
    const previous = pendingByKey.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    pendingByKey.set(key, next);
    try {
      return await next;
    } finally {
      if (pendingByKey.get(key) === next) {
        pendingByKey.delete(key);
      }
    }
  };
}
