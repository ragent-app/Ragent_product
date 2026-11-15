#!/usr/bin/env node
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const authSessionToken = 'runtime-provider-browser-session';
const cookie = `session_token=${authSessionToken}`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, description, timeoutMs = 15_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return;
    await sleep(50);
  }
  throw new Error(`Timed out: ${description}`);
}

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
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch {}
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function setupTempHome() {
  const home = mkdtempSync(join(tmpdir(), 'ragent-runtime-provider-browser-'));
  const configDir = join(home, '.config', 'ragent');
  const nativeRuntimeDir = join(configDir, 'native-provider-runtime');
  const secretsDir = join(nativeRuntimeDir, 'secrets');
  const binDir = join(home, '.local', 'bin');
  mkdirSync(secretsDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });

  writeFileSync(join(configDir, 'auth.json'), JSON.stringify({
    token: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  }), 'utf8');
  writeFileSync(join(configDir, 'auth-sessions.json'), JSON.stringify({
    [authSessionToken]: { expiry: Date.now() + 60 * 60 * 1000, role: 'owner' },
  }), 'utf8');

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
  writeFileSync(join(binDir, 'codex'), '#!/bin/sh\nexit 0\n', 'utf8');
  chmodSync(join(binDir, 'codex'), 0o755);
  return { home, configDir, binDir };
}

async function startServer({ home, configDir, binDir, port }) {
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
      RAGENT_AUTH_SESSION_SECRET: 'test-secret-runtime-provider-browser',
      RAGENT_PROVIDER_HOMES_DIR: join(home, '.config', 'provider-homes'),
      RAGENT_RUNNER_SUPERVISOR_SOCKET: '',
      RAGENT_RUNNER_SUPERVISOR_REQUIRED: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => { output = `${output}${chunk}`.slice(-8000); });
  child.stderr?.on('data', (chunk) => { output = `${output}${chunk}`.slice(-8000); });
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`Server exited during startup: ${output}`);
    try { return (await request(port, 'GET', '/api/auth/me')).status === 200; } catch { return false; }
  }, 'server startup');
  return child;
}

async function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await waitFor(() => child.exitCode !== null || child.signalCode !== null, 'server shutdown');
}

async function createSession(port, name, model = 'gpt-current') {
  const response = await request(port, 'POST', '/api/sessions', {
    folder: repoRoot,
    tool: 'codex',
    providerProfile: 'codex-current',
    model,
    name,
  });
  assert.equal(response.status, 201, response.text);
  assert.equal(response.json.session.providerProfile, 'codex-current');
  assert.equal(response.json.session.model, model);
  return response.json.session;
}

async function openProviderView(page) {
  const composer = page.locator('#inputArea');
  if (await composer.evaluate((element) => element.classList.contains('composer-collapsed'))) {
    await page.locator('#inputArea .input-actions-row').click({ position: { x: 360, y: 20 } });
    await waitFor(async () => (await composer.evaluate((element) => element.classList.contains('composer-expanded'))), 'composer expansion');
  }
  await page.locator('#composerRuntimeBtn').click();
  await waitFor(async () => (await page.locator('#composerRuntimeToolOptions button').count()) > 0, 'runtime tool rows');
  await page.locator('#composerRuntimeToolOptions button').filter({ hasText: 'CodeX' }).click();
  await waitFor(async () => (await page.locator('#composerRuntimeProviderOptions button').count()) === 2, 'runtime Provider rows');
}

async function openSession(page, sessionId) {
  const sessionRow = page.locator(`[data-session-id="${sessionId}"]`).first();
  await sessionRow.click();
  await waitFor(
    async () => (await page.locator(`[data-session-id="${sessionId}"].active`).count()) > 0,
    `session ${sessionId} attached`,
  );
  await waitFor(async () => (await page.locator('#imgBtn:not([disabled])').count()) === 1, `session ${sessionId} composer`);
}

function runtimeMenuGeometry(page) {
  return page.evaluate(() => {
    const panel = document.getElementById('composerRuntimeMenu');
    const anchor = document.getElementById('composerRuntimeBtn');
    const panelRect = panel.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    return {
      panel: {
        top: panelRect.top,
        right: panelRect.right,
        bottom: panelRect.bottom,
        left: panelRect.left,
        width: panelRect.width,
        height: panelRect.height,
      },
      anchor: { top: anchorRect.top, bottom: anchorRect.bottom },
      viewport: { width: innerWidth, height: innerHeight },
    };
  });
}

const fixture = setupTempHome();
const port = await getAvailablePort();
let server = null;
let browser = null;
let context = null;
let page = null;
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outputDir = process.env.RAGENT_VISUAL_OUTPUT_DIR
  || join(tmpdir(), 'ragent-runtime-provider-visual', stamp);
mkdirSync(outputDir, { recursive: true });

try {
  server = await startServer({ ...fixture, port });
  const sessionA = await createSession(port, 'Provider panel A');
  const sessionB = await createSession(port, 'Provider panel B');

  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addCookies([{ name: 'session_token', value: authSessionToken, domain: '127.0.0.1', path: '/' }]);
  page = await context.newPage();
  const browserDiagnostics = [];
  page.on('console', (message) => {
    if (message.type() === 'error') browserDiagnostics.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => browserDiagnostics.push(`pageerror: ${error.message}`));
  page.on('response', (response) => {
    if (response.status() >= 400) browserDiagnostics.push(`http ${response.status()}: ${response.url()}`);
  });
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });

  try {
    await waitFor(async () => (await page.locator(`[data-session-id="${sessionA.id}"]`).count()) > 0, 'session A in sidebar');
  } catch (error) {
    const diagnostics = await page.evaluate(async () => ({
      bodyText: document.body?.innerText?.slice(0, 600),
      sessionApi: await fetch('/api/sessions').then(async (response) => ({ status: response.status, text: await response.text() })).catch((cause) => ({ error: String(cause) })),
      sessionRows: [...document.querySelectorAll('[data-session-id]')].map((node) => node.getAttribute('data-session-id')),
    }));
    error.message += `\nBrowser diagnostics: ${JSON.stringify({ diagnostics, browserDiagnostics })}`;
    throw error;
  }
  await openSession(page, sessionA.id);
  assert.equal(await page.locator('#composerProviderMenuItem').count(), 0, 'the add menu should not expose Provider');

  await openProviderView(page);
  const desktop = await runtimeMenuGeometry(page);
  assert.ok(desktop.panel.bottom <= desktop.anchor.top + 1, `desktop runtime menu should open above the composer: ${JSON.stringify(desktop)}`);
  assert.ok(desktop.panel.right <= desktop.viewport.width, `desktop runtime menu should stay inside the viewport: ${JSON.stringify(desktop)}`);
  assert.ok(desktop.panel.left >= 0, `desktop runtime menu should not overflow left: ${JSON.stringify(desktop)}`);
  await page.screenshot({ path: join(outputDir, 'runtime-provider-desktop.png'), fullPage: false });

  const selectedA = await page.locator('#composerRuntimeProviderOptions button[aria-checked="true"]').textContent();
  assert.match(selectedA || '', /Current account/);
  await page.evaluate(() => {
    // Simulate a post-PATCH session projection failure. The Provider change
    // must still be confirmed from durable server state by the picker.
    window.__providerPickerOriginalGoalChip = window.updateGoalChip;
    window.updateGoalChip = () => { throw new Error('simulated projection failure'); };
  });
  await page.locator('#composerRuntimeProviderOptions button').filter({ hasText: 'Secondary account' }).click();
  await waitFor(async () => (await request(port, 'GET', `/api/sessions/${sessionA.id}`)).json?.session?.providerProfile === 'codex-secondary', 'session A Provider persistence');
  await waitFor(async () => (await page.locator('#composerRuntimeProviderStatus').textContent()) === '', 'Provider selection status should settle after durable persistence');
  await page.evaluate(() => {
    window.updateGoalChip = window.__providerPickerOriginalGoalChip;
    delete window.__providerPickerOriginalGoalChip;
  });
  await page.keyboard.press('Escape');

  await openSession(page, sessionB.id);
  await openProviderView(page);
  const selectedB = await page.locator('#composerRuntimeProviderOptions button[aria-checked="true"]').textContent();
  assert.match(selectedB || '', /Current account/, 'session B should restore its own Provider selection');
  await page.keyboard.press('Escape');

  await openSession(page, sessionA.id);
  await openProviderView(page);
  const selectedARestored = await page.locator('#composerRuntimeProviderOptions button[aria-checked="true"]').textContent();
  assert.match(selectedARestored || '', /Secondary account/, 'session A should restore its changed Provider selection');
  await page.keyboard.press('Escape');

  await page.setViewportSize({ width: 390, height: 844 });
  await openProviderView(page);
  const mobile = await runtimeMenuGeometry(page);
  assert.ok(mobile.panel.bottom <= mobile.anchor.top + 1, `mobile runtime menu should open above the composer: ${JSON.stringify(mobile)}`);
  assert.ok(mobile.panel.left >= 0 && mobile.panel.right <= mobile.viewport.width, 'mobile runtime sheet should fit the viewport');
  assert.ok(mobile.panel.height > 0 && mobile.panel.height < mobile.viewport.height, 'mobile runtime sheet should leave the chat surface visible');
  await page.screenshot({ path: join(outputDir, 'runtime-provider-mobile.png'), fullPage: false });

  for (const filename of ['runtime-provider-desktop.png', 'runtime-provider-mobile.png']) {
    const path = join(outputDir, filename);
    assert.ok(statSync(path).size > 0, `${filename} should be non-empty`);
  }

  console.log(`test-chat-session-provider-panel-browser: ok (${outputDir})`);
} finally {
  await page?.close().catch(() => {});
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  await stopServer(server).catch(() => {});
  rmSync(fixture.home, { recursive: true, force: true });
}
