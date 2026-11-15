import { randomBytes, timingSafeEqual } from 'node:crypto';
import { open, readFile, lstat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_DIR, CHAT_PORT } from './config.mjs';
import { loadOrCreateInstanceIdentity } from './instance-identity.mjs';

export const isProotRuntime = process.env.RAGENT_RUNTIME_MODE === 'proot';
const tokenPath = join(CONFIG_DIR, 'proot-local-token');

async function readToken() {
  const info = await lstat(tokenPath);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) || info.size > 128) throw new Error('Unsafe local pairing token');
  const value = (await readFile(tokenPath, 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid local pairing token');
  return value;
}

export function isDirectProotRequest(req) {
  const address = req?.socket?.remoteAddress;
  const host = req?.headers?.host;
  if (address !== '127.0.0.1' && address !== '::ffff:127.0.0.1') return false;
  if (host !== `127.0.0.1:${CHAT_PORT}`) return false;
  return !Object.keys(req.headers || {}).some(key => /^(forwarded|via|x-forwarded-.*|x-real-ip|x-ragent-tunnel)$/i.test(key));
}

export async function authenticateProotRequest(req) {
  if (!isProotRuntime || !isDirectProotRequest(req)) return false;
  const match = /^Bearer ([a-f0-9]{64})$/.exec(req.headers?.authorization || '');
  if (!match) return false;
  try {
    const expected = Buffer.from(await readToken(), 'hex');
    return timingSafeEqual(expected, Buffer.from(match[1], 'hex'));
  } catch { return false; }
}

async function initialize() {
  try {
    const handle = await open(tokenPath, 'wx', 0o600);
    try { await handle.writeFile(`${randomBytes(32).toString('hex')}\n`); } finally { await handle.close(); }
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
  await readToken();
  await loadOrCreateInstanceIdentity();
}

async function main() {
  if (!isProotRuntime) throw new Error('Set RAGENT_RUNTIME_MODE=proot');
  const [command, destination] = process.argv.slice(2);
  if (command === 'init' && !destination) { await initialize(); return; }
  if (command !== 'export' || !destination || !isAbsolute(destination)) throw new Error('Usage: proot-local-pairing.mjs init | export <absolute-file>');
  const token = await readToken();
  const identity = await loadOrCreateInstanceIdentity();
  const handle = await open(destination, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify({ version: 1, kind: 'ragent-proot-local', baseUrl: `http://127.0.0.1:${CHAT_PORT}`, instanceId: identity.instanceId, token }, null, 2)}\n`); }
  finally { await handle.close(); }
}
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
