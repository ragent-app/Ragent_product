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
  const workspace = `${windowsOsPaths.programData}\\Ragent\\instances\\owner\\workspace`;
  const memory = `${windowsOsPaths.programData}\\Ragent\\instances\\owner\\memory`;
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

test('attested managedWriter sw__* staging under ProgramData allows Write/PowerShell/Bash inside staging while keeping all other ProgramData paths protected', async () => {
  const { analyzeWindowsPowerShell } = await import('../chat/windows-powershell-actions.mjs');
  const { analyzeWindowsBash } = await import('../chat/windows-bash-actions.mjs');
  const { buildClaudeWindowsRelativeOperationBridge } = await import('../chat/windows-claude-relative-operation-bridge.mjs');
  const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');

  const tempData = mkdtempSync(path.join(tmpdir(), 'ragent-win-pd-staging-'));
  try {
    const programData = path.win32.join(tempData, 'ProgramData');
    const canonicalOwnerWorkspace = path.win32.join(programData, 'Ragent', 'instances', 'owner', 'workspace');
    const stagingBase = path.win32.join(canonicalOwnerWorkspace, 'managed-writer-staging');
    const stagingDir = path.win32.join(stagingBase, 'sw__lead123');
    const otherStagingDir = path.win32.join(stagingBase, 'sw__other456');
    const outsideProgramData = path.win32.join(programData, 'other-vendor');
    const memoryProtected = path.win32.join(programData, 'Ragent', 'instances', 'owner', 'memory');
    const windowsDir = path.win32.join(tempData, 'Windows');
    const pfDir = path.win32.join(tempData, 'Program Files');
    const pf86Dir = path.win32.join(tempData, 'Program Files (x86)');
    for (const dir of [
      canonicalOwnerWorkspace,
      path.win32.join(canonicalOwnerWorkspace, 'out'),
      stagingDir,
      path.win32.join(stagingDir, 'out'),
      otherStagingDir,
      outsideProgramData,
      memoryProtected,
      windowsDir,
      pfDir,
      pf86Dir,
    ]) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(path.win32.join(stagingDir, 'out', 'lead-notes.md'), 'draft', 'utf8');
    writeFileSync(path.win32.join(stagingDir, '.env'), 'SECRET=1', 'utf8');

    const windowsOsPaths = {
      windows: windowsDir,
      programData,
      programFiles: pfDir,
      programFilesX86: pf86Dir,
    };

    // Unattested or mismatched managedWriterStagingRoot must never unlock ProgramData writes.
    const unattested = buildRunRiskContext({
      platform: 'win32',
      workspaceRoot: { realPath: stagingDir },
      scopeRoot: { realPath: stagingDir },
      cwd: { realPath: stagingDir },
    }, { windowsOsPaths, protectedRoots: [memoryProtected] });
    assert.equal(unattested.managedWriterStagingRoot, undefined);

    const badRoot = buildRunRiskContext({
      platform: 'win32',
      workspaceRoot: { realPath: canonicalOwnerWorkspace },
      scopeRoot: { realPath: canonicalOwnerWorkspace },
      cwd: { realPath: canonicalOwnerWorkspace },
    }, { windowsOsPaths, managedWriterStagingRoot: canonicalOwnerWorkspace });
    assert.equal(badRoot.managedWriterStagingRoot, undefined, 'non-sw__* ProgramData workspace cannot attest staging exception');

    const scope = {
      platform: 'win32',
      workspaceRoot: { realPath: stagingDir },
      scopeRoot: { realPath: stagingDir },
      cwd: { realPath: stagingDir },
    };
    const context = buildRunRiskContext(scope, {
      windowsOsPaths,
      protectedRoots: [memoryProtected],
      managedWriterStagingRoot: stagingDir,
    });
    assert.equal(context.managedWriterStagingRoot, path.win32.resolve(stagingDir));
    scope.riskContext = context;
    const manifest = { executionScope: scope, executionScopeDigest: computeExecutionScopeDigest(scope) };
    const binding = resolveRunRiskContext(manifest, { platform: 'win32', windowsOsPaths });
    assert.equal(binding.valid, true, binding.reason);

    // Tampered / mismatched managedWriterStagingRoot fails sidecar verification.
    const tamperedScope = { ...scope, riskContext: { ...context, managedWriterStagingRoot: canonicalOwnerWorkspace } };
    assert.equal(
      resolveRunRiskContext({ executionScope: tamperedScope, executionScopeDigest: computeExecutionScopeDigest(tamperedScope) }, { platform: 'win32', windowsOsPaths }).reason,
      'managed-writer-staging-root-invalid',
    );
    const crossDirScope = { ...scope, riskContext: { ...context, managedWriterStagingRoot: otherStagingDir } };
    assert.equal(
      resolveRunRiskContext({ executionScope: crossDirScope, executionScopeDigest: computeExecutionScopeDigest(crossDirScope) }, { platform: 'win32', windowsOsPaths }).reason,
      'managed-writer-staging-root-invalid',
    );

    const stagingFile = path.win32.join(stagingDir, 'out', 'lead-notes.md');
    const canonicalFile = path.win32.join(canonicalOwnerWorkspace, 'out', 'lead-notes.md');
    const siblingStagingFile = path.win32.join(otherStagingDir, 'out', 'evil.md');
    const vendorFile = path.win32.join(outsideProgramData, 'evil.txt');
    const envFile = path.win32.join(stagingDir, '.env');

    const fsApi = {
      async lstat(target) {
        const lower = target.toLowerCase();
        if ([stagingDir, path.win32.join(stagingDir, 'out'), canonicalOwnerWorkspace, path.win32.join(canonicalOwnerWorkspace, 'out'), otherStagingDir].some((d) => d.toLowerCase() === lower)) {
          return { isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false, nlink: 1 };
        }
        return { isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false, nlink: 1 };
      },
      async realpath(target) { return target; },
      async readdir() { return []; },
    };

    const allowedWrite = await analyzeWindowsFileChanges([{ kind: 'write', path: stagingFile }], context, { fsApi });
    assert.equal(allowedWrite.complete, true);
    assert.equal(allowedWrite.actions[0].protected, false);
    assert.equal(allowedWrite.actions[0].workspace, true);
    assert.equal(decideWindowsPowerShellActions(allowedWrite).decision, 'allow');

    // Negative security boundaries stay strictly protected.
    for (const [label, forbiddenPath] of [
      ['canonical owner workspace outside sw__', canonicalFile],
      ['sibling sw__other staging workspace', siblingStagingFile],
      ['unrelated ProgramData folder', vendorFile],
      ['sensitive .env inside sw__', envFile],
      ['protected memory root', path.win32.join(memoryProtected, 'secret.md')],
    ]) {
      const denied = await analyzeWindowsFileChanges([{ kind: 'write', path: forbiddenPath }], context, { fsApi });
      assert.equal(denied.actions[0].protected, true, `${label} write must remain protected`);
      assert.equal(decideWindowsPowerShellActions(denied).decision, 'review', `${label} must require review`);
    }

    // Symlink escape whose actual realpath leaves sw__* into ProgramData MUST remain protected.
    const symlinkEscape = await analyzeWindowsFileChanges([{ kind: 'write', path: path.win32.join(stagingDir, 'escape-link.md') }], context, {
      fsApi: {
        ...fsApi,
        async realpath(target) {
          return target.toLowerCase().endsWith('escape-link.md') ? canonicalFile : target;
        },
      },
    });
    assert.equal(symlinkEscape.actions[0].protected, true, 'symlink escape out of sw__* into ProgramData remains protected');

    // Bash write/mkdir inside sw__* (mocked fsApi + relative bridge on real Windows host).
    const bashResult = await analyzeWindowsBash('mkdir -p out && echo hello > out/lead-notes.md', {
      ...context,
      requireAbsolutePaths: false,
      allowCwdRewrite: true,
    }, {
      analyzeFiles: (entries, ctx) => analyzeWindowsFileChanges(entries, ctx, { fsApi }),
    });
    assert.equal(bashResult.complete, true, bashResult.reason);
    assert.equal(decideWindowsPowerShellActions(bashResult).decision, 'allow');

    if (process.platform === 'win32') {
      const { resolveWindowsSystemPaths } = await import('../chat/windows-system-paths.mjs');
      for (const riskMode of ['recommended', 'full-auto']) {
        const state = { riskMode, cwd: stagingDir, turnActive: true, riskContext: context, riskContextValid: true };
        const writeGate = await decideWindowsApproval({
          providerMethod: 'can_use_tool',
          requestClass: 'tool_invocation',
          kind: 'permissions',
          params: { tool_name: 'Write', input: { file_path: stagingFile } },
        }, state);
        assert.equal(writeGate.decision, 'auto-allow', `${riskMode}: Write inside attested sw__* auto-allows`);

        const psGate = await decideWindowsApproval({
          kind: 'command',
          params: {
            command: [resolveWindowsSystemPaths().powershell, '-NoProfile', '-Command', `Set-Content -LiteralPath '${stagingFile.replaceAll("'", "''")}' -Value 'ok'`],
          },
        }, state);
        assert.equal(psGate.decision, 'auto-allow', `${riskMode}: PowerShell write inside attested sw__* auto-allows`);

        const bashBridge = await buildClaudeWindowsRelativeOperationBridge({
          approval: {
            providerMethod: 'can_use_tool',
            requestClass: 'tool_invocation',
            kind: 'command',
            params: { tool_name: 'Bash', input: { command: 'mkdir -p out && echo ok > out/lead-notes.md' } },
          },
          state,
        });
        assert.ok(bashBridge?.updatedInput?.command, `${riskMode}: relative Bash mkdir+write inside attested sw__* bridges & allows`);

        const escapedWrite = await decideWindowsApproval({
          providerMethod: 'can_use_tool',
          requestClass: 'tool_invocation',
          kind: 'permissions',
          params: { tool_name: 'Write', input: { file_path: canonicalFile } },
        }, state);
        assert.equal(escapedWrite.decision, 'prompt', `${riskMode}: canonical owner/workspace write stays gated`);
      }
    }
  } finally {
    rmSync(tempData, { recursive: true, force: true });
  }
});
