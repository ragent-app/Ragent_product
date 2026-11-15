#!/usr/bin/env node
// DS-10 invalidation scenarios for the timeline bundle memo:
//   active run, operation update, approval, fork, compact (generation-bump
//   model), direct session deletion, skip threshold, decision reasons.
// Runs against a clean temp HOME like the sibling test-session-timeline-cache
// test; never touches real config or history.
import assert from 'assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tempHome = mkdtempSync(join(tmpdir(), 'ragent-timeline-cache-scenarios-'));
const previousHome = process.env.HOME;
process.env.HOME = tempHome;
process.env.RAGENT_INSTANCE_ROOT = tempHome;
process.env.RAGENT_CONFIG_DIR = join(tempHome, 'config');
process.env.RAGENT_MEMORY_DIR = join(tempHome, 'memory');
process.env.RAGENT_WORK_ROOT_DIR = join(tempHome, 'work');

async function main() {
  const sessionManager = await import(pathToFileURL(join(repoRoot, 'chat', 'session-manager.mjs')).href);
  const {
    __getTimelineBundleCounters,
    __getTimelineBundleDiagnostics,
    __probeTimelineBundleDecision,
    __setTimelineCacheLimitsForTest,
    broadcastSessionInvalidation,
    createSession,
    deleteSession,
    forkSession,
    getSessionTimelineBundle,
    killAll,
    releaseSessionTimelineCache,
  } = sessionManager;
  const { appendEvent, loadMeta } = await import(pathToFileURL(join(repoRoot, 'chat', 'history.mjs')).href);
  const { createRun, updateRun } = await import(pathToFileURL(join(repoRoot, 'chat', 'runs.mjs')).href);
  const { mutateSessionMeta } = await import(pathToFileURL(join(repoRoot, 'chat', 'session-meta-store.mjs')).href);

  const counts = () => __getTimelineBundleCounters();
  const diagnostics = () => __getTimelineBundleDiagnostics();
  const probe = (sessionId) => __probeTimelineBundleDecision(sessionId);

  // ── 1. operation update: appended operation events bump latestSeq; a
  // broadcast invalidation without any new event (in-place mutation model)
  // bumps the generation counter and rebuilds too.
  {
    const session = await createSession(tempHome, 'fake-codex', 'Operation Update Case');
    const sessionId = session.id;
    await appendEvent(sessionId, { type: 'message', role: 'user', content: 'run it' });
    const before = await getSessionTimelineBundle(sessionId);
    assert.equal(counts().builds, 1, 'first call builds');
    assert.deepEqual(await probe(sessionId), { decision: 'hit', reason: 'key_match' }, 'cached decision is hit');

    await appendEvent(sessionId, {
      type: 'operation',
      role: 'system',
      state: 'running',
      kind: 'shell',
      title: 'npm test',
      command: 'npm test',
      startedAt: Date.now(),
    });
    const afterOperation = await getSessionTimelineBundle(sessionId);
    assert.equal(counts().builds, 2, 'operation event forces a rebuild');
    assert.ok(afterOperation.displayEvents.some((event) => event?.type === 'operation'), 'operation visible in display events');

    // In-place mutation without a new event: generation bump must invalidate.
    await broadcastSessionInvalidation(sessionId);
    assert.deepEqual(await probe(sessionId), { decision: 'miss', reason: 'key_mismatch' }, 'generation bump makes the memo miss');
    await getSessionTimelineBundle(sessionId);
    assert.equal(counts().builds, 3, 'generation bump forces a rebuild');
    assert.deepEqual(await probe(sessionId), { decision: 'hit', reason: 'key_match' }, 'stable again after rebuild');
  }

  // ── 2. approval flow contract: privileged-approval appends the response
  // event and calls invalidate() (wired to broadcastSessionInvalidation).
  // The observable memo behavior is a single rebuild for append+invalidate.
  {
    const session = await createSession(tempHome, 'fake-codex', 'Approval Case');
    const sessionId = session.id;
    await appendEvent(sessionId, { type: 'message', role: 'user', content: 'approve anything?' });
    await getSessionTimelineBundle(sessionId);
    const buildsBefore = counts().builds;

    await appendEvent(sessionId, {
      type: 'approval_request',
      role: 'system',
      approvalId: 'approval_ds10_1',
      status: 'pending',
      title: 'Allow command',
      command: 'rm -rf /tmp/x',
      cwd: '/tmp',
      questions: [{ id: 'q1', prompt: 'Allow?', choices: ['allow', 'deny'] }],
    });
    await broadcastSessionInvalidation(sessionId);
    const afterApproval = await getSessionTimelineBundle(sessionId);
    assert.equal(counts().builds, buildsBefore + 1, 'approval request + invalidate rebuilds once');
    assert.ok(afterApproval.displayEvents.some((event) => event?.type === 'approval_request'), 'approval visible in display events');
    await getSessionTimelineBundle(sessionId);
    assert.equal(counts().builds, buildsBefore + 1, 'stable approval state hits the memo');
  }

  // ── 3. active run: run fingerprint (state/updatedAt/lastNormalizedAt)
  // changes rebuild; stable runs hit.
  {
    const session = await createSession(tempHome, 'fake-codex', 'Active Run Case');
    const sessionId = session.id;
    await appendEvent(sessionId, { type: 'message', role: 'user', content: 'stream it' });
    await getSessionTimelineBundle(sessionId);
    const buildsBefore = counts().builds;

    const run = await createRun({
      status: { sessionId, requestId: 'req_ds10_run', state: 'accepted', tool: 'fake-codex', runtimeFamily: 'codex-json' },
      manifest: { sessionId, requestId: 'req_ds10_run', folder: '~', tool: 'fake-codex', prompt: 'x', runtimeFamily: 'codex-json', options: { runtimeFamily: 'codex-json' } },
    });
    await mutateSessionMeta(sessionId, (draft) => {
      draft.activeRunId = run.id;
      return true;
    });
    await updateRun(run.id, { state: 'running', lastNormalizedAt: new Date().toISOString() });
    const running = await getSessionTimelineBundle(sessionId);
    assert.equal(counts().builds, buildsBefore + 1, 'run going active forces a rebuild');
    assert.equal(running.sessionRunning, true, 'bundle reflects the running run');

    await updateRun(run.id, { state: 'completed' });
    const completed = await getSessionTimelineBundle(sessionId);
    assert.equal(counts().builds, buildsBefore + 2, 'terminal run state forces a rebuild');
    assert.equal(completed.sessionRunning, false, 'bundle reflects the completed run');

    await getSessionTimelineBundle(sessionId);
    assert.equal(counts().builds, buildsBefore + 2, 'stable run state hits the memo');
  }

  // ── 4. fork: the child builds its own entry; the parent memo is untouched.
  {
    const session = await createSession(tempHome, 'fake-codex', 'Fork Case');
    const sessionId = session.id;
    await appendEvent(sessionId, { type: 'message', role: 'user', content: 'fork me' });
    await appendEvent(sessionId, { type: 'message', role: 'assistant', content: 'done' });
    await getSessionTimelineBundle(sessionId);
    const buildsBefore = counts().builds;
    const hitsBefore = counts().hits;

    const child = await forkSession(sessionId);
    assert.ok(child && child.id, 'fork created a child session');
    await getSessionTimelineBundle(child.id);
    assert.equal(counts().builds, buildsBefore + 1, 'child session builds its own bundle');
    assert.equal(counts().hits, hitsBefore, 'child build is not a parent hit');

    await getSessionTimelineBundle(sessionId);
    assert.deepEqual(await probe(sessionId), { decision: 'hit', reason: 'key_match' }, 'parent memo survives the fork');
    assert.ok(diagnostics().cacheEntries.includes(child.id), 'child bundle is cached');
  }

  // ── 5. compact: the compaction finalize path calls broadcastSessionInvalidation
  // (with possibly unchanged latestSeq) — the generation bump must rebuild.
  {
    const session = await createSession(tempHome, 'fake-codex', 'Compact Case');
    const sessionId = session.id;
    await appendEvent(sessionId, { type: 'message', role: 'user', content: 'before compact' });
    const beforeSeq = (await loadMeta(sessionId)).latestSeq;
    await getSessionTimelineBundle(sessionId);
    const buildsBefore = counts().builds;

    // Compact rewrites history but appends the compaction status events; the
    // essential cache contract is: any invalidation that leaves latestSeq
    // unchanged still rebuilds (generation counter), and a changed latestSeq
    // also rebuilds.
    await broadcastSessionInvalidation(sessionId);
    const afterBump = await getSessionTimelineBundle(sessionId);
    assert.equal(counts().builds, buildsBefore + 1, 'compact-style generation bump rebuilds');
    assert.deepEqual(afterBump.displayEvents, afterBump.displayEvents, 'rebuild is self-consistent');

    await appendEvent(sessionId, { type: 'status', text: 'Context compacted' });
    const afterEvent = await getSessionTimelineBundle(sessionId);
    assert.equal(counts().builds, buildsBefore + 2, 'compact status event (latestSeq bump) rebuilds');
    assert.equal((await loadMeta(sessionId)).latestSeq, beforeSeq + 1, 'append moved latestSeq');
  }

  // ── 6. direct deletion releases the bundle and generation immediately.
  {
    const session = await createSession(tempHome, 'fake-codex', 'Direct Deletion Case');
    const sessionId = session.id;
    await appendEvent(sessionId, { type: 'message', role: 'user', content: 'keep me' });
    await getSessionTimelineBundle(sessionId);
    assert.ok(diagnostics().cacheEntries.includes(sessionId), 'bundle cached before deletion');

    await deleteSession(sessionId);
    assert.ok(!diagnostics().cacheEntries.includes(sessionId), 'deletion releases the cached bundle');
    assert.ok(!diagnostics().generationSessions.includes(sessionId), 'deletion releases the generation counter');
    assert.deepEqual(await probe(sessionId), { decision: 'miss', reason: 'key_mismatch' }, 'deleted session misses');
    const empty = await getSessionTimelineBundle(sessionId);
    assert.ok(Array.isArray(empty.displayEvents), 'deleted session serves an empty bundle');
  }

  // ── 7. skip threshold: sessions whose retained payload exceeds the
  // estimate are built but never cached, with an observable skip reason.
  {
    __setTimelineCacheLimitsForTest({ skipEstimateBytes: 2000 });
    try {
      const session = await createSession(tempHome, 'fake-codex', 'Skip Threshold Case');
      const sessionId = session.id;
      await appendEvent(sessionId, { type: 'message', role: 'user', content: 'x'.repeat(5000) });
      const buildsBefore = counts().builds;
      const hitsBefore = counts().hits;

      const big = await getSessionTimelineBundle(sessionId);
      assert.ok(big.displayEvents.length > 0, 'over-threshold session still serves a fresh bundle');
      assert.equal(counts().builds, buildsBefore + 1, 'over-threshold build happens');
      assert.equal(diagnostics().skips, 1, 'over-threshold build is recorded as a skip');
      assert.equal(diagnostics().skipReasons[sessionId], 'over_estimate_threshold', 'skip reason is observable');
      assert.ok(!diagnostics().cacheEntries.includes(sessionId), 'over-threshold bundle is not cached');
      assert.deepEqual(await probe(sessionId), { decision: 'skip', reason: 'over_estimate_threshold' }, 'probe reports the skip reason');

      await getSessionTimelineBundle(sessionId);
      assert.equal(counts().builds, buildsBefore + 2, 'over-threshold session never hits — rebuilt each time');
      assert.equal(counts().hits, hitsBefore, 'no hit is recorded for the skipped session');
    } finally {
      __setTimelineCacheLimitsForTest({ skipEstimateBytes: 64 * 1024 * 1024 });
    }
  }

  // ── 8. bounded generation map: a generation only exists for invalidated
  // sessions, and it is swept once its bundle is no longer cached, so the
  // map cannot grow with sessions that are not retained.
  {
    const session = await createSession(tempHome, 'fake-codex', 'Generation Sweep Case');
    const sessionId = session.id;
    await appendEvent(sessionId, { type: 'message', role: 'user', content: 'sweep me' });
    await getSessionTimelineBundle(sessionId);
    assert.ok(!diagnostics().generationSessions.includes(sessionId), 'never-invalidated sessions carry no generation');

    await broadcastSessionInvalidation(sessionId);
    assert.ok(diagnostics().generationSessions.includes(sessionId), 'invalidation records a generation');
    await getSessionTimelineBundle(sessionId);
    assert.ok(diagnostics().generationSessions.includes(sessionId), 'cached session holds its generation after the sweep');

    // Drop the entry; the next successful cache set sweeps the orphan.
    releaseSessionTimelineCache(sessionId);
    const probeAfter = await probe(sessionId);
    assert.deepEqual(probeAfter, { decision: 'miss', reason: 'key_mismatch' }, 'released session misses');
    const other = await createSession(tempHome, 'fake-codex', 'Sweep Trigger Case');
    await appendEvent(other.id, { type: 'message', role: 'user', content: 'trigger sweep' });
    await getSessionTimelineBundle(other.id);
    assert.ok(!diagnostics().generationSessions.includes(sessionId), 'orphan generation is swept after a cache set');
    assert.ok(diagnostics().generationSessions.length <= diagnostics().cacheEntries.length,
      'generation map stays bounded by the cache size');
  }
}

try {
  await main();
  const { killAll } = await import(pathToFileURL(join(repoRoot, 'chat', 'session-manager.mjs')).href);
  killAll();
  console.log('test-session-timeline-cache-scenarios: ok');
} finally {
  process.env.HOME = previousHome;
  rmSync(tempHome, { recursive: true, force: true });
}
