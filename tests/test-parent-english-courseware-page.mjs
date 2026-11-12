#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

function randomPort() {
  return 45000 + Math.floor(Math.random() * 10000);
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

function request(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'GET',
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
  const home = mkdtempSync(join(tmpdir(), 'agentoc-parent-page-'));
  const configDir = join(home, '.config', 'agentoc');
  mkdirSync(configDir, { recursive: true });

  writeFileSync(
    join(configDir, 'auth.json'),
    JSON.stringify({ token: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' }, null, 2),
    'utf8',
  );

  return { home, configDir };
}

async function startServer({ home, configDir, port }) {
  const child = spawn(process.execPath, ['chat-server.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      AGENTOC_RUNNER_SUPERVISOR_SOCKET: "",
      AGENTOC_RUNNER_SUPERVISOR_REQUIRED: "",
      HOME: home,
      CHAT_PORT: String(port),
      AGENTOC_INSTANCE_ROOT: home,
      AGENTOC_CONFIG_DIR: configDir,
      AGENTOC_MEMORY_DIR: join(home, '.agentoc', 'memory'),
      SECURE_COOKIES: '0',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  await waitFor(async () => {
    try {
      const res = await request(port, '/login');
      return res.status === 200;
    } catch {
      return false;
    }
  }, 'server startup');

  return { child };
}

async function stopServer(server) {
  if (!server?.child || server.child.exitCode !== null || server.child.signalCode !== null) return;
  server.child.kill('SIGTERM');
  await waitFor(() => server.child.exitCode !== null || server.child.signalCode !== null, 'server shutdown');
}

async function main() {
  const { home, configDir } = setupTempHome();
  const port = randomPort();
  const server = await startServer({ home, configDir, port });

  try {
    const page = await request(port, '/showcase/parent-english-courseware');
    assert.ok([302, 404].includes(page.status), 'retired showcase is not publicly served');

    const css = await request(port, '/parent-english-courseware.css');
    assert.ok([302, 404].includes(css.status), 'retired stylesheet is not served');

    const js = await request(port, '/parent-english-courseware.js');
    assert.ok([302, 404].includes(js.status), 'retired script is not served');

    console.log('test-parent-english-courseware-page: ok');
  } finally {
    await stopServer(server);
  }
}

main().catch((error) => {
  console.error('test-parent-english-courseware-page: failed', error);
  process.exitCode = 1;
});
