#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempHome = mkdtempSync(join(tmpdir(), 'ragent-swarm-factory-bridge-'));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.RAGENT_INSTANCE_ROOT = tempHome;
process.env.RAGENT_CONFIG_DIR = join(tempHome, 'config');
process.env.RAGENT_DATA_DIR = join(tempHome, 'data');
process.env.RAGENT_ORG_SCHEMA_ENABLED = '1';
process.env.RAGENT_ORG_PROJECTION_V2_ENABLED = '1';
process.env.RAGENT_ORG_STALL_GOVERNOR_ENABLED = '1';

const repoDir = join(tempHome, 'repo');
mkdirSync(join(repoDir, 'src'), { recursive: true });
execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir, stdio: 'ignore' });
execFileSync('git', ['config', 'user.email', 'qa@example.com'], { cwd: repoDir, stdio: 'ignore' });
execFileSync('git', ['config', 'user.name', 'Swarm Bridge QA'], { cwd: repoDir, stdio: 'ignore' });
writeFileSync(join(repoDir, 'src', 'feature.js'), 'export const version = 1;\n', 'utf8');
writeFileSync(join(repoDir, 'README.md'), '# Repo\n', 'utf8');
execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'ignore' });
execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: repoDir, stdio: 'ignore' });

const sessionManager = await import('../chat/session-manager.mjs');
const runs = await import('../chat/runs.mjs');
const store = await import('../chat/organization-store.mjs');
const boardStore = await import('../chat/organization-board-store.mjs');
const swarm = await import('../chat/organization-swarm.mjs');
const bridge = await import('../chat/organization-swarm-factory-bridge.mjs');
const tools = await import('../chat/organization-control-tools.mjs');
const factoryControl = await import('../chat/factory-control.mjs');
const factoryAcceptance = await import('../chat/factory-acceptance.mjs');
const factoryIntegration = await import('../chat/factory-integration.mjs');
const resultPackets = await import('../chat/result-packets.mjs');
const governor = await import('../chat/organization-governor.mjs');

await store.initializeOrganizationStore();
await governor.initializeOrganizationGovernor();

let assertions = 0;
const equal = (a, b, m) => { assertions += 1; assert.equal(a, b, m); };
const ok = (v, m) => { assertions += 1; assert.ok(v, m); };
const rejectsWith = (fn, pred, m) => { assertions += 1; return assert.rejects(fn, pred, m); };

async function createCompletedRun({ runId, sessionId, projectId, requestId, summary = 'Completed cleanly' }) {
  await runs.createRun({
    status: {
      id: runId,
      sessionId,
      requestId,
      tool: 'codex',
      state: 'running',
    },
    manifest: {
      sessionId,
      requestId,
      projectId,
      executionScope: { projectId },
      summary,
    },
  });
  await runs.writeRunResult(runId, { summary });
  await runs.updateRun(runId, {
    state: 'completed',
    finalizedAt: new Date().toISOString(),
  });
  return runs.getRun(runId);
}

try {
  // 1. Create real canonical root session and Swarm organization
  const rootSession = await sessionManager.createSession(repoDir, 'codex', 'Bridge Root');
  const orgInit = await swarm.ensureSwarmOrganization({
    rootSessionId: rootSession.id,
    projectId: rootSession.projectId || 'proj_bridge',
    title: 'Swarm Factory Bridge Org',
    policy: { projectRoot: repoDir, workspaceScope: repoDir },
    actor: { maxDepth: 4, maxChildren: 16, maxConcurrent: 8 },
  });
  const orgId = orgInit.organization.id;
  const owner = { kind: 'user', role: 'owner', principalId: 'owner' };

  const runtimeDeps = {
    getSession: sessionManager.getSession,
    createSession: async (cwd, tool, title, meta) => sessionManager.createSession(cwd, tool, title, meta),
    getRunState: async () => ({ running: false }),
    deliverSessionMessage: async (sessionId, text) => ({ delivered: true, sessionId, preview: text.slice(0, 60) }),
  };

  // 2. UPWARD BRIDGE: Swarm worktree member -> Candidate Artifact -> Acceptance -> Git Integration Commit
  const spawnWorktree = await swarm.spawnSwarmMembers(runtimeDeps, {
    organizationId: orgId,
    actorNodeId: orgInit.coordinatorNode.id,
    actorSessionId: rootSession.id,
    name: 'impl-wt',
    role: 'worker',
    brief: 'Update src/feature.js and add src/extra.js',
    workspace: 'worktree',
    writablePaths: ['src/feature.js', 'src/extra.js'],
    harness: 'codex',
    projectRoot: repoDir,
    deferDelivery: false,
  });
  const implMember = spawnWorktree.members[0];

  // Also spawn read-only inherit verifier to verify upward refusal on inherit workspace
  const spawnInherit = await swarm.spawnSwarmMembers(runtimeDeps, {
    organizationId: orgId,
    actorNodeId: orgInit.coordinatorNode.id,
    actorSessionId: rootSession.id,
    name: 'verifier-inh',
    role: 'reviewer',
    brief: 'Read-only verify',
    workspace: 'inherit',
    harness: 'claude',
    projectRoot: repoDir,
    deferDelivery: true,
  });
  const inheritMember = spawnInherit.members[0];

  // Refuses promoting inherit workspace
  await rejectsWith(
    () => bridge.promoteSwarmWorkspaceToCandidate(runtimeDeps, {
      organizationId: orgId,
      targetNameOrNodeId: inheritMember.nodeId,
      actor: owner,
    }),
    (err) => err?.code === 'SWARM_PROMOTE_REQUIRES_ISOLATED_WORKSPACE',
    'Refuses promoting non-isolated inherit workspace',
  );

  // Refuses promoting while worker is still working
  await rejectsWith(
    () => bridge.promoteSwarmWorkspaceToCandidate(runtimeDeps, {
      organizationId: orgId,
      targetNameOrNodeId: implMember.nodeId,
      actor: owner,
    }),
    (err) => err?.code === 'SWARM_MEMBER_BUSY',
    'Refuses promoting while worker is working',
  );

  // Settle impl-wt without a completed Run -> refuses SWARM_PROMOTE_RUN_REQUIRED
  await swarm.markSwarmMemberState({
    organizationId: orgId,
    nodeId: implMember.nodeId,
    swarmState: 'waiting',
    reason: 'done_waiting',
  });
  await rejectsWith(
    () => bridge.promoteSwarmWorkspaceToCandidate(runtimeDeps, {
      organizationId: orgId,
      targetNameOrNodeId: implMember.nodeId,
      actor: owner,
    }),
    (err) => err?.code === 'SWARM_PROMOTE_RUN_REQUIRED',
    'Refuses promotion without a completed canonical Run',
  );

  // Create real completed Run for impl-wt, verify empty diff fails first!
  const runWtId = 'run_bridge_wt_1';
  await createCompletedRun({
    runId: runWtId,
    sessionId: implMember.currentSessionId,
    projectId: rootSession.projectId || 'proj_bridge',
    requestId: 'req-wt-1',
    summary: 'Implemented feature v2 + extra module',
  });
  await rejectsWith(
    () => bridge.promoteSwarmWorkspaceToCandidate(runtimeDeps, {
      organizationId: orgId,
      targetNameOrNodeId: implMember.nodeId,
      runId: runWtId,
      actor: owner,
    }),
    (err) => err?.code === 'SWARM_WORKSPACE_EMPTY_DIFF',
    'Refuses promoting isolated worktree with zero changes',
  );

  // Make real file edits inside the isolated worktree (and test out-of-scope protection!)
  writeFileSync(join(implMember.workspacePath, 'README.md'), '# Unauthorized touch\n', 'utf8');
  writeFileSync(join(implMember.workspacePath, 'src', 'feature.js'), 'export const version = 2;\n', 'utf8');
  await rejectsWith(
    () => bridge.promoteSwarmWorkspaceToCandidate(runtimeDeps, {
      organizationId: orgId,
      targetNameOrNodeId: implMember.nodeId,
      runId: runWtId,
      actor: owner,
    }),
    (err) => err?.code === 'SWARM_WORK_ITEM_SCOPE_EXCEEDED',
    'Blocks promoting worktree edits outside member writablePaths',
  );

  // Restore unauthorized file & add valid authorized change
  execFileSync('git', ['checkout', '--', 'README.md'], { cwd: implMember.workspacePath, stdio: 'ignore' });
  writeFileSync(join(implMember.workspacePath, 'src', 'extra.js'), 'export const extra = true;\n', 'utf8');

  const promoted = await tools.executeOrganizationControlTool({
    authSession: {
      role: 'runner',
      principalKind: 'run_capability',
      capabilityOperation: 'session.organization.tools',
      sessionId: rootSession.id,
      runId: 'run-coord-promote',
      turnId: 'turn-coord-promote',
    },
    action: 'swarm.promote_candidate',
    args: {
      targetNameOrNodeId: 'impl-wt',
      runId: runWtId,
      objective: 'Ship feature v2 + extra.js',
      criterionId: 'owner_ok',
      criterionTitle: 'Owner reviews feature v2 diff',
      summary: 'Candidate ready from impl-wt worktree',
    },
    deps: runtimeDeps,
  });

  ok(promoted.goalId, 'Auto-created Factory Goal');
  equal(promoted.workItem.state, 'review', 'Promoted Work Item enters review (candidate_ready) state');
  equal(promoted.binding.status, 'candidate', 'Execution binding advances to candidate');
  ok(promoted.candidate.candidateId && /^[a-f0-9]{64}$/.test(promoted.candidate.digest), 'Immutable Candidate Artifact sealed');
  equal(promoted.resultPacket.kind, 'execution', 'Valid ResultPacket created');

  // Now run the REAL Factory acceptance & Git integration commit flow on the promoted Work Item!
  const accepted = await factoryAcceptance.decideFactoryManualAcceptance({
    organizationId: orgId,
    workItemId: promoted.workItem.id,
    criterionId: 'owner_ok',
    decision: 'passed',
    rationale: 'Verified worktree diff cleanly',
    contractRevision: promoted.workItem.contractRevision,
    candidateDigest: promoted.candidate.digest,
    gateGeneration: promoted.workItem.gateGeneration,
    expectedVersion: promoted.workItem.rowVersion,
    commandId: 'cmd_accept_promoted_1',
    idempotencyKey: 'accept_promoted_1',
  }, owner);
  equal(accepted.item.state, 'completed', 'Manual acceptance transitions promoted Work Item to completed');

  const opId = 'op_integrate_swarm_wt_1';
  const applied = await factoryIntegration.integrateFactoryCandidate({
    organizationId: orgId,
    workItemId: promoted.workItem.id,
    candidateId: promoted.candidate.candidateId,
    candidateDigest: promoted.candidate.digest,
    operationId: opId,
    expectedHead: promoted.candidate.expectedHead,
    expectedVersion: accepted.item.rowVersion,
  }, owner);
  equal(applied.state, 'workspace_applied_verified', 'Candidate applied cleanly to canonical repository');

  const committed = await factoryIntegration.commitFactoryIntegration({
    organizationId: orgId,
    workItemId: promoted.workItem.id,
    operationId: opId,
    expectedVersion: accepted.item.rowVersion,
  }, owner);
  equal(committed.state, 'integrated', 'Promoted Swarm worktree integrated & committed onto main branch');
  equal(readFileSync(join(repoDir, 'src', 'feature.js'), 'utf8'), 'export const version = 2;\n', 'Canonical feature.js updated on disk');
  equal(readFileSync(join(repoDir, 'src', 'extra.js'), 'utf8'), 'export const extra = true;\n', 'Canonical extra.js created on disk');

  // Verify staging workspace upward promotion as well
  const spawnStaging = await swarm.spawnSwarmMembers(runtimeDeps, {
    organizationId: orgId,
    actorNodeId: orgInit.coordinatorNode.id,
    actorSessionId: rootSession.id,
    name: 'impl-stg',
    role: 'worker',
    brief: 'Update README.md cleanly in staging',
    workspace: 'staging',
    writablePaths: ['README.md'],
    harness: 'claude',
    projectRoot: repoDir,
    deferDelivery: true,
  });
  const stgMember = spawnStaging.members[0];
  writeFileSync(join(stgMember.workspacePath, 'README.md'), '# Repo\nUpdated via staging.\n', 'utf8');
  const runStgId = 'run_bridge_stg_1';
  await createCompletedRun({
    runId: runStgId,
    sessionId: stgMember.currentSessionId,
    projectId: rootSession.projectId || 'proj_bridge',
    requestId: 'req-stg-1',
    summary: 'Updated README in staging',
  });

  // Finding #2 regression: reject unapproved ('proposed') or dependency-blocked ('blocked') existing Work Items!
  const proposedWiRes = await factoryControl.executeFactoryCommand({
    commandId: 'cmd_proposed_wi_1',
    idempotencyKey: 'proposed_wi_1',
    organizationId: orgId,
    targetId: orgId,
    type: 'CreateWorkItem',
    payload: {
      goalId: promoted.goalId,
      kind: 'execution',
      assigneeNodeId: stgMember.nodeId,
      contract: {
        objective: 'Unapproved contract must block promotion',
        targetBranch: 'main',
        allowedPaths: ['README.md'],
        acceptanceCriteria: [{ id: 'ok', title: 'OK', method: 'manual' }],
      },
    },
  }, owner);
  equal(proposedWiRes.item.state, 'proposed');
  await rejectsWith(
    () => bridge.promoteSwarmWorkspaceToCandidate(runtimeDeps, {
      organizationId: orgId,
      targetNameOrNodeId: stgMember.nodeId,
      runId: runStgId,
      workItemId: proposedWiRes.item.id,
      goalId: promoted.goalId,
      actor: owner,
    }),
    (err) => err?.code === 'FACTORY_CONFLICT' && err?.statusCode === 409,
    'Rejects promoting onto unapproved proposed Work Item',
  );

  // Dependency-blocked Work Item (depends on unresolved proposedWiRes) must also reject cleanly!
  const blockedCreated = await factoryControl.executeFactoryCommand({
    commandId: 'cmd_blocked_wi_1',
    idempotencyKey: 'blocked_wi_1',
    organizationId: orgId,
    targetId: orgId,
    type: 'CreateWorkItem',
    payload: {
      goalId: promoted.goalId,
      kind: 'execution',
      assigneeNodeId: stgMember.nodeId,
      dependencies: [{ predecessorId: proposedWiRes.item.id, milestone: 'accepted' }],
      contract: {
        objective: 'Dependency-blocked item must reject promotion',
        targetBranch: 'main',
        allowedPaths: ['README.md'],
        acceptanceCriteria: [{ id: 'ok', title: 'OK', method: 'manual' }],
      },
    },
  }, owner);
  const blockedApproved = await factoryControl.executeFactoryCommand({
    commandId: 'cmd_blocked_approve_1',
    idempotencyKey: 'blocked_approve_1',
    organizationId: orgId,
    targetId: blockedCreated.item.id,
    type: 'ApproveContract',
    expectedVersion: blockedCreated.item.rowVersion,
    payload: {},
  }, owner);
  equal(blockedApproved.item.state, 'blocked');
  await rejectsWith(
    () => bridge.promoteSwarmWorkspaceToCandidate(runtimeDeps, {
      organizationId: orgId,
      targetNameOrNodeId: stgMember.nodeId,
      runId: runStgId,
      workItemId: blockedApproved.item.id,
      goalId: promoted.goalId,
      actor: owner,
    }),
    (err) => err?.code === 'FACTORY_CONFLICT' && err?.statusCode === 409,
    'Rejects promoting onto dependency-blocked Work Item',
  );

  const promotedStg = await bridge.promoteSwarmWorkspaceToCandidate(runtimeDeps, {
    organizationId: orgId,
    targetNameOrNodeId: stgMember.nodeId,
    runId: runStgId,
    goalId: promoted.goalId,
    actor: owner,
  });
  equal(promotedStg.workItem.state, 'review', 'Staging workspace also promotes cleanly into candidate review');

  // 3. DOWNWARD BRIDGE: Work Item -> Bounded Child Swarm -> completeWorkItemSwarm -> ResultPacket
  const downItemRes = await factoryControl.executeFactoryCommand({
    commandId: 'cmd_down_wi_1',
    idempotencyKey: 'down_wi_1',
    organizationId: orgId,
    targetId: orgId,
    type: 'CreateWorkItem',
    payload: {
      goalId: promoted.goalId,
      kind: 'execution',
      assigneeNodeId: orgInit.coordinatorNode.id,
      contract: {
        objective: 'Refactor src/feature.js with bounded child swarm',
        targetBranch: 'main',
        allowedPaths: ['src/feature.js'],
        budget: { maxTotalAgents: 2 },
        acceptanceCriteria: [{ id: 'done_check', title: 'Child swarm synthesized', method: 'manual' }],
      },
    },
  }, owner);
  const approvedDown = await factoryControl.executeFactoryCommand({
    commandId: 'cmd_down_approve_1',
    idempotencyKey: 'down_approve_1',
    organizationId: orgId,
    targetId: downItemRes.item.id,
    type: 'ApproveContract',
    expectedVersion: downItemRes.item.rowVersion,
    payload: {},
  }, owner);
  const downWorkItem = approvedDown.item;

  // Reject spawning outside allowedPaths
  await rejectsWith(
    () => bridge.startWorkItemSwarm(runtimeDeps, {
      organizationId: orgId,
      workItemId: downWorkItem.id,
      actorNodeId: orgInit.coordinatorNode.id,
      members: [{
        name: 'rogue-child',
        role: 'worker',
        brief: 'Out of scope',
        workspace: 'staging',
        writablePaths: ['README.md'],
      }],
      actor: owner,
    }),
    (err) => err?.code === 'SWARM_WORK_ITEM_SCOPE_EXCEEDED' && err?.statusCode === 403,
    'Downward WorkItem swarm blocks writablePaths escaping Work Item allowedPaths',
  );

  // Start bounded child Swarm cleanly
  const startedChild = await bridge.startWorkItemSwarm(runtimeDeps, {
    organizationId: orgId,
    workItemId: downWorkItem.id,
    actorNodeId: orgInit.coordinatorNode.id,
    actorSessionId: rootSession.id,
    members: [{
      name: 'wi-child-1',
      role: 'worker',
      brief: 'Bounded edit on src/feature.js',
      workspace: 'inherit',
      writablePaths: ['src/feature.js'],
      harness: 'codex',
    }],
    deferDelivery: false,
    actor: owner,
  });
  equal(startedChild.members.length, 1);
  equal(startedChild.members[0].parentWorkItemId, downWorkItem.id, 'Child Swarm node bound to parentWorkItemId');

  // Cannot exceed Work Item child budget (maxTotalAgents: 2)
  await rejectsWith(
    () => tools.executeOrganizationControlTool({
      authSession: {
        role: 'runner',
        principalKind: 'run_capability',
        capabilityOperation: 'session.organization.tools',
        sessionId: rootSession.id,
        runId: 'run-spawn-exceed',
        turnId: 'turn-spawn-exceed',
      },
      action: 'swarm.spawn',
      args: {
        name: 'extra-children',
        brief: 'Exceed budget',
        n: 2,
        workspace: 'inherit',
        writablePaths: ['src/feature.js'],
        parentWorkItemId: downWorkItem.id,
      },
      deps: runtimeDeps,
    }),
    (err) => err?.code === 'ORG_BUDGET_EXCEEDED' && err?.statusCode === 409,
    'Bounded Work Item child Swarm rejects exceeding child budget',
  );

  // Cannot complete while child member is still working
  await rejectsWith(
    () => bridge.completeWorkItemSwarm(runtimeDeps, {
      organizationId: orgId,
      workItemId: downWorkItem.id,
      actor: owner,
    }),
    (err) => err?.code === 'SWARM_CHILDREN_STILL_ACTIVE' && err?.statusCode === 409,
    'completeWorkItemSwarm refuses while child member is still working',
  );

  // Settle child run with verified telemetry & post board evidence
  const childSessId = startedChild.members[0].currentSessionId;
  const childRunId = 'run_bridge_child_done';
  await createCompletedRun({
    runId: childRunId,
    sessionId: childSessId,
    projectId: rootSession.projectId || 'proj_bridge',
    requestId: 'req-child-done',
    summary: 'Bounded child completed review of src/feature.js',
  });
  await swarm.settleSwarmMemberRunState({
    sessionId: childSessId,
    runId: childRunId,
    state: 'completed',
    usage: { inputTokens: 500, outputTokens: 200, totalTokens: 700, costUsd: 0.008 },
    actualReportedConfig: { tool: 'codex', model: 'gpt-5.4' },
  });
  const childPost = await boardStore.postBoardMessage({
    organizationId: orgId,
    channel: 'main',
    senderKind: 'node',
    senderNodeId: startedChild.members[0].nodeId,
    bodyMarkdown: '[done] Reviewed src/feature.js cleanly.',
    kind: 'done',
  });

  const completedBridge = await tools.executeOrganizationControlTool({
    authSession: {
      role: 'runner',
      principalKind: 'run_capability',
      capabilityOperation: 'session.organization.tools',
      sessionId: rootSession.id,
      runId: 'run-coord-complete',
      turnId: 'turn-coord-complete',
    },
    action: 'swarm.complete_work_item',
    args: {
      workItemId: downWorkItem.id,
      runId: childRunId,
      summary: 'Bounded Work Item Swarm finished and verified.',
      markDone: true,
    },
    deps: runtimeDeps,
  });

  ok(completedBridge.resultPacket.packetId, 'Synthesized immutable ResultPacket on completion');
  equal(completedBridge.resultPacket.state, 'succeeded');
  ok(completedBridge.synthesis.evidenceRefs.includes(`board:#${childPost.headSeq}`), 'Synthesis cites verified #seq ref');
  equal(completedBridge.synthesis.aggregatedChildUsage.totalTokens, 700, 'Aggregates child epoch usage accurately');

  const storedPacket = await resultPackets.getResultPacket(completedBridge.resultPacket.packetId);
  ok(storedPacket && storedPacket.digest === completedBridge.resultPacket.digest, 'Synthesized ResultPacket persisted in canonical store');

  const finalSwarmStatus = await swarm.getSwarmStatus({ organizationId: orgId });
  equal(finalSwarmStatus.isDone, true, 'markDone=true marks Swarm done on work item completion');

  // Track 2B (#152/#153) regression: Coordinator grant with absolute [repoDir] writablePaths resolves repo-relative allowedPaths safely
  await store.withOrganizationDatabase((conn) => {
    const coordRow = conn.prepare('SELECT grant_json FROM organization_nodes WHERE id = ? AND organization_id = ?')
      .get(orgInit.coordinatorNode.id, orgId);
    const coordGrant = JSON.parse(coordRow.grant_json || '{}');
    coordGrant.writablePaths = [repoDir];
    conn.prepare('UPDATE organization_nodes SET grant_json = ? WHERE id = ? AND organization_id = ?')
      .run(JSON.stringify(coordGrant), orgInit.coordinatorNode.id, orgId);
  }, { mutate: true });

  const relItemCreated = await factoryControl.executeFactoryCommand({
    commandId: 'cmd_rel_wi_1',
    idempotencyKey: 'rel_wi_1',
    organizationId: orgId,
    targetId: orgId,
    type: 'CreateWorkItem',
    payload: {
      goalId: promoted.goalId,
      kind: 'execution',
      assigneeNodeId: orgInit.coordinatorNode.id,
      contract: {
        objective: 'Update README.md inside repo-relative allowedPaths under absolute coordinator grant',
        targetBranch: 'main',
        allowedPaths: ['README.md'],
        acceptanceCriteria: [{ id: 'readme_done', title: 'README updated', method: 'manual' }],
      },
    },
  }, owner);
  const relItemApproved = await factoryControl.executeFactoryCommand({
    commandId: 'cmd_rel_approve_1',
    idempotencyKey: 'rel_approve_1',
    organizationId: orgId,
    targetId: relItemCreated.item.id,
    type: 'ApproveContract',
    expectedVersion: relItemCreated.item.rowVersion,
    payload: {},
  }, owner);

  const startedRelChild = await bridge.startWorkItemSwarm(runtimeDeps, {
    organizationId: orgId,
    workItemId: relItemApproved.item.id,
    actorNodeId: orgInit.coordinatorNode.id,
    actorSessionId: rootSession.id,
    members: [{
      name: 'wi-rel-child',
      role: 'worker',
      brief: 'Edit README.md safely',
      workspace: 'staging',
      harness: 'codex',
    }],
    projectRoot: repoDir,
    deferDelivery: true,
    actor: owner,
  });
  equal(startedRelChild.members.length, 1, 'startWorkItemSwarm spawns child when coordinator grant has absolute [repoDir] and WorkItem uses repo-relative allowedPaths');
  const relChild = startedRelChild.members[0];
  const relChildGrant = await store.withOrganizationDatabase((conn) => {
    const row = conn.prepare('SELECT grant_json FROM organization_nodes WHERE id = ? AND organization_id = ?')
      .get(relChild.nodeId, orgId);
    return JSON.parse(row?.grant_json || '{}');
  });
  ok(
    Array.isArray(relChildGrant.writablePaths) && relChildGrant.writablePaths.some((p) => p.endsWith('/README.md')),
    'Child grant resolves repo-relative path against verified projectRoot',
  );

  // Verify resolved child staging workspace promotes & commits CRLF bytes cleanly even when core.autocrlf=true
  execFileSync('git', ['config', 'core.autocrlf', 'true'], { cwd: repoDir, stdio: 'ignore' });
  const crlfReadme = '# Repo updated by WorkItem Swarm\r\nLine 2 CRLF\r\n';
  writeFileSync(join(relChild.workspacePath, 'README.md'), crlfReadme, 'utf8');
  const relRunId = 'run_rel_child_done';
  await createCompletedRun({
    runId: relRunId,
    sessionId: relChild.currentSessionId,
    projectId: rootSession.projectId || 'proj_bridge',
    requestId: 'req-rel-child-done',
    summary: 'Updated README.md with CRLF',
  });
  await swarm.settleSwarmMemberRunState({
    sessionId: relChild.currentSessionId,
    runId: relRunId,
    state: 'completed',
    usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150, costUsd: 0.001 },
  });
  const promotedRel = await bridge.promoteSwarmWorkspaceToCandidate(runtimeDeps, {
    organizationId: orgId,
    targetNameOrNodeId: relChild.nodeId,
    runId: relRunId,
    goalId: promoted.goalId,
    actor: owner,
  });
  equal(promotedRel.workItem.state, 'review', 'Resolved child writablePaths round-trip cleanly into promoteSwarmWorkspaceToCandidate');

  const relCriterionId = promotedRel.workItem.contract?.acceptanceCriteria?.[0]?.id || 'owner_approval';
  const acceptedRel = await factoryAcceptance.decideFactoryManualAcceptance({
    organizationId: orgId,
    workItemId: promotedRel.workItem.id,
    criterionId: relCriterionId,
    decision: 'passed',
    rationale: 'Verified CRLF candidate under core.autocrlf=true',
    contractRevision: promotedRel.workItem.contractRevision,
    candidateDigest: promotedRel.candidate.digest,
    gateGeneration: promotedRel.workItem.gateGeneration,
    expectedVersion: promotedRel.workItem.rowVersion,
    commandId: 'cmd_accept_rel_crlf_1',
    idempotencyKey: 'accept_rel_crlf_1',
  }, owner);
  equal(acceptedRel.item.state, 'completed', 'Manual acceptance passes for CRLF candidate under core.autocrlf=true');

  const relOpId = 'op_integrate_rel_crlf_1';
  const appliedRel = await factoryIntegration.integrateFactoryCandidate({
    organizationId: orgId,
    workItemId: promotedRel.workItem.id,
    candidateId: promotedRel.candidate.candidateId,
    candidateDigest: promotedRel.candidate.digest,
    operationId: relOpId,
    expectedHead: promotedRel.candidate.expectedHead,
    expectedVersion: acceptedRel.item.rowVersion,
  }, owner);
  equal(appliedRel.state, 'workspace_applied_verified', 'CRLF candidate applied cleanly to canonical workspace');

  const committedRel = await factoryIntegration.commitFactoryIntegration({
    organizationId: orgId,
    workItemId: promotedRel.workItem.id,
    operationId: relOpId,
    expectedVersion: acceptedRel.item.rowVersion,
  }, owner);
  equal(committedRel.state, 'integrated', 'CRLF candidate committed onto main even with core.autocrlf=true');
  ok(/^[a-f0-9]{40,}$/.test(committedRel.commitId), 'commitFactoryIntegration returns verified commit SHA');
  equal(
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim(),
    committedRel.commitId,
    'Canonical repo HEAD updated to verified commit SHA',
  );
  equal(
    execFileSync('git', ['show', `${committedRel.commitId}:README.md`], { cwd: repoDir, encoding: 'buffer' }).toString('utf8'),
    crlfReadme,
    'Committed Git blob preserves exact sealed CRLF bytes under core.autocrlf=true',
  );

  // Verify fail-closed realpath / traversal containment guard in startWorkItemSwarm
  const outsideSecretDir = join(tempHome, 'outside-secret');
  mkdirSync(outsideSecretDir, { recursive: true });
  writeFileSync(join(outsideSecretDir, 'secret.txt'), 'nope', 'utf8');
  symlinkSync(outsideSecretDir, join(repoDir, 'escape-link'), process.platform === 'win32' ? 'junction' : 'dir');
  const escapeItemCreated = await factoryControl.executeFactoryCommand({
    commandId: 'cmd_escape_wi_1',
    idempotencyKey: 'escape_wi_1',
    organizationId: orgId,
    targetId: orgId,
    type: 'CreateWorkItem',
    payload: {
      goalId: promoted.goalId,
      kind: 'execution',
      assigneeNodeId: orgInit.coordinatorNode.id,
      contract: {
        objective: 'Attempt symlink escape',
        targetBranch: 'main',
        allowedPaths: ['escape-link/secret.txt'],
        acceptanceCriteria: [{ id: 'escape_ok', title: 'Should block', method: 'manual' }],
      },
    },
  }, owner);
  const escapeItemApproved = await factoryControl.executeFactoryCommand({
    commandId: 'cmd_escape_approve_1',
    idempotencyKey: 'escape_approve_1',
    organizationId: orgId,
    targetId: escapeItemCreated.item.id,
    type: 'ApproveContract',
    expectedVersion: escapeItemCreated.item.rowVersion,
    payload: {},
  }, owner);
  await rejectsWith(
    () => bridge.startWorkItemSwarm(runtimeDeps, {
      organizationId: orgId,
      workItemId: escapeItemApproved.item.id,
      actorNodeId: orgInit.coordinatorNode.id,
      actorSessionId: rootSession.id,
      members: [{
        name: 'escape-child',
        role: 'worker',
        brief: 'Attempt escape',
        workspace: 'inherit',
        harness: 'codex',
      }],
      projectRoot: repoDir,
      deferDelivery: true,
      actor: owner,
    }),
    (err) => err?.code === 'SWARM_WORK_ITEM_SCOPE_EXCEEDED' && err?.statusCode === 403,
    'startWorkItemSwarm fails closed when repo-relative path traverses symlink/junction outside projectRoot',
  );

  console.log(`test-organization-swarm-factory-bridge: ok (${assertions} assertions)`);
} finally {
  await resultPackets.closeResultPacketStore?.().catch(() => {});
  rmSync(tempHome, { recursive: true, force: true });
}
