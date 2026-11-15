#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const authSessionToken = 'provider-profile-test-session';
const cookie = `session_token=${authSessionToken}`;

function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, description, timeoutMs = 10_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return;
    await sleep(50);
  }
  throw new Error(`Timed out: ${description}`);
}

function request(port, method, path, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        Cookie: cookie,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch {}
        resolve({ status: res.statusCode, json, text: data });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function setupTempHome() {
  const home = mkdtempSync(join(tmpdir(), 'ragent-provider-profile-isolation-'));
  const configDir = join(home, '.config', 'ragent');
  const binDir = join(home, '.local', 'bin');
  const nativeRuntimeDir = join(configDir, 'native-provider-runtime');
  const secretsDir = join(nativeRuntimeDir, 'secrets');
  mkdirSync(secretsDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(configDir, 'auth.json'), JSON.stringify({
    token: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  }));
  writeFileSync(join(configDir, 'auth-sessions.json'), JSON.stringify({
    [authSessionToken]: { expiry: Date.now() + 60 * 60 * 1000, role: 'owner' },
  }));

  writeFileSync(join(nativeRuntimeDir, 'providers.json'), JSON.stringify({
    version: 1,
    profiles: [
      {
        id: 'codex-current', agentType: 'codex', protocol: 'openai-responses',
        displayName: 'Current account', baseUrl: 'https://api.example.test/v1',
        authProfileId: 'auth-codex-current', modelPolicy: { defaultModel: 'gpt-current' },
      },
      {
        id: 'codex-secondary', agentType: 'codex', protocol: 'openai-responses',
        displayName: 'Secondary account', baseUrl: 'https://api.example.test/v1',
        authProfileId: 'auth-codex-secondary', modelPolicy: { defaultModel: 'gpt-secondary' },
      },
    ],
  }, null, 2));
  writeFileSync(join(nativeRuntimeDir, 'auth-profiles.json'), JSON.stringify({
    version: 1,
    profiles: [
      { id: 'auth-codex-current', agentType: 'codex', authType: 'api-key', displayName: 'Current account', storageType: 'secret-store', storageRef: 'secret-codex-current' },
      { id: 'auth-codex-secondary', agentType: 'codex', authType: 'api-key', displayName: 'Secondary account', storageType: 'secret-store', storageRef: 'secret-codex-secondary' },
    ],
  }, null, 2));
  writeFileSync(join(secretsDir, 'secret-codex-current.json'), JSON.stringify({ authType: 'api-key', apiKey: 'test-only-current' }));
  writeFileSync(join(secretsDir, 'secret-codex-secondary.json'), JSON.stringify({ authType: 'api-key', apiKey: 'test-only-secondary' }));
  writeFileSync(join(binDir, 'codex'), '#!/bin/sh\nexit 0\n');
  return { home, configDir, binDir };
}

async function startServer({ home, configDir, binDir, port }) {
  chmodSync(join(binDir, 'codex'), 0o755);
  const child = spawn(process.execPath, ['chat-server.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      PATH: `${binDir}:${process.env.PATH || ''}`,
      CHAT_PORT: String(port),
      SECURE_COOKIES: '0',
      RAGENT_CONFIG_DIR: configDir,
      RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES: '1',
      RAGENT_AUTH_SESSION_SECRET: 'test-secret-provider-profile-isolation',
      RAGENT_PROVIDER_HOMES_DIR: join(configDir, 'provider-homes'),
      RAGENT_RUNNER_SUPERVISOR_SOCKET: '',
      RAGENT_RUNNER_SUPERVISOR_REQUIRED: '',
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  await waitFor(async () => {
    if (child.exitCode !== null) {
      throw new Error(`Server exited during startup with code ${child.exitCode}`);
    }
    try { return (await request(port, 'GET', '/api/auth/me')).status === 200; } catch { return false; }
  }, 'server startup');
  return child;
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await waitFor(() => child.exitCode !== null, 'server shutdown');
}

async function createSession(port, name) {
  const response = await request(port, 'POST', '/api/sessions', {
    folder: repoRoot,
    tool: 'codex',
    providerProfile: 'codex-current',
    name,
  });
  assert.equal(response.status, 201, response.text);
  return response.json.session;
}

const fixture = setupTempHome();
const port = await getAvailablePort();
const server = await startServer({ ...fixture, port });

try {
  const sessionA = await createSession(port, 'Provider A');
  const sessionB = await createSession(port, 'Provider B');
  assert.equal(sessionA.providerProfile, 'codex-current');
  assert.equal(sessionB.providerProfile, 'codex-current');

  const switched = await request(port, 'PATCH', `/api/sessions/${sessionA.id}`, {
    providerProfile: 'codex-secondary',
  });
  assert.equal(switched.status, 200, switched.text);
  assert.equal(switched.json.session.providerProfile, 'codex-secondary');
  assert.equal(switched.json.session.model, undefined, 'Provider change should clear a stale model even without a UI model patch');

  const restoredA = await request(port, 'GET', `/api/sessions/${sessionA.id}`);
  const restoredB = await request(port, 'GET', `/api/sessions/${sessionB.id}`);
  assert.equal(restoredA.json.session.providerProfile, 'codex-secondary');
  assert.equal(restoredB.json.session.providerProfile, 'codex-current', 'another session must keep its own Provider');

  const sessionC = await createSession(port, 'Provider C');
  assert.equal(sessionC.providerProfile, 'codex-current', 'a new session with an explicit Native provider should use that provider');

  const invalid = await request(port, 'PATCH', `/api/sessions/${sessionB.id}`, {
    providerProfile: 'missing-provider',
  });
  assert.equal(invalid.status, 400);
  assert.match(invalid.json.error, /provider does not exist/i);

  console.log('test-http-session-provider-profile-isolation: ok');
} finally {
  await stopServer(server);
  rmSync(fixture.home, { recursive: true, force: true });
}
