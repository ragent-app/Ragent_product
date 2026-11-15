import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';

if (process.platform !== 'win32') { console.log('windows-user-install-admission: skipped (Windows only)'); process.exit(0); }
const root = await mkdtemp(path.join(os.tmpdir(), 'ragent-user-install-admission-'));
process.env.HOME = root;
process.env.USERPROFILE = root;
process.env.LOCALAPPDATA = path.join(root, 'local');
process.env.APPDATA = path.join(root, 'roaming');
process.env.RAGENT_INSTANCE_ROOT = path.join(root, 'instance');
process.env.RAGENT_CONFIG_DIR = path.join(root, 'instance', 'config');
process.env.RAGENT_MEMORY_DIR = path.join(root, 'instance', 'memory');
process.env.RAGENT_WORK_ROOT_DIR = path.join(root, 'instance', 'workspace');
process.env.RAGENT_PROVIDER_HOMES_DIR = path.join(root, 'instance', 'provider-homes');
process.env.RAGENT_RUN_SPOOL_DIR = path.join(root, 'instance', 'data', 'chat-runs');
const fullFixture = process.env.RAGENT_QA_USER_INSTALL_FULL === '1';
const fakeWinget = path.join(root, 'winget.exe');
if (fullFixture) {
  const source = path.join(root, 'fake-winget.go');
  await writeFile(source, `package main\nimport ("fmt";"os")\nfunc main(){if len(os.Args)>1 && os.Args[1]=="source" {fmt.Println(\x60{"Name":"winget","Type":"Microsoft.PreIndexed.Package","Identifier":"Microsoft.Winget.Source_8wekyb3d8bbwe","TrustLevel":["Trusted"],"Arg":"https://cdn.winget.microsoft.com/cache"}\x60);return};if len(os.Args)>1 && os.Args[1]=="show" {fmt.Println("Found Fixture [Vendor.App]\\nVersion\\n-------\\n1.2.3");return};os.Exit(17)}\n`);
  await promisify(execFile)('go', ['build', '-o', fakeWinget, source], { cwd: root, windowsHide: true });
  process.env.RAGENT_WINGET_EXECUTABLE = fakeWinget;
}
const { createSession, proposeApprovedActions, killAll } = await import('../chat/session-manager.mjs');
const { createRun } = await import('../chat/runs.mjs');
const { bindWindowsRunExecutionIdentity } = await import('../chat/windows-run-identity.mjs');
const { loadOrCreateInstanceIdentity } = await import('../lib/instance-identity.mjs');
const { loadWindowsAutoInstallPublicIdentity } = await import('../chat/windows-managed-auto-install.mjs');
const { runWindowsUserInstallBridge } = await import('../chat/windows-user-install-bridge.mjs');
const { executeWindowsUserInstall } = await import('../chat/windows-user-install-executor.mjs');
const { revalidateWindowsUserWingetInstall } = await import('../chat/semantic-windows-adapter.mjs');
const { runWindowsInstallBridge } = await import('../scripts/ragent-windows-install-bridge.mjs');
const { trackClaudeBidiApprovalRequest } = await import('../chat/runner-sidecar.mjs');
const digest = (value) => createHash('sha256').update(value).digest('hex');
try {
  const session = await createSession(root, 'codex', 'fixture', { riskMode: 'recommended' });
  const token = 'fixture-token';
  const run = await createRun({ status: { sessionId: session.id, state: 'running', windowsExecutionSid: 'S-1-5-21-1-2-3-4' },
    manifest: { sessionId: session.id, folder: root, tool: 'codex', options: { approvedActionChannel: {
      tokenHash: digest(token), turnId: 'turn-1', authenticatedPrincipalKind: 'owner',
    } } } });
  const request = { token, tokenMatches: (provided, hash) => digest(provided) === hash, sessionId: session.id,
    runId: run.id, turnId: 'turn-1', requestKey: 'gate:fixture', actions: [{ command: 'winget install Vendor.App --scope user' }],
    autoInstallUserAuthorization: true };
  await assert.rejects(proposeApprovedActions({ ...request, token: 'wrong' }), { code: 'APPROVED_ACTION_TOKEN_INVALID' });
  await assert.rejects(proposeApprovedActions({ ...request, turnId: 'other' }), { code: 'APPROVED_ACTION_BINDING_MISMATCH' });
  await assert.rejects(proposeApprovedActions({ ...request, autoInstallPreflight: true }), { code: 'AUTO_INSTALL_REQUEST_INVALID' });
  await assert.rejects(proposeApprovedActions(request), { code: 'USER_INSTALL_IDENTITY_UNAVAILABLE' });
  if (fullFixture) {
    await loadOrCreateInstanceIdentity();
    const pinnedIdentity = await loadWindowsAutoInstallPublicIdentity();
    const testSid = 'S-1-5-21-1-2-3-4';
    for (const mode of ['recommended', 'full-auto']) {
    const serviceSession = await createSession(root, 'codex', `fixture-service-${mode}`, { riskMode: mode });
    const serviceRun = await createRun({ status: { sessionId: serviceSession.id, state: 'running' },
      manifest: { sessionId: serviceSession.id, folder: root, tool: 'codex', options: { approvedActionChannel: {
        tokenHash: digest(token), turnId: 'turn-service', authenticatedPrincipalKind: 'owner', windowsUserInstallIdentity: pinnedIdentity,
      } } } });
    await bindWindowsRunExecutionIdentity(serviceRun.id, { sid: testSid, isService: true });
    const serviceRequest = { token, tokenMatches: request.tokenMatches, sessionId: serviceSession.id, runId: serviceRun.id,
      turnId: 'turn-service', requestKey: 'gate:service', actions: [{ command: 'winget install Vendor.App --scope user' }] };
    assert.equal((await proposeApprovedActions({ ...serviceRequest, autoInstallPreflight: true })).ready, false);
    await assert.rejects(proposeApprovedActions({ ...serviceRequest, autoInstallUserAuthorization: true }), { code: 'USER_INSTALL_AUTHORIZATION_UNAVAILABLE' });
    }
    for (const mode of ['recommended', 'full-auto']) for (const scope of ['', 'user', 'user-inline', 'user-alias', 'user-query']) {
    const installSession = await createSession(root, 'codex', `fixture-${mode}-${scope}`, { riskMode: mode });
    const fullRun = await createRun({ status: { sessionId: installSession.id, state: 'running' },
      manifest: { sessionId: installSession.id, folder: root, tool: 'codex', options: { approvedActionChannel: {
        tokenHash: digest(token), turnId: 'turn-full', authenticatedPrincipalKind: 'owner', windowsUserInstallIdentity: pinnedIdentity,
      } } } });
    await bindWindowsRunExecutionIdentity(fullRun.id, { sid: testSid });
    const approvalId = 'claude:install-user';
    const binding = { sessionId: installSession.id, runId: fullRun.id, turnId: 'turn-full', requestKey: `gate:${digest(JSON.stringify([fullRun.id, approvalId]))}` };
    const base = { ...binding, token, tokenMatches: (provided, hash) => digest(provided) === hash,
      actions: [{ command: scope === 'user-query' ? 'winget add --query=Vendor.App --scope user' : scope === 'user-alias' ? 'winget add --id Vendor.App --scope user' : scope === 'user-inline' ? 'winget install --id=Vendor.App --source=winget --scope=user'
        : `winget install Vendor.App${scope ? ' --scope user' : ''}` }] };
    assert.equal((await proposeApprovedActions({ ...base, autoInstallPreflight: true })).ready, true);
    const issued = await proposeApprovedActions(base);
    assert.equal(issued.kind, 'automatic_user_install_authorization');
    const serviceResult = await executeWindowsUserInstall({ capability: issued.capability, binding, riskMode: mode,
      publicKey: pinnedIdentity.publicKey, cwd: root, expectedOwnerSid: testSid, platform: 'win32' }, {
      assertIdentity: async () => ({ sid: testSid, isService: true }),
      assertActive: async () => { throw new Error('service identity must be rejected first'); },
      claim: async () => { throw new Error('service identity must not claim'); }, finish: async () => {},
    });
    assert.equal(serviceResult.code, 'USER_INSTALL_IDENTITY_OR_RUN_INVALID');
    await assert.rejects(proposeApprovedActions({ ...base, autoInstallUserClaim: true,
      userInstallCapability: { ...issued.capability, windowsExecutionSid: 'S-1-5-21-1-2-3-5' } }), { code: 'USER_INSTALL_AUTHORIZATION_INVALID' });
    let installs = 0;
    const execFixture = async (file, args, options) => {
      if (args[0] === 'install') { installs += 1; assert.equal(args.includes('--scope'), Boolean(scope)); return { stdout: 'fixture' }; }
      return promisify(execFile)(file, args, options);
    };
    const server = createServer((req, res) => {
      let data = '';
      req.on('data', (chunk) => { data += chunk; });
      req.on('end', async () => {
        try {
          const payload = JSON.parse(data);
          const value = await proposeApprovedActions({ ...payload, token: req.headers['x-ragent-approved-action-token'], tokenMatches: base.tokenMatches });
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value));
        } catch (error) { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ code: error.code || 'fixture-error', error: error.message })); }
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const endpoint = `http://127.0.0.1:${server.address().port}/api/internal/approved-actions/propose`;
      const sent = [];
      const state = { riskMode: mode, cwd: root, turnActive: true, riskContextValid: true,
        riskContext: { trustedWorkspaceRoot: root, protectedRoots: [] }, pendingApprovals: new Map(), autoApprovedMcpRequestIds: new Set(),
        windowsManagedActionChannel: true, windowsManagedActionBinding: { ...binding, endpoint, token, windowsUserInstallIdentity: pinnedIdentity } };
      const toolRequest = { type: 'control_request', request_id: 'install-user', request: { subtype: 'can_use_tool',
        tool_name: scope ? 'Bash' : 'PowerShell', input: { command: base.actions[0].command } } };
      await trackClaudeBidiApprovalRequest(fullRun.id, state, toolRequest, { stdin: { writable: true, write(value) { sent.push(JSON.parse(value)); return true; } } });
      assert.equal(sent[0]?.response?.response?.behavior, 'allow');
      const rewritten = sent[0].response.response.updatedInput.command;
      const encoded = /'([A-Za-z0-9_-]+)'$/.exec(rewritten)?.[1];
      assert.ok(encoded, 'the approved command must contain the bound bridge request');
      assert.deepEqual(JSON.parse(Buffer.from(encoded, 'base64url').toString()).windowsUserInstallIdentity, pinnedIdentity);
      let output = '';
      await runWindowsInstallBridge({ argv: ['', '', encoded], env: {
        RAGENT_APPROVED_ACTIONS_ENDPOINT: endpoint,
        RAGENT_APPROVED_ACTIONS_TOKEN: token, RAGENT_APPROVED_ACTIONS_SESSION_ID: binding.sessionId,
        RAGENT_APPROVED_ACTIONS_RUN_ID: binding.runId, RAGENT_APPROVED_ACTIONS_TURN_ID: binding.turnId,
      }, writeOutput: (text) => { output += text; },
      runUser: (options) => runWindowsUserInstallBridge(options, {
        execute: (execOptions, deps) => executeWindowsUserInstall(execOptions, { ...deps, assertIdentity: async () => ({ sid: testSid }), execFile: execFixture,
          revalidate: (cap, opts) => revalidateWindowsUserWingetInstall(cap, { ...opts, resolveExecutable: async () => fakeWinget }) }),
      }) });
      assert.match(output, /completed successfully/);
    } finally { await new Promise((resolve) => server.close(resolve)); }
    assert.equal(installs, 1);
    const duplicate = await runWindowsUserInstallBridge({ capability: issued.capability, pinnedIdentity, binding, cwd: root,
      request: (extra) => proposeApprovedActions({ ...base, ...extra }) }, {
      execute: (options, deps) => executeWindowsUserInstall(options, { ...deps, assertIdentity: async () => ({ sid: testSid }), execFile: execFixture,
        revalidate: (cap, opts) => revalidateWindowsUserWingetInstall(cap, { ...opts, resolveExecutable: async () => fakeWinget }) }),
    });
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.status, 'succeeded');
    assert.equal(installs, 1);
    assert.equal((await proposeApprovedActions({ ...base, autoInstallStatusOnly: true })).status, 'succeeded');
    }
    console.log('windows-user-install-admission: signed authorization, claim, mock execution and result passed');
  }
  console.log('windows-user-install-admission: binding and pinned-key checks passed');
} finally {
  await Promise.resolve(killAll?.()).catch(() => {});
  const actualRoot = await realpath(root);
  const actualParent = await realpath(os.tmpdir());
  assert.equal(path.dirname(actualRoot).toLowerCase(), actualParent.toLowerCase());
  assert.ok(path.basename(actualRoot).startsWith('ragent-user-install-admission-'));
  await rm(actualRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
