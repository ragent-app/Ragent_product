import { setTimeout as delay } from 'node:timers/promises';
import { getRunAcceptanceEvidence, listRunIndexEntries, isTerminalRunState, requestRunCancel } from './runs.mjs';
import { readSessionApiScope, withSessionApiScope } from './session-meta-store.mjs';
import { loadMeta, readEventsPage, readEventBody } from './history.mjs';
import { getRetainedRunReplyPublication, cancelActiveRun } from './session-manager.mjs';
import { cancelQueuedMessageRun } from './message-commit-store.mjs';
import { projectMessageResult } from './message-result-contract.mjs';
import { sessionApiError } from './session-api-mutation-contract.mjs';
import { RUN_API_LIST_SCAN_LIMIT, RUN_API_EVENT_SCAN_LIMIT, RUN_API_EVENT_TEXT_BYTES,
  projectApiRun, projectApiRunEvent, runApiHash, parseRunCancellation } from './run-api-contract.mjs';

export async function readApiRun(sessionId, runId) {
  const run = await getRunAcceptanceEvidence(runId);
  if (!run || run.sessionId !== sessionId)
    throw sessionApiError('RESOURCE_NOT_FOUND', 404, 'Run is unavailable in this Session');
  return run;
}
export async function scopedRunRead(sessionId, scope, read) {
  await readSessionApiScope(sessionId, scope);
  const result = await read(); // Files, decompression and waits never hold the metadata actor.
  await readSessionApiScope(sessionId, scope);
  return result;
}
export async function listApiRuns(sessionId, scope, { limit, cursor }) {
  return scopedRunRead(sessionId, scope, async () => {
    const rows = await listRunIndexEntries({ sessionId, limit: RUN_API_LIST_SCAN_LIMIT + 1, reverse: true });
    if (rows.length > RUN_API_LIST_SCAN_LIMIT)
      throw sessionApiError('RESOURCE_LIMIT', 413, 'Run listing exceeds this contract snapshot limit');
    const ids = rows.map(row => row.id);
    const digest = runApiHash([sessionId, scope.expectedScopeRevision, scope.expectedProjectId, ids]);
    let offset = 0;
    if (cursor != null) {
      const match = /^([a-f0-9]{64}):(0|[1-9][0-9]{0,3})$/.exec(cursor);
      if (!match) throw sessionApiError('INVALID_ARGUMENT', 400, 'Invalid Run list cursor');
      offset = Number(match[2]);
      if (match[1] !== digest || offset >= ids.length)
        throw sessionApiError('CURSOR_STALE', 409, 'Run list membership changed');
    }
    const runs = [];
    for (const id of ids.slice(offset, offset + limit)) runs.push(projectApiRun(await readApiRun(sessionId, id)));
    const next = offset + runs.length;
    return { version: 1, sessionId, runs, nextCursor: next < ids.length ? `${digest}:${next}` : null };
  });
}
function assertHistoryBoundary(original, latest, afterSeq = 0) {
  if (original.historyRevision !== latest.historyRevision || latest.latestSeq < original.latestSeq || afterSeq > latest.latestSeq)
    throw sessionApiError('CURSOR_STALE', 409, 'Run history boundary changed');
}
async function hydrateSelected(sessionId, event, meta, maxBytes) {
  if (!event.bodyAvailable || event.bodyLoaded !== false || !event.bodyField) return event;
  const body = await readEventBody(sessionId, event.seq, { strict: true, metaOverride: meta, maxBytes });
  if (!body) return event;
  return { ...event, [body.field]: body.value, bodyLoaded: true, bodyTruncated: body.truncated === true };
}
export async function readApiRunEvents(sessionId, runId, scope, { afterSeq, historyRevision, limit }) {
  return scopedRunRead(sessionId, scope, async () => {
    await readApiRun(sessionId, runId);
    const meta = await loadMeta(sessionId, { strict: true, recover: false });
    if ((historyRevision != null && historyRevision !== meta.historyRevision) || afterSeq > meta.latestSeq)
      throw sessionApiError('CURSOR_STALE', 409, 'Run history cursor changed');
    if (afterSeq > 0 && historyRevision == null)
      throw sessionApiError('INVALID_ARGUMENT', 400, 'A continued event cursor requires the history revision');
    const page = await readEventsPage(sessionId, { strict: true, metaOverride: meta,
      direction: 'forward', afterSeq, limit: RUN_API_EVENT_SCAN_LIMIT, includeBodies: false, maxResponseBytes: 256 * 1024, priority: 'interactive' });
    let scannedThrough = afterSeq; let bytes = 0;
    const events = [];
    for (const event of page.events) {
      if (projectApiRunEvent(event, runId)) {
        const projected = projectApiRunEvent(await hydrateSelected(sessionId, event, meta, RUN_API_EVENT_TEXT_BYTES), runId);
        const size = Buffer.byteLength(JSON.stringify(projected));
        if (events.length >= limit || bytes + size > 64 * 1024) break;
        events.push(projected); bytes += size;
      }
      scannedThrough = event.seq;
    }
    // An empty filtered page still advances the Session sequence. It never
    // reports unrelated events, nor loops forever before this Run's first event.
    const latest = await loadMeta(sessionId, { strict: true, recover: false });
    assertHistoryBoundary(meta, latest, afterSeq);
    await readApiRun(sessionId, runId);
    return { version: 1, sessionId, runId, historyRevision: meta.historyRevision,
      events, scannedThrough, latestSeq: latest.latestSeq, hasMore: scannedThrough < latest.latestSeq };
  });
}
async function strictPublicationHistory(sessionId, runId, { allowedRunIds = [runId], requestId = null } = {}) {
  const meta = await loadMeta(sessionId, { strict: true, recover: false });
  const matches = []; let beforeSeq = 0; let scanned = 0;
  const allowed = new Set(allowedRunIds);
  while (scanned < 8192) {
    const page = await readEventsPage(sessionId, { strict: true, metaOverride: meta,
      direction: 'latest', beforeSeq, limit: 128, includeBodies: false, priority: 'interactive' });
    if (!page.events.length) break;
    scanned += page.events.length;
    for (const event of page.events) {
      const eventRun = event.runId || event.resultRunId;
      if (eventRun ? allowed.has(eventRun) : requestId && event.requestId === requestId) matches.push(event);
    }
    if (matches.length >= 4096)
      throw sessionApiError('RESOURCE_LIMIT', 413, 'Run result exceeds retained event limits');
    if (!page.pagination.hasMoreBefore) break;
    beforeSeq = page.pagination.nextBeforeSeq;
    if (scanned >= 8192)
      throw sessionApiError('RESOURCE_LIMIT', 413, 'Run result requires a larger history scan');
  }
  // Only matching assistant messages need body hydration. Publication performs
  // final Run ownership checks before any body can enter its public projection.
  let remaining = 128 * 1024;
  const hydrated = [];
  for (const event of matches.sort((a, b) => a.seq - b.seq)) {
    if (event.type === 'message' && event.role === 'assistant' && event.bodyAvailable && event.bodyLoaded === false && remaining > 0) {
      const item = await hydrateSelected(sessionId, event, meta, Math.min(48 * 1024, remaining));
      remaining -= Math.min(48 * 1024, remaining);
      hydrated.push(item);
    } else hydrated.push(event);
  }
  assertHistoryBoundary(meta, await loadMeta(sessionId, { strict: true, recover: false }));
  return hydrated;
}
export async function readApiRunResult(sessionId, runId, scope) {
  return scopedRunRead(sessionId, scope, async () => {
    const run = await readApiRun(sessionId, runId);
    const publication = run.state === 'completed' ? await getRetainedRunReplyPublication(run,
      { readHistory: strictPublicationHistory, readRun: getRunAcceptanceEvidence }) : null;
    const latest = await readApiRun(sessionId, runId);
    if (runApiHash([run.state, run.replyPublication]) !== runApiHash([latest.state, latest.replyPublication]))
      throw sessionApiError('REVISION_CONFLICT', 409, 'Run publication changed during result reading');
    const result = projectMessageResult({ sessionId, requestId: run.requestId, runId, state: 'accepted', queued: run.state === 'queued' }, run, publication);
    if (run.state === 'queued') result.state = 'queued';
    if (run.state === 'accepted') result.state = 'checking';
    // The private request key is not part of this exact-Run public interface.
    delete result.requestId;
    return { ...result, version: 1 };
  });
}
const waiters = new Map(); let totalWaiters = 0;
export async function waitApiRun(sessionId, runId, scope, { afterRevision, timeoutMs, signal, authorize }) {
  const count = waiters.get(sessionId) || 0;
  if (count >= 8 || totalWaiters >= 64)
    throw sessionApiError('RESOURCE_LIMIT', 429, 'Run wait capacity is full');
  waiters.set(sessionId, count + 1); totalWaiters++;
  const end = performance.now() + timeoutMs;
  try {
    while (true) {
      signal?.throwIfAborted();
      if (authorize) await authorize();
      const run = await scopedRunRead(sessionId, scope, async () => projectApiRun(await readApiRun(sessionId, runId)));
      const changed = run.revision !== afterRevision;
      if (changed || run.terminal || performance.now() >= end)
        return { version: 1, sessionId, runId, run, changed, timedOut: !changed && !run.terminal };
      await delay(Math.min(250, Math.max(1, end - performance.now())), null, { signal });
    }
  } finally {
    totalWaiters--; const remaining = (waiters.get(sessionId) || 1) - 1;
    if (remaining) waiters.set(sessionId, remaining); else waiters.delete(sessionId);
  }
}
export async function cancelApiRun(sessionId, runId, scope, request, { authorize = null, authorizeWrite = null } = {}) {
  parseRunCancellation(request);
  await readApiRun(sessionId, runId);
  return withSessionApiScope(sessionId, scope, async () => {
    // Revalidate after queued actor admission. No expired command starts a new effect.
    parseRunCancellation(request);
    const current = await readApiRun(sessionId, runId);
    parseRunCancellation(request);
    await authorize?.(current);
    if (isTerminalRunState(current.state)) return { version: 1, run: projectApiRun(current), disposition: 'already_terminal' };
    const beforeWrite = () => { parseRunCancellation(request); };
    if (current.runnerLaunchMode === 'restricted-candidate-host' && current.restrictedExecution?.version === 1) {
      // The restricted host owns its Job. Never signal an Owner sidecar/PID or
      // claim termination here; persist intent for its scoped cancellation poll.
      const leaseId = current.restrictedExecution.leaseId;
      const updated = await requestRunCancel(runId, { authorizeWrite, beforeWrite: next => {
        beforeWrite();
        if (next.restrictedExecution?.leaseId !== leaseId || next.sessionId !== sessionId)
          throw sessionApiError('RUN_IDENTITY_CONFLICT', 409, 'Restricted execution identity changed');
      } });
      return { version: 1, run: projectApiRun(updated), disposition: 'cancellation_requested' };
    }
    let updated = current.appApiMessageVersion === 1 && current.appApiMessageQueue
      ? await cancelQueuedMessageRun(runId, { beforeWrite, authorizeWrite }) : null;
    if (!updated) updated = await cancelActiveRun(sessionId, { expectedRunId: runId, reconcile: false, beforeWrite, authorizeWrite });
    if (!updated) {
      const observed = await readApiRun(sessionId, runId);
      if (!isTerminalRunState(observed.state))
        throw sessionApiError('RUN_IDENTITY_CONFLICT', 409, 'Run no longer owns this Session execution');
      return { version: 1, run: projectApiRun(observed), disposition: 'already_terminal' };
    }
    if (updated.id !== runId || updated.sessionId !== sessionId)
      throw sessionApiError('RUN_IDENTITY_CONFLICT', 409, 'Run cancellation identity changed');
    return { version: 1, run: projectApiRun(updated), disposition: 'cancellation_requested' };
  });
}
