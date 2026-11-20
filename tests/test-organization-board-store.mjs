#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tempRoot = mkdtempSync(join(tmpdir(), 'ragent-org-board-store-'));
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
const boardStore = await import('../chat/organization-board-store.mjs');
const swarm = await import('../chat/organization-swarm.mjs');

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
  // 1. Schema creation + idempotency + new organization_nodes columns
  await orgStore.initializeOrganizationStore();
  await orgStore.initializeOrganizationStore();

  const schemaCheck = await orgStore.withOrganizationDatabase((conn) => {
    const tables = new Set(
      conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name),
    );
    const nodeCols = new Set(
      conn.prepare('PRAGMA table_info(organization_nodes)').all().map((c) => c.name),
    );
    const version = Number(conn.prepare('PRAGMA user_version').get().user_version || 0);
    return { tables, nodeCols, version };
  });
  for (const tbl of [
    'organization_board_channels',
    'organization_board_channel_subscriptions',
    'organization_board_messages',
    'organization_board_cursors',
    'organization_board_wakeups',
    'organization_swarm_stall_alerts',
  ]) {
    a.ok(schemaCheck.tables.has(tbl), `expected table ${tbl} to exist`);
  }
  for (const col of ['lifecycle_mode', 'swarm_state', 'workspace_mode', 'workspace_path', 'workspace_branch']) {
    a.ok(schemaCheck.nodeCols.has(col), `expected organization_nodes column ${col}`);
  }
  a.ok(schemaCheck.version >= 3, 'user_version bumped for board + swarm schema');

  // 2. normalizeBoardChannelName + parseBoardMentions
  a.equal(boardStore.normalizeBoardChannelName('#Backend_API'), 'backend_api');
  a.equal(boardStore.normalizeBoardChannelName(''), 'main');
  a.equal(boardStore.normalizeBoardChannelName('bad space!'), 'bad-space');
  a.equal(boardStore.normalizeBoardChannelName('!!!', { allowEmpty: true }), '');

  const parsed = boardStore.parseBoardMentions(
    'Contact user@example.com or a.b@sub.domain.org. @worker-1 please check @#backend with @all re #12 [done]',
  );
  a.deepEqual(parsed.memberTargets, ['worker-1']);
  a.deepEqual(parsed.channelTargets, ['backend']);
  a.equal(parsed.mentionAll, true);
  a.equal(parsed.replyToSeq, 12);
  a.equal(parsed.isDoneSignal, true);
  a.equal(parsed.isStallAlert, false);

  const stallParsed = boardStore.parseBoardMentions('[stall] @coordinator please inspect #4');
  a.equal(stallParsed.isStallAlert, true);
  a.deepEqual(stallParsed.memberTargets, ['coordinator']);
  a.equal(stallParsed.replyToSeq, 4);

  // 3. Provision org via ensureSwarmOrganization (revision 0, #main auto-created) + additional nodes
  const { organization: org, coordinatorNode } = await swarm.ensureSwarmOrganization({
    rootSessionId: 'root-board-1',
    projectId: 'proj-board',
    title: 'Board Store Test Swarm',
  });
  a.equal(org.currentRevision, 0);
  a.ok(coordinatorNode?.id);

  const workerNode = await orgStore.createNode({
    organizationId: org.id,
    stableKey: 'worker-1',
    nodeRole: 'worker',
    createdRevision: 0,
    lifecycleState: 'active',
    lifecycleMode: 'ephemeral_swarm',
    swarmState: 'waiting',
    currentSessionId: 'sess-worker-1',
    bindingGeneration: 1,
    parentNodeId: coordinatorNode.id,
    depth: 1,
    sessionClass: 'WORKER',
    grant: { role: 'worker', swarmName: 'worker-1', canWrite: true },
  });
  const killedNode = await orgStore.createNode({
    organizationId: org.id,
    stableKey: 'ghost-worker',
    nodeRole: 'worker',
    createdRevision: 0,
    retiredRevision: 0,
    lifecycleState: 'retired',
    lifecycleMode: 'ephemeral_swarm',
    swarmState: 'killed',
    currentSessionId: 'sess-ghost',
    bindingGeneration: 1,
    parentNodeId: coordinatorNode.id,
    depth: 1,
    sessionClass: 'WORKER',
    grant: { role: 'worker', swarmName: 'ghost-worker' },
  });

  // 4. Channel CRUD + #main protection + subscription + archiving
  await a.rejects(
    () => boardStore.archiveBoardChannel({ organizationId: org.id, channel: 'main' }),
    { code: 'BOARD_MAIN_CHANNEL_PROTECTED' },
  );

  const backendChan = await boardStore.createBoardChannel({
    organizationId: org.id,
    name: 'backend',
    topic: 'Backend coordination',
    createdByNodeId: coordinatorNode.id,
  });
  a.equal(backendChan.name, 'backend');

  await boardStore.subscribeBoardChannel({
    organizationId: org.id,
    channel: 'backend',
    nodeId: workerNode.id,
  });
  const channelsList = await boardStore.listBoardChannels({ organizationId: org.id });
  const listedBackend = channelsList.find((c) => c.name === 'backend');
  a.ok(listedBackend.subscribers.includes(workerNode.id));
  a.ok(channelsList.some((c) => c.name === 'main'));

  await boardStore.createBoardChannel({ organizationId: org.id, name: 'temp-scratch' });
  await boardStore.archiveBoardChannel({ organizationId: org.id, channel: 'temp-scratch' });
  await a.rejects(
    () => boardStore.postBoardMessage({
      organizationId: org.id,
      channel: 'temp-scratch',
      senderKind: 'node',
      senderNodeId: coordinatorNode.id,
      bodyMarkdown: 'should fail on archived channel',
    }),
    { code: 'BOARD_CHANNEL_ARCHIVED' },
  );
  // Unsubscribe check + Phase 2 visibility="org"-only fail-closed check
  const unsub = await boardStore.unsubscribeBoardChannel({
    organizationId: org.id,
    channel: 'temp-scratch',
    nodeId: workerNode.id,
  });
  a.equal(unsub.unsubscribed, false);
  await a.rejects(
    () => boardStore.createBoardChannel({
      organizationId: org.id,
      name: 'secret-chan',
      visibility: 'private',
      createdByNodeId: coordinatorNode.id,
    }),
    { code: 'BOARD_CHANNEL_VISIBILITY_UNSUPPORTED', statusCode: 400 },
  );

  // 5. Ordinary post -> 0 wakeups; monotonic seq across channels
  const ordinaryMain = await boardStore.postBoardMessage({
    organizationId: org.id,
    channel: 'main',
    senderKind: 'node',
    senderNodeId: coordinatorNode.id,
    bodyMarkdown: 'Status update without any mention; mail to ops@example.com works too.',
  });
  a.equal(ordinaryMain.message.seq, 1);
  a.equal(ordinaryMain.wakeups.length, 0, 'ordinary posts create 0 wakeups');
  a.equal((await boardStore.listPendingBoardWakeups({ organizationId: org.id })).length, 0);

  // Self-mention must NOT create a wakeup for sender, killed member must NOT create wakeup
  const selfAndGhost = await boardStore.postBoardMessage({
    organizationId: org.id,
    channel: 'main',
    senderKind: 'node',
    senderNodeId: coordinatorNode.id,
    bodyMarkdown: '@coordinator self-ping and @ghost-worker retired check',
  });
  a.equal(selfAndGhost.message.seq, 2);
  a.equal(selfAndGhost.wakeups.length, 0, 'sender and killed member never receive wakeups');

  // 6. Explicit @mention wakeup + coalescing across #main and #backend + idempotency
  const m1 = await boardStore.postBoardMessage({
    organizationId: org.id,
    channel: 'main',
    senderKind: 'node',
    senderNodeId: coordinatorNode.id,
    bodyMarkdown: '@worker-1 please start slice A',
    artifactRefs: [{ path: 'chat/organization-board-store.mjs', kind: 'file' }],
    idempotencyKey: 'idem-post-1',
  });
  a.equal(m1.message.seq, 3);
  a.equal(m1.wakeups.length, 1);
  a.equal(m1.wakeups[0].targetNodeId, workerNode.id);
  a.equal(m1.wakeups[0].triggerSeq, 3);
  a.equal(m1.wakeups[0].latestSeq, 3);
  a.equal(m1.wakeups[0].coalescedCount, 1);
  a.equal(m1.message.artifactRefs.length, 1);

  const m1Replay = await boardStore.postBoardMessage({
    organizationId: org.id,
    channel: 'main',
    senderKind: 'node',
    senderNodeId: coordinatorNode.id,
    bodyMarkdown: '@worker-1 please start slice A',
    idempotencyKey: 'idem-post-1',
  });
  a.equal(m1Replay.replay, true);
  a.equal(m1Replay.message.seq, 3);
  a.equal(m1Replay.wakeups.length, 0);

  const m2 = await boardStore.postBoardMessage({
    organizationId: org.id,
    channel: 'backend',
    senderKind: 'node',
    senderNodeId: coordinatorNode.id,
    bodyMarkdown: 'Slice B in @#backend re #3',
  });
  a.equal(m2.message.seq, 4);
  a.equal(m2.wakeups.length, 1);
  a.equal(m2.wakeups[0].triggerSeq, 3, 'triggerSeq stays anchored at earliest unconsumed mention');
  a.equal(m2.wakeups[0].latestSeq, 4);
  a.equal(m2.wakeups[0].coalescedCount, 2);

  const m3 = await boardStore.postBoardMessage({
    organizationId: org.id,
    channel: 'main',
    senderKind: 'owner',
    senderName: 'Owner',
    bodyMarkdown: '@all sync point',
  });
  a.equal(m3.message.seq, 5);
  // Owner notifies coordinator (1st) and coalesces worker-1 (3rd)
  const pendingAfterM3 = await boardStore.listPendingBoardWakeups({ organizationId: org.id });
  a.equal(pendingAfterM3.length, 2);
  const workerWake = pendingAfterM3.find((w) => w.targetNodeId === workerNode.id);
  a.equal(workerWake.coalescedCount, 3);
  a.equal(workerWake.triggerSeq, 3);
  a.equal(workerWake.latestSeq, 5);

  // Mark defer -> deliver
  const deferred = await boardStore.markBoardWakeupDeferred({
    wakeupId: workerWake.id,
    reason: 'target_busy_deferred',
  });
  a.equal(deferred.state, 'deferred');
  a.equal(deferred.attempts, 1);
  const delivered = await boardStore.markBoardWakeupDelivered({ wakeupId: workerWake.id });
  a.equal(delivered.state, 'delivered');

  // 7. Bounded readBoardMessages + cursor advancement + listUnreadBoardSummary
  const unreadBefore = await boardStore.listUnreadBoardSummary({
    organizationId: org.id,
    readerNodeId: workerNode.id,
  });
  a.equal(unreadBefore.totalUnread, 5);
  a.equal(unreadBefore.channels.length, 2);

  const page1 = await boardStore.readBoardMessages({
    organizationId: org.id,
    channel: 'main',
    sinceSeq: 0,
    limit: 2,
    readerNodeId: workerNode.id,
    advanceCursor: true,
  });
  a.equal(page1.messages.length, 2);
  a.equal(page1.hasMore, true);
  a.deepEqual(page1.messages.map((m) => m.seq), [1, 2]);

  // Read rest of main
  const page2 = await boardStore.readBoardMessages({
    organizationId: org.id,
    channel: 'main',
    sinceSeq: page1.nextSinceSeq,
    limit: 10,
    readerNodeId: workerNode.id,
    advanceCursor: true,
  });
  a.deepEqual(page2.messages.map((m) => m.seq), [3, 5]);
  a.equal(page2.hasMore, false);

  const unreadAfterMain = await boardStore.listUnreadBoardSummary({
    organizationId: org.id,
    readerNodeId: workerNode.id,
  });
  a.equal(unreadAfterMain.totalUnread, 1, 'only seq #4 in #backend remains unread');
  a.equal(unreadAfterMain.channels[0].channel, 'backend');

  await a.rejects(
    () => boardStore.createBoardChannel(undefined, { organizationId: org.id, name: '!!!' }),
    { code: 'BOARD_INVALID_CHANNEL' },
  );

  // 8. Authoritative board projection (mode: 'ragent_swarm', readOnly: false) + done authority
  const workerDoneMsg = await boardStore.postBoardMessage({
    organizationId: org.id,
    channel: 'main',
    senderKind: 'node',
    senderNodeId: workerNode.id,
    bodyMarkdown: '@coordinator [done] finished both slices',
  });
  a.equal(workerDoneMsg.message.isDoneSignal, true);
  const projectionMid = await boardStore.buildAuthoritativeBoardProjection({
    organizationId: org.id,
    limit: 20,
    readerId: coordinatorNode.id,
  });
  a.equal(projectionMid.isDone, false, 'worker [done] does not end the whole Swarm');

  const depth0FormalWorker = await orgStore.createNode({
    organizationId: org.id,
    stableKey: 'formal-depth0-worker',
    nodeRole: 'worker',
    createdRevision: 0,
    lifecycleState: 'active',
    lifecycleMode: 'formal_org',
    currentSessionId: 'sess-formal-d0-w',
    bindingGeneration: 1,
    depth: 0,
    sessionClass: 'WORKER',
    grant: { role: 'worker' },
  });
  await boardStore.postBoardMessage({
    organizationId: org.id,
    channel: 'main',
    senderKind: 'node',
    senderNodeId: depth0FormalWorker.id,
    bodyMarkdown: '[done] non-coordinator depth-0 done must not close swarm',
    kind: 'done',
  });
  const projectionAfterDepth0Worker = await boardStore.buildAuthoritativeBoardProjection({
    organizationId: org.id,
    limit: 20,
    readerId: coordinatorNode.id,
  });
  a.equal(projectionAfterDepth0Worker.isDone, false, 'depth=0 non-coordinator node cannot mark whole Swarm done');

  // Explicit isStallAlert: false / isDoneSignal: false overrides inline markers & kind
  const suppressedStall = await boardStore.postBoardMessage({
    organizationId: org.id,
    channel: 'main',
    senderKind: 'node',
    senderNodeId: workerNode.id,
    bodyMarkdown: '[stall] non-system stall mention should not spoof',
    kind: 'stall',
    isStallAlert: false,
  });
  a.equal(suppressedStall.message.isStallAlert, false);
  a.equal(suppressedStall.message.kind, 'message');

  const suppressedDone = await boardStore.postBoardMessage({
    organizationId: org.id,
    channel: 'main',
    senderKind: 'node',
    senderNodeId: workerNode.id,
    bodyMarkdown: '[done] explicitly suppressed done flag',
    kind: 'done',
    isDoneSignal: false,
  });
  a.equal(suppressedDone.message.isDoneSignal, false);
  a.equal(suppressedDone.message.kind, 'message');

  await boardStore.postBoardMessage({
    organizationId: org.id,
    channel: 'main',
    senderKind: 'node',
    senderNodeId: coordinatorNode.id,
    bodyMarkdown: '[done] Swarm coordination complete',
    kind: 'done',
  });
  const projection = await boardStore.buildAuthoritativeBoardProjection({
    organizationId: org.id,
    limit: 20,
    readerId: coordinatorNode.id,
  });
  a.equal(projection.mode, 'ragent_swarm');
  a.equal(projection.source, 'ragent_swarm');
  a.equal(projection.readOnly, false);
  a.equal(projection.isDone, true);
  a.equal(projection.headSeq, 10);
  a.ok(projection.channels.some((c) => c.name === 'main'));
  a.ok(projection.messages.some((m) => m.seq === 6 && m.isDoneSignal === true));
  a.ok(projection.messages.some((m) => m.seq === 10 && m.isDoneSignal === true));
  void killedNode;

  // 9. Bug #6 regression: kind='brief' & @mention-targeted Coordinator/Owner [done] instructions never mark whole Swarm done
  const bug6Org = await orgStore.createOrganization({
    rootSessionId: 'root-board-bug6',
    projectId: 'proj-board-bug6',
    state: 'active',
    currentRevision: 0,
    policy: { mode: 'ragent_swarm', swarmEnabled: true },
  });
  const bug6Coord = await orgStore.createNode({
    organizationId: bug6Org.id,
    stableKey: 'coordinator',
    nodeRole: 'root_leadership',
    createdRevision: 0,
    lifecycleState: 'active',
    lifecycleMode: 'ephemeral_swarm',
    swarmState: 'working',
    sessionClass: 'ROOT_LEADERSHIP',
    currentSessionId: 'root-board-bug6',
    grant: { role: 'manager', canDelegate: true },
  });
  const bug6Author = await orgStore.createNode({
    organizationId: bug6Org.id,
    stableKey: 'author',
    nodeRole: 'actor',
    createdRevision: 0,
    lifecycleState: 'active',
    lifecycleMode: 'ephemeral_swarm',
    swarmState: 'waiting',
    sessionClass: 'ACTOR',
    currentSessionId: 'author-sess-bug6',
    parentNodeId: bug6Coord.id,
    depth: 1,
    grant: { role: 'actor', canWrite: true },
  });
  const briefWithDone = await boardStore.postBoardMessage({
    organizationId: bug6Org.id,
    channel: 'main',
    senderKind: 'node',
    senderNodeId: bug6Coord.id,
    bodyMarkdown: `@${bug6Author.stableKey} fix math.mjs then post @verifier [done]`,
    kind: 'brief',
    isDoneSignal: true, // even erroneous caller override must stay suppressed for kind='brief'
  });
  a.equal(briefWithDone.message.kind, 'brief');
  a.equal(briefWithDone.message.isDoneSignal, false, 'kind=brief never sets isDoneSignal=true');
  a.equal(boardStore.parseBoardMentions('@author finish and tell @verifier [done]').isWholeSwarmDoneSignal, false);
  a.equal(boardStore.parseBoardMentions('[done] all done').isWholeSwarmDoneSignal, true);

  await boardStore.postBoardMessage({
    organizationId: bug6Org.id,
    channel: 'main',
    senderKind: 'node',
    senderNodeId: bug6Coord.id,
    bodyMarkdown: `@${bug6Author.stableKey} reply with @verifier [done] when verified`,
    kind: 'done',
  });
  await boardStore.postBoardMessage({
    organizationId: bug6Org.id,
    channel: 'main',
    senderKind: 'owner',
    bodyMarkdown: '@coordinator mark [done] after review',
    kind: 'message',
  });
  const bug6MidProjection = await boardStore.buildAuthoritativeBoardProjection({ organizationId: bug6Org.id });
  a.equal(bug6MidProjection.isDone, false, 'brief or @mention-bearing Coordinator/Owner [done] instructions must not mark Swarm done');

  await boardStore.postBoardMessage({
    organizationId: bug6Org.id,
    channel: 'main',
    senderKind: 'node',
    senderNodeId: bug6Coord.id,
    bodyMarkdown: '[done] Verified cleanly with zero open blockers.',
    kind: 'done',
  });
  const bug6DoneProjection = await boardStore.buildAuthoritativeBoardProjection({ organizationId: bug6Org.id });
  a.equal(bug6DoneProjection.isDone, true, 'Coordinator [done] without @mentions closes Swarm');
}

try {
  await runTests();
  console.log(`test-organization-board-store: ok (${assertionCount} assertions)`);
} finally {
  rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
