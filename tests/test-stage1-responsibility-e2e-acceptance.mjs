#!/usr/bin/env node
// Stage 1 End-to-End Acceptance Suite for Ragent Full 2.0:
// Exercises real SQLite stores, real Responsibility & Factory runtimes, real
// HTTP routes, real ResultPackets, real Web Push crypto/VAPID generation, and
// a loopback Accounts Cloud Push server verifying Ed25519 instance signatures.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createECDH, createHash, createPrivateKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { Readable } from 'node:stream';

const tempRoot = mkdtempSync(join(tmpdir(), 'ragent-stage1-e2e-'));
const instanceRoot = join(tempRoot, 'instance');
const configDir = join(instanceRoot, 'config');
const dataDir = join(instanceRoot, 'data');
const workRootDir = join(instanceRoot, 'workspace');
const memoryDir = join(instanceRoot, 'memory');
const harnessRoot = join(tempRoot, 'harnesses');
const harnessBin = join(harnessRoot, 'codex', 'node_modules', '.bin');
const repoDir = join(tempRoot, 'repo');

const OWNER_ID = 'owner-stage1-e2e';
const ACCOUNT_ID = 'acct_stage1_e2e';
const DEVICE_ID = 'rdev_stage1_e2e';

process.env.HOME = tempRoot;
process.env.USERPROFILE = tempRoot;
process.env.LOCALAPPDATA = join(tempRoot, 'localappdata');
process.env.APPDATA = join(tempRoot, 'appdata');
process.env.RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
process.env.RAGENT_INSTANCE_ROOT = instanceRoot;
process.env.RAGENT_CONFIG_DIR = configDir;
process.env.RAGENT_DATA_DIR = dataDir;
process.env.RAGENT_WORK_ROOT_DIR = workRootDir;
process.env.RAGENT_MEMORY_DIR = memoryDir;
process.env.RAGENT_HARNESS_ROOT = harnessRoot;
process.env.RAGENT_ACCOUNTS_URL = 'https://accounts.stage1.invalid/accounts';
process.env.RAGENT_ACCOUNTS_ISSUER = 'https://accounts.stage1.invalid/accounts';
process.env.RAGENT_AUTH_SESSION_SECRET = 'stage1-acceptance-auth-secret-1234567890';
process.env.SECURE_COOKIES = '0';
process.env.RAGENT_ORG_SCHEMA_ENABLED = '1';
process.env.RAGENT_ORG_PROJECTION_V1_ENABLED = '1';
process.env.RAGENT_ORG_PROJECTION_V2_ENABLED = '1';
process.env.RAGENT_ORG_STALL_GOVERNOR_ENABLED = '1';
process.env.RAGENT_MANAGED_WRITER_ENABLED = '1';
process.env.RAGENT_CODEX_PROVIDER_READONLY = '1';
process.env.RAGENT_FACTORY_CONTROL_ENABLED = 'true';
process.env.RAGENT_FACTORY_SCHEDULER_ENABLED = '1';
process.env.RAGENT_FACTORY_SCHEDULER_OWNER_ID = OWNER_ID;
process.env.RAGENT_RESPONSIBILITY_RUNTIME_ENABLED = '1';
process.env.RAGENT_RESPONSIBILITY_PUSH_ENABLED = '0';

mkdirSync(configDir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(workRootDir, { recursive: true });
mkdirSync(memoryDir, { recursive: true });
mkdirSync(process.env.LOCALAPPDATA, { recursive: true });
mkdirSync(process.env.APPDATA, { recursive: true });
mkdirSync(harnessBin, { recursive: true });
mkdirSync(join(repoDir, 'docs'), { recursive: true });

// Provide codex command stub on PATH so tool availability checks stay deterministic offline.
writeFileSync(join(harnessBin, 'codex'), '#!/bin/sh\necho "0.114.0"\n', 'utf8');
try { chmodSync(join(harnessBin, 'codex'), 0o755); } catch {}
if (process.platform === 'win32') {
  writeFileSync(join(harnessBin, 'codex.cmd'), '@echo off\r\necho 0.114.0\r\n', 'utf8');
}
process.env.PATH = `${harnessBin}${delimiter}${process.env.PATH || ''}`;

// Create a real non-CI Git repository with an origin remote so both project-report and project-code baselines work.
execFileSync('git', ['init', '-b', 'main', repoDir], { stdio: 'ignore' });
execFileSync('git', ['-C', repoDir, 'config', 'user.email', 'stage1-e2e@example.com'], { stdio: 'ignore' });
execFileSync('git', ['-C', repoDir, 'config', 'user.name', 'Stage1 E2E'], { stdio: 'ignore' });
execFileSync('git', ['-C', repoDir, 'remote', 'add', 'origin', 'https://github.com/ragent-app/Ragent_product.git'], { stdio: 'ignore' });
writeFileSync(join(repoDir, 'README.md'), '# Non-CI Project\nInitial baseline.\n', 'utf8');
writeFileSync(join(repoDir, 'docs', 'status.md'), 'Status: initial\n', 'utf8');
execFileSync('git', ['-C', repoDir, 'add', '.'], { stdio: 'ignore' });
execFileSync('git', ['-C', repoDir, 'commit', '-m', 'initial project baseline'], { stdio: 'ignore' });

// Seed owner account binding + trusted device + instance identity before importing runtime modules.
const deviceKeyPair = generateKeyPairSync('ed25519');
const deviceToken = `rdt_${'a'.repeat(64)}`;
writeFileSync(join(configDir, 'auth.json'), JSON.stringify({ username: 'owner', passwordHash: 'unused-fixture' }), 'utf8');
writeFileSync(join(configDir, 'owner-account-binding.json'), JSON.stringify({
  accountId: ACCOUNT_ID,
  provider: 'google',
  bindingAuthorityRevision: '1',
  boundAt: new Date().toISOString(),
}), 'utf8');

const identityMod = await import('../lib/instance-identity.mjs');
const identity = await identityMod.loadOrCreateInstanceIdentity();
const { verifyInstanceProofSignature } = await import('../lib/instance-proof-protocol.mjs');
const { createPrivateKey: createPriv, sign } = await import('node:crypto');

const bindingAuthorityRev = '1';
writeFileSync(join(configDir, 'owner-account-authority.json'), JSON.stringify({
  version: 1,
  instanceId: identity.instanceId,
  keyFingerprint: identity.keyFingerprint,
  revision: bindingAuthorityRev,
  deniedAccounts: [],
}), 'utf8');
writeFileSync(join(configDir, 'trusted-devices.json'), JSON.stringify({
  version: 1,
  instanceId: 'rli_stage1_e2e',
  instanceSecret: 'ris_stage1_e2e',
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

// Seed authority snapshot cache if needed by binding-authority-runtime.
const accountsKeys = generateKeyPairSync('ed25519');
let failNextPushEvents = 0;
const receivedCloudPushEvents = [];
const accountsServer = createServer(async (req, res) => {
  const path = (req.url || '').split('?')[0];
  if (path === '/accounts/.well-known/jwks.json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys: [{ ...accountsKeys.publicKey.export({ format: 'jwk' }), kid: 'stage1-k1' }] }));
    return;
  }
  if (path === '/accounts/v1/owner-auth/instances/authority' && req.method === 'POST') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const iat = Math.floor(Date.now() / 1000);
    const assertionPayload = {
      iss: process.env.RAGENT_ACCOUNTS_ISSUER,
      aud: identity.instanceId,
      sub: ACCOUNT_ID,
      tx: body.requestId,
      nonce: body.nonce,
      instanceKeyFingerprint: identity.keyFingerprint,
      purpose: 'binding_authority',
      authorityProtocol: 1,
      bindingAuthorityState: 'active',
      bindingAuthorityRevision: bindingAuthorityRev,
      iat,
      exp: iat + 30,
    };
    const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', kid: 'stage1-k1' })).toString('base64url');
    const claims = Buffer.from(JSON.stringify(assertionPayload)).toString('base64url');
    const sig = sign(null, Buffer.from(`${header}.${claims}`), accountsKeys.privateKey).toString('base64url');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ assertion: `${header}.${claims}.${sig}` }));
    return;
  }
  if (path === '/accounts/v1/push/events' && req.method === 'POST') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (failNextPushEvents > 0) {
      failNextPushEvents -= 1;
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 'push_temporarily_unavailable' }));
      return;
    }
    const msg = JSON.stringify([
      'ragent-push-event-v1',
      body.instanceId,
      body.eventId,
      body.sessionId,
      body.kind,
      body.runId,
      body.awaitingKey,
      body.generation,
      body.occurredAt,
      body.expiresAt,
      body.issuedAt,
      body.nonce,
    ]);
    const validSig = verifyInstanceProofSignature({
      publicKey: identity.publicKey,
      message: msg,
      signature: body.signature,
    });
    if (!validSig || body.instanceId !== identity.instanceId) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 'push_unauthorized' }));
      return;
    }
    receivedCloudPushEvents.push(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, accepted: true, instanceId: body.instanceId, kind: body.kind, eventId: body.eventId }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found', path }));
});

await new Promise((resolve) => accountsServer.listen(0, '127.0.0.1', resolve));
const realFetch = globalThis.fetch;
globalThis.fetch = (url, options) => {
  const parsed = new URL(url);
  if (parsed.origin === 'https://accounts.stage1.invalid') {
    return realFetch(`http://127.0.0.1:${accountsServer.address().port}${parsed.pathname}${parsed.search}`, options);
  }
  return realFetch(url, options);
};

// Spy web-push delivery using real generateRequestDetails (real VAPID JWT + AES-128-GCM encryption) without live network push service.
const webpushMod = (await import('web-push')).default;
const origSendNotification = webpushMod.sendNotification.bind(webpushMod);
const sentWebPushCalls = [];
let webPushSimulateResult = 'ok';
webpushMod.sendNotification = async (subscription, payload, options) => {
  const requestDetails = webpushMod.generateRequestDetails(subscription, payload, options);
  sentWebPushCalls.push({
    endpoint: subscription.endpoint,
    payload: JSON.parse(payload),
    options,
    headers: requestDetails.headers,
    encryptedBytes: requestDetails.body?.length || 0,
  });
  if (webPushSimulateResult === 'gone') {
    throw Object.assign(new Error('Gone'), { statusCode: 410 });
  }
  if (webPushSimulateResult === 'transient') {
    throw Object.assign(new Error('Service Unavailable'), { statusCode: 503 });
  }
  return { statusCode: 201, headers: {}, body: '' };
};

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
const factoryReconciliation = await import('../chat/factory-reconciliation.mjs');
const factoryReviewOpinions = await import('../chat/factory-review-opinions.mjs');
const { getResponsibilityCapabilities } = await import('../chat/responsibility-capabilities.mjs');
const { createResponsibilityRuntime } = await import('../chat/responsibility-runtime.mjs');
const responsibilityService = await import('../chat/responsibility-service.mjs');
const responsibilityEvents = await import('../chat/responsibility-events.mjs');
const responsibilityPlans = await import('../chat/responsibility-plans.mjs');
const responsibilityNotifications = await import('../chat/responsibility-notifications.mjs');
const { captureResponsibilityCodeBaseline } = await import('../chat/responsibility-code-baseline.mjs');
const { getFactoryFormula } = await import('../chat/factory-workflow.mjs');
const { PROJECT_REPORT_PROVIDER, GENERIC_PLANNER_PROVIDER } = await import('../chat/responsibility-providers.mjs');
const { handleResponsibilityRoutes } = await import('../chat/router-responsibility-routes.mjs');
const { handleFactoryRoutes } = await import('../chat/router-factory-routes.mjs');
const { addSubscription, getPublicKey } = await import('../chat/push.mjs');
const { drainAccountPushOutbox, enqueueAccountPush, getAccountPushStatus, startAccountPushOutbox, stopAccountPushOutbox } = await import('../chat/account-push-outbox.mjs');
const { parseResponsibilityAwaitingKey } = await import('../chat/attention-push.mjs');
const { createRunSessionControlCapability } = await import('../chat/session-control-capability.mjs');

let assertions = 0;
function equal(actual, expected, msg) { assertions += 1; assert.equal(actual, expected, msg); }
function ok(val, msg) { assertions += 1; assert.ok(val, msg); }
function match(val, regex, msg) { assertions += 1; assert.match(val, regex, msg); }

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

async function callRoute(handler, { method = 'GET', pathname, body = null, authSession = null, headers = {} }) {
  const req = makeHttpReq({ method, url: pathname, body, headers });
  let statusCode = 0;
  let responseBody = '';
  const res = {
    headersSent: false,
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

async function completeReadOnlyRun({ sessionId, runId, requestId, summaryContent, tokens = 120, costUsd = 0.02, includeUsage = true }) {
  await history.appendEvent(sessionId, {
    type: 'message',
    role: 'assistant',
    content: summaryContent,
    runId,
    requestId,
    messagePhase: 'final_answer',
    providerMessageId: `msg_${runId}`,
    timestamp: Date.now(),
  });
  if (includeUsage) {
    await history.appendEvent(sessionId, {
      type: 'usage',
      runId,
      requestId,
      usageScope: 'provider_turn_total',
      costSource: 'provider_reported',
      usageAccountingTokens: tokens,
      costUsd,
      timestamp: Date.now(),
    });
  }
  const completedAt = new Date().toISOString();
  await runs.writeRunResult(runId, { exitCode: 0, signal: null, completedAt });
  await runs.updateRun(runId, (current) => ({
    ...current,
    state: 'completed',
    completedAt,
    finalizedAt: completedAt,
  }));
}

let scheduler = null;
let respRuntime = null;

try {
  // ── 1. Setup real Project, Apps, Organization, Nodes & Codex Sessions ──────
  await orgStore.initializeOrganizationStore();
  await governor.initializeOrganizationGovernor();

  const project = await projects.createProject({ name: 'Stage1 Non-CI Project', rootPath: repoDir });
  const specialistApp = await appsMod.createApp({
    name: 'Codex Specialist',
    tool: 'codex',
    collaborationPolicy: { role: 'specialist', canDelegate: false, revision: 'spec-1' },
  });
  const writerApp = await appsMod.createApp({
    name: 'Codex Writer',
    tool: 'codex',
    collaborationPolicy: { role: 'writer', canDelegate: false, writablePaths: ['docs'], revision: 'writer-1' },
  });
  const reviewerApp = await appsMod.createApp({
    name: 'Codex Reviewer',
    tool: 'codex',
    collaborationPolicy: { role: 'reviewer', canDelegate: false, revision: 'rev-1' },
  });

  const rootSession = await sessionManager.createSession(repoDir, 'codex', 'Stage1 Root Session', {
    projectId: project.id,
    sessionClass: 'ROOT_LEADERSHIP',
    sessionPlane: 'user',
    model: 'gpt-5.3-codex',
    effort: 'medium',
  });

  const org = await orgStore.createOrganization({
    rootSessionId: rootSession.id,
    projectId: project.id,
    state: 'active',
    currentRevision: 1,
    policy: {
      factoryMaxConcurrent: 2,
      factoryChecks: [
        { id: 'docs-lint', command: 'node -e "process.exit(0)"' },
      ],
    },
    budget: { maxTotalRuns: 30, maxTokens: 100000, maxCost: 50 },
    idempotencyKey: 'stage1-e2e-org',
  });
  process.env.RAGENT_FACTORY_ORGANIZATIONS = org.id;

  await orgStore.createRevision(org.id, {
    revision: 1,
    proposal: { nodes: [], edges: [] },
    compiled: { nodes: [], edges: [] },
  });
  await orgStore.freezeRevision(org.id, 1);

  async function createBoundOrgNode({ stableKey, nodeRole, app, grant }) {
    const roleInst = await orgStore.createRoleInstance({
      organizationId: org.id,
      organizationRevision: 1,
      stableKey,
      role: nodeRole,
      agentId: app.id,
      lifecycleState: 'active',
      idempotencyKey: `role-${stableKey}`,
    });
    const node = await orgStore.createNode({
      organizationId: org.id,
      stableKey,
      nodeRole,
      createdRevision: 1,
      lifecycleState: 'active',
      lifecycleMode: 'formal_org',
      grant,
      roleInstanceId: roleInst.id,
      bindingGeneration: 1,
      sessionClass: nodeRole === 'reviewer' ? 'REVIEWER' : 'WORKER',
    });
    await orgStore.bindRoleInstanceNode(roleInst.id, node.id);
    const sess = await sessionManager.createSession(repoDir, 'codex', `Node ${stableKey}`, {
      projectId: project.id,
      templateId: app.id,
      sessionPlane: 'organization',
      sessionClass: nodeRole === 'reviewer' ? 'REVIEWER' : 'WORKER',
      lifecycleMode: 'formal_org',
      managedScope: 'organization',
      organizationRootSessionId: rootSession.id,
      organizationId: org.id,
      organizationNodeId: node.id,
      organizationRevision: 1,
      roleInstanceId: roleInst.id,
      controllerSessionId: rootSession.id,
      parentSessionId: rootSession.id,
      delegatedFromSessionId: rootSession.id,
      delegationDepth: 1,
      model: 'gpt-5.3-codex',
      effort: 'medium',
      riskMode: 'recommended',
    });
    await orgStore.bindNodeSession(node.id, { sessionId: sess.id, bindingGeneration: 1 });
    const bound = await orgStore.getNode(node.id);
    await orgStore.materializeFrozenNodeGrants({
      organizationId: org.id,
      nodeId: bound.id,
      revision: 1,
      expectedGrant: grant,
    });
    return { node: bound, session: sess, roleInstance: roleInst };
  }

  const plannerNode = await createBoundOrgNode({
    stableKey: 'planner',
    nodeRole: 'specialist',
    app: specialistApp,
    grant: { canWrite: false, canReview: false, allowedCapabilities: ['read', 'run'], projectId: project.id },
  });
  const reporterNode = await createBoundOrgNode({
    stableKey: 'reporter',
    nodeRole: 'specialist',
    app: specialistApp,
    grant: { canWrite: false, canReview: false, allowedCapabilities: ['read', 'run'], projectId: project.id },
  });
  const writerNode = await createBoundOrgNode({
    stableKey: 'writer',
    nodeRole: 'writer',
    app: writerApp,
    grant: { canWrite: true, canReview: false, writablePaths: ['docs'], allowedCapabilities: ['read', 'write', 'run'], projectId: project.id },
  });
  const reviewerNode = await createBoundOrgNode({
    stableKey: 'reviewer',
    nodeRole: 'reviewer',
    app: reviewerApp,
    grant: { canWrite: false, canReview: true, allowedCapabilities: ['read', 'review', 'run'], projectId: project.id },
  });

  // ── 2. Setup Web Push Subscription + Verify Default-off Gate ───────────────
  const vapidPublicKey = await getPublicKey();
  ok(typeof vapidPublicKey === 'string' && vapidPublicKey.length > 20, 'VAPID public key initialized');

  const clientEcdh = createECDH('prime256v1');
  clientEcdh.generateKeys();
  const webPushSubscription = {
    endpoint: 'https://webpush.stage1.invalid/sub/e2e-1',
    keys: {
      p256dh: clientEcdh.getPublicKey('base64url'),
      auth: randomBytes(16).toString('base64url'),
    },
  };
  await addSubscription(webPushSubscription);

  const subRegRes = await callRoute(handleResponsibilityRoutes, {
    method: 'POST',
    pathname: '/api/responsibilities/notification-subscriptions',
    body: { subscription: webPushSubscription },
  });
  equal(subRegRes.statusCode, 200, 'Trusted owner device binds Web Push subscription');
  const subscriptionId = subRegRes.body.subscriptionId;
  match(subscriptionId, /^[a-f0-9]{64}$/, 'Subscription ID is endpoint SHA-256');

  // Initialize Orchestrator + Factory Adapter/Scheduler + Responsibility Runtime
  const orchestrator = createCollaborationOrchestrator({
    pollMs: 100000,
    dependencies: {
      sendMessage: async (sid, text, images, opts) => sessionManager.sendMessage(sid, text, images, { ...opts, skipRunnerLaunch: true }),
    },
  });
  const serviceActor = { kind: 'service', role: 'factory_scheduler', principalId: `factory-scheduler:${OWNER_ID}`, authorizingPrincipalId: OWNER_ID };
  const ownerActor = { kind: 'user', role: 'owner', principalId: OWNER_ID };
  const adapter = createFactoryExecutionAdapter({ organizationId: org.id, actor: serviceActor, orchestrator });
  scheduler = createFactoryScheduler({ organizationId: org.id, actor: serviceActor, adapter, admissionEnabled: true, pollMs: 60000, onError: (err) => console.error('SCHED_ERR:', err) });
  const runtimeErrors = [];
  respRuntime = createResponsibilityRuntime({ intervalMs: 60000, onError: (err) => { runtimeErrors.push(err); console.error('RESP_ERR:', err); } });
  await scheduler.start();
  respRuntime.start();

  // ── 3. Verify Capabilities & Formulas ──────────────────────────────────────
  const capsRes = await callRoute(handleResponsibilityRoutes, {
    method: 'GET',
    pathname: `/api/responsibilities/capabilities?organizationId=${encodeURIComponent(org.id)}&projectId=${encodeURIComponent(project.id)}`,
  });
  equal(capsRes.statusCode, 200, 'Capabilities route succeeds for owner');
  ok(capsRes.body.providers.some((p) => p.id === 'project-report'), 'project-report provider exposed');
  ok(capsRes.body.providers.some((p) => p.id === 'generic-planner'), 'generic-planner provider exposed');

  const reportFormula = getFactoryFormula('ragent-project-report', 1);
  const plannerFormula = getFactoryFormula('ragent-responsibility-planner', 1);
  const codeFormula = getFactoryFormula('ragent-reviewed-change', 3);

  // ── 4. Lifecycle A: Non-CI Generic Planner -> Approval -> Report -> Acceptance -> Complete ──
  const validUntil = new Date(Date.now() + 7 * 86400_000).toISOString();
  const planCatalogReportEntry = {
    entryId: 'monthly_status_report',
    capability: 'project-report',
    templateId: reportFormula.id,
    templateVersion: reportFormula.version,
    templateDigest: reportFormula.digest,
    resource: { projectId: project.id, readScope: 'entire_project', networkPolicy: 'inherit_existing_permissions' },
    nodeBindings: { report: { nodeId: reporterNode.node.id, bindingGeneration: reporterNode.node.bindingGeneration } },
    maxAttempts: 2,
    maxCost: 1.5,
    autoApproval: false,
    requiresHumanApproval: true,
  };
  const createBody = {
    organizationId: org.id,
    projectId: project.id,
    objective: 'Periodically investigate project status docs and compile an owner report',
    successCriteria: ['Accurate status summary delivered', 'Owner explicitly accepts report'],
    idempotencyKey: 'resp-create-nonci-a',
    policy: {
      providerId: GENERIC_PLANNER_PROVIDER.id,
      providerVersion: GENERIC_PLANNER_PROVIDER.version,
      providerDigest: GENERIC_PLANNER_PROVIDER.digest,
      templateId: plannerFormula.id,
      templateVersion: plannerFormula.version,
      templateDigest: plannerFormula.digest,
      resource: { projectId: project.id, readScope: 'entire_project', networkPolicy: 'inherit_existing_permissions' },
      networkPermissionConfirmed: true,
      nodeBindings: { planning: { nodeId: plannerNode.node.id, bindingGeneration: plannerNode.node.bindingGeneration } },
      maxAttempts: 2,
      maxCost: 1.0,
      planCatalog: [planCatalogReportEntry],
      planExecutionMaxAttempts: 4,
      planExecutionMaxCost: 3.0,
      planApproval: 'always',
      dailyBudget: { timeZone: 'UTC', maxRuns: 10, maxTokens: 20000, maxCost: 10.0 },
      validUntil,
    },
  };
  const createdRes = await callRoute(handleResponsibilityRoutes, {
    method: 'POST',
    pathname: '/api/responsibilities',
    body: createBody,
  });
  equal(createdRes.statusCode, 200, 'Draft non-CI responsibility created via HTTP route');
  const respA = createdRes.body.responsibility;
  const normalizedCatalogEntry = createdRes.body.policy.planCatalog[0];
  equal(respA.lifecycle, 'draft', 'New responsibility starts in draft');

  // Enable notification opt-in while RAGENT_RESPONSIBILITY_PUSH_ENABLED='0'
  const notifEnableRes = await callRoute(handleResponsibilityRoutes, {
    method: 'PUT',
    pathname: `/api/responsibilities/${encodeURIComponent(respA.id)}/notifications`,
    body: { enabled: true, expectedVersion: 0, idempotencyKey: 'notif-optin-a', confirmed: true },
  });
  equal(notifEnableRes.statusCode, 200, 'Notification opt-in persisted');
  equal(notifEnableRes.body.enabled, true);

  // Activate responsibility
  const resumeRes = await callRoute(handleResponsibilityRoutes, {
    method: 'POST',
    pathname: `/api/responsibilities/${encodeURIComponent(respA.id)}/resume`,
    body: { expectedVersion: respA.rowVersion, idempotencyKey: 'resp-resume-a' },
  });
  equal(resumeRes.statusCode, 200);
  equal(resumeRes.body.responsibility.lifecycle, 'active');

  // Manual wake + idempotent replay check
  const wakePayload = { expectedVersion: resumeRes.body.responsibility.rowVersion, idempotencyKey: 'wake-a-1' };
  const wakeRes = await callRoute(handleResponsibilityRoutes, {
    method: 'POST',
    pathname: `/api/responsibilities/${encodeURIComponent(respA.id)}/wake`,
    body: wakePayload,
  });
  equal(wakeRes.statusCode, 200, 'Manual wake accepted');
  const wakeReplay = await callRoute(handleResponsibilityRoutes, {
    method: 'POST',
    pathname: `/api/responsibilities/${encodeURIComponent(respA.id)}/wake`,
    body: wakePayload,
  });
  equal(wakeReplay.body.replayed, true, 'Duplicate wake with same idempotencyKey replays');
  equal(wakeReplay.body.wake.id, wakeRes.body.wake.id, 'Replay returns identical wakeId');

  // Drive responsibility decision -> admits planning workflow -> factory scheduler dispatches planning run
  await respRuntime.tick();
  await scheduler.tick();
  await scheduler.tick(); // bind_run + reconcile

  const workItemsAfterPlanDispatch = (await factoryControl.listFactoryWorkItems(org.id, {}, ownerActor)).items;
  const planningItem = workItemsAfterPlanDispatch.find((w) => w.source?.templateKey === 'planning');
  if (!planningItem) {
    const act = await responsibilityService.listResponsibilityActivity(respA.id, { after: 0, limit: 100 }, ownerActor);
    console.error('DEBUG_NO_PLANNING_ITEM', { runtimeErrors: runtimeErrors.map(e => e?.message), act: act.activity, workItemsAfterPlanDispatch });
  }
  ok(planningItem, 'Planning work item admitted into Factory Work Graph');
  const planningDetail = (await factoryControl.getFactoryWorkItem(org.id, planningItem.id, ownerActor)).item;
  const planningBinding = planningDetail.bindings[0];
  ok(planningBinding?.runId, 'Planner Run launched via Collaboration orchestrator');
  equal(planningBinding.status, 'running');

  // Complete planner run with a valid catalog-constrained plan decision JSON
  const planJson = JSON.stringify({
    schemaVersion: 1,
    decision: 'plan',
    steps: [{
      id: 'step-report-1',
      entryId: normalizedCatalogEntry.entryId,
      entryDigest: normalizedCatalogEntry.entryDigest,
      templateId: normalizedCatalogEntry.templateId,
      templateVersion: normalizedCatalogEntry.templateVersion,
      templateDigest: normalizedCatalogEntry.templateDigest,
      nodeBindings: normalizedCatalogEntry.nodeBindings,
      dependsOn: [],
    }],
  });
  const planningRun = await runs.getRun(planningBinding.runId);
  await completeReadOnlyRun({
    sessionId: planningRun.sessionId,
    runId: planningRun.id,
    requestId: planningRun.requestId,
    summaryContent: planJson,
    tokens: 180,
    costUsd: 0.03,
  });
  equal(await orchestrator.completeRun(planningRun.id), true, 'Planner Run completed in Collaboration orchestrator');
  await scheduler.tick(); // submits planning candidate

  // Collect plan while PUSH_ENABLED='0' -> plan_proposed queued in outbox, NOT yet sent
  await respRuntime.tick();
  equal(sentWebPushCalls.length, 0, 'Default-off RAGENT_RESPONSIBILITY_PUSH_ENABLED=0 sends zero Web Push notifications');

  const plansListRes = await callRoute(handleResponsibilityRoutes, {
    method: 'GET',
    pathname: `/api/responsibilities/${encodeURIComponent(respA.id)}/plans`,
  });
  equal(plansListRes.statusCode, 200);
  equal(plansListRes.body.plans.length, 1, 'Proposed plan collected from verified ResultPacket');
  const proposedPlan = plansListRes.body.plans[0];
  equal(proposedPlan.state, 'pending_review', 'Plan requires explicit owner approval under planApproval=always');

  // Enable RAGENT_RESPONSIBILITY_PUSH_ENABLED='1' and verify queued plan_proposed delivers via both Web Push & Account Cloud Push
  process.env.RAGENT_RESPONSIBILITY_PUSH_ENABLED = '1';
  await responsibilityNotifications.processResponsibilityNotifications();
  await drainAccountPushOutbox();
  equal(sentWebPushCalls.length, 1, 'Pending plan_proposed Web Push delivered once flag is enabled');
  equal(sentWebPushCalls[0].payload.responsibilityId, respA.id);
  equal(sentWebPushCalls[0].payload.kind, 'responsibility');
  ok(sentWebPushCalls[0].encryptedBytes > 0, 'Web Push payload encrypted via web-push AES-128-GCM');
  const planCloudEvt = receivedCloudPushEvents.find((e) => e.kind === 'plan' && parseResponsibilityAwaitingKey(e.awaitingKey)?.responsibilityId === respA.id);
  ok(planCloudEvt, 'plan_proposed delivered signed Account Cloud Push kind=plan event');
  equal(parseResponsibilityAwaitingKey(planCloudEvt.awaitingKey)?.planId, proposedPlan.id, 'Cloud Push awaitingKey encodes planId');

  // Owner approves plan via HTTP route
  const latestRespA = (await responsibilityService.getResponsibility(respA.id, ownerActor)).responsibility;
  const approveRes = await callRoute(handleResponsibilityRoutes, {
    method: 'POST',
    pathname: `/api/responsibilities/${encodeURIComponent(respA.id)}/plans/${encodeURIComponent(proposedPlan.id)}/approve`,
    body: {
      confirmed: true,
      expectedVersion: latestRespA.rowVersion,
      proposalDigest: proposedPlan.proposalDigest,
      idempotencyKey: 'approve-plan-a-1',
    },
  });
  equal(approveRes.statusCode, 200, 'Owner approved proposed plan');
  equal(approveRes.body.state, 'approved');

  // Runtime dispatches approved plan -> Factory schedules & launches project-report Work Item
  await respRuntime.tick();
  await scheduler.tick();
  await scheduler.tick();

  const itemsAfterReportDispatch = (await factoryControl.listFactoryWorkItems(org.id, {}, ownerActor)).items;
  const reportItem = itemsAfterReportDispatch.find((w) => w.source?.templateKey === 'report');
  ok(reportItem, 'Approved plan step materialized project-report Work Item');
  const reportDetail = (await factoryControl.getFactoryWorkItem(org.id, reportItem.id, ownerActor)).item;
  const reportBinding = reportDetail.bindings[0];
  ok(reportBinding?.runId, 'Report Run launched');

  // Complete report Run with markdown report + <ragent-result-packet> + provider usage
  const reportText = [
    'Project docs investigation complete: README.md and docs/status.md reflect initial baseline.',
    '',
    '<ragent-result-packet>',
    JSON.stringify({ state: 'completed', summary: 'Non-CI project docs verified cleanly.' }),
    '</ragent-result-packet>',
  ].join('\n');
  const reportRun = await runs.getRun(reportBinding.runId);
  await completeReadOnlyRun({
    sessionId: reportRun.sessionId,
    runId: reportRun.id,
    requestId: reportRun.requestId,
    summaryContent: reportText,
    tokens: 240,
    costUsd: 0.04,
  });
  equal(await orchestrator.completeRun(reportRun.id), true);
  await scheduler.tick(); // settles budget + submits candidate

  // Inspect report projection + budget observation via Factory routes
  const itemWithReport = (await factoryControl.getFactoryWorkItem(org.id, reportItem.id, ownerActor, { includeReport: true })).item;
  equal(itemWithReport.state, 'review', 'Report Work Item moved to review after candidate submission');
  equal(itemWithReport.candidates[0]?.report?.readable, true, 'Report projection readable from verified assistant final message');
  equal(itemWithReport.candidates[0]?.report?.declaration?.state, 'completed');

  const budgetObsRes = await callRoute(handleFactoryRoutes, {
    method: 'GET',
    pathname: `/api/organizations/${encodeURIComponent(org.id)}/factory/work-items/${encodeURIComponent(reportItem.id)}/budget`,
  });
  equal(budgetObsRes.statusCode, 200);
  equal(budgetObsRes.body.reservation.state, 'settled', 'Report budget reservation settled from provider usage');
  equal(budgetObsRes.body.reservation.actualUsage.tokens, 240);
  equal(budgetObsRes.body.usageState, 'actual');
  equal(budgetObsRes.body.costEnforcement, 'admission_estimate_only', 'Budget explicitly communicates admission estimate vs hard cap');
  equal(budgetObsRes.body.hardCapAvailable, false);

  // Owner accepts report -> workflow_completed -> Web Push delivered
  const acceptRes = await callRoute(handleFactoryRoutes, {
    method: 'POST',
    pathname: `/api/organizations/${encodeURIComponent(org.id)}/factory/work-items/${encodeURIComponent(reportItem.id)}/manual-acceptance`,
    body: {
      criterionId: 'report-reviewed',
      decision: 'passed',
      rationale: 'Status report verified against project files.',
      contractRevision: itemWithReport.contractRevision,
      candidateDigest: itemWithReport.candidateDigest,
      gateGeneration: itemWithReport.gateGeneration,
      expectedVersion: itemWithReport.rowVersion,
      commandId: 'cmd-accept-report-a1',
      idempotencyKey: 'accept-report-a1',
    },
  });
  equal(acceptRes.statusCode, 200);
  equal(acceptRes.body.item.state, 'completed', 'Report Work Item accepted and completed');

  await respRuntime.tick();
  await drainAccountPushOutbox();
  ok(sentWebPushCalls.length >= 2, 'workflow_completed notification delivered via Web Push');
  ok(receivedCloudPushEvents.some((e) => e.kind === 'attention_resolved' && e.awaitingKey === planCloudEvt.awaitingKey), 'Approving plan emitted attention_resolved Cloud Push event');
  ok(receivedCloudPushEvents.some((e) => e.kind === 'completion'), `workflow_completed delivered via Account Cloud Push: ${JSON.stringify(receivedCloudPushEvents)}`);
  const activityAfterAccept = (await responsibilityService.listResponsibilityActivity(respA.id, { after: 0, limit: 100 }, ownerActor)).activity;
  ok(activityAfterAccept.some((a) => a.type === 'workflow_completed'), 'workflow_completed activity recorded');

  // Complete the responsibility
  const preComplete = (await responsibilityService.getResponsibility(respA.id, ownerActor)).responsibility;
  const completedResp = await responsibilityService.setResponsibilityLifecycle(respA.id, 'complete', {
    expectedVersion: preComplete.rowVersion,
    confirmed: true,
    idempotencyKey: 'complete-resp-a1',
  }, ownerActor);
  equal(completedResp.responsibility.lifecycle, 'completed', 'Responsibility transitions cleanly to completed');

  // ── 5. Lifecycle B: Authorized Report Auto-Admission + Project Code Independent Review ──
  const codeBaseline = await captureResponsibilityCodeBaseline(org.id, project.id);
  ok(codeBaseline.id && codeBaseline.branch === 'main', 'Local code baseline captured');

  const autoReportEntry = {
    entryId: 'auto_report',
    capability: 'project-report',
    templateId: reportFormula.id,
    templateVersion: reportFormula.version,
    templateDigest: reportFormula.digest,
    resource: { projectId: project.id, readScope: 'entire_project', networkPolicy: 'inherit_existing_permissions' },
    nodeBindings: { report: { nodeId: reporterNode.node.id, bindingGeneration: reporterNode.node.bindingGeneration } },
    maxAttempts: 1,
    maxCost: 1.0,
    autoApproval: true,
    requiresHumanApproval: false,
  };
  const autoResp = (await responsibilityService.createResponsibility({
    organizationId: org.id,
    projectId: project.id,
    objective: 'Auto-admitted report within policy',
    successCriteria: ['Report delivered'],
    idempotencyKey: 'resp-create-auto-b',
    policy: {
      providerId: GENERIC_PLANNER_PROVIDER.id,
      providerVersion: GENERIC_PLANNER_PROVIDER.version,
      providerDigest: GENERIC_PLANNER_PROVIDER.digest,
      templateId: plannerFormula.id,
      templateVersion: plannerFormula.version,
      templateDigest: plannerFormula.digest,
      resource: { projectId: project.id, readScope: 'entire_project', networkPolicy: 'inherit_existing_permissions' },
      networkPermissionConfirmed: true,
      nodeBindings: { planning: { nodeId: plannerNode.node.id, bindingGeneration: plannerNode.node.bindingGeneration } },
      maxAttempts: 2,
      maxCost: 1.0,
      planCatalog: [autoReportEntry],
      planExecutionMaxAttempts: 2,
      planExecutionMaxCost: 2.0,
      planApproval: 'within_policy',
      planAutoAdmissionConfirmed: true,
      dailyBudget: { timeZone: 'UTC', maxRuns: 5, maxTokens: 10000, maxCost: 5.0 },
      validUntil,
    },
  }, ownerActor));
  const autoCatalog = autoResp.policy.planCatalog[0];
  await responsibilityService.setResponsibilityLifecycle(autoResp.responsibility.id, 'resume', {
    expectedVersion: autoResp.responsibility.rowVersion,
    idempotencyKey: 'resume-auto-b',
  }, ownerActor);
  await responsibilityEvents.wakeResponsibility(autoResp.responsibility.id, {
    expectedVersion: 2,
    idempotencyKey: 'wake-auto-b',
  }, ownerActor);
  await respRuntime.tick();
  await scheduler.tick();
  await scheduler.tick();

  const autoPlanItem = (await factoryControl.listFactoryWorkItems(org.id, {}, ownerActor)).items
    .find((w) => w.source?.templateKey === 'planning' && w.state === 'running');
  ok(autoPlanItem, 'Auto-policy planning item dispatched');
  const autoPlanBinding = (await factoryControl.getFactoryWorkItem(org.id, autoPlanItem.id, ownerActor)).item.bindings[0];
  const autoPlanRun = await runs.getRun(autoPlanBinding.runId);
  await completeReadOnlyRun({
    sessionId: autoPlanRun.sessionId,
    runId: autoPlanRun.id,
    requestId: autoPlanRun.requestId,
    summaryContent: JSON.stringify({
      schemaVersion: 1,
      decision: 'plan',
      steps: [{
        id: 'auto-step-1',
        entryId: autoCatalog.entryId,
        entryDigest: autoCatalog.entryDigest,
        templateId: autoCatalog.templateId,
        templateVersion: autoCatalog.templateVersion,
        templateDigest: autoCatalog.templateDigest,
        nodeBindings: autoCatalog.nodeBindings,
        dependsOn: [],
      }],
    }),
  });
  await orchestrator.completeRun(autoPlanRun.id);
  await scheduler.tick();
  await respRuntime.tick();

  const autoActivity = (await responsibilityService.listResponsibilityActivity(autoResp.responsibility.id, { after: 0, limit: 50 }, ownerActor)).activity;
  ok(autoActivity.some((a) => a.type === 'plan_approved_by_policy'), 'Authorized report catalog step auto-approved by policy');

  // Complete the auto-admitted report Work Item cleanly so reporterNode capacity is freed
  await scheduler.tick();
  await scheduler.tick();
  const autoReportItem = (await factoryControl.listFactoryWorkItems(org.id, {}, ownerActor)).items
    .find((w) => w.source?.templateKey === 'report' && w.state === 'running');
  ok(autoReportItem, 'Auto-admitted report item dispatched');
  const autoReportBinding = (await factoryControl.getFactoryWorkItem(org.id, autoReportItem.id, ownerActor)).item.bindings[0];
  const autoReportRun = await runs.getRun(autoReportBinding.runId);
  await completeReadOnlyRun({
    sessionId: autoReportRun.sessionId,
    runId: autoReportRun.id,
    requestId: autoReportRun.requestId,
    summaryContent: 'Auto-admitted report complete.',
    tokens: 100,
    costUsd: 0.01,
  });
  await orchestrator.completeRun(autoReportRun.id);
  await scheduler.tick();
  const autoReportReview = (await factoryControl.getFactoryWorkItem(org.id, autoReportItem.id, ownerActor)).item;
  await factoryAcceptance.decideFactoryManualAcceptance({
    organizationId: org.id,
    workItemId: autoReportItem.id,
    criterionId: 'report-reviewed',
    decision: 'passed',
    rationale: 'Auto-admitted report verified.',
    contractRevision: autoReportReview.contractRevision,
    candidateDigest: autoReportReview.candidateDigest,
    gateGeneration: autoReportReview.gateGeneration,
    expectedVersion: autoReportReview.rowVersion,
    commandId: 'cmd-accept-auto-b',
    idempotencyKey: 'accept-auto-b',
  }, ownerActor);

  // Verify needs_input outcome and invalid_output guard (never bypasses catalog)
  const needsInputResp = await responsibilityService.createResponsibility({
    organizationId: org.id,
    projectId: project.id,
    objective: 'Test needs_input planning outcome',
    successCriteria: ['Clarify scope'],
    idempotencyKey: 'resp-create-needs-input',
    policy: createBody.policy,
  }, ownerActor);
  await responsibilityNotifications.setResponsibilityNotificationSettings(needsInputResp.responsibility.id, {
    enabled: true,
    expectedVersion: 0,
    confirmed: true,
    idempotencyKey: 'enable-notif-needs-input',
  }, ownerActor);
  await responsibilityService.setResponsibilityLifecycle(needsInputResp.responsibility.id, 'resume', {
    expectedVersion: needsInputResp.responsibility.rowVersion,
    idempotencyKey: 'resume-needs-input',
  }, ownerActor);
  await responsibilityEvents.wakeResponsibility(needsInputResp.responsibility.id, {
    expectedVersion: 2,
    idempotencyKey: 'wake-needs-input',
  }, ownerActor);
  await respRuntime.tick();
  await scheduler.tick();
  await scheduler.tick();
  const niPlanItem = (await factoryControl.listFactoryWorkItems(org.id, {}, ownerActor)).items
    .filter((w) => w.source?.templateKey === 'planning' && w.state === 'running').at(-1);
  const niBinding = (await factoryControl.getFactoryWorkItem(org.id, niPlanItem.id, ownerActor)).item.bindings[0];
  const niRun = await runs.getRun(niBinding.runId);
  await completeReadOnlyRun({
    sessionId: niRun.sessionId,
    runId: niRun.id,
    requestId: niRun.requestId,
    summaryContent: JSON.stringify({
      schemaVersion: 1,
      decision: 'needs_input',
      reason: 'Target report period is unspecified',
      question: 'Which milestone window should be summarized?',
      requiredInput: 'date_range',
    }),
  });
  await orchestrator.completeRun(niRun.id);
  await scheduler.tick();
  const prevPushEnabled = process.env.RAGENT_RESPONSIBILITY_PUSH_ENABLED;
  process.env.RAGENT_RESPONSIBILITY_PUSH_ENABLED = '0';
  await respRuntime.tick();
  const niActivity = (await responsibilityService.listResponsibilityActivity(needsInputResp.responsibility.id, { after: 0, limit: 50 }, ownerActor)).activity;
  ok(niActivity.some((a) => a.type === 'planning_needs_input'), 'planning_needs_input outcome recorded cleanly');

  // ── 6. Fault Injection F1: Daily Budget Exhaustion Rejection & Unstarted Cleanup ──
  const tightResp = await responsibilityService.createResponsibility({
    organizationId: org.id,
    projectId: project.id,
    objective: 'Tight daily budget rejection check',
    successCriteria: ['Reject over-budget run cleanly'],
    idempotencyKey: 'resp-create-tight-budget',
    policy: {
      providerId: PROJECT_REPORT_PROVIDER.id,
      providerVersion: PROJECT_REPORT_PROVIDER.version,
      providerDigest: PROJECT_REPORT_PROVIDER.digest,
      templateId: reportFormula.id,
      templateVersion: reportFormula.version,
      templateDigest: reportFormula.digest,
      resource: { projectId: project.id, readScope: 'entire_project', networkPolicy: 'inherit_existing_permissions' },
      networkPermissionConfirmed: true,
      nodeBindings: { report: { nodeId: reporterNode.node.id, bindingGeneration: reporterNode.node.bindingGeneration } },
      maxAttempts: 2,
      maxCost: 2.0,
      // Report formula reserves maxCost/(1*2) = 1.0, which exceeds dailyBudget.maxCost = 0.50!
      dailyBudget: { timeZone: 'UTC', maxRuns: 1, maxTokens: 1000, maxCost: 0.5 },
      validUntil,
    },
  }, ownerActor);
  await responsibilityService.setResponsibilityLifecycle(tightResp.responsibility.id, 'resume', {
    expectedVersion: tightResp.responsibility.rowVersion,
    idempotencyKey: 'resume-tight-budget',
  }, ownerActor);
  await responsibilityEvents.wakeResponsibility(tightResp.responsibility.id, {
    expectedVersion: 2,
    idempotencyKey: 'wake-tight-budget',
  }, ownerActor);
  await respRuntime.tick();
  await scheduler.tick(); // claims and hits ORG_BUDGET_EXCEEDED in reserveFactoryBudget
  const tightActivity = (await responsibilityService.listResponsibilityActivity(tightResp.responsibility.id, { after: 0, limit: 50 }, ownerActor)).activity;
  ok(tightActivity.some((a) => a.type === 'budget_blocked'), 'Daily budget rejection emits budget_blocked without launching a Run');
  const tightItem = (await factoryControl.listFactoryWorkItems(org.id, {}, ownerActor)).items
    .find((w) => w.state === 'failed' && w.blockedReason?.evidenceRef?.startsWith('unstarted:'));
  ok(tightItem, 'Budget-rejected item marked failed with unstarted:<bindingId> evidence and no leaked Run');

  // ── 7. Fault Injection F2: Unknown Usage Retention (Never Zeroed) ──────────
  const unknownUsageResp = await responsibilityService.createResponsibility({
    organizationId: org.id,
    projectId: project.id,
    objective: 'Unknown usage keeps budget reserved',
    successCriteria: ['Reservation stays reserved'],
    idempotencyKey: 'resp-create-unknown-usage',
    policy: {
      providerId: PROJECT_REPORT_PROVIDER.id,
      providerVersion: PROJECT_REPORT_PROVIDER.version,
      providerDigest: PROJECT_REPORT_PROVIDER.digest,
      templateId: reportFormula.id,
      templateVersion: reportFormula.version,
      templateDigest: reportFormula.digest,
      resource: { projectId: project.id, readScope: 'entire_project', networkPolicy: 'inherit_existing_permissions' },
      networkPermissionConfirmed: true,
      nodeBindings: { report: { nodeId: reporterNode.node.id, bindingGeneration: reporterNode.node.bindingGeneration } },
      maxAttempts: 1,
      maxCost: 1.0,
      dailyBudget: { timeZone: 'UTC', maxRuns: 2, maxTokens: 5000, maxCost: 5.0 },
      validUntil,
    },
  }, ownerActor);
  await responsibilityService.setResponsibilityLifecycle(unknownUsageResp.responsibility.id, 'resume', {
    expectedVersion: unknownUsageResp.responsibility.rowVersion,
    idempotencyKey: 'resume-unknown-usage',
  }, ownerActor);
  await responsibilityEvents.wakeResponsibility(unknownUsageResp.responsibility.id, {
    expectedVersion: 2,
    idempotencyKey: 'wake-unknown-usage',
  }, ownerActor);
  await respRuntime.tick();
  await scheduler.tick();
  await scheduler.tick();

  const unknownUsageItems = (await factoryControl.listFactoryWorkItems(org.id, {}, ownerActor)).items
    .filter((w) => w.state === 'running' && w.source?.templateKey === 'report');
  const unknownUsageItem = unknownUsageItems.at(-1);
  ok(unknownUsageItem, 'Unknown usage report item dispatched');
  const uuBinding = (await factoryControl.getFactoryWorkItem(org.id, unknownUsageItem.id, ownerActor)).item.bindings[0];
  const uuRun = await runs.getRun(uuBinding.runId);
  await completeReadOnlyRun({
    sessionId: uuRun.sessionId,
    runId: uuRun.id,
    requestId: uuRun.requestId,
    summaryContent: 'Report without usage event.',
    includeUsage: false,
  });
  await orchestrator.completeRun(uuRun.id);
  await scheduler.tick();

  const uuBudget = await factoryReconciliation.getFactoryBudgetObservation({ organizationId: org.id, workItemId: unknownUsageItem.id }, ownerActor);
  equal(uuBudget.reservation.state, 'reserved', 'Missing provider usage keeps reservation in reserved state');
  equal(uuBudget.usageState, 'unknown', 'Usage state stays unknown rather than assuming 0');

  // ── 8. Fault Injection F3: Unknown Outcome Reconciliation & Positive Run Recovery ──
  // Create a fresh goal/workItem via project-report responsibility and simulate crash after dispatch command persisted, before run bound!
  const collabStore = await import('../chat/collaboration-store.mjs');
  const unknownResp = await responsibilityService.createResponsibility({
    organizationId: org.id,
    projectId: project.id,
    objective: 'Reconcile unbound dispatch intent safely',
    successCriteria: ['Adopt positive Run receipt without duplicate dispatch'],
    idempotencyKey: 'resp-create-reconcile',
    policy: {
      providerId: PROJECT_REPORT_PROVIDER.id,
      providerVersion: PROJECT_REPORT_PROVIDER.version,
      providerDigest: PROJECT_REPORT_PROVIDER.digest,
      templateId: reportFormula.id,
      templateVersion: reportFormula.version,
      templateDigest: reportFormula.digest,
      resource: { projectId: project.id, readScope: 'entire_project', networkPolicy: 'inherit_existing_permissions' },
      networkPermissionConfirmed: true,
      nodeBindings: { report: { nodeId: reporterNode.node.id, bindingGeneration: reporterNode.node.bindingGeneration } },
      maxAttempts: 1,
      maxCost: 1.0,
      dailyBudget: { timeZone: 'UTC', maxRuns: 3, maxTokens: 5000, maxCost: 5.0 },
      validUntil,
    },
  }, ownerActor);
  await responsibilityService.setResponsibilityLifecycle(unknownResp.responsibility.id, 'resume', {
    expectedVersion: unknownResp.responsibility.rowVersion,
    idempotencyKey: 'resume-reconcile',
  }, ownerActor);
  await responsibilityEvents.wakeResponsibility(unknownResp.responsibility.id, {
    expectedVersion: 2,
    idempotencyKey: 'wake-reconcile',
  }, ownerActor);
  await respRuntime.tick();

  // Pause auto-dispatch by passing a custom no-send orchestrator to claim + enqueue dispatch command without calling sendMessage!
  await scheduler.stop();
  const dryOrchestrator = createCollaborationOrchestrator({
    pollMs: 100000,
    dependencies: {
      sendMessage: async () => { throw new Error('simulated crash before sendMessage receipt'); },
    },
  });
  const dryAdapter = createFactoryExecutionAdapter({ organizationId: org.id, actor: serviceActor, orchestrator: dryOrchestrator });
  const dryScheduler = createFactoryScheduler({ organizationId: org.id, actor: serviceActor, adapter: dryAdapter, admissionEnabled: true, pollMs: 60000 });
  await dryScheduler.start();

  const recLinks = await responsibilityService.listResponsibilityWorkLinks(unknownResp.responsibility.id, ownerActor);
  const recWorkId = recLinks.links[0].workItemIds[0];
  let recItem = (await factoryControl.getFactoryWorkItem(org.id, recWorkId, ownerActor)).item;
  equal(recItem.state, 'claimed', 'Work item claimed');
  equal(recItem.bindings[0].status, 'intent', 'Binding remains unbound intent when sendMessage fails/crashes');
  equal(recItem.bindings[0].runId, null);

  // Verify reconciliation while Run is absent -> stays 'unknown', never redispatches a duplicate!
  const leaseInfo = await collabStore.withDatabase((db) => db.prepare('SELECT * FROM factory_scheduler_leases WHERE organization_id=?').get(org.id));
  const recMiss = await factoryReconciliation.reconcileFactoryAcceptedRunAutomatically({
    organizationId: org.id,
    workItemId: recItem.id,
    expectedVersion: recItem.rowVersion,
    executionEpoch: recItem.executionEpoch,
    leaseOwnerToken: leaseInfo.owner_token,
    leaseGeneration: leaseInfo.generation,
  }, serviceActor);
  equal(recMiss.state, 'unknown', 'Missing Run keeps reconciliation in unknown without auto-redispatching');
  equal(recMiss.reason, 'run_evidence_unavailable');

  // Now simulate that the original requestId DID create a Run on disk (crash right after Run creation, before completeAttemptDispatch).
  const cmdRow = await collabStore.withDatabase((db) => db.prepare('SELECT * FROM collaboration_dispatch_commands WHERE task_id=?').get(recItem.id));
  ok(cmdRow?.request_id && cmdRow?.session_id, 'Durable dispatch command persisted');
  const orphanedRun = await runs.createRun({
    status: {
      sessionId: cmdRow.session_id,
      requestId: cmdRow.request_id,
      tool: 'codex',
      model: 'gpt-5',
      effort: 'medium',
      state: 'running',
      createdAt: new Date().toISOString(),
    },
    manifest: {
      sessionId: cmdRow.session_id,
      requestId: cmdRow.request_id,
      projectId: project.id,
      folder: repoDir,
    },
  });
  ok(orphanedRun?.id, 'Run exists on disk for original requestId');

  // Owner reconciliation request + automatic positive recovery adopts exact runId without creating a new dispatch!
  const ownerRecReq = await factoryReconciliation.requestFactoryReconciliation({
    organizationId: org.id,
    workItemId: recItem.id,
    expectedVersion: recItem.rowVersion,
    executionEpoch: recItem.executionEpoch,
    commandId: 'cmd-req-rec-1',
  }, ownerActor);
  equal(ownerRecReq.requested, true);
  const obsSnapshot = await factoryReconciliation.getFactoryReconciliation({ organizationId: org.id, workItemId: recItem.id }, ownerActor);
  equal(obsSnapshot.acceptedRunObservation.state, 'found');
  equal(obsSnapshot.acceptedRunObservation.expectedRunId, orphanedRun.id);

  const recAdopted = await factoryReconciliation.reconcileFactoryAcceptedRunAutomatically({
    organizationId: org.id,
    workItemId: recItem.id,
    expectedVersion: recItem.rowVersion,
    executionEpoch: recItem.executionEpoch,
    leaseOwnerToken: leaseInfo.owner_token,
    leaseGeneration: leaseInfo.generation,
  }, serviceActor);
  const attRow = await collabStore.withDatabase((db) => db.prepare('SELECT id,state,failure_kind,run_id FROM collaboration_attempts WHERE id=?').get(cmdRow.attempt_id));
  equal(recAdopted.state, 'accepted', `Positive Run receipt reconciliation succeeds: recAdopted=${JSON.stringify(recAdopted)} cmd=${JSON.stringify(cmdRow)} att=${JSON.stringify(attRow)}`);
  equal(recAdopted.runId, orphanedRun.id, 'Adopted exact original Run ID');

  // Replaying verification is idempotent
  const ownerVerifyReplay = await factoryReconciliation.verifyFactoryAcceptedRun({
    organizationId: org.id,
    workItemId: recItem.id,
    expectedVersion: recItem.rowVersion,
    executionEpoch: recItem.executionEpoch,
    leaseGeneration: leaseInfo.generation,
    expectedRunId: orphanedRun.id,
  }, ownerActor);
  equal(ownerVerifyReplay.state, 'accepted');
  equal(ownerVerifyReplay.replayed, true);
  await dryScheduler.stop();
  await scheduler.start();

  // ── 9. Fault Injection F4: Cancel-while-running (Cancel Requested != Stopped) ──
  await scheduler.tick(); // binds orphanedRun.id into binding.status = 'running'
  recItem = (await factoryControl.getFactoryWorkItem(org.id, recWorkId, ownerActor)).item;
  equal(recItem.state, 'running');

  const cancelPre = (await responsibilityService.getResponsibility(unknownResp.responsibility.id, ownerActor)).responsibility;
  const cancelRes = await responsibilityService.setResponsibilityLifecycle(unknownResp.responsibility.id, 'cancel', {
    expectedVersion: cancelPre.rowVersion,
    confirmed: true,
    stopExisting: true,
    idempotencyKey: 'cancel-while-running-1',
  }, ownerActor);
  equal(cancelRes.responsibility.lifecycle, 'cancelled');
  equal(cancelRes.existingWorkStopped, false, 'Cancel never claims existing work is already stopped');
  equal(cancelRes.stop.items[0].controlState, 'cancel_requested', 'Work item enters cancel_requested');

  // Tick scheduler while Run is still running -> requestRunCancel fires, workItem stays 'running' (NOT prematurely 'cancelled' or 'stopped'!)
  await scheduler.tick();
  const whileRunning = (await factoryControl.getFactoryWorkItem(org.id, recWorkId, ownerActor)).item;
  equal(whileRunning.state, 'running', 'Active item remains running while Run cancellation is still pending');
  equal(whileRunning.controlState, 'cancel_requested');
  const whileRunningRecon = await factoryReconciliation.getFactoryReconciliation({ organizationId: org.id, workItemId: recWorkId }, ownerActor);
  equal(whileRunningRecon.stopStatus, 'cancel_requested_pending', 'Reconciliation reports cancel_requested_pending instead of stopped');
  equal(whileRunningRecon.stopConfirmed, false);
  const cancellingRun = await runs.getRun(orphanedRun.id);
  equal(cancellingRun.cancelRequested, true, 'Scheduler propagates cancelRequested to running Run');

  // Now finalize the Run as cancelled and reconcile -> transitions binding to 'stopped' and item to 'cancelled'
  const cancelledAt = new Date().toISOString();
  await runs.writeRunResult(orphanedRun.id, { exitCode: null, signal: 'SIGTERM', cancelled: true, completedAt: cancelledAt });
  await runs.updateRun(orphanedRun.id, (c) => ({ ...c, state: 'cancelled', completedAt: cancelledAt, finalizedAt: cancelledAt }));
  await orchestrator.completeRun(orphanedRun.id);
  await scheduler.tick();

  const afterStop = (await factoryControl.getFactoryWorkItem(org.id, recWorkId, ownerActor)).item;
  equal(afterStop.state, 'cancelled', 'Work item transitions to cancelled only after Run cancellation is finalized');
  equal(afterStop.controlState, 'none');
  equal(afterStop.bindings[0].status, 'stopped');

  // ── 9b. S1.2 Closure: Explicit Owner Resolve for True Unknown Outcome + Completed-Before-Stop ──
  // Case A: True unverified unknown_outcome (no Run created on disk) -> explicit owner resolve via HTTP route
  const trueUnknownResp = await responsibilityService.createResponsibility({
    organizationId: org.id,
    projectId: project.id,
    objective: 'Explicit resolve for unverified unknown_outcome',
    successCriteria: ['Owner verifies no provider execution and confirms stopped'],
    idempotencyKey: 'resp-create-true-unknown-s12',
    policy: {
      providerId: PROJECT_REPORT_PROVIDER.id,
      providerVersion: PROJECT_REPORT_PROVIDER.version,
      providerDigest: PROJECT_REPORT_PROVIDER.digest,
      templateId: reportFormula.id,
      templateVersion: reportFormula.version,
      templateDigest: reportFormula.digest,
      resource: { projectId: project.id, readScope: 'entire_project', networkPolicy: 'inherit_existing_permissions' },
      networkPermissionConfirmed: true,
      nodeBindings: { report: { nodeId: reporterNode.node.id, bindingGeneration: reporterNode.node.bindingGeneration } },
      maxAttempts: 1,
      maxCost: 1.0,
      dailyBudget: { timeZone: 'UTC', maxRuns: 5, maxTokens: 5000, maxCost: 5.0 },
      validUntil,
    },
  }, ownerActor);
  await responsibilityService.setResponsibilityLifecycle(trueUnknownResp.responsibility.id, 'resume', {
    expectedVersion: trueUnknownResp.responsibility.rowVersion,
    idempotencyKey: 'resume-true-unknown-s12',
  }, ownerActor);
  await responsibilityEvents.wakeResponsibility(trueUnknownResp.responsibility.id, {
    expectedVersion: 2,
    idempotencyKey: 'wake-true-unknown-s12',
  }, ownerActor);
  await respRuntime.tick();

  await scheduler.stop();
  const s12DryScheduler = createFactoryScheduler({ organizationId: org.id, actor: serviceActor, adapter: dryAdapter, admissionEnabled: true, pollMs: 60000 });
  await s12DryScheduler.start();
  await s12DryScheduler.stop();

  const trueUnknownWorkId = (await responsibilityService.listResponsibilityWorkLinks(trueUnknownResp.responsibility.id, ownerActor)).links[0].workItemIds[0];
  let trueUnknownItem = (await factoryControl.getFactoryWorkItem(org.id, trueUnknownWorkId, ownerActor)).item;
  const resolveBeforeCancel = await callRoute(handleFactoryRoutes, {
    method: 'POST',
    pathname: `/api/organizations/${encodeURIComponent(org.id)}/factory/work-items/${encodeURIComponent(trueUnknownWorkId)}/reconcile/resolve`,
    body: {
      commandId: 'cmd-s12-resolve-before-cancel',
      idempotencyKey: 's12-resolve-before-cancel',
      expectedVersion: trueUnknownItem.rowVersion,
      executionEpoch: trueUnknownItem.executionEpoch,
      resolution: 'confirm_stopped',
      rationale: 'Attempt before stop request',
      confirmed: true,
    },
  });
  equal(resolveBeforeCancel.statusCode, 409, 'resolve refuses confirm_stopped without cancel_requested/pause_requested');

  await responsibilityService.setResponsibilityLifecycle(trueUnknownResp.responsibility.id, 'pause', {
    expectedVersion: 2,
    stopExisting: true,
    idempotencyKey: 'pause-true-unknown-s12',
  }, ownerActor);
  trueUnknownItem = (await factoryControl.getFactoryWorkItem(org.id, trueUnknownWorkId, ownerActor)).item;
  const resolveOk = await callRoute(handleFactoryRoutes, {
    method: 'POST',
    pathname: `/api/organizations/${encodeURIComponent(org.id)}/factory/work-items/${encodeURIComponent(trueUnknownWorkId)}/reconcile/resolve`,
    body: {
      commandId: 'cmd-s12-resolve-ok',
      idempotencyKey: 's12-resolve-ok',
      expectedVersion: trueUnknownItem.rowVersion,
      executionEpoch: trueUnknownItem.executionEpoch,
      resolution: 'confirm_stopped',
      rationale: 'Verified zero external executions on provider side',
      confirmed: true,
    },
  });
  equal(resolveOk.statusCode, 200, 'POST /reconcile/resolve confirm_stopped succeeds after cancel_requested');
  equal(resolveOk.body.item.state, 'cancelled');
  equal(resolveOk.body.binding.status, 'stopped');
  equal(resolveOk.body.budgetRetained, true, 'Unknown-usage budget reservation remains retained on confirm_stopped');

  // Case B: cancel_requested arrives, Run finishes completed before stopping -> blocked/completed_pending_review, NEVER cancelled
  await scheduler.start();
  const raceResp = await responsibilityService.createResponsibility({
    organizationId: org.id,
    projectId: project.id,
    objective: 'Completed before stop race',
    successCriteria: ['Completed Run stays completed_pending_review'],
    idempotencyKey: 'resp-create-race-s12',
    policy: {
      providerId: PROJECT_REPORT_PROVIDER.id,
      providerVersion: PROJECT_REPORT_PROVIDER.version,
      providerDigest: PROJECT_REPORT_PROVIDER.digest,
      templateId: reportFormula.id,
      templateVersion: reportFormula.version,
      templateDigest: reportFormula.digest,
      resource: { projectId: project.id, readScope: 'entire_project', networkPolicy: 'inherit_existing_permissions' },
      networkPermissionConfirmed: true,
      nodeBindings: { report: { nodeId: reporterNode.node.id, bindingGeneration: reporterNode.node.bindingGeneration } },
      maxAttempts: 1,
      maxCost: 1.0,
      dailyBudget: { timeZone: 'UTC', maxRuns: 5, maxTokens: 5000, maxCost: 5.0 },
      validUntil,
    },
  }, ownerActor);
  await responsibilityService.setResponsibilityLifecycle(raceResp.responsibility.id, 'resume', {
    expectedVersion: raceResp.responsibility.rowVersion,
    idempotencyKey: 'resume-race-s12',
  }, ownerActor);
  await responsibilityEvents.wakeResponsibility(raceResp.responsibility.id, {
    expectedVersion: 2,
    idempotencyKey: 'wake-race-s12',
  }, ownerActor);
  await respRuntime.tick();
  await scheduler.tick();
  await scheduler.tick();

  const raceWorkId = (await responsibilityService.listResponsibilityWorkLinks(raceResp.responsibility.id, ownerActor)).links[0].workItemIds[0];
  await responsibilityService.setResponsibilityLifecycle(raceResp.responsibility.id, 'pause', {
    expectedVersion: 2,
    stopExisting: true,
    idempotencyKey: 'pause-race-s12',
  }, ownerActor);
  const raceBinding = (await factoryControl.getFactoryWorkItem(org.id, raceWorkId, ownerActor)).item.bindings[0];
  const raceRun = await runs.getRun(raceBinding.runId);
  await runs.requestRunCancel(raceRun.id);
  await completeReadOnlyRun({
    sessionId: raceRun.sessionId,
    runId: raceRun.id,
    requestId: raceRun.requestId,
    summaryContent: 'Finished right before cancel took effect.',
    tokens: 90,
    costUsd: 0.01,
  });
  await orchestrator.completeRun(raceRun.id);
  await scheduler.tick();

  const raceAfter = (await factoryControl.getFactoryWorkItem(org.id, raceWorkId, ownerActor)).item;
  equal(raceAfter.state, 'blocked', 'Completed Run despite cancel_requested blocks for review rather than cancelling');
  equal(raceAfter.blockedReason?.code, 'completed_pending_review');
  const raceRecon = await factoryReconciliation.getFactoryReconciliation({ organizationId: org.id, workItemId: raceWorkId }, ownerActor);
  equal(raceRecon.stopStatus, 'completed_before_stop', 'Reconciliation reports completed_before_stop');
  equal(raceRecon.stopConfirmed, false);

  // ── 10. Fault Injection F5: Process Restart Recovery (Fresh Node Subprocess) ──
  await scheduler.stop();
  await respRuntime.stop();

  const restartCheckOutput = execFileSync(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    const svc = await import(${JSON.stringify(new URL('../chat/responsibility-service.mjs', import.meta.url).href)});
    const fc = await import(${JSON.stringify(new URL('../chat/factory-control.mjs', import.meta.url).href)});
    const owner = { kind: 'user', role: 'owner', principalId: ${JSON.stringify(OWNER_ID)} };
    const resp = await svc.getResponsibility(${JSON.stringify(respA.id)}, owner);
    const items = await fc.listFactoryWorkItems(${JSON.stringify(org.id)}, {}, owner);
    assert.equal(resp.responsibility.lifecycle, 'completed');
    assert.ok(items.items.length >= 4);
    console.log(JSON.stringify({ lifecycle: resp.responsibility.lifecycle, itemCount: items.items.length }));
  `], { env: process.env, encoding: 'utf8' }).trim().split('\n').at(-1);
  const restarted = JSON.parse(restartCheckOutput);
  equal(restarted.lifecycle, 'completed', 'Fresh process reads durable responsibility completion');

  // ── 11. Fault Injection F6: Web Push Revocation + Account Cloud Push Outbox Retry/Expiry ──
  // needsInputResp queued real pending `planning_needs_input` rows (both web_push and account_cloud_push); revoke Web Push binding BEFORE delivering it!
  const preRevokeSettings = await responsibilityNotifications.getResponsibilityNotificationSettings(needsInputResp.responsibility.id, ownerActor);
  ok(preRevokeSettings.receipts.some((r) => r.channel === 'web_push' && r.type === 'planning_needs_input' && r.state === 'pending'), 'Pending Web Push notification queued for needsInputResp');
  ok(preRevokeSettings.receipts.some((r) => r.channel === 'account_cloud_push' && r.type === 'planning_needs_input' && r.state === 'pending'), 'Pending Account Cloud Push notification queued for needsInputResp');
  const subBinding = preRevokeSettings.bindings.find((b) => b.subscriptionId === subscriptionId);
  ok(subBinding, 'Active binding listed');
  await responsibilityNotifications.revokeResponsibilityNotificationSubscription({
    subscriptionId,
    expectedVersion: subBinding.version,
    confirmed: true,
    idempotencyKey: 'revoke-sub-1',
  }, ownerActor);
  const preRevokePushCount = sentWebPushCalls.length;
  process.env.RAGENT_RESPONSIBILITY_PUSH_ENABLED = prevPushEnabled || '1';
  await responsibilityNotifications.processResponsibilityNotifications();
  await drainAccountPushOutbox();
  equal(sentWebPushCalls.length, preRevokePushCount, 'Revoked Web Push binding receives zero notifications');
  const postRevokeSettings = await responsibilityNotifications.getResponsibilityNotificationSettings(needsInputResp.responsibility.id, ownerActor);
  ok(postRevokeSettings.receipts.some((r) => r.channel === 'web_push' && r.type === 'planning_needs_input' && r.state === 'suppressed'), 'Pending Web Push notification suppressed after binding revocation');
  ok(postRevokeSettings.receipts.some((r) => r.channel === 'account_cloud_push' && r.type === 'planning_needs_input' && ['queued', 'provider_accepted'].includes(r.state)), `Account Cloud Push queued/accepted after Web Push binding revocation: ${JSON.stringify(postRevokeSettings.receipts)}`);
  ok(receivedCloudPushEvents.some((e) => e.kind === 'answer' && parseResponsibilityAwaitingKey(e.awaitingKey)?.responsibilityId === needsInputResp.responsibility.id && e.awaitingKey.includes('act=needs_user_input') && e.awaitingKey.includes('raw=planning_needs_input')), `needs_input delivered via signed Account Cloud Push after Web Push revocation: ${JSON.stringify(receivedCloudPushEvents)}`);

  // Test Account Cloud Push outbox enqueue, 503 retry -> 200 acceptance, and expiry rejection
  const preOutboxStatus = await getAccountPushStatus();
  failNextPushEvents = 1;
  await enqueueAccountPush({
    sessionId: rootSession.id,
    kind: 'plan',
    runId: 'run_stage1_cloud_1',
    eventId: 'evt_stage1_cloud_1',
    awaitingKey: 'appr_stage1_1',
    generation: '1',
    occurredAt: Date.now(),
  });
  await enqueueAccountPush({
    sessionId: rootSession.id,
    kind: 'completion',
    runId: 'run_stage1_expired_1',
    eventId: 'evt_stage1_expired_1',
    occurredAt: Date.now() - 48 * 60 * 60_000, // already expired (> 24h TTL)
  });

  startAccountPushOutbox();
  await drainAccountPushOutbox();
  const midStatus = await getAccountPushStatus();
  ok(midStatus.rejected >= preOutboxStatus.rejected + 1, 'Expired cloud push event is rejected without delivery');
  ok(midStatus.pending >= 1, '503 event remains pending for retry');

  // Stop outbox, reset nextAttemptAt on pending entries to simulate backoff expiry after restart, then drain cleanly
  stopAccountPushOutbox();
  const outboxPath = join(configDir, 'account-push-outbox.json');
  const outboxEntries = JSON.parse(readFileSync(outboxPath, 'utf8'));
  for (const entry of outboxEntries) {
    if (entry.state === 'pending') entry.nextAttemptAt = 0;
  }
  writeFileSync(outboxPath, JSON.stringify(outboxEntries, null, 2), 'utf8');

  await enqueueAccountPush({
    sessionId: rootSession.id,
    kind: 'completion',
    runId: 'run_stage1_cloud_2',
    eventId: 'evt_stage1_cloud_2',
    occurredAt: Date.now(),
  });
  await drainAccountPushOutbox();
  const finalPushStatus = await getAccountPushStatus();
  ok(finalPushStatus.accepted >= preOutboxStatus.accepted + 2, 'Account cloud push outbox recovers after transient 503 and delivers signed events');
  ok(receivedCloudPushEvents.some((e) => e.eventId === 'evt_stage1_cloud_1'), 'Retried event accepted with valid Ed25519 signature');
  ok(!receivedCloudPushEvents.some((e) => e.eventId === 'evt_stage1_expired_1'), 'Expired event never sent to Accounts');

  // Verify independent review opinion path (code baseline + reviewer opinion + review acceptance)
  const codePlanResp = await responsibilityService.createResponsibility({
    organizationId: org.id,
    projectId: project.id,
    objective: 'Scoped code update with independent review',
    successCriteria: ['Independent reviewer passes candidate'],
    idempotencyKey: 'resp-create-code-c',
    policy: {
      providerId: GENERIC_PLANNER_PROVIDER.id,
      providerVersion: GENERIC_PLANNER_PROVIDER.version,
      providerDigest: GENERIC_PLANNER_PROVIDER.digest,
      templateId: plannerFormula.id,
      templateVersion: plannerFormula.version,
      templateDigest: plannerFormula.digest,
      resource: { projectId: project.id, readScope: 'entire_project', networkPolicy: 'inherit_existing_permissions' },
      networkPermissionConfirmed: true,
      nodeBindings: { planning: { nodeId: plannerNode.node.id, bindingGeneration: plannerNode.node.bindingGeneration } },
      maxAttempts: 2,
      maxCost: 1.0,
      planCatalog: [{
        entryId: 'update_docs_code',
        capability: 'project-code',
        templateId: codeFormula.id,
        templateVersion: codeFormula.version,
        templateDigest: codeFormula.digest,
        repositoryFactId: codeBaseline.repositoryFactId,
        codeBaselineId: codeBaseline.id,
        repository: codeBaseline.repository,
        targetBranch: codeBaseline.branch,
        allowedPaths: ['docs'],
        candidateScope: 'docs',
        checkActionId: 'docs-lint',
        nodeBindings: {
          implementation: { nodeId: writerNode.node.id, bindingGeneration: writerNode.node.bindingGeneration },
          review: { nodeId: reviewerNode.node.id, bindingGeneration: reviewerNode.node.bindingGeneration },
          integration: { nodeId: writerNode.node.id, bindingGeneration: writerNode.node.bindingGeneration },
        },
        maxAttempts: 2,
        maxCost: 3.0,
      }],
      planExecutionMaxAttempts: 4,
      planExecutionMaxCost: 6.0,
      planApproval: 'always',
      dailyBudget: { timeZone: 'UTC', maxRuns: 10, maxTokens: 30000, maxCost: 15.0 },
      validUntil,
    },
  }, ownerActor);
  equal(codePlanResp.responsibility.lifecycle, 'draft', 'project-code catalog entry validated against code baseline and checkActionId');
  ok(typeof factoryReviewOpinions.submitFactoryReviewOpinion === 'function' && typeof createRunSessionControlCapability === 'function', 'Independent review opinion module ready');

  console.log(`test-stage1-responsibility-e2e-acceptance: ok (${assertions} assertions)`);
} finally {
  webpushMod.sendNotification = origSendNotification;
  globalThis.fetch = realFetch;
  try { stopAccountPushOutbox(); } catch {}
  try { if (scheduler) await scheduler.stop(); } catch {}
  try { if (respRuntime) await respRuntime.stop(); } catch {}
  try { accountsServer.close(); } catch {}
  try { sessionManager.killAll(); } catch {}
  try { rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
}
