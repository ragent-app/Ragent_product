// Shared helpers for the DS-37 benchmark harness.
// Every server instance runs against a throwaway mkdtemp HOME + configDir
// (clean instance): no real config, no real provider, no real history.
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { spawn } from 'child_process';
import WebSocket from 'ws';

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = dirname(dirname(here));
export const FAKE_PROVIDER_SOURCE = join(here, 'fake-provider.mjs');

export const COOKIE = 'session_token=test-session';
export const AUTH_TOKEN = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
export const TEMP_PREFIX = 'ragent-bench-';

export function randomPort() {
  return 33000 + Math.floor(Math.random() * 10000);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(predicate, description, timeoutMs = 10000, intervalMs = 100) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out: ${description}`);
}

export function request(port, method, path, body = null, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          Cookie: COOKIE,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...extraHeaders,
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
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// Writes the repo fake provider into the clean instance's localBin as the
// `fake-codex` binary so the harness and the deployed copy are identical.
export function installFakeProvider(localBin) {
  const source = readFileSync(FAKE_PROVIDER_SOURCE, 'utf8');
  const target = join(localBin, 'fake-codex');
  writeFileSync(target, source, { mode: 0o755 });
  chmodSync(target, 0o755);
  return target;
}

export function setupTempHome() {
  const home = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  const configDir = join(home, '.config', 'ragent');
  const localBin = join(home, '.local', 'bin');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(localBin, { recursive: true });

  writeFileSync(
    join(configDir, 'auth.json'),
    JSON.stringify({ token: AUTH_TOKEN }, null, 2),
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
  installFakeProvider(localBin);
  return { home, configDir, localBin };
}

export async function startServer({ home, port, envOverrides = {} }) {
  const configDir = join(home, '.config', 'ragent');
  const localBin = join(home, '.local', 'bin');
  const child = spawn(process.execPath, ['chat-server.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      RAGENT_RUNNER_SUPERVISOR_SOCKET: '',
      RAGENT_RUNNER_SUPERVISOR_REQUIRED: '',
      RAGENT_RUNNER_LIFECYCLE_SOCKET: '',
      RAGENT_RUNNER_LIFECYCLE_REQUIRED: '',
      RAGENT_RUNNER_UNIT_NAME: '',
      RAGENT_RUNNER_UNIT_SCOPE: '',
      HOME: home,
      CHAT_PORT: String(port),
      RAGENT_CHAT_BASE_URL: `http://127.0.0.1:${port}`,
      RAGENT_INSTANCE_ROOT: '',
      RAGENT_CONFIG_DIR: configDir,
      // Synthetic session-secret for the throwaway instance only: without it
      // lib/auth.mjs refuses to load auth-sessions.json and the cookie
      // session never authenticates. Never used against a real instance.
      RAGENT_AUTH_SESSION_SECRET: 'benchmark-harness-synthetic-secret',
      SECURE_COOKIES: '0',
      RAGENT_REPLY_SELF_CHECK: 'off',
      PATH: `${localBin}:${process.env.PATH || ''}`,
      ...envOverrides,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  await waitFor(async () => {
    try {
      const res = await request(port, 'GET', '/api/auth/me');
      return res.status === 200;
    } catch {
      return false;
    }
  }, 'server startup');

  return { child, pid: child.pid, getStdout: () => stdout, getStderr: () => stderr };
}

export async function stopServer(server) {
  if (!server?.child || server.child.exitCode !== null) return;
  server.child.kill('SIGTERM');
  await waitFor(() => server.child.exitCode !== null, 'server shutdown');
  await sleep(150);
}

export function wsConnect(port) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: COOKIE } });
    socket.on('open', () => resolve(socket));
    socket.on('error', reject);
  });
}

// Linux /proc RSS sample in bytes; returns null when unavailable.
export function sampleRssBytes(pid) {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const match = status.match(/^VmRSS:\s+(\d+) kB$/m);
    return match ? Number(match[1]) * 1024 : null;
  } catch {
    return null;
  }
}

export function dirBytes(root) {
  const result = { bytes: 0, files: 0 };
  if (!root) return result;
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        try {
          result.bytes += statSync(full).size;
          result.files += 1;
        } catch {}
      }
    }
  };
  walk(root);
  return result;
}

export function percentiles(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const pick = (ratio) => {
    if (sorted.length === 0) return null;
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(ratio * sorted.length) - 1));
    return sorted[index];
  };
  return { n: sorted.length, p50: pick(0.5), p95: pick(0.95), min: sorted[0] ?? null, max: sorted[sorted.length - 1] ?? null };
}

export async function createSession(port, { name = 'Bench', group = 'Benchmarks', description = 'DS-37 harness' } = {}) {
  const res = await request(port, 'POST', '/api/sessions', {
    folder: repoRoot,
    tool: 'fake-codex',
    name,
    group,
    description,
  });
  if (res.status !== 201) {
    throw new Error(`create session failed: ${res.status} ${String(res.text || '').slice(0, 300)}`);
  }
  return res.json.session;
}

export async function submitMessage(port, sessionId, requestId, text = 'Run the fake tool') {
  const res = await request(port, 'POST', `/api/sessions/${sessionId}/messages`, {
    requestId,
    text,
    tool: 'fake-codex',
    model: 'fake-model',
    effort: 'low',
  });
  if (res.status !== 202 && res.status !== 200) {
    throw new Error(`submit message failed: ${res.status} ${String(res.text || '').slice(0, 300)}`);
  }
  if (!res.json?.run?.id) {
    throw new Error(`submit message did not return a run id (duplicate=${res.json?.duplicate})`);
  }
  return res.json;
}

export async function waitForRunTerminal(port, runId) {
  return waitFor(async () => {
    const res = await request(port, 'GET', `/api/runs/${runId}`);
    if (res.status !== 200) return false;
    if (!['completed', 'failed', 'cancelled'].includes(res.json.run.state)) return false;
    return res.json.run;
  }, `run ${runId} terminal`, 120000);
}

export async function getEvents(port, sessionId, filter = 'all') {
  const res = await request(port, 'GET', `/api/sessions/${sessionId}/events?filter=${encodeURIComponent(filter)}`);
  if (res.status !== 200) {
    throw new Error(`events request failed: ${res.status} ${String(res.text || '').slice(0, 300)}`);
  }
  return res.json.events || [];
}

export function removeTempHome(home) {
  rmSync(home, { recursive: true, force: true });
}
