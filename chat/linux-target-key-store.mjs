/**
 * Root-owned key storage for the Linux target-observation protocol.
 * This module is not wired into the executor or the product. The caller must
 * use a fixed, administrator-controlled directory, never an agent-supplied
 * path. Root and other root-equivalent processes are part of the trust base.
 */
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, realpath } from 'node:fs/promises';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { posix as path } from 'node:path';

export const DEFAULT_LINUX_TARGET_KEY_DIRECTORY = '/var/lib/agentoc-privileged-target';
const PRIVATE_NAME = 'observation-private.json';
const PUBLIC_NAME = 'observation-public.json';
const MAX_KEY_BYTES = 8192;

function fail(message) {
  const error = new Error(message);
  error.code = 'LINUX_TARGET_KEY_STORE_INVALID';
  throw error;
}

function directoryPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value === '/' ||
      value.endsWith('/') || path.normalize(value) !== value || /[\x00-\x1f\x7f]/.test(value)) {
    fail('invalid key directory');
  }
  return value;
}

export async function assertLinuxRootControlledDirectory(directory) {
  if (directory !== '/') directoryPath(directory);
  let current = '/';
  const components = directory.slice(1).split('/');
  for (const component of ['', ...components]) {
    if (component) current = path.join(current, component);
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || stat.gid !== 0 || (stat.mode & 0o022)) {
      fail('key directory is not root-controlled');
    }
  }
  if (await realpath(directory) !== directory) fail('key directory resolves through a link');
}

async function readProtectedFile(filePath, mode) {
  const file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== 0 || stat.gid !== 0 || stat.nlink !== 1 ||
        (stat.mode & 0o7777) !== mode || stat.size < 1 || stat.size > MAX_KEY_BYTES) {
      fail('key file is not root-controlled');
    }
    return await file.readFile('utf8');
  } finally { await file.close(); }
}

async function writeNewFile(filePath, text, mode) {
  const file = await open(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try {
    await file.chown(0, 0);
    await file.chmod(mode);
    await file.writeFile(text, 'utf8');
    await file.sync();
  } finally { await file.close(); }
  const dir = await open(path.dirname(filePath), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await dir.sync(); } finally { await dir.close(); }
}

function strictRecord(text, fields) {
  let record;
  try { record = JSON.parse(text); } catch { fail('invalid key record'); }
  if (!record || typeof record !== 'object' || Array.isArray(record) ||
      Object.keys(record).length !== fields.length || fields.some((field) => !Object.hasOwn(record, field)) ||
      record.version !== 1 || record.algorithm !== 'ed25519') fail('invalid key record');
  return record;
}

function decode(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) fail('invalid key encoding');
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) fail('invalid key encoding');
  return bytes;
}

function readPublicRecord(text) {
  const record = strictRecord(text, ['version', 'algorithm', 'keyId', 'publicKey']);
  const bytes = decode(record.publicKey);
  let publicKey;
  try { publicKey = createPublicKey({ key: bytes, type: 'spki', format: 'der' }); }
  catch { fail('invalid public key'); }
  if (publicKey.asymmetricKeyType !== 'ed25519' ||
      !publicKey.export({ type: 'spki', format: 'der' }).equals(bytes) ||
      record.keyId !== createHash('sha256').update(bytes).digest('hex')) fail('public key identity mismatch');
  return { publicKey, keyId: record.keyId, encoded: record.publicKey };
}

/** Read a root-owned, non-writable public key, including its directory chain. */
export async function loadLinuxTargetPublicKey(directory = DEFAULT_LINUX_TARGET_KEY_DIRECTORY) {
  directory = directoryPath(directory);
  await assertLinuxRootControlledDirectory(directory);
  const record = readPublicRecord(await readProtectedFile(path.join(directory, PUBLIC_NAME), 0o644));
  return { publicKey: record.publicKey, keyId: record.keyId };
}

/** Load the root-only key; initialization must be explicitly requested. */
export async function loadOrCreateLinuxTargetKey(directory = DEFAULT_LINUX_TARGET_KEY_DIRECTORY, { initialize = false } = {}) {
  if (process.platform !== 'linux' || typeof process.geteuid !== 'function' || process.geteuid() !== 0) fail('root on Linux is required');
  directory = directoryPath(directory);
  await assertLinuxRootControlledDirectory(path.dirname(directory));
  try { await mkdir(directory, { mode: 0o755 }); await chmod(directory, 0o755); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  await assertLinuxRootControlledDirectory(directory);
  const privatePath = path.join(directory, PRIVATE_NAME), publicPath = path.join(directory, PUBLIC_NAME);
  let privateText;
  try { privateText = await readProtectedFile(privatePath, 0o600); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (initialize !== true) fail('private key is missing; explicit initialization is required');
    try { await lstat(publicPath); fail('public key exists without its private key'); }
    catch (publicError) { if (publicError.code !== 'ENOENT') throw publicError; }
    const pair = generateKeyPairSync('ed25519');
    const publicBytes = pair.publicKey.export({ type: 'spki', format: 'der' });
    const record = { version: 1, algorithm: 'ed25519', keyId: createHash('sha256').update(publicBytes).digest('hex'),
      publicKey: publicBytes.toString('base64url'), privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url') };
    privateText = `${JSON.stringify(record)}\n`;
    await writeNewFile(privatePath, privateText, 0o600);
  }
  const record = strictRecord(privateText, ['version', 'algorithm', 'keyId', 'publicKey', 'privateKey']);
  const publicRecord = { version: record.version, algorithm: record.algorithm, keyId: record.keyId, publicKey: record.publicKey };
  const parsedPublic = readPublicRecord(JSON.stringify(publicRecord));
  let privateKey;
  const privateBytes = decode(record.privateKey);
  try { privateKey = createPrivateKey({ key: privateBytes, type: 'pkcs8', format: 'der' }); }
  catch { fail('invalid private key'); }
  if (privateKey.asymmetricKeyType !== 'ed25519' || !privateKey.export({ type: 'pkcs8', format: 'der' }).equals(privateBytes) ||
      createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64url') !== parsedPublic.encoded) {
    fail('private and public keys do not match');
  }
  try { await writeNewFile(publicPath, `${JSON.stringify(publicRecord)}\n`, 0o644); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const published = await loadLinuxTargetPublicKey(directory);
  if (published.keyId !== parsedPublic.keyId) fail('published public key does not match private key');
  return { privateKey, publicKey: published.publicKey, keyId: published.keyId };
}
