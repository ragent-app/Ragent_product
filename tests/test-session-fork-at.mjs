#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const home = mkdtempSync(join(tmpdir(), 'ragent-session-fork-at-'));
process.env.HOME = home;
process.env.RAGENT_INSTANCE_ROOT = home;
process.env.RAGENT_CONFIG_DIR = join(home, '.config', 'ragent');
process.env.RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';

const {
  createSession,
  forkSessionAt,
  getHistory,
  getSession,
  killAll,
} = await import('../chat/session-manager.mjs');
const { appendEvents, getForkContext, setContextHead } = await import('../chat/history.mjs');
const { createProject } = await import('../chat/projects.mjs');

try {
  // Keep two projects on the same root so this catches folder-based project
  // re-resolution rather than only testing the unambiguous case.
  await createProject({ name: 'Canonical historical project', rootPath: home });
  const selectedProject = await createProject({ name: 'Selected historical project', rootPath: home });
  const parent = await createSession(home, 'missing-tool', 'Historical branch source', {
    projectId: selectedProject.id,
    description: 'Parent session',
  });
  await appendEvents(parent.id, [
    {
      type: 'message',
      role: 'user',
      content: 'Start the original discussion.',
      requestId: 'request-parent-1',
      runId: 'run-parent-1',
      timestamp: 1,
    },
    {
      type: 'message',
      role: 'assistant',
      content: 'The original discussion is underway.',
      requestId: 'request-parent-1',
      runId: 'run-parent-1',
      timestamp: 2,
    },
    {
      type: 'message',
      role: 'user',
      content: 'Now explore a separate direction.',
      requestId: 'request-parent-2',
      runId: 'run-parent-2',
      timestamp: 3,
    },
    {
      type: 'message',
      role: 'assistant',
      content: 'Here is the separate direction.',
      requestId: 'request-parent-2',
      runId: 'run-parent-2',
      timestamp: 4,
    },
  ]);
  await setContextHead(parent.id, {
    mode: 'summary',
    summary: 'A summary that is valid through the current assistant reply.',
    activeFromSeq: 0,
    compactedThroughSeq: 0,
    inputTokens: 24,
    source: 'test',
  });

  const child = await forkSessionAt(parent.id, {
    anchorSeq: 2,
    mode: 'assistant-continue',
    idempotencyKey: 'fork-at-test-1',
  });
  assert.ok(child, 'historical fork should create a child');
  assert.notEqual(child.id, parent.id, 'historical fork should create a new session');
  assert.equal(child.forkedFromSessionId, parent.id, 'child should record its parent');
  assert.equal(child.forkedFromSeq, 2, 'assistant fork should include the anchor');
  assert.equal(child.forkedAnchorSeq, 2, 'child should record the selected anchor');
  assert.equal(child.forkMode, 'assistant-continue', 'child should record its fork mode');
  assert.equal(child.projectId, parent.projectId, 'historical fork should keep the explicit project binding');
  assert.equal(child.sessionHierarchy?.parentSessionId, null, 'historical fork should not become a hierarchy child');
  assert.equal(child.isRootSession, true, 'historical fork of a root session should remain a root session');
  assert.equal(child.activity?.run?.state, 'idle', 'assistant fork should start idle');

  const childHistory = await getHistory(child.id);
  assert.deepEqual(
    childHistory.map((event) => event.content),
    ['Start the original discussion.', 'The original discussion is underway.'],
    'historical fork should copy only the prefix through the selected message',
  );
  assert.equal(childHistory.some((event) => event.runId || event.requestId), false, 'fork should isolate execution identity');
  const childForkContext = await getForkContext(child.id);
  assert.match(childForkContext?.continuationBody || '', /original discussion is underway/i, 'fork context should include history through the anchor');
  assert.doesNotMatch(childForkContext?.continuationBody || '', /separate direction/i, 'fork context must not include events after the anchor');
  assert.equal((await getHistory(parent.id)).length, 4, 'parent history should remain unchanged');

  const duplicate = await forkSessionAt(parent.id, {
    anchorSeq: 2,
    mode: 'assistant-continue',
    idempotencyKey: 'fork-at-test-1',
  });
  assert.equal(duplicate.id, child.id, 'same idempotency key should return the existing child');

  await assert.rejects(
    () => forkSessionAt(parent.id, { anchorSeq: 3, mode: 'assistant-continue' }),
    (error) => error?.code === 'FORK_ANCHOR_INVALID',
    'assistant-continue should reject a user anchor',
  );
  await assert.rejects(
    () => forkSessionAt(parent.id, { anchorSeq: 2, mode: 'unknown' }),
    (error) => error?.code === 'FORK_ANCHOR_INVALID',
    'historical fork should reject an unknown mode',
  );

  const replayChild = await forkSessionAt(parent.id, {
    anchorSeq: 3,
    mode: 'user-replay',
    idempotencyKey: 'fork-at-replay-1',
  });
  assert.equal(replayChild.forkMode, 'user-continue', 'legacy replay requests should use a history-only fork');
  assert.equal(replayChild.forkedFromSeq, 3, 'user fork should include the selected message');
  assert.equal(replayChild.activity?.run?.state, 'idle', 'a fork must never start a new run');
  const replayHistory = await getHistory(replayChild.id);
  assert.deepEqual(
    replayHistory.slice(0, 3).map((event) => event.content),
    ['Start the original discussion.', 'The original discussion is underway.', 'Now explore a separate direction.'],
    'user fork should preserve the selected message as copied history',
  );
  assert.equal(replayHistory[2].requestId, undefined, 'copied input must not acquire a new execution request');
  assert.equal(replayHistory.length, 3, 'fork should not add execution events');

  const userChild = await forkSessionAt(parent.id, { anchorSeq: 3, mode: 'user-continue' });
  assert.equal(userChild.activity?.run?.state, 'idle');
  assert.deepEqual((await getHistory(userChild.id)).map((event) => event.content),
    ['Start the original discussion.', 'The original discussion is underway.', 'Now explore a separate direction.']);

  // Keep this fixture explicit: the current native Codex fork test uses a
  // provider-specific fake and is covered separately.
  const sessionsPath = join(home, '.config', 'ragent', 'chat-sessions.json');
  assert.ok(JSON.parse(readFileSync(sessionsPath, 'utf8')).some((entry) => entry.id === child.id));
  console.log('test-session-fork-at: ok');
} finally {
  await killAll();
  rmSync(home, { recursive: true, force: true });
}
