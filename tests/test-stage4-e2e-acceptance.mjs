#!/usr/bin/env node
// Stage 4 End-to-End Acceptance Suite (S4.1 Cross-Device Mesh + S4.2 Unified Connector Contract)
//
// Independently verifies Stage 4 exit criteria end-to-end across real SQLite stores,
// HTTP route handlers, dual-process target runtime, Ed25519 signatures, and
// cross-mesh responsibility capability boundaries.
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
const tempRoot = mkdtempSync(join(BASE_TEMP, 'ragent-stage4-e2e-'));

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

const OWNER_ID = 'stage4-e2e-owner';
const ACCOUNT_ID = 'acct_stage4_e2e';
const DEVICE_ID = 'rdev_stage4_e2e';
const BINDING_AUTH_REV = '1';

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

// Isolate source instance completely before importing any Ragent module.
process.env.HOME = sourceRoot;
process.env.USERPROFILE = sourceRoot;
process.env.LOCALAPPDATA = join(sourceRoot, 'localappdata');
process.env.APPDATA = join(sourceRoot, 'appdata');
process.env.ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
process.env.RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
process.env.RAGENT_INSTANCE_ROOT = sourceInstanceRoot;
process.env.RAGENT_CONFIG_DIR = sourceConfigDir;
process.env.RAGENT_DATA_DIR = sourceDataDir;
process.env.RAGENT_WORK_ROOT_DIR = sourceWorkRootDir;
process.env.RAGENT_MEMORY_DIR = sourceMemoryDir;
process.env.RAGENT_HARNESS_ROOT = harnessRoot;
process.env.RAGENT_ACCOUNTS_URL = 'https://accounts.stage4-e2e.invalid/accounts';
process.env.RAGENT_ACCOUNTS_ISSUER = 'https://accounts.stage4-e2e.invalid/accounts';
process.env.RAGENT_AUTH_SESSION_SECRET = 'stage4-e2e-auth-secret-0123456789abcdef';
process.env.SECURE_COOKIES = '0';
process.env.RAGENT_ORG_SCHEMA_ENABLED = '1';
process.env.RAGENT_ORG_PROJECTION_V1_ENABLED = '1';
process.env.RAGENT_ORG_PROJECTION_V2_ENABLED = '1';
process.env.RAGENT_MANAGED_WRITER_ENABLED = '1';
process.env.RAGENT_CODEX_PROVIDER_READONLY = '1';
process.env.RAGENT_FACTORY_CONTROL_ENABLED = 'true';
process.env.RAGENT_FACTORY_SCHEDULER_ENABLED = '1';
process.env.RAGENT_FACTORY_SCHEDULER_OWNER_ID = OWNER_ID;
// Start with both Stage 4 runtime gates explicitly OFF to prove default-off security.
process.env.RAGENT_REMOTE_FACTORY_ENABLED = '0';
process.env.RAGENT_REMOTE_FILE_TRANSFER_ENABLED = '0';

function initGitRepo(dir) {
  mkdirSync(join(dir, 'docs'), { recursive: true });
  execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'stage4-e2e@example.com'], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Stage4 E2E'], { stdio: 'ignore' });
  writeFileSync(join(dir, 'README.md'), '# Stage4 E2E Repo\n', 'utf8');
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
const { createInstancePublicKeyFingerprint } = await import('../lib/instance-proof-protocol.mjs');

const sourceIdentity = await identityMod.loadOrCreateInstanceIdentity();
const targetIdentity = await identityMod.loadOrCreateInstanceIdentity({ filePath: join(targetConfigDir, 'instance-identity.json') });
const macIdentity = await identityMod.loadOrCreateInstanceIdentity({ filePath: join(tempRoot, 'mac-identity.json') });
const rogueKeyPair = generateKeyPairSync('ed25519');
const roguePublicKey = rogueKeyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const rogueInstanceId = `inst_${createInstancePublicKeyFingerprint(roguePublicKey).slice(0, 32)}`;

const deviceKeyPair = generateKeyPairSync('ed25519');
const deviceToken = `rdt_${'e'.repeat(64)}`;

function seedInstanceAuth(cfgDir, instIdentity) {
  writeFileSync(join(cfgDir, 'auth.json'), JSON.stringify({ username: 'owner', passwordHash: 'unused' }), 'utf8');
  writeFileSync(join(cfgDir, 'owner-account-binding.json'), JSON.stringify({
    accountId: ACCOUNT_ID,
    provider: 'google',
    bindingAuthorityRevision: BINDING_AUTH_REV,
    boundAt: new Date().toISOString(),
  }), 'utf8');
  writeFileSync(join(cfgDir, 'owner-account-authority.json'), JSON.stringify({
    version: 1,
    instanceId: instIdentity.instanceId,
    keyFingerprint: instIdentity.keyFingerprint,
    revision: BINDING_AUTH_REV,
    deniedAccounts: [],
  }), 'utf8');
  writeFileSync(join(cfgDir, 'trusted-devices.json'), JSON.stringify({
    version: 1,
    instanceId: `rli_${instIdentity.instanceId}`,
    instanceSecret: 'ris_stage4_e2e',
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
      bindingAuthorityRevision: BINDING_AUTH_REV,
      createdAt: new Date().toISOString(),
      boundAt: new Date().toISOString(),
      revokedAt: '',
    }],
  }), 'utf8');
}
seedInstanceAuth(sourceConfigDir, sourceIdentity);
seedInstanceAuth(targetConfigDir, targetIdentity);

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
      publicEndpoint: 'https://source.stage4-e2e.invalid',
      deviceAlias: 'Win-Coordinator',
      boundAt: new Date().toISOString(),
      revokedAt: '',
    },
    {
      instanceId: targetIdentity.instanceId,
      accountId: ACCOUNT_ID,
      instancePublicKey: targetIdentity.publicKey,
      instanceKeyFingerprint: targetIdentity.keyFingerprint,
      publicEndpoint: 'https://target.stage4-e2e.invalid',
      deviceAlias: 'Linux-Target',
      boundAt: new Date().toISOString(),
      revokedAt: '',
    },
  ],
};
const broker = createOwnerAuthBroker({
  store: { async mutate(fn) { return fn(brokerState); } },
  issuer: 'https://accounts.stage4-e2e.invalid/accounts',
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
      bindingAuthorityRevision: BINDING_AUTH_REV,
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
      const result = await broker.authorizeTargetRuntime(JSON.parse(raw || '{}'));
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

// Spawn a real isolated target Ragent HTTP server process.
const targetWorkerPath = join(tempRoot, 'target-e2e-worker.mjs');
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
  if (parsed.origin === 'https://accounts.stage4-e2e.invalid') {
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

const project = await projects.createProject({ name: 'Target E2E Project', rootPath: targetRepoDir });
const writerApp = await appsMod.createApp({
  name: 'Target E2E Writer',
  tool: 'codex',
  collaborationPolicy: { role: 'writer', canDelegate: false, writablePaths: ['docs'], revision: 'te2e-1' },
});
const rootSession = await sessionManager.createSession(targetRepoDir, 'codex', 'Target E2E Root', {
  projectId: project.id, sessionClass: 'ROOT_LEADERSHIP', sessionPlane: 'user', model: 'gpt-5.3-codex', effort: 'medium',
});
const org = await orgStore.createOrganization({
  rootSessionId: rootSession.id, projectId: project.id, state: 'active', currentRevision: 1,
  policy: { factoryMaxConcurrent: 2 }, budget: { maxTotalRuns: 20, maxTokens: 50000, maxCost: 25 },
  idempotencyKey: 'target-e2e-org',
});
process.env.RAGENT_FACTORY_ORGANIZATIONS = org.id;
await orgStore.createRevision(org.id, { revision: 1, proposal: { nodes: [], edges: [] }, compiled: { nodes: [], edges: [] } });
await orgStore.freezeRevision(org.id, 1);

const roleInst = await orgStore.createRoleInstance({
  organizationId: org.id, organizationRevision: 1, stableKey: 'target_writer', role: 'writer',
  agentId: writerApp.id, lifecycleState: 'active', idempotencyKey: 'role-te2e',
});
const writerNode = await orgStore.createNode({
  organizationId: org.id, stableKey: 'target_writer', nodeRole: 'writer', createdRevision: 1,
  lifecycleState: 'active', lifecycleMode: 'formal_org',
  grant: { canWrite: true, canReview: false, writablePaths: ['docs'], allowedCapabilities: ['read', 'write', 'run'], projectId: project.id },
  roleInstanceId: roleInst.id, bindingGeneration: 1, sessionClass: 'WORKER',
});
await orgStore.bindRoleInstanceNode(roleInst.id, writerNode.id);
const writerSession = await sessionManager.createSession(targetRepoDir, 'codex', 'Target E2E Writer', {
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

const fileSession = await sessionManager.createSession(targetRepoDir, 'codex', 'Target E2E File Session', {
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
      mkdirSync(join(sess.folder, 'docs'), { recursive: true });
      writeFileSync(join(sess.folder, 'docs', 'remote-e2e-summary.md'), '# Remote Execution Summary\\nVerified release readiness artifact from target runtime.\\n', 'utf8');
      await history.appendEvent(sid, {
        type: 'message', role: 'assistant', content: 'Target remote execution produced docs/remote-e2e-summary.md.', runId: run.id,
        requestId: opts.requestId, messagePhase: 'final_answer', providerMessageId: 'msg_' + run.id, timestamp: Date.now(),
      });
      await history.appendEvent(sid, {
        type: 'usage', runId: run.id, requestId: opts.requestId, usageScope: 'provider_turn_total',
        costSource: 'provider_reported', usageAccountingTokens: 210, costUsd: 0.03, timestamp: Date.now(),
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

const stats = { remoteFactoryAcceptCalls: 0, remoteFilePostCalls: 0 };

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
        writeJson(res, 200, { ok: true });
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
      stats.remoteFilePostCalls += 1;
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

const realFetch = globalThis.fetch;
globalThis.fetch = (url, opts) => {
  const parsed = new URL(url);
  if (parsed.origin === 'https://accounts.stage4-e2e.invalid') {
    return realFetch(`http://127.0.0.1:${accountsPort}${parsed.pathname}${parsed.search}`, opts);
  }
  if (parsed.origin === 'https://target.stage4-e2e.invalid') {
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
const { createFileAssetUploadIntent, ingestFileAssetUpload, finalizeFileAssetUpload } = await import('../chat/file-assets.mjs');
const { withDatabase } = await import('../chat/collaboration-store.mjs');

const deviceRegistry = await import('../chat/device-capability-registry.mjs');
const remoteFactorySource = await import('../chat/remote-factory-source.mjs');
const { handleRemoteFactoryRoutes } = await import('../chat/router-remote-factory-routes.mjs');
const remoteFileTransfer = await import('../chat/remote-file-transfer.mjs');
const { handleRemoteFileRoutes } = await import('../chat/router-remote-file-routes.mjs');
const { inspectSourceRemoteBaseline } = await import('../chat/factory-remote-admission.mjs');
const { proxyToTarget } = await import('../chat/router-target-runtime-routes.mjs');

const dispatcherMod = await import('../lib/connector-action-dispatcher.mjs');
const githubMod = await import('../lib/connector-github.mjs');
const gmailMod = await import('../lib/connector-gmail.mjs');
const calendarMod = await import('../lib/connector-calendar.mjs');
const driveMod = await import('../lib/connector-drive.mjs');
const respCapabilities = await import('../chat/responsibility-capabilities.mjs');

let passed = 0;
function check(cond, msg) {
  assert.ok(cond, msg);
  passed += 1;
}
function equal(actual, expected, msg) {
  assert.equal(actual, expected, msg);
  passed += 1;
}
function deepEqual(actual, expected, msg) {
  assert.deepEqual(actual, expected, msg);
  passed += 1;
}
async function rejectsCode(fn, expectedCode, msg) {
  passed += 1;
  let caught = null;
  try { await fn(); } catch (err) { caught = err; }
  assert.ok(caught, `Expected error (${expectedCode}): ${msg}`);
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
    bindingAuthorityRevision: BINDING_AUTH_REV,
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
    bindingAuthorityRevision: BINDING_AUTH_REV,
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

function makeJsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  };
}

function createGitHubE2EMock() {
  const pulls = new Map();
  const comments = new Map();
  let nextPr = 101;
  let postPullCalls = 0;
  let patchPullCalls = 0;
  let putMergeCalls = 0;
  let dropNextCreate = false;
  let dropNextMerge = false;

  const fetchImpl = async (url, options = {}) => {
    const target = String(url);
    const method = String(options.method || 'GET').toUpperCase();
    const body = options.body ? JSON.parse(options.body) : null;

    if (target.startsWith('https://api.github.com/repos/octo/stage4-app/pulls?')) {
      const u = new URL(target);
      const state = u.searchParams.get('state') || 'open';
      const head = u.searchParams.get('head') || '';
      const base = u.searchParams.get('base') || '';
      const headBranch = head.includes(':') ? head.split(':')[1] : head;
      const items = [...pulls.values()].filter((pr) => {
        if (state !== 'all' && pr.state !== state) return false;
        if (headBranch && pr.head.ref !== headBranch) return false;
        if (base && pr.base.ref !== base) return false;
        return true;
      });
      return makeJsonResponse(items);
    }

    if (target === 'https://api.github.com/repos/octo/stage4-app/pulls' && method === 'POST') {
      postPullCalls += 1;
      const pr = {
        number: nextPr++,
        title: body.title,
        body: body.body || '',
        state: 'open',
        merged: false,
        merge_commit_sha: null,
        html_url: 'https://github.com/octo/stage4-app/pull/101',
        head: { ref: body.head, sha: 'head-sha-e2e-1' },
        base: { ref: body.base },
      };
      pulls.set(pr.number, pr);
      if (dropNextCreate) {
        dropNextCreate = false;
        await new Promise((r) => setTimeout(r, 120));
        return makeJsonResponse(pr, 201);
      }
      return makeJsonResponse(pr, 201);
    }

    const prMatch = target.match(/^https:\/\/api\.github\.com\/repos\/octo\/stage4-app\/pulls\/(\d+)$/);
    if (prMatch && method === 'GET') {
      const pr = pulls.get(Number(prMatch[1]));
      return pr ? makeJsonResponse(pr) : makeJsonResponse({ message: 'Not Found' }, 404);
    }
    if (prMatch && method === 'PATCH') {
      patchPullCalls += 1;
      const pr = pulls.get(Number(prMatch[1]));
      if (!pr) return makeJsonResponse({ message: 'Not Found' }, 404);
      if (body.title !== undefined) pr.title = body.title;
      if (body.body !== undefined) pr.body = body.body;
      return makeJsonResponse(pr);
    }

    const commentMatch = target.match(/^https:\/\/api\.github\.com\/repos\/octo\/stage4-app\/issues\/(\d+)\/comments$/);
    if (commentMatch && method === 'POST') {
      const prNum = Number(commentMatch[1]);
      const item = { id: 8801 + (comments.get(prNum)?.length || 0), body: body.body, html_url: `https://github.com/octo/stage4-app/pull/${prNum}#issuecomment-8801` };
      const arr = comments.get(prNum) || [];
      arr.push(item);
      comments.set(prNum, arr);
      return makeJsonResponse(item, 201);
    }

    const mergeMatch = target.match(/^https:\/\/api\.github\.com\/repos\/octo\/stage4-app\/pulls\/(\d+)\/merge$/);
    if (mergeMatch && method === 'PUT') {
      putMergeCalls += 1;
      const pr = pulls.get(Number(mergeMatch[1]));
      if (!pr) return makeJsonResponse({ message: 'Not Found' }, 404);
      pr.merged = true;
      pr.state = 'closed';
      pr.merge_commit_sha = `merge-sha-${pr.number}`;
      const payload = { merged: true, sha: pr.merge_commit_sha, message: 'Pull Request successfully merged' };
      if (dropNextMerge) {
        dropNextMerge = false;
        await new Promise((r) => setTimeout(r, 120));
        return makeJsonResponse(payload);
      }
      return makeJsonResponse(payload);
    }

    return makeJsonResponse({ message: `Unexpected ${method} ${target}` }, 404);
  };

  return {
    fetchImpl,
    setDropNextCreate: (v) => { dropNextCreate = v; },
    setDropNextMerge: (v) => { dropNextMerge = v; },
    stats: () => ({ postPullCalls, patchPullCalls, putMergeCalls }),
  };
}

function createGmailE2EMock() {
  const drafts = new Map();
  const messages = [];
  let seq = 1;
  let sendCalls = 0;
  let mode = 'normal';

  const gmailClient = {
    users: {
      drafts: {
        create: async ({ requestBody }) => {
          const id = `draft-${seq++}`;
          const rec = { id, raw: requestBody.message.raw, threadId: 'thr-e2e-1' };
          drafts.set(id, rec);
          return { data: { id, message: { id: `msg-${id}`, threadId: rec.threadId } } };
        },
        list: async () => ({
          data: { drafts: [...drafts.values()].map((d) => ({ id: d.id, message: { id: `msg-${d.id}`, threadId: d.threadId } })) },
        }),
        get: async ({ id }) => {
          const rec = drafts.get(id);
          return { data: { id, message: { id: `msg-${id}`, raw: rec?.raw || '' } } };
        },
      },
      messages: {
        send: async ({ requestBody }) => {
          sendCalls += 1;
          const decoded = Buffer.from(String(requestBody.raw || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
          const idMatch = decoded.match(/Message-ID:\s*([^\r\n]+)/i);
          const msgId = `gmail-sent-${seq++}`;
          const record = { id: msgId, threadId: 'thr-sent-1', rfcMessageId: idMatch?.[1] || '', raw: decoded };
          if (mode === 'timeout_and_sent') {
            mode = 'normal';
            messages.push(record);
            await new Promise((r) => setTimeout(r, 120));
            return { data: { id: msgId, threadId: record.threadId } };
          }
          if (mode === 'timeout_and_lost') {
            mode = 'normal';
            await new Promise((r) => setTimeout(r, 120));
            throw new Error('upstream mail drop');
          }
          messages.push(record);
          return { data: { id: msgId, threadId: record.threadId } };
        },
        list: async ({ q }) => {
          const m = String(q || '').match(/rfc822msgid:([^\s]+)/);
          const wanted = m?.[1]?.replace(/^<|>$/g, '') || '';
          const matched = messages.filter((msg) => msg.rfcMessageId.includes(wanted));
          return { data: { messages: matched.map((x) => ({ id: x.id, threadId: x.threadId })) } };
        },
        get: async ({ id }) => {
          const found = messages.find((x) => x.id === id);
          return { data: { id, threadId: found?.threadId || '', snippet: 'Sent via Stage 4 E2E' } };
        },
      },
    },
  };

  return {
    gmailClient,
    setMode: (m) => { mode = m; },
    stats: () => ({ sendCalls, draftCount: drafts.size, sentCount: messages.length }),
  };
}

function createCalendarE2EMock() {
  const events = new Map();
  let insertCalls = 0;
  let patchCalls = 0;
  let dropNextInsert = false;

  const calendarClient = {
    events: {
      list: async ({ calendarId }) => ({
        data: { items: [...events.values()].filter((e) => e.calendarId === calendarId) },
      }),
      get: async ({ calendarId, eventId }) => {
        const key = `${calendarId}:${eventId}`;
        const ev = events.get(key);
        if (!ev) {
          const err = new Error('Not Found');
          err.statusCode = 404;
          throw err;
        }
        return { data: { ...ev } };
      },
      insert: async ({ calendarId, requestBody }) => {
        insertCalls += 1;
        const ev = {
          ...requestBody,
          calendarId,
          etag: '"cal-etag-1"',
          sequence: 0,
          updated: new Date().toISOString(),
          status: 'confirmed',
          htmlLink: `https://calendar.example.test/${requestBody.id}`,
        };
        events.set(`${calendarId}:${requestBody.id}`, ev);
        if (dropNextInsert) {
          dropNextInsert = false;
          await new Promise((r) => setTimeout(r, 120));
          return { data: { ...ev } };
        }
        return { data: { ...ev } };
      },
      patch: async ({ calendarId, eventId, requestBody }) => {
        patchCalls += 1;
        const key = `${calendarId}:${eventId}`;
        const ev = events.get(key);
        if (!ev) throw new Error('Not found');
        const nextSeq = (ev.sequence || 0) + 1;
        const updated = {
          ...ev,
          ...requestBody,
          sequence: nextSeq,
          etag: `"cal-etag-${nextSeq + 1}"`,
          updated: new Date().toISOString(),
        };
        events.set(key, updated);
        return { data: { ...updated } };
      },
      delete: async ({ calendarId, eventId }) => {
        events.delete(`${calendarId}:${eventId}`);
        return { data: {} };
      },
    },
  };

  return {
    calendarClient,
    setDropNextInsert: (v) => { dropNextInsert = v; },
    stats: () => ({ insertCalls, patchCalls }),
  };
}

function createDriveE2EMock() {
  const files = new Map();
  const contents = new Map();
  const permissions = new Map();
  let seq = 1;
  let updateCalls = 0;

  files.set('folder-allowed', {
    id: 'folder-allowed',
    name: 'Allowed Folder',
    mimeType: 'application/vnd.google-apps.folder',
    parents: ['root'],
    etag: '"drv-fld-1"',
    version: '1',
    headRevisionId: 'rev-1',
    trashed: false,
  });
  files.set('folder-secret', {
    id: 'folder-secret',
    name: 'Restricted Folder',
    mimeType: 'application/vnd.google-apps.folder',
    parents: ['root'],
    etag: '"drv-sec-1"',
    version: '1',
    headRevisionId: 'rev-1',
    trashed: false,
  });
  files.set('file-secret-1', {
    id: 'file-secret-1',
    name: 'payroll.csv',
    mimeType: 'text/csv',
    parents: ['folder-secret'],
    etag: '"drv-sec-file-1"',
    version: '1',
    headRevisionId: 'rev-1',
    trashed: false,
  });
  contents.set('file-secret-1', 'secret,100\n');
  files.set('file-parentless-leak', {
    id: 'file-parentless-leak',
    name: 'leak.txt',
    mimeType: 'text/plain',
    parents: [],
    etag: '"drv-leak-1"',
    version: '1',
    headRevisionId: 'rev-1',
    trashed: false,
  });

  const driveClient = {
    files: {
      list: async () => ({
        data: { files: [...files.values()].filter((f) => !f.trashed) },
      }),
      get: async ({ fileId, alt }) => {
        const f = files.get(fileId);
        if (!f) throw new Error('File not found');
        if (alt === 'media') return { data: contents.get(fileId) || '' };
        return { data: { ...f } };
      },
      create: async ({ requestBody, media }) => {
        const id = `drv-item-${seq++}`;
        const rec = {
          id,
          name: requestBody.name,
          mimeType: requestBody.mimeType || 'application/octet-stream',
          parents: requestBody.parents || [],
          appProperties: requestBody.appProperties || {},
          etag: `"drv-etag-${seq}"`,
          version: '1',
          headRevisionId: `rev-${seq}`,
          webViewLink: `https://drive.example.test/${id}`,
          trashed: false,
        };
        files.set(id, rec);
        if (media?.body !== undefined) contents.set(id, String(media.body));
        permissions.set(id, []);
        return { data: { ...rec } };
      },
      update: async ({ fileId, requestBody, media }) => {
        updateCalls += 1;
        const cur = files.get(fileId);
        if (!cur) throw new Error('Not found');
        const nextVer = String(Number(cur.version || 1) + 1);
        const updated = {
          ...cur,
          ...requestBody,
          appProperties: { ...(cur.appProperties || {}), ...(requestBody?.appProperties || {}) },
          version: nextVer,
          headRevisionId: `rev-upd-${nextVer}`,
          etag: `"drv-etag-upd-${nextVer}"`,
        };
        files.set(fileId, updated);
        if (media?.body !== undefined) contents.set(fileId, String(media.body));
        return { data: { ...updated } };
      },
    },
    permissions: {
      create: async ({ fileId, requestBody }) => {
        const perm = { id: `perm-${seq++}`, ...requestBody };
        const list = permissions.get(fileId) || [];
        list.push(perm);
        permissions.set(fileId, list);
        return { data: { ...perm } };
      },
      list: async ({ fileId }) => ({ data: { permissions: permissions.get(fileId) || [] } }),
      delete: async ({ fileId, permissionId }) => {
        const list = permissions.get(fileId) || [];
        permissions.set(fileId, list.filter((p) => p.id !== permissionId));
        return { data: {} };
      },
    },
  };

  return {
    driveClient,
    contents,
    permissions,
    stats: () => ({ updateCalls }),
  };
}

const ownerActor = { kind: 'user', role: 'owner', principalId: OWNER_ID };
const serviceActor = { kind: 'service', role: 'factory_scheduler', principalId: `factory-scheduler:${OWNER_ID}`, authorizingPrincipalId: OWNER_ID };
const futureExpiry = new Date(Date.now() + 7 * 86400_000).toISOString();
const baseNowMs = Date.parse('2026-11-22T14:00:00.000Z');

let sourceScheduler = null;
let dispatcher = null;

try {
  // ═══════════════════════════════════════════════════════════════════════════
  // SETUP SOURCE ORGANIZATION, SESSIONS & NODES
  // ═══════════════════════════════════════════════════════════════════════════
  await orgStore.initializeOrganizationStore();
  await governor.initializeOrganizationGovernor();

  const srcProject = await projects.createProject({ name: 'Stage4 E2E Project', rootPath: sourceRepoDir });
  const srcWriterApp = await appsMod.createApp({
    name: 'Source E2E Writer',
    tool: 'codex',
    collaborationPolicy: { role: 'writer', canDelegate: false, writablePaths: ['docs'], revision: 's4e-w1' },
  });
  const srcReviewerApp = await appsMod.createApp({
    name: 'Source E2E Reviewer',
    tool: 'codex',
    collaborationPolicy: { role: 'reviewer', canDelegate: false, revision: 's4e-r1' },
  });
  const srcRootSession = await sessionManager.createSession(sourceRepoDir, 'codex', 'Source E2E Root', {
    projectId: srcProject.id, sessionClass: 'ROOT_LEADERSHIP', sessionPlane: 'user', model: 'gpt-5.3-codex', effort: 'medium',
  });
  const srcOrg = await orgStore.createOrganization({
    rootSessionId: srcRootSession.id,
    projectId: srcProject.id,
    state: 'active',
    currentRevision: 1,
    policy: { factoryMaxConcurrent: 4 },
    budget: { maxTotalRuns: 30, maxTokens: 100000, maxCost: 50 },
    idempotencyKey: 'stage4-e2e-src-org',
  });
  process.env.RAGENT_FACTORY_ORGANIZATIONS = srcOrg.id;
  await orgStore.createRevision(srcOrg.id, { revision: 1, proposal: { nodes: [], edges: [] }, compiled: { nodes: [], edges: [] } });
  await orgStore.freezeRevision(srcOrg.id, 1);

  async function makeSourceNode(stableKey, role, app, grant) {
    const ri = await orgStore.createRoleInstance({
      organizationId: srcOrg.id, organizationRevision: 1, stableKey, role, agentId: app.id,
      lifecycleState: 'active', idempotencyKey: `ri-e2e-${stableKey}`,
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

  const srcWriter1 = await makeSourceNode('src_writer_1', 'writer', srcWriterApp, {
    canWrite: true, canReview: false, writablePaths: ['docs'], allowedCapabilities: ['read', 'write', 'run'], projectId: srcProject.id,
  });
  const srcWriter2 = await makeSourceNode('src_writer_2', 'writer', srcWriterApp, {
    canWrite: true, canReview: false, writablePaths: ['docs'], allowedCapabilities: ['read', 'write', 'run'], projectId: srcProject.id,
  });
  const srcReviewer = await makeSourceNode('src_reviewer', 'reviewer', srcReviewerApp, {
    canWrite: false, canReview: true, allowedCapabilities: ['read', 'review', 'run'], projectId: srcProject.id,
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // E2E SCENARIO A (S4.1): Cross-Device Mesh Routing, Auth & Isolation Gates
  // ═══════════════════════════════════════════════════════════════════════════
  const localWinReport = await deviceRegistry.signDeviceCapabilityReport({
    platform: 'windows',
    status: 'online',
    heartbeatAt: new Date(baseNowMs).toISOString(),
    staleAfterMs: 60_000,
    availableHarnesses: ['codex'],
    capabilities: ['build', 'tests'],
    authorizedWorkspaceRoots: [sourceRepoDir],
    maxConcurrentRuns: 2,
    currentConcurrentRuns: 0,
    isolation: { supported: true, enforced: true, mode: 'worktree', readOnlySupported: true },
  }, { identity: sourceIdentity });
  await deviceRegistry.registerDeviceCapabilities({ signedReport: localWinReport }, ownerActor, { nowMs: baseNowMs });

  const macReport = await deviceRegistry.signDeviceCapabilityReport({
    platform: 'macos',
    status: 'online',
    heartbeatAt: new Date(baseNowMs).toISOString(),
    staleAfterMs: 45_000,
    availableHarnesses: ['codex', 'claude'],
    capabilities: ['xcode', 'tests'],
    authorizedWorkspaceRoots: ['/Users/dev/stage4-app'],
    maxConcurrentRuns: 3,
    currentConcurrentRuns: 0,
    isolation: { supported: true, enforced: true, mode: 'worktree', readOnlySupported: true },
  }, { identity: macIdentity });
  await deviceRegistry.registerDeviceCapabilities({ signedReport: macReport }, ownerActor, { nowMs: baseNowMs });

  // Rogue online Windows device with NO peer authorization binding + non-isolated shared mode
  await deviceRegistry.registerDeviceCapabilities({
    instanceId: rogueInstanceId,
    publicKey: roguePublicKey,
    platform: 'windows',
    status: 'online',
    heartbeatAt: new Date(baseNowMs).toISOString(),
    availableHarnesses: ['codex'],
    capabilities: ['build', 'tests'],
    authorizedWorkspaceRoots: [sourceRepoDir],
    maxConcurrentRuns: 4,
    currentConcurrentRuns: 0,
    isolation: { supported: true, enforced: true, mode: 'shared' },
    factSource: 'verified_remote',
  }, ownerActor, { nowMs: baseNowMs });
  const rogueStored = await deviceRegistry.getDeviceCapabilities(rogueInstanceId, { nowMs: baseNowMs });
  equal(rogueStored.isolation.enforced, false, 'Shared isolation mode never reports enforced=true');

  // Non-owner run_capability principal cannot authorize peer devices via HTTP route even if feature enabled.
  process.env.RAGENT_REMOTE_FACTORY_ENABLED = '1';
  const nonOwnerAuthAttempt = await callRoute(handleRemoteFactoryRoutes, {
    method: 'POST',
    pathname: '/api/remote-factory/devices/authorizations',
    authSession: { role: 'agent', principalKind: 'run_capability', runId: 'r1', sessionId: 's1' },
    body: {
      organizationId: srcOrg.id,
      targetInstanceId: rogueInstanceId,
      bindingId: 'bind_rogue',
      expectedVersion: 0,
      ownerAuthorized: true,
      expiresAt: futureExpiry,
    },
  });
  equal(nonOwnerAuthAttempt.statusCode, 403, 'Non-owner principal rejected from device authorization route');

  // Explicit owner authorization for Windows coordinator + macOS simulation peer (macOS limited via owner ∩ binding policy).
  const macAuthHttp = await callRoute(handleRemoteFactoryRoutes, {
    method: 'POST',
    pathname: '/api/remote-factory/devices/authorizations',
    body: {
      organizationId: srcOrg.id,
      targetInstanceId: macIdentity.instanceId,
      bindingId: 'bind_mac_sim',
      expectedVersion: 0,
      ownerAuthorized: true,
      ownerPolicy: {
        allowedPlatforms: ['macos', 'linux'],
        allowedHarnesses: ['codex', 'claude'],
        allowedWorkspaceRoots: ['/Users/dev'],
        allowedAccessModes: ['read', 'write'],
      },
      bindingPolicy: {
        allowedPlatforms: ['macos'],
        allowedHarnesses: ['codex'],
        allowedWorkspaceRoots: ['/Users/dev/stage4-app'],
        allowedAccessModes: ['read', 'write'],
        maxConcurrentRuns: 2,
      },
      expiresAt: futureExpiry,
    },
  });
  equal(macAuthHttp.statusCode, 200, 'Owner authorizes macOS peer via HTTP route');

  // Authorized cross-device selection picks macOS peer and excludes unauthorized online Windows rogue device.
  const macRoute = await callRoute(handleRemoteFactoryRoutes, {
    method: 'POST',
    pathname: '/api/remote-factory/devices/select',
    body: {
      organizationId: srcOrg.id,
      requiredPlatform: 'macos',
      requiredHarness: 'codex',
      requiredCapabilities: ['xcode'],
      workspaceRoot: '/Users/dev/stage4-app/core',
      accessMode: 'write',
      requiredIsolation: true,
      nowMs: baseNowMs,
    },
  });
  equal(macRoute.statusCode, 200);
  equal(macRoute.body.selected?.instanceId, macIdentity.instanceId, 'Routes macOS isolated task to authorized macOS device');
  check(
    macRoute.body.rejected.some((r) => r.instanceId === rogueInstanceId && r.reasons.includes('device_not_authorized')),
    'Unauthorized online device rejected during cross-device selection',
  );

  // Owner ∩ binding intersection: claude allowed by ownerPolicy, excluded by bindingPolicy -> rejected!
  const macClaudeDenied = await deviceRegistry.selectAuthorizedDeviceForTask({
    organizationId: srcOrg.id,
    requiredPlatform: 'macos',
    requiredHarness: 'claude',
    workspaceRoot: '/Users/dev/stage4-app',
  }, { nowMs: baseNowMs });
  equal(macClaudeDenied.selected, null, 'Harness outside bindingPolicy rejected despite ownerPolicy allowance');

  // Re-verify default-off gate on source binding creation when RAGENT_REMOTE_FACTORY_ENABLED='0'.
  process.env.RAGENT_REMOTE_FACTORY_ENABLED = '0';
  const gateBlockedRes = await callRoute(handleRemoteFactoryRoutes, {
    method: 'POST',
    pathname: '/api/remote-factory/source-bindings',
    body: { id: 'src_gate_block' },
  });
  equal(gateBlockedRes.statusCode, 503, 'Remote factory source-bindings blocked when gate is 0');
  equal(gateBlockedRes.body.code, 'REMOTE_FACTORY_DISABLED');

  // ═══════════════════════════════════════════════════════════════════════════
  // E2E SCENARIO B (S4.1): Dual-Instance 3-State Offline Lifecycle & Synced Review
  // ═══════════════════════════════════════════════════════════════════════════
  process.env.RAGENT_REMOTE_FACTORY_ENABLED = '1';
  await targetControl('/test-control/flags', { remoteFactoryEnabled: '1' });

  const contractTemplate = {
    objective: 'Implement docs/remote-e2e-summary.md on authorized remote target',
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

  const tgtBind = await targetControl('/test-control/configure-binding', {
    id: 'tgt_e2e_bind_1',
    sourceInstanceId: sourceIdentity.instanceId,
    sourcePublicKey: sourceIdentity.publicKey,
    allowedContractDigests: [contractDigest],
    budgetLimit: 10.0,
    expectedVersion: 0,
    expiresAt: futureExpiry,
  });
  equal(tgtBind.status, 200, 'Target binding configured on child instance');

  await remoteFactorySource.configureRemoteFactorySourceBinding({
    id: 'src_e2e_linux',
    organizationId: srcOrg.id,
    targetInstanceId: targetIdentity.instanceId,
    targetPublicKey: targetIdentity.publicKey,
    targetBindingId: 'tgt_e2e_bind_1',
    targetBindingVersion: 1,
    expectedVersion: 0,
    expiresAt: futureExpiry,
    bindingPolicy: { allowedPlatforms: ['linux'], allowedHarnesses: ['codex'], allowedAccessModes: ['write'], allowedRelativePaths: ['docs'] },
    ownerPolicy: { allowedPlatforms: ['linux', 'macos'], allowedHarnesses: ['codex'] },
  }, ownerActor);

  await remoteFactorySource.configureRemoteFactorySourceBinding({
    id: 'src_e2e_mac_backup',
    organizationId: srcOrg.id,
    targetInstanceId: macIdentity.instanceId,
    targetPublicKey: macIdentity.publicKey,
    targetBindingId: 'tgt_e2e_mac',
    targetBindingVersion: 1,
    expectedVersion: 0,
    expiresAt: futureExpiry,
    bindingPolicy: { allowedPlatforms: ['macos'], allowedHarnesses: ['codex'], allowedAccessModes: ['write'], allowedRelativePaths: ['docs'] },
    ownerPolicy: { allowedPlatforms: ['macos'], allowedHarnesses: ['codex'] },
  }, ownerActor);

  // Target initially offline; macOS backup online (fresh heartbeat now).
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
    isolation: { supported: true, enforced: true, mode: 'container', readOnlySupported: true },
    factSource: 'verified_remote',
  }, ownerActor);

  await deviceRegistry.recordDeviceHeartbeat({
    instanceId: macIdentity.instanceId,
    platform: 'macos',
    status: 'online',
    heartbeatAt: new Date().toISOString(),
    staleAfterMs: 120_000,
    availableHarnesses: ['codex'],
    capabilities: ['docs', 'xcode'],
    authorizedWorkspaceRoots: ['/Users/dev/stage4-app'],
    maxConcurrentRuns: 2,
    currentConcurrentRuns: 0,
    isolation: { supported: true, enforced: true, mode: 'worktree', readOnlySupported: true },
  }, ownerActor);

  async function createClaimedSourceItem(suffix, assignee) {
    const gRes = await factoryControl.executeFactoryCommand({
      organizationId: srcOrg.id,
      commandId: `cmd-e2e-goal-${suffix}`,
      idempotencyKey: `e2e-goal-${suffix}`,
      type: 'CreateGoal',
      payload: { projectId: srcProject.id, objective: `Stage4 E2E goal ${suffix}` },
    }, ownerActor);
    const wiRes = await factoryControl.executeFactoryCommand({
      organizationId: srcOrg.id,
      commandId: `cmd-e2e-wi-${suffix}`,
      idempotencyKey: `e2e-wi-${suffix}`,
      type: 'CreateWorkItem',
      payload: { goalId: gRes.goal.id, assigneeNodeId: assignee.node.id, kind: 'execution', contract: contractTemplate },
    }, ownerActor);
    const approved = await factoryControl.executeFactoryCommand({
      organizationId: srcOrg.id,
      commandId: `cmd-e2e-app-${suffix}`,
      idempotencyKey: `e2e-app-${suffix}`,
      type: 'ApproveContract',
      targetId: wiRes.item.id,
      expectedVersion: wiRes.item.rowVersion,
      payload: {},
    }, ownerActor);
    const lease = await factoryControl.acquireFactorySchedulerLease({
      organizationId: srcOrg.id,
      ownerToken: 'stage4_e2e_sched',
    }, serviceActor);
    const dispatchKey = `factory:${wiRes.item.id}:1:${assignee.node.bindingGeneration}:1`;
    const claim = await factoryControl.claimFactoryWork({
      organizationId: srcOrg.id,
      workItemId: wiRes.item.id,
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
      factoryWorkItemId: wiRes.item.id,
      delta: { cost: 1.0, tokens: 5000, runs: 1 },
    });
    return { goalId: gRes.goal.id, workItem: claim.item, binding: claim.binding, lease, budgetKey };
  }

  const srcBaseline = await inspectSourceRemoteBaseline(sourceRepoDir, ['docs']);

  // State 1: not_dispatched when primary target offline -> reroute to online authorized backup
  const itemOffline1 = await createClaimedSourceItem('s1', srcWriter1);
  const opOffline1 = `op_e2e_s1_${itemOffline1.binding.id}`;
  const preWireNotDispatched = await remoteFactorySource.dispatchRemoteFactoryOperation({
    organizationId: srcOrg.id,
    workItemId: itemOffline1.workItem.id,
    expectedVersion: itemOffline1.workItem.rowVersion,
    sourceFactoryBindingId: itemOffline1.binding.id,
    contractRevision: 1,
    executionEpoch: itemOffline1.workItem.executionEpoch,
    bindingGeneration: itemOffline1.workItem.bindingGeneration,
    leaseOwnerToken: itemOffline1.lease.ownerToken,
    leaseGeneration: itemOffline1.lease.generation,
    bindingId: 'src_e2e_linux',
    bindingVersion: 1,
    operationId: opOffline1,
    requestId: opOffline1,
    contractDigest,
    payload: {
      contract: itemOffline1.workItem.contract,
      sourceReservationId: itemOffline1.budgetKey,
      reservedCost: 1.0,
      reservedTokens: 5000,
      sourceBindingId: 'src_e2e_linux',
      sourceBindingVersion: 1,
      expectedBaseHead: srcBaseline.baseHead,
      expectedBaseBranch: srcBaseline.baseBranch,
      expectedBaselineDigest: srcBaseline.baselineDigest,
    },
  }, serviceActor, { verifyExternal: () => inspectSourceRemoteBaseline(sourceRepoDir, ['docs']) });

  equal(preWireNotDispatched.offlineState, 'not_dispatched', 'Offline target produces pre-wire not_dispatched');
  equal((await targetControl('/test-control/stats')).body.remoteFactoryAcceptCalls, 0, 'No POST reaches target during not_dispatched');

  const rerouted = await callRoute(handleRemoteFactoryRoutes, {
    method: 'POST',
    pathname: `/api/remote-factory/source-bindings/src_e2e_linux/operations/${opOffline1}/reroute`,
    body: { taskRequirements: { requiredPlatform: 'macos', requiredHarness: 'codex', workspaceRoot: '/Users/dev/stage4-app' }, reason: 'linux_offline' },
  });
  equal(rerouted.statusCode, 200, 'not_dispatched operation reroutes cleanly');
  equal(rerouted.body.newBindingId, 'src_e2e_mac_backup');
  equal(rerouted.body.offlineState, 'not_dispatched');

  // State 2: Linux target comes online -> POST commits on real target worker, response dropped -> dispatched_unconfirmed
  const signedTargetHb = await deviceRegistry.signDeviceCapabilityReport({
    platform: 'linux',
    status: 'online',
    heartbeatAt: new Date().toISOString(),
    staleAfterMs: 120_000,
    availableHarnesses: ['codex'],
    capabilities: ['git', 'docs'],
    authorizedWorkspaceRoots: [targetRepoDir],
    maxConcurrentRuns: 2,
    currentConcurrentRuns: 0,
    isolation: { supported: true, enforced: true, mode: 'container', readOnlySupported: true },
  }, { identity: targetIdentity });
  const hbOk = await callRoute(handleRemoteFactoryRoutes, {
    method: 'POST',
    pathname: '/api/remote-factory/devices/heartbeat',
    body: { signedReport: signedTargetHb },
  });
  equal(hbOk.statusCode, 200);

  const itemUnconfirmed = await createClaimedSourceItem('s2', srcWriter2);
  const opUnconfirmed = `op_e2e_s2_${itemUnconfirmed.binding.id}`;
  const dropDispatchResponseProxy = async (args) => {
    const res = await proxyToTarget(args);
    if (args.method === 'POST' && args.operation === 'factory.remote.accept') {
      throw new Error('Simulated socket close after target admitted child work item');
    }
    return res;
  };

  const unconfirmed = await remoteFactorySource.dispatchRemoteFactoryOperation({
    organizationId: srcOrg.id,
    workItemId: itemUnconfirmed.workItem.id,
    expectedVersion: itemUnconfirmed.workItem.rowVersion,
    sourceFactoryBindingId: itemUnconfirmed.binding.id,
    contractRevision: 1,
    executionEpoch: itemUnconfirmed.workItem.executionEpoch,
    bindingGeneration: itemUnconfirmed.workItem.bindingGeneration,
    leaseOwnerToken: itemUnconfirmed.lease.ownerToken,
    leaseGeneration: itemUnconfirmed.lease.generation,
    operationId: opUnconfirmed,
    requestId: opUnconfirmed,
    contractDigest,
    taskRequirements: { requiredPlatform: 'linux', requiredHarness: 'codex', workspaceRoot: targetRepoDir },
    payload: {
      contract: itemUnconfirmed.workItem.contract,
      sourceReservationId: itemUnconfirmed.budgetKey,
      reservedCost: 1.0,
      reservedTokens: 5000,
      expectedBaseHead: srcBaseline.baseHead,
      expectedBaseBranch: srcBaseline.baseBranch,
      expectedBaselineDigest: srcBaseline.baselineDigest,
    },
  }, serviceActor, {
    autoRoute: true,
    verifyExternal: () => inspectSourceRemoteBaseline(sourceRepoDir, ['docs']),
    proxyImpl: dropDispatchResponseProxy,
  });

  equal(unconfirmed.offlineState, 'dispatched_unconfirmed', 'Dropped dispatch response enters dispatched_unconfirmed');
  equal(unconfirmed.replayForbidden, true);
  equal((await targetControl('/test-control/stats')).body.remoteFactoryAcceptCalls, 1, 'Target admitted POST exactly once');

  // Re-dispatch and reroute must both be blocked while dispatched_unconfirmed.
  const blockedReplay = await remoteFactorySource.dispatchRemoteFactoryOperation({
    organizationId: srcOrg.id,
    workItemId: itemUnconfirmed.workItem.id,
    expectedVersion: itemUnconfirmed.workItem.rowVersion,
    sourceFactoryBindingId: itemUnconfirmed.binding.id,
    contractRevision: 1,
    executionEpoch: itemUnconfirmed.workItem.executionEpoch,
    bindingGeneration: itemUnconfirmed.workItem.bindingGeneration,
    leaseOwnerToken: itemUnconfirmed.lease.ownerToken,
    leaseGeneration: itemUnconfirmed.lease.generation,
    bindingId: 'src_e2e_linux',
    bindingVersion: 1,
    operationId: opUnconfirmed,
    requestId: opUnconfirmed,
    contractDigest,
    payload: {
      contract: itemUnconfirmed.workItem.contract,
      sourceReservationId: itemUnconfirmed.budgetKey,
      reservedCost: 1.0,
      reservedTokens: 5000,
      sourceBindingId: 'src_e2e_linux',
      sourceBindingVersion: 1,
      expectedBaseHead: srcBaseline.baseHead,
      expectedBaseBranch: srcBaseline.baseBranch,
      expectedBaselineDigest: srcBaseline.baselineDigest,
    },
  }, serviceActor, { verifyExternal: () => inspectSourceRemoteBaseline(sourceRepoDir, ['docs']) });
  equal(blockedReplay.replayForbidden, true, 'Blind replay prevented on dispatched_unconfirmed');
  equal((await targetControl('/test-control/stats')).body.remoteFactoryAcceptCalls, 1, 'No second POST hit target');

  const rerouteBlocked = await callRoute(handleRemoteFactoryRoutes, {
    method: 'POST',
    pathname: `/api/remote-factory/source-bindings/src_e2e_linux/operations/${opUnconfirmed}/reroute`,
    body: { newBindingId: 'src_e2e_mac_backup' },
  });
  equal(rerouteBlocked.statusCode, 409, 'Reroute rejected on dispatched_unconfirmed');

  // Reconnect query confirms signed receipt without re-executing.
  const queriedReceipt = await remoteFactorySource.queryRemoteFactoryOperation('src_e2e_linux', opUnconfirmed, ownerActor);
  equal(queriedReceipt.offlineState, 'dispatched_confirmed', 'Receipt query reconciles dispatched_unconfirmed -> dispatched_confirmed');
  check(Boolean(queriedReceipt.target?.workItemId), 'Signed receipt confirms child work item');

  // State 3: Target executes work item -> executed_unsynced -> source pulls signed candidate & runs independent review
  const childExec = await targetControl('/test-control/execute-child', {
    bindingId: 'tgt_e2e_bind_1',
    operationId: opUnconfirmed,
  });
  equal(childExec.status, 200);
  equal(childExec.body.workItem.state, 'review', 'Target worker completed child execution into review');

  // Turn RAGENT_REMOTE_FACTORY_ENABLED back OFF to prove recovery/candidate pull still completes cleanly.
  process.env.RAGENT_REMOTE_FACTORY_ENABLED = '0';
  await targetControl('/test-control/flags', { remoteFactoryEnabled: '0' });

  const stateBeforePull = await remoteFactorySource.queryRemoteFactoryOperation('src_e2e_linux', opUnconfirmed, ownerActor);
  equal(stateBeforePull.offlineState, 'executed_unsynced', 'Target review transition detected as executed_unsynced');

  const reconciledSync = await callRoute(handleRemoteFactoryRoutes, {
    method: 'POST',
    pathname: `/api/remote-factory/source-bindings/src_e2e_linux/operations/${opUnconfirmed}/reconcile`,
    body: {},
  });
  equal(reconciledSync.statusCode, 200, 'Reconcile + signed candidate pull works even when gate is 0');
  equal(reconciledSync.body.offlineState, 'synced');
  equal(reconciledSync.body.reviewReady, true);
  check(Boolean(reconciledSync.body.candidateDigest), 'Signed candidate digest persisted');

  const remoteEvidenceRes = await callRoute(handleRemoteFactoryRoutes, {
    method: 'GET',
    pathname: `/api/organizations/${srcOrg.id}/factory/work-items/${itemUnconfirmed.workItem.id}/remote-evidence`,
  });
  equal(remoteEvidenceRes.statusCode, 200);
  const summaryChange = remoteEvidenceRes.body.changes.find((c) => c.path === 'docs/remote-e2e-summary.md');
  check(Boolean(summaryChange), 'Remote candidate diff contains docs/remote-e2e-summary.md');

  // Feed pulled candidate into an independent source review work item + manual owner acceptance.
  const revWi = await factoryControl.executeFactoryCommand({
    organizationId: srcOrg.id,
    commandId: 'cmd-e2e-wi-rev',
    idempotencyKey: 'e2e-wi-rev',
    type: 'CreateWorkItem',
    payload: {
      goalId: itemUnconfirmed.goalId,
      assigneeNodeId: srcReviewer.node.id,
      kind: 'review',
      dependencies: [{ predecessorId: itemUnconfirmed.workItem.id, milestone: 'candidate_ready' }],
      contract: {
        objective: 'Independently verify target candidate docs/remote-e2e-summary.md',
        acceptanceCriteria: [{ id: 'independent-review', method: 'manual' }],
        accessMode: 'read',
        retry: { maxAttempts: 1 },
        budget: { maxCost: 1.0, maxTokens: 3000 },
        budgetReservation: { cost: 1.0, tokens: 3000 },
        organizationRevision: 1,
      },
    },
  }, ownerActor);
  await factoryControl.executeFactoryCommand({
    organizationId: srcOrg.id,
    commandId: 'cmd-e2e-app-rev',
    idempotencyKey: 'e2e-app-rev',
    type: 'ApproveContract',
    targetId: revWi.item.id,
    expectedVersion: revWi.item.rowVersion,
    payload: {},
  }, ownerActor);
  await withDatabase((db) => {
    db.prepare(`
      INSERT INTO factory_workflow_instances (
        id, organization_id, goal_id, template_id, template_version,
        template_digest, input_digest, mapping_json, created_at
      ) VALUES (?,?,?,?,?,?,?,?,?)
    `).run(
      `wfi_e2e_${itemUnconfirmed.workItem.id}`,
      srcOrg.id,
      itemUnconfirmed.goalId,
      'ragent-reviewed-change',
      1,
      createHash('sha256').update('ragent-reviewed-change:v1').digest('hex'),
      createHash('sha256').update(itemUnconfirmed.workItem.id).digest('hex'),
      JSON.stringify({ implementation: itemUnconfirmed.workItem.id, review: revWi.item.id }),
      new Date().toISOString(),
    );
  });

  let capturedReviewRun = null;
  let capturedRemoteSummaryText = '';
  const srcOrchestrator = createCollaborationOrchestrator({
    pollMs: 100000,
    dependencies: {
      sendMessage: async (sid, txt, imgs, opts = {}) => {
        const sess = await sessionManager.getSession(sid);
        const materialized = join(sess.folder, 'docs', 'remote-e2e-summary.md');
        ok: {
          check(existsSync(materialized), 'Validation workspace materialized remote candidate file');
          capturedRemoteSummaryText = readFileSync(materialized, 'utf8');
          break ok;
        }
        const outcome = await sessionManager.sendMessage(sid, txt, imgs, { ...opts, skipRunnerLaunch: true });
        capturedReviewRun = {
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
    ownerToken: itemUnconfirmed.lease.ownerToken,
    generation: itemUnconfirmed.lease.generation,
  }, serviceActor);
  const srcAdapter = createFactoryExecutionAdapter({ organizationId: srcOrg.id, actor: serviceActor, orchestrator: srcOrchestrator });
  sourceScheduler = createFactoryScheduler({ organizationId: srcOrg.id, actor: serviceActor, adapter: srcAdapter, admissionEnabled: true, pollMs: 60000 });
  await sourceScheduler.start();
  await sourceScheduler.tick();

  const revRunning = (await factoryControl.getFactoryWorkItem(srcOrg.id, revWi.item.id, ownerActor)).item;
  equal(revRunning.state, 'running', 'Independent source review launched');
  const revManifest = await runs.getRunManifest(capturedReviewRun.runId);
  const revScope = revManifest?.options?.sessionControlChannel?.scope || capturedReviewRun.organizationMessageScope;

  await factoryReviewOpinions.submitFactoryReviewOpinion({
    candidateWorkItemId: itemUnconfirmed.workItem.id,
    candidateDigest: reconciledSync.body.candidateDigest,
    contractRevision: itemUnconfirmed.workItem.contractRevision,
    executionEpoch: itemUnconfirmed.workItem.executionEpoch,
    verdict: 'pass',
    reason: 'Independent review verified docs/remote-e2e-summary.md',
    idempotencyKey: 'e2e-rev-op-1',
  }, {
    principalKind: 'run_capability',
    capabilityOperation: 'factory.review.submit',
    runId: capturedReviewRun.runId,
    sessionId: capturedReviewRun.sessionId,
    organizationMessageScope: revScope,
  });
  await history.appendEvent(capturedReviewRun.sessionId, {
    type: 'message', role: 'assistant', content: 'Independent review passed.', runId: capturedReviewRun.runId,
    requestId: capturedReviewRun.requestId, messagePhase: 'final_answer', providerMessageId: 'msg_' + capturedReviewRun.runId, timestamp: Date.now(),
  });
  await history.appendEvent(capturedReviewRun.sessionId, {
    type: 'usage', runId: capturedReviewRun.runId, requestId: capturedReviewRun.requestId,
    usageScope: 'provider_turn_total', costSource: 'provider_reported', usageAccountingTokens: 90, costUsd: 0.01, timestamp: Date.now(),
  });
  const revDoneAt = new Date().toISOString();
  await runs.writeRunResult(capturedReviewRun.runId, { exitCode: 0, signal: null, completedAt: revDoneAt });
  await runs.updateRun(capturedReviewRun.runId, (c) => ({ ...c, state: 'completed', completedAt: revDoneAt, finalizedAt: revDoneAt }));
  await srcOrchestrator.completeRun(capturedReviewRun.runId);

  const reviewOpinions = await withDatabase((db) => db.prepare('SELECT id FROM factory_review_opinions WHERE candidate_work_item_id=?').all(itemUnconfirmed.workItem.id));
  equal(reviewOpinions.length, 1);
  await factoryReviewOpinions.reconcileFactoryReviewOpinion({ organizationId: srcOrg.id, opinionId: reviewOpinions[0].id }, ownerActor);

  const syncedSourceItem = (await factoryControl.getFactoryWorkItem(srcOrg.id, itemUnconfirmed.workItem.id, ownerActor)).item;
  const acceptedRemote = await factoryAcceptance.decideFactoryManualAcceptance({
    organizationId: srcOrg.id,
    workItemId: itemUnconfirmed.workItem.id,
    criterionId: 'remote-execution-result',
    decision: 'passed',
    rationale: 'Accepted verified remote candidate after independent review',
    contractRevision: syncedSourceItem.contractRevision,
    candidateDigest: syncedSourceItem.candidateDigest,
    gateGeneration: syncedSourceItem.gateGeneration,
    expectedVersion: syncedSourceItem.rowVersion,
    commandId: 'cmd-e2e-acc',
    idempotencyKey: 'e2e-acc-1',
  }, ownerActor);
  equal(acceptedRemote.item.state, 'completed', 'Remote work item completed after independent review + manual owner acceptance');
  await sourceScheduler.stop();
  sourceScheduler = null;

  // ═══════════════════════════════════════════════════════════════════════════
  // E2E SCENARIO C (S4.1): Chunked Resumable Large-File & Scoped Bundle Transfer
  // ═══════════════════════════════════════════════════════════════════════════
  // Default-off gate checks
  const fileGateBlocked = await callRoute(handleRemoteFileRoutes, {
    method: 'POST',
    pathname: '/api/remote-files/grants',
    body: { sessionId: srcRootSession.id },
  });
  equal(fileGateBlocked.statusCode, 503, 'Remote file grant creation blocked when RAGENT_REMOTE_FILE_TRANSFER_ENABLED=0');

  process.env.RAGENT_REMOTE_FILE_TRANSFER_ENABLED = '1';
  await targetControl('/test-control/flags', { remoteFileTransferEnabled: '1' });

  // Large (>4 MiB = 4.25 MiB) file transfer: pause, drop response on chunk 2, reconcile under gate=0, resume to completion.
  const largeDir = join(sourceRepoDir, 'dist');
  mkdirSync(largeDir, { recursive: true });
  const largePath = join(largeDir, 'release-payload.bin');
  const largeBytes = randomBytes(4 * 1024 * 1024 + 256 * 1024);
  const largeSha = createHash('sha256').update(largeBytes).digest('hex');
  writeFileSync(largePath, largeBytes);

  const largeManifest = await remoteFileTransfer.buildRemoteTransferManifest({
    transferMode: 'chunked_file',
    sourcePath: largePath,
    sessionId: srcRootSession.id,
    bundleName: 'release-payload.bin',
    chunkBytes: 1024 * 1024, // 5 chunks
  });
  equal(largeManifest.manifest.totalChunks, 5, '4.25 MiB payload splits into 5 chunks');

  await targetControl('/test-control/configure-file-grant', {
    id: 'tgt_e2e_large',
    role: 'target',
    peerId: sourceIdentity.instanceId,
    peerKey: sourceIdentity.publicKey,
    peerGrantId: 'src_e2e_large',
    peerVersion: 1,
    transferMode: 'chunked_file',
    manifestDigest: largeManifest.manifestDigest,
    chunkBytes: 1024 * 1024,
    fileCount: 1,
    sizeBytes: largeBytes.length,
    filename: 'release-payload.bin',
    expectedVersion: 0,
    expiresAt: futureExpiry,
  });
  await remoteFileTransfer.configureRemoteFileGrant({
    id: 'src_e2e_large',
    role: 'source',
    peerId: targetIdentity.instanceId,
    peerKey: targetIdentity.publicKey,
    sessionId: srcRootSession.id,
    sourcePath: largePath,
    peerGrantId: 'tgt_e2e_large',
    peerVersion: 1,
    transferMode: 'chunked_file',
    manifestDigest: largeManifest.manifestDigest,
    chunkBytes: 1024 * 1024,
    fileCount: 1,
    sizeBytes: largeBytes.length,
    filename: 'release-payload.bin',
    expectedVersion: 0,
    expiresAt: futureExpiry,
  }, ownerActor);

  const paused = await remoteFileTransfer.sendRemoteFile('src_e2e_large', 'tr_e2e_large_1', ownerActor, { stopAfterChunks: 2 });
  equal(paused.status, 'resumable');
  deepEqual(paused.confirmedChunks, [0, 1]);

  let chunk2Dropped = false;
  const dropChunk2Proxy = async (args) => {
    const res = await proxyToTarget(args);
    if (args.method === 'POST' && args.body && String(args.body).includes('"chunkIndex":2') && !chunk2Dropped) {
      chunk2Dropped = true;
      throw new Error('Simulated drop after chunk 2 persisted');
    }
    return res;
  };
  const unknownChunk2 = await remoteFileTransfer.resumeRemoteManifestTransfer('src_e2e_large', 'tr_e2e_large_1', ownerActor, {
    proxyImpl: dropChunk2Proxy,
  });
  equal(unknownChunk2.status, 'unknown_outcome');

  // Reconcile under gate=0 observes chunk 2 already landed -> no blind resend!
  process.env.RAGENT_REMOTE_FILE_TRANSFER_ENABLED = '0';
  const recLarge = await callRoute(handleRemoteFileRoutes, {
    method: 'POST',
    pathname: '/api/remote-files/grants/src_e2e_large/transfers/tr_e2e_large_1/reconcile',
    body: {},
  });
  equal(recLarge.statusCode, 200);
  deepEqual(recLarge.body.confirmedChunks, [0, 1, 2], 'Reconcile observes chunk 2 already committed on target');

  process.env.RAGENT_REMOTE_FILE_TRANSFER_ENABLED = '1';
  const callsBeforeResume = (await targetControl('/test-control/stats')).body.remoteFilePostCalls;
  const doneLarge = await remoteFileTransfer.resumeRemoteManifestTransfer('src_e2e_large', 'tr_e2e_large_1', ownerActor);
  equal(doneLarge.status, 'received', 'Resumed >4 MiB chunked file finished cleanly');
  equal((await targetControl('/test-control/stats')).body.remoteFilePostCalls - callsBeforeResume, 3, 'Only chunks 3, 4 and finalize sent');

  const largeMeta = JSON.parse(readFileSync(join(targetConfigDir, 'file-assets', `${doneLarge.targetAssetId}.json`), 'utf8'));
  const targetLargeActualSha = createHash('sha256')
    .update(readFileSync(join(targetConfigDir, 'file-assets', 'objects', largeMeta.storage.localFilename)))
    .digest('hex');
  equal(targetLargeActualSha, largeSha, 'Target assembled >4 MiB file matches SHA-256 byte-for-byte');

  // Bounded directory bundle with allowedPaths filter
  const bundleDir = join(sourceRepoDir, 'scoped_bundle');
  mkdirSync(join(bundleDir, 'docs'), { recursive: true });
  mkdirSync(join(bundleDir, 'ignored_outside'), { recursive: true });
  writeFileSync(join(bundleDir, 'docs', 'summary.md'), capturedRemoteSummaryText || '# Summary\n', 'utf8');
  writeFileSync(join(bundleDir, 'docs', 'empty.txt'), '', 'utf8');
  writeFileSync(join(bundleDir, 'ignored_outside', 'secret.txt'), 'must not transfer', 'utf8');

  const scopedBundleManifest = await remoteFileTransfer.buildRemoteTransferManifest({
    transferMode: 'directory_bundle',
    sourcePath: bundleDir,
    sessionId: srcRootSession.id,
    bundleName: 'scoped-docs-bundle',
    chunkBytes: 512,
    allowedPaths: ['docs'],
  });
  equal(scopedBundleManifest.manifest.fileCount, 2, 'allowedPaths filters directory bundle to docs/ only');
  check(scopedBundleManifest.manifest.files.every((f) => f.path.startsWith('docs/')), 'Manifest contains only authorized paths');

  await targetControl('/test-control/configure-file-grant', {
    id: 'tgt_e2e_bundle',
    role: 'target',
    peerId: sourceIdentity.instanceId,
    peerKey: sourceIdentity.publicKey,
    peerGrantId: 'src_e2e_bundle',
    peerVersion: 1,
    transferMode: 'directory_bundle',
    manifestDigest: scopedBundleManifest.manifestDigest,
    chunkBytes: 512,
    fileCount: scopedBundleManifest.manifest.fileCount,
    sizeBytes: scopedBundleManifest.manifest.totalBytes,
    filename: 'scoped-docs-bundle',
    targetDir: 'e2e_received_bundle',
    allowedPaths: ['docs'],
    expectedVersion: 0,
    expiresAt: futureExpiry,
  });
  await remoteFileTransfer.configureRemoteFileGrant({
    id: 'src_e2e_bundle',
    role: 'source',
    peerId: targetIdentity.instanceId,
    peerKey: targetIdentity.publicKey,
    sessionId: srcRootSession.id,
    sourcePath: bundleDir,
    peerGrantId: 'tgt_e2e_bundle',
    peerVersion: 1,
    transferMode: 'directory_bundle',
    manifestDigest: scopedBundleManifest.manifestDigest,
    chunkBytes: 512,
    fileCount: scopedBundleManifest.manifest.fileCount,
    sizeBytes: scopedBundleManifest.manifest.totalBytes,
    filename: 'scoped-docs-bundle',
    allowedPaths: ['docs'],
    expectedVersion: 0,
    expiresAt: futureExpiry,
  }, ownerActor);

  const bundleDelivered = await remoteFileTransfer.sendRemoteFile('src_e2e_bundle', 'tr_e2e_bundle_1', ownerActor);
  equal(bundleDelivered.status, 'received');
  equal(existsSync(join(targetRepoDir, 'e2e_received_bundle', 'docs', 'summary.md')), true);
  equal(existsSync(join(targetRepoDir, 'e2e_received_bundle', 'ignored_outside', 'secret.txt')), false, 'Out-of-scope dir not materialized');

  // Security negative assertions: traversal, restricted names, symlink/junction, tamper, revocation
  for (const evilPath of ['../secret', 'a\\b.txt', '//host/share/f', 'C:/win.ini', '.git/HEAD', '.env.prod', 'ssh/id_rsa', 'tls/cert.pem', 'CON.txt']) {
    passed += 1;
    assert.throws(
      () => remoteFileTransfer.validateBundleRelativePath(evilPath),
      (e) => /^FILE_TRANSFER_PATH_/.test(String(e?.code || '')),
      `Rejected unsafe bundle path: ${evilPath}`,
    );
  }

  const symlinkDir = join(sourceRepoDir, 'sym_escape_dir');
  const outsideDir = join(tempRoot, 'outside_sensitive');
  mkdirSync(symlinkDir, { recursive: true });
  mkdirSync(outsideDir, { recursive: true });
  writeFileSync(join(outsideDir, 'token.txt'), 'secret-outside-token', 'utf8');
  symlinkSync(outsideDir, join(symlinkDir, 'link_out'), process.platform === 'win32' ? 'junction' : 'dir');
  await rejectsCode(
    () => remoteFileTransfer.buildRemoteTransferManifest({
      transferMode: 'directory_bundle',
      sourcePath: symlinkDir,
      sessionId: srcRootSession.id,
      chunkBytes: 512,
    }),
    'FILE_TRANSFER_SYMLINK_REJECTED',
    'Symlink/junction escape inside bundle rejected',
  );

  // Tamper test: corrupt chunk payload and ensure target rejects 403, then revoke grant and confirm chunk rejected.
  const tamperManifest = await remoteFileTransfer.buildRemoteTransferManifest({
    transferMode: 'chunked_file',
    sourcePath: largePath,
    sessionId: srcRootSession.id,
    bundleName: 'tamper.bin',
    chunkBytes: 1024 * 1024,
  });
  await targetControl('/test-control/configure-file-grant', {
    id: 'tgt_e2e_tamper',
    role: 'target',
    peerId: sourceIdentity.instanceId,
    peerKey: sourceIdentity.publicKey,
    peerGrantId: 'src_e2e_tamper',
    peerVersion: 1,
    transferMode: 'chunked_file',
    manifestDigest: tamperManifest.manifestDigest,
    chunkBytes: 1024 * 1024,
    fileCount: 1,
    sizeBytes: largeBytes.length,
    filename: 'tamper.bin',
    expectedVersion: 0,
    expiresAt: futureExpiry,
  });
  await remoteFileTransfer.configureRemoteFileGrant({
    id: 'src_e2e_tamper',
    role: 'source',
    peerId: targetIdentity.instanceId,
    peerKey: targetIdentity.publicKey,
    sessionId: srcRootSession.id,
    sourcePath: largePath,
    peerGrantId: 'tgt_e2e_tamper',
    peerVersion: 1,
    transferMode: 'chunked_file',
    manifestDigest: tamperManifest.manifestDigest,
    chunkBytes: 1024 * 1024,
    fileCount: 1,
    sizeBytes: largeBytes.length,
    filename: 'tamper.bin',
    expectedVersion: 0,
    expiresAt: futureExpiry,
  }, ownerActor);
  let sawTamperHttp = 0;
  const corruptChunk0 = async (args) => {
    if (args.method === 'POST' && args.body && String(args.body).includes('"action":"upload_chunk"')) {
      const parsed = JSON.parse(args.body);
      const b = Buffer.from(parsed.bytesBase64, 'base64');
      b[0] ^= 0xff;
      parsed.bytesBase64 = b.toString('base64');
      const r = await proxyToTarget({ ...args, body: JSON.stringify(parsed) });
      sawTamperHttp = r.response.status;
      return r;
    }
    return proxyToTarget(args);
  };
  await remoteFileTransfer.sendRemoteFile('src_e2e_tamper', 'tr_e2e_tamper_1', ownerActor, { proxyImpl: corruptChunk0 });
  equal(sawTamperHttp, 403, 'Target rejected tampered chunk payload with HTTP 403');

  const revGrantRes = await callRoute(handleRemoteFileRoutes, {
    method: 'POST',
    pathname: '/api/remote-files/grants/src_e2e_tamper/revoke',
    body: { expectedVersion: 1 },
  });
  equal(revGrantRes.statusCode, 200);
  equal(revGrantRes.body.enabled, false, 'Source grant revoked cleanly');
  await rejectsCode(
    () => remoteFileTransfer.sendRemoteFile('src_e2e_tamper', 'tr_e2e_after_revoke', ownerActor),
    'FILE_TRANSFER_FORBIDDEN',
    'Revoked grant rejects new remote file transfer',
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // E2E SCENARIO D (S4.2): Unified Connector Dispatcher, 4 Connectors & Boundaries
  // ═══════════════════════════════════════════════════════════════════════════
  // 1. Conservative Responsibility Capability Catalog Defaults & Scope Fail-Closed
  const defaultCaps = await respCapabilities.getResponsibilityCapabilities({ organizationId: srcOrg.id, projectId: srcProject.id }, ownerActor);
  equal(defaultCaps.planCatalogDescriptors[0].capability, 'project-report');
  equal(defaultCaps.planCatalogDescriptors[1].capability, 'project-code');
  equal(defaultCaps.features.defaultCapabilityGates.allowConnectorRead, false);
  equal(defaultCaps.features.defaultCapabilityGates.allowConnectorWrite, false);
  equal(defaultCaps.features.defaultCapabilityGates.allowConnectorBroadcast, false);

  const defaultGateBlocked = respCapabilities.resolveConnectorCapabilityBoundary({
    capability: 'gmail.message.read',
    scope: { resource: 'mailbox:messages' },
    policy: {},
  });
  equal(defaultGateBlocked.allowed, false);
  equal(defaultGateBlocked.code, 'CONNECTOR_GATE_DISABLED');

  const missingRepoBlocked = respCapabilities.resolveConnectorCapabilityBoundary({
    capability: 'github.pr.create',
    scope: { resource: 'pr:new' },
    policy: {
      capabilityGates: { allowConnectorBroadcast: true },
      allowedConnectorCapabilities: ['github.pr.create'],
      connectorScopes: { github: { allowedRepositories: ['octo/stage4-app'] } },
    },
    actor: ownerActor,
    approval: { confirmed: true, approvedBy: OWNER_ID },
  });
  equal(missingRepoBlocked.allowed, false);
  equal(missingRepoBlocked.code, 'CONNECTOR_SCOPE_VIOLATION', 'Missing scope.repository fails closed');

  const ledgerPath = join(sourceDataDir, 'stage4-e2e-connector-ledger.sqlite');
  dispatcher = dispatcherMod.createConnectorActionDispatcher({ ledgerPath });

  // 2. GitHub Connector E2E (PR create approval -> timeout across restart -> reconcile -> update/merge)
  const gh = createGitHubE2EMock();
  const ghPolicy = {
    allowedCapabilities: ['github.pull.list', 'github.pull.get', 'github.pr.create', 'github.pr.update', 'github.pr.comment', 'github.pr.merge'],
    withinPolicy: true,
    allowAutoWithinPolicyReversible: true,
    connectorScopes: {
      github: { allowedRepositories: ['octo/stage4-app'], allowedBaseBranches: ['main'] },
    },
  };

  const ghPending = await dispatcher.dispatch(
    'github.pr.create',
    { owner: 'octo', repo: 'stage4-app', title: 'Remote Delivery Summary', head: 'feat/remote-e2e', base: 'main', body: capturedRemoteSummaryText, idempotencyKey: 'e2e-gh-pr-1' },
    { policy: ghPolicy, fetchImpl: gh.fetchImpl, token: 'gh-e2e-tok' },
  );
  equal(ghPending.state, 'pending_approval', 'GitHub PR create gated by explicit approval');

  gh.setDropNextCreate(true);
  const ghTimedOut = await dispatcher.dispatch(
    'github.pr.create',
    { owner: 'octo', repo: 'stage4-app', title: 'Remote Delivery Summary', head: 'feat/remote-e2e', base: 'main', body: capturedRemoteSummaryText, idempotencyKey: 'e2e-gh-pr-1' },
    {
      policy: ghPolicy,
      fetchImpl: gh.fetchImpl,
      token: 'gh-e2e-tok',
      timeoutMs: 40,
      actor: ownerActor,
      approval: { confirmed: true, approvedBy: OWNER_ID, approvalId: 'appr-e2e-gh-1' },
    },
  );
  equal(ghTimedOut.state, 'unknown_outcome');
  await new Promise((r) => setTimeout(r, 140));

  // Restart dispatcher against durable SQLite ledger -> verify blind replay stays blocked across restarts!
  dispatcher.close();
  dispatcher = dispatcherMod.createConnectorActionDispatcher({ ledgerPath });

  const ghReplayBlocked = await dispatcher.dispatch(
    'github.pr.create',
    { owner: 'octo', repo: 'stage4-app', title: 'Remote Delivery Summary', head: 'feat/remote-e2e', base: 'main', body: capturedRemoteSummaryText, idempotencyKey: 'e2e-gh-pr-1' },
    {
      policy: ghPolicy,
      fetchImpl: gh.fetchImpl,
      token: 'gh-e2e-tok',
      actor: ownerActor,
      approval: { confirmed: true, approvedBy: OWNER_ID, approvalId: 'appr-e2e-gh-2' },
    },
  );
  equal(ghReplayBlocked.blockedReplay, true, 'Unknown outcome PR create never blindly replays after restart');
  equal(gh.stats().postPullCalls, 1);

  const ghReconcile = await dispatcher.reconcile(
    githubMod.createGitHubConnectorAction(
      'github.pr.create',
      { owner: 'octo', repo: 'stage4-app', title: 'Remote Delivery Summary', head: 'feat/remote-e2e', base: 'main', body: capturedRemoteSummaryText },
      { idempotencyKey: 'e2e-gh-pr-1', fetchImpl: gh.fetchImpl, token: 'gh-e2e-tok' },
    ),
  );
  equal(ghReconcile.ok, true, 'Reconciles PR #101 via GitHub idempotency marker');
  equal(ghReconcile.externalId, '101');

  const ghStaleUpdate = await dispatcher.dispatch(
    'github.pr.update',
    { owner: 'octo', repo: 'stage4-app', pullNumber: 101, title: 'Updated PR', expectedHeadSha: 'wrong-sha', idempotencyKey: 'e2e-gh-upd-stale' },
    { policy: ghPolicy, fetchImpl: gh.fetchImpl, token: 'gh-e2e-tok', actor: ownerActor, approval: { confirmed: true, approvedBy: OWNER_ID, approvalId: 'appr-e2e-gh-upd-stale' } },
  );
  equal(ghStaleUpdate.state, 'conflict');
  equal(gh.stats().patchPullCalls, 0);

  const ghMergePending = await dispatcher.dispatch(
    'github.pr.merge',
    { owner: 'octo', repo: 'stage4-app', pullNumber: 101, sha: 'head-sha-e2e-1', idempotencyKey: 'e2e-gh-merge-1' },
    { policy: ghPolicy, fetchImpl: gh.fetchImpl, token: 'gh-e2e-tok' },
  );
  equal(ghMergePending.state, 'pending_approval');

  const ghMergeOk = await dispatcher.dispatch(
    'github.pr.merge',
    { owner: 'octo', repo: 'stage4-app', pullNumber: 101, sha: 'head-sha-e2e-1', idempotencyKey: 'e2e-gh-merge-1' },
    { policy: ghPolicy, fetchImpl: gh.fetchImpl, token: 'gh-e2e-tok', verifyReceiptAfterExecute: true, actor: ownerActor, approval: { confirmed: true, approvedBy: OWNER_ID, approvalId: 'appr-e2e-gh-merge-1' } },
  );
  equal(ghMergeOk.ok, true);
  equal(ghMergeOk.externalId, 'merge-sha-101');

  // 3. Gmail Connector E2E (Draft vs Send separation + timeout_and_sent reconcile + manual outcome review)
  const gm = createGmailE2EMock();
  const gmailDraftOnlyPolicy = {
    allowedCapabilities: ['gmail.message.list', 'gmail.message.read', 'gmail.draft.create'],
    withinPolicy: true,
    allowAutoWithinPolicyReversible: true,
    connectorScopes: { gmail: { allowDraftOnly: true, allowedRecipients: ['release-ops@example.com'] } },
  };
  const gmDraft = await dispatcher.dispatch(
    'gmail.draft.create',
    { to: 'release-ops@example.com', subject: 'Remote Delivery Summary', body: capturedRemoteSummaryText, idempotencyKey: 'e2e-gm-draft-1' },
    { policy: gmailDraftOnlyPolicy, gmailClient: gm.gmailClient },
  );
  equal(gmDraft.ok, true, 'Draft created within draft-only policy');
  equal(gm.stats().sendCalls, 0);

  const gmSendBlocked = await dispatcher.dispatch(
    'gmail.message.send',
    { to: 'release-ops@example.com', subject: 'Blocked', body: 'x', idempotencyKey: 'e2e-gm-send-blocked' },
    { policy: gmailDraftOnlyPolicy, gmailClient: gm.gmailClient, actor: ownerActor, approval: { confirmed: true, approvedBy: OWNER_ID } },
  );
  equal(gmSendBlocked.state, 'denied', 'Draft-only policy strictly denies gmail.message.send');

  const gmailSendPolicy = {
    allowedCapabilities: ['gmail.draft.create', 'gmail.message.send'],
    withinPolicy: true,
    connectorScopes: { gmail: { allowedRecipients: ['release-ops@example.com'] } },
  };
  gm.setMode('timeout_and_sent');
  const gmTimeoutSent = await dispatcher.dispatch(
    'gmail.message.send',
    { to: 'release-ops@example.com', subject: 'Delivered Release Notice', body: 'Ready', idempotencyKey: 'e2e-gm-send-ok' },
    { policy: gmailSendPolicy, gmailClient: gm.gmailClient, timeoutMs: 40, actor: ownerActor, approval: { confirmed: true, approvedBy: OWNER_ID, approvalId: 'appr-e2e-gm-1' } },
  );
  equal(gmTimeoutSent.state, 'unknown_outcome');
  await new Promise((r) => setTimeout(r, 140));

  const gmReconciled = await dispatcher.reconcile(
    gmailMod.createGmailConnectorAction(
      'gmail.message.send',
      { to: 'release-ops@example.com', subject: 'Delivered Release Notice', body: 'Ready' },
      { idempotencyKey: 'e2e-gm-send-ok', gmailClient: gm.gmailClient },
    ),
  );
  equal(gmReconciled.ok, true, 'Reconciles sent email via deterministic rfc822msgid receipt');
  equal(gmReconciled.state, 'delivered');

  gm.setMode('timeout_and_lost');
  const gmTimeoutLost = await dispatcher.dispatch(
    'gmail.message.send',
    { to: 'release-ops@example.com', subject: 'Lost Send', body: 'Body', idempotencyKey: 'e2e-gm-send-lost' },
    { policy: gmailSendPolicy, gmailClient: gm.gmailClient, timeoutMs: 40, actor: ownerActor, approval: { confirmed: true, approvedBy: OWNER_ID, approvalId: 'appr-e2e-gm-lost' } },
  );
  equal(gmTimeoutLost.state, 'unknown_outcome');
  await new Promise((r) => setTimeout(r, 140));

  const gmReview = await dispatcher.recordOutcomeReview(
    { idempotencyKey: 'e2e-gm-send-lost', observation: 'observed_absent', evidence: 'Verified Sent folder empty' },
    ownerActor,
  );
  equal(gmReview.state, 'unknown_outcome', 'Owner outcome review logs observation while preserving unknown_outcome ledger');

  // 4. Calendar Connector E2E (deterministic ID + conflict guard + mandatory delete approval)
  const cal = createCalendarE2EMock();
  const calPolicy = {
    allowedCapabilities: ['calendar.event.get', 'calendar.event.create', 'calendar.event.update', 'calendar.event.cancel', 'calendar.event.delete'],
    withinPolicy: true,
    allowAutoWithinPolicyReversible: true,
    connectorScopes: { calendar: { allowedCalendarIds: ['primary'] } },
  };
  cal.setDropNextInsert(true);
  const calTimeout = await dispatcher.dispatch(
    'calendar.event.create',
    { calendarId: 'primary', title: 'Stage 4 Cutover', startTime: '2026-12-02T10:00:00Z', endTime: '2026-12-02T11:00:00Z', idempotencyKey: 'e2e-cal-1' },
    { policy: calPolicy, calendarClient: cal.calendarClient, timeoutMs: 40, actor: ownerActor, approval: { confirmed: true, approvedBy: OWNER_ID, approvalId: 'appr-e2e-cal-1' } },
  );
  equal(calTimeout.state, 'unknown_outcome');
  await new Promise((r) => setTimeout(r, 140));

  const calRec = await dispatcher.reconcile(
    calendarMod.createCalendarConnectorAction(
      'calendar.event.create',
      { calendarId: 'primary', title: 'Stage 4 Cutover', startTime: '2026-12-02T10:00:00Z', endTime: '2026-12-02T11:00:00Z' },
      { idempotencyKey: 'e2e-cal-1', calendarClient: cal.calendarClient },
    ),
  );
  equal(calRec.ok, true);
  const evtId = calRec.externalId;

  const calNoPrecond = await dispatcher.dispatch(
    'calendar.event.update',
    { calendarId: 'primary', eventId: evtId, title: 'Unsafe Overwrite', idempotencyKey: 'e2e-cal-nopre' },
    { policy: calPolicy, calendarClient: cal.calendarClient, actor: ownerActor, approval: { confirmed: true, approvedBy: OWNER_ID, approvalId: 'appr-e2e-cal-nopre' } },
  );
  equal(calNoPrecond.state, 'failed_pre_dispatch');
  equal(calNoPrecond.code, 'CONNECTOR_CONFLICT_CHECK_REQUIRED');
  equal(cal.stats().patchCalls, 0);

  const curEvt = (await calendarMod.getCalendarEvent({ calendarId: 'primary', eventId: evtId, calendarClient: cal.calendarClient })).event;
  const calUpdOk = await dispatcher.dispatch(
    'calendar.event.update',
    { calendarId: 'primary', eventId: evtId, title: 'Stage 4 Cutover Confirmed', expectedEtag: curEvt.etag, expectedSequence: curEvt.sequence, idempotencyKey: 'e2e-cal-upd-ok' },
    { policy: calPolicy, calendarClient: cal.calendarClient, verifyReceiptAfterExecute: true, actor: ownerActor, approval: { confirmed: true, approvedBy: OWNER_ID, approvalId: 'appr-e2e-cal-updok' } },
  );
  equal(calUpdOk.ok, true);

  const calDelPending = await dispatcher.dispatch(
    'calendar.event.delete',
    { calendarId: 'primary', eventId: evtId, expectedSequence: 1, idempotencyKey: 'e2e-cal-del-1' },
    { policy: calPolicy, calendarClient: cal.calendarClient },
  );
  equal(calDelPending.state, 'pending_approval', 'Calendar hard delete enforces mandatory human approval');

  // 5. Drive Connector E2E (folder scoping + parentless filtering + query injection + etag + sharing gate & compensation)
  const drv = createDriveE2EMock();
  const drivePolicy = {
    allowedCapabilities: ['drive.file.list', 'drive.file.get', 'drive.file.read', 'drive.folder.create', 'drive.file.create', 'drive.file.update', 'drive.file.share'],
    withinPolicy: true,
    allowAutoWithinPolicyReversible: true,
    connectorScopes: {
      drive: {
        allowedFolderIds: ['folder-allowed'],
        allowedShareEmails: ['reviewer@example.com'],
        allowedShareDomains: ['example.com'],
        allowPublicExposure: false,
      },
    },
  };

  const drvSecretDenied = await dispatcher.dispatch(
    'drive.file.read',
    { fileId: 'file-secret-1', idempotencyKey: 'e2e-drv-secret' },
    { policy: drivePolicy, driveClient: drv.driveClient },
  );
  equal(drvSecretDenied.state, 'denied');
  equal(drvSecretDenied.code, 'CONNECTOR_SCOPE_VIOLATION');

  const drvListScoped = await dispatcher.dispatch(
    'drive.file.list',
    { folderId: 'folder-allowed', idempotencyKey: 'e2e-drv-list-1' },
    { policy: drivePolicy, driveClient: drv.driveClient },
  );
  equal(drvListScoped.ok, true);
  equal(drvListScoped.result.files.some((f) => f.id === 'file-parentless-leak' || f.id === 'file-secret-1'), false, 'Parentless and secret files excluded from scoped Drive list');

  const drvCreateOk = await dispatcher.dispatch(
    'drive.file.create',
    { name: 'remote-e2e-summary.md', parentId: 'folder-allowed', mimeType: 'text/markdown', content: capturedRemoteSummaryText, idempotencyKey: 'e2e-drv-create-1' },
    { policy: drivePolicy, driveClient: drv.driveClient, actor: ownerActor, approval: { confirmed: true, approvedBy: OWNER_ID, approvalId: 'appr-e2e-drv-c1' } },
  );
  equal(drvCreateOk.ok, true);
  const driveFileId = drvCreateOk.externalId;

  const drvReadMeta = await dispatcher.dispatch(
    'drive.file.read',
    { fileId: driveFileId, idempotencyKey: 'e2e-drv-read-1' },
    { policy: drivePolicy, driveClient: drv.driveClient },
  );
  const drvStaleUpd = await dispatcher.dispatch(
    'drive.file.update',
    { fileId: driveFileId, content: 'stale-write', expectedEtag: '"wrong-etag"', idempotencyKey: 'e2e-drv-upd-stale' },
    { policy: drivePolicy, driveClient: drv.driveClient, actor: ownerActor, approval: { confirmed: true, approvedBy: OWNER_ID, approvalId: 'appr-e2e-drv-us' } },
  );
  equal(drvStaleUpd.state, 'conflict');
  equal(drv.stats().updateCalls, 0);

  const drvUpdOk = await dispatcher.dispatch(
    'drive.file.update',
    { fileId: driveFileId, content: `${capturedRemoteSummaryText}\nApproved: true\n`, expectedEtag: drvReadMeta.result.etag, expectedRevisionId: drvReadMeta.result.revisionId, idempotencyKey: 'e2e-drv-upd-ok' },
    { policy: drivePolicy, driveClient: drv.driveClient, actor: ownerActor, approval: { confirmed: true, approvedBy: OWNER_ID, approvalId: 'appr-e2e-drv-uok' } },
  );
  equal(drvUpdOk.ok, true);

  const drvPublicBlocked = await dispatcher.dispatch(
    'drive.file.share',
    { fileId: driveFileId, type: 'anyone', role: 'reader', allowPublicExposure: true, idempotencyKey: 'e2e-drv-share-pub' },
    { policy: drivePolicy, driveClient: drv.driveClient, actor: ownerActor, approval: { confirmed: true, approvedBy: OWNER_ID, approvalId: 'appr-e2e-drv-pub' } },
  );
  equal(drvPublicBlocked.state, 'denied', 'Public Drive share denied despite approval');

  const drvShareOk = await dispatcher.dispatch(
    'drive.file.share',
    { fileId: driveFileId, type: 'user', role: 'reader', emailAddress: 'reviewer@example.com', idempotencyKey: 'e2e-drv-share-rev' },
    { policy: drivePolicy, driveClient: drv.driveClient, verifyReceiptAfterExecute: true, actor: ownerActor, approval: { confirmed: true, approvedBy: OWNER_ID, approvalId: 'appr-e2e-drv-rev' } },
  );
  equal(drvShareOk.ok, true);
  equal((drv.permissions.get(driveFileId) || []).length, 1);

  // External broadcast sharing refuses automatic "undo" compensation (cannot retract copied external views).
  const drvShareCompUnsupported = await dispatcher.compensate('e2e-drv-share-rev', {
    policy: drivePolicy,
    actor: ownerActor,
    approval: { confirmed: true, approvedBy: OWNER_ID, approvalId: 'appr-e2e-drv-share-comp' },
  });
  equal(drvShareCompUnsupported.ok, false);
  equal(drvShareCompUnsupported.code, 'CONNECTOR_COMPENSATION_UNSUPPORTED', 'External Drive share refuses automatic compensation');

  // Reversible Drive file update supports approved compensating_action restoration.
  const drvUpdateCompensated = await dispatcher.compensate('e2e-drv-upd-ok', {
    policy: drivePolicy,
    actor: ownerActor,
    approval: { confirmed: true, approvedBy: OWNER_ID, approvalId: 'appr-e2e-drv-upd-comp' },
    executeCompensation: async () => {
      const restored = await drv.driveClient.files.update({
        fileId: driveFileId,
        requestBody: {},
        media: { body: capturedRemoteSummaryText },
      });
      return { externalId: restored.data.id };
    },
  });
  equal(drvUpdateCompensated.ok, true, 'Reversible Drive update compensated cleanly');
  equal(drv.contents.get(driveFileId), capturedRemoteSummaryText, 'Compensated update restored previous content');

  console.log(`test-stage4-e2e-acceptance: ok (${passed} assertions)`);
} finally {
  try { sessionManager.killAll?.(); } catch {}
  try { if (sourceScheduler) await sourceScheduler.stop(); } catch {}
  try { dispatcher?.close?.(); } catch {}
  try { await targetControl('/test-control/shutdown'); } catch {}
  try {
    await new Promise((r) => {
      if (targetProc.exitCode !== null) return r();
      const t = setTimeout(() => { try { targetProc.kill('SIGKILL'); } catch {} r(); }, 2000);
      targetProc.once('exit', () => { clearTimeout(t); r(); });
    });
  } catch {}
  try { await new Promise((r) => accountsServer.close(() => r())); } catch {}
  try { await orgStore.closeOrganizationDatabase?.(); } catch {}
  globalThis.fetch = realFetch;
  try { rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
}
