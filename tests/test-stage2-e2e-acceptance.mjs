#!/usr/bin/env node
// Stage 2 End-to-End Acceptance Suite for Ragent Full 2.0:
// Exercises real SQLite stores, real Responsibility & Factory runtimes, real HTTP
// routes, Swarm-Factory Bridge & Deterministic Fan-out dispatch, cost-aware model
// tiering & budget reservations, durable producer-side event retention, bounded
// workspace/external change fingerprint LLM skip, and Goal-DAG generalized
// revision with unaffected artifact reuse & generation fencing.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { Readable } from 'node:stream';

const testTmpRoot = process.env.RAGENT_TEST_TMPDIR || tmpdir();
mkdirSync(testTmpRoot, { recursive: true });
const tempRoot = mkdtempSync(join(testTmpRoot, 'ragent-stage2-e2e-'));
const instanceRoot = join(tempRoot, 'instance');
const configDir = join(instanceRoot, 'config');
const dataDir = join(instanceRoot, 'data');
const workRootDir = join(instanceRoot, 'workspace');
const memoryDir = join(instanceRoot, 'memory');
const harnessRoot = join(tempRoot, 'harnesses');
const harnessBin = join(harnessRoot, 'codex', 'node_modules', '.bin');
const repoDir = join(tempRoot, 'repo');
const outsideDir = join(tempRoot, 'outside-secret');

const OWNER_ID = 'owner-stage2-e2e';
const ACCOUNT_ID = 'acct_stage2_e2e';
const DEVICE_ID = 'rdev_stage2_e2e';

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
process.env.RAGENT_AUTH_SESSION_SECRET = 'stage2-acceptance-auth-secret-1234567890';
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
mkdirSync(join(repoDir, 'src'), { recursive: true });
mkdirSync(outsideDir, { recursive: true });

// Provide deterministic offline codex CLI stub.
writeFileSync(join(harnessBin, 'codex'), '#!/bin/sh\necho "0.114.0"\n', 'utf8');
try { chmodSync(join(harnessBin, 'codex'), 0o755); } catch {}
if (process.platform === 'win32') {
  writeFileSync(join(harnessBin, 'codex.cmd'), '@echo off\r\necho 0.114.0\r\n', 'utf8');
}
process.env.PATH = `${harnessBin}${delimiter}${process.env.PATH || ''}`;

// Initialize real Git repository with origin remote & committed files.
execFileSync('git', ['init', '-b', 'main', repoDir], { stdio: 'ignore' });
execFileSync('git', ['-C', repoDir, 'config', 'user.email', 'stage2-e2e@example.com'], { stdio: 'ignore' });
execFileSync('git', ['-C', repoDir, 'config', 'user.name', 'Stage2 E2E'], { stdio: 'ignore' });
execFileSync('git', ['-C', repoDir, 'remote', 'add', 'origin', 'https://github.com/ragent-app/Ragent_product.git'], { stdio: 'ignore' });
writeFileSync(join(repoDir, 'README.md'), '# Stage 2 Non-CI Project\nInitial baseline.\n', 'utf8');
writeFileSync(join(repoDir, 'docs', 'status.md'), 'Status: baseline\n', 'utf8');
writeFileSync(join(repoDir, 'src', 'moduleA.js'), 'export const a = 1;\n', 'utf8');
writeFileSync(join(repoDir, 'src', 'moduleB.js'), 'export const b = 2;\n', 'utf8');
writeFileSync(join(outsideDir, 'secret.txt'), 'OUTSIDE_SECRET_DO_NOT_HASH\n', 'utf8');
execFileSync('git', ['-C', repoDir, 'add', '.'], { stdio: 'ignore' });
execFileSync('git', ['-C', repoDir, 'commit', '-m', 'stage2 initial baseline'], { stdio: 'ignore' });

// Seed owner account binding + trusted device + instance identity.
const deviceKeyPair = generateKeyPairSync('ed25519');
const deviceToken = `rdt_${'b'.repeat(64)}`;
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
  instanceId: 'rli_stage2_e2e',
  instanceSecret: 'ris_stage2_e2e',
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
const { createCollaborationOrchestrator } = await import('../chat/collaboration-orchestrator.mjs');
const { createFactoryExecutionAdapter } = await import('../chat/factory-execution-adapter.mjs');
const { createFactoryScheduler } = await import('../chat/factory-scheduler.mjs');
const resultPackets = await import('../chat/result-packets.mjs');
const factoryControl = await import('../chat/factory-control.mjs');
const factoryAcceptance = await import('../chat/factory-acceptance.mjs');
const factoryCandidates = await import('../chat/factory-candidates.mjs');
const factoryGoalRevision = await import('../chat/factory-goal-revision.mjs');
const factoryAdmission = await import('../chat/factory-responsibility-admission.mjs');
const swarmBridge = await import('../chat/organization-swarm-factory-bridge.mjs');
const swarmMod = await import('../chat/organization-swarm.mjs');
const workGraphStore = await import('../chat/work-graph-store.mjs');
const { executeWorkGraphCommand, reconcileFactoryDependencies } = await import('../chat/work-graph.mjs');
const responsibilityStore = await import('../chat/responsibility-store.mjs');
const respProject = await import('../chat/responsibility-project.mjs');
const {
  getResponsibilityCapabilities,
  STAGE2_FANOUT_READ_FORMULA,
  STAGE2_SWARM_TEMPLATE,
} = await import('../chat/responsibility-capabilities.mjs');
const { createResponsibilityRuntime } = await import('../chat/responsibility-runtime.mjs');
const responsibilityService = await import('../chat/responsibility-service.mjs');
const responsibilityEvents = await import('../chat/responsibility-trigger-events.mjs');
const responsibilityPlans = await import('../chat/responsibility-plans.mjs');
const { GENERIC_PLANNER_PROVIDER } = await import('../chat/responsibility-providers.mjs');
const { getFactoryFormula, parallel: factoryParallel } = await import('../chat/factory-workflow.mjs');
const { handleResponsibilityRoutes } = await import('../chat/router-responsibility-routes.mjs');
const { handleFactoryRoutes } = await import('../chat/router-factory-routes.mjs');

let assertions = 0;
function equal(actual, expected, msg) { assertions += 1; assert.equal(actual, expected, msg); }
function ok(val, msg) { assertions += 1; assert.ok(val, msg); }
function deepEqual(actual, expected, msg) { assertions += 1; assert.deepEqual(actual, expected, msg); }
function rejectsWith(fn, pred, msg) { assertions += 1; return assert.rejects(fn, pred, msg); }

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

async function callRoute(handler, { method = 'GET', pathname, body = null, authSession = null, headers = {}, cookie = ownerCookieHeader }) {
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
  const session = authSession || ownerAuthSession;
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
  await orgStore.initializeOrganizationStore();
  await governor.initializeOrganizationGovernor();

  const project = await projects.createProject({ name: 'Stage2 Acceptance Project', rootPath: repoDir });
  const specialistApp = await appsMod.createApp({
    name: 'Stage2 Specialist',
    tool: 'codex',
    collaborationPolicy: { role: 'specialist', canDelegate: false, revision: 'spec-1' },
  });
  const writerApp = await appsMod.createApp({
    name: 'Stage2 Writer',
    tool: 'codex',
    collaborationPolicy: { role: 'writer', canDelegate: true, writablePaths: ['docs', 'src'], revision: 'writer-1' },
  });
  const reviewerApp = await appsMod.createApp({
    name: 'Stage2 Reviewer',
    tool: 'codex',
    collaborationPolicy: { role: 'reviewer', canDelegate: false, revision: 'rev-1' },
  });

  const rootSession = await sessionManager.createSession(repoDir, 'codex', 'Stage2 Root Session', {
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
      swarmEnabled: true,
      mode: 'ragent_swarm',
      allowModelSwitch: true,
      allowedHarnesses: ['codex', 'claude'],
      factoryChecks: [{ id: 'docs-lint', command: 'node -e "process.exit(0)"' }],
    },
    budget: { maxTotalRuns: 40, maxTokens: 200000, maxCost: 100 },
    idempotencyKey: 'stage2-e2e-org',
  });
  process.env.RAGENT_FACTORY_ORGANIZATIONS = org.id;

  await orgStore.createRevision(org.id, {
    revision: 1,
    proposal: { nodes: [], edges: [] },
    compiled: { nodes: [], edges: [] },
  });
  await orgStore.freezeRevision(org.id, 1);

  async function createBoundOrgNode({ stableKey, nodeRole, app, grant, sessionClass = '' }) {
    const resolvedSessionClass = sessionClass || (nodeRole === 'reviewer' ? 'REVIEWER' : 'WORKER');
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
      sessionClass: resolvedSessionClass,
    });
    await orgStore.bindRoleInstanceNode(roleInst.id, node.id);
    const sess = await sessionManager.createSession(repoDir, 'codex', `Node ${stableKey}`, {
      projectId: project.id,
      templateId: app.id,
      sessionPlane: 'organization',
      sessionClass: resolvedSessionClass,
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

  const ownerActor = { kind: 'user', role: 'owner', principalId: OWNER_ID };
  const serviceActor = { kind: 'service', role: 'factory_scheduler', principalId: `factory-scheduler:${OWNER_ID}`, authorizingPrincipalId: OWNER_ID };

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
    grant: { canWrite: true, canReview: false, writablePaths: ['docs', 'src'], allowedCapabilities: ['read', 'write', 'run'], projectId: project.id },
  });
  const reviewerNode = await createBoundOrgNode({
    stableKey: 'reviewer',
    nodeRole: 'reviewer',
    app: reviewerApp,
    grant: { canWrite: false, canReview: true, allowedCapabilities: ['read', 'review', 'run'], projectId: project.id },
  });
  const coordNode = await createBoundOrgNode({
    stableKey: 'coordinator',
    nodeRole: 'root_leadership',
    app: writerApp,
    grant: { canRead: true, canWrite: true, canRun: true, canDelegate: true, maxDepth: 3, writablePaths: ['docs', 'src'], workspaceScope: repoDir, allowedCapabilities: ['read', 'write', 'run', 'manage'], projectId: project.id },
  });

  let plannerDispatchCount = 0;
  let reportDispatchCount = 0;
  let s1PlannerDispatchCount = 0;
  let activeS1RespId = null;
  let activeObsRespId = null;
  let acceptCounter = 0;

  const orchestrator = createCollaborationOrchestrator({
    pollMs: 100000,
    dependencies: {
      sendMessage: async (sid, text, images, opts = {}) => {
        if (sid === plannerNode.session.id && activeS1RespId) {
          s1PlannerDispatchCount += 1;
          const run = await runs.createRun({
            status: { sessionId: sid, requestId: opts.requestId, tool: 'codex', model: 'gpt-5.3-codex', effort: 'medium', state: 'running', startedAt: new Date().toISOString() },
            manifest: { sessionId: sid, requestId: opts.requestId, projectId: project.id, folder: repoDir },
          });
          const cur = await responsibilityService.getResponsibility(activeS1RespId, ownerActor);
          const [fanEntry, swarmEntry] = cur.policy.planCatalog;
          const planJson = JSON.stringify({
            schemaVersion: 1,
            decision: 'plan',
            steps: [
              {
                id: 'step-fanout-audit',
                entryId: fanEntry.entryId,
                entryDigest: fanEntry.entryDigest,
                templateId: fanEntry.templateId,
                templateVersion: fanEntry.templateVersion,
                templateDigest: fanEntry.templateDigest,
                nodeBindings: fanEntry.nodeBindings,
                modelTierHints: { slice_moduleA: 'lightweight', slice_moduleB: 'lightweight' },
                dependsOn: [],
              },
              {
                id: 'step-swarm-impl',
                entryId: swarmEntry.entryId,
                entryDigest: swarmEntry.entryDigest,
                templateId: swarmEntry.templateId,
                templateVersion: swarmEntry.templateVersion,
                templateDigest: swarmEntry.templateDigest,
                nodeBindings: swarmEntry.nodeBindings,
                modelTierHints: { auditor: 'lightweight', implementer: 'strong', review: 'strong' },
                dependsOn: ['step-fanout-audit'],
              },
            ],
          });
          await completeReadOnlyRun({
            sessionId: sid,
            runId: run.id,
            requestId: opts.requestId,
            summaryContent: `\`\`\`json\n${planJson}\n\`\`\``,
            tokens: 140,
            costUsd: 0.02,
          });
          return { session: await sessionManager.getSession(sid), run: await runs.getRun(run.id), prompt: text };
        }
        if (sid === plannerNode.session.id && activeObsRespId) {
          plannerDispatchCount += 1;
          const run = await runs.createRun({
            status: { sessionId: sid, requestId: opts.requestId, tool: 'codex', model: 'gpt-5.3-codex', effort: 'medium', state: 'running', startedAt: new Date().toISOString() },
            manifest: { sessionId: sid, requestId: opts.requestId, projectId: project.id, folder: repoDir },
          });
          const cur = await responsibilityService.getResponsibility(activeObsRespId, ownerActor);
          const entry = cur.policy.planCatalog[0];
          const planJson = JSON.stringify({
            schemaVersion: 1,
            decision: 'plan',
            steps: [{
              id: 'step-report-obs',
              entryId: entry.entryId,
              entryDigest: entry.entryDigest,
              templateId: entry.templateId,
              templateVersion: entry.templateVersion,
              templateDigest: entry.templateDigest,
              nodeBindings: entry.nodeBindings,
              dependsOn: [],
            }],
          });
          await completeReadOnlyRun({
            sessionId: sid,
            runId: run.id,
            requestId: opts.requestId,
            summaryContent: `\`\`\`json\n${planJson}\n\`\`\``,
            tokens: 100,
            costUsd: 0.01,
          });
          return { session: await sessionManager.getSession(sid), run: await runs.getRun(run.id), prompt: text };
        }
        if (sid === reporterNode.session.id && (activeObsRespId || activeS1RespId)) {
          if (activeObsRespId) reportDispatchCount += 1;
          const run = await runs.createRun({
            status: { sessionId: sid, requestId: opts.requestId, tool: 'codex', model: 'gpt-5.3-codex', effort: 'medium', state: 'running', startedAt: new Date().toISOString() },
            manifest: { sessionId: sid, requestId: opts.requestId, projectId: project.id, folder: repoDir },
          });
          await completeReadOnlyRun({
            sessionId: sid,
            runId: run.id,
            requestId: opts.requestId,
            summaryContent: '# Status Report\nVerified.\n<ragent-result-packet>{"kind":"report","state":"completed","summary":"ok"}</ragent-result-packet>',
            tokens: 90,
            costUsd: 0.01,
          });
          return { session: await sessionManager.getSession(sid), run: await runs.getRun(run.id), prompt: text };
        }
        return sessionManager.sendMessage(sid, text, images, { ...opts, skipRunnerLaunch: true });
      },
      getRunState: (id) => runs.getRun(id),
      getRun: (id) => runs.getRun(id),
      getRunResult: (id) => runs.getRunResult(id),
      getRunManifest: (id) => runs.getRunManifest(id),
      listRunIds: () => runs.listRunIds(),
      requestRunCancel: (id) => runs.requestRunCancel(id),
      loadHistory: (sid) => history.loadHistory(sid),
      resolveRuntimeReadOnlyCapability: async () => ({ supportsReadOnlyFilesystem: true, sandboxMode: 'test-ro', runtimeId: 'test-ro' }),
    },
  });
  const adapter = createFactoryExecutionAdapter({ organizationId: org.id, actor: serviceActor, orchestrator });
  scheduler = createFactoryScheduler({ organizationId: org.id, actor: serviceActor, adapter, admissionEnabled: true, pollMs: 60000 });
  respRuntime = createResponsibilityRuntime({ intervalMs: 60000 });
  await scheduler.start();
  respRuntime.start();

  // Baseline capability & Stage 2 wiring verification
  const capsRes = await callRoute(handleResponsibilityRoutes, {
    method: 'GET',
    pathname: `/api/responsibilities/capabilities?organizationId=${encodeURIComponent(org.id)}&projectId=${encodeURIComponent(project.id)}`,
  });
  equal(capsRes.statusCode, 200, 'Capabilities route succeeds for owner');
  ok(Boolean(plannerNode.node.id && reporterNode.node.id && writerNode.node.id && reviewerNode.node.id && coordNode.node.id), 'Stage 2 organization nodes initialized');
  equal(capsRes.body.planCatalogDescriptors[0].capability, 'project-report', 'Preserves Stage 1 project-report capability descriptor first');
  equal(capsRes.body.features.defaultCapabilityGates.allowFanout, false, 'Capability gates default conservative (allowFanout=false)');
  equal(capsRes.body.features.defaultCapabilityGates.allowSwarm, false, 'Capability gates default conservative (allowSwarm=false)');
  equal(capsRes.body.features.defaultCapabilityGates.allowWrite, false, 'Capability gates default conservative (allowWrite=false)');

  const plannerFormula = getFactoryFormula('ragent-responsibility-planner', 1);
  const reportFormula = getFactoryFormula('ragent-project-report', 1);
  const validUntil = new Date(Date.now() + 14 * 86400_000).toISOString();

  // ── Scenario 1 (S2.1): Controlled Planner -> Fan-out & Swarm-Factory Bridge with Cost-Aware Tiering & Budget Reservation ──
  const s1ProjectFact = await respProject.captureResponsibilityProject(org.id, project.id);
  const s1FanoutSpec = factoryParallel(
    ['moduleA', 'moduleB'],
    (slice) => ({
      key: `slice_${slice}`,
      title: `Audit ${slice}`,
      requiredRole: 'researcher',
      stepKind: 'execution',
      accessMode: 'read',
      objective: `Audit ${slice}`,
      prompt: `Inspect ${slice}`,
      outputSchema: {
        type: 'object',
        properties: { summary: { type: 'string' } },
        required: ['summary'],
      },
    }),
    { name: 'e2e-audit-slices', maxConcurrency: 2 },
  );
  const s1FanoutEntry = {
    entryId: 'e2e-s1-fanout-read',
    capability: 'fanout',
    templateId: 'ragent-fanout-workflow',
    templateVersion: 1,
    templateDigest: workGraphStore.digest(STAGE2_FANOUT_READ_FORMULA),
    objective: 'Run parallel read audit across modules',
    accessMode: 'read',
    maxAttempts: 2,
    maxCost: 1.0,
    maxRuns: 4,
    maxConcurrency: 2,
    spec: s1FanoutSpec,
    resource: { projectId: project.id, readScope: 'entire_project', networkPolicy: 'inherit_existing_permissions' },
    nodeBindings: { read: { nodeId: reporterNode.node.id, bindingGeneration: reporterNode.node.bindingGeneration } },
  };
  const s1SwarmEntry = {
    entryId: 'e2e-s1-swarm-write',
    capability: 'swarm-collaboration',
    templateId: 'ragent-swarm-collaboration',
    templateVersion: 1,
    templateDigest: workGraphStore.digest(STAGE2_SWARM_TEMPLATE),
    objective: 'Implement src/moduleA.js update via isolated Swarm and independent review',
    accessMode: 'write',
    allowedPaths: ['src'],
    targetBranch: 'main',
    candidateScope: 'branch_diff',
    maxAttempts: 2,
    maxCost: 2.0,
    maxTotalAgents: 4,
    maxDepth: 1,
    allowModelSwitch: true,
    requireReview: true,
    members: [
      { name: 'auditor', role: 'researcher', taskKind: 'investigation', accessMode: 'read', workspace: 'inherit', modelTierHint: 'lightweight', brief: 'Inspect module interfaces read-only' },
      { name: 'implementer', role: 'engineer', taskKind: 'implementation', accessMode: 'write', writablePaths: ['src'], workspace: 'worktree', modelTierHint: 'strong', brief: 'Update src/moduleA.js inside isolated worktree' },
    ],
    nodeBindings: {
      coordinator: { nodeId: coordNode.node.id, bindingGeneration: coordNode.node.bindingGeneration },
      review: { nodeId: reviewerNode.node.id, bindingGeneration: reviewerNode.node.bindingGeneration },
    },
  };

  const s1Created = await callRoute(handleResponsibilityRoutes, {
    method: 'POST',
    pathname: '/api/responsibilities',
    body: {
      organizationId: org.id,
      projectId: project.id,
      objective: 'Audit modules in parallel then coordinate isolated Swarm feature update',
      successCriteria: ['Parallel read audit completed with lightweight tier', 'Isolated Swarm update promoted and ready for independent review'],
      idempotencyKey: 'e2e-s1-resp',
      policy: {
        providerId: GENERIC_PLANNER_PROVIDER.id,
        providerVersion: GENERIC_PLANNER_PROVIDER.version,
        providerDigest: GENERIC_PLANNER_PROVIDER.digest,
        projectFactId: s1ProjectFact.id,
        templateId: plannerFormula.id,
        templateVersion: plannerFormula.version,
        templateDigest: plannerFormula.digest,
        resource: { projectId: project.id, readScope: 'entire_project', networkPolicy: 'inherit_existing_permissions' },
        networkPermissionConfirmed: true,
        nodeBindings: { planning: { nodeId: plannerNode.node.id, bindingGeneration: plannerNode.node.bindingGeneration } },
        maxAttempts: 2,
        maxCost: 1.0,
        allowedPaths: ['src'],
        planCatalog: [s1FanoutEntry, s1SwarmEntry],
        planExecutionMaxAttempts: 6,
        planExecutionMaxCost: 4.0,
        planApproval: 'within_policy',
        planAutoAdmissionConfirmed: true,
        capabilityGates: {
          allowFanout: true,
          allowSwarm: true,
          allowWrite: true,
          allowModelSwitch: true,
        },
        modelTiering: {
          enabled: true,
          observationTier: 'lightweight',
          executionTier: 'strong',
          reviewTier: 'strong',
          maxTier: 'strong',
        },
        dailyBudget: { timeZone: 'UTC', maxRuns: 50, maxTokens: 100000, maxCost: 50 },
        validUntil,
      },
    },
  });
  equal(s1Created.statusCode, 200, 'S2.1 responsibility created');
  activeS1RespId = s1Created.body.responsibility.id;

  const s1Resumed = await responsibilityService.setResponsibilityLifecycle(activeS1RespId, 'resume', {
    expectedVersion: s1Created.body.responsibility.rowVersion,
    idempotencyKey: 'e2e-s1-resume',
  }, ownerActor);
  const s1WakeRes = await callRoute(handleResponsibilityRoutes, {
    method: 'POST',
    pathname: `/api/responsibilities/${encodeURIComponent(activeS1RespId)}/wake`,
    body: { expectedVersion: s1Resumed.responsibility.rowVersion, idempotencyKey: 'e2e-s1-wake' },
  });
  equal(s1WakeRes.statusCode, 200, 'S2.1 responsibility manual wake accepted');

  await respRuntime.tick();
  await scheduler.tick();
  await orchestrator.reconcile();
  await scheduler.tick();
  equal(s1PlannerDispatchCount, 1, 'S2.1 planner woke and produced bounded 2-step DAG');

  await responsibilityPlans.collectResponsibilityPlans();
  const s1PlansRes = await callRoute(handleResponsibilityRoutes, {
    method: 'GET',
    pathname: `/api/responsibilities/${encodeURIComponent(activeS1RespId)}/plans`,
  });
  equal(s1PlansRes.statusCode, 200);
  equal(s1PlansRes.body.plans.length, 1, 'Collected S2.1 Fanout+Swarm plan');
  const s1Plan = s1PlansRes.body.plans[0];
  equal(s1Plan.state, 'pending_review', 'Stage 2 Fanout+Swarm plan refuses silent auto-approval');

  const s1DetailPreApprove = (await responsibilityService.getResponsibility(activeS1RespId, ownerActor)).responsibility;
  const s1ApproveRes = await callRoute(handleResponsibilityRoutes, {
    method: 'POST',
    pathname: `/api/responsibilities/${encodeURIComponent(activeS1RespId)}/plans/${encodeURIComponent(s1Plan.id)}/approve`,
    body: {
      confirmed: true,
      expectedVersion: s1DetailPreApprove.rowVersion,
      proposalDigest: s1Plan.proposalDigest,
      idempotencyKey: 'e2e-s1-approve',
    },
  });
  equal(s1ApproveRes.statusCode, 200, 'Owner explicitly approved S2.1 plan');

  const admissionActor = { kind: 'service', role: 'responsibility_admission', principalId: `responsibility-admission:${OWNER_ID}` };
  const s1Admitted = await factoryAdmission.admitResponsibilityPlan({
    organizationId: org.id,
    projectId: project.id,
    planId: s1Plan.id,
    planDigest: s1Plan.proposalDigest,
    approvalId: s1ApproveRes.body.approvalId,
    commandId: `e2e-s1-admit-${s1Plan.id}`,
    idempotencyKey: `e2e-s1-admit-idem-${s1Plan.id}`,
  }, admissionActor);
  equal(s1Admitted.steps.length, 2, 'Admitted both Fan-out and Swarm steps');

  const s1FanoutCtx = await factoryAdmission.getAdmittedPlanStepExecution({
    organizationId: org.id,
    projectId: project.id,
    planId: s1Plan.id,
    stepId: 'step-fanout-audit',
  });
  const s1SwarmCtx = await factoryAdmission.getAdmittedPlanStepExecution({
    organizationId: org.id,
    projectId: project.id,
    planId: s1Plan.id,
    stepId: 'step-swarm-impl',
  });
  const s1CoordWorkId = s1SwarmCtx.mapping.coordinator;
  const s1ReviewWorkId = s1SwarmCtx.mapping.review;
  equal(s1FanoutCtx.items.length, 2, 'Fan-out instantiated 2 parallel Work Items');
  equal((await factoryControl.getFactoryWorkItem(org.id, s1CoordWorkId, ownerActor)).item.state, 'blocked', 'Swarm coordinator waits on Fan-out dependency');

  const s1BridgeSessions = new Map();
  const s1BridgeDeps = {
    getSession: sessionManager.getSession,
    createSession: async (cwd, tool, title, meta) => {
      const s = await sessionManager.createSession(cwd, tool, title, meta);
      s1BridgeSessions.set(s.id, { ...s });
      return s;
    },
    getRunState: runs.getRun,
    getRun: runs.getRun,
    getRunAcceptanceEvidence: runs.getRunAcceptanceEvidence,
    deliverSessionMessage: async (sessionId, msg) => ({ delivered: true, sessionId, preview: String(msg || '').slice(0, 60) }),
    updateSessionRuntime: async (sessionId, patch) => {
      const cur = s1BridgeSessions.get(sessionId) || await sessionManager.getSession(sessionId);
      if (cur) {
        Object.assign(cur, { tool: patch.tool, model: patch.model });
        s1BridgeSessions.set(sessionId, cur);
      }
    },
    runtimeCatalog: [
      { tool: 'codex', models: [{ id: 'gpt-5.4-nano' }, { id: 'gpt-5.4-mini' }, { id: 'gpt-5.4' }] },
      { tool: 'claude', models: [{ id: 'claude-haiku-4.5' }, { id: 'claude-sonnet-4.6' }, { id: 'claude-opus-4.6' }] },
    ],
  };

  // Blocked Swarm step must NOT start before Fan-out predecessor completes
  await rejectsWith(
    () => factoryAdmission.startAdmittedPlanSwarm(s1BridgeDeps, {
      organizationId: org.id,
      projectId: project.id,
      planId: s1Plan.id,
      stepId: 'step-swarm-impl',
      projectRoot: repoDir,
      idempotencyKey: 'e2e-s1-swarm-premature',
      actor: ownerActor,
    }),
    (err) => err?.statusCode === 409,
    'Blocked Swarm coordinator Work Item cannot spawn before predecessor completes',
  );

  // Execute Fan-out step with real cost-aware tiering + governor reservation & settlement
  const s1SliceTiers = {};
  const s1FanoutRun = await factoryAdmission.executeAdmittedPlanFanout({
    runStep: async ({ step, tiering, workItemId }) => {
      ok(workItemId, `Fan-out step ${step.key} carries persisted Work Item ID`);
      s1SliceTiers[step.key] = tiering;
      return {
        output: { summary: `audited:${step.key}:${tiering.selectedModel}` },
        usage: { inputTokens: 80, outputTokens: 40, totalTokens: 120, costUsd: 0.04 },
      };
    },
  }, {
    organizationId: org.id,
    projectId: project.id,
    planId: s1Plan.id,
    stepId: 'step-fanout-audit',
  });
  equal(s1FanoutRun.status, 'completed');
  equal(s1SliceTiers.slice_moduleA.resolvedTier, 'lightweight');
  equal(s1SliceTiers.slice_moduleA.selectedModel, 'gpt-5.4-nano');
  ok(s1FanoutRun.governorCounter.totals.cost >= 0.07, 'Governor budget counter settled Fan-out spend');
  ok(s1FanoutRun.aggregatedPacketId, 'Fan-out produced aggregated ResultPacket');

  // Complete & accept the 2 Fan-out Work Items via real Factory scheduler -> orchestrator -> manual acceptance
  const remainingSlices = new Set(['slice_moduleA', 'slice_moduleB']);
  for (let pass = 0; pass < 4 && remainingSlices.size > 0; pass += 1) {
    await scheduler.tick();
    await orchestrator.reconcile();
    await scheduler.tick();
    for (const sliceKey of [...remainingSlices]) {
      const wi = (await factoryControl.getFactoryWorkItem(org.id, s1FanoutCtx.mapping[sliceKey], ownerActor)).item;
      if (wi.state === 'review' && wi.candidateDigest) {
        acceptCounter += 1;
        await factoryAcceptance.decideFactoryManualAcceptance({
          organizationId: org.id,
          workItemId: wi.id,
          criterionId: wi.contract.acceptanceCriteria[0].id,
          decision: 'passed',
          rationale: `Verified S2.1 parallel audit ${sliceKey}`,
          contractRevision: wi.contractRevision,
          gateGeneration: wi.gateGeneration,
          candidateDigest: wi.candidateDigest,
          expectedVersion: wi.rowVersion,
          commandId: `cmd-s1-accept-${acceptCounter}`,
          idempotencyKey: `key-s1-accept-${acceptCounter}`,
        }, ownerActor);
        remainingSlices.delete(sliceKey);
      }
    }
  }
  equal(remainingSlices.size, 0, 'Both parallel Fan-out Work Items completed candidate review and accepted');

  // Stop scheduler momentarily so its lease yields cleanly for explicit dependency reconciliation & Swarm execution
  await scheduler.stop();
  const s1CoordBeforeUnblock = (await factoryControl.getFactoryWorkItem(org.id, s1CoordWorkId, ownerActor)).item;
  const s1SchedLease = await factoryControl.acquireFactorySchedulerLease({
    organizationId: org.id,
    ownerToken: 'e2e-s1-reconcile-lease',
    ttlMs: 60000,
  }, serviceActor);
  await reconcileFactoryDependencies({
    organizationId: org.id,
    workItemId: s1CoordWorkId,
    expectedVersion: s1CoordBeforeUnblock.rowVersion,
    leaseOwnerToken: s1SchedLease.ownerToken,
    leaseGeneration: s1SchedLease.generation,
  }, serviceActor);
  equal((await factoryControl.getFactoryWorkItem(org.id, s1CoordWorkId, ownerActor)).item.state, 'ready', 'Swarm coordinator unblocks once Fan-out predecessors accept');

  const s1StartedSwarm = await factoryAdmission.startAdmittedPlanSwarm(s1BridgeDeps, {
    organizationId: org.id,
    projectId: project.id,
    planId: s1Plan.id,
    stepId: 'step-swarm-impl',
    projectRoot: repoDir,
    idempotencyKey: 'e2e-s1-start-swarm',
    actor: ownerActor,
  });
  const s1Auditor = s1StartedSwarm.members.find((m) => m.name === 'auditor');
  const s1Implementer = s1StartedSwarm.members.find((m) => m.name === 'implementer');
  equal(s1Auditor.workspaceMode, 'inherit', 'Read Swarm member keeps inherit workspace');
  equal(s1Implementer.workspaceMode, 'worktree', 'Write Swarm member runs in isolated worktree');

  await swarmMod.markSwarmMemberState({ organizationId: org.id, nodeId: s1Auditor.nodeId, swarmState: 'waiting' });
  await swarmMod.markSwarmMemberState({ organizationId: org.id, nodeId: s1Implementer.nodeId, swarmState: 'waiting' });
  const s1Switched = await swarmBridge.switchWorkItemSwarmMemberTier(s1BridgeDeps, {
    organizationId: org.id,
    workItemId: s1CoordWorkId,
    actorNodeId: coordNode.node.id,
    targetNameOrNodeId: 'auditor',
    targetTier: 'standard',
    expectedBindingGeneration: 1,
    reason: 'Escalate auditor tier to standard for interface cross-check',
    projectRoot: repoDir,
    actor: ownerActor,
  });
  equal(s1Switched.tiering.resolvedTier, 'standard');
  equal(s1Switched.tiering.selectedModel, 'gpt-5.4-mini');
  equal((await orgStore.getNode(s1Auditor.nodeId)).bindingGeneration, 2, 'Controlled tier switch increments node bindingGeneration');

  // Implementer modifies src/moduleA.js ONLY in its isolated worktree and completes a canonical Run
  const mainModuleABefore = readFileSync(join(repoDir, 'src', 'moduleA.js'), 'utf8');
  writeFileSync(join(s1Implementer.workspacePath, 'src', 'moduleA.js'), 'export const a = 42;\n', 'utf8');
  equal(readFileSync(join(repoDir, 'src', 'moduleA.js'), 'utf8'), mainModuleABefore, 'Main working tree remains isolated from Swarm worker edits');

  const s1ImplNode = await orgStore.getNode(s1Implementer.nodeId);
  const s1ImplSession = (await sessionManager.getSession(s1ImplNode.currentSessionId)) || s1BridgeSessions.get(s1ImplNode.currentSessionId);
  const s1ImplReqId = 'req_e2e_s1_impl';
  const s1ImplRun = await runs.createRun({
    status: { sessionId: s1ImplSession.id, requestId: s1ImplReqId, tool: 'codex', model: 'gpt-5.4', effort: 'medium', state: 'running', startedAt: new Date().toISOString() },
    manifest: { sessionId: s1ImplSession.id, requestId: s1ImplReqId, projectId: project.id, folder: s1ImplSession.cwd || repoDir },
  }, { admissionSession: s1ImplSession });
  await completeReadOnlyRun({
    sessionId: s1ImplSession.id,
    runId: s1ImplRun.id,
    requestId: s1ImplReqId,
    summaryContent: 'Updated src/moduleA.js in isolated worktree',
    tokens: 160,
    costUsd: 0.04,
  });

  const s1Promoted = await swarmBridge.promoteSwarmWorkspaceToCandidate(s1BridgeDeps, {
    organizationId: org.id,
    targetNameOrNodeId: s1Implementer.nodeId,
    workItemId: s1CoordWorkId,
    runId: s1ImplRun.id,
    title: 'Stage 2 Swarm isolated moduleA update',
    objective: 'Deliver moduleA=42 from isolated worktree',
    actor: ownerActor,
  });
  equal(s1Promoted.workItem.state, 'review', 'Promoted Swarm worktree deliverable enters review state');

  acceptCounter += 1;
  await factoryAcceptance.decideFactoryManualAcceptance({
    organizationId: org.id,
    workItemId: s1CoordWorkId,
    criterionId: s1Promoted.workItem.contract.acceptanceCriteria[0].id,
    decision: 'passed',
    rationale: 'Verified isolated Swarm candidate diff',
    contractRevision: s1Promoted.workItem.contractRevision,
    gateGeneration: s1Promoted.workItem.gateGeneration,
    candidateDigest: s1Promoted.workItem.candidateDigest,
    expectedVersion: s1Promoted.workItem.rowVersion,
    commandId: `cmd-s1-accept-${acceptCounter}`,
    idempotencyKey: `key-s1-accept-${acceptCounter}`,
  }, ownerActor);

  const s1RevPre = (await factoryControl.getFactoryWorkItem(org.id, s1ReviewWorkId, ownerActor)).item;
  await reconcileFactoryDependencies({
    organizationId: org.id,
    workItemId: s1ReviewWorkId,
    expectedVersion: s1RevPre.rowVersion,
    leaseOwnerToken: s1SchedLease.ownerToken,
    leaseGeneration: s1SchedLease.generation,
  }, serviceActor);
  equal((await factoryControl.getFactoryWorkItem(org.id, s1ReviewWorkId, ownerActor)).item.state, 'ready', 'Independent review Work Item unblocks upon coordinator candidate acceptance');

  const s1Synthesis = await swarmBridge.completeWorkItemSwarm(s1BridgeDeps, {
    organizationId: org.id,
    workItemId: s1CoordWorkId,
    actorNodeId: coordNode.node.id,
    summary: 'Swarm workers audited and promoted isolated src/moduleA.js update',
    markDone: false,
    actor: ownerActor,
  });
  ok(s1Synthesis.resultPacket?.packetId, 'completeWorkItemSwarm emits immutable ResultPacket');

  // Cleanly pause S2.1 responsibility, release manual reconciliation lease, and restart scheduler before Scenario 2
  await responsibilityService.setResponsibilityLifecycle(activeS1RespId, 'pause', {
    expectedVersion: (await responsibilityService.getResponsibility(activeS1RespId, ownerActor)).responsibility.rowVersion,
    idempotencyKey: 'e2e-s1-pause',
  }, ownerActor);
  activeS1RespId = null;
  await factoryControl.releaseFactorySchedulerLease({
    organizationId: org.id,
    ownerToken: s1SchedLease.ownerToken,
    generation: s1SchedLease.generation,
  }, serviceActor);
  await scheduler.start();

  // ── Scenario 2 (S2.2): Periodic No-Change LLM Skip vs Manual / File Change / Durable Producer Event ──
  const obsCatalogEntry = {
    entryId: 'obs_report_docs',
    capability: 'project-report',
    templateId: reportFormula.id,
    templateVersion: reportFormula.version,
    templateDigest: reportFormula.digest,
    resource: { projectId: project.id, readScope: 'entire_project', networkPolicy: 'inherit_existing_permissions' },
    nodeBindings: { report: { nodeId: reporterNode.node.id, bindingGeneration: reporterNode.node.bindingGeneration } },
    maxAttempts: 2,
    maxCost: 4.0,
    autoApproval: true,
    requiresHumanApproval: false,
  };
  const obsRespCreated = await callRoute(handleResponsibilityRoutes, {
    method: 'POST',
    pathname: '/api/responsibilities',
    body: {
      organizationId: org.id,
      projectId: project.id,
      objective: 'Monitor project docs & trigger on real changes or durable Run terminal events',
      successCriteria: ['Skip LLM when fingerprint unchanged', 'Trigger on manual wake, workspace edit, or pruned producer event'],
      idempotencyKey: 'e2e-s2-obs-resp',
      intervalMs: 60000,
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
        maxCost: 4.0,
        planCatalog: [obsCatalogEntry],
        planExecutionMaxAttempts: 4,
        planExecutionMaxCost: 8.0,
        planApproval: 'within_policy',
        planAutoAdmissionConfirmed: true,
        workspaceFingerprint: { enabled: true, paths: ['README.md', 'docs', 'src'], maxFiles: 100, maxDepth: 5 },
        externalResourceWatermarks: { enabled: true, requiredResourceKeys: ['ci:docs-sync'] },
        dailyBudget: { timeZone: 'UTC', maxRuns: 50, maxTokens: 100000, maxCost: 50 },
        validUntil,
      },
    },
  });
  equal(obsRespCreated.statusCode, 200, 'S2.2 responsibility created');
  activeObsRespId = obsRespCreated.body.responsibility.id;

  const wmRes = await callRoute(handleResponsibilityRoutes, {
    method: 'POST',
    pathname: `/api/responsibilities/${encodeURIComponent(activeObsRespId)}/external-watermarks`,
    body: { source: 'ci', resourceKey: 'ci:docs-sync', watermarkValue: 'v1' },
  });
  equal(wmRes.statusCode, 200, 'Initial external watermark recorded');

  const obsResumed = await responsibilityService.setResponsibilityLifecycle(activeObsRespId, 'resume', {
    expectedVersion: obsRespCreated.body.responsibility.rowVersion,
    idempotencyKey: 'e2e-s2-obs-resume',
  }, ownerActor);

  const evtBindRes = await callRoute(handleResponsibilityRoutes, {
    method: 'POST',
    pathname: `/api/responsibilities/${encodeURIComponent(activeObsRespId)}/trigger-bindings`,
    body: {
      type: 'event',
      eventType: 'run_terminal',
      source: { kind: 'root_session' },
      observeFrom: 'binding_created',
      expectedVersion: obsResumed.responsibility.rowVersion,
      confirmed: true,
      idempotencyKey: 'e2e-s2-obs-event-bind',
    },
  });
  equal(evtBindRes.statusCode, 200, 'Durable root_session run_terminal trigger binding created');

  async function fireIntervalWake() {
    await responsibilityStore.transaction((db) => {
      db.prepare('UPDATE responsibility_subscriptions SET next_due_at=? WHERE responsibility_id=?')
        .run(new Date(Date.now() - 1000).toISOString(), activeObsRespId);
    });
    await respRuntime.tick();
  }

  async function driveObsCycle() {
    await scheduler.tick();
    await orchestrator.reconcile();
    await scheduler.tick();
    await respRuntime.tick();
    await scheduler.tick();
    await orchestrator.reconcile();
    await scheduler.tick();
    const links = await responsibilityService.listResponsibilityWorkLinks(activeObsRespId, ownerActor);
    for (const link of links.links) {
      for (const wiId of link.workItemIds || []) {
        const detail = await factoryControl.getFactoryWorkItem(org.id, wiId, ownerActor);
        if (detail.item.kind === 'execution' && detail.item.state === 'review' && detail.item.candidateDigest) {
          acceptCounter += 1;
          await factoryAcceptance.decideFactoryManualAcceptance({
            organizationId: org.id,
            workItemId: detail.item.id,
            criterionId: detail.item.contract.acceptanceCriteria[0].id,
            decision: 'passed',
            rationale: 'Verified S2.2 report step',
            contractRevision: detail.item.contractRevision,
            gateGeneration: detail.item.gateGeneration,
            candidateDigest: detail.item.candidateDigest,
            expectedVersion: detail.item.rowVersion,
            commandId: `cmd-s2-accept-${acceptCounter}`,
            idempotencyKey: `key-s2-accept-${acceptCounter}`,
          }, ownerActor);
        }
      }
    }
    await respRuntime.tick();
  }

  // Wake 1 (interval, no baseline): evaluates LLM planner once
  await fireIntervalWake();
  await driveObsCycle();
  equal(plannerDispatchCount, 1, 'Wake 1 evaluates planner');
  equal(reportDispatchCount, 1, 'Wake 1 executes report');

  // Wake 2 (interval, unchanged): deterministically skips LLM planning
  await fireIntervalWake();
  equal(plannerDispatchCount, 1, 'Unchanged periodic wake skips LLM planning');

  // Wake 3 (manual wake with unchanged workspace): bypasses skip
  const preManual = (await responsibilityService.getResponsibility(activeObsRespId, ownerActor)).responsibility;
  const manualRes = await callRoute(handleResponsibilityRoutes, {
    method: 'POST',
    pathname: `/api/responsibilities/${encodeURIComponent(activeObsRespId)}/wake`,
    body: { expectedVersion: preManual.rowVersion, idempotencyKey: 'e2e-s2-manual-wake' },
  });
  equal(manualRes.statusCode, 200, 'Manual wake accepted');
  await respRuntime.tick();
  await driveObsCycle();
  equal(plannerDispatchCount, 2, 'Manual wake triggers LLM planning despite unchanged fingerprint');

  // Wake 4 (interval after uncommitted file edit): triggers LLM planning
  writeFileSync(join(repoDir, 'docs', 'status.md'), 'Status: updated-uncommitted\n', 'utf8');
  await fireIntervalWake();
  await driveObsCycle();
  equal(plannerDispatchCount, 3, 'Uncommitted workspace file change triggers LLM planning');

  // Wake 5 (durable producer event when raw Run is pruned before first poll): triggers LLM planning
  const prunedRun = await runs.createRun({
    status: { sessionId: rootSession.id, requestId: 'req_e2e_pruned_terminal', tool: 'codex', model: 'gpt-5.3-codex', effort: 'medium', state: 'running', startedAt: new Date().toISOString() },
    manifest: { sessionId: rootSession.id, requestId: 'req_e2e_pruned_terminal', projectId: project.id, folder: repoDir },
  });
  await completeReadOnlyRun({
    sessionId: rootSession.id,
    runId: prunedRun.id,
    requestId: 'req_e2e_pruned_terminal',
    summaryContent: 'Root run finished before prune',
  });
  const removed = await runs.removeRunsForSession(rootSession.id);
  ok(removed.includes(prunedRun.id), 'Raw Run pruned from disk before first event poll');
  await responsibilityEvents.processResponsibilityTriggerEvents();
  await respRuntime.tick();
  await driveObsCycle();
  equal(plannerDispatchCount, 4, 'Durable producer event survives raw Run pruning and triggers evaluation');

  // Symlink escape guard during periodic wake fails closed without calling LLM
  const escapePath = join(repoDir, 'docs', 'e2e-escape');
  try {
    symlinkSync(outsideDir, escapePath, process.platform === 'win32' ? 'junction' : 'dir');
    await fireIntervalWake();
    equal(plannerDispatchCount, 4, 'Symlink escape fails closed without calling LLM');
  } finally {
    rmSync(escapePath, { recursive: true, force: true });
  }

  const obsGet = await callRoute(handleResponsibilityRoutes, {
    method: 'GET',
    pathname: `/api/responsibilities/${encodeURIComponent(activeObsRespId)}/observations`,
  });
  equal(obsGet.statusCode, 200);
  ok(obsGet.body.changeObservations.some((o) => o.outcome === 'no_change_skipped'), 'Verifiable no_change_skipped observation persisted');

  await responsibilityService.setResponsibilityLifecycle(activeObsRespId, 'pause', {
    expectedVersion: (await responsibilityService.getResponsibility(activeObsRespId, ownerActor)).responsibility.rowVersion,
    idempotencyKey: 'e2e-s2-obs-pause',
  }, ownerActor);
  activeObsRespId = null;

  // ── Scenario 3 (S2.3): Mid-Flight Goal-DAG Revision, Artifact Reuse & Generation Fencing ──
  await scheduler.stop();
  scheduler = null;
  await respRuntime.stop();
  respRuntime = null;

  const dagGoal = (await executeWorkGraphCommand({
    organizationId: org.id,
    type: 'CreateGoal',
    commandId: 'cmd-e2e-dag-goal',
    idempotencyKey: 'key-e2e-dag-goal',
    payload: { projectId: project.id, objective: 'Stage 2 E2E Diamond Goal-DAG', acceptanceBaseline: ['Artifacts verified'] },
  }, ownerActor)).goal;

  const dagContract = (objective) => ({
    objective,
    accessMode: 'write',
    allowedPaths: ['docs', 'src'],
    acceptanceCriteria: [{ id: 'manual-ok', method: 'manual' }],
  });
  async function mkDagNode(key, objective, deps = []) {
    return (await executeWorkGraphCommand({
      organizationId: org.id,
      type: 'CreateWorkItem',
      commandId: `cmd-e2e-dag-${key}`,
      idempotencyKey: `key-e2e-dag-${key}`,
      payload: { goalId: dagGoal.id, kind: 'execution', assigneeNodeId: writerNode.node.id, contract: dagContract(objective), dependencies: deps },
    }, ownerActor)).item;
  }

  // Topology: nodeA (completed) -> nodeC (completed) -> nodeD (running) -> nodeE (blocked); nodeB (completed sibling)
  const nodeA = await mkDagNode('A', 'Upstream foundation');
  const nodeB = await mkDagNode('B', 'Independent completed sibling');
  const nodeC = await mkDagNode('C', 'Branch C depending on A', [{ predecessorId: nodeA.id, milestone: 'accepted' }]);
  const nodeD = await mkDagNode('D', 'Mid-flight running D depending on C', [{ predecessorId: nodeC.id, milestone: 'accepted' }]);
  const nodeE = await mkDagNode('E', 'Downstream E depending on D', [{ predecessorId: nodeD.id, milestone: 'accepted' }]);

  const candA = createHash('sha256').update('e2e-cand-A').digest('hex');
  const candB = createHash('sha256').update('e2e-cand-B').digest('hex');
  const candC = createHash('sha256').update('e2e-cand-C').digest('hex');
  const dagStagingD = join(tempRoot, 'e2e-staging-d');
  mkdirSync(join(dagStagingD, 'docs'), { recursive: true });
  writeFileSync(join(dagStagingD, 'docs', 'stale.md'), 'stale output\n', 'utf8');

  let staleFenceD = null;
  await workGraphStore.factoryTransaction((db) => {
    const ts = new Date().toISOString();
    for (const [it, dig, integrated] of [[nodeA, candA, true], [nodeB, candB, false], [nodeC, candC, false]]) {
      db.prepare("UPDATE factory_work_items SET state='completed',control_state='none',execution_epoch=1,binding_generation=1,gate_generation=1,candidate_digest=?,row_version=row_version+1,updated_at=? WHERE id=?")
        .run(dig, ts, it.id);
      db.prepare('INSERT INTO factory_candidates VALUES(?,?,?,?,?,?,?,?)')
        .run(`cand_${it.id}`, it.id, 1, 1, 1, dig, JSON.stringify({ verified: true }), ts);
      db.prepare('INSERT INTO factory_acceptance_decisions VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(`acc_${it.id}`, it.id, 1, dig, 1, 'manual-ok', 'passed', ownerActor.principalId, JSON.stringify([{ kind: 'owner_manual_review' }]), ts);
      if (integrated) {
        db.prepare('INSERT INTO factory_delivery_milestones VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(`mile_${it.id}`, org.id, it.id, 1, 1, 1, dig, 'integrated', `op_${it.id}`, 'main', dig, dig, JSON.stringify({ verified: true }), ts);
      }
    }
    db.prepare("UPDATE factory_work_items SET state='running',control_state='none',execution_epoch=1,binding_generation=1,gate_generation=0,row_version=row_version+1,updated_at=? WHERE id=?")
      .run(ts, nodeD.id);
    const dRow = db.prepare('SELECT * FROM factory_work_items WHERE id=?').get(nodeD.id);
    staleFenceD = { rowVersion: dRow.row_version, contractRevision: dRow.contract_revision, executionEpoch: dRow.execution_epoch, bindingGeneration: dRow.binding_generation, gateGeneration: dRow.gate_generation, goalRevision: 1 };
    db.prepare('INSERT INTO factory_execution_bindings VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('bind_e2e_d', nodeD.id, 1, 1, 1, 'disp_e2e_d', 'running', 'collab_e2e_d', nodeD.id, 'att_e2e_d', 'run_e2e_d', JSON.stringify({}), ts, ts);
    db.exec(`CREATE TABLE IF NOT EXISTS factory_candidate_payloads (
      candidate_id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL, contract_revision INTEGER NOT NULL,
      execution_epoch INTEGER NOT NULL, binding_generation INTEGER NOT NULL, run_id TEXT NOT NULL,
      baseline_digest TEXT NOT NULL, files_json TEXT NOT NULL, digest TEXT NOT NULL, created_at TEXT NOT NULL
    );`);
    const bJson = JSON.stringify({ workspace: { stagingDir: dagStagingD, canonicalCwd: repoDir, writablePaths: ['docs'] }, source: { head: '0'.repeat(40), branch: 'main' }, files: [] });
    const bDig = createHash('sha256').update(JSON.stringify({ workItemId: nodeD.id, contractRevision: 1, executionEpoch: 1, bindingGeneration: 1, runId: '', baselineDigest: '', filesJson: bJson })).digest('hex');
    db.prepare('INSERT INTO factory_candidate_payloads VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run('baseline:disp_e2e_d', nodeD.id, 1, 1, 1, '', '', bJson, bDig, ts);
  });

  const revPreview = await callRoute(handleFactoryRoutes, {
    method: 'POST',
    pathname: `/api/organizations/${encodeURIComponent(org.id)}/factory/goals/${encodeURIComponent(dagGoal.id)}/revision/preview`,
    body: { expectedVersion: 1, affectedRootIds: [nodeC.id] },
  });
  equal(revPreview.statusCode, 200, 'Goal-DAG partial revision preview succeeds');
  deepEqual(revPreview.body.affectedItemIds, [nodeC.id, nodeD.id, nodeE.id].sort(), 'Invalidates only C and downstream {D, E}');
  deepEqual(revPreview.body.unaffectedItemIds, [nodeA.id, nodeB.id].sort(), 'Preserves unaffected {A, B}');
  equal(revPreview.body.reusableArtifacts.length, 2, 'Marks both unaffected completed items as reusable');

  const revCommit = await callRoute(handleFactoryRoutes, {
    method: 'POST',
    pathname: `/api/organizations/${encodeURIComponent(org.id)}/factory/goals/${encodeURIComponent(dagGoal.id)}/revision/commit`,
    body: {
      commandId: 'cmd-e2e-dag-commit',
      idempotencyKey: 'key-e2e-dag-commit',
      expectedVersion: 1,
      affectedRootIds: [nodeC.id],
      impactDigest: revPreview.body.impactDigest,
      objective: 'Stage 2 E2E Diamond Goal-DAG (C revised)',
      acceptanceBaseline: ['Artifacts verified', 'C revised'],
    },
  });
  equal(revCommit.statusCode, 200, 'Goal-DAG partial revision commit succeeds');
  equal(revCommit.body.goalRevision, 2);

  const staleRunD = await runs.createRun({
    status: { sessionId: writerNode.session.id, requestId: 'req_e2e_stale_d', tool: 'codex', model: 'gpt-5.3-codex', effort: 'medium', state: 'running', startedAt: new Date().toISOString() },
    manifest: { sessionId: writerNode.session.id, requestId: 'req_e2e_stale_d', projectId: project.id, folder: repoDir },
  });
  await completeReadOnlyRun({ sessionId: writerNode.session.id, runId: staleRunD.id, requestId: 'req_e2e_stale_d', summaryContent: 'stale output' });

  await rejectsWith(
    () => factoryCandidates.sealFactoryCandidate({
      context: { ...staleFenceD, workItemId: nodeD.id, dispatchKey: 'disp_e2e_d' },
      workspace: { stagingDir: dagStagingD, canonicalCwd: repoDir, writablePaths: ['docs'] },
      runId: staleRunD.id,
    }),
    (err) => err?.code === 'FACTORY_WORK_INVALIDATED' && err?.statusCode === 409,
    'Stale generation attempt cannot seal candidate after Goal-DAG invalidation',
  );

  const dAfterRev = await workGraphStore.factoryRead((db) => db.prepare('SELECT row_version,control_state FROM factory_work_items WHERE id=?').get(nodeD.id));
  equal(dAfterRev.control_state, 'cancel_requested', 'Running invalidated node D transitions to cancel_requested');
  await rejectsWith(
    () => factoryControl.updateFactoryBinding({
      organizationId: org.id,
      workItemId: nodeD.id,
      expectedVersion: dAfterRev.row_version,
      contractRevision: staleFenceD.contractRevision,
      executionEpoch: staleFenceD.executionEpoch,
      bindingGeneration: staleFenceD.bindingGeneration,
      action: 'submit_candidate',
      payload: { candidateId: 'cand_stale', digest: 'b'.repeat(64) },
    }, serviceActor, { verifyCandidate: () => ({ digest: 'b'.repeat(64), terminalEvidenceRef: `run:${staleRunD.id}` }) }),
    (err) => err?.code === 'FACTORY_WORK_INVALIDATED' && err?.statusCode === 409,
    'Stale attempt fenced out of submit_candidate',
  );

  // Replacement nodeC_v2 depending on preserved nodeA immediately becomes ready upon approval!
  const nodeCv2 = await mkDagNode('Cv2', 'Replacement branch C_v2', [{ predecessorId: nodeA.id, milestone: 'accepted' }]);
  const approvedCv2 = await executeWorkGraphCommand({
    organizationId: org.id,
    type: 'ApproveContract',
    commandId: 'cmd-e2e-approve-cv2',
    idempotencyKey: 'key-e2e-approve-cv2',
    targetId: nodeCv2.id,
    expectedVersion: nodeCv2.rowVersion,
    payload: {},
  }, ownerActor);
  equal(approvedCv2.item.state, 'ready', 'Replacement branch reuses preserved completed upstream nodeA artifact');

  ok(typeof factoryGoalRevision.getFactoryGoalRevisionArtifacts === 'function' && typeof getResponsibilityCapabilities === 'function' && typeof responsibilityPlans.collectResponsibilityPlans === 'function', 'Stage 2 modules loaded cleanly');

  console.log(`test-stage2-e2e-acceptance: ok (${assertions} assertions)`);
} finally {
  try { if (scheduler) await scheduler.stop(); } catch {}
  try { if (respRuntime) await respRuntime.stop(); } catch {}
  try { sessionManager.killAll(); } catch {}
  try { await resultPackets.closeResultPacketStore(); } catch {}
  try { await orgStore.closeOrganizationDatabase?.(); } catch {}
  try { rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
}
