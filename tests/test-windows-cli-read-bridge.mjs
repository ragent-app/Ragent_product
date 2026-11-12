import assert from 'node:assert/strict';
import { buildWindowsCliAssetBridge, buildWindowsCliReadBridge } from '../chat/windows-cli-read-bridge.mjs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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
  const renamedFallback = await bridge('node "$env:RAGENT_PROJECT_ROOT/cli.js" trigger list --session $env:RAGENT_SESSION_ID --json | Out-String', { state: { ...state, riskMode } });
  assert.ok(renamedFallback?.updatedCommand.includes(' trigger-list '));
  const help = await bridge('node "$env:AGENTOC_PROJECT_ROOT/cli.js" trigger list --help | Out-String', { state: { ...state, riskMode } });
  assert.equal(help?.updatedCommand, "& 'C:\\Program Files\\AgentoC\\bin\\agentoc-cli-read-bridge.exe' trigger-help 'http://127.0.0.1:7690'");
}
assert.ok(await bridge('agentoc trigger list'));
assert.ok(await bridge('ragent trigger list --json'));
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
const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'agentoc-asset-bridge-'));
try {
  const file = path.join(fixtureRoot, 'fixture.txt'); await writeFile(file, 'fixture');
  const workspace = path.join(fixtureRoot, 'workspace'); await mkdir(workspace);
  await mkdir(path.join(fixtureRoot, '.ssh')); await writeFile(path.join(fixtureRoot, '.ssh', 'key'), 'fixture');
  const assetState = { ...state, cwd: workspace, riskContext: { platform: 'win32', cwd: workspace, trustedWorkspaceRoot: workspace, protectedRoots: [] } };
  const assetRequest = command => ({ providerMethod: 'can_use_tool', params: { tool_name: 'Bash', input: { command } } });
  const route = '"/api/sessions/$AGENTOC_SESSION_ID/assets"';
  const body = JSON.stringify({ localPath: file, mimeType: 'text/plain', originalName: 'fixture.txt', text: 'fixture' });
  const asset = (command, overrides = {}) => buildWindowsCliAssetBridge({ approval: assetRequest(command), state: assetState, helperPath, port: 7690, runId: 'fixture-run', ...overrides }, { inspect });
  for (const riskMode of ['recommended', 'full-auto']) for (const [prefix, target] of [['agentoc', route], ['ragent', '/api/sessions/$AGENTOC_SESSION_ID/assets'], ['node "$AGENTOC_PROJECT_ROOT/cli.js"', route], ['MSYS_NO_PATHCONV=1 node "$AGENTOC_PROJECT_ROOT/cli.js"', route]]) {
    const result = await asset(`${prefix} api POST ${target} --body '${body}'`, { state: { ...assetState, riskMode } });
    assert.ok(result?.updatedCommand.includes(' asset-publish '), `${riskMode}: ${prefix}`);
    assert.deepEqual(JSON.parse(Buffer.from(result.updatedCommand.match(/'([A-Za-z0-9_-]+)'$/)[1], 'base64url').toString()), JSON.parse(body));
  }
  assert.ok((await asset(`ragent api POST "/api/sessions/$RAGENT_SESSION_ID/assets" --body '${body}'`))?.updatedCommand.includes(' asset-publish '));
  for (const command of [
    `agentoc api POST "/api/sessions/other/assets" --body '${body}'`,
    `agentoc api POST '__SESSION_ASSETS__' --body '${body}'`,
    `agentoc api POST "/api/sessions/\${AGENTOC_SESSION_ID/assets" --body '${body}'`,
    `agentoc api POST ${route} --body '${body}' --base-url http://attacker`,
    `agentoc api POST ${route} --body '${body}' ; echo bad`,
    `agentoc api POST ${route} --body '${JSON.stringify({ localPath: path.join(fixtureRoot, '.ssh', 'key') })}'`,
    `agentoc api POST ${route} --body '${JSON.stringify({ localPath: file, extra: 'bad' })}'`,
    `agentoc api POST ${route} --body '${JSON.stringify({ localPath: 'relative.txt' })}'`,
    `agentoc api POST ${route} --body '${JSON.stringify({ localPath: path.join(fixtureRoot, 'missing.txt') })}'`,
    `agentoc api POST ${route} --body '${JSON.stringify({ localPath: file, renderAs: 'html' })}'`,
    `agentoc api DELETE ${route} --body '${body}'`,
    `agentoc api POST ${route} --body-file '${file}'`,
    `agentoc api POST ${route} --body '${body}' > output.txt`,
    `NODE_OPTIONS=evil node "$AGENTOC_PROJECT_ROOT/cli.js" api POST ${route} --body '${body}'`,
  ]) assert.equal(await asset(command), null, command);
  assert.equal(await asset(`agentoc api POST ${route} --body '${body}'`, { state: { ...assetState, sessionControlReadAvailable: false } }), null);
  assert.equal(await asset(`agentoc api POST ${route} --body '${body}'`, { state: { ...assetState, interactionMode: 'plan' } }), null);
  assert.equal(await asset(`agentoc api POST ${route} --body '${body}'`, { runId: 'another-run' }), null);
  const network = assetRequest(`agentoc api POST ${route} --body '${body}'`); network.params.additionalPermissions = { network: true };
  assert.equal(await buildWindowsCliAssetBridge({ approval: network, state: assetState, helperPath, port: 7690, runId: 'fixture-run' }, { inspect }), null);
} finally { await rm(fixtureRoot, { recursive: true, force: true }); }
console.log('windows-cli-read-bridge: native AST and policy boundary checks passed');
