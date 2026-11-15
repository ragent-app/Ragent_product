#!/usr/bin/env node
// Browser regression for the project picker: summary label, toggle, and
// Escape/pointerdown close behavior. Locks the behavior that the shared
// workspace-picker infrastructure (document handlers, syncProjectUi) provides
// so the dead-workspace cleanup cannot regress it.
import assert from 'assert/strict';
import { createHmac } from 'crypto';
import { chromium } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const cookie = 'session_token=test-session';
const PROJECT_ID = 'prj_a1b2c3d4e5f60718293a4b5c';
const PROJECT_NAME = 'Picker Fixture Project';
const SHARED_PROJECT_NAME = 'Shared Follow-up Project';
const AUTH_SESSION_SECRET = 'picker-test-session-secret';

function randomPort() {
  return 43000 + Math.floor(Math.random() * 10000);
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function appendOutput(buffer, chunk, limit = 8000) {
  const next = `${buffer}${chunk}`;
  return next.length <= limit ? next : next.slice(-limit);
}
function formatStartupOutput(stdout, stderr) {
  const sections = [];
  if (stderr.trim()) sections.push(`stderr:\n${stderr.trim()}`);
  if (stdout.trim()) sections.push(`stdout:\n${stdout.trim()}`);
  return sections.join('\n\n');
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
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}), ...extraHeaders },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: data }));
      },
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function setupTempHome(projectRootPath) {
  const home = mkdtempSync(join(tmpdir(), 'ragent-picker-'));
  const configDir = join(home, '.config', 'ragent');
  const binDir = join(home, 'bin');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });

  writeFileSync(join(configDir, 'auth.json'), JSON.stringify({
    token: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  }, null, 2), 'utf8');
  writeFileSync(join(configDir, 'auth-sessions.json'), JSON.stringify({
    [`s${createHmac('sha256', AUTH_SESSION_SECRET).update('test-session').digest('hex')}`]: {
      expiry: Date.now() + 60 * 60 * 1000,
      role: 'owner',
    },
  }, null, 2), 'utf8');

  const now = new Date().toISOString();
  writeFileSync(join(configDir, 'chat-projects.json'), JSON.stringify({
    schemaVersion: 1,
    projects: [
      { id: PROJECT_ID, name: PROJECT_NAME, rootPath: projectRootPath, createdAt: now, updatedAt: now },
    ],
  }, null, 2), 'utf8');

  return { home, binDir };
}

async function startServer({ home, binDir, port }) {
  const configDir = join(home, '.config', 'ragent');
  const child = spawn(process.execPath, ['chat-server.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      RAGENT_RUNNER_SUPERVISOR_SOCKET: "",
      RAGENT_RUNNER_SUPERVISOR_REQUIRED: "",
      HOME: home,
      PATH: `${binDir}:${process.env.PATH || ''}`,
      CHAT_PORT: String(port),
      RAGENT_INSTANCE_ROOT: '',
      RAGENT_CONFIG_DIR: configDir,
      RAGENT_AUTH_SESSION_SECRET: AUTH_SESSION_SECRET,
      RAGENT_MEMORY_DIR: join(home, '.ragent', 'memory'),
      SECURE_COOKIES: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => { stdout = appendOutput(stdout, chunk); });
  child.stderr?.on('data', (chunk) => { stderr = appendOutput(stderr, chunk); });

  await waitFor(async () => {
    if (child.exitCode !== null || child.signalCode !== null) {
      const exitLabel = child.signalCode ? `signal ${child.signalCode}` : `code ${child.exitCode}`;
      throw new Error(`Server exited during startup with ${exitLabel}\n${formatStartupOutput(stdout, stderr)}`);
    }
    try {
      const res = await request(port, 'GET', '/login', null, { Cookie: '' });
      return res.status === 200;
    } catch {
      return false;
    }
  }, 'server startup');

  return {
    child,
    stop() {
      child.kill('SIGTERM');
    },
  };
}

async function main() {
  const projectRoot = mkdtempSync(join(tmpdir(), 'ragent-picker-root-'));
  const { home, binDir } = setupTempHome(projectRoot);
  const port = randomPort();
  const server = await startServer({ home, binDir, port });
  const browser = await chromium.launch({ headless: true });

  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addCookies([{ name: 'session_token', value: 'test-session', domain: '127.0.0.1', path: '/' }]);
    const page = await context.newPage();

    const consoleErrors = [];
    const httpErrors = [];
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', (err) => { consoleErrors.push(String(err)); });
    page.on('response', (response) => {
      if (response.status() >= 400) httpErrors.push(`${response.status()} ${response.url()}`);
    });

    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });

    // Project catalog loads async; the picker must reflect the active project.
    // (Assert via the has-no-project class so it does not depend on i18n
    // translations, which are not bundled in this fixture.)
    try {
      await waitFor(async () => page.evaluate(() => {
        const picker = document.getElementById('workspacePicker');
        return !!picker && !picker.classList.contains('has-no-project');
      }), 'project picker to reflect the active project');
    } catch (error) {
      const diagnostics = await page.evaluate(async () => {
        const projectResponse = await fetch('/api/projects', { credentials: 'same-origin' });
        return {
          url: location.href,
          title: document.title,
          bodyText: document.body?.innerText?.slice(0, 500),
          projectStatus: projectResponse.status,
          projectBody: await projectResponse.text(),
          pickerClass: document.getElementById('workspacePicker')?.className || '',
        };
      });
      error.message += `\nBrowser diagnostics: ${JSON.stringify(diagnostics)}\nConsole errors: ${JSON.stringify(consoleErrors)}`;
      throw error;
    }

    // The selected folder already has a project. Creating another logical
    // project for that same workspace must create a new catalog identity and
    // select it instead of treating the request as a duplicate.
    await page.click('#newSessionBtn');
    await waitFor(async () => page.evaluate(() => {
      const dialog = document.querySelector('.project-create-dialog');
      return !!dialog && dialog.hidden === false;
    }), 'project create dialog to open');
    await page.fill('#projectCreateName', SHARED_PROJECT_NAME);
    await page.click('#projectCreateConfirm');
    const createdProjectState = await waitFor(async () => page.evaluate((rootPath) => {
      const projects = window.ragentGetProjects?.() || [];
      const sharedProjects = projects.filter((project) => project.rootPath === rootPath);
      const active = window.ragentGetSelectedProject?.();
      return sharedProjects.length === 2 && active?.name === 'Shared Follow-up Project'
        ? {
            ids: sharedProjects.map((project) => project.id),
            activeName: active.name,
          }
        : null;
    }, projectRoot), 'second project to be created in the existing workspace');
    assert.equal(new Set(createdProjectState.ids).size, 2,
      'shared-workspace projects should have independent ids in the browser catalog');
    assert.equal(createdProjectState.activeName, SHARED_PROJECT_NAME,
      'the newly created shared-workspace project should become active');

    const popoverState = async () => page.evaluate(() => document.getElementById('workspacePopover')?.hidden);

    // Popover starts collapsed.
    assert.equal(await popoverState(), true, 'project popover should be hidden initially');

    // Summary button opens the popover.
    await page.evaluate(() => document.getElementById('workspaceSummaryButton')?.click());
    await waitFor(async () => (await popoverState()) === false, 'popover to open after summary click');

    // Escape collapses it (document capture handler -> ragentCloseProjectPicker).
    await page.keyboard.press('Escape');
    await waitFor(async () => (await popoverState()) === true, 'popover to close on Escape');

    // Reopen, then a pointerdown outside collapses it.
    await page.evaluate(() => document.getElementById('workspaceSummaryButton')?.click());
    await waitFor(async () => (await popoverState()) === false, 'popover to reopen');
    await page.mouse.click(10, 10);
    await waitFor(async () => (await popoverState()) === true, 'popover to close on outside pointerdown');

    const unexpectedConsoleErrors = consoleErrors.filter((message) => message !== 'Failed to load resource: the server responded with a status of 404 (Not Found)');
    const unexpectedHttpErrors = httpErrors.filter((entry) => !entry.endsWith('/api/device'));
    assert.deepEqual(
      [...unexpectedConsoleErrors, ...unexpectedHttpErrors],
      [],
      `chat page should log no unexpected errors during picker interaction: ${JSON.stringify({ consoleErrors, httpErrors })}`,
    );

    console.log('test-chat-project-picker: ok');
  } finally {
    await browser.close();
    server.stop();
    rmSync(home, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
