#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const dir = await mkdtemp(join(tmpdir(), 'ragent-accounts-entrypoint-'));
const entry = join(dir, 'server.mjs');
await symlink(join(root, 'accounts/server.mjs'), entry);

const child = spawn(process.execPath, [entry], {
  cwd: root,
  env: {
    ...process.env,
    RAGENT_ACCOUNTS_DATA_DIR: dir,
    RAGENT_ACCOUNTS_SIGNING_KEY_FILE: join(dir, 'signing-key.json'),
    RAGENT_ACCOUNTS_PUBLIC_BASE_URL: 'http://127.0.0.1:0',
    RAGENT_ACCOUNTS_HOST: '127.0.0.1',
    PORT: '0',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stdout = '';
let stderr = '';
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (chunk) => { stdout += chunk; });
child.stderr.on('data', (chunk) => { stderr += chunk; });

try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`entrypoint did not start: ${stderr}`)), 5000);
    child.once('spawn', () => {
      const check = setInterval(() => {
        if (stdout.includes('Accounts owner-auth server listening')) {
          clearInterval(check);
          clearTimeout(timer);
          resolve();
        }
      }, 25);
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      clearInterval(timer);
      if (!stdout.includes('Accounts owner-auth server listening')) {
        reject(new Error(`entrypoint exited early: code=${code} signal=${signal} stderr=${stderr}`));
      }
    });
  });
  assert.equal(child.exitCode, null);
  console.log('ok - accounts server starts through a version symlink');
} finally {
  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));
  await rm(dir, { recursive: true, force: true });
}
