#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tempRoot = mkdtempSync(join(tmpdir(), 'ragent-swarm-watchdog-'));
const instanceRoot = join(tempRoot, 'instance');
const configDir = join(instanceRoot, 'config');
process.env.HOME = tempRoot;
process.env.USERPROFILE = tempRoot;
process.env.LOCALAPPDATA = join(tempRoot, 'localappdata');
process.env.APPDATA = join(tempRoot, 'appdata');
process.env.RAGENT_INSTANCE_ROOT = instanceRoot;
process.env.RAGENT_CONFIG_DIR = configDir;
mkdirSync(configDir, { recursive: true });
mkdirSync(process.env.LOCALAPPDATA, { recursive: true });
mkdirSync(process.env.APPDATA, { recursive: true });

const orgStore = await import('../chat/organization-store.mjs');
const collabStore = await import('../chat/collaboration-store.mjs');
const boardStore = await import('../chat/organization-board-store.mjs');
const swarm = await import('../chat/organization-swarm.mjs');
const { createCollaborationOrchestrator } = await import('../chat/collaboration-orchestrator.mjs');

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

async function runTests() {
  await collabStore.initializeCollaborationStore();
  await orgStore.initializeOrganizationStore();

  let fakeNowMs = Date.now();
  const deliveries = [];
  const ownerAlerts = [];
  const runStates = new Map();
  const sessions = new Map([
    ['root-watchdog-1', { id: 'root-watchdog-1', folder: tempRoot, tool: 'codex' }],
  ]);

  const mockDeps = {
    createSession: async (folder, tool, name, extra) => {
      const id = `sess_${sessions.size + 1}`;
      const rec = { id, folder, tool, name, ...extra };
      sessions.set(id, rec);
      return rec;
    },
    getSession: async (id) => sessions.get(id) || null,
    getRunState: async (sessionId) => runStates.get(sessionId) || null,
    sendMessage: async (sessionId, text, images, options) => {
      deliveries.push({ sessionId, text, options });
      return { deferred: false, queued: false, run: { id: `run_${deliveries.length}` } };
    },
    notifyOwner: async (alert) => {
      ownerAlerts.push(alert);
    },
  };

  const orchestrator = createCollaborationOrchestrator({
    pollMs: 60_000,
    dependencies: mockDeps,
    swarmStall: {
      nowMs: () => fakeNowMs,
      stallThresholdMs: 5_000,
      cooldownMs: 10_000,
      maxAlerts: 3,
    },
  });

  const { organization: org, coordinatorNode } = await swarm.ensureSwarmOrganization({
    rootSessionId: 'root-watchdog-1',
    projectId: 'proj-watchdog',
    title: 'Stall Watchdog Swarm',
    policy: { projectRoot: tempRoot },
  });

  const spawnRes = await swarm.spawnSwarmMembers(mockDeps, {
    organizationId: org.id,
    actorNodeId: coordinatorNode.id,
    actorSessionId: 'root-watchdog-1',
    name: 'worker-1',
    role: 'worker',
    brief: 'Run slice 1',
    projectRoot: tempRoot,
    deferDelivery: false,
  });
  const worker1 = spawnRes.members[0];
  // Clear initial brief delivery count; coordinator is working while worker-1 transitions to working
  const deliveriesBeforeReconcile = deliveries.length;

  // 1. Active working swarm within threshold -> 0 LLM dispatches & 0 stall alerts
  await swarm.markSwarmMemberState({ organizationId: org.id, nodeId: worker1.id, swarmState: 'working' });
  await orchestrator.reconcile();
  a.equal(deliveries.length, deliveriesBeforeReconcile, '0-token watchdog emits zero messages while active');
  a.equal((await swarm.getSwarmStatus({ organizationId: org.id })).activeStalls.length, 0);

  // 2. Condition 1 (all_waiting, not [done]): first alert -> coordinator + same-tick doorbell; cooldown -> owner escalation; maxAlerts=3
  await swarm.markSwarmMemberState({ organizationId: org.id, nodeId: coordinatorNode.id, swarmState: 'waiting' });
  await swarm.markSwarmMemberState({ organizationId: org.id, nodeId: worker1.id, swarmState: 'waiting' });

  // Before threshold -> 0 alerts
  await orchestrator.reconcile();
  a.equal((await swarm.getSwarmStatus({ organizationId: org.id })).activeStalls.length, 0);

  // Past threshold -> 1st alert goes to coordinator and reconciler wakes coordinator in same tick
  fakeNowMs += 10_000;
  await orchestrator.reconcile();
  const afterAlert1 = await swarm.getSwarmStatus({ organizationId: org.id });
  a.equal(afterAlert1.activeStalls.length, 1);
  a.equal(afterAlert1.activeStalls[0].conditionKind, 'all_waiting');
  a.equal(afterAlert1.activeStalls[0].targetRole, 'coordinator');
  a.equal(afterAlert1.activeStalls[0].alertCount, 1);
  a.equal(ownerAlerts.length, 0);
  const coordWake = deliveries.slice(deliveriesBeforeReconcile).find((d) => d.sessionId === 'root-watchdog-1');
  a.ok(coordWake?.text.includes('[stall]'), 'coordinator receives [stall] doorbell wakeup');
  a.equal(coordWake?.options.internalOperation, 'swarm_wakeup');

  // Coordinator goes back to waiting without resolving stall -> within cooldown skipped, past cooldown escalates to owner
  await swarm.markSwarmMemberState({ organizationId: org.id, nodeId: coordinatorNode.id, swarmState: 'waiting' });
  fakeNowMs += 2_000; // within 10s cooldown
  const cooldownRes = await swarm.evaluateSwarmStalls(mockDeps, {
    organizationId: org.id,
    nowMs: fakeNowMs,
    stallThresholdMs: 5_000,
    cooldownMs: 10_000,
    maxAlerts: 3,
  });
  a.equal(cooldownRes.alertsEmitted.length, 0);
  a.equal(cooldownRes.alertsSkipped[0].reason, 'cooldown_active');

  // 2nd alert (past cooldown) escalates to owner
  fakeNowMs += 12_000;
  await orchestrator.reconcile();
  a.equal(ownerAlerts.length, 1);
  a.equal(ownerAlerts[0].conditionKind, 'all_waiting');

  // 3rd alert (past cooldown) reaches maxAlerts=3
  fakeNowMs += 12_000;
  await orchestrator.reconcile();
  a.equal(ownerAlerts.length, 2);

  // 4th attempt past cooldown MUST be suppressed by maxAlerts=3
  fakeNowMs += 12_000;
  const maxRes = await swarm.evaluateSwarmStalls(mockDeps, {
    organizationId: org.id,
    nowMs: fakeNowMs,
    stallThresholdMs: 5_000,
    cooldownMs: 10_000,
    maxAlerts: 3,
  });
  a.equal(maxRes.alertsEmitted.length, 0);
  a.equal(maxRes.alertsSkipped[0].reason, 'max_alerts_reached');
  a.equal(ownerAlerts.length, 2);

  // Moving worker back to working resolves active stall alerts cleanly
  await swarm.markSwarmMemberState({ organizationId: org.id, nodeId: coordinatorNode.id, swarmState: 'working' });
  await swarm.markSwarmMemberState({ organizationId: org.id, nodeId: worker1.id, swarmState: 'working' });
  a.equal((await swarm.getSwarmStatus({ organizationId: org.id })).activeStalls.length, 0);

  // 3. Condition 2 (overdue_mention): unread mention past threshold alerts coordinator; clears once read
  await swarm.markSwarmMemberState({ organizationId: org.id, nodeId: worker1.id, swarmState: 'waiting' });
  const mentionPost = await boardStore.postBoardMessage({
    organizationId: org.id,
    channel: 'main',
    senderKind: 'node',
    senderNodeId: coordinatorNode.id,
    bodyMarkdown: '@worker-1 please inspect backlog',
  });
  const overdueEval = await swarm.evaluateSwarmStalls(mockDeps, {
    organizationId: org.id,
    nowMs: Date.parse(mentionPost.message.createdAt) + 20_000,
    stallThresholdMs: 5_000,
    cooldownMs: 10_000,
    maxAlerts: 3,
  });
  const overdueAlert = overdueEval.alertsEmitted.find((x) => x.conditionKind === 'overdue_mention');
  a.ok(overdueAlert, 'overdue_mention alert emitted when wakeup unconsumed past threshold');
  a.equal(overdueAlert.targetRole, 'coordinator');

  // Advance worker1 read cursor -> overdue_mention no longer matches
  await boardStore.readBoardMessages({
    organizationId: org.id,
    channel: 'main',
    sinceSeq: 0,
    readerNodeId: worker1.id,
    advanceCursor: true,
  });
  const clearedOverdueEval = await swarm.evaluateSwarmStalls(mockDeps, {
    organizationId: org.id,
    nowMs: Date.parse(mentionPost.message.createdAt) + 40_000,
    stallThresholdMs: 5_000,
    cooldownMs: 10_000,
    maxAlerts: 3,
  });
  a.equal(
    clearedOverdueEval.alertsEmitted.some((x) => x.conditionKind === 'overdue_mention'),
    false,
  );

  // 4. Condition 3 (crashed_member): quota_exhausted worker alerts coordinator & redacts secrets; crashed coordinator escalates directly to owner
  runStates.set(worker1.currentSessionId, {
    runId: 'run-crash-w1',
    state: 'quota_exhausted',
    failureReason: '429 key sk-secretTokenValue987654321 exhausted',
  });
  fakeNowMs += 20_000;
  const crashWorkerEval = await swarm.evaluateSwarmStalls(mockDeps, {
    organizationId: org.id,
    nowMs: fakeNowMs,
    stallThresholdMs: 5_000,
    cooldownMs: 10_000,
    maxAlerts: 3,
  });
  const crashW1Alert = crashWorkerEval.alertsEmitted.find((x) => x.conditionKind === 'crashed_member');
  a.ok(crashW1Alert);
  a.equal(crashW1Alert.targetRole, 'coordinator');
  a.equal(crashW1Alert.message.text.includes('sk-secretTokenValue987654321'), false, 'secrets must be redacted');
  a.ok(crashW1Alert.message.text.includes('[REDACTED]'));

  // Flush prior pending wakeups, then verify crashed coordinator escalates directly to owner
  await swarm.deliverPendingSwarmWakeups(mockDeps, { organizationId: org.id });
  const deliverCountBeforeCoordCrash = deliveries.length;
  runStates.delete(worker1.currentSessionId);
  runStates.set('root-watchdog-1', {
    runId: 'run-crash-coord',
    state: 'crashed',
    error: 'SIGTERM unexpected termination',
  });
  const ownerBeforeCoordCrash = ownerAlerts.length;
  await orchestrator.reconcile();
  a.equal(ownerAlerts.length, ownerBeforeCoordCrash + 1);
  a.equal(ownerAlerts.at(-1).conditionKind, 'crashed_member');
  a.equal(deliveries.length, deliverCountBeforeCoordCrash, 'crashed coordinator alert goes to owner, zero extra coordinator prompts');
  const settledCoordStatus = await swarm.getSwarmStatus({ organizationId: org.id });
  const settledCoord = settledCoordStatus.members.find((m) => m.id === coordinatorNode.id);
  a.equal(settledCoord.swarmState, 'waiting', 'reconcileSwarm settles crashed working member back to waiting');

  // 5. markSwarmDone marks swarm [done] -> suppresses all watchdog evaluations and clears active alerts
  await swarm.markSwarmDone({
    organizationId: org.id,
    actorNodeId: coordinatorNode.id,
    summary: 'Swarm finished cleanly',
    postToBoard: true,
  });
  fakeNowMs += 100_000;
  const doneEval = await swarm.evaluateSwarmStalls(mockDeps, {
    organizationId: org.id,
    nowMs: fakeNowMs,
    stallThresholdMs: 1,
  });
  a.equal(doneEval.evaluated, false);
  a.equal(doneEval.alertsEmitted.length, 0);
  a.equal((await swarm.getSwarmStatus({ organizationId: org.id })).activeStalls.length, 0);

  // Also test swarmWatchdog: false disables orchestrator sweep cleanly
  const disabledOrch = createCollaborationOrchestrator({
    swarmWatchdog: false,
    dependencies: mockDeps,
  });
  const disabledRes = await disabledOrch.reconcileSwarm();
  a.deepEqual(disabledRes, { organizations: 0, wakeupsDelivered: 0, alertsEmitted: 0 });
}

try {
  await runTests();
  console.log(`test-swarm-stall-watchdog: ok (${assertionCount} assertions)`);
} finally {
  rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
