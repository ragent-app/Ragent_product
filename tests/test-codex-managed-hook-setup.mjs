import assert from 'node:assert/strict';
import { createCodexManagedHookSetup } from '../chat/codex-managed-hook-setup.mjs';
import { consumeCodexSharedHookRegistration, handleCodexAppServerInitializeResponse } from '../chat/runner-sidecar.mjs';

const configPath = 'D:\\agentoc\\run\\config.toml', cwd = 'E:\\project';
const command = "& 'D:\\node.exe' 'D:\\agentoc\\hook.mjs'";
const hook = { key: `${configPath}:pre_tool_use:0:0`, source: 'user', sourcePath: configPath, isManaged: false, enabled: true,
  eventName: 'preToolUse', handlerType: 'command', matcher: '^Bash$', command, currentHash: 'sha256:' + 'a'.repeat(64), trustStatus: 'untrusted' };
const result = value => ({ data: [{ cwd, hooks: [value] }] });
function setup() {
  let id = 0; const sent = [], done = [];
  const instance = createCodexManagedHookSetup({ cwd, configPath, command, nextRequestId: () => ++id, send: value => { sent.push(value); return true; }, onDone: value => done.push(value) });
  instance.start(); return { instance, sent, done };
}
{
  const { instance, sent, done } = setup();
  assert.equal(instance.consume({ id: 99, result: result(hook) }), false);
  instance.consume({ id: 1, result: result(hook) });
  assert.deepEqual(sent[1], { id: 2, method: 'config/batchWrite', params: { filePath: configPath, reloadUserConfig: true,
    edits: [{ keyPath: 'hooks.state', mergeStrategy: 'upsert', value: { [hook.key]: { trusted_hash: hook.currentHash } } }] } });
  instance.consume({ id: 2, result: {} });
  assert.equal(sent[2].method, 'hooks/list');
  instance.consume({ id: 3, result: result({ ...hook, trustStatus: 'trusted' }) });
  assert.deepEqual(done, [true]);
}
for (const bad of [{ ...hook, sourcePath: 'D:\\other\\config.toml' }, { ...hook, command: 'evil' },
  { ...hook, currentHash: 'sha256:bad' }, { ...hook, isManaged: true }, { ...hook, enabled: false }]) {
  const { instance, sent, done } = setup(); instance.consume({ id: 1, result: result(bad) });
  assert.deepEqual(done, [false]); assert.equal(sent.length, 1);
}
{
  const { instance, done } = setup(); instance.consume({ id: 1, result: result(hook) }); instance.consume({ id: 2, result: {} });
  instance.consume({ id: 3, result: result({ ...hook, currentHash: 'sha256:' + 'b'.repeat(64), trustStatus: 'trusted' }) });
  assert.deepEqual(done, [false]);
}
{
  const sourcePath = 'C:\\<session-flags>\\config.toml';
  const sessionHook = { ...hook, key: `${sourcePath}:pre_tool_use:0:0`, source: 'sessionFlags', sourcePath, displayOrder: 3 };
  let id = 0, finished;
  const sent = [];
  const instance = createCodexManagedHookSetup({ cwd, configPath, sourcePath, source: 'sessionFlags', command,
    nextRequestId: () => ++id, send: value => { sent.push(value); return true; }, onDone: (ready, selected) => { finished = { ready, selected }; } });
  instance.start(); instance.consume({ id: 1, result: result(sessionHook) }); instance.consume({ id: 2, result: {} });
  instance.consume({ id: 3, result: result({ ...sessionHook, trustStatus: 'trusted' }) });
  assert.equal(finished.ready, true);
  assert.equal(finished.selected.displayOrder, 3);
  assert.equal(finished.selected.trustStatus, 'trusted');
  assert.equal(sent[1].params.filePath, configPath);
}
{
  const messages = [];
  const proc = { stdin: { writable: true, write: text => { messages.push(JSON.parse(text)); return true; } } };
  const state = { initialized: false, initializeRequestId: 0, threadRequestId: 1, nextControlRequestId: 1000, cwd,
    codexWindowsInstallHook: { command, configPath }, riskMode: 'recommended', model: 'fixture', pendingApprovals: new Map() };
  assert.equal(handleCodexAppServerInitializeResponse(proc, state, { id: 0, result: {} }), true);
  assert.equal(messages[0].method, 'initialized');
  assert.equal(messages[1].method, 'hooks/list');
  assert.ok(!messages.some(m => m.method === 'thread/start'));
  state.codexManagedHookSetup.consume({ id: 1000, result: result(hook) });
  state.codexManagedHookSetup.consume({ id: 1001, result: {} });
  state.codexManagedHookSetup.consume({ id: 1002, result: result({ ...hook, trustStatus: 'trusted' }) });
  assert.equal(state.codexManagedHookReady, true);
  assert.equal(messages.at(-1).method, 'thread/start');
}
{
  const messages = [];
  const proc = { stdin: { writable: true, write: text => { messages.push(JSON.parse(text)); return true; } } };
  const sourcePath = 'C:\\<session-flags>\\config.toml';
  const sharedHook = { ...hook, source: 'sessionFlags', sourcePath, key: `${sourcePath}:pre_tool_use:0:0`, displayOrder: 2 };
  const state = { initialized: false, initializeRequestId: 0, threadRequestId: 1, nextControlRequestId: 1000, cwd,
    codexWindowsInstallHook: { command, configPath, sourcePath, source: 'sessionFlags', shared: true }, riskMode: 'recommended', model: 'fixture' };
  handleCodexAppServerInitializeResponse(proc, state, { id: 0, result: {} });
  state.codexManagedHookSetup.consume({ id: 1000, result: result(sharedHook) });
  state.codexManagedHookSetup.consume({ id: 1001, result: {} });
  state.codexManagedHookSetup.consume({ id: 1002, result: result({ ...sharedHook, trustStatus: 'trusted' }) });
  assert.equal(messages.at(-1).method, 'agentoc/registerWindowsHook');
  assert.deepEqual(messages.at(-1).params, { sourcePath, displayOrder: 2 });
  assert.ok(!messages.some(message => message.method === 'thread/start'));
  assert.equal(consumeCodexSharedHookRegistration(state, { id: 1003, result: {} }), true);
  assert.equal(messages.at(-1).method, 'thread/start');
}
{
  const messages = [];
  const proc = { stdin: { writable: true, write: text => { messages.push(JSON.parse(text)); return true; } } };
  const state = { initialized: false, initializeRequestId: 0, threadRequestId: 1, nextControlRequestId: 1000, cwd,
    codexWindowsInstallHook: { command, configPath }, riskMode: 'recommended', model: 'fixture' };
  handleCodexAppServerInitializeResponse(proc, state, { id: 0, result: {} });
  state.codexManagedHookSetup.consume({ id: 1000, error: { message: 'unsupported' } });
  assert.equal(state.codexManagedHookReady, false);
  assert.equal(messages.at(-1).method, 'thread/start');
}
console.log('codex-managed-hook-setup: exact identity, private write and verification passed');
