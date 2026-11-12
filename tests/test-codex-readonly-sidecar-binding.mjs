import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { createCodexAppServerRunState, handleCodexAppServerInitializeResponse, maybeStartCodexAppServerTurn } from '../chat/runner-sidecar.mjs';

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
console.log('test-codex-readonly-sidecar-binding: ok');
