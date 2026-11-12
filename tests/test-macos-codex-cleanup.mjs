import assert from 'node:assert/strict';
import { captureMacCodexIdentity, cleanupMacCodexRun, codexThreadRunTag } from '../chat/codex-app-server-broker.mjs';

const request = (method, tag) => ({
  method,
  params: { config: { shell_environment_policy: { set: { AGENTOC_RUN_ID: tag } } } },
});
assert.equal(codexThreadRunTag(request('thread/start', 'run-123')), 'run-123');
assert.equal(codexThreadRunTag(request('thread/resume', 'run_456')), 'run_456');
assert.equal(codexThreadRunTag(request('turn/interrupt', 'run-123')), '');
assert.equal(codexThreadRunTag(request('thread/start', '../other')), '');

const calls = [];
const run = (...args) => { calls.push(args); return { status: 0 }; };
const identity = captureMacCodexIdentity(42, { platform: 'darwin', run: () => ({ status: 0, stdout: '123456 42\n' }) });
assert.deepEqual(identity, { seconds: '123456', microseconds: '42' });
assert.equal(captureMacCodexIdentity(42, { platform: 'darwin', run: () => ({ status: 0, stdout: '123 1000000\n' }) }), null);
assert.equal(captureMacCodexIdentity(42, { platform: 'darwin', run: () => { throw new Error('missing'); } }), null);
assert.equal(cleanupMacCodexRun(42, 'run-123', { platform: 'darwin', executable: '/test/helper', identity, run }), true);
assert.deepEqual(calls, [['/test/helper', ['42', 'run-123', '123456', '42'], { stdio: 'ignore', timeout: 5000 }]]);
assert.equal(cleanupMacCodexRun(42, 'run-123', { platform: 'darwin', run }), false);
assert.equal(cleanupMacCodexRun(42, 'run-123', { platform: 'linux', run }), false);
assert.equal(cleanupMacCodexRun(1, 'run-123', { platform: 'darwin', run }), false);
assert.equal(cleanupMacCodexRun(42, '../other', { platform: 'darwin', run }), false);
assert.equal(cleanupMacCodexRun(42, 'run-123', { platform: 'darwin', identity, run: () => ({ status: 2 }) }), false);
assert.equal(cleanupMacCodexRun(42, 'run-123', { platform: 'darwin', identity, run: () => ({ error: new Error('timeout') }) }), false);
console.log('macOS Codex cleanup request checks passed');
