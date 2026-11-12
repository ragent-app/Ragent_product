import assert from 'node:assert/strict';
import { access, link, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { analyzeWindowsFileChanges, analyzeWindowsPowerShell, analyzeWindowsRipgrep, decideWindowsPowerShellActions } from '../chat/windows-powershell-actions.mjs';
import { decideWindowsApproval } from '../chat/windows-approval-gate.mjs';
import { resolveWindowsSystemPaths } from '../chat/windows-system-paths.mjs';
import { buildWindowsSelectStringGlobBridge, verifyCodexWindowsBoundSearchApproval } from '../chat/windows-ripgrep-bridge.mjs';

if (process.platform !== 'win32') {
  console.log('windows-powershell-actions: skipped (requires Windows)');
  process.exit(0);
}
const root = await mkdtemp(path.join(os.tmpdir(), 'agentoc-powershell-actions-'));
const workspace = path.join(root, 'workspace');
await mkdir(path.join(workspace, 'folder'), { recursive: true });
await mkdir(path.join(workspace, 'linked-dest'), { recursive: true });
await mkdir(path.join(workspace, 'existing-dest', 'folder', '.ssh'), { recursive: true });
await mkdir(path.join(workspace, 'sensitive-folder', '.ssh'), { recursive: true });
await mkdir(path.join(workspace, 'build', 'nested'), { recursive: true });
await mkdir(path.join(workspace, 'build-sensitive', '.ssh'), { recursive: true });
await mkdir(path.join(workspace, 'glob-read'));
await writeFile(path.join(workspace, 'glob-read', 'public.md'), 'fixture');
await writeFile(path.join(workspace, 'glob-read', 'public.txt'), 'fixture');
await writeFile(path.join(workspace, 'glob-read', '.env.txt'), 'fixture');
await writeFile(path.join(workspace, 'readme.txt'), 'fixture');
await writeFile(path.join(workspace, 'another.txt'), 'fixture');
await writeFile(path.join(root, 'ordinary.txt'), 'outside fixture');
await mkdir(path.join(root, 'outside-folder'));
await mkdir(path.join(root, 'profile', 'AppData', 'Roaming', 'Microsoft', 'Credentials'), { recursive: true });
await mkdir(path.join(root, 'profile', 'AppData', 'Local', 'Microsoft', 'Protect'), { recursive: true });
await mkdir(path.join(root, 'profile', 'AppData', 'Local', 'ordinary-app'), { recursive: true });
await writeFile(path.join(root, 'profile', 'NTUSER.DAT'), 'fixture');
await writeFile(path.join(workspace, 'sensitive-folder', '.ssh', 'fixture-key'), 'fixture');
await writeFile(path.join(workspace, 'build', 'nested', 'output.txt'), 'fixture');
await writeFile(path.join(workspace, 'build-sensitive', '.ssh', 'fixture-key'), 'fixture');
await link(path.join(workspace, 'sensitive-folder', '.ssh', 'fixture-key'), path.join(workspace, 'ordinary-link'));
await link(path.join(workspace, 'sensitive-folder', '.ssh', 'fixture-key'), path.join(workspace, 'linked-dest', 'readme.txt'));
const context = { platform: 'win32', cwd: workspace, trustedWorkspaceRoot: workspace, protectedRoots: [path.join(root, 'protected')] };
async function inspect(command, options) {
  const result = await analyzeWindowsPowerShell(command, context, options);
  return { ...result, ...decideWindowsPowerShellActions(result) };
}
for (const target of [path.join(root, 'profile', 'NTUSER.DAT'), path.join(root, 'profile', 'AppData', 'Roaming', 'Microsoft', 'Credentials', 'fixture'),
  path.join(root, 'profile', 'AppData', 'Local', 'Microsoft', 'Protect', 'fixture')]) {
  for (const kind of ['read', 'write', 'delete']) {
    assert.equal(decideWindowsPowerShellActions(await analyzeWindowsFileChanges([{ path: target, kind }], context)).decision, 'review', `${kind}: protected profile path`);
  }
}
assert.equal(decideWindowsPowerShellActions(await analyzeWindowsFileChanges([{ path: path.join(root, 'profile', 'AppData', 'Local', 'ordinary-app', 'fixture'), kind: 'write' }], context)).decision, 'allow');
{
  const previous = process.env.ProgramData;
  const programDataRoot = path.join(root, 'relocated-workspace-data');
  const programDataWorkspace = path.join(programDataRoot, 'owner-workspace');
  const protectedMemory = path.join(programDataWorkspace, 'memory');
  await mkdir(protectedMemory, { recursive: true });
  await writeFile(path.join(programDataWorkspace, 'readme.txt'), 'fixture');
  await writeFile(path.join(protectedMemory, 'private.txt'), 'fixture');
  await mkdir(path.join(programDataRoot, 'another-app'));
  await writeFile(path.join(programDataRoot, 'another-app', 'private.txt'), 'fixture');
  const programDataContext = {
    ...context,
    cwd: programDataWorkspace,
    trustedWorkspaceRoot: programDataWorkspace,
    programDataRoot,
    protectedRoots: [protectedMemory],
    systemPathRoots: [programDataRoot],
  };
  try {
    process.env.ProgramData = programDataRoot;
    const shellApproval = script => ({ kind: 'command', params: {
      command: [resolveWindowsSystemPaths().powershell, '-NoProfile', '-Command', script],
    } });
    const decide = (script, riskMode = 'recommended') => decideWindowsApproval(shellApproval(script), {
      riskMode, cwd: programDataWorkspace, riskContext: programDataContext, riskContextValid: true,
    });
    const listing = await decide(`Get-ChildItem -LiteralPath '${programDataWorkspace}'`);
    assert.equal(listing.decision, 'auto-allow', 'PowerShell may list a Run-bound workspace beneath ProgramData');
    const content = await decide(`Get-Content -LiteralPath '${path.join(programDataWorkspace, 'readme.txt')}'`);
    assert.equal(content.decision, 'auto-allow', 'PowerShell may read a file in that workspace');
    const mutation = await decide(`Set-Content -LiteralPath '${path.join(programDataWorkspace, 'readme.txt')}' -Value changed`);
    assert.equal(mutation.decision, 'prompt', 'ProgramData workspace writes remain owner-gated');
    const memoryRead = await decide(`Get-Content -LiteralPath '${path.join(protectedMemory, 'private.txt')}'`);
    assert.equal(memoryRead.decision, 'prompt', 'instance memory remains protected inside the workspace boundary');
    const outsideRead = await decide(`Get-Content -LiteralPath '${path.join(programDataRoot, 'another-app', 'private.txt')}'`);
    assert.equal(outsideRead.decision, 'auto-allow', 'ordinary ProgramData files do not require workspace membership');
  } finally {
    if (previous === undefined) delete process.env.ProgramData; else process.env.ProgramData = previous;
  }
}
{
  const windows = path.join(root, 'Windows');
  await mkdir(path.join(windows, 'System32', 'config'), { recursive: true });
  await writeFile(path.join(windows, 'win.ini'), 'fixture');
  await writeFile(path.join(windows, 'System32', 'config', 'SAM'), 'fixture');
  const systemContext = { ...context, systemPathRoots: [windows] };
  assert.equal(decideWindowsPowerShellActions(await analyzeWindowsFileChanges([{ path: path.join(windows, 'win.ini'), kind: 'read' }], systemContext)).decision, 'allow');
  assert.equal(decideWindowsPowerShellActions(await analyzeWindowsFileChanges([{ path: path.join(windows, 'System32', 'config', 'SAM'), kind: 'read' }], systemContext)).decision, 'review');
  const copy = (source, destination) => `Copy-Item -LiteralPath '${source.replaceAll("'", "''")}' -Destination '${destination.replaceAll("'", "''")}'`;
  const outsideDestination = path.join(root, 'outside-copy.ini');
  assert.equal(decideWindowsPowerShellActions(await analyzeWindowsPowerShell(copy(path.join(windows, 'win.ini'), outsideDestination), systemContext)).decision, 'allow');
  assert.equal(decideWindowsPowerShellActions(await analyzeWindowsPowerShell(copy(path.join(windows, 'System32', 'config', 'SAM'), outsideDestination), systemContext)).decision, 'review');
  assert.equal(decideWindowsPowerShellActions(await analyzeWindowsPowerShell(copy(path.join(windows, 'win.ini'), path.join(windows, 'target.ini')), systemContext)).decision, 'review');
  assert.equal(decideWindowsPowerShellActions(await analyzeWindowsPowerShell(copy(path.join(windows, 'win.ini'), outsideDestination), { ...systemContext, protectedRoots: [windows] })).decision, 'review');
  assert.equal(decideWindowsPowerShellActions(await analyzeWindowsRipgrep(['--no-config', 'fixture', path.join(windows, 'win.ini')], systemContext)).decision, 'allow');
  assert.equal(decideWindowsPowerShellActions(await analyzeWindowsRipgrep(['--no-config', 'fixture', path.join(windows, 'System32', 'config', 'SAM')], systemContext)).decision, 'review');
}
{
  const previous = process.env.ProgramData;
  const shared = path.join(root, 'relocated-shared-data');
  await mkdir(shared);
  try {
    process.env.ProgramData = shared;
    const script = `Set-Content -LiteralPath '${path.join(shared, 'fixture.txt').replace(/'/g, "''")}' -Value hello`;
    for (const riskMode of ['recommended', 'full-auto']) {
      const approval = { kind: 'command', params: { command: [resolveWindowsSystemPaths().powershell, '-NoProfile', '-Command', script] } };
      assert.equal((await decideWindowsApproval(approval, { riskMode, cwd: workspace, riskContext: context })).decision, 'prompt', `${riskMode}: relocated ProgramData`);
    }
  } finally {
    if (previous === undefined) delete process.env.ProgramData; else process.env.ProgramData = previous;
  }
}
let result = await inspect('Get-Content readme.txt | Select-Object -First 1');
assert.equal(result.decision, 'allow');
assert.equal(result.actions.length, 2);
assert.equal((await inspect("Test-Path -LiteralPath '..\\protected\\secret'")).decision, 'allow', 'existence checks do not read protected file contents');
assert.equal((await inspect("Get-Content -LiteralPath '..\\protected\\secret'")).decision, 'review', 'protected file contents still require review');
{
  const quote = value => `'${String(value).replaceAll("'", "''")}'`;
  const ordinary = path.join(root, 'ordinary.txt');
  const sensitive = path.join(workspace, 'sensitive-folder', '.ssh', 'fixture-key');
  const command = `$p=${quote(ordinary)}; if (Test-Path -LiteralPath $p) { Get-Item -LiteralPath $p | Select-Object Name }`;
  const protectedCommand = `$p=${quote(sensitive)}; if (Test-Path -LiteralPath $p) { Get-Content -LiteralPath $p }`;
  for (const riskMode of ['recommended', 'full-auto']) {
    const state = { riskMode, cwd: workspace, riskContext: context, riskContextValid: true };
    const approval = { kind: 'command', providerMethod: 'can_use_tool', params: { tool_name: 'PowerShell', input: { command } } };
    assert.equal((await decideWindowsApproval(approval, state)).decision, 'auto-allow', `${riskMode}: static variable resolves to ordinary outside file`);
    approval.params.input.command = protectedCommand;
    assert.equal((await decideWindowsApproval(approval, state)).decision, 'prompt', `${riskMode}: static variable resolves to sensitive file`);
    for (const unsafe of [
      `$p=${quote(ordinary)}; $p=${quote(sensitive)}; Get-Content -LiteralPath $p`,
      `$p=${quote(ordinary)}; if (Test-Path -LiteralPath $p) { $p=${quote(sensitive)} }; Get-Content -LiteralPath $p`,
      `$p=${quote(ordinary)}; Set-Variable p ${quote(sensitive)}; Get-Content -LiteralPath $p`,
      `$p=${quote(ordinary)}; Get-Content -LiteralPath ($p + '.other')`,
      `$p=${quote(ordinary)}; & $p`,
      `$p=${quote(ordinary)}; Get-Content -LiteralPath "$p"`,
      `$p=${quote(ordinary)}; Get-Content -LiteralPath $p > $p`,
      `$p=Join-Path ${quote(root)} ordinary.txt; Get-Content -LiteralPath $p`,
      `$ErrorView=${quote(ordinary)}; Get-Content -LiteralPath $ErrorView`,
      `$LogCommandHealthEvent=${quote(ordinary)}; Get-Content -LiteralPath $LogCommandHealthEvent`,
    ]) {
      approval.params.input.command = unsafe;
      assert.equal((await decideWindowsApproval(approval, state)).decision, 'prompt', `${riskMode}: dynamic variable operation is not automatically allowed`);
    }
  }
}
for (const command of ["Select-String -Path readme.txt -Pattern fixture", "Select-String fixture readme.txt", "Select-String -LiteralPath '..\\ordinary.txt' -Pattern fixture -SimpleMatch"]) {
  assert.equal((await inspect(command)).decision, 'allow', `${command}: ordinary files can be searched`);
}
for (const command of ["Select-String -Path '..\\protected\\secret' -Pattern fixture", "Select-String -Path 'glob-read\\*.txt' -Pattern fixture", "Select-String -Path 'glob-read\\*.md' -Pattern fixture", "Select-String -Path '..\\protected\\*.txt' -Pattern fixture", "Select-String -LiteralPath ordinary-link -Pattern fixture"]) {
  assert.equal((await inspect(command)).decision, 'review', `${command}: file scope still needs checking`);
}
assert.equal((await inspect("Select-String -LiteralPath 'readme.txt','..\\protected\\secret' -Pattern fixture")).decision, 'review', 'every literal path in a list is checked');
const hiddenGlobFile = path.join(workspace, 'glob-read', 'hidden.md');
await writeFile(hiddenGlobFile, 'hidden-fixture');
execFileSync(path.join(process.env.SystemRoot, 'System32', 'attrib.exe'), ['+H', hiddenGlobFile], { windowsHide: true });
for (const riskMode of ['recommended', 'full-auto']) {
  const glob = path.join(workspace, 'glob-read', '*.md');
  const approval = { kind: 'command', providerMethod: 'can_use_tool', params: { tool_name: 'PowerShell', input: { command: `Select-String -Path '${glob}' -Pattern fixture` } } };
  const state = { riskMode, turnActive: true, cwd: workspace, riskContext: context, riskContextValid: true };
  assert.equal((await decideWindowsApproval(approval, state)).decision, 'prompt', 'unmodified wildcard is never directly authorized');
  const bridge = await buildWindowsSelectStringGlobBridge({ approval, state });
  assert.ok(bridge, `${riskMode}: ordinary wildcard gets a bound rewrite`);
  assert.match(bridge.updatedCommand, /-LiteralPath/i);
  assert.doesNotMatch(bridge.updatedCommand, /\*/);
  assert.doesNotMatch(bridge.updatedCommand, /hidden\.md/i, 'wildcard search does not add hidden files that Select-String would omit');
  assert.equal((await inspect(bridge.updatedCommand)).decision, 'allow');
  if (process.env.AGENTOC_QA_SAFE_SEARCH_HELPER) {
    const helperPath = process.env.AGENTOC_QA_SAFE_SEARCH_HELPER;
    const pinned = await buildWindowsSelectStringGlobBridge({ approval, state, helperPath });
    assert.ok(pinned, `${riskMode}: wildcard search gets a handle-bound executor`);
    const rawApproval = { ...approval, params: { ...approval.params, input: { command: `${approval.params.input.command} -Raw -NoEmphasis` } } };
    const rawSearch = await buildWindowsSelectStringGlobBridge({ approval: rawApproval, state, helperPath });
    assert.ok(rawSearch, `${riskMode}: raw wildcard search is still automatic`);
    const rawResult = execFileSync(resolveWindowsSystemPaths().powershell, ['-NoProfile', '-NonInteractive', '-Command', rawSearch.updatedCommand], { cwd: workspace, encoding: 'utf8', windowsHide: true });
    assert.equal(rawResult.trim(), 'fixture');
    const shellQuote = value => `'${value.replaceAll("'", `'"'"'`)}'`;
    const commandForCodex = cmd => [resolveWindowsSystemPaths().powershell, '-NoProfile', '-Command', cmd].map(shellQuote).join(' ');
    const current = { ...state, startedTurn: true, threadId: 'thread', turnId: 'turn' };
    const codex = { kind: 'command', providerMethod: 'item/commandExecution/requestApproval', params: {
      threadId: 'thread', turnId: 'turn', itemId: 'item', cwd: workspace, command: commandForCodex(pinned.updatedCommand),
    } };
    assert.equal(await verifyCodexWindowsBoundSearchApproval({ approval: codex, state: current, helperPath }), true);
    assert.equal(await verifyCodexWindowsBoundSearchApproval({ approval: { ...codex, params: { ...codex.params, turnId: 'other' } }, state: current, helperPath }), false);
    assert.equal(await verifyCodexWindowsBoundSearchApproval({ approval: { ...codex, params: { ...codex.params, additionalPermissions: { network: true } } }, state: current, helperPath }), false);
    const encoded = /--request '([A-Za-z0-9_-]+)'$/.exec(pinned.updatedCommand)[1];
    const forged = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    forged.targets[0].path = path.join(workspace, 'sensitive-folder', '.ssh', 'fixture-key');
    const forgedCommand = pinned.updatedCommand.replace(encoded, Buffer.from(JSON.stringify(forged)).toString('base64url'));
    assert.equal(await verifyCodexWindowsBoundSearchApproval({ approval: { ...codex, params: { ...codex.params, command: commandForCodex(forgedCommand) } }, state: current, helperPath }), false, 'forged hook request cannot read sensitive file');
    const actual = execFileSync(resolveWindowsSystemPaths().powershell, ['-NoProfile', '-NonInteractive', '-Command', pinned.updatedCommand], { cwd: workspace, encoding: 'utf8', windowsHide: true });
    assert.match(actual, /fixture/);
    const target = path.join(workspace, 'glob-read', 'public.md');
    await writeFile(target, 'changed after approval');
    try {
      assert.throws(() => execFileSync(resolveWindowsSystemPaths().powershell, ['-NoProfile', '-NonInteractive', '-Command', `${pinned.updatedCommand}; exit $LASTEXITCODE`], { cwd: workspace, encoding: 'utf8', windowsHide: true, stdio: 'pipe' }), 'changed target cannot be searched');
    } finally { await writeFile(target, 'fixture'); }
  }
  const lateSecret = path.join(workspace, 'glob-read', '.env.late.md');
  await writeFile(lateSecret, 'late-sensitive-fixture');
  try {
    const actualOutput = execFileSync(resolveWindowsSystemPaths().powershell, ['-NoProfile', '-NonInteractive', '-Command', bridge.updatedCommand], { cwd: workspace, encoding: 'utf8', windowsHide: true });
    assert.doesNotMatch(actualOutput, /late-sensitive-fixture/, 'a file added after approval is not read by the bound command');
  } finally { await rm(lateSecret, { force: true }); }
  approval.params.input.command = `Select-String -Path '${path.join(workspace, 'glob-read', '*.txt')}' -Pattern fixture`;
  assert.equal(await buildWindowsSelectStringGlobBridge({ approval, state }), null, 'sensitive matched file is not rewritten');
  approval.params.input.command = `Select-String -Path '${glob}' -Pattern fixture; Remove-Item -LiteralPath '${path.join(workspace, 'readme.txt')}'`;
  assert.equal(await buildWindowsSelectStringGlobBridge({ approval, state }), null, 'a compound command cannot be rewritten as a simple search');
  approval.params.input.command = `Select-String -Path '${glob}' -Pattern fixture`;
  assert.equal(await buildWindowsSelectStringGlobBridge({ approval: { ...approval, params: { ...approval.params, additionalPermissions: { network: true } } }, state }), null, 'extra permission requests cannot be silently granted');
}
execFileSync(path.join(process.env.SystemRoot, 'System32', 'attrib.exe'), ['-H', hiddenGlobFile], { windowsHide: true });
for (const command of ["winget list --id Microsoft.VisualStudioCode --exact --disable-interactivity | Select-String 'Visual Studio'", "winget.exe list --source winget | Select-String -Pattern 'example' -SimpleMatch", "'text' | Select-String 'text'", "(winget list --id Example.App | Select-String 'Example')"]) {
  assert.equal((await inspect(command)).decision, 'allow', command);
}
for (const riskMode of ['recommended', 'full-auto']) {
  const command = "winget list --id Microsoft.VisualStudioCode --exact --disable-interactivity | Select-String 'Visual Studio'";
  const state = { riskMode, cwd: workspace, riskContext: context, riskContextValid: true };
  const claude = { kind: 'command', providerMethod: 'can_use_tool', params: { tool_name: 'PowerShell', input: { command } } };
  const codex = { kind: 'command', params: { command: [resolveWindowsSystemPaths().powershell, '-NoProfile', '-Command', command] } };
  assert.equal((await decideWindowsApproval(claude, state)).decision, 'auto-allow', `${riskMode}: Claude list query`);
  assert.equal((await decideWindowsApproval(codex, state)).decision, 'auto-allow', `${riskMode}: Codex list query`);
  const search = `Select-String -Path '${path.join(root, 'ordinary.txt').replaceAll("'", "''")}' -Pattern fixture`;
  claude.params.input.command = search;
  codex.params.command[3] = search;
  assert.equal((await decideWindowsApproval(claude, state)).decision, 'auto-allow', `${riskMode}: Claude searches an outside file`);
  assert.equal((await decideWindowsApproval(codex, state)).decision, 'auto-allow', `${riskMode}: Codex searches an outside file`);
}
for (const command of ['winget install --id Example.App', 'winget uninstall --id Example.App', '(winget uninstall --id Example.App)', 'winget list --open-logs', "winget list --id Example.App | Select-String -Path 'secret.txt' -Pattern 'x'"]) {
  assert.equal((await inspect(command)).decision, 'review', command);
}
for (const command of ['git status --short', 'git status -sb --ignored=matching', 'git diff --stat', 'git branch --show-current', 'git log -n 5 --oneline', "git log -1 --format='%h %s'"]) {
  assert.equal((await inspect(command)).decision, 'allow', `${command} is a read-only Git query`);
}
for (const command of ['git diff', 'git add .', 'git commit -m test']) assert.equal((await inspect(command)).decision, 'allow');
for (const command of ['python --version', 'node --version', 'go version', 'java -version']) assert.equal((await inspect(command)).decision, 'allow');
for (const command of ['git status --ignored=bogus']) {
  assert.equal((await inspect(command)).decision, 'review', `${command} is not on the read-only Git allowlist`);
}
result = await inspect(`Set-Content -LiteralPath '${path.join(workspace, 'chain.txt')}' -Value PASS && Get-Content -LiteralPath '${path.join(workspace, 'chain.txt')}' 2>&1 | Out-String`);
assert.equal(result.decision, 'allow', 'a literal PowerShell 7 success chain of safe workspace operations is eligible');
assert.deepEqual(result.actions.map(action => action.kind), ['write', 'read', 'read']);
assert.equal((await inspect(`Remove-Item -LiteralPath '${path.join(workspace, 'readme.txt')}' && Write-Output done`)).decision, 'allow');
assert.equal((await inspect(`Get-Content -LiteralPath '${path.join(workspace, 'readme.txt')}' && Remove-Item -LiteralPath '${path.join(root, 'protected', 'secret')}'`)).decision, 'review', 'a safe chain cannot hide an unsafe later action');
assert.equal((await inspect(`Set-Content -LiteralPath '${path.join(workspace, 'chain.txt')}' -Value PASS || Remove-Item -LiteralPath '${path.join(workspace, 'readme.txt')}'`)).decision, 'review', 'failure chains remain explicit review requests');
result = await inspect('Get-Content -LiteralPath readme.txt,folder');
assert.equal(result.decision, 'allow');
assert.equal(result.actions.length, 2);
assert.equal((await inspect('Get-Content readme.txt,..\\protected\\secret')).decision, 'review');
assert.equal((await inspect('Get-Content readme.txt,$env:TEMP')).decision, 'review');
assert.equal((await inspect('Remove-Item readme.txt,folder')).decision, 'review');
assert.equal((await inspect('Remove-Item -Force -Confirm:$false readme.txt,another.txt')).decision, 'allow');
assert.equal((await inspect('Remove-Item readme.txt,..\\protected\\secret')).decision, 'review');
assert.equal((await inspect('Remove-Item -Recurse readme.txt,another.txt')).decision, 'review');
assert.equal((await inspect('Get-ChildItem | Get-Content readme.txt,folder')).decision, 'review');
assert.equal((await inspect('Get-Process -Name explorer | Select-Object -First 1')).decision, 'allow');
assert.equal((await inspect('Get-Command')).decision, 'allow');
assert.equal((await inspect('Get-Command -ListImported')).decision, 'allow');
for (const type of ['Alias', 'Function', 'Filter', 'Cmdlet', 'ExternalScript', 'Application', 'Script', 'Configuration', 'All']) {
  assert.equal((await inspect(`Get-Command -ListImported -CommandType ${type}`)).decision, 'allow', type);
}
assert.equal((await inspect('Get-Command -ListImported -CommandType Unknown')).decision, 'review');
assert.equal((await inspect('Get-Command -CommandType Cmdlet')).decision, 'allow');
assert.equal((await inspect('Get-Command -ListImported -CommandType Cmdlet -Name Get-Content')).decision, 'review');
assert.equal((await inspect('Get-Command -ListImported | Select-Object -First 1')).decision, 'allow');
assert.equal((await inspect("'AgentoCFixture\\Invoke-AgentoCProbe' | Get-Command -ListImported")).decision, 'review');
assert.equal((await inspect("Write-Output 'AgentoCFixture\\Invoke-AgentoCProbe' | Get-Command")).decision, 'review');
assert.equal((await inspect('Get-Command -Name Get-Content -CommandType Cmdlet')).decision, 'review');
assert.equal((await inspect('Get-Command -ListImported -Name Invoke-AgentoCProbe')).decision, 'review');
assert.equal((await inspect('Get-Command -ListImported AgentoCFixture\\Invoke-AgentoCProbe')).decision, 'review');
assert.equal((await inspect('Get-Process -Id $env:PID')).decision, 'review');
assert.equal((await inspect('Get-Command -Name Get-Content; Remove-Item . -Recurse')).decision, 'review');
result = await inspect('Set-Content -Path result.txt -Value hello');
assert.equal(result.decision, 'allow');
assert.equal(result.actions[0].kind, 'write');
assert.equal((await inspect('Set-Content -LiteralPath result.txt -Value hello -Encoding utf8 -NoNewline')).decision, 'allow');
assert.equal((await inspect('Add-Content -LiteralPath result.txt -Value hello -NoNewline')).decision, 'allow');
assert.equal((await inspect('Get-Content -LiteralPath readme.txt -Tail 3 -ReadCount 2')).decision, 'allow');
assert.equal((await inspect('Get-Content -LiteralPath readme.txt -TotalCount $env:COUNT')).decision, 'review');
assert.equal((await inspect('Set-Content -LiteralPath result.txt -Value hello -Stream hidden')).decision, 'review');
result = await inspect('Clear-Content -LiteralPath readme.txt -Force');
assert.equal(result.decision, 'allow');
assert.equal(result.actions[0].kind, 'write');
assert.equal((await inspect('clc -LiteralPath readme.txt')).decision, 'allow');
assert.equal((await inspect('Clear-Content -LiteralPath ..\\protected\\result.txt')).decision, 'review');
assert.equal((await inspect('Clear-Content -Path *.txt')).decision, 'review');
assert.equal((await inspect('Clear-Content -LiteralPath ordinary-link')).decision, 'review');
assert.equal((await inspect('mkdir new-folder')).decision, 'allow');
assert.equal((await inspect('mkdir -Path ..\\outside-new -Force')).decision, 'allow');
assert.equal((await inspect('mkdir -Path ..\\protected\\new-folder')).decision, 'review');
assert.equal((await inspect('mkdir -Path $env:TEMP')).decision, 'review');
assert.equal((await inspect('mkdir folder other-folder')).decision, 'review');
assert.equal((await inspect('Get-ChildItem folder | mkdir -Path new-folder')).decision, 'review');
assert.equal((await inspect('mkdir -Name new-folder')).decision, 'review');
assert.equal((await inspect('Write-Output hello > result.txt')).decision, 'allow');
assert.equal((await inspect('Write-Output hello >> result.txt')).decision, 'allow');
assert.equal((await inspect('Write-Output hello > ..\\protected\\result.txt')).decision, 'review');
assert.equal((await inspect('Write-Output hello > ordinary-link')).decision, 'review');
assert.equal((await inspect('Write-Output hello > $env:TEMP')).decision, 'review');
assert.equal((await inspect('Write-Output hello 2>&1')).decision, 'allow');
assert.equal((await inspect('Write-Output hello 2>$null')).decision, 'allow');
assert.equal((await inspect('Write-Output hello > $null')).decision, 'allow');
assert.equal((await inspect("New-Item -ItemType File -Path 'new-fixture.txt' | Out-Null")).decision, 'allow');
assert.equal((await inspect("New-Item -ItemType File -Path '..\\protected\\new-fixture.txt' | Out-Null")).decision, 'review');
assert.equal((await inspect("Get-Item -LiteralPath 'readme.txt' | Format-List Name,Length | Out-String")).decision, 'allow');
assert.equal((await inspect("Get-ChildItem . | Where-Object Name -like '*.txt' | Select-Object Name")).decision, 'allow');
assert.equal((await inspect("Get-ChildItem . | where Length -gt 0 | Select-Object Name")).decision, 'allow');
assert.equal((await inspect("Get-ChildItem . | Where-Object { $_.Name -like '*.txt' } | Select-Object Name")).decision, 'allow');
assert.equal((await inspect("Get-ChildItem . | where { $PSItem.Length -gt 0 }")).decision, 'allow');
assert.equal((await inspect("Get-ChildItem . | Where-Object { ($_.Name -like '*.txt') -and ($_.Length -gt 0) -and -not $_.PSIsContainer }")).decision, 'allow');
assert.equal((await inspect("Get-ChildItem . | Where-Object { $_.Name -eq 'readme.txt' -or $_.PSIsContainer -eq $true }")).decision, 'allow');
assert.equal((await inspect("Get-ChildItem '..\\protected' | Where-Object Name -like '*.txt'")).decision, 'review');
assert.equal((await inspect("Get-ChildItem '..\\protected' | Where-Object { $_.Name -like '*.txt' }")).decision, 'review');
assert.equal((await inspect("Get-ChildItem . | Where-Object { Remove-Item readme.txt }")).decision, 'review');
assert.equal((await inspect("Get-ChildItem . | Where-Object { $_.Name -like '*.txt'; Remove-Item readme.txt }")).decision, 'review');
assert.equal((await inspect("Get-ChildItem . | Where-Object { $_.Name.ToString() -eq 'x' }")).decision, 'review');
assert.equal((await inspect("Get-ChildItem . | Where-Object { $_.Name -eq $env:TEMP }")).decision, 'review');
assert.equal((await inspect("Get-ChildItem . | Where-Object { $_.Name -eq $(Remove-Item readme.txt) }")).decision, 'review');
assert.equal((await inspect("Get-ChildItem . | Where-Object { ($_.Name -eq 'x') -or (Remove-Item readme.txt) }")).decision, 'review');
assert.equal((await inspect("Get-ChildItem . | Where-Object { $_.Name -eq 'x' -and $_.Name -eq $env:TEMP }")).decision, 'review');
assert.equal((await inspect("Get-ChildItem . | Where-Object { $_.Name -eq 'x' -or $_.Name.ToString() -eq 'x' }")).decision, 'review');
assert.equal((await inspect("Get-ChildItem . | Where-Object Name -like $env:TEMP")).decision, 'review');
assert.equal((await inspect("Get-Item -LiteralPath '..\\protected\\secret.txt' | fl Name,Length | Out-String")).decision, 'review');
assert.equal((await inspect("Get-Item -LiteralPath 'readme.txt' | Format-List @{Name='x';Expression={Remove-Item readme.txt}} | Out-String")).decision, 'review');
assert.equal((await inspect("Get-Content -LiteralPath 'readme.txt' 2>$null")).decision, 'allow');
assert.equal((await inspect("Get-Content -LiteralPath '..\\protected\\secret.txt' 2>$null")).decision, 'review');
assert.equal((await inspect('Write-Output hello 2>$env:TEMP')).decision, 'review');
assert.equal((await inspect('Write-Output hello 2>$(Get-Location)')).decision, 'review');
assert.equal((await inspect("'hello' > result.txt")).decision, 'allow');
assert.equal((await inspect("'hello' >> result.txt")).decision, 'allow');
assert.equal((await inspect("'hello' > ..\\protected\\result.txt")).decision, 'review');
assert.equal((await inspect("'hello' > ordinary-link")).decision, 'review');
assert.equal((await inspect("'hello' > $env:TEMP")).decision, 'review');
assert.equal((await inspect("(Get-Date).Date > result.txt")).decision, 'review');
assert.equal((await inspect("'hello' | Out-File -FilePath result.txt -Encoding utf8")).decision, 'allow');
assert.equal((await inspect('Write-Output hello | Out-File -Append result.txt')).decision, 'allow');
assert.equal((await inspect('Write-Output hello | Out-File -LiteralPath ..\\protected\\result.txt')).decision, 'review');
assert.equal((await inspect('Write-Output hello | Out-File -FilePath ordinary-link')).decision, 'review');
assert.equal((await inspect('Write-Output hello | Out-File -FilePath result.txt -LiteralPath other.txt')).decision, 'review');
assert.equal((await inspect('Write-Output hello | Out-File -FilePath $env:TEMP')).decision, 'review');
assert.equal((await inspect('Set-Content -LiteralPath .env:stream -Value hello')).decision, 'review');
assert.equal((await inspect('Write-Output hello > NUL')).decision, 'review');
assert.equal((await inspect('Write-Output hello > CON.txt')).decision, 'review');
assert.equal((await inspect("Write-Output hello > '.env.'")).decision, 'review');
assert.equal((await inspect('Get-Content ordinary-link')).decision, 'review');
assert.equal((await inspect('Set-Content ordinary-link -Value hello')).decision, 'review');
assert.equal((await inspect('Remove-Item ordinary-link')).decision, 'allow');
assert.equal((await inspect('Remove-Item -Confirm:$false readme.txt')).decision, 'allow');
assert.equal((await inspect('Remove-Item -Confirm readme.txt')).decision, 'review');
assert.equal((await inspect('Remove-Item -Confirm:$true readme.txt')).decision, 'review');
assert.equal((await inspect('Remove-Item -Confirm:$env:FLAG readme.txt')).decision, 'review');
assert.equal((await inspect('Remove-Item readme.txt -Recurse')).decision, 'review');
assert.equal(decideWindowsPowerShellActions(await analyzeWindowsFileChanges([{ path: path.join(workspace, 'ordinary-link'), kind: 'write' }], context)).decision, 'review');
result = await inspect('Copy-Item -Path readme.txt -Destination result.txt');
assert.equal(result.decision, 'allow');
assert.deepEqual(result.actions.map((a) => a.kind), ['read', 'write']);
assert.equal((await inspect('Copy-Item -Path readme.txt -Destination linked-dest')).decision, 'review');
assert.equal((await inspect('Move-Item -Path readme.txt -Destination linked-dest')).decision, 'review');
result = await inspect('Rename-Item -LiteralPath readme.txt -NewName renamed.txt');
assert.equal(result.decision, 'allow');
assert.deepEqual(result.actions.map((action) => action.kind), ['delete', 'write']);
assert.equal(path.win32.basename(result.actions[1].target.actual), 'renamed.txt');
assert.equal((await inspect('ren readme.txt renamed.txt')).decision, 'allow');
assert.equal((await inspect('rni -Path readme.txt -NewName .env')).decision, 'review');
assert.equal((await inspect('Rename-Item -Path readme.txt -NewName ..\\outside.txt')).decision, 'review');
assert.equal((await inspect('Rename-Item -Path readme.txt -NewName *.txt')).decision, 'review');
assert.equal((await inspect('Get-ChildItem | Rename-Item -Path readme.txt -NewName renamed.txt')).decision, 'review');
assert.equal((await inspect('Rename-Item -Path folder -NewName renamed-folder')).decision, 'review');
assert.equal((await inspect('Rename-Item -Path ..\\protected\\result.txt -NewName other.txt')).decision, 'review');
assert.equal((await inspect('Rename-Item -Path readme.txt -NewName ordinary-link')).decision, 'review');
for (const riskMode of ['recommended', 'full-auto']) {
  const approval = (script) => ({ kind: 'command', params: { command: [resolveWindowsSystemPaths().powershell, '-NoProfile', '-Command', script] } });
  const state = { riskMode, cwd: workspace, riskContext: context };
  assert.equal((await decideWindowsApproval(approval('Get-Command -ListImported AgentoCFixture\\Invoke-AgentoCProbe'), state)).decision, 'prompt', `${riskMode}: module lookup`);
  assert.equal((await decideWindowsApproval(approval('Get-Command -ListImported -Name Invoke-AgentoCProbe'), state)).decision, 'prompt', `${riskMode}: unqualified lookup`);
  assert.equal((await decideWindowsApproval(approval("'AgentoCFixture\\Invoke-AgentoCProbe' | Get-Command -ListImported"), state)).decision, 'prompt', `${riskMode}: piped module lookup`);
  assert.equal((await decideWindowsApproval(approval("'..\\protected' | Get-ChildItem"), state)).decision, 'prompt', `${riskMode}: piped listing target`);
  assert.equal((await decideWindowsApproval(approval('Get-Command -ListImported'), state)).decision, 'auto-allow', `${riskMode}: imported command inventory`);
  assert.equal((await decideWindowsApproval(approval('Get-Command -ListImported -CommandType Cmdlet'), state)).decision, 'auto-allow', `${riskMode}: imported command type inventory`);
  const outside = path.join(root, 'ordinary.txt').replace(/'/g, "''");
  assert.equal((await decideWindowsApproval(approval(`Get-Content -LiteralPath '${outside}' -Tail 1`), state)).decision, 'auto-allow');
  assert.equal((await decideWindowsApproval(approval(`Set-Content -LiteralPath '${outside}' -Value hello -Encoding utf8 -NoNewline`), state)).decision, 'auto-allow');
  assert.equal((await decideWindowsApproval(approval(`Set-Content -LiteralPath '${outside}' -Value hello -Stream hidden`), state)).decision, 'prompt');
  assert.equal((await decideWindowsApproval(approval('Clear-Content -LiteralPath ..\\ordinary.txt'), state)).decision, 'auto-allow', `${riskMode}: ordinary outside file`);
  assert.equal((await decideWindowsApproval(approval('Clear-Content -LiteralPath ..\\protected\\result.txt'), state)).decision, 'prompt', `${riskMode}: protected file`);
  assert.equal((await decideWindowsApproval(approval('Rename-Item -LiteralPath ..\\ordinary.txt -NewName renamed.txt'), state)).decision, 'auto-allow', `${riskMode}: rename ordinary outside file`);
  assert.equal((await decideWindowsApproval(approval('Rename-Item -LiteralPath ..\\ordinary.txt -NewName .env'), state)).decision, 'prompt', `${riskMode}: sensitive rename destination`);
  assert.equal((await decideWindowsApproval(approval('Copy-Item readme.txt -Destination linked-dest'), state)).decision, 'prompt');
  assert.equal((await decideWindowsApproval(approval('Copy-Item readme.txt -Destination ordinary-output.txt'), state)).decision, 'auto-allow');
  for (const script of [
    'Get-Content -LiteralPath ..\\ordinary.txt',
    'Set-Content -LiteralPath ..\\outside-output.txt -Value hello',
    'Remove-Item -LiteralPath ..\\ordinary.txt',
  ]) {
    assert.equal((await decideWindowsApproval(approval(script), state)).decision, 'auto-allow', `${riskMode}: ${script}`);
  }
  assert.equal((await decideWindowsApproval(approval('Set-Content -LiteralPath ..\\protected\\result.txt -Value hello'), state)).decision, 'prompt');
  assert.equal((await decideWindowsApproval(approval('Remove-Item -LiteralPath ..\\outside-folder -Recurse'), state)).decision, 'prompt');
}
// A module-qualified lookup executes the module body even with ListImported.
// Verify the behavior against both Windows PowerShell and packaged PowerShell
// when provided; the fixture writes only an isolated marker under TEMP.
for (const [index, shell] of [resolveWindowsSystemPaths().powershell, process.env.AGENTOC_TEST_PWSH].filter(Boolean).entries()) {
  const name = `AgentoCQueryFixture${index}`;
  const modules = path.join(root, `modules-${index}`);
  const moduleDir = path.join(modules, name);
  const marker = path.join(root, `module-loaded-${index}.txt`);
  await mkdir(moduleDir, { recursive: true });
  await writeFile(path.join(moduleDir, `${name}.psm1`), `Set-Content -LiteralPath '${marker.replaceAll("'", "''")}' -Value loaded\nfunction Invoke-AgentoCProbe { 'fixture' }\nExport-ModuleMember -Function Invoke-AgentoCProbe\n`);
  const env = { ...process.env, PSModulePath: `${modules};${process.env.PSModulePath || ''}` };
  execFileSync(shell, ['-NoProfile', '-NonInteractive', '-Command', 'Get-Command -ListImported | Out-Null'], { env, windowsHide: true });
  await assert.rejects(access(marker), { code: 'ENOENT' });
  execFileSync(shell, ['-NoProfile', '-NonInteractive', '-Command', 'Get-Command -ListImported -CommandType Cmdlet | Out-Null'], { env, windowsHide: true });
  await assert.rejects(access(marker), { code: 'ENOENT' });
  execFileSync(shell, ['-NoProfile', '-NonInteractive', '-Command', 'Get-Command -CommandType Cmdlet | Out-Null'], { env, windowsHide: true });
  await assert.rejects(access(marker), { code: 'ENOENT' });
  const query = `Get-Command -ListImported ${name}\\Invoke-AgentoCProbe`;
  assert.equal((await inspect(query, { executable: shell })).decision, 'review');
  execFileSync(shell, ['-NoProfile', '-NonInteractive', '-Command', `${query} | Out-Null`], { env, windowsHide: true });
  await access(marker);
  const pipedName = `${name}Piped`;
  const pipedDir = path.join(modules, pipedName);
  const pipedMarker = path.join(root, `module-piped-${index}.txt`);
  await mkdir(pipedDir);
  await writeFile(path.join(pipedDir, `${pipedName}.psm1`), `Set-Content -LiteralPath '${pipedMarker.replaceAll("'", "''")}' -Value loaded\nfunction Invoke-AgentoCProbe { 'fixture' }\nExport-ModuleMember -Function Invoke-AgentoCProbe\n`);
  const pipedQuery = `'${pipedName}\\Invoke-AgentoCProbe' | Get-Command -ListImported`;
  assert.equal((await inspect(pipedQuery, { executable: shell })).decision, 'review');
  execFileSync(shell, ['-NoProfile', '-NonInteractive', '-Command', `${pipedQuery} | Out-Null`], { env, windowsHide: true });
  await access(pipedMarker);
  const unqualifiedName = `${name}Unqualified`;
  const unqualifiedDir = path.join(modules, unqualifiedName);
  const unqualifiedMarker = path.join(root, `module-unqualified-${index}.txt`);
  const unqualifiedFunction = `Invoke-AgentoCUnqualified${index}`;
  await mkdir(unqualifiedDir);
  await writeFile(path.join(unqualifiedDir, `${unqualifiedName}.psm1`), `Set-Content -LiteralPath '${unqualifiedMarker.replaceAll("'", "''")}' -Value loaded\nfunction ${unqualifiedFunction} { 'fixture' }\nExport-ModuleMember -Function ${unqualifiedFunction}\n`);
  const unqualifiedQuery = `Get-Command -ListImported -Name ${unqualifiedFunction}`;
  assert.equal((await inspect(unqualifiedQuery, { executable: shell })).decision, 'review');
  execFileSync(shell, ['-NoProfile', '-NonInteractive', '-Command', `${unqualifiedQuery} | Out-Null`], { env, windowsHide: true });
  await access(unqualifiedMarker);
}
assert.equal((await inspect('Get-ChildItem -Path folder -Recurse')).decision, 'allow');
assert.equal((await inspect('Get-ChildItem | Select-Object -First 1')).decision, 'allow');
assert.equal((await inspect("'..\\protected' | Get-ChildItem")).decision, 'review');
assert.equal((await inspect("Get-ChildItem -Path folder -Filter '*.md'")).decision, 'allow');
assert.equal((await inspect("Get-ChildItem -Path folder -Filter '*.md' -Recurse")).decision, 'allow');
assert.equal((await inspect('Get-ChildItem -Path folder -File -Name')).decision, 'allow');
assert.equal((await inspect('Get-ChildItem -Path folder -Depth 1 -Directory')).decision, 'allow');
assert.equal((await inspect('Get-ChildItem -Path sensitive-folder -Depth 1 -File')).decision, 'review');
assert.equal((await inspect('Get-ChildItem -Path folder -Depth $env:depth')).decision, 'review');
assert.equal((await inspect("Get-ChildItem -Path sensitive-folder -Filter '*.md' -Recurse")).decision, 'review');
assert.equal((await inspect("Remove-Item -Path folder -Filter '*.md' -Recurse")).decision, 'review');
assert.equal((await inspect('Get-ChildItem -Path folder -Filter $env:filter')).decision, 'review');
assert.equal((await inspect('Get-ChildItem -Path ..\\outside-folder -Recurse')).decision, 'allow');
assert.equal((await inspect('Get-ChildItem -Path sensitive-folder -Recurse')).decision, 'review');
assert.equal((await inspect('Copy-Item -Path folder -Destination copied -Recurse')).decision, 'allow');
assert.equal((await inspect('Copy-Item -Path sensitive-folder -Destination copied -Recurse')).decision, 'review');
assert.equal((await inspect('Copy-Item -Path folder -Destination sensitive-folder -Recurse')).decision, 'allow');
assert.equal((await inspect('Copy-Item -Path folder -Destination existing-dest -Recurse')).decision, 'review');
result = await inspect('Move-Item -Path readme.txt -Destination result.txt');
assert.deepEqual(result.actions.map((a) => a.kind), ['delete', 'write']);
assert.equal(result.decision, 'allow');
result = await inspect('Remove-Item -LiteralPath folder -Recurse');
assert.equal(result.decision, 'review');
const wildcardDeletion = await analyzeWindowsPowerShell('Remove-Item -Path build\\* -Recurse -Force', context);
// Simulate a new sensitive entry arriving after inspection but before the
// approval decision; the original wildcard would expand again at execution.
await mkdir(path.join(workspace, 'build', '.ssh'));
await writeFile(path.join(workspace, 'build', '.ssh', 'late-key'), 'fixture');
assert.equal(decideWindowsPowerShellActions(wildcardDeletion).decision, 'review');
assert.equal(decideWindowsPowerShellActions(wildcardDeletion, { conservative: true }).decision, 'review');
assert.ok(wildcardDeletion.actions.every(action => action.requiresPinnedExecution));
assert.equal((await inspect('Remove-Item -Path build-sensitive\\* -Recurse -Force')).decision, 'review');
assert.equal((await inspect('Remove-Item -Path * -Recurse -Force')).decision, 'review');
assert.equal((await inspect('Remove-Item -Path ..\\outside-folder\\* -Recurse -Force')).decision, 'review');
assert.equal((await inspect('Remove-Item -Path build\\*.txt -Recurse -Force')).decision, 'review');
assert.equal((await inspect('Remove-Item -LiteralPath build\\* -Recurse -Force')).decision, 'review');
assert.equal((await inspect("Remove-Item -Path build\\* -Filter '*.txt' -Recurse")).decision, 'review');
result = await inspect('Remove-Item -LiteralPath .');
assert.equal(result.decision, 'review');
result = await inspect('Remove-Item -LiteralPath ..\\ordinary.txt');
assert.equal(result.decision, 'allow');
assert.equal(decideWindowsPowerShellActions(result, { conservative: true }).decision, 'review');
result = await inspect('Remove-Item -LiteralPath ..\\outside-folder');
assert.equal(result.decision, 'review');
result = await inspect('Move-Item -Path sensitive-folder -Destination moved');
assert.equal(result.decision, 'review');
result = await inspect('Set-Content -Path ..\\protected\\result.txt -Value hello');
assert.equal(result.decision, 'review');
result = await inspect('Get-Content $env:TEMP');
assert.equal(result.decision, 'review');
result = await inspect('ls . | Select-Object -First 1');
assert.equal(result.decision, 'allow');
assert.equal(result.actions[0].program, 'get-childitem');
for (const command of [
  'Get-ChildItem . | Select-Object Name,Length | Format-Table -AutoSize',
  'Get-ChildItem . | Select-Object -Property Name,Length | ft -AutoSize',
  'Get-ChildItem . | Sort-Object Name,Length | Format-Table Name,Length',
]) assert.equal((await inspect(command)).decision, 'allow', command);
const conditionalRead = `if (Test-Path -LiteralPath '${workspace.replaceAll("'", "''")}\\build') { Get-ChildItem -LiteralPath '${workspace.replaceAll("'", "''")}\\build' -Force | Select-Object Mode,LastWriteTime,Length,Name | Format-Table -AutoSize | Out-String } else { 'TARGET_MISSING' }`;
assert.equal((await inspect(conditionalRead)).decision, 'allow', 'read-only existence check and listing should not require approval');
for (const command of [
  'Get-Content readme.txt 2>&1 | Out-String',
  'Get-ChildItem . 3>&1 2>&1 | Out-String',
  "'status' 2>&1",
]) assert.equal((await inspect(command)).decision, 'allow', command);
for (const command of [
  'Get-Content readme.txt 2>&1 > ..\\protected\\result.txt',
  'Remove-Item ..\\outside-folder -Recurse 2>&1',
  'Unknown-Command 2>&1 | Out-String',
]) assert.equal((await inspect(command)).decision, 'review', command);
for (const command of [
  "if (Test-Path readme.txt) { Remove-Item readme.txt } else { 'missing' }",
  "if (Test-Path readme.txt) { Set-Content output.txt changed }",
  "if (Test-Path readme.txt) { 'text' > output.txt }",
]) assert.equal((await inspect(command)).decision, 'allow', command);
for (const command of [
  "if (Test-Path readme.txt) { Set-Content ..\\protected\\result.txt changed }",
  "if (Test-Path readme.txt) { Get-Content readme.txt } else { Remove-Item ..\\protected\\secret }",
  "if (Test-Path readme.txt) { Remove-Item folder -Recurse -Force }",
  "if (Test-Path readme.txt) { Get-Content readme.txt } else { Unknown-Command }",
  "if ($env:DO_DELETE) { Get-Content readme.txt }",
  "if (Test-Path readme.txt) { Get-Content ..\\protected\\secret }",
]) assert.equal((await inspect(command)).decision, 'review', command);
for (const command of [
  'Get-ChildItem . | Select-Object Name,$env:TEMP | Format-Table -AutoSize',
  'Get-ChildItem . | Select-Object @{Name="x";Expression={Remove-Item readme.txt}}',
  'Get-ChildItem . | Format-Table -GroupBy $env:TEMP',
  'Get-ChildItem ..\\protected | Select-Object Name,Length | ft -AutoSize',
]) assert.equal((await inspect(command)).decision, 'review', command);
result = await inspect('Get-Content readme.txt | Unknown-Command');
assert.equal(result.decision, 'review');
result = await inspect('New-Item -Path . -Name .env -ItemType File');
assert.equal(result.decision, 'review');
result = await inspect('New-Item -Path . -Name link -ItemType SymbolicLink -Value readme.txt');
assert.equal(result.decision, 'review');
assert.equal(decideWindowsPowerShellActions({ complete: true, actions: [{ kind: 'write', target: {}, workspace: false }] }, { conservative: true }).decision, 'review');
const rootDeletion = await analyzeWindowsFileChanges([{ path: workspace, kind: 'delete' }], context);
assert.equal(decideWindowsPowerShellActions(rootDeletion).decision, 'review');
const ordinaryDirectoryDeletion = await analyzeWindowsFileChanges([{ path: path.join(workspace, 'folder'), kind: 'delete' }], context);
await mkdir(path.join(workspace, 'folder', '.ssh'));
await writeFile(path.join(workspace, 'folder', '.ssh', 'late-key'), 'fixture');
assert.equal(decideWindowsPowerShellActions(ordinaryDirectoryDeletion).decision, 'review');
const outsideDirectoryRead = await analyzeWindowsFileChanges([{ path: path.join(root, 'outside-folder'), kind: 'read', recursive: true }], context);
assert.equal(decideWindowsPowerShellActions(outsideDirectoryRead).decision, 'allow');
const sensitiveDirectoryRead = await analyzeWindowsFileChanges([{ path: path.join(workspace, 'sensitive-folder'), kind: 'read', recursive: true }], context);
assert.equal(decideWindowsPowerShellActions(sensitiveDirectoryRead).decision, 'review');
const unknownChange = await analyzeWindowsFileChanges([{ path: path.join(workspace, 'readme.txt'), kind: 'unknown' }], context);
assert.equal(decideWindowsPowerShellActions(unknownChange).decision, 'review');

// Literal .NET file operations use the same path and link checks as cmdlets.
const psLiteral = value => `'${value.replaceAll("'", "''")}'`;
const ordinaryFile = psLiteral(path.join(workspace, 'readme.txt'));
const outsideFile = psLiteral(path.join(root, 'ordinary.txt'));
const protectedFile = psLiteral(path.join(root, 'protected', 'important.txt'));
for (const command of [
  `[System.IO.File]::ReadAllText(${ordinaryFile})`,
  `[System.IO.File]::WriteAllText(${ordinaryFile}, 'hello')`,
  `[System.IO.File]::WriteAllText(${ordinaryFile}, 'hello', [System.Text.Encoding]::UTF8)`,
  `[System.IO.File]::ReadAllText(${ordinaryFile}, [System.Text.Encoding]::Unicode)`,
  `[System.IO.File]::AppendAllText(${outsideFile}, 'hello')`,
  `[System.IO.File]::AppendAllText(${outsideFile}, 'hello', [System.Text.Encoding]::UTF8)`,
  `[System.IO.File]::Delete(${ordinaryFile})`,
]) assert.equal((await inspect(command)).decision, 'allow', command);
assert.equal((await inspect(`[System.IO.File]::WriteAllText(${protectedFile}, 'x')`)).decision, 'review');
assert.equal((await inspect(`[System.IO.File]::WriteAllText(${protectedFile}, 'x', [System.Text.Encoding]::UTF8)`)).decision, 'review');
assert.equal((await inspect(`[System.IO.File]::WriteAllText(${psLiteral(path.join(workspace, 'ordinary-link'))}, 'x')`)).decision, 'review');
assert.equal((await inspect(`[System.IO.File]::ReadAllText(${psLiteral(path.join(workspace, 'sensitive-folder', '.ssh', 'fixture-key'))})`)).decision, 'review');
assert.equal(decideWindowsPowerShellActions(await analyzeWindowsPowerShell(`[System.IO.File]::WriteAllText(${outsideFile}, 'x')`, context), { conservative: true }).decision, 'review');
for (const command of [
  `[System.IO.File]::WriteAllText('readme.txt', 'x')`,
  `[System.IO.File]::ReadAllText('C:relative.txt')`,
  `[System.IO.File]::WriteAllText($env:TEMP, 'x')`,
  `[System.IO.File]::WriteAllText(${ordinaryFile}, (Get-Date).ToString())`,
  `[System.IO.File]::WriteAllText(${ordinaryFile}, 'x', [System.Text.Encoding]::GetEncoding(65001))`,
  `[System.IO.File]::WriteAllText(${ordinaryFile}, 'x', $encoding)`,
  `[System.IO.Directory]::Delete(${psLiteral(workspace)}, $true)`,
  `[System.IO.File]::WriteAllText(${ordinaryFile}, 'x'); Remove-Item -LiteralPath ${protectedFile}`,
]) assert.equal((await inspect(command)).decision, 'review', command);
for (const riskMode of ['recommended', 'full-auto']) {
  const state = { cwd: workspace, riskContext: context, riskContextValid: true, riskMode };
  const request = command => ({ kind: 'command', providerMethod: 'can_use_tool', params: { tool_name: 'PowerShell', input: { command } } });
  assert.equal((await decideWindowsApproval(request(`Get-Content -LiteralPath ${ordinaryFile} 2>&1 | Out-String`), state)).decision, 'auto-allow', `${riskMode}: merge safe output streams`);
  assert.equal((await decideWindowsApproval(request(`Get-Content -LiteralPath ${ordinaryFile} 2>&1 > ${protectedFile}`), state)).decision, 'prompt', `${riskMode}: protected output remains gated`);
  assert.equal((await decideWindowsApproval(request(`[System.IO.File]::WriteAllText(${outsideFile}, 'x')`), state)).decision, 'auto-allow');
  assert.equal((await decideWindowsApproval(request(`[System.IO.File]::WriteAllText(${outsideFile}, 'x', [System.Text.Encoding]::UTF8)`), state)).decision, 'auto-allow');
  assert.equal((await decideWindowsApproval(request(`[System.IO.File]::WriteAllText(${protectedFile}, 'x')`), state)).decision, 'prompt');
}
if (process.env.AGENTOC_TEST_PWSH) {
  const modern = await analyzeWindowsPowerShell(`[System.IO.File]::WriteAllText(${ordinaryFile}, 'hello')`, context, { executable: process.env.AGENTOC_TEST_PWSH });
  assert.equal(decideWindowsPowerShellActions(modern).decision, 'allow');
  const modernProtected = await analyzeWindowsPowerShell(`[System.IO.File]::WriteAllText(${protectedFile}, 'hello')`, context, { executable: process.env.AGENTOC_TEST_PWSH });
  assert.equal(decideWindowsPowerShellActions(modernProtected).decision, 'review');
  const utf8Target = path.join(workspace, 'unicode-编码.txt');
  const utf8Command = `[System.IO.File]::WriteAllText(${psLiteral(utf8Target)}, '中文', [System.Text.Encoding]::UTF8)`;
  for (const shell of [resolveWindowsSystemPaths().powershell, process.env.AGENTOC_TEST_PWSH]) {
    const encoded = await analyzeWindowsPowerShell(utf8Command, context, { executable: shell });
    assert.equal(decideWindowsPowerShellActions(encoded).decision, 'allow');
    execFileSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', utf8Command], { windowsHide: true });
    assert.equal((await readFile(utf8Target, 'utf8')).replace(/^\uFEFF/, ''), '中文');
  }
}
await rm(root, { recursive: true, force: true });
console.log('windows-powershell-actions: native AST and file policy checks passed');
