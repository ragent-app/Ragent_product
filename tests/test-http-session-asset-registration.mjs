#!/usr/bin/env node
// Explicit asset registration API e2e: POST /api/sessions/:id/assets must
// publish a local file as a session attachment without any text-path
// resolution, and the attachment must surface in the session event stream.
import assert from 'assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const cookie = 'session_token=test-session';

function randomPort() {
  return 38000 + Math.floor(Math.random() * 2000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, description, timeoutMs = 15000, intervalMs = 100) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out: ${description}`);
}

function request(port, method, path, body = null, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        Cookie: cookie,
        ...(body !== null && body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...extraHeaders,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const text = buffer.toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch {}
        resolve({ status: res.statusCode, headers: res.headers, json, text, buffer });
      });
    });
    req.on('error', reject);
    if (body !== null && body !== undefined) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

function setupTempHome() {
  const home = mkdtempSync(join(tmpdir(), 'ragent-asset-registration-'));
  const configDir = join(home, '.config', 'ragent');
  const workRoot = join(home, '.ragent', 'workspace');
  const outputsDir = join(home, 'code', 'renders');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(workRoot, { recursive: true });
  mkdirSync(outputsDir, { recursive: true });

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
  writeFileSync(
    join(configDir, 'tools.json'),
    JSON.stringify([
      {
        id: 'fake-codex',
        name: 'Fake Codex',
        command: 'fake-codex',
        runtimeFamily: 'codex-json',
        models: [{ id: 'fake-model', label: 'Fake model', defaultEffort: 'low' }],
        reasoning: { kind: 'enum', label: 'Reasoning', levels: ['low'], default: 'low' },
      },
    ], null, 2),
    'utf8',
  );

  const chartPath = join(outputsDir, 'weekly-chart.png');
  writeFileSync(chartPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]), 'utf8');
  const reportPath = join(outputsDir, 'summary-report.pdf');
  writeFileSync(reportPath, '%PDF-1.7 mock summary report', 'utf8');
  return { home, configDir, outputsDir, chartPath, reportPath };
}

async function startServer({ home, configDir, port }) {
  const child = spawn(process.execPath, ['chat-server.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      RAGENT_RUNNER_SUPERVISOR_SOCKET: "",
      RAGENT_AUTH_SESSION_SECRET: "test-secret-ragent-http-assets",
      RAGENT_RUNNER_SUPERVISOR_REQUIRED: "",
      HOME: home,
      CHAT_PORT: String(port),
      RAGENT_INSTANCE_ROOT: '',
      RAGENT_CONFIG_DIR: configDir,
      RAGENT_MEMORY_DIR: join(home, '.ragent', 'memory'),
      RAGENT_WORK_ROOT_DIR: join(home, '.ragent', 'workspace'),
      RAGENT_DISABLE_SYSTEMD_DETACHED_RUNNER: '1',
      SECURE_COOKIES: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});

  await waitFor(async () => {
    try {
      const res = await request(port, 'GET', '/api/auth/me');
      return res.status === 200;
    } catch {
      return false;
    }
  }, 'server startup');

  return child;
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await waitFor(() => child.exitCode !== null, 'server shutdown');
}

try {
  const { home, configDir, outputsDir, chartPath, reportPath } = setupTempHome();
  const port = randomPort();
  const chatServer = await startServer({ home, configDir, port });

  try {
    const createSessionRes = await request(port, 'POST', '/api/sessions', {
      folder: repoRoot,
      tool: 'fake-codex',
      name: 'Asset registration e2e',
      systemPrompt: 'Register produced files through the assets API.',
    });
    assert.equal(createSessionRes.status, 201, 'session should be created');
    const sessionId = createSessionRes.json.session.id;

    // ── registration succeeds and surfaces in the event stream ──────────
    const registerRes = await request(port, 'POST', `/api/sessions/${sessionId}/assets`, {
      localPath: chartPath,
      originalName: 'weekly-chart.png',
      mimeType: 'image/png',
      text: 'Weekly chart is ready.',
    });
    assert.equal(registerRes.status, 201, 'registration should succeed with 201');
    assert.equal(registerRes.json.asset.originalName, 'weekly-chart.png', 'response should echo the registered name');
    assert.equal(registerRes.json.asset.mimeType, 'image/png', 'response should echo the mime type');
    assert.equal(registerRes.json.asset.sizeBytes, 12, 'response should report the file size');
    assert.ok(registerRes.json.asset.assetId, 'response should carry an assetId');
    const assetId = registerRes.json.asset.assetId;

    const registeredMessage = await waitFor(async () => {
      const res = await request(port, 'GET', `/api/sessions/${sessionId}/events?filter=all&limit=500`);
      if (res.status !== 200) return false;
      const events = res.json?.events || [];
      return events.find((event) => (
        event.type === 'message'
        && event.role === 'assistant'
        && event.source === 'session_asset_registration'
      )) || false;
    }, 'registered assistant message in event stream');
    assert.equal(registeredMessage.content, 'Weekly chart is ready.', 'registered message should carry the caption text');
    assert.equal(registeredMessage.attachments?.length, 1, 'registered message should attach the published asset');
    const attachment = registeredMessage.attachments[0];
    assert.equal(attachment.assetId, assetId, 'attachment should reference the registered asset');
    assert.equal(attachment.originalName, 'weekly-chart.png', 'attachment should keep the registered name');
    assert.equal(attachment.mimeType, 'image/png', 'attachment should keep the mime type');

    // ── asset metadata and bytes are reachable through the standard routes ──
    const assetRes = await request(port, 'GET', `/api/assets/${assetId}`);
    assert.equal(assetRes.status, 200, 'registered asset metadata should load');
    assert.equal(assetRes.json.asset.status, 'ready', 'registered asset should be ready');
    const downloadRes = await request(port, 'GET', `/api/assets/${assetId}/download?download=1`);
    assert.equal(downloadRes.status, 200, 'registered asset download should serve the file bytes');
    assert.deepEqual(downloadRes.buffer, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]), 'registered asset download should return the exact bytes');

    // ── renderAs: file is honored for non-previewable types ────────────
    const registerPdfRes = await request(port, 'POST', `/api/sessions/${sessionId}/assets`, {
      localPath: reportPath,
      renderAs: 'file',
    });
    assert.equal(registerPdfRes.status, 201, 'pdf registration should succeed');
    const pdfMessage = await waitFor(async () => {
      const res = await request(port, 'GET', `/api/sessions/${sessionId}/events?filter=all&limit=500`);
      if (res.status !== 200) return false;
      const events = res.json?.events || [];
      const matches = events.filter((event) => (
        event.type === 'message'
        && event.role === 'assistant'
        && event.source === 'session_asset_registration'
      ));
      const withPdf = matches.find((event) => event.attachments?.some((item) => item.originalName === 'summary-report.pdf'));
      return withPdf || false;
    }, 'registered pdf message');
    assert.equal(pdfMessage.content, '', 'omitted text should default to empty content');
    assert.equal(pdfMessage.attachments[0].renderAs, 'file', 'renderAs: file should be preserved');
    assert.equal(pdfMessage.attachments[0].originalName, 'summary-report.pdf', 'originalName should default to the basename');

    // ── failure semantics ───────────────────────────────────────────────
    const missingPathRes = await request(port, 'POST', `/api/sessions/${sessionId}/assets`, {
      localPath: join(outputsDir, 'does-not-exist.png'),
    });
    assert.equal(missingPathRes.status, 400, 'a nonexistent file should be rejected with 400');
    assert.equal(missingPathRes.json.code, 'FILE_ASSET_LOCAL_PATH_INVALID', 'rejection should carry the diagnostic code');

    const noPathRes = await request(port, 'POST', `/api/sessions/${sessionId}/assets`, {});
    assert.equal(noPathRes.status, 400, 'missing localPath should be rejected with 400');
    assert.match(noPathRes.json.error, /localPath is required/u, 'missing localPath should explain the requirement');

    const unknownSessionRes = await request(port, 'POST', '/api/sessions/no-such-session/assets', {
      localPath: chartPath,
    });
    assert.equal(unknownSessionRes.status, 404, 'an unknown session should be rejected with 404');

    const noAuthRes = await request(port, 'POST', `/api/sessions/${sessionId}/assets`, {
      localPath: chartPath,
    }, { Cookie: 'session_token=not-a-valid-session' });
    assert.equal(noAuthRes.status, 401, 'an invalid session cookie should be rejected with 401');
  } finally {
    await stopServer(chatServer);
    rmSync(home, { recursive: true, force: true });
  }

  console.log('test-http-session-asset-registration: ok');
} catch (error) {
  console.error(error);
  process.exit(1);
}
