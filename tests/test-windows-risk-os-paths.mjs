import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRunRiskContext } from '../chat/run-admission.mjs';
import { classifyRiskTargetScope, RISK_TARGET_SCOPE } from '../chat/risk-policy.mjs';
import { analyzeWindowsFileChanges, decideWindowsPowerShellActions } from '../chat/windows-powershell-actions.mjs';
import { computeExecutionScopeDigest } from '../chat/execution-scope.mjs';
import { resolveRunRiskContext } from '../chat/runner-sidecar.mjs';
import { decideWindowsApproval } from '../chat/windows-approval-gate.mjs';

test('run admission protects OS-derived roots across drives for every file operation', async () => {
  const windowsOsPaths = { windows: 'D:\\Windows', programData: 'E:\\Shared Data', programFiles: 'F:\\Applications', programFilesX86: 'H:\\Apps32' };
  const context = buildRunRiskContext({
    platform: 'win32',
    workspaceRoot: { realPath: 'G:\\work' },
    scopeRoot: { realPath: 'G:\\work' },
    cwd: { realPath: 'G:\\work' },
  }, { windowsOsPaths });
  const fsApi = {
    async lstat() { return { isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false, nlink: 1 }; },
    async realpath(p) { return p; },
  };
  for (const root of Object.values(windowsOsPaths)) {
    const target = `${root}\\example.txt`;
    assert.equal(classifyRiskTargetScope(target, { riskContext: context }), RISK_TARGET_SCOPE.SYSTEM);
    for (const kind of ['read', 'write', 'delete']) {
      const result = await analyzeWindowsFileChanges([{ kind, path: target }], context, { fsApi });
      assert.equal(result.complete, true);
      assert.equal(result.actions[0].protected, true, `${kind} must protect ${target}`);
      assert.equal(decideWindowsPowerShellActions(result).decision, 'review');
    }
  }
  const ordinary = await analyzeWindowsFileChanges([{ kind: 'write', path: 'E:\\Documents\\note.txt' }], context, { fsApi });
  assert.equal(ordinary.actions[0].protected, false);
  assert.equal(decideWindowsPowerShellActions(ordinary).decision, 'allow');
});

test('a bound ProgramData workspace is readable while control paths and mutations stay protected', async () => {
  const windowsOsPaths = { windows: 'D:\\Windows', programData: 'E:\\Shared Data', programFiles: 'F:\\Applications', programFilesX86: 'H:\\Apps32' };
  const workspace = `${windowsOsPaths.programData}\\AgentoC\\instances\\owner\\workspace`;
  const memory = `${windowsOsPaths.programData}\\AgentoC\\instances\\owner\\memory`;
  const context = buildRunRiskContext({
    platform: 'win32',
    workspaceRoot: { realPath: workspace },
    scopeRoot: { realPath: workspace },
    cwd: { realPath: workspace },
  }, { windowsOsPaths, protectedRoots: [memory] });
  const fsApi = {
    async lstat(target) {
      return target.toLowerCase() === workspace.toLowerCase()
        ? { isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false, nlink: 1 }
        : { isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false, nlink: 1 };
    },
    async realpath(target) { return target; },
  };
  assert.equal(context.programDataRoot, windowsOsPaths.programData, 'the Run snapshot binds the real ProgramData root');

  const workspaceRead = await analyzeWindowsFileChanges([{ kind: 'read', path: `${workspace}\\README.md` }], context, { fsApi });
  assert.equal(workspaceRead.actions[0].protected, false);
  assert.equal(workspaceRead.actions[0].workspace, true);
  assert.equal(decideWindowsPowerShellActions(workspaceRead).decision, 'allow');

  for (const kind of ['write', 'delete']) {
    const mutation = await analyzeWindowsFileChanges([{ kind, path: `${workspace}\\README.md` }], context, { fsApi });
    assert.equal(mutation.actions[0].protected, true, `${kind} beneath ProgramData remains protected`);
    assert.equal(decideWindowsPowerShellActions(mutation).decision, 'review');
  }

  const controlRead = await analyzeWindowsFileChanges([{ kind: 'read', path: `${memory}\\private.md` }], context, { fsApi });
  assert.equal(controlRead.actions[0].protected, true, 'instance memory stays protected even under ProgramData');
  assert.equal(decideWindowsPowerShellActions(controlRead).decision, 'review');

  const outsideRead = await analyzeWindowsFileChanges([{ kind: 'read', path: `${windowsOsPaths.programData}\\other-app\\private.md` }], context, { fsApi });
  assert.equal(outsideRead.actions[0].protected, true, 'unbound ProgramData content stays protected');
  assert.equal(decideWindowsPowerShellActions(outsideRead).decision, 'review');

  const gateState = { riskMode: 'recommended', cwd: workspace, riskContext: context, riskContextValid: true };
  const readRequest = { providerMethod: 'can_use_tool', requestClass: 'tool_invocation', kind: 'permissions', params: {
    tool_name: 'Read', input: { file_path: `${workspace}\\README.md` },
  } };
  const gatedRead = await decideWindowsApproval(readRequest, gateState, {
    analyzeFiles: (entries, riskContext) => analyzeWindowsFileChanges(entries, riskContext, { fsApi }),
  });
  assert.equal(gatedRead.decision, 'auto-allow', 'Claude Code Read in the bound ProgramData workspace should not open an owner prompt');
  const gatedMemoryRead = await decideWindowsApproval({ ...readRequest, params: {
    ...readRequest.params, input: { file_path: `${memory}\\private.md` },
  } }, gateState, {
    analyzeFiles: (entries, riskContext) => analyzeWindowsFileChanges(entries, riskContext, { fsApi }),
  });
  assert.equal(gatedMemoryRead.decision, 'prompt', 'Claude Code Read of instance memory still needs owner review');
  const gatedWrite = await decideWindowsApproval({ ...readRequest, params: {
    ...readRequest.params, tool_name: 'Write', input: { file_path: `${workspace}\\README.md` },
  } }, gateState, {
    analyzeFiles: (entries, riskContext) => analyzeWindowsFileChanges(entries, riskContext, { fsApi }),
  });
  assert.equal(gatedWrite.decision, 'prompt', 'a file write beneath ProgramData is not covered by the read exception');
});

test('Windows sidecar refuses automatic approval when OS roots cannot be verified', () => {
  const windowsOsPaths = { windows: 'D:\\Windows', programData: 'E:\\Shared Data', programFiles: 'F:\\Applications', programFilesX86: 'H:\\Apps32' };
  const scope = {
    platform: 'win32',
    workspaceRoot: { realPath: 'G:\\work' },
    scopeRoot: { realPath: 'G:\\work' },
    cwd: { realPath: 'G:\\work' },
  };
  scope.riskContext = buildRunRiskContext(scope, { windowsOsPaths });
  const manifest = { executionScope: scope, executionScopeDigest: computeExecutionScopeDigest(scope) };
  const options = { platform: 'win32', windowsOsPaths };
  assert.equal(resolveRunRiskContext(manifest, options).valid, true);
  const mismatchedProgramDataScope = { ...scope, riskContext: { ...scope.riskContext, programDataRoot: 'G:\\attacker-data' } };
  assert.equal(resolveRunRiskContext({ executionScope: mismatchedProgramDataScope,
    executionScopeDigest: computeExecutionScopeDigest(mismatchedProgramDataScope) }, options).reason, 'windows-program-data-root-mismatch');
  assert.equal(resolveRunRiskContext(manifest, { ...options, windowsOsPaths: null }).reason, 'windows-system-paths-unavailable');
  assert.equal(resolveRunRiskContext(manifest, { ...options, windowsOsPaths: { ...windowsOsPaths, programFilesX86: '' } }).reason, 'windows-system-paths-unavailable');
  const omittedRootScope = { ...scope, riskContext: { ...scope.riskContext,
    systemPathRoots: scope.riskContext.systemPathRoots.filter(root => root.toLowerCase() !== windowsOsPaths.programData.toLowerCase()) } };
  assert.equal(resolveRunRiskContext({ executionScope: omittedRootScope,
    executionScopeDigest: computeExecutionScopeDigest(omittedRootScope) }, options).reason, 'windows-system-paths-unavailable');
  const otherPlatformScope = { ...scope, riskContext: { ...scope.riskContext, platform: 'linux' } };
  assert.equal(resolveRunRiskContext({ executionScope: otherPlatformScope,
    executionScopeDigest: computeExecutionScopeDigest(otherPlatformScope) }, options).reason, 'windows-system-paths-unavailable');
});

test('real Windows admission and sidecar agree on the OS roots', { skip: process.platform !== 'win32' }, () => {
  const work = process.cwd();
  const scope = { workspaceRoot: { realPath: work }, scopeRoot: { realPath: work }, cwd: { realPath: work } };
  scope.riskContext = buildRunRiskContext(scope);
  const binding = resolveRunRiskContext({ executionScope: scope, executionScopeDigest: computeExecutionScopeDigest(scope) });
  assert.equal(binding.valid, true, binding.reason);
});

test('an unverified context cannot auto-approve file operations in either main mode', async () => {
  for (const riskMode of ['recommended', 'full-auto']) {
    const decision = await decideWindowsApproval({ providerMethod: 'can_use_tool',
      params: { tool_name: 'Write', input: { file_path: 'G:\\work\\report.md' } } },
    { riskMode, cwd: 'G:\\work', riskContextValid: false });
    assert.equal(decision.decision, 'prompt');
    assert.equal(decision.reason, 'run path context is unavailable');
  }
});
