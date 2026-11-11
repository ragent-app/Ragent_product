import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { computeExecutionScopeDigest } from '../chat/execution-scope.mjs';
import { readOnlyWorkspaceForRun } from '../chat/read-only-run-sandbox.mjs';
import { buildSandboxedSpawn, isBwrapPresent } from '../lib/runner-sandbox.mjs';

const root = mkdtempSync(join(realpathSync(tmpdir()), 'agentoc-readonly-run-'));
try {
  const workspace = join(root, 'workspace');
  const home = join(root, 'home');
  const nested = join(workspace, 'project');
  mkdirSync(nested, { recursive: true });
  mkdirSync(home);
  const scope = { accessMode: 'read', workspaceRoot: { realPath: workspace }, cwd: { realPath: nested } };
  const manifest = { executionScope: scope, executionScopeDigest: computeExecutionScopeDigest(scope) };
  assert.equal(readOnlyWorkspaceForRun(manifest, nested), workspace);
  assert.equal(readOnlyWorkspaceForRun({}, nested), null);
  assert.throws(() => readOnlyWorkspaceForRun({ ...manifest, executionScopeDigest: 'sha256:bad' }, nested), { code: 'READ_ONLY_RUNTIME_REFUSED' });
  assert.throws(() => readOnlyWorkspaceForRun({ options: { readOnlyRequired: true } }, nested), { code: 'READ_ONLY_RUNTIME_REFUSED' });
  assert.throws(() => readOnlyWorkspaceForRun(manifest, home), { code: 'READ_ONLY_RUNTIME_REFUSED' });
  const link = join(root, 'workspace-alias');
  symlinkSync(workspace, link);
  assert.throws(() => readOnlyWorkspaceForRun(manifest, join(link, 'project')), { code: 'READ_ONLY_RUNTIME_REFUSED' });
  const original = join(workspace, 'original');
  const alias = join(home, 'alias');
  writeFileSync(original, 'unchanged');
  linkSync(original, alias);
  const sandbox = buildSandboxedSpawn({ command: '/bin/sh',
    args: ['-c', 'test -f "$1" || exit 2; test "$(cat "$1")" = unchanged || exit 3; echo changed > "$1" 2>/dev/null; test $? -ne 0', 'readonly-test', alias],
    cwd: nested, runnerHome: home, readOnly: true, bindReadOnlyPaths: [workspace] });
  try {
    assert.equal(sandbox.args.some((value, index) => value === '--bind' && sandbox.args[index + 1] === home), false);
    if (isBwrapPresent()) {
      const result = spawnSync(sandbox.command, sandbox.args, { encoding: 'utf8' });
      if (result.status !== 0 && /Operation not permitted/u.test(result.stderr || '')) {
        console.log('Read-only mount execution unavailable on this host');
      } else {
        assert.equal(result.status, 0, `hard-link write should fail: ${result.stderr}`);
        console.log('Read-only sandbox prevented a write through a home hard link');
      }
    }
  } finally { rmSync(sandbox.emptyDir, { recursive: true, force: true }); }
  console.log('read-only run scope and sandbox checks passed');
} finally { rmSync(root, { recursive: true, force: true }); }
