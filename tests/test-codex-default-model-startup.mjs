import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import {
  createCodexAppServerRunState,
  configureCodexAccountModelCatalog,
  handleCodexAppServerInitializeResponse,
  writeCodexAppServerThreadStart,
  maybeStartCodexAppServerTurn,
  isUnrequestedCodexThreadEvent,
} from '../chat/runner-sidecar.mjs';

const fixtureRoot = process.env.RAGENT_TEST_EVIDENCE_ROOT || tmpdir();

async function providerHome(auth) {
  const root = await mkdtemp(join(fixtureRoot, 'codex-catalog-fixture-'));
  const home = join(root, 'provider');
  await mkdir(home);
  await writeFile(join(home, 'auth.json'), JSON.stringify(auth));
  await writeFile(join(home, 'config.toml'), 'model = "stale-config-model"\n');
  return home;
}

test('official implicit Run preparation cannot start a separate catalog upstream', async () => {
  const state = await createCodexAppServerRunState({
    prompt: 'Synthetic prompt',
    manifest: { options: {} },
    cwd: fixtureRoot,
    codexHomeDir: await providerHome({ auth_mode: 'chatgpt', tokens: { access_token: 'fixture' } }),
  });
  assert.equal(state.model, '');
  assert.equal(state.needsAccountModelCatalog, true);
});

test('explicit official model remains authoritative without catalog startup', async () => {
  const state = await createCodexAppServerRunState({
    prompt: '',
    manifest: { options: { model: 'explicit-selected' } },
    cwd: fixtureRoot,
    codexHomeDir: await providerHome({ auth_mode: 'chatgpt', tokens: { access_token: 'fixture' } }),
  });
  assert.equal(state.model, 'explicit-selected');
  assert.equal(state.needsAccountModelCatalog, false);
});

test('nonofficial profile preserves config preference without account catalog', async () => {
  const state = await createCodexAppServerRunState({
    prompt: '',
    manifest: { options: {} },
    cwd: fixtureRoot,
    codexHomeDir: await providerHome({ auth_mode: 'apikey', OPENAI_API_KEY: 'fixture' }),
  });
  assert.equal(state.model, 'stale-config-model');
  assert.equal(state.needsAccountModelCatalog, false);
});

async function officialState(options = {}) {
  return createCodexAppServerRunState({
    prompt: 'Synthetic prompt', manifest: { options }, cwd: fixtureRoot,
    codexHomeDir: await providerHome({ auth_mode: 'chatgpt', tokens: { access_token: 'fixture' } }),
  });
}

test('actual initializer gates thread start on its own catalog and fresh authorization', async (t) => {
  const state = await officialState({ permissionMode: 'recommended' });
  state.mcpRequired = true;
  const messages = [], failures = [];
  let checks = 0;
  const proc = { stdin: { writable: true, write: (line) => messages.push(JSON.parse(line)) } };
  const catalog = configureCodexAccountModelCatalog({ proc, state,
    beforeReady: async () => { checks += 1; }, onFailure: async (error) => failures.push(error) });
  t.after(() => catalog.cancel());
  assert.equal(writeCodexAppServerThreadStart(proc, state), false);
  assert.equal(handleCodexAppServerInitializeResponse(proc, state, { id: state.initializeRequestId, result: {} }), true);
  assert.deepEqual(messages.map((message) => message.method), ['initialized', 'model/list']);
  assert.equal(state.threadRequestSent, false);
  const page = messages.at(-1);
  await catalog.consume({ id: page.id, result: { data: [{ id: 'live-default', isDefault: true }] } });
  assert.equal(checks, 1);
  assert.equal(messages.at(-1).method, 'thread/start');
  assert.equal(messages.at(-1).params.model, 'live-default');
  assert.equal(state.mcpRequired, true);
  assert.equal(state.nextControlRequestId, 1001);
  assert.deepEqual(failures, []);
  assert.equal(handleCodexAppServerInitializeResponse(proc, state, { id: state.initializeRequestId, result: {} }), false);
  assert.equal(messages.filter((message) => message.method === 'thread/start').length, 1);
});

test('actual initializer keeps explicit model and bypasses account catalog', async () => {
  const state = await officialState({ model: 'explicit-model' });
  const messages = [];
  const proc = { stdin: { writable: true, write: (line) => messages.push(JSON.parse(line)) } };
  assert.equal(configureCodexAccountModelCatalog({ proc, state }), null);
  handleCodexAppServerInitializeResponse(proc, state, { id: state.initializeRequestId, result: {} });
  assert.deepEqual(messages.map((message) => message.method), ['initialized', 'thread/start']);
  assert.equal(messages.at(-1).params.model, 'explicit-model');
});

test('actual initializer cannot start thread after authorization fails during catalog wait', async (t) => {
  const state = await officialState();
  const messages = [], failures = [];
  const proc = { stdin: { writable: true, write: (line) => messages.push(JSON.parse(line)) } };
  const denied = Object.assign(new Error('Expired fixture grant'), { code: 'RUN_EXECUTION_INPUT_UNAVAILABLE' });
  const catalog = configureCodexAccountModelCatalog({ proc, state,
    beforeReady: async () => { throw denied; }, onFailure: async (error) => failures.push(error) });
  t.after(() => catalog.cancel());
  handleCodexAppServerInitializeResponse(proc, state, { id: state.initializeRequestId, result: {} });
  await catalog.consume({ id: messages.at(-1).id, result: { data: [{ id: 'live' }] } });
  assert.equal(failures[0], denied);
  assert.equal(state.threadRequestSent, false);
  assert.equal(messages.some((message) => message.method === 'thread/start'), false);
});

test('an early thread notification cannot start a turn while catalog is pending', async () => {
  const state = await officialState();
  const messages = [];
  const proc = { stdin: { writable: true, write: (line) => messages.push(JSON.parse(line)) } };
  assert.equal(maybeStartCodexAppServerTurn(proc, state,
    { method: 'thread/started', params: { thread: { id: 'unrequested-thread' } } }), false);
  assert.deepEqual(messages, []);
  assert.equal(state.threadId, '');
});

test('thread events before an owned request are excluded from Run processing', async () => {
  const state = await officialState();
  for (const message of [
    { method: 'thread/started', params: { thread: { id: 'foreign-thread' } } },
    { method: 'turn/completed', params: { threadId: 'foreign-thread', turn: { status: 'completed' } } },
  ]) assert.equal(isUnrequestedCodexThreadEvent(state, message), true);
  assert.equal(isUnrequestedCodexThreadEvent(state, { id: 1000, result: { data: [] } }), false);
  state.threadRequestSent = true;
  assert.equal(isUnrequestedCodexThreadEvent(state,
    { method: 'thread/started', params: { thread: { id: 'owned-thread' } } }), false);
});

test('cancelled explicit startup cannot initialize or send thread and turn requests', async () => {
  const state = await officialState({ model: 'explicit-model' });
  const messages = [];
  const proc = { stdin: { writable: true, write: (line) => messages.push(JSON.parse(line)) } };
  state.startupCancelled = true;
  assert.equal(handleCodexAppServerInitializeResponse(proc, state,
    { id: state.initializeRequestId, result: {} }), false);
  assert.equal(writeCodexAppServerThreadStart(proc, state), false);
  state.threadRequestSent = true;
  assert.equal(maybeStartCodexAppServerTurn(proc, state,
    { method: 'thread/started', params: { thread: { id: 'owned-thread' } } }), false);
  assert.deepEqual(messages, []);
});

test('actual thread confirmation starts a turn only after the owned thread request', async () => {
  const state = await officialState({ model: 'explicit-model' });
  const messages = [];
  const proc = { stdin: { writable: true, write: (line) => messages.push(JSON.parse(line)) } };
  handleCodexAppServerInitializeResponse(proc, state, { id: state.initializeRequestId, result: {} });
  assert.equal(maybeStartCodexAppServerTurn(proc, state,
    { id: state.threadRequestId, result: { thread: { id: 'owned-thread' } } }), true);
  assert.equal(messages.at(-1).method, 'turn/start');
  assert.equal(messages.at(-1).params.model, 'explicit-model');
});

test('one owned fake upstream handles catalog, thread and synthetic turn over the same stdio', { timeout: 8_000 }, async (t) => {
  const state = await officialState();
  const script = `
    import { createInterface } from 'node:readline';
    const send = message => process.stdout.write(JSON.stringify({ ...message, fixturePid: process.pid })+'\\n');
    createInterface({ input: process.stdin }).on('line', line => {
      const message=JSON.parse(line);
      if(message.method==='initialize') send({ id:message.id,result:{} });
      else if(message.method==='model/list') send({ id:message.id,result:message.params.cursor
        ? { data:[{ id:'live-default',isDefault:true }], nextCursor:null }
        : { data:[{ id:'first-visible' }], nextCursor:'next' } });
      else if(message.method==='thread/start') send({ id:message.id,result:{ thread:{ id:'fixture-thread',model:message.params.model } } });
      else if(message.method==='turn/start') send({ method:'turn/completed',params:{ threadId:'fixture-thread',turn:{ id:'fixture-turn',status:'completed' } } });
    });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['pipe', 'pipe', 'pipe'] });
  const exit = once(child, 'exit');
  const reader = createInterface({ input: child.stdout });
  const pids = new Set(), methods = [];
  let resolveDone, rejectDone;
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  const deadline = setTimeout(() => rejectDone(new Error('Owned fake upstream exceeded 5 seconds')), 5_000);
  const catalog = configureCodexAccountModelCatalog({ proc: child, state,
    beforeReady: async () => {}, onFailure: async (error) => rejectDone(error) });
  let queued = Promise.resolve();
  reader.on('line', (line) => {
    queued = queued.then(async () => {
      const message = JSON.parse(line); pids.add(message.fixturePid);
      if (handleCodexAppServerInitializeResponse(child, state, message)) return;
      if (await catalog.consume(message)) return;
      if (message.result?.thread) {
        assert.equal(message.result.thread.model, 'live-default');
        assert.equal(maybeStartCodexAppServerTurn(child, state, message), true);
      } else if (message.method === 'turn/completed') resolveDone();
    }).catch(rejectDone);
  });
  const originalWrite = child.stdin.write.bind(child.stdin);
  child.stdin.write = (line, ...args) => { methods.push(JSON.parse(line).method); return originalWrite(line, ...args); };
  try {
    child.stdin.write(JSON.stringify({ id: state.initializeRequestId, method: 'initialize', params: {} })+'\n');
    await done; await queued;
    assert.deepEqual([...pids], [child.pid]);
    assert.deepEqual(methods, ['initialize', 'initialized', 'model/list', 'model/list', 'thread/start', 'turn/start']);
    t.diagnostic(JSON.stringify({ syntheticOnly: true, childPid: child.pid,
      executable: process.execPath, oneUpstream: pids.size === 1, methods }));
  } finally {
    clearTimeout(deadline); catalog.cancel(); reader.close(); child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exit;
  }
});
