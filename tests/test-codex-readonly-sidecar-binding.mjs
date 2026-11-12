import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { configureCodexReadOnlyEnvironment, createCodexAppServerRunState, handleCodexAppServerInitializeResponse, maybeStartCodexAppServerTurn } from '../chat/runner-sidecar.mjs';

for (const resume of [false, true]) {
  const cwd = tmpdir();
  const state = await createCodexAppServerRunState({ prompt: 'fixture', cwd,
    manifest: { options: { model: 'fixture-model', codexResume: resume, ...(resume ? { codexThreadId: 'existing' } : {}) } }, codexHomeDir: cwd });
  state.executionEnvironment = { environmentId: 'ragent_fixture', cwd };
  const messages = [];
  const proc = { stdin: { writable: true, write: line => messages.push(JSON.parse(line)) } };
  handleCodexAppServerInitializeResponse(proc, state, { id: state.initializeRequestId, result: {} });
  const thread = messages.at(-1);
  assert.equal(thread.method, resume ? 'thread/resume' : 'thread/start');
  if (resume) assert.equal(Object.hasOwn(thread.params, 'environments'), false);
  else assert.deepEqual(thread.params.environments, [state.executionEnvironment]);
  assert.equal(maybeStartCodexAppServerTurn(proc, state, { id: state.threadRequestId, result: { thread: { id: 'fixture-thread' } } }), true);
  assert.deepEqual(messages.at(-1).params.environments, [state.executionEnvironment]);
  assert.deepEqual(messages.at(-1).params.sandboxPolicy, { type: 'externalSandbox' });
}
{
  const cwd = tmpdir(), messages = [];
  const state = await createCodexAppServerRunState({ prompt: 'fixture', cwd,
    manifest: { options: { model: 'fixture-model' } }, codexHomeDir: cwd });
  const proc = { stdin: { writable: true, write: line => messages.push(JSON.parse(line)) } };
  let stopped = 0, cleaned = 0;
  const setup = configureCodexReadOnlyEnvironment({ proc, state, environmentId: 'ragent_fixture', workspace: cwd, hidePaths: ['/hidden'],
    executor: { execServerUrl: 'ws://127.0.0.1:45678/', authBearerToken: 'a'.repeat(64), stop: async () => { stopped++; } },
    prepareMcp: async () => ({ config: { mcp_servers: {} }, cleanup: async () => { cleaned++; } }) });
  handleCodexAppServerInitializeResponse(proc, state, { id: state.initializeRequestId, result: {} });
  assert.deepEqual(messages.map(message => message.method), ['initialized', 'config/read']);
  await setup.consume({ id: messages.at(-1).id, result: { config: {} } });
  assert.equal(messages.at(-1).method, 'environment/add');
  await setup.consume({ id: messages.at(-1).id, result: {} });
  assert.equal(messages.at(-1).method, 'environment/info');
  await setup.consume({ id: messages.at(-1).id, result: { shell: { path: '/bin/sh' } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(messages.at(-1).method, 'thread/start');
  assert.deepEqual(messages.at(-1).params.environments, [{ environmentId: 'ragent_fixture', cwd }]);
  await setup.close(); assert.equal(stopped, 1); assert.equal(cleaned, 1);
}
console.log('test-codex-readonly-sidecar-binding: ok');
