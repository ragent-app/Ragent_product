#!/usr/bin/env node
// DS-16: GET /api/sessions/:id/events/:seq/body serves cold compressed bodies.
//
// Spawns a real chat-server.mjs child against a temp HOME (auth.json +
// auth-sessions.json fixtures, cookie session_token=<token>), writes a large
// (compressed gz + meta) and a small (plain) body directly via history.mjs,
// then asserts: 200 payload with original byte length, immutable private
// Cache-Control, ETag + 304 revalidation, 404 for missing seq/session, and
// access control (no cookie denied, owner allowed, visitor allowed only when
// scoped to the session id).
import assert from 'assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

function randomPort() {
  return 52000 + Math.floor(Math.random() * 1000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, description, timeoutMs = 20000, intervalMs = 100) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out: ${description}`);
}

function request(port, path, { cookie = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'GET',
        headers: {
          ...(cookie ? { Cookie: cookie } : {}),
          ...headers,
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let json = null;
          try { json = data ? JSON.parse(data) : null; } catch {}
          resolve({ status: res.statusCode, headers: res.headers, json, text: data });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

const home = mkdtempSync(join(tmpdir(), 'ragent-body-endpoint-'));
const configDir = join(home, '.config', 'ragent');
mkdirSync(configDir, { recursive: true });
process.env.HOME = home;
process.env.RAGENT_CONFIG_DIR = configDir;
process.env.RAGENT_MEMORY_DIR = join(home, 'memory');
process.env.RAGENT_WORK_ROOT_DIR = join(home, 'workspace');
process.env.RAGENT_INSTANCE_ROOT = home;

const history = await import('../chat/history.mjs');
const { createSession } = await import('../chat/session-manager.mjs');

const BIG = '大正文·测试🎯'.repeat(12000); // ~180KB — compressed cold body
const SMALL_TOOL_INPUT = 'small body 小正文' + 'x'.repeat(3000); // plain, under 4KB

const childRef = { child: null };
try {
  // --- 1. create session + events directly against the shared config dir ---
  const sid = (await createSession('~', 'fake', 'body-endpoint-test', {})).id;
  await history.appendEvent(sid, { id: 'e1', type: 'message', role: 'user', content: BIG });
  await history.appendEvent(sid, { id: 'e2', type: 'tool_use', toolInput: SMALL_TOOL_INPUT });

  const bodiesDir = join(configDir, 'chat-history', sid, 'bodies');
  const files = readdirSync(bodiesDir).sort();
  assert.deepEqual(
    files,
    ['evt_000000001_content.txt.gz', 'evt_000000001_content.txt.meta.json', 'evt_000000002_toolInput.txt'],
    'large body compressed with meta, small body plain',
  );

  // The sessions-meta flush is debounced (session-meta-store.mjs ~800ms) —
  // wait it out so the server child sees the session in loadSessionsMeta.
  await sleep(1200);

  // --- 2. auth fixtures: owner + visitor scoped to sid + visitor scoped elsewhere ---
  writeFileSync(join(configDir, 'auth.json'), JSON.stringify({ token: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' }, null, 2), 'utf8');
  writeFileSync(
    join(configDir, 'auth-sessions.json'),
    JSON.stringify({
      'test-session': { expiry: Date.now() + 60 * 60 * 1000, role: 'owner' },
      'visitor-ok': { expiry: Date.now() + 60 * 60 * 1000, role: 'visitor', sessionId: sid },
      'visitor-denied': { expiry: Date.now() + 60 * 60 * 1000, role: 'visitor', sessionId: 'some-other-session' },
    }, null, 2),
    'utf8',
  );

  // --- 3. start the real server child ---
  const port = randomPort();
  const child = spawn(process.execPath, ['chat-server.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      RAGENT_RUNNER_SUPERVISOR_SOCKET: '',
      RAGENT_RUNNER_SUPERVISOR_REQUIRED: '',
      RAGENT_RUNNER_UNIT_NAME: '',
      RAGENT_RUNNER_UNIT_SCOPE: '',
      HOME: home,
      CHAT_PORT: String(port),
      RAGENT_CHAT_BASE_URL: `http://127.0.0.1:${port}`,
      RAGENT_INSTANCE_ROOT: home,
      RAGENT_CONFIG_DIR: configDir,
      RAGENT_AUTH_SESSION_SECRET: 'test-secret-0123456789abcdef0123456789abcdef',
      SECURE_COOKIES: '0',
      RAGENT_REPLY_SELF_CHECK: 'off',
      PATH: `${join(home, '.local', 'bin')}:${process.env.PATH || ''}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  childRef.child = child;
  let serverStderr = '';
  child.stderr.on('data', (chunk) => { serverStderr += chunk.toString(); });

  const ownerCookie = 'session_token=test-session';
  await waitFor(async () => {
    try {
      const res = await request(port, '/api/auth/me', { cookie: ownerCookie });
      return res.status === 200;
    } catch {
      return false;
    }
  }, 'server startup');

  const base = `/api/sessions/${encodeURIComponent(sid)}/events`;

  // --- 4. access control ---
  {
    const noCookie = await request(port, `${base}/1/body`);
    assert.equal(noCookie.status, 401, 'no cookie → 401 (auth gate)');
  }
  {
    const denied = await request(port, `${base}/1/body`, { cookie: 'session_token=visitor-denied' });
    assert.equal(denied.status, 403, 'visitor scoped to another session → 403');
  }
  {
    const allowed = await request(port, `${base}/1/body`, { cookie: 'session_token=visitor-ok' });
    assert.equal(allowed.status, 200, 'visitor scoped to this session → 200');
  }

  // --- 5. compressed cold body over HTTP: payload, headers, revalidation ---
  {
    const res = await request(port, `${base}/1/body`, { cookie: ownerCookie });
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'application/json');
    assert.equal(res.headers['cache-control'], 'private, max-age=1296000, immutable');
    assert.ok(res.headers.etag, 'ETag present');
    assert.equal(res.headers.vary, undefined, 'vary: "" → no Vary header');
    assert.equal(res.json.body.seq, 1);
    assert.equal(res.json.body.field, 'content');
    assert.equal(res.json.body.value, BIG, 'compressed body hydrated byte-exact over HTTP');
    assert.equal(res.json.body.bytes, Buffer.byteLength(BIG, 'utf8'), 'original byte length preserved');

    const revalidated = await request(port, `${base}/1/body`, {
      cookie: ownerCookie,
      headers: { 'If-None-Match': res.headers.etag },
    });
    assert.equal(revalidated.status, 304, 'If-None-Match with current ETag → 304');
    assert.equal(revalidated.text, '', '304 has no body');
    assert.equal(revalidated.headers.etag, res.headers.etag);
  }

  // --- 6. plain cold body + 404s ---
  {
    const res = await request(port, `${base}/2/body`, { cookie: ownerCookie });
    assert.equal(res.status, 200);
    assert.equal(res.json.body.field, 'toolInput');
    assert.equal(res.json.body.value, SMALL_TOOL_INPUT);
    assert.equal(res.json.body.bytes, Buffer.byteLength(SMALL_TOOL_INPUT, 'utf8'));
  }
  {
    const missingSeq = await request(port, `${base}/999/body`, { cookie: ownerCookie });
    assert.equal(missingSeq.status, 404, 'missing seq → 404');
    assert.equal(missingSeq.json?.error, 'Event body not found');
  }
  {
    const missingSession = await request(port, '/api/sessions/no-such-session/events/1/body', { cookie: ownerCookie });
    assert.equal(missingSession.status, 404, 'unknown session → 404');
  }

  console.log('history body endpoint: all sections passed');
} finally {
  if (childRef.child?.exitCode === null) {
    childRef.child.kill('SIGTERM');
    await waitFor(() => childRef.child.exitCode !== null, 'server shutdown').catch(() => {});
    await sleep(150);
  }
  rmSync(home, { recursive: true, force: true });
}
