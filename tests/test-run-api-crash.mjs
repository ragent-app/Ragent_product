import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';

const root = process.env.RAGENT_RUN_CRASH_ROOT || await mkdtemp(join(tmpdir(), 'ragent-run-api-crash-'));
process.env.RAGENT_INSTANCE_ROOT = root;
process.env.RAGENT_CONFIG_DIR = join(root, 'config');
process.env.RAGENT_MEMORY_DIR = join(root, 'memory');
const meta = await import('../chat/session-meta-store.mjs');
const runs = await import('../chat/runs.mjs');
const { handleSessionMainRoutes } = await import('../chat/router-session-main-routes.mjs');
const { CHAT_RUNS_DIR } = await import('../lib/config.mjs');
const mode = process.argv[2];
if (mode === 'server') {
  const server = createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, 'http://localhost');
    await handleSessionMainRoutes({ req, res, parsedUrl, pathname: parsedUrl.pathname, authSession: { role: 'owner' },
      requireSessionAccess: async (_res, _auth, _id, options) => { assert.equal(options.metadataOnly, true); return true; },
      writeJson: (_res, status, body) => {
        if (status === 200) process.send({ type: 'durable-before-reply', body });
        else { res.writeHead(status); res.end(JSON.stringify(body)); }
      } });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  process.send({ type: 'listening', port: server.address().port });
} else if (mode === 'cold') {
  const run = await runs.getRunAcceptanceEvidence(process.argv[3]);
  process.stdout.write('COLD_RUN=' + JSON.stringify({ id: run.id, sessionId: run.sessionId, cancelRequested: run.cancelRequested, state: run.state }) + '\n');
} else {
  test('actual HTTP cancellation survives owned process death before any response and cold GET does not dispatch', { timeout: 15000 }, async () => {
    await meta.withSessionsMetaMutation(async (rows, save) => {
      rows.push({ id: 'crash_session', name: 'Crash fixture', folder: root, sessionPlane: 'user', sessionClass: 'ROOT_LEADERSHIP', userAddressable: true });
      await save(rows, { immediate: true, durable: true });
    });
    const run = await runs.createRun({ status: { sessionId: 'crash_session', state: 'running' }, manifest: {} });
    await meta.mutateSessionMeta('crash_session', row => { row.activeRunId = run.id; return true; });
    const context = await meta.readSessionApiContext('crash_session');
    const scope = { version: 1, sessionId: context.sessionId, expectedScopeRevision: context.scopeRevision, expectedProjectId: context.projectId };
    const env = { ...process.env, RAGENT_RUN_CRASH_ROOT: root };
    const child = fork(import.meta.filename, ['server'], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    const signals = []; let wake;
    child.on('message', message => { signals.push(message); wake?.(); });
    async function message(type) {
      const end = Date.now() + 10000;
      while (Date.now() < end) {
        const found = signals.find(item => item.type === type); if (found) return found;
        if (child.exitCode != null) throw new Error(`Fixture exited ${child.exitCode}: ${output}`);
        await new Promise(resolve => { const timer = setTimeout(resolve, 100); wake = () => { clearTimeout(timer); resolve(); }; });
      }
      throw new Error('Timed out waiting for owned crash fixture: ' + type);
    }
    let http;
    try {
      const listening = await message('listening');
      const body = JSON.stringify({ version: 1, expiresAt: new Date(Date.now() + 10000).toISOString() });
      const received = new Promise(resolve => {
        http = request({ hostname: '127.0.0.1', port: listening.port, path: `/api/sessions/crash_session/app-api-runs/${run.id}/cancel`,
          method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
            'x-ragent-app-api-scope': Buffer.from(JSON.stringify(scope)).toString('base64url') } }, response => {
          response.resume(); resolve({ status: response.statusCode });
        });
        http.on('error', error => resolve({ error: error.code })); http.end(body);
      });
      const committed = await message('durable-before-reply');
      assert.equal(committed.body.run.runId, run.id); assert.equal(committed.body.run.cancelRequested, true);
      assert.equal(committed.body.run.terminal, false); assert.equal(committed.body.disposition, 'cancellation_requested');
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
      const response = await received; assert.ok(response.error); assert.equal(response.status, undefined);
      const path = join(CHAT_RUNS_DIR, run.id, 'status.json'); const before = await readFile(path);
      const cold = await promisify(execFile)(process.execPath, [import.meta.filename, 'cold', run.id], { env, timeout: 10000 });
      const line = cold.stdout.split(/\r?\n/).find(item => item.startsWith('COLD_RUN='));
      const retained = JSON.parse(line.slice('COLD_RUN='.length));
      assert.deepEqual(retained, { id: run.id, sessionId: 'crash_session', cancelRequested: true, state: 'running' });
      assert.deepEqual(await readFile(path), before);
      console.log('Retained actual HTTP/cold read fixture: ' + root);
    } finally {
      http?.destroy(); if (child.exitCode == null && child.signalCode == null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    }
  });
}
