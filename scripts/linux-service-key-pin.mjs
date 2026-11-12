// Isolated enrollment primitive. The administrator must authenticate the
// fingerprint out of band; never enroll a key supplied by a Run or socket peer.
// No automatic key replacement or rotation is provided.
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash, createPublicKey } from 'node:crypto';
import { posix as path } from 'node:path';
import { assertLinuxRootControlledDirectory } from '../chat/linux-target-key-store.mjs';

const NAME = 'service-scope-public.json';
const MAX_BYTES = 4096;
function fail() { throw Object.assign(new Error('Invalid Linux service key pin'), { code: 'LINUX_SERVICE_KEY_PIN_INVALID' }); }
function rootOnly() { if (process.platform !== 'linux' || process.geteuid?.() !== 0) fail(); }
function normalizedDirectory(directory) {
  if (typeof directory !== 'string' || directory === '/' || !directory.startsWith('/') ||
      directory.endsWith('/') || path.normalize(directory) !== directory || /[\x00-\x1f\x7f]/.test(directory)) fail();
  return directory;
}
function serialize(publicKey) {
  if (publicKey?.type !== 'public' || publicKey.asymmetricKeyType !== 'ed25519') fail();
  const bytes = publicKey.export({ type: 'spki', format: 'der' });
  return { version: 1, algorithm: 'ed25519', keyId: createHash('sha256').update(bytes).digest('hex'), publicKey: bytes.toString('base64url') };
}

/** Explicit enrollment only, exclusively creates the pin and fsyncs it and its directory. */
export async function enrollLinuxServiceKeyPin({ directory, publicKey, expectedKeyId } = {}) {
  rootOnly();
  directory = normalizedDirectory(directory);
  await assertLinuxRootControlledDirectory(directory);
  const record = serialize(publicKey);
  if (typeof expectedKeyId !== 'string' || !/^[a-f0-9]{64}$/.test(expectedKeyId) || record.keyId !== expectedKeyId) fail();
  const file = await open(path.join(directory, NAME), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await file.chown(0, 0);
    await file.chmod(0o600);
    await file.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
    await file.sync();
  } finally { await file.close(); }
  const dir = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await dir.sync(); } finally { await dir.close(); }
  return { keyId: record.keyId };
}

/** Never falls back to a caller-provided key when the protected pin is invalid. */
export async function loadLinuxServiceKeyPin(directory) {
  rootOnly();
  directory = normalizedDirectory(directory);
  await assertLinuxRootControlledDirectory(directory);
  const file = await open(path.join(directory, NAME), constants.O_RDONLY | constants.O_NOFOLLOW);
  let text;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== 0 || stat.gid !== 0 || stat.nlink !== 1 ||
        (stat.mode & 0o7777) !== 0o600 || stat.size < 1 || stat.size > MAX_BYTES) fail();
    text = await file.readFile('utf8');
  } finally { await file.close(); }
  let record, publicKey;
  try {
    record = JSON.parse(text);
    if (!record || typeof record !== 'object' || Array.isArray(record) || Object.keys(record).length !== 4 ||
        record.version !== 1 || record.algorithm !== 'ed25519' || typeof record.publicKey !== 'string' ||
        !/^[A-Za-z0-9_-]+$/.test(record.publicKey)) fail();
    const bytes = Buffer.from(record.publicKey, 'base64url');
    if (bytes.toString('base64url') !== record.publicKey) fail();
    publicKey = createPublicKey({ key: bytes, type: 'spki', format: 'der' });
    const canonical = serialize(publicKey);
    if (canonical.publicKey !== record.publicKey || canonical.keyId !== record.keyId) fail();
  } catch { fail(); }
  return { publicKey, keyId: record.keyId };
}
