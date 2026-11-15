#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { createHmac } from 'crypto';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const cookie = 'session_token=test-session';
const sessionSecret = 'workspace-readable-test-session-secret';

function randomPort() {
  return 43000 + Math.floor(Math.random() * 2000);
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
        ...(body && !(body instanceof Buffer) ? { 'Content-Type': 'application/json' } : {}),
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
    if (body) {
      if (body instanceof Buffer) req.write(body);
      else req.write(JSON.stringify(body));
    }
    req.end();
  });
}

function setupTempHome() {
  const home = mkdtempSync(join(tmpdir(), 'ragent-workspace-readable-'));
  const configDir = join(home, '.config', 'ragent');
  const localBin = join(home, '.local', 'bin');
  const workspaceDir = join(home, 'workspace');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(localBin, { recursive: true });
  mkdirSync(join(workspaceDir, 'docs', 'nested'), { recursive: true });
  mkdirSync(join(workspaceDir, 'empty-folder'), { recursive: true });
  mkdirSync(join(workspaceDir, 'node_modules'), { recursive: true });

  writeFileSync(join(workspaceDir, 'README.md'), '# Workspace\n\nReadable markdown.', 'utf8');
  writeFileSync(join(workspaceDir, 'docs', 'manual.markdown'), '## Manual\n\nDetails.', 'utf8');
  writeFileSync(join(workspaceDir, 'docs', 'index.pdf'), Buffer.from('%PDF-1.4\n% Ragent test\n'));
  writeFileSync(join(workspaceDir, 'notes.txt'), 'not a reader file', 'utf8');
  writeFileSync(join(workspaceDir, 'node_modules', 'ignored.md'), '# ignored', 'utf8');

  writeFileSync(
    join(configDir, 'auth.json'),
    JSON.stringify({ token: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' }, null, 2),
    'utf8',
  );
  writeFileSync(
    join(configDir, 'auth-sessions.json'),
    JSON.stringify({
      [`s${createHmac('sha256', sessionSecret).update('test-session').digest('hex')}`]: { expiry: Date.now() + 60 * 60 * 1000, role: 'owner' },
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
  writeFileSync(
    join(localBin, 'fake-codex'),
    '#!/usr/bin/env node\nconsole.log(JSON.stringify({type:"turn.completed"}));\n',
    'utf8',
  );
  chmodSync(join(localBin, 'fake-codex'), 0o755);
  return { home, configDir, localBin, workspaceDir };
}

async function startServer({ home, configDir, localBin, port }) {
  const child = spawn(process.execPath, ['chat-server.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      RAGENT_RUNNER_SUPERVISOR_SOCKET: "",
      RAGENT_RUNNER_SUPERVISOR_REQUIRED: "",
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ''}`,
      CHAT_PORT: String(port),
      RAGENT_INSTANCE_ROOT: '',
      RAGENT_CONFIG_DIR: configDir,
      RAGENT_AUTH_SESSION_SECRET: sessionSecret,
      RAGENT_MEMORY_DIR: join(home, '.ragent', 'memory'),
      RAGENT_WORK_ROOT_DIR: join(home, '.ragent', 'workspace'),
      RAGENT_DISABLE_SYSTEMD_DETACHED_RUNNER: '1',
      SECURE_COOKIES: '0',
      RAGENT_ASSET_STORAGE_BASE_URL: '',
      RAGENT_ASSET_STORAGE_PUBLIC_BASE_URL: '',
      RAGENT_ASSET_STORAGE_PROVIDER: '',
      RAGENT_ASSET_STORAGE_REGION: '',
      RAGENT_ASSET_STORAGE_ACCESS_KEY_ID: '',
      RAGENT_ASSET_STORAGE_SECRET_ACCESS_KEY: '',
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

const { home, configDir, localBin, workspaceDir } = setupTempHome();
const port = randomPort();
const server = await startServer({ home, configDir, localBin, port });

try {
  const createSessionRes = await request(port, 'POST', '/api/sessions', {
    folder: workspaceDir,
    tool: 'fake-codex',
    name: 'Readable workspace',
  });
  assert.equal(createSessionRes.status, 201, 'session should be created');
  const sessionId = createSessionRes.json.session.id;

  const listRes = await request(port, 'GET', `/api/workspace-files?sessionId=${encodeURIComponent(sessionId)}`);
  assert.equal(listRes.status, 200, 'workspace file list should load');
  const paths = listRes.json.files.map((file) => file.path).sort();
  assert.deepEqual(
    paths,
    ['README.md', 'docs/index.pdf', 'docs/manual.markdown'],
    'workspace file list should include only supported readable files and skip dependency folders',
  );
  assert.equal(listRes.json.files.find((file) => file.path === 'docs/index.pdf')?.kind, 'pdf', 'PDF files should be typed for the reader');
  assert.deepEqual(
    listRes.json.directories.map((directory) => directory.path).sort(),
    ['docs', 'docs/nested', 'empty-folder'],
    'workspace file list should include workspace subfolders, including folders without readable files',
  );

  const workspaceListRes = await request(port, 'GET', `/api/workspace-files?workspace=${encodeURIComponent(workspaceDir)}`);
  assert.equal(workspaceListRes.status, 200, 'workspace-scoped file list should load without a session id');
  assert.equal(workspaceListRes.json.workspace, workspaceDir, 'workspace-scoped file list should be keyed by workspace folder');
  assert.equal(workspaceListRes.json.sessionId, undefined, 'workspace-scoped file list should not be tied to a session');
  assert.deepEqual(
    workspaceListRes.json.files.map((file) => file.path).sort(),
    paths,
    'workspace-scoped file list should match the session folder list',
  );
  assert.deepEqual(
    workspaceListRes.json.directories.map((directory) => directory.path).sort(),
    ['docs', 'docs/nested', 'empty-folder'],
    'workspace-scoped file list should include the same folder tree',
  );

  const markdownRes = await request(port, 'GET', `/api/workspace-files/content?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent('README.md')}`);
  assert.equal(markdownRes.status, 200, 'markdown content should stream');
  assert.match(markdownRes.headers['content-type'] || '', /^text\/markdown/u, 'markdown content should use markdown content type');
  assert.match(markdownRes.headers['content-disposition'] || '', /^inline;/u, 'markdown preview should default to inline disposition');
  assert.equal(markdownRes.text, '# Workspace\n\nReadable markdown.', 'markdown content should match the workspace file');

  const absoluteRes = await request(port, 'GET', `/api/workspace-files/content?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(join(workspaceDir, 'README.md'))}`);
  assert.equal(absoluteRes.status, 200, 'absolute files within the session workspace should stream');
  assert.equal(absoluteRes.text, markdownRes.text);

  const pdfRes = await request(port, 'GET', `/api/workspace-files/content?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent('docs/index.pdf')}`);
  assert.equal(pdfRes.status, 200, 'PDF content should stream');
  assert.match(pdfRes.headers['content-type'] || '', /^application\/pdf/u, 'PDF content should use PDF content type');
  assert.equal(pdfRes.buffer.subarray(0, 5).toString('utf8'), '%PDF-', 'PDF content should match the workspace file');

  const workspaceMarkdownRes = await request(port, 'GET', `/api/workspace-files/content?workspace=${encodeURIComponent(workspaceDir)}&path=${encodeURIComponent('docs/manual.markdown')}`);
  assert.equal(workspaceMarkdownRes.status, 200, 'workspace-scoped markdown content should stream');
  assert.equal(workspaceMarkdownRes.text, '## Manual\n\nDetails.', 'workspace-scoped markdown content should match the workspace file');

  const escapeRes = await request(port, 'GET', `/api/workspace-files/content?workspace=${encodeURIComponent(workspaceDir)}&path=${encodeURIComponent('../.config/ragent/auth.json')}`);
  assert.equal(escapeRes.status, 400, 'workspace file reader should reject paths outside the workspace folder');

  writeFileSync(join(home, 'outside.md'), 'outside workspace');
  let symlinkAvailable = true;
  try { symlinkSync(join(home, 'outside.md'), join(workspaceDir, 'link.md'), 'file'); }
  catch (error) {
    if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
    symlinkAvailable = false;
  }
  if (symlinkAvailable) {
    const linkRes = await request(port, 'GET', `/api/workspace-files/content?sessionId=${encodeURIComponent(sessionId)}&path=link.md`);
    assert.equal(linkRes.status, 403, 'workspace file reader should reject links outside the workspace');
  }

  console.log('test-http-workspace-readable-files: ok');
} finally {
  await stopServer(server);
  rmSync(home, { recursive: true, force: true });
}
