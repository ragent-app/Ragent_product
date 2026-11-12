import assert from 'node:assert/strict';
import { buildCodexRunShellEnvironment, buildSharedCodexProcessEnvironment } from '../chat/codex-shared-environment.mjs';

const first = { Path: 'run-a-path', AGENTOC_SESSION_CONTROL_TOKEN: 'token-a', AGENTOC_RUN_ID: 'run-a',
  AGENTOC_NATIVE_OAUTH_LOCK_TOKEN: 'lock-secret', AGENTOC_CODEX_BROKER_SOCKET: 'private-socket', CODEX_HOME: 'provider-home', TEMP: 'temp' };
const shared = buildSharedCodexProcessEnvironment(first, { basePath: 'base-path', hookSocket: 'shared-hook-socket' });
assert.deepEqual(shared, { CODEX_HOME: 'provider-home', TEMP: 'temp', PATH: 'base-path', AGENTOC_CODEX_BROKER_SOCKET: 'shared-hook-socket' });
assert.deepEqual(buildCodexRunShellEnvironment(first), { Path: 'run-a-path', AGENTOC_SESSION_CONTROL_TOKEN: 'token-a', AGENTOC_RUN_ID: 'run-a' });
const second = buildCodexRunShellEnvironment({ PATH: 'run-b-path', AGENTOC_RUN_ID: 'run-b' });
assert.equal(second.AGENTOC_SESSION_CONTROL_TOKEN, undefined);
assert.equal(shared.AGENTOC_SESSION_CONTROL_TOKEN, undefined);
console.log('test-codex-shared-environment: run credentials stay out of the shared process');
