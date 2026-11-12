import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildWindowsWildcardNameBridge, buildCodexWindowsWildcardNameHookDecision, verifyCodexWindowsWildcardNameApproval } from '../chat/windows-wildcard-list-bridge.mjs';
import { resolveWindowsSystemPaths } from '../chat/windows-system-paths.mjs';

if (process.platform !== 'win32' || !process.env.AGENTOC_QA_SAFE_SEARCH_HELPER) {
  console.log('windows-wildcard-list-bridge: skipped (requires Windows helper fixture)');
  process.exit(0);
}
const root = await mkdtemp(path.join(os.tmpdir(), 'agentoc-list-bridge-'));
const workspace = path.join(root, 'workspace');
const outside = path.join(root, 'outside');
const target = path.join(root, 'outside-link-target');
await mkdir(workspace); await mkdir(outside); await mkdir(target);
await writeFile(path.join(outside, 'visible.md'), 'fixture');
await writeFile(path.join(outside, 'aaa.md'), 'fixture');
await writeFile(path.join(outside, '项目.md'), 'fixture');
await mkdir(path.join(outside, 'folder.md'));
await writeFile(path.join(outside, 'other.txt'), 'fixture');
await writeFile(path.join(target, 'not-followed.md'), 'fixture');
const helperPath = process.env.AGENTOC_QA_SAFE_SEARCH_HELPER;
const q = value => `'${String(value).replaceAll("'", "''")}'`;
const shellQuote = value => `'${String(value).replaceAll("'", `'"'"'`)}'`;
const shell = resolveWindowsSystemPaths().powershell;
const utf8Prefix = '[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding $false; ';
const commandForCodex = command => [shell, '-NoProfile', '-Command', command].map(shellQuote).join(' ');
const pattern = path.join(outside, '*.md');
try {
  for (const riskMode of ['recommended', 'full-auto']) {
    const state = { riskMode, cwd: workspace, turnActive: true, riskContextValid: true,
      riskContext: { platform: 'win32', cwd: workspace, trustedWorkspaceRoot: workspace, protectedRoots: [] } };
    const command = `Get-ChildItem -Path ${q(pattern)} -Force | Select-Object Name | Out-String`;
    const approval = { kind: 'command', providerMethod: 'can_use_tool', params: { tool_name: 'PowerShell', input: { command } } };
    const bridge = await buildWindowsWildcardNameBridge({ approval, state, helperPath });
    assert.ok(bridge, `${riskMode}: outside-workspace name listing is bound`);
    const originalOutput = execFileSync(shell, ['-NoProfile', '-NonInteractive', '-Command', utf8Prefix + command], { encoding: 'utf8', cwd: workspace, windowsHide: true });
    const boundOutput = execFileSync(shell, ['-NoProfile', '-NonInteractive', '-Command', utf8Prefix + bridge.updatedCommand], { encoding: 'utf8', cwd: workspace, windowsHide: true });
    assert.equal(boundOutput.trim(), originalOutput.trim(), 'listing output matches PowerShell');
    const nameCommand = `Get-ChildItem -Path ${q(pattern)} -Name`;
    const nameApproval = { ...approval, params: { ...approval.params, input: { command: nameCommand } } };
    const nameBridge = await buildWindowsWildcardNameBridge({ approval: nameApproval, state, helperPath });
    assert.ok(nameBridge, 'the -Name form is also bound');
    assert.equal(execFileSync(shell, ['-NoProfile', '-NonInteractive', '-Command', utf8Prefix + nameBridge.updatedCommand], { encoding: 'utf8', cwd: workspace, windowsHide: true }).trim(),
      execFileSync(shell, ['-NoProfile', '-NonInteractive', '-Command', utf8Prefix + nameCommand], { encoding: 'utf8', cwd: workspace, windowsHide: true }).trim());
    for (const kind of ['File', 'Directory']) {
      const filteredCommand = `Get-ChildItem -Path ${q(pattern)} -${kind} -Name`;
      const filteredApproval = { ...approval, params: { ...approval.params, input: { command: filteredCommand } } };
      const filteredBridge = await buildWindowsWildcardNameBridge({ approval: filteredApproval, state, helperPath });
      assert.ok(filteredBridge, `${kind} listing is bound`);
      assert.equal(execFileSync(shell, ['-NoProfile', '-NonInteractive', '-Command', utf8Prefix + filteredBridge.updatedCommand], { encoding: 'utf8', cwd: workspace, windowsHide: true }).trim(),
        execFileSync(shell, ['-NoProfile', '-NonInteractive', '-Command', utf8Prefix + filteredCommand], { encoding: 'utf8', cwd: workspace, windowsHide: true }).trim());
    }
    const tableCommand = `Get-ChildItem -Path ${q(pattern)} -Force | Select-Object Mode,LastWriteTime,Length,Name | Format-Table -AutoSize | Out-String`;
    const tableApproval = { ...approval, params: { ...approval.params, input: { command: tableCommand } } };
    const tableBridge = await buildWindowsWildcardNameBridge({ approval: tableApproval, state, helperPath });
    assert.ok(tableBridge, 'common metadata table is bound');
    const defaultApproval = { ...approval, params: { ...approval.params, input: { command: `Get-ChildItem -Path ${q(pattern)} -Force` } } };
    const defaultBridge = await buildWindowsWildcardNameBridge({ approval: defaultApproval, state, helperPath });
    assert.ok(defaultBridge, 'standalone wildcard listing is bound');
    const normal = text => text.split(/\r?\n/).map(line => line.trim().split(/\s+/).join(' ')).filter(Boolean).join('\n');
    const shells = [shell, path.join(process.env.ProgramFiles || '', 'PowerShell', '7', 'pwsh.exe')];
    for (const candidate of shells) {
      if (!candidate || !path.isAbsolute(candidate)) continue;
      try {
        const utf8 = '[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding $false; ';
        const direct = execFileSync(candidate, ['-NoProfile', '-NonInteractive', '-Command', utf8 + tableCommand], { encoding: 'utf8', cwd: workspace, windowsHide: true, stdio: 'pipe' });
        const rewritten = execFileSync(candidate, ['-NoProfile', '-NonInteractive', '-Command', utf8 + tableBridge.updatedCommand], { encoding: 'utf8', cwd: workspace, windowsHide: true, stdio: 'pipe' });
        assert.equal(normal(rewritten), normal(direct), 'metadata table retains shell-specific Mode values');
        const originalNames = execFileSync(candidate, ['-NoProfile', '-NonInteractive', '-Command', utf8 + nameCommand], { encoding: 'utf8', cwd: workspace, windowsHide: true, stdio: 'pipe' });
        const rewrittenNames = execFileSync(candidate, ['-NoProfile', '-NonInteractive', '-Command', utf8 + nameBridge.updatedCommand], { encoding: 'utf8', cwd: workspace, windowsHide: true, stdio: 'pipe' });
        assert.equal(normal(rewrittenNames), normal(originalNames), 'file names retain the actual shell sorting order');
        const defaultResult = execFileSync(candidate, ['-NoProfile', '-NonInteractive', '-Command', utf8 + defaultBridge.updatedCommand], { encoding: 'utf8', cwd: workspace, windowsHide: true, stdio: 'pipe' });
        assert.match(defaultResult, /visible\.md/);
        assert.match(defaultResult, /\b7\b/);
        assert.ok(defaultResult.includes(path.basename(candidate).toLowerCase() === 'pwsh.exe' ? '-a---' : '-a----'));
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
    }
    const current = { ...state, startedTurn: true, threadId: 'thread', turnId: 'turn' };
    const codex = { kind: 'command', providerMethod: 'item/commandExecution/requestApproval', params: {
      threadId: 'thread', turnId: 'turn', itemId: 'item', cwd: workspace, command: commandForCodex(bridge.updatedCommand),
    } };
    assert.equal(await verifyCodexWindowsWildcardNameApproval({ approval: codex, state: current, helperPath }), true);
    assert.equal(await verifyCodexWindowsWildcardNameApproval({ approval: { ...codex, params: { ...codex.params, turnId: 'other' } }, state: current, helperPath }), false);
    assert.equal(await verifyCodexWindowsWildcardNameApproval({ approval: { ...codex, params: { ...codex.params, additionalPermissions: { network: true } } }, state: current, helperPath }), false);
    const event = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'fixture', cwd: workspace, tool_input: { command } };
    const hook = await buildCodexWindowsWildcardNameHookDecision({ event, state, runId: 'run-fixture', helperPath });
    assert.equal(hook.hookSpecificOutput?.updatedInput?.command, bridge.updatedCommand);
    for (const unsafe of [
      `Get-ChildItem -Path ${q(pattern)} -File -Directory -Name`,
      `Get-ChildItem -Path ${q(pattern)} -Recurse | Select-Object Name`,
      `Get-ChildItem -Path ${q(path.join(root, '*', '*.md'))} | Select-Object Name`,
      `Get-ChildItem -Path ${q(pattern)} | Select-Object Name,FullName`,
      `Get-ChildItem -Path ${q(pattern)}; Get-Content ${q(path.join(target, 'not-followed.md'))}`,
      `Get-ChildItem -Path ${q(pattern)} | Select-Object @{Name='x';Expression={Remove-Item ${q(target)}}}`,
      `Get-ChildItem -Path '\\\\127.0.0.1\\not-a-real-share\\*.md' -Name`,
      `$p=${q(pattern)}; Get-ChildItem -Path $p -Name`,
    ]) {
      approval.params.input.command = unsafe;
      assert.equal(await buildWindowsWildcardNameBridge({ approval, state, helperPath }), null, 'unsupported operation cannot use the listing bridge');
    }
    const link = path.join(outside, `link-${riskMode}.md`);
    execFileSync('cmd.exe', ['/d', '/c', 'mklink', '/J', link, target], { stdio: 'pipe', windowsHide: true });
    try {
      const lateOutput = execFileSync(shell, ['-NoProfile', '-NonInteractive', '-Command', bridge.updatedCommand], { encoding: 'utf8', cwd: workspace, windowsHide: true });
      assert.match(lateOutput, new RegExp(`link-${riskMode}\\.md`));
      assert.doesNotMatch(lateOutput, /not-followed\.md/, 'newly matched junction is listed but never traversed');
      assert.equal(await buildWindowsWildcardNameBridge({ approval: tableApproval, state, helperPath }), null,
        'pre-existing junction metadata requires the original approval path');
      const filesOnlyApproval = { ...tableApproval, params: { ...tableApproval.params, input: { command: tableCommand.replace('-Force', '-Force -File') } } };
      const filesOnlyBridge = await buildWindowsWildcardNameBridge({ approval: filesOnlyApproval, state, helperPath });
      assert.ok(filesOnlyBridge, 'a directory junction excluded by -File does not block the listing');
      const filesOnlyOutput = execFileSync(shell, ['-NoProfile', '-NonInteractive', '-Command', filesOnlyBridge.updatedCommand], { encoding: 'utf8', cwd: workspace, windowsHide: true });
      assert.doesNotMatch(filesOnlyOutput, /link-/);
      assert.equal(await buildWindowsWildcardNameBridge({ approval: defaultApproval, state, helperPath }), null,
        'default listing with a pre-existing junction requires the original approval path');
      assert.throws(() => execFileSync(shell, ['-NoProfile', '-NonInteractive', '-Command', `${tableBridge.updatedCommand}; exit $LASTEXITCODE`],
        { encoding: 'utf8', cwd: workspace, windowsHide: true, stdio: 'pipe' }), 'a junction added after preflight is not inspected for metadata');
    } finally { await rm(link); }
    const raceDir = path.join(root, `race-${riskMode}`), savedDir = `${raceDir}-saved`;
    await mkdir(raceDir);
    await writeFile(path.join(raceDir, 'safe.md'), 'fixture');
    const raceApproval = { ...approval, params: { ...approval.params, input: { command: `Get-ChildItem -Path ${q(path.join(raceDir, '*.md'))} -Name` } } };
    const raceBridge = await buildWindowsWildcardNameBridge({ approval: raceApproval, state, helperPath });
    assert.ok(raceBridge);
    const { rename } = await import('node:fs/promises');
    await rename(raceDir, savedDir);
    execFileSync('cmd.exe', ['/d', '/c', 'mklink', '/J', raceDir, target], { stdio: 'pipe', windowsHide: true });
    try {
      assert.throws(() => execFileSync(shell, ['-NoProfile', '-NonInteractive', '-Command', `${raceBridge.updatedCommand}; exit $LASTEXITCODE`],
        { encoding: 'utf8', cwd: workspace, windowsHide: true, stdio: 'pipe' }), 'a directory replaced with a junction cannot be enumerated');
    } finally { await rm(raceDir); }
    const dollarDir = path.join(root, '$ordinary');
    await mkdir(dollarDir, { recursive: true });
    await writeFile(path.join(dollarDir, 'visible.md'), 'fixture');
    const dollarApproval = { ...approval, params: { ...approval.params, input: { command: `Get-ChildItem -Path ${q(path.join(dollarDir, '*.md'))} -Name` } } };
    const dollarBridge = await buildWindowsWildcardNameBridge({ approval: dollarApproval, state, helperPath });
    assert.ok(dollarBridge, 'quoted local directory containing a dollar sign is supported');
    const dollarOutput = execFileSync(shell, ['-NoProfile', '-NonInteractive', '-Command', dollarBridge.updatedCommand], { encoding: 'utf8', cwd: workspace, windowsHide: true });
    assert.match(dollarOutput, /visible\.md/);
  }
  console.log('windows-wildcard-list-bridge: pinned local name listing checks passed');
} finally { await rm(root, { recursive: true, force: true }); }
