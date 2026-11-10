import assert from 'node:assert/strict';
import { access, link, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { analyzeWindowsFileChanges, analyzeWindowsPowerShell, decideWindowsPowerShellActions } from '../chat/windows-powershell-actions.mjs';
import { decideWindowsApproval } from '../chat/windows-approval-gate.mjs';
import { resolveWindowsSystemPaths } from '../chat/windows-system-paths.mjs';

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
const context = { cwd: workspace, trustedWorkspaceRoot: workspace, protectedRoots: [path.join(root, 'protected')] };
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
for (const command of ['git status --short', 'git diff --stat', 'git branch --show-current']) {
  assert.equal((await inspect(command)).decision, 'allow', `${command} is a read-only Git query`);
}
for (const command of ['git add .', 'git commit -m test', 'git diff', 'git status --ignored=matching']) {
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
