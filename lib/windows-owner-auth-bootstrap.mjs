import { randomBytes, scrypt as scryptCallback } from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname } from 'path';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function hashOwnerPassword(password) {
  const salt = randomBytes(16);
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, 32, { N: 16384, r: 8, p: 1 }, (error, key) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(`scrypt$16384$8$1$${salt.toString('hex')}$${key.toString('hex')}`);
    });
  });
}

export async function ensureWindowsOwnerAuth({
  authFile,
  platform = process.platform,
  username = process.env.RAGENT_INITIAL_USERNAME,
  password = process.env.RAGENT_INITIAL_PASSWORD,
} = {}) {
  if (platform !== 'win32') return { created: false, auth: null, initialPassword: '' };
  if (!authFile) throw new Error('Windows owner auth bootstrap requires authFile');

  try {
    const auth = JSON.parse(await readFile(authFile, 'utf8'));
    return { created: false, auth, initialPassword: '' };
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const initialPassword = trimString(password) || randomBytes(18).toString('base64url');
  const auth = {
    username: trimString(username) || 'owner',
    passwordHash: await hashOwnerPassword(initialPassword),
  };
  await mkdir(dirname(authFile), { recursive: true });
  await writeFile(authFile, `${JSON.stringify(auth, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return { created: true, auth, initialPassword };
}
