import assert from 'node:assert/strict';
import { buildWindowsCliReadBridge } from '../chat/windows-cli-read-bridge.mjs';

if (process.platform !== 'win32') { console.log('windows-cli-read-bridge: skipped (requires Windows)'); process.exit(0); }
const state = { turnActive: true, riskContextValid: true, sessionControlReadAvailable: true, sessionControlReadRunId: 'fixture-run', riskMode: 'recommended',
  windowsManagedActionChannel: true, windowsManagedActionBinding: { runId: 'fixture-run' } };
const helperPath = 'C:\\Program Files\\AgentoC\\bin\\agentoc-cli-read-bridge.exe';
const inspect = async () => ({ isFile: () => true, isSymbolicLink: () => false });
const request = command => ({ providerMethod: 'can_use_tool', params: { tool_name: 'PowerShell', input: { command } } });
const bridge = (command, overrides = {}) => buildWindowsCliReadBridge({ approval: request(command), state, helperPath, port: 7690, runId: 'fixture-run', ...overrides }, { inspect });
for (const riskMode of ['recommended', 'full-auto']) {
  const result = await bridge('agentoc trigger list --json 2>&1 | Out-String', { state: { ...state, riskMode } });
  assert.equal(result?.updatedCommand, "& 'C:\\Program Files\\AgentoC\\bin\\agentoc-cli-read-bridge.exe' trigger-list 'http://127.0.0.1:7690' --json");
  for (const suffix of ['--json', '--session $env:AGENTOC_SESSION_ID --json', '--source-session $env:AGENTOC_SESSION_ID --json']) {
    const fallback = await bridge(`node "$env:AGENTOC_PROJECT_ROOT/cli.js" trigger list ${suffix} | Out-String`, { state: { ...state, riskMode, windowsManagedActionChannel: false, windowsManagedActionBinding: null } });
    assert.equal(fallback?.updatedCommand, "& 'C:\\Program Files\\AgentoC\\bin\\agentoc-cli-read-bridge.exe' trigger-list 'http://127.0.0.1:7690' --json", suffix);
  }
  const help = await bridge('node "$env:AGENTOC_PROJECT_ROOT/cli.js" trigger list --help | Out-String', { state: { ...state, riskMode } });
  assert.equal(help?.updatedCommand, "& 'C:\\Program Files\\AgentoC\\bin\\agentoc-cli-read-bridge.exe' trigger-help 'http://127.0.0.1:7690'");
}
assert.ok(await bridge('agentoc trigger list'));
for (const command of [
  'agentoc trigger delete x', 'agentoc trigger list --base-url http://attacker',
  'agentoc trigger list --json; Remove-Item secret', 'agentoc trigger list --json > output.txt',
  'agentoc trigger list --json | Out-String; Write-Output extra',
  'agentoc trigger list --json | Out-String -Stream', 'agentoc trigger list $env:EVIL',
  'agentoc trigger list --json | Out-String > output.txt',
  'agentoc trigger list --json; Out-String', 'agentoc trigger list --json 2>&1 3>&1',
  'agentoc trigger list --json --json', 'agentoc trigger list --session other',
  'node "$env:AGENTOC_PROJECT_ROOT/cli.js" trigger delete x',
  'node "$env:AGENTOC_PROJECT_ROOT/cli.js" trigger list --session $env:OTHER --json',
  'node "$env:AGENTOC_PROJECT_ROOT/cli.js" trigger list --session other --json',
  'node "$env:AGENTOC_PROJECT_ROOT/cli.js" trigger list --json; Remove-Item secret',
  'node "$env:AGENTOC_PROJECT_ROOT/cli.js" trigger list --json | Out-String > secret',
  'node "$(Invoke-Expression evil)/cli.js" trigger list --json',
  'node "$env:AGENTOC_PROJECT_ROOT/other.js" trigger list --json',
]) assert.equal(await bridge(command), null, command);
assert.equal(await bridge('agentoc trigger list', { state: { ...state, riskMode: 'conservative-auto' } }), null);
assert.equal(await bridge('agentoc trigger list', { state: { ...state, turnActive: false } }), null);
assert.equal(await bridge('agentoc trigger list', { state: { ...state, sessionControlReadAvailable: false } }), null);
assert.equal(await bridge('agentoc trigger list', { state: { ...state, sessionControlReadRunId: 'different-run' } }), null);
assert.equal(await bridge('agentoc trigger list', { runId: 'different-run' }), null);
assert.equal(await bridge('agentoc trigger list', { state: { ...state, interactionMode: 'plan' } }), null);
assert.equal(await bridge('agentoc trigger list', { port: 0 }), null);
const privileged = request('agentoc trigger list'); privileged.params.additionalPermissions = { network: true };
assert.equal(await buildWindowsCliReadBridge({ approval: privileged, state, helperPath, port: 7690, runId: 'fixture-run' }, { inspect }), null);
const escape = request('agentoc trigger list'); escape.params.input.dangerouslyDisableSandbox = true;
assert.equal(await buildWindowsCliReadBridge({ approval: escape, state, helperPath, port: 7690, runId: 'fixture-run' }, { inspect }), null);
console.log('windows-cli-read-bridge: native AST and policy boundary checks passed');
