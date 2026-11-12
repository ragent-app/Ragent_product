import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { access, mkdir, mkdtemp, readFile, rm, rmdir, unlink, writeFile, copyFile, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync } from 'node:crypto';
import { decodeCodexShlexArgv, decideWindowsApproval, readWindowsPowerShellInvocation } from '../chat/windows-approval-gate.mjs';
import { buildClaudeWindowsInstallBridge } from '../chat/windows-auto-install-bridge.mjs';
import { createCodexManagedHookSetup } from '../chat/codex-managed-hook-setup.mjs';
import { prepareManagedMcpOverlay } from '../chat/approved-action-mcp-overlay.mjs';
import { buildWindowsSafeDeleteBridge } from '../chat/windows-safe-delete-bridge.mjs';
import { buildWindowsCliAssetBridge } from '../chat/windows-cli-read-bridge.mjs';
import { buildWindowsSelectStringGlobBridge } from '../chat/windows-ripgrep-bridge.mjs';
import { buildCodexAppServerProjectTrustArgs } from '../chat/adapters/codex-app-server.mjs';
import { validateCodexAppServerApprovalContext } from '../chat/codex-app-server-protocol.mjs';
if (process.platform !== 'win32' || process.env.AGENTOC_RUN_CODEX_LOCAL_GATE !== '1') {
  console.log('codex-windows-local-gate: skipped (opt-in Windows integration test)');
  process.exit(0);
}
if (!process.env.AGENTOC_TEST_CODEX_BINARY || !path.isAbsolute(process.env.AGENTOC_TEST_CODEX_BINARY)) throw new Error('absolute test Codex binary path required');
const home = await mkdtemp(path.join(tmpdir(), process.env.AGENTOC_QA_CODEX_UNICODE === '1'
  ? 'agentoc-codex-local-gate-项目 空格-' : 'agentoc-codex-local-gate-'));
const managedAsset = process.env.AGENTOC_QA_HOOK_MANAGED_ASSET === '1';
if (managedAsset) process.env.CHAT_PORT = '18669';
const alternateCwd = path.join(home, 'alternate-workdir');
if (process.env.AGENTOC_QA_HOOK_WORKDIR === '1' || process.env.AGENTOC_QA_HOOK_MANAGED_DELETE === '1') await mkdir(alternateCwd);
process.env.AGENTOC_INSTANCE_ROOT = path.join(home, 'instance');
process.env.AGENTOC_CONFIG_DIR = path.join(home, 'instance', 'config');
process.env.AGENTOC_WORK_ROOT_DIR = path.join(home, 'instance', 'workspace');
process.env.AGENTOC_MEMORY_DIR = path.join(home, 'instance', 'memory');
process.env.AGENTOC_PROVIDER_HOMES_DIR = path.join(home, 'instance', 'provider-homes');
process.env.AGENTOC_RUN_SPOOL_DIR = path.join(home, 'instance', 'data', 'chat-runs');
const { appendRunSpoolRecord, createRun, getRun } = await import('../chat/runs.mjs');
const { flushCodexAppServerApprovalResponses, trackCodexAppServerApprovalRequest, handleCodexAppServerInitializeResponse } = await import('../chat/runner-sidecar.mjs');
const phoneQueueCase = process.env.AGENTOC_QA_SAMSUNG_CODEX_QUEUE === '1';
const phoneSessionId = 'samsung-fixture';
const { handleSessionMainRoutes } = phoneQueueCase ? await import('../chat/router-session-main-routes.mjs') : {};
const { getHistory } = phoneQueueCase ? await import('../chat/session-manager.mjs') : {};
const { withSessionsMetaMutation, mutateSessionMeta } = phoneQueueCase ? await import('../chat/session-meta-store.mjs') : {};
let phoneApproval = null; let phoneState = null; let phoneQueued = false;
const riskMode = ['full-auto', 'conservative-auto'].includes(process.env.AGENTOC_QA_MODE) ? process.env.AGENTOC_QA_MODE : 'recommended';
const boundContext = process.env.AGENTOC_QA_BOUND_CONTEXT === '1'
  ? await (await import('./fixtures/windows-admitted-context.mjs')).admittedWindowsContext(home, 'fixture-session') : null;
const managedInstall = process.env.AGENTOC_QA_HOOK_MANAGED_INSTALL === '1';
const managedElevation = process.env.AGENTOC_QA_HOOK_ELEVATION === '1';
const pinnedIdentity = managedInstall && process.env.AGENTOC_QA_PIN_INSTALL_KEY === '1'
  ? { kid: 'fixture-key', publicKey: generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString() } : null;
const packageCommand = process.env.AGENTOC_QA_INSTALL_EQUALS === '1'
  ? `winget install --id=Vendor.App --source=winget --scope=${process.env.AGENTOC_QA_INSTALL_USER === '1' ? 'user' : 'machine'}`
  : process.env.AGENTOC_QA_INSTALL_FLAGS === '1'
  ? `winget install --id Vendor.App -e -h --disable-interactivity --scope ${process.env.AGENTOC_QA_INSTALL_USER === '1' ? 'user' : 'machine'}`
  : 'winget install Vendor.App';
const installCommand = process.env.AGENTOC_QA_HOOK_WRAPPED_INSTALL === '1'
  ? `agentoc-privileged --description "Install fixture" --category install -- ${packageCommand}`
  : packageCommand;
const managedDelete = process.env.AGENTOC_QA_HOOK_MANAGED_DELETE === '1';
const managedRipgrep = process.env.AGENTOC_QA_HOOK_MANAGED_RG === '1';
const managedGlob = process.env.AGENTOC_QA_HOOK_MANAGED_GLOB === '1';
const assetOutsideRoot = managedAsset ? await mkdtemp(path.join(tmpdir(), 'agentoc-codex-asset-outside-')) : '';
const assetFile = managedAsset ? path.join(assetOutsideRoot, 'fixture.txt') : '';
let assetHelper = '';
if (managedAsset) {
  const source = process.env.AGENTOC_TEST_INSTALLED_PAYLOAD, helper = process.env.AGENTOC_TEST_CLI_READ_BINARY;
  if (!path.isAbsolute(source || '') || !path.isAbsolute(helper || '')) throw new Error('absolute asset helper and payload required');
  await writeFile(assetFile, 'isolated asset fixture');
  const payload = path.join(home, 'asset-payload'); await mkdir(path.join(payload, 'bin'), { recursive: true });
  await Promise.all(['node.exe', 'cli.js', 'package.json'].map(file => copyFile(path.join(source, file), path.join(payload, file))));
  await cp(path.join(source, 'lib'), path.join(payload, 'lib'), { recursive: true });
  assetHelper = path.join(payload, 'bin', 'agentoc-cli-read-bridge.exe'); await copyFile(helper, assetHelper);
}
const rgFixture = path.join(home, 'rg-fixture');
const rgConfig = path.join(home, 'rg-config');
if (managedRipgrep) {
  await mkdir(rgFixture); await writeFile(path.join(rgFixture, 'ordinary-fixture.txt'), 'fixture');
  await writeFile(path.join(rgFixture, '.env'), 'fake-secret'); await writeFile(path.join(rgFixture, '.ignore'), '!.env\n'); await writeFile(rgConfig, '--hidden\n');
}
const fileCommand = process.env.AGENTOC_QA_FILE_COMMAND || '';
if (phoneQueueCase && (fileCommand !== 'uninstall' || riskMode !== 'recommended' || process.env.AGENTOC_QA_EXPECT_DECISION !== 'prompt')) throw new Error('phone queue fixture requires recommended uninstall review');
if (fileCommand && (!['rename', 'clear', 'dotnet', 'read-null', 'conditional-write', 'output-filters', 'where-filter', 'system-copy', 'select-string', 'git-status', 'git-diff', 'git-show', 'git-log-format', 'git-diff-file', 'git-c', 'uninstall'].includes(fileCommand) || managedDelete || managedInstall || (process.env.AGENTOC_QA_HOOK_REWRITE === '1' && !managedGlob) || process.env.AGENTOC_QA_SENSITIVE === '1')) throw new Error('invalid file command fixture mode');
if (managedGlob && (fileCommand !== 'select-string' || process.env.AGENTOC_QA_SEARCH_GLOB !== '1' || process.env.AGENTOC_QA_HOOK_REWRITE !== '1')) throw new Error('managed wildcard fixture requires a hooked wildcard search');
if (fileCommand === 'git-status' && process.env.AGENTOC_QA_EXPECT_DECISION !== 'auto-allow') throw new Error('read-only fixture must expect automatic approval');
if (fileCommand === 'uninstall' && process.env.AGENTOC_QA_EXPECT_DECISION !== 'prompt') throw new Error('uninstall classifier fixture must expect a user-review classification');
const outsideWrite = process.env.AGENTOC_QA_FILE_OUTSIDE === '1';
if (outsideWrite && fileCommand !== 'dotnet') throw new Error('outside-write fixture requires the fixed dotnet command');
const outsideWriteRoot = outsideWrite || fileCommand === 'select-string' ? await mkdtemp(path.join(tmpdir(), 'agentoc-codex-outside-write-')) : '';
const fileFixture = path.join(outsideWriteRoot || home, 'ordinary-fixture.txt');
if (fileCommand) await writeFile(fileFixture, 'fixture content');
if (fileCommand === 'git-c') { await mkdir(alternateCwd); execFileSync('git', ['init', '-q'], { cwd: alternateCwd, windowsHide: true }); await writeFile(path.join(alternateCwd, 'ordinary-fixture.txt'), 'fixture content'); }
if (['git-status', 'git-diff', 'git-show', 'git-log-format', 'git-diff-file'].includes(fileCommand)) execFileSync('git', ['init', '-q'], { cwd: home, windowsHide: true });
if (['git-show', 'git-log-format', 'git-diff-file'].includes(fileCommand)) {
  execFileSync('git', ['add', 'ordinary-fixture.txt'], { cwd: home, windowsHide: true });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'fixture'], { cwd: home, windowsHide: true });
  if (fileCommand === 'git-diff-file') await writeFile(fileFixture, 'changed fixture');
}
const safeFileCommand = fileCommand === 'rename'
  ? `Rename-Item -LiteralPath '${fileFixture.replace(/'/g, "''")}' -NewName renamed-fixture.txt`
  : fileCommand === 'read-null' ? `Get-Content -LiteralPath '${fileFixture.replace(/'/g, "''")}' 2>$null`
  : fileCommand === 'select-string' ? `Select-String ${process.env.AGENTOC_QA_SEARCH_GLOB === '1' ? '-Path' : '-LiteralPath'} '${(process.env.AGENTOC_QA_SEARCH_GLOB === '1' ? path.join(outsideWriteRoot, '*.txt') : fileFixture).replace(/'/g, "''")}' -Pattern 'fixture content'`
  : fileCommand === 'conditional-write' ? `if (Test-Path -LiteralPath '${fileFixture.replace(/'/g, "''")}') { Set-Content -LiteralPath '${fileFixture.replace(/'/g, "''")}' -Value 'changed fixture' } else { 'TARGET_MISSING' }`
  : fileCommand === 'output-filters' ? `Set-Content -LiteralPath '${fileFixture.replace(/'/g, "''")}' -Value 'changed fixture' | Out-Null; Get-Item -LiteralPath '${fileFixture.replace(/'/g, "''")}' | Format-List Name,Length | Out-String`
  : fileCommand === 'where-filter' ? `Get-ChildItem -LiteralPath '${home.replace(/'/g, "''")}' | Where-Object ${process.env.AGENTOC_QA_WHERE_SCRIPT === '2' ? "{ ($_.Name -like 'ordinary-*.txt') -and ($_.Length -gt 0) -and -not $_.PSIsContainer }" : process.env.AGENTOC_QA_WHERE_SCRIPT === '1' ? "{ $_.Name -like 'ordinary-*.txt' }" : "Name -like 'ordinary-*.txt'"} | Select-Object Name | Out-String`
  : fileCommand === 'system-copy' ? `Copy-Item -LiteralPath '${path.join(process.env.SystemRoot, 'win.ini').replace(/'/g, "''")}' -Destination '${fileFixture.replace(/'/g, "''")}' -Force`
  : fileCommand === 'uninstall' ? 'winget uninstall --id AgentoC.Nonexistent.Test.Fixture --exact'
  : fileCommand === 'git-status' ? 'git status --short'
  : fileCommand === 'git-diff' ? 'git diff'
  : fileCommand === 'git-show' ? 'git show --stat HEAD'
  : fileCommand === 'git-log-format' ? "git log -1 --format='%h %s'"
  : fileCommand === 'git-diff-file' ? 'git diff HEAD -- ordinary-fixture.txt'
  : fileCommand === 'git-c' ? `git -C '${alternateCwd.replace(/'/g, "''")}' status --short`
  : fileCommand === 'dotnet'
    ? `[System.IO.File]::WriteAllText('${fileFixture.replace(/'/g, "''")}', 'dotnet fixture'${process.env.AGENTOC_QA_DOTNET_ENCODING === '1' ? ', [System.Text.Encoding]::UTF8' : ''})`
    : `Clear-Content -LiteralPath '${fileFixture.replace(/'/g, "''")}'`;
const managedDeleteRelative = managedDelete && process.env.AGENTOC_QA_RELATIVE_DELETE === '1';
const dangerousRetry = managedDeleteRelative && process.env.AGENTOC_QA_RELATIVE_DANGEROUS === '1';
const safeDeleteBinary = process.env.AGENTOC_TEST_SAFE_DELETE_BINARY;
let outsideFixture = '';
if (managedDelete) {
  if (!safeDeleteBinary || !path.isAbsolute(safeDeleteBinary)) throw new Error('absolute safe deletion test helper required');
  await mkdir(path.join(home, 'build')); await writeFile(path.join(home, 'build', 'fixture.txt'), 'fixture');
  await mkdir(path.join(alternateCwd, 'build')); await writeFile(path.join(alternateCwd, 'build', 'keep.txt'), 'keep');
  if (managedDeleteRelative) { await mkdir(path.join(alternateCwd, 'delete-target')); await writeFile(path.join(alternateCwd, 'delete-target', 'fixture.txt'), 'fixture'); }
  if (dangerousRetry) { outsideFixture = await mkdtemp(path.join(tmpdir(), 'agentoc-delete-outside-')); await mkdir(path.join(outsideFixture, 'target')); await writeFile(path.join(outsideFixture, 'target', 'keep.txt'), 'keep'); }
}
const productionStartup = (managedInstall || managedDelete || managedElevation || managedRipgrep || managedAsset || managedGlob) && process.env.AGENTOC_QA_PRODUCTION_STARTUP === '1';
const failSecondPreflight = managedInstall && process.env.AGENTOC_QA_PREFLIGHT_FAIL_SECOND === '1';
let preflights = 0; let submissions = 0;
let providerRequests = 0;
const fixtureSessionId = phoneQueueCase ? phoneSessionId : 'fixture-session';
if (phoneQueueCase) await withSessionsMetaMutation(async (rows, save) => { rows.push({ id: phoneSessionId, name: 'Samsung real Codex fixture', folder: home, tool: 'codex', sessionPlane: 'user', sessionClass: 'ROOT_LEADERSHIP', userAddressable: true }); await save(rows, { immediate: true, durable: true }); });
const run = await createRun({ status: { sessionId: fixtureSessionId, requestId: 'fixture-request', state: phoneQueueCase ? 'running' : 'accepted', tool: 'codex' },
  manifest: { sessionId: fixtureSessionId, requestId: 'fixture-request', folder: home, tool: 'codex', runtimeFamily: 'codex-app-server-json', prompt: 'fixture', options: phoneQueueCase ? { riskMode: 'recommended' } : {} } });
if (phoneQueueCase) await mutateSessionMeta(phoneSessionId, row => { row.activeRunId = run.id; return true; });
const server = createServer((req, res) => {
  if (phoneQueueCase && req.url.startsWith('/api/')) {
    void (async () => {
      const url = new URL(req.url, 'http://127.0.0.1'); let status = 0; let body;
      const isEvents = req.method === 'GET' && url.pathname === `/api/sessions/${phoneSessionId}/events`;
      const isApproval = phoneApproval && req.method === 'POST' && url.pathname === `/api/runs/${encodeURIComponent(run.id)}/approvals/${encodeURIComponent(phoneApproval.approvalId)}`;
      if (!isEvents && !isApproval) { res.writeHead(404).end(); return; }
      const handled = await handleSessionMainRoutes({ req, res, pathname: url.pathname, parsedUrl: { pathname: url.pathname, query: Object.fromEntries(url.searchParams) },
        ...(isEvents ? { sessionGetRoute: { kind: 'event-delta', sessionId: phoneSessionId } } : {}),
        authSession: { role: 'owner', principalKind: 'trusted_device' }, requireSessionAccess: async (_response, _auth, id) => id === phoneSessionId,
        writeJson: (_response, code, value) => { status = code; body = value; }, writeJsonCached: (_request, _response, value) => { status = 200; body = value; } });
      if (!handled || status !== (isEvents ? 200 : 202)) throw new Error(`unexpected phone route status ${status}`);
      if (isApproval) {
        const current = await getRun(run.id); const response = current.appServerApprovalResponseQueue.find(entry => entry.approvalId === phoneApproval.approvalId);
        if (response?.decision !== 'deny') throw new Error('phone did not deny the fixture');
        let writes = 0; const tracked = { stdin: { writable: true, write(value) { writes++; return child.stdin.write(value); } } };
        await flushCodexAppServerApprovalResponses(tracked, phoneState, current);
        await flushCodexAppServerApprovalResponses(tracked, phoneState, current);
        const delivered = (await getRun(run.id)).appServerApprovalResponseQueue.find(entry => entry.id === response.id);
        if (writes !== 1 || delivered?.state !== 'sent' || delivered?.response?.result?.decision !== 'decline') throw new Error('Codex response was not delivered exactly once');
        phoneQueued = true;
      }
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    })().catch(error => { console.error(error); if (!res.headersSent) res.writeHead(500).end(); }); return;
  }
  if (phoneQueueCase && req.method === 'GET' && req.url === '/fixture/status') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ queued: phoneQueued })); return; }
  let body = ''; req.setEncoding('utf8');
  req.on('data', chunk => { body += chunk; if (body.length > 4_000_000) req.destroy(); });
  req.on('end', () => {
    let data; try { data = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
    if (managedAsset && req.method === 'POST' && req.url === '/api/sessions/fixture-session/assets') {
      if (req.headers['x-agentoc-session-control-token'] !== 'fixture-token' || req.headers['x-agentoc-session-control-session-id'] !== 'fixture-session' || req.headers['x-agentoc-session-control-run-id'] !== run.id || req.headers['x-agentoc-session-control-turn-id'] !== 'fixture-turn' || data.localPath !== assetFile) { res.writeHead(403).end(); return; }
      submissions++; res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ asset: { assetId: 'fixture-asset' } })); return;
    }
    if (req.url === '/api/internal/approved-actions/propose') {
      if (!managedInstall || req.headers['x-agentoc-approved-action-token'] !== 'fixture-token' || data.sessionId !== 'fixture-session' || data.runId !== run.id || data.turnId !== 'fixture-turn' || data.actions?.[0]?.command !== packageCommand) { res.writeHead(400).end(); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      if (data.autoInstallPreflight === true) { preflights++; res.end(JSON.stringify({ kind: 'automatic_install_preflight', ready: !(failSecondPreflight && preflights >= 2) })); }
      else { submissions++; res.end(JSON.stringify({ kind: 'automatic_install', status: 'succeeded' })); }
      return;
    }
    const toolSpecs = Array.isArray(data.tools) ? data.tools : [];
    const shellToolSpec = toolSpecs.find(item => ['exec_command', 'shell_command'].includes(item?.name || item?.function?.name));
    const shellToolName = shellToolSpec?.name || shellToolSpec?.function?.name || '';
    const shellToolSchema = shellToolSpec?.parameters || shellToolSpec?.function?.parameters || shellToolSpec?.input_schema || {};
    const shellToolProperties = shellToolSchema?.properties && typeof shellToolSchema.properties === 'object'
      ? shellToolSchema.properties : {};
    const shellCommandField = Object.hasOwn(shellToolProperties, 'cmd') ? 'cmd'
      : Object.hasOwn(shellToolProperties, 'command') ? 'command' : '';
    if (process.env.AGENTOC_QA_TRACE_CODEX === '1') process.stderr.write(`[fixture] shell tool: ${JSON.stringify({ name: shellToolName, properties: Object.keys(shellToolProperties), required: shellToolSchema.required || [] })}\n`);
    if (!shellToolName || !shellCommandField) { process.stderr.write('Codex shell tool schema missing a supported command field\n'); process.exitCode = 1; res.writeHead(400).end(); child.kill(); server.close(); return; }
    providerRequests++;
    if ((managedElevation || phoneQueueCase) && providerRequests > 1) {
      if (managedElevation && !JSON.stringify(data).includes('agentoc_request_actions')) { process.stderr.write('managed elevation instruction did not reach model\n'); process.exitCode = 1; res.writeHead(400).end(); child.kill(); server.close(); return; }
      const item = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Managed elevation required', annotations: [] }] };
      const response = { id: 'resp_done', object: 'response', created_at: 1, status: 'completed', model: 'gpt-5.4', output: [item], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of [{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item }, { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response }]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end(); return;
    }
    if (managedDeleteRelative && providerRequests === 2 && !JSON.stringify(data).includes('resolve the target against the command working directory')) { process.stderr.write('relative retry instruction did not reach model\n'); process.exitCode = 1; res.writeHead(400).end(); child.kill(); server.close(); return; }
    const deleteTarget = dangerousRetry ? path.join(outsideFixture, 'target') : managedDeleteRelative ? path.join(alternateCwd, 'delete-target') : path.join(home, 'build');
    const relativeTarget = dangerousRetry ? path.relative(alternateCwd, deleteTarget) : 'delete-target';
    const deleteCommand = managedDeleteRelative && providerRequests === 1 ? `Remove-Item -LiteralPath '${relativeTarget.replace(/'/g, "''")}' -Recurse -Force` : `Remove-Item -LiteralPath '${deleteTarget.replace(/'/g, "''")}' -Recurse -Force`;
    const adminCommand = process.env.AGENTOC_QA_HOOK_ELEVATION_REGISTRY === '1' ? "Set-ItemProperty -LiteralPath 'HKLM:\\Software\\AgentoC-Nonexistent-Fixture' -Name Value -Value 1 -WhatIf" : process.env.AGENTOC_QA_HOOK_ELEVATION_SC === '1' ? 'sc.exe start agentoc-fixture' : process.env.AGENTOC_QA_HOOK_ELEVATION_DIRECT === '1' ? 'New-LocalUser -Name agentoc-fixture -WhatIf' : `Start-Process -FilePath '${path.join(home, 'nonexistent.exe').replace(/'/g, "''")}' -Verb RunAs`;
    const shellCommand = managedAsset ? `ragent api POST "/api/sessions/$env:AGENTOC_SESSION_ID/assets" --body '${JSON.stringify({ localPath: assetFile, originalName: 'fixture.txt' }).replaceAll("'", "''")}'` : managedElevation ? adminCommand : managedDelete ? deleteCommand : managedInstall ? installCommand
      : managedRipgrep ? `rg --files ${process.env.AGENTOC_QA_RG_GLOB === '1' ? "-g '*' " : ''}'${rgFixture.replace(/'/g, "''")}'` : fileCommand ? safeFileCommand : process.env.AGENTOC_QA_SENSITIVE === '1' ? "Write-Output 'fixture' > .ssh\\dummy" : "Write-Output 'agentoc-fixture'";
    const argsObject = { [shellCommandField]: shellCommand };
    if (Object.hasOwn(shellToolProperties, 'yield_time_ms')) argsObject.yield_time_ms = 1000;
    if (Object.hasOwn(shellToolProperties, 'workdir') && (process.env.AGENTOC_QA_HOOK_WORKDIR === '1' || managedDelete)) argsObject.workdir = alternateCwd;
    const args = JSON.stringify(argsObject);
    const call = { id: managedDeleteRelative && providerRequests > 1 ? 'fc_fixture_retry' : 'fc_fixture', type: 'function_call', name: shellToolName, call_id: managedDeleteRelative && providerRequests > 1 ? 'call_fixture_retry' : 'call_fixture', arguments: args, status: 'completed' };
    const response = { id: 'resp_fixture', object: 'response', created_at: 1, status: 'completed', model: 'gpt-5.4', output: [call], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } };
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    for (const event of [
      { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { ...call, arguments: '', status: 'in_progress' } },
      { type: 'response.function_call_arguments.delta', item_id: call.id, output_index: 0, delta: args },
      { type: 'response.function_call_arguments.done', item_id: call.id, output_index: 0, arguments: args },
      { type: 'response.output_item.done', output_index: 0, item: call },
      { type: 'response.completed', response },
    ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
});
await new Promise(resolve => server.listen(phoneQueueCase ? 18667 : managedAsset ? 18669 : 0, '127.0.0.1', resolve));
const port = server.address().port;
const hookExperiment = process.env.AGENTOC_QA_HOOK_REWRITE === '1';
const hookShouldRun = hookExperiment && process.env.AGENTOC_QA_HOOK_TRUST !== '0';
const hookShouldFail = hookShouldRun && process.env.AGENTOC_QA_HOOK_FAIL === '1';
const exactTrust = hookShouldRun && process.env.AGENTOC_QA_HOOK_EXACT_TRUST === '1';
const mutateTrustedHook = exactTrust && process.env.AGENTOC_QA_HOOK_MUTATE === '1';
const hookExpectedRun = hookShouldRun && !hookShouldFail && !mutateTrustedHook;
const trapPath = path.join(home, 'unexpected-hook-ran');
let hookConfig = '';
let fixtureHookCommand = '';
let fixtureHookSourcePath = path.join(home, 'config.toml');
if (hookExperiment) {
  const hookPath = managedInstall || managedDelete || managedElevation || managedRipgrep || managedAsset || managedGlob ? fileURLToPath(new URL('../scripts/agentoc-codex-windows-install-hook.mjs', import.meta.url)) : path.join(home, 'fixture-hook.cjs');
  if (!managedInstall && !managedDelete && !managedElevation && !managedRipgrep && !managedAsset && !managedGlob) await writeFile(hookPath, `const fs=require('fs'); process.on('uncaughtException', e => { fs.writeFileSync(${JSON.stringify(path.join(home, 'hook-error.txt'))}, String(e.stack)); process.exitCode=1; }); let data=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', c => data += c); process.stdin.on('end', () => { fs.writeFileSync(${JSON.stringify(path.join(home, 'hook-input.json'))}, data); fs.writeFileSync(${JSON.stringify(path.join(home, 'hook-process-cwd.txt'))}, process.cwd()); JSON.parse(data); ${hookShouldFail ? "throw new Error('fixture hook failure');" : ''} process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow',updatedInput:{command:"Write-Output 'agentoc-rewritten'"}}})); });`);
  const quote = value => `'${value.replace(/'/g, "''")}'`;
  const command = `& ${quote(process.execPath)} ${quote(hookPath)}`;
  fixtureHookCommand = command;
  hookConfig = `\n[[hooks.PreToolUse]]\nmatcher = "^Bash$"\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = ${JSON.stringify(command)}\n`;
  if (exactTrust) {
    const trapScript = path.join(home, 'untrusted-hook.cjs');
    await writeFile(trapScript, `require('fs').writeFileSync(${JSON.stringify(trapPath)}, 'ran'); process.stdout.write('{}');`);
    const trapCommand = `& ${quote(process.execPath)} ${quote(trapScript)}`;
    fixtureHookSourcePath = path.join(home, 'hooks.json');
    await writeFile(fixtureHookSourcePath, JSON.stringify({ hooks: { PreToolUse: [
      ...(!productionStartup ? [{ matcher: '^Bash$', hooks: [{ type: 'command', command }] }] : []),
      { matcher: '^Bash$', hooks: [{ type: 'command', command: trapCommand }] },
    ] } }));
    hookConfig = `\n[hooks.state."preserved-state"]\ntrusted_hash = "sha256:${'a'.repeat(64)}"\n`;
  }
}
await writeFile(home + '\\config.toml', `model_provider = "agentoc_fixture"\nmodel = "gpt-5.4"\n${hookConfig}\n[model_providers.agentoc_fixture]\nname = "Fixture"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nenv_key = "AGENTOC_QA_PROVIDER_KEY"\n`);
const env = { ...process.env, CODEX_HOME: home, XDG_CACHE_HOME: home, XDG_CONFIG_HOME: home, AGENTOC_QA_PROVIDER_KEY: 'fixture',
  AGENTOC_APPROVED_ACTIONS_ENDPOINT: `http://127.0.0.1:${port}/api/internal/approved-actions/propose`, AGENTOC_APPROVED_ACTIONS_TOKEN: 'fixture-token',
  AGENTOC_APPROVED_ACTIONS_SESSION_ID: 'fixture-session', AGENTOC_APPROVED_ACTIONS_RUN_ID: run.id, AGENTOC_APPROVED_ACTIONS_TURN_ID: 'fixture-turn',
  HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost',
  http_proxy: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9', all_proxy: 'http://127.0.0.1:9', no_proxy: '127.0.0.1,localhost' };
delete env.OPENAI_API_KEY;
if (pinnedIdentity) env.AGENTOC_WINDOWS_USER_INSTALL_IDENTITY = JSON.stringify(pinnedIdentity);
if (managedRipgrep) env.RIPGREP_CONFIG_PATH = rgConfig;
if (managedAsset) Object.assign(env, { AGENTOC_SESSION_ID: 'fixture-session', AGENTOC_SESSION_CONTROL_TOKEN: 'fixture-token', AGENTOC_SESSION_CONTROL_SESSION_ID: 'fixture-session', AGENTOC_SESSION_CONTROL_RUN_ID: run.id, AGENTOC_SESSION_CONTROL_TURN_ID: 'fixture-turn' });
if (managedDelete || managedRipgrep || managedAsset || managedGlob) env.AGENTOC_WINDOWS_SAFE_DELETE_CONTEXT = JSON.stringify({ runId: run.id, helperPath: safeDeleteBinary || '', assetHelperPath: assetHelper, port: managedAsset ? port : undefined,
  state: { riskMode, riskContextValid: boundContext?.valid ?? true, sessionControlReadAvailable: managedAsset, sessionControlReadRunId: managedAsset ? run.id : '', riskContext: boundContext?.riskContext ?? { trustedWorkspaceRoot: home, protectedRoots: [] } } });
let productionOverlay = null;
if (productionStartup) {
  if (!exactTrust) throw new Error('production fixture requires exact trust');
  await writeFile(path.join(home, 'auth.json'), JSON.stringify({ access_token: 'fixture' }));
  productionOverlay = await prepareManagedMcpOverlay({ runtimeFamily: 'codex-app-server-json', runId: run.id, spawnEnv: env,
    servers: [{ kind: 'actions', scriptPath: fileURLToPath(new URL('../scripts/agentoc-approved-actions-mcp.mjs', import.meta.url)) }],
    codexWindowsApprovalGate: true, codexWindowsInstallHook: fileURLToPath(new URL('../scripts/agentoc-codex-windows-install-hook.mjs', import.meta.url)) });
  if (!productionOverlay?.codexWindowsInstallHook) throw new Error('production hook overlay unavailable');
  env.CODEX_HOME = productionOverlay.root;
  fixtureHookCommand = productionOverlay.codexWindowsInstallHook.command;
  fixtureHookSourcePath = productionOverlay.codexWindowsInstallHook.sourcePath;
}
// Bypassing hook trust is limited to this disposable home with one fixed,
// test-owned hook. Never copy this setting into production thread options: it
// would also trust unrelated user, project, or plugin hooks.
const codexBinary = process.env.AGENTOC_TEST_CODEX_BINARY;
const codexArgs = ['app-server', '--disable', 'plugins', '--disable', 'remote_plugin', '--disable', 'plugin_sharing', '--listen', 'stdio://',
  ...buildCodexAppServerProjectTrustArgs(home)];
const codexEntrypoint = process.env.AGENTOC_TEST_CODEX_ENTRYPOINT;
const child = spawn(codexBinary, codexEntrypoint ? [codexEntrypoint, ...codexArgs] : codexArgs, {
  cwd: home, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
});
let codexStderr = '';
child.stderr.on('data', chunk => {
  codexStderr = (codexStderr + String(chunk)).slice(-6000);
  if (process.env.AGENTOC_QA_TRACE_CODEX === '1') process.stderr.write(`[fixture] Codex stderr: ${String(chunk).slice(-2000)}\n`);
});
const timeout = setTimeout(() => { process.stderr.write(`fixture timed out${codexStderr ? `: ${codexStderr}` : ''}\n`); child.kill(); server.close(); process.exitCode = 1; }, phoneQueueCase ? 240000 : 30000);
let stage = 0; let hookCompleted = false; let hookFailed = false; let hookBlocked = false;
let fixtureHookKey = '';
let managedHookSetup = null;
let productionState = null;
function startThread() {
  stage = 1;
  child.stdin.write(JSON.stringify({ id: 2, method: 'thread/start', params: { cwd: home, model: 'gpt-5.4', modelProvider: 'agentoc_fixture', approvalsReviewer: 'user', sandbox: 'danger-full-access', config: { allow_login_shell: false, ...(hookShouldRun && !exactTrust ? { bypass_hook_trust: true } : {}) } } }) + '\n');
}
function fixtureError(message) { process.stderr.write(message + '\n'); process.exitCode = 1; stage = 3; child.kill(); server.close(); }
createInterface({ input: child.stdout }).on('line', async line => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (process.env.AGENTOC_QA_TRACE_CODEX === '1') process.stderr.write(`[fixture] app-server: ${JSON.stringify({ id: msg.id, method: msg.method, error: msg.error?.message, resultKeys: Object.keys(msg.result || {}) })}\n`);
  if (process.env.AGENTOC_QA_TRACE_LIFECYCLE === '1' && ['item/started', 'hook/started', 'hook/completed', 'item/commandExecution/requestApproval'].includes(msg.method)) process.stderr.write('fixture event: ' + JSON.stringify({ method: msg.method, params: msg.params }) + '\n');
  if (hookExperiment && msg.method === 'hook/completed' && msg.params?.run?.eventName === 'preToolUse') { hookCompleted = msg.params.run.status === 'completed'; hookFailed = msg.params.run.status === 'failed'; hookBlocked = msg.params.run.status === 'blocked'; }
  if (productionState?.codexManagedHookSetup?.consume(msg)) return;
  if (managedHookSetup?.consume(msg)) return;
  if (stage === 0 && msg.id === 1) {
    if (msg.error) { process.stderr.write('initialize rejected\n'); process.exitCode = 1; child.kill(); server.close(); return; }
    if (productionStartup) {
      stage = 1;
      productionState = { initialized: false, initializeRequestId: 1, threadRequestId: 2, nextControlRequestId: 200, cwd: home,
        codexWindowsInstallHook: productionOverlay.codexWindowsInstallHook, riskMode, permissionMode: 'untrusted-danger-full-access', agentocApprovalGate: true, model: 'gpt-5.4' };
      handleCodexAppServerInitializeResponse(child, productionState, msg);
      return;
    }
    child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
    if (exactTrust) {
      stage = 10; let id = 200;
      managedHookSetup = createCodexManagedHookSetup({ cwd: home, configPath: path.join(home, 'config.toml'), sourcePath: fixtureHookSourcePath, command: fixtureHookCommand,
        nextRequestId: () => id++, send: message => child.stdin.write(JSON.stringify(message) + '\n'),
        onDone: ready => { if (!ready) { fixtureError('production hook setup failed'); return; } stage = 12; child.stdin.write(JSON.stringify({ id: 92, method: 'hooks/list', params: { cwds: [home] } }) + '\n'); } });
      managedHookSetup.start();
    }
    else startThread();
  } else if (stage === 12 && msg.id === 92) {
    const hooks = msg.result?.data?.[0]?.hooks || [];
    fixtureHookKey = hooks.find(h => h.command === fixtureHookCommand)?.key || '';
    if (hooks.length !== 2 || hooks.find(h => h.key === fixtureHookKey)?.trustStatus !== 'trusted' || hooks.find(h => h.key !== fixtureHookKey)?.trustStatus !== 'untrusted') { fixtureError('precise hook trust did not preserve the other hook as untrusted: ' + JSON.stringify(msg.result)); return; }
    if (!(await readFile(path.join(home, 'config.toml'), 'utf8')).includes('preserved-state')) { fixtureError('precise hook trust write erased an existing hook state'); return; }
    if (mutateTrustedHook) {
      const configPath = fixtureHookSourcePath;
      const current = await readFile(configPath, 'utf8');
      const oldCommand = JSON.stringify(fixtureHookCommand);
      const newCommand = JSON.stringify(fixtureHookCommand + ' ');
      if (!current.includes(oldCommand)) { fixtureError('fixture hook config missing before mutation'); return; }
      await writeFile(configPath, current.replace(oldCommand, newCommand));
    }
    startThread();
  } else if (stage === 1 && msg.id === 2) {
    if (msg.error) { process.stderr.write('thread rejected: '+msg.error.message+'\n'); process.exitCode = 1; child.kill(); server.close(); return; }
    const approvalContext = validateCodexAppServerApprovalContext({
      response: msg.result,
      cwd: home,
      permissionMode: 'untrusted-danger-full-access',
    });
    if (!approvalContext.ok) { fixtureError(`effective Codex approval context was not verified: ${approvalContext.reasonCode}`); return; }
    if (productionStartup && productionState.codexManagedHookReady !== true) { fixtureError('production startup did not verify the managed hook'); return; }
    stage = 2; child.stdin.write(JSON.stringify({ id: 3, method: 'turn/start', params: { threadId: msg.result.thread.id, cwd: home, input: [{type:'text',text:'Fixture only',text_elements:[]}], approvalsReviewer: 'user', sandboxPolicy: {type:'dangerFullAccess'} } }) + '\n');
  } else if (stage === 2 && msg.method === 'item/commandExecution/requestApproval') {
    if (managedElevation) { fixtureError('direct elevation unexpectedly reached command approval'); return; }
    if (dangerousRetry) {
      const state = { riskMode, cwd: home, riskContextValid: boundContext?.valid ?? true, riskContext: boundContext?.riskContext ?? { trustedWorkspaceRoot: home }, startedTurn: true,
        threadId: msg.params.threadId, turnId: msg.params.turnId, pendingApprovals: new Map(), activeItems: new Map(), autoApprovedMcpRequestIds: new Set() };
      const sent = [];
      await trackCodexAppServerApprovalRequest(run.id, state, msg, { stdin: { writable: true, write(value) { sent.push(JSON.parse(value)); return true; } } }, { safeDeleteHelperPath: safeDeleteBinary });
      const pending = (await getRun(run.id)).appServerPendingApprovals || [];
      const routed = riskMode !== 'recommended' ? sent[0]?.result?.decision === 'decline' : sent.length === 0 && pending.length === 1;
      if (!routed || await readFile(path.join(outsideFixture, 'target', 'keep.txt'), 'utf8') !== 'keep') { fixtureError('outside target was not routed to review or denial'); return; }
      process.stdout.write(`codex-windows-local-gate: relative outside deletion routed safely for ${riskMode}\n`);
      stage = 3; child.stdin.write(JSON.stringify({ id: msg.id, result: { decision: 'decline' } }) + '\n'); child.kill(); server.close(); return;
    }
    if (hookExpectedRun) {
      if (process.env.AGENTOC_QA_TRACE_APPROVAL === '1') process.stderr.write('fixture approval: ' + JSON.stringify(msg.params) + '\n');
      const deleteTarget = managedDeleteRelative ? path.join(alternateCwd, 'delete-target') : path.join(home, 'build');
      const deleteCommand = `Remove-Item -LiteralPath '${deleteTarget.replace(/'/g, "''")}' -Recurse -Force`;
      const expectedDelete = managedDelete ? await buildWindowsSafeDeleteBridge({ approval: { approvalId: managedDeleteRelative ? 'call_fixture_retry' : 'call_fixture', providerMethod: 'can_use_tool', params: { tool_name: 'PowerShell', input: { command: deleteCommand } } },
        state: { riskMode, turnActive: true, cwd: alternateCwd, riskContextValid: true, riskContext: { trustedWorkspaceRoot: home, protectedRoots: [] } }, runId: run.id, helperPath: safeDeleteBinary }) : null;
      const expectedBridge = managedInstall ? buildClaudeWindowsInstallBridge({ approval: { approvalId: 'call_fixture', providerMethod: 'can_use_tool', params: { tool_name: 'PowerShell', input: { command: installCommand } } },
        state: { windowsManagedActionChannel: true, windowsManagedActionBinding: { windowsUserInstallIdentity: pinnedIdentity }, riskMode: 'recommended', riskContextValid: true }, runId: run.id, nodePath: process.execPath,
        scriptPath: fileURLToPath(new URL('../scripts/agentoc-windows-install-bridge.mjs', import.meta.url)) }) : null;
      const assetCommand = `ragent api POST "/api/sessions/$env:AGENTOC_SESSION_ID/assets" --body '${JSON.stringify({ localPath: assetFile, originalName: 'fixture.txt' }).replaceAll("'", "''")}'`;
      const expectedAsset = managedAsset ? await buildWindowsCliAssetBridge({ approval: { providerMethod: 'can_use_tool', params: { tool_name: 'PowerShell', input: { command: assetCommand } } },
        state: { riskMode, turnActive: true, cwd: home, riskContextValid: boundContext?.valid ?? true, riskContext: boundContext?.riskContext ?? { trustedWorkspaceRoot: home }, sessionControlReadAvailable: true, sessionControlReadRunId: run.id }, runId: run.id, helperPath: assetHelper, port }) : null;
      const expectedGlob = managedGlob ? await buildWindowsSelectStringGlobBridge({ approval: { kind: 'command', providerMethod: 'can_use_tool', params: { tool_name: 'PowerShell', input: { command: safeFileCommand } } },
        state: { riskMode, turnActive: true, cwd: home, riskContextValid: boundContext?.valid ?? true, riskContext: boundContext?.riskContext ?? { trustedWorkspaceRoot: home, protectedRoots: [] } } }) : null;
      const decodedArgv = decodeCodexShlexArgv(msg.params.command);
      const invocation = readWindowsPowerShellInvocation({ params: { command: decodedArgv } });
      const rewrittenCommand = managedInstall ? decodedArgv?.at(-1) : '';
      const rewriteMatches = managedGlob ? invocation?.command === expectedGlob?.updatedCommand && !!expectedGlob && !invocation.command.includes('*') : managedAsset ? invocation?.command === expectedAsset?.updatedCommand : managedDelete
        ? invocation?.command === expectedDelete?.updatedCommand && msg.params.cwd.toLowerCase() === alternateCwd.toLowerCase()
        : managedInstall
          ? rewrittenCommand === expectedBridge?.updatedCommand && preflights === 1 && submissions === 0
          : managedRipgrep ? /rg --no-config .*--files/.test(String(decodedArgv?.at(-1) || ''))
          : String(msg.params.command || '').includes('agentoc-rewritten');
      if (!hookCompleted || !rewriteMatches) {
        process.stderr.write(`approval did not contain the completed hook rewrite (hookCompleted=${hookCompleted}, rewriteMatches=${rewriteMatches}, preflights=${preflights}, submissions=${submissions})\n`); process.exitCode = 1; stage = 3;
        child.stdin.write(JSON.stringify({ id: msg.id, result: { decision: 'decline' } }) + '\n'); child.kill(); server.close(); return;
      }
      if (managedInstall && !invocation) {
        const state = { riskMode, cwd: home, riskContextValid: true, riskContext: { trustedWorkspaceRoot: home }, startedTurn: true,
          windowsManagedActionChannel: true, windowsManagedActionBinding: { endpoint: env.AGENTOC_APPROVED_ACTIONS_ENDPOINT, token: 'fixture-token', sessionId: 'fixture-session', runId: run.id, turnId: 'fixture-turn', windowsUserInstallIdentity: pinnedIdentity },
          threadId: msg.params.threadId, turnId: msg.params.turnId, pendingApprovals: new Map(), activeItems: new Map(), autoApprovedMcpRequestIds: new Set() };
        const sent = [];
        await trackCodexAppServerApprovalRequest(run.id, state, msg, { stdin: { writable: true, write(value) { sent.push(JSON.parse(value)); return true; } } });
        const pending = (await getRun(run.id)).appServerPendingApprovals || [];
        if (sent.length !== 0 || pending.length !== 1 || submissions !== 0) {
          fixtureError('managed install wrapper without a verified no-profile PowerShell identity must remain owner-gated'); return;
        }
        process.stdout.write('codex-windows-local-gate: managed hook rewrote the install; unverified shell startup remained owner-gated\n');
        stage = 3;
        child.stdin.write(JSON.stringify({ id: msg.id, result: { decision: 'decline' } }) + '\n');
        setTimeout(() => { child.kill(); server.close(); }, 100);
        return;
      }
      if (managedInstall || managedDelete || managedRipgrep || managedAsset || managedGlob) {
        const state = { riskMode, cwd: home, riskContextValid: boundContext?.valid ?? true, riskContext: boundContext?.riskContext ?? { trustedWorkspaceRoot: home }, startedTurn: true,
          sessionControlReadAvailable: managedAsset, sessionControlReadRunId: managedAsset ? run.id : '',
          windowsManagedActionChannel: true, windowsManagedActionBinding: { endpoint: env.AGENTOC_APPROVED_ACTIONS_ENDPOINT, token: 'fixture-token', sessionId: 'fixture-session', runId: run.id, turnId: 'fixture-turn', windowsUserInstallIdentity: pinnedIdentity },
          threadId: msg.params.threadId, turnId: msg.params.turnId, pendingApprovals: new Map(), activeItems: new Map(), autoApprovedMcpRequestIds: new Set() };
        const sent = [];
        await trackCodexAppServerApprovalRequest(run.id, state, msg, { stdin: { writable: true, write(value) { sent.push(JSON.parse(value)); return true; } } }, managedDelete ? { safeDeleteHelperPath: safeDeleteBinary } : managedAsset ? { cliReadHelperPath: assetHelper } : undefined);
        if (failSecondPreflight) {
          const pending = (await getRun(run.id)).appServerPendingApprovals || [];
          const stopped = preflights === 2 && submissions === 0 && (riskMode !== 'recommended' ? sent[0]?.result?.decision === 'decline' : sent.length === 0 && pending.length === 1);
          if (!stopped) { fixtureError('second preflight failure did not stop the managed bridge'); return; }
          process.stdout.write(`codex-windows-local-gate: second preflight failure stopped ${riskMode}\n`);
          stage = 3; child.stdin.write(JSON.stringify({ id: msg.id, result: { decision: 'decline' } }) + '\n'); child.kill(); server.close(); return;
        }
        if (sent[0]?.result?.decision !== 'accept' || (managedInstall && preflights !== 2)) { fixtureError('sidecar did not independently authorize the managed bridge'); return; }
        stage = 4; child.stdin.write(JSON.stringify(sent[0]) + '\n'); return;
      }
      stage = 4; child.stdin.write(JSON.stringify({ id: msg.id, result: { decision: 'accept' } }) + '\n'); return;
    }
    if (hookShouldFail && !hookFailed) { process.stderr.write('fixture hook failure was not observed\n'); process.exitCode = 1; stage = 3; child.stdin.write(JSON.stringify({ id: msg.id, result: { decision: 'decline' } }) + '\n'); child.kill(); server.close(); return; }
    stage = 3;
    const argv = decodeCodexShlexArgv(msg.params?.command);
    const recognized = !!readWindowsPowerShellInvocation({ params: { command: argv } });
    const state = { riskMode, cwd: home, riskContextValid: boundContext?.valid ?? true, riskContext: boundContext?.riskContext ?? { trustedWorkspaceRoot: home },
      threadId: msg.params.threadId, turnId: msg.params.turnId, pendingApprovals: new Map(), sentApprovalResponseIds: new Set(), activeItems: new Map(), autoApprovedMcpRequestIds: new Set(), startedTurn: true };
    const policy = await decideWindowsApproval({ kind: 'command', providerMethod: msg.method, params: msg.params }, state);
    const sent = [];
    const fakeProc = { stdin: { writable: true, write(value) { sent.push(JSON.parse(value)); return true; } } };
    await trackCodexAppServerApprovalRequest(run.id, state, msg, fakeProc);
    const expected = process.env.AGENTOC_QA_EXPECT_DECISION || 'auto-allow';
    const pending = (await getRun(run.id)).appServerPendingApprovals || [];
    const routed = expected === 'auto-allow' ? sent[0]?.result?.decision === 'accept'
      : riskMode === 'full-auto' ? sent[0]?.result?.decision === 'decline' && pending.length === 0
        : riskMode !== 'recommended' ? sent[0]?.result?.decision === 'decline'
        : sent.length === 0 && pending.length === 1;
    if (!recognized || policy.decision !== expected || !routed) {
      process.stderr.write(`unexpected gate result: recognized=${recognized} decision=${policy.decision} routed=${routed}\n`); process.exitCode = 1;
      child.stdin.write(JSON.stringify({ id: msg.id, result: { decision: 'decline' } }) + '\n');
      child.kill(); server.close();
    } else if (expected === 'auto-allow') {
      // Only the fixed, harmless Write-Output fixture may actually execute.
      stage = 4; child.stdin.write(JSON.stringify(sent[0]) + '\n');
    } else {
      if (outsideWrite && await readFile(fileFixture, 'utf8') !== 'fixture content') { fixtureError('outside review fixture was modified'); return; }
      if (phoneQueueCase) {
        phoneApproval = pending[0]; phoneState = state; await appendRunSpoolRecord(run.id, { stream: 'stdout', json: msg });
        const history = await getHistory(phoneSessionId);
        if (!history.some(item => item.type === 'approval_request' && item.approvalId === phoneApproval.approvalId)) { fixtureError('Codex approval did not project to phone history'); return; }
        stage = 6; process.stdout.write('SAMSUNG_CODEX_PROVIDER_READY\n'); return;
      }
      process.stdout.write(riskMode === 'full-auto'
        ? 'codex-windows-local-gate: full-auto denied the dangerous command without creating an owner prompt\n'
        : `codex-windows-local-gate: ${expected} passed\n`);
      child.stdin.write(JSON.stringify({ id: msg.id, result: { decision: 'decline' } }) + '\n');
      setTimeout(() => { child.kill(); server.close(); }, 100);
    }
  } else if (stage === 4 && msg.method === 'item/completed' && msg.params?.item?.type === 'commandExecution') {
    stage = 5;
    if (process.env.AGENTOC_QA_HOOK_WORKDIR === '1') {
      const event = JSON.parse(await readFile(path.join(home, 'hook-input.json'), 'utf8'));
      process.stdout.write('fixture hook workdir: ' + JSON.stringify({ cwd: event.cwd, processCwd: await readFile(path.join(home, 'hook-process-cwd.txt'), 'utf8'), tool_input: event.tool_input }) + '\n');
    }
    if (exactTrust && await access(trapPath).then(() => true, () => false)) { process.stderr.write('untrusted hook unexpectedly executed\n'); process.exitCode = 1; child.kill(); server.close(); return; }
    if (productionStartup) {
      const sourceConfig = await readFile(path.join(home, 'config.toml'), 'utf8');
      const overlayConfig = await readFile(productionOverlay.configPath, 'utf8');
      const sourceHooks = JSON.parse(await readFile(path.join(home, 'hooks.json'), 'utf8'));
      if (sourceConfig.includes(productionOverlay.codexWindowsInstallHook.sourcePath) || !overlayConfig.includes('preserved-state') ||
          !overlayConfig.includes('pre_tool_use') || sourceHooks.hooks.PreToolUse.length !== 1) {
        process.stderr.write('production hook setup changed source configuration or lost owner state\n'); process.exitCode = 1; child.kill(); server.close(); return;
      }
    }
    if (managedDelete && (await readFile(path.join(alternateCwd, 'build', 'keep.txt'), 'utf8')) !== 'keep') { fixtureError('unrelated workdir target was changed'); return; }
    const fileResult = fileCommand === 'rename'
      ? await readFile(path.join(home, 'renamed-fixture.txt'), 'utf8').catch(() => null) === 'fixture content' && !await access(fileFixture).then(() => true, () => false)
      : fileCommand === 'clear' ? await readFile(fileFixture, 'utf8').catch(() => null) === ''
        : fileCommand === 'system-copy' ? (await readFile(fileFixture).catch(() => Buffer.alloc(0))).equals(await readFile(path.join(process.env.SystemRoot, 'win.ini')))
        : ['conditional-write', 'output-filters'].includes(fileCommand) ? (await readFile(fileFixture, 'utf8').catch(() => '')).replaceAll('\r\n', '\n') === 'changed fixture\n'
        : fileCommand === 'dotnet' ? (await readFile(fileFixture, 'utf8').catch(() => '')).replace(/^\uFEFF/, '') === 'dotnet fixture' : true;
    if (msg.params.item.exitCode !== 0 || !fileResult || (['read-null', 'select-string'].includes(fileCommand) && !String(msg.params.item.aggregatedOutput || '').replace(/\r?\n/g, '').includes('fixture content')) || (['git-show', 'git-diff-file', 'git-c', 'where-filter'].includes(fileCommand) && !String(msg.params.item.aggregatedOutput || '').includes('ordinary-fixture.txt')) || (fileCommand === 'git-log-format' && !/\b[0-9a-f]{7,40} fixture\b/.test(String(msg.params.item.aggregatedOutput || ''))) || (!fileCommand && !String(msg.params.item.aggregatedOutput || '').includes(managedAsset ? 'fixture-asset' : managedDelete ? '"deleted":2' : managedInstall ? 'Installation completed successfully' : managedRipgrep ? 'ordinary-fixture.txt' : hookExpectedRun ? 'agentoc-rewritten' : 'agentoc-fixture')) || (managedRipgrep && String(msg.params.item.aggregatedOutput || '').includes('.env')) || (!hookExpectedRun && hookCompleted) || ((managedInstall || managedAsset) && submissions !== 1)) {
      process.stderr.write(`approved harmless command failed: exit=${msg.params.item.exitCode} output=${String(msg.params.item.aggregatedOutput || '').slice(0, 1200)}\n`); process.exitCode = 1;
    } else process.stdout.write(fileCommand ? `codex-windows-local-gate: ${fileCommand} executed on isolated fixture\n` : managedAsset ? 'codex-windows-local-gate: controlled asset publication reached isolated service\n' : managedDelete ? 'codex-windows-local-gate: bound deletion used the approved absolute target\n' : managedInstall ? 'codex-windows-local-gate: managed install bridge reached mock control plane\n' : hookShouldFail ? 'codex-windows-local-gate: failed hook; original passed gate\n' : hookExpectedRun ? 'codex-windows-local-gate: hook rewrote approved harmless command\n' : hookExperiment ? 'codex-windows-local-gate: untrusted hook skipped; original passed gate\n' : 'codex-windows-local-gate: auto-allow executed harmless command\n');
    child.kill(); server.close();
  } else if (stage === 2 && msg.method === 'item/completed' && msg.params?.item?.type === 'commandExecution') {
    if (managedElevation) { fixtureError('direct elevation unexpectedly executed'); return; }
    if (managedDeleteRelative && msg.params.item.id === 'call_fixture') return;
    if (['git-status', 'git-diff', 'git-show', 'git-log-format', 'git-diff-file', 'git-c'].includes(fileCommand) && process.env.AGENTOC_QA_EXPECT_DECISION === 'auto-allow') {
      if (msg.params.item.exitCode !== 0 || (fileCommand === 'git-log-format' ? !/\b[0-9a-f]{7,40} fixture\b/.test(String(msg.params.item.aggregatedOutput || '')) : !String(msg.params.item.aggregatedOutput || '').includes('ordinary-fixture.txt'))) {
        fixtureError('read-only Git status did not return the isolated fixture entry'); return;
      }
      stage = 5;
      process.stdout.write('codex-windows-local-gate: real Codex CLI git status completed without an approval request\n');
      child.kill(); server.close(); return;
    }
    stage = 3;
    process.stderr.write('command completed without a gate request\n'); process.exitCode = 1;
    child.kill(); server.close();
  } else if (stage === 6 && phoneQueueCase && msg.method === 'turn/completed') {
    if (!phoneQueued || providerRequests < 2) { fixtureError('phone denial did not return to Codex model'); return; }
    stage = 5; process.stdout.write('codex-windows-local-gate: Samsung denial reached real Codex CLI\n'); setTimeout(() => { child.kill(); server.close(); }, 1000);
  } else if (stage === 2 && managedElevation && msg.method === 'turn/completed') {
    if (!hookBlocked || providerRequests < 2) { fixtureError('managed elevation denial did not reach the model'); return; }
    stage = 5; process.stdout.write('codex-windows-local-gate: managed elevation guidance reached model without executing command\n'); child.kill(); server.close();
  }
});
child.on('exit', async () => {
  clearTimeout(timeout); if (stage !== 3 && stage !== 5 && !process.exitCode) process.exitCode = 1; server.close();
  // Only delete the mkdtemp directory created by this test, after its Codex
  // child has exited. Failed cleanup never expands beyond the checked parent.
  const target = path.resolve(home), parent = path.resolve(tmpdir());
  if (path.dirname(target).toLowerCase() === parent.toLowerCase() && path.basename(target).startsWith('agentoc-codex-local-gate-')) {
    await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {});
  }
  if (outsideFixture && path.dirname(path.resolve(outsideFixture)).toLowerCase() === parent.toLowerCase() && path.basename(outsideFixture).startsWith('agentoc-delete-outside-')) {
    await unlink(path.join(outsideFixture, 'target', 'keep.txt')).catch(() => {});
    await rmdir(path.join(outsideFixture, 'target')).catch(() => {});
    await rmdir(outsideFixture).catch(() => {});
  }
  if (outsideWriteRoot && path.dirname(path.resolve(outsideWriteRoot)).toLowerCase() === parent.toLowerCase() && path.basename(outsideWriteRoot).startsWith('agentoc-codex-outside-write-')) {
    await unlink(fileFixture).catch(() => {});
    await rmdir(outsideWriteRoot).catch(() => {});
  }
  if (assetOutsideRoot && path.dirname(path.resolve(assetOutsideRoot)).toLowerCase() === parent.toLowerCase() && path.basename(assetOutsideRoot).startsWith('agentoc-codex-asset-outside-')) {
    await unlink(assetFile).catch(() => {}); await rmdir(assetOutsideRoot).catch(() => {});
  }
});
child.on('error', () => { clearTimeout(timeout); process.exitCode = 1; server.close(); });
child.stdin.write(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'agentoc-qa', version: '0.0.1' }, capabilities: { experimentalApi: true } } }) + '\n');
