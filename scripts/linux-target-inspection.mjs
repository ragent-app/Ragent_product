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
import { validateLinuxTargetPath } from '../chat/linux-target-binding.mjs';
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

function runInspection(fd, targetPath) {
  return new Promise((resolve, reject) => {
    // The already-verified descriptor is inherited as fd 3. Executing through
    // procfs prevents a later pathname replacement from selecting another file.
    const child = spawn('/proc/self/fd/3', [targetPath], {
      cwd: '/', env: {}, stdio: ['ignore', 'pipe', 'pipe', fd],
    });
    let stdout = '', stderr = '', settled = false;
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error('inspection timed out')); }, TIMEOUT_MS);
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    }
    function collect(chunk, which) {
      const next = (which === 'stdout' ? stdout : stderr) + chunk.toString('utf8');
      if (Buffer.byteLength(next, 'utf8') > MAX_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        finish(new Error('inspection output exceeded limit'));
      } else if (which === 'stdout') stdout = next;
      else stderr = next;
    }
    child.stdout.on('data', (chunk) => collect(chunk, 'stdout'));
    child.stderr.on('data', (chunk) => collect(chunk, 'stderr'));
    child.once('error', (error) => finish(error));
    child.once('close', (code, signal) => {
      if (code !== 0 || signal) return finish(new Error('native inspection rejected target'));
      try { finish(null, JSON.parse(stdout)); } catch { finish(new Error('invalid native inspection response')); }
    });
  });
}

export async function inspectAndAttestLinuxTarget({ helperPath, expectedSha256, privateKey, targetPath, context } = {}) {
  if (process.platform !== 'linux' || typeof process.geteuid !== 'function' || process.geteuid() !== 0) fail('Linux root is required');
  validateLinuxTargetPath(helperPath);
  validateLinuxTargetPath(targetPath);
  const normalizedContext = canonicalLinuxTargetContext(context);
  if (!/^[a-f0-9]{64}$/.test(expectedSha256 || '') || !privateKey || privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') {
    fail('trusted helper digest and private key are required');
  }
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
    const snapshot = await runInspection(file.fd, targetPath);
    return signLinuxTargetAttestation({ privateKey, context: normalizedContext, path: targetPath, snapshot });
  } finally { await file.close(); }
}
