#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const tempRoot = mkdtempSync(join(tmpdir(), 'ragent-p0-f1-reg-'));
const instanceRoot = join(tempRoot, 'instance');
const configDir = join(instanceRoot, 'config');
const harnessRoot = join(tempRoot, 'harnesses');
const claudeHarnessBin = join(harnessRoot, 'claude', 'node_modules', '.bin');
const agyHarnessBin = join(harnessRoot, 'agy', 'bin');

process.env.HOME = tempRoot;
process.env.USERPROFILE = tempRoot;
process.env.LOCALAPPDATA = join(tempRoot, 'localappdata');
process.env.APPDATA = join(tempRoot, 'appdata');
process.env.RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
process.env.RAGENT_INSTANCE_ROOT = instanceRoot;
process.env.RAGENT_CONFIG_DIR = configDir;
process.env.RAGENT_HARNESS_ROOT = harnessRoot;
process.env.RAGENT_MANAGED_INPUT_ENFORCEMENT = '1';
process.env.RAGENT_MANAGED_WRITER_ENABLED = '1';
process.env.RAGENT_ORG_PROJECTION_V1_ENABLED = '1';
process.env.RAGENT_ORG_PROJECTION_V2_ENABLED = '1';
process.env.RAGENT_AUTH_SESSION_SECRET = 'test-p0-f1-session-control-secret';
process.env.RAGENT_RUN_PROVIDER_MAX_CONCURRENT = '1';

mkdirSync(configDir, { recursive: true });
mkdirSync(process.env.LOCALAPPDATA, { recursive: true });
mkdirSync(process.env.APPDATA, { recursive: true });
mkdirSync(claudeHarnessBin, { recursive: true });
mkdirSync(agyHarnessBin, { recursive: true });
writeFileSync(join(claudeHarnessBin, 'claude'), '#!/bin/sh\necho "2.1.0"\n', 'utf8');
writeFileSync(join(agyHarnessBin, 'agy'), '#!/bin/sh\necho "1.5.12"\n', 'utf8');
try { chmodSync(join(claudeHarnessBin, 'claude'), 0o755); } catch {}
try { chmodSync(join(agyHarnessBin, 'agy'), 0o755); } catch {}
if (process.platform === 'win32') {
  writeFileSync(join(claudeHarnessBin, 'claude.cmd'), '@echo off\r\necho 2.1.0\r\n', 'utf8');
  writeFileSync(join(agyHarnessBin, 'agy.cmd'), '@echo off\r\necho 1.5.12\r\n', 'utf8');
}
process.env.PATH = `${claudeHarnessBin}${delimiter}${agyHarnessBin}${delimiter}${process.env.PATH || ''}`;

const repoDir = join(tempRoot, 'repo');
mkdirSync(join(repoDir, 'work'), { recursive: true });
writeFileSync(join(repoDir, 'README.md'), 'init\n', 'utf8');
writeFileSync(join(repoDir, 'work', 'target.txt'), 'before\n', 'utf8');
execFileSync('git', ['init', repoDir], { stdio: 'ignore' });
execFileSync('git', ['-C', repoDir, 'config', 'user.email', 'test@example.com'], { stdio: 'ignore' });
execFileSync('git', ['-C', repoDir, 'config', 'user.name', 'Test'], { stdio: 'ignore' });
execFileSync('git', ['-C', repoDir, 'add', '.'], { stdio: 'ignore' });
execFileSync('git', ['-C', repoDir, 'commit', '-m', 'init'], { stdio: 'ignore' });

const { createNativeProviderRegistry } = await import('../lib/provider-runtime/registry.mjs');
const { createSecretStore } = await import('../lib/provider-runtime/secret-store.mjs');
const registry = createNativeProviderRegistry({ configDir });
const secretStore = createSecretStore({ configDir });
await secretStore.writeSecret('glm-test-key', { authType: 'api-key', apiKey: 'sk-test-glm-regression' });
await registry.upsertAuthProfile({
  id: 'glm-auth-1',
  agentType: 'claude',
  authType: 'api-key',
  displayName: 'Test GLM Auth',
  storageType: 'secret-store',
  storageRef: 'glm-test-key',
});
await registry.upsertProviderProfile({
  id: 'glm-68f6bd41',
  agentType: 'claude',
  protocol: 'anthropic-messages',
  displayName: 'Test GLM Provider',
  baseUrl: 'https://example.invalid/anthropic',
  authProfileId: 'glm-auth-1',
  modelPolicy: {
    defaultModel: 'glm-5.3',
    allowedModels: ['glm-5.3'],
  },
});

const orgStore = await import('../chat/organization-store.mjs');
const appsMod = await import('../chat/apps.mjs');
const { createCollaborationOrchestrator } = await import('../chat/collaboration-orchestrator.mjs');
const identityCtx = await import('../chat/organization-identity-context.mjs');
const controlTools = await import('../chat/organization-control-tools.mjs');
const swarm = await import('../chat/organization-swarm.mjs');
const sessionManager = await import('../chat/session-manager.mjs');
const projects = await import('../chat/projects.mjs');
const history = await import('../chat/history.mjs');
const runs = await import('../chat/runs.mjs');
const { createSessionControlAuthenticator } = await import('../chat/session-control-capability.mjs');
const {
  createDetachedRunnerSpawner,
  launchDetachedRunnerViaSystemd,
  spawnDetachedRunnerAsProcess,
} = await import('../chat/run-launcher.mjs');
const { createDetachedRunReconciler } = await import('../chat/run-reconciler.mjs');
const { getAdaptiveHarnessBudget } = await import('../chat/adaptive-concurrency-registry.mjs');

try {
  const project = await projects.createProject({ name: 'F1 Regressions', rootPath: repoDir });
  const specialistApp = await appsMod.createApp({
    name: 'Claude Specialist',
    tool: 'claude-bidi',
    collaborationPolicy: { role: 'specialist', canDelegate: false, revision: 'spec-r1' },
  });
  const managerApp = await appsMod.createApp({
    name: 'Claude Manager',
    tool: 'claude-bidi',
    collaborationPolicy: {
      role: 'manager',
      canDelegate: true,
      allowedAgentIds: [specialistApp.id],
      maxChildren: 4,
      maxConcurrent: 2,
      maxDepth: 2,
      workspacePolicy: 'shared-exclusive',
      revision: 'mgr-r1',
    },
  });

  // ── 1. P0 #1: Formal org auto root aggregation (`collaboration_resume`) gets root sessionControlChannel + model fallback
  {
    const root = await sessionManager.createSession(repoDir, 'claude-bidi', 'Formal Org Root', {
      projectId: project.id,
      templateId: managerApp.id,
      sessionClass: 'ROOT_LEADERSHIP',
      sessionPlane: 'user',
      providerProfile: 'glm-68f6bd41',
      model: 'glm-5.3@glm-68f6bd41',
      effort: 'medium',
      riskMode: 'full-auto',
      riskModeExplicit: true,
    });
    const org = await orgStore.createOrganization({
      rootSessionId: root.id,
      projectId: project.id,
      state: 'active',
      currentRevision: 1,
      idempotencyKey: 'f1-p0-1-org',
    });
    const workerNodeId = 'node_f1_p0_1_worker';
    const workerSess = await sessionManager.createSession(repoDir, 'claude-bidi', 'Formal Worker', {
      sessionPlane: 'organization',
      sessionClass: 'WORKER',
      lifecycleMode: 'formal_org',
      managedScope: 'organization',
      organizationRootSessionId: root.id,
      organizationId: org.id,
      organizationNodeId: workerNodeId,
      organizationRevision: 1,
      roleInstanceId: 'rinst_p0_1',
      controllerSessionId: root.id,
      parentSessionId: root.id,
      delegatedFromSessionId: root.id,
      delegationDepth: 1,
      providerProfile: 'glm-68f6bd41',
      model: 'glm-5.3@glm-68f6bd41',
    });
    const workerNode = await orgStore.createNode({
      id: workerNodeId,
      organizationId: org.id,
      stableKey: 'formal-worker',
      nodeRole: 'worker',
      createdRevision: 1,
      lifecycleState: 'active',
      lifecycleMode: 'formal_org',
      grant: { canWrite: true, canDelegate: false, writablePaths: ['work'] },
      currentSessionId: workerSess.id,
      bindingGeneration: 1,
      roleInstanceId: 'rinst_p0_1',
      sessionClass: 'WORKER',
    });
    await orgStore.createRevision(org.id, {
      revision: 1,
      proposal: {
        nodes: [{ stableKey: 'formal-worker', nodeRole: 'worker', displayName: 'Formal Worker', responsibility: 'Edit work' }],
        edges: [],
        phases: [{ phaseId: 'phase-1', objective: 'Execute phase 1' }],
      },
      compiled: {
        nodes: [{ stableKey: 'formal-worker', nodeRole: 'worker', displayName: 'Formal Worker', responsibility: 'Edit work', phaseId: 'phase-1' }],
        edges: [],
        phases: [{ phaseId: 'phase-1', objective: 'Execute phase 1' }],
      },
    });
    await orgStore.freezeRevision(org.id, 1);

    let workerRunId = '';
    const orchestrator = createCollaborationOrchestrator({
      pollMs: 100000,
      dependencies: {
        getSession: sessionManager.getSession,
        getApp: appsMod.getApp,
        createSession: sessionManager.createSession,
        sendMessage: async (sid, text, images, opts) => {
          const res = await sessionManager.sendMessage(sid, text, images, { ...opts, skipRunnerLaunch: true });
          if (opts?.internalOperation === 'collaboration_task') workerRunId = res.run.id;
          return res;
        },
        getRunState: async (id) => {
          const r = await runs.getRun(id);
          return r || null;
        },
        getRun: runs.getRun,
        getRunResult: runs.getRunResult,
        getRunManifest: runs.getRunManifest,
        findRunByRequest: runs.findRunByRequest,
        listRunIds: async () => [],
        getProject: async () => project,
        requestRunCancel: async () => null,
        loadHistory: async (sid, runId) => [{
          type: 'message',
          role: 'assistant',
          runId: runId || workerRunId,
          content: 'Worker finished cleanly.',
        }],
      },
    });
    try {
      const collab = await orchestrator.dispatch({
        rootSessionId: root.id,
        idempotencyKey: 'f1-p0-1-collab',
        policy: {
          ...managerApp.collaborationPolicy,
          organizationId: org.id,
          organizationNodeId: workerNode.id,
          organizationBindingGeneration: 1,
          organizationRevision: 1,
          organizationPhaseDispatch: { revision: 1, phaseId: 'phase-1' },
        },
        plan: {
          title: 'formal agg test',
          workspacePolicy: 'shared-exclusive',
          tasks: [{
            id: 'task-1',
            agentId: specialistApp.id,
            role: 'specialist',
            objective: 'Do work',
            writablePaths: [],
            managedSessionId: workerSess.id,
          }],
        },
      });
      assert.ok(workerRunId, 'dispatched worker run');
      const workerRun = await runs.getRun(workerRunId);
      const completedAt = new Date().toISOString();
      const workerContent = 'Worker finished cleanly.';
      const workerHash = (await import('node:crypto')).createHash('sha256').update(workerContent).digest('hex');
      const workerMsg = await sessionManager.appendAssistantMessage(workerSess.id, workerContent, [], {
        runId: workerRunId,
        requestId: workerRun.requestId,
      });
      await history.appendEvent(workerSess.id, {
        type: 'status',
        content: 'completed',
        providerLifecycle: 'completed',
        runState: 'completed',
        deliveryContentHash: workerHash,
        runId: workerRunId,
        requestId: workerRun.requestId,
      });
      const workerResult = {
        exitCode: 0,
        signal: null,
        completedAt,
        finalDelivery: {
          contentHash: workerHash,
          eventSeq: workerMsg?.seq,
        },
      };
      await runs.writeRunResult(workerRunId, workerResult);
      await runs.updateRun(workerRunId, (current) => ({
        ...current,
        state: 'completed',
        completedAt,
        finalizedAt: completedAt,
        result: workerResult,
      }));
      assert.equal(await orchestrator.completeRun(workerRunId), true);
      const afterComplete = await orchestrator.get(collab.id);
      const aggRunId = afterComplete.aggregationRunId || await orchestrator.maybeAggregate(collab.id);
      const deferral = await (await import('../chat/collaboration-store.mjs')).getAggregationDeferral(collab.id);
      assert.ok(aggRunId, `maybeAggregate creates root aggregation run (state=${afterComplete.state}, task=${afterComplete.tasks[0]?.state}, attemptFailure=${afterComplete.attempts[0]?.failureReason}, deferral=${JSON.stringify(deferral)})`);
      const aggRun = await runs.getRun(aggRunId);
      const aggManifest = await runs.getRunManifest(aggRunId);
      const ctrl = aggManifest?.options?.sessionControlChannel;
      assert.match(ctrl?.tokenHash || '', /^[a-f0-9]{64}$/, 'collaboration_resume root aggregation issues sessionControlChannel tokenHash');
      assert.match(ctrl?.renewalTokenHash || '', /^[a-f0-9]{64}$/, 'collaboration_resume root aggregation issues sessionControlChannel renewalTokenHash');
      assert.equal(ctrl?.scope, undefined, 'collaboration_resume root aggregation is root-scoped (scope: undefined)');
      assert.equal(aggManifest?.options?.windowsBrokerChannel, undefined, 'collaboration_resume never receives owner windows broker authority');
      assert.equal(aggRun?.model, 'glm-5.3@glm-68f6bd41', 'aggregation run inherits model when omitted');
      assert.equal(aggManifest?.options?.model, 'glm-5.3@glm-68f6bd41', 'aggregation manifest preserves model');
      assert.equal(aggManifest?.options?.effort, 'medium', 'aggregation manifest preserves effort');

      const { readFileSync } = await import('node:fs');
      const tokenPath = join(instanceRoot, 'data', 'chat-runs', aggRunId, ctrl.tokenFile);
      const issuedToken = readFileSync(tokenPath, 'utf8').trim();
      const auth = createSessionControlAuthenticator({
        getRunImpl: runs.getRun,
        getRunManifestImpl: runs.getRunManifest,
        getSessionImpl: sessionManager.getSession,
      });
      const verifiedCtrl = await auth({
        method: 'POST',
        url: `/api/sessions/${root.id}/organization/tools-root`,
        headers: {
          'x-ragent-session-control-token': issuedToken,
          'x-ragent-session-control-run-id': ctrl.runId,
          'x-ragent-session-control-session-id': ctrl.sessionId,
          'x-ragent-session-control-turn-id': ctrl.turnId,
        },
      });
      assert.equal(verifiedCtrl?.surfaceMode, 'session_control');
      assert.equal(verifiedCtrl?.sessionId, root.id);
      assert.equal(verifiedCtrl?.scope ?? null, null);

      const cs = await import('../chat/collaboration-store.mjs');
      const guardRoot1 = await sessionManager.createSession(repoDir, 'claude-bidi', 'Guard Root 1', {
        projectId: project.id,
        sessionClass: 'ROOT_LEADERSHIP',
        sessionPlane: 'user',
        providerProfile: 'glm-68f6bd41',
        model: 'glm-5.3@glm-68f6bd41',
      });
      const guardCollab = await cs.createCollaborationRecord({
        rootSessionId: guardRoot1.id,
        title: 'guard collab',
        plan: { version: 1, workspacePolicy: 'shared-exclusive', tasks: [{ id: 'g-t1', agentId: specialistApp.id, role: 'specialist', objective: 'noop', timeoutMs: 60000 }] },
        policy: {},
        idempotencyKey: 'f1-p0-1-guard-collab',
      });
      await cs.withDatabase((db) => {
        db.prepare("UPDATE collaborations SET state = 'aggregating', aggregation_generation = 1, aggregation_claimed_generation = 1 WHERE id = ?").run(guardCollab.id);
      }, { mutate: true });

      const deniedOtherOp = await sessionManager.sendMessage(guardRoot1.id, 'untrusted internal op', [], {
        internalOperation: 'compaction',
        skipRunnerLaunch: true,
        recordUserMessage: false,
        sourceContext: { kind: 'collaboration_aggregation', collaborationId: guardCollab.id, aggregationGeneration: 1 },
      });
      assert.ok(deniedOtherOp?.run?.id);
      const deniedManifest = await runs.getRunManifest(deniedOtherOp.run.id);
      assert.equal(deniedManifest?.options?.sessionControlChannel, undefined, 'other internalOperations remain fail-closed');

      const guardRoot2 = await sessionManager.createSession(repoDir, 'claude-bidi', 'Guard Root 2', {
        projectId: project.id,
        sessionClass: 'ROOT_LEADERSHIP',
        sessionPlane: 'user',
        providerProfile: 'glm-68f6bd41',
        model: 'glm-5.3@glm-68f6bd41',
      });
      const guardCollab2 = await cs.createCollaborationRecord({
        rootSessionId: guardRoot2.id,
        title: 'spoof guard collab',
        plan: { version: 1, workspacePolicy: 'shared-exclusive', tasks: [{ id: 'g-t2', agentId: specialistApp.id, role: 'specialist', objective: 'noop', timeoutMs: 60000 }] },
        policy: {},
        idempotencyKey: 'f1-p0-1-spoof-guard',
      });
      await cs.withDatabase((db) => {
        db.prepare("UPDATE collaborations SET state = 'aggregating', aggregation_generation = 1, aggregation_claimed_generation = 1 WHERE id = ?").run(guardCollab2.id);
      }, { mutate: true });
      const spoofedUserAgg = await sessionManager.sendUserMessage(guardRoot2.id, 'spoofed user collab resume', [], {
        internalOperation: 'collaboration_resume',
        skipRunnerLaunch: true,
        sourceContext: { kind: 'collaboration_aggregation', collaborationId: guardCollab2.id, aggregationGeneration: 1 },
      });
      assert.ok(spoofedUserAgg?.run?.id);
      const spoofedManifest = await runs.getRunManifest(spoofedUserAgg.run.id);
      assert.equal(spoofedManifest?.options?.sessionControlChannel, undefined, 'public sendUserMessage strips internalOperation');

      // Also verify plain (non-org) collaboration aggregation succeeds cleanly with collaboration_resume
      const plainRoot = await sessionManager.createSession(repoDir, 'claude-bidi', 'Plain Collab Root', {
        projectId: project.id,
        sessionClass: 'ROOT_LEADERSHIP',
        sessionPlane: 'user',
        providerProfile: 'glm-68f6bd41',
        model: 'glm-5.3@glm-68f6bd41',
      });
      const plainCollab = await cs.createCollaborationRecord({
        rootSessionId: plainRoot.id,
        title: 'plain agg collab',
        plan: { version: 1, workspacePolicy: 'shared-exclusive', tasks: [{ id: 'p-t1', agentId: specialistApp.id, role: 'specialist', objective: 'noop', timeoutMs: 60000 }] },
        policy: {},
        idempotencyKey: 'f1-p0-1-plain-collab',
      });
      await cs.withDatabase((db) => {
        db.prepare("UPDATE collaborations SET state = 'aggregating', aggregation_generation = 1, aggregation_claimed_generation = 1 WHERE id = ?").run(plainCollab.id);
      }, { mutate: true });
      const plainAggRes = await sessionManager.sendMessage(plainRoot.id, 'plain aggregate', [], {
        internalOperation: 'collaboration_resume',
        requestId: `collaboration:${plainCollab.id}:aggregation:1`,
        skipRunnerLaunch: true,
        recordUserMessage: false,
        sourceContext: { kind: 'collaboration_aggregation', collaborationId: plainCollab.id, aggregationGeneration: 1 },
      });
      const plainAggManifest = await runs.getRunManifest(plainAggRes.run.id);
      assert.match(plainAggManifest?.options?.sessionControlChannel?.tokenHash || '', /^[a-f0-9]{64}$/, 'plain collaboration_resume also receives root sessionControlChannel');
      assert.equal(plainAggManifest?.options?.sessionControlChannel?.scope, undefined);
    } finally {
      orchestrator.stop();
    }
  }

  // ── 2. P0 #2: End-to-end Swarm `swarm.spawn` (`args.tool` + claude-bidi inheritance) + wakeup model propagation
  {
    const swarmRoot = await sessionManager.createSession(repoDir, 'claude-bidi', 'Swarm Claude Root', {
      projectId: project.id,
      sessionClass: 'ROOT_LEADERSHIP',
      sessionPlane: 'user',
      providerProfile: 'glm-68f6bd41',
      model: 'glm-5.3@glm-68f6bd41',
      effort: 'medium',
      riskMode: 'full-auto',
      riskModeExplicit: true,
    });
    const toolsDeps = {
      getSession: sessionManager.getSession,
      createSession: sessionManager.createSession,
      deliverSessionMessage: async (sid, text, images, opts) => sessionManager.sendMessage(sid, text, images, { ...opts, skipRunnerLaunch: true }),
      getRunState: async () => ({ running: false }),
      requestRunCancel: async () => null,
    };
    const spawnRes = await controlTools.executeOrganizationControlTool({
      authSession: {
        principalKind: 'run_capability',
        capabilityOperation: 'session.organization.tools',
        sessionId: swarmRoot.id,
        runId: 'run-swarm-root-test',
        turnId: 'turn-swarm-root-test',
      },
      action: 'swarm.spawn',
      args: { name: 'bidi-coder', tool: 'claude-bidi', brief: 'Inspect codebase cleanly', deferDelivery: true },
      deps: toolsDeps,
    });
    assert.equal(spawnRes.members.length, 1);
    const spawnedMember = spawnRes.members[0];
    assert.equal(spawnedMember.harness, 'claude-bidi');
    assert.equal(spawnedMember.provider, 'glm-68f6bd41');
    assert.equal(spawnedMember.model, 'glm-5.3@glm-68f6bd41');
    assert.equal(spawnedMember.effort, 'medium');

    const wakeErrors = [];
    const wakeStats = await swarm.deliverPendingSwarmWakeups({
      getSession: sessionManager.getSession,
      sendMessage: async (sid, text, images, opts) => {
        try {
          const out = await sessionManager.sendMessage(sid, text, images, { ...opts, skipRunnerLaunch: true });
          const wakeManifest = await runs.getRunManifest(out.run.id);
          assert.equal(out.run.tool, 'claude-bidi');
          assert.equal(out.run.model, 'glm-5.3@glm-68f6bd41');
          assert.equal(out.run.effort, 'medium');
          assert.equal(wakeManifest?.options?.providerProfile, 'glm-68f6bd41');
          assert.equal(wakeManifest?.options?.model, 'glm-5.3@glm-68f6bd41');
          assert.equal(wakeManifest?.options?.effort, 'medium');
          assert.equal(wakeManifest?.options?.riskMode, 'full-auto');
          assert.equal(wakeManifest?.options?.sessionControlChannel?.scope?.kind, 'organization_message');
          return out;
        } catch (err) {
          wakeErrors.push(err?.stack || String(err));
          throw err;
        }
      },
    }, { organizationId: spawnRes.organizationId });
    assert.equal(wakeStats.delivered, 1, `wakeStats=${JSON.stringify(wakeStats)} errors=${wakeErrors.join(' | ')}`);
  }

  // ── 3. P0 #3: Formal org non-empty writablePaths (`managedWriter`) resolves identity & organization_message scope
  {
    const mwRoot = await sessionManager.createSession(repoDir, 'claude-bidi', 'Formal MW Root', {
      projectId: project.id,
      templateId: managerApp.id,
      sessionClass: 'ROOT_LEADERSHIP',
      sessionPlane: 'user',
      providerProfile: 'glm-68f6bd41',
      model: 'glm-5.3@glm-68f6bd41',
    });
    const mwOrg = await orgStore.createOrganization({
      rootSessionId: mwRoot.id,
      projectId: project.id,
      state: 'active',
      currentRevision: 1,
      idempotencyKey: 'f1-p0-3-org',
    });
    const mwNodeId = 'node_f1_p0_3_mw';
    const mwTargetSess = await sessionManager.createSession(repoDir, 'claude-bidi', 'Formal MW Target', {
      sessionPlane: 'organization',
      sessionClass: 'WORKER',
      managedScope: 'organization',
      lifecycleMode: 'formal_org',
      organizationRootSessionId: mwRoot.id,
      organizationId: mwOrg.id,
      organizationNodeId: mwNodeId,
      organizationRevision: 1,
      roleInstanceId: 'rinst_mw_1',
      controllerSessionId: mwRoot.id,
      parentSessionId: mwRoot.id,
      delegatedFromSessionId: mwRoot.id,
      delegationDepth: 1,
      providerProfile: 'glm-68f6bd41',
      model: 'glm-5.3@glm-68f6bd41',
      riskMode: 'full-auto',
      riskModeExplicit: true,
    });
    const mwNode = await orgStore.createNode({
      id: mwNodeId,
      organizationId: mwOrg.id,
      stableKey: 'mw-worker',
      nodeRole: 'worker',
      createdRevision: 1,
      lifecycleState: 'active',
      lifecycleMode: 'formal_org',
      grant: { canWrite: true, canDelegate: false, writablePaths: ['work'] },
      currentSessionId: mwTargetSess.id,
      bindingGeneration: 1,
      roleInstanceId: 'rinst_mw_1',
      sessionClass: 'WORKER',
    });
    await orgStore.createRevision(mwOrg.id, {
      revision: 1,
      proposal: {
        nodes: [{ stableKey: 'mw-worker', nodeRole: 'worker', displayName: 'MW Worker', domain: 'backend', responsibility: 'Edit work' }],
        edges: [],
      },
      compiled: {
        nodes: [{ stableKey: 'mw-worker', nodeRole: 'worker', displayName: 'MW Worker', domain: 'backend', responsibility: 'Edit work' }],
        edges: [],
      },
    });
    await orgStore.freezeRevision(mwOrg.id, 1);

    const deliveredRuns = [];
    const mwOrchestrator = createCollaborationOrchestrator({
      pollMs: 100000,
      managedWriterEnabled: true,
      dependencies: {
        getSession: sessionManager.getSession,
        getApp: appsMod.getApp,
        createSession: sessionManager.createSession,
        sendMessage: async (sid, text, images, opts) => {
          const res = await sessionManager.sendMessage(sid, text, images, { ...opts, skipRunnerLaunch: true });
          deliveredRuns.push({ sessionId: sid, runId: res.run.id });
          return res;
        },
        getRunState: sessionManager.getRunState,
        getRun: runs.getRun,
        getRunResult: runs.getRunResult,
        getRunManifest: runs.getRunManifest,
        findRunByRequest: runs.findRunByRequest,
        listRunIds: async () => [],
        getProject: async () => project,
        requestRunCancel: async () => null,
        loadHistory: async () => [],
      },
    });
    try {
      const mwCollab = await mwOrchestrator.dispatch({
        rootSessionId: mwRoot.id,
        idempotencyKey: 'f1-p0-3-dispatch',
        policy: {
          ...managerApp.collaborationPolicy,
          organizationId: mwOrg.id,
          organizationNodeId: mwNode.id,
          organizationBindingGeneration: 1,
          organizationRevision: 1,
        },
        plan: {
          title: 'Formal MW writablePaths task',
          workspacePolicy: 'shared-exclusive',
          tasks: [{
            id: 'mw-task-1',
            agentId: specialistApp.id,
            objective: 'Write inside work/',
            acceptance: ['done'],
            writablePaths: ['work'],
            accessMode: 'write',
            managedSessionId: mwTargetSess.id,
          }],
        },
      });
      assert.equal(deliveredRuns.length, 1, 'managedWriter dispatch succeeds on first drain without ORG_IDENTITY_UNAVAILABLE');
      const stagingChildId = deliveredRuns[0].sessionId;
      assert.notEqual(stagingChildId, mwTargetSess.id, 'managedWriter creates staging child rather than mutating managedTarget');
      const latestNode = await orgStore.getNode(mwNode.id);
      assert.equal(latestNode.currentSessionId, mwTargetSess.id, 'organization_nodes.current_session_id stays pinned to managedTarget');

      const stagingChild = await sessionManager.getSession(stagingChildId);
      assert.equal(stagingChild.organizationId, mwOrg.id);
      assert.equal(stagingChild.organizationNodeId, mwNode.id);
      assert.equal(stagingChild.parentSessionId, mwTargetSess.id);
      assert.equal(stagingChild.lifecycleMode, 'formal_org');

      const identityXml = await identityCtx.buildOrganizationIdentityContext(stagingChild);
      const identityMatch = identityXml.match(/<organization-identity>\n([^\n]+)\n/);
      assert.ok(identityMatch, 'staging child resolves <organization-identity> XML');
      const identityPayload = JSON.parse(identityMatch[1]);
      assert.equal(identityPayload.organizationId, mwOrg.id);
      assert.equal(identityPayload.nodeId, mwNode.id);
      assert.equal(identityPayload.revision, 1);
      assert.equal(identityPayload.attemptId, mwCollab.attempts[0].id);

      const stagingManifest = await runs.getRunManifest(deliveredRuns[0].runId);
      assert.deepEqual(stagingManifest?.options?.sessionControlChannel?.scope, {
        kind: 'organization_message',
        organizationId: mwOrg.id,
        nodeId: mwNode.id,
        bindingGeneration: 1,
        organizationRevision: 1,
      }, 'managedWriter staging child run receives organization_message capability scope');

      const stagingCaps = await controlTools.executeOrganizationControlTool({
        authSession: {
          principalKind: 'run_capability',
          capabilityOperation: 'organization.tools',
          sessionId: stagingChildId,
          runId: deliveredRuns[0].runId,
          organizationMessageScope: stagingManifest.options.sessionControlChannel.scope,
        },
        action: 'capabilities.get',
        deps: {},
      });
      assert.equal(stagingCaps.canSwarm, true);

      // Verify formal_org fencing remains intact once node is retired
      await orgStore.retireNode(mwNode.id, { retiredRevision: 1 });
      await assert.rejects(
        () => identityCtx.buildOrganizationIdentityContext(stagingChild),
        (err) => err?.code === 'ORG_IDENTITY_UNAVAILABLE',
        'retired formal_org node still fences staging child with ORG_IDENTITY_UNAVAILABLE',
      );
    } finally {
      mwOrchestrator.stop();
    }
  }

  // ── 4. P1 #4b: Failed pre-launch (`PROVIDER_HOME_PREPARE_FAILED` / broker-required) transitions out of queued & releases adaptive slot
  {
    const prepErr = Object.assign(new Error('Provider preparation failed (model-missing)'), {
      code: 'PROVIDER_HOME_PREPARE_FAILED',
      causeCode: 'model-missing',
    });
    await assert.rejects(
      () => spawnDetachedRunnerAsProcess('run_prep_fail_proc', {
        prepareProviderImpl: async () => { throw prepErr; },
      }),
      (err) => err?.launchDefinitelyNotSubmitted === true && err?.launchStage === 'provider-preparation',
      'spawnDetachedRunnerAsProcess marks prepare failure launchDefinitelyNotSubmitted=true',
    );
    await assert.rejects(
      () => launchDetachedRunnerViaSystemd('run_prep_fail_systemd', {
        scope: 'user',
        prepareProviderImpl: async () => { throw prepErr; },
      }),
      (err) => err?.launchDefinitelyNotSubmitted === true && err?.launchStage === 'provider-preparation',
      'launchDetachedRunnerViaSystemd marks prepare failure launchDefinitelyNotSubmitted=true',
    );
    let plainFallbackCalled = false;
    const linuxSpawner = createDetachedRunnerSpawner({
      platform: 'linux',
      getScopeImpl: () => 'user',
      assertExecutionBoundaryImpl: async () => {},
      prepareProviderImpl: async () => { throw prepErr; },
      execFileImpl: async () => { throw new Error('systemd-run should not execute after prepare failure'); },
      spawnImpl: () => { plainFallbackCalled = true; return { unref() {}, pid: 1 }; },
    });
    await assert.rejects(
      () => linuxSpawner('run_prep_fail_linux_spawner'),
      (err) => err?.launchDefinitelyNotSubmitted === true && err?.launchStage === 'provider-preparation',
      'systemd launcher rethrows provider-preparation failure without plain fallback',
    );
    assert.equal(plainFallbackCalled, false);

    let storedStuck = {
      state: 'queued',
      runnerLaunchState: 'lifecycle_submitting',
      failureReason: 'Runner launch failed: model-missing',
      createdAt: new Date(Date.now() - 10_000).toISOString(),
    };
    const reconcile = createDetachedRunReconciler({
      appendRunSpoolRecord: async () => {},
      collectRunOutputPreview: () => '',
      graceMs: 0,
      launchGraceMs: 0,
      lifecycleTimeoutMs: 0,
      isTerminalRunState: (state) => ['completed', 'failed', 'cancelled'].includes(state),
      nowIso: () => new Date().toISOString(),
      stallAfterMs: 60_000,
      checkProcessAlive: () => false,
      checkRunnerUnitActive: async () => false,
      getRunResult: async () => null,
      readRunControl: async () => null,
      updateRun: async (_id, fn) => {
        storedStuck = fn(storedStuck);
        return storedStuck;
      },
      writeRunResult: async () => {},
    });
    const healthyQueued = await reconcile('run_healthy_q', { state: 'queued', runnerLaunchState: 'adaptive_capacity' });
    assert.equal(healthyQueued, null, 'healthy queued run is preserved');
    await reconcile('run_stuck_q', storedStuck);
    assert.ok(storedStuck.missingResultDetectedAt, 'stuck queued run is not skipped by reconciler');
    const stuckQueued = await reconcile('run_stuck_q', storedStuck);
    assert.equal(stuckQueued?.state, 'failed', 'stuck queued run with lifecycle_submitting & failureReason settles to failed');

    // End-to-end sessionManager adaptive.harness:claude-bidi slot test across two concurrent claude-bidi sessions
    const claudeSess1 = await sessionManager.createSession(repoDir, 'claude-bidi', 'Slot Leak Test 1', {
      projectId: project.id,
      providerProfile: 'glm-68f6bd41',
      model: 'glm-5.3@glm-68f6bd41',
    });
    const claudeSess2 = await sessionManager.createSession(repoDir, 'claude-bidi', 'Slot Leak Test 2', {
      projectId: project.id,
      providerProfile: 'glm-68f6bd41',
      model: 'glm-5.3@glm-68f6bd41',
    });
    const budget = getAdaptiveHarnessBudget('claude-bidi');
    const baselineActive = budget.active;
    const heldLease = budget.tryAcquire({ priority: 'interactive' });
    assert.ok(heldLease, 'test acquires single claude-bidi slot to force queueing');
    assert.equal(budget.active, baselineActive + 1);

    const queued1 = await sessionManager.sendMessage(claudeSess1.id, 'first queued turn', [], {
      skipRunnerLaunch: false,
      recordUserMessage: false,
    });
    const queued2 = await sessionManager.sendMessage(claudeSess2.id, 'second queued turn', [], {
      skipRunnerLaunch: false,
      recordUserMessage: false,
    });
    assert.equal(queued1.queued, true);
    assert.equal(queued2.queued, true);
    assert.equal((await runs.getRun(queued1.run.id)).state, 'queued');
    assert.equal((await runs.getRun(queued2.run.id)).state, 'queued');

    const prevLifecycleRequired = process.env.RAGENT_RUNNER_LIFECYCLE_REQUIRED;
    const prevLifecycleSocket = process.env.RAGENT_RUNNER_LIFECYCLE_SOCKET;
    process.env.RAGENT_RUNNER_LIFECYCLE_REQUIRED = '1';
    delete process.env.RAGENT_RUNNER_LIFECYCLE_SOCKET;
    try {
      heldLease.release({ outcome: 'success' });
      assert.equal(budget.active, baselineActive);
      await sessionManager.__drainAdaptiveRunQueueForTest();

      const after1 = await runs.getRun(queued1.run.id);
      const after2 = await runs.getRun(queued2.run.id);
      assert.equal(after1.state, 'failed', 'failed pre-launch run1 must NOT stay stuck in queued');
      assert.equal(after1.runnerLaunchState, 'failed');
      assert.equal(after1.adaptiveQueue, undefined);
      assert.ok(String(after1.failureReason || '').includes('Runner launch failed:'));
      assert.equal(after2.state, 'failed', 'run2 must drain cleanly instead of remaining wedged in adaptive_capacity');
      assert.equal(after2.runnerLaunchState, 'failed');
      assert.equal(budget.active, baselineActive, 'claude-bidi adaptive concurrency slot must return to 0 after failures');
      assert.equal(sessionManager.__harnessRunLeasesForTest.has(queued1.run.id), false);
      assert.equal(sessionManager.__harnessRunLeasesForTest.has(queued2.run.id), false);
      assert.equal(sessionManager.__adaptiveQueuedRunIdsForTest.has(queued1.run.id), false);
      assert.equal(sessionManager.__adaptiveQueuedRunIdsForTest.has(queued2.run.id), false);
    } finally {
      if (prevLifecycleRequired === undefined) delete process.env.RAGENT_RUNNER_LIFECYCLE_REQUIRED;
      else process.env.RAGENT_RUNNER_LIFECYCLE_REQUIRED = prevLifecycleRequired;
      if (prevLifecycleSocket === undefined) delete process.env.RAGENT_RUNNER_LIFECYCLE_SOCKET;
      else process.env.RAGENT_RUNNER_LIFECYCLE_SOCKET = prevLifecycleSocket;
    }
  }

  // ── 4. P0 Windows managedWriter riskMode inheritance + staging admission + Formal Org staging conversation resolution
  {
    const { createStagingWorkspace, commitStagingToCanonical, discardStaging } = await import('../chat/managed-writer.mjs');
    const { createManagedSessionForNode } = await import('../chat/organization-managed-session-factory.mjs');
    const { makeMemberRef } = await import('../chat/organization-member-reference.mjs');
    const { handleOrganizationRoutes } = await import('../chat/router-organization-routes.mjs');
    const { resolveRunRiskContext } = await import('../chat/runner-sidecar.mjs');
    const { existsSync, realpathSync } = await import('node:fs');

    const rootRec = await sessionManager.createSession(repoDir, 'claude-bidi', 'Recommended Formal Root', {
      projectId: project.id,
      templateId: managerApp.id,
      sessionClass: 'ROOT_LEADERSHIP',
      sessionPlane: 'user',
      providerProfile: 'glm-68f6bd41',
      model: 'glm-5.3@glm-68f6bd41',
      riskMode: 'recommended',
    });
    const orgRec = await orgStore.createOrganization({
      rootSessionId: rootRec.id,
      projectId: project.id,
      state: 'active',
      currentRevision: 1,
      idempotencyKey: 'f1-p0-managed-writer-staging-conv',
    });
    const leadNodeId = 'node_f1_lead_staging';
    const managedLead = await createManagedSessionForNode({
      organizationId: orgRec.id,
      organizationRevision: 1,
      organizationNodeId: leadNodeId,
      roleInstanceId: 'rinst_lead_staging',
      stableKey: 'lead',
      role: 'specialist',
      agentId: specialistApp.id,
      sessionClass: 'WORKER',
      idempotencyKey: 'f1-managed-lead-session',
    });
    const leadTarget = await sessionManager.getSession(managedLead.sessionId);
    assert.equal(leadTarget.riskMode, 'recommended', 'managedTarget inherits recommended riskMode from root');

    const leadNode = await orgStore.createNode({
      id: leadNodeId,
      organizationId: orgRec.id,
      stableKey: 'lead',
      nodeRole: 'specialist',
      createdRevision: 1,
      lifecycleState: 'active',
      lifecycleMode: 'formal_org',
      grant: { canWrite: true, canDelegate: false, writablePaths: ['work'] },
      currentSessionId: leadTarget.id,
      bindingGeneration: 1,
      roleInstanceId: 'rinst_lead_staging',
      sessionClass: 'WORKER',
    });
    await orgStore.createRevision(orgRec.id, {
      revision: 1,
      proposal: {
        nodes: [{ stableKey: 'lead', nodeRole: 'specialist', displayName: 'Lead', responsibility: 'Write deliverables' }],
        edges: [],
        phases: [{ phaseId: 'phase-1', objective: 'Deliver work' }],
      },
      compiled: {
        nodes: [{ stableKey: 'lead', nodeRole: 'specialist', displayName: 'Lead', responsibility: 'Write deliverables', phaseId: 'phase-1' }],
        edges: [],
        phases: [{ phaseId: 'phase-1', objective: 'Deliver work' }],
      },
    });
    await orgStore.freezeRevision(orgRec.id, 1);

    let stagingRunId = '';
    let stagingChildId = '';
    const stagingOrchestrator = createCollaborationOrchestrator({
      pollMs: 100000,
      dependencies: {
        getSession: sessionManager.getSession,
        getApp: appsMod.getApp,
        createSession: sessionManager.createSession,
        createStagingWorkspace,
        commitStagingToCanonical,
        discardStaging,
        sendMessage: async (sid, text, images, opts) => {
          const res = await sessionManager.sendMessage(sid, text, images, { ...opts, skipRunnerLaunch: true });
          if (opts?.internalOperation === 'collaboration_task') {
            stagingChildId = sid;
            stagingRunId = res.run.id;
          }
          return res;
        },
        getRunState: async (id) => runs.getRun(id),
        getRun: runs.getRun,
        getRunResult: runs.getRunResult,
        getRunManifest: runs.getRunManifest,
        findRunByRequest: runs.findRunByRequest,
        listRunIds: async () => [],
        getProject: async () => project,
        requestRunCancel: async () => null,
        loadHistory: async (sid, runId) => [{
          type: 'message',
          role: 'assistant',
          runId: runId || stagingRunId,
          content: 'Lead staging deliverable written.',
        }],
      },
    });
    try {
      const stagingCollab = await stagingOrchestrator.dispatch({
        rootSessionId: rootRec.id,
        idempotencyKey: 'f1-managed-writer-collab',
        policy: {
          ...managerApp.collaborationPolicy,
          organizationId: orgRec.id,
          organizationNodeId: leadNode.id,
          organizationBindingGeneration: 1,
          organizationRevision: 1,
          organizationPhaseDispatch: { revision: 1, phaseId: 'phase-1' },
        },
        plan: {
          title: 'staging delivery',
          workspacePolicy: 'shared-exclusive',
          tasks: [{
            id: 'task-lead-stage',
            agentId: specialistApp.id,
            role: 'specialist',
            objective: 'Write staging file',
            writablePaths: ['work'],
            managedSessionId: leadTarget.id,
          }],
        },
      });
      assert.ok(stagingChildId && stagingChildId !== leadTarget.id, 'managedWriter dispatches into staging child session');
      assert.ok(stagingRunId, 'staging child run created');
      const stagingChildSession = await sessionManager.getSession(stagingChildId);
      assert.equal(stagingChildSession.riskMode, 'recommended', 'staging child preserves recommended riskMode from managedTarget');

      const stagingManifest = await runs.getRunManifest(stagingRunId);
      const realStagingDir = realpathSync(stagingChildSession.folder);
      assert.equal(
        stagingManifest.executionScope?.riskContext?.managedWriterStagingRoot,
        realStagingDir,
        'Formal Org managedWriter run admission attests managedWriterStagingRoot',
      );
      assert.equal(
        stagingManifest.executionScope?.riskContext?.trustedWorkspaceRoot,
        realStagingDir,
        'Formal Org managedWriter run admission scopes trustedWorkspaceRoot to stagingDir rather than canonical project root',
      );
      assert.equal(
        resolveRunRiskContext(stagingManifest).valid,
        true,
        'runner-sidecar validates Formal Org managedWriter executionScopeDigest and riskContext',
      );

      // managedTarget has 0 timeline entries while execution ran in stagingChildId.
      const stagingMsgText = 'Lead staging deliverable written.';
      const stagingMsg = await sessionManager.appendAssistantMessage(stagingChildId, stagingMsgText, [], {
        runId: stagingRunId,
        requestId: stagingManifest.requestId,
      });

      const invokeOrgGet = async (pathname) => {
        let statusCode = 0;
        let payload = null;
        await handleOrganizationRoutes({
          req: { method: 'GET', headers: { host: 'localhost' }, url: pathname },
          res: { setHeader() {} },
          pathname: pathname.split('?')[0],
          authSession: { role: 'owner' },
          writeJson: (_res, status, body) => { statusCode = status; payload = body; },
        });
        return { statusCode, payload };
      };

      const leadRef = makeMemberRef({ kind: 'formal', root: rootRec.id, id: leadNode.id, generation: 1 });
      const memberConv = await invokeOrgGet(`/api/sessions/${encodeURIComponent(rootRec.id)}/organization/members/${encodeURIComponent(leadRef)}/conversation?limit=20`);
      assert.equal(memberConv.statusCode, 200);
      assert.equal(memberConv.payload.scope, 'full');
      assert.ok(memberConv.payload.entries.length >= 1, 'members/:ref/conversation resolves staging child entries instead of entries: 0');
      assert.ok(
        memberConv.payload.entries.some((entry) => String(entry?.content || '').includes('Lead staging deliverable written.')),
        'members/:ref/conversation exposes staging child assistant message',
      );

      const nodeConv = await invokeOrgGet(`/api/organizations/${encodeURIComponent(orgRec.id)}/nodes/${encodeURIComponent(leadNode.id)}/conversation`);
      assert.equal(nodeConv.statusCode, 200);
      assert.equal(nodeConv.payload.currentBinding?.sessionId, stagingChildId, 'nodes/:nodeId/conversation resolves verified staging child session when managedTarget is empty');

      // Stale generation still fences strictly.
      const staleRef = makeMemberRef({ kind: 'formal', root: rootRec.id, id: leadNode.id, generation: 99 });
      const staleConv = await invokeOrgGet(`/api/sessions/${encodeURIComponent(rootRec.id)}/organization/members/${encodeURIComponent(staleRef)}/conversation?limit=20`);
      assert.equal(staleConv.statusCode, 409);
      assert.equal(staleConv.payload.code, 'ORGANIZATION_BINDING_CHANGED');

      // Item 5 (P2 #4): projection v2 transitions completed phase from 'planned' to 'completed'
      // without fabricating a passed gate.
      const { buildOrganizationProjection } = await import('../chat/organization-projection.mjs');
      const { createHash } = await import('node:crypto');
      mkdirSync(join(stagingChildSession.folder, 'work'), { recursive: true });
      writeFileSync(join(stagingChildSession.folder, 'work', 'lead-notes.md'), 'delivered via staging\n', 'utf8');
      const stagingDoneAt = new Date().toISOString();
      const stagingHash = createHash('sha256').update(stagingMsgText).digest('hex');
      await history.appendEvent(stagingChildId, {
        type: 'status',
        content: 'completed',
        providerLifecycle: 'completed',
        runState: 'completed',
        deliveryContentHash: stagingHash,
        runId: stagingRunId,
        requestId: stagingManifest.requestId,
      });
      const stagingDoneResult = {
        exitCode: 0,
        signal: null,
        completedAt: stagingDoneAt,
        finalDelivery: { contentHash: stagingHash, eventSeq: stagingMsg?.seq },
      };
      await runs.writeRunResult(stagingRunId, stagingDoneResult);
      await runs.updateRun(stagingRunId, (current) => ({
        ...current,
        state: 'completed',
        completedAt: stagingDoneAt,
        finalizedAt: stagingDoneAt,
        result: stagingDoneResult,
      }));
      assert.equal(await stagingOrchestrator.completeRun(stagingRunId), true, 'staging orchestrator completes staging run cleanly');
      assert.equal(existsSync(join(repoDir, 'work', 'lead-notes.md')), true, 'managedWriter committed staged deliverable to canonical repo');
      const collabBeforeAgg = await stagingOrchestrator.get(stagingCollab.id);
      const aggRunId = collabBeforeAgg?.aggregationRunId || await stagingOrchestrator.maybeAggregate(stagingCollab.id);
      if (aggRunId) {
        const aggDoneAt = new Date().toISOString();
        const aggResult = { exitCode: 0, signal: null, completedAt: aggDoneAt };
        await runs.writeRunResult(aggRunId, aggResult);
        await runs.updateRun(aggRunId, (current) => ({
          ...current,
          state: 'completed',
          completedAt: aggDoneAt,
          finalizedAt: aggDoneAt,
          result: aggResult,
        }));
        await stagingOrchestrator.completeAggregation(aggRunId);
      }
      const projV2 = await buildOrganizationProjection(orgRec.id, { version: 2 });
      const projPhase = projV2?.phases?.find((p) => p.phaseId === 'phase-1');
      const collabAfterComplete = await stagingOrchestrator.get(stagingCollab.id);
      const failureDiag = JSON.stringify({
        collabState: collabAfterComplete?.state,
        taskState: collabAfterComplete?.tasks?.[0]?.state,
        attemptState: collabAfterComplete?.attempts?.[0]?.state,
        attemptFailure: collabAfterComplete?.attempts?.[0]?.failureReason,
        projPhase,
      });
      assert.equal(projPhase?.state, 'completed', `P2 #4: completed phase derives state=completed instead of planned (${failureDiag})`);
      assert.equal(projPhase?.reviewState, 'pending', 'P2 #4: reviewState remains honestly pending without a passed gate');
      assert.equal(projPhase?.gate ?? null, null, 'P2 #4: gate fact is not fabricated');

      // ── 5. P2 polish #1: publicAttempt emits bounded, secret-redacted resultPacketSummary/Verdict & Android DTO parity
      const resultPacketsMod = await import('../chat/result-packets.mjs');
      const collabStoreMod = await import('../chat/collaboration-store.mjs');
      const messagingMod = await import('../chat/organization-messaging.mjs');
      const { assertPublicProjection } = await import('../chat/organization-projection.mjs');
      const { collectOrganizationStatus } = await import('../chat/organization-status-projection.mjs');
      try {
        const longText = `${'Implemented server summary cleanly. '.repeat(20)}`;
        const summaryRunId = 'run_p2_summary_1';
        await runs.ensureRunDirectory(summaryRunId);
        await runs.createRun({
          status: { id: summaryRunId, sessionId: leadTarget.id, requestId: 'req_p2_summary_1', state: 'completed', finalizedAt: stagingDoneAt },
          manifest: {
            sessionId: leadTarget.id,
            requestId: 'req_p2_summary_1',
            projectId: project.id,
            executionScopeDigest: 'sha256:p2-summary-scope',
            executionScope: { projectId: project.id, sessionId: leadTarget.id, workspaceRevision: 1, git: { state: 'not_git' } },
          },
        });
        await runs.writeRunResult(summaryRunId, {
          summary: `Leaked sk-secretTokenValue987654321 and Authorization: Bearer topsecret_token_999.\n<ragent-result-packet>{"state":"completed","summary":"Summary with sk-secretTokenValue987654321 and Bearer my_bearer_999 ${longText}"}</ragent-result-packet>`,
        });
        const richPacket = await resultPacketsMod.createExecutionPacket({
          runId: summaryRunId,
          projectId: project.id,
          sessionId: leadTarget.id,
          taskId: 'task-p2-rich',
          attemptId: 'att-p2-rich',
          organizationId: orgRec.id,
          nodeId: leadNode.id,
          revision: 1,
          phaseId: 'phase-1',
        });

        // Use collectOrganizationStatus directly to test rich packet, missing packet, and empty-packet cases cleanly.
        const richStatus = await collectOrganizationStatus({
          organizationId: orgRec.id,
          organization: orgRec,
          revision: await orgStore.getRevision(orgRec.id, 1),
          nodes: [leadNode],
          events: await messagingMod.listOrganizationEvents(orgRec.id),
          gates: await orgStore.listOrganizationGates(orgRec.id),
          collaborations: [{
            id: 'col_rich_1',
            state: 'completed',
            updatedAt: stagingDoneAt,
            policy: {
              organizationId: orgRec.id,
              organizationNodeId: leadNode.id,
              organizationBindingGeneration: 1,
            },
            tasks: [{ id: 'task-p2-rich', state: 'succeeded', objective: 'Summarize', runId: summaryRunId, updatedAt: stagingDoneAt }],
            attempts: [{
              id: 'att-p2-rich',
              taskId: 'task-p2-rich',
              attemptNumber: 1,
              state: 'succeeded',
              sessionId: leadTarget.id,
              runId: summaryRunId,
              resultPacketId: richPacket.packetId,
              report: { summary: 'Fallback report summary' },
              startedAt: stagingDoneAt,
              completedAt: stagingDoneAt,
              updatedAt: stagingDoneAt,
            }],
          }],
          runResolver: async () => ({ id: summaryRunId, sessionId: leadTarget.id, state: 'completed', startedAt: stagingDoneAt, completedAt: stagingDoneAt }),
        });
        const richNode = richStatus.nodes[0];
        assert.equal(richNode.attempt.resultPacketId, richPacket.packetId);
        assert.ok(richNode.attempt.resultPacketSummary, 'publicAttempt emits non-empty resultPacketSummary');
        assert.ok(richNode.attempt.resultPacketSummary.length <= 400, 'resultPacketSummary is bounded to <= 400 chars');
        assert.equal(richNode.attempt.resultPacketSummary.includes('sk-secretTokenValue987654321'), false, 'raw sk- secret redacted');
        assert.equal(richNode.attempt.resultPacketSummary.includes('topsecret_token_999'), false, 'raw bearer token redacted');
        assert.equal(richNode.attempt.resultPacketSummary.includes('my_bearer_999'), false, 'extracted bearer token redacted');
        assert.equal(richNode.attempt.resultPacketSummary.includes('<ragent-result-packet>'), false, 'raw packet XML tags stripped');
        assert.ok(richNode.attempt.resultPacketSummary.includes('[redacted]'), 'redaction marker replaces secrets');
        assert.equal(richNode.attempt.resultPacketVerdict, 'succeeded', 'resultPacketVerdict reflects canonical packet state');
        assert.equal(richNode.resultPacketId, richPacket.packetId, 'node exposes resultPacketId for Android DTO');
        assert.equal(richNode.resultPacketSummary, richNode.attempt.resultPacketSummary, 'node exposes resultPacketSummary for Android DTO');
        assert.equal(richNode.attempt.summary, richNode.attempt.resultPacketSummary, 'attempt exposes Android summary field');

        // Clean summary passes assertPublicProjection end-to-end.
        const cleanRunId = 'run_p2_clean_1';
        await runs.ensureRunDirectory(cleanRunId);
        await runs.createRun({
          status: { id: cleanRunId, sessionId: leadTarget.id, requestId: 'req_p2_clean_1', state: 'completed', finalizedAt: stagingDoneAt },
          manifest: {
            sessionId: leadTarget.id,
            requestId: 'req_p2_clean_1',
            projectId: project.id,
            executionScopeDigest: 'sha256:p2-clean-scope',
            executionScope: { projectId: project.id, sessionId: leadTarget.id, workspaceRevision: 1, git: { state: 'not_git' } },
          },
        });
        await runs.writeRunResult(cleanRunId, { summary: 'All unit checks passed in work/lead-notes.md.' });
        const cleanPacket = await resultPacketsMod.createExecutionPacket({
          runId: cleanRunId,
          projectId: project.id,
          sessionId: leadTarget.id,
          taskId: 'task-p2-clean',
          attemptId: 'att-p2-clean',
        });
        const cleanStatus = await collectOrganizationStatus({
          organizationId: orgRec.id,
          organization: orgRec,
          revision: await orgStore.getRevision(orgRec.id, 1),
          nodes: [leadNode],
          events: [],
          gates: [],
          collaborations: [{
            id: 'col_clean_1',
            state: 'completed',
            updatedAt: stagingDoneAt,
            policy: { organizationId: orgRec.id, organizationNodeId: leadNode.id, organizationBindingGeneration: 1 },
            tasks: [{ id: 'task-p2-clean', state: 'succeeded', objective: 'Clean', runId: cleanRunId, updatedAt: stagingDoneAt }],
            attempts: [{
              id: 'att-p2-clean',
              taskId: 'task-p2-clean',
              attemptNumber: 1,
              state: 'succeeded',
              sessionId: leadTarget.id,
              runId: cleanRunId,
              resultPacketId: cleanPacket.packetId,
              updatedAt: stagingDoneAt,
            }],
          }],
        });
        assert.equal(cleanStatus.nodes[0].attempt.resultPacketSummary, 'All unit checks passed in work/lead-notes.md.');
        assertPublicProjection({ schemaVersion: 2, nodes: cleanStatus.nodes, phases: cleanStatus.phases });

        // Missing packet in store + no report summary -> null summary/verdict; no raw failureReason leak.
        const missingPacketStatus = await collectOrganizationStatus({
          organizationId: orgRec.id,
          organization: orgRec,
          revision: await orgStore.getRevision(orgRec.id, 1),
          nodes: [leadNode],
          events: [],
          gates: [],
          collaborations: [{
            id: 'col_missing_1',
            state: 'completed',
            updatedAt: stagingDoneAt,
            policy: { organizationId: orgRec.id, organizationNodeId: leadNode.id, organizationBindingGeneration: 1 },
            tasks: [{ id: 'task-p2-missing', state: 'succeeded', objective: 'Missing', runId: 'run_none', updatedAt: stagingDoneAt }],
            attempts: [{
              id: 'att-p2-missing',
              taskId: 'task-p2-missing',
              attemptNumber: 1,
              state: 'succeeded',
              sessionId: leadTarget.id,
              runId: 'run_none',
              resultPacketId: 'rsp_missing_999',
              failureReason: 'raw internal error must not leak',
              updatedAt: stagingDoneAt,
            }],
          }],
        });
        assert.equal(missingPacketStatus.nodes[0].attempt.resultPacketId, 'rsp_missing_999');
        assert.equal(missingPacketStatus.nodes[0].attempt.resultPacketSummary, null, 'missing packet cleanly yields null resultPacketSummary');
        assert.equal(missingPacketStatus.nodes[0].attempt.resultPacketVerdict, null, 'missing packet cleanly yields null resultPacketVerdict');
        assert.equal(missingPacketStatus.nodes[0].resultPacketSummary, undefined, 'node omits empty resultPacketSummary so Android falls back to ResultPacket ID');
        assert.equal(JSON.stringify(missingPacketStatus).includes('raw internal error must not leak'), false);

        // Unpacketized failed attempt -> null resultPacketSummary/Verdict even when report exists.
        const noPacketFailedStatus = await collectOrganizationStatus({
          organizationId: orgRec.id,
          organization: orgRec,
          revision: await orgStore.getRevision(orgRec.id, 1),
          nodes: [leadNode],
          events: [],
          gates: [],
          collaborations: [{
            id: 'col_nopkt_1',
            state: 'failed',
            updatedAt: stagingDoneAt,
            policy: { organizationId: orgRec.id, organizationNodeId: leadNode.id, organizationBindingGeneration: 1 },
            tasks: [{ id: 'task-p2-nopkt', state: 'failed', objective: 'Failed', runId: 'run_fail', updatedAt: stagingDoneAt }],
            attempts: [{
              id: 'att-p2-nopkt',
              taskId: 'task-p2-nopkt',
              attemptNumber: 1,
              state: 'failed',
              failureKind: 'deterministic_failure',
              failureReason: 'super secret failure',
              sessionId: leadTarget.id,
              runId: 'run_fail',
              resultPacketId: '',
              report: { summary: 'Raw failed summary' },
              updatedAt: stagingDoneAt,
            }],
          }],
        });
        assert.equal(noPacketFailedStatus.nodes[0].attempt.resultPacketId, null);
        assert.equal(noPacketFailedStatus.nodes[0].attempt.resultPacketSummary, null);
        assert.equal(noPacketFailedStatus.nodes[0].attempt.resultPacketVerdict, null);
      } finally {
        await resultPacketsMod.closeResultPacketStore?.().catch(() => {});
      }

      // ── 6. P2 polish #2: Auto-persist phase.completed when reviewPolicy.required === false to unblock dependsOn,
      // while preserving 409 ORG_PHASE_DEPENDENCY_BLOCKED for incomplete or reviewPolicy.required === true phases.
      {
        const { dispatchOrganizationPhase, phaseDependenciesCompleted } = await import('../chat/organization-phase-dispatch.mjs');
        const { reconcileReviewOptionalPhaseCompletions } = await import('../chat/organization-phase-completion.mjs');
        const { decideGate, completePhase } = await import('../chat/phase-gates.mjs');
        const seqWriterApp = await appsMod.createApp({
          name: 'Claude Seq Writer',
          tool: 'claude-bidi',
          capabilities: ['read', 'write'],
          accessMode: 'writer',
          collaborationPolicy: {
            role: 'specialist',
            canDelegate: false,
            accessMode: 'writer',
            capabilities: ['read', 'write'],
            revision: 'seq-w-r1',
          },
        });

        const makeSequentialOrg = async ({ keyPrefix, reviewRequiredPolicy }) => {
          const seqRoot = await sessionManager.createSession(repoDir, 'claude-bidi', `Seq Root ${keyPrefix}`, {
            projectId: project.id,
            templateId: managerApp.id,
            sessionClass: 'ROOT_LEADERSHIP',
            sessionPlane: 'user',
            providerProfile: 'glm-68f6bd41',
            model: 'glm-5.3@glm-68f6bd41',
            riskMode: 'recommended',
          });
          const seqOrg = await orgStore.createOrganization({
            rootSessionId: seqRoot.id,
            projectId: project.id,
            state: 'active',
            currentRevision: 1,
            idempotencyKey: `${keyPrefix}-org`,
          });
          const seqLeadNodeId = `node_${keyPrefix}_lead`;
          const seqWorkerNodeId = `node_${keyPrefix}_worker`;
          const seqLeadSess = await createManagedSessionForNode({
            organizationId: seqOrg.id,
            organizationRevision: 1,
            organizationNodeId: seqLeadNodeId,
            roleInstanceId: `rinst_${keyPrefix}_lead`,
            stableKey: 'lead',
            role: 'specialist',
            agentId: seqWriterApp.id,
            sessionClass: 'WORKER',
            runtime: { tool: 'claude-bidi', provider: 'glm-68f6bd41', model: 'glm-5.3@glm-68f6bd41' },
            idempotencyKey: `${keyPrefix}-lead-sess`,
          });
          const seqWorkerSess = await createManagedSessionForNode({
            organizationId: seqOrg.id,
            organizationRevision: 1,
            organizationNodeId: seqWorkerNodeId,
            roleInstanceId: `rinst_${keyPrefix}_worker`,
            stableKey: 'worker',
            role: 'specialist',
            agentId: seqWriterApp.id,
            sessionClass: 'WORKER',
            runtime: { tool: 'claude-bidi', provider: 'glm-68f6bd41', model: 'glm-5.3@glm-68f6bd41' },
            idempotencyKey: `${keyPrefix}-worker-sess`,
          });
          const seqLeadNode = await orgStore.createNode({
            id: seqLeadNodeId,
            organizationId: seqOrg.id,
            stableKey: 'lead',
            nodeRole: 'specialist',
            createdRevision: 1,
            lifecycleState: 'active',
            lifecycleMode: 'formal_org',
            grant: { accessMode: 'writer', canWrite: true, canDelegate: false, writablePaths: ['work'] },
            currentSessionId: seqLeadSess.sessionId,
            bindingGeneration: 1,
            roleInstanceId: `rinst_${keyPrefix}_lead`,
            sessionClass: 'WORKER',
          });
          const seqWorkerNode = await orgStore.createNode({
            id: seqWorkerNodeId,
            organizationId: seqOrg.id,
            stableKey: 'worker',
            nodeRole: 'specialist',
            createdRevision: 1,
            lifecycleState: 'active',
            lifecycleMode: 'formal_org',
            grant: { accessMode: 'writer', canWrite: true, canDelegate: false, writablePaths: ['work'] },
            currentSessionId: seqWorkerSess.sessionId,
            bindingGeneration: 1,
            roleInstanceId: `rinst_${keyPrefix}_worker`,
            sessionClass: 'WORKER',
          });
          const reviewPolicy = reviewRequiredPolicy
            ? { required: true, minReviewers: 1, independent: true }
            : { required: false, minReviewers: 0, independent: false };
          const compiled = {
            schemaVersion: 1,
            nodes: [
              {
                stableKey: 'lead',
                role: 'specialist',
                agentId: seqWriterApp.id,
                phaseId: 'phase_lead',
                objective: 'Lead delivery',
                acceptance: [{ criterion: 'lead done', evidenceRequired: false }],
                scope: { writablePaths: ['work'] },
                runtime: { tool: 'claude-bidi', provider: 'glm-68f6bd41', model: 'glm-5.3@glm-68f6bd41' },
                resolver: { selectedAgentId: seqWriterApp.id },
              },
              {
                stableKey: 'worker',
                role: 'specialist',
                agentId: seqWriterApp.id,
                phaseId: 'phase_worker',
                objective: 'Worker follow-up',
                acceptance: [{ criterion: 'worker done', evidenceRequired: false }],
                scope: { writablePaths: ['work'] },
                runtime: { tool: 'claude-bidi', provider: 'glm-68f6bd41', model: 'glm-5.3@glm-68f6bd41' },
                resolver: { selectedAgentId: seqWriterApp.id },
              },
            ],
            phases: [
              {
                phaseId: 'phase_lead',
                objective: 'Lead phase',
                dependsOn: [],
                acceptance: [{ criterion: 'lead done', evidenceRequired: false }],
                reviewRequired: reviewRequiredPolicy,
              },
              {
                phaseId: 'phase_worker',
                objective: 'Worker phase',
                dependsOn: ['phase_lead'],
                acceptance: [{ criterion: 'worker done', evidenceRequired: false }],
                reviewRequired: reviewRequiredPolicy,
              },
            ],
            reviewPolicy,
          };
          await orgStore.createRevision(seqOrg.id, {
            revision: 1,
            proposal: { objective: `Sequential ${keyPrefix}`, reviewPolicy, phases: compiled.phases, nodes: compiled.nodes },
            compiled,
          });
          await orgStore.freezeRevision(seqOrg.id, 1);
          return { seqRoot, seqOrg, seqLeadNode, seqWorkerNode, seqLeadSess, seqWorkerSess, compiled };
        };

        // 6a: reviewPolicy.required === false -> incomplete blocks with 409; completing phase_lead auto-persists phase.completed idempotently and unblocks phase_worker!
        const opt = await makeSequentialOrg({ keyPrefix: 'opt_seq', reviewRequiredPolicy: false });
        const workerPhaseDef = opt.compiled.phases[1];

        await assert.rejects(
          () => phaseDependenciesCompleted(opt.seqOrg.id, 1, workerPhaseDef),
          (err) => err?.code === 'ORG_PHASE_DEPENDENCY_BLOCKED' && err?.statusCode === 409,
          'phase_worker is blocked before phase_lead completes',
        );

        const optDispatches = [];
        const optStagingChildIds = [];
        const optOrch = createCollaborationOrchestrator({
          pollMs: 100000,
          dependencies: {
            getSession: sessionManager.getSession,
            getApp: appsMod.getApp,
            createSession: sessionManager.createSession,
            createStagingWorkspace,
            commitStagingToCanonical,
            discardStaging,
            sendMessage: async (sid, text, images, opts) => {
              const res = await sessionManager.sendMessage(sid, text, images, { ...opts, skipRunnerLaunch: true });
              if (opts?.internalOperation === 'collaboration_task') {
                optStagingChildIds.push(sid);
                optDispatches.push({ sid, runId: res.run.id, taskId: opts?.sourceContext?.taskId || '' });
              }
              return res;
            },
            getRunState: async (id) => runs.getRun(id),
            getRun: runs.getRun,
            getRunResult: runs.getRunResult,
            getRunManifest: runs.getRunManifest,
            findRunByRequest: runs.findRunByRequest,
            listRunIds: async () => [],
            getProject: async () => project,
            requestRunCancel: async () => null,
            loadHistory: async (_sid, runId) => [{ type: 'message', role: 'assistant', runId, content: 'Lead completed.' }],
          },
        });
        try {
          await dispatchOrganizationPhase({
            organizationId: opt.seqOrg.id,
            phaseId: 'phase_lead',
            revision: 1,
            idempotencyKey: 'opt-dispatch-lead',
            orchestrator: optOrch,
          });
          const leadEntry = optDispatches.find((d) => d.taskId.endsWith(':phase_lead:lead'));
          assert.ok(leadEntry?.runId, 'phase_lead dispatched run');

          // Still running -> strictly blocked with 409.
          await assert.rejects(
            () => dispatchOrganizationPhase({
              organizationId: opt.seqOrg.id,
              phaseId: 'phase_worker',
              revision: 1,
              idempotencyKey: 'opt-dispatch-worker-early',
              orchestrator: optOrch,
            }),
            (err) => err?.code === 'ORG_PHASE_DEPENDENCY_BLOCKED' && err?.statusCode === 409,
            'phase_worker stays blocked while phase_lead is still running',
          );

          // Complete lead run + aggregation cleanly.
          const { createHash } = await import('node:crypto');
          const leadManifest = await runs.getRunManifest(leadEntry.runId);
          const leadContent = 'Lead finished phase_lead cleanly.';
          const leadHash = createHash('sha256').update(leadContent).digest('hex');
          const leadMsg = await sessionManager.appendAssistantMessage(leadEntry.sid, leadContent, [], {
            runId: leadEntry.runId,
            requestId: leadManifest.requestId,
          });
          const leadDoneAt = new Date().toISOString();
          await history.appendEvent(leadEntry.sid, {
            type: 'status',
            content: 'completed',
            providerLifecycle: 'completed',
            runState: 'completed',
            deliveryContentHash: leadHash,
            runId: leadEntry.runId,
            requestId: leadManifest.requestId,
          });
          const leadResult = { exitCode: 0, signal: null, completedAt: leadDoneAt, finalDelivery: { contentHash: leadHash, eventSeq: leadMsg?.seq } };
          await runs.writeRunResult(leadEntry.runId, leadResult);
          await runs.updateRun(leadEntry.runId, (cur) => ({ ...cur, state: 'completed', completedAt: leadDoneAt, finalizedAt: leadDoneAt, result: leadResult }));
          assert.equal(await optOrch.completeRun(leadEntry.runId), true);

          const leadCollab = (await collabStoreMod.listCollaborationRecords({ activeOnly: false }))
            .find((c) => c.policy?.organizationNodeId === opt.seqLeadNode.id);
          const aggRunId = leadCollab?.aggregationRunId || await optOrch.maybeAggregate(leadCollab.id);
          if (aggRunId) {
            const aggDoneAt = new Date().toISOString();
            const aggRes = { exitCode: 0, signal: null, completedAt: aggDoneAt };
            await runs.writeRunResult(aggRunId, aggRes);
            await runs.updateRun(aggRunId, (cur) => ({ ...cur, state: 'completed', completedAt: aggDoneAt, finalizedAt: aggDoneAt, result: aggRes }));
            await optOrch.completeAggregation(aggRunId);
          }

          // Auto-persisted phase.completed exists after phase_lead completes!
          const eventsAfterLead = await messagingMod.listOrganizationEvents(opt.seqOrg.id);
          const phaseCompletedEvents = eventsAfterLead.filter((e) => e.phaseId === 'phase_lead' && ['phase.completed', 'phase_completed'].includes(e.type));
          assert.equal(phaseCompletedEvents.length, 1, 'reviewPolicy.required=false auto-persists exactly one phase.completed event');

          // Downstream phase_worker now dispatches cleanly!
          const workerDispatch = await dispatchOrganizationPhase({
            organizationId: opt.seqOrg.id,
            phaseId: 'phase_worker',
            revision: 1,
            idempotencyKey: 'opt-dispatch-worker-ready',
            orchestrator: optOrch,
          });
          assert.equal(workerDispatch.state, 'dispatched');
          assert.equal(workerDispatch.phaseId, 'phase_worker');
          assert.ok(optDispatches.some((d) => d.taskId.endsWith(':phase_worker:worker')), 'phase_worker dispatched downstream run');

          // Repeated reconciliation / projection / dependency checks must remain idempotent (no duplicate phase.completed spam).
          await reconcileReviewOptionalPhaseCompletions({ organizationId: opt.seqOrg.id, revision: 1 });
          await phaseDependenciesCompleted(opt.seqOrg.id, 1, workerPhaseDef);
          const optProj = await buildOrganizationProjection(opt.seqOrg.id, { version: 2 });
          assert.equal(optProj.phases.find((p) => p.phaseId === 'phase_lead')?.state, 'completed');
          assert.equal(optProj.phases.find((p) => p.phaseId === 'phase_lead')?.reviewState, 'complete');
          const eventsAfterReplay = await messagingMod.listOrganizationEvents(opt.seqOrg.id);
          assert.equal(
            eventsAfterReplay.filter((e) => e.phaseId === 'phase_lead' && ['phase.completed', 'phase_completed'].includes(e.type)).length,
            1,
            'idempotent checks never duplicate phase.completed events',
          );
        } finally {
          for (const childId of optStagingChildIds) {
            const s = await sessionManager.getSession(childId).catch(() => null);
            if (s?.folder) await discardStaging(s.folder).catch(() => {});
          }
          optOrch.stop();
        }

        // 6b: reviewPolicy.required === false while an open/blocking gate exists -> stays blocked 409!
        const gatedOpt = await makeSequentialOrg({ keyPrefix: 'opt_gated', reviewRequiredPolicy: false });
        const gatedCollab = await collabStoreMod.createCollaborationRecord({
          rootSessionId: gatedOpt.seqRoot.id,
          title: 'gated-opt',
          policy: {
            organizationId: gatedOpt.seqOrg.id,
            organizationNodeId: gatedOpt.seqLeadNode.id,
            organizationBindingGeneration: 1,
            role: 'specialist',
          },
          idempotencyKey: 'gated-opt-collab',
          plan: { version: 1, tasks: [{ id: 'task-gated-opt', objective: 'work', agentId: seqWriterApp.id, role: 'specialist', dependsOn: [], acceptance: [], retry: { maxAttempts: 1, retryOn: [] }, timeoutMs: 60000 }] },
        });
        await collabStoreMod.markReadyTasks(gatedCollab.id);
        const gatedAtt = await collabStoreMod.claimTaskAttempt('task-gated-opt', { sessionId: gatedOpt.seqLeadSess.sessionId, runId: 'run-gated-opt' });
        await collabStoreMod.completeAttempt(gatedAtt.id, { state: 'succeeded', resultPacketId: 'rsp_gated_opt' });
        await collabStoreMod.finishCollaboration(gatedCollab.id, 'completed');
        await orgStore.createGate({ organizationId: gatedOpt.seqOrg.id, phaseId: 'phase_lead', generation: 1, state: 'open' });
        await assert.rejects(
          () => phaseDependenciesCompleted(gatedOpt.seqOrg.id, 1, gatedOpt.compiled.phases[1]),
          (err) => err?.code === 'ORG_PHASE_DEPENDENCY_BLOCKED' && err?.statusCode === 409,
          'open review gate blocks auto-completion even when reviewPolicy.required === false',
        );

        // 6c: reviewPolicy.required === true -> stays strictly 409 ORG_PHASE_DEPENDENCY_BLOCKED until gate passed + completePhase!
        const reqOrg = await makeSequentialOrg({ keyPrefix: 'req_seq', reviewRequiredPolicy: true });
        const reqCollab = await collabStoreMod.createCollaborationRecord({
          rootSessionId: reqOrg.seqRoot.id,
          title: 'req-seq',
          policy: {
            organizationId: reqOrg.seqOrg.id,
            organizationNodeId: reqOrg.seqLeadNode.id,
            organizationBindingGeneration: 1,
            role: 'specialist',
          },
          idempotencyKey: 'req-seq-collab',
          plan: { version: 1, tasks: [{ id: 'task-req-seq', objective: 'work', agentId: seqWriterApp.id, role: 'specialist', dependsOn: [], acceptance: [], retry: { maxAttempts: 1, retryOn: [] }, timeoutMs: 60000 }] },
        });
        await collabStoreMod.markReadyTasks(reqCollab.id);
        const reqAtt = await collabStoreMod.claimTaskAttempt('task-req-seq', { sessionId: reqOrg.seqLeadSess.sessionId, runId: 'run-req-seq' });
        await collabStoreMod.completeAttempt(reqAtt.id, { state: 'succeeded', resultPacketId: 'rsp_req_seq' });
        await collabStoreMod.finishCollaboration(reqCollab.id, 'completed');

        const reqProj = await buildOrganizationProjection(reqOrg.seqOrg.id, { version: 2 });
        assert.equal(reqProj.phases.find((p) => p.phaseId === 'phase_lead')?.state, 'completed');
        assert.equal(reqProj.phases.find((p) => p.phaseId === 'phase_lead')?.reviewState, 'pending', 'reviewRequired=true stays pending without gate');
        await assert.rejects(
          () => phaseDependenciesCompleted(reqOrg.seqOrg.id, 1, reqOrg.compiled.phases[1]),
          (err) => err?.code === 'ORG_PHASE_DEPENDENCY_BLOCKED' && err?.statusCode === 409,
          'reviewPolicy.required === true strictly preserves 409 ORG_PHASE_DEPENDENCY_BLOCKED before approval',
        );
        const reqEventsBefore = await messagingMod.listOrganizationEvents(reqOrg.seqOrg.id);
        assert.equal(
          reqEventsBefore.filter((e) => e.phaseId === 'phase_lead' && ['phase.completed', 'phase_completed'].includes(e.type)).length,
          0,
          'no auto phase.completed event is written when reviewPolicy.required === true',
        );

        await decideGate({
          organizationId: reqOrg.seqOrg.id,
          phaseId: 'phase_lead',
          fromGeneration: 0,
          decision: 'passed',
          decidedByNodeId: reqOrg.seqLeadNode.id,
          packetId: 'rsp_req_seq',
          acceptance: [{ criterion: 'lead done', status: 'passed', evidenceRef: 'ev:lead' }],
        });
        await completePhase({ organizationId: reqOrg.seqOrg.id, phaseId: 'phase_lead', fromGeneration: 1 });
        await phaseDependenciesCompleted(reqOrg.seqOrg.id, 1, reqOrg.compiled.phases[1]);

        // 6d: reviewPolicy.required === false during active collaboration_resume (`aggregating` before completeAggregation):
        // phaseDependenciesCompleted recognizes all phase tasks succeeded and unblocks phase_worker idempotently.
        const aggOpt = await makeSequentialOrg({ keyPrefix: 'opt_agg', reviewRequiredPolicy: false });
        const aggCollab = await collabStoreMod.createCollaborationRecord({
          rootSessionId: aggOpt.seqRoot.id,
          title: 'agg-opt',
          policy: {
            organizationId: aggOpt.seqOrg.id,
            organizationNodeId: aggOpt.seqLeadNode.id,
            organizationBindingGeneration: 1,
            role: 'specialist',
          },
          idempotencyKey: 'agg-opt-collab',
          plan: { version: 1, tasks: [{ id: 'task-agg-opt', objective: 'work', agentId: seqWriterApp.id, role: 'specialist', dependsOn: [], acceptance: [], retry: { maxAttempts: 1, retryOn: [] }, timeoutMs: 60000 }] },
        });
        await collabStoreMod.markReadyTasks(aggCollab.id);
        const aggAtt = await collabStoreMod.claimTaskAttempt('task-agg-opt', { sessionId: aggOpt.seqLeadSess.sessionId, runId: 'run-agg-opt' });
        await collabStoreMod.completeAttempt(aggAtt.id, { state: 'succeeded', resultPacketId: 'rsp_agg_opt' });
        await collabStoreMod.refreshBarrier(aggCollab.id);
        assert.equal((await collabStoreMod.getCollaboration(aggCollab.id)).state, 'waiting_aggregation');
        await phaseDependenciesCompleted(aggOpt.seqOrg.id, 1, aggOpt.compiled.phases[1]);
        const aggEvents = await messagingMod.listOrganizationEvents(aggOpt.seqOrg.id);
        assert.equal(
          aggEvents.filter((e) => e.phaseId === 'phase_lead' && ['phase.completed', 'phase_completed'].includes(e.type)).length,
          1,
          'reviewPolicy.required=false unblocks downstream dependsOn even while lead collaboration awaits root resume aggregation',
        );
      }
    } finally {
      if (stagingChildId) {
        const s = await sessionManager.getSession(stagingChildId).catch(() => null);
        if (s?.folder) await discardStaging(s.folder).catch(() => {});
      }
      stagingOrchestrator.stop();
    }
  }

  console.log('test-org-p0-f1-regressions: ok');
} finally {
  sessionManager.killAll();
  rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
