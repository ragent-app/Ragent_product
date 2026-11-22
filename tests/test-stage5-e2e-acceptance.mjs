#!/usr/bin/env node
// Stage 5 End-to-End Acceptance Suite for Ragent Full 2.0 (S5.1 + S5.2 Backend Contract):
// Exercises real SQLite stores, real Responsibility & Factory runtimes, real HTTP
// routes, Butler 4-bucket overview (inProgress, awaitingDecision, deliveredArtifacts,
// blockedAndAlerts including unknown_outcome), multi-turn Voice Butler sessions,
// failure diagnostics follow-up, barge-in TTS generation cancellation, Android -> Desktop
// cross-device handoff, subprocess restart durability, owner/principal isolation, and
// strict voice safety gates (ASR failure / low-confidence zero writes; high-risk
// requires_visual_approval -> explicit owner confirmation).
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

const testTmpRoot = process.env.RAGENT_TEST_TMPDIR || process.env.TEMP || process.env.TMP || tmpdir();
mkdirSync(testTmpRoot, { recursive: true });
const tempRoot = mkdtempSync(join(testTmpRoot, 'ragent-stage5-e2e-'));
const instanceRoot = join(tempRoot, 'instance');
const configDir = join(instanceRoot, 'config');
const dataDir = join(instanceRoot, 'data');
const workRootDir = join(instanceRoot, 'workspace');
const memoryDir = join(instanceRoot, 'memory');
const harnessRoot = join(tempRoot, 'harnesses');
const harnessBin = join(harnessRoot, 'codex', 'node_modules', '.bin');
const repoDir = join(tempRoot, 'repo');

const OWNER_ID = 'owner-stage5-e2e';
const ACCOUNT_ID = 'acct_stage5_e2e';
const DEVICE_ID = 'rdev_android_stage5_e2e';
const DESKTOP_DEVICE_ID = 'rdev_desktop_stage5_e2e';

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
process.env.RAGENT_AUTH_SESSION_SECRET = 'stage5-acceptance-auth-secret-1234567890';
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

for (const dir of [
  configDir,
  dataDir,
  workRootDir,
  memoryDir,
  join(tempRoot, 'localappdata'),
  join(tempRoot, 'appdata'),
  harnessBin,
  join(repoDir, 'docs'),
]) {
  mkdirSync(dir, { recursive: true });
}

writeFileSync(join(harnessBin, 'codex'), '#!/bin/sh\necho "0.114.0"\n', 'utf8');
try { chmodSync(join(harnessBin, 'codex'), 0o755); } catch {}
if (process.platform === 'win32') {
  writeFileSync(join(harnessBin, 'codex.cmd'), '@echo off\r\necho 0.114.0\r\n', 'utf8');
}
process.env.PATH = `${harnessBin}${delimiter}${process.env.PATH || ''}`;

execFileSync('git', ['init', '-b', 'main', repoDir], { stdio: 'ignore' });
execFileSync('git', ['-C', repoDir, 'config', 'user.email', 'stage5-e2e@example.com'], { stdio: 'ignore' });
execFileSync('git', ['-C', repoDir, 'config', 'user.name', 'Stage5 E2E'], { stdio: 'ignore' });
execFileSync('git', ['-C', repoDir, 'remote', 'add', 'origin', 'https://github.com/ragent-app/Ragent_product.git'], { stdio: 'ignore' });
writeFileSync(join(repoDir, 'README.md'), '# Stage 5 E2E Repo\n', 'utf8');
writeFileSync(join(repoDir, 'docs', 'status.md'), 'Status: baseline\n', 'utf8');
execFileSync('git', ['-C', repoDir, 'add', '.'], { stdio: 'ignore' });
execFileSync('git', ['-C', repoDir, 'commit', '-m', 'stage5 baseline'], { stdio: 'ignore' });

const deviceKeyPair = generateKeyPairSync('ed25519');
const deviceToken = `rdt_${'f'.repeat(64)}`;
const bindingAuthorityRev = '1';
writeFileSync(join(configDir, 'auth.json'), JSON.stringify({ username: 'owner', passwordHash: 'unused-fixture' }), 'utf8');
writeFileSync(join(configDir, 'owner-account-binding.json'), JSON.stringify({
  accountId: ACCOUNT_ID,
  provider: 'google',
  bindingAuthorityRevision: bindingAuthorityRev,
  boundAt: new Date().toISOString(),
}), 'utf8');

const identityMod = await import('../lib/instance-identity.mjs');
const identity = await identityMod.loadOrCreateInstanceIdentity();
writeFileSync(join(configDir, 'owner-account-authority.json'), JSON.stringify({
  version: 1,
  instanceId: identity.instanceId,
  keyFingerprint: identity.keyFingerprint,
  revision: bindingAuthorityRev,
  deniedAccounts: [],
}), 'utf8');
writeFileSync(join(configDir, 'trusted-devices.json'), JSON.stringify({
  version: 1,
  instanceId: 'rli_stage5_e2e',
  instanceSecret: 'ris_stage5_e2e',
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

const authMod = await import('../lib/auth.mjs');
authMod.resetInstanceAuthCache?.();
const ownerToken = await authMod.issueSession({ role: 'owner', username: 'owner' });
const ownerCookieHeader = authMod.setCookie(ownerToken).split(';')[0];
const ownerAuthSession = authMod.getAuthSession({ headers: { cookie: ownerCookieHeader }, socket: { encrypted: false } }) || { role: 'owner' };

const projects = await import('../chat/projects.mjs');
const appsMod = await import('../chat/apps.mjs');
const sessionManager = await import('../chat/session-manager.mjs');
const history = await import('../chat/history.mjs');
const runs = await import('../chat/runs.mjs');
const orgStore = await import('../chat/organization-store.mjs');
const governor = await import('../chat/organization-governor.mjs');
const resultPackets = await import('../chat/result-packets.mjs');
const collabStore = await import('../chat/collaboration-store.mjs');
const { createCollaborationOrchestrator } = await import('../chat/collaboration-orchestrator.mjs');
const { createFactoryExecutionAdapter } = await import('../chat/factory-execution-adapter.mjs');
const { createFactoryScheduler } = await import('../chat/factory-scheduler.mjs');
const factoryControl = await import('../chat/factory-control.mjs');
const factoryAcceptance = await import('../chat/factory-acceptance.mjs');
const factoryReconciliation = await import('../chat/factory-reconciliation.mjs');
const { getFactoryFormula } = await import('../chat/factory-workflow.mjs');
const { PROJECT_REPORT_PROVIDER, GENERIC_PLANNER_PROVIDER } = await import('../chat/responsibility-providers.mjs');
const { createResponsibilityRuntime } = await import('../chat/responsibility-runtime.mjs');
const responsibilityService = await import('../chat/responsibility-service.mjs');
const responsibilityEvents = await import('../chat/responsibility-events.mjs');
const responsibilityPlans = await import('../chat/responsibility-plans.mjs');
const { handleResponsibilityRoutes } = await import('../chat/router-responsibility-routes.mjs');

let assertions = 0;
function equal(actual, expected, msg) { assertions += 1; assert.equal(actual, expected, msg); }
function ok(val, msg) { assertions += 1; assert.ok(val, msg); }
function match(val, re, msg) { assertions += 1; assert.match(val, re, msg); }

function makeHttpReq({ method = 'GET', url, body = null, headers = {}, cookie = ownerCookieHeader }) {
  const raw = body !== null ? JSON.stringify(body) : '';
  const stream = Readable.from(raw ? [Buffer.from(raw, 'utf8')] : []);
  stream.method = method;
  stream.url = url;
  stream.headers = {
    host: '127.0.0.1:7690',
    ...(cookie ? { cookie } : {}),
    ...(raw ? { 'content-type': 'application/json' } : {}),
    ...headers,
  };
  stream.socket = { encrypted: false, remoteAddress: '127.0.0.1' };
  return stream;
}

async function callRoute({ method = 'GET', pathname, body = null, authSession = ownerAuthSession, headers = {}, cookie = ownerCookieHeader }) {
  const req = makeHttpReq({ method, url: pathname, body, headers, cookie });
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
  const handled = await handleResponsibilityRoutes({
    req,
    res,
    pathname: pathname.split('?')[0],
    authSession,
    writeJson,
    requireSessionAccess: async () => true,
  });
  return { handled, statusCode, body: responseBody ? JSON.parse(responseBody) : null };
}

async function completeReadOnlyRun({ sessionId, runId, requestId, summaryContent, tokens = 120, costUsd = 0.02 }) {
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
  const completedAt = new Date().toISOString();
  await runs.writeRunResult(runId, { exitCode: 0, signal: null, completedAt });
  await runs.updateRun(runId, (current) => ({
    ...current,
    state: 'completed',
    completedAt,
    finalizedAt: completedAt,
  }));
}

async function failReadOnlyRun({ sessionId, runId, requestId, errorMessage }) {
  await history.appendEvent(sessionId, {
    type: 'message',
    role: 'assistant',
    content: `Execution failed: ${errorMessage}`,
    runId,
    requestId,
    messagePhase: 'final_answer',
    providerMessageId: `msg_fail_${runId}`,
    timestamp: Date.now(),
  });
  const completedAt = new Date().toISOString();
  await runs.writeRunResult(runId, { exitCode: 1, signal: null, error: errorMessage, completedAt });
  await runs.updateRun(runId, (current) => ({
    ...current,
    state: 'failed',
    error: errorMessage,
    completedAt,
    finalizedAt: completedAt,
  }));
}

let scheduler = null;
let respRuntime = null;

try {
  // ── 1. Real Organization, Nodes, Project, and Orchestrator Setup ──
  await orgStore.initializeOrganizationStore();
  await governor.initializeOrganizationGovernor();
  const project = await projects.createProject({ name: 'Stage5 Butler Project', rootPath: repoDir });

  const plannerApp = await appsMod.createApp({
    name: 'Stage5 Planner',
    tool: 'codex',
    collaborationPolicy: { role: 'planner', canDelegate: false, revision: 's5-p1' },
  });
  const reporterApp = await appsMod.createApp({
    name: 'Stage5 Reporter',
    tool: 'codex',
    collaborationPolicy: { role: 'specialist', canDelegate: false, revision: 's5-r1' },
  });

  const rootSession = await sessionManager.createSession(repoDir, 'codex', 'Stage5 Desktop Root', {
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
      projectRoot: repoDir,
      workspaceScope: repoDir,
      factoryMaxConcurrent: 4,
    },
    budget: { maxTotalRuns: 40, maxTokens: 200000, maxCost: 100 },
    idempotencyKey: 'stage5-e2e-org',
  });
  process.env.RAGENT_FACTORY_ORGANIZATIONS = org.id;
  await orgStore.createRevision(org.id, {
    revision: 1,
    proposal: { nodes: [], edges: [] },
    compiled: { nodes: [], edges: [] },
  });
  await orgStore.freezeRevision(org.id, 1);

  const plannerRole = await orgStore.createRoleInstance({
    organizationId: org.id,
    organizationRevision: 1,
    stableKey: 'planner',
    role: 'planner',
    agentId: plannerApp.id,
    lifecycleState: 'active',
    idempotencyKey: 'role-planner-s5',
  });
  const plannerGrant = { canWrite: false, canReview: false, allowedCapabilities: ['read', 'run'], projectId: project.id };
  const plannerNode = await orgStore.createNode({
    organizationId: org.id,
    stableKey: 'planner',
    nodeRole: 'planner',
    createdRevision: 1,
    lifecycleState: 'active',
    lifecycleMode: 'formal_org',
    grant: plannerGrant,
    roleInstanceId: plannerRole.id,
    bindingGeneration: 1,
    sessionClass: 'WORKER',
  });
  await orgStore.bindRoleInstanceNode(plannerRole.id, plannerNode.id);
  const plannerSession = await sessionManager.createSession(repoDir, 'codex', 'Node planner', {
    projectId: project.id,
    templateId: plannerApp.id,
    sessionPlane: 'organization',
    sessionClass: 'WORKER',
    lifecycleMode: 'formal_org',
    managedScope: 'organization',
    organizationRootSessionId: rootSession.id,
    organizationId: org.id,
    organizationNodeId: plannerNode.id,
    organizationRevision: 1,
    roleInstanceId: plannerRole.id,
    controllerSessionId: rootSession.id,
    parentSessionId: rootSession.id,
    delegatedFromSessionId: rootSession.id,
    delegationDepth: 1,
    model: 'gpt-5.3-codex',
    effort: 'medium',
    riskMode: 'recommended',
  });
  await orgStore.bindNodeSession(plannerNode.id, { sessionId: plannerSession.id, bindingGeneration: 1 });
  const boundPlanner = await orgStore.getNode(plannerNode.id);
  await orgStore.materializeFrozenNodeGrants({
    organizationId: org.id,
    nodeId: boundPlanner.id,
    revision: 1,
    expectedGrant: plannerGrant,
  });

  const reporterRole = await orgStore.createRoleInstance({
    organizationId: org.id,
    organizationRevision: 1,
    stableKey: 'reporter',
    role: 'specialist',
    agentId: reporterApp.id,
    lifecycleState: 'active',
    idempotencyKey: 'role-reporter-s5',
  });
  const reporterGrant = { canWrite: false, canReview: false, allowedCapabilities: ['read', 'run'], projectId: project.id };
  const reporterNode = await orgStore.createNode({
    organizationId: org.id,
    stableKey: 'reporter',
    nodeRole: 'specialist',
    createdRevision: 1,
    lifecycleState: 'active',
    lifecycleMode: 'formal_org',
    grant: reporterGrant,
    roleInstanceId: reporterRole.id,
    bindingGeneration: 1,
    sessionClass: 'WORKER',
  });
  await orgStore.bindRoleInstanceNode(reporterRole.id, reporterNode.id);
  const reporterSession = await sessionManager.createSession(repoDir, 'codex', 'Node reporter', {
    projectId: project.id,
    templateId: reporterApp.id,
    sessionPlane: 'organization',
    sessionClass: 'WORKER',
    lifecycleMode: 'formal_org',
    managedScope: 'organization',
    organizationRootSessionId: rootSession.id,
    organizationId: org.id,
    organizationNodeId: reporterNode.id,
    organizationRevision: 1,
    roleInstanceId: reporterRole.id,
    controllerSessionId: rootSession.id,
    parentSessionId: rootSession.id,
    delegatedFromSessionId: rootSession.id,
    delegationDepth: 1,
    model: 'gpt-5.3-codex',
    effort: 'medium',
    riskMode: 'recommended',
  });
  await orgStore.bindNodeSession(reporterNode.id, { sessionId: reporterSession.id, bindingGeneration: 1 });
  const boundReporter = await orgStore.getNode(reporterNode.id);
  await orgStore.materializeFrozenNodeGrants({
    organizationId: org.id,
    nodeId: boundReporter.id,
    revision: 1,
    expectedGrant: reporterGrant,
  });

  const reporter2Role = await orgStore.createRoleInstance({
    organizationId: org.id,
    organizationRevision: 1,
    stableKey: 'reporter_live',
    role: 'specialist',
    agentId: reporterApp.id,
    lifecycleState: 'active',
    idempotencyKey: 'role-reporter2-s5',
  });
  const reporter2Node = await orgStore.createNode({
    organizationId: org.id,
    stableKey: 'reporter_live',
    nodeRole: 'specialist',
    createdRevision: 1,
    lifecycleState: 'active',
    lifecycleMode: 'formal_org',
    grant: reporterGrant,
    roleInstanceId: reporter2Role.id,
    bindingGeneration: 1,
    sessionClass: 'WORKER',
  });
  await orgStore.bindRoleInstanceNode(reporter2Role.id, reporter2Node.id);
  const reporter2Session = await sessionManager.createSession(repoDir, 'codex', 'Node reporter live', {
    projectId: project.id,
    templateId: reporterApp.id,
    sessionPlane: 'organization',
    sessionClass: 'WORKER',
    lifecycleMode: 'formal_org',
    managedScope: 'organization',
    organizationRootSessionId: rootSession.id,
    organizationId: org.id,
    organizationNodeId: reporter2Node.id,
    organizationRevision: 1,
    roleInstanceId: reporter2Role.id,
    controllerSessionId: rootSession.id,
    parentSessionId: rootSession.id,
    delegatedFromSessionId: rootSession.id,
    delegationDepth: 1,
    model: 'gpt-5.3-codex',
    effort: 'medium',
    riskMode: 'recommended',
  });
  await orgStore.bindNodeSession(reporter2Node.id, { sessionId: reporter2Session.id, bindingGeneration: 1 });
  const boundReporter2 = await orgStore.getNode(reporter2Node.id);
  await orgStore.materializeFrozenNodeGrants({
    organizationId: org.id,
    nodeId: boundReporter2.id,
    revision: 1,
    expectedGrant: reporterGrant,
  });

  const ownerActor = { kind: 'user', role: 'owner', principalId: OWNER_ID };
  const serviceActor = { kind: 'service', role: 'factory_scheduler', principalId: `factory-scheduler:${OWNER_ID}`, authorizingPrincipalId: OWNER_ID };
  const orchestrator = createCollaborationOrchestrator({
    pollMs: 100000,
    dependencies: {
      sendMessage: async (sid, text, images, opts) => sessionManager.sendMessage(sid, text, images, { ...opts, skipRunnerLaunch: true }),
    },
  });
  const adapter = createFactoryExecutionAdapter({ organizationId: org.id, actor: serviceActor, orchestrator });
  scheduler = createFactoryScheduler({ organizationId: org.id, actor: serviceActor, adapter, admissionEnabled: true, pollMs: 60000 });
  respRuntime = createResponsibilityRuntime({ intervalMs: 60000 });
  await scheduler.start();
  respRuntime.start();

  const reportFormula = getFactoryFormula('ragent-project-report', 1);
  const plannerFormula = getFactoryFormula('ragent-responsibility-planner', 1);
  const validUntil = new Date(Date.now() + 7 * 86400_000).toISOString();

  const makeReportPolicy = (maxAttempts = 1, node = boundReporter) => ({
    providerId: PROJECT_REPORT_PROVIDER.id,
    providerVersion: PROJECT_REPORT_PROVIDER.version,
    providerDigest: PROJECT_REPORT_PROVIDER.digest,
    templateId: reportFormula.id,
    templateVersion: reportFormula.version,
    templateDigest: reportFormula.digest,
    resource: { projectId: project.id, readScope: 'entire_project', networkPolicy: 'inherit_existing_permissions' },
    networkPermissionConfirmed: true,
    nodeBindings: { report: { nodeId: node.id, bindingGeneration: node.bindingGeneration } },
    maxAttempts,
    maxCost: 1.5,
    dailyBudget: { timeZone: 'UTC', maxRuns: 10, maxTokens: 40000, maxCost: 20.0 },
    validUntil,
  });

  // Helper to create + activate + wake a responsibility via HTTP routes.
  async function createActiveWokenResponsibility({ objective, policy, key }) {
    const cRes = await callRoute({
      method: 'POST',
      pathname: '/api/responsibilities',
      body: {
        organizationId: org.id,
        projectId: project.id,
        objective,
        successCriteria: ['Accurate persisted execution'],
        idempotencyKey: `create-${key}`,
        policy,
      },
    });
    equal(cRes.statusCode, 200, `Create ${key}`);
    const r = cRes.body.responsibility;
    const rRes = await callRoute({
      method: 'POST',
      pathname: `/api/responsibilities/${encodeURIComponent(r.id)}/resume`,
      body: { expectedVersion: r.rowVersion, idempotencyKey: `resume-${key}` },
    });
    equal(rRes.statusCode, 200, `Resume ${key}`);
    const wRes = await callRoute({
      method: 'POST',
      pathname: `/api/responsibilities/${encodeURIComponent(r.id)}/wake`,
      body: { expectedVersion: rRes.body.responsibility.rowVersion, idempotencyKey: `wake-${key}` },
    });
    equal(wRes.statusCode, 200, `Wake ${key}`);
    return { responsibility: rRes.body.responsibility, policy: cRes.body.policy };
  }

  // ── 2. Build Real Persisted State Across All 4 Butler Buckets ──

  // (A) Delivered Artifacts bucket: complete report with <ragent-result-packet> + manual acceptance
  const { responsibility: respDelivered } = await createActiveWokenResponsibility({
    objective: 'Compile weekly release readiness report',
    policy: makeReportPolicy(1),
    key: 'delivered',
  });
  await respRuntime.tick();
  await scheduler.tick();
  await scheduler.tick();
  const deliveredWorkId = (await responsibilityService.listResponsibilityWorkLinks(respDelivered.id, ownerActor)).links[0].workItemIds[0];
  let deliveredItem = (await factoryControl.getFactoryWorkItem(org.id, deliveredWorkId, ownerActor)).item;
  const deliveredRun = await runs.getRun(deliveredItem.bindings[0].runId);
  await completeReadOnlyRun({
    sessionId: deliveredRun.sessionId,
    runId: deliveredRun.id,
    requestId: deliveredRun.requestId,
    summaryContent: [
      'Weekly release readiness report compiled cleanly.',
      '',
      '<ragent-result-packet>',
      JSON.stringify({ state: 'completed', summary: 'Weekly release readiness report verified and archived.' }),
      '</ragent-result-packet>',
    ].join('\n'),
    tokens: 210,
    costUsd: 0.03,
  });
  equal(await orchestrator.completeRun(deliveredRun.id), true);
  await scheduler.tick();
  deliveredItem = (await factoryControl.getFactoryWorkItem(org.id, deliveredWorkId, ownerActor)).item;
  equal(deliveredItem.state, 'review');
  const acceptRes = await factoryAcceptance.decideFactoryManualAcceptance({
    organizationId: org.id,
    workItemId: deliveredItem.id,
    criterionId: 'report-reviewed',
    decision: 'passed',
    rationale: 'Owner verified delivered readiness artifact.',
    contractRevision: deliveredItem.contractRevision,
    candidateDigest: deliveredItem.candidateDigest,
    gateGeneration: deliveredItem.gateGeneration,
    expectedVersion: deliveredItem.rowVersion,
    commandId: 'cmd-accept-s5-delivered',
    idempotencyKey: 'accept-s5-delivered',
  }, ownerActor);
  equal(acceptRes.item.state, 'completed', 'Delivered artifact work item accepted');

  // (B) Awaiting Decision bucket: generic-planner produces pending_review plan
  const catalogReportEntry = {
    entryId: 'monthly_audit_report',
    capability: 'project-report',
    templateId: reportFormula.id,
    templateVersion: reportFormula.version,
    templateDigest: reportFormula.digest,
    resource: { projectId: project.id, readScope: 'entire_project', networkPolicy: 'inherit_existing_permissions' },
    nodeBindings: { report: { nodeId: boundReporter.id, bindingGeneration: boundReporter.bindingGeneration } },
    maxAttempts: 1,
    maxCost: 1.5,
    autoApproval: false,
    requiresHumanApproval: true,
  };
  const { responsibility: respAwaiting, policy: awaitingPolicy } = await createActiveWokenResponsibility({
    objective: 'Audit security compliance and propose remediation plan',
    policy: {
      providerId: GENERIC_PLANNER_PROVIDER.id,
      providerVersion: GENERIC_PLANNER_PROVIDER.version,
      providerDigest: GENERIC_PLANNER_PROVIDER.digest,
      templateId: plannerFormula.id,
      templateVersion: plannerFormula.version,
      templateDigest: plannerFormula.digest,
      resource: { projectId: project.id, readScope: 'entire_project', networkPolicy: 'inherit_existing_permissions' },
      networkPermissionConfirmed: true,
      nodeBindings: { planning: { nodeId: boundPlanner.id, bindingGeneration: boundPlanner.bindingGeneration } },
      maxAttempts: 2,
      maxCost: 1.0,
      planCatalog: [catalogReportEntry],
      planExecutionMaxAttempts: 3,
      planExecutionMaxCost: 3.0,
      planApproval: 'always',
      dailyBudget: { timeZone: 'UTC', maxRuns: 10, maxTokens: 40000, maxCost: 20.0 },
      validUntil,
    },
    key: 'awaiting',
  });
  await respRuntime.tick();
  await scheduler.tick();
  await scheduler.tick();
  const planningWorkId = (await responsibilityService.listResponsibilityWorkLinks(respAwaiting.id, ownerActor)).links[0].workItemIds[0];
  const planningItem = (await factoryControl.getFactoryWorkItem(org.id, planningWorkId, ownerActor)).item;
  const planningRun = await runs.getRun(planningItem.bindings[0].runId);
  const normEntry = awaitingPolicy.planCatalog[0];
  await completeReadOnlyRun({
    sessionId: planningRun.sessionId,
    runId: planningRun.id,
    requestId: planningRun.requestId,
    summaryContent: JSON.stringify({
      schemaVersion: 1,
      decision: 'plan',
      steps: [{
        id: 'step-audit-1',
        entryId: normEntry.entryId,
        entryDigest: normEntry.entryDigest,
        templateId: normEntry.templateId,
        templateVersion: normEntry.templateVersion,
        templateDigest: normEntry.templateDigest,
        nodeBindings: normEntry.nodeBindings,
        dependsOn: [],
      }],
    }),
    tokens: 160,
    costUsd: 0.02,
  });
  equal(await orchestrator.completeRun(planningRun.id), true);
  await scheduler.tick();
  await respRuntime.tick();
  const awaitingPlans = (await responsibilityPlans.listResponsibilityPlans(respAwaiting.id, ownerActor)).plans;
  equal(awaitingPlans.length, 1);
  equal(awaitingPlans[0].state, 'pending_review');
  const proposedPlan = awaitingPlans[0];

  // (C) Blocked & Alerts bucket — Case 1: Real failed execution with clear root cause
  const { responsibility: respFailed } = await createActiveWokenResponsibility({
    objective: 'Synchronize migration telemetry and validate schema checksums',
    policy: makeReportPolicy(1),
    key: 'failed-rootcause',
  });
  await respRuntime.tick();
  await scheduler.tick();
  await scheduler.tick();
  const failedWorkId = (await responsibilityService.listResponsibilityWorkLinks(respFailed.id, ownerActor)).links[0].workItemIds[0];
  let failedItem = (await factoryControl.getFactoryWorkItem(org.id, failedWorkId, ownerActor)).item;
  const failedRun = await runs.getRun(failedItem.bindings[0].runId);
  const ROOT_CAUSE_MSG = 'Database schema checksum mismatch in migration v4';
  await failReadOnlyRun({
    sessionId: failedRun.sessionId,
    runId: failedRun.id,
    requestId: failedRun.requestId,
    errorMessage: ROOT_CAUSE_MSG,
  });
  await orchestrator.completeRun(failedRun.id);
  await scheduler.tick();
  failedItem = (await factoryControl.getFactoryWorkItem(org.id, failedWorkId, ownerActor)).item;
  ok(['blocked', 'failed'].includes(failedItem.state), `Failed work item persisted in ${failedItem.state}`);

  // (D) In Progress bucket: active running responsibility on dedicated reporter2 node
  const { responsibility: respInProgress } = await createActiveWokenResponsibility({
    objective: 'Monitor active repository docs and index daily changes',
    policy: makeReportPolicy(1, boundReporter2),
    key: 'in-progress',
  });
  await respRuntime.tick();
  await scheduler.tick();
  await scheduler.tick();
  const inProgWorkId = (await responsibilityService.listResponsibilityWorkLinks(respInProgress.id, ownerActor)).links[0].workItemIds[0];
  const inProgItem = (await factoryControl.getFactoryWorkItem(org.id, inProgWorkId, ownerActor)).item;
  equal(inProgItem.state, 'running');

  // (E) Blocked & Alerts bucket — Case 2: True unknown_outcome via dispatch crash before Run receipt
  const { responsibility: respUnknown } = await createActiveWokenResponsibility({
    objective: 'Reconcile external billing webhook delivery',
    policy: makeReportPolicy(1),
    key: 'unknown-outcome',
  });
  await respRuntime.tick();
  await scheduler.stop();
  const dryOrchestrator = createCollaborationOrchestrator({
    pollMs: 100000,
    dependencies: {
      sendMessage: async () => {
        throw Object.assign(new Error('Runtime constraints changed before dispatch'), {
          code: 'COLLABORATION_RUNTIME_CONSTRAINT_CHANGED',
        });
      },
    },
  });
  const dryAdapter = createFactoryExecutionAdapter({ organizationId: org.id, actor: serviceActor, orchestrator: dryOrchestrator });
  const dryScheduler = createFactoryScheduler({ organizationId: org.id, actor: serviceActor, adapter: dryAdapter, admissionEnabled: true, pollMs: 60000 });
  await dryScheduler.start();
  await dryScheduler.stop();
  await dryOrchestrator.start();
  dryOrchestrator.stop();
  const unknownWorkId = (await responsibilityService.listResponsibilityWorkLinks(respUnknown.id, ownerActor)).links[0].workItemIds[0];
  const unknownItem = (await factoryControl.getFactoryWorkItem(org.id, unknownWorkId, ownerActor)).item;
  equal(unknownItem.bindings[0].status, 'intent');
  equal(unknownItem.bindings[0].runId, null);

  await scheduler.start();

  // ── 3. Verify Auth / Owner Isolation on Stage 5 Routes ──
  const unauthOverview = await callRoute({
    method: 'GET',
    pathname: '/api/responsibilities/butler-overview',
    authSession: { role: 'guest' },
    cookie: '',
  });
  equal(unauthOverview.statusCode, 403, 'Non-owner rejected from butler-overview');

  for (const principalKind of ['run_capability', 'temporary_device', 'provisional_device']) {
    const r = await callRoute({
      method: 'GET',
      pathname: '/api/responsibilities/butler-overview',
      authSession: { role: 'owner', principalKind },
      cookie: '',
    });
    equal(r.statusCode, 403, `Restricted principal ${principalKind} rejected`);
  }

  const badOriginPost = await callRoute({
    method: 'POST',
    pathname: '/api/responsibilities/voice/sessions',
    body: { responsibilityId: respFailed.id, deviceId: DEVICE_ID, deviceType: 'android' },
    headers: { 'sec-fetch-site': 'cross-site' },
  });
  equal(badOriginPost.statusCode, 403, 'Cross-site sec-fetch-site blocked on voice session mutation');

  // ── 4. Verify Butler 4-Bucket Overview ──
  const overviewRes = await callRoute({
    method: 'GET',
    pathname: `/api/responsibilities/butler-overview?organizationId=${encodeURIComponent(org.id)}&projectId=${encodeURIComponent(project.id)}`,
  });
  equal(overviewRes.statusCode, 200, 'Butler overview succeeds for owner');
  const ov = overviewRes.body;
  equal(ov.schemaVersion, 1);
  ok(ov.counts && typeof ov.counts === 'object', 'Butler counts present');
  equal(ov.counts.inProgress, ov.inProgress.length);
  equal(ov.counts.awaitingDecision, ov.awaitingDecision.length);
  equal(ov.counts.deliveredArtifacts, ov.deliveredArtifacts.length);
  equal(ov.counts.blockedAndAlerts, ov.blockedAndAlerts.length);

  ok(ov.inProgress.some((i) => i.responsibilityId === respInProgress.id), 'inProgress bucket contains active running responsibility');
  const awaitingItem = ov.awaitingDecision.find((i) => i.responsibilityId === respAwaiting.id && i.itemType === 'plan');
  ok(awaitingItem, 'awaitingDecision bucket contains proposed plan awaiting review');
  equal(awaitingItem.actionTarget?.planId, proposedPlan.id);
  equal(awaitingItem.actionTarget?.proposalDigest, proposedPlan.proposalDigest);
  ok(awaitingItem.actionTarget?.confirmationPath?.includes(proposedPlan.id), 'Plan confirmationPath points to plan approve endpoint');

  const deliveredEntry = ov.deliveredArtifacts.find((i) => i.responsibilityId === respDelivered.id);
  ok(deliveredEntry, 'deliveredArtifacts bucket contains accepted ResultPacket artifact');
  ok(deliveredEntry.artifact?.packetId, 'deliveredArtifacts entry exposes packetId');

  const failedEntry = ov.blockedAndAlerts.find((i) => i.responsibilityId === respFailed.id);
  ok(failedEntry, 'blockedAndAlerts contains failed/blocked responsibility');
  const unknownEntry = ov.blockedAndAlerts.find((i) => i.responsibilityId === respUnknown.id);
  ok(unknownEntry, `blockedAndAlerts contains unknown_outcome responsibility; unknownItem=${JSON.stringify(unknownItem)} inProg=${JSON.stringify(ov.inProgress.filter(i => i.responsibilityId === respUnknown.id))} blocked=${JSON.stringify(ov.blockedAndAlerts)}`);
  equal(unknownEntry.isUnknownOutcome, true, 'unknown_outcome surfaced explicitly in blockedAndAlerts');
  ok(ov.counts.unknownOutcomeCount >= 1, 'unknownOutcomeCount counts real unknown_outcome alert');

  // ── 5. Verify Decoupled Voice Adapters Discovery ──
  const adaptersRes = await callRoute({ method: 'GET', pathname: '/api/responsibilities/voice/adapters' });
  equal(adaptersRes.statusCode, 200);
  equal(adaptersRes.body.schemaVersion, 1);
  ok(Array.isArray(adaptersRes.body.asr) && adaptersRes.body.asr.length >= 1, 'ASR adapters listed');
  ok(Array.isArray(adaptersRes.body.reasoner) && adaptersRes.body.reasoner.length >= 1, 'Reasoner adapters listed');
  ok(Array.isArray(adaptersRes.body.tts) && adaptersRes.body.tts.length >= 1, 'TTS adapters listed');

  // ── 6. Multi-Turn Voice Butler Flow + Failure Follow-up + Barge-in + Android->Desktop Handoff ──
  const createSessBody = {
    responsibilityId: respFailed.id,
    deviceId: DEVICE_ID,
    deviceType: 'android',
    deviceLabel: 'Samsung Galaxy S22',
    language: 'en-US',
    idempotencyKey: 'voice-sess-create-1',
  };
  const sessRes = await callRoute({
    method: 'POST',
    pathname: '/api/responsibilities/voice/sessions',
    body: createSessBody,
  });
  equal(sessRes.statusCode, 200, 'Voice session created bound to responsibility');
  const voiceSession = sessRes.body.session;
  equal(voiceSession.responsibilityId, respFailed.id);
  equal(voiceSession.activeDeviceId, DEVICE_ID);
  equal(voiceSession.activeDeviceType, 'android');
  equal(voiceSession.turnSeq, 0);
  equal(sessRes.body.responsibilitySnapshot?.responsibility?.id, respFailed.id);

  // Idempotent session creation replay
  const sessReplay = await callRoute({
    method: 'POST',
    pathname: '/api/responsibilities/voice/sessions',
    body: createSessBody,
  });
  equal(sessReplay.statusCode, 200);
  equal(sessReplay.body.session.id, voiceSession.id, 'Voice session create replays idempotently');

  // Turn 1: Query status
  const turn1Body = {
    asr: { transcript: 'What is the current status of this responsibility?', confidence: 0.95, status: 'ok', language: 'en-US', mode: 'local' },
    streamTts: true,
    idempotencyKey: 'voice-turn-1',
  };
  const turn1Res = await callRoute({
    method: 'POST',
    pathname: `/api/responsibilities/voice/sessions/${encodeURIComponent(voiceSession.id)}/turn`,
    body: turn1Body,
  });
  equal(turn1Res.statusCode, 200);
  equal(turn1Res.body.outcome, 'answered');
  equal(turn1Res.body.safetyDecision, 'read_only_allowed');
  equal(turn1Res.body.mutated, false);
  equal(turn1Res.body.dispatched, false);
  equal(turn1Res.body.turn.turnSeq, 1);
  ok(turn1Res.body.responseText && turn1Res.body.responseText.length > 0, 'Status response generated');
  ok(Array.isArray(turn1Res.body.ttsStream?.chunks) && turn1Res.body.ttsStream.chunks.length >= 1, 'Streaming TTS chunks returned');

  // Idempotent Turn 1 replay
  const turn1Replay = await callRoute({
    method: 'POST',
    pathname: `/api/responsibilities/voice/sessions/${encodeURIComponent(voiceSession.id)}/turn`,
    body: turn1Body,
  });
  equal(turn1Replay.statusCode, 200);
  equal(turn1Replay.body.replayed, true);
  equal(turn1Replay.body.turn.id, turn1Res.body.turn.id);
  equal(turn1Replay.body.turn.turnSeq, 1);

  // Turn 2: Follow-up on failure root cause
  const turn2Res = await callRoute({
    method: 'POST',
    pathname: `/api/responsibilities/voice/sessions/${encodeURIComponent(voiceSession.id)}/turn`,
    body: {
      asr: { transcript: 'Why did it fail and what is the failure root cause?', confidence: 0.92, status: 'ok', language: 'en-US' },
      streamTts: true,
      idempotencyKey: 'voice-turn-2',
    },
  });
  equal(turn2Res.statusCode, 200);
  equal(turn2Res.body.outcome, 'answered');
  equal(turn2Res.body.mutated, false);
  equal(turn2Res.body.dispatched, false);
  equal(turn2Res.body.turn.turnSeq, 2);
  ok(
    turn2Res.body.responseText.includes(ROOT_CAUSE_MSG),
    `Follow-up response reflects exact persisted failure root cause: ${turn2Res.body.responseText}`,
  );

  // Barge-in interrupt mid-TTS on Turn 2 generation
  const genBeforeInterrupt = turn2Res.body.ttsStream.generation;
  const intRes = await callRoute({
    method: 'POST',
    pathname: `/api/responsibilities/voice/sessions/${encodeURIComponent(voiceSession.id)}/interrupt`,
    body: {
      targetGeneration: genBeforeInterrupt,
      targetTurnSeq: 2,
      interruptedChunkIndex: 0,
      reason: 'user_barge_in',
      deviceId: DEVICE_ID,
      deviceType: 'android',
    },
  });
  equal(intRes.statusCode, 200);
  equal(intRes.body.interrupted, true);
  equal(intRes.body.alreadySuperseded, false);
  ok(intRes.body.playbackGeneration > genBeforeInterrupt, 'Barge-in bumps monotonic playbackGeneration');

  // Stale/duplicate interrupt on superseded generation must NOT clobber
  const staleIntRes = await callRoute({
    method: 'POST',
    pathname: `/api/responsibilities/voice/sessions/${encodeURIComponent(voiceSession.id)}/interrupt`,
    body: {
      targetGeneration: genBeforeInterrupt,
      targetTurnSeq: 2,
      reason: 'late_retry',
      deviceId: DEVICE_ID,
      deviceType: 'android',
    },
  });
  equal(staleIntRes.statusCode, 200);
  equal(staleIntRes.body.alreadySuperseded, true, 'Stale barge-in generation is safely superseded');
  equal(staleIntRes.body.playbackGeneration, intRes.body.playbackGeneration);

  // Turn 3 immediately after barge-in
  const turn3Res = await callRoute({
    method: 'POST',
    pathname: `/api/responsibilities/voice/sessions/${encodeURIComponent(voiceSession.id)}/turn`,
    body: {
      asr: { transcript: 'Give me a brief summary of what is blocked right now', confidence: 0.94, status: 'ok', language: 'en-US' },
      expectedGeneration: intRes.body.playbackGeneration,
      streamTts: true,
      idempotencyKey: 'voice-turn-3',
    },
  });
  equal(turn3Res.statusCode, 200);
  equal(turn3Res.body.turn.turnSeq, 3);
  ok(turn3Res.body.ttsStream.generation > genBeforeInterrupt, 'Post-barge-in TTS generation strictly advances');

  // Cross-device handoff: Android -> Desktop preserving full turn history & responsibility context
  const handoffRes = await callRoute({
    method: 'POST',
    pathname: `/api/responsibilities/voice/sessions/${encodeURIComponent(voiceSession.id)}/handoff`,
    body: {
      targetDeviceId: DESKTOP_DEVICE_ID,
      targetDeviceType: 'desktop',
      targetDeviceLabel: 'Windows 11 Desktop',
      targetRootSessionId: rootSession.id,
      expectedRowVersion: turn3Res.body.session.rowVersion,
      reason: 'continue_on_desktop',
      idempotencyKey: 'voice-handoff-1',
    },
  });
  equal(handoffRes.statusCode, 200, 'Cross-device handoff Android -> Desktop succeeds');
  equal(handoffRes.body.session.activeDeviceId, DESKTOP_DEVICE_ID);
  equal(handoffRes.body.session.activeDeviceType, 'desktop');
  equal(handoffRes.body.session.responsibilityId, respFailed.id);
  equal(handoffRes.body.turns.length, 3, 'All 3 Android turns preserved on Desktop handoff');
  ok(handoffRes.body.handoff?.id, 'Handoff record persisted');
  equal(handoffRes.body.responsibilitySnapshot?.responsibility?.id, respFailed.id);

  // Handoff idempotency replay mismatch must reject with 409
  const handoffMismatch = await callRoute({
    method: 'POST',
    pathname: `/api/responsibilities/voice/sessions/${encodeURIComponent(voiceSession.id)}/handoff`,
    body: {
      targetDeviceId: 'different-device-id',
      targetDeviceType: 'web',
      idempotencyKey: 'voice-handoff-1',
    },
  });
  equal(handoffMismatch.statusCode, 409, 'Handoff idempotency key mismatch returns 409');

  // Turn 4 on Desktop
  const turn4Res = await callRoute({
    method: 'POST',
    pathname: `/api/responsibilities/voice/sessions/${encodeURIComponent(voiceSession.id)}/turn`,
    body: {
      asr: { transcript: 'What is the overall butler status across responsibilities?', confidence: 0.96, status: 'ok', language: 'en-US' },
      deviceId: DESKTOP_DEVICE_ID,
      deviceType: 'desktop',
      streamTts: true,
      idempotencyKey: 'voice-turn-4',
    },
  });
  equal(turn4Res.statusCode, 200);
  equal(turn4Res.body.turn.turnSeq, 4);
  equal(turn4Res.body.session.activeDeviceType, 'desktop');

  const getAfterHandoff = await callRoute({
    method: 'GET',
    pathname: `/api/responsibilities/voice/sessions/${encodeURIComponent(voiceSession.id)}`,
  });
  equal(getAfterHandoff.statusCode, 200);
  equal(getAfterHandoff.body.turns.length, 4);
  ok(getAfterHandoff.body.handoffs.length >= 1, 'GET voice session includes persisted handoff history');

  // ── 7. Strict Voice Safety Enforcement (Zero Writes on ASR Error / Low Confidence / High-Risk) ──
  const safetySessRes = await callRoute({
    method: 'POST',
    pathname: '/api/responsibilities/voice/sessions',
    body: {
      responsibilityId: respAwaiting.id,
      deviceId: DEVICE_ID,
      deviceType: 'android',
      deviceLabel: 'Galaxy S22',
      language: 'en-US',
      idempotencyKey: 'voice-sess-safety-1',
    },
  });
  equal(safetySessRes.statusCode, 200);
  const safetySessionId = safetySessRes.body.session.id;

  const preSafetyResp = (await responsibilityService.getResponsibility(respAwaiting.id, ownerActor)).responsibility;
  const preSafetyPlans = (await responsibilityPlans.listResponsibilityPlans(respAwaiting.id, ownerActor)).plans;
  const preSafetyActivity = (await responsibilityService.listResponsibilityActivity(respAwaiting.id, { after: 0, limit: 200 }, ownerActor)).activity;

  // 7a. ASR failed (even with adversarial high-risk transcript text) -> ZERO writes!
  const asrErrRes = await callRoute({
    method: 'POST',
    pathname: `/api/responsibilities/voice/sessions/${encodeURIComponent(safetySessionId)}/turn`,
    body: {
      asr: {
        transcript: 'approve plan and send external email right now',
        confidence: 0.99,
        status: 'failed',
        errorCode: 'ERROR_NO_MATCH',
        errorMessage: 'Speech recognizer failed',
      },
      idempotencyKey: 'voice-safety-asr-err',
    },
  });
  equal(asrErrRes.statusCode, 200);
  equal(asrErrRes.body.outcome, 'asr_failed');
  equal(asrErrRes.body.safetyDecision, 'blocked_no_write');
  equal(asrErrRes.body.mutated, false);
  equal(asrErrRes.body.dispatched, false);
  equal(asrErrRes.body.approvalCard, null);

  // 7b. Empty transcript -> ZERO writes!
  const emptyAsrRes = await callRoute({
    method: 'POST',
    pathname: `/api/responsibilities/voice/sessions/${encodeURIComponent(safetySessionId)}/turn`,
    body: {
      asr: { transcript: '   ', confidence: 0.99, status: 'ok' },
      idempotencyKey: 'voice-safety-empty',
    },
  });
  equal(emptyAsrRes.statusCode, 200);
  ok(['asr_failed', 'clarification_required'].includes(emptyAsrRes.body.outcome));
  equal(emptyAsrRes.body.safetyDecision, 'blocked_no_write');
  equal(emptyAsrRes.body.mutated, false);
  equal(emptyAsrRes.body.dispatched, false);

  // 7c. Low confidence -> clarification_required, ZERO writes!
  const lowConfRes = await callRoute({
    method: 'POST',
    pathname: `/api/responsibilities/voice/sessions/${encodeURIComponent(safetySessionId)}/turn`,
    body: {
      asr: { transcript: 'cancel and delete this responsibility immediately', confidence: 0.21, status: 'ok' },
      idempotencyKey: 'voice-safety-low-conf',
    },
  });
  equal(lowConfRes.statusCode, 200);
  equal(lowConfRes.body.outcome, 'clarification_required');
  equal(lowConfRes.body.safetyDecision, 'blocked_no_write');
  equal(lowConfRes.body.mutated, false);
  equal(lowConfRes.body.dispatched, false);
  ok(lowConfRes.body.clarificationPrompt && lowConfRes.body.clarificationPrompt.length > 0, 'Clarification prompt returned');

  // Verify ZERO responsibility / plan / activity mutations occurred across 7a-7c
  const midSafetyResp = (await responsibilityService.getResponsibility(respAwaiting.id, ownerActor)).responsibility;
  const midSafetyPlans = (await responsibilityPlans.listResponsibilityPlans(respAwaiting.id, ownerActor)).plans;
  const midSafetyActivity = (await responsibilityService.listResponsibilityActivity(respAwaiting.id, { after: 0, limit: 200 }, ownerActor)).activity;
  equal(midSafetyResp.rowVersion, preSafetyResp.rowVersion, 'ASR errors/low-confidence never change responsibility rowVersion');
  equal(midSafetyResp.lifecycle, 'active');
  equal(midSafetyPlans[0].state, preSafetyPlans[0].state, 'ASR errors/low-confidence never approve pending plan');
  equal(midSafetyActivity.length, preSafetyActivity.length, 'ASR errors/low-confidence produce zero responsibility activity mutations');

  // 7d. High-risk action via voice -> requires_visual_approval card payload, NEVER auto-executes!
  const highRiskPlanRes = await callRoute({
    method: 'POST',
    pathname: `/api/responsibilities/voice/sessions/${encodeURIComponent(safetySessionId)}/turn`,
    body: {
      asr: { transcript: 'Approve the pending plan right now', confidence: 0.96, status: 'ok' },
      idempotencyKey: 'voice-safety-approve-plan',
    },
  });
  equal(highRiskPlanRes.statusCode, 200);
  equal(highRiskPlanRes.body.outcome, 'requires_visual_approval');
  equal(highRiskPlanRes.body.safetyDecision, 'visual_approval_required');
  equal(highRiskPlanRes.body.mutated, false);
  equal(highRiskPlanRes.body.dispatched, false);
  const card = highRiskPlanRes.body.approvalCard;
  ok(card && typeof card === 'object', 'Visual approval card returned');
  equal(card.requiresExplicitConfirm, true);
  equal(card.executableViaVoice, false);
  equal(card.confirmationPolicy, 'require_visual_approval');
  equal(card.responsibilityId, respAwaiting.id);
  equal(card.planId, proposedPlan.id);
  equal(card.proposalDigest, proposedPlan.proposalDigest);
  ok(card.target && card.impactSummary && card.actionDigest, 'Approval card includes target, impactSummary, and actionDigest');

  // Verify plan STILL pending_review before explicit visual confirmation
  const plansBeforeConfirm = (await responsibilityPlans.listResponsibilityPlans(respAwaiting.id, ownerActor)).plans;
  equal(plansBeforeConfirm[0].state, 'pending_review', 'Plan MUST remain pending_review until explicit owner confirmation');

  // Also test mixed read+action bypass attempts and external-send / merge high-risk voice requests
  for (const dangerousUtterance of [
    'Merge the pull request and send email to the client',
    'Check status and merge the PR',
    'Show pending approvals and approve the plan',
  ]) {
    const highRiskExtRes = await callRoute({
      method: 'POST',
      pathname: `/api/responsibilities/voice/sessions/${encodeURIComponent(safetySessionId)}/turn`,
      body: {
        asr: { transcript: dangerousUtterance, confidence: 0.97, status: 'ok' },
        idempotencyKey: `voice-safety-ext-${Buffer.from(dangerousUtterance).toString('hex').slice(0, 16)}`,
      },
    });
    equal(highRiskExtRes.statusCode, 200);
    equal(highRiskExtRes.body.outcome, 'requires_visual_approval', `Mixed/dangerous utterance requires visual approval: ${dangerousUtterance}`);
    equal(highRiskExtRes.body.safetyDecision, 'visual_approval_required');
    equal(highRiskExtRes.body.mutated, false);
    equal(highRiskExtRes.body.dispatched, false);
    equal(highRiskExtRes.body.approvalCard?.executableViaVoice, false);
    equal(highRiskExtRes.body.approvalCard?.requiresExplicitConfirm, true);
  }

  // 7e. Explicit owner visual confirmation using approvalCard.confirmationEndpoint -> executes cleanly!
  ok(card.confirmationEndpoint?.path, 'Plan approval card provides confirmationEndpoint');
  const confirmBody = {
    ...(card.confirmationEndpoint.bodyTemplate || {}),
    confirmed: true,
    expectedVersion: card.expectedVersion ?? midSafetyResp.rowVersion,
    proposalDigest: card.proposalDigest ?? proposedPlan.proposalDigest,
    idempotencyKey: 'visual-confirm-plan-s5-1',
  };
  const confirmRes = await callRoute({
    method: card.confirmationEndpoint.method || 'POST',
    pathname: card.confirmationEndpoint.path,
    body: confirmBody,
  });
  equal(confirmRes.statusCode, 200, 'Explicit owner confirmation via approval card succeeds');
  equal(confirmRes.body.state, 'approved');

  const overviewAfterApprove = await callRoute({
    method: 'GET',
    pathname: `/api/responsibilities/butler-overview?organizationId=${encodeURIComponent(org.id)}&projectId=${encodeURIComponent(project.id)}`,
  });
  equal(overviewAfterApprove.statusCode, 200);
  ok(
    !overviewAfterApprove.body.awaitingDecision.some((i) => i.actionTarget?.planId === proposedPlan.id),
    'Approved plan leaves awaitingDecision bucket in butler-overview',
  );

  // ── 8. Subprocess Restart Durability Verification ──
  const verifyScript = `
    import assert from 'node:assert/strict';
    import { Readable } from 'node:stream';
    const authMod = await import(${JSON.stringify(pathToFileURL(join(repoRoot, 'lib', 'auth.mjs')).href)});
    authMod.resetInstanceAuthCache?.();
    const token = await authMod.issueSession({ role: 'owner', username: 'owner' });
    const cookie = authMod.setCookie(token).split(';')[0];
    const authSession = authMod.getAuthSession({ headers: { cookie }, socket: { encrypted: false } });
    const { handleResponsibilityRoutes } = await import(${JSON.stringify(pathToFileURL(join(repoRoot, 'chat', 'router-responsibility-routes.mjs')).href)});
    async function getRoute(pathname) {
      const req = Readable.from([]);
      req.method = 'GET';
      req.url = pathname;
      req.headers = { host: '127.0.0.1:7690', cookie };
      req.socket = { encrypted: false, remoteAddress: '127.0.0.1' };
      let statusCode = 0, raw = '';
      const res = { headersSent: false, writeHead(c) { statusCode = c; this.headersSent = true; }, end(s) { raw += s || ''; } };
      await handleResponsibilityRoutes({
        req, res, pathname: pathname.split('?')[0], authSession,
        writeJson: (r, c, p) => { r.writeHead(c); r.end(JSON.stringify(p)); },
        requireSessionAccess: async () => true,
      });
      return { statusCode, body: JSON.parse(raw) };
    }
    const sess = await getRoute('/api/responsibilities/voice/sessions/' + encodeURIComponent(process.env.STAGE5_SESSION_ID));
    assert.equal(sess.statusCode, 200);
    assert.equal(sess.body.session.activeDeviceType, 'desktop');
    assert.equal(sess.body.session.responsibilityId, process.env.STAGE5_RESP_ID);
    assert.equal(sess.body.turns.length, 4);
    assert.ok(sess.body.handoffs.length >= 1);
    const ov = await getRoute('/api/responsibilities/butler-overview?organizationId=' + encodeURIComponent(process.env.STAGE5_ORG_ID));
    assert.equal(ov.statusCode, 200);
    assert.ok(ov.body.counts.unknownOutcomeCount >= 1);
    console.log('STAGE5_SUBPROCESS_OK');
  `;
  const subOut = await execFileAsync(process.execPath, ['--input-type=module', '-e', verifyScript], {
    cwd: repoRoot,
    env: {
      ...process.env,
      STAGE5_SESSION_ID: voiceSession.id,
      STAGE5_RESP_ID: respFailed.id,
      STAGE5_ORG_ID: org.id,
    },
  });
  match(subOut.stdout, /STAGE5_SUBPROCESS_OK/, 'Voice session continuity & butler overview persist across clean restart');

  console.log(`test-stage5-e2e-acceptance: ok (${assertions} assertions)`);
} finally {
  try { if (scheduler) await scheduler.stop(); } catch {}
  try { if (respRuntime) await respRuntime.stop(); } catch {}
  try { sessionManager.killAll(); } catch {}
  try { await resultPackets.closeResultPacketStore(); } catch {}
  try { await orgStore.closeOrganizationDatabase?.(); } catch {}
  try { authMod.closeAuthSessionStore?.(); } catch {}
  try { rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
}
