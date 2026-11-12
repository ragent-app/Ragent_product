import test from 'node:test';
import assert from 'node:assert/strict';
import { computeExecutionScopeDigest } from '../chat/execution-scope.mjs';
import { resolveApprovedActionRunDirectories } from '../chat/approved-action-run-directories.mjs';

function scoped() {
  const scope = { sessionId: 'session1', cwd: { realPath: '/srv/project/sub' },
    scopeRoot: { realPath: '/srv/project/sub' },
    riskContext: { platform: 'linux', cwd: '/srv/project/sub', trustedWorkspaceRoot: '/srv/project/sub' } };
  return { run: { sessionId: 'session1' }, session: { folder: '/srv/project' }, platform: 'linux',
    manifest: { sessionId: 'session1', folder: '/srv/project', executionScope: scope, executionScopeDigest: computeExecutionScopeDigest(scope) } };
}
test('Linux approval uses the immutable Run scope even when the session folder changes', () => {
  const args = scoped();
  assert.deepEqual(resolveApprovedActionRunDirectories(args), { cwd: '/srv/project/sub', projectRoot: '/srv/project/sub' });
  args.session.folder = '/srv/other';
  assert.deepEqual(resolveApprovedActionRunDirectories(args), { cwd: '/srv/project/sub', projectRoot: '/srv/project/sub' });
});
test('an invalid scoped Run cannot fall back to mutable paths', () => {
  for (const change of [
    (a) => { a.manifest.executionScope.cwd.realPath = '/etc'; },
    (a) => { a.run.sessionId = 'other'; },
    (a) => { a.manifest.executionScope = null; },
    (a) => { a.manifest.executionScope.riskContext.cwd = '/srv/elsewhere'; a.manifest.executionScopeDigest = computeExecutionScopeDigest(a.manifest.executionScope); },
    (a) => { a.manifest.executionScope.cwd.realPath = '/etc'; a.manifest.executionScope.riskContext.cwd = '/etc'; a.manifest.executionScopeDigest = computeExecutionScopeDigest(a.manifest.executionScope); },
  ]) {
    const args = scoped();
    change(args);
    assert.throws(() => resolveApprovedActionRunDirectories(args), { code: 'APPROVED_ACTION_EXECUTION_SCOPE_INVALID' });
  }
});
test('legacy Runs and non-Linux platforms keep their existing paths', () => {
  const args = scoped();
  assert.deepEqual(resolveApprovedActionRunDirectories({ ...args, platform: 'win32' }), { cwd: '/srv/project', projectRoot: '/srv/project' });
  delete args.manifest.executionScope;
  assert.deepEqual(resolveApprovedActionRunDirectories(args), { cwd: '/srv/project', projectRoot: '/srv/project' });
});
