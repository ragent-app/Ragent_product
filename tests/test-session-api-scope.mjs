import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, appendFile } from 'node:fs/promises';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createServer, request as httpRequest } from 'node:http';
import { fork, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test, after } from 'node:test';
import { parseSessionApiScope, readSessionApiScopeHeader, SESSION_API_SCOPE_HEADER } from '../chat/session-api-scope-contract.mjs';

const root = process.env.AGENTOC_SCOPE_TEST_ROOT || await mkdtemp(join(tmpdir(), 'agentoc-session-scope-'));
process.env.AGENTOC_INSTANCE_ROOT = root;
process.env.AGENTOC_CONFIG_DIR = join(root, 'config');
process.env.AGENTOC_MEMORY_DIR = join(root, 'memory');
const store = await import('../chat/session-meta-store.mjs');
const runs = await import('../chat/runs.mjs');
const { CHAT_SESSIONS_FILE, CHAT_RUNS_DIR } = await import('../lib/config.mjs');
const { handleSessionMainRoutes } = await import('../chat/router-session-main-routes.mjs');
assert.equal(CHAT_SESSIONS_FILE, join(root, 'config', 'chat-sessions.json'));
const disk = async () => JSON.parse(await readFile(CHAT_SESSIONS_FILE, 'utf8'));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const condition = c => ({ version: 1, sessionId: c.sessionId,
  expectedScopeRevision: c.scopeRevision, expectedProjectId: c.projectId });
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const header = value => ({ [SESSION_API_SCOPE_HEADER]: encode(value) });
async function seed(extra = {}) {
  await store.withSessionsMetaMutation(async (rows, save) => {
    rows.splice(0, rows.length, { id: 's1', name: 'Original', folder: root, projectId: 'p1',
      sessionPlane: 'user', sessionClass: 'ROOT_LEADERSHIP', userAddressable: true, tool: 'codex', ...extra });
    await save(rows, { immediate: true });
  });
  return condition(await store.readSessionApiContext('s1'));
}
const patch = values => store.mutateSessionMeta('s1', draft => { Object.assign(draft, values); return true; });
async function newRun(state = 'queued') {
  return runs.createRun({ status: { sessionId: 's1', state, tool: 'missing-tool' }, manifest: {} });
}
async function cancelRoute(runId, { scope, headers = {}, auth = { role: 'owner' }, access = true } = {}) {
  const pathname = `/api/runs/${encodeURIComponent(runId)}/cancel`;
  const parsedUrl = new URL(pathname, 'http://localhost');
  const req = new PassThrough(); req.method = 'POST'; req.headers = { ...headers, ...(scope ? header(scope) : {}) };
  const res = { headers: {}, setHeader(key, value) { this.headers[key] = value; } }; let accessCalls = 0;
  const handled = await handleSessionMainRoutes({ req, res, pathname, parsedUrl, authSession: auth,
    requireSessionAccess: async (_res, _auth, sessionId, options) => {
      accessCalls++; assert.equal(sessionId, 's1');
      if (Object.hasOwn(req.headers, SESSION_API_SCOPE_HEADER)) assert.equal(options?.metadataOnly, true);
      return access;
    },
    writeJson: (_res, status, body) => Object.assign(res, { status, body }) });
  req.end();
  return { ...res, handled, accessCalls };
}
if (process.argv[2] === 'cancel-crash-server') {
  const server = createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, 'http://localhost');
    await handleSessionMainRoutes({ req, res, pathname: parsedUrl.pathname, parsedUrl,
      authSession: { role: 'owner' }, requireSessionAccess: async (_res, _auth, _id, options) => {
        assert.equal(options?.metadataOnly, true); return true;
      },
      writeJson: (_res, status, body) => {
        // Hold the successful real HTTP request before publishing any response.
        // Its bounded PC Run effect has already returned from the scope guard.
        if (status === 200) process.send({ type: 'committed', run: body.run });
        else { res.writeHead(status); res.end(JSON.stringify(body)); }
      } });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  process.send({ type: 'listening', port: server.address().port });
} else if (process.argv[2] === 'cold-read-cancel') {
  const run = await runs.getRun(process.argv[3]);
  process.stdout.write(`COLD_RUN=${JSON.stringify(run)}\n`);
} else {
after(async () => { await store.flushSessionsMetaNow(); console.log(`Retained isolated scope test root: ${root}`); });

test('scope schema rejects missing project, coercion and caller claims', async () => {
  const good = await seed();
  assert.deepEqual(parseSessionApiScope(good, 's1'), good);
  assert.ok(Object.isFrozen(parseSessionApiScope(good, 's1')));
  for (const values of [{ version: 2 }, { sessionId: 's2' }, { expectedProjectId: undefined },
    { expectedProjectId: '' }, { expectedProjectId: ['p1'] }, { expectedScopeRevision: 'old' },
    { expectedScopeRevision: [good.expectedScopeRevision] }, { caller: 'owner' }])
    assert.throws(() => parseSessionApiScope({ ...good, ...values }, 's1'), { code: 'INVALID_ARGUMENT' });
  const missing = { ...good }; delete missing.expectedProjectId;
  assert.throws(() => parseSessionApiScope(missing, 's1'), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => parseSessionApiScope([], 's1'), { code: 'INVALID_ARGUMENT' });
  assert.equal(parseSessionApiScope({ ...good, expectedProjectId: null }, 's1').expectedProjectId, null);
});

test('authenticated scope discovery advertises only implemented effects and rejects unsupported requests', async () => {
  async function discover({ method = 'GET', auth = { role: 'owner' }, query = '' } = {}) {
    const parsedUrl = new URL('/api/session-scope-contract' + query, 'http://localhost');
    const res = { headers: {}, setHeader(key, value) { this.headers[key] = value; } };
    assert.equal(await handleSessionMainRoutes({ req: { method }, res, parsedUrl,
      pathname: parsedUrl.pathname, authSession: auth,
      requireSessionAccess: () => { throw new Error('Contract discovery has no Session effect'); },
      writeJson: (_res, status, body) => Object.assign(res, { status, body }) }), true);
    assert.equal(res.headers['Cache-Control'], 'private, no-store');
    return res;
  }
  const success = await discover();
  assert.equal(success.status, 200); assert.equal(success.body.version, 1);
  assert.equal(success.body.header, SESSION_API_SCOPE_HEADER);
  assert.equal(success.body.encoding, 'base64url-utf8-json');
  assert.deepEqual(success.body.effects.map(effect => effect.id), ['run.cancel',
    'asset.upload.intent', 'asset.upload.body', 'asset.upload.chunk', 'asset.upload.checkpoint',
    'asset.upload.finalize', 'asset.upload.receipt',
    'message.prepare', 'message.preparation.receipt', 'message.commit', 'message.commit.receipt']);
  assert.equal(success.body.effects[1].method, 'POST');
  assert.equal(success.body.effects[2].stagedBeforeGuard, true);
  assert.equal(success.body.effects[3].method, 'PATCH');
  assert.equal(success.body.effects[4].readonly, true);
  assert.equal(success.body.effects[5].verifiedBeforeGuard, true);
  assert.equal(success.body.effects[6].readonly, true);
  assert.equal(success.body.effects[7].startsRun, false);
  assert.equal(success.body.effects[8].readonly, true);
  assert.equal(success.body.effects[0].cancellationRequestedIsTerminal, false);
  assert.equal((await discover({ auth: { role: 'visitor' } })).status, 403);
  assert.equal((await discover({ auth: { role: 'owner', principalKind: 'run_capability' } })).status, 403);
  const post = await discover({ method: 'POST' }); assert.equal(post.status, 405); assert.equal(post.headers.Allow, 'GET');
  assert.equal((await discover({ query: '?target=s1' })).status, 400);
});

test('scope headers round trip Unicode and reject malformed encodings', async () => {
  const good = { ...await seed(), sessionId: '工作😀', expectedProjectId: '项目😀' };
  assert.deepEqual(readSessionApiScopeHeader({ headers: header(good) }, good.sessionId), good);
  assert.equal(readSessionApiScopeHeader({ headers: {} }, 's1'), null);
  for (const value of [[], '', encode(good) + '=', 'a'.repeat(4097), '_w', 'Zh', encode({ ...good, version: 0 })])
    assert.throws(() => readSessionApiScopeHeader({ headers: { [SESSION_API_SCOPE_HEADER]: value } }, good.sessionId),
      { code: 'INVALID_ARGUMENT' });
});

test('scope is durably checked before the bounded filesystem effect', { timeout: 10000 }, async () => {
  const scope = await seed();
  const effectFile = join(root, 'effects.jsonl');
  const result = await store.withSessionApiScope('s1', scope, async frozen => {
    assert.equal((await disk())[0].appApiScopeRevision, frozen.expectedScopeRevision);
    await appendFile(effectFile, JSON.stringify(frozen) + '\n');
    return 'accepted';
  });
  assert.equal(result, 'accepted');
  assert.deepEqual(JSON.parse((await readFile(effectFile, 'utf8')).trim()), scope);
});

test('nested bookkeeping is serialized without deadlocking the scope', { timeout: 10000 }, async () => {
  const scope = await seed({ counter: 0 });
  await store.withSessionApiScope('s1', scope, async () => {
    await Promise.all(Array.from({ length: 12 }, () => store.mutateSessionMeta('s1', draft => {
      draft.counter++; return true;
    })));
    await patch({ activeRunId: 'bookkeeping-only', name: 'Updated' });
    assert.equal((await store.findSessionMeta('s1')).counter, 12);
  });
  assert.equal((await disk())[0].counter, 12);
  assert.equal((await disk())[0].activeRunId, 'bookkeeping-only');
  assert.equal((await store.readSessionApiContext('s1')).scopeRevision, scope.expectedScopeRevision);
});

test('project movement and A to B to A each reject a frozen effect', async () => {
  const scope = await seed(); let effects = 0;
  await patch({ projectId: 'p2' });
  await assert.rejects(store.withSessionApiScope('s1', scope, () => effects++), { code: 'REVISION_CONFLICT' });
  await patch({ projectId: 'p1' });
  await assert.rejects(store.withSessionApiScope('s1', scope, () => effects++), { code: 'REVISION_CONFLICT' });
  assert.equal(effects, 0);
  assert.notEqual((await disk())[0].appApiScopeRevision, scope.expectedScopeRevision);
});

test('nested mutation children are rejected explicitly instead of losing parallel writes', { timeout: 10000 }, async () => {
  const scope = await seed({ counter: 0 });
  await store.withSessionApiScope('s1', scope, async () => {
    await store.withSessionsMetaMutation(async (rows, save) => {
      const children = await Promise.allSettled(Array.from({ length: 3 }, () =>
        store.mutateSessionMeta('s1', draft => { draft.counter++; return true; })));
      for (const child of children) {
        assert.equal(child.status, 'rejected'); assert.equal(child.reason.code, 'REVISION_CONFLICT');
      }
      assert.equal((await store.findSessionMeta('s1')).counter, 0);
      rows[0].counter = 3; await save(rows, { immediate: true });
    });
    await patch({ name: 'After nested rejection' });
  });
  assert.equal((await disk())[0].counter, 3);
  assert.equal((await store.findSessionMeta('s1')).name, 'After nested rejection');
});

test('concurrent project movement linearizes after the actual effect', { timeout: 10000 }, async () => {
  const scope = await seed(); const entered = deferred(); const release = deferred(); const order = [];
  const effect = store.withSessionApiScope('s1', scope, async () => {
    entered.resolve(); await release.promise;
    assert.equal((await disk())[0].projectId, 'p1');
    await writeFile(join(root, 'linearized-effect.txt'), 'performed in p1'); order.push('effect');
  });
  await entered.promise;
  const movement = store.mutateSessionMeta('s1', draft => { order.push('move'); draft.projectId = 'p2'; return true; });
  assert.deepEqual(order, []); release.resolve(); await Promise.all([effect, movement]);
  assert.deepEqual(order, ['effect', 'move']);
  assert.equal((await disk())[0].projectId, 'p2');
});

test('cache aliases obtained earlier or during a scope cannot change the guarded resource', { timeout: 10000 }, async () => {
  const scope = await seed(); const oldAlias = await store.findSessionMeta('s1');
  await store.withSessionApiScope('s1', scope, async () => {
    oldAlias.projectId = 'foreign'; oldAlias.userAddressable = false;
    const alias = store.findSessionMetaCached('s1'); alias.projectId = 'also-foreign';
    const read = await store.findSessionMeta('s1'); read.folder = 'unapproved';
    assert.equal((await store.findSessionMeta('s1')).projectId, 'p1');
    await patch({ name: 'Safe' });
  });
  assert.equal((await disk())[0].projectId, 'p1');
  assert.equal((await disk())[0].folder, root);
  assert.equal((await disk())[0].userAddressable, true);
});

test('each resource fingerprint change is denied before cache or disk publication', { timeout: 10000 }, async () => {
  for (const change of [{ projectId: 'p2' }, { folder: root + '-other' }, { sessionClass: 'ROOT_OTHER' },
    { sessionPlane: 'internal' }, { userAddressable: false }, { visitorId: 'visitor' }, { internalRole: 'manager' }]) {
    const scope = await seed(); const before = (await disk())[0];
    await store.withSessionApiScope('s1', scope, async () => {
      await assert.rejects(patch(change), { code: 'REVISION_CONFLICT' });
      assert.deepEqual((await disk())[0], before);
      assert.equal((await store.findSessionMeta('s1')).projectId, 'p1');
      await patch({ name: 'Allowed after rejected move' });
    });
    assert.equal((await store.findSessionMeta('s1')).name, 'Allowed after rejected move');
  }
});

test('resource removal and explicit nested scope effects fail without deadlock', { timeout: 10000 }, async () => {
  const scope = await seed();
  await store.withSessionApiScope('s1', scope, async () => {
    await assert.rejects(store.removeSessionMeta('s1'), { code: 'RESOURCE_NOT_FOUND' });
    await assert.rejects(store.withSessionApiScope('s1', scope, () => {}), { code: 'REVISION_CONFLICT' });
    assert.equal((await disk())[0].id, 's1');
  });
});

test('an effect failure releases the actor for later metadata writers', { timeout: 10000 }, async () => {
  const scope = await seed();
  await assert.rejects(store.withSessionApiScope('s1', scope, async () => {
    await patch({ name: 'Before failure' }); throw new Error('deliberate effect failure');
  }), /deliberate effect failure/);
  await patch({ projectId: 'p2' });
  assert.equal((await disk())[0].projectId, 'p2');
});

test('a failed durable scope publication prevents the effect and releases the actor', { timeout: 10000 }, async () => {
  const scope = await seed(); const before = await readFile(CHAT_SESSIONS_FILE); let effects = 0; let failures = 0;
  const originalRename = fs.promises.rename;
  fs.promises.rename = async (from, to) => {
    if (to === CHAT_SESSIONS_FILE && failures++ === 0)
      throw Object.assign(new Error('controlled commit failure'), { code: 'EIO' });
    return originalRename(from, to);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(store.withSessionApiScope('s1', scope, () => effects++),
      { code: 'SESSION_MUTATION_STORE_UNAVAILABLE' });
  } finally { fs.promises.rename = originalRename; syncBuiltinESMExports(); }
  assert.equal(effects, 0); assert.ok(failures > 0); assert.deepEqual(await readFile(CHAT_SESSIONS_FILE), before);
  await patch({ projectId: 'p2' }); assert.equal((await disk())[0].projectId, 'p2');
});

test('detached async children lose transaction ownership after their parent scope ends', { timeout: 10000 }, async () => {
  const scope = await seed(); const trigger = deferred(); const entered = deferred(); const release = deferred();
  const order = []; let detached;
  await store.withSessionApiScope('s1', scope, async () => {
    detached = (async () => { await trigger.promise; await store.mutateSessionMeta('s1', draft => {
      order.push('detached'); draft.projectId = 'p2'; return true;
    }); })();
  });
  const second = store.withSessionApiScope('s1', scope, async () => {
    entered.resolve(); await release.promise; order.push('second');
  });
  await entered.promise; trigger.resolve();
  await Promise.resolve(); assert.deepEqual(order, []);
  release.resolve(); await Promise.all([second, detached]);
  assert.deepEqual(order, ['second', 'detached']);
  assert.equal((await disk())[0].projectId, 'p2');
});

test('internal and non-addressable Sessions do not reach an effect', async () => {
  for (const extra of [{ userAddressable: false }, { sessionPlane: 'internal' }, { internalRole: 'manager' }]) {
    await seed(); await patch(extra);
    const meta = await store.findSessionMeta('s1');
    const scope = { version: 1, sessionId: 's1', expectedProjectId: 'p1', expectedScopeRevision: meta.appApiScopeRevision };
    let effects = 0;
    await assert.rejects(store.withSessionApiScope('s1', scope, () => effects++), { code: 'RESOURCE_NOT_FOUND' });
    assert.equal(effects, 0);
  }
});

test('a conditional queued Run cancellation changes the exact real Run record', { timeout: 10000 }, async () => {
  const scope = await seed(); const run = await newRun(); await patch({ activeRunId: run.id });
  const result = await cancelRoute(run.id, { scope });
  assert.equal(result.handled, true); assert.equal(result.status, 200); assert.equal(result.accessCalls, 1);
  assert.equal(result.headers['Cache-Control'], 'private, no-store');
  const actual = await runs.getRun(run.id);
  assert.equal(actual.state, 'cancelled'); assert.equal(actual.cancelRequested, true);
  assert.equal(actual.result.cancelled, true); assert.equal(result.body.run.id, run.id);
  assert.equal((await store.readSessionApiContext('s1')).scopeRevision, scope.expectedScopeRevision);
});

test('conditional running cancellation records a request without waiting for provider reconciliation', { timeout: 10000 }, async () => {
  const scope = await seed(); const run = await newRun('running'); await patch({ activeRunId: run.id });
  const result = await cancelRoute(run.id, { scope });
  assert.equal(result.status, 200); assert.equal(result.body.run.id, run.id);
  const actual = await runs.getRun(run.id);
  assert.equal(actual.cancelRequested, true); assert.equal(actual.state, 'running');
  assert.equal(actual.result?.cancelled, undefined);
});

test('stale scope cannot cancel a Run even after its project returns', { timeout: 10000 }, async () => {
  const scope = await seed(); const run = await newRun(); await patch({ activeRunId: run.id });
  const before = await runs.getRun(run.id);
  await patch({ projectId: 'p2' }); await patch({ projectId: 'p1' });
  const result = await cancelRoute(run.id, { scope });
  assert.equal(result.status, 409); assert.equal(result.body.code, 'REVISION_CONFLICT');
  assert.deepEqual(await runs.getRun(run.id), before);
});

test('queue admission between snapshot and Run mutation requests cancellation without claiming provider stop', { timeout: 10000 }, async () => {
  const scope = await seed(); const run = await newRun(); await patch({ activeRunId: run.id });
  const statusFile = join(CHAT_RUNS_DIR, run.id, 'status.json');
  const originalStat = fs.promises.stat; let reads = 0; let admitted = false;
  fs.promises.stat = async (path, ...args) => {
    if (path === statusFile && ++reads === 3) {
      // The route and cancellation read a queued snapshot first. Publish an
      // actual running record at the locked mutation's fresh read boundary.
      const current = JSON.parse(await readFile(statusFile, 'utf8'));
      assert.equal(current.state, 'queued');
      await writeFile(statusFile, JSON.stringify({ ...current, state: 'running' }));
      admitted = true;
    }
    return originalStat(path, ...args);
  };
  syncBuiltinESMExports(); let result;
  try { result = await cancelRoute(run.id, { scope }); }
  finally { fs.promises.stat = originalStat; syncBuiltinESMExports(); }
  assert.equal(admitted, true); assert.equal(result.status, 200);
  assert.equal(result.body.run.id, run.id); assert.equal(result.body.run.state, 'running');
  const actual = await runs.getRun(run.id);
  assert.equal(actual.state, 'running'); assert.equal(actual.cancelRequested, true);
  assert.equal(actual.result?.cancelled, undefined);
});

test('a newer active Run never receives cancellation requested for its predecessor', { timeout: 10000 }, async () => {
  const scope = await seed(); const old = await newRun(); const current = await newRun();
  await patch({ activeRunId: current.id });
  for (const options of [{ scope }, {}]) {
    const result = await cancelRoute(old.id, options);
    assert.equal(result.status, 409); assert.equal(result.body.code, 'RUN_IDENTITY_CONFLICT');
    assert.equal((await runs.getRun(old.id)).cancelRequested, false);
    assert.equal((await runs.getRun(current.id)).cancelRequested, false);
  }
});

test('visitor and run-capability callers cannot use conditional cancellation', async () => {
  const scope = await seed(); const run = await newRun(); await patch({ activeRunId: run.id });
  for (const auth of [{ role: 'visitor' }, { role: 'owner', principalKind: 'run_capability' }]) {
    const result = await cancelRoute(run.id, { scope, auth });
    assert.equal(result.status, 403); assert.equal(result.body.code, 'PERMISSION_DENIED');
    assert.equal(result.accessCalls, 0); assert.equal((await runs.getRun(run.id)).cancelRequested, false);
  }
});

test('malformed and cross-Session conditions cause no Run effect', async () => {
  const scope = await seed(); const run = await newRun(); await patch({ activeRunId: run.id });
  for (const value of ['_', encode({ ...scope, sessionId: 's2' }), encode({ ...scope, expectedProjectId: 'p2' })]) {
    const result = await cancelRoute(run.id, { headers: { [SESSION_API_SCOPE_HEADER]: value } });
    assert.ok([400, 409].includes(result.status));
    assert.equal((await runs.getRun(run.id)).cancelRequested, false);
  }
});

test('a queued Run with no active binding returns conflict instead of false cancellation success', async () => {
  const scope = await seed(); const run = await newRun();
  const result = await cancelRoute(run.id, { scope });
  assert.equal(result.status, 409); assert.equal(result.body.code, 'RUN_IDENTITY_CONFLICT');
  assert.equal((await runs.getRun(run.id)).state, 'queued');
});

test('process death after conditional Run effect but before HTTP reply survives a cold read', { timeout: 20000 }, async () => {
  const scope = await seed(); const run = await newRun(); await patch({ activeRunId: run.id });
  const file = fileURLToPath(import.meta.url);
  const child = fork(file, ['cancel-crash-server'], {
    env: { ...process.env, AGENTOC_SCOPE_TEST_ROOT: root }, silent: true,
  });
  let childOutput = '';
  child.stdout.on('data', bytes => { childOutput += bytes; });
  child.stderr.on('data', bytes => { childOutput += bytes; });
  const messages = []; const listeners = new Map();
  child.on('message', message => {
    messages.push(message);
    listeners.get(message.type)?.(message);
  });
  function message(type) {
    const existing = messages.find(item => item.type === type);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`No ${type} from owned fixture: ${childOutput}`)), 8000);
      listeners.set(type, value => { clearTimeout(timer); resolve(value); });
    });
  }
  let request;
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  try {
    const listening = await message('listening');
    let replied = false;
    const outcome = new Promise(resolve => {
      request = httpRequest({ hostname: '127.0.0.1', port: listening.port,
        path: `/api/runs/${run.id}/cancel`, method: 'POST', headers: header(scope) }, res => {
        replied = true; res.resume(); res.on('end', () => resolve('replied'));
      });
      request.on('error', () => resolve('disconnected')); request.end();
    });
    const committed = await message('committed');
    assert.equal(committed.run.id, run.id); assert.equal(committed.run.state, 'cancelled');
    assert.equal(replied, false);
    assert.equal(child.kill('SIGKILL'), true);
    const termination = await exited;
    assert.ok(termination.signal || termination.code !== 0);
    assert.equal(await outcome, 'disconnected');
    const cold = await promisify(execFile)(process.execPath, [file, 'cold-read-cancel', run.id], {
      env: { ...process.env, AGENTOC_SCOPE_TEST_ROOT: root }, timeout: 8000,
    });
    const line = cold.stdout.split('\n').find(value => value.startsWith('COLD_RUN='));
    const actual = JSON.parse(line.slice('COLD_RUN='.length));
    assert.equal(actual.id, run.id); assert.equal(actual.state, 'cancelled');
    assert.equal(actual.cancelRequested, true); assert.equal(actual.result.cancelled, true);
    assert.equal((await disk())[0].appApiScopeRevision, scope.expectedScopeRevision);
  } finally {
    request?.destroy();
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
  }
});

test('strict corrupt metadata prevents any conditional filesystem effect', async () => {
  const scope = await seed(); const original = await readFile(CHAT_SESSIONS_FILE);
  await writeFile(CHAT_SESSIONS_FILE, '{invalid'); let effects = 0;
  try {
    await assert.rejects(store.withSessionApiScope('s1', scope, () => effects++), { code: 'SESSION_MUTATION_STORE_INVALID' });
    assert.equal(effects, 0);
  } finally { await writeFile(CHAT_SESSIONS_FILE, original); }
});
}
