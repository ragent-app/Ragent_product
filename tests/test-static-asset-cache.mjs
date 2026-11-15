#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, mkdirSync, statSync, utimesSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const cookie = 'session_token=test-session';

function randomPort() {
  return 45000 + Math.floor(Math.random() * 5000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, description, timeoutMs = 10000, intervalMs = 100) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out: ${description}`);
}

function request(port, path, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'GET',
        headers: {
          Cookie: cookie,
          ...extraHeaders,
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          resolve({ status: res.statusCode, headers: res.headers, text: data });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function setupTempHome() {
  const home = mkdtempSync(join(tmpdir(), 'ragent-static-cache-'));
  const configDir = join(home, '.config', 'ragent');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, 'auth.json'),
    JSON.stringify({ token: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' }, null, 2),
    'utf8',
  );
  writeFileSync(
    join(configDir, 'auth-sessions.json'),
    JSON.stringify({
      'test-session': { expiry: Date.now() + 60 * 60 * 1000, role: 'owner' },
    }, null, 2),
    'utf8',
  );
  return { home };
}

async function startServer({ home, port }) {
  const child = spawn(process.execPath, ['chat-server.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      RAGENT_RUNNER_SUPERVISOR_SOCKET: '',
      RAGENT_RUNNER_SUPERVISOR_REQUIRED: '',
      HOME: home,
      CHAT_PORT: String(port),
      SECURE_COOKIES: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitFor(async () => {
    try {
      const res = await request(port, '/login', { Cookie: '' });
      return res.status === 200;
    } catch {
      return false;
    }
  }, 'server startup');
  return { child };
}

async function stopServer(server) {
  if (!server?.child || server.child.exitCode !== null) return;
  server.child.kill('SIGTERM');
  await waitFor(() => server.child.exitCode !== null, 'server shutdown');
}

async function main() {
  const { home } = setupTempHome();
  const port = randomPort();
  const probeName = `__static_cache_probe_${Date.now().toString(36)}.js`;
  const probePath = join(repoRoot, 'static', 'chat', probeName);
  const originalContent = 'window.__RAGENT_STATIC_PROBE__ = true;\n';
  writeFileSync(probePath, originalContent, 'utf8');

  const server = await startServer({ home, port });
  try {
    const first = await request(port, `/chat/${probeName}`);
    assert.equal(first.status, 200);
    assert.match(first.text, /__RAGENT_STATIC_PROBE__ = true/, 'first request serves the file from disk');

    // Same-size rewrite with the mtime restored: the cache must serve the
    // previous content (mtime+size match → cache hit, no disk re-read).
    const probeStats = statSync(probePath);
    const staleReplacement = 'window.__RAGENT_STATIC_PROBE__ = null;\n'; // same byte length as the original
    assert.equal(
      Buffer.byteLength(staleReplacement, 'utf8'),
      Buffer.byteLength(originalContent, 'utf8'),
      'test rewrite must keep the file size',
    );
    writeFileSync(probePath, staleReplacement, 'utf8');
    // Restore the exact mtime (float seconds preserve sub-ms precision) so
    // the server's mtimeMs comparison matches the cached entry.
    utimesSync(probePath, probeStats.atimeMs / 1000, probeStats.mtimeMs / 1000);
    const staleServed = await request(port, `/chat/${probeName}`);
    assert.equal(staleServed.status, 200);
    assert.match(staleServed.text, /__RAGENT_STATIC_PROBE__ = true/, 'unchanged mtime+size serves the cached asset');

    // Real file change (mtime advances): the cache must invalidate and
    // re-read the file — the hot-reload contract.
    writeFileSync(probePath, staleReplacement, 'utf8');
    const freshServed = await request(port, `/chat/${probeName}`);
    assert.equal(freshServed.status, 200);
    assert.match(freshServed.text, /__RAGENT_STATIC_PROBE__ = null/, 'mtime change invalidates the cache and re-reads the file');

    // Versioned requests use a separate cache key and still re-read on mtime
    // change (CSS rewrite versioning path stays correct).
    const versioned = await request(port, `/chat/${probeName}?v=build-1`);
    assert.equal(versioned.status, 200);
    assert.match(versioned.text, /__RAGENT_STATIC_PROBE__ = null/, 'versioned request serves the current file');

    console.log('✅ Static asset memory cache validated');
  } finally {
    await stopServer(server);
    rmSync(probePath, { force: true });
  }
}

main().catch((err) => {
  console.error('❌ Static asset cache test failed:', err);
  process.exitCode = 1;
});
