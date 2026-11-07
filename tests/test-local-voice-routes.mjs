import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'agentoc-local-voice-route-'));
process.env.AGENTOC_INSTANCE_ROOT = root;
process.env.AGENTOC_CONFIG_DIR = join(root, 'config');
process.env.AGENTOC_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
const { createLocalVoiceRoutes, createConfiguredLocalVoiceRoutes } = await import('../chat/local-voice-routes.mjs');
let handleControlRoutes = null;
try { ({ handleControlRoutes } = await import('../chat/router-control-routes.mjs')); }
catch (error) {
  if (error?.code !== 'ERR_MODULE_NOT_FOUND' || !error.message.includes("Cannot find package 'web-push'")) throw error;
}

let calls = 0, aborted = false, exists = true, allowed = true, voiceEnabled = true, runtimeEnabled = true;
let entered, release;
const transcriber = {
  async isInstalled() { return true; },
  async isAvailable() { return runtimeEnabled; },
  isRunning() { return runtimeEnabled; },
  isReady() { return runtimeEnabled; },
  async setEnabled(value) { runtimeEnabled = value; },
  async transcribe(audio, { signal }) {
    calls++;
    assert.equal(audio.toString(), 'sample');
    if (entered) {
      entered();
      await new Promise(resolve => {
        release = resolve;
        signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true });
      });
    }
    return '识别结果';
  },
};
const settingsStore = {
  async load() { return { enabled: voiceEnabled }; },
  async save(value) { voiceEnabled = value.enabled; return { enabled: voiceEnabled }; },
};
const handler = createLocalVoiceRoutes({ transcriber, settingsStore });
const server = createServer(async (req, res) => {
  const principal = req.headers['x-test-principal'] || 'owner';
  const authSession = principal === 'visitor' ? { role: 'visitor' }
    : principal === 'target_runtime_gateway' ? { role: 'owner', principalKind: principal, targetRuntime: true,
      targetRuntimeOperation: req.method === 'GET' ? 'session.read' : 'session.message' }
    : principal === 'forged_gateway' ? { role: 'owner', principalKind: 'target_runtime_gateway', targetRuntime: true, targetRuntimeOperation: 'session.read' }
    : { role: 'owner', principalKind: principal };
  const writeJson = (response, status, value) => {
    response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value));
  };
  const handled = await handler({ req, res, pathname: req.url, authSession,
    getSession: async id => exists && id === 's1' ? { id } : null,
    requireSessionAccess: async response => { if (!allowed) writeJson(response, 403, { error: 'Access denied' }); return allowed; }, writeJson });
  if (!handled) { res.statusCode = 404; res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/api/sessions/s1/local-voice-recognition`;
const settingsBase = `http://127.0.0.1:${server.address().port}/api/local-voice-settings`;
const body = JSON.stringify({ audio: Buffer.from('sample').toString('base64') });
try {
  let res = await fetch(settingsBase);
  assert.deepEqual(await res.json(), { installed: true, enabled: true, running: true, ready: true });
  assert.equal(res.headers.get('cache-control'), 'no-store');
  res = await fetch(settingsBase, { headers: { 'x-test-principal': 'visitor' } }); assert.equal(res.status, 403);
  res = await fetch(settingsBase, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{"enabled":false}' });
  assert.deepEqual(await res.json(), { installed: true, enabled: false, running: false, ready: false });
  res = await fetch(base); assert.equal((await res.json()).available, false);
  res = await fetch(base, { method: 'POST', body }); assert.equal(res.status, 503); assert.equal(calls, 0);
  res = await fetch(settingsBase, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{"enabled":true}' });
  assert.deepEqual(await res.json(), { installed: true, enabled: true, running: true, ready: true });
  res = await fetch(settingsBase, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{"enabled":"yes"}' });
  assert.equal(res.status, 400);
  res = await fetch(base);
  assert.deepEqual(await res.json(), { available: true, destination: 'connected_computer', maxSeconds: 20 });
  assert.equal(res.headers.get('cache-control'), 'private, no-store');
  for (const principal of ['visitor', 'run_capability', 'temporary_device', 'provisional_device', 'forged_gateway']) {
    res = await fetch(base, { method: 'POST', headers: { 'x-test-principal': principal }, body });
    assert.equal(res.status, 403);
  }
  assert.equal(calls, 0);
  for (const principal of ['owner', 'trusted_device', 'target_runtime_gateway']) {
    res = await fetch(base, { method: 'POST', headers: { 'x-test-principal': principal }, body });
    assert.equal(res.status, 200); assert.deepEqual(await res.json(), { text: '识别结果' });
  }
  for (const invalid of ['{}', '{', '{"audio":"c2FtcGxl= "}', '{"audio":"c2FtcGxl","path":"x"}']) {
    res = await fetch(base, { method: 'POST', body: invalid }); assert.equal(res.status, 400);
  }
  res = await fetch(base, { method: 'POST', body: 'x'.repeat(900_001) }); assert.equal(res.status, 413);
  exists = false; res = await fetch(base); assert.equal(res.status, 404); exists = true;
  allowed = false; res = await fetch(base); assert.equal(res.status, 403); allowed = true;
  let ready;
  const readyPromise = new Promise(resolve => { ready = resolve; }); entered = ready;
  const revoked = fetch(base, { method: 'POST', body });
  await readyPromise; allowed = false; release();
  res = await revoked; assert.equal(res.status, 403); allowed = true; entered = null;
  let started;
  const startedPromise = new Promise(resolve => { started = resolve; }); entered = started;
  const controller = new AbortController();
  const pending = fetch(base, { method: 'POST', body, signal: controller.signal }).catch(() => null);
  await startedPromise; controller.abort(); await pending;
  for (let i = 0; i < 100 && !aborted; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(aborted, true); release?.(); entered = null;
  const disabled = createLocalVoiceRoutes({ settingsStore: { load: async () => ({ enabled: false }), save: async () => ({ enabled: false }) } });
  const fakeRes = { setHeader() {} };
  let result;
  await disabled({ req: { method: 'GET' }, res: fakeRes, pathname: '/api/sessions/s1/local-voice-recognition',
    authSession: { role: 'owner' }, requireSessionAccess: async () => true, getSession: async () => ({}),
    writeJson: (_res, status, value) => { result = { status, value }; } });
  assert.equal(result.status, 200); assert.equal(result.value.available, false);
  if (handleControlRoutes) {
    const routedReq = new PassThrough(); routedReq.method = 'GET'; routedReq.headers = {};
    result = null;
    assert.equal(await handleControlRoutes({ req: routedReq, res: fakeRes,
      pathname: '/api/sessions/s1/local-voice-recognition', authSession: { role: 'visitor' },
      writeJson: (_res, status, value) => { result = { status, value }; } }), true);
    assert.equal(result.status, 403); routedReq.end();
  }
  console.log(handleControlRoutes ? 'local voice authenticated route: PASS' : 'local voice authenticated route: PASS (router integration skipped: web-push is not installed)');
} finally {
  await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}
