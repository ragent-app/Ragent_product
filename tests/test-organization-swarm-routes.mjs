#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';

const tempHome = mkdtempSync(join(tmpdir(), 'ragent-org-swarm-routes-'));
process.env.HOME = tempHome;
process.env.RAGENT_INSTANCE_ROOT = tempHome;
process.env.RAGENT_CONFIG_DIR = join(tempHome, 'config');
process.env.RAGENT_DATA_DIR = join(tempHome, 'data');
process.env.RAGENT_ORG_PROJECTION_V1_ENABLED = '1';
process.env.RAGENT_ORG_PROJECTION_V2_ENABLED = '1';
mkdirSync(join(tempHome, 'workspace'), { recursive: true });

const orgStore = await import('../chat/organization-store.mjs');
const boardStore = await import('../chat/organization-board-store.mjs');
const swarm = await import('../chat/organization-swarm.mjs');
const sessionManager = await import('../chat/session-manager.mjs');
const { handleOrganizationRoutes } = await import('../chat/router-organization-routes.mjs');

function responseProbe() {
  const state = { status: 0, payload: null, headers: {} };
  return {
    state,
    setHeader(key, value) { state.headers[key] = value; },
    writeHead(status, headers) { state.status = status; Object.assign(state.headers, headers); },
    end(body) { state.payload = body ? JSON.parse(body) : null; },
  };
}

async function invoke(method, urlWithQuery, { authSession = { role: 'owner' }, body = undefined, listMembers = undefined, swarmDeps = undefined } = {}) {
  const res = responseProbe();
  const pathname = urlWithQuery.split('?')[0];
  const rawBody = body === undefined ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
  const req = Object.assign(Readable.from(rawBody ? [Buffer.from(rawBody)] : []), {
    method,
    url: urlWithQuery,
    headers: rawBody ? { 'content-type': 'application/json' } : {},
  });
  const handled = await handleOrganizationRoutes({
    req,
    res,
    pathname,
    authSession,
    writeJson: (_r, status, payload) => { res.state.status = status; res.state.payload = payload; },
    ...(listMembers ? { listMembers } : {}),
    ...(swarmDeps !== undefined ? { swarmDeps } : {}),
  });
  return { handled, ...res.state };
}

let assertions = 0;
function equal(actual, expected, message) { assertions += 1; assert.equal(actual, expected, message); }
function ok(value, message) { assertions += 1; assert.ok(value, message); }

try {
  await orgStore.initializeOrganizationStore();

  // 1. Create a plain session (no Ragent org) to verify native fallback & 404 guards
  const nativeRootSession = await sessionManager.createSession('Native Fallback Root');
  const plainSession = await sessionManager.createSession('Plain Empty Session');

  // 1a. Auth & principalKind guards on all Wave 2A endpoints
  const endpoints = [
    ['GET', `/api/sessions/${nativeRootSession.id}/organization/board`],
    ['POST', `/api/sessions/${nativeRootSession.id}/organization/board/messages`, { bodyMarkdown: 'hi' }],
    ['GET', `/api/sessions/${nativeRootSession.id}/organization/swarm/status`],
    ['POST', `/api/sessions/${nativeRootSession.id}/organization/swarm/channels`, { name: 'review' }],
    ['POST', `/api/sessions/${nativeRootSession.id}/organization/swarm/kill`, { targetNameOrNodeId: 'worker-1' }],
  ];
  for (const [method, url, body] of endpoints) {
    const agentDenied = await invoke(method, url, { authSession: { role: 'agent' }, body });
    equal(agentDenied.status, 403, `${method} ${url} rejects non-owner agent`);
    const capDenied = await invoke(method, url, { authSession: { role: 'owner', principalKind: 'run_capability' }, body });
    equal(capDenied.status, 403, `${method} ${url} rejects run_capability even if role=owner`);
  }

  // 1b. Method enforcement (405)
  equal((await invoke('POST', `/api/sessions/${nativeRootSession.id}/organization/board`)).status, 405, 'POST /board returns 405');
  equal((await invoke('GET', `/api/sessions/${nativeRootSession.id}/organization/board/messages`)).status, 405, 'GET /board/messages returns 405');
  equal((await invoke('POST', `/api/sessions/${nativeRootSession.id}/organization/swarm/status`)).status, 405, 'POST /swarm/status returns 405');
  equal((await invoke('GET', `/api/sessions/${nativeRootSession.id}/organization/swarm/channels`)).status, 405, 'GET /swarm/channels returns 405');
  equal((await invoke('GET', `/api/sessions/${nativeRootSession.id}/organization/swarm/kill`)).status, 405, 'GET /swarm/kill returns 405');

  // 1c. Missing session / missing org -> 404
  equal((await invoke('GET', '/api/sessions/nonexistent-session-xyz/organization/board')).status, 404, 'missing session /board -> 404');
  equal((await invoke('GET', `/api/sessions/${plainSession.id}/organization/swarm/status`)).status, 404, 'no org /swarm/status -> 404');
  equal((await invoke('POST', `/api/sessions/${plainSession.id}/organization/board/messages`, { body: { text: 'nope' } })).status, 404, 'no org POST /board/messages -> 404');

  // 1d. Native AgY read-only fallback when no authoritative Ragent board exists
  const nativeStub = async () => ({
    availability: 'partial',
    gap: false,
    board: {
      schemaVersion: 1,
      source: 'provider_native',
      provider: 'agy',
      readOnly: true,
      title: 'Agy Native Board',
      channels: [{ name: 'main', messageCount: 2, latestSeq: 2 }],
      messages: [
        { seq: 1, channel: 'main', sender: 'coordinator', text: 'native brief' },
        { seq: 2, channel: 'review', sender: 'echoer', text: 'native finding' },
      ],
    },
    channels: [{ name: 'main', messageCount: 2, latestSeq: 2 }],
  });

  const nativeBoardRes = await invoke('GET', `/api/sessions/${nativeRootSession.id}/organization/board`, { listMembers: nativeStub });
  equal(nativeBoardRes.status, 200, 'native board GET succeeds');
  equal(nativeBoardRes.payload.mode, 'provider_native', 'native fallback exposes mode=provider_native');
  equal(nativeBoardRes.payload.readOnly, true, 'native fallback exposes readOnly=true');
  equal(nativeBoardRes.payload.board.mode, 'provider_native');
  equal(nativeBoardRes.payload.board.readOnly, true);
  equal(nativeBoardRes.payload.board.title, 'Agy Native Board');
  equal(nativeBoardRes.payload.board.messages.length, 2);

  // 2. Authoritative Ragent Swarm Board & Status
  const swarmRootSession = await sessionManager.createSession('Swarm Coordinator Root');
  const ensured = await swarm.ensureSwarmOrganization({
    rootSessionId: swarmRootSession.id,
    title: 'Wave 2A Swarm',
    policy: { projectRoot: join(tempHome, 'workspace') },
    budget: { maxTotalRuns: 8 },
  });
  const orgId = ensured.organization.id;

  const w1Session = await sessionManager.createSession('Worker 1 Session');
  const v1Session = await sessionManager.createSession('Verifier 1 Session');
  const execGitStub = async (_cmd, args) => {
    if (Array.isArray(args) && args.includes('rev-parse')) return { stdout: 'abc123head\n', stderr: '' };
    return { stdout: '', stderr: '' };
  };
  const spawnW1 = await swarm.spawnSwarmMembers({
    createSession: async () => w1Session,
    createWorktree: async ({ branchName }) => ({
      worktreePath: join(tempHome, 'workspace', branchName.replace(/\//g, '-')),
      branchName,
    }),
    execFile: execGitStub,
    deliverSessionMessage: async () => ({ delivered: true }),
  }, {
    organizationId: orgId,
    actorNodeId: ensured.coordinatorNode.id,
    name: 'worker-1',
    role: 'worker',
    harness: 'codex',
    model: 'gpt-5-codex',
    workspace: 'worktree',
    brief: 'Implement route handlers',
  });
  const spawnV1 = await swarm.spawnSwarmMembers({
    createSession: async () => v1Session,
    deliverSessionMessage: async () => ({ delivered: true }),
  }, {
    organizationId: orgId,
    actorNodeId: ensured.coordinatorNode.id,
    name: 'verifier-1',
    role: 'reviewer',
    harness: 'claude',
    model: 'claude-sonnet',
    workspace: 'inherit',
    brief: 'Verify routes & XSS',
  });
  equal(spawnW1.members.length + spawnV1.members.length, 2, 'spawned 2 swarm members');
  const workerNode = spawnW1.members[0];
  const verifierNode = spawnV1.members[0];
  ok(workerNode && verifierNode);
  ok(workerNode.workspaceBranch.startsWith('swarm/'), 'worker assigned worktree branch');

  // Put worker-1 back in waiting state so owner @mention wakes it
  await swarm.markSwarmMemberState({ organizationId: orgId, nodeId: workerNode.nodeId, swarmState: 'waiting' });

  // 2a. GET /board returns authoritative ragent_swarm separated from nativeBoard
  const separatedBoard = await invoke('GET', `/api/sessions/${swarmRootSession.id}/organization/board`, { listMembers: nativeStub });
  equal(separatedBoard.status, 200);
  equal(separatedBoard.payload.mode, 'ragent_swarm', 'authoritative board takes mode=ragent_swarm');
  equal(separatedBoard.payload.readOnly, false, 'authoritative board is writable');
  equal(separatedBoard.payload.board.mode, 'ragent_swarm');
  equal(separatedBoard.payload.board.readOnly, false);
  equal(separatedBoard.payload.nativeBoard?.mode, 'provider_native', 'nativeBoard returned separately');
  equal(separatedBoard.payload.nativeBoard?.readOnly, true);
  equal(separatedBoard.payload.board.messages.some((m) => m.text === 'native brief'), false, 'native messages never leak into ragent board');

  // 2b. Channel management: create & archive guard
  const createChan = await invoke('POST', `/api/sessions/${swarmRootSession.id}/organization/swarm/channels`, {
    body: { action: 'create', name: '#Review', topic: 'Code review findings' },
  });
  equal(createChan.status, 201, 'create channel succeeds');
  equal(createChan.payload.channel.name, 'review');

  const archiveMain = await invoke('POST', `/api/sessions/${swarmRootSession.id}/organization/swarm/channels`, {
    body: { action: 'archive', name: 'main' },
  });
  equal(archiveMain.status, 409, 'archiving #main is rejected');
  equal(archiveMain.payload.code, 'BOARD_MAIN_CHANNEL_PROTECTED');

  // 2c. Owner ordinary message creates ZERO wakeups
  const deliveries = [];
  const fakeDeps = {
    deliverSessionMessage: async (sessionId, text, images, opts) => {
      deliveries.push({ sessionId, text, images, opts });
      return { delivered: true };
    },
    getSession: async (id) => sessionManager.getSessionMeta(id),
  };

  const ordinaryPost = await invoke('POST', `/api/sessions/${swarmRootSession.id}/organization/board/messages`, {
    body: {
      channel: 'main',
      senderKind: 'node', // spoofed by client -> server must override to 'owner'
      bodyMarkdown: 'Ordinary status note without mention.',
    },
    swarmDeps: fakeDeps,
  });
  equal(ordinaryPost.status, 201, 'ordinary owner post succeeds');
  equal(ordinaryPost.payload.message.senderKind, 'owner', 'server forces senderKind=owner');
  equal(ordinaryPost.payload.wakeups.length, 0, 'ordinary post produces 0 wakeups');
  equal(deliveries.length, 0, 'ordinary post triggers 0 wake deliveries');

  // 2d. Owner @mention message triggers wakeup doorbell
  const mentionPost = await invoke('POST', `/api/sessions/${swarmRootSession.id}/organization/board/messages`, {
    body: {
      channel: 'review',
      bodyMarkdown: `@worker-1 please verify #${ordinaryPost.payload.message.seq} [done]`,
    },
    swarmDeps: fakeDeps,
  });
  equal(mentionPost.status, 201, 'owner @mention post succeeds');
  equal(mentionPost.payload.message.channel, 'review');
  equal(mentionPost.payload.message.replyToSeq, ordinaryPost.payload.message.seq);
  equal(mentionPost.payload.message.isDoneSignal, true);
  equal(mentionPost.payload.wakeups.length, 1, 'mention creates 1 wakeup');
  equal(mentionPost.payload.wakeupsDelivery?.delivered, 1, 'deliverPendingSwarmWakeups delivers wakeup');
  equal(deliveries.length, 1, 'deliverSessionMessage called once');
  equal(deliveries[0].sessionId, w1Session.id);
  equal(deliveries[0].opts.queueIfBusy, false);
  equal(deliveries[0].opts.deferIfBusy, true);
  equal(deliveries[0].opts.internalOrganizationWakeup, true);

  // 2e. Query filtering (?channel, ?sinceSeq, ?limit) & invalid cursor
  const reviewOnly = await invoke('GET', `/api/sessions/${swarmRootSession.id}/organization/board?channel=review&sinceSeq=${ordinaryPost.payload.message.seq}&limit=10`, {
    listMembers: async () => ({ availability: 'none', gap: false, board: null, channels: [] }),
  });
  equal(reviewOnly.status, 200);
  equal(reviewOnly.payload.board.messages.length, 1);
  equal(reviewOnly.payload.board.messages[0].seq, mentionPost.payload.message.seq);

  equal((await invoke('GET', `/api/sessions/${swarmRootSession.id}/organization/board?sinceSeq=-5`)).status, 400, 'negative sinceSeq rejected');
  equal((await invoke('GET', `/api/sessions/${swarmRootSession.id}/organization/board?limit=500`)).status, 400, 'oversized limit rejected');

  // 2f. Archive #review & verify post rejection
  const archiveReview = await invoke('POST', `/api/sessions/${swarmRootSession.id}/organization/swarm/channels`, {
    body: { action: 'archive', name: 'review' },
  });
  equal(archiveReview.status, 200);
  const archivedPost = await invoke('POST', `/api/sessions/${swarmRootSession.id}/organization/board/messages`, {
    body: { channel: 'review', bodyMarkdown: 'too late' },
    swarmDeps: fakeDeps,
  });
  equal(archivedPost.status, 409);
  equal(archivedPost.payload.code, 'BOARD_CHANNEL_ARCHIVED');

  // 2g. GET /swarm/status checks 4-state counts, members, channels, budget
  const statusRes = await invoke('GET', `/api/sessions/${swarmRootSession.id}/organization/swarm/status`);
  equal(statusRes.status, 200);
  equal(statusRes.payload.mode, 'ragent_swarm');
  equal(statusRes.payload.headSeq, mentionPost.payload.message.seq);
  equal(statusRes.payload.isDone, false, '@mention-bearing owner [done] instruction keeps swarm active');
  ok(statusRes.payload.counts.working >= 2, 'coordinator + woken worker working');
  equal(statusRes.payload.budget.limits.maxTotalRuns, 8);
  const statusWorker = statusRes.payload.members.find((m) => m.nodeId === workerNode.nodeId);
  equal(statusWorker.swarmState, 'working', 'worker transitioned to working on wakeup');
  equal(statusWorker.workspaceBranch, workerNode.workspaceBranch);

  // 3. Kill endpoint: missing target, coordinator protection, unmerged workspace guard, forceDiscard
  equal((await invoke('POST', `/api/sessions/${swarmRootSession.id}/organization/swarm/kill`, { body: {} })).status, 400);

  const killCoord = await invoke('POST', `/api/sessions/${swarmRootSession.id}/organization/swarm/kill`, {
    body: { targetNodeId: ensured.coordinatorNode.id },
    swarmDeps: {},
  });
  equal(killCoord.status, 409);
  equal(killCoord.payload.code, 'SWARM_CANNOT_KILL_COORDINATOR');

  let removedWorktreeCalled = 0;
  let cancelledRunId = '';
  const killGuardDeps = {
    checkWorktreeDirty: async () => ({
      unmerged: true,
      reason: '1 dirty file on branch',
      dirtyFiles: ['chat/router-organization-routes.mjs'],
      unmergedCommits: 1,
    }),
    getRunState: async () => ({ running: true, runId: 'run-w1-active', activeRunId: 'run-w1-active' }),
    requestRunCancel: async (runId) => { cancelledRunId = runId; },
    removeWorktree: async () => { removedWorktreeCalled += 1; },
  };

  const blockedKill = await invoke('POST', `/api/sessions/${swarmRootSession.id}/organization/swarm/kill`, {
    body: { targetNodeId: workerNode.nodeId },
    swarmDeps: killGuardDeps,
  });
  equal(blockedKill.status, 409, 'kill blocks on unmerged worktree changes');
  equal(blockedKill.payload.code, 'SWARM_WORKSPACE_UNMERGED_CHANGES');
  equal(blockedKill.payload.workspaceBranch, workerNode.workspaceBranch);
  equal(blockedKill.payload.dirtyFiles[0], 'chat/router-organization-routes.mjs');
  equal(blockedKill.payload.unmergedCommits, 1);
  equal(removedWorktreeCalled, 0, 'worktree not removed when kill refused');

  const forcedKill = await invoke('POST', `/api/sessions/${swarmRootSession.id}/organization/swarm/kill`, {
    body: { targetNodeId: workerNode.nodeId, forceDiscard: true },
    swarmDeps: killGuardDeps,
  });
  equal(forcedKill.status, 200, 'forceDiscard=true kills member');
  equal(forcedKill.payload.killed, true);
  equal(forcedKill.payload.node.swarmState, 'killed');
  equal(cancelledRunId, 'run-w1-active', 'active run cancelled on kill');
  equal(removedWorktreeCalled, 1, 'worktree cleaned up on forced kill');

  const afterKillStatus = await invoke('GET', `/api/sessions/${swarmRootSession.id}/organization/swarm/status?includeKilled=true`);
  equal(afterKillStatus.status, 200);
  equal(afterKillStatus.payload.counts.killed, 1);
  equal(afterKillStatus.payload.members.find((m) => m.nodeId === workerNode.nodeId)?.swarmState, 'killed');

  const ownerDonePost = await invoke('POST', `/api/sessions/${swarmRootSession.id}/organization/board/messages`, {
    body: { channel: 'main', bodyMarkdown: '[done] Swarm route work verified complete.' },
    swarmDeps: fakeDeps,
  });
  equal(ownerDonePost.status, 201);
  const afterDoneStatus = await invoke('GET', `/api/sessions/${swarmRootSession.id}/organization/swarm/status`);
  equal(afterDoneStatus.status, 200);
  equal(afterDoneStatus.payload.isDone, true, 'unmentioned owner [done] closes swarm');

  // 4. Phase 3 routes: auth/method guards + controlled /swarm/model switch & busy check
  const p3AuthRoutes = [
    ['POST', `/api/sessions/${swarmRootSession.id}/organization/swarm/model`, { targetNodeId: ensured.coordinatorNode.id, model: 'claude-sonnet-4-6', harness: 'claude' }],
    ['POST', `/api/sessions/${swarmRootSession.id}/organization/swarm/promote-candidate`, { targetNodeId: workerNode.nodeId }],
    ['POST', `/api/sessions/${swarmRootSession.id}/organization/swarm/work-items/work-1/start`, {}],
    ['POST', `/api/sessions/${swarmRootSession.id}/organization/swarm/work-items/work-1/complete`, {}],
  ];
  for (const [method, url, body] of p3AuthRoutes) {
    equal((await invoke(method, url, { authSession: { role: 'agent' }, body })).status, 403);
    equal((await invoke(method, url, { authSession: { role: 'owner', principalKind: 'run_capability' }, body })).status, 403);
    equal((await invoke('GET', url)).status, 405);
  }

  // Spawn an unlocked waiting worker and switch its model via POST /swarm/model
  const switchableRes = await swarm.spawnSwarmMembers({
    organizationId: ensured.organization.id,
    actorNodeId: ensured.coordinatorNode.id,
    name: 'analyst-1',
    role: 'reviewer',
    brief: 'Initial review on codex',
    workspace: 'inherit',
    harness: 'codex',
    model: 'gpt-5.4',
    deferDelivery: true,
  });
  const analyst = switchableRes.members[0];
  const badModelReq = await invoke('POST', `/api/sessions/${swarmRootSession.id}/organization/swarm/model`, {
    body: { targetNodeId: analyst.nodeId },
    swarmDeps: {},
  });
  equal(badModelReq.status, 400, 'POST /swarm/model requires at least one target runtime field');

  const modelSwitchRes = await invoke('POST', `/api/sessions/${swarmRootSession.id}/organization/swarm/model`, {
    body: { targetNodeId: analyst.nodeId, harness: 'claude', model: 'claude-sonnet-4-6', effort: 'high', reason: 'route switch test' },
    swarmDeps: { skipRunLookup: true },
  });
  equal(modelSwitchRes.status, 200, `POST /swarm/model succeeds: ${JSON.stringify(modelSwitchRes.payload)}`);
  equal(modelSwitchRes.payload.bindingGeneration, 2);
  equal(modelSwitchRes.payload.member.harness, 'claude');
  equal(modelSwitchRes.payload.member.model, 'claude-sonnet-4-6');
  equal(modelSwitchRes.payload.member.modelHistory.length, 2);

  // Track 2B (#163/#164) regression: POST /work-items/:wiId/start using defaultSwarmRuntimeDeps() wires createSession (never synthetic swarm_sess_*)
  const factoryControl = await import('../chat/factory-control.mjs');
  const wiRouteRootSession = await sessionManager.createSession(join(tempHome, 'workspace'), 'codex', 'WI Route Root');
  const wiProjectId = wiRouteRootSession.projectId || 'proj-route-wi';
  const wiEnsured = await swarm.ensureSwarmOrganization({
    rootSessionId: wiRouteRootSession.id,
    projectId: wiProjectId,
    title: 'Route WI Swarm',
    policy: { projectRoot: join(tempHome, 'workspace') },
  });
  const ownerActor = { kind: 'user', role: 'owner', principalId: 'owner' };
  const routeGoal = await factoryControl.executeFactoryCommand({
    commandId: 'cmd_route_wi_goal_1',
    idempotencyKey: 'route_wi_goal_1',
    organizationId: wiEnsured.organization.id,
    targetId: wiEnsured.organization.id,
    type: 'CreateGoal',
    payload: { projectId: wiProjectId, objective: 'Verify defaultSwarmRuntimeDeps createSession' },
  }, ownerActor);
  const routeWi = await factoryControl.executeFactoryCommand({
    commandId: 'cmd_route_wi_1',
    idempotencyKey: 'route_wi_1',
    organizationId: wiEnsured.organization.id,
    targetId: wiEnsured.organization.id,
    type: 'CreateWorkItem',
    payload: {
      goalId: routeGoal.goal.id,
      kind: 'execution',
      assigneeNodeId: wiEnsured.coordinatorNode.id,
      contract: {
        objective: 'Start WorkItem child using defaultSwarmRuntimeDeps',
        targetBranch: 'main',
        allowedPaths: ['README.md'],
        acceptanceCriteria: [{ id: 'done_wi', title: 'Started', method: 'manual' }],
      },
    },
  }, ownerActor);
  await factoryControl.executeFactoryCommand({
    commandId: 'cmd_route_wi_approve_1',
    idempotencyKey: 'route_wi_approve_1',
    organizationId: wiEnsured.organization.id,
    targetId: routeWi.item.id,
    type: 'ApproveContract',
    expectedVersion: routeWi.item.rowVersion,
    payload: {},
  }, ownerActor);

  const defaultDepsStart = await invoke(
    'POST',
    `/api/sessions/${wiRouteRootSession.id}/organization/swarm/work-items/${routeWi.item.id}/start`,
    {
      body: {
        members: [{ name: 'wi-default-deps', role: 'worker', brief: 'Verify real session creation', workspace: 'inherit', harness: 'codex' }],
        deferDelivery: true,
      },
    },
  );
  equal(defaultDepsStart.status, 200, `POST /work-items/:id/start succeeds via defaultSwarmRuntimeDeps: ${JSON.stringify(defaultDepsStart.payload)}`);
  const startedWiMember = defaultDepsStart.payload.members[0];
  ok(startedWiMember?.currentSessionId && !startedWiMember.currentSessionId.startsWith('swarm_sess_'), 'defaultSwarmRuntimeDeps creates real session id instead of synthetic fallback');
  const persistedMeta = await sessionManager.getSessionMeta(startedWiMember.currentSessionId);
  ok(Boolean(persistedMeta && persistedMeta.id === startedWiMember.currentSessionId), 'Created child session exists in session-manager store');

  console.log(`test-organization-swarm-routes: ok (${assertions} assertions)`);
} finally {
  rmSync(tempHome, { recursive: true, force: true });
}
