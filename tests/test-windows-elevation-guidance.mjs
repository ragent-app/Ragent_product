import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { needsWindowsElevationGuidance, buildCodexWindowsElevationGuidance, shouldInstallWindowsElevationHook, isWindowsAdministrativeArgv } from '../chat/windows-elevation-guidance.mjs';

const hookContext = { platform: 'win32', runtimeFamily: 'codex-app-server-json' };
assert.equal(shouldInstallWindowsElevationHook(hookContext), true);
for (const overrides of [{ platform: 'linux' }, { runtimeFamily: 'claude' }, { interactionMode: 'plan' },
  { permissionMode: 'plan' }, { workbenchPolicy: true }, { workbenchPolicy: { schemaVersion: 1 } }]) {
  assert.equal(shouldInstallWindowsElevationHook({ ...hookContext, ...overrides }), false);
}

if (process.platform === 'win32') {
  for (const command of ['runas /user:admin cmd.exe', 'gsudo.exe whoami', 'sudo whoami',
    'Start-Process notepad.exe -Verb RunAs', 'Start-Process -Verb:RunAs notepad.exe',
    "Write-Output hello; Start-Process notepad.exe -Verb RunAs", 'New-LocalUser -Name fixture -WhatIf',
    'Remove-LocalGroupMember -Group Administrators -Member fixture -WhatIf', 'New-Service -Name fixture -WhatIf',
    'sc.exe config fixture start= demand', 'net.exe user fixture /add', 'Restart-Service -Name fixture',
    'sc.exe start fixture', 'sc.exe stop fixture', 'net start fixture', 'net.exe stop fixture',
    "& 'C:\\Windows\\System32\\sc.exe' start fixture", 'sc.exe start $env:SERVICE_NAME',
    'New-NetFirewallRule -DisplayName fixture -WhatIf', 'Disable-NetFirewallRule -DisplayName fixture -WhatIf',
    'Set-NetFirewallProfile -Enabled True -WhatIf', 'Add-MpPreference -ExclusionPath fixture -WhatIf',
    "reg.exe add 'HKLM\\Software\\AgentoCFixture' /v Fixture /d 1", "reg delete 'HKEY_LOCAL_MACHINE\\Software\\Fixture' /v Value",
    "reg.exe copy 'HKCU\\Software\\Fixture' 'HKLM\\Software\\Fixture'",
    "Set-ItemProperty -LiteralPath 'HKLM:\\Software\\Fixture' -Name Value -Value 1",
    "New-Item 'Registry::HKEY_LOCAL_MACHINE\\Software\\Fixture' -WhatIf"]) {
    assert.equal(await needsWindowsElevationGuidance(command), true, command);
  }
  for (const command of ["Write-Output 'sudo whoami'", 'winget install Git.Git', 'Start-Process notepad.exe',
    'sudo --version', "Write-Output 'Start-Process -Verb RunAs'", 'Get-LocalUser', 'Get-Service',
    'sc.exe query fixture', 'sc config fixture', 'sc.exe start', 'net.exe start', 'net.exe user fixture', "Write-Output 'New-LocalUser -Name fixture'",
    'Get-NetFirewallRule', 'Get-NetFirewallProfile', 'Get-MpPreference', "Write-Output 'Set-MpPreference'",
    "reg.exe query 'HKLM\\Software\\Fixture'", "reg.exe add 'HKCU\\Software\\Fixture' /v Value /d 1",
    "reg.exe add 'HKCU\\Software\\Fixture' /v Value /d 'HKLM\\Software\\Text'",
    "reg.exe copy 'HKLM\\Software\\Fixture' 'HKCU\\Software\\Fixture'", "Write-Output 'reg.exe add HKLM\\Software\\Fixture'",
    "Get-ItemProperty 'HKLM:\\Software\\Fixture'", "Set-ItemProperty 'HKCU:\\Software\\Fixture' -Name Value -Value 'HKLM:\\Text'"]) {
    assert.equal(await needsWindowsElevationGuidance(command), false, command);
  }
  assert.equal(await needsWindowsElevationGuidance('sudo whoami', 'Bash'), true);
  assert.equal(await needsWindowsElevationGuidance("'C:/Windows/System32/sc.exe' stop fixture", 'Bash'), true);
  assert.equal(await needsWindowsElevationGuidance("reg.exe add 'HKLM\\Software\\Fixture' /v Value /d 1", 'Bash'), true);
  assert.equal(await needsWindowsElevationGuidance("reg.exe query 'HKLM\\Software\\Fixture'", 'Bash'), false);
  assert.equal(isWindowsAdministrativeArgv(['reg.exe', 'add', 'HKLM\\Software\\Fixture']), true);
  assert.equal(isWindowsAdministrativeArgv(['winget', 'install', '--id', '7zip.7zip', '--exact', '--scope', 'machine']), true);
  assert.equal(isWindowsAdministrativeArgv(['winget.exe', 'upgrade', '--id', '7zip.7zip', '--scope=machine']), true);
  assert.equal(isWindowsAdministrativeArgv(['winget', 'install', '--id', '7zip.7zip', '--scope', 'user']), false);
  assert.equal(isWindowsAdministrativeArgv(['winget', 'list', '--scope', 'machine']), false);
  assert.equal(isWindowsAdministrativeArgv(['reg.exe', 'query', 'HKLM\\Software\\Fixture']), false);
  assert.equal(isWindowsAdministrativeArgv(['Set-ItemProperty', '-LiteralPath', 'HKLM:\\Software\\Fixture']), true);
  assert.equal(isWindowsAdministrativeArgv(['Set-ItemProperty', 'HKCU:\\Software\\Fixture', '-Value', 'HKLM:\\Text']), false);
  assert.equal(isWindowsAdministrativeArgv(['sc.exe', 'start', 'fixture']), true);
  assert.equal(isWindowsAdministrativeArgv(['net.exe', 'stop', 'fixture']), true);
  assert.equal(isWindowsAdministrativeArgv(['net.exe', 'start']), false);
  assert.equal(isWindowsAdministrativeArgv(['sc.exe', 'query', 'fixture']), false);
  assert.equal(await needsWindowsElevationGuidance("echo 'sudo whoami'", 'Bash'), false);
  const bashQuote = value => `'${value.replaceAll("'", `'"'"'`)}'`;
  const systemPowerShell = path.join(process.env.SystemRoot || process.env.WINDIR, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const wrapper = script => `${bashQuote(systemPowerShell)} -NoProfile -NonInteractive -Command ${bashQuote(script)}`;
  for (const script of ['Start-Service -Name fixture', 'Stop-Service -Name fixture', 'New-LocalUser -Name fixture', 'sc.exe start fixture', 'net.exe stop fixture']) {
    assert.equal(await needsWindowsElevationGuidance(wrapper(script), 'Bash'), true, script);
  }
  assert.equal(await needsWindowsElevationGuidance(`powershell.exe -NoProfile -Command ${bashQuote('Start-Service -Name fixture')}`, 'Bash'), true);
  for (const script of ['Get-Service -Name fixture', 'sc.exe query fixture', "Write-Output 'Start-Service'"]) {
    assert.equal(await needsWindowsElevationGuidance(wrapper(script), 'Bash'), false, script);
  }
  assert.equal(await needsWindowsElevationGuidance(`${wrapper('Start-Service -Name fixture')}; echo extra`, 'Bash'), false);
  const event = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'test', tool_input: { command: 'runas /user:admin cmd.exe' } };
  const channel = { endpoint: 'endpoint', token: 'token', sessionId: 'session', runId: 'run', turnId: 'turn' };
  const managed = await buildCodexWindowsElevationGuidance({ event, channel });
  assert.equal(managed.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(managed.hookSpecificOutput.permissionDecisionReason, /ragent_request_actions/);
  assert.match(managed.hookSpecificOutput.permissionDecisionReason, /Start-Service or Stop-Service/);
  assert.match((await buildCodexWindowsElevationGuidance({ event })).hookSpecificOutput.permissionDecisionReason, /unavailable/);
  assert.deepEqual(await buildCodexWindowsElevationGuidance({ event: { ...event, hook_event_name: 'PostToolUse' }, channel }), {});
  const hook = spawnSync(process.execPath, ['scripts/agentoc-codex-windows-install-hook.mjs'], { input: JSON.stringify(event), encoding: 'utf8',
    env: { ...process.env, AGENTOC_APPROVED_ACTIONS_ENDPOINT: channel.endpoint, AGENTOC_APPROVED_ACTIONS_TOKEN: channel.token,
      AGENTOC_APPROVED_ACTIONS_SESSION_ID: channel.sessionId, AGENTOC_APPROVED_ACTIONS_RUN_ID: channel.runId,
      AGENTOC_APPROVED_ACTIONS_TURN_ID: channel.turnId, AGENTOC_WINDOWS_SAFE_DELETE_CONTEXT: '' } });
  assert.equal(hook.status, 0, hook.stderr);
  assert.match(JSON.parse(hook.stdout).hookSpecificOutput.permissionDecisionReason, /ragent_request_actions/);
  const disabledEnv = { ...process.env, AGENTOC_WINDOWS_INSTALL_BRIDGE_DISABLED: '1', AGENTOC_WINDOWS_SAFE_DELETE_CONTEXT: '',
    AGENTOC_APPROVED_ACTIONS_ENDPOINT: channel.endpoint, AGENTOC_APPROVED_ACTIONS_TOKEN: channel.token,
    AGENTOC_APPROVED_ACTIONS_SESSION_ID: channel.sessionId, AGENTOC_APPROVED_ACTIONS_RUN_ID: channel.runId,
    AGENTOC_APPROVED_ACTIONS_TURN_ID: channel.turnId };
  const disabledInstall = spawnSync(process.execPath, ['scripts/agentoc-codex-windows-install-hook.mjs'],
    { input: JSON.stringify({ ...event, tool_input: { command: 'winget install Git.Git' } }), encoding: 'utf8', env: disabledEnv });
  assert.equal(disabledInstall.status, 0, disabledInstall.stderr);
  assert.deepEqual(JSON.parse(disabledInstall.stdout), {});
  const disabledElevation = spawnSync(process.execPath, ['scripts/agentoc-codex-windows-install-hook.mjs'],
    { input: JSON.stringify(event), encoding: 'utf8', env: disabledEnv });
  assert.match(JSON.parse(disabledElevation.stdout).hookSpecificOutput.permissionDecisionReason, /ragent_request_actions/);

  const root = await mkdtemp(path.join(os.tmpdir(), 'agentoc-elevation-guidance-test-'));
  try {
    const workspace = path.join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    Object.assign(process.env, { AGENTOC_INSTANCE_ROOT: root, AGENTOC_CONFIG_DIR: path.join(root, 'config'),
      AGENTOC_WORK_ROOT_DIR: workspace, AGENTOC_MEMORY_DIR: path.join(root, 'memory'),
      AGENTOC_PROVIDER_HOMES_DIR: path.join(root, 'provider-homes'), AGENTOC_RUN_SPOOL_DIR: path.join(root, 'runs') });
    const { createRun } = await import('../chat/runs.mjs');
    const { trackClaudeBidiApprovalRequest } = await import('../chat/runner-sidecar.mjs');
    const run = await createRun({ status: { sessionId: 'session', requestId: 'request', state: 'accepted', tool: 'claude' },
      manifest: { sessionId: 'session', requestId: 'request', folder: workspace, tool: 'claude', prompt: 'fixture', options: {} } });
    const sent = [];
    const state = { turnActive: true, windowsManagedActionChannel: true, windowsManagedActionBinding: { ...channel, runId: run.id },
      pendingApprovals: new Map(), autoApprovedMcpRequestIds: new Set(), riskMode: 'recommended' };
    const proc = { stdin: { writable: true, write(line) { sent.push(JSON.parse(line)); return true; } } };
    await trackClaudeBidiApprovalRequest(run.id, state, { type: 'control_request', request_id: 'direct-elevation',
      request: { subtype: 'can_use_tool', tool_name: 'PowerShell', input: { command: 'Start-Process notepad -Verb RunAs' } } }, proc);
    assert.equal(sent[0].response.response.behavior, 'deny');
    assert.match(sent[0].response.response.message, /ragent_request_actions/);
    assert.equal(state.pendingApprovals.size, 0);
    await trackClaudeBidiApprovalRequest(run.id, state, { type: 'control_request', request_id: 'direct-admin',
      request: { subtype: 'can_use_tool', tool_name: 'PowerShell', input: { command: 'New-LocalUser -Name agentoc-fixture -WhatIf' } } }, proc);
    assert.equal(sent[1].response.response.behavior, 'deny');
    assert.match(sent[1].response.response.message, /ragent_request_actions/);
    await trackClaudeBidiApprovalRequest(run.id, state, { type: 'control_request', request_id: 'direct-service',
      request: { subtype: 'can_use_tool', tool_name: 'PowerShell', input: { command: 'sc.exe start agentoc-fixture' } } }, proc);
    assert.equal(sent[2].response.response.behavior, 'deny');
    assert.match(sent[2].response.response.message, /Start-Service or Stop-Service/);
    await trackClaudeBidiApprovalRequest(run.id, state, { type: 'control_request', request_id: 'direct-firewall',
      request: { subtype: 'can_use_tool', tool_name: 'PowerShell', input: { command: 'New-NetFirewallRule -DisplayName fixture -WhatIf' } } }, proc);
    assert.equal(sent[3].response.response.behavior, 'deny');
    assert.match(sent[3].response.response.message, /ragent_request_actions/);
    assert.equal(state.pendingApprovals.size, 0);
    await trackClaudeBidiApprovalRequest(run.id, state, { type: 'control_request', request_id: 'direct-registry',
      request: { subtype: 'can_use_tool', tool_name: 'PowerShell', input: { command: "reg.exe add 'HKLM\\Software\\Fixture' /v Value /d 1" } } }, proc);
    assert.equal(sent[4].response.response.behavior, 'deny');
    assert.match(sent[4].response.response.message, /ragent_request_actions/);
    assert.equal(state.pendingApprovals.size, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
}
console.log('Windows managed elevation guidance passed');
