import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, fork } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { promisify } from 'node:util';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';
import { test, after } from 'node:test';
import {
  parseSessionApiMutation, projectSessionApiContext, sessionApiReceipts,
} from '../chat/session-api-mutation-contract.mjs';

const root = process.env.RAGENT_MUTATION_TEST_ROOT || await mkdtemp(join(tmpdir(), 'ragent-session-api-'));
process.env.RAGENT_INSTANCE_ROOT = root;
process.env.RAGENT_CONFIG_DIR = join(root, 'config');
process.env.RAGENT_MEMORY_DIR = join(root, 'memory');
const store = await import('../chat/session-meta-store.mjs');
const { CHAT_SESSIONS_FILE, CHAT_HISTORY_DIR } = await import('../lib/config.mjs');
assert.equal(CHAT_SESSIONS_FILE, join(root, 'config', 'chat-sessions.json'));
const { handleSessionMainRoutes } = await import('../chat/router-session-main-routes.mjs');
const { handleSessionApiMutationRoutes } = await import('../chat/session-api-mutation-routes.mjs');
const { createSessionListItem, createSessionDetail } = await import('../chat/session-api-shapes.mjs');
const { writeJsonAtomic } = await import('../chat/fs-utils.mjs');
const disk = async () => JSON.parse(await readFile(CHAT_SESSIONS_FILE, 'utf8'));
const read = id => store.readSessionApiContext(id || 's1');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function seed(extra = {}) {
  await store.withSessionsMetaMutation(async (rows, save) => {
    rows.splice(0, rows.length, { id: 's1', name: 'Original', folder: root, projectId: 'p1',
      sessionPlane: 'user', sessionClass: 'ROOT_LEADERSHIP', userAddressable: true, tool: 'codex', ...extra });
    await save(rows, { immediate: true });
  });
  return read();
}
function request(context, id = 'r1', kind = 'rename', value = 'New title') {
  return { version: 1, requestId: id, expectedRevision: context.revision,
    expectedScopeRevision: context.scopeRevision, expectedProjectId: context.projectId, kind, value };
}
async function route(pathname, { method = 'GET', payload, raw, auth = { role: 'owner' },
  headers = {}, access = true, direct = false, invalidate, chunks } = {}) {
  const req = new PassThrough();
  req.method = method;
  req.headers = { 'content-type': 'application/json', ...headers };
  const res = { status: 0, body: '', headers: {}, setHeader(k, v) { this.headers[k] = v; } };
  let accessCalls = 0;
  const parsedUrl = new URL(pathname, 'http://localhost');
  const args = { req, res, pathname: parsedUrl.pathname, parsedUrl, authSession: auth,
    requireSessionAccess: async (_res, _auth, _id, options) => {
      accessCalls++;
      assert.equal(options.metadataOnly, true);
      if (!access) args.writeJson(res, 403, { error: 'Access denied' });
      return access;
    }, writeJson: (_res, status, value) => { res.status = status; res.body = JSON.stringify(value); }, invalidate };
  const pending = (direct ? handleSessionApiMutationRoutes : handleSessionMainRoutes)(args);
  if (chunks) { for (const chunk of chunks) req.write(chunk); req.end(); }
  else req.end(raw ?? JSON.stringify(payload ?? {}));
  const handled = await pending;
  return { handled, status: res.status, body: res.body ? JSON.parse(res.body) : null, headers: res.headers, accessCalls };
}
async function patchFs(name, replacement, action) {
  const original = fs.promises[name];
  fs.promises[name] = replacement(original);
  syncBuiltinESMExports();
  try { return await action(); }
  finally { fs.promises[name] = original; syncBuiltinESMExports(); }
}

if (process.argv[2] === 'crash-server') {
  const server = createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, 'http://localhost');
    await handleSessionMainRoutes({ req, res, pathname: parsedUrl.pathname, parsedUrl,
      authSession: { role: 'owner' }, requireSessionAccess: async () => true,
      writeJson: (_res, status, value) => {
        // A committed POST is deliberately held before HTTP publication.
        if (req.method === 'POST' && status === 200) process.send({ type: 'committed', receipt: value });
        else { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); }
      } });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  process.send({ type: 'listening', port: server.address().port });
} else if (process.argv[2] === 'cold-replay') {
  const input = JSON.parse(process.env.RAGENT_MUTATION_TEST_REQUEST);
  const receipt = await store.applySessionApiMutation('s1', input);
  assert.equal(receipt.duplicate, true);
  const lookup = await store.readSessionApiMutationReceipt('s1', input.requestId);
  assert.deepEqual({ ...receipt, duplicate: false }, lookup);
  await store.flushSessionsMetaNow();
  console.log(JSON.stringify({ receipt, context: await read() }));
} else {
  after(async () => { await store.flushSessionsMetaNow(); console.log(`Retained isolated test root: ${root}`); });

  test('context is bounded, durable and independent of Run dispatch', async () => {
    const c = await seed({ name: 'a'.repeat(255) + '😀z', projectId: '' });
    assert.equal(c.projectId, null);
    assert.equal(c.title, 'a'.repeat(255));
    assert.equal(c.titleTruncated, true);
    assert.equal(c.remainingMutationReceipts, 64);
    assert.equal((await disk())[0].appApiScopeRevision, c.scopeRevision);
    assert.equal((await disk())[0].appApiRevision, c.revision);
    assert.equal((await disk())[0].activeRunId, undefined);
    const second = await read();
    assert.equal(second.revision, c.revision);
    assert.equal(second.scopeRevision, c.scopeRevision);
  });

  test('strict request parsing rejects coercion and unexpected fields', async () => {
    const c = await seed();
    const good = request(c);
    for (const patch of [ { version: 2 }, { expectedRevision: [c.revision] },
      { expectedScopeRevision: [c.scopeRevision] }, { requestId: '' }, { requestId: 'a'.repeat(201) },
      { kind: 'shell' }, { kind: 'setPinned', value: 1 }, { value: '\n' }, { value: 'x'.repeat(257) },
      { expectedProjectId: '' }, { caller: 'owner' }, { expectedProjectId: undefined } ])
      assert.throws(() => parseSessionApiMutation({ ...good, ...patch }), { code: 'INVALID_ARGUMENT' });
    const missing = { ...good }; delete missing.expectedProjectId;
    assert.throws(() => parseSessionApiMutation(missing), { code: 'INVALID_ARGUMENT' });
    assert.throws(() => parseSessionApiMutation([]), { code: 'INVALID_ARGUMENT' });
  });

  test('concurrent identical retries produce one durable effect and receipt', async () => {
    const c = await seed(); const input = request(c);
    const receipts = await Promise.all(Array.from({ length: 12 }, () => store.applySessionApiMutation('s1', input)));
    assert.equal(receipts.filter(r => !r.duplicate).length, 1);
    const first = receipts.find(r => !r.duplicate);
    for (const receipt of receipts) assert.deepEqual({ ...receipt, duplicate: false }, first);
    assert.equal((await disk())[0].appApiMutationReceipts.length, 1);
    assert.equal((await disk())[0].name, 'New title');
    assert.equal((await disk())[0].titleSource, 'user');
    assert.equal((await disk())[0].autoRenamePending, false);
  });

  test('stale competing mutations cannot overwrite the winner', async () => {
    const c = await seed();
    const results = await Promise.allSettled([
      store.applySessionApiMutation('s1', request(c, 'a')),
      store.applySessionApiMutation('s1', request(c, 'b', 'setPinned', true)),
    ]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(results.find(r => r.status === 'rejected').reason.code, 'REVISION_CONFLICT');
    const winner = results.find(r => r.status === 'fulfilled').value;
    assert.equal((await disk())[0].appApiMutationReceipts.length, 1);
    assert.equal((await read()).revision, winner.revision);
  });

  test('a changed input under the retained request ID is a conflict', async () => {
    const c = await seed(); const input = request(c);
    await store.applySessionApiMutation('s1', input);
    await assert.rejects(store.applySessionApiMutation('s1', { ...input, value: 'different' }), { code: 'REVISION_CONFLICT' });
    await assert.rejects(store.applySessionApiMutation('s1', { ...input, expectedRevision: (await read()).revision }), { code: 'REVISION_CONFLICT' });
    assert.equal((await read()).title, 'New title');
  });

  test('all four metadata actions preserve active Run and stable reviewed receipt', async () => {
    await seed({ activeRunId: 'running' });
    let c = await read();
    const reviewedRequest = request(c, 'review', 'setReviewed', true);
    const review = await store.applySessionApiMutation('s1', reviewedRequest);
    for (const [id, kind, value] of [['pin', 'setPinned', true], ['archive', 'setArchived', true],
      ['name', 'rename', ' Manual title ']]) {
      c = await read(); await store.applySessionApiMutation('s1', request(c, id, kind, value));
    }
    const restored = await store.applySessionApiMutation('s1', reviewedRequest);
    assert.deepEqual({ ...restored, duplicate: false }, review);
    const meta = (await disk())[0];
    assert.equal(meta.lastReviewedAt, review.observedAt);
    assert.equal(meta.activeRunId, 'running');
    assert.equal(meta.archived, true); assert.equal(meta.pinned, true); assert.equal(meta.name, 'Manual title');
    for (const [id, kind] of [['unpin', 'setPinned'], ['unarchive', 'setArchived'], ['unreview', 'setReviewed']])
      await store.applySessionApiMutation('s1', request(await read(), id, kind, false));
    const cleared = (await disk())[0];
    assert.equal(cleared.pinned, undefined); assert.equal(cleared.archived, undefined); assert.equal(cleared.lastReviewedAt, undefined);
    assert.equal(cleared.activeRunId, 'running');
  });

  test('a no-effect command still has one immutable acknowledgement', async () => {
    const c = await seed({ pinned: true });
    const input = request(c, 'noop', 'setPinned', true);
    const receipt = await store.applySessionApiMutation('s1', input);
    assert.equal(receipt.changed, false);
    assert.notEqual(receipt.revision, c.revision);
    assert.equal((await store.applySessionApiMutation('s1', input)).duplicate, true);
  });

  test('unknown response is reconciled by cold process without repeating review time', async () => {
    const c = await seed(); const input = request(c, 'lost-reply', 'setReviewed', true);
    const original = await store.applySessionApiMutation('s1', input);
    const child = await promisify(execFile)(process.execPath, [fileURLToPath(import.meta.url), 'cold-replay'], {
      env: { ...process.env, RAGENT_MUTATION_TEST_ROOT: root, RAGENT_MUTATION_TEST_REQUEST: JSON.stringify(input) },
      timeout: 30000, maxBuffer: 1024 * 1024,
    });
    const result = JSON.parse(child.stdout.trim());
    assert.deepEqual({ ...result.receipt, duplicate: false }, original);
    assert.equal(result.context.lastReviewedAt, original.observedAt);
    assert.equal((await disk())[0].appApiMutationReceipts.length, 1);
  });

  test('actual fixture process death after commit but before HTTP response retains exact receipt', { timeout: 30000 }, async t => {
    const c = await seed(); const input = request(c, 'crash-before-response', 'setReviewed', true);
    const child = fork(fileURLToPath(import.meta.url), ['crash-server'], {
      execArgv: [], windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, RAGENT_MUTATION_TEST_ROOT: root },
    });
    child.stdout.resume(); child.stderr.resume();
    t.signal.addEventListener('abort', () => child.kill('SIGKILL'), { once: true });
    const listening = deferred(), committed = deferred();
    const failure = new Promise((_resolve, reject) => {
      child.once('error', reject); child.once('exit', () => reject(new Error('Fixture ended before its expected marker')));
    });
    child.on('message', message => {
      if (message.type === 'listening') listening.resolve(message);
      if (message.type === 'committed') committed.resolve(message);
    });
    try {
      const { port } = await Promise.race([listening.promise, failure]);
      const url = `http://127.0.0.1:${port}/api/sessions/s1/app-api-mutations`;
      const oversized = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(8193) });
      assert.equal(oversized.status, 413); await oversized.text();
      const chunked = await new Promise((resolve, reject) => {
        const outgoing = httpRequest(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, response => {
          response.resume(); response.on('end', () => resolve(response.statusCode));
        });
        outgoing.on('error', reject); outgoing.write('x'.repeat(8193)); outgoing.end();
      });
      assert.equal(chunked, 413);
      const unknownHttp = fetch(`http://127.0.0.1:${port}/api/sessions/s1/app-api-mutations`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
      }).then(response => ({ received: true, status: response.status }), error => ({ received: false, error: error.message }));
      const { receipt } = await Promise.race([committed.promise, failure]);
      assert.equal((await disk())[0].lastReviewedAt, receipt.observedAt);
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGKILL'); await exited;
      assert.equal((await unknownHttp).received, false);
      const replay = await promisify(execFile)(process.execPath, [fileURLToPath(import.meta.url), 'cold-replay'], {
        env: { ...process.env, RAGENT_MUTATION_TEST_ROOT: root, RAGENT_MUTATION_TEST_REQUEST: JSON.stringify(input) }, timeout: 15000,
      });
      const result = JSON.parse(replay.stdout.trim());
      assert.deepEqual({ ...result.receipt, duplicate: false }, receipt);
      assert.equal(result.context.lastReviewedAt, receipt.observedAt);
      assert.equal((await disk())[0].appApiMutationReceipts.length, 1);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });

  test('single and in-place bulk project moves reject old writes and receipt disclosure, including ABA', async () => {
    const c = await seed(); const input = request(c);
    await store.applySessionApiMutation('s1', input);
    await store.mutateSessionMeta('s1', row => { row.projectId = 'p2'; return true; });
    assert.equal((await disk())[0].projectId, 'p2', 'Scope changes bypass debounce');
    await assert.rejects(store.applySessionApiMutation('s1', input), { code: 'REVISION_CONFLICT' });
    await assert.rejects(store.readSessionApiMutationReceipt('s1', input.requestId), { code: 'REVISION_CONFLICT' });
    await store.withSessionsMetaMutation(async (rows, save) => { rows[0].projectId = 'p1'; await save(rows); });
    const movedBack = await read();
    assert.equal(movedBack.projectId, 'p1');
    assert.notEqual(movedBack.scopeRevision, c.scopeRevision);
    await assert.rejects(store.applySessionApiMutation('s1', input), { code: 'REVISION_CONFLICT' });
    await assert.rejects(store.applySessionApiMutation('s1', request(c, 'new-stale')), { code: 'REVISION_CONFLICT' });
  });

  test('folder and visibility changes rotate scope; internal resources fail closed inside transaction', async () => {
    const c = await seed(); const input = request(c);
    await mkdir(join(root, 'moved'), { recursive: true });
    await store.mutateSessionMeta('s1', row => { row.folder = join(root, 'moved'); return true; });
    assert.notEqual((await read()).scopeRevision, c.scopeRevision);
    await assert.rejects(store.applySessionApiMutation('s1', input), { code: 'REVISION_CONFLICT' });
    await store.mutateSessionMeta('s1', row => { row.internalRole = 'context_compactor'; return true; });
    await assert.rejects(read(), { code: 'RESOURCE_NOT_FOUND' });
    await assert.rejects(store.applySessionApiMutation('s1', input), { code: 'RESOURCE_NOT_FOUND' });
    await assert.rejects(seed({ sessionPlane: 'system' }), { code: 'RESOURCE_NOT_FOUND' });
  });

  test('legacy debounced metadata edits invalidate context; volatile updates do not', async () => {
    const c = await seed();
    await store.mutateSessionMeta('s1', row => { row.activeRunId = 'r'; row.updatedAt = new Date().toISOString(); return true; });
    assert.equal((await read()).revision, c.revision);
    await store.mutateSessionMeta('s1', row => { row.name = 'Legacy rename'; return true; });
    assert.equal((await disk())[0].name, 'Original', 'Ordinary title saves still debounce');
    await assert.rejects(store.applySessionApiMutation('s1', request(c)), { code: 'REVISION_CONFLICT' });
    const fresh = await read();
    assert.notEqual(fresh.revision, c.revision);
    assert.equal((await disk())[0].name, 'Legacy rename', 'Context commits pending facts before returning');
    await store.mutateSessionMeta('s1', row => { row.autoRenamePending = true; return true; });
    await assert.rejects(store.applySessionApiMutation('s1', request(fresh, 'stale-rename-state')), { code: 'REVISION_CONFLICT' });
  });

  test('debounced older file write cannot overwrite a later API commit', async () => {
    await seed();
    const entered = deferred(), release = deferred();
    await patchFs('rename', original => async (from, to) => {
      if (to === CHAT_SESSIONS_FILE && !entered.done) { entered.done = true; entered.resolve(); await release.promise; }
      return original(from, to);
    }, async () => {
      await store.mutateSessionMeta('s1', row => { row.name = 'Pending legacy'; return true; });
      const oldFlush = store.flushSessionsMetaNow();
      await entered.promise;
      const contextRead = read();
      release.resolve();
      await oldFlush;
      const c = await contextRead;
      await store.applySessionApiMutation('s1', request(c));
    });
    assert.equal((await disk())[0].name, 'New title');
    assert.equal((await disk())[0].appApiMutationReceipts.length, 1);
  });

  test('external metadata normalization/read waits for committed API cache; nested transaction reads remain usable', async () => {
    const c = await seed(); const entered = deferred(), release = deferred();
    await patchFs('rename', original => async (from, to) => {
      if (to === CHAT_SESSIONS_FILE && !entered.done) { entered.done = true; entered.resolve(); await release.promise; }
      return original(from, to);
    }, async () => {
      const mutation = store.applySessionApiMutation('s1', request(c));
      await entered.promise;
      let readFinished = false;
      const reading = store.loadSessionsMeta().then(rows => { readFinished = true; return rows; });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(readFinished, false);
      release.resolve();
      const receipt = await mutation;
      const rows = await reading;
      assert.equal(rows[0].appApiRevision, receipt.revision);
      assert.equal(rows[0].appApiMutationReceipts.length, 1);
    });
    await store.withSessionsMetaMutation(async rows => {
      assert.equal((await store.loadSessionsMeta())[0].id, rows[0].id);
    });
  });

  test('sync precedes rename and receipt publication; rename failure leaves no memory/disk receipt or temp file', async () => {
    const c = await seed(); const input = request(c);
    const steps = [];
    await patchFs('open', original => async (...args) => {
      const handle = await original(...args);
      if (String(args[0]).startsWith(CHAT_SESSIONS_FILE + '.tmp-')) {
        const realSync = handle.sync.bind(handle);
        handle.sync = async () => { steps.push('sync'); return realSync(); };
      }
      return handle;
    }, async () => patchFs('rename', original => async (from, to) => {
      if (to === CHAT_SESSIONS_FILE) {
        assert.equal(steps.at(-1), 'sync');
        assert.equal(store.findSessionMetaCached('s1').name, 'Original');
        assert.equal((await disk())[0].name, 'Original');
        throw Object.assign(new Error('Injected private path failure'), { code: 'EIO' });
      }
      return original(from, to);
    }, async () => {
      await assert.rejects(store.applySessionApiMutation('s1', input), { code: 'SESSION_MUTATION_STORE_UNAVAILABLE' });
    }));
    assert.equal(store.findSessionMetaCached('s1').appApiMutationReceipts, undefined);
    assert.equal((await disk())[0].appApiMutationReceipts, undefined);
    assert.equal((await readdir(join(root, 'config'))).filter(x => x.includes('.tmp-')).length, 0);
    const recovered = await store.applySessionApiMutation('s1', input);
    assert.equal(recovered.duplicate, false);
    assert.equal((await disk())[0].name, 'New title');
  });

  test('sync failure leaves original file and acknowledgement unpublished', async () => {
    const c = await seed();
    await patchFs('open', original => async (...args) => {
      const handle = await original(...args);
      if (String(args[0]).startsWith(CHAT_SESSIONS_FILE + '.tmp-'))
        handle.sync = async () => { throw new Error('Injected fsync failure'); };
      return handle;
    }, async () => assert.rejects(store.applySessionApiMutation('s1', request(c)), { code: 'SESSION_MUTATION_STORE_UNAVAILABLE' }));
    assert.equal((await disk())[0].name, 'Original');
    assert.equal(store.findSessionMetaCached('s1').name, 'Original');
    assert.equal((await readdir(join(root, 'config'))).filter(x => x.includes('.tmp-')).length, 0);
  });

  test('receipt quota never evicts a retained request and permits its replay', async () => {
    const initial = await seed(); const firstInput = request(initial, 'quota-0', 'setPinned', true);
    const first = await store.applySessionApiMutation('s1', firstInput);
    for (let i = 1; i < 64; i++)
      await store.applySessionApiMutation('s1', request(await read(), 'quota-' + i, 'setPinned', i % 2 === 0));
    const full = await read(); assert.equal(full.remainingMutationReceipts, 0);
    await assert.rejects(store.applySessionApiMutation('s1', request(full, 'overflow')), { code: 'RESOURCE_LIMIT' });
    assert.deepEqual({ ...await store.applySessionApiMutation('s1', firstInput), duplicate: false }, first);
    assert.equal((await disk())[0].appApiMutationReceipts.length, 64);
  });

  test('corrupt/missing disk and malformed private journals never become successful empty reads', async () => {
    await seed(); const valid = await readFile(CHAT_SESSIONS_FILE, 'utf8');
    for (const raw of ['{', '{}', '[{"id":"s1"},{"id":"s1"}]',
      JSON.stringify([{ id: 's1', appApiRevision: ['bad'] }]),
      JSON.stringify([{ id: 's1', appApiMutationReceipts: [{ requestId: 'r' }] }])]) {
      await writeFile(CHAT_SESSIONS_FILE, raw);
      await assert.rejects(read(), { code: 'SESSION_MUTATION_STORE_INVALID' });
    }
    await writeFile(CHAT_SESSIONS_FILE, valid);
    const parked = CHAT_SESSIONS_FILE + '.parked';
    await rename(CHAT_SESSIONS_FILE, parked);
    try { await assert.rejects(read(), { code: 'SESSION_MUTATION_STORE_INVALID' }); }
    finally { await rename(parked, CHAT_SESSIONS_FILE); }
    assert.equal((await read()).title, 'Original');
  });

  test('corrupted retained receipt extensions cannot leak paths or private content', async () => {
    const c = await seed(); await store.applySessionApiMutation('s1', request(c));
    const meta = (await disk())[0];
    for (const patch of [{ path: 'private' }, { changed: 'yes' }, { duplicate: true },
      { projectId: [] }, { observedAt: 'not a timestamp' }]) {
      const copy = structuredClone(meta); Object.assign(copy.appApiMutationReceipts[0].receipt, patch);
      assert.throws(() => sessionApiReceipts(copy), { code: 'SESSION_MUTATION_STORE_INVALID' });
    }
    assert.throws(() => projectSessionApiContext({ ...meta, lastReviewedAt: 'x'.repeat(500) }), { code: 'SESSION_MUTATION_STORE_INVALID' });
  });

  test('normal Session list/detail never expose private revisions or journals', async () => {
    const c = await seed(); await store.applySessionApiMutation('s1', request(c));
    const meta = (await disk())[0];
    for (const shape of [createSessionDetail(meta), createSessionListItem(meta)]) {
      for (const key of ['appApiRevision', 'appApiScopeRevision', 'appApiMutationReceipts']) assert.equal(shape[key], undefined);
    }
    assert.equal(meta.appApiMutationReceipts.length, 1, 'Projection must not mutate persistence');
    const { renameSession } = await import('../chat/session-manager.mjs');
    const enriched = await renameSession('s1', 'Legacy public title');
    for (const key of ['appApiRevision', 'appApiScopeRevision', 'appApiMutationReceipts']) assert.equal(enriched[key], undefined);
  });

  test('migration export/import cannot transfer PC-private revisions or idempotency receipts', async () => {
    const { createProject } = await import('../chat/projects.mjs');
    const { appendEvent } = await import('../chat/history.mjs');
    const { exportSelectedProjectSessions, importSessionMigrationBundle } = await import('../chat/session-migration.mjs');
    const source = join(root, 'migration-source'), target = join(root, 'migration-target');
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'README.txt'), 'fixture');
    const project = await createProject({ name: 'Mutation migration', rootPath: source });
    const c = await seed({ projectId: project.id, folder: source });
    await store.applySessionApiMutation('s1', request(c));
    const privateMeta = (await disk())[0];
    await appendEvent('s1', { type: 'message', role: 'user', content: 'Migration fixture' });
    const exported = await exportSelectedProjectSessions({ projectId: project.id, sessionIds: ['s1'], targetPath: target });
    const metadataPath = join(exported.bundlePath, 'sessions', 's1', 'session-meta.json');
    const external = JSON.parse(await readFile(metadataPath, 'utf8'));
    for (const key of ['appApiRevision', 'appApiScopeRevision', 'appApiMutationReceipts']) assert.equal(external[key], undefined);
    // An old/malicious bundle may still contain these fields; import drops them.
    await writeFile(metadataPath, JSON.stringify({ ...external, appApiRevision: privateMeta.appApiRevision,
      appApiScopeRevision: privateMeta.appApiScopeRevision, appApiMutationReceipts: privateMeta.appApiMutationReceipts }));
    await store.removeSessionMeta('s1');
    const originalHistory = join(CHAT_HISTORY_DIR, 's1');
    const underRoot = relative(root, originalHistory);
    assert.ok(underRoot && !underRoot.startsWith('..') && !isAbsolute(underRoot));
    await rename(originalHistory, join(root, 'migration-original-history'));
    await importSessionMigrationBundle({ bundlePath: exported.bundlePath, projectRootPath: target });
    const imported = await read();
    assert.notEqual(imported.scopeRevision, c.scopeRevision);
    assert.notEqual(imported.revision, privateMeta.appApiRevision);
    assert.equal(imported.remainingMutationReceipts, 64);
    assert.equal(await store.readSessionApiMutationReceipt('s1', 'r1'), null);
    await assert.rejects(store.applySessionApiMutation('s1', request(c)), { code: 'REVISION_CONFLICT' });
  });

  test('production router exposes contract, context, write and receipt with no-store', async () => {
    const c = await seed();
    const contract = await route('/api/session-mutation-contract');
    assert.equal(contract.status, 200); assert.equal(contract.body.conditionalMetadataOnly, true);
    const context = await route('/api/sessions/s1/app-api-context');
    assert.equal(context.status, 200); assert.equal(context.body.revision, c.revision);
    const written = await route('/api/sessions/s1/app-api-mutations', { method: 'POST', payload: request(c) });
    assert.equal(written.status, 200); assert.equal(written.body.duplicate, false);
    assert.equal(written.headers['Cache-Control'], 'private, no-store');
    assert.deepEqual((await route('/api/sessions/s1/app-api-mutations/r1')).body, written.body);
    assert.equal((await route('/api/sessions/s1/app-api-mutations/missing')).body, null);
    assert.equal((await route('/api/sessions/missing/app-api-context')).status, 404);
  });

  test('owner/paired-device auth and session access gates precede mutation effects', async () => {
    const c = await seed();
    for (const auth of [null, { role: 'visitor' }, { role: 'run_capability', principalKind: 'run_capability' },
      { role: 'owner', principalKind: 'run_capability' }, { role: 'owner', principalKind: 'provisional_device' }]) {
      const result = await route('/api/sessions/s1/app-api-mutations', { method: 'POST', payload: request(c), auth });
      assert.equal(result.status, 403); assert.equal(result.accessCalls, 0);
    }
    const denied = await route('/api/sessions/s1/app-api-mutations', { method: 'POST', payload: request(c), access: false });
    assert.equal(denied.status, 403); assert.equal(denied.accessCalls, 1);
    assert.equal((await disk())[0].name, 'Original');
    assert.equal((await route('/api/sessions/s1/app-api-context', { auth: { role: 'owner', principalKind: 'trusted_device' } })).status, 200);
  });

  test('route method, encoding, query, UTF-8, JSON and byte limits reject invalid calls', async () => {
    const c = await seed();
    assert.equal((await route('/api/session-mutation-contract', { method: 'POST' })).status, 405);
    assert.equal((await route('/api/sessions/s1/app-api-mutations')).status, 405);
    assert.equal((await route('/api/sessions/%ZZ/app-api-context')).status, 400);
    assert.equal((await route('/api/sessions/%0A/app-api-context')).status, 400);
    assert.equal((await route('/api/sessions/s1/app-api-context?private=true')).status, 400);
    assert.equal((await route('/api/sessions/s1/app-api-mutations', { method: 'POST', raw: '{' })).status, 400);
    assert.equal((await route('/api/sessions/s1/app-api-mutations', { method: 'POST', chunks: [Buffer.from([0xff])] })).status, 400);
    assert.equal((await route('/api/sessions/s1/app-api-mutations', { method: 'POST', raw: 'x'.repeat(8193) })).status, 413);
    assert.equal((await route('/api/sessions/s1/app-api-mutations', { method: 'POST', headers: { 'content-length': '8193' } })).status, 413);
    assert.equal((await route('/api/sessions/s1/app-api-mutations', { method: 'POST', payload: request(c), headers: { 'content-type': 'text/plain' } })).status, 415);
    const utf8 = Buffer.from(JSON.stringify(request(c, 'unicode', 'rename', '中文😀')));
    const index = utf8.indexOf(Buffer.from('😀')) + 1;
    const valid = await route('/api/sessions/s1/app-api-mutations', { method: 'POST', chunks: [utf8.subarray(0, index), utf8.subarray(index)] });
    assert.equal(valid.status, 200); assert.equal((await read()).title, '中文😀');
    assert.equal((await route('/unrelated')).handled, false);
  });

  test('post-commit invalidation failure cannot change durable success; no duplicate hints', async () => {
    const c = await seed(); let hints = 0;
    const args = { method: 'POST', payload: request(c), direct: true, invalidate: () => { hints++; throw new Error('private'); } };
    const first = await route('/api/sessions/s1/app-api-mutations', args);
    assert.equal(first.status, 200);
    const repeat = await route('/api/sessions/s1/app-api-mutations', args);
    assert.equal(repeat.status, 200); assert.equal(repeat.body.duplicate, true); assert.equal(hints, 1);
  });

  test('opt-in durable atomic utility cleans failed rename and preserves ordinary writes', async () => {
    const file = join(root, 'utility.json');
    await writeJsonAtomic(file, { before: true });
    await patchFs('rename', original => async (from, to) => {
      if (to === file) throw new Error('Injected rename');
      return original(from, to);
    }, async () => assert.rejects(writeJsonAtomic(file, { after: true }, { durable: true })));
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { before: true });
    assert.equal((await readdir(root)).filter(x => x.startsWith('utility.json.tmp-')).length, 0);
    await writeJsonAtomic(file, { after: true }, { durable: true });
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { after: true });
  });
}
