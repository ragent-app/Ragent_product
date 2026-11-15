#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'ragent-shared-prefix-fork-'));
process.env.HOME = home;
process.env.RAGENT_CONFIG_DIR = join(home, '.config', 'ragent');
process.env.RAGENT_MEMORY_DIR = join(home, 'memory');
process.env.RAGENT_WORK_ROOT_DIR = join(home, 'workspace');
await mkdir(process.env.RAGENT_CONFIG_DIR, { recursive: true });
await writeFile(
  join(process.env.RAGENT_CONFIG_DIR, 'auth.json'),
  JSON.stringify({ username: 'test-owner', passwordHash: 'not-a-real-hash' }),
  'utf8',
);

const {
  createSession,
  deleteSession,
  forkSession,
  forkSessionAt,
  getHistory: getSessionHistory,
  getSession,
  killAll,
  recoverSharedForkHistories,
} = await import('../chat/session-manager.mjs');
const history = await import('../chat/history.mjs');
const { writeHistoryBase } = await import('../chat/history-base.mjs');
const { loadSessionsMeta, mutateSessionMeta } = await import('../chat/session-meta-store.mjs');
const { buildProjectionModel, ensureSessionAuditProjection } = await import('../chat/session-audit-projection.mjs');
const { defaultContinuityStore } = await import('../chat/continuity-store.mjs');
const { createProject, deleteProject } = await import('../chat/projects.mjs');
const { handleControlRoutes } = await import('../chat/router-control-routes.mjs');

const historyRoot = join(process.env.RAGENT_CONFIG_DIR, 'chat-history');
const historyDir = (sessionId) => join(historyRoot, sessionId);
const eventsDir = (sessionId) => join(historyDir(sessionId), 'events');
const bodiesDir = (sessionId) => join(historyDir(sessionId), 'bodies');

function readSpawnResult(output) {
  const marker = 'RESULT:';
  const index = output.lastIndexOf(marker);
  assert.ok(index >= 0, `fork subprocess did not return a result: ${output.slice(-500)}`);
  return JSON.parse(output.slice(index + marker.length).trim());
}

async function coldFork(sessionId) {
  const historyUrl = new URL('../chat/history.mjs', import.meta.url).href;
  const managerUrl = new URL('../chat/session-manager.mjs', import.meta.url).href;
  const script = `
    const history = await import(${JSON.stringify(historyUrl)});
    const manager = await import(${JSON.stringify(managerUrl)});
    history.__resetHistoryReadStatsForTest();
    const child = await manager.forkSession(${JSON.stringify(sessionId)});
    process.stdout.write('RESULT:' + JSON.stringify({ childId: child?.id, stats: history.getHistoryReadStats() }));
    manager.killAll();
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let error = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { error += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(`cold fork failed (${code}): ${error.slice(-1000)}`));
        return;
      }
      try {
        resolve(readSpawnResult(output));
      } catch (parseError) {
        reject(parseError);
      }
    });
  });
}

async function assertNoPhysicalEvents(sessionId, message) {
  assert.deepEqual(await readdir(eventsDir(sessionId)), [], message);
  assert.deepEqual(await readdir(bodiesDir(sessionId)), [], `${message}: bodies`);
}

function makeBodyRequest(body, method = 'DELETE') {
  const chunk = Buffer.from(JSON.stringify(body));
  return {
    method,
    headers: { host: 'localhost' },
    on(event, handler) {
      if (event === 'data') queueMicrotask(() => handler(chunk));
      if (event === 'end') queueMicrotask(() => handler());
      return this;
    },
    destroy() {},
  };
}

function makeResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode;
      this.headers = { ...headers };
    },
    end(body = '') {
      this.body = body;
    },
  };
}

function writeJson(res, statusCode, value) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}

try {
  // A long parent transcript is forked in a cold process. The fork request may
  // read only the bounded recent context window; it must not copy the parent
  // event or body files and must not read an old cold body.
  const total = 1200;
  const bigBody = '共享正文·测试🎯'.repeat(12000);
  const parent = await createSession(home, 'missing-tool', 'Large shared-prefix source');
  const parentEvents = [
    {
      type: 'message', role: 'user', content: 'The first message',
      runId: 'run-parent', requestId: 'request-parent', timestamp: 1,
    },
    {
      type: 'tool_result', output: bigBody,
      runId: 'run-parent', requestId: 'request-parent', timestamp: 2,
    },
  ];
  for (let seq = 3; seq <= total - 2; seq += 1) {
    parentEvents.push({ type: 'status', content: `background event ${seq}`, timestamp: seq });
  }
  parentEvents.push(
    { type: 'message', role: 'user', content: 'Finish the original work.', timestamp: total - 1 },
    { type: 'message', role: 'assistant', content: 'The original work is finished.', timestamp: total },
  );
  await history.appendEvents(parent.id, parentEvents);
  await history.setContextHead(parent.id, {
    mode: 'summary',
    summary: 'A bounded summary for the original session.',
    activeFromSeq: 0,
    compactedThroughSeq: 0,
    source: 'test',
  });

  const coldForkResult = await coldFork(parent.id);
  assert.ok(coldForkResult.childId, 'cold fork should create a child');
  assert.ok(
    coldForkResult.stats.eventFileReads < total,
    `fork should not read the complete transcript (${coldForkResult.stats.eventFileReads}/${total})`,
  );
  assert.equal(coldForkResult.stats.bodyFileReads, 0, 'fork should not read the old cold body');
  const childId = coldForkResult.childId;
  const base = await history.getHistoryBase(childId);
  assert.equal(base.sourceSessionId, parent.id);
  assert.equal(base.throughSeq, total);
  assert.equal(base.sourceLatestSeqAtFork, total);
  await assertNoPhysicalEvents(childId, 'ordinary shared-prefix fork has no copied files');

  const childHistory = await history.loadHistory(childId, { includeBodies: true });
  assert.equal(childHistory.length, total, 'logical child history has the full parent prefix');
  assert.equal(childHistory[1].output, bigBody, 'logical body is read from the parent source');
  assert.equal(childHistory[0].runId, undefined, 'shared parent run id is not exposed');
  assert.equal(childHistory[0].requestId, undefined, 'shared parent request id is not exposed');

  const page = await history.readEventsPage(childId, {
    afterSeq: 1,
    limit: 1,
    includeBodies: false,
  });
  assert.equal(page.events[0].seq, 2);
  assert.equal(page.events[0].bodyAvailable, true, 'index page retains body availability for shared bodies');
  assert.equal(page.events[0].bodyLoaded, false);
  assert.equal((await history.readEventBody(childId, 2)).value, bigBody, 'shared body endpoint resolves the source body');
  await assert.rejects(
    () => writeHistoryBase(childId, {
      sourceSessionId: 'another-source',
      throughSeq: total,
      sourceThroughSeq: total,
    }),
    (error) => error?.code === 'HISTORY_BASE_IMMUTABLE',
  );

  // Parent and child use independent physical tails even when their next
  // logical sequence number is the same.
  await history.appendEvent(parent.id, { type: 'status', content: 'parent-only tail', timestamp: total + 1 });
  assert.equal((await history.loadMeta(childId)).latestSeq, total, 'parent append does not advance child meta');
  await history.appendEvent(childId, { type: 'status', content: 'child-only tail', timestamp: total + 1 });
  const childTail = await getSessionHistory(childId);
  assert.equal(childTail.at(-1).content, 'child-only tail');
  assert.equal(childTail.at(-1).seq, total + 1);
  assert.equal(childTail.some((event) => event.content === 'parent-only tail'), false);
  assert.equal((await readdir(eventsDir(childId))).length, 1, 'only the child tail is physically stored');
  await history.waitForForkHistoryIndexBuild(childId);
  const indexedTail = Array.from({ length: 600 }, (_, index) => ({
    type: 'message',
    role: index % 2 === 0 ? 'assistant' : 'user',
    content: `indexed tail ${index}`,
    timestamp: total + 2 + index,
  }));
  await history.appendEvents(childId, indexedTail);
  await history.waitForForkHistoryIndexBuild(childId);
  const indexedContinuity = await defaultContinuityStore.read(childId);
  assert.equal(indexedContinuity?.coverage?.coveredThroughSeq, total + 1 + indexedTail.length);
  const indexedFork = await forkSessionAt(childId, {
    anchorSeq: 1500,
    mode: 'assistant-continue',
    idempotencyKey: 'shared-prefix-indexed-suffix-1',
  });
  assert.equal(indexedFork.historyStatsState, 'ready', 'indexed suffix fork should be ready synchronously');
  assert.equal((await getSessionHistory(indexedFork.id)).length, 1500);
  await assertNoPhysicalEvents(indexedFork.id, 'indexed suffix fork has no copied files');

  // A historical fork of an old, non-indexed session returns quickly in the
  // pending state, then becomes exact after the resumable background index.
  const historicalParent = await createSession(home, 'missing-tool', 'Historical shared source');
  await history.appendEvents(historicalParent.id, [
    { type: 'message', role: 'user', content: 'Before branch', runId: 'run-h1', timestamp: 1 },
    { type: 'message', role: 'assistant', content: 'Branch here', runId: 'run-h1', timestamp: 2 },
    { type: 'message', role: 'user', content: 'After branch', runId: 'run-h2', timestamp: 3 },
    { type: 'message', role: 'assistant', content: 'Later answer', runId: 'run-h2', timestamp: 4 },
  ]);
  const historicalChild = await forkSessionAt(historicalParent.id, {
    anchorSeq: 2,
    mode: 'assistant-continue',
    idempotencyKey: 'shared-prefix-historical-1',
  });
  assert.equal(historicalChild.historyStorage, 'shared-prefix-v1');
  assert.ok(['pending', 'ready'].includes(historicalChild.historyStatsState));
  if (historicalChild.historyStatsState === 'pending') {
    assert.equal((await history.getHistorySnapshot(historicalChild.id)).messageCount, null);
  }
  await assertNoPhysicalEvents(historicalChild.id, 'historical shared-prefix fork has no copied files');
  await history.waitForForkHistoryIndexBuild(historicalChild.id);
  const historicalSnapshot = await history.getHistorySnapshot(historicalChild.id);
  assert.equal(historicalSnapshot.historyStatsState, 'ready');
  assert.equal(historicalSnapshot.messageCount, 2);
  assert.deepEqual(
    (await getSessionHistory(historicalChild.id)).map((event) => event.content),
    ['Before branch', 'Branch here'],
  );

  const grandchild = await forkSession(historicalChild.id);
  assert.ok(grandchild, 'a shared-prefix child can be forked again');
  assert.equal((await history.getHistoryBase(grandchild.id)).sourceSessionId, historicalChild.id);
  assert.deepEqual(
    (await getSessionHistory(grandchild.id)).map((event) => event.content),
    ['Before branch', 'Branch here'],
  );
  await assertNoPhysicalEvents(grandchild.id, 'multi-level shared-prefix fork has no copied files');

  // The derived audit projection is rebuilt from the logical view, while
  // asset/path data remains isolated from the parent storage identity.
  const auditParent = await createSession(home, 'missing-tool', 'Audit shared source');
  await history.appendEvents(auditParent.id, [
    {
      type: 'file_change', filePath: 'report.md', changeType: 'update',
      added: 2, removed: 1, source: 'test', timestamp: 1,
    },
    {
      type: 'message', role: 'assistant', content: 'Report attached.',
      runId: 'run-audit-parent', timestamp: 2,
      attachments: [{ assetId: 'asset-report', originalName: 'report.md', savedPath: '/private/report.md' }],
    },
  ]);
  const auditChild = await forkSession(auditParent.id);
  const auditProjection = await ensureSessionAuditProjection(auditChild.id, {
    latestSeq: 2,
    loadEvents: () => history.loadHistory(auditChild.id, { includeBodies: false }),
  });
  const auditModel = buildProjectionModel(auditProjection, { session: auditChild });
  assert.equal(auditModel.files[0]?.filePath, 'report.md');
  assert.equal(auditModel.files[0]?.added, 2);
  assert.equal(auditModel.artifactFiles[0]?.assetId, 'asset-report');
  assert.equal(auditModel.artifactFiles[0]?.savedPath, undefined, 'audit projection must not expose parent saved paths');
  await assertNoPhysicalEvents(auditChild.id, 'audit shared-prefix fork has no copied files');

  const project = await createProject({ name: 'Shared history deletion guard', rootPath: home });
  const projectParent = await createSession(home, 'missing-tool', 'Project source', { projectId: project.id });
  await history.appendEvent(projectParent.id, { type: 'message', role: 'user', content: 'project source' });
  const projectChild = await forkSession(projectParent.id);
  // Make the child an explicitly detached inbox session so deleting the
  // project exercises the kept-child materialization path.
  await mutateSessionMeta(projectChild.id, (meta) => {
    meta.projectId = '';
    meta.projectDetached = true;
    return true;
  });
  const projectDeleteResponse = makeResponse();
  await handleControlRoutes({
    req: makeBodyRequest({ deleteSessions: true }),
    res: projectDeleteResponse,
    parsedUrl: { pathname: `/api/projects/${project.id}`, query: {} },
    pathname: `/api/projects/${project.id}`,
    authSession: { role: 'owner' },
    writeJson,
    writeJsonCached: writeJson,
  });
  const projectDeletePayload = JSON.parse(projectDeleteResponse.body);
  assert.equal(projectDeleteResponse.statusCode, 200, 'project delete should materialize kept fork children');
  assert.equal(projectDeletePayload.deletedSessionCount, 1);
  assert.ok(await getSession(projectChild.id), 'kept fork child should survive project deletion');
  assert.equal(await history.getHistoryBase(projectChild.id), null, 'kept fork child should no longer depend on the deleted project source');
  assert.equal((await history.loadMeta(projectChild.id)).historyStorage, undefined);
  assert.equal((await loadSessionsMeta()).find((meta) => meta.id === projectChild.id)?.historyStorage, undefined);
  assert.equal((await history.loadHistory(projectChild.id))[0].content, 'project source');
  await deleteSession(projectChild.id);

  // Deleting a source materializes the child first, preserving its logical
  // transcript and allowing the source to disappear independently.
  const deleteParent = await createSession(home, 'missing-tool', 'Referenced source');
  await history.appendEvent(deleteParent.id, { type: 'message', role: 'user', content: 'keep me' });
  const deleteChild = await forkSession(deleteParent.id);
  assert.ok(await deleteSession(deleteParent.id), 'source deletion succeeds with a live fork child');
  assert.equal(await getSession(deleteParent.id), null, 'source session should be removed');
  assert.equal(await history.getHistoryBase(deleteChild.id), null, 'child should be detached from deleted source');
  assert.equal((await history.loadHistory(deleteChild.id))[0].content, 'keep me');
  assert.equal((await loadSessionsMeta()).find((meta) => meta.id === deleteChild.id)?.historyStorage, undefined);
  assert.ok(await deleteSession(deleteChild.id), 'materialized child deletion succeeds');

  // A surviving grandchild may still share the intermediate child. Deleting
  // the root must detach only the direct child, and deleting that child later
  // must detach the grandchild in turn.
  const chainRoot = await createSession(home, 'missing-tool', 'Chain root');
  await history.appendEvent(chainRoot.id, { type: 'message', role: 'user', content: 'chain root' });
  const chainChild = await forkSession(chainRoot.id);
  await history.appendEvent(chainChild.id, { type: 'status', content: 'chain child tail' });
  const chainGrandchild = await forkSession(chainChild.id);
  assert.ok(await deleteSession(chainRoot.id), 'root deletion should preserve a multi-level fork chain');
  assert.equal(await history.getHistoryBase(chainChild.id), null);
  assert.equal((await history.loadHistory(chainGrandchild.id)).at(-1).content, 'chain child tail');
  assert.ok(await deleteSession(chainChild.id), 'intermediate deletion should preserve its grandchild');
  assert.equal(await history.getHistoryBase(chainGrandchild.id), null);
  assert.equal((await history.loadHistory(chainGrandchild.id))[0].content, 'chain root');
  assert.ok(await deleteSession(chainGrandchild.id));

  // Recovery hides incomplete/corrupt shared forks and keeps an explicit
  // repair marker. Reads fail with a typed error instead of returning empty.
  const orphan = await createSession(home, 'missing-tool', 'Orphan shared fork', {
    historyStorage: 'shared-prefix-v1',
  });
  await assert.rejects(
    () => history.loadHistory(orphan.id),
    (error) => error?.code === 'HISTORY_BASE_UNAVAILABLE',
  );

  const cycleA = await createSession(home, 'missing-tool', 'Cycle A', { historyStorage: 'shared-prefix-v1' });
  const cycleB = await createSession(home, 'missing-tool', 'Cycle B', { historyStorage: 'shared-prefix-v1' });
  await history.appendEvent(cycleA.id, { type: 'status', content: 'cycle-a' });
  await history.appendEvent(cycleB.id, { type: 'status', content: 'cycle-b' });
  await writeHistoryBase(cycleA.id, {
    sourceSessionId: cycleB.id, throughSeq: 1, sourceThroughSeq: 1,
  });
  await writeHistoryBase(cycleB.id, {
    sourceSessionId: cycleA.id, throughSeq: 1, sourceThroughSeq: 1,
  });
  await history.waitForForkHistoryIndexBuild(cycleA.id);
  await history.waitForForkHistoryIndexBuild(cycleB.id);
  await assert.rejects(
    () => history.loadHistory(cycleA.id),
    (error) => error?.code === 'HISTORY_BASE_CYCLE',
  );

  const missingSource = await createSession(home, 'missing-tool', 'Missing source', {
    historyStorage: 'shared-prefix-v1',
  });
  await history.appendEvent(missingSource.id, { type: 'status', content: 'missing-source' });
  await writeHistoryBase(missingSource.id, {
    sourceSessionId: 'source-that-does-not-exist', throughSeq: 1, sourceThroughSeq: 1,
  });
  await history.appendEvent(missingSource.id, { type: 'status', content: 'local-tail' });
  await assert.rejects(
    () => history.loadHistory(missingSource.id, { fromSeq: 2 }),
    (error) => error?.code === 'HISTORY_BASE_UNAVAILABLE',
    'a local-tail read must still validate the shared source lineage',
  );
  await history.waitForForkHistoryIndexBuild(missingSource.id);
  await assert.rejects(
    () => history.loadHistory(missingSource.id),
    (error) => error?.code === 'HISTORY_BASE_UNAVAILABLE',
  );

  const recovery = await recoverSharedForkHistories();
  assert.equal(recovery.repaired, 4, 'recovery marks missing, cyclic and unavailable bases');
  const repaired = await loadSessionsMeta();
  for (const sessionId of [orphan.id, cycleA.id, cycleB.id, missingSource.id]) {
    const record = repaired.find((entry) => entry.id === sessionId);
    assert.equal(record?.archived, true, `broken fork ${sessionId} is hidden`);
    assert.match(record?.historyRepairState || '', /^HISTORY_BASE_/);
  }

  console.log('test-shared-prefix-fork: ok');
} finally {
  killAll();
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
