#!/usr/bin/env node
// Stage 2 S2.2 & S2.3 Focused Acceptance Suite:
// - S2.2 Durable producer-side event retention, deduplication, bounded retention, cursor recovery
// - S2.2 Bounded workspace & external resource change fingerprint + deterministic LLM skip (no_change_skipped)
// - S2.3 Goal-DAG generalized revision, unaffected artifact reuse (reusableArtifacts), generation/version fencing
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { Readable } from 'node:stream';

const baseTmp = process.env.RAGENT_TEST_TMPDIR || process.env.TMPDIR || process.env.TEMP || tmpdir();
mkdirSync(baseTmp, { recursive: true });
const tempRoot = mkdtempSync(join(baseTmp, 'ragent-stage2-obs-dag-'));
const instanceRoot = join(tempRoot, 'instance');
const configDir = join(instanceRoot, 'config');
const dataDir = join(instanceRoot, 'data');
const workRootDir = join(instanceRoot, 'workspace');
const memoryDir = join(instanceRoot, 'memory');
const harnessRoot = join(tempRoot, 'harnesses');
const harnessBin = join(harnessRoot, 'codex', 'node_modules', '.bin');
const repoDir = join(tempRoot, 'repo');
const outsideDir = join(tempRoot, 'outside-secret');

const OWNER_ID = 'owner-stage2-obs';

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
process.env.RAGENT_AUTH_SESSION_SECRET = 'stage2-obs-dag-test-secret-123456';
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
mkdirSync(join(repoDir, 'src', 'nested'), { recursive: true });
mkdirSync(outsideDir, { recursive: true });

writeFileSync(join(harnessBin, 'codex'), '#!/bin/sh\necho "0.114.0"\n', 'utf8');
try { chmodSync(join(harnessBin, 'codex'), 0o755); } catch {}
if (process.platform === 'win32') {
  writeFileSync(join(harnessBin, 'codex.cmd'), '@echo off\r\necho 0.114.0\r\n', 'utf8');
}
process.env.PATH = `${harnessBin}${delimiter}${process.env.PATH || ''}`;

execFileSync('git', ['init', '-b', 'main', repoDir], { stdio: 'ignore' });
execFileSync('git', ['-C', repoDir, 'config', 'user.email', 'stage2-obs@example.com'], { stdio: 'ignore' });
execFileSync('git', ['-C', repoDir, 'config', 'user.name', 'Stage2 Obs'], { stdio: 'ignore' });
execFileSync('git', ['-C', repoDir, 'remote', 'add', 'origin', 'https://github.com/ragent-app/Ragent_product.git'], { stdio: 'ignore' });
writeFileSync(join(repoDir, 'README.md'), '# Stage 2 Obs & DAG\nBaseline.\n', 'utf8');
writeFileSync(join(repoDir, 'docs', 'status.md'), 'status=v1\n', 'utf8');
writeFileSync(join(repoDir, 'src', 'a.js'), 'export const a = 1;\n', 'utf8');
writeFileSync(join(repoDir, 'src', 'nested', 'b.js'), 'export const b = 2;\n', 'utf8');
writeFileSync(join(outsideDir, 'secret.txt'), 'SECRET_OUTSIDE_ROOT\n', 'utf8');
execFileSync('git', ['-C', repoDir, 'add', '.'], { stdio: 'ignore' });
execFileSync('git', ['-C', repoDir, 'commit', '-m', 'initial baseline'], { stdio: 'ignore' });

writeFileSync(join(configDir, 'auth.json'), JSON.stringify({ username: 'owner', passwordHash: 'unused-fixture' }), 'utf8');

const projects = await import('../chat/projects.mjs');
const appsMod = await import('../chat/apps.mjs');
const sessionManager = await import('../chat/session-manager.mjs');
const history = await import('../chat/history.mjs');
const runs = await import('../chat/runs.mjs');
const orgStore = await import('../chat/organization-store.mjs');
const orgMessaging = await import('../chat/organization-messaging.mjs');
const governor = await import('../chat/organization-governor.mjs');
const { createCollaborationOrchestrator } = await import('../chat/collaboration-orchestrator.mjs');
const { createFactoryExecutionAdapter } = await import('../chat/factory-execution-adapter.mjs');
const { createFactoryScheduler } = await import('../chat/factory-scheduler.mjs');
const factoryControl = await import('../chat/factory-control.mjs');
const factoryAcceptance = await import('../chat/factory-acceptance.mjs');
const factoryCandidates = await import('../chat/factory-candidates.mjs');
const workGraphStore = await import('../chat/work-graph-store.mjs');
const { executeWorkGraphCommand } = await import('../chat/work-graph.mjs');
const factoryGoalRevision = await import('../chat/factory-goal-revision.mjs');
const responsibilityStore = await import('../chat/responsibility-store.mjs');
const responsibilityService = await import('../chat/responsibility-service.mjs');
const responsibilityRuntimeMod = await import('../chat/responsibility-runtime.mjs');
const responsibilityEvents = await import('../chat/responsibility-trigger-events.mjs');
const responsibilityTriggerBridge = await import('../chat/responsibility-trigger-bridge.mjs');
const responsibilityGitObs = await import('../chat/responsibility-git-observation.mjs');
const responsibilityProject = await import('../chat/responsibility-project.mjs');
const responsibilityPlans = await import('../chat/responsibility-plans.mjs');
const { GENERIC_PLANNER_PROVIDER, PROJECT_REPORT_PROVIDER } = await import('../chat/responsibility-providers.mjs');
const { getFactoryFormula } = await import('../chat/factory-workflow.mjs');
const { handleResponsibilityRoutes } = await import('../chat/router-responsibility-routes.mjs');
const { handleFactoryRoutes } = await import('../chat/router-factory-routes.mjs');
const auth = await import('../lib/auth.mjs');

const ownerToken = await auth.issueSession({ role: 'owner', username: 'owner' });
const ownerCookieHeader = auth.setCookie(ownerToken).split(';')[0];
const ownerAuthSession = auth.getAuthSession({ headers: { cookie: ownerCookieHeader }, socket: { encrypted: false } }) || { role: 'owner' };

let assertions = 0;
const a = new Proxy(assert, {
  get(target, prop) {
    const val = target[prop];
    if (typeof val === 'function') {
      return (...args) => {
        assertions += 1;
        return val.apply(target, args);
      };
    }
    return val;
  },
});

const OWNER_ACTOR = { kind: 'user', role: 'owner', principalId: OWNER_ID };
const SERVICE_ACTOR = { kind: 'service', role: 'factory_scheduler', principalId: `factory-scheduler:${OWNER_ID}`, authorizingPrincipalId: OWNER_ID };

async function callRoute(handler, { method = 'GET', pathname, body = null, authSession = ownerAuthSession, cookie = ownerCookieHeader } = {}) {
  const raw = body !== null ? JSON.stringify(body) : '';
  const req = Readable.from(raw ? [Buffer.from(raw, 'utf8')] : []);
  req.method = method;
  req.url = pathname;
  req.headers = {
    host: '127.0.0.1:7690',
    ...(cookie ? { cookie } : {}),
    ...(raw ? { 'content-type': 'application/json' } : {}),
  };
  req.socket = { encrypted: false, remoteAddress: '127.0.0.1' };
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
  const handled = await handler({
    req,
    res,
    pathname: pathname.split('?')[0],
    authSession,
    writeJson,
    requireSessionAccess: async () => true,
  });
  return { handled, statusCode, body: responseBody ? JSON.parse(responseBody) : null };
}

function futureIso(days = 30) {
  return new Date(Date.now() + days * 86400000).toISOString();
}

async function finalizeRun(sessionId, runId, requestId, { state = 'completed', summary = 'done', tokens = 80, costUsd = 0.01 } = {}) {
  if (state === 'completed') {
    await history.appendEvent(sessionId, {
      type: 'message',
      role: 'assistant',
      messagePhase: 'final_answer',
      providerMessageId: `msg_${runId}`,
      content: summary,
      runId,
      requestId,
      timestamp: Date.now(),
    });
  }
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
  const doneAt = new Date().toISOString();
  await runs.writeRunResult(runId, { exitCode: state === 'completed' ? 0 : 1, signal: null, completedAt: doneAt });
  await runs.updateRun(runId, current => ({
    ...current,
    state,
    completedAt: doneAt,
    finalizedAt: doneAt,
    ...(state !== 'completed' ? { failureReason: `simulated_${state}` } : {}),
  }));
}

let scheduler = null;
let respRuntime = null;

try {
  await orgStore.initializeOrganizationStore();
  await governor.initializeOrganizationGovernor();

  const project = await projects.createProject({ name: 'Stage2 Obs & DAG Project', rootPath: repoDir });
  const specialistApp = await appsMod.createApp({
    name: 'Stage2 Obs Specialist',
    tool: 'codex',
    collaborationPolicy: { role: 'specialist', canDelegate: false, revision: 'obs-spec-1' },
  });
  const writerApp = await appsMod.createApp({
    name: 'Stage2 Obs Writer',
    tool: 'codex',
    collaborationPolicy: { role: 'writer', canDelegate: false, writablePaths: ['docs', 'src'], revision: 'obs-writer-1' },
  });

  const rootSession = await sessionManager.createSession(repoDir, 'codex', 'Stage2 Obs Root Session', {
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
    budget: { maxTotalRuns: 100, maxTokens: 500000, maxCost: 200 },
    idempotencyKey: 'stage2-obs-dag-org',
  });
  process.env.RAGENT_FACTORY_ORGANIZATIONS = org.id;

  await orgStore.createRevision(org.id, {
    revision: 1,
    proposal: { nodes: [], edges: [] },
    compiled: { nodes: [], edges: [] },
  });
  await orgStore.freezeRevision(org.id, 1);

  async function bindOrgNode(stableKey, role, app, grant) {
    const roleInst = await orgStore.createRoleInstance({
      organizationId: org.id,
      organizationRevision: 1,
      stableKey,
      role,
      agentId: app.id,
      lifecycleState: 'active',
      idempotencyKey: `role-${stableKey}`,
    });
    const node = await orgStore.createNode({
      organizationId: org.id,
      stableKey,
      nodeRole: role,
      createdRevision: 1,
      lifecycleState: 'active',
      lifecycleMode: 'formal_org',
      grant,
      roleInstanceId: roleInst.id,
      bindingGeneration: 1,
      sessionClass: 'WORKER',
    });
    await orgStore.bindRoleInstanceNode(roleInst.id, node.id);
    const sess = await sessionManager.createSession(repoDir, 'codex', `Node ${stableKey}`, {
      projectId: project.id,
      templateId: app.id,
      sessionPlane: 'organization',
      sessionClass: 'WORKER',
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
    });
    await orgStore.bindNodeSession(node.id, { sessionId: sess.id, bindingGeneration: 1 });
    const bound = await orgStore.getNode(node.id);
    await orgStore.materializeFrozenNodeGrants({
      organizationId: org.id,
      nodeId: bound.id,
      revision: 1,
      expectedGrant: grant,
    });
    return { node: bound, session: sess };
  }

  const plannerNode = await bindOrgNode('planner', 'specialist', specialistApp, {
    canWrite: false, canReview: false, allowedCapabilities: ['read', 'run'], projectId: project.id,
  });
  const reporterNode = await bindOrgNode('reporter', 'specialist', specialistApp, {
    canWrite: false, canReview: false, allowedCapabilities: ['read', 'run'], projectId: project.id,
  });
  const writerNode = await bindOrgNode('writer', 'writer', writerApp, {
    canWrite: true, canReview: false, writablePaths: ['docs', 'src'], allowedCapabilities: ['read', 'write', 'run'], projectId: project.id,
  });

  const plannerFormula = getFactoryFormula('ragent-responsibility-planner', 1);
  const reportFormula = getFactoryFormula('ragent-project-report', 1);

  const reportCatalogEntry = {
    entryId: 'report-docs',
    capability: 'project-report',
    templateId: reportFormula.id,
    templateVersion: reportFormula.version,
    templateDigest: reportFormula.digest,
    resource: { projectId: project.id, readScope: 'entire_project', networkPolicy: 'inherit_existing_permissions' },
    nodeBindings: { report: { nodeId: reporterNode.node.id, bindingGeneration: reporterNode.node.bindingGeneration } },
    maxAttempts: 2,
    maxCost: 5,
    autoApproval: true,
    requiresHumanApproval: false,
  };

  // =========================================================================
  // GROUP 1: S2.2 Durable Producer-Side Event Retention & Cursor Recovery
  // =========================================================================
  console.log('[Group 1] S2.2 Durable producer-side event retention & cursor recovery');

  const respEventRes = await callRoute(handleResponsibilityRoutes, {
    method: 'POST',
    pathname: '/api/responsibilities',
    body: {
      organizationId: org.id,
      projectId: project.id,
      objective: 'Observe root runs and org events reliably',
      successCriteria: ['Zero missed terminal events when raw runs are pruned'],
      idempotencyKey: 'create-resp-events',
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
        maxCost: 5,
        planExecutionMaxAttempts: 4,
        planExecutionMaxCost: 10,
        planApproval: 'within_policy',
        planAutoAdmissionConfirmed: true,
        planCatalog: [reportCatalogEntry],
        dailyBudget: { timeZone: 'UTC', maxRuns: 50, maxCost: 100 },
        validUntil: futureIso(30),
      },
    },
  });
  a.equal(respEventRes.statusCode, 200, `create event resp: ${JSON.stringify(respEventRes.body)}`);
  const respEventId = respEventRes.body.responsibility.id;
  const resumedEventResp = await responsibilityService.setResponsibilityLifecycle(respEventId, 'resume', {
    expectedVersion: respEventRes.body.responsibility.rowVersion,
    idempotencyKey: 'resume-resp-events',
  }, OWNER_ACTOR);

  const eventTriggerRes = await callRoute(handleResponsibilityRoutes, {
    method: 'POST',
    pathname: `/api/responsibilities/${encodeURIComponent(respEventId)}/trigger-bindings`,
    body: {
      type: 'event',
      eventType: 'run_terminal',
      source: { kind: 'root_session' },
      observeFrom: 'binding_created',
      expectedVersion: resumedEventResp.responsibility.rowVersion,
      confirmed: true,
      idempotencyKey: 'bind-root-run-terminal',
    },
  });
  a.equal(eventTriggerRes.statusCode, 200, `event trigger binding created: ${JSON.stringify(eventTriggerRes.body)}`);
  const eventBindingId = eventTriggerRes.body.binding.id;

  // Create & finalize a Run on rootSession AFTER binding_created, then DELETE it from disk BEFORE first poll!
  const prunedRun = await runs.createRun({
    status: {
      sessionId: rootSession.id,
      requestId: 'req_pruned_before_poll',
      tool: 'codex',
      model: 'gpt-5.3-codex',
      effort: 'medium',
      state: 'running',
      startedAt: new Date().toISOString(),
    },
    manifest: { sessionId: rootSession.id, requestId: 'req_pruned_before_poll', projectId: project.id, folder: repoDir },
  });
  await finalizeRun(rootSession.id, prunedRun.id, 'req_pruned_before_poll', { state: 'completed', summary: 'finished before prune' });

  // Verify producer hook captured it idempotently and rejects conflicting replay
  const finalPrunedRun = await runs.getRun(prunedRun.id);
  const dupCapture = await responsibilityEvents.captureRunTerminalProducerEvent(finalPrunedRun);
  a.equal(dupCapture.deduplicated, true, 'captureRunTerminalProducerEvent is idempotent on replay');
  await assert.rejects(
    () => responsibilityEvents.captureRunTerminalProducerEvent({ ...finalPrunedRun, state: 'failed' }),
    err => err?.code === 'RESPONSIBILITY_CONFLICT' && err?.statusCode === 409,
    'conflicting producer event payload for same runId is rejected',
  );

  // Prune/remove ALL Runs from session storage BEFORE first trigger poll!
  const removedIds = await runs.removeRunsForSession(rootSession.id);
  a.ok(removedIds.includes(prunedRun.id), 'raw Run removed by removeRunsForSession before first poll');
  const evidenceAfterDelete = await runs.getRunAcceptanceEvidence(prunedRun.id).catch(() => null);
  a.equal(evidenceAfterDelete, null, 'raw Run evidence is completely gone before first trigger poll');
  const indexAfterDelete = await runs.listDurableSessionRunIndexEntries(rootSession.id);
  a.equal(indexAfterDelete.length, 0, 'session run index is empty after pruning');

  // First poll via processResponsibilityTriggerEvents MUST recover from producer log with zero retention_gap!
  await responsibilityEvents.processResponsibilityTriggerEvents();
  const triggersAfterPoll = await responsibilityTriggerBridge.listResponsibilityTriggers(respEventId, OWNER_ACTOR);
  const bStateAfterPoll = triggersAfterPoll.bindings.find(b => b.id === eventBindingId);
  a.equal(bStateAfterPoll.source.status, 'ready', 'source remains ready when producer log retains pruned Run');

  const wakesFromPruned = await responsibilityStore.read(db =>
    db.prepare('SELECT w.*, o.payload_json FROM responsibility_wakes w JOIN responsibility_observations o ON o.wake_id=w.id WHERE w.responsibility_id=?').all(respEventId)
  );
  a.equal(wakesFromPruned.length, 1, 'exactly one wake delivered for pruned Run');
  const wakeObs = JSON.parse(wakesFromPruned[0].payload_json);
  a.equal(wakeObs.runId, prunedRun.id, 'wake observation points to pruned Run');
  a.equal(wakeObs.runState, 'completed', 'wake observation preserves terminal runState');
  a.ok(Number.isSafeInteger(wakeObs.producerSequence), 'wake observation records durable producerSequence');

  // Re-polling must not produce duplicate wakes
  await responsibilityEvents.processResponsibilityTriggerEvents();
  const wakesAfterSecondPoll = await responsibilityStore.read(db =>
    db.prepare('SELECT id FROM responsibility_wakes WHERE responsibility_id=?').all(respEventId)
  );
  a.equal(wakesAfterSecondPoll.length, 1, 'duplicate poll does not duplicate wake');

  // Organization event capture via appendOrganizationEvent
  const orgEv = await orgMessaging.appendOrganizationEvent({
    organizationId: org.id,
    eventKey: 'stage2-gate-passed-1',
    type: 'phase.gate_passed',
    organizationRevision: 1,
    phaseId: 'phase-1',
    payload: { phaseId: 'phase-1', state: 'passed' },
  });
  a.ok(orgEv.id >= 1, 'organization event persisted');
  const producerRouteRes = await callRoute(handleResponsibilityRoutes, {
    method: 'GET',
    pathname: `/api/responsibilities/${encodeURIComponent(respEventId)}/producer-events`,
  });
  a.equal(producerRouteRes.statusCode, 200, 'producer-events route returns 200');
  a.ok(producerRouteRes.body.events.some(e => e.eventKey === `run_terminal:${prunedRun.id}`), 'route lists terminal run producer event');
  a.ok(producerRouteRes.body.events.some(e => e.eventType === 'phase.gate_passed' && e.eventKey === `org:${org.id}:stage2-gate-passed-1`), 'route lists organization producer event');

  // Unauthorized principal cannot read producer-events
  const unauthProdRes = await callRoute(handleResponsibilityRoutes, {
    method: 'GET',
    pathname: `/api/responsibilities/${encodeURIComponent(respEventId)}/producer-events`,
    authSession: { role: 'member', principalId: 'other-owner' },
    cookie: '',
  });
  a.equal(unauthProdRes.statusCode, 403, 'non-owner cannot read producer-events');

  // Bounded retention & cursor recovery test:
  // Record 5 synthetic producer events at occurredAt >= now, prune to maxRows: 2 -> oldest 3 pruned -> cursor gap detected -> recover!
  const baseTs = Date.now() + 5000;
  for (let i = 1; i <= 5; i += 1) {
    const fakeRunId = `run_retention_${i}`;
    await responsibilityEvents.recordProducerTriggerEvent({
      eventKey: `run_terminal:${fakeRunId}`,
      eventType: 'run_terminal',
      sourceKind: 'root_session',
      sessionId: rootSession.id,
      runId: fakeRunId,
      eventId: fakeRunId,
      state: 'completed',
      occurredAt: new Date(baseTs + i * 1000).toISOString(),
      payload: { id: fakeRunId, runId: fakeRunId, sessionId: rootSession.id, state: 'completed', finalizedAt: new Date(baseTs + i * 1000).toISOString(), runPublication: { version: 1, publicationId: `00000000-0000-4000-8000-00000000000${i}` } },
    }, { autoPrune: false });
  }
  const pruneRes = await responsibilityEvents.pruneProducerTriggerEvents({ maxRows: 2, maxAgeMs: null });
  a.equal(pruneRes.remainingCount, 2, 'bounded retention enforces maxRows=2');
  a.ok(pruneRes.deletedCount >= 3, 'bounded retention pruned older overflow rows');
  a.ok(pruneRes.minAvailableSequence > 0, 'retention floor sequence recorded');

  // Next poll detects cursor gap (`retention_gap`), advances floor, and owner `recover` allows resuming remaining 2 events!
  await responsibilityEvents.processResponsibilityTriggerEvents();
  const afterGapList = await responsibilityTriggerBridge.listResponsibilityTriggers(respEventId, OWNER_ACTOR);
  const gapBinding = afterGapList.bindings.find(b => b.id === eventBindingId);
  a.equal(gapBinding.source.status, 'retention_gap', 'cursor falling behind pruned floor raises retention_gap');
  a.equal(gapBinding.source.lastError, 'producer_event_retention_gap', 'exact retention gap reason reported');

  // Recover binding and poll again -> delivers the remaining 2 retained events cleanly!
  await responsibilityTriggerBridge.changeResponsibilityTrigger(respEventId, eventBindingId, 'recover', {
    confirmed: true,
    expectedVersion: gapBinding.version,
    idempotencyKey: 'recover-after-retention-gap',
  }, OWNER_ACTOR);
  await responsibilityEvents.processResponsibilityTriggerEvents();
  const afterRecoverList = await responsibilityTriggerBridge.listResponsibilityTriggers(respEventId, OWNER_ACTOR);
  a.equal(afterRecoverList.bindings.find(b => b.id === eventBindingId).source.status, 'ready', 'source recovers to ready after retention_gap');
  const wakesAfterRecover = await responsibilityStore.read(db =>
    db.prepare('SELECT id FROM responsibility_wakes WHERE responsibility_id=?').all(respEventId)
  );
  a.equal(wakesAfterRecover.length, 3, 'surviving 2 events after floor are delivered cleanly on cursor recovery');

  // Pause respEventId so it does not interfere with Group 2
  await responsibilityService.setResponsibilityLifecycle(respEventId, 'pause', {
    expectedVersion: (await responsibilityService.getResponsibility(respEventId, OWNER_ACTOR)).responsibility.rowVersion,
    idempotencyKey: 'pause-resp-events',
  }, OWNER_ACTOR);

  // =========================================================================
  // GROUP 2: S2.2 Workspace & External Resource Fingerprint + No-Change LLM Skip
  // =========================================================================
  console.log('[Group 2] S2.2 Workspace/External fingerprint confinement & deterministic LLM skip');

  const projectFact = await responsibilityProject.captureResponsibilityProject(org.id, project.id);

  // 2A: Symlink escape rejection + non-cyclic internal symlink confinement + cyclic loop rejection
  const escapeLinkPath = join(repoDir, 'escape-link');
  try {
    symlinkSync(outsideDir, escapeLinkPath, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(
      () => responsibilityGitObs.observeResponsibilityWorkspaceFingerprint(projectFact.id, { maxFiles: 100, maxDepth: 6 }),
      err => err?.reason === 'symlink_escape' && err?.code === 'RESPONSIBILITY_WORKSPACE_OBSERVATION_UNAVAILABLE',
      'escaping symlink/junction strictly rejected',
    );
  } finally {
    rmSync(escapeLinkPath, { recursive: true, force: true });
  }

  const siblingLinkPath = join(repoDir, 'docs', 'alias-src');
  try {
    const siblingTarget = process.platform === 'win32' ? join(repoDir, 'src') : '../src';
    symlinkSync(siblingTarget, siblingLinkPath, process.platform === 'win32' ? 'junction' : 'dir');
    const fpWithSibling = await responsibilityGitObs.observeResponsibilityWorkspaceFingerprint(projectFact.id, {
      paths: ['docs', 'src'],
      maxFiles: 100,
      maxDepth: 6,
    });
    a.equal(fpWithSibling.fileCount, 5, 'non-cyclic internal sibling symlink resolves inside root cleanly');
    await assert.rejects(
      () => responsibilityGitObs.observeResponsibilityWorkspaceFingerprint(projectFact.id, {
        paths: ['docs', 'src'],
        maxFiles: 100,
        maxDepth: 6,
        allowInternalSymlinks: false,
      }),
      err => err?.reason === 'symlink_escape',
      'internal symlink rejected when allowInternalSymlinks=false',
    );
  } finally {
    rmSync(siblingLinkPath, { recursive: true, force: true });
  }

  const cyclicLinkPath = join(repoDir, 'docs', 'loop');
  try {
    const loopTarget = process.platform === 'win32' ? join(repoDir, 'docs') : '..';
    symlinkSync(loopTarget, cyclicLinkPath, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(
      () => responsibilityGitObs.observeResponsibilityWorkspaceFingerprint(projectFact.id, { paths: ['docs'], maxFiles: 100, maxDepth: 6 }),
      err => err?.reason === 'symlink_escape',
      'cyclic internal symlink loop rejected via ancestor stack',
    );
  } finally {
    rmSync(cyclicLinkPath, { recursive: true, force: true });
  }

  // 2B: Path traversal & cap checks (fail-closed)
  await assert.rejects(
    () => responsibilityGitObs.observeResponsibilityWorkspaceFingerprint(projectFact.id, { paths: ['../outside-secret'] }),
    err => err?.reason === 'path_traversal',
    'relative .. traversal rejected',
  );
  await assert.rejects(
    () => responsibilityGitObs.observeResponsibilityWorkspaceFingerprint(projectFact.id, { paths: [outsideDir] }),
    err => err?.reason === 'invalid_workspace_path',
    'absolute external path rejected',
  );
  await assert.rejects(
    () => responsibilityGitObs.observeResponsibilityWorkspaceFingerprint(projectFact.id, { maxFiles: 2 }),
    err => err?.reason === 'max_files_exceeded',
    'maxFiles cap fails closed',
  );
  await assert.rejects(
    () => responsibilityGitObs.observeResponsibilityWorkspaceFingerprint(projectFact.id, { maxDepth: 1 }),
    err => err?.reason === 'max_depth_exceeded',
    'maxDepth cap fails closed',
  );
  await assert.rejects(
    () => responsibilityGitObs.observeResponsibilityWorkspaceFingerprint(projectFact.id, { maxTotalBytes: 10 }),
    err => err?.reason === 'max_total_bytes_exceeded',
    'maxTotalBytes cap fails closed',
  );

  // Valid bounded fingerprint succeeds and detects uncommitted file edits
  const fp1 = await responsibilityGitObs.observeResponsibilityWorkspaceFingerprint(projectFact.id, {
    paths: ['README.md', 'docs', 'src'],
    maxFiles: 50,
    maxDepth: 5,
    maxTotalBytes: 1024 * 1024,
  });
  a.equal(fp1.fileCount, 4, 'workspace fingerprint counts exact 4 files');
  writeFileSync(join(repoDir, 'docs', 'status.md'), 'status=v2\n', 'utf8');
  const fp2 = await responsibilityGitObs.observeResponsibilityWorkspaceFingerprint(projectFact.id, {
    paths: ['README.md', 'docs', 'src'],
    maxFiles: 50,
    maxDepth: 5,
    maxTotalBytes: 1024 * 1024,
  });
  a.notEqual(fp1.digest, fp2.digest, 'uncommitted file edit changes workspace fingerprint');
  writeFileSync(join(repoDir, 'docs', 'status.md'), 'status=v1\n', 'utf8');
  const fp3 = await responsibilityGitObs.observeResponsibilityWorkspaceFingerprint(projectFact.id, {
    paths: ['README.md', 'docs', 'src'],
    maxFiles: 50,
    maxDepth: 5,
    maxTotalBytes: 1024 * 1024,
  });
  a.equal(fp3.digest, fp1.digest, 'restoring original content yields identical deterministic fingerprint');

  // 2C: Full runtime test for no-change deterministic LLM skip + manual/edit/watermark/failure/revision bypass!
  let plannerDispatchCount = 0;
  let reportDispatchCount = 0;
  let obsRespId = null;
  let acceptCounter = 0;
  const orchestrator = createCollaborationOrchestrator({
    pollMs: 100000,
    dependencies: {
      sendMessage: async (sid, text, _images, opts = {}) => {
        const session = await sessionManager.getSession(sid);
        const run = await runs.createRun({
          status: { sessionId: sid, requestId: opts.requestId, tool: 'codex', model: 'gpt-5.3-codex', effort: 'medium', state: 'running', startedAt: new Date().toISOString() },
          manifest: { sessionId: sid, requestId: opts.requestId, projectId: project.id, folder: repoDir },
        });
        if (sid === plannerNode.session.id) {
          plannerDispatchCount += 1;
          const current = await responsibilityService.getResponsibility(obsRespId, OWNER_ACTOR);
          const entry = current.policy.planCatalog[0];
          const planJson = JSON.stringify({
            schemaVersion: 1,
            decision: 'plan',
            steps: [{
              id: 'step-report-1',
              entryId: entry.entryId,
              entryDigest: entry.entryDigest,
              templateId: entry.templateId,
              templateVersion: entry.templateVersion,
              templateDigest: entry.templateDigest,
              nodeBindings: entry.nodeBindings,
              dependsOn: [],
            }],
          });
          await finalizeRun(sid, run.id, opts.requestId, {
            state: 'completed',
            summary: `\`\`\`json\n${planJson}\n\`\`\``,
          });
        } else {
          reportDispatchCount += 1;
          await finalizeRun(sid, run.id, opts.requestId, {
            state: 'completed',
            summary: '# Report\nAll clear.\n<ragent-result-packet>{"kind":"report","state":"completed","summary":"ok"}</ragent-result-packet>',
          });
        }
        return { session, run: await runs.getRun(run.id), prompt: text };
      },
      getRunState: id => runs.getRun(id),
      getRun: id => runs.getRun(id),
      getRunResult: id => runs.getRunResult(id),
      getRunManifest: id => runs.getRunManifest(id),
      listRunIds: () => runs.listRunIds(),
      requestRunCancel: id => runs.requestRunCancel(id),
      loadHistory: sid => history.loadHistory(sid),
      resolveRuntimeReadOnlyCapability: async () => ({ supportsReadOnlyFilesystem: true, sandboxMode: 'test-ro', runtimeId: 'test-ro' }),
    },
  });
  const adapter = createFactoryExecutionAdapter({ organizationId: org.id, actor: SERVICE_ACTOR, orchestrator });
  scheduler = createFactoryScheduler({ organizationId: org.id, actor: SERVICE_ACTOR, adapter, admissionEnabled: true, pollMs: 100000, onError: err => console.error('[sched]', err) });
  respRuntime = responsibilityRuntimeMod.createResponsibilityRuntime({ intervalMs: 60000, onError: err => console.error('[resp-rt]', err) });
  await scheduler.start();
  respRuntime.start();
  await respRuntime.tick();

  const obsRespRes = await callRoute(handleResponsibilityRoutes, {
    method: 'POST',
    pathname: '/api/responsibilities',
    body: {
      organizationId: org.id,
      projectId: project.id,
      objective: 'Skip unchanged periodic wakes and detect workspace/external changes',
      successCriteria: ['Skip LLM when fingerprint unchanged'],
      idempotencyKey: 'create-resp-obs-skip',
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
        maxCost: 5,
        planExecutionMaxAttempts: 4,
        planExecutionMaxCost: 10,
        planApproval: 'within_policy',
        planAutoAdmissionConfirmed: true,
        planCatalog: [reportCatalogEntry],
        workspaceFingerprint: { enabled: true, paths: ['README.md', 'docs', 'src'], maxFiles: 100, maxDepth: 5 },
        externalResourceWatermarks: { enabled: true, requiredResourceKeys: ['drive:specs'] },
        dailyBudget: { timeZone: 'UTC', maxRuns: 50, maxCost: 100 },
        validUntil: futureIso(30),
      },
    },
  });
  a.equal(obsRespRes.statusCode, 200, `create obs resp: ${JSON.stringify(obsRespRes.body)}`);
  obsRespId = obsRespRes.body.responsibility.id;
  await responsibilityService.setResponsibilityLifecycle(obsRespId, 'resume', {
    expectedVersion: obsRespRes.body.responsibility.rowVersion,
    idempotencyKey: 'resume-obs-resp',
  }, OWNER_ACTOR);

  // Record required external watermark
  const wm1Res = await callRoute(handleResponsibilityRoutes, {
    method: 'POST',
    pathname: `/api/responsibilities/${encodeURIComponent(obsRespId)}/external-watermarks`,
    body: { source: 'drive', resourceKey: 'drive:specs', watermarkValue: 'rev-1', metadata: { etag: 'e1' } },
  });
  a.equal(wm1Res.statusCode, 200, 'external watermark recorded via HTTP route');

  async function triggerIntervalTick() {
    await responsibilityStore.transaction(db => {
      db.prepare('UPDATE responsibility_subscriptions SET next_due_at=? WHERE responsibility_id=?')
        .run(new Date(Date.now() - 1000).toISOString(), obsRespId);
    });
    await respRuntime.tick();
  }

  async function drivePlanningCycle() {
    await scheduler.tick();
    await orchestrator.reconcile();
    await scheduler.tick();
    await respRuntime.tick(); // collect + auto-approve + dispatch step
    await scheduler.tick();
    await orchestrator.reconcile();
    await scheduler.tick();
    // Accept any pending review step work items cleanly
    const links = await responsibilityService.listResponsibilityWorkLinks(obsRespId, OWNER_ACTOR);
    for (const link of links.links) {
      for (const wiId of link.workItemIds || []) {
        const detail = await factoryControl.getFactoryWorkItem(org.id, wiId, OWNER_ACTOR);
        if (detail.item.kind === 'execution' && detail.item.state === 'review' && detail.item.candidateDigest) {
          acceptCounter += 1;
          await factoryAcceptance.decideFactoryManualAcceptance({
            organizationId: org.id,
            workItemId: detail.item.id,
            criterionId: detail.item.contract.acceptanceCriteria[0].id,
            decision: 'passed',
            rationale: 'Verified step report',
            contractRevision: detail.item.contractRevision,
            gateGeneration: detail.item.gateGeneration,
            candidateDigest: detail.item.candidateDigest,
            expectedVersion: detail.item.rowVersion,
            commandId: `cmd-accept-obs-${acceptCounter}`,
            idempotencyKey: `key-accept-obs-${acceptCounter}`,
          }, OWNER_ACTOR);
        }
      }
    }
    await respRuntime.tick();
  }

  // Wake 1 (interval): no baseline yet -> dispatches planner LLM
  await triggerIntervalTick();
  await drivePlanningCycle();
  a.equal(plannerDispatchCount, 1, 'Wake 1 (no baseline) runs LLM planner once');

  // Wake 2 (interval, unchanged workspace + unchanged external watermark): MUST skip LLM!
  await triggerIntervalTick();
  a.equal(plannerDispatchCount, 1, 'Wake 2 (unchanged) deterministically skips LLM planning');

  // Wake 3 (interval, still unchanged): MUST ALSO skip LLM!
  await triggerIntervalTick();
  a.equal(plannerDispatchCount, 1, 'Wake 3 (unchanged) also deterministically skips LLM planning');

  const obsRouteRes = await callRoute(handleResponsibilityRoutes, {
    method: 'GET',
    pathname: `/api/responsibilities/${encodeURIComponent(obsRespId)}/observations`,
  });
  a.equal(obsRouteRes.statusCode, 200, 'observations route returns 200');
  const skippedObs = obsRouteRes.body.changeObservations.filter(o => o.outcome === 'no_change_skipped');
  a.equal(skippedObs.length, 2, 'two verifiable no_change_skipped observations recorded');
  a.ok(skippedObs.every(o => o.baselineWakeId && o.fingerprintDigest && o.workspaceDigest && o.externalDigest), 'skipped observations retain verifiable baseline & component digests');

  const detailRouteRes = await callRoute(handleResponsibilityRoutes, {
    method: 'GET',
    pathname: `/api/responsibilities/${encodeURIComponent(obsRespId)}`,
  });
  a.equal(detailRouteRes.statusCode, 200, 'GET /api/responsibilities/:id returns 200');
  a.equal(detailRouteRes.body.changeObservation.noChangeSkipCount, 2, 'responsibility detail summarizes noChangeSkipCount=2');

  const actRouteRes = await callRoute(handleResponsibilityRoutes, {
    method: 'GET',
    pathname: `/api/responsibilities/${encodeURIComponent(obsRespId)}/activity`,
  });
  a.equal(actRouteRes.body.activity.filter(x => x.type === 'no_change_skipped').length, 2, 'activity records each no_change_skipped event');

  // Wake 4 (manual wake with NO file changes): MUST bypass skip!
  const manualWakeRes = await callRoute(handleResponsibilityRoutes, {
    method: 'POST',
    pathname: `/api/responsibilities/${encodeURIComponent(obsRespId)}/wake`,
    body: {
      expectedVersion: detailRouteRes.body.responsibility.rowVersion,
      idempotencyKey: 'manual-wake-bypass-skip',
    },
  });
  a.equal(manualWakeRes.statusCode, 200, 'manual wake accepted');
  await respRuntime.tick();
  await drivePlanningCycle();
  a.equal(plannerDispatchCount, 2, 'manual wake bypasses no-change skip');

  // Wake 5 (interval after uncommitted workspace file modification): MUST evaluate!
  writeFileSync(join(repoDir, 'src', 'a.js'), 'export const a = 42;\n', 'utf8');
  await triggerIntervalTick();
  await drivePlanningCycle();
  a.equal(plannerDispatchCount, 3, 'uncommitted file change triggers LLM planning');

  // Wake 6 (interval after external watermark change): MUST evaluate!
  await callRoute(handleResponsibilityRoutes, {
    method: 'POST',
    pathname: `/api/responsibilities/${encodeURIComponent(obsRespId)}/external-watermarks`,
    body: { source: 'drive', resourceKey: 'drive:specs', watermarkValue: 'rev-2', metadata: { etag: 'e2' } },
  });
  await triggerIntervalTick();
  await drivePlanningCycle();
  a.equal(plannerDispatchCount, 4, 'external watermark change triggers LLM planning');

  // Wake 7 (interval with unchanged fingerprint, AFTER a terminal failure event): MUST bypass skip!
  const failRun = await runs.createRun({
    status: { sessionId: rootSession.id, requestId: 'req_fail_bypass', tool: 'codex', model: 'gpt-5.3-codex', effort: 'medium', state: 'running', startedAt: new Date().toISOString() },
    manifest: { sessionId: rootSession.id, requestId: 'req_fail_bypass', projectId: project.id, folder: repoDir },
  });
  await finalizeRun(rootSession.id, failRun.id, 'req_fail_bypass', { state: 'failed' });
  await triggerIntervalTick();
  await drivePlanningCycle();
  a.equal(plannerDispatchCount, 5, 'real terminal failure event bypasses no-change skip on subsequent interval wake');

  // Wake 8 (interval after policy/catalog revision change): MUST evaluate!
  const latestRespDetail = await responsibilityService.getResponsibility(obsRespId, OWNER_ACTOR);
  await responsibilityService.updateResponsibility(obsRespId, {
    expectedVersion: latestRespDetail.responsibility.rowVersion,
    idempotencyKey: 'bump-policy-catalog-rev',
    policy: {
      ...latestRespDetail.policy,
      planCatalog: [{ ...reportCatalogEntry, maxCost: 6 }],
    },
  }, OWNER_ACTOR);
  await triggerIntervalTick();
  await drivePlanningCycle();
  a.equal(plannerDispatchCount, 6, 'policy/catalog revision bump invalidates old baseline and runs planner');

  // Symlink escape during interval wake fails closed without dispatching LLM
  const escapeRuntimeLink = join(repoDir, 'docs', 'runtime-escape');
  try {
    symlinkSync(outsideDir, escapeRuntimeLink, process.platform === 'win32' ? 'junction' : 'dir');
    await triggerIntervalTick();
    a.equal(plannerDispatchCount, 6, 'symlink escape blocks wake without calling LLM');
    const blockedAct = (await responsibilityService.listResponsibilityActivity(obsRespId, {}, OWNER_ACTOR)).activity
      .find(x => x.type === 'workspace_observation_blocked');
    a.ok(blockedAct, 'workspace_observation_blocked activity emitted on symlink escape');
  } finally {
    rmSync(escapeRuntimeLink, { recursive: true, force: true });
  }

  // Pause obsRespId cleanly and stop runtime/scheduler from Group 2 before Group 3
  await responsibilityService.setResponsibilityLifecycle(obsRespId, 'pause', {
    expectedVersion: (await responsibilityService.getResponsibility(obsRespId, OWNER_ACTOR)).responsibility.rowVersion,
    idempotencyKey: 'pause-obs-resp',
  }, OWNER_ACTOR);
  await scheduler.stop();
  scheduler = null;
  await respRuntime.stop();
  respRuntime = null;

  // =========================================================================
  // GROUP 3: S2.3 Goal-DAG Generalized Revision, Artifact Reuse & Fencing
  // =========================================================================
  console.log('[Group 3] S2.3 Goal-DAG generalized revision, artifact reuse & generation fencing');

  const createGoalRes = await executeWorkGraphCommand({
    organizationId: org.id,
    type: 'CreateGoal',
    commandId: 'cmd-dag-goal',
    idempotencyKey: 'key-dag-goal',
    payload: { projectId: project.id, objective: 'Diamond & Sibling DAG', acceptanceBaseline: ['all items pass'] },
  }, OWNER_ACTOR);
  const goalId = createGoalRes.goal.id;

  const baseContract = obj => ({
    objective: obj,
    accessMode: 'write',
    allowedPaths: ['docs', 'src'],
    acceptanceCriteria: [{ id: 'manual-ok', method: 'manual' }],
  });

  async function mkItem(key, objective, deps = [], assigneeNodeId = writerNode.node.id) {
    const res = await executeWorkGraphCommand({
      organizationId: org.id,
      type: 'CreateWorkItem',
      commandId: `cmd-item-${key}`,
      idempotencyKey: `key-item-${key}`,
      payload: { goalId, kind: 'execution', assigneeNodeId, contract: baseContract(objective), dependencies: deps },
    }, OWNER_ACTOR);
    return res.item;
  }

  // Build arbitrary DAG:
  // U (completed) -> L (completed) -> M (running!) -> D (proposed)
  // U (completed) -> R (completed) -> M (running!)
  // S (completed, independent sibling)
  const itemU = await mkItem('U', 'Upstream shared foundation');
  const itemS = await mkItem('S', 'Independent sibling task');
  const itemL = await mkItem('L', 'Left branch task', [{ predecessorId: itemU.id, milestone: 'accepted' }]);
  const itemR = await mkItem('R', 'Right branch task', [{ predecessorId: itemU.id, milestone: 'accepted' }]);
  const itemM = await mkItem('M', 'Merge task depending on L and R', [
    { predecessorId: itemL.id, milestone: 'accepted' },
    { predecessorId: itemR.id, milestone: 'accepted' },
  ]);
  const itemD = await mkItem('D', 'Downstream packaging depending on M', [{ predecessorId: itemM.id, milestone: 'accepted' }]);

  const candDigestU = createHash('sha256').update('cand-U-v1').digest('hex');
  const candDigestR = createHash('sha256').update('cand-R-v1').digest('hex');
  const candDigestL = createHash('sha256').update('cand-L-v1').digest('hex');

  const stagingDirM = join(tempRoot, 'staging-m');
  mkdirSync(join(stagingDirM, 'docs'), { recursive: true });
  writeFileSync(join(stagingDirM, 'docs', 'out.md'), 'candidate output\n', 'utf8');

  // Seed verified completed candidates + acceptance + delivery milestone for U, R, L, S, and active running binding on M
  let staleFenceM = null;
  await workGraphStore.factoryTransaction(db => {
    const ts = new Date().toISOString();
    for (const [it, dig, withIntegrated] of [[itemU, candDigestU, true], [itemR, candDigestR, false], [itemL, candDigestL, false]]) {
      db.prepare("UPDATE factory_work_items SET state='completed',control_state='none',execution_epoch=1,binding_generation=1,gate_generation=1,candidate_digest=?,row_version=row_version+1,updated_at=? WHERE id=?")
        .run(dig, ts, it.id);
      db.prepare("INSERT INTO factory_candidates VALUES(?,?,?,?,?,?,?,?)")
        .run(`cand_${it.id}`, it.id, 1, 1, 1, dig, JSON.stringify({ verified: true, runId: `run_${it.id}` }), ts);
      db.prepare("INSERT INTO factory_acceptance_decisions VALUES(?,?,?,?,?,?,?,?,?,?)")
        .run(`acc_${it.id}`, it.id, 1, dig, 1, 'manual-ok', 'passed', OWNER_ID, JSON.stringify([{ kind: 'owner_manual_review' }]), ts);
      if (withIntegrated) {
        db.prepare("INSERT INTO factory_delivery_milestones VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
          .run(`mile_${it.id}`, org.id, it.id, 1, 1, 1, dig, 'integrated', `op_${it.id}`, 'main', dig, dig, JSON.stringify({ verified: true }), ts);
      }
    }
    const candDigestS = createHash('sha256').update('cand-S-v1').digest('hex');
    db.prepare("UPDATE factory_work_items SET state='completed',control_state='none',execution_epoch=1,binding_generation=1,gate_generation=1,candidate_digest=?,row_version=row_version+1,updated_at=? WHERE id=?")
      .run(candDigestS, ts, itemS.id);
    db.prepare("INSERT INTO factory_candidates VALUES(?,?,?,?,?,?,?,?)")
      .run(`cand_${itemS.id}`, itemS.id, 1, 1, 1, candDigestS, JSON.stringify({ verified: true }), ts);

    // Put M into active running state with a binding & baseline payload so we can test sealing & submitting rejection!
    db.prepare("UPDATE factory_work_items SET state='running',control_state='none',execution_epoch=1,binding_generation=1,gate_generation=0,row_version=row_version+1,updated_at=? WHERE id=?")
      .run(ts, itemM.id);
    const mRow = db.prepare('SELECT * FROM factory_work_items WHERE id=?').get(itemM.id);
    staleFenceM = {
      rowVersion: mRow.row_version,
      contractRevision: mRow.contract_revision,
      executionEpoch: mRow.execution_epoch,
      bindingGeneration: mRow.binding_generation,
      gateGeneration: mRow.gate_generation,
      goalRevision: 1,
    };
    const mRunId = 'run_m_stale_attempt';
    db.prepare("INSERT INTO factory_execution_bindings VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run('bind_m_1', itemM.id, 1, 1, 1, 'disp_m_1', 'running', 'collab_m_1', itemM.id, 'att_m_1', mRunId, JSON.stringify({}), ts, ts);
    db.exec(`CREATE TABLE IF NOT EXISTS factory_candidate_payloads (
      candidate_id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL, contract_revision INTEGER NOT NULL,
      execution_epoch INTEGER NOT NULL, binding_generation INTEGER NOT NULL, run_id TEXT NOT NULL,
      baseline_digest TEXT NOT NULL, files_json TEXT NOT NULL, digest TEXT NOT NULL, created_at TEXT NOT NULL
    );`);
    const baselineFilesJson = JSON.stringify({ workspace: { stagingDir: stagingDirM, canonicalCwd: repoDir, writablePaths: ['docs'] }, source: { head: '0'.repeat(40), branch: 'main' }, files: [] });
    const bDigest = createHash('sha256').update(JSON.stringify({ workItemId: itemM.id, contractRevision: 1, executionEpoch: 1, bindingGeneration: 1, runId: '', baselineDigest: '', filesJson: baselineFilesJson })).digest('hex');
    db.prepare('INSERT INTO factory_candidate_payloads VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run('baseline:disp_m_1', itemM.id, 1, 1, 1, '', '', baselineFilesJson, bDigest, ts);
  });

  // Preview generalized DAG revision rooted ONLY at L (affectedRootIds: [itemL.id]) via HTTP route!
  const previewDagRes = await callRoute(handleFactoryRoutes, {
    method: 'POST',
    pathname: `/api/organizations/${encodeURIComponent(org.id)}/factory/goals/${encodeURIComponent(goalId)}/revision/preview`,
    body: { expectedVersion: 1, affectedRootIds: [itemL.id] },
  });
  a.equal(previewDagRes.statusCode, 200, `DAG preview returns 200: ${JSON.stringify(previewDagRes.body)}`);
  a.deepEqual(previewDagRes.body.affectedItemIds, [itemL.id, itemM.id, itemD.id].sort(), 'precise downstream invalidation set = {L, M, D}');
  a.deepEqual(previewDagRes.body.unaffectedItemIds, [itemR.id, itemS.id, itemU.id].sort(), 'exact unaffected set = {U, R, S}');
  a.equal(previewDagRes.body.reusableArtifacts.length, 3, 'all 3 unaffected completed items U, R, S marked reusable');
  const reusableU = previewDagRes.body.reusableArtifacts.find(x => x.workItemId === itemU.id);
  const reusableR = previewDagRes.body.reusableArtifacts.find(x => x.workItemId === itemR.id);
  a.equal(reusableU.candidateDigest, candDigestU, 'upstream U candidateDigest preserved');
  a.equal(reusableU.milestones.length, 1, 'upstream U integrated milestone preserved');
  a.equal(reusableR.candidateVerified, true, 'sibling R candidateVerified preserved');
  a.deepEqual(reusableR.passedCriteria, ['manual-ok'], 'sibling R passed acceptance criteria preserved');

  // Commit generalized DAG revision
  const commitDagRes = await callRoute(handleFactoryRoutes, {
    method: 'POST',
    pathname: `/api/organizations/${encodeURIComponent(org.id)}/factory/goals/${encodeURIComponent(goalId)}/revision/commit`,
    body: {
      commandId: 'cmd-dag-revise-1',
      idempotencyKey: 'key-dag-revise-1',
      expectedVersion: 1,
      affectedRootIds: [itemL.id],
      impactDigest: previewDagRes.body.impactDigest,
      objective: 'Diamond & Sibling DAG (revised L branch)',
      acceptanceBaseline: ['all items pass', 'L revised'],
    },
  });
  a.equal(commitDagRes.statusCode, 200, `DAG commit returns 200: ${JSON.stringify(commitDagRes.body)}`);
  a.equal(commitDagRes.body.goalRevision, 2, 'goalRevision incremented to 2');
  a.deepEqual(commitDagRes.body.invalidatedWorkItemIds.slice().sort(), [itemL.id, itemM.id, itemD.id].sort(), 'L, M, D invalidated');
  a.equal(commitDagRes.body.reusableArtifacts.length, 3, 'U, R, S returned as reusableArtifacts');

  // Verify unaffected U, R, S remain untouched in DB and reusable by replacement work items!
  const itemsAfterRev = await workGraphStore.factoryRead(db => ({
    U: db.prepare('SELECT * FROM factory_work_items WHERE id=?').get(itemU.id),
    R: db.prepare('SELECT * FROM factory_work_items WHERE id=?').get(itemR.id),
    S: db.prepare('SELECT * FROM factory_work_items WHERE id=?').get(itemS.id),
    L: db.prepare('SELECT * FROM factory_work_items WHERE id=?').get(itemL.id),
    M: db.prepare('SELECT * FROM factory_work_items WHERE id=?').get(itemM.id),
    D: db.prepare('SELECT * FROM factory_work_items WHERE id=?').get(itemD.id),
  }));
  a.equal(itemsAfterRev.U.state, 'completed', 'U remains completed');
  a.equal(itemsAfterRev.U.candidate_digest, candDigestU, 'U candidate_digest preserved');
  a.equal(itemsAfterRev.R.state, 'completed', 'R remains completed');
  a.equal(itemsAfterRev.R.candidate_digest, candDigestR, 'R candidate_digest preserved');
  a.equal(itemsAfterRev.S.state, 'completed', 'S remains completed');
  a.equal(itemsAfterRev.L.control_state, 'paused', 'idle L set to paused');
  a.equal(itemsAfterRev.L.candidate_digest, null, 'invalidated L candidate_digest cleared');
  a.equal(itemsAfterRev.M.control_state, 'cancel_requested', 'running M transitions to cancel_requested');
  a.equal(itemsAfterRev.M.gate_generation, staleFenceM.gateGeneration + 1, 'invalidated M gate_generation bumped');

  // Replacement work item L_v2 depending on preserved U (`accepted`) immediately becomes `ready` on ApproveContract!
  const itemLv2 = await mkItem('Lv2', 'Revised left branch v2', [{ predecessorId: itemU.id, milestone: 'accepted' }]);
  const approveLv2 = await executeWorkGraphCommand({
    organizationId: org.id,
    type: 'ApproveContract',
    commandId: 'cmd-approve-lv2',
    idempotencyKey: 'key-approve-lv2',
    targetId: itemLv2.id,
    expectedVersion: itemLv2.rowVersion,
    payload: {},
  }, OWNER_ACTOR);
  a.equal(approveLv2.item.state, 'ready', 'replacement L_v2 reuses completed U artifact and immediately becomes ready');

  // Generation / version fencing:
  // 1) Stale attempt on M CANNOT seal a new candidate via sealFactoryCandidate
  const staleRunM = await runs.createRun({
    status: { sessionId: writerNode.session.id, requestId: 'req_stale_m', tool: 'codex', model: 'gpt-5.3-codex', effort: 'medium', state: 'running', startedAt: new Date().toISOString() },
    manifest: { sessionId: writerNode.session.id, requestId: 'req_stale_m', projectId: project.id, folder: repoDir },
  });
  await finalizeRun(writerNode.session.id, staleRunM.id, 'req_stale_m', { state: 'completed', summary: 'stale work' });
  await assert.rejects(
    () => factoryCandidates.sealFactoryCandidate({
      context: {
        workItemId: itemM.id,
        contractRevision: staleFenceM.contractRevision,
        executionEpoch: staleFenceM.executionEpoch,
        bindingGeneration: staleFenceM.bindingGeneration,
        gateGeneration: staleFenceM.gateGeneration,
        goalRevision: staleFenceM.goalRevision,
        dispatchKey: 'disp_m_1',
      },
      workspace: { stagingDir: stagingDirM, canonicalCwd: repoDir, writablePaths: ['docs'] },
      runId: staleRunM.id,
    }),
    err => err?.code === 'FACTORY_WORK_INVALIDATED' && err?.statusCode === 409,
    'invalidated M cannot seal a new candidate via sealFactoryCandidate',
  );

  // 2) Stale attempt on M CANNOT submit candidate via updateFactoryBinding (neither with stale version nor current version!)
  await assert.rejects(
    () => factoryControl.updateFactoryBinding({
      organizationId: org.id,
      workItemId: itemM.id,
      expectedVersion: itemsAfterRev.M.row_version,
      contractRevision: staleFenceM.contractRevision,
      executionEpoch: staleFenceM.executionEpoch,
      bindingGeneration: staleFenceM.bindingGeneration,
      action: 'submit_candidate',
      payload: { candidateId: 'cand_fake', digest: 'a'.repeat(64) },
    }, SERVICE_ACTOR, { verifyCandidate: () => ({ digest: 'a'.repeat(64), terminalEvidenceRef: `run:${staleRunM.id}` }) }),
    err => err?.code === 'FACTORY_WORK_INVALIDATED' && err?.statusCode === 409,
    'invalidated M cannot submit candidate via updateFactoryBinding even with refreshed rowVersion',
  );

  // 3) Invalidated D cannot be claimed via claimFactoryWork
  await workGraphStore.factoryTransaction(db => {
    db.prepare("UPDATE factory_work_items SET state='ready',control_state='none' WHERE id=?").run(itemD.id);
  });
  const dAfter = await workGraphStore.factoryRead(db => db.prepare('SELECT row_version FROM factory_work_items WHERE id=?').get(itemD.id));
  const lease = await factoryControl.acquireFactorySchedulerLease({ organizationId: org.id, ownerToken: 'lease-obs-dag' }, SERVICE_ACTOR);
  await assert.rejects(
    () => factoryControl.claimFactoryWork({
      organizationId: org.id,
      workItemId: itemD.id,
      expectedVersion: dAfter.row_version,
      dispatchKey: 'disp_invalidated_d',
      bindingGeneration: 1,
      leaseOwnerToken: lease.ownerToken,
      leaseGeneration: lease.generation,
      managedSessionId: writerNode.session.id,
      runtimeTool: 'codex',
    }, SERVICE_ACTOR),
    err => err?.code === 'FACTORY_WORK_INVALIDATED' && err?.statusCode === 409,
    'invalidated D cannot be claimed via claimFactoryWork',
  );

  // 4) Scoped revision on a separate Goal-DAG also preserves unaffected completed siblings and bumps root epoch+gateGeneration
  const scopedGoalRes = await executeWorkGraphCommand({
    organizationId: org.id,
    type: 'CreateGoal',
    commandId: 'cmd-scoped-goal',
    idempotencyKey: 'key-scoped-goal',
    payload: { projectId: project.id, objective: 'Scoped Revision DAG', acceptanceBaseline: ['ok'] },
  }, OWNER_ACTOR);
  const sGoalId = scopedGoalRes.goal.id;
  const sRootA = (await executeWorkGraphCommand({
    organizationId: org.id, type: 'CreateWorkItem', commandId: 'cmd-sa', idempotencyKey: 'key-sa',
    payload: { goalId: sGoalId, kind: 'execution', assigneeNodeId: writerNode.node.id, contract: baseContract('Root A'), dependencies: [] },
  }, OWNER_ACTOR)).item;
  const sSiblingB = (await executeWorkGraphCommand({
    organizationId: org.id, type: 'CreateWorkItem', commandId: 'cmd-sb', idempotencyKey: 'key-sb',
    payload: { goalId: sGoalId, kind: 'execution', assigneeNodeId: writerNode.node.id, contract: baseContract('Sibling B'), dependencies: [] },
  }, OWNER_ACTOR)).item;
  const sDownC = (await executeWorkGraphCommand({
    organizationId: org.id, type: 'CreateWorkItem', commandId: 'cmd-sc', idempotencyKey: 'key-sc',
    payload: { goalId: sGoalId, kind: 'execution', assigneeNodeId: writerNode.node.id, contract: baseContract('Down C'), dependencies: [{ predecessorId: sRootA.id, milestone: 'accepted' }] },
  }, OWNER_ACTOR)).item;
  const candB = createHash('sha256').update('cand-B-scoped').digest('hex');
  await workGraphStore.factoryTransaction(db => {
    const ts = new Date().toISOString();
    db.prepare("UPDATE factory_work_items SET state='completed',execution_epoch=1,binding_generation=1,gate_generation=1,candidate_digest=?,row_version=row_version+1 WHERE id=?").run(candB, sSiblingB.id);
    db.prepare("INSERT INTO factory_candidates VALUES(?,?,?,?,?,?,?,?)").run('cand_sb', sSiblingB.id, 1, 1, 1, candB, JSON.stringify({ verified: true }), ts);
  });

  const scopedPreview = await factoryGoalRevision.previewFactoryScopedRevision({
    organizationId: org.id,
    goalId: sGoalId,
    expectedVersion: 1,
    rootWorkItemId: sRootA.id,
    objective: 'Root A revised',
  }, OWNER_ACTOR);
  a.deepEqual(scopedPreview.affectedItemIds, [sRootA.id, sDownC.id].sort(), 'scoped revision affects only A and downstream C');
  a.equal(scopedPreview.reusableArtifacts.length, 1, 'scoped revision marks unaffected completed sibling B reusable');
  a.equal(scopedPreview.reusableArtifacts[0].workItemId, sSiblingB.id, 'sibling B identified as reusable artifact');

  const scopedCommit = await factoryGoalRevision.reviseFactoryScopeWithImpact({
    organizationId: org.id,
    goalId: sGoalId,
    expectedVersion: 1,
    rootWorkItemId: sRootA.id,
    objective: 'Root A revised',
    impactDigest: scopedPreview.impactDigest,
    commandId: 'cmd-scoped-commit-1',
    idempotencyKey: 'key-scoped-commit-1',
  }, OWNER_ACTOR);
  a.equal(scopedCommit.contractRevision, 2, 'scoped revision increments root contractRevision');
  a.equal(scopedCommit.item.executionEpoch, sRootA.executionEpoch + 1, 'scoped revision bumps root executionEpoch');
  a.equal(scopedCommit.item.gateGeneration, sRootA.gateGeneration + 1, 'scoped revision bumps root gateGeneration');
  a.equal(scopedCommit.reusableArtifacts.length, 1, 'scoped commit returns reusableArtifacts');

  // Verify pre-revision stale contract/epoch on sRootA fails generation fence
  await workGraphStore.factoryRead(db => {
    a.throws(
      () => factoryGoalRevision.assertFactoryWorkItemGenerationFence(db, sRootA.id, {
        contractRevision: sRootA.contractRevision,
        executionEpoch: sRootA.executionEpoch,
      }),
      err => err?.code === 'FACTORY_CONFLICT' && err?.statusCode === 409,
      'stale pre-revision contractRevision/executionEpoch on scoped root rejected by generation fence',
    );
  });

  console.log(`test-stage2-obs-and-dag: ok (${assertions} assertions)`);
} finally {
  try { if (scheduler) await scheduler.stop(); } catch {}
  try { if (respRuntime) await respRuntime.stop(); } catch {}
  try { sessionManager.killAll(); } catch {}
  try { rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
}
