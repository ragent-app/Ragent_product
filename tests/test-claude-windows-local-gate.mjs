import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, access, realpath, rm, copyFile, cp } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import os from 'node:os';
import path from 'node:path';

if ((process.platform !== 'win32' && process.env.AGENTOC_QA_POSIX !== '1') || process.env.AGENTOC_RUN_CLAUDE_LOCAL_GATE !== '1') {
  console.log('claude-windows-local-gate: skipped (opt-in Windows integration test)'); process.exit(0);
}
const binary = process.env.AGENTOC_TEST_CLAUDE_BINARY;
if (!binary || !path.isAbsolute(binary)) throw new Error('absolute Claude executable required');
const unicodeFixture = process.env.AGENTOC_QA_CLAUDE_UNICODE === '1';
const root = await mkdtemp(path.join(os.tmpdir(), unicodeFixture ? 'agentoc-claude-local-gate-项目 空格-' : 'agentoc-claude-local-gate-'));
// The real admission snapshot protects the instance's control directories.
// Keep those outside the project so ordinary recursive project searches do
// not inadvertently search the fixture's own Ragent configuration.
const separateInstance = process.env.AGENTOC_QA_BOUND_CONTEXT === '1'
  ? await mkdtemp(path.join(os.tmpdir(), 'agentoc-claude-instance-')) : '';
const instance = separateInstance || path.join(root, 'instance');
const config = path.join(root, 'config');
await mkdir(config);
const askAll = process.env.AGENTOC_QA_CLAUDE_ASK_ALL === '1';
const taskToolCase = process.env.AGENTOC_QA_CLAUDE_TASK_TOOL || '';
if (taskToolCase && (!askAll || !['TaskList', 'TaskCreate', 'TaskGet', 'TaskUpdate'].includes(taskToolCase))) throw new Error('task fixture requires an explicit supported tool and command gate');
const taskFollowup = ['TaskGet', 'TaskUpdate'].includes(taskToolCase);
const cliReadCase = process.env.AGENTOC_QA_CLAUDE_CLI_READ || '';
const assetPrefix = process.env.AGENTOC_QA_ASSET_PREFIX || 'msys';
if (cliReadCase === 'asset' && !['agentoc', 'ragent', 'node', 'msys'].includes(assetPrefix)) throw new Error('invalid asset CLI prefix');
if (cliReadCase && (!askAll || !['list', 'session', 'source', 'help', 'asset'].includes(cliReadCase))) throw new Error('invalid CLI read fixture');
if (cliReadCase) process.env.CHAT_PORT = '18669';
process.env.AGENTOC_INSTANCE_ROOT = instance;
process.env.AGENTOC_CONFIG_DIR = path.join(instance, 'config');
process.env.AGENTOC_WORK_ROOT_DIR = path.join(instance, 'workspace');
process.env.AGENTOC_MEMORY_DIR = path.join(instance, 'memory');
process.env.AGENTOC_PROVIDER_HOMES_DIR = path.join(instance, 'provider-homes');
process.env.AGENTOC_RUN_SPOOL_DIR = path.join(instance, 'data', 'chat-runs');
const { buildClaudeBidiArgs } = await import('../chat/adapters/claude-bidi.mjs');
const { buildPlatformSpawnSpec } = await import('../lib/executable-resolution.mjs');
const { buildClaudeBidiApprovalResponseMessage, buildClaudeBidiInitializeMessage, buildClaudeBidiUserMessage, readClaudeBidiApprovalRequest, serializeClaudeBidiMessage } = await import('../chat/claude-bidi-protocol.mjs');
const { appendRunSpoolRecord, createRun, getRun, readRunSpoolRecords } = await import('../chat/runs.mjs');
const { flushClaudeBidiApprovalResponses, trackClaudeBidiApprovalRequest } = await import('../chat/runner-sidecar.mjs');
const { observeClaudePosixCwdResult } = await import('../chat/windows-claude-relative-operation-bridge.mjs');
const protectedCase = process.env.AGENTOC_QA_CLAUDE_PROTECTED === '1';
const installCase = process.env.AGENTOC_QA_CLAUDE_INSTALL === '1';
const uninstallCase = process.env.AGENTOC_QA_CLAUDE_UNINSTALL === '1';
const phoneQueueCase = process.env.AGENTOC_QA_SAMSUNG_CLAUDE_QUEUE === '1';
const phoneGroupCase = phoneQueueCase && process.env.AGENTOC_QA_CLAUDE_GROUP === '1';
if (phoneQueueCase && (!uninstallCase || process.env.AGENTOC_QA_MODE !== 'recommended' || !askAll)) throw new Error('phone queue fixture requires the isolated recommended uninstall case');
const phoneSessionId = 'samsung-fixture';
let phoneApproval = null; const phoneApprovals = []; let phoneQueued = false; let phoneToolResultObserved = false;
let resolvePhoneStatus; const phoneStatusObserved = new Promise(resolve => { resolvePhoneStatus = resolve; });
const { handleSessionMainRoutes } = phoneQueueCase ? await import('../chat/router-session-main-routes.mjs') : {};
const { getHistory } = phoneQueueCase ? await import('../chat/session-manager.mjs') : {};
const { withSessionsMetaMutation, mutateSessionMeta } = phoneQueueCase ? await import('../chat/session-meta-store.mjs') : {};
if (phoneQueueCase) await withSessionsMetaMutation(async (rows, save) => {
  rows.push({ id: phoneSessionId, name: 'Samsung real Claude fixture', folder: root, tool: 'claude', sessionPlane: 'user', sessionClass: 'ROOT_LEADERSHIP', userAddressable: true });
  await save(rows, { immediate: true, durable: true });
});
const deleteCase = process.env.AGENTOC_QA_CLAUDE_DELETE === '1';
const nativePowerShell = process.env.AGENTOC_QA_CLAUDE_NATIVE_POWERSHELL === '1';
const deleteList = process.env.AGENTOC_QA_CLAUDE_DELETE_LIST === '1';
const deleteSteps = process.env.AGENTOC_QA_CLAUDE_DELETE_STEPS === '1';
if (nativePowerShell && !deleteCase && !['conditional', 'conditional-write', 'stderr-null', 'output-filters', 'where-filter', 'system-copy', 'select-string'].includes(process.env.AGENTOC_QA_CLAUDE_READ) && !cliReadCase) throw new Error('native PowerShell fixture requires deletion, read or CLI-read mode');
if (deleteList && (!deleteCase || !nativePowerShell)) throw new Error('deletion list requires native PowerShell fixture');
if (deleteSteps && (!deleteList || !nativePowerShell)) throw new Error('deletion steps require native PowerShell list fixture');
const outsideFileCase = process.env.AGENTOC_QA_CLAUDE_FILE_OUTSIDE === '1';
const dotnetCase = process.env.AGENTOC_QA_CLAUDE_DOTNET === '1';
const guidanceCase = process.env.AGENTOC_QA_CLAUDE_ELEVATION === '1';
const readCase = process.env.AGENTOC_QA_CLAUDE_READ || '';
if (readCase === 'rg-text' && !askAll) throw new Error('rg-text fixture requires the production command gate');
const outsideCase = deleteCase && process.env.AGENTOC_QA_CLAUDE_DELETE_OUTSIDE === '1';
const conservativeOutside = outsideFileCase && process.env.AGENTOC_QA_MODE === 'conservative-auto';
const reviewCase = protectedCase || outsideCase || conservativeOutside || uninstallCase;
const relativeDelete = deleteCase && (process.env.AGENTOC_QA_CLAUDE_DELETE_RELATIVE === '1' || process.env.AGENTOC_QA_CLAUDE_DELETE_RELATIVE_DIRECT === '1');
if ((installCase && (protectedCase || deleteCase)) || (reviewCase && relativeDelete) || (outsideCase && protectedCase) || (outsideFileCase && (installCase || deleteCase || protectedCase)) || (dotnetCase && (installCase || deleteCase)) || (guidanceCase && (installCase || deleteCase || dotnetCase || protectedCase || outsideFileCase))) throw new Error('fixture modes are mutually exclusive');
if (readCase && (!['numbered', 'relative', 'relative-file-tool', 'relative-cd', 'fallback', 'cd-rg', 'cwd-change', 'cwd-change-rg', 'relative-write', 'unconditional-file-delete', 'npm-task', 'rg-text', 'curl', 'glob', 'list', 'git-status', 'git-show', 'git-log-format', 'git-diff-file', 'git-c-outside', 'conditional', 'conditional-write', 'stderr-null', 'output-filters', 'where-filter', 'system-copy', 'select-string'].includes(readCase) || (['conditional', 'conditional-write', 'stderr-null', 'output-filters', 'where-filter', 'system-copy', 'select-string'].includes(readCase) && !nativePowerShell) || (readCase === 'cwd-change-rg' && process.platform === 'win32') || installCase || deleteCase || dotnetCase || guidanceCase || protectedCase || outsideFileCase)) throw new Error('invalid read fixture mode');
const cwdChangeCase = ['cwd-change', 'cwd-change-rg'].includes(readCase);
if (uninstallCase && (installCase || deleteCase || dotnetCase || guidanceCase || protectedCase || outsideFileCase || readCase)) throw new Error('uninstall fixture must be isolated');
if ((installCase || uninstallCase || deleteCase || dotnetCase || guidanceCase || readCase || cliReadCase === 'asset') && !path.isAbsolute(process.env.AGENTOC_TEST_BASH_BINARY || '')) throw new Error('absolute Git Bash executable required');
const safeDeleteHelper = process.env.AGENTOC_TEST_SAFE_DELETE_BINARY;
if (deleteCase && !path.isAbsolute(safeDeleteHelper || '')) throw new Error('absolute safe deletion helper required');
const installCommand = `winget ${process.env.AGENTOC_QA_CLAUDE_INSTALL_ALIAS === '1' ? 'add' : 'install'} --${process.env.AGENTOC_QA_CLAUDE_INSTALL_QUERY === '1' ? 'query' : 'id'}=Vendor.App --source=winget --scope=user`;
// The admitted-context fixture uses an actually sensitive profile directory,
// rather than injecting an extra protected root directly into gate state.
const protectedRoot = path.join(root, process.env.AGENTOC_QA_BOUND_CONTEXT === '1' ? '.ssh' : 'protected');
if (protectedCase) await mkdir(protectedRoot);
const outsideRoot = outsideCase ? await mkdtemp(path.join(os.tmpdir(), 'agentoc-claude-outside-')) : '';
const outsideFileRoot = outsideFileCase ? await mkdtemp(path.join(os.tmpdir(), 'agentoc-claude-outside-file-')) : '';
const outsideGitRoot = readCase === 'git-c-outside' ? await mkdtemp(path.join(os.tmpdir(), 'agentoc-claude-outside-git-')) : '';
if (outsideGitRoot) { execFileSync('git', ['init', '-q'], { cwd: outsideGitRoot, windowsHide: true }); await writeFile(path.join(outsideGitRoot, 'fixture.md'), 'outside git fixture\n'); }
const outsideReadRoot = ['relative-file-tool', 'select-string'].includes(readCase) || (readCase === 'conditional' && (process.env.AGENTOC_QA_STATIC_PATH_VARIABLE === '1' || process.env.AGENTOC_QA_BOUND_NAME_LIST === '1')) || cliReadCase === 'asset' ? await mkdtemp(path.join(os.tmpdir(), 'agentoc-claude-outside-read-')) : '';
if (outsideReadRoot) await writeFile(path.join(outsideReadRoot, 'fixture.md'), 'local read fixture\n');
const deleteTarget = path.join(outsideCase ? outsideRoot : protectedCase ? protectedRoot : root, unicodeFixture ? '构建 输出' : 'delete-fixture');
const keepFile = path.join(root, 'keep-fixture.txt');
const extraFile = path.join(root, 'delete-extra.txt');
if (deleteCase) {
  await mkdir(deleteTarget);
  await writeFile(path.join(deleteTarget, 'fixture.txt'), 'deletable fixture');
  await writeFile(keepFile, 'keep fixture');
  if (deleteList) await writeFile(extraFile, 'deletable extra fixture');
}
const bashTarget = deleteTarget.replace(/^([A-Za-z]):\\/, (_, drive) => `/${drive.toLowerCase()}/`).replaceAll('\\', '/');
const deleteCommand = nativePowerShell
  ? `Remove-Item -LiteralPath '${deleteTarget.replaceAll("'", "''")}' -Recurse -Force`
  : `rm -rf '${bashTarget.replace(/'/g, "'\\''")}'`;
const artifact = path.join(cliReadCase === 'asset' || readCase === 'select-string' ? outsideReadRoot : outsideFileCase ? outsideFileRoot : protectedCase ? protectedRoot : root, 'fixture.md');
if (cliReadCase === 'asset') await writeFile(artifact, 'isolated asset fixture\n');
const bashQuote = value => `'${value.replaceAll("'", `'"'"'`)}'`;
if (readCase) await writeFile(artifact, readCase === 'rg-text' ? 'local read fixture\nSEARCH_TOKEN=public\n' : 'local read fixture\n');
if (readCase === 'rg-text') { await writeFile(path.join(root, '.env'), 'SEARCH_TOKEN=private\n'); await writeFile(path.join(root, '.ignore'), '!.env\n'); if (process.env.AGENTOC_QA_RG_HIDDEN === '1') await writeFile(path.join(root, '.hidden.txt'), 'SEARCH_TOKEN=hidden-public\n'); }
if (readCase === 'npm-task') await writeFile(path.join(root, 'package.json'), JSON.stringify({ private: true, scripts: { 'qa-fixture': 'echo safe-task-fixture' } }));
if (cwdChangeCase) { await mkdir(path.join(root, 'child')); await writeFile(path.join(root, 'child', 'fixture.md'), 'CHILD_MARKER\n'); }
if (readCase === 'cwd-change-rg') { await writeFile(path.join(root, 'child', '.env'), 'CHILD_MARKER_PRIVATE\n'); await writeFile(path.join(root, 'child', '.ignore'), '!.env\n'); }
if (readCase === 'cd-rg') {
  await mkdir(path.join(root, 'child')); await writeFile(path.join(root, 'child', 'fixture.md'), 'SEARCH_TOKEN=public\n');
  await writeFile(path.join(root, 'child', '.env'), 'SEARCH_TOKEN=private\n'); await writeFile(path.join(root, 'child', '.ignore'), '!.env\n');
}
if (['git-status', 'git-show', 'git-log-format', 'git-diff-file'].includes(readCase)) execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
if (['git-show', 'git-log-format', 'git-diff-file'].includes(readCase)) {
  execFileSync('git', ['add', 'fixture.md'], { cwd: root, windowsHide: true });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'fixture'], { cwd: root, windowsHide: true });
  if (readCase === 'git-diff-file') await writeFile(artifact, 'changed fixture\n');
}
const bashArtifact = artifact.replace(/^([A-Za-z]):\\/, (_, drive) => `/${drive.toLowerCase()}/`).replaceAll('\\', '/');
const bashRoot = root.replace(/^([A-Za-z]):\\/, (_, drive) => `/${drive.toLowerCase()}/`).replaceAll('\\', '/');
const bashGitRoot = outsideGitRoot.replace(/^([A-Za-z]):\\/, (_, drive) => `/${drive.toLowerCase()}/`).replaceAll('\\', '/');
let readCommand = readCase === 'conditional'
  ? process.env.AGENTOC_QA_BOUND_NAME_LIST === '1'
    ? `Get-ChildItem -Path '${path.join(outsideReadRoot, '*.md').replaceAll("'", "''")}' -Force${process.env.AGENTOC_QA_BOUND_LIST_FILE === '1' ? ' -File' : ''}${process.env.AGENTOC_QA_BOUND_DEFAULT_LIST === '1' ? '' : ` | ${process.env.AGENTOC_QA_BOUND_METADATA_LIST === '1' ? 'Select-Object Mode,LastWriteTime,Length,Name | Format-Table -AutoSize' : 'Select-Object Name'} | Out-String`}`
    : process.env.AGENTOC_QA_STATIC_PATH_VARIABLE === '1'
    ? `$p=${process.env.AGENTOC_QA_STATIC_CONCAT === '1' ? `('${(path.dirname(outsideReadRoot) + path.sep).replaceAll("'", "''")}' + '${path.basename(outsideReadRoot).replaceAll("'", "''")}')` : `'${outsideReadRoot.replaceAll("'", "''")}'`}; if (Test-Path -LiteralPath $p) { Get-ChildItem -LiteralPath $p -Force | Select-Object Name | Out-String } else { 'TARGET_MISSING' }`
    : `if (Test-Path -LiteralPath '${root.replaceAll("'", "''")}') { Get-ChildItem -LiteralPath '${root.replaceAll("'", "''")}' -Force | Select-Object Mode,LastWriteTime,Length,Name | Format-Table -AutoSize | Out-String } else { 'TARGET_MISSING' }`
  : readCase === 'conditional-write' ? `if (Test-Path -LiteralPath '${artifact.replaceAll("'", "''")}') { Set-Content -LiteralPath '${artifact.replaceAll("'", "''")}' -Value 'changed fixture' } else { 'TARGET_MISSING' }`
  : readCase === 'stderr-null' ? `Get-Content -LiteralPath '${artifact.replaceAll("'", "''")}' 2>$null`
  : readCase === 'select-string' ? `Select-String ${process.env.AGENTOC_QA_SEARCH_GLOB === '1' ? '-Path' : '-LiteralPath'} '${(process.env.AGENTOC_QA_SEARCH_GLOB === '1' ? path.join(outsideReadRoot, '*.md') : artifact).replaceAll("'", "''")}' -Pattern 'local read fixture'`
  : readCase === 'output-filters' ? `Set-Content -LiteralPath '${artifact.replaceAll("'", "''")}' -Value 'changed fixture' | Out-Null; Get-Item -LiteralPath '${artifact.replaceAll("'", "''")}' | Format-List Name,Length | Out-String`
  : readCase === 'where-filter' ? `Get-ChildItem -LiteralPath '${root.replaceAll("'", "''")}' | Where-Object ${process.env.AGENTOC_QA_WHERE_SCRIPT === '2' ? "{ ($_.Name -like '*.md') -and ($_.Length -gt 0) -and -not $_.PSIsContainer }" : process.env.AGENTOC_QA_WHERE_SCRIPT === '1' ? "{ $_.Name -like '*.md' }" : "Name -like '*.md'"} | Select-Object Name | Out-String`
  : readCase === 'system-copy' ? `Copy-Item -LiteralPath '${path.join(process.env.SystemRoot, 'win.ini').replaceAll("'", "''")}' -Destination '${artifact.replaceAll("'", "''")}' -Force; Get-Item -LiteralPath '${artifact.replaceAll("'", "''")}' | Select-Object Name | Out-String`
  : readCase === 'numbered' ? `cat -n ${bashQuote(bashArtifact)}` : readCase === 'relative' ? 'cat fixture.md' : readCase === 'relative-cd' ? 'cd . && cat fixture.md' : readCase === 'fallback' ? 'grep missing fixture.md 2>/dev/null || cat fixture.md' : readCase === 'cd-rg' ? 'cd child && rg -n SEARCH_TOKEN .' : readCase === 'relative-write' ? 'echo changed > fixture.md && cat fixture.md' : readCase === 'unconditional-file-delete' ? 'if true; then rm -f fixture.md; fi' : readCase === 'npm-task' ? 'npm run qa-fixture' : readCase === 'rg-text' ? `rg ${process.env.AGENTOC_QA_RG_GLOB === '1' ? "--hidden -g '*' " : process.env.AGENTOC_QA_RG_HIDDEN === '1' ? '-uu ' : ''}-n SEARCH_TOKEN .` : readCase === 'git-status' ? 'git status --short' : readCase === 'git-show' ? 'git show --stat HEAD' : readCase === 'git-log-format' ? "git log -1 --format='%h %s'" : readCase === 'git-diff-file' ? 'git diff HEAD -- fixture.md' : readCase === 'git-c-outside' ? `git -C ${bashQuote(bashGitRoot)} status --short` : `ls -lah ${bashQuote(bashRoot)}`;
const powershell = process.platform === 'win32' ? path.join(process.env.SystemRoot || process.env.WINDIR, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : '/usr/bin/unused-powershell';
const dotnetScript = `[System.IO.File]::WriteAllText('${artifact.replaceAll("'", "''")}', 'dotnet fixture'${process.env.AGENTOC_QA_DOTNET_ENCODING === '1' ? ', [System.Text.Encoding]::UTF8' : ''})`;
const dotnetCommand = `${bashQuote(powershell)} -NoProfile -NonInteractive -Command ${bashQuote(dotnetScript)}`;
const guidanceMarker = path.join(root, 'admin-command-ran.txt');
const guidanceAction = process.env.AGENTOC_QA_CLAUDE_ELEVATION_REGISTRY === '1'
  ? "Set-ItemProperty -LiteralPath 'HKLM:\\Software\\AgentoC-Nonexistent-Fixture' -Name Value -Value 1 -WhatIf"
  : "Start-Service -Name 'AgentoC-Nonexistent-Fixture'";
const guidanceScript = `${guidanceAction}; [System.IO.File]::WriteAllText('${guidanceMarker.replaceAll("'", "''")}', 'unexpected')`;
const guidanceCommand = `${bashQuote(powershell)} -NoProfile -NonInteractive -Command ${bashQuote(guidanceScript)}`;
let requests = 0;
let preflights = 0; let submissions = 0; let toolResultObserved = false; let guidanceObserved = false; let privateSearchObserved = false; let hiddenSearchObserved = false; let cwdMarkerCount = 0; let rootMarkerCount = 0;
let cliReads = 0;
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
      assert.equal(handled, true); assert.equal(status, isEvents ? 200 : 202);
      if (isApproval) {
        const current = await getRun(run.id); const response = current.appServerApprovalResponseQueue.find(entry => entry.approvalId === phoneApproval.approvalId);
        assert.equal(response?.decision, 'deny'); assert.equal(body?.approval?.decision, 'deny');
        if (phoneGroupCase) assert.equal(current.appServerApprovalResponseQueue.filter(entry => entry.decision === 'deny').length, 2);
        let writes = 0;
        const trackedProcess = { stdin: { writable: true, write(value) { writes += 1;
          if (phoneGroupCase && JSON.parse(String(value))?.response?.request_id === 'synthetic-group-request') return true;
          return child.stdin.write(value); } } };
        await flushClaudeBidiApprovalResponses(trackedProcess, gateState, current);
        await flushClaudeBidiApprovalResponses(trackedProcess, gateState, current);
        assert.equal(writes, phoneGroupCase ? 2 : 1, 'repeated queue scans must send one response per provider request');
        const delivered = (await getRun(run.id)).appServerApprovalResponseQueue.find(entry => entry.id === response.id);
        assert.equal(delivered?.state, 'sent'); assert.equal(delivered?.response?.response?.response?.behavior, 'deny'); phoneQueued = true;
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
        return;
      }
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    })().catch(error => { console.error(error); if (!res.headersSent) res.writeHead(500).end(); });
    return;
  }
  if (phoneQueueCase && req.method === 'GET' && req.url === '/fixture/status') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ queued: phoneQueued })); if (phoneQueued) resolvePhoneStatus(); return; }
  if (cliReadCase && req.method === 'GET' && req.url === '/api/triggers?sessionId=claude-local-fixture') {
    if (req.headers['x-agentoc-session-control-token'] !== 'fixture-token' || req.headers['x-agentoc-session-control-session-id'] !== 'claude-local-fixture') { res.writeHead(403).end(); return; }
    cliReads++; res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ triggers: [{ id: 'fixture-trigger' }] })); return;
  }
  if (req.method === 'GET' && req.url === '/fixture/read') { res.writeHead(200).end('local read fixture'); return; }
  let body = ''; req.setEncoding('utf8');
  req.on('data', (chunk) => { body += chunk; if (body.length > 4_000_000) req.destroy(); });
  req.on('end', () => {
    let request; try { request = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
    if (cliReadCase === 'asset' && req.method === 'POST' && req.url === '/api/sessions/claude-local-fixture/assets') {
      if (req.headers['x-agentoc-session-control-token'] !== 'fixture-token' || req.headers['x-agentoc-session-control-session-id'] !== 'claude-local-fixture' || request.localPath !== artifact) { res.writeHead(403).end(); return; }
      cliReads++; res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ asset: { assetId: 'fixture-asset' } })); return;
    }
    if (installCase && req.url === '/api/internal/approved-actions/propose' && req.method === 'POST') {
      if (req.headers['x-agentoc-approved-action-token'] !== 'fixture-token' || request.actions?.[0]?.command !== installCommand || request.runId !== run.id) { res.writeHead(400).end(); return; }
      if (request.autoInstallPreflight === true) { preflights++; res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ kind: 'automatic_install_preflight', ready: true })); }
      else { submissions++; res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ kind: 'automatic_install', status: 'succeeded' })); }
      return;
    }
    if (req.method !== 'POST' || !req.url.startsWith('/v1/messages')) { res.writeHead(404).end(); return; }
    requests++;
    if (process.env.AGENTOC_QA_TRACE_TASK_SCHEMAS === '1' && requests === 1) {
      process.stderr.write(`[fixture] task schemas: ${JSON.stringify((request.tools || []).filter(item => ['TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate'].includes(item.name)).map(({ name, input_schema }) => ({ name, input_schema })))}\n`);
    }
    if (process.env.AGENTOC_QA_TRACE_CLAUDE === '1') {
      const last = request.messages?.at(-1);
      process.stderr.write(`[fixture] model request ${requests}: ${JSON.stringify({ url: req.url, lastRole: last?.role, lastContentTypes: Array.isArray(last?.content) ? last.content.map(item => item.type) : [], toolNames: (request.tools || []).map(item => item.name), toolChoice: request.tool_choice })}\n`);
      if (readCase === 'cwd-change') process.stderr.write(`[fixture] tool results: ${JSON.stringify((request.messages || []).flatMap(message => Array.isArray(message.content) ? message.content.filter(block => block.type === 'tool_result').map(block => block.content) : []))}\n`);
      if (taskToolCase && requests > 1) process.stderr.write(`[fixture] task result: ${JSON.stringify((request.messages || []).flatMap(message => Array.isArray(message.content) ? message.content.filter(block => block.type === 'tool_result').map(block => block.content) : []))}\n`);
    }
    const tool = requests === 1 || ((cwdChangeCase || taskFollowup) && requests === 2);
    const toolName = (taskFollowup && requests === 1 ? 'TaskCreate' : taskToolCase) || (readCase === 'glob' ? 'Glob' : readCase === 'relative-file-tool' ? 'Read' : nativePowerShell ? 'PowerShell' : installCase || uninstallCase || deleteCase || dotnetCase || guidanceCase || readCase || cliReadCase === 'asset' ? 'Bash' : 'Write');
    if (tool && !request.tools?.some((item) => item.name === toolName)) { res.writeHead(400).end(); return; }
    if (!tool && installCase) toolResultObserved ||= JSON.stringify(request.messages || []).includes('Installation completed successfully');
    if (!tool && deleteCase) toolResultObserved ||= JSON.stringify(request.messages || []).includes('deleted');
    if (!tool && guidanceCase) guidanceObserved ||= JSON.stringify(request.messages || []).includes('agentoc_request_actions');
    if (!tool && phoneQueueCase) phoneToolResultObserved ||= (request.messages || []).some(message => Array.isArray(message.content) && message.content.some(item => item.type === 'tool_result'));
    if (!tool && cliReadCase) toolResultObserved ||= (request.messages || []).some(message => Array.isArray(message.content) && message.content.some(item =>
      item.type === 'tool_result' && item.tool_use_id === 'toolu_fixture_1' && item.is_error !== true && (cliReadCase === 'help' ? /(?:agentoc|ragent) trigger <command>/.test(JSON.stringify(item.content)) : JSON.stringify(item.content).includes(cliReadCase === 'asset' ? 'fixture-asset' : 'fixture-trigger'))));
    if (!tool && taskToolCase) toolResultObserved ||= (request.messages || []).some(message => Array.isArray(message.content)
      && message.content.some(item => item.type === 'tool_result' && item.tool_use_id === `toolu_fixture_${taskFollowup ? 2 : 1}` && item.is_error !== true
        && (!['TaskCreate', 'TaskGet'].includes(taskToolCase) || JSON.stringify(item.content).includes('Fixture task'))));
    if (!tool && ['unconditional-file-delete', 'conditional-write'].includes(readCase)) toolResultObserved ||= (request.messages || []).some(message =>
      Array.isArray(message.content) && message.content.some(item => item.type === 'tool_result' && item.tool_use_id === 'toolu_fixture_1' && item.is_error !== true));
    else if (!tool && readCase === 'git-log-format') toolResultObserved ||= (request.messages || []).some(message =>
      Array.isArray(message.content) && message.content.some(item => item.type === 'tool_result' && /\b[0-9a-f]{7,40} fixture\b/.test(JSON.stringify(item.content))));
    else if (!tool && readCase) toolResultObserved ||= JSON.stringify(request.messages || []).includes(cwdChangeCase ? 'CHILD_MARKER' : readCase === 'relative-write' ? 'changed' : readCase === 'npm-task' ? 'safe-task-fixture' : ['rg-text', 'cd-rg'].includes(readCase) ? 'SEARCH_TOKEN=public' : ['numbered', 'relative', 'relative-file-tool', 'relative-cd', 'fallback', 'curl', 'stderr-null'].includes(readCase) ? 'local read fixture' : 'fixture.md');
    if (!tool && cwdChangeCase) {
      const messages = JSON.stringify(request.messages || []);
      cwdMarkerCount = (messages.match(/CHILD_MARKER/g) || []).length;
      rootMarkerCount = (messages.match(/local read fixture/g) || []).length;
    }
    if (!tool && ['rg-text', 'cd-rg'].includes(readCase)) privateSearchObserved ||= JSON.stringify(request.messages || []).includes('SEARCH_TOKEN=private');
    if (!tool && readCase === 'rg-text') hiddenSearchObserved ||= JSON.stringify(request.messages || []).includes('SEARCH_TOKEN=hidden-public');
    if (!tool && readCase === 'cwd-change-rg') privateSearchObserved ||= JSON.stringify(request.messages || []).includes('CHILD_MARKER_PRIVATE');
    const message = { id: `msg_fixture_${requests}`, type: 'message', role: 'assistant', content: [], model: 'claude-sonnet-4-5', stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
    const events = [{ type: 'message_start', message }];
    if (tool) {
      const taskResult = taskFollowup && requests === 2 ? JSON.stringify(request.messages || []).match(/Task #(\d+) created successfully/) : null;
      if (taskFollowup && requests === 2 && !taskResult) { res.writeHead(400).end(); return; }
      const cliSuffix = cliReadCase === 'session' ? '--session $env:AGENTOC_SESSION_ID --json' : cliReadCase === 'source' ? '--source-session $env:AGENTOC_SESSION_ID --json' : cliReadCase === 'help' ? '--help' : '--json';
      const input = JSON.stringify(cliReadCase === 'asset' ? { command: `${['agentoc', 'ragent'].includes(assetPrefix) ? assetPrefix : `${assetPrefix === 'msys' ? 'MSYS_NO_PATHCONV=1 ' : ''}node "$AGENTOC_PROJECT_ROOT/cli.js"`} api POST ${assetPrefix === 'ragent' ? '/api/sessions/$AGENTOC_SESSION_ID/assets' : '"/api/sessions/$AGENTOC_SESSION_ID/assets"'} --body ${bashQuote(JSON.stringify({ localPath: artifact, originalName: 'fixture.md', mimeType: 'text/plain', text: 'fixture' }))}`, description: 'Publish isolated fixture' } : cliReadCase ? { command: `node "$env:AGENTOC_PROJECT_ROOT/cli.js" trigger list ${cliSuffix} | Out-String`, description: 'Read isolated trigger list' } : toolName === 'TaskList' ? {} : toolName === 'TaskCreate' ? { subject: 'Fixture task', description: 'Isolated test task' }
        : toolName === 'TaskGet' ? { taskId: taskResult[1] } : toolName === 'TaskUpdate' ? { taskId: taskResult[1], status: 'completed' } : installCase ? { command: installCommand, description: 'Fixture installation' } : uninstallCase
        ? { command: 'winget uninstall --id AgentoC.Nonexistent.Test.Fixture --exact', description: 'Fixture uninstall' } : deleteCase
        ? { command: deleteSteps ? (relativeDelete ? 'Remove-Item delete-extra.txt -Force; Remove-Item delete-fixture -Recurse -Force' : `Remove-Item '${extraFile.replaceAll("'", "''")}' -Force; Remove-Item '${deleteTarget.replaceAll("'", "''")}' -Recurse -Force`) : deleteList ? (relativeDelete ? 'Remove-Item -LiteralPath delete-fixture,delete-extra.txt -Recurse -Force' : `Remove-Item -LiteralPath '${deleteTarget.replaceAll("'", "''")}','${extraFile.replaceAll("'", "''")}' -Recurse -Force`) : relativeDelete ? (nativePowerShell ? 'Remove-Item -LiteralPath delete-fixture -Recurse -Force' : 'rm -rf delete-fixture') : deleteCommand, description: 'Delete fixture' }
        : dotnetCase ? { command: dotnetCommand, description: 'Write isolated fixture' }
        : guidanceCase ? { command: guidanceCommand, description: 'Administrative fixture' }
        : readCase === 'glob' ? { pattern: 'fixture.md' } : readCase === 'relative-file-tool' ? { file_path: path.relative(root, path.join(outsideReadRoot, 'fixture.md')) } : cwdChangeCase ? { command: requests === 1 ? 'cd child && cat fixture.md' : readCase === 'cwd-change-rg' ? 'rg -n CHILD_MARKER .' : 'cat fixture.md', description: 'Read isolated fixture' } : readCase ? { command: readCommand, description: 'Read isolated fixture' } : { file_path: artifact, content: 'local fixture\n' });
      events.push({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_fixture_${requests}`, name: toolName, input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: input } });
    } else events.push({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Fixture completed.' } });
    events.push({ type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }, { type: 'message_stop' });
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
});
await new Promise((resolve) => server.listen(phoneQueueCase ? 18667 : cliReadCase ? 18669 : 0, '127.0.0.1', resolve));
if (readCase === 'curl') readCommand = `curl -fsS http://127.0.0.1:${server.address().port}/fixture/read`;
const env = { ...process.env, HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root,
  XDG_CACHE_HOME: path.join(root, 'cache'), XDG_CONFIG_HOME: path.join(root, 'xdg-config'),
  CLAUDE_CONFIG_DIR: config, ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
  ANTHROPIC_API_KEY: 'fixture', DISABLE_TELEMETRY: '1', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost',
  http_proxy: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9', all_proxy: 'http://127.0.0.1:9', no_proxy: '127.0.0.1,localhost' };
delete env.ANTHROPIC_AUTH_TOKEN;
const mode = ['full-auto', 'conservative-auto'].includes(process.env.AGENTOC_QA_MODE) ? process.env.AGENTOC_QA_MODE : 'recommended';
const boundContext = process.env.AGENTOC_QA_BOUND_CONTEXT === '1'
  ? await (await import('./fixtures/windows-admitted-context.mjs')).admittedWindowsContext(root, 'claude-local-fixture') : null;
const fixtureSessionId = phoneQueueCase ? phoneSessionId : 'claude-local-fixture';
const run = await createRun({ status: { sessionId: fixtureSessionId, requestId: 'fixture', state: 'running', tool: 'claude' },
  manifest: { sessionId: fixtureSessionId, requestId: 'fixture', folder: root, tool: 'claude', runtimeFamily: 'claude-stream-json-bidi', prompt: 'fixture', options: { riskMode: 'recommended', permissionMode: 'default' } } });
if (phoneQueueCase) await mutateSessionMeta(phoneSessionId, row => { row.activeRunId = run.id; return true; });
const gateState = { riskMode: mode, permissionMode: 'default', cwd: root, projectRoot: root, turnActive: true, requestId: 'fixture', approvalTurnSequence: 1, approvalProcessId: 'fixture-process', riskContextValid: boundContext?.valid ?? true,
  riskContext: boundContext?.riskContext ?? { platform: process.platform, trustedWorkspaceRoot: root, protectedRoots: protectedCase ? [protectedRoot] : [] }, pendingApprovals: new Map(), sentApprovalResponseIds: new Set(), autoApprovedMcpRequestIds: new Set() };
let cliReadHelperPath = '';
if (cliReadCase) {
  const source = process.env.AGENTOC_TEST_INSTALLED_PAYLOAD, helper = process.env.AGENTOC_TEST_CLI_READ_BINARY;
  if (!path.isAbsolute(source || '') || !path.isAbsolute(helper || '')) throw new Error('CLI fixture requires absolute isolated payload and helper inputs');
  const payload = path.join(root, 'cli-payload'); await mkdir(path.join(payload, 'bin'), { recursive: true });
  await copyFile(path.join(source, 'node.exe'), path.join(payload, 'node.exe'));
  await Promise.all(['cli.js', 'package.json'].map(file => copyFile(path.join(source, file), path.join(payload, file))));
  await cp(path.join(source, 'lib'), path.join(payload, 'lib'), { recursive: true });
  cliReadHelperPath = path.join(payload, 'bin', 'agentoc-cli-read-bridge.exe'); await copyFile(helper, cliReadHelperPath);
  Object.assign(env, { AGENTOC_SESSION_ID: 'claude-local-fixture', AGENTOC_SESSION_CONTROL_SESSION_ID: 'claude-local-fixture',
    AGENTOC_SESSION_CONTROL_RUN_ID: run.id, AGENTOC_SESSION_CONTROL_TURN_ID: 'fixture-turn', AGENTOC_SESSION_CONTROL_TOKEN: 'fixture-token' });
  gateState.sessionControlReadAvailable = true; gateState.sessionControlReadRunId = run.id;
}
if (installCase || uninstallCase || deleteCase || dotnetCase || guidanceCase || readCase || cliReadCase === 'asset') env.CLAUDE_CODE_GIT_BASH_PATH = process.env.AGENTOC_TEST_BASH_BINARY;
if (nativePowerShell) env.CLAUDE_CODE_USE_POWERSHELL_TOOL = '1';
if (guidanceCase) {
  gateState.windowsManagedActionChannel = true;
  gateState.windowsManagedActionBinding = { runId: run.id };
}
if (installCase) {
  const endpoint = `http://127.0.0.1:${server.address().port}/api/internal/approved-actions/propose`;
  Object.assign(env, { CLAUDE_CODE_GIT_BASH_PATH: process.env.AGENTOC_TEST_BASH_BINARY,
    AGENTOC_APPROVED_ACTIONS_ENDPOINT: endpoint, AGENTOC_APPROVED_ACTIONS_TOKEN: 'fixture-token',
    AGENTOC_APPROVED_ACTIONS_SESSION_ID: 'claude-local-fixture', AGENTOC_APPROVED_ACTIONS_RUN_ID: run.id, AGENTOC_APPROVED_ACTIONS_TURN_ID: 'fixture-turn' });
  gateState.windowsManagedActionChannel = true;
  gateState.windowsManagedActionBinding = { endpoint, token: 'fixture-token', sessionId: 'claude-local-fixture', runId: run.id, turnId: 'fixture-turn' };
}
const cliArgs = buildClaudeBidiArgs({ permissionMode: 'default', model: 'claude-sonnet-4-5', maxTurns: cwdChangeCase || taskFollowup ? 3 : 2, forceClaudeCommandGate: askAll });
if (readCase === 'relative-file-tool' || taskToolCase) {
  const index = cliArgs.indexOf('--settings');
  if (index < 0) throw new Error('relative file tool fixture requires the gate settings');
  const settings = JSON.parse(cliArgs[index + 1]); settings.permissions.ask.push(taskToolCase || 'Read');
  if (taskFollowup) settings.permissions.ask.push('TaskCreate');
  cliArgs[index + 1] = JSON.stringify(settings);
}
const spawnSpec = buildPlatformSpawnSpec(binary, cliArgs, { cwd: root, env });
const child = spawn(spawnSpec.file, spawnSpec.args, {
  cwd: root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
  ...(spawnSpec.windowsVerbatimArguments === undefined ? {} : { windowsVerbatimArguments: spawnSpec.windowsVerbatimArguments }),
});
let errors = ''; child.stderr.on('data', (chunk) => { errors = (errors + String(chunk)).slice(-6000); });
let approvals = 0; let terminal = null; let handlerFailure = null;
const output = createInterface({ input: child.stdout });
const completed = new Promise((resolve, reject) => {
  const timer = setTimeout(() => { child.kill(); reject(new Error(`Claude fixture timed out: ${errors}`)); }, phoneQueueCase ? 240000 : 45000);
  child.on('error', (error) => { clearTimeout(timer); reject(error); });
  child.on('exit', (code) => { clearTimeout(timer); resolve(code); });
});
output.on('line', (line) => {
  void (async () => {
    let event; try { event = JSON.parse(line); } catch { return; }
    await observeClaudePosixCwdResult(gateState, event);
    if (process.env.AGENTOC_QA_TRACE_CLAUDE === '1') {
      process.stderr.write(`[fixture] CLI event: ${JSON.stringify({ type: event.type, subtype: event.subtype || event.request?.subtype, toolName: event.request?.tool_name || event.name, toolUseName: event.message?.content?.find?.(item => item.type === 'tool_use')?.name })}\n`);
      if (readCase === 'cwd-change' && event.type === 'user') process.stderr.write(`[fixture] tool result metadata: ${JSON.stringify({ keys: Object.keys(event), content: event.message?.content, toolUseResult: event.tool_use_result, meta: event.tool_result_meta })}\n`);
    }
    const approval = readClaudeBidiApprovalRequest(event);
    if (approval) {
      if (process.env.AGENTOC_QA_TRACE_CLAUDE === '1' && readCase === 'cwd-change') process.stderr.write(`[fixture] gate metadata: ${JSON.stringify({ requestId: approval.providerRequestId, toolUseId: approval.params?.tool_use_id })}\n`);
      approvals++;
      // Never let a regression execute the uninstall, even for the nonexistent
      // package: only a deny response can reach the real CLI in this fixture.
      const gatedChild = uninstallCase || (readCase === 'select-string' && process.env.AGENTOC_QA_SEARCH_GLOB === '1') ? { stdin: { writable: true, write(value) {
        const response = JSON.parse(String(value));
        if (uninstallCase) assert.equal(response?.response?.response?.behavior, 'deny', 'uninstall must never be auto-approved');
        else {
          const result = response?.response?.response;
          assert.equal(result?.behavior, 'allow', 'ordinary wildcard search must be approved');
          assert.match(result?.updatedInput?.command || '', /agentoc-safe-search\.exe.*--request/i);
          assert.doesNotMatch(result?.updatedInput?.command || '', /\*/);
        }
        return child.stdin.write(value);
      } } } : child;
      await trackClaudeBidiApprovalRequest(run.id, gateState, event, gatedChild, deleteCase ? { safeDeleteHelperPath: safeDeleteHelper } : cliReadCase ? { cliReadHelperPath } :
        process.env.AGENTOC_QA_SAFE_SEARCH_HELPER ? { searchHelperPath: process.env.AGENTOC_QA_SAFE_SEARCH_HELPER } : {});
      if (process.env.AGENTOC_QA_TRACE_CLAUDE === '1') {
        const current = await getRun(run.id);
        const pending = current.appServerPendingApprovals?.find((item) => item.approvalId === approval.approvalId);
        process.stderr.write(`[fixture] gate outcome: ${JSON.stringify({ pending: Boolean(pending), riskReasonCodes: pending?.riskReasonCodes, riskTier: pending?.riskTier })}\n`);
      }
      if (readCase === 'git-status' && mode === 'recommended') {
        const current = await getRun(run.id);
        assert.ok(!current.appServerPendingApprovals?.some((item) => item.approvalId === approval.approvalId),
          'read-only git status must not create a phone approval');
      }
      if (reviewCase && mode === 'recommended') {
        const current = await getRun(run.id);
        assert.ok(current.appServerPendingApprovals?.some((item) => item.approvalId === approval.approvalId), 'protected operation must wait for the owner');
        if (phoneQueueCase) {
          phoneApprovals.push(approval); phoneApproval ||= approval; await appendRunSpoolRecord(run.id, { stream: 'stdout', json: event });
          if (phoneGroupCase) {
            const duplicate = { ...event, request_id: 'synthetic-group-request', request: { ...event.request, tool_use_id: 'synthetic-group-tool' } };
            await trackClaudeBidiApprovalRequest(run.id, gateState, duplicate, gatedChild);
            phoneApprovals.push(readClaudeBidiApprovalRequest(duplicate));
            await appendRunSpoolRecord(run.id, { stream: 'stdout', json: duplicate });
          }
          if (phoneApprovals.length === (phoneGroupCase ? 2 : 1)) {
            const history = await getHistory(phoneSessionId);
            assert.ok(history.some(item => item.type === 'approval_request' && item.approvalId === phoneApproval.approvalId));
            if (phoneGroupCase) assert.equal(history.filter(item => item.type === 'approval_request').length, 1, 'matching pending requests must share one card');
            console.log('SAMSUNG_CLAUDE_PROVIDER_READY');
          }
        } else child.stdin.write(serializeClaudeBidiMessage(buildClaudeBidiApprovalResponseMessage(approval, 'deny')));
      }
    }
    if (event.type === 'result') { terminal = event; child.stdin.end(); }
  })().catch((error) => { handlerFailure = error; child.kill(); });
});
child.stdin.write(serializeClaudeBidiMessage(buildClaudeBidiInitializeMessage('fixture-init')));
child.stdin.write(serializeClaudeBidiMessage(buildClaudeBidiUserMessage({ text: 'Write the requested fixture.' })));
try {
  const code = await completed;
  if (phoneQueueCase) await Promise.race([phoneStatusObserved, new Promise((_, reject) => { const timeout = setTimeout(() => reject(new Error('phone did not observe delivery status')), 30000); timeout.unref(); })]);
  if (handlerFailure) throw handlerFailure;
  assert.equal(code, 0, `Claude exited unexpectedly: ${errors}`);
  if (readCase) assert.ok(approvals <= (cwdChangeCase ? 2 : 1), 'read fixture must not emit unnecessary approvals');
  else assert.equal(approvals, taskFollowup ? 2 : 1, 'real Claude must emit the expected approval requests');
  assert.ok(terminal && !terminal.is_error, 'Claude must finish the turn');
  if (installCase) {
    assert.ok(preflights >= 1, 'sidecar must preflight the controlled install');
    assert.equal(submissions, 1, 'only the mock control service may receive the install request');
    assert.ok(toolResultObserved, 'actual Claude must receive the bridge result');
  } else if (deleteCase) {
    if (reviewCase) assert.equal(await readFile(path.join(deleteTarget, 'fixture.txt'), 'utf8'), 'deletable fixture');
    else await assert.rejects(access(deleteTarget), { code: 'ENOENT' });
    if (deleteList && !reviewCase) await assert.rejects(access(extraFile), { code: 'ENOENT' });
    assert.equal(await readFile(keepFile, 'utf8'), 'keep fixture');
    if (!reviewCase) assert.ok(toolResultObserved, 'actual Claude must receive the safe deletion result');
  } else if (guidanceCase) {
    await assert.rejects(access(guidanceMarker), { code: 'ENOENT' });
    assert.ok(guidanceObserved, 'real Claude must receive managed executor guidance');
  } else if (readCase) {
    if (readCase === 'unconditional-file-delete') await assert.rejects(access(artifact), { code: 'ENOENT' });
    else if (readCase === 'system-copy') assert.deepEqual(await readFile(artifact), await readFile(path.join(process.env.SystemRoot, 'win.ini')));
    else assert.equal((await readFile(artifact, 'utf8')).replaceAll('\r\n', '\n'), readCase === 'relative-write' ? 'changed\n' : ['git-diff-file', 'conditional-write', 'output-filters'].includes(readCase) ? 'changed fixture\n' : readCase === 'rg-text' ? 'local read fixture\nSEARCH_TOKEN=public\n' : 'local read fixture\n');
    if (['rg-text', 'cd-rg'].includes(readCase)) assert.equal(privateSearchObserved, false, 'sensitive file contents must not be included in the search result');
    if (readCase === 'rg-text' && process.env.AGENTOC_QA_RG_HIDDEN === '1') assert.equal(hiddenSearchObserved, true, 'ordinary hidden file must remain searchable');
    if (readCase === 'relative-write') assert.equal(approvals, 1, 'real Claude must exercise the relative-operation approval callback');
    if (readCase === 'unconditional-file-delete') assert.equal(approvals, 1, 'real Claude must exercise the conditional deletion approval callback');
    if (readCase === 'stderr-null') assert.equal(approvals, 1, 'real Claude must exercise the PowerShell null-redirection approval callback');
    if (readCase === 'conditional-write') assert.equal(approvals, 1, 'real Claude must exercise the conditional write approval callback');
    if (readCase === 'output-filters') assert.equal(approvals, 1, 'real Claude must exercise the PowerShell output filter approval callback');
    if (readCase === 'where-filter') assert.equal(approvals, 1, 'real Claude must exercise the PowerShell filter approval callback');
    if (readCase === 'system-copy') assert.equal(approvals, 1, 'real Claude must exercise the system copy approval callback');
    if (readCase === 'select-string') assert.equal(approvals, 1, 'real Claude must exercise the Select-String approval callback');
    if (readCase === 'rg-text' && askAll) assert.equal(approvals, 1, 'ask rule must route the search through Ragent');
    if (readCase === 'git-diff-file' && askAll) assert.equal(approvals, 1, 'ask rule must route the file diff through Ragent');
    if (readCase === 'git-log-format' && askAll) assert.equal(approvals, 1, 'ask rule must route the formatted log through Ragent');
    if (readCase === 'fallback' && askAll) assert.equal(approvals, 1, 'ask rule must route the fallback command through Ragent');
    if (readCase === 'cd-rg' && askAll) assert.equal(approvals, 1, 'ask rule must route the directory search through Ragent');
    if (readCase === 'git-c-outside' && askAll) assert.equal(approvals, 1, 'ask rule must route the outside Git query through Ragent');
    if (readCase === 'relative-file-tool') assert.equal(approvals, 1, 'fixture must exercise the file-tool approval callback');
    assert.ok(toolResultObserved, 'actual Claude must receive the read result');
    if (cwdChangeCase) assert.ok(process.platform === 'win32' ? cwdMarkerCount >= 1 && rootMarkerCount >= 1 : cwdMarkerCount >= 2,
      'both commands must succeed with the provider working-directory behavior');
    if (cwdChangeCase && process.platform !== 'win32') assert.equal(gateState.cwd, await realpath(path.join(root, 'child')));
    if (readCase === 'cwd-change-rg') assert.equal(privateSearchObserved, false, 'subsequent search must not return sensitive file contents');
    if (readCase === 'git-status') assert.equal(approvals, 0, 'Claude Code should not emit an approval request for read-only git status');
  } else if (cliReadCase) { assert.ok(toolResultObserved, 'actual Claude must return the CLI result'); assert.equal(cliReads, cliReadCase === 'help' ? 0 : 1); }
  else if (taskToolCase) assert.ok(toolResultObserved, 'actual Claude must return a successful task tool result');
  else if (protectedCase || conservativeOutside || uninstallCase) await assert.rejects(access(artifact), { code: 'ENOENT' });
  else assert.equal((await readFile(artifact, 'utf8')).replace(/^\uFEFF/, ''), dotnetCase ? 'dotnet fixture' : 'local fixture\n');
  assert.ok(requests >= 2, 'local model must receive the tool result');
  if (phoneQueueCase) { assert.equal(phoneQueued, true); assert.equal(phoneToolResultObserved, true, 'real Claude must return the denied tool result to the local model'); }
  const spool = await readRunSpoolRecords(run.id);
  if (deleteCase && !reviewCase) assert.ok(spool.some((record) => record.json?.reason === 'handle-bound workspace deletion'), 'actual sidecar must use the handle-bound deletion helper');
  else if (guidanceCase) assert.ok(spool.some((record) => record.json?.type === 'agentoc.approval_response' && record.json?.autoDenied === true && record.json?.reason?.includes('agentoc_request_actions')), 'actual sidecar must persist managed executor guidance');
  else if (readCase === 'git-status' && approvals > 0) assert.ok(spool.some((record) => record.json?.type === 'agentoc.approval_response' && record.json?.autoApproved === true), 'a surfaced read-only Git request must be automatically approved');
  else if (!reviewCase && (!readCase || approvals) && readCase !== 'git-status') assert.ok(spool.some((record) => record.json?.type === 'agentoc.approval_response' && record.json?.autoApproved === true), 'actual sidecar must persist the automatic decision');
  else if (reviewCase && mode !== 'recommended') assert.ok(spool.some((record) => record.json?.type === 'agentoc.approval_response' && record.json?.autoDenied === true), 'unattended protected write must be denied');
  console.log(`claude-windows-local-gate: ${mode} real CLI${nativePowerShell ? ' native PowerShell' : ''} ${cliReadCase ? `${cliReadCase === 'asset' ? 'asset publication' : `trigger ${cliReadCase}`} completed` : taskToolCase ? `${taskToolCase} completed` : installCase ? 'controlled install reached mock service' : reviewCase ? 'dangerous operation denied' : deleteCase ? 'handle-bound fixture deletion completed' : guidanceCase ? 'managed executor guidance received' : readCase ? `${readCase} ${approvals ? 'approval observed' : 'read completed without approval request'}` : dotnetCase ? 'trusted PowerShell wrapped file write completed' : outsideFileCase ? 'outside-workspace file write completed' : 'file approval completed'}`);
} finally {
  child.kill(); output.close(); await new Promise((resolve) => server.close(resolve));
  const parent = path.resolve(os.tmpdir()).toLowerCase();
  for (const [target, prefix] of [[root, 'agentoc-claude-local-gate-'], [separateInstance, 'agentoc-claude-instance-'], [outsideRoot, 'agentoc-claude-outside-'], [outsideFileRoot, 'agentoc-claude-outside-file-'], [outsideGitRoot, 'agentoc-claude-outside-git-'], [outsideReadRoot, 'agentoc-claude-outside-read-']]) {
    if (!target) continue;
    const resolved = path.resolve(target);
    if (path.dirname(resolved).toLowerCase() !== parent || !path.basename(resolved).startsWith(prefix)) throw new Error('unsafe fixture cleanup target');
    await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
