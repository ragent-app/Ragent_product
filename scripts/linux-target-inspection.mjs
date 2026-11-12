/**
 * Root-only assembly of a native target observation and signed attestation.
 * Not exposed by the production executor. Both helperPath and expectedSha256
 * MUST be fixed by trusted installation metadata, never by a request. This
 * function does not grant deletion authority or implement replay protection.
 */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { posix as path } from 'node:path';
import { createLinuxTargetBinding, validateLinuxTargetPath } from '../chat/linux-target-binding.mjs';
import { canonicalLinuxTargetContext, signLinuxTargetAttestation } from '../chat/linux-target-attestation.mjs';
import { assertLinuxRootControlledDirectory } from '../chat/linux-target-key-store.mjs';

const MAX_HELPER_BYTES = 16 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 8192;
const TIMEOUT_MS = 5000;

function fail(message) {
  const error = new Error(message);
  error.code = 'LINUX_TARGET_INSPECTION_FAILED';
  throw error;
}

function sameHelper(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid &&
    a.gid === b.gid && a.nlink === b.nlink && a.size === b.size &&
    a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

function runNative(fd, args) {
  return new Promise((resolve) => {
    // The already-verified descriptor is inherited as fd 3. Executing through
    // procfs prevents a later pathname replacement from selecting another file.
    const child = spawn('/proc/self/fd/3', args, {
      cwd: '/', env: {}, stdio: ['ignore', 'pipe', 'pipe', fd],
    });
    let stdout = '', stderr = '', settled = false;
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish({ uncertain: true }); }, TIMEOUT_MS);
    function finish(value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }
    function collect(chunk, which) {
      const next = (which === 'stdout' ? stdout : stderr) + chunk.toString('utf8');
      if (Buffer.byteLength(next, 'utf8') > MAX_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        finish({ uncertain: true });
      } else if (which === 'stdout') stdout = next;
      else stderr = next;
    }
    child.stdout.on('data', (chunk) => collect(chunk, 'stdout'));
    child.stderr.on('data', (chunk) => collect(chunk, 'stderr'));
    child.once('error', () => finish({ uncertain: true }));
    child.once('close', (code, signal) => finish({ code, signal, stdout, stderr }));
  });
}

async function withVerifiedHelper(helperPath, expectedSha256, action) {
  if (process.platform !== 'linux' || typeof process.geteuid !== 'function' || process.geteuid() !== 0) fail('Linux root is required');
  validateLinuxTargetPath(helperPath);
  if (!/^[a-f0-9]{64}$/.test(expectedSha256 || '')) fail('trusted helper digest is required');
  await assertLinuxRootControlledDirectory(path.dirname(helperPath));
  const file = await open(helperPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.uid !== 0n || before.gid !== 0n || before.nlink !== 1n ||
        (before.mode & 0o022n) !== 0n || (before.mode & 0o100n) === 0n || before.size < 20n || before.size > BigInt(MAX_HELPER_BYTES)) {
      fail('helper is not an owner-controlled executable');
    }
    const binary = await file.readFile();
    const after = await file.stat({ bigint: true });
    const machine = process.arch === 'x64' ? 62 : process.arch === 'arm64' ? 183 : 0;
    if (!sameHelper(before, after) || binary.length !== Number(before.size) ||
        binary[0] !== 0x7f || binary[1] !== 0x45 || binary[2] !== 0x4c || binary[3] !== 0x46 ||
        binary[4] !== 2 || binary[5] !== 1 || !machine || binary.readUInt16LE(18) !== machine ||
        createHash('sha256').update(binary).digest('hex') !== expectedSha256) {
      fail('helper identity or architecture does not match');
    }
    return await action(file.fd);
  } finally { await file.close(); }
}

export async function inspectAndAttestLinuxTarget({ helperPath, expectedSha256, privateKey, targetPath, context } = {}) {
  validateLinuxTargetPath(targetPath);
  const normalizedContext = canonicalLinuxTargetContext(context);
  if (!privateKey || privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') fail('private key is required');
  return withVerifiedHelper(helperPath, expectedSha256, async (fd) => {
    const result = await runNative(fd, [targetPath]);
    if (result.uncertain || result.code !== 0 || result.signal) fail('native inspection rejected target');
    let snapshot;
    try { snapshot = JSON.parse(result.stdout); } catch { fail('invalid native inspection response'); }
    return signLinuxTargetAttestation({ privateKey, context: normalizedContext, path: targetPath, snapshot });
  });
}

const SNAPSHOT_FIELDS = Object.freeze([
  'mountId', 'parentDevice', 'parentInode', 'device', 'inode', 'size',
  'ctimeSeconds', 'ctimeNanoseconds', 'mtimeSeconds', 'mtimeNanoseconds',
]);
const DEFINITE_REJECTIONS = new Set([
  'ROOT_REQUIRED', 'INVALID_ARGUMENTS', 'INVALID_PATH', 'INTERNAL_ERROR', 'ROOT_UNAVAILABLE',
  'UNTRUSTED_DIRECTORY', 'UNTRUSTED_TARGET', 'TARGET_CHANGED_OR_UNTRUSTED', 'SNAPSHOT_MISMATCH',
]);

export function classifyLinuxDeleteNativeResult(result = {}) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return { state: 'unknown', code: 'LINUX_DELETE_RESULT_UNKNOWN' };
  if (!result.uncertain && !result.signal && result.code === 0) {
    try {
      const value = JSON.parse(result.stdout);
      if (value && Object.keys(value).length === 1 && value.removed === true) return { state: 'completed' };
    } catch { /* The operation may have happened; report unknown. */ }
  }
  const code = typeof result.stderr === 'string' ? result.stderr.trim() : '';
  if (!result.uncertain && !result.signal && result.code === 1 && DEFINITE_REJECTIONS.has(code)) {
    return { state: 'rejected', code };
  }
  return { state: 'unknown', code: 'LINUX_DELETE_RESULT_UNKNOWN' };
}

/**
 * Executes only a validated single-file snapshot. This is NOT authorization:
 * a trusted caller must verify policy, owner capability, run liveness, and
 * durably consume a one-shot nonce before invoking it. Not exposed by Ragent.
 */
export async function removeVerifiedLinuxTarget({ helperPath, expectedSha256, binding } = {}) {
  let normalized;
  try {
    if (!binding || typeof binding !== 'object' || Array.isArray(binding) || !Object.hasOwn(binding, 'path')) {
      return { state: 'rejected', code: 'INVALID_BINDING' };
    }
    const { path: targetPath, ...snapshot } = binding || {};
    normalized = createLinuxTargetBinding(targetPath, snapshot);
  } catch { return { state: 'rejected', code: 'INVALID_BINDING' }; }
  let invoked = false;
  try {
    return await withVerifiedHelper(helperPath, expectedSha256, async (fd) => {
      invoked = true;
      const result = await runNative(fd, ['--remove', normalized.path, ...SNAPSHOT_FIELDS.map((field) => normalized[field])]);
      return classifyLinuxDeleteNativeResult(result);
    });
  } catch {
    return invoked ? { state: 'unknown', code: 'LINUX_DELETE_RESULT_UNKNOWN' }
      : { state: 'rejected', code: 'HELPER_UNAVAILABLE' };
  }
}
