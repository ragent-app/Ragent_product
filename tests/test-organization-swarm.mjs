#!/usr/bin/env node
import assert from 'assert/strict';
import { execFileSync } from 'child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, join } from 'path';

const tempRoot = mkdtempSync(join(tmpdir(), 'ragent-org-swarm-'));
const instanceRoot = join(tempRoot, 'instance');
const configDir = join(instanceRoot, 'config');
const harnessRoot = join(tempRoot, 'harnesses');
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
process.env.RAGENT_AUTH_SESSION_SECRET = 'test-swarm-session-control-secret';
mkdirSync(configDir, { recursive: true });
mkdirSync(process.env.LOCALAPPDATA, { recursive: true });
mkdirSync(process.env.APPDATA, { recursive: true });
mkdirSync(agyHarnessBin, { recursive: true });
writeFileSync(join(agyHarnessBin, 'agy'), '#!/bin/sh\necho "1.5.12"\n', 'utf8');
try { chmodSync(join(agyHarnessBin, 'agy'), 0o755); } catch {}
if (process.platform === 'win32') {
  writeFileSync(join(agyHarnessBin, 'agy.cmd'), '@echo off\r\necho 1.5.12\r\n', 'utf8');
}
process.env.PATH = `${agyHarnessBin}${delimiter}${process.env.PATH || ''}`;

const orgStore = await import('../chat/organization-store.mjs');
const boardStore = await import('../chat/organization-board-store.mjs');
const governor = await import('../chat/organization-governor.mjs');
const managedInput = await import('../chat/managed-input.mjs');
const identityCtx = await import('../chat/organization-identity-context.mjs');
const swarm = await import('../chat/organization-swarm.mjs');
const sessionManager = await import('../chat/session-manager.mjs');
const providerContract = await import('../chat/provider-contract.mjs');
const execCtx = await import('../chat/organization-execution-context.mjs');
const projects = await import('../chat/projects.mjs');
const collaborationStore = await import('../chat/collaboration-store.mjs');
const runAdmission = await import('../chat/run-admission.mjs');
const runs = await import('../chat/runs.mjs');
const runnerSidecar = await import('../chat/runner-sidecar.mjs');
const windowsGate = await import('../chat/windows-approval-gate.mjs');

let assertionCount = 0;
const a = new Proxy(assert, {
  get(target, prop) {
    const value = target[prop];
    if (typeof value === 'function') {
      return (...args) => {
        assertionCount += 1;
        return value.apply(target, args);
      };
    }
    return value;
  },
});

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function createTempRepo(name = 'repo') {
  const repoDir = join(tempRoot, name);
  mkdirSync(join(repoDir, 'src'), { recursive: true });
  execFileSync('git', ['init', '-b', 'main', repoDir], { encoding: 'utf8' });
  git(repoDir, 'config', 'user.email', 'test@example.com');
  git(repoDir, 'config', 'user.name', 'Test User');
  writeFileSync(join(repoDir, 'README.md'), '# Test Repo\n', 'utf8');
  writeFileSync(join(repoDir, 'src', 'app.js'), 'export const v = 1;\n', 'utf8');
  git(repoDir, 'add', '.');
  git(repoDir, 'commit', '-m', 'init');
  return repoDir;
}

async function runTests() {
  await orgStore.initializeOrganizationStore();
  const repoDir = createTempRepo('swarm-repo');

  // 1. Live ephemeral_swarm contract in managed-input.mjs
  const validSwarmLineage = {
    id: 'sess-sw-1',
    sessionPlane: 'organization',
    sessionClass: 'WORKER',
    managedScope: 'organization',
    lifecycleMode: 'ephemeral_swarm',
    organizationId: 'org_test',
    organizationRootSessionId: 'root_1',
    organizationNodeId: 'node_1',
    roleInstanceId: 'rinst_1',
    parentSessionId: 'root_1',
    controllerSessionId: 'root_1',
    organizationRevision: 0,
  };
  a.equal(managedInput.assertManagedSessionLineage(validSwarmLineage), 'WORKER');
  // Formal org at revision 0 without lifecycleMode: 'ephemeral_swarm' remains blocked
  a.throws(
    () => managedInput.assertManagedSessionLineage({ ...validSwarmLineage, lifecycleMode: 'formal_org' }),
    { code: 'MANAGED_SESSION_LINEAGE_INCOMPLETE' },
  );
  // Missing verified lineage fields on ephemeral_swarm must reject
  for (const missingField of ['organizationId', 'organizationRootSessionId', 'roleInstanceId', 'parentSessionId', 'controllerSessionId']) {
    a.throws(
      () => managedInput.assertManagedSessionLineage({ ...validSwarmLineage, [missingField]: '' }),
      { code: 'MANAGED_SESSION_LINEAGE_INCOMPLETE' },
      `missing ${missingField} rejected`,
    );
  }
  a.throws(
    () => managedInput.assertManagedSessionLineage({ ...validSwarmLineage, organizationRevision: 1 }),
    { code: 'MANAGED_SESSION_LINEAGE_INCOMPLETE' },
  );
  a.throws(
    () => managedInput.assertManagedSessionLineage({ ...validSwarmLineage, sessionClass: 'SWARM_MEMBER' }),
    { code: 'SESSION_CLASS_INVALID' },
  );

  // swarm_wakeup internalOperation allowed for org messages, blocked for bypasses & consultation
  a.doesNotThrow(() => managedInput.assertManagedInputAllowed({
    session: validSwarmLineage,
    operation: 'message',
    requestContext: { internalOperation: 'swarm_wakeup' },
  }));
  a.throws(() => managedInput.assertManagedInputAllowed({
    session: validSwarmLineage,
    operation: 'fork',
    requestContext: { internalOperation: 'swarm_wakeup' },
  }), { code: 'MANAGED_SESSION_INPUT_BYPASS' });
  a.throws(() => managedInput.assertManagedInputAllowed({
    session: validSwarmLineage,
    operation: 'message',
    requestContext: { role: 'owner' },
  }), { code: 'MANAGED_SESSION_INPUT_BYPASS' });
  a.throws(() => managedInput.assertManagedInputAllowed({
    session: { id: 'sess-consult', sessionPlane: 'organization', sessionClass: 'WORKER', managedScope: 'consultation' },
    operation: 'message',
    requestContext: { internalOperation: 'swarm_wakeup' },
  }), { code: 'MANAGED_SESSION_INPUT_BYPASS' });

  // 2. Ensure swarm organization + positional createSession signature + identity context
  const createdSessions = [];
  const sessionsById = new Map([['root-swarm-1', { id: 'root-swarm-1', folder: repoDir, tool: 'codex' }]]);
  const cancelledRuns = [];
  const activeRunBySession = new Map();
  const deferredSessions = new Set();
  const deliveries = [];

  const mockDeps = {
    createSession: async (folder, tool, name, extra) => {
      const id = `sess_${createdSessions.length + 1}`;
      const record = { id, folder, tool, name, ...extra };
      createdSessions.push(record);
      sessionsById.set(id, record);
      return record;
    },
    getSession: async (id) => sessionsById.get(id) || null,
    getRunState: async (sessionId) => activeRunBySession.get(sessionId) || null,
    requestRunCancel: async (runId) => {
      cancelledRuns.push(runId);
      return { id: runId, state: 'cancelled' };
    },
    sendMessage: async (sessionId, text, images, options) => {
      deliveries.push({ sessionId, text, options });
      if (deferredSessions.has(sessionId)) {
        return { deferred: true, queued: false, run: null };
      }
      return { deferred: false, queued: false, run: { id: `run_${deliveries.length}` } };
    },
  };

  const { organization: org, coordinatorNode } = await swarm.ensureSwarmOrganization({
    rootSessionId: 'root-swarm-1',
    projectId: 'proj-swarm',
    title: 'Phase 2 Swarm',
    policy: { projectRoot: repoDir, maxConcurrent: 8, maxDepth: 2 },
    budget: { agents: 3 },
  });
  a.equal(org.currentRevision, 0);
  a.equal(coordinatorNode.lifecycleMode, 'ephemeral_swarm');
  a.equal(coordinatorNode.sessionClass, 'ROOT_LEADERSHIP');

  // getSwarmStatus works on a fresh DB before organization_budget_counters exists
  const initialStatus = await swarm.getSwarmStatus({ organizationId: org.id });
  a.equal(initialStatus.members.length, 1);
  a.deepEqual(initialStatus.budget.reserved, {});

  // 3. Sharded spawn + verifier role + identity context without frozen revision
  const shardRes = await swarm.spawnSwarmMembers(mockDeps, {
    organizationId: org.id,
    actorNodeId: coordinatorNode.id,
    actorSessionId: 'root-swarm-1',
    name: 'worker',
    role: 'author',
    tasks: ['module-a', 'module-b'],
    brief: 'Implement slices',
    channels: ['backend'],
    workspace: 'inherit',
    projectRoot: repoDir,
    idempotencyKey: 'spawn-shards-1',
  });
  a.equal(shardRes.replay, false);
  a.deepEqual(shardRes.members.map((m) => m.name), ['worker-1', 'worker-2']);
  a.equal(shardRes.members[0].sessionClass, 'WORKER');
  a.equal(shardRes.members[0].lifecycleMode, 'ephemeral_swarm');
  a.ok(shardRes.members[0].roleInstanceId);
  a.equal(shardRes.wakeups.length, 2);
  a.equal(createdSessions[0].lifecycleMode, 'ephemeral_swarm');
  a.equal(createdSessions[0].organizationRevision, 0);
  a.equal(createdSessions[0].sessionClass, 'WORKER');

  // Verify idempotent replay
  const shardReplay = await swarm.spawnSwarmMembers(mockDeps, {
    organizationId: org.id,
    actorNodeId: coordinatorNode.id,
    name: 'worker',
    tasks: ['module-a', 'module-b'],
    brief: 'Implement slices',
    idempotencyKey: 'spawn-shards-1',
  });
  a.equal(shardReplay.replay, true);
  a.equal(shardReplay.members.length, 2);

  // Verify duplicate name rejection
  await a.rejects(
    () => swarm.spawnSwarmMembers(mockDeps, {
      organizationId: org.id,
      actorNodeId: coordinatorNode.id,
      name: 'worker-1',
      brief: 'Duplicate name',
    }),
    { code: 'SWARM_NAME_CONFLICT' },
  );

  // Spawn a reviewer (sessionClass: 'REVIEWER') as 3rd budgeted agent (reaches budget.agents=3)
  const verifierRes = await swarm.spawnSwarmMembers(mockDeps, {
    organizationId: org.id,
    actorNodeId: coordinatorNode.id,
    actorSessionId: 'root-swarm-1',
    name: 'verifier',
    role: 'verifier',
    brief: 'Verify worker-1 and worker-2',
    workspace: 'inherit',
    projectRoot: repoDir,
  });
  const verifier = verifierRes.members[0];
  a.equal(verifier.sessionClass, 'REVIEWER');
  a.equal(verifier.contractRole, 'reviewer');

  // Identity context works for ephemeral_swarm worker & verifier without frozen revision
  const workerIdentity = await identityCtx.buildOrganizationIdentityContext(sessionsById.get(shardRes.members[0].currentSessionId));
  a.ok(workerIdentity.includes('<organization-identity>'));
  a.ok(workerIdentity.includes(shardRes.members[0].nodeId));
  const verifierIdentity = await identityCtx.buildOrganizationIdentityContext(sessionsById.get(verifier.currentSessionId));
  a.ok(verifierIdentity.includes('ragent:builtin:reviewer'), 'REVIEWER ephemeral swarm node receives reviewer builtin skill');

  // Formal org node without frozen revision MUST still fail ORG_IDENTITY_UNAVAILABLE
  const formalOrg = await orgStore.createOrganization({
    rootSessionId: 'root-formal-unfrozen',
    projectId: 'proj-formal',
    currentRevision: 0,
  });
  const formalNode = await orgStore.createNode({
    organizationId: formalOrg.id,
    stableKey: 'formal-w1',
    nodeRole: 'worker',
    createdRevision: 0,
    lifecycleMode: 'formal_org',
    currentSessionId: 'sess-formal-w1',
    bindingGeneration: 1,
    sessionClass: 'WORKER',
    grant: { role: 'worker' },
  });
  await a.rejects(
    () => identityCtx.buildOrganizationIdentityContext({
      id: 'sess-formal-w1',
      sessionPlane: 'organization',
      sessionClass: 'WORKER',
      organizationId: formalOrg.id,
      organizationNodeId: formalNode.id,
    }),
    { code: 'ORG_IDENTITY_UNAVAILABLE' },
  );

  // 4. Budget exhaustion rollback & governor release on kill
  const counterBeforeOverbudget = await governor.getBudgetCounter(org.id, 0);
  a.equal(counterBeforeOverbudget.reserved.agents, 3);
  await a.rejects(
    () => swarm.spawnSwarmMembers(mockDeps, {
      organizationId: org.id,
      actorNodeId: coordinatorNode.id,
      name: 'overflow',
      brief: 'Should hit agents budget limit',
      workspace: 'inherit',
      projectRoot: repoDir,
    }),
    { code: 'ORG_BUDGET_EXCEEDED' },
  );
  const counterAfterRollback = await governor.getBudgetCounter(org.id, 0);
  a.equal(counterAfterRollback.reserved.agents, 3, 'failed spawn does not leak budget');

  // Delegation & depth enforcement
  await a.rejects(
    () => swarm.spawnSwarmMembers(mockDeps, {
      organizationId: org.id,
      actorNodeId: verifier.id,
      name: 'nested',
      brief: 'Verifier lacks canDelegate',
    }),
    { code: 'SWARM_DELEGATION_FORBIDDEN' },
  );

  // Fork from node in same org produces sanitized handoff bundle; cross-org fork rejected
  await a.rejects(
    () => swarm.spawnSwarmMembers(mockDeps, {
      organizationId: org.id,
      actorNodeId: coordinatorNode.id,
      name: 'badfork',
      brief: 'Cross-org fork forbidden',
      forkFromNodeId: formalNode.id,
    }),
    { code: 'SWARM_FORK_SOURCE_NOT_FOUND' },
  );

  // Kill verifier with active run -> cancels run + releases budget slot back to 2
  activeRunBySession.set(verifier.currentSessionId, { runId: 'run-verifier-1', running: true });
  const killedVerifier = await swarm.killSwarmMember(mockDeps, {
    organizationId: org.id,
    actorNodeId: coordinatorNode.id,
    targetNameOrNodeId: 'verifier',
  });
  a.equal(killedVerifier.killed, true);
  a.equal(killedVerifier.node.swarmState, 'killed');
  a.ok(cancelledRuns.includes('run-verifier-1'));
  const counterAfterKill = await governor.getBudgetCounter(org.id, 0);
  a.equal(counterAfterKill.reserved.agents, 2, 'killing member releases governor agent slot');

  // Killed member CANNOT be revived
  await a.rejects(
    () => swarm.markSwarmMemberState({
      organizationId: org.id,
      nodeId: verifier.id,
      swarmState: 'waiting',
    }),
    { code: 'SWARM_MEMBER_KILLED' },
  );
  // Coordinator CANNOT be killed
  await a.rejects(
    () => swarm.killSwarmMember(mockDeps, {
      organizationId: org.id,
      targetNameOrNodeId: coordinatorNode.id,
    }),
    { code: 'SWARM_CANNOT_KILL_COORDINATOR' },
  );

  // 5. Real worktree workspace + SWARM_WORKSPACE_UNMERGED_CHANGES guard
  const wtRes = await swarm.spawnSwarmMembers(mockDeps, {
    organizationId: org.id,
    actorNodeId: coordinatorNode.id,
    actorSessionId: 'root-swarm-1',
    name: 'wt-coder',
    role: 'writer',
    brief: 'Edit src/app.js in isolated worktree',
    workspace: 'worktree',
    projectRoot: repoDir,
    forkFromNodeId: shardRes.members[0].id,
  });
  const wtMember = wtRes.members[0];
  a.equal(wtMember.workspaceMode, 'worktree');
  a.ok(existsSync(wtMember.workspacePath));
  a.equal(wtRes.handoffBundle?.kind, 'swarm_fork_handoff');
  a.equal(wtRes.handoffBundle?.untrustedPeerContext, true);
  a.equal(wtRes.handoffBundle?.sourceNodeId, shardRes.members[0].id);

  // Dirty untracked file in worktree blocks killSwarmMember
  writeFileSync(join(wtMember.workspacePath, 'scratch.txt'), 'uncommitted\n', 'utf8');
  await a.rejects(
    () => swarm.killSwarmMember(mockDeps, {
      organizationId: org.id,
      actorNodeId: coordinatorNode.id,
      targetNameOrNodeId: 'wt-coder',
      projectRoot: repoDir,
    }),
    { code: swarm.SWARM_WORKSPACE_UNMERGED_CHANGES },
  );

  // Committed unmerged change on branch also blocks killSwarmMember
  git(wtMember.workspacePath, 'add', 'scratch.txt');
  git(wtMember.workspacePath, 'commit', '-m', 'unmerged work');
  await a.rejects(
    () => swarm.killSwarmMember(mockDeps, {
      organizationId: org.id,
      actorNodeId: coordinatorNode.id,
      targetNameOrNodeId: 'wt-coder',
      projectRoot: repoDir,
    }),
    { code: swarm.SWARM_WORKSPACE_UNMERGED_CHANGES },
  );

  // forceDiscard: true removes worktree + branch + releases slot
  const killedWt = await swarm.killSwarmMember(mockDeps, {
    organizationId: org.id,
    actorNodeId: coordinatorNode.id,
    targetNameOrNodeId: 'wt-coder',
    projectRoot: repoDir,
    forceDiscard: true,
  });
  a.equal(killedWt.killed, true);
  a.equal(existsSync(wtMember.workspacePath), false, 'worktree directory removed on kill');

  // 6. Real staging workspace + unmerged diff guard
  const stgRes = await swarm.spawnSwarmMembers(mockDeps, {
    organizationId: org.id,
    actorNodeId: coordinatorNode.id,
    actorSessionId: 'root-swarm-1',
    name: 'stg-writer',
    role: 'writer',
    brief: 'Modify src/app.js in staging workspace',
    workspace: 'staging',
    writablePaths: ['src'],
    projectRoot: repoDir,
  });
  const stgMember = stgRes.members[0];
  a.equal(stgMember.workspaceMode, 'staging');
  writeFileSync(join(stgMember.workspacePath, 'src', 'app.js'), 'export const v = 2;\n', 'utf8');
  await a.rejects(
    () => swarm.killSwarmMember(mockDeps, {
      organizationId: org.id,
      actorNodeId: coordinatorNode.id,
      targetNameOrNodeId: 'stg-writer',
      projectRoot: repoDir,
    }),
    { code: swarm.SWARM_WORKSPACE_UNMERGED_CHANGES },
  );
  const killedStg = await swarm.killSwarmMember(mockDeps, {
    organizationId: org.id,
    actorNodeId: coordinatorNode.id,
    targetNameOrNodeId: 'stg-writer',
    projectRoot: repoDir,
    forceDiscard: true,
  });
  a.equal(killedStg.killed, true);
  a.equal(existsSync(stgMember.workspacePath), false, 'staging dir removed on kill');

  // 7. Wakeup delivery: initial brief delivered, deferIfBusy while working, stopped verification
  const w1 = shardRes.members[0];
  const w2 = shardRes.members[1];
  a.ok(deliveries.some((d) => d.sessionId === w1.currentSessionId), 'initial brief delivered to w1');
  a.ok(deliveries.some((d) => d.sessionId === w2.currentSessionId), 'initial brief delivered to w2');

  deferredSessions.add(w1.currentSessionId);
  await swarm.markSwarmMemberState({
    organizationId: org.id,
    nodeId: w2.id,
    swarmState: 'stopped',
  });
  await boardStore.postBoardMessage({
    organizationId: org.id,
    channel: 'main',
    senderKind: 'node',
    senderNodeId: coordinatorNode.id,
    bodyMarkdown: '@worker-1 @worker-2 follow-up task 1',
  });
  await boardStore.postBoardMessage({
    organizationId: org.id,
    channel: 'main',
    senderKind: 'node',
    senderNodeId: coordinatorNode.id,
    bodyMarkdown: '@worker-1 follow-up task 2 (coalesced while busy)',
  });

  const firstWake = await swarm.deliverPendingSwarmWakeups(mockDeps, { organizationId: org.id });
  a.equal(firstWake.deferred, 1, 'busy w1 defers wakeup without duplicating');
  a.equal(firstWake.delivered, 1, 'stopped w2 verified via getSession and woken cleanly');
  const statusMid = await swarm.getSwarmStatus({ organizationId: org.id });
  a.equal(statusMid.members.find((m) => m.id === w2.id).swarmState, 'working');
  a.equal(statusMid.members.find((m) => m.id === w1.id).swarmState, 'working');

  // Unblock w1 and re-deliver deferred coalesced wakeup
  deferredSessions.delete(w1.currentSessionId);
  const preDeliverCount = deliveries.length;
  const secondWake = await swarm.deliverPendingSwarmWakeups(mockDeps, { organizationId: org.id });
  a.equal(secondWake.delivered, 1);
  const w1Delivery = deliveries.slice(preDeliverCount).find((d) => d.sessionId === w1.currentSessionId);
  a.ok(w1Delivery.text.includes('coalesced=2'), 'deferred mentions coalesced into one doorbell');
  a.equal(w1Delivery.options.internalOperation, 'swarm_wakeup');
  a.equal(w1Delivery.options.queueIfBusy, false);
  a.equal(w1Delivery.options.deferIfBusy, true);

  // 8. Non-coordinator (including formal_org depth:0 worker) cannot markSwarmDone or kill peers
  const depth0FormalWorker = await orgStore.createNode({
    organizationId: org.id,
    stableKey: 'formal-d0-worker',
    nodeRole: 'worker',
    createdRevision: 0,
    lifecycleState: 'active',
    lifecycleMode: 'formal_org',
    currentSessionId: 'sess-formal-d0-worker',
    bindingGeneration: 1,
    depth: 0,
    sessionClass: 'WORKER',
    grant: { role: 'worker' },
  });
  await a.rejects(
    () => swarm.markSwarmDone({ organizationId: org.id, actorNodeId: w1.id }),
    { code: 'SWARM_DONE_FORBIDDEN' },
  );
  await a.rejects(
    () => swarm.markSwarmDone({ organizationId: org.id, actorNodeId: depth0FormalWorker.id }),
    { code: 'SWARM_DONE_FORBIDDEN' },
  );
  await a.rejects(
    () => swarm.killSwarmMember(mockDeps, {
      organizationId: org.id,
      actorNodeId: depth0FormalWorker.id,
      targetNameOrNodeId: w1.id,
    }),
    { code: 'SWARM_KILL_FORBIDDEN' },
  );
  const doneRes = await swarm.markSwarmDone({
    organizationId: org.id,
    actorNodeId: coordinatorNode.id,
    summary: 'All tasks verified.',
    postToBoard: true,
  });
  a.equal(doneRes.isDone, true);
  const activeAfterDone = await swarm.listActiveSwarmOrganizations();
  a.equal(activeAfterDone.includes(org.id), false);

  // 9. Wave 2B live-blocker regressions (Blockers 2, 3, 4 & Minor Gap 5)
  // 9a. Blocker 2 & 4: verifier advisory read-only defaults, wakeup propagation, omitted empty projectId, certifiedReadOnly opt-in
  a.equal(verifier.certifiedReadOnly, false, 'swarm reviewer defaults to advisory read-only');
  const verifierSessRecord = sessionsById.get(verifier.currentSessionId);
  a.equal(verifierSessRecord.readOnlyAdvisory, true);
  a.equal(verifierSessRecord.projectId, 'proj-swarm');
  a.equal(Object.hasOwn(verifierSessRecord, 'providerProfile'), false);
  a.equal(Object.hasOwn(verifierSessRecord, 'model'), false);
  a.equal(Object.hasOwn(verifierSessRecord, 'effort'), false);
  const verifierInitialDelivery = deliveries.find((d) => d.sessionId === verifier.currentSessionId);
  a.equal(verifierInitialDelivery.options.accessMode, 'read');
  a.equal(verifierInitialDelivery.options.readOnlyRequired, false);
  a.equal(verifierInitialDelivery.options.readOnlyAdvisory, true);

  const b2Extras = [];
  const b2Deliveries = [];
  const b2Deps = {
    createSession: async (folder, tool, name, extra) => {
      const id = `sess_b2_${b2Extras.length + 1}`;
      const record = { id, folder, tool, name, ...extra };
      b2Extras.push(extra);
      sessionsById.set(id, record);
      return record;
    },
    getSession: async (id) => sessionsById.get(id) || null,
    getRunState: async () => null,
    requestRunCancel: async (runId) => ({ id: runId, state: 'cancelled' }),
    sendMessage: async (sessionId, text, images, options) => {
      b2Deliveries.push({ sessionId, text, options });
      return { deferred: false, queued: false, run: { id: `run_b2_${b2Deliveries.length}` } };
    },
  };
  const { organization: b2Org, coordinatorNode: b2Coord } = await swarm.ensureSwarmOrganization({
    rootSessionId: 'root-swarm-b2',
    policy: { projectRoot: repoDir, maxConcurrent: 4, maxDepth: 2 },
  });
  const advRevRes = await swarm.spawnSwarmMembers(b2Deps, {
    organizationId: b2Org.id,
    actorNodeId: b2Coord.id,
    actorSessionId: 'root-swarm-b2',
    name: 'adv-reviewer',
    role: 'reviewer',
    brief: 'Advisory review worker changes',
    workspace: 'inherit',
    projectRoot: repoDir,
  });
  a.equal(Object.hasOwn(b2Extras[0], 'projectId'), false, 'undefined projectId key omitted from createSession extra');
  a.equal(Object.hasOwn(b2Extras[0], 'providerProfile'), false);
  a.equal(Object.hasOwn(b2Extras[0], 'model'), false);
  a.equal(Object.hasOwn(b2Extras[0], 'effort'), false);
  a.equal(b2Deliveries[0].options.accessMode, 'read');
  a.equal(b2Deliveries[0].options.readOnlyRequired, false);
  a.equal(b2Deliveries[0].options.readOnlyAdvisory, true);
  await boardStore.postBoardMessage({
    organizationId: b2Org.id,
    channel: 'main',
    senderKind: 'node',
    senderNodeId: b2Coord.id,
    bodyMarkdown: '@adv-reviewer check round 2',
  });
  await swarm.deliverPendingSwarmWakeups(b2Deps, { organizationId: b2Org.id });
  const advWake = b2Deliveries[b2Deliveries.length - 1];
  a.equal(advWake.options.accessMode, 'read');
  a.equal(advWake.options.readOnlyRequired, false);
  a.equal(advWake.options.readOnlyAdvisory, true);

  const certRevRes = await swarm.spawnSwarmMembers(b2Deps, {
    organizationId: b2Org.id,
    actorNodeId: b2Coord.id,
    actorSessionId: 'root-swarm-b2',
    name: 'strict-reviewer',
    role: 'reviewer',
    certifiedReadOnly: true,
    brief: 'Strict certified read-only review',
    workspace: 'inherit',
    projectRoot: repoDir,
  });
  a.equal(certRevRes.members[0].certifiedReadOnly, true);
  const certDelivery = b2Deliveries.find((d) => d.sessionId === certRevRes.members[0].currentSessionId);
  a.equal(certDelivery.options.accessMode, 'read');
  a.equal(certDelivery.options.readOnlyRequired, true);
  a.equal(certDelivery.options.readOnlyAdvisory, undefined);
  await boardStore.postBoardMessage({
    organizationId: b2Org.id,
    channel: 'main',
    senderKind: 'node',
    senderNodeId: b2Coord.id,
    bodyMarkdown: '@strict-reviewer verify round 2',
  });
  await swarm.deliverPendingSwarmWakeups(b2Deps, { organizationId: b2Org.id });
  const certWake = b2Deliveries[b2Deliveries.length - 1];
  a.equal(certWake.sessionId, certRevRes.members[0].currentSessionId);
  a.equal(certWake.options.accessMode, 'read');
  a.equal(certWake.options.readOnlyRequired, true);
  a.equal(certWake.options.readOnlyAdvisory, undefined);

  // 9b. Blocker 3: applySessionContractFields preserves ephemeral_swarm lifecycleMode, revision=0, readOnlyAdvisory/readOnlyRequired
  const swarmContractSess = { id: 'sess-contract-sw', sessionPlane: 'organization' };
  sessionManager.__applySessionContractFieldsForTest(swarmContractSess, {
    lifecycleMode: 'ephemeral_swarm',
    organizationRevision: 0,
    readOnlyAdvisory: true,
    organizationId: b2Org.id,
    organizationRootSessionId: 'root-swarm-b2',
    organizationNodeId: advRevRes.members[0].id,
    roleInstanceId: advRevRes.members[0].roleInstanceId,
    controllerSessionId: 'root-swarm-b2',
    parentSessionId: 'root-swarm-b2',
  }, { sessionClass: 'REVIEWER', userAddressable: false });
  a.equal(swarmContractSess.lifecycleMode, 'ephemeral_swarm');
  a.equal(swarmContractSess.organizationRevision, 0);
  a.equal(swarmContractSess.readOnlyAdvisory, true);
  a.equal(swarmContractSess.accessMode, 'read');
  a.equal(managedInput.assertManagedSessionLineage(swarmContractSess), 'REVIEWER');

  const certContractSess = { id: 'sess-contract-cert', sessionPlane: 'organization' };
  sessionManager.__applySessionContractFieldsForTest(certContractSess, {
    lifecycleMode: 'ephemeral_swarm',
    organizationRevision: 0,
    readOnlyRequired: true,
    organizationId: b2Org.id,
    organizationRootSessionId: 'root-swarm-b2',
    organizationNodeId: certRevRes.members[0].id,
    roleInstanceId: certRevRes.members[0].roleInstanceId,
    controllerSessionId: 'root-swarm-b2',
    parentSessionId: 'root-swarm-b2',
  }, { sessionClass: 'REVIEWER', userAddressable: false });
  a.equal(certContractSess.readOnlyRequired, true);
  a.equal(certContractSess.readOnlyAdvisory, undefined);
  a.equal(certContractSess.accessMode, 'read');
  sessionManager.__applySessionContractFieldsForTest(certContractSess, {
    lifecycleMode: 'ephemeral_swarm',
    readOnlyAdvisory: true,
  }, { sessionClass: 'REVIEWER', userAddressable: false });
  a.equal(certContractSess.readOnlyRequired, true, 'readOnlyRequired opt-in must not downgrade to advisory');
  a.equal(certContractSess.readOnlyAdvisory, undefined);

  const formalContractSess = { id: 'sess-contract-formal', sessionPlane: 'organization' };
  sessionManager.__applySessionContractFieldsForTest(formalContractSess, {
    lifecycleMode: 'formal_org',
    organizationRevision: 0,
  }, { sessionClass: 'WORKER', userAddressable: false });
  a.equal(formalContractSess.lifecycleMode, 'formal_org');
  a.equal(formalContractSess.organizationRevision, undefined, 'formal_org keeps revision > 0 invariant');

  // 9c. Blocker 4: AgY ACP and stream-json-bidi classified uniformly with org MCP & builtin skill support
  for (const family of ['agy-json', 'agy-stream-json', 'agy-acp', 'agy-stream-json-bidi']) {
    a.equal(sessionManager.__isAgyRunManifestForTest({ tool: 'custom-wrapper', options: { runtimeFamily: family } }), true, `isAgyRunManifest accepts ${family}`);
    a.equal(sessionManager.__resolveRunNativeAgentTypeForTest({ tool: 'custom-wrapper', runtimeFamily: family }), 'agy', `nativeAgentType accepts ${family}`);
    a.equal(sessionManager.__resolveProviderContextKeyForTest('custom-wrapper', { runtimeFamily: family }), 'agy', `providerContextKey accepts ${family}`);
    const resume = sessionManager.__resolveResumeStateForTest(
      'custom-wrapper',
      { agyConversationId: 'conv-agy-123' },
      { runtimeFamily: family },
    );
    a.equal(resume.providerKey, 'agy');
    a.equal(resume.hasResume, true);
    a.equal(resume.agyConversationId, 'conv-agy-123');
  }
  a.equal(providerContract.supportsOrganizationControlMcp('agy-acp'), true);
  a.equal(providerContract.supportsServerBuiltinSkillRead('agy-acp'), true);
  a.equal(providerContract.supportsOrganizationControlMcp('agy-stream-json'), true);
  a.equal(providerContract.supportsServerBuiltinSkillRead('agy-stream-json'), true);

  // 9d. Minor Gap 5 + live real sessionManager.createSession (Blocker 3 + projectId): ephemeral_swarm sub-manager delegation context
  const realRootSess = await sessionManager.createSession(repoDir, 'agy', 'Swarm Real Root', {
    sessionClass: 'ROOT_LEADERSHIP',
    sessionPlane: 'user',
  });
  const realSessionDeps = {
    createSession: sessionManager.createSession,
    getSession: sessionManager.getSession,
    getRunState: () => null,
    requestRunCancel: async (runId) => ({ id: runId, state: 'cancelled' }),
    sendMessage: async (sessionId, text, images, options) => ({
      deferred: false,
      queued: false,
      run: { id: `run_real_${sessionId}`, options },
    }),
  };
  const { organization: realOrg, coordinatorNode: realCoord } = await swarm.ensureSwarmOrganization({
    rootSessionId: realRootSess.id,
    policy: { projectRoot: repoDir, maxConcurrent: 4, maxDepth: 2 },
  });
  const subMgrRes = await swarm.spawnSwarmMembers(realSessionDeps, {
    organizationId: realOrg.id,
    actorNodeId: realCoord.id,
    actorSessionId: realRootSess.id,
    name: 'sub-manager',
    role: 'manager',
    brief: 'Manage workers in ephemeral swarm',
    workspace: 'inherit',
    projectRoot: repoDir,
    tool: 'agy',
    runtimeFamily: 'agy-acp',
  });
  const subMgrNode = subMgrRes.members[0];
  const subMgrSess = await sessionManager.getSession(subMgrNode.currentSessionId);
  a.ok(subMgrSess);
  a.equal(subMgrSess.lifecycleMode, 'ephemeral_swarm');
  a.equal(subMgrSess.organizationRevision, 0);
  a.equal(managedInput.assertManagedSessionLineage(subMgrSess), 'MANAGER');
  const subMgrCtxRaw = await execCtx.buildOrganizationExecutionContext({
    sessionId: subMgrSess.id,
    runId: 'run-gap5-swarm',
    requestId: 'req-gap5-swarm',
    organizationToolScope: {
      kind: 'organization_message',
      organizationId: realOrg.id,
      nodeId: subMgrNode.id,
      bindingGeneration: subMgrNode.bindingGeneration,
      organizationRevision: 0,
    },
    selectedRuntime: { tool: 'agy', runtimeFamily: 'agy-acp' },
  });
  const subMgrCtxMatch = subMgrCtxRaw.match(/<organization-execution>\n([^\n]+)\n/);
  a.ok(subMgrCtxMatch, 'ephemeral_swarm sub-manager receives execution context JSON');
  const subMgrCtxPayload = JSON.parse(subMgrCtxMatch[1]);
  a.equal(subMgrCtxPayload.canDelegate, true);
  a.ok(subMgrCtxPayload.remainingDepth > 0);

  // Strict formal_org unfrozen revision=0 manager still denied delegation authority even when root session exists
  const formalRootSess = await sessionManager.createSession(repoDir, 'agy', 'Formal Root Real', {
    sessionClass: 'ROOT_LEADERSHIP',
    sessionPlane: 'user',
  });
  const formalUnfrozenOrg = await orgStore.createOrganization({
    rootSessionId: formalRootSess.id,
    projectId: 'proj-formal-unfrozen-gap5',
    currentRevision: 1,
  });
  const formalMgrSess = await sessionManager.createSession(repoDir, 'agy', 'Formal Unfrozen Manager', {
    sessionClass: 'MANAGER',
    sessionPlane: 'organization',
    organizationRootSessionId: formalRootSess.id,
    organizationId: formalUnfrozenOrg.id,
    organizationRevision: 1,
    organizationNodeId: 'formal-mgr-node',
    roleInstanceId: 'r-formal-mgr',
    controllerSessionId: formalRootSess.id,
    parentSessionId: formalRootSess.id,
  });
  const formalMgrNode = await orgStore.createNode({
    organizationId: formalUnfrozenOrg.id,
    stableKey: 'formal-mgr-node',
    nodeRole: 'manager',
    createdRevision: 1,
    lifecycleState: 'active',
    lifecycleMode: 'formal_org',
    currentSessionId: formalMgrSess.id,
    bindingGeneration: 1,
    sessionClass: 'MANAGER',
    grant: { role: 'manager', canDelegate: true, maxDepth: 2, maxChildren: 4 },
  });
  const formalMgrCtxRaw = await execCtx.buildOrganizationExecutionContext({
    sessionId: formalMgrSess.id,
    runId: 'run-gap5-formal',
    requestId: 'req-gap5-formal',
    organizationToolScope: {
      kind: 'organization_message',
      organizationId: formalUnfrozenOrg.id,
      nodeId: formalMgrNode.id,
      bindingGeneration: 1,
      organizationRevision: 1,
    },
    selectedRuntime: { tool: 'agy', runtimeFamily: 'agy-acp' },
  });
  const formalMgrCtxPayload = JSON.parse(formalMgrCtxRaw.match(/<organization-execution>\n([^\n]+)\n/)[1]);
  a.equal(formalMgrCtxPayload.canDelegate, false, 'formal_org unfrozen revision must NOT grant delegation');
  a.equal(formalMgrCtxPayload.remainingDepth, 0);

  // 10. Bugs #6, #7, #8 end-to-end: brief [done] does not end swarm/stall watchdog; real worktree member retains folder + projectId and scoped swarm_wakeup binds worktree root
  const isoProject = await projects.createProject({ name: 'Swarm Isolated Worktree', rootPath: repoDir });
  const isoRootSess = await sessionManager.createSession(repoDir, 'agy', 'Iso Root Coordinator', {
    projectId: isoProject.id,
    sessionClass: 'ROOT_LEADERSHIP',
    sessionPlane: 'user',
  });
  const isoDeliveries = [];
  const isoDeps = {
    createSession: sessionManager.createSession,
    getSession: sessionManager.getSession,
    getRunState: async () => null,
    requestRunCancel: async (runId) => ({ id: runId, state: 'cancelled' }),
    sendMessage: async (sessionId, text, images, options) => {
      isoDeliveries.push({ sessionId, text, options });
      return { deferred: false, queued: false, run: { id: `run_iso_${isoDeliveries.length}`, options } };
    },
  };
  const { organization: isoOrg, coordinatorNode: isoCoord } = await swarm.ensureSwarmOrganization({
    rootSessionId: isoRootSess.id,
    projectId: isoProject.id,
    policy: { projectRoot: repoDir, maxConcurrent: 4, maxDepth: 2 },
  });
  const isoAuthorRes = await swarm.spawnSwarmMembers(isoDeps, {
    organizationId: isoOrg.id,
    actorNodeId: isoCoord.id,
    actorSessionId: isoRootSess.id,
    name: 'iso-author',
    role: 'actor',
    brief: 'Fix math.mjs in isolated worktree and report @verifier [done] when ready',
    workspace: 'worktree',
    harness: 'agy',
    projectRoot: repoDir,
  });
  try {
    const isoAuthor = isoAuthorRes.members[0];
    a.equal(isoAuthorRes.messages[0].kind, 'brief');
    a.equal(isoAuthorRes.messages[0].isDoneSignal, false, 'Bug #6: brief containing [done] never marks isDoneSignal=true');
    const isoBoard = await boardStore.buildAuthoritativeBoardProjection({ organizationId: isoOrg.id });
    a.equal(isoBoard.isDone, false, 'Bug #6: brief containing @verifier [done] keeps swarm active');
    const isoStallCheck = await swarm.evaluateSwarmStalls(isoDeps, {
      organizationId: isoOrg.id,
      nowMs: Date.now(),
      stallThresholdMs: 300_000,
    });
    a.equal(isoStallCheck.evaluated, true, 'Bug #6: stall watchdog remains enabled after brief containing [done]');

    const isoAuthorSess = await sessionManager.getSession(isoAuthor.currentSessionId);
    const realWorktreePath = realpathSync(isoAuthor.workspacePath);
    const realRepoPath = realpathSync(repoDir);
    a.equal(isoAuthorSess.projectId, isoProject.id, 'Bug #8: isolated worktree session preserves canonical projectId');
    a.equal(realpathSync(isoAuthorSess.folder), realWorktreePath, 'Bug #8: session.folder preserves isolated worktree instead of project.rootPath');
    a.equal(isoAuthorSess.workspaceMode, 'worktree');
    a.notEqual(realpathSync(isoAuthorSess.folder), realRepoPath);
    a.equal(isoDeliveries[0].options.internalOperation, 'swarm_wakeup');
    a.equal(isoDeliveries[0].options.executionIsolation, 'worktree');

    // Spoofed isolated workspace without valid swarm org rejects fail-closed
    await a.rejects(
      () => sessionManager.createSession(realWorktreePath, 'agy', 'Spoofed Worktree', {
        projectId: isoProject.id,
        sessionClass: 'ACTOR',
        sessionPlane: 'organization',
        lifecycleMode: 'ephemeral_swarm',
        workspaceMode: 'worktree',
        organizationId: 'org_missing_spoof',
        organizationNodeId: 'node_missing_spoof',
        organizationRootSessionId: isoRootSess.id,
        controllerSessionId: isoRootSess.id,
        parentSessionId: isoRootSess.id,
        organizationRevision: 0,
      }),
      /invalid|not found|required/i,
      'spoofed isolated swarm session rejects fail-closed',
    );

    await collaborationStore.withDatabase(() => {});
    const admitted = await runAdmission.prepareRunExecution({
      sessionId: isoAuthorSess.id,
      session: isoAuthorSess,
      manifest: {
        sessionId: isoAuthorSess.id,
        requestId: 'req_iso_author_wake',
        folder: isoAuthorSess.folder,
        tool: 'agy',
        prompt: 'edit worktree',
      },
      options: {
        runId: 'run_iso_author_wake',
        internalOperation: 'swarm_wakeup',
        executionIsolation: 'worktree',
      },
    });
    a.equal(admitted.legacy, false, 'Bug #7: swarm_wakeup enters scoped admission instead of legacy');
    a.equal(admitted.executionScope.projectId, isoProject.id);
    a.equal(admitted.executionScope.executionIsolation, 'worktree');
    a.equal(admitted.executionScope.workspaceRoot.realPath, realWorktreePath, 'Bug #8: workspaceRoot binds to isolated worktree');
    a.equal(admitted.executionScope.cwd.realPath, realWorktreePath, 'Bug #8: cwd binds to isolated worktree');
    a.equal(admitted.executionScope.riskContext.trustedWorkspaceRoot, realWorktreePath, 'Bug #8: trustedWorkspaceRoot binds to isolated worktree');
    const riskBinding = runnerSidecar.resolveRunRiskContext(admitted.manifest);
    a.equal(riskBinding.valid, true, `Bug #7/#8: resolveRunRiskContext must accept swarm_wakeup worktree snapshot (${riskBinding.reason})`);
    if (process.platform === 'win32') {
      const gateState = {
        riskMode: 'full-auto',
        cwd: admitted.executionScope.cwd.realPath,
        riskContext: riskBinding.riskContext,
        riskContextValid: riskBinding.valid,
      };
      const worktreeWrite = await windowsGate.decideWindowsApproval({
        providerMethod: 'can_use_tool',
        params: { tool_name: 'Write', input: { file_path: join(realWorktreePath, 'src', 'app.js') } },
      }, gateState);
      a.equal(worktreeWrite.decision, 'auto-allow', 'Bug #8: writes inside isolated worktree auto-allow');
      const mainWrite = await windowsGate.decideWindowsApproval({
        providerMethod: 'can_use_tool',
        params: { tool_name: 'Write', input: { file_path: join(realRepoPath, 'src', 'app.js') } },
      }, gateState);
      a.equal(mainWrite.decision, 'prompt', 'Bug #8: writes to canonical main project root do NOT auto-allow');
    }
  } finally {
    await swarm.killSwarmMember(isoDeps, {
      organizationId: isoOrg.id,
      actorNodeId: isoCoord.id,
      targetNameOrNodeId: 'iso-author',
      projectRoot: repoDir,
      forceDiscard: true,
    }).catch(() => {});
  }

  // 11. Bug #9: Tightly-gated Coordinator swarm_wakeup sessionControlChannel + stuck 'working' settlement
  const coordWakeOutcome = await sessionManager.sendMessage(isoRootSess.id, '[Swarm Board Doorbell] #4 @coordinator PASS', [], {
    internalOperation: 'swarm_wakeup',
    internalOrganizationWakeup: true,
    organizationId: isoOrg.id,
    organizationNodeId: isoCoord.id,
    skipRunnerLaunch: true,
    recordUserMessage: false,
  });
  a.ok(coordWakeOutcome?.run?.id, 'Bug #9: Coordinator swarm_wakeup creates run');
  const coordWakeManifest = await runs.getRunManifest(coordWakeOutcome.run.id);
  const coordCtrl = coordWakeManifest?.options?.sessionControlChannel;
  a.match(coordCtrl?.tokenHash || '', /^[a-f0-9]{64}$/, 'Bug #9: active Swarm ROOT_LEADERSHIP wakeup persists root sessionControlChannel tokenHash');
  a.match(coordCtrl?.renewalTokenHash || '', /^[a-f0-9]{64}$/, 'Bug #9: active Swarm ROOT_LEADERSHIP wakeup persists renewalTokenHash');
  a.equal(coordCtrl?.scope, undefined, 'Bug #9: Coordinator wakeup capability stays root-scoped (scope=null)');
  a.equal(coordWakeManifest?.protectedDelegatedRun, true);
  a.equal(coordWakeManifest?.options?.windowsBrokerChannel, undefined, 'Coordinator wakeup must NOT gain owner Windows broker authority');

  // Public sendUserMessage strips internalOperation / internalOrganizationWakeup so unauthenticated user callers cannot spoof swarm_wakeup capability
  const spoofRootSess = await sessionManager.createSession(repoDir, 'agy', 'Spoof Guard Root', {
    projectId: isoProject.id,
    sessionClass: 'ROOT_LEADERSHIP',
    sessionPlane: 'user',
  });
  const { organization: spoofOrg } = await swarm.ensureSwarmOrganization({
    rootSessionId: spoofRootSess.id,
    projectId: isoProject.id,
    policy: { projectRoot: repoDir, maxConcurrent: 4, maxDepth: 2 },
  });
  const spoofedUserOutcome = await sessionManager.sendUserMessage(spoofRootSess.id, 'spoof attempt', [], {
    internalOperation: 'swarm_wakeup',
    internalOrganizationWakeup: true,
    organizationId: spoofOrg.id,
    skipRunnerLaunch: true,
    requestId: 'req_spoof_user_wakeup',
  });
  a.ok(spoofedUserOutcome?.run?.id);
  const spoofedManifest = await runs.getRunManifest(spoofedUserOutcome.run.id);
  a.equal(spoofedManifest?.options?.sessionControlChannel, undefined, 'sendUserMessage must strip internalOperation and deny sessionControlChannel without principal');

  // Non-swarm ROOT_LEADERSHIP session calling internalOperation='swarm_wakeup' stays denied
  const nonSwarmRootSess = await sessionManager.createSession(repoDir, 'agy', 'Plain Root Session', {
    projectId: isoProject.id,
    sessionClass: 'ROOT_LEADERSHIP',
    sessionPlane: 'user',
  });
  const nonSwarmOutcome = await sessionManager.sendMessage(nonSwarmRootSess.id, 'no org', [], {
    internalOperation: 'swarm_wakeup',
    internalOrganizationWakeup: true,
    skipRunnerLaunch: true,
    recordUserMessage: false,
  });
  const nonSwarmManifest = await runs.getRunManifest(nonSwarmOutcome.run.id);
  a.equal(nonSwarmManifest?.options?.sessionControlChannel, undefined, 'non-swarm root session denied swarm_wakeup sessionControlChannel');

  // Stuck 'working' state settlement on failure/completion + reconcileSwarmMemberStates runId-keyed lookup
  await swarm.markSwarmMemberState({
    organizationId: isoOrg.id,
    nodeId: isoCoord.id,
    swarmState: 'working',
    lastRunId: 'run_bug9_fail_1',
  });
  const runStatusMap = new Map([
    ['run_bug9_fail_1', { id: 'run_bug9_fail_1', state: 'failed', failureReason: 'MCP_ORGANIZATION_CAPABILITY_MISSING sk-secretTokenValue987654321' }],
  ]);
  const reconcileSettled = await swarm.reconcileSwarmMemberStates({
    getSession: async () => ({ id: isoRootSess.id }), // activeRunId cleared
    getRunState: async (runId) => runStatusMap.get(runId) || null,
  }, { organizationId: isoOrg.id });
  a.equal(reconcileSettled.settled, 1, 'Bug #9: reconcileSwarmMemberStates settles stuck working member using lastRunId');
  a.equal(reconcileSettled.nodes[0].swarmState, 'waiting');
  a.equal(reconcileSettled.nodes[0].lastRunFailure?.state, 'failed');
  a.equal(reconcileSettled.nodes[0].lastRunFailure?.reason.includes('sk-secretTokenValue987654321'), false, 'failure reason secrets redacted');
  a.ok(reconcileSettled.nodes[0].lastRunFailure?.reason.includes('[REDACTED]'));

  // 12. P0 #2 regression: deliverPendingSwarmWakeups + sessionManager swarm_wakeup preserve model/effort/providerProfile/tool/riskMode
  const rtRootSess = await sessionManager.createSession(repoDir, 'agy', 'Swarm Wakeup Model Root', {
    projectId: isoProject.id,
    sessionClass: 'ROOT_LEADERSHIP',
    sessionPlane: 'user',
    model: 'test-swarm-model-1',
    effort: 'high',
    riskMode: 'full-auto',
    riskModeExplicit: true,
  });
  const rtDeliveries = [];
  const rtDeps = {
    createSession: sessionManager.createSession,
    getSession: sessionManager.getSession,
    getRunState: async () => null,
    requestRunCancel: async (runId) => ({ id: runId, state: 'cancelled' }),
    sendMessage: async (sessionId, text, images, options) => {
      rtDeliveries.push({ sessionId, text, options });
      return { deferred: false, queued: false, run: { id: `run_rt_${rtDeliveries.length}`, options } };
    },
  };
  const { organization: rtOrg, coordinatorNode: rtCoord } = await swarm.ensureSwarmOrganization({
    rootSessionId: rtRootSess.id,
    projectId: isoProject.id,
    policy: { projectRoot: repoDir, maxConcurrent: 4, maxDepth: 2 },
    actor: {
      projectId: isoProject.id,
      runtimePolicy: { tool: 'agy', model: 'test-swarm-model-1', effort: 'high' },
      riskMode: 'full-auto',
      riskModeExplicit: true,
    },
  });
  const rtSpawn = await swarm.spawnSwarmMembers(rtDeps, {
    organizationId: rtOrg.id,
    actorNodeId: rtCoord.id,
    actorSessionId: rtRootSess.id,
    name: 'rt-worker',
    brief: 'Verify wakeup runtime tuple',
    deferDelivery: true,
  });
  const rtWorker = rtSpawn.members[0];
  a.equal(rtDeliveries.length, 0);
  const wakeRes = await swarm.deliverPendingSwarmWakeups(rtDeps, { organizationId: rtOrg.id });
  a.equal(wakeRes.delivered, 1);
  a.equal(rtDeliveries[0].options.tool, 'agy');
  a.equal(rtDeliveries[0].options.model, 'test-swarm-model-1');
  a.equal(rtDeliveries[0].options.effort, 'high');
  a.equal(rtDeliveries[0].options.riskMode, 'full-auto');
  a.equal(rtDeliveries[0].options.riskModeExplicit, true);

  // Even if an internal swarm_wakeup caller omits options.model / options.effort, sessionManager inherits session.model / session.effort.
  const wakeRunRes = await sessionManager.sendMessage(rtWorker.currentSessionId, '[Swarm Board Doorbell] #1 fallback test', [], {
    internalOperation: 'swarm_wakeup',
    internalOrganizationWakeup: true,
    organizationId: rtOrg.id,
    organizationNodeId: rtWorker.id,
    bindingGeneration: rtWorker.bindingGeneration,
    skipRunnerLaunch: true,
    recordUserMessage: false,
  });
  a.ok(wakeRunRes?.run?.id, 'swarm_wakeup fallback creates a run');
  a.equal(wakeRunRes.run.model, 'test-swarm-model-1', 'run.model inherits session.model on swarm_wakeup');
  a.equal(wakeRunRes.run.effort, 'high', 'run.effort inherits session.effort on swarm_wakeup');
  const wakeRunManifest = await runs.getRunManifest(wakeRunRes.run.id);
  a.equal(wakeRunManifest?.options?.model, 'test-swarm-model-1', 'manifest.options.model inherits session.model on swarm_wakeup');
  a.equal(wakeRunManifest?.options?.effort, 'high', 'manifest.options.effort inherits session.effort on swarm_wakeup');
  a.equal(wakeRunManifest?.options?.riskMode, 'full-auto', 'manifest.options.riskMode preserves explicit riskMode');
}

try {
  await runTests();
  console.log(`test-organization-swarm: ok (${assertionCount} assertions)`);
} finally {
  await sessionManager.killAll();
  rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
