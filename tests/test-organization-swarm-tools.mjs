#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tempHome = mkdtempSync(join(tmpdir(), 'ragent-org-swarm-tools-'));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.RAGENT_INSTANCE_ROOT = tempHome;
process.env.RAGENT_CONFIG_DIR = join(tempHome, 'config');
process.env.RAGENT_ORG_SCHEMA_ENABLED = '1';
process.env.RAGENT_ORG_PROJECTION_V2_ENABLED = '1';
process.env.RAGENT_ORG_STALL_GOVERNOR_ENABLED = '1';
mkdirSync(join(tempHome, 'workspace'), { recursive: true });
const workFolder = join(tempHome, 'workspace');

const store = await import('../chat/organization-store.mjs');
const boardStore = await import('../chat/organization-board-store.mjs');
const swarm = await import('../chat/organization-swarm.mjs');
const tools = await import('../chat/organization-control-tools.mjs');
const contextProj = await import('../chat/organization-context-projection.mjs');
const rolePrompts = await import('../chat/organization-role-prompts.mjs');

await store.initializeOrganizationStore();

let assertions = 0;
function equal(actual, expected, message) { assertions += 1; assert.equal(actual, expected, message); }
function ok(value, message) { assertions += 1; assert.ok(value, message); }
function rejectsWith(fn, predicate, message) { assertions += 1; return assert.rejects(fn, predicate, message); }

function rootAuth(sessionId, runId = 'run-root', turnId = 'turn-root') {
  return {
    role: 'runner',
    principalKind: 'run_capability',
    capabilityOperation: 'session.organization.tools',
    sessionId,
    runId,
    turnId,
  };
}

function nodeAuth({ sessionId, organizationId, nodeId, bindingGeneration = 1, organizationRevision = 0, runId = 'run-node', turnId = 'turn-node' }) {
  return {
    role: 'runner',
    principalKind: 'run_capability',
    capabilityOperation: 'organization.tools',
    sessionId,
    runId,
    turnId,
    organizationMessageScope: {
      kind: 'organization_message',
      organizationId,
      nodeId,
      bindingGeneration,
      organizationRevision,
    },
  };
}

// Track simulated sessions so executeOrganizationControlTool getSession() resolves root & non-root sessions cleanly.
const sessionsById = new Map([
  ['root-a', {
    id: 'root-a',
    sessionClass: 'ROOT_LEADERSHIP',
    sessionPlane: 'user',
    userAddressable: true,
    folder: workFolder,
    projectId: 'proj-a',
    collaborationPolicyOverrides: { maxConcurrent: 8 },
    runtimeConstraints: {
      model: { mode: 'locked', value: 'gpt-5.4', source: 'user', scope: 'organization', version: 1 },
    },
  }],
  ['root-b', {
    id: 'root-b',
    sessionClass: 'ROOT_LEADERSHIP',
    sessionPlane: 'user',
    userAddressable: true,
    folder: workFolder,
    projectId: 'proj-b',
  }],
  ['root-locked-nodeleg', {
    id: 'root-locked-nodeleg',
    sessionClass: 'ROOT_LEADERSHIP',
    sessionPlane: 'user',
    userAddressable: true,
    folder: workFolder,
    collaborationPolicyOverrides: { canDelegate: false, maxDepth: 0 },
  }],
  ['fake-root-subsession', {
    id: 'fake-root-subsession',
    sessionClass: 'ROOT_LEADERSHIP',
    sessionPlane: 'user',
    userAddressable: true,
    parentSessionId: 'root-a',
    folder: workFolder,
  }],
]);

const deliveredWakeups = [];
let dirtyWorktrees = new Set();
const sharedDeps = {
  getSession: async (id) => sessionsById.get(id) || null,
  getApp: async () => null,
  readSessionRuntimeConstraints: async (id) => {
    const s = sessionsById.get(id);
    return s?.runtimeConstraints ? { sessionId: id, revision: 1, constraints: s.runtimeConstraints } : null;
  },
  deliverSessionMessage: async (sessionId, digest, images, opts) => {
    deliveredWakeups.push({ sessionId, digest, opts });
    return { delivered: true };
  },
  checkWorktreeDirty: async ({ workspacePath }) => (
    dirtyWorktrees.has(workspacePath)
      ? { unmerged: true, dirtyFiles: ['src/uncommitted.js'], unmergedCommits: 1, reason: '1 dirty file and 1 unmerged commit' }
      : { unmerged: false }
  ),
  createWorktree: async ({ memberName }) => ({ worktreePath: join(workFolder, `wt-${memberName}`) }),
  removeWorktree: async ({ worktreePath }) => { dirtyWorktrees.delete(worktreePath); },
};

try {
  // 1. Auth guard on tools-root: sub-session / non-root rejected for swarm tools & skills check.
  await rejectsWith(
    () => tools.executeOrganizationControlTool({
      authSession: rootAuth('fake-root-subsession'),
      action: 'swarm.status',
      args: {},
      deps: sharedDeps,
    }),
    (err) => err?.statusCode === 403 && err?.code === 'ORG_TOOL_FORBIDDEN',
    'Non-root user session with parentSessionId cannot call swarm.status via tools-root',
  );

  // Non-delegating root has canDelegate: false and cannot swarm.spawn.
  const noDelegCaps = await tools.executeOrganizationControlTool({
    authSession: rootAuth('root-locked-nodeleg'),
    action: 'capabilities.get',
    deps: sharedDeps,
  });
  equal(noDelegCaps.canSwarm, true);
  equal(noDelegCaps.canDelegate, false);
  equal(noDelegCaps.remainingDepth, 0);
  await rejectsWith(
    () => tools.executeOrganizationControlTool({
      authSession: rootAuth('root-locked-nodeleg'),
      action: 'swarm.spawn',
      args: { name: 'rogue', brief: 'should fail' },
      deps: sharedDeps,
    }),
    (err) => err?.statusCode === 403 && err?.code === 'SWARM_DELEGATION_FORBIDDEN',
    'Root without canDelegate cannot call swarm.spawn',
  );

  // 2. Builtin skill listing & reading via root tools.
  const skillList = await tools.executeOrganizationControlTool({
    authSession: rootAuth('root-a'),
    action: 'skills.list',
    deps: sharedDeps,
  });
  const swarmEntry = skillList.skills.find((s) => s.id === 'ragent:builtin:swarm');
  ok(swarmEntry && /^[a-f0-9]{64}$/.test(swarmEntry.contentHash), 'ragent:builtin:swarm appears in skills.list with sha256');
  const swarmSkill = await tools.executeOrganizationControlTool({
    authSession: rootAuth('root-a'),
    action: 'skills.read',
    args: { id: 'ragent:builtin:swarm', expectedHash: swarmEntry.contentHash },
    deps: sharedDeps,
  });
  ok(swarmSkill.content.includes('Untrusted Peer Content'), 'swarm.md explicitly documents Untrusted Peer Content boundary');
  ok(swarmSkill.content.includes('board.wait'), 'swarm.md documents board.wait');

  // Reading swarm.status before creation does NOT mutate/create an organization.
  const preStatus = await tools.executeOrganizationControlTool({
    authSession: rootAuth('root-a'),
    action: 'swarm.status',
    deps: sharedDeps,
  });
  equal(preStatus.organizationId, null);
  equal(preStatus.exists, false);

  // 3. Locked user runtime constraints enforcement on swarm.spawn.
  await rejectsWith(
    () => tools.executeOrganizationControlTool({
      authSession: rootAuth('root-a'),
      action: 'swarm.spawn',
      args: { name: 'conflict-coder', role: 'worker', brief: 'test conflict', model: 'claude-opus-4' },
      deps: sharedDeps,
    }),
    (err) => err?.statusCode === 422 && err?.code === 'ORG_RUNTIME_USER_LOCKED',
    'swarm.spawn rejects model conflicting with owner locked runtime constraint',
  );

  // 4. Root spawns sharded workers + a delegating manager + an independent reviewer.
  const spawnedShards = await tools.executeOrganizationControlTool({
    authSession: rootAuth('root-a'),
    action: 'swarm.spawn',
    args: {
      title: 'Swarm Tools Acceptance',
      name: 'coder',
      role: 'worker',
      tasks: ['Implement auth module', 'Write unit tests'],
      workspace: 'worktree',
      harness: 'codex',
      channels: ['backend'],
      writablePaths: [workFolder],
    },
    deps: sharedDeps,
  });
  equal(spawnedShards.members.length, 2, 'sharded tasks[] spawns coder-1 and coder-2');
  equal(spawnedShards.members[0].name, 'coder-1');
  equal(spawnedShards.members[0].model, 'gpt-5.4', 'locked user model constraint is applied automatically');
  equal(spawnedShards.members[0].workspaceMode, 'worktree');
  ok(deliveredWakeups.length >= 2, 'spawn brief @mentions deliver wakeups');

  const orgAId = spawnedShards.organizationId;
  const coder1 = spawnedShards.members[0];
  const coder2 = spawnedShards.members[1];
  dirtyWorktrees.add(coder2.workspacePath);

  const spawnedLead = await tools.executeOrganizationControlTool({
    authSession: rootAuth('root-a'),
    action: 'swarm.spawn',
    args: {
      name: 'sub-lead',
      role: 'manager',
      brief: 'Manage QA slice',
      workspace: 'inherit',
      harness: 'agy',
    },
    deps: sharedDeps,
  });
  const subLead = spawnedLead.members[0];
  const spawnedVerifier = await tools.executeOrganizationControlTool({
    authSession: rootAuth('root-a'),
    action: 'swarm.spawn',
    args: {
      name: 'verifier',
      role: 'reviewer',
      brief: 'Verify changes read-only',
      workspace: 'inherit',
      harness: 'claude',
      forkFrom: { nodeId: 'coder-1', sinceSeq: 0 },
    },
    deps: sharedDeps,
  });
  const verifier = spawnedVerifier.members[0];
  equal(verifier.contractRole, 'reviewer');
  equal(verifier.canWrite, false);

  // Also bootstrap orgB separately to verify cross-org isolation.
  const orgBSwarm = await swarm.ensureSwarmOrganization({ rootSessionId: 'root-b', title: 'Other Org B' });
  const orgBSpawn = await swarm.spawnSwarmMembers(sharedDeps, {
    organizationId: orgBSwarm.organization.id,
    actorNodeId: orgBSwarm.coordinatorNode.id,
    name: 'secret-worker-b',
    brief: 'org B confidential task',
    workspace: 'inherit',
  });
  const workerB = orgBSpawn.members[0];
  await boardStore.postBoardMessage({
    organizationId: orgBSwarm.organization.id,
    senderKind: 'node',
    senderNodeId: orgBSwarm.coordinatorNode.id,
    bodyMarkdown: 'Top secret orgB message',
  });

  // 5. Same-org isolation tests (both Root A & Coder-1 A trying to access Org B).
  for (const act of ['swarm.status', 'swarm.channel.list', 'board.read']) {
    await rejectsWith(
      () => tools.executeOrganizationControlTool({
        authSession: nodeAuth({ sessionId: coder1.currentSessionId, organizationId: orgAId, nodeId: coder1.id }),
        action: act,
        args: { organizationId: orgBSwarm.organization.id },
        deps: sharedDeps,
      }),
      (err) => err?.statusCode === 403 && err?.code === 'ORG_TOOL_FORBIDDEN',
      `Node in orgA cannot read orgB via ${act}`,
    );
  }
  await rejectsWith(
    () => tools.executeOrganizationControlTool({
      authSession: nodeAuth({ sessionId: coder1.currentSessionId, organizationId: orgAId, nodeId: coder1.id }),
      action: 'board.post',
      args: { organizationId: orgBSwarm.organization.id, body: 'cross-org hijack' },
      deps: sharedDeps,
    }),
    (err) => err?.statusCode === 403 && err?.code === 'ORG_TOOL_FORBIDDEN',
    'Node in orgA cannot post into orgB board',
  );
  await rejectsWith(
    () => tools.executeOrganizationControlTool({
      authSession: rootAuth('root-a'),
      action: 'swarm.spawn',
      args: { name: 'fork-theft', brief: 'steal', forkFrom: { nodeId: workerB.id, sinceSeq: 0 } },
      deps: sharedDeps,
    }),
    (err) => err?.statusCode === 404 && err?.code === 'SWARM_FORK_SOURCE_NOT_FOUND',
    'Root A cannot fork from orgB node',
  );
  await rejectsWith(
    () => tools.executeOrganizationControlTool({
      authSession: rootAuth('root-a'),
      action: 'swarm.kill',
      args: { targetNameOrNodeId: workerB.id },
      deps: sharedDeps,
    }),
    (err) => err?.statusCode === 404 && err?.code === 'ORGANIZATION_NODE_NOT_FOUND',
    'Root A cannot kill orgB node',
  );

  // 6. Node role authorization & delegation bounds.
  const coderSkillList = await tools.executeOrganizationControlTool({
    authSession: nodeAuth({ sessionId: coder1.currentSessionId, organizationId: orgAId, nodeId: coder1.id }),
    action: 'skills.list',
    deps: sharedDeps,
  });
  ok(coderSkillList.skills.some((s) => s.id === 'ragent:builtin:swarm'), 'node scope can list ragent:builtin:swarm');
  ok(coderSkillList.skills.some((s) => s.id === 'ragent:builtin:worker'), 'worker node can read worker skill');

  // Worker cannot spawn, kill another, done, or switch model.
  await rejectsWith(
    () => tools.executeOrganizationControlTool({
      authSession: nodeAuth({ sessionId: coder1.currentSessionId, organizationId: orgAId, nodeId: coder1.id }),
      action: 'swarm.spawn',
      args: { name: 'illegal-child', brief: 'nope' },
      deps: sharedDeps,
    }),
    (err) => err?.statusCode === 403 && err?.code === 'SWARM_DELEGATION_FORBIDDEN',
    'Worker cannot swarm.spawn',
  );
  await rejectsWith(
    () => tools.executeOrganizationControlTool({
      authSession: nodeAuth({ sessionId: coder1.currentSessionId, organizationId: orgAId, nodeId: coder1.id }),
      action: 'swarm.kill',
      args: { targetNameOrNodeId: coder2.id },
      deps: sharedDeps,
    }),
    (err) => err?.statusCode === 403 && err?.code === 'SWARM_KILL_FORBIDDEN',
    'Worker cannot kill peer',
  );
  await rejectsWith(
    () => tools.executeOrganizationControlTool({
      authSession: nodeAuth({ sessionId: subLead.currentSessionId, organizationId: orgAId, nodeId: subLead.id }),
      action: 'swarm.done',
      args: { summary: 'premature close' },
      deps: sharedDeps,
    }),
    (err) => err?.statusCode === 403 && err?.code === 'SWARM_DONE_FORBIDDEN',
    'Non-coordinator Manager cannot call swarm.done',
  );

  // Depth-2 sub-lead has depth=1, maxDepth=0? Wait: root default maxDepth is 1, so subLead depth=1 has maxDepth=0 -> remainingDepth=0!
  // Spawn a root with maxDepth=3 to test Manager -> sub-child delegation & remainingDepth exhaustion cleanly.
  const deepRootId = 'root-deep';
  sessionsById.set(deepRootId, {
    id: deepRootId,
    sessionClass: 'ROOT_LEADERSHIP',
    sessionPlane: 'user',
    userAddressable: true,
    folder: workFolder,
    collaborationPolicy: { role: 'manager', canDelegate: true, maxDepth: 3, maxChildren: 8, maxConcurrent: 8 },
  });
  const deepMgrRes = await tools.executeOrganizationControlTool({
    authSession: rootAuth(deepRootId),
    action: 'swarm.spawn',
    args: { name: 'mgr-1', role: 'manager', brief: 'coordinate layer 2', workspace: 'inherit' },
    deps: sharedDeps,
  });
  const mgr1 = deepMgrRes.members[0];
  const mgrCaps = await tools.executeOrganizationControlTool({
    authSession: nodeAuth({ sessionId: mgr1.currentSessionId, organizationId: deepMgrRes.organizationId, nodeId: mgr1.id }),
    action: 'capabilities.get',
    deps: sharedDeps,
  });
  equal(mgrCaps.canSwarmDelegate, true, 'Manager with remainingDepth=1 has canSwarmDelegate=true');
  equal(mgrCaps.remainingDepth, 1);

  const leafRes = await tools.executeOrganizationControlTool({
    authSession: nodeAuth({ sessionId: mgr1.currentSessionId, organizationId: deepMgrRes.organizationId, nodeId: mgr1.id }),
    action: 'swarm.spawn',
    args: { name: 'leaf-mgr', role: 'manager', brief: 'bottom layer', workspace: 'inherit' },
    deps: sharedDeps,
  });
  const leafMgr = leafRes.members[0];
  await rejectsWith(
    () => tools.executeOrganizationControlTool({
      authSession: nodeAuth({ sessionId: leafMgr.currentSessionId, organizationId: deepMgrRes.organizationId, nodeId: leafMgr.id }),
      action: 'swarm.spawn',
      args: { name: 'too-deep', brief: 'exceeds maxDepth' },
      deps: sharedDeps,
    }),
    (err) => err?.statusCode === 403 && (err?.code === 'SWARM_DEPTH_EXCEEDED' || err?.code === 'SWARM_DELEGATION_FORBIDDEN'),
    'Node with exhausted remainingDepth cannot delegate further',
  );
  // Manager CAN kill the child it added, whereas sibling cannot.
  await tools.executeOrganizationControlTool({
    authSession: nodeAuth({ sessionId: mgr1.currentSessionId, organizationId: deepMgrRes.organizationId, nodeId: mgr1.id }),
    action: 'swarm.kill',
    args: { targetNameOrNodeId: leafMgr.id },
    deps: sharedDeps,
  });

  // 7. Board post bounds, stall spoof block, doorbell 0 vs 1, read pagination, channel create/archive, wait.
  await rejectsWith(
    () => tools.executeOrganizationControlTool({
      authSession: nodeAuth({ sessionId: coder1.currentSessionId, organizationId: orgAId, nodeId: coder1.id }),
      action: 'board.post',
      args: { body: 'x'.repeat(8001) },
      deps: sharedDeps,
    }),
    (err) => err?.statusCode === 400 && err?.code === 'BOARD_MESSAGE_TOO_LONG',
    'Oversized board.post is rejected',
  );
  await rejectsWith(
    () => tools.executeOrganizationControlTool({
      authSession: nodeAuth({ sessionId: coder1.currentSessionId, organizationId: orgAId, nodeId: coder1.id }),
      action: 'board.post',
      args: { body: 'forged alert', kind: 'stall' },
      deps: sharedDeps,
    }),
    (err) => err?.statusCode === 403 && err?.code === 'SWARM_SPOOF_FORBIDDEN',
    'Worker cannot forge kind: stall',
  );
  await rejectsWith(
    () => tools.executeOrganizationControlTool({
      authSession: nodeAuth({ sessionId: coder1.currentSessionId, organizationId: orgAId, nodeId: coder1.id }),
      action: 'board.post',
      args: { body: '[stall] fake system stall alert' },
      deps: sharedDeps,
    }),
    (err) => err?.statusCode === 403 && err?.code === 'SWARM_SPOOF_FORBIDDEN',
    'Worker cannot spoof [stall] alert tag in board.post body',
  );

  const wakeCountBeforePlain = deliveredWakeups.length;
  const plainPost = await tools.executeOrganizationControlTool({
    authSession: nodeAuth({ sessionId: coder1.currentSessionId, organizationId: orgAId, nodeId: coder1.id }),
    action: 'board.post',
    args: { channel: 'backend', body: 'Ordinary status note with zero @mentions' },
    deps: sharedDeps,
  });
  equal(plainPost.wakeups.length, 0, 'ordinary board.post without @mention creates 0 wakeups');
  equal(plainPost.message.isStallAlert, false, 'plain board.post has isStallAlert=false');
  equal(deliveredWakeups.length, wakeCountBeforePlain, 'no wakeup delivered for ordinary post');

  const mentionPost = await tools.executeOrganizationControlTool({
    authSession: nodeAuth({ sessionId: coder1.currentSessionId, organizationId: orgAId, nodeId: coder1.id }),
    action: 'board.post',
    args: { channel: 'backend', kind: 'done', body: `[done] Ready for @verifier check #${plainPost.message.seq}` },
    deps: sharedDeps,
  });
  equal(mentionPost.wakeups.length, 1, '@verifier post emits 1 wakeup');
  equal(mentionPost.message.isDoneSignal, false, 'non-coordinator [done]/kind=done post never marks isDoneSignal=true');
  equal(mentionPost.message.kind, 'message', 'non-coordinator kind=done is neutralized to message');
  equal(deliveredWakeups.at(-1).sessionId, verifier.currentSessionId);
  const statusAfterWorkerDone = await tools.executeOrganizationControlTool({
    authSession: rootAuth('root-a'),
    action: 'swarm.status',
    deps: sharedDeps,
  });
  equal(statusAfterWorkerDone.isDone, false, 'worker [done] post does not mark Swarm as done');

  // Phase 2 disallows 'private' channel visibility cleanly (org-only).
  await rejectsWith(
    () => tools.executeOrganizationControlTool({
      authSession: nodeAuth({ sessionId: verifier.currentSessionId, organizationId: orgAId, nodeId: verifier.id }),
      action: 'swarm.channel.create',
      args: { name: 'secret-room', visibility: 'private' },
      deps: sharedDeps,
    }),
    (err) => err?.statusCode === 400 && err?.code === 'BOARD_CHANNEL_VISIBILITY_UNSUPPORTED',
    'swarm.channel.create rejects unsupported visibility: private in Phase 2',
  );

  // Verifier creates a channel; coder1 cannot archive verifier's channel; main cannot be archived.
  await tools.executeOrganizationControlTool({
    authSession: nodeAuth({ sessionId: verifier.currentSessionId, organizationId: orgAId, nodeId: verifier.id }),
    action: 'swarm.channel.create',
    args: { name: 'qa-evidence', topic: 'Verification logs' },
    deps: sharedDeps,
  });
  await rejectsWith(
    () => tools.executeOrganizationControlTool({
      authSession: nodeAuth({ sessionId: coder1.currentSessionId, organizationId: orgAId, nodeId: coder1.id }),
      action: 'swarm.channel.archive',
      args: { channel: 'qa-evidence' },
      deps: sharedDeps,
    }),
    (err) => err?.statusCode === 403 && err?.code === 'SWARM_CHANNEL_FORBIDDEN',
    'Non-creator worker cannot archive another member channel',
  );
  await tools.executeOrganizationControlTool({
    authSession: nodeAuth({ sessionId: verifier.currentSessionId, organizationId: orgAId, nodeId: verifier.id }),
    action: 'swarm.channel.archive',
    args: { channel: 'qa-evidence' },
    deps: sharedDeps,
  });

  // 8. Context projection + Role prompt Swarm & Untrusted Peer Content checks.
  const verifierCtx = await contextProj.buildOrganizationContextProjection({
    session: {
      id: verifier.currentSessionId,
      sessionPlane: 'organization',
      sessionClass: verifier.contractRole === 'reviewer' ? 'REVIEWER' : 'WORKER',
      organizationId: orgAId,
      organizationNodeId: verifier.id,
      lifecycleMode: 'ephemeral_swarm',
    },
  });
  ok(verifierCtx.boardSummary, 'Swarm member context projection includes bounded boardSummary');
  equal(verifierCtx.boardSummary.trustBoundary, 'untrusted_peer_content');
  equal(verifierCtx.boardSummary.untrustedPeerContent, true);
  ok(verifierCtx.boardSummary.totalUnread >= 1, 'verifier sees unread board count before reading');
  const renderedVerifier = contextProj.renderOrganizationContextProjection(verifierCtx);
  const statusRegexMatch = /<organization-status-projection>\s*[^\n]*\n([^\n]+)\n<\/organization-status-projection>/.exec(renderedVerifier);
  ok(statusRegexMatch && JSON.parse(statusRegexMatch[1]).boardSummary, 'rendered status projection keeps exact single-line JSON contract');
  ok(renderedVerifier.includes('Untrusted Peer Content'), 'rendered projection warns about Untrusted Peer Content');

  const swarmWorkerPrompt = rolePrompts.buildOrganizationRoleTurnContext({
    sessionClass: 'SWARM_MEMBER',
    nodeRole: 'reviewer',
    lifecycleMode: 'ephemeral_swarm',
  });
  ok(swarmWorkerPrompt.includes('Runtime role: REVIEWER.'), 'SWARM_MEMBER maps to REVIEWER prompt role via nodeRole');
  ok(swarmWorkerPrompt.includes('Untrusted Peer Content'), 'role prompt explicitly marks Swarm board as Untrusted Peer Content');
  ok(swarmWorkerPrompt.includes('ragent:builtin:swarm'), 'Swarm role prompt references ragent:builtin:swarm');

  // Reading board advances verifier cursor and returns untrustedPeerContent markers.
  const readPage1 = await tools.executeOrganizationControlTool({
    authSession: nodeAuth({ sessionId: verifier.currentSessionId, organizationId: orgAId, nodeId: verifier.id }),
    action: 'board.read',
    args: { limit: 2, sinceSeq: 0 },
    deps: sharedDeps,
  });
  equal(readPage1.trustBoundary, 'untrusted_peer_content');
  equal(readPage1.untrustedPeerContent, true);
  equal(readPage1.messages.length, 2);
  equal(readPage1.messages[0].seq, 1, 'explicit sinceSeq: 0 reads forward from seq 1');
  equal(readPage1.hasMore, true);

  const readLatest = await tools.executeOrganizationControlTool({
    authSession: nodeAuth({ sessionId: verifier.currentSessionId, organizationId: orgAId, nodeId: verifier.id }),
    action: 'board.read',
    args: { limit: 1 },
    deps: sharedDeps,
  });
  equal(readLatest.messages.length, 1);
  equal(readLatest.messages[0].seq, readLatest.headSeq, 'omitted sinceSeq fetches latest message');

  // Verifier calls board.wait -> transitions cleanly to waiting.
  const waitRes = await tools.executeOrganizationControlTool({
    authSession: nodeAuth({ sessionId: verifier.currentSessionId, organizationId: orgAId, nodeId: verifier.id }),
    action: 'board.wait',
    args: { reason: 'awaiting @verifier check' },
    deps: sharedDeps,
  });
  equal(waitRes.swarmState, 'waiting');

  // 9. Dirty worktree kill refusal + forceDiscard + killed node tool denial + Phase 3 swarm.model boundary.
  await rejectsWith(
    () => tools.executeOrganizationControlTool({
      authSession: rootAuth('root-a'),
      action: 'swarm.kill',
      args: { targetNameOrNodeId: 'coder-2' },
      deps: sharedDeps,
    }),
    (err) => err?.statusCode === 409 && err?.code === swarm.SWARM_WORKSPACE_UNMERGED_CHANGES,
    'swarm.kill preserves SWARM_WORKSPACE_UNMERGED_CHANGES when worktree is dirty',
  );
  const killedCoder2 = await tools.executeOrganizationControlTool({
    authSession: rootAuth('root-a'),
    action: 'swarm.kill',
    args: { targetNameOrNodeId: 'coder-2', forceDiscard: true },
    deps: sharedDeps,
  });
  equal(killedCoder2.killed, true);
  await rejectsWith(
    () => tools.executeOrganizationControlTool({
      authSession: nodeAuth({ sessionId: coder2.currentSessionId, organizationId: orgAId, nodeId: coder2.id }),
      action: 'swarm.status',
      deps: sharedDeps,
    }),
    (err) => err?.statusCode === 403 && err?.code === 'ORG_TOOL_FORBIDDEN',
    'Killed node can no longer execute organization.tools',
  );

  // Phase 3 swarm.model boundary check: Worker rejected 403, Coordinator hits clean 409 owner-lock guard when trying to mutate locked model.
  await rejectsWith(
    () => tools.executeOrganizationControlTool({
      authSession: nodeAuth({ sessionId: coder1.currentSessionId, organizationId: orgAId, nodeId: coder1.id }),
      action: 'swarm.model',
      args: { targetNameOrNodeId: 'verifier', model: 'gpt-5.4' },
      deps: sharedDeps,
    }),
    (err) => err?.statusCode === 403 && err?.code === 'SWARM_MODEL_FORBIDDEN',
    'Worker cannot call swarm.model',
  );
  await rejectsWith(
    () => tools.executeOrganizationControlTool({
      authSession: rootAuth('root-a'),
      action: 'swarm.model',
      args: { targetNameOrNodeId: 'coder-1', model: 'other-model' },
      deps: sharedDeps,
    }),
    (err) => err?.statusCode === 409 && err?.code === 'SWARM_MODEL_LOCKED_BY_OWNER',
    'swarm.model fails closed with 409 SWARM_MODEL_LOCKED_BY_OWNER without mutating locked config',
  );

  // Coordinator completes Swarm via swarm.done.
  const doneRes = await tools.executeOrganizationControlTool({
    authSession: rootAuth('root-a'),
    action: 'swarm.done',
    args: { summary: 'All checks verified.' },
    deps: sharedDeps,
  });
  equal(doneRes.isDone, true);

  // 10. Real MCP stdio server (scripts/ragent-organization-mcp.mjs) over HTTP mock backed by executeOrganizationControlTool!
  const mockAuthSessions = new Map([
    ['tok-root', rootAuth('root-a')],
    ['tok-worker', nodeAuth({ sessionId: coder1.currentSessionId, organizationId: orgAId, nodeId: coder1.id })],
  ]);
  const server = createServer(async (req, res) => {
    const match = /^\/api\/sessions\/([^/]+)\/organization\/(tools|tools-root)$/.exec(req.url || '');
    const scToken = String(req.headers['x-ragent-session-control-token'] || '');
    const scSession = String(req.headers['x-ragent-session-control-session-id'] || '');
    const authSession = mockAuthSessions.get(scToken);
    if (!match || !authSession || authSession.sessionId !== decodeURIComponent(match[1]) || scSession !== authSession.sessionId) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden' }));
      return;
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    try {
      const out = await tools.executeOrganizationControlTool({
        authSession,
        action: body.action,
        args: body.args || {},
        deps: sharedDeps,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    } catch (err) {
      res.writeHead(err?.statusCode || 400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: err?.message || 'failed', code: err?.code }));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  async function spawnMcpClient({ scope, sessionId, token }) {
    const child = spawn(process.execPath, [join(repoRoot, 'scripts', 'ragent-organization-mcp.mjs')], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        RAGENT_CHAT_BASE_URL: baseUrl,
        RAGENT_ORGANIZATION_TOOL_SCOPE: scope,
        RAGENT_SESSION_CONTROL_SESSION_ID: sessionId,
        RAGENT_SESSION_CONTROL_TOKEN: token,
        RAGENT_SESSION_CONTROL_RUN_ID: 'run-mcp',
        RAGENT_SESSION_CONTROL_TURN_ID: 'turn-mcp',
      },
    });
    const rl = createInterface({ input: child.stdout });
    const pending = new Map();
    rl.on('line', (line) => {
      const msg = JSON.parse(line);
      const waiter = pending.get(msg.id);
      if (waiter) {
        pending.delete(msg.id);
        waiter(msg);
      }
    });
    const call = (id, method, params) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`MCP timeout for ${method}`)), 5000);
      pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
    const notify = (method, params) => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    };
    const close = async () => {
      child.stdin.end();
      await new Promise((resolve) => child.once('exit', resolve));
    };
    return { call, notify, close };
  }

  try {
    const rootMcp = await spawnMcpClient({ scope: 'root', sessionId: 'root-a', token: 'tok-root' });
    rootMcp.notify('notifications/initialized', {});
    const discover = await rootMcp.call(1, 'server/discover');
    assert.deepEqual(discover.result, {}, 'server/discover returns empty object immediately');
    assertions += 1;

    const rootList = await rootMcp.call(2, 'tools/list');
    const rootReadActions = rootList.result.tools.find((t) => t.name === 'ragent_organization_read').inputSchema.properties.action.enum;
    const rootWriteTool = rootList.result.tools.find((t) => t.name === 'ragent_organization_action');
    const rootWriteActions = rootWriteTool.inputSchema.properties.action.enum;
    assert.deepEqual(rootWriteTool.inputSchema.properties.args.properties.visibility.enum, ['org'], 'MCP visibility schema restricts to org-only in Phase 2');
    assertions += 1;
    ok(rootReadActions.includes('swarm.status') && rootReadActions.includes('board.read') && rootReadActions.includes('swarm.channel.list'));
    ok(rootReadActions.includes('capabilities.get'), 'root tools/list exposes capabilities.get');
    ok(rootWriteActions.includes('swarm.spawn') && rootWriteActions.includes('swarm.kill') && rootWriteActions.includes('swarm.done') && rootWriteActions.includes('board.post'));
    ok(rootWriteActions.includes('swarm.model') && rootWriteActions.includes('swarm.promote_candidate') && rootWriteActions.includes('swarm.complete_work_item'), 'Phase 3 tools/list exposes swarm.model and bridge actions for Coordinator');

    const rootCapsCall = await rootMcp.call(20, 'tools/call', {
      name: 'ragent_organization_read',
      arguments: { action: 'capabilities.get' },
    });
    equal(Boolean(rootCapsCall.result?.isError), false, 'MCP capabilities.get succeeds on root scope without -32601');
    equal(JSON.parse(rootCapsCall.result.content[0].text).root, true, 'root capabilities.get returns capability payload');

    const mcpStatusCall = await rootMcp.call(3, 'tools/call', {
      name: 'ragent_organization_read',
      arguments: { action: 'swarm.status', args: { includeKilled: true } },
    });
    const parsedMcpStatus = JSON.parse(mcpStatusCall.result.content[0].text);
    equal(parsedMcpStatus.organizationId, orgAId, `unexpected MCP status response: ${mcpStatusCall.result.content[0].text}`);
    equal(parsedMcpStatus.isDone, true);

    const mcpModelCall = await rootMcp.call(4, 'tools/call', {
      name: 'ragent_organization_action',
      arguments: { action: 'swarm.model', args: { targetNameOrNodeId: 'coder-1', model: 'gpt-x' } },
    });
    equal(mcpModelCall.result.isError, true, 'MCP swarm.model fails closed on locked owner constraint');
    ok(mcpModelCall.result.content[0].text.includes('SWARM_MODEL_LOCKED_BY_OWNER'));
    await rootMcp.close();

    const workerMcp = await spawnMcpClient({ scope: 'node', sessionId: coder1.currentSessionId, token: 'tok-worker' });
    const workerList = await workerMcp.call(1, 'tools/list');
    const workerReadActions = workerList.result.tools.find((t) => t.name === 'ragent_organization_read').inputSchema.properties.action.enum;
    const workerWriteActions = workerList.result.tools.find((t) => t.name === 'ragent_organization_action').inputSchema.properties.action.enum;
    ok(workerReadActions.includes('board.read') && workerReadActions.includes('swarm.status'));
    ok(workerReadActions.includes('capabilities.get'), 'worker tools/list exposes capabilities.get');
    ok(workerWriteActions.includes('board.post') && workerWriteActions.includes('board.wait'));

    const workerCapsCall = await workerMcp.call(20, 'tools/call', {
      name: 'ragent_organization_read',
      arguments: { action: 'capabilities.get' },
    });
    equal(Boolean(workerCapsCall.result?.isError), false, 'MCP capabilities.get succeeds on node scope without -32601');
    const workerCapsJson = JSON.parse(workerCapsCall.result.content[0].text);
    equal(workerCapsJson.canSwarm, true, 'worker capabilities.get returns node capability payload');
    equal(workerCapsJson.isCoordinator, false, 'worker capabilities.get keeps isCoordinator=false');
    ok(!workerWriteActions.includes('swarm.spawn') && !workerWriteActions.includes('swarm.kill') && !workerWriteActions.includes('swarm.done') && !workerWriteActions.includes('swarm.model') && !workerWriteActions.includes('swarm.promote_candidate'));

    const workerPost = await workerMcp.call(2, 'tools/call', {
      name: 'ragent_organization_action',
      arguments: { action: 'board.post', args: { channel: 'main', body: 'MCP post from coder-1' } },
    });
    equal(Boolean(workerPost.result.isError), false);
    const postedJson = JSON.parse(workerPost.result.content[0].text);
    equal(postedJson.trustBoundary, 'untrusted_peer_content');

    const workerWait = await workerMcp.call(3, 'tools/call', {
      name: 'ragent_organization_action',
      arguments: { action: 'board.wait' },
    });
    equal(Boolean(workerWait.result.isError), false);
    equal(JSON.parse(workerWait.result.content[0].text).swarmState, 'waiting');
    await workerMcp.close();

    // Regression: formal_org depth-0 worker/manager edge cases & sharded node:<name>-1..k constraint scopes.
    const formalOrg = await store.createOrganization({
      id: 'org-formal-depth0',
      rootSessionId: 'root-formal-depth0',
      state: 'active',
      currentRevision: 1,
      policy: { swarmEnabled: true },
      idempotencyKey: 'org-formal-depth0',
    });
    const depth0Worker = await store.createNode({
      id: 'node-formal-depth0-worker',
      organizationId: formalOrg.id,
      stableKey: 'top-worker',
      nodeRole: 'worker',
      createdRevision: 1,
      lifecycleState: 'active',
      grant: { canDelegate: false, canWrite: true, maxDepth: 0 },
      currentSessionId: 'sess-formal-depth0-worker',
      bindingGeneration: 1,
      depth: 0,
      sessionClass: 'WORKER',
    });
    const depth0Peer = await store.createNode({
      id: 'node-formal-depth0-peer',
      organizationId: formalOrg.id,
      stableKey: 'top-peer',
      nodeRole: 'worker',
      createdRevision: 1,
      lifecycleState: 'active',
      grant: { canDelegate: false, canWrite: true, maxDepth: 0 },
      currentSessionId: 'sess-formal-depth0-peer',
      bindingGeneration: 1,
      depth: 0,
      sessionClass: 'WORKER',
    });
    const exhaustedFormalMgr = await store.createNode({
      id: 'node-formal-mgr-exhausted',
      organizationId: formalOrg.id,
      stableKey: 'top-mgr-exhausted',
      nodeRole: 'manager',
      createdRevision: 1,
      lifecycleState: 'active',
      grant: { canDelegate: true, canWrite: true, maxDepth: 1 },
      currentSessionId: 'sess-formal-mgr-exhausted',
      bindingGeneration: 1,
      depth: 1,
      sessionClass: 'MANAGER',
    });
    const creatorChannel = await boardStore.createBoardChannel({
      organizationId: formalOrg.id,
      name: 'peer-chan',
      createdByNodeId: depth0Peer.id,
    });
    equal(creatorChannel.name, 'peer-chan');

    const depth0WorkerCaps = await tools.executeOrganizationControlTool({
      authSession: nodeAuth({
        sessionId: depth0Worker.currentSessionId,
        organizationId: formalOrg.id,
        nodeId: depth0Worker.id,
        organizationRevision: 1,
      }),
      action: 'capabilities.get',
      deps: sharedDeps,
    });
    equal(depth0WorkerCaps.isCoordinator, false, 'formal_org depth-0 worker must never receive isCoordinator=true');

    await rejectsWith(
      () => tools.executeOrganizationControlTool({
        authSession: nodeAuth({
          sessionId: depth0Worker.currentSessionId,
          organizationId: formalOrg.id,
          nodeId: depth0Worker.id,
          organizationRevision: 1,
        }),
        action: 'swarm.done',
        args: { summary: 'hijack done' },
        deps: sharedDeps,
      }),
      (err) => err?.statusCode === 403 && err?.code === 'SWARM_DONE_FORBIDDEN',
      'formal_org depth-0 worker denied swarm.done',
    );
    await rejectsWith(
      () => tools.executeOrganizationControlTool({
        authSession: nodeAuth({
          sessionId: depth0Worker.currentSessionId,
          organizationId: formalOrg.id,
          nodeId: depth0Worker.id,
          organizationRevision: 1,
        }),
        action: 'swarm.kill',
        args: { targetNameOrNodeId: depth0Peer.id },
        deps: sharedDeps,
      }),
      (err) => err?.statusCode === 403 && err?.code === 'SWARM_KILL_FORBIDDEN',
      'formal_org depth-0 worker denied swarm.kill on peer',
    );
    await rejectsWith(
      () => tools.executeOrganizationControlTool({
        authSession: nodeAuth({
          sessionId: depth0Worker.currentSessionId,
          organizationId: formalOrg.id,
          nodeId: depth0Worker.id,
          organizationRevision: 1,
        }),
        action: 'swarm.channel.archive',
        args: { channel: 'peer-chan' },
        deps: sharedDeps,
      }),
      (err) => err?.statusCode === 403 && err?.code === 'SWARM_CHANNEL_FORBIDDEN',
      'formal_org depth-0 worker denied archiving peer channel',
    );
    const depth0WorkerPost = await tools.executeOrganizationControlTool({
      authSession: nodeAuth({
        sessionId: depth0Worker.currentSessionId,
        organizationId: formalOrg.id,
        nodeId: depth0Worker.id,
        organizationRevision: 1,
      }),
      action: 'board.post',
      args: { channel: 'main', kind: 'done', body: '[done] depth-0 worker report' },
      deps: sharedDeps,
    });
    equal(depth0WorkerPost.message.isDoneSignal, false, 'depth-0 non-coordinator board.post cannot mark isDoneSignal');
    const formalStatus = await boardStore.buildAuthoritativeBoardProjection({ organizationId: formalOrg.id });
    equal(formalStatus.isDone, false, 'formal_org remains active after depth-0 worker [done] post');

    // Regression: MCP tools/list hides swarm.spawn when remainingDepth === 0 on formal_org MANAGER (canDelegate: true, canSwarmDelegate: false) and when root has canDelegate: false.
    mockAuthSessions.set('tok-exhausted-mgr', nodeAuth({
      sessionId: exhaustedFormalMgr.currentSessionId,
      organizationId: formalOrg.id,
      nodeId: exhaustedFormalMgr.id,
      organizationRevision: 1,
    }));
    const mgrExhaustedMcp = await spawnMcpClient({
      scope: 'node',
      sessionId: exhaustedFormalMgr.currentSessionId,
      token: 'tok-exhausted-mgr',
    });
    const mgrExhaustedList = await mgrExhaustedMcp.call(1, 'tools/list');
    const mgrExhaustedWrites = mgrExhaustedList.result.tools.find((t) => t.name === 'ragent_organization_action').inputSchema.properties.action.enum;
    ok(!mgrExhaustedWrites.includes('swarm.spawn'), 'MCP tools/list hides swarm.spawn when remainingDepth === 0 even if formal_org canDelegate is true');
    ok(!mgrExhaustedWrites.includes('swarm.kill'), 'MCP tools/list hides swarm.kill when remainingDepth === 0 and not coordinator');
    await mgrExhaustedMcp.close();

    mockAuthSessions.set('tok-root-nodeleg', rootAuth('root-locked-nodeleg'));
    const rootNoDelegMcp = await spawnMcpClient({
      scope: 'root',
      sessionId: 'root-locked-nodeleg',
      token: 'tok-root-nodeleg',
    });
    const rootNoDelegList = await rootNoDelegMcp.call(1, 'tools/list');
    const rootNoDelegWrites = rootNoDelegList.result.tools.find((t) => t.name === 'ragent_organization_action').inputSchema.properties.action.enum;
    ok(!rootNoDelegWrites.includes('swarm.spawn'), 'MCP tools/list hides swarm.spawn when root canDelegate is false');
    ok(rootNoDelegWrites.includes('swarm.kill') && rootNoDelegWrites.includes('swarm.done'), 'root Coordinator retains swarm.kill and swarm.done');
    await rootNoDelegMcp.close();

    // Regression: sharded node:<name>-1..k lock enforcement in validateSwarmSpawnRuntime.
    sessionsById.set('root-shard-locks', {
      id: 'root-shard-locks',
      sessionClass: 'ROOT_LEADERSHIP',
      sessionPlane: 'user',
      userAddressable: true,
      folder: workFolder,
      runtimeConstraints: {
        model: [
          { mode: 'locked', value: 'gpt-5.4-mini', source: 'user', scope: 'node:auditor-1', version: 1 },
        ],
      },
    });
    await rejectsWith(
      () => tools.executeOrganizationControlTool({
        authSession: rootAuth('root-shard-locks'),
        action: 'swarm.spawn',
        args: { name: 'auditor', tasks: ['shard one', 'shard two'], model: 'claude-opus-4', workspace: 'inherit' },
        deps: sharedDeps,
      }),
      (err) => err?.statusCode === 422 && err?.code === 'ORG_RUNTIME_USER_LOCKED',
      'swarm.spawn enforces per-shard node:<name>-1 runtime constraint locks',
    );
    const shardLockApplied = await tools.executeOrganizationControlTool({
      authSession: rootAuth('root-shard-locks'),
      action: 'swarm.spawn',
      args: { name: 'auditor', tasks: ['shard one', 'shard two'], workspace: 'inherit' },
      deps: sharedDeps,
    });
    equal(shardLockApplied.members[0].model, 'gpt-5.4-mini', 'sharded swarm.spawn inherits locked node:<name>-1 model');

    await rejectsWith(
      () => tools.executeOrganizationControlTool({
        authSession: rootAuth('root-shard-locks'),
        action: 'swarm.spawn',
        args: { name: 'bad-cert-rev', role: 'reviewer', certifiedReadOnly: 'yes', brief: 'invalid flag', workspace: 'inherit' },
        deps: sharedDeps,
      }),
      (err) => err?.statusCode === 400 && err?.code === 'BAD_REQUEST',
      'swarm.spawn rejects non-boolean certifiedReadOnly',
    );
    const certToolRev = await tools.executeOrganizationControlTool({
      authSession: rootAuth('root-shard-locks'),
      action: 'swarm.spawn',
      args: { name: 'cert-tool-rev', role: 'reviewer', certifiedReadOnly: true, brief: 'certified read-only review', workspace: 'inherit' },
      deps: sharedDeps,
    });
    equal(certToolRev.members[0].certifiedReadOnly, true, 'swarm.spawn forwards certifiedReadOnly opt-in');

    // Regression (Stream F1 P0 #2): swarm.spawn accepts args.tool/providerProfile/riskMode and inherits Coordinator runtime when omitted.
    const createdInheritedSessions = new Map();
    const inheritDeps = {
      ...sharedDeps,
      createSession: async (folder, tool, name, extra = {}) => {
        const s = { id: `inherit-sess-${createdInheritedSessions.size + 1}`, folder, tool, name, ...extra };
        createdInheritedSessions.set(s.id, s);
        return s;
      },
    };
    sessionsById.set('root-claude-inherit', {
      id: 'root-claude-inherit',
      sessionClass: 'ROOT_LEADERSHIP',
      sessionPlane: 'user',
      userAddressable: true,
      folder: workFolder,
      tool: 'claude-bidi',
      providerProfile: 'glm-68f6bd41',
      model: 'glm-5.3',
      effort: 'medium',
      riskMode: 'full-auto',
      riskModeExplicit: true,
    });
    await rejectsWith(
      () => tools.executeOrganizationControlTool({
        authSession: rootAuth('root-claude-inherit'),
        action: 'swarm.spawn',
        args: { name: 'mismatch-tool', harness: 'codex', tool: 'claude-bidi', brief: 'mismatch', workspace: 'inherit' },
        deps: inheritDeps,
      }),
      (err) => err?.statusCode === 400 && err?.code === 'BAD_REQUEST',
      'swarm.spawn rejects conflicting tool and harness values',
    );
    const inheritedSpawn = await tools.executeOrganizationControlTool({
      authSession: rootAuth('root-claude-inherit'),
      action: 'swarm.spawn',
      args: { name: 'inherited-claude', brief: 'inherit coordinator runtime', workspace: 'inherit' },
      deps: inheritDeps,
    });
    equal(inheritedSpawn.members[0].harness, 'claude-bidi', 'swarm.spawn inherits coordinator tool instead of codex default');
    equal(inheritedSpawn.members[0].provider, 'glm-68f6bd41', 'swarm.spawn inherits coordinator providerProfile');
    equal(inheritedSpawn.members[0].model, 'glm-5.3', 'swarm.spawn inherits coordinator model');
    equal(inheritedSpawn.members[0].effort, 'medium', 'swarm.spawn inherits coordinator effort');
    const inheritedSess = createdInheritedSessions.get(inheritedSpawn.members[0].currentSessionId);
    equal(inheritedSess.tool, 'claude-bidi');
    equal(inheritedSess.providerProfile, 'glm-68f6bd41');
    equal(inheritedSess.model, 'glm-5.3');
    equal(inheritedSess.effort, 'medium');
    equal(inheritedSess.riskMode, 'full-auto');
    equal(inheritedSess.riskModeExplicit, true);

    const toolArgSpawn = await tools.executeOrganizationControlTool({
      authSession: rootAuth('root-claude-inherit'),
      action: 'swarm.spawn',
      args: { name: 'explicit-tool-arg', tool: 'claude-bidi', brief: 'use args.tool', workspace: 'inherit' },
      deps: inheritDeps,
    });
    equal(toolArgSpawn.members[0].harness, 'claude-bidi', 'swarm.spawn honors args.tool');
    equal(toolArgSpawn.members[0].model, 'glm-5.3', 'swarm.spawn inherits model when args.tool matches coordinator');

    const crossToolSpawn = await tools.executeOrganizationControlTool({
      authSession: rootAuth('root-claude-inherit'),
      action: 'swarm.spawn',
      args: { name: 'cross-codex', tool: 'codex', brief: 'explicit different tool', workspace: 'inherit' },
      deps: inheritDeps,
    });
    equal(crossToolSpawn.members[0].harness, 'codex', 'swarm.spawn accepts cross-tool args.tool');
    equal(crossToolSpawn.members[0].model, '', 'cross-tool spawn does not leak claude-bidi model onto codex');

    sessionsById.set('root-claude-unexplicit', {
      id: 'root-claude-unexplicit',
      sessionClass: 'ROOT_LEADERSHIP',
      sessionPlane: 'user',
      userAddressable: true,
      folder: workFolder,
      tool: 'claude-bidi',
      providerProfile: 'glm-68f6bd41',
      model: 'glm-5.3',
      riskMode: 'full-auto',
      riskModeExplicit: false,
    });
    const clampedSpawn = await tools.executeOrganizationControlTool({
      authSession: rootAuth('root-claude-unexplicit'),
      action: 'swarm.spawn',
      args: { name: 'clamped-risk', brief: 'clamp unexplicit full-auto', workspace: 'inherit' },
      deps: inheritDeps,
    });
    equal(createdInheritedSessions.get(clampedSpawn.members[0].currentSessionId).riskMode, 'recommended', 'unexplicit full-auto coordinator clamps inherited worker riskMode to recommended');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  console.log(`test-organization-swarm-tools: ok (${assertions} assertions)`);
} finally {
  rmSync(tempHome, { recursive: true, force: true });
}
