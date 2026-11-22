#!/usr/bin/env node
// Stage 4 S4.1 Device Mesh & Transfer Acceptance Suite:
// Exercises durable Device Capability Registry, heartbeat staleness,
// owner ∩ binding policy routing, dual-instance Remote Factory 3-state offline
// handling (not_dispatched / dispatched_unconfirmed / executed_unsynced + review),
// manifest-backed chunked large-file & directory bundle transfers with tamper/
// symlink/path-traversal rejection, unknown_outcome reconciliation without blind
// resend, and default-off feature gates.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE_TEMP = process.env.RAGENT_TEST_TMPDIR || process.env.TMPDIR || process.env.TEMP || tmpdir();
mkdirSync(BASE_TEMP, { recursive: true });
const tempRoot = mkdtempSync(join(BASE_TEMP, 'ragent-stage4-mesh-'));

const sourceRoot = join(tempRoot, 'source');
const sourceInstanceRoot = join(sourceRoot, 'instance');
const sourceConfigDir = join(sourceInstanceRoot, 'config');
const sourceDataDir = join(sourceInstanceRoot, 'data');
const sourceWorkRootDir = join(sourceInstanceRoot, 'workspace');
const sourceMemoryDir = join(sourceInstanceRoot, 'memory');
const sourceRepoDir = join(sourceRoot, 'repo');

const targetRoot = join(tempRoot, 'target');
const targetInstanceRoot = join(targetRoot, 'instance');
const targetConfigDir = join(targetInstanceRoot, 'config');
const targetDataDir = join(targetInstanceRoot, 'data');
const targetWorkRootDir = join(targetInstanceRoot, 'workspace');
const targetMemoryDir = join(targetInstanceRoot, 'memory');
const targetRepoDir = join(targetRoot, 'repo');

const harnessRoot = join(tempRoot, 'harnesses');
const harnessBin = join(harnessRoot, 'codex', 'node_modules', '.bin');

const OWNER_ID = 'owner-stage4-mesh';
const ACCOUNT_ID = 'acct_stage4_mesh';
const DEVICE_ID = 'rdev_stage4_mesh';

for (const dir of [
  sourceConfigDir, sourceDataDir, sourceWorkRootDir, sourceMemoryDir,
  targetConfigDir, targetDataDir, targetWorkRootDir, targetMemoryDir,
  join(sourceRoot, 'localappdata'), join(sourceRoot, 'appdata'),
  join(targetRoot, 'localappdata'), join(targetRoot, 'appdata'),
  harnessBin,
]) {
  mkdirSync(dir, { recursive: true });
}

writeFileSync(join(harnessBin, 'codex'), '#!/bin/sh\necho "0.114.0"\n', 'utf8');
try { chmodSync(join(harnessBin, 'codex'), 0o755); } catch {}
if (process.platform === 'win32') {
  writeFileSync(join(harnessBin, 'codex.cmd'), '@echo off\r\necho 0.114.0\r\n', 'utf8');
}
process.env.PATH = `${harnessBin}${delimiter}${process.env.PATH || ''}`;

// Set source environment BEFORE importing any Ragent modules.
process.env.HOME = sourceRoot;
process.env.USERPROFILE = sourceRoot;
process.env.LOCALAPPDATA = join(sourceRoot, 'localappdata');
process.env.APPDATA = join(sourceRoot, 'appdata');
process.env.RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
process.env.RAGENT_INSTANCE_ROOT = sourceInstanceRoot;
process.env.RAGENT_CONFIG_DIR = sourceConfigDir;
process.env.RAGENT_DATA_DIR = sourceDataDir;
process.env.RAGENT_WORK_ROOT_DIR = sourceWorkRootDir;
process.env.RAGENT_MEMORY_DIR = sourceMemoryDir;
process.env.RAGENT_HARNESS_ROOT = harnessRoot;
process.env.RAGENT_ACCOUNTS_URL = 'https://accounts.stage4.invalid/accounts';
process.env.RAGENT_ACCOUNTS_ISSUER = 'https://accounts.stage4.invalid/accounts';
process.env.RAGENT_AUTH_SESSION_SECRET = 'stage4-device-mesh-auth-secret-1234567890';
process.env.SECURE_COOKIES = '0';
process.env.RAGENT_ORG_SCHEMA_ENABLED = '1';
process.env.RAGENT_ORG_PROJECTION_V1_ENABLED = '1';
process.env.RAGENT_ORG_PROJECTION_V2_ENABLED = '1';
process.env.RAGENT_MANAGED_WRITER_ENABLED = '1';
process.env.RAGENT_CODEX_PROVIDER_READONLY = '1';
process.env.RAGENT_FACTORY_CONTROL_ENABLED = 'true';
process.env.RAGENT_FACTORY_SCHEDULER_ENABLED = '1';
process.env.RAGENT_FACTORY_SCHEDULER_OWNER_ID = OWNER_ID;
// Keep default-off gates OFF initially to test admission blocks!
process.env.RAGENT_REMOTE_FACTORY_ENABLED = '0';
process.env.RAGENT_REMOTE_FILE_TRANSFER_ENABLED = '0';

// Create identical Git repo baseline on both sourceRepoDir and targetRepoDir.
function initGitRepo(dir) {
  mkdirSync(join(dir, 'docs'), { recursive: true });
  execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'stage4-mesh@example.com'], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Stage4 Mesh'], { stdio: 'ignore' });
  writeFileSync(join(dir, 'README.md'), '# Stage4 Mesh Repo\n', 'utf8');
  writeFileSync(join(dir, 'docs', 'spec.md'), 'Baseline spec v1\n', 'utf8');
  execFileSync('git', ['-C', dir, 'add', '.'], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'commit', '-m', 'initial baseline', '--date', '2026-11-22T00:00:00Z'], {
    stdio: 'ignore',
    env: { ...process.env, GIT_AUTHOR_DATE: '2026-11-22T00:00:00Z', GIT_COMMITTER_DATE: '2026-11-22T00:00:00Z' },
  });
}
initGitRepo(sourceRepoDir);
initGitRepo(targetRepoDir);

const { createOwnerAuthBroker } = await import('../accounts/owner-auth-broker.mjs');
const { loadOrCreateSigningKeyRing, signAssertionFactory } = await import('../accounts/keys.mjs');
const identityMod = await import('../lib/instance-identity.mjs');
const sourceIdentity = await identityMod.loadOrCreateInstanceIdentity();
const targetIdentity = await identityMod.loadOrCreateInstanceIdentity({ filePath: join(targetConfigDir, 'instance-identity.json') });
const altTargetIdentity = await identityMod.loadOrCreateInstanceIdentity({ filePath: join(tempRoot, 'alt-identity.json') });

const deviceKeyPair = generateKeyPairSync('ed25519');
const deviceToken = `rdt_${'b'.repeat(64)}`;
const bindingAuthorityRev = '1';

function seedAuthFiles(cfgDir, instIdentity) {
  writeFileSync(join(cfgDir, 'auth.json'), JSON.stringify({ username: 'owner', passwordHash: 'unused' }), 'utf8');
  writeFileSync(join(cfgDir, 'owner-account-binding.json'), JSON.stringify({
    accountId: ACCOUNT_ID,
    provider: 'google',
    bindingAuthorityRevision: bindingAuthorityRev,
    boundAt: new Date().toISOString(),
  }), 'utf8');
  writeFileSync(join(cfgDir, 'owner-account-authority.json'), JSON.stringify({
    version: 1,
    instanceId: instIdentity.instanceId,
    keyFingerprint: instIdentity.keyFingerprint,
    revision: bindingAuthorityRev,
    deniedAccounts: [],
  }), 'utf8');
  writeFileSync(join(cfgDir, 'trusted-devices.json'), JSON.stringify({
    version: 1,
    instanceId: `rli_${instIdentity.instanceId}`,
    instanceSecret: 'ris_stage4_mesh',
    createdAt: new Date().toISOString(),
    invitations: [],
    challenges: [],
    authTokens: [],
    devices: [{
      id: DEVICE_ID,
      status: 'bound',
      accountId: ACCOUNT_ID,
      enrollmentKind: 'account-join',
      tokenHash: createHash('sha256').update(deviceToken).digest('hex'),
      devicePublicKey: deviceKeyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      keyAlgorithm: 'ed25519',
      bindingAuthorityRevision: bindingAuthorityRev,
      createdAt: new Date().toISOString(),
      boundAt: new Date().toISOString(),
      revokedAt: '',
    }],
  }), 'utf8');
}
seedAuthFiles(sourceConfigDir, sourceIdentity);
seedAuthFiles(targetConfigDir, targetIdentity);

// Start real local Accounts broker server supporting JWKS, binding authority, and target-runtime grants.
const keyRing = await loadOrCreateSigningKeyRing(join(tempRoot, 'accounts-keys.json'));
const signAssertion = signAssertionFactory(keyRing);
const jwksPayload = {
  keys: Object.values(keyRing.keys).map((k) => ({ ...k.publicJwk, kid: k.kid, alg: 'EdDSA' })),
};
const accountsKeys = Object.values(keyRing.keys)[0];

const brokerState = {
  instanceBindings: [
    {
      instanceId: sourceIdentity.instanceId,
      accountId: ACCOUNT_ID,
      instancePublicKey: sourceIdentity.publicKey,
      instanceKeyFingerprint: sourceIdentity.keyFingerprint,
      publicEndpoint: 'https://source.stage4.invalid',
      deviceAlias: 'Source-Win',
      boundAt: new Date().toISOString(),
      revokedAt: '',
    },
    {
      instanceId: targetIdentity.instanceId,
      accountId: ACCOUNT_ID,
      instancePublicKey: targetIdentity.publicKey,
      instanceKeyFingerprint: targetIdentity.keyFingerprint,
      publicEndpoint: 'https://target.stage4.invalid',
      deviceAlias: 'Target-Node',
      boundAt: new Date().toISOString(),
      revokedAt: '',
    },
  ],
};
const broker = createOwnerAuthBroker({
  store: { async mutate(fn) { return fn(brokerState); } },
  issuer: 'https://accounts.stage4.invalid/accounts',
  verifyGoogleCredential: async () => ({ providerSubject: 'unused' }),
  resolveAccount: async () => ({ accountId: 'unused' }),
  signAssertion,
});

const accountsServer = createServer(async (req, res) => {
  const path = (req.url || '').split('?')[0];
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (path === '/accounts/.well-known/jwks.json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(jwksPayload));
    return;
  }
  if (path === '/accounts/v1/owner-auth/instances/authority' && req.method === 'POST') {
    const body = JSON.parse(raw || '{}');
    const iat = Math.floor(Date.now() / 1000);
    const claims = {
      iss: process.env.RAGENT_ACCOUNTS_ISSUER,
      aud: body.instanceId || sourceIdentity.instanceId,
      sub: ACCOUNT_ID,
      tx: body.requestId,
      nonce: body.nonce,
      instanceKeyFingerprint: body.instanceKeyFingerprint || sourceIdentity.keyFingerprint,
      purpose: 'binding_authority',
      authorityProtocol: 1,
      bindingAuthorityState: 'active',
      bindingAuthorityRevision: bindingAuthorityRev,
      iat,
      exp: iat + 30,
    };
    const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', kid: accountsKeys.kid })).toString('base64url');
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const sig = sign(null, Buffer.from(`${header}.${payload}`), createPrivateKey(accountsKeys.privateKey)).toString('base64url');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ assertion: `${header}.${payload}.${sig}` }));
    return;
  }
  if (path === '/accounts/v1/target-runtime/authorize' && req.method === 'POST') {
    try {
      const body = JSON.parse(raw || '{}');
      const result = await broker.authorizeTargetRuntime(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(err.statusCode || 400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: err.code || 'BROKER_ERROR', error: err.message }));
    }
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found', path }));
});

await new Promise((r) => accountsServer.listen(0, '127.0.0.1', r));
const accountsPort = accountsServer.address().port;

// Spawn a real second Ragent Target HTTP server process with its own identity & DB.
const targetWorkerPath = join(tempRoot, 'target-worker.mjs');
writeFileSync(targetWorkerPath, `
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = ${JSON.stringify(REPO_ROOT)};
const accountsPort = ${accountsPort};
const realFetch = globalThis.fetch;
globalThis.fetch = (url, opts) => {
  const parsed = new URL(url);
  if (parsed.origin === 'https://accounts.stage4.invalid') {
    return realFetch('http://127.0.0.1:' + accountsPort + parsed.pathname + parsed.search, opts);
  }
  return realFetch(url, opts);
};

const mod = (rel) => import(pathToFileURL(join(repoRoot, rel)).href);
const { loadOrCreateInstanceIdentity } = await mod('lib/instance-identity.mjs');
const { authenticateTargetRuntimeRequest, createTargetRuntimeResponse } = await mod('lib/target-runtime-auth.mjs');
const { createTargetRuntimeSummary } = await mod('chat/target-runtime-summary.mjs');
const { handleRemoteFactoryRoutes } = await mod('chat/router-remote-factory-routes.mjs');
const { handleRemoteFileRoutes } = await mod('chat/router-remote-file-routes.mjs');
const { configureRemoteFactoryBinding } = await mod('chat/remote-factory-operations.mjs');
const { configureRemoteFileGrant } = await mod('chat/remote-file-transfer.mjs');
const projects = await mod('chat/projects.mjs');
const appsMod = await mod('chat/apps.mjs');
const sessionManager = await mod('chat/session-manager.mjs');
const history = await mod('chat/history.mjs');
const runs = await mod('chat/runs.mjs');
const orgStore = await mod('chat/organization-store.mjs');
const governor = await mod('chat/organization-governor.mjs');
const factoryControl = await mod('chat/factory-control.mjs');
const { createCollaborationOrchestrator } = await mod('chat/collaboration-orchestrator.mjs');
const { createFactoryExecutionAdapter } = await mod('chat/factory-execution-adapter.mjs');
const { createFactoryScheduler } = await mod('chat/factory-scheduler.mjs');
const { withDatabase } = await mod('chat/collaboration-store.mjs');

const identity = await loadOrCreateInstanceIdentity();
await orgStore.initializeOrganizationStore();
await governor.initializeOrganizationGovernor();

const targetRepoDir = ${JSON.stringify(targetRepoDir)};
const ownerId = ${JSON.stringify(OWNER_ID)};
const ownerActor = { kind: 'user', role: 'owner', principalId: ownerId };
const serviceActor = { kind: 'service', role: 'factory_scheduler', principalId: 'factory-scheduler:' + ownerId, authorizingPrincipalId: ownerId };

const project = await projects.createProject({ name: 'Target Project', rootPath: targetRepoDir });
const writerApp = await appsMod.createApp({
  name: 'Target Codex Writer',
  tool: 'codex',
  collaborationPolicy: { role: 'writer', canDelegate: false, writablePaths: ['docs'], revision: 'tw-1' },
});
const rootSession = await sessionManager.createSession(targetRepoDir, 'codex', 'Target Root Session', {
  projectId: project.id, sessionClass: 'ROOT_LEADERSHIP', sessionPlane: 'user', model: 'gpt-5.3-codex', effort: 'medium',
});
const org = await orgStore.createOrganization({
  rootSessionId: rootSession.id, projectId: project.id, state: 'active', currentRevision: 1,
  policy: { factoryMaxConcurrent: 2 }, budget: { maxTotalRuns: 20, maxTokens: 50000, maxCost: 25 },
  idempotencyKey: 'target-org-stage4',
});
process.env.RAGENT_FACTORY_ORGANIZATIONS = org.id;
await orgStore.createRevision(org.id, { revision: 1, proposal: { nodes: [], edges: [] }, compiled: { nodes: [], edges: [] } });
await orgStore.freezeRevision(org.id, 1);

const roleInst = await orgStore.createRoleInstance({
  organizationId: org.id, organizationRevision: 1, stableKey: 'target_writer', role: 'writer',
  agentId: writerApp.id, lifecycleState: 'active', idempotencyKey: 'role-tw',
});
const writerNode = await orgStore.createNode({
  organizationId: org.id, stableKey: 'target_writer', nodeRole: 'writer', createdRevision: 1,
  lifecycleState: 'active', lifecycleMode: 'formal_org',
  grant: { canWrite: true, canReview: false, writablePaths: ['docs'], allowedCapabilities: ['read', 'write', 'run'], projectId: project.id },
  roleInstanceId: roleInst.id, bindingGeneration: 1, sessionClass: 'WORKER',
});
await orgStore.bindRoleInstanceNode(roleInst.id, writerNode.id);
const writerSession = await sessionManager.createSession(targetRepoDir, 'codex', 'Target Writer Session', {
  projectId: project.id, templateId: writerApp.id, sessionPlane: 'organization', sessionClass: 'WORKER',
  lifecycleMode: 'formal_org', managedScope: 'organization', organizationRootSessionId: rootSession.id,
  organizationId: org.id, organizationNodeId: writerNode.id, organizationRevision: 1, roleInstanceId: roleInst.id,
  controllerSessionId: rootSession.id, parentSessionId: rootSession.id, delegatedFromSessionId: rootSession.id,
  delegationDepth: 1, model: 'gpt-5.3-codex', effort: 'medium', riskMode: 'recommended',
});
await orgStore.bindNodeSession(writerNode.id, { sessionId: writerSession.id, bindingGeneration: 1 });
const boundWriterNode = await orgStore.getNode(writerNode.id);
await orgStore.materializeFrozenNodeGrants({
  organizationId: org.id, nodeId: boundWriterNode.id, revision: 1, expectedGrant: boundWriterNode.grant,
});

const fileSession = await sessionManager.createSession(targetRepoDir, 'codex', 'Target File Session', {
  projectId: project.id, sessionPlane: 'user', model: 'gpt-5.3-codex', effort: 'medium',
});

let orchestrator;
orchestrator = createCollaborationOrchestrator({
  pollMs: 100000,
  dependencies: {
    sendMessage: async (sid, prompt, _images, opts = {}) => {
      const sess = await sessionManager.getSession(sid);
      const run = await runs.createRun({
        status: { sessionId: sid, requestId: opts.requestId, tool: 'codex', model: 'gpt-5.3-codex', effort: 'medium', state: 'running', createdAt: new Date().toISOString() },
        manifest: { sessionId: sid, requestId: opts.requestId, projectId: project.id, folder: sess.folder },
      });
      // Write change inside staging workspace docs/remote-output.md
      mkdirSync(join(sess.folder, 'docs'), { recursive: true });
      writeFileSync(join(sess.folder, 'docs', 'remote-output.md'), 'Remote executed output from target!\\n', 'utf8');
      await history.appendEvent(sid, {
        type: 'message', role: 'assistant', content: 'Completed remote writer change.', runId: run.id,
        requestId: opts.requestId, messagePhase: 'final_answer', providerMessageId: 'msg_' + run.id, timestamp: Date.now(),
      });
      await history.appendEvent(sid, {
        type: 'usage', runId: run.id, requestId: opts.requestId, usageScope: 'provider_turn_total',
        costSource: 'provider_reported', usageAccountingTokens: 150, costUsd: 0.02, timestamp: Date.now(),
      });
      const completedAt = new Date().toISOString();
      await runs.writeRunResult(run.id, { exitCode: 0, signal: null, completedAt });
      await runs.updateRun(run.id, (cur) => ({ ...cur, state: 'completed', completedAt, finalizedAt: completedAt }));
      return { session: sess, run: await runs.getRun(run.id), prompt };
    },
  },
});
const adapter = createFactoryExecutionAdapter({ organizationId: org.id, actor: serviceActor, orchestrator });
const scheduler = createFactoryScheduler({ organizationId: org.id, actor: serviceActor, adapter, admissionEnabled: true, pollMs: 60000 });
await scheduler.start();

const stats = { remoteFactoryAcceptCalls: 0, remoteFileChunkCalls: 0 };

const server = createServer(async (req, res) => {
  const pathname = (req.url || '').split('?')[0];
  const writeJson = (targetRes, code, payload) => {
    targetRes.writeHead(code, { 'content-type': 'application/json' });
    targetRes.end(JSON.stringify(payload));
  };
  try {
    if (pathname.startsWith('/test-control/')) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (pathname === '/test-control/flags') {
        if (body.remoteFactoryEnabled !== undefined) process.env.RAGENT_REMOTE_FACTORY_ENABLED = body.remoteFactoryEnabled;
        if (body.remoteFileTransferEnabled !== undefined) process.env.RAGENT_REMOTE_FILE_TRANSFER_ENABLED = body.remoteFileTransferEnabled;
        writeJson(res, 200, { ok: true, remoteFactory: process.env.RAGENT_REMOTE_FACTORY_ENABLED, remoteFile: process.env.RAGENT_REMOTE_FILE_TRANSFER_ENABLED });
        return;
      }
      if (pathname === '/test-control/configure-binding') {
        writeJson(res, 200, await configureRemoteFactoryBinding({
          ...body,
          organizationId: org.id, projectId: project.id, nodeId: boundWriterNode.id, sessionId: writerSession.id,
        }, ownerActor));
        return;
      }
      if (pathname === '/test-control/configure-file-grant') {
        writeJson(res, 200, await configureRemoteFileGrant({ ...body, sessionId: fileSession.id }, ownerActor));
        return;
      }
      if (pathname === '/test-control/execute-child') {
        await scheduler.tick();
        const childRow = await withDatabase((db) => db.prepare('SELECT * FROM factory_remote_children WHERE binding_id=? AND operation_id=?').get(body.bindingId, body.operationId));
        if (!childRow) { writeJson(res, 404, { error: 'child_not_found' }); return; }
        let detail = (await factoryControl.getFactoryWorkItem(org.id, childRow.work_item_id, ownerActor)).item;
        if (detail.bindings[0]?.runId) {
          await orchestrator.completeRun(detail.bindings[0].runId);
          await scheduler.tick();
          detail = (await factoryControl.getFactoryWorkItem(org.id, childRow.work_item_id, ownerActor)).item;
        }
        writeJson(res, 200, { workItem: detail });
        return;
      }
      if (pathname === '/test-control/stats') {
        writeJson(res, 200, stats);
        return;
      }
      if (pathname === '/test-control/shutdown') {
        await scheduler.stop();
        writeJson(res, 200, { ok: true });
        server.close();
        return;
      }
      writeJson(res, 404, { error: 'unknown_control' });
      return;
    }

    const targetAuth = await authenticateTargetRuntimeRequest(req);
    if (targetAuth?.replay) {
      for (const [k, v] of Object.entries(targetAuth.replay.headers || {})) res.setHeader(k, v);
      res.writeHead(targetAuth.replay.statusCode);
      res.end(targetAuth.replay.body);
      return;
    }
    const wrappedRes = targetAuth ? createTargetRuntimeResponse(res, targetAuth) : res;
    const authSession = targetAuth?.principal || null;

    if (pathname === '/api/runtime/summary' && req.method === 'GET') {
      if (authSession?.principalKind !== 'target_runtime_gateway') { writeJson(wrappedRes, 403, { error: 'target grant required' }); return; }
      writeJson(wrappedRes, 200, await createTargetRuntimeSummary({ identity }));
      return;
    }
    if (pathname.startsWith('/api/remote-factory/bindings/') && req.method === 'POST' && !pathname.endsWith('/cancel')) {
      stats.remoteFactoryAcceptCalls += 1;
    }
    if (pathname.startsWith('/api/remote-files/grants/') && req.method === 'POST') {
      stats.remoteFileChunkCalls += 1;
    }
    if (await handleRemoteFactoryRoutes({ req, res: wrappedRes, pathname, authSession, writeJson })) return;
    if (await handleRemoteFileRoutes({ req, res: wrappedRes, pathname, authSession, writeJson, requireSessionAccess: async () => true })) return;
    writeJson(wrappedRes, 404, { error: 'not_found' });
  } catch (err) {
    writeJson(res, err?.statusCode || 500, { code: err?.code || 'TARGET_ERR', error: err?.message || 'err' });
  }
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
process.stdout.write(JSON.stringify({
  port: server.address().port,
  instanceId: identity.instanceId,
  publicKey: identity.publicKey,
  orgId: org.id,
  projectId: project.id,
  writerNodeId: boundWriterNode.id,
  writerSessionId: writerSession.id,
  fileSessionId: fileSession.id,
}) + '\\n');
`, 'utf8');

const targetProc = spawn(process.execPath, [targetWorkerPath], {
  cwd: REPO_ROOT,
  env: {
    ...process.env,
    HOME: targetRoot,
    USERPROFILE: targetRoot,
    LOCALAPPDATA: join(targetRoot, 'localappdata'),
    APPDATA: join(targetRoot, 'appdata'),
    RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES: '1',
    RAGENT_INSTANCE_ROOT: targetInstanceRoot,
    RAGENT_CONFIG_DIR: targetConfigDir,
    RAGENT_DATA_DIR: targetDataDir,
    RAGENT_WORK_ROOT_DIR: targetWorkRootDir,
    RAGENT_MEMORY_DIR: targetMemoryDir,
    RAGENT_REMOTE_FACTORY_ENABLED: '0',
    RAGENT_REMOTE_FILE_TRANSFER_ENABLED: '0',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let targetStderr = '';
targetProc.stderr.on('data', (d) => { targetStderr += d.toString('utf8'); });

const targetInfo = await new Promise((resolveReady, rejectReady) => {
  let buf = '';
  const timer = setTimeout(() => rejectReady(new Error(`Target worker timeout. stderr=${targetStderr}`)), 15000);
  targetProc.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    const nl = buf.indexOf('\n');
    if (nl !== -1) {
      const line = buf.slice(0, nl).trim();
      try {
        const parsed = JSON.parse(line);
        if (parsed.port) {
          clearTimeout(timer);
          resolveReady(parsed);
        }
      } catch {}
    }
  });
  targetProc.once('exit', (code) => {
    clearTimeout(timer);
    rejectReady(new Error(`Target worker exited early (${code}). stderr=${targetStderr}`));
  });
});

// Route https://accounts.stage4.invalid and https://target.stage4.invalid via real loopback listeners!
const realFetch = globalThis.fetch;
globalThis.fetch = (url, opts) => {
  const parsed = new URL(url);
  if (parsed.origin === 'https://accounts.stage4.invalid') {
    return realFetch(`http://127.0.0.1:${accountsPort}${parsed.pathname}${parsed.search}`, opts);
  }
  if (parsed.origin === 'https://target.stage4.invalid') {
    return realFetch(`http://127.0.0.1:${targetInfo.port}${parsed.pathname}${parsed.search}`, opts);
  }
  return realFetch(url, opts);
};

async function targetControl(path, body = {}) {
  const r = await realFetch(`http://127.0.0.1:${targetInfo.port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}

const { resetInstanceAuthCache } = await import('../lib/auth.mjs');
resetInstanceAuthCache?.();

const projects = await import('../chat/projects.mjs');
const appsMod = await import('../chat/apps.mjs');
const sessionManager = await import('../chat/session-manager.mjs');
const history = await import('../chat/history.mjs');
const runs = await import('../chat/runs.mjs');
const orgStore = await import('../chat/organization-store.mjs');
const governor = await import('../chat/organization-governor.mjs');
const { createCollaborationOrchestrator } = await import('../chat/collaboration-orchestrator.mjs');
const { createFactoryExecutionAdapter } = await import('../chat/factory-execution-adapter.mjs');
const { createFactoryScheduler } = await import('../chat/factory-scheduler.mjs');
const factoryControl = await import('../chat/factory-control.mjs');
const factoryAcceptance = await import('../chat/factory-acceptance.mjs');
const factoryReviewOpinions = await import('../chat/factory-review-opinions.mjs');
const { reconcileFactoryDependencies } = await import('../chat/work-graph.mjs');
const { getFileAsset, createFileAssetUploadIntent, ingestFileAssetUpload, finalizeFileAssetUpload, localizeFileAsset } = await import('../chat/file-assets.mjs');
const { createRunSessionControlCapability } = await import('../chat/session-control-capability.mjs');
const { withDatabase } = await import('../chat/collaboration-store.mjs');

const deviceRegistry = await import('../chat/device-capability-registry.mjs');
const remoteFactoryOps = await import('../chat/remote-factory-operations.mjs');
const remoteFactorySource = await import('../chat/remote-factory-source.mjs');
const { handleRemoteFactoryRoutes } = await import('../chat/router-remote-factory-routes.mjs');
const remoteFileTransfer = await import('../chat/remote-file-transfer.mjs');
const { handleRemoteFileRoutes } = await import('../chat/router-remote-file-routes.mjs');
const { inspectSourceRemoteBaseline } = await import('../chat/factory-remote-admission.mjs');
const { proxyToTarget } = await import('../chat/router-target-runtime-routes.mjs');

let assertions = 0;
function equal(a, b, msg) { assertions += 1; assert.equal(a, b, msg); }
function ok(v, msg) { assertions += 1; assert.ok(v, msg); }
function deepEqual(a, b, msg) { assertions += 1; assert.deepEqual(a, b, msg); }
async function rejectsCode(fn, expectedCode, msg) {
  assertions += 1;
  let caught = null;
  try { await fn(); } catch (e) { caught = e; }
  assert.ok(caught, `Expected rejection (${expectedCode}): ${msg}`);
  assert.equal(caught.code, expectedCode, `${msg}: got ${caught.code} (${caught.message})`);
}

function makeHttpReq({ method = 'GET', url, body = null, headers = {} }) {
  const raw = body !== null ? JSON.stringify(body) : '';
  const stream = Readable.from(raw ? [Buffer.from(raw, 'utf8')] : []);
  stream.method = method;
  stream.url = url;
  stream.headers = {
    host: '127.0.0.1:7690',
    ...(raw ? { 'content-type': 'application/json' } : {}),
    ...headers,
  };
  stream.socket = { encrypted: false, remoteAddress: '127.0.0.1' };
  stream._bearerAuthSession = {
    role: 'owner',
    principalKind: 'trusted_device',
    deviceId: DEVICE_ID,
    accountId: ACCOUNT_ID,
    bindingAuthorityRevision: bindingAuthorityRev,
  };
  return stream;
}

async function callRoute(handler, { method = 'GET', pathname, body = null, authSession = null }) {
  const req = makeHttpReq({ method, url: pathname, body });
  let statusCode = 0;
  let responseBody = '';
  const res = {
    headersSent: false,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    writeHead(code) { statusCode = code; this.headersSent = true; },
    end(chunk) { responseBody += chunk || ''; },
  };
  const writeJson = (r, code, payload) => {
    r.writeHead(code, { 'content-type': 'application/json' });
    r.end(JSON.stringify(payload));
  };
  const session = authSession || {
    role: 'owner',
    principalKind: 'trusted_device',
    deviceId: DEVICE_ID,
    accountId: ACCOUNT_ID,
    bindingAuthorityRevision: bindingAuthorityRev,
  };
  const handled = await handler({
    req,
    res,
    pathname: pathname.split('?')[0],
    authSession: session,
    writeJson,
    requireSessionAccess: async () => true,
  });
  return { handled, statusCode, body: responseBody ? JSON.parse(responseBody) : null };
}

const ownerActor = { kind: 'user', role: 'owner', principalId: OWNER_ID };
const serviceActor = { kind: 'service', role: 'factory_scheduler', principalId: `factory-scheduler:${OWNER_ID}`, authorizingPrincipalId: OWNER_ID };
const futureExpiry = new Date(Date.now() + 7 * 86400_000).toISOString();
const baseTime = Date.parse('2026-11-22T12:00:00.000Z');

let sourceScheduler = null;

try {
  // ── Setup Source Project, Apps, Organization & Nodes ─────────────────────
  await orgStore.initializeOrganizationStore();
  await governor.initializeOrganizationGovernor();

  const srcProject = await projects.createProject({ name: 'Stage4 Source Project', rootPath: sourceRepoDir });
  const srcWriterApp = await appsMod.createApp({
    name: 'Source Writer', tool: 'codex',
    collaborationPolicy: { role: 'writer', canDelegate: false, writablePaths: ['docs'], revision: 'sw-1' },
  });
  const srcReviewerApp = await appsMod.createApp({
    name: 'Source Independent Reviewer', tool: 'codex',
    collaborationPolicy: { role: 'reviewer', canDelegate: false, revision: 'sr-1' },
  });
  const srcRootSession = await sessionManager.createSession(sourceRepoDir, 'codex', 'Source Root', {
    projectId: srcProject.id, sessionClass: 'ROOT_LEADERSHIP', sessionPlane: 'user', model: 'gpt-5.3-codex', effort: 'medium',
  });
  const srcOrg = await orgStore.createOrganization({
    rootSessionId: srcRootSession.id, projectId: srcProject.id, state: 'active', currentRevision: 1,
    policy: { factoryMaxConcurrent: 4 },
    budget: { maxTotalRuns: 30, maxTokens: 100000, maxCost: 50 },
    idempotencyKey: 'stage4-src-org',
  });
  process.env.RAGENT_FACTORY_ORGANIZATIONS = srcOrg.id;
  await orgStore.createRevision(srcOrg.id, { revision: 1, proposal: { nodes: [], edges: [] }, compiled: { nodes: [], edges: [] } });
  await orgStore.freezeRevision(srcOrg.id, 1);

  async function makeSourceNode(stableKey, role, app, grant) {
    const ri = await orgStore.createRoleInstance({
      organizationId: srcOrg.id, organizationRevision: 1, stableKey, role, agentId: app.id,
      lifecycleState: 'active', idempotencyKey: `ri-${stableKey}`,
    });
    const node = await orgStore.createNode({
      organizationId: srcOrg.id, stableKey, nodeRole: role, createdRevision: 1, lifecycleState: 'active',
      lifecycleMode: 'formal_org', grant, roleInstanceId: ri.id, bindingGeneration: 1,
      sessionClass: role === 'reviewer' ? 'REVIEWER' : 'WORKER',
    });
    await orgStore.bindRoleInstanceNode(ri.id, node.id);
    const sess = await sessionManager.createSession(sourceRepoDir, 'codex', `Src ${stableKey}`, {
      projectId: srcProject.id, templateId: app.id, sessionPlane: 'organization',
      sessionClass: role === 'reviewer' ? 'REVIEWER' : 'WORKER', lifecycleMode: 'formal_org',
      managedScope: 'organization', organizationRootSessionId: srcRootSession.id,
      organizationId: srcOrg.id, organizationNodeId: node.id, organizationRevision: 1, roleInstanceId: ri.id,
      controllerSessionId: srcRootSession.id, parentSessionId: srcRootSession.id, delegatedFromSessionId: srcRootSession.id,
      delegationDepth: 1, model: 'gpt-5.3-codex', effort: 'medium', riskMode: 'recommended',
    });
    await orgStore.bindNodeSession(node.id, { sessionId: sess.id, bindingGeneration: 1 });
    const bound = await orgStore.getNode(node.id);
    await orgStore.materializeFrozenNodeGrants({
      organizationId: srcOrg.id, nodeId: bound.id, revision: 1, expectedGrant: grant,
    });
    return { node: bound, session: sess };
  }

  const srcWriter = await makeSourceNode('src_writer', 'writer', srcWriterApp, {
    canWrite: true, canReview: false, writablePaths: ['docs'], allowedCapabilities: ['read', 'write', 'run'], projectId: srcProject.id,
  });
  const srcWriter2 = await makeSourceNode('src_writer_2', 'writer', srcWriterApp, {
    canWrite: true, canReview: false, writablePaths: ['docs'], allowedCapabilities: ['read', 'write', 'run'], projectId: srcProject.id,
  });
  const srcReviewer = await makeSourceNode('src_reviewer', 'reviewer', srcReviewerApp, {
    canWrite: false, canReview: true, allowedCapabilities: ['read', 'review', 'run'], projectId: srcProject.id,
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST GROUP 1: Device Capability Registry, Staleness & Authorized Routing
  // ═══════════════════════════════════════════════════════════════════════════
  const winAuthKeys = generateKeyPairSync('ed25519');
  const winAuthPub = winAuthKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const { createInstancePublicKeyFingerprint } = await import('../lib/instance-proof-protocol.mjs');
  const winAuthId = `inst_${createInstancePublicKeyFingerprint(winAuthPub).slice(0, 32)}`;

  const winUnauthKeys = generateKeyPairSync('ed25519');
  const winUnauthPub = winUnauthKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const winUnauthId = `inst_${createInstancePublicKeyFingerprint(winUnauthPub).slice(0, 32)}`;

  const winNoIsoKeys = generateKeyPairSync('ed25519');
  const winNoIsoPub = winNoIsoKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const winNoIsoId = `inst_${createInstancePublicKeyFingerprint(winNoIsoPub).slice(0, 32)}`;

  const macStaleKeys = generateKeyPairSync('ed25519');
  const macStalePub = macStaleKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const macStaleId = `inst_${createInstancePublicKeyFingerprint(macStalePub).slice(0, 32)}`;

  const linuxUnverifiedKeys = generateKeyPairSync('ed25519');
  const linuxUnverifiedPub = linuxUnverifiedKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const linuxUnverifiedId = `inst_${createInstancePublicKeyFingerprint(linuxUnverifiedPub).slice(0, 32)}`;

  // Test signed capability attestation & tamper rejection
  const signedTargetCap = await deviceRegistry.signDeviceCapabilityReport({
    platform: 'windows',
    status: 'online',
    heartbeatAt: new Date(baseTime).toISOString(),
    staleAfterMs: 60_000,
    availableHarnesses: ['codex', 'claude'],
    capabilities: ['build', 'git', 'tests'],
    authorizedWorkspaceRoots: ['G:/AgentoC/Projects/app1'],
    maxConcurrentRuns: 3,
    currentConcurrentRuns: 1,
    isolation: { supported: true, enforced: true, mode: 'worktree', readOnlySupported: true },
  }, { identity: { instanceId: winAuthId, publicKey: winAuthPub, privateKey: winAuthKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() } });

  const tamperedCap = {
    ...signedTargetCap,
    report: { ...signedTargetCap.report, maxConcurrentRuns: 99 },
  };
  await rejectsCode(
    () => deviceRegistry.registerDeviceCapabilities({ signedReport: tamperedCap }, ownerActor, { nowMs: baseTime }),
    'DEVICE_CAPABILITY_FORBIDDEN',
    'Tampered signed device capability report must be rejected',
  );

  await deviceRegistry.registerDeviceCapabilities({ signedReport: signedTargetCap }, ownerActor, { nowMs: baseTime });

  // Online device WITHOUT explicit peer binding (must NEVER be authorized just because status==='online')
  await deviceRegistry.registerDeviceCapabilities({
    instanceId: winUnauthId,
    platform: 'windows',
    status: 'online',
    heartbeatAt: new Date(baseTime).toISOString(),
    availableHarnesses: ['codex', 'claude'],
    capabilities: ['build', 'git', 'tests'],
    authorizedWorkspaceRoots: ['G:/AgentoC/Projects/app1'],
    maxConcurrentRuns: 4,
    currentConcurrentRuns: 0,
    isolation: { supported: true, enforced: true, mode: 'worktree', readOnlySupported: true },
    factSource: 'verified_remote',
  }, ownerActor, { nowMs: baseTime });

  // Authorized device with NO enforced isolation (mode: 'shared' -> enforced must stay false!)
  await deviceRegistry.registerDeviceCapabilities({
    instanceId: winNoIsoId,
    platform: 'windows',
    status: 'online',
    heartbeatAt: new Date(baseTime).toISOString(),
    availableHarnesses: ['codex'],
    capabilities: ['build', 'git'],
    authorizedWorkspaceRoots: ['G:/AgentoC/Projects/app1'],
    maxConcurrentRuns: 2,
    currentConcurrentRuns: 0,
    isolation: { supported: true, enforced: true, mode: 'shared' },
    factSource: 'verified_remote',
  }, ownerActor, { nowMs: baseTime });
  const noIsoRec = await deviceRegistry.getDeviceCapabilities(winNoIsoId, { nowMs: baseTime });
  equal(noIsoRec.isolation.enforced, false, 'Shared mode never promotes isolation.enforced to true');

  // Stale macOS device (heartbeat 120s old, staleAfterMs=30s)
  await deviceRegistry.registerDeviceCapabilities({
    instanceId: macStaleId,
    platform: 'macos',
    status: 'online',
    heartbeatAt: new Date(baseTime - 120_000).toISOString(),
    staleAfterMs: 30_000,
    availableHarnesses: ['codex'],
    capabilities: ['build'],
    authorizedWorkspaceRoots: ['/Users/dev/app1'],
    maxConcurrentRuns: 2,
    currentConcurrentRuns: 0,
    isolation: { supported: true, enforced: true, mode: 'worktree' },
    factSource: 'verified_remote',
  }, ownerActor, { nowMs: baseTime });
  const staleRec = await deviceRegistry.getDeviceCapabilities(macStaleId, { nowMs: baseTime });
  equal(staleRec.status, 'stale', 'Expired heartbeat computes effective status=stale');
  equal(staleRec.isStale, true);

  // Unverified catalog fact source (must be rejected even with peer binding)
  await deviceRegistry.registerDeviceCapabilities({
    instanceId: linuxUnverifiedId,
    platform: 'linux',
    status: 'online',
    heartbeatAt: new Date(baseTime).toISOString(),
    availableHarnesses: ['codex'],
    capabilities: ['build'],
    authorizedWorkspaceRoots: ['/srv/app1'],
    maxConcurrentRuns: 2,
    currentConcurrentRuns: 0,
    isolation: { supported: true, enforced: true, mode: 'container' },
    factSource: 'catalog',
  }, ownerActor, { nowMs: baseTime });

  // Path traversal rejection in authorizedWorkspaceRoots
  await rejectsCode(
    () => deviceRegistry.registerDeviceCapabilities({
      instanceId: 'inst_bad_path',
      platform: 'linux',
      authorizedWorkspaceRoots: ['/srv/work/../etc'],
    }, ownerActor),
    'DEVICE_REGISTRY_INVALID',
    'Workspace root traversal segment rejected',
  );

  // Configure explicit peer authorizations (owner ∩ binding policy)
  await deviceRegistry.configureDevicePeerAuthorization({
    organizationId: srcOrg.id,
    targetInstanceId: winAuthId,
    bindingId: 'bind_win_auth',
    expectedVersion: 0,
    ownerAuthorized: true,
    ownerPolicy: {
      allowedPlatforms: ['windows', 'linux'],
      allowedHarnesses: ['codex', 'claude'],
      allowedWorkspaceRoots: ['G:/AgentoC/Projects'],
      allowedAccessModes: ['read', 'write'],
    },
    bindingPolicy: {
      allowedPlatforms: ['windows'],
      allowedHarnesses: ['codex'],
      allowedWorkspaceRoots: ['G:/AgentoC/Projects/app1'],
      allowedAccessModes: ['read', 'write'],
      maxConcurrentRuns: 2,
    },
    expiresAt: futureExpiry,
  }, ownerActor, { nowMs: baseTime });

  for (const [peerId, bId, plat, rootPath] of [
    [winNoIsoId, 'bind_win_no_iso', 'windows', 'G:/AgentoC/Projects/app1'],
    [macStaleId, 'bind_mac_stale', 'macos', '/Users/dev/app1'],
    [linuxUnverifiedId, 'bind_linux_cat', 'linux', '/srv/app1'],
  ]) {
    await deviceRegistry.configureDevicePeerAuthorization({
      organizationId: srcOrg.id,
      targetInstanceId: peerId,
      bindingId: bId,
      expectedVersion: 0,
      ownerAuthorized: true,
      ownerPolicy: { allowedPlatforms: [plat], allowedWorkspaceRoots: [rootPath] },
      bindingPolicy: { allowedPlatforms: [plat], allowedWorkspaceRoots: [rootPath] },
      expiresAt: futureExpiry,
    }, ownerActor, { nowMs: baseTime });
  }

  // Test authorized selection
  const routeWin = await deviceRegistry.selectAuthorizedDeviceForTask({
    organizationId: srcOrg.id,
    requiredPlatform: 'windows',
    requiredHarness: 'codex',
    requiredCapabilities: ['build', 'git'],
    workspaceRoot: 'G:/AgentoC/Projects/app1/packages/core',
    accessMode: 'write',
    requiredIsolation: true,
  }, { nowMs: baseTime });
  equal(routeWin.selected?.instanceId, winAuthId, 'Selects explicitly authorized isolated online Windows device');
  equal(routeWin.selected?.capacity.maxConcurrentRuns, 2, 'Effective maxConcurrentRuns respects min(device, bindingPolicy)');
  equal(routeWin.selected?.capacity.availableSlots, 1);

  // Unauthorized online device (winUnauthId) must NEVER be selected
  const unauthRejection = routeWin.rejected.find((r) => r.instanceId === winUnauthId);
  ok(unauthRejection?.reasons.includes('device_not_authorized'), 'Online device without explicit binding is rejected');

  // No-isolation device rejected
  const noIsoRejection = routeWin.rejected.find((r) => r.instanceId === winNoIsoId);
  ok(noIsoRejection?.reasons.includes('device_isolationEnforced_no'), 'Device without enforced isolation is rejected');

  // Binding policy narrows ownerPolicy: claude allowed by ownerPolicy, denied by bindingPolicy!
  const routeClaude = await deviceRegistry.selectAuthorizedDeviceForTask({
    organizationId: srcOrg.id,
    requiredPlatform: 'windows',
    requiredHarness: 'claude',
    workspaceRoot: 'G:/AgentoC/Projects/app1',
  }, { nowMs: baseTime });
  equal(routeClaude.selected, null, 'Harness outside owner ∩ binding policy intersection is denied');

  // Inline ownerPolicy narrows bindingPolicy: disallow windows -> denied!
  const routeOwnerNarrow = await deviceRegistry.selectAuthorizedDeviceForTask({
    organizationId: srcOrg.id,
    requiredPlatform: 'windows',
    requiredHarness: 'codex',
    workspaceRoot: 'G:/AgentoC/Projects/app1',
  }, { nowMs: baseTime, ownerPolicy: { allowedPlatforms: ['linux'] } });
  equal(routeOwnerNarrow.selected, null, 'Owner policy narrowing denies platform even when binding allows it');

  // Workspace root outside bindingPolicy (app2 allowed by ownerPolicy 'Projects', denied by bindingPolicy 'Projects/app1')
  const routeWrongWs = await deviceRegistry.selectAuthorizedDeviceForTask({
    organizationId: srcOrg.id,
    requiredPlatform: 'windows',
    requiredHarness: 'codex',
    workspaceRoot: 'G:/AgentoC/Projects/app2',
  }, { nowMs: baseTime });
  equal(routeWrongWs.selected, null, 'Workspace outside binding policy is rejected');

  // Stale macOS device rejected
  const routeMac = await deviceRegistry.selectAuthorizedDeviceForTask({
    organizationId: srcOrg.id,
    requiredPlatform: 'macos',
    workspaceRoot: '/Users/dev/app1',
  }, { nowMs: baseTime });
  equal(routeMac.selected, null);
  ok(routeMac.rejected.find((r) => r.instanceId === macStaleId)?.reasons.includes('device_heartbeat_stale'), 'Stale heartbeat device rejected');

  // Unverified catalog Linux device rejected
  const routeLinux = await deviceRegistry.selectAuthorizedDeviceForTask({
    organizationId: srcOrg.id,
    requiredPlatform: 'linux',
    workspaceRoot: '/srv/app1',
  }, { nowMs: baseTime });
  equal(routeLinux.selected, null);
  ok(routeLinux.rejected.find((r) => r.instanceId === linuxUnverifiedId)?.reasons.includes('unverified_device_facts'), 'Unverified catalog claim rejected');

  // Heartbeat staleness progression on winAuthId: after 61s -> stale -> rejected
  const routeAfterStale = await deviceRegistry.selectAuthorizedDeviceForTask({
    organizationId: srcOrg.id,
    requiredPlatform: 'windows',
    requiredHarness: 'codex',
    workspaceRoot: 'G:/AgentoC/Projects/app1',
  }, { nowMs: baseTime + 61_000 });
  equal(routeAfterStale.selected, null, 'Fresh device becomes stale after staleAfterMs');

  // Concurrency slot saturation & release
  await deviceRegistry.updateDeviceConcurrency(winAuthId, 1, { nowMs: baseTime }); // now 2/2 under bindingPolicy!
  const routeFull = await deviceRegistry.selectAuthorizedDeviceForTask({
    organizationId: srcOrg.id,
    requiredPlatform: 'windows',
    requiredHarness: 'codex',
    workspaceRoot: 'G:/AgentoC/Projects/app1',
  }, { nowMs: baseTime });
  equal(routeFull.selected, null, 'Saturated device concurrency rejects new task');
  await deviceRegistry.updateDeviceConcurrency(winAuthId, -1, { nowMs: baseTime });

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST GROUP 2: Remote Factory Default-off Gate & 3-State Offline Handling
  // ═══════════════════════════════════════════════════════════════════════════
  // Verify HTTP default-off gate when RAGENT_REMOTE_FACTORY_ENABLED='0'
  const gateSrcBindRes = await callRoute(handleRemoteFactoryRoutes, {
    method: 'POST',
    pathname: '/api/remote-factory/source-bindings',
    body: { id: 'sb_gate_test' },
  });
  equal(gateSrcBindRes.statusCode, 503, 'Source binding route blocked when RAGENT_REMOTE_FACTORY_ENABLED=0');
  equal(gateSrcBindRes.body.code, 'REMOTE_FACTORY_DISABLED');

  const gateTargetBindRes = await callRoute(handleRemoteFactoryRoutes, {
    method: 'POST',
    pathname: '/api/remote-factory/bindings',
    body: { id: 'tb_gate_test' },
  });
  equal(gateTargetBindRes.statusCode, 503, 'Target binding route blocked when RAGENT_REMOTE_FACTORY_ENABLED=0');

  await rejectsCode(
    () => remoteFactorySource.dispatchRemoteFactoryOperation({}, serviceActor, { verifyExternal: async () => ({}) }),
    'REMOTE_FACTORY_DISABLED',
    'dispatchRemoteFactoryOperation enforces default-off gate',
  );

  // Enable RAGENT_REMOTE_FACTORY_ENABLED='1' on both source and target
  process.env.RAGENT_REMOTE_FACTORY_ENABLED = '1';
  await targetControl('/test-control/flags', { remoteFactoryEnabled: '1' });

  const contractTemplate = {
    objective: 'Produce remote docs/remote-output.md on authorized target',
    acceptanceCriteria: [{ id: 'remote-execution-result', method: 'manual' }],
    accessMode: 'write',
    allowedPaths: ['docs'],
    candidateScope: 'docs',
    targetBranch: 'main',
    retry: { maxAttempts: 1 },
    budget: { maxCost: 1.0, maxTokens: 5000 },
    budgetReservation: { cost: 1.0, tokens: 5000 },
    organizationRevision: 1,
  };
  const contractDigest = createHash('sha256').update(JSON.stringify(contractTemplate)).digest('hex');

  // Configure Target binding (via real target server) + Source binding (primary + alternate)
  const tgtBindRes = await targetControl('/test-control/configure-binding', {
    id: 'tgt_bind_1',
    sourceInstanceId: sourceIdentity.instanceId,
    sourcePublicKey: sourceIdentity.publicKey,
    allowedContractDigests: [contractDigest],
    budgetLimit: 5.0,
    expectedVersion: 0,
    expiresAt: futureExpiry,
  });
  equal(tgtBindRes.status, 200, 'Target remote factory binding configured');

  const srcBindRes = await callRoute(handleRemoteFactoryRoutes, {
    method: 'POST',
    pathname: '/api/remote-factory/source-bindings',
    body: {
      id: 'src_bind_1',
      organizationId: srcOrg.id,
      targetInstanceId: targetIdentity.instanceId,
      targetPublicKey: targetIdentity.publicKey,
      targetBindingId: 'tgt_bind_1',
      targetBindingVersion: 1,
      expectedVersion: 0,
      expiresAt: futureExpiry,
      bindingPolicy: {
        allowedPlatforms: ['linux'],
        allowedHarnesses: ['codex'],
        allowedAccessModes: ['write'],
        allowedRelativePaths: ['docs'],
      },
      ownerPolicy: {
        allowedPlatforms: ['linux', 'windows'],
        allowedHarnesses: ['codex'],
      },
    },
  });
  equal(srcBindRes.statusCode, 200, 'Source remote factory binding configured via HTTP route');

  // Configure an alternate authorized binding (altTargetIdentity) for reroute test!
  await remoteFactorySource.configureRemoteFactorySourceBinding({
    id: 'src_bind_alt',
    organizationId: srcOrg.id,
    targetInstanceId: altTargetIdentity.instanceId,
    targetPublicKey: altTargetIdentity.publicKey,
    targetBindingId: 'tgt_bind_alt',
    targetBindingVersion: 1,
    expectedVersion: 0,
    expiresAt: futureExpiry,
    bindingPolicy: { allowedPlatforms: ['linux'], allowedHarnesses: ['codex'], allowedAccessModes: ['write'], allowedRelativePaths: ['docs'] },
    ownerPolicy: { allowedPlatforms: ['linux'], allowedHarnesses: ['codex'] },
  }, ownerActor);

  // Register live capability facts for targetIdentity (initially OFFLINE to test not_dispatched!) and altTargetIdentity (ONLINE)
  await deviceRegistry.registerDeviceCapabilities({
    instanceId: targetIdentity.instanceId,
    publicKey: targetIdentity.publicKey,
    platform: 'linux',
    status: 'offline',
    heartbeatAt: new Date().toISOString(),
    availableHarnesses: ['codex'],
    capabilities: ['git', 'docs'],
    authorizedWorkspaceRoots: [targetRepoDir],
    maxConcurrentRuns: 2,
    currentConcurrentRuns: 0,
    isolation: { supported: true, enforced: true, mode: 'worktree', readOnlySupported: true },
    factSource: 'verified_remote',
  }, ownerActor);

  await deviceRegistry.registerDeviceCapabilities({
    instanceId: altTargetIdentity.instanceId,
    publicKey: altTargetIdentity.publicKey,
    platform: 'linux',
    status: 'online',
    heartbeatAt: new Date().toISOString(),
    availableHarnesses: ['codex'],
    capabilities: ['git', 'docs'],
    authorizedWorkspaceRoots: ['/srv/alt/repo'],
    maxConcurrentRuns: 2,
    currentConcurrentRuns: 0,
    isolation: { supported: true, enforced: true, mode: 'worktree', readOnlySupported: true },
    factSource: 'verified_remote',
  }, ownerActor);

  // Helper to create, approve, claim, and reserve budget for a source Work Item
  async function createClaimedSourceWorkItem(suffix, assignee = srcWriter) {
    const gRes = await factoryControl.executeFactoryCommand({
      organizationId: srcOrg.id,
      commandId: `cmd-goal-${suffix}`,
      idempotencyKey: `goal-${suffix}`,
      type: 'CreateGoal',
      payload: { projectId: srcProject.id, objective: `Remote goal ${suffix}` },
    }, ownerActor);
    const goalId = gRes.goal.id;
    const wiRes = await factoryControl.executeFactoryCommand({
      organizationId: srcOrg.id,
      commandId: `cmd-wi-${suffix}`,
      idempotencyKey: `wi-${suffix}`,
      type: 'CreateWorkItem',
      payload: {
        goalId,
        assigneeNodeId: assignee.node.id,
        kind: 'execution',
        contract: contractTemplate,
      },
    }, ownerActor);
    const workItemId = wiRes.item.id;
    const approved = await factoryControl.executeFactoryCommand({
      organizationId: srcOrg.id,
      commandId: `cmd-app-${suffix}`,
      idempotencyKey: `app-${suffix}`,
      type: 'ApproveContract',
      targetId: workItemId,
      expectedVersion: wiRes.item.rowVersion,
      payload: {},
    }, ownerActor);
    const lease = await factoryControl.acquireFactorySchedulerLease({
      organizationId: srcOrg.id,
      ownerToken: 'stage4_sched_owner',
    }, serviceActor);
    const dispatchKey = `factory:${workItemId}:1:${assignee.node.bindingGeneration}:1`;
    const claim = await factoryControl.claimFactoryWork({
      organizationId: srcOrg.id,
      workItemId,
      expectedVersion: approved.item.rowVersion,
      bindingGeneration: assignee.node.bindingGeneration,
      dispatchKey,
      leaseOwnerToken: lease.ownerToken,
      leaseGeneration: lease.generation,
      managedSessionId: assignee.session.id,
      runtimeTool: 'codex',
    }, serviceActor);
    const budgetKey = `factory:${claim.binding.id}`;
    await governor.reserveFactoryBudget({
      organizationId: srcOrg.id,
      revision: 1,
      reservationId: budgetKey,
      idempotencyKey: budgetKey,
      factoryWorkItemId: workItemId,
      delta: { cost: 1.0, tokens: 5000, runs: 1 },
    });
    return { goalId, workItem: claim.item, binding: claim.binding, lease, budgetKey };
  }

  const baseline = await inspectSourceRemoteBaseline(sourceRepoDir, ['docs']);

  // ── 2A. Offline State 1: not_dispatched + safe reroute ─────────────────────
  const item1 = await createClaimedSourceWorkItem('state1');
  const op1Id = `op_state1_${item1.binding.id}`;
  const notDispatchedRes = await remoteFactorySource.dispatchRemoteFactoryOperation({
    organizationId: srcOrg.id,
    workItemId: item1.workItem.id,
    expectedVersion: item1.workItem.rowVersion,
    sourceFactoryBindingId: item1.binding.id,
    contractRevision: 1,
    executionEpoch: item1.workItem.executionEpoch,
    bindingGeneration: item1.workItem.bindingGeneration,
    leaseOwnerToken: item1.lease.ownerToken,
    leaseGeneration: item1.lease.generation,
    bindingId: 'src_bind_1',
    bindingVersion: 1,
    operationId: op1Id,
    requestId: op1Id,
    contractDigest,
    payload: {
      contract: item1.workItem.contract,
      sourceReservationId: item1.budgetKey,
      reservedCost: 1.0,
      reservedTokens: 5000,
      sourceBindingId: 'src_bind_1',
      sourceBindingVersion: 1,
      expectedBaseHead: baseline.baseHead,
      expectedBaseBranch: baseline.baseBranch,
      expectedBaselineDigest: baseline.baselineDigest,
    },
  }, serviceActor, { verifyExternal: () => inspectSourceRemoteBaseline(sourceRepoDir, ['docs']) });

  equal(notDispatchedRes.offlineState, 'not_dispatched', 'Offline device before POST yields not_dispatched');
  equal(notDispatchedRes.canReroute, true);
  equal((await targetControl('/test-control/stats')).body.remoteFactoryAcceptCalls, 0, 'Target never received wire POST for not_dispatched');

  // Reroute not_dispatched operation via HTTP route to alternate authorized device!
  const rerouteRes = await callRoute(handleRemoteFactoryRoutes, {
    method: 'POST',
    pathname: `/api/remote-factory/source-bindings/src_bind_1/operations/${op1Id}/reroute`,
    body: {
      taskRequirements: { requiredPlatform: 'linux', requiredHarness: 'codex' },
      reason: 'primary_offline_before_dispatch',
    },
  });
  equal(rerouteRes.statusCode, 200, 'not_dispatched operation cleanly rerouted to alternate device');
  equal(rerouteRes.body.rerouted, true);
  equal(rerouteRes.body.newBindingId, 'src_bind_alt');
  equal(rerouteRes.body.offlineState, 'not_dispatched');

  // Cancel the rerouted not_dispatched operation even when RAGENT_REMOTE_FACTORY_ENABLED=0
  process.env.RAGENT_REMOTE_FACTORY_ENABLED = '0';
  const cancelNotDispatchedRes = await callRoute(handleRemoteFactoryRoutes, {
    method: 'POST',
    pathname: `/api/remote-factory/source-bindings/src_bind_alt/operations/${rerouteRes.body.newOperationId}/cancel`,
    body: {},
  });
  equal(cancelNotDispatchedRes.statusCode, 200, 'Cancel observation works when RAGENT_REMOTE_FACTORY_ENABLED=0');
  equal(cancelNotDispatchedRes.body.offlineState, 'cancelled');
  process.env.RAGENT_REMOTE_FACTORY_ENABLED = '1';

  // ── 2B. Offline State 2: dispatched_unconfirmed (drop response after real POST) ──
  // Bring targetIdentity ONLINE via signed heartbeat HTTP route!
  const signedHeartbeat = await deviceRegistry.signDeviceCapabilityReport({
    platform: 'linux',
    status: 'online',
    heartbeatAt: new Date().toISOString(),
    staleAfterMs: 120_000,
    availableHarnesses: ['codex'],
    capabilities: ['git', 'docs'],
    authorizedWorkspaceRoots: [targetRepoDir],
    maxConcurrentRuns: 2,
    currentConcurrentRuns: 0,
    isolation: { supported: true, enforced: true, mode: 'worktree', readOnlySupported: true },
  }, { identity: targetIdentity });
  const hbRouteRes = await callRoute(handleRemoteFactoryRoutes, {
    method: 'POST',
    pathname: '/api/remote-factory/devices/heartbeat',
    body: { signedReport: signedHeartbeat },
  });
  equal(hbRouteRes.statusCode, 200, 'Target heartbeat persisted via HTTP route');
  equal(hbRouteRes.body.device.status, 'online');

  const item2 = await createClaimedSourceWorkItem('state2', srcWriter2);
  const op2Id = `op_state2_${item2.binding.id}`;
  // Custom proxyImpl: lets real POST execute on target, then drops response to simulate disconnect!
  const dropAfterPostProxy = async (args) => {
    const res = await proxyToTarget(args);
    if (args.method === 'POST' && args.operation === 'factory.remote.accept') {
      throw new Error('Simulated TCP reset after target accepted dispatch');
    }
    return res;
  };

  const unconfirmedRes = await remoteFactorySource.dispatchRemoteFactoryOperation({
    organizationId: srcOrg.id,
    workItemId: item2.workItem.id,
    expectedVersion: item2.workItem.rowVersion,
    sourceFactoryBindingId: item2.binding.id,
    contractRevision: 1,
    executionEpoch: item2.workItem.executionEpoch,
    bindingGeneration: item2.workItem.bindingGeneration,
    leaseOwnerToken: item2.lease.ownerToken,
    leaseGeneration: item2.lease.generation,
    operationId: op2Id,
    requestId: op2Id,
    contractDigest,
    taskRequirements: { requiredPlatform: 'linux', requiredHarness: 'codex', workspaceRoot: targetRepoDir },
    payload: {
      contract: item2.workItem.contract,
      sourceReservationId: item2.budgetKey,
      reservedCost: 1.0,
      reservedTokens: 5000,
      expectedBaseHead: baseline.baseHead,
      expectedBaseBranch: baseline.baseBranch,
      expectedBaselineDigest: baseline.baselineDigest,
    },
  }, serviceActor, {
    autoRoute: true,
    verifyExternal: () => inspectSourceRemoteBaseline(sourceRepoDir, ['docs']),
    proxyImpl: dropAfterPostProxy,
  });

  equal(unconfirmedRes.offlineState, 'dispatched_unconfirmed', 'Dropped POST response enters dispatched_unconfirmed');
  equal(unconfirmedRes.replayForbidden, true);
  equal((await targetControl('/test-control/stats')).body.remoteFactoryAcceptCalls, 1, 'Target admitted POST exactly once');

  // Blind replay attempt MUST NOT re-send POST!
  const replayAttempt = await remoteFactorySource.dispatchRemoteFactoryOperation({
    organizationId: srcOrg.id,
    workItemId: item2.workItem.id,
    expectedVersion: item2.workItem.rowVersion,
    sourceFactoryBindingId: item2.binding.id,
    contractRevision: 1,
    executionEpoch: item2.workItem.executionEpoch,
    bindingGeneration: item2.workItem.bindingGeneration,
    leaseOwnerToken: item2.lease.ownerToken,
    leaseGeneration: item2.lease.generation,
    bindingId: 'src_bind_1',
    bindingVersion: 1,
    operationId: op2Id,
    requestId: op2Id,
    contractDigest,
    payload: {
      contract: item2.workItem.contract,
      sourceReservationId: item2.budgetKey,
      reservedCost: 1.0,
      reservedTokens: 5000,
      sourceBindingId: 'src_bind_1',
      sourceBindingVersion: 1,
      expectedBaseHead: baseline.baseHead,
      expectedBaseBranch: baseline.baseBranch,
      expectedBaselineDigest: baseline.baselineDigest,
    },
  }, serviceActor, { verifyExternal: () => inspectSourceRemoteBaseline(sourceRepoDir, ['docs']) });
  equal(replayAttempt.replayForbidden, true, 'Blind replay forbidden for dispatched_unconfirmed');
  equal((await targetControl('/test-control/stats')).body.remoteFactoryAcceptCalls, 1, 'Target accept count stays 1 (no blind replay)');

  // Reroute MUST also be forbidden on dispatched_unconfirmed!
  const rerouteForbiddenRes = await callRoute(handleRemoteFactoryRoutes, {
    method: 'POST',
    pathname: `/api/remote-factory/source-bindings/src_bind_1/operations/${op2Id}/reroute`,
    body: { newBindingId: 'src_bind_alt' },
  });
  equal(rerouteForbiddenRes.statusCode, 409, 'Rerouting dispatched_unconfirmed operation is forbidden');

  // Reconnect & query signed receipt -> transitions to dispatched_confirmed!
  const receiptRes = await remoteFactorySource.queryRemoteFactoryOperation('src_bind_1', op2Id, ownerActor);
  equal(receiptRes.offlineState, 'dispatched_confirmed', 'Reconnect receipt query confirms target work item');
  ok(receiptRes.target?.workItemId, 'Signed receipt includes target workItemId');

  // ── 2C. Offline State 3: executed_unsynced -> pull signed candidate -> independent source review ──
  // Execute child work item to 'review' on target instance while source stays disconnected!
  const execChildRes = await targetControl('/test-control/execute-child', {
    bindingId: 'tgt_bind_1',
    operationId: op2Id,
  });
  equal(execChildRes.status, 200);
  equal(execChildRes.body.workItem.state, 'review', 'Target executed child Work Item to review');

  // Disable RAGENT_REMOTE_FACTORY_ENABLED on BOTH sides to verify read/reconcile/candidate pull still works when disabled!
  process.env.RAGENT_REMOTE_FACTORY_ENABLED = '0';
  await targetControl('/test-control/flags', { remoteFactoryEnabled: '0' });

  const reconcileRes = await callRoute(handleRemoteFactoryRoutes, {
    method: 'POST',
    pathname: `/api/remote-factory/source-bindings/src_bind_1/operations/${op2Id}/reconcile`,
    body: {},
  });
  equal(reconcileRes.statusCode, 200, 'Reconcile succeeds even when RAGENT_REMOTE_FACTORY_ENABLED=0');
  equal(reconcileRes.body.offlineState, 'synced');
  equal(reconcileRes.body.action, 'synced_to_review');
  equal(reconcileRes.body.reviewReady, true);
  ok(reconcileRes.body.candidateDigest, 'Pulled verified candidate digest');

  const sourceItemAfterSync = (await factoryControl.getFactoryWorkItem(srcOrg.id, item2.workItem.id, ownerActor)).item;
  equal(sourceItemAfterSync.state, 'review', 'Source Work Item moved to review after candidate sync');
  equal(sourceItemAfterSync.bindings[0].status, 'remote_candidate');

  // Read remote evidence via HTTP route while disabled
  const evRes = await callRoute(handleRemoteFactoryRoutes, {
    method: 'GET',
    pathname: `/api/organizations/${srcOrg.id}/factory/work-items/${item2.workItem.id}/remote-evidence`,
  });
  equal(evRes.statusCode, 200, 'Remote evidence route readable while disabled');
  ok(evRes.body.changes.some((c) => c.path === 'docs/remote-output.md'), 'Remote candidate diff includes docs/remote-output.md');

  // Feed into independent source review Work Item & complete acceptance!
  const revWiRes = await factoryControl.executeFactoryCommand({
    organizationId: srcOrg.id,
    commandId: 'cmd-wi-indrev',
    idempotencyKey: 'wi-indrev',
    type: 'CreateWorkItem',
    payload: {
      goalId: item2.goalId,
      assigneeNodeId: srcReviewer.node.id,
      kind: 'review',
      dependencies: [{ predecessorId: item2.workItem.id, milestone: 'candidate_ready' }],
      contract: {
        objective: 'Independently review remote candidate diff in isolated validation workspace',
        acceptanceCriteria: [{ id: 'independent-review', method: 'manual' }],
        accessMode: 'read',
        retry: { maxAttempts: 1 },
        budget: { maxCost: 1.0, maxTokens: 3000 },
        budgetReservation: { cost: 1.0, tokens: 3000 },
        organizationRevision: 1,
      },
    },
  }, ownerActor);
  const revApproved = await factoryControl.executeFactoryCommand({
    organizationId: srcOrg.id,
    commandId: 'cmd-app-indrev',
    idempotencyKey: 'app-indrev',
    type: 'ApproveContract',
    targetId: revWiRes.item.id,
    expectedVersion: revWiRes.item.rowVersion,
    payload: {},
  }, ownerActor);
  equal(revApproved.item.state, 'blocked', 'Review item blocked on candidate_ready pin before reconcile');
  await withDatabase((db) => {
    db.prepare(`
      INSERT INTO factory_workflow_instances (
        id, organization_id, goal_id, template_id, template_version,
        template_digest, input_digest, mapping_json, created_at
      ) VALUES (?,?,?,?,?,?,?,?,?)
    `).run(
      `wfi_stage4_${item2.workItem.id}`,
      srcOrg.id,
      item2.goalId,
      'ragent-reviewed-change',
      1,
      createHash('sha256').update('ragent-reviewed-change:v1').digest('hex'),
      createHash('sha256').update(item2.workItem.id).digest('hex'),
      JSON.stringify({ implementation: item2.workItem.id, review: revWiRes.item.id }),
      new Date().toISOString(),
    );
  });

  let launchedReviewRun = null;
  const srcOrchestrator = createCollaborationOrchestrator({
    pollMs: 100000,
    dependencies: {
      sendMessage: async (sid, txt, imgs, opts = {}) => {
        const sess = await sessionManager.getSession(sid);
        const validationFile = join(sess.folder, 'docs', 'remote-output.md');
        ok(existsSync(validationFile), 'Validation workspace materialized remote candidate file for independent review');
        const outcome = await sessionManager.sendMessage(sid, txt, imgs, { ...opts, skipRunnerLaunch: true });
        launchedReviewRun = {
          sessionId: sid,
          runId: outcome.run.id,
          requestId: outcome.run.requestId || opts.requestId,
          organizationMessageScope: opts.organizationMessageScope,
        };
        return outcome;
      },
    },
  });
  await factoryControl.releaseFactorySchedulerLease({
    organizationId: srcOrg.id,
    ownerToken: item2.lease.ownerToken,
    generation: item2.lease.generation,
  }, serviceActor);
  const srcAdapter = createFactoryExecutionAdapter({ organizationId: srcOrg.id, actor: serviceActor, orchestrator: srcOrchestrator });
  const schedulerErrors = [];
  sourceScheduler = createFactoryScheduler({
    organizationId: srcOrg.id,
    actor: serviceActor,
    adapter: srcAdapter,
    admissionEnabled: true,
    pollMs: 60000,
    onError: (err) => { schedulerErrors.push(err); },
  });
  await sourceScheduler.start();
  await sourceScheduler.tick();
  equal(schedulerErrors.length, 0, `Source scheduler had no errors: ${schedulerErrors.map((e) => e?.message).join('; ')}`);
  const revRunning = (await factoryControl.getFactoryWorkItem(srcOrg.id, revWiRes.item.id, ownerActor)).item;
  if (!revRunning.bindings[0]?.runId) {
    const diag = await withDatabase((db) => ({
      attempts: db.prepare('SELECT id,task_id,state,failure_kind,failure_reason,run_id FROM collaboration_attempts').all(),
      cmds: db.prepare('SELECT * FROM collaboration_dispatch_commands').all(),
      ws: db.prepare('SELECT * FROM factory_validation_workspaces').all(),
    }));
    throw new Error(`Review run missing runId: launchedReviewRun=${JSON.stringify(launchedReviewRun)} revRunning=${JSON.stringify(revRunning)} diag=${JSON.stringify(diag)}`);
  }
  ok(revRunning.bindings[0]?.runId, 'Independent review Run launched against remote candidate');
  equal(revRunning.state, 'running', 'Independent review Work Item bound to running state');
  ok(launchedReviewRun?.runId === revRunning.bindings[0].runId, 'Captured launched review Run metadata');
  const revManifest = await runs.getRunManifest(launchedReviewRun.runId);
  const revScope = revManifest?.options?.sessionControlChannel?.scope || launchedReviewRun.organizationMessageScope;
  await factoryReviewOpinions.submitFactoryReviewOpinion({
    candidateWorkItemId: item2.workItem.id,
    candidateDigest: sourceItemAfterSync.candidateDigest,
    contractRevision: sourceItemAfterSync.contractRevision,
    executionEpoch: sourceItemAfterSync.executionEpoch,
    verdict: 'pass',
    reason: 'Verified remote docs/remote-output.md in isolated validation workspace.',
    idempotencyKey: 'rev-op-stage4-1',
  }, {
    principalKind: 'run_capability',
    capabilityOperation: 'factory.review.submit',
    runId: launchedReviewRun.runId,
    sessionId: launchedReviewRun.sessionId,
    organizationMessageScope: revScope,
  });
  await history.appendEvent(launchedReviewRun.sessionId, {
    type: 'message', role: 'assistant', content: 'Independent review passed.', runId: launchedReviewRun.runId,
    requestId: launchedReviewRun.requestId, messagePhase: 'final_answer', providerMessageId: 'msg_' + launchedReviewRun.runId, timestamp: Date.now(),
  });
  await history.appendEvent(launchedReviewRun.sessionId, {
    type: 'usage', runId: launchedReviewRun.runId, requestId: launchedReviewRun.requestId,
    usageScope: 'provider_turn_total', costSource: 'provider_reported', usageAccountingTokens: 120, costUsd: 0.02, timestamp: Date.now(),
  });
  const revCompletedAt = new Date().toISOString();
  await runs.writeRunResult(launchedReviewRun.runId, { exitCode: 0, signal: null, completedAt: revCompletedAt });
  await runs.updateRun(launchedReviewRun.runId, (c) => ({ ...c, state: 'completed', completedAt: revCompletedAt, finalizedAt: revCompletedAt }));
  await srcOrchestrator.completeRun(launchedReviewRun.runId);
  const opinions = await withDatabase((db) => db.prepare('SELECT id FROM factory_review_opinions WHERE candidate_work_item_id=?').all(item2.workItem.id));
  equal(opinions.length, 1, 'Independent review opinion submitted');
  await factoryReviewOpinions.reconcileFactoryReviewOpinion({ organizationId: srcOrg.id, opinionId: opinions[0].id }, ownerActor);

  const acceptRemote = await factoryAcceptance.decideFactoryManualAcceptance({
    organizationId: srcOrg.id,
    workItemId: item2.workItem.id,
    criterionId: 'remote-execution-result',
    decision: 'passed',
    rationale: 'Accepted after independent review of synced remote candidate.',
    contractRevision: sourceItemAfterSync.contractRevision,
    candidateDigest: sourceItemAfterSync.candidateDigest,
    gateGeneration: sourceItemAfterSync.gateGeneration,
    expectedVersion: sourceItemAfterSync.rowVersion,
    commandId: 'cmd-acc-remote',
    idempotencyKey: 'acc-remote',
  }, ownerActor);
  equal(acceptRemote.item.state, 'completed', 'Remote Work Item completed after independent review + owner acceptance');
  await sourceScheduler.stop();
  sourceScheduler = null;

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST GROUP 3: Chunked Large-File, Directory Bundle, Tamper/Traversal & Gates
  // ═══════════════════════════════════════════════════════════════════════════
  // Verify default-off gate when RAGENT_REMOTE_FILE_TRANSFER_ENABLED='0'
  const fileGateGrantRes = await callRoute(handleRemoteFileRoutes, {
    method: 'POST',
    pathname: '/api/remote-files/grants',
    body: { sessionId: srcRootSession.id },
  });
  equal(fileGateGrantRes.statusCode, 503, 'Remote file grant creation blocked when RAGENT_REMOTE_FILE_TRANSFER_ENABLED=0');
  equal(fileGateGrantRes.body.code, 'REMOTE_FILE_TRANSFER_DISABLED');

  const fileGateSendRes = await callRoute(handleRemoteFileRoutes, {
    method: 'POST',
    pathname: '/api/remote-files/grants/g1/transfers/t1/send',
    body: {},
  });
  equal(fileGateSendRes.statusCode, 503, 'Remote file send blocked when RAGENT_REMOTE_FILE_TRANSFER_ENABLED=0');

  await rejectsCode(
    () => remoteFileTransfer.sendRemoteFile('g1', 't1', ownerActor),
    'REMOTE_FILE_TRANSFER_DISABLED',
    'sendRemoteFile enforces default-off gate',
  );
  await rejectsCode(
    () => remoteFileTransfer.receiveRemoteFile({}, { targetRuntime: true, targetRuntimeOperation: 'file.transfer.write', targetRuntimeResourceId: 'g1' }),
    'REMOTE_FILE_TRANSFER_DISABLED',
    'receiveRemoteFile enforces default-off gate',
  );

  // Enable RAGENT_REMOTE_FILE_TRANSFER_ENABLED='1' on both instances
  process.env.RAGENT_REMOTE_FILE_TRANSFER_ENABLED = '1';
  await targetControl('/test-control/flags', { remoteFileTransferEnabled: '1' });

  // ── 3A. Backwards-compatible <= 4 MiB single-file signed transfer ──────────
  const smallPayload = Buffer.from('Backwards compatible <= 4 MiB single-file payload.\n', 'utf8');
  const smallSha = createHash('sha256').update(smallPayload).digest('hex');
  const smallIntent = await createFileAssetUploadIntent({
    sessionId: srcRootSession.id,
    originalName: 'legacy-small.txt',
    mimeType: 'text/plain',
    sizeBytes: smallPayload.length,
    sha256: smallSha,
    requestId: 'req-small-1',
    forceLocal: true,
  });
  await ingestFileAssetUpload(smallIntent.asset.id, Readable.from(smallPayload));
  await finalizeFileAssetUpload(smallIntent.asset.id, { sizeBytes: smallPayload.length });

  await targetControl('/test-control/configure-file-grant', {
    id: 'tgt_fg_small',
    role: 'target',
    peerId: sourceIdentity.instanceId,
    peerKey: sourceIdentity.publicKey,
    peerGrantId: 'src_fg_small',
    peerVersion: 1,
    sha256: smallSha,
    sizeBytes: smallPayload.length,
    filename: 'legacy-small.txt',
    mime: 'text/plain',
    expectedVersion: 0,
    expiresAt: futureExpiry,
  });
  const smallSrcGrantRes = await callRoute(handleRemoteFileRoutes, {
    method: 'POST',
    pathname: '/api/remote-files/grants',
    body: {
      id: 'src_fg_small',
      role: 'source',
      peerId: targetIdentity.instanceId,
      peerKey: targetIdentity.publicKey,
      sessionId: srcRootSession.id,
      assetId: smallIntent.asset.id,
      peerGrantId: 'tgt_fg_small',
      peerVersion: 1,
      sha256: smallSha,
      sizeBytes: smallPayload.length,
      filename: 'legacy-small.txt',
      mime: 'text/plain',
      expectedVersion: 0,
      expiresAt: futureExpiry,
    },
  });
  equal(smallSrcGrantRes.statusCode, 200, 'Legacy <=4 MiB single-file grant configured');

  const smallSendRes = await callRoute(handleRemoteFileRoutes, {
    method: 'POST',
    pathname: '/api/remote-files/grants/src_fg_small/transfers/tr_small_1/send',
    body: {},
  });
  equal(smallSendRes.statusCode, 200);
  equal(smallSendRes.body.status, 'received', 'Legacy single-file signed transfer succeeded');
  equal(smallSendRes.body.sha256, smallSha);

  // ── 3B. Large file (> 4 MiB = 4.5 MiB) resumable chunked transfer + unknown_outcome recovery ──
  const largeDir = join(sourceRepoDir, 'artifacts');
  mkdirSync(largeDir, { recursive: true });
  const largeFilePath = join(largeDir, 'large-bundle.bin');
  const largeBuf = randomBytes(4 * 1024 * 1024 + 512 * 1024); // 4.5 MiB (> 4 MiB legacy limit!)
  writeFileSync(largeFilePath, largeBuf);
  const largeFileSha = createHash('sha256').update(largeBuf).digest('hex');

  const largeManifestBuilt = await remoteFileTransfer.buildRemoteTransferManifest({
    transferMode: 'chunked_file',
    sourcePath: largeFilePath,
    sessionId: srcRootSession.id,
    bundleName: 'large-bundle.bin',
    chunkBytes: 1024 * 1024, // 5 chunks (4x1MiB + 512KiB)
  });
  equal(largeManifestBuilt.manifest.totalChunks, 5, '4.5 MiB file splits into 5x 1 MiB chunks');
  equal(largeManifestBuilt.manifest.totalBytes, largeBuf.length);

  await targetControl('/test-control/configure-file-grant', {
    id: 'tgt_fg_large',
    role: 'target',
    peerId: sourceIdentity.instanceId,
    peerKey: sourceIdentity.publicKey,
    peerGrantId: 'src_fg_large',
    peerVersion: 1,
    transferMode: 'chunked_file',
    manifestDigest: largeManifestBuilt.manifestDigest,
    chunkBytes: 1024 * 1024,
    fileCount: 1,
    sizeBytes: largeBuf.length,
    filename: 'large-bundle.bin',
    expectedVersion: 0,
    expiresAt: futureExpiry,
  });
  await remoteFileTransfer.configureRemoteFileGrant({
    id: 'src_fg_large',
    role: 'source',
    peerId: targetIdentity.instanceId,
    peerKey: targetIdentity.publicKey,
    sessionId: srcRootSession.id,
    sourcePath: largeFilePath,
    peerGrantId: 'tgt_fg_large',
    peerVersion: 1,
    transferMode: 'chunked_file',
    manifestDigest: largeManifestBuilt.manifestDigest,
    chunkBytes: 1024 * 1024,
    fileCount: 1,
    sizeBytes: largeBuf.length,
    filename: 'large-bundle.bin',
    expectedVersion: 0,
    expiresAt: futureExpiry,
  }, ownerActor);

  // Phase 1: Upload 2 chunks then pause (`stopAfterChunks: 2`)
  const part1 = await remoteFileTransfer.sendRemoteFile('src_fg_large', 'tr_large_1', ownerActor, { stopAfterChunks: 2 });
  equal(part1.status, 'resumable', 'Transfer paused cleanly after 2 chunks');
  deepEqual(part1.confirmedChunks, [0, 1]);
  equal(part1.nextChunkIndex, 2);

  // Phase 2: Resume, let chunk 2 commit on target, then drop response -> unknown_outcome!
  const statsBeforeDrop = (await targetControl('/test-control/stats')).body.remoteFileChunkCalls;
  let chunk2Dropped = false;
  const dropChunk2ResponseProxy = async (args) => {
    const res = await proxyToTarget(args);
    if (args.method === 'POST' && args.body && String(args.body).includes('"chunkIndex":2') && !chunk2Dropped) {
      chunk2Dropped = true;
      throw new Error('Simulated timeout after chunk 2 committed on target');
    }
    return res;
  };
  const droppedChunkRes = await remoteFileTransfer.resumeRemoteManifestTransfer('src_fg_large', 'tr_large_1', ownerActor, {
    proxyImpl: dropChunk2ResponseProxy,
  });
  equal(droppedChunkRes.status, 'unknown_outcome', 'Dropped chunk response enters unknown_outcome');
  equal(droppedChunkRes.pendingChunkIndex, 2);

  // Blind resend MUST be refused without reconciliation!
  const blindResend = await remoteFileTransfer.sendRemoteFile('src_fg_large', 'tr_large_1', ownerActor);
  equal(blindResend.status, 'unknown_outcome');
  equal(blindResend.reason, 'reconcile_required');
  equal(blindResend.replayForbidden, true);
  equal((await targetControl('/test-control/stats')).body.remoteFileChunkCalls, statsBeforeDrop + 1, 'Blind resend did NOT retransmit chunk 2');

  // Reconcile while RAGENT_REMOTE_FILE_TRANSFER_ENABLED='0' -> discovers chunk 2 ALREADY confirmed!
  process.env.RAGENT_REMOTE_FILE_TRANSFER_ENABLED = '0';
  const reconciledChunkRes = await callRoute(handleRemoteFileRoutes, {
    method: 'POST',
    pathname: '/api/remote-files/grants/src_fg_large/transfers/tr_large_1/reconcile',
    body: {},
  });
  equal(reconciledChunkRes.statusCode, 200, 'File reconciliation succeeds even when RAGENT_REMOTE_FILE_TRANSFER_ENABLED=0');
  equal(reconciledChunkRes.body.status, 'resumable');
  deepEqual(reconciledChunkRes.body.confirmedChunks, [0, 1, 2], 'Reconcile observed chunk 2 already persisted on target');
  equal(reconciledChunkRes.body.nextChunkIndex, 3);

  // Re-enable transfer and resume -> drop finalize response AFTER target finalizes!
  process.env.RAGENT_REMOTE_FILE_TRANSFER_ENABLED = '1';
  const statsBeforeResume = (await targetControl('/test-control/stats')).body.remoteFileChunkCalls;
  const dropFinalizeProxy = async (args) => {
    const res = await proxyToTarget(args);
    if (args.method === 'POST' && args.body && String(args.body).includes('"action":"finalize_manifest"')) {
      throw new Error('Simulated timeout after target finalized manifest');
    }
    return res;
  };
  const droppedFinRes = await remoteFileTransfer.resumeRemoteManifestTransfer('src_fg_large', 'tr_large_1', ownerActor, {
    proxyImpl: dropFinalizeProxy,
  });
  equal(droppedFinRes.status, 'unknown_outcome', 'Dropped finalize response enters unknown_outcome');
  // Only chunk 3, chunk 4, and finalize (3 POST calls) should have been sent (chunk 2 was NOT resent!)
  equal((await targetControl('/test-control/stats')).body.remoteFileChunkCalls - statsBeforeResume, 3, 'Resumed only remaining chunks 3, 4 and finalize without resending chunk 2');

  // Reconcile after dropped finalize -> discovers transfer already received!
  const finReconcile = await remoteFileTransfer.reconcileRemoteFileTransfer('src_fg_large', 'tr_large_1', ownerActor);
  equal(finReconcile.status, 'received', 'Reconcile resolves unknown_outcome finalize to received');
  equal(finReconcile.blindResendAvoided, true);
  equal(finReconcile.totalBytes, largeBuf.length);
  ok(finReconcile.targetAssetId, 'Target created real FileAsset for 4.5 MiB chunked file');
  const targetAssetMetaPath = join(targetConfigDir, 'file-assets', `${finReconcile.targetAssetId}.json`);
  ok(existsSync(targetAssetMetaPath), 'Target FileAsset metadata JSON exists on disk');
  const targetAssetMeta = JSON.parse(readFileSync(targetAssetMetaPath, 'utf8'));
  const targetAssetFile = join(targetConfigDir, 'file-assets', 'objects', targetAssetMeta.storage.localFilename);
  ok(existsSync(targetAssetFile), 'Target assembled 4.5 MiB file asset exists on disk');
  equal(createHash('sha256').update(readFileSync(targetAssetFile)).digest('hex'), largeFileSha, 'Assembled 4.5 MiB file SHA-256 matches byte-for-byte');

  // ── 3C. Bounded Directory Bundle Transfer ─────────────────────────────────
  const bundleSrcDir = join(sourceRepoDir, 'bundle_src');
  mkdirSync(join(bundleSrcDir, 'sub'), { recursive: true });
  writeFileSync(join(bundleSrcDir, 'index.json'), JSON.stringify({ ok: true, stage: 4 }), 'utf8');
  writeFileSync(join(bundleSrcDir, 'empty.txt'), '', 'utf8');
  writeFileSync(join(bundleSrcDir, 'sub', 'payload.bin'), randomBytes(2000));

  const bundleBuilt = await remoteFileTransfer.buildRemoteTransferManifest({
    transferMode: 'directory_bundle',
    sourcePath: bundleSrcDir,
    sessionId: srcRootSession.id,
    bundleName: 'stage4-bundle',
    chunkBytes: 512,
  });
  equal(bundleBuilt.manifest.fileCount, 3, 'Directory bundle includes nested + 0-byte files');

  await targetControl('/test-control/configure-file-grant', {
    id: 'tgt_fg_bundle',
    role: 'target',
    peerId: sourceIdentity.instanceId,
    peerKey: sourceIdentity.publicKey,
    peerGrantId: 'src_fg_bundle',
    peerVersion: 1,
    transferMode: 'directory_bundle',
    manifestDigest: bundleBuilt.manifestDigest,
    chunkBytes: 512,
    fileCount: bundleBuilt.manifest.fileCount,
    sizeBytes: bundleBuilt.manifest.totalBytes,
    filename: 'stage4-bundle',
    targetDir: 'received_bundle',
    expectedVersion: 0,
    expiresAt: futureExpiry,
  });
  await remoteFileTransfer.configureRemoteFileGrant({
    id: 'src_fg_bundle',
    role: 'source',
    peerId: targetIdentity.instanceId,
    peerKey: targetIdentity.publicKey,
    sessionId: srcRootSession.id,
    sourcePath: bundleSrcDir,
    peerGrantId: 'tgt_fg_bundle',
    peerVersion: 1,
    transferMode: 'directory_bundle',
    manifestDigest: bundleBuilt.manifestDigest,
    chunkBytes: 512,
    fileCount: bundleBuilt.manifest.fileCount,
    sizeBytes: bundleBuilt.manifest.totalBytes,
    filename: 'stage4-bundle',
    expectedVersion: 0,
    expiresAt: futureExpiry,
  }, ownerActor);

  const bundleResult = await remoteFileTransfer.sendRemoteFile('src_fg_bundle', 'tr_bundle_1', ownerActor);
  equal(bundleResult.status, 'received', 'Directory bundle transfer completed');
  equal(bundleResult.fileCount, 3);
  equal(readFileSync(join(targetRepoDir, 'received_bundle', 'index.json'), 'utf8'), JSON.stringify({ ok: true, stage: 4 }));
  equal(readFileSync(join(targetRepoDir, 'received_bundle', 'empty.txt')).length, 0);
  deepEqual(
    readFileSync(join(targetRepoDir, 'received_bundle', 'sub', 'payload.bin')),
    readFileSync(join(bundleSrcDir, 'sub', 'payload.bin')),
    'Nested binary file in directory bundle matches byte-for-byte',
  );

  // ── 3D. Tamper, Path-Traversal & Symlink Rejection ────────────────────────
  // Path traversal & restricted paths
  for (const badPath of ['../escape.txt', 'docs/../../secret', 'a\\b.txt', '.git/config', 'creds/id_rsa', 'certs/key.pem', 'C:/Windows/win.ini']) {
    assertions += 1;
    assert.throws(
      () => remoteFileTransfer.validateBundleRelativePath(badPath),
      (err) => /^FILE_TRANSFER_PATH_/.test(String(err?.code || '')),
      `Path traversal or restricted path rejected: ${badPath}`,
    );
  }

  // Symlink / junction rejection in directory bundle scan
  const symlinkBundleDir = join(sourceRepoDir, 'symlink_bundle');
  const outsideTargetDir = join(tempRoot, 'outside_secret_dir');
  mkdirSync(symlinkBundleDir, { recursive: true });
  mkdirSync(outsideTargetDir, { recursive: true });
  writeFileSync(join(outsideTargetDir, 'secret.txt'), 'do not leak', 'utf8');
  writeFileSync(join(symlinkBundleDir, 'normal.txt'), 'ok', 'utf8');
  symlinkSync(outsideTargetDir, join(symlinkBundleDir, 'escaped_link'), process.platform === 'win32' ? 'junction' : 'dir');

  await rejectsCode(
    () => remoteFileTransfer.buildRemoteTransferManifest({
      transferMode: 'directory_bundle',
      sourcePath: symlinkBundleDir,
      sessionId: srcRootSession.id,
      chunkBytes: 512,
    }),
    'FILE_TRANSFER_SYMLINK_REJECTED',
    'Directory bundle containing symlink/junction is rejected',
  );

  // Source path escaping session folder rejected
  await rejectsCode(
    () => remoteFileTransfer.configureRemoteFileGrant({
      id: 'src_escape_grant',
      role: 'source',
      peerId: targetIdentity.instanceId,
      peerKey: targetIdentity.publicKey,
      sessionId: srcRootSession.id,
      sourcePath: outsideTargetDir,
      peerGrantId: 'tgt_escape',
      peerVersion: 1,
      transferMode: 'directory_bundle',
      manifestDigest: bundleBuilt.manifestDigest,
      chunkBytes: 512,
      fileCount: 1,
      sizeBytes: 10,
      filename: 'escape',
      expectedVersion: 0,
      expiresAt: futureExpiry,
    }, ownerActor),
    'FILE_TRANSFER_PATH_FORBIDDEN',
    'Grant referencing path outside session folder is rejected',
  );

  // Chunk tamper rejection on target (flip 1 byte inside chunk!)
  const tamperManifest = await remoteFileTransfer.buildRemoteTransferManifest({
    transferMode: 'chunked_file',
    sourcePath: largeFilePath,
    sessionId: srcRootSession.id,
    bundleName: 'tamper-test.bin',
    chunkBytes: 1024 * 1024,
  });
  await targetControl('/test-control/configure-file-grant', {
    id: 'tgt_fg_tamper',
    role: 'target',
    peerId: sourceIdentity.instanceId,
    peerKey: sourceIdentity.publicKey,
    peerGrantId: 'src_fg_tamper',
    peerVersion: 1,
    transferMode: 'chunked_file',
    manifestDigest: tamperManifest.manifestDigest,
    chunkBytes: 1024 * 1024,
    fileCount: 1,
    sizeBytes: largeBuf.length,
    filename: 'tamper-test.bin',
    expectedVersion: 0,
    expiresAt: futureExpiry,
  });
  await remoteFileTransfer.configureRemoteFileGrant({
    id: 'src_fg_tamper',
    role: 'source',
    peerId: targetIdentity.instanceId,
    peerKey: targetIdentity.publicKey,
    sessionId: srcRootSession.id,
    sourcePath: largeFilePath,
    peerGrantId: 'tgt_fg_tamper',
    peerVersion: 1,
    transferMode: 'chunked_file',
    manifestDigest: tamperManifest.manifestDigest,
    chunkBytes: 1024 * 1024,
    fileCount: 1,
    sizeBytes: largeBuf.length,
    filename: 'tamper-test.bin',
    expectedVersion: 0,
    expiresAt: futureExpiry,
  }, ownerActor);

  let tamperedStatus = 0;
  const tamperChunkProxy = async (args) => {
    if (args.method === 'POST' && args.body && String(args.body).includes('"action":"upload_chunk"')) {
      const parsed = JSON.parse(args.body);
      const buf = Buffer.from(parsed.bytesBase64, 'base64');
      buf[0] ^= 0xff; // Corrupt 1 byte!
      parsed.bytesBase64 = buf.toString('base64');
      const res = await proxyToTarget({ ...args, body: JSON.stringify(parsed) });
      tamperedStatus = res.response.status;
      return res;
    }
    return proxyToTarget(args);
  };
  const tamperRes = await remoteFileTransfer.sendRemoteFile('src_fg_tamper', 'tr_tamper_1', ownerActor, {
    proxyImpl: tamperChunkProxy,
  });
  equal(tamperRes.status, 'unknown_outcome');
  equal(tamperedStatus, 403, 'Target rejected tampered chunk bytes with 403');

  // Verify target grant revocation works even when RAGENT_REMOTE_FILE_TRANSFER_ENABLED='0'
  process.env.RAGENT_REMOTE_FILE_TRANSFER_ENABLED = '0';
  const revokeRes = await callRoute(handleRemoteFileRoutes, {
    method: 'POST',
    pathname: '/api/remote-files/grants/src_fg_tamper/revoke',
    body: { expectedVersion: 1 },
  });
  equal(revokeRes.statusCode, 200, 'Grant revocation allowed when RAGENT_REMOTE_FILE_TRANSFER_ENABLED=0');
  equal(revokeRes.body.enabled, false);

  console.log(`test-stage4-device-mesh: ok (${assertions} assertions)`);
} finally {
  try { if (sourceScheduler) await sourceScheduler.stop(); } catch {}
  try { await targetControl('/test-control/shutdown'); } catch {}
  try {
    await new Promise((r) => {
      if (targetProc.exitCode !== null) return r();
      const t = setTimeout(() => { try { targetProc.kill('SIGKILL'); } catch {} r(); }, 2000);
      targetProc.once('exit', () => { clearTimeout(t); r(); });
    });
  } catch {}
  try { await new Promise((r) => accountsServer.close(() => r())); } catch {}
  globalThis.fetch = realFetch;
  try { rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
}
