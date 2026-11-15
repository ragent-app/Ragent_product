import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, readFile, writeFile, rename, readdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fork, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { syncBuiltinESMExports } from 'node:module';
import { test, after } from 'node:test';

const root = process.env.RAGENT_RUN_PUBLICATION_TEST_ROOT || await mkdtemp(join(tmpdir(), 'ragent-run-publication-'));
process.env.RAGENT_INSTANCE_ROOT = root;
process.env.RAGENT_CONFIG_DIR = join(root, 'config');
process.env.RAGENT_MEMORY_DIR = join(root, 'memory');
process.env.RAGENT_AUTH_SESSION_SECRET = 'isolated-run-publication-fixture-secret';
const runs = await import('../chat/runs.mjs');
const contract = await import('../chat/run-publication-contract.mjs');
const meta = await import('../chat/session-meta-store.mjs');
const { getMessageSubmissionReceipt } = await import('../chat/session-manager.mjs');
let seq = 0;
const input = (id = `publish-${++seq}`) => ({ status: { id, sessionId: `session-${id}`, requestId: `request-${id}`, state: 'preparing' },
  manifest: { sessionId: `session-${id}`, requestId: `request-${id}`, preparation: { version: 1, text: '原始资料', options: {} } } });
const path = (id, file) => join(runs.runDir(id), file);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function seed(value) {
  await meta.withSessionsMetaMutation(async (rows, save) => {
    rows.push({ id: value.status.sessionId, folder: root, name: 'Publication', tool: 'codex', sourceId: 'chat' });
    await save(rows, { immediate: true });
  });
}

if (process.argv[2] === 'cold') {
  const value = JSON.parse(process.env.RAGENT_RUN_PUBLICATION_INPUT);
  const receipt = await getMessageSubmissionReceipt(value.status.sessionId, value.status.requestId);
  const evidence = await runs.findRunByRequest(value.status.sessionId, value.status.requestId);
  process.stdout.write('COLD=' + JSON.stringify({ receipt, evidence }) + '\n');
} else if (process.argv[2] === 'duplicate') {
  const value = JSON.parse(process.env.RAGENT_RUN_PUBLICATION_INPUT);
  await assert.rejects(runs.createRun(value), { code: 'RUN_ALREADY_EXISTS' });
  process.stdout.write('COLD_DUPLICATE_REJECTED\n');
} else if (process.argv[2] === 'crash') {
  const value = JSON.parse(process.env.RAGENT_RUN_PUBLICATION_INPUT);
  const window = process.env.RAGENT_RUN_PUBLICATION_WINDOW;
  const original = fs.promises.rename;
  fs.promises.rename = async (from, to) => {
    const target = String(to);
    if (target === path(value.status.id, 'manifest.json') && window === 'before-manifest') {
      process.send({ type: 'window', window, pid: process.pid });
      await new Promise(() => {});
    }
    const result = await original(from, to);
    if ((target === path(value.status.id, 'manifest.json') && window === 'after-manifest') ||
        (target === path(value.status.id, 'status.json') && window === 'after-status')) {
      process.send({ type: 'window', window, pid: process.pid });
      await new Promise(() => {});
    }
    return result;
  };
  syncBuiltinESMExports();
  await runs.createRun(value);
  throw new Error('Crash checkpoint did not intercept publication');
} else {
after(async () => { await meta.flushSessionsMetaNow(); console.log('Retained isolated publication root: ' + root); });

test('publication binds the actual Run/Session/request and rejects conflicting or caller-supplied markers', async () => {
  const value = input();
  for (const key of ['id', 'sessionId', 'requestId']) {
    await assert.rejects(runs.createRun({ ...value, manifest: { ...value.manifest, [key]: 'different' } }), { code: 'INVALID_ARGUMENT' });
  }
  await assert.rejects(runs.createRun({ ...value, manifest: { ...value.manifest, runPublication: contract.createRunPublication() } }), { code: 'INVALID_ARGUMENT' });
  const run = await runs.createRun(value);
  const manifest = await runs.getRunManifest(run.id);
  assert.equal(contract.assertRunPublication(run, manifest), true);
  assert.deepEqual(await runs.getRunAcceptanceEvidence(run.id), run);
});

test('real files and all initial secret inputs sync before manifest and status publication', async () => {
  const value = input();
  value.manifest.options = { browserMcpEnabled: true, sessionControlChannel: {
    token: 'test-primary-token', renewalToken: 'test-renewal-token', runId: value.status.id,
    sessionId: value.status.sessionId, turnId: value.status.requestId, version: 1 } };
  const events = [];
  const originalOpen = fs.promises.open; const originalRename = fs.promises.rename;
  fs.promises.open = async (...args) => {
    const handle = await originalOpen(...args);
    const realSync = handle.sync.bind(handle);
    handle.sync = async () => { const result = await realSync(); events.push(['sync', String(args[0])]); return result; };
    return handle;
  };
  fs.promises.rename = async (from, to) => { const result = await originalRename(from, to); events.push(['rename', String(to)]); return result; };
  syncBuiltinESMExports();
  try { await runs.createRun(value); } finally { fs.promises.open = originalOpen; fs.promises.rename = originalRename; syncBuiltinESMExports(); }
  const statusIndex = events.findIndex(([kind, file]) => kind === 'rename' && file === path(value.status.id, 'status.json'));
  const manifestIndex = events.findIndex(([kind, file]) => kind === 'rename' && file === path(value.status.id, 'manifest.json'));
  assert.ok(statusIndex > manifestIndex && manifestIndex >= 0);
  for (const file of ['status.json', 'manifest.json', 'auth-recovery.cap', 'browser.cap', 'session-control.cap', 'session-control-renewal.cap']) {
    const publish = events.findIndex(([kind, target]) => kind === 'rename' && basename(target) === file);
    assert.ok(publish >= 0 && publish <= statusIndex, file);
    assert.ok(events.slice(0, publish).some(([kind, target]) => kind === 'sync' && target.startsWith(path(value.status.id, file) + '.tmp-')), file);
  }
});

test('lookup cannot observe accepted status while real manifest publication is held', async () => {
  const value = input(); await seed(value);
  const entered = deferred(); const release = deferred(); const original = fs.promises.rename;
  fs.promises.rename = async (from, to) => {
    if (String(to) === path(value.status.id, 'manifest.json')) { entered.resolve(); await release.promise; }
    return original(from, to);
  };
  syncBuiltinESMExports();
  const creation = runs.createRun(value);
  try {
    await entered.promise;
    assert.equal(await runs.getRun(value.status.id), null);
    assert.equal(await runs.findRunByRequest(value.status.sessionId, value.status.requestId), null);
    assert.equal((await getMessageSubmissionReceipt(value.status.sessionId, value.status.requestId)).state, 'unconfirmed');
  } finally { release.resolve(); fs.promises.rename = original; syncBuiltinESMExports(); }
  const run = await creation;
  assert.equal((await getMessageSubmissionReceipt(value.status.sessionId, value.status.requestId)).runId, run.id);
});

for (const file of ['manifest.json', 'status.json']) test(`failed ${file} publication never accepts an incomplete Run and exact Run-ID retry succeeds`, async () => {
  const value = input(); await seed(value);
  const original = fs.promises.rename;
  fs.promises.rename = async (from, to) => {
    if (String(to) === path(value.status.id, file)) throw Object.assign(new Error('injected publication failure'), { code: 'EIO' });
    return original(from, to);
  };
  syncBuiltinESMExports();
  try { await assert.rejects(runs.createRun(value), { code: 'EIO' }); }
  finally { fs.promises.rename = original; syncBuiltinESMExports(); }
  assert.equal(await runs.getRun(value.status.id), null);
  assert.equal((await getMessageSubmissionReceipt(value.status.sessionId, value.status.requestId)).state, 'unconfirmed');
  const files = await readdir(runs.runDir(value.status.id));
  assert.ok(!files.some(name => name.includes('.tmp-') || name === '.mutation.lock'));
  const run = await runs.createRun(value);
  assert.equal((await runs.findRunByRequest(value.status.sessionId, value.status.requestId)).id, run.id);
});

test('published same Run ID cannot be recreated or credentials replaced by concurrent creation', async () => {
  const value = input();
  const outcomes = await Promise.allSettled([runs.createRun(value), runs.createRun({ ...value, manifest: { ...value.manifest, prompt: 'different' } })]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(result => result.status === 'rejected').reason.code, 'RUN_ALREADY_EXISTS');
  const before = await readFile(path(value.status.id, 'manifest.json'));
  await assert.rejects(runs.createRun(value), { code: 'RUN_ALREADY_EXISTS' });
  const cold = await promisify(execFile)(process.execPath, [import.meta.filename, 'duplicate'], {
    env: { ...process.env, RAGENT_RUN_PUBLICATION_TEST_ROOT: root, RAGENT_RUN_PUBLICATION_INPUT: JSON.stringify(value) }, timeout: 10000 });
  assert.match(cold.stdout, /COLD_DUPLICATE_REJECTED/);
  assert.deepEqual(await readFile(path(value.status.id, 'manifest.json')), before);
});

test('actual credential file sync failure prevents manifest/status acceptance and cleans its private temp', async () => {
  const value = input(); await seed(value); const original = fs.promises.open;
  fs.promises.open = async (...args) => {
    const handle = await original(...args);
    if (String(args[0]).startsWith(path(value.status.id, 'auth-recovery.cap') + '.tmp-'))
      handle.sync = async () => { throw Object.assign(new Error('injected credential sync failure'), { code: 'EIO' }); };
    return handle;
  };
  syncBuiltinESMExports();
  try { await assert.rejects(runs.createRun(value), { code: 'EIO' }); }
  finally { fs.promises.open = original; syncBuiltinESMExports(); }
  assert.equal((await getMessageSubmissionReceipt(value.status.sessionId, value.status.requestId)).state, 'unconfirmed');
  assert.ok(!(await readdir(runs.runDir(value.status.id))).some(name => name.endsWith('.json') || name.includes('.tmp-') || name === '.mutation.lock'));
  await runs.createRun(value);
});

test('preparing-to-executable manifest replacement retains immutable binding and publication token', async () => {
  const run = await runs.createRun(input());
  const next = await runs.updateRunManifest(run.id, () => ({ prompt: 'Resolved prompt', folder: root, options: {} }));
  assert.equal(next.id, run.id); assert.equal(next.sessionId, run.sessionId); assert.equal(next.requestId, run.requestId);
  assert.deepEqual(next.runPublication, run.runPublication);
  const updated = await runs.updateRun(run.id, { state: 'accepted' });
  assert.deepEqual(await runs.getRunAcceptanceEvidence(run.id), updated);
  for (const key of ['id', 'sessionId', 'requestId']) {
    await assert.rejects(runs.updateRunManifest(run.id, current => ({ ...current, [key]: 'different' })), { code: 'RUN_PUBLICATION_CONFLICT' });
    await assert.rejects(runs.updateRun(run.id, { [key]: 'different' }), { code: 'RUN_PUBLICATION_CONFLICT' });
  }
  await assert.rejects(runs.updateRun(run.id, { runPublication: null }), { code: 'RUN_PUBLICATION_CONFLICT' });
  await assert.rejects(runs.updateRunManifest(run.id, current => ({ ...current, runPublication: null })), { code: 'RUN_PUBLICATION_CONFLICT' });
  await assert.rejects(runs.updateRunManifest(run.id, current => {
    current.runPublication.publicationId = contract.createRunPublication().publicationId;
    return { ...current, prompt: 'Aliased rewrite' };
  }), { code: 'RUN_PUBLICATION_CONFLICT' });
  assert.deepEqual((await runs.getRunAcceptanceEvidence(run.id)).runPublication, run.runPublication);
});

test('actual sidecar input gate rejects publication rebinding before even text-only provider execution', async () => {
  const run = await runs.createRun(input()); const manifest = await runs.getRunManifest(run.id);
  const { verifyRunInputBinding } = await import('../chat/runner-sidecar.mjs');
  verifyRunInputBinding(manifest, run, run.id);
  for (const changed of [{ ...manifest, sessionId: 'foreign' }, { ...manifest, runPublication: null }])
    assert.throws(() => verifyRunInputBinding(changed, run, run.id), { code: 'RUN_PUBLICATION_UNAVAILABLE' });
  assert.throws(() => verifyRunInputBinding(manifest, run, 'foreign-run'), { code: 'RUN_PUBLICATION_UNAVAILABLE' });
});

test('fresh acceptance fails closed on missing, damaged or rebound manifests despite cached successful reads', async () => {
  const value = input(); await seed(value); const run = await runs.createRun(value);
  const manifestPath = path(run.id, 'manifest.json'); const original = await readFile(manifestPath);
  await runs.getRunManifest(run.id);
  const hold = manifestPath + '.held'; await rename(manifestPath, hold);
  try { await assert.rejects(getMessageSubmissionReceipt(run.sessionId, run.requestId), { code: 'RUN_PUBLICATION_UNAVAILABLE' }); }
  finally { await rename(hold, manifestPath); }
  for (const body of ['{broken', JSON.stringify({ ...JSON.parse(original), sessionId: 'foreign' }),
      JSON.stringify({ ...JSON.parse(original), runPublication: null })]) {
    await writeFile(manifestPath, body);
    await assert.rejects(runs.findRunByRequest(run.sessionId, run.requestId), { code: 'RUN_PUBLICATION_UNAVAILABLE' });
  }
  await writeFile(manifestPath, original);
  assert.equal((await runs.findRunByRequest(run.sessionId, run.requestId)).id, run.id);
});

test('actual metadata-only receipt/result routes return private 503 for an incomplete published Run', async () => {
  const value = input(); await seed(value); const run = await runs.createRun(value);
  const manifestPath = path(run.id, 'manifest.json'); const original = await readFile(manifestPath);
  await writeFile(manifestPath, '{broken');
  const { handleSessionMainRoutes } = await import('../chat/router-session-main-routes.mjs');
  try {
    for (const action of ['message-receipts', 'message-results']) {
      const parsedUrl = new URL(`/api/sessions/${run.sessionId}/${action}/${run.requestId}`, 'http://localhost');
      const res = { headers: {}, setHeader(key, value) { this.headers[key] = value; } };
      const handled = await handleSessionMainRoutes({ req: { method: 'GET', headers: {} }, res,
        parsedUrl, pathname: parsedUrl.pathname, authSession: { role: 'owner' },
        requireSessionAccess: async (_res, _auth, id, flags) => { assert.equal(id, run.sessionId); assert.equal(flags.metadataOnly, true); return true; },
        writeJson: (_res, status, body) => Object.assign(res, { status, body }) });
      assert.equal(handled, true); assert.equal(res.status, 503); assert.equal(res.headers['Cache-Control'], 'private, no-store');
      assert.ok(!JSON.stringify(res.body).includes(root)); assert.equal(Object.hasOwn(res.body, 'runId'), false);
    }
  } finally { await writeFile(manifestPath, original); }
});

test('fresh evidence detects corrupted status and one-sided marker removal, while legacy remains readable', async () => {
  const value = input(); const run = await runs.createRun(value); const statusPath = path(run.id, 'status.json');
  const original = await readFile(statusPath);
  for (const body of ['{broken', JSON.stringify({ ...JSON.parse(original), id: 'wrong' }),
      JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(original)).filter(([key]) => key !== 'runPublication')))]) {
    await writeFile(statusPath, body);
    await assert.rejects(runs.findRunByRequest(run.sessionId, run.requestId), { code: 'RUN_PUBLICATION_UNAVAILABLE' });
  }
  await writeFile(statusPath, original);
  const legacy = input(); await runs.ensureRunDirectory(legacy.status.id);
  await writeFile(path(legacy.status.id, 'status.json'), JSON.stringify(legacy.status));
  assert.deepEqual(await runs.getRunAcceptanceEvidence(legacy.status.id), legacy.status);
});

test('Run publication inside the actual Session guard rejects stale scope and leaves no status', async () => {
  const value = input(); await seed(value);
  const context = await meta.readSessionApiContext(value.status.sessionId);
  const scope = { version: 1, sessionId: context.sessionId, expectedScopeRevision: context.scopeRevision, expectedProjectId: context.projectId };
  await meta.withSessionsMetaMutation(async (rows, save) => { rows.find(row => row.id === context.sessionId).projectId = 'moved'; await save(rows, { immediate: true }); });
  await assert.rejects(meta.withSessionApiScope(context.sessionId, scope, () => runs.createRun(value)), { code: 'REVISION_CONFLICT' });
  assert.equal(await runs.getRun(value.status.id), null);
  const fresh = await meta.readSessionApiContext(context.sessionId);
  const run = await meta.withSessionApiScope(context.sessionId, { ...scope, expectedProjectId: fresh.projectId, expectedScopeRevision: fresh.scopeRevision }, () => runs.createRun(value));
  assert.equal((await runs.getRunAcceptanceEvidence(run.id)).id, run.id);
});

for (const window of ['before-manifest', 'after-manifest', 'after-status']) test(`owned process death at ${window} has truthful cold acceptance and recoverable exact identity`, { timeout: 20000 }, async () => {
  const value = input(); await seed(value);
  const env = { ...process.env, RAGENT_RUN_PUBLICATION_TEST_ROOT: root, RAGENT_RUN_PUBLICATION_INPUT: JSON.stringify(value), RAGENT_RUN_PUBLICATION_WINDOW: window };
  const child = fork(import.meta.filename, ['crash'], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  try {
    const checkpoint = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('checkpoint timeout: ' + output)), 10000);
      child.once('message', value => { clearTimeout(timer); resolve(value); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('premature exit: ' + output)); });
    });
    assert.equal(checkpoint.window, window); assert.equal(checkpoint.pid, child.pid);
    assert.equal(child.kill('SIGKILL'), true); const exit = await exited;
    assert.ok(exit.signal || exit.code !== 0, JSON.stringify(exit));
    const cold = await promisify(execFile)(process.execPath, [import.meta.filename, 'cold'], { env, timeout: 10000 });
    const evidence = JSON.parse(cold.stdout.match(/COLD=(.+)/)[1]);
    assert.equal(evidence.receipt.state, window === 'after-status' ? 'accepted' : 'unconfirmed');
    if (window === 'after-status') {
      assert.equal(evidence.evidence.id, value.status.id);
      assert.deepEqual(evidence.evidence.runPublication, JSON.parse(await readFile(path(value.status.id, 'manifest.json'), 'utf8')).runPublication);
      await assert.rejects(runs.createRun(value), { code: 'RUN_ALREADY_EXISTS' });
    } else {
      assert.equal(evidence.evidence, null);
      const run = await runs.createRun(value);
      assert.equal((await runs.findRunByRequest(run.sessionId, run.requestId)).id, value.status.id);
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
  }
});
}
