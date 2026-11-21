#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempHome = mkdtempSync(join(tmpdir(), 'ragent-swarm-model-switch-'));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.RAGENT_INSTANCE_ROOT = tempHome;
process.env.RAGENT_CONFIG_DIR = join(tempHome, 'config');
process.env.RAGENT_DATA_DIR = join(tempHome, 'data');
process.env.RAGENT_ORG_SCHEMA_ENABLED = '1';
process.env.RAGENT_ORG_PROJECTION_V2_ENABLED = '1';
process.env.RAGENT_ORG_STALL_GOVERNOR_ENABLED = '1';

const repoDir = join(tempHome, 'repo');
mkdirSync(repoDir, { recursive: true });
execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir, stdio: 'ignore' });
execFileSync('git', ['config', 'user.email', 'qa@example.com'], { cwd: repoDir, stdio: 'ignore' });
execFileSync('git', ['config', 'user.name', 'Swarm QA'], { cwd: repoDir, stdio: 'ignore' });
writeFileSync(join(repoDir, 'app.txt'), 'v1\n', 'utf8');
execFileSync('git', ['add', 'app.txt'], { cwd: repoDir, stdio: 'ignore' });
execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir, stdio: 'ignore' });

const store = await import('../chat/organization-store.mjs');
const boardStore = await import('../chat/organization-board-store.mjs');
const swarm = await import('../chat/organization-swarm.mjs');
const tools = await import('../chat/organization-control-tools.mjs');
const governor = await import('../chat/organization-governor.mjs');

await store.initializeOrganizationStore();
await governor.initializeOrganizationGovernor();

let assertions = 0;
const equal = (a, b, m) => { assertions += 1; assert.equal(a, b, m); };
const ok = (v, m) => { assertions += 1; assert.ok(v, m); };
const rejectsWith = (fn, pred, m) => { assertions += 1; return assert.rejects(fn, pred, m); };

try {
  // 1. Setup simulated sessions + deliveries + runtime rebinds
  const sessions = new Map([
    ['root-unlocked', {
      id: 'root-unlocked',
      sessionClass: 'ROOT_LEADERSHIP',
      sessionPlane: 'user',
      userAddressable: true,
      folder: repoDir,
      projectId: 'proj-sw',
      collaborationPolicyOverrides: { maxConcurrent: 8 },
    }],
    ['root-locked', {
      id: 'root-locked',
      sessionClass: 'ROOT_LEADERSHIP',
      sessionPlane: 'user',
      userAddressable: true,
      folder: repoDir,
      projectId: 'proj-lock',
      collaborationPolicyOverrides: { maxConcurrent: 8 },
      runtimeConstraints: {
        tool: { mode: 'locked', value: 'codex', source: 'owner', scope: 'organization', version: 1 },
        model: { mode: 'locked', value: 'gpt-5.4', source: 'owner', scope: 'node:locked-worker', version: 1 },
        effort: { mode: 'locked', value: 'high', source: 'owner', scope: 'organization', version: 1 },
      },
    }],
  ]);
  const rebinds = [];
  const deliveries = [];
  const runsById = new Map();

  const makeDeps = () => ({
    skipRunLookup: true,
    allowUnlistedModels: true,
    getSession: async (id) => sessions.get(id) || null,
    createSession: async (cwd, tool, title, meta = {}) => {
      const id = `sess_${sessions.size + 1}_${meta.organizationNodeId || 'n'}`;
      const record = {
        id,
        folder: cwd,
        tool,
        title,
        providerProfile: meta.providerProfile || '',
        model: meta.model || '',
        effort: meta.effort || '',
        codexThreadId: 'codex-thread-epoch-1',
        claudeSessionId: 'claude-sess-epoch-1',
        agyConversationId: 'agy-conv-epoch-1',
      };
      sessions.set(id, record);
      return record;
    },
    updateSessionRuntime: async (sessionId, patch) => {
      const cur = sessions.get(sessionId);
      assert.ok(cur, `session ${sessionId} must exist during rebind`);
      rebinds.push({ sessionId, patch: { ...patch }, before: { tool: cur.tool, model: cur.model, effort: cur.effort } });
      Object.assign(cur, {
        tool: patch.tool,
        providerProfile: patch.providerProfile || '',
        model: patch.model || '',
        effort: patch.effort || '',
        // Never allow stale cross-provider thread reuse!
        codexThreadId: undefined,
        claudeSessionId: undefined,
        agyConversationId: undefined,
      });
      return cur;
    },
    getRunState: async (idOrSess) => {
      const r = runsById.get(idOrSess);
      if (r) return r;
      return { running: false };
    },
    getRun: async (runId) => runsById.get(runId) || null,
    deliverSessionMessage: async (sessionId, text, _attachments, opts) => {
      deliveries.push({ sessionId, text, opts });
      return { delivered: true, runId: `run_wake_${deliveries.length}` };
    },
  });

  const deps = makeDeps();

  // 2. Test Owner Lock enforcement (`409 SWARM_MODEL_LOCKED_BY_OWNER`)
  const ensuredLocked = await swarm.ensureSwarmOrganization({
    rootSessionId: 'root-locked',
    projectId: 'proj-lock',
    title: 'Locked Runtime Swarm',
    policy: { projectRoot: repoDir },
  });
  const lockedSpawn = await swarm.spawnSwarmMembers(deps, {
    organizationId: ensuredLocked.organization.id,
    actorNodeId: ensuredLocked.coordinatorNode.id,
    name: 'locked-worker',
    role: 'worker',
    brief: 'Work under owner lock',
    workspace: 'inherit',
    harness: 'codex',
    model: 'gpt-5.4',
    effort: 'high',
    deferDelivery: true,
  });
  const lockedWorker = lockedSpawn.members[0];

  // Attempt violating locked model
  await rejectsWith(
    () => swarm.switchSwarmMemberModel(deps, {
      organizationId: ensuredLocked.organization.id,
      actorNodeId: ensuredLocked.coordinatorNode.id,
      targetNameOrNodeId: 'locked-worker',
      model: 'gpt-5.3-codex',
    }),
    (err) => err?.code === 'SWARM_MODEL_LOCKED_BY_OWNER' && err?.statusCode === 409,
    'Owner-locked model rejects switch fail-closed with 409 SWARM_MODEL_LOCKED_BY_OWNER',
  );
  // Attempt violating locked harness/tool
  await rejectsWith(
    () => swarm.switchSwarmMemberModel(deps, {
      organizationId: ensuredLocked.organization.id,
      actorNodeId: ensuredLocked.coordinatorNode.id,
      targetNameOrNodeId: 'locked-worker',
      harness: 'claude',
      model: 'claude-sonnet-4-6',
    }),
    (err) => err?.code === 'SWARM_MODEL_LOCKED_BY_OWNER' && err?.statusCode === 409,
    'Owner-locked tool rejects harness switch fail-closed',
  );
  // Attempt violating locked effort
  await rejectsWith(
    () => swarm.switchSwarmMemberModel(deps, {
      organizationId: ensuredLocked.organization.id,
      actorNodeId: ensuredLocked.coordinatorNode.id,
      targetNameOrNodeId: 'locked-worker',
      model: 'gpt-5.4',
      effort: 'low',
    }),
    (err) => err?.code === 'SWARM_MODEL_LOCKED_BY_OWNER' && err?.statusCode === 409,
    'Owner-locked effort rejects effort downgrade fail-closed',
  );
  const statusLocked = await swarm.getSwarmStatus({ organizationId: ensuredLocked.organization.id });
  const lockedAfter = statusLocked.members.find((m) => m.nodeId === lockedWorker.nodeId);
  equal(lockedAfter.bindingGeneration, 1, 'Failed owner-lock switches never bump bindingGeneration');
  equal(lockedAfter.modelHistory.length, 1, 'Failed switches never create spurious epochs');

  // 3. Test Unlocked Swarm: working guard, catalog guard, budget guard, full switch + handoff + separate epochs
  const ensuredUnlocked = await swarm.ensureSwarmOrganization({
    rootSessionId: 'root-unlocked',
    projectId: 'proj-sw',
    title: 'Multi-Model Swarm',
    policy: { projectRoot: repoDir },
    budget: { maxCost: 1.0, maxTokens: 50000 },
  });
  const spawnWorkerRes = await swarm.spawnSwarmMembers(deps, {
    organizationId: ensuredUnlocked.organization.id,
    actorNodeId: ensuredUnlocked.coordinatorNode.id,
    name: 'coder-1',
    role: 'worker',
    brief: 'Implement app logic carefully',
    workspace: 'worktree',
    harness: 'codex',
    provider: 'openai-main',
    model: 'gpt-5.4',
    effort: 'medium',
    deferDelivery: false,
  });
  const spawnStatus = await swarm.getSwarmStatus({ organizationId: ensuredUnlocked.organization.id });
  let coder = spawnStatus.members.find((m) => m.name === 'coder-1');
  equal(coder.swarmState, 'working', 'Spawn wakeup transitions coder-1 to working');
  equal(coder.modelHistory.length, 1);

  // Dirty the worktree to confirm switch preserves dirty work & records it in verified handoff
  writeFileSync(join(coder.workspacePath, 'app.txt'), 'v1 -> dirty edit\n', 'utf8');

  // Busy guard: refuse while working!
  await rejectsWith(
    () => swarm.switchSwarmMemberModel(deps, {
      organizationId: ensuredUnlocked.organization.id,
      actorNodeId: ensuredUnlocked.coordinatorNode.id,
      targetNameOrNodeId: 'coder-1',
      harness: 'claude',
      model: 'claude-sonnet-4-6',
    }),
    (err) => err?.code === 'SWARM_MEMBER_BUSY' && err?.statusCode === 409,
    'Refuses switch while member is working (409 SWARM_MEMBER_BUSY)',
  );

  // Complete Epoch 1 Run with real Model A usage telemetry
  const runEpoch1Id = 'run-epoch-1';
  runsById.set(runEpoch1Id, {
    id: runEpoch1Id,
    runId: runEpoch1Id,
    state: 'completed',
    running: false,
    tool: 'codex',
    providerProfile: 'openai-main',
    actualModel: 'gpt-5.4',
    effort: 'medium',
    usage: { inputTokens: 1200, outputTokens: 300, totalTokens: 1500, costUsd: 0.015 },
  });
  await swarm.settleSwarmMemberRunState(deps, {
    sessionId: coder.currentSessionId,
    runId: runEpoch1Id,
    state: 'completed',
  });

  // Post an unread board message so handoff tracks exact unread #seq range
  const peerMsg = await boardStore.postBoardMessage({
    organizationId: ensuredUnlocked.organization.id,
    channel: 'main',
    senderKind: 'node',
    senderNodeId: ensuredUnlocked.coordinatorNode.id,
    bodyMarkdown: 'Focus on error edge cases in app.txt',
    kind: 'message',
  });

  // Catalog guard test: mock runtimeCatalog rejects unknown model or invalid effort
  await rejectsWith(
    () => swarm.switchSwarmMemberModel({
      ...deps,
      runtimeCatalog: [
        {
          tool: 'claude',
          providers: ['anthropic-main'],
          models: [{ id: 'claude-sonnet-4-6', effortLevels: ['low', 'medium', 'high'] }],
          effortLevels: ['low', 'medium', 'high'],
        },
      ],
    }, {
      organizationId: ensuredUnlocked.organization.id,
      actorNodeId: ensuredUnlocked.coordinatorNode.id,
      targetNameOrNodeId: 'coder-1',
      harness: 'claude',
      model: 'claude-invented-99',
    }),
    (err) => err?.code === 'SWARM_MODEL_CANDIDATE_INVALID' && err?.statusCode === 422,
    'Catalog validation rejects unlisted/fabricated target model',
  );

  // Stale expectedBindingGeneration rejected cleanly
  await rejectsWith(
    () => swarm.switchSwarmMemberModel(deps, {
      organizationId: ensuredUnlocked.organization.id,
      actorNodeId: ensuredUnlocked.coordinatorNode.id,
      targetNameOrNodeId: 'coder-1',
      harness: 'claude',
      model: 'claude-sonnet-4-6',
      expectedBindingGeneration: 99,
    }),
    (err) => err?.code === 'SWARM_BINDING_CONFLICT' && err?.statusCode === 409,
    'expectedBindingGeneration guards against stale switch',
  );

  // Execute valid controlled model switch: codex:gpt-5.4 -> claude:claude-sonnet-4-6 (high)
  const switchOut = await tools.executeOrganizationControlTool({
    authSession: {
      role: 'runner',
      principalKind: 'run_capability',
      capabilityOperation: 'session.organization.tools',
      sessionId: 'root-unlocked',
      runId: 'run-coord',
      turnId: 'turn-coord',
    },
    action: 'swarm.model',
    args: {
      targetNameOrNodeId: 'coder-1',
      harness: 'claude',
      provider: 'anthropic-main',
      model: 'claude-sonnet-4-6',
      effort: 'high',
      reason: 'Switch coder-1 to Claude for deep refactor',
      handoffNotes: 'Preserve uncommitted edit in app.txt',
      idempotencyKey: 'switch-coder1-epoch2',
    },
    deps: {
      ...deps,
      runtimeCatalog: [
        {
          tool: 'claude',
          providers: ['anthropic-main'],
          models: [{ id: 'claude-sonnet-4-6', effortLevels: ['low', 'medium', 'high'] }],
          effortLevels: ['low', 'medium', 'high'],
        },
      ],
    },
  });

  equal(switchOut.previousBindingGeneration, 1);
  equal(switchOut.bindingGeneration, 2, 'bindingGeneration incremented cleanly');
  equal(switchOut.sessionRebound, true, 'Session runtime rebound');
  equal(switchOut.member.harness, 'claude');
  equal(switchOut.member.provider, 'anthropic-main');
  equal(switchOut.member.model, 'claude-sonnet-4-6');
  equal(switchOut.member.effort, 'high');
  equal(switchOut.member.pendingModelSwitchHandoff, true);
  equal(switchOut.handoff.workspace.unmerged, true, 'Dirty worktree captured honestly in handoff');
  ok(switchOut.handoff.workspace.dirtyFiles.some((f) => f.includes('app.txt')), 'Handoff includes app.txt dirty status');
  ok(switchOut.handoff.boardRange.headSeq >= peerMsg.headSeq, 'Handoff captures board headSeq range');
  ok(switchOut.handoff.briefSummary.includes('Implement app logic carefully'), 'Handoff retains brief context');

  // Verify prior native provider thread IDs were cleared on rebind (never cross-provider cloned)
  const reboundSess = sessions.get(coder.currentSessionId);
  equal(reboundSess.tool, 'claude');
  equal(reboundSess.model, 'claude-sonnet-4-6');
  equal(reboundSess.codexThreadId, undefined, 'Stale codexThreadId cleared');
  equal(reboundSess.claudeSessionId, undefined, 'Stale claudeSessionId cleared');

  // Old capability token referencing bindingGeneration = 1 must be REJECTED immediately!
  await rejectsWith(
    () => tools.executeOrganizationControlTool({
      authSession: {
        role: 'runner',
        principalKind: 'run_capability',
        capabilityOperation: 'organization.tools',
        sessionId: coder.currentSessionId,
        runId: 'run-stale-gen1',
        turnId: 'turn-stale',
        organizationMessageScope: {
          kind: 'organization_message',
          organizationId: ensuredUnlocked.organization.id,
          nodeId: coder.nodeId,
          bindingGeneration: 1,
          organizationRevision: 0,
        },
      },
      action: 'swarm.status',
      deps,
    }),
    (err) => err?.statusCode === 403 && err?.code === 'ORG_TOOL_FORBIDDEN',
    'Stale generation=1 capability token rejected after generation bump to 2',
  );

  // Trigger wakeup on switched member -> handoff injected ONCE into next wakeup prompt & cleared!
  const beforeWakeDeliveries = deliveries.length;
  await boardStore.postBoardMessage({
    organizationId: ensuredUnlocked.organization.id,
    channel: 'main',
    senderKind: 'node',
    senderNodeId: ensuredUnlocked.coordinatorNode.id,
    bodyMarkdown: '@coder-1 resume work on app.txt with new model',
    kind: 'message',
  });
  await swarm.deliverPendingSwarmWakeups(deps, { organizationId: ensuredUnlocked.organization.id });
  equal(deliveries.length, beforeWakeDeliveries + 1, 'Wakeup delivered to switched member');
  const nextWake = deliveries[deliveries.length - 1];
  equal(nextWake.opts.bindingGeneration, 2, 'Wakeup carries new bindingGeneration=2');
  ok(nextWake.text.includes('[Swarm Verified Model Switch Handoff]'), 'Verified handoff injected into wakeup digest');
  ok(nextWake.text.includes(switchOut.handoff.handoffId), 'Wakeup cites handoffId');
  ok(nextWake.opts.modelSwitchHandoff?.handoffId === switchOut.handoff.handoffId, 'Wakeup metadata attaches handoff');

  // Complete Epoch 2 Run on Model B (claude)
  const runEpoch2Id = 'run-epoch-2';
  runsById.set(runEpoch2Id, {
    id: runEpoch2Id,
    runId: runEpoch2Id,
    state: 'completed',
    running: false,
    tool: 'claude',
    providerProfile: 'anthropic-main',
    actualModel: 'claude-sonnet-4-6',
    effort: 'high',
    usage: { inputTokens: 800, outputTokens: 400, totalTokens: 1200, costUsd: 0.012 },
  });
  await swarm.settleSwarmMemberRunState(deps, {
    sessionId: coder.currentSessionId,
    runId: runEpoch2Id,
    state: 'completed',
  });

  // Verify Epoch 1 vs Epoch 2 billing/reporting separation (账实分离)
  const statusAfter = await swarm.getSwarmStatus({ organizationId: ensuredUnlocked.organization.id });
  const finalCoder = statusAfter.members.find((m) => m.nodeId === coder.nodeId);
  equal(finalCoder.pendingModelSwitchHandoff, false, 'Pending handoff cleared after delivery');
  equal(finalCoder.modelHistory.length, 2, 'Two distinct epochs recorded');

  const ep1 = finalCoder.modelHistory[0];
  const ep2 = finalCoder.modelHistory[1];
  equal(ep1.bindingGeneration, 1);
  equal(ep1.resolvedConfig.model, 'gpt-5.4');
  equal(ep1.usage.totalTokens, 1500, 'Epoch 1 retains Model A tokens strictly');
  equal(ep1.usage.costUsd, 0.015);
  ok(ep1.endedAt, 'Epoch 1 is closed cleanly');

  equal(ep2.bindingGeneration, 2);
  equal(ep2.resolvedConfig.model, 'claude-sonnet-4-6');
  equal(ep2.actualReportedConfig.model, 'claude-sonnet-4-6');
  equal(ep2.usage.totalTokens, 1200, 'Epoch 2 records Model B tokens strictly without mixing Epoch 1');
  equal(ep2.usage.costUsd, 0.012);
  equal(ep2.endedAt, null, 'Epoch 2 remains active');

  equal(finalCoder.usageByModel.length, 2, 'usageByModel keeps Model A and Model B strictly separated');

  // Budget exhaustion check
  await rejectsWith(
    () => swarm.switchSwarmMemberModel({
      ...deps,
      checkModelBudget: () => { throw Object.assign(new Error('budget exhausted'), { code: 'ORG_BUDGET_EXCEEDED', statusCode: 409 }); },
    }, {
      organizationId: ensuredUnlocked.organization.id,
      actorNodeId: ensuredUnlocked.coordinatorNode.id,
      targetNameOrNodeId: 'coder-1',
      harness: 'agy',
      model: 'gemini-3-pro',
    }),
    (err) => err?.code === 'ORG_BUDGET_EXCEEDED' && err?.statusCode === 409,
    'Governor/budget exhaustion blocks unauthorized model switch',
  );

  // Finding #1a regression: concurrent CAS conflict must NEVER mutate live session preferences!
  const rebindsBeforeCas = rebinds.length;
  const sessionBeforeCas = { ...sessions.get(coder.currentSessionId) };
  await rejectsWith(
    () => swarm.switchSwarmMemberModel({
      ...deps,
      checkModelBudget: async () => {
        // Simulate concurrent writer bumping binding_generation right before CAS
        const orgDbMod = await import('../chat/organization-store.mjs');
        await orgDbMod.withOrganizationDatabase((conn) => {
          conn.prepare('UPDATE organization_nodes SET binding_generation = binding_generation + 1 WHERE id = ?')
            .run(coder.nodeId);
        }, { mutate: true });
      },
    }, {
      organizationId: ensuredUnlocked.organization.id,
      actorNodeId: ensuredUnlocked.coordinatorNode.id,
      targetNameOrNodeId: 'coder-1',
      harness: 'agy',
      model: 'gemini-3-pro',
    }),
    (err) => err?.code === 'SWARM_BINDING_CONFLICT' && err?.statusCode === 409,
    'Concurrent CAS conflict aborts before touching session runtime',
  );
  equal(rebinds.length, rebindsBeforeCas, 'rebindSwarmSessionRuntime was NOT called on CAS conflict');
  equal(sessions.get(coder.currentSessionId).model, sessionBeforeCas.model, 'Session model preserved on CAS conflict');

  // Finding #1b regression: failed session rebind rolls back SQLite binding_generation & grant atomically!
  const preFailStatus = await swarm.getSwarmStatus({ organizationId: ensuredUnlocked.organization.id });
  const preFailGen = preFailStatus.members.find((m) => m.nodeId === coder.nodeId).bindingGeneration;
  await rejectsWith(
    () => swarm.switchSwarmMemberModel({
      ...deps,
      updateSessionRuntime: async () => {
        throw Object.assign(new Error('Simulated rebind failure'), { code: 'REBIND_FAILED', statusCode: 500 });
      },
    }, {
      organizationId: ensuredUnlocked.organization.id,
      actorNodeId: ensuredUnlocked.coordinatorNode.id,
      targetNameOrNodeId: 'coder-1',
      harness: 'agy',
      model: 'gemini-3-pro',
    }),
    (err) => err?.code === 'REBIND_FAILED',
    'Rebind error propagates cleanly',
  );
  const postRollbackStatus = await swarm.getSwarmStatus({ organizationId: ensuredUnlocked.organization.id });
  const postRollbackMember = postRollbackStatus.members.find((m) => m.nodeId === coder.nodeId);
  equal(postRollbackMember.bindingGeneration, preFailGen, 'Failed rebind rolls back bindingGeneration in DB');
  equal(postRollbackMember.model, 'claude-sonnet-4-6', 'Failed rebind rolls back model in DB');

  // Finding #3 regression: Work Item with rowVersion > 1 creates real FactoryTaskHandoff via live row_version lookup
  const factoryCtrl = await import('../chat/factory-control.mjs');
  const ownerActor = { kind: 'user', role: 'owner', principalId: 'owner' };
  const goalRes = await factoryCtrl.executeFactoryCommand({
    commandId: 'cmd_handoff_goal_1',
    idempotencyKey: 'handoff_goal_1',
    organizationId: ensuredUnlocked.organization.id,
    targetId: ensuredUnlocked.organization.id,
    type: 'CreateGoal',
    payload: { projectId: 'proj-sw', objective: 'Verify live FactoryTaskHandoff on rowVersion > 1' },
  }, ownerActor);
  const wiCreated = await factoryCtrl.executeFactoryCommand({
    commandId: 'cmd_handoff_wi_1',
    idempotencyKey: 'handoff_wi_1',
    organizationId: ensuredUnlocked.organization.id,
    targetId: ensuredUnlocked.organization.id,
    type: 'CreateWorkItem',
    payload: {
      goalId: goalRes.goal.id,
      kind: 'execution',
      assigneeNodeId: coder.nodeId,
      contract: {
        objective: 'Check rowVersion > 1 handoff',
        targetBranch: 'main',
        allowedPaths: ['app.txt'],
        acceptanceCriteria: [{ id: 'ok_crit', title: 'OK', method: 'manual' }],
      },
    },
  }, ownerActor);
  const wiApproved = await factoryCtrl.executeFactoryCommand({
    commandId: 'cmd_handoff_approve_1',
    idempotencyKey: 'handoff_approve_1',
    organizationId: ensuredUnlocked.organization.id,
    targetId: wiCreated.item.id,
    type: 'ApproveContract',
    expectedVersion: wiCreated.item.rowVersion,
    payload: {},
  }, ownerActor);
  ok(wiApproved.item.rowVersion >= 2, 'Approved Work Item has rowVersion >= 2');

  const wiSwitchRes = await swarm.switchSwarmMemberModel(deps, {
    organizationId: ensuredUnlocked.organization.id,
    actorNodeId: ensuredUnlocked.coordinatorNode.id,
    targetNameOrNodeId: 'coder-1',
    harness: 'agy',
    model: 'gemini-3-pro',
    workItemId: wiApproved.item.id,
  });
  ok(
    typeof wiSwitchRes.handoff.factoryTaskHandoffId === 'string' && wiSwitchRes.handoff.factoryTaskHandoffId.startsWith('handoff_'),
    `Creates real FactoryTaskHandoff even when workItem.rowVersion=${wiApproved.item.rowVersion} > 1`,
  );

  // Mid-Run board.wait (#152/#153): telemetry & cached tokens still record cleanly when swarm_state flips to 'waiting' before Run exits
  await swarm.markSwarmMemberState({
    organizationId: ensuredUnlocked.organization.id,
    nodeId: coder.nodeId,
    swarmState: 'working',
    lastRunId: 'run-epoch3-midwait',
  });
  await swarm.markSwarmMemberState({
    organizationId: ensuredUnlocked.organization.id,
    nodeId: coder.nodeId,
    swarmState: 'waiting',
    reason: 'board.wait',
  });
  const midWaitRunId = 'run-epoch3-midwait';
  runsById.set(midWaitRunId, {
    id: midWaitRunId,
    runId: midWaitRunId,
    state: 'completed',
    running: false,
    tool: 'agy',
    providerProfile: 'agy-default',
    actualModel: 'gemini-4-argon',
    effort: 'low',
    usage: {
      inputTokens: 39490,
      outputTokens: 4189,
      cachedInputTokens: 156142,
      reasoningTokens: 2353,
    },
  });
  const midWaitSettled = await swarm.settleSwarmMemberRunState(deps, {
    sessionId: coder.currentSessionId,
    runId: midWaitRunId,
    state: 'completed',
  });
  equal(midWaitSettled.settled, true, 'settleSwarmMemberRunState records telemetry even after mid-Run board.wait');
  const postMidWaitStatus = await swarm.getSwarmStatus({ organizationId: ensuredUnlocked.organization.id });
  const coderMidWait = postMidWaitStatus.members.find((m) => m.nodeId === coder.nodeId);
  equal(coderMidWait.swarmState, 'waiting', 'Preserves waiting state after mid-Run board.wait');
  const ep3MidWait = coderMidWait.modelHistory[coderMidWait.modelHistory.length - 1];
  equal(ep3MidWait.usage.runCount, 1, 'Epoch 3 runCount increments on mid-Run board.wait run');
  equal(ep3MidWait.usage.cachedInputTokens, 156142, 'Epoch 3 preserves cachedInputTokens');
  equal(ep3MidWait.usage.reasoningTokens, 2353, 'Epoch 3 preserves reasoningTokens');
  equal(ep3MidWait.usage.totalTokens, 202174, 'Epoch 3 totalTokens includes cachedInputTokens + reasoningTokens when omitted');
  equal(ep3MidWait.actualReportedConfig.model, 'gemini-4-argon', 'Epoch 3 records actualReportedConfig.model');
  ok(
    coderMidWait.usageByModel.some((entry) => entry.model === 'gemini-4-argon' && entry.totalTokens === 202174 && entry.runCount === 1),
    'usageByModel surfaces non-zero Epoch 3 agy usage after mid-Run board.wait',
  );

  // Reconcile path also backfills missed telemetry for waiting nodes with unrecorded runIds (with cachedReadTokens fallback)
  const reconcileRunId = 'run-epoch3-reconcile-cachedread';
  await swarm.markSwarmMemberState({
    organizationId: ensuredUnlocked.organization.id,
    nodeId: coder.nodeId,
    swarmState: 'waiting',
    reason: 'board.wait',
    lastRunId: reconcileRunId,
  });
  runsById.set(reconcileRunId, {
    id: reconcileRunId,
    runId: reconcileRunId,
    state: 'completed',
    running: false,
    tool: 'agy',
    actualModel: 'gemini-4-argon',
    usage: { inputTokens: 100, outputTokens: 20, cachedReadTokens: 80, thoughtTokens: 10 },
  });
  const recRes1 = await swarm.reconcileSwarmMemberStates({
    ...deps,
    getRunState: async (id) => runsById.get(id) || null,
  }, { organizationId: ensuredUnlocked.organization.id });
  equal(recRes1.settled, 1, 'reconcileSwarmMemberStates backfills missed waiting-node telemetry');
  const recRes2 = await swarm.reconcileSwarmMemberStates({
    ...deps,
    getRunState: async (id) => runsById.get(id) || null,
  }, { organizationId: ensuredUnlocked.organization.id });
  equal(recRes2.settled, 0, 'reconcileSwarmMemberStates deduplicates by runId cleanly on repeat call');
  const postReconcileStatus = await swarm.getSwarmStatus({ organizationId: ensuredUnlocked.organization.id });
  const coderReconciled = postReconcileStatus.members.find((m) => m.nodeId === coder.nodeId);
  const ep3AfterRec = coderReconciled.modelHistory[coderReconciled.modelHistory.length - 1];
  equal(ep3AfterRec.usage.runCount, 2);
  equal(ep3AfterRec.usage.totalTokens, 202384, 'cachedReadTokens + thoughtTokens added to totalTokens cleanly');

  // Partial actualReportedConfig (#158/#159): keep epoch.actualReportedConfig honest while merging non-empty fields in usageByModel
  await swarm.switchSwarmMemberModel(deps, {
    organizationId: ensuredUnlocked.organization.id,
    actorNodeId: ensuredUnlocked.coordinatorNode.id,
    targetNameOrNodeId: 'coder-1',
    harness: 'agy',
    provider: 'agy-official',
    model: 'gemini-4-neon',
    effort: 'high',
  });
  const ep4RunId = 'run-epoch4-partial-actual';
  runsById.set(ep4RunId, {
    id: ep4RunId,
    runId: ep4RunId,
    state: 'completed',
    running: false,
    tool: 'agy',
    providerProfile: 'agy-official',
    usage: { inputTokens: 1000, outputTokens: 200 },
  });
  await swarm.settleSwarmMemberRunState({ getRun: deps.getRun }, {
    sessionId: coder.currentSessionId,
    runId: ep4RunId,
    state: 'completed',
  });
  const postEp4Status = await swarm.getSwarmStatus({ organizationId: ensuredUnlocked.organization.id });
  const coderEp4 = postEp4Status.members.find((m) => m.nodeId === coder.nodeId);
  const ep4 = coderEp4.modelHistory[coderEp4.modelHistory.length - 1];
  assert.deepEqual(ep4.actualReportedConfig, { tool: 'agy', provider: 'agy-official' }, 'Epoch 4 actualReportedConfig stays honest when status omits model/effort');
  equal(
    coderEp4.usageByModel.some((entry) => entry.modelKey === 'agy:agy-official'),
    false,
    'usageByModel never creates degraded provider-only bucket when resolvedConfig has model',
  );
  const mergedNeonBucket = coderEp4.usageByModel.find((entry) => entry.modelKey === 'agy:gemini-4-neon');
  ok(mergedNeonBucket, 'usageByModel preserves agy:gemini-4-neon bucket across partial actualReportedConfig');
  equal(mergedNeonBucket.model, 'gemini-4-neon');
  equal(mergedNeonBucket.effort, 'high');
  equal(mergedNeonBucket.provider, 'agy-official');
  equal(mergedNeonBucket.inputTokens, 1000);
  equal(mergedNeonBucket.runCount, 1);

  // Kill guard: after killing, switch refuses cleanly with SWARM_MEMBER_KILLED and settle skips killed nodes
  await swarm.killSwarmMember(deps, {
    organizationId: ensuredUnlocked.organization.id,
    actorNodeId: ensuredUnlocked.coordinatorNode.id,
    targetNameOrNodeId: 'coder-1',
    forceDiscard: true,
    projectRoot: repoDir,
  });
  const killedSettle = await swarm.settleSwarmMemberRunState(deps, {
    sessionId: coder.currentSessionId,
    runId: 'run-after-kill-should-ignore',
    state: 'completed',
    usage: { inputTokens: 999, outputTokens: 999 },
  });
  equal(killedSettle.settled, false, 'settleSwarmMemberRunState ignores permanently killed nodes');
  await rejectsWith(
    () => swarm.switchSwarmMemberModel(deps, {
      organizationId: ensuredUnlocked.organization.id,
      actorNodeId: ensuredUnlocked.coordinatorNode.id,
      targetNameOrNodeId: 'coder-1',
      model: 'gpt-5.4',
    }),
    (err) => err?.code === 'SWARM_MEMBER_KILLED' && err?.statusCode === 409,
    'Cannot switch killed member model',
  );

  console.log(`test-organization-swarm-model-switch: ok (${assertions} assertions)`);
} finally {
  rmSync(tempHome, { recursive: true, force: true });
}
