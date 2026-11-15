#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { spawn } from 'child_process';
import { buildChildEnvironment } from '../scripts/launch-test-instance.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const cookie = 'session_token=test-session';

function randomPort() {
  return 44000 + Math.floor(Math.random() * 10000);
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
  const home = mkdtempSync(join(tmpdir(), 'ragent-static-route-'));
  const configDir = join(home, '.ragent', 'config');
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
      ...buildChildEnvironment({id:`static-route-${process.pid}`, instanceDir:join(home,'.ragent'),
        configDir:join(home,'.ragent','config'), memoryDir:join(home,'.ragent','memory'),
        workRootDir:join(home,'.ragent','workspace'), spoolDir:join(home,'.ragent','data','chat-runs'),
        providerHomesDir:join(home,'.ragent','provider-homes'), port}, process.env),
      RAGENT_AUTH_SESSION_SECRET: 'test-secret-static-routing',
      RAGENT_WINDOWS_SERVICE_MODE: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitFor(async () => {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('Server exited during startup');
      try {
        const res = await request(port, '/login', { Cookie: '' });
        return res.status === 200;
      } catch {
        return false;
      }
    }, 'server startup');
  } catch (error) {
    await stopServer({ child });
    throw error;
  }
  return { child };
}

async function stopServer(server) {
  if (!server?.child || server.child.exitCode !== null || server.child.signalCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise(resolve => spawn('taskkill', ['/pid', String(server.child.pid), '/t', '/f'], { stdio:'ignore', windowsHide:true }).once('close', resolve));
  } else server.child.kill('SIGTERM');
  await waitFor(() => server.child.exitCode !== null || server.child.signalCode !== null, 'server shutdown');
}

async function main() {
  const { home } = setupTempHome();
  const port = randomPort();
  const probeName = `__static_probe_${Date.now().toString(36)}.js`;
  const probePath = join(repoRoot, 'static', 'chat', probeName);
  writeFileSync(probePath, 'window.__RAGENT_STATIC_PROBE__ = true;\n', 'utf8');

  let server;
  try {
    server = await startServer({ home, port });
    const page = await request(port, '/');
    assert.equal(page.status, 200, 'chat page should render');
    assert.match(page.text, /<script src="\/?chat\/icons\.js(?:\?v=[^"]+)?"/);

    const probe = await request(port, `/chat/${probeName}`);
    assert.equal(probe.status, 200, 'new static asset should load without router filename changes');
    assert.equal(
      probe.headers['content-type'],
      'application/javascript',
      'extension-based routing should infer javascript content type',
    );
    assert.equal(
      probe.headers['cache-control'],
      'public, no-cache, max-age=0, must-revalidate',
      'static assets should keep safe revalidation caching',
    );
    assert.ok(probe.headers.etag, 'new static asset should expose an ETag');
    assert.match(probe.text, /__RAGENT_STATIC_PROBE__/);

    const versionedProbe = await request(port, `/chat/${probeName}?v=test-build`);
    assert.equal(versionedProbe.status, 200, 'versioned static asset should load');
    assert.equal(
      versionedProbe.headers['cache-control'],
      'public, max-age=31536000, immutable',
      'versioned static assets should be long-lived immutable cache hits',
    );

    const probe304 = await request(port, `/chat/${probeName}`, {
      'If-None-Match': probe.headers.etag,
    });
    assert.equal(probe304.status, 304, 'new static asset should support conditional requests');

    const manifest = await request(port, '/manifest.json');
    assert.equal(manifest.status, 200, 'manifest should still load');
    assert.equal(
      manifest.headers['content-type'],
      'application/manifest+json',
      'manifest should keep its explicit content type',
    );

    const hidden = await request(port, '/.hidden-probe');
    assert.equal(hidden.status, 404, 'hidden static files should not be exposed');

    console.log('✅ Static asset routing validated');
  } finally {
    await stopServer(server);
    rmSync(probePath, { force: true });
    const resolvedHome = realpathSync(home);
    const relativeHome = relative(resolve(tmpdir()), resolvedHome);
    if (!relativeHome || relativeHome.startsWith('..') || isAbsolute(relativeHome) || !basename(resolvedHome).startsWith('ragent-static-route-')) {
      throw new Error('Refusing to remove a test directory outside its temporary root');
    }
    rmSync(resolvedHome, { force: true, recursive: true });
  }
}

main().catch((err) => {
  console.error('❌ Static asset routing test failed:', err);
  process.exitCode = 1;
});
