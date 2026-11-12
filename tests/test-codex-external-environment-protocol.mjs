import { strict as assert } from 'node:assert';
import { buildCodexAppServerEnvironmentAddMessage, buildCodexAppServerThreadMessage, buildCodexAppServerTurnStartMessage } from '../chat/codex-app-server-protocol.mjs';

const environment = { environmentId: 'ragent_run_123', cwd: '/workspace/project' };
const fresh = buildCodexAppServerThreadMessage({ cwd: environment.cwd, executionEnvironment: environment });
assert.deepEqual(fresh.params.environments, [environment]);
assert.deepEqual(buildCodexAppServerThreadMessage({ executionEnvironment: { environmentId: 'win_run', cwd: 'G:\\workspace' } }).params.environments,
  [{ environmentId: 'win_run', cwd: 'G:\\workspace' }]);
const resume = buildCodexAppServerThreadMessage({ threadId: 'thread', useResume: true, cwd: environment.cwd, executionEnvironment: environment });
assert.equal(Object.hasOwn(resume.params, 'environments'), false, 'Codex thread/resume has no environments field');
for (const threadId of ['new-thread', 'resumed-thread']) {
  const turn = buildCodexAppServerTurnStartMessage({ threadId, text: 'fixture', executionEnvironment: environment });
  assert.deepEqual(turn.params.environments, [environment]);
  assert.deepEqual(turn.params.sandboxPolicy, { type: 'externalSandbox' });
}
assert.equal(Object.hasOwn(buildCodexAppServerTurnStartMessage({ threadId: 'ordinary' }).params, 'environments'), false);
for (const invalid of ['', {}, { environmentId: '../escape', cwd: '/workspace' },
  { environmentId: 'safe', cwd: 'relative' }, { environmentId: 'safe', cwd: '/workspace\nother' }]) {
  assert.throws(() => buildCodexAppServerThreadMessage({ executionEnvironment: invalid }), TypeError);
  assert.throws(() => buildCodexAppServerTurnStartMessage({ executionEnvironment: invalid }), TypeError);
}
assert.throws(() => buildCodexAppServerTurnStartMessage({ executionEnvironment: environment, namedPermissionProfile: 'strict' }), TypeError);
const registration = { id: 7, environmentId: environment.environmentId, execServerUrl: 'ws://127.0.0.1:52461', authBearerToken: 'a'.repeat(64) };
assert.equal(buildCodexAppServerEnvironmentAddMessage(registration).method, 'environment/add');
for (const patch of [{ execServerUrl: 'ws://192.168.1.1:52461' }, { execServerUrl: 'http://127.0.0.1:52461' }, { execServerUrl: 'ws://127.0.0.1:0' },
  { execServerUrl: 'ws://127.0.0.1:52461?token=unsafe' }, { execServerUrl: 'ws://127.0.0.1:52461/path' },
  { execServerUrl: 'ws://user:pass@127.0.0.1:52461' }, { authBearerToken: 'short' }, { id: -1 }]) {
  assert.throws(() => buildCodexAppServerEnvironmentAddMessage({ ...registration, ...patch }), TypeError);
}
console.log('test-codex-external-environment-protocol: ok');
