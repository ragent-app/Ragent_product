import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { copyFile, cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveWindowsPerUserPaths } from '../lib/windows-runtime-paths.mjs';

if (process.platform !== 'win32') { console.log('windows-cli-read-e2e: skipped (requires Windows)'); process.exit(0); }
const serviceProfile = { LOCALAPPDATA: 'C:\\ProgramData\\Ragent-test-profile\\Local' };
assert.throws(() => resolveWindowsPerUserPaths({ env: serviceProfile }), /LOCALAPPDATA must not be under Windows ProgramData/);
assert.doesNotThrow(() => resolveWindowsPerUserPaths({ env: { ...serviceProfile, RAGENT_WINDOWS_SERVICE_MODE: '1' } }));
const payload = process.env.RAGENT_TEST_INSTALLED_PAYLOAD;
const helper = process.env.RAGENT_TEST_CLI_READ_BINARY;
if (!path.isAbsolute(payload || '') || !path.isAbsolute(helper || '')) throw new Error('installed payload and helper paths required');
const root = await mkdtemp(path.join(os.tmpdir(), 'ragent-cli-read-e2e-'));
let server;
try {
  await mkdir(path.join(root, 'bin'));
  await Promise.all(['node.exe', 'cli.js', 'package.json'].map(file => copyFile(path.join(payload, file), path.join(root, file))));
  await cp(path.join(payload, 'lib'), path.join(root, 'lib'), { recursive: true });
  const exe = path.join(root, 'bin', 'ragent-cli-read-bridge.exe');
  await copyFile(helper, exe);
  let reads = 0, renewals = 0;
  server = createServer((req, res) => {
    const valid = req.headers['x-ragent-session-control-session-id'] === 'session'
      && req.headers['x-ragent-session-control-run-id'] === 'run'
      && req.headers['x-ragent-session-control-turn-id'] === 'turn';
    res.setHeader('Content-Type', 'application/json');
    if (!valid) { res.writeHead(403); res.end('{}'); return; }
    if (req.method === 'POST' && req.url === '/api/internal/session-control/renew'
        && req.headers['x-ragent-session-control-renewal-token'] === 'renewal') {
      renewals++; res.end(JSON.stringify({ sessionControl: { token: 'renewed', runId: 'run', sessionId: 'session', turnId: 'turn' } })); return;
    }
    if (req.method === 'GET' && req.url === '/api/triggers?sessionId=session') {
      reads++;
      if (req.headers['x-ragent-session-control-token'] === 'expired') { res.writeHead(401); res.end('{"code":"SESSION_CONTROL_CAPABILITY_EXPIRED"}'); return; }
      if (req.headers['x-ragent-session-control-token'] === 'renewed') { res.end('{"triggers":[]}'); return; }
    }
    res.writeHead(403); res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const child = spawn(exe, ['trigger-list', base, '--json'], { windowsHide: true, env: { ...process.env,
    RAGENT_SESSION_ID: 'session', RAGENT_SESSION_CONTROL_TOKEN: 'expired', RAGENT_SESSION_CONTROL_RENEWAL_TOKEN: 'renewal',
    RAGENT_SESSION_CONTROL_RUN_ID: 'run', RAGENT_SESSION_CONTROL_SESSION_ID: 'session', RAGENT_SESSION_CONTROL_TURN_ID: 'turn',
    LOCALAPPDATA: path.join(root, 'service-profile', 'Local'), RAGENT_WINDOWS_SERVICE_MODE: '0',
    NODE_OPTIONS: '--require nonexistent-malicious-module', RAGENT_CHAT_BASE_URL: 'http://attacker.invalid', HTTP_PROXY: 'http://attacker.invalid',
  } });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(code, 0, stderr); assert.deepEqual(JSON.parse(stdout), { triggers: [] });
  assert.equal(reads, 2); assert.equal(renewals, 1);
  const help = spawn(exe, ['trigger-help', base], { windowsHide: true, env: { ...process.env,
    RAGENT_SESSION_ID: 'session', RAGENT_SESSION_CONTROL_TOKEN: 'expired',
    RAGENT_SESSION_CONTROL_RUN_ID: 'run', RAGENT_SESSION_CONTROL_SESSION_ID: 'session', RAGENT_SESSION_CONTROL_TURN_ID: 'turn',
    LOCALAPPDATA: path.join(root, 'service-profile', 'Local'), NODE_OPTIONS: '--require nonexistent-malicious-module',
  } });
  let helpOutput = '', helpError = '';
  help.stdout.on('data', data => { helpOutput += data; }); help.stderr.on('data', data => { helpError += data; });
  const helpCode = await new Promise((resolve, reject) => { help.once('error', reject); help.once('close', resolve); });
  assert.equal(helpCode, 0, helpError); assert.match(helpOutput, /(?:ragent|ragent) trigger <command>/);
  assert.equal(reads, 2, 'help must not perform an API request'); assert.equal(renewals, 1);
  console.log('windows-cli-read-e2e: installed CLI, capability renewal and sanitized environment passed');
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  if (path.dirname(path.resolve(root)).toLowerCase() !== path.resolve(os.tmpdir()).toLowerCase() || !path.basename(root).startsWith('ragent-cli-read-e2e-')) throw new Error('unsafe fixture cleanup');
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
