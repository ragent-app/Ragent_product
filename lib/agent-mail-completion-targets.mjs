import { readFile } from 'fs/promises';

import {
  buildAssistantReplyAttachmentFallbackText,
  classifyAssistantReplyCandidate,
  getAssistantReplyAttachments,
  stripHiddenBlocks,
} from './reply-selection.mjs';
import { readEventBody, readEventsPage } from '../chat/history.mjs';
import { materializeFileAssetAttachments } from '../chat/file-assets.mjs';
import {
  buildReplyPublicationPayload,
  collectReplyPublicationRunIds,
  getRunResponseIds,
} from '../chat/reply-publication.mjs';
import { getRun, updateRun } from '../chat/runs.mjs';
import { sendOutboundEmail } from './agent-mail-outbound.mjs';
import { loadIdentity, loadOutboundConfig, updateQueueItem } from './agent-mailbox.mjs';
import { resolveEmailConnectorBinding } from './connector-bindings.mjs';

const TARGET_STALE_MS = 60 * 1000;
const MAX_REPLY_PUBLICATION_EVENTS = 4096;
const REPLY_CANDIDATE_PAGE_SIZE = 256;
const REPLY_PUBLICATION_PAGE_SIZE = 256;
const REPLY_PUBLICATION_BODY_CONCURRENCY = 8;
const MAX_REPLY_PUBLICATION_BODY_BYTES = 256 * 1024;
const REPLY_PUBLICATION_CACHE_TTL_MS = 30 * 1000;
const REPLY_PUBLICATION_CACHE_MAX_ENTRIES = 64;
const REPLY_PUBLICATION_CACHE_MAX_BYTES = 8 * 1024 * 1024;
const replyPublicationHistoryCache = new Map();

function nowIso() {
  return new Date().toISOString();
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const trimmed = trimString(value);
    if (trimmed) return trimmed;
  }
  return '';
}

function normalizeSubject(value) {
  return trimString(value);
}

function targetStateIsStale(state) {
  const startedAt = Date.parse(state?.startedAt || '');
  if (!Number.isFinite(startedAt)) return true;
  return (Date.now() - startedAt) > TARGET_STALE_MS;
}

function summarizeDeliveryResult(result) {
  return {
    provider: trimString(result?.provider),
    requestedProvider: trimString(result?.requestedProvider),
    fallbackFromProvider: trimString(result?.fallbackFromProvider),
    fallbackReason: trimString(result?.fallbackReason),
    statusCode: Number.isInteger(result?.statusCode) ? result.statusCode : null,
    responseId: firstNonEmpty(result?.summary?.id, result?.response?.id, result?.response?.messageId),
    responseMessage: firstNonEmpty(result?.summary?.message, result?.response?.message),
  };
}

function sanitizeEmailTarget(target, index) {
  const to = trimString(target?.to);
  if (!to) return null;
  const id = firstNonEmpty(target?.id, `email_target_${index + 1}`);
  return {
    id,
    type: 'email',
    enabled: target?.enabled !== false,
    requestId: trimString(target?.requestId),
    responseId: trimString(target?.responseId),
    bindingId: trimString(target?.bindingId),
    to,
    from: trimString(target?.from),
    subject: normalizeSubject(target?.subject),
    inReplyTo: trimString(target?.inReplyTo),
    references: trimString(target?.references),
    mailboxRoot: trimString(target?.mailboxRoot),
    mailboxItemId: trimString(target?.mailboxItemId),
  };
}

export function sanitizeEmailCompletionTargets(targets = []) {
  if (!Array.isArray(targets)) return [];
  return targets
    .map((target, index) => {
      const type = trimString(target?.type || target?.kind).toLowerCase();
      if (type !== 'email') return null;
      return sanitizeEmailTarget(target, index);
    })
    .filter(Boolean);
}

async function buildOutboundReplyAttachments(event) {
  const requestedAttachments = getAssistantReplyAttachments(event);
  return buildOutboundReplyAttachmentsFromRefs(requestedAttachments);
}

async function buildOutboundReplyAttachmentsFromRefs(requestedAttachments = []) {
  if (requestedAttachments.length === 0) {
    return [];
  }

  const materializedAttachments = await materializeFileAssetAttachments(requestedAttachments);
  return await Promise.all(materializedAttachments.map(async (attachment) => {
    const savedPath = trimString(attachment?.savedPath);
    if (!savedPath) {
      throw new Error('Assistant attachment could not be materialized for outbound delivery');
    }
    const buffer = await readFile(savedPath);
    return {
      filename: firstNonEmpty(attachment?.originalName, attachment?.filename, 'attachment'),
      contentType: firstNonEmpty(attachment?.mimeType, 'application/octet-stream'),
      contentBase64: buffer.toString('base64'),
      sourcePath: savedPath,
    };
  }));
}

function eventBelongsToReplyPublication(event, runIds, responseIds) {
  if (!(event && typeof event === 'object')) return false;
  const runId = trimString(event.runId);
  if (runId && runIds.has(runId)) return true;
  const resultRunId = trimString(event.resultRunId);
  if (resultRunId && runIds.has(resultRunId)) return true;
  const responseId = trimString(event.responseId);
  return !!(responseId && responseIds.has(responseId));
}

async function hydrateReplyMessageBodies(sessionId, events = []) {
  const source = Array.isArray(events) ? events : [];
  if (source.length === 0) return [];
  const hydrated = new Array(source.length);
  let cursor = 0;
  const workerCount = Math.min(REPLY_PUBLICATION_BODY_CONCURRENCY, source.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= source.length) return;
      const event = source[index];
      if (event?.type !== 'message' || event.role !== 'assistant'
        || event.bodyLoaded !== false || !event.bodyAvailable) {
        hydrated[index] = event;
        continue;
      }
      const body = await readEventBody(sessionId, event.seq, {
        maxBytes: MAX_REPLY_PUBLICATION_BODY_BYTES,
      }).catch(() => null);
      if (!body || typeof body.value !== 'string') {
        hydrated[index] = event;
        continue;
      }
      hydrated[index] = {
        ...event,
        [body.field]: body.value,
        bodyLoaded: true,
      };
    }
  }));
  return hydrated;
}

async function loadReplyPublicationHistory(sessionId, rootRun) {
  const cacheKey = `${sessionId}:${JSON.stringify({
    runs: collectReplyPublicationRunIds(rootRun),
    responses: getRunResponseIds(rootRun),
  })}`;
  const cached = replyPublicationHistoryCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    // Refresh insertion order for a small LRU-like cache without retaining
    // expired or unbounded session payloads.
    replyPublicationHistoryCache.delete(cacheKey);
    replyPublicationHistoryCache.set(cacheKey, cached);
    return cached.events;
  }
  if (cached) replyPublicationHistoryCache.delete(cacheKey);

  const selected = [];
  const runIds = new Set(collectReplyPublicationRunIds(rootRun));
  const responseIds = new Set(getRunResponseIds(rootRun));
  const responseIdsFound = new Set();
  const responseStartsFound = new Set();
  const runStartsFound = new Set();
  let beforeSeq = 0;
  let pagesRead = 0;
  const maxPages = Math.ceil(MAX_REPLY_PUBLICATION_EVENTS / REPLY_PUBLICATION_PAGE_SIZE) + 1;
  while (true) {
    pagesRead += 1;
    const page = await readEventsPage(sessionId, {
      direction: 'latest',
      beforeSeq,
      limit: REPLY_PUBLICATION_PAGE_SIZE,
      includeBodies: false,
      includeMessageBodies: false,
    }).catch(() => null);
    const events = Array.isArray(page?.events) ? page.events : [];
    if (events.length === 0) break;

    // The page is chronological even for a latest/backward request. Walk it
    // newest-first so a completed Run normally needs only one page. Keep the
    // newest bounded tail, matching the old MAX_REPLY_PUBLICATION_EVENTS
    // contract without retaining an entire long-session transcript.
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      const eventRunId = trimString(event?.runId);
      const eventResponseId = trimString(event?.responseId);
      const sameRun = eventRunId && runIds.has(eventRunId);
      const sameResponse = eventResponseId && responseIds.has(eventResponseId);
      if (!sameRun && !sameResponse) continue;
      selected.push(event);
      if (selected.length > MAX_REPLY_PUBLICATION_EVENTS) selected.pop();
      if (sameResponse) responseIdsFound.add(eventResponseId);
      // The user message is the natural start boundary for a Run. Some
      // connector paths attach only the responseId to that message, so both
      // bindings count as a boundary.
      if (event?.type === 'message' && event.role === 'user') {
        if (sameRun) runStartsFound.add(eventRunId);
        if (sameResponse) responseStartsFound.add(eventResponseId);
      }
    }

    const runsComplete = runIds.size === 0 || runStartsFound.size >= runIds.size;
    const responsesComplete = responseIds.size === 0 || responseIdsFound.size >= responseIds.size;
    const responseStartsComplete = responseIds.size === 0 || responseStartsFound.size >= responseIds.size;
    if (selected.length >= MAX_REPLY_PUBLICATION_EVENTS
      || (responsesComplete && (runsComplete || responseStartsComplete))
      || pagesRead >= maxPages) break;
    if (page?.pagination?.hasMoreBefore !== true) break;
    const nextBeforeSeq = Number.isInteger(page?.pagination?.nextBeforeSeq)
      ? page.pagination.nextBeforeSeq
      : 0;
    if (nextBeforeSeq < 2 || nextBeforeSeq === beforeSeq) break;
    beforeSeq = nextBeforeSeq;
  }
  selected.sort((left, right) => (left?.seq || 0) - (right?.seq || 0));
  const history = await hydrateReplyMessageBodies(sessionId, selected);
  let estimatedBytes = 0;
  for (const event of history) {
    estimatedBytes += 512;
    if (typeof event?.content === 'string') estimatedBytes += event.content.length;
    if (Array.isArray(event?.attachments)) estimatedBytes += event.attachments.length * 256;
    if (estimatedBytes > REPLY_PUBLICATION_CACHE_MAX_BYTES) break;
  }
  if (estimatedBytes <= REPLY_PUBLICATION_CACHE_MAX_BYTES) {
    while (replyPublicationHistoryCache.size >= REPLY_PUBLICATION_CACHE_MAX_ENTRIES) {
      const oldest = replyPublicationHistoryCache.keys().next().value;
      if (oldest === undefined) break;
      replyPublicationHistoryCache.delete(oldest);
    }
    replyPublicationHistoryCache.set(cacheKey, {
      events: history,
      expiresAt: Date.now() + REPLY_PUBLICATION_CACHE_TTL_MS,
    });
  }
  return history;
}

async function findLatestReplyCandidate(sessionId, run) {
  // Reply events are appended at the end of the session.  Walk backward in
  // bounded pages and stop as soon as the newest usable candidate is found;
  // the previous forward scan paid O(session event count) for every outbound
  // email even when the run had just completed in the newest page.
  const runId = trimString(run?.id);
  const requestId = trimString(run?.requestId);
  if (!runId && !requestId) return null;
  let beforeSeq = 0;
  let attachmentFallback = null;
  let checklistFallback = null;

  while (true) {
    const page = await readEventsPage(sessionId, {
      direction: 'latest',
      beforeSeq,
      limit: REPLY_CANDIDATE_PAGE_SIZE,
      includeBodies: false,
      includeMessageBodies: false,
    });
    const events = Array.isArray(page?.events) ? page.events : [];
    if (events.length === 0) break;

    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.type !== 'message' || event.role !== 'assistant') continue;
      if (runId && trimString(event.runId) !== runId
        && (!requestId || trimString(event.requestId) !== requestId)) {
        continue;
      }
      if (!runId && requestId && trimString(event.requestId) !== requestId) continue;

      let candidateEvent = event;
      if (candidateEvent.bodyAvailable && candidateEvent.bodyLoaded === false) {
        const body = await readEventBody(sessionId, candidateEvent.seq).catch(() => null);
        if (body && typeof body.value === 'string') {
          candidateEvent = {
            ...candidateEvent,
            [body.field]: body.value,
            bodyLoaded: true,
          };
        }
      }

      const candidate = classifyAssistantReplyCandidate(candidateEvent);
      if (candidate.kind === 'select') return candidateEvent;
      if (candidate.kind === 'fallback_attachment' && !attachmentFallback) {
        attachmentFallback = candidateEvent;
      }
      if (candidate.kind === 'fallback_checklist' && !checklistFallback) {
        checklistFallback = candidateEvent;
      }
    }

    if (page?.pagination?.hasMoreBefore !== true) break;
    const nextBeforeSeq = Number.isInteger(page?.pagination?.nextBeforeSeq)
      ? page.pagination.nextBeforeSeq
      : 0;
    if (nextBeforeSeq < 2 || nextBeforeSeq === beforeSeq) break;
    beforeSeq = nextBeforeSeq;
  }

  return attachmentFallback || checklistFallback;
}

async function resolveAssistantReply(sessionId, run, target = null) {
  const responseId = trimString(target?.responseId || run?.responseId);
  if (responseId) {
    const rootRunId = trimString(run?.replyPublicationRootRunId) || trimString(run?.id);
    const rootRun = rootRunId && rootRunId !== run.id
      ? (await getRun(rootRunId) || run)
      : run;
    const publicationHistory = await loadReplyPublicationHistory(sessionId, rootRun);
    const payload = buildReplyPublicationPayload(publicationHistory, rootRun);
    const attachments = await buildOutboundReplyAttachmentsFromRefs(payload.attachments || []);
    const fallbackText = attachments.length > 0
      ? buildAssistantReplyAttachmentFallbackText({
          attachments: payload.attachments || [],
          images: payload.attachments || [],
        })
      : '';
    const replyBody = stripHiddenBlocks(payload.text || '') || fallbackText;

    if (!replyBody && attachments.length === 0) {
      throw new Error('No assistant reply content was found for this response');
    }

    return {
      assistantMessage: null,
      content: replyBody,
      attachments,
    };
  }

  const assistantMessage = await findLatestReplyCandidate(sessionId, run);

  const content = stripHiddenBlocks(assistantMessage?.content || '');
  const attachments = await buildOutboundReplyAttachments(assistantMessage);
  const fallbackText = attachments.length > 0
    ? buildAssistantReplyAttachmentFallbackText(assistantMessage)
    : '';
  const replyBody = content || fallbackText;

  if (!replyBody && attachments.length === 0) {
    throw new Error('No assistant reply content was found for this run');
  }

  return {
    assistantMessage,
    content: replyBody,
    attachments,
  };
}

async function updateMailboxDelivery(target, session, run, state, extra = {}) {
  if (!target.mailboxRoot || !target.mailboxItemId) return;
  await updateQueueItem(target.mailboxItemId, target.mailboxRoot, (item) => {
    item.status = state === 'sent'
      ? 'reply_sent'
      : state === 'failed'
        ? 'reply_failed'
        : 'processing_for_reply';
    item.automation = {
      ...(item.automation || {}),
      status: item.status,
      sessionId: session?.id || item.automation?.sessionId || null,
      runId: run?.id || item.automation?.runId || null,
      requestId: run?.requestId || item.automation?.requestId || null,
      responseId: run?.responseId || item.automation?.responseId || null,
      updatedAt: nowIso(),
      ...(state === 'sent'
        ? {
            lastError: null,
            repliedAt: nowIso(),
            delivery: {
              ...(item.automation?.delivery || {}),
              ...extra,
            },
          }
        : state === 'failed'
          ? { lastError: trimString(extra.error) }
          : {}),
    };
    return item;
  });
}

async function deliverEmailTarget(target, session, run, options = {}, resolvedReply = null, beforeSend = async () => {}) {
  const { content, attachments } = resolvedReply || await resolveAssistantReply(session.id, run, target);
  const binding = await resolveEmailConnectorBinding({
    bindingId: target.bindingId,
    rootDir: target.mailboxRoot,
    ensureStored: false,
  });
  const mailboxRoot = binding?.mailboxRoot || target.mailboxRoot || undefined;
  if (binding?.capabilityState === 'binding_required') {
    throw new Error('This instance does not have an email binding yet.');
  }
  if (binding?.capabilityState === 'authorization_required') {
    throw new Error('This instance has an email binding, but outbound authorization is incomplete.');
  }

  const outboundConfig = await loadOutboundConfig(mailboxRoot);
  const identity = await loadIdentity(mailboxRoot);
  // Persist this boundary before invoking the provider: a process failure or
  // transport error after this point cannot prove that the email was not sent.
  await beforeSend();
  const result = await sendOutboundEmail({
    to: target.to,
    from: firstNonEmpty(target.from, outboundConfig.from, identity?.address),
    subject: target.subject,
    text: content,
    inReplyTo: target.inReplyTo,
    references: target.references,
    ...(attachments.length > 0 ? { attachments } : {}),
  }, outboundConfig, { ...options, noTransportReplay: true });

  const summary = summarizeDeliveryResult(result);
  summary.externalId = summary.responseId;
  summary.bindingId = trimString(binding?.id);
  if (attachments.length > 0) {
    summary.attachmentCount = attachments.length;
  }
  await updateMailboxDelivery(target, session, run, 'sent', summary);
  return summary;
}

function shouldDispatchTarget(target, run, currentState) {
  if (!target?.enabled) return false;
  if (target.responseId && trimString(run?.responseId) !== target.responseId) return false;
  if (!target.responseId && target.requestId && trimString(run?.requestId) !== target.requestId) return false;
  if (currentState?.state === 'sent') return false;
  if (currentState?.state === 'sending' || currentState?.state === 'unknown_outcome') return false;
  if (currentState?.state === 'failed' && currentState.safeToRetry !== true) return false;
  return true;
}

export async function dispatchSessionEmailCompletionTargets(session, run, options = {}) {
  const targets = sanitizeEmailCompletionTargets(session?.completionTargets || []);
  if (!session?.id || !run?.id || targets.length === 0) {
    return [];
  }

  const results = [];
  // Several completion targets can share one response. Resolve the assistant
  // payload once per target identity and reuse the in-flight promise so a
  // multi-recipient delivery does not repeat a large-session history scan or
  // re-materialize the same attachments.
  const replyResolutionCache = new Map();
  for (const target of targets) {
    const currentRun = await getRun(run.id) || run;
    const currentState = currentRun.completionTargets?.[target.id] || null;
    if (currentState?.state === 'failed' && currentState.safeToRetry !== true) {
      await updateRun(run.id, (existing) => {
        const current = existing.completionTargets?.[target.id];
        if (current?.state !== 'failed' || current.safeToRetry === true) return existing;
        return { ...existing, completionTargets: { ...existing.completionTargets,
          [target.id]: { ...current, state: 'unknown_outcome', lastError: 'Earlier delivery failure did not record whether the provider was invoked.' } } };
      });
      continue;
    }
    if (currentState?.state === 'sending' && targetStateIsStale(currentState)) {
      await updateRun(run.id, (existing) => {
        const current = existing.completionTargets?.[target.id];
        if (current?.state !== 'sending' || current.startedAt !== currentState.startedAt) return existing;
        return { ...existing, completionTargets: { ...existing.completionTargets,
          [target.id]: { ...current, state: 'unknown_outcome', lastError: 'Delivery result requires verification before retry.' } } };
      });
      const latest = await getRun(run.id);
      if (latest?.completionTargets?.[target.id]?.state === 'unknown_outcome') {
        results.push({ id: target.id, bindingId: trimString(target.bindingId), state: 'unknown_outcome' });
      }
      continue;
    }
    if (!shouldDispatchTarget(target, currentRun, currentState)) {
      continue;
    }

    const startedAt = nowIso();
    let claimed = false;
    await updateRun(run.id, (existing) => {
      if (!shouldDispatchTarget(target, existing, existing.completionTargets?.[target.id])) return existing;
      claimed = true;
      return { ...existing, completionTargets: {
        ...(existing.completionTargets || {}),
        [target.id]: { ...(existing.completionTargets?.[target.id] || {}), state: 'sending', startedAt,
          attempts: (existing.completionTargets?.[target.id]?.attempts || 0) + 1, lastError: null, safeToRetry: false },
      } };
    });
    if (!claimed) continue;
    await updateMailboxDelivery(target, session, currentRun, 'sending');

    let providerInvoked = false;
    try {
      const replyKey = target.responseId
        || target.requestId
        || trimString(currentRun.responseId)
        || trimString(currentRun.id);
      let replyPromise = replyResolutionCache.get(replyKey);
      if (!replyPromise) {
        replyPromise = resolveAssistantReply(session.id, currentRun, target);
        replyResolutionCache.set(replyKey, replyPromise);
      }
      const summary = await deliverEmailTarget(
        target,
        session,
        currentRun,
        options,
        await replyPromise,
        async () => {
          await updateRun(run.id, (existing) => ({ ...existing, completionTargets: {
            ...existing.completionTargets,
            [target.id]: { ...existing.completionTargets?.[target.id], providerInvokedAt: nowIso() },
          } }));
          providerInvoked = true;
        },
      );
      const deliveredAt = nowIso();
      await updateRun(run.id, (existing) => ({
        ...existing,
        completionTargets: {
          ...(existing.completionTargets || {}),
          [target.id]: {
            ...(existing.completionTargets?.[target.id] || {}),
            state: 'sent',
            deliveredAt,
            delivery: summary,
            lastError: null,
          },
        },
      }));
      results.push({ id: target.id, bindingId: summary.bindingId, state: 'sent', delivery: summary });
    } catch (error) {
      const failedAt = nowIso();
      const state = providerInvoked ? 'unknown_outcome' : 'failed';
      await updateRun(run.id, (existing) => ({
        ...existing,
        completionTargets: {
          ...(existing.completionTargets || {}),
          [target.id]: {
            ...(existing.completionTargets?.[target.id] || {}),
            state,
            safeToRetry: !providerInvoked,
            failedAt,
            lastError: error.message,
          },
        },
      }));
      await updateMailboxDelivery(target, session, currentRun, state, { error: error.message });
      results.push({ id: target.id, bindingId: trimString(target.bindingId), state, error: error.message });
    }
  }

  return results;
}

// Human observations are kept separate from a provider receipt and do not
// automatically authorize another send or turn an unknown outcome into sent.
export async function recordEmailDeliveryReview({ runId, targetId, observation, evidence }, actor) {
  if (actor?.kind !== 'user' || actor?.role !== 'owner' || !trimString(actor.principalId)) throw Object.assign(new Error('Owner access required'), { statusCode: 403 });
  if (!trimString(runId) || !trimString(targetId) || !['observed_present', 'observed_absent', 'inconclusive'].includes(observation)
      || !trimString(evidence) || evidence.length > 2000) throw Object.assign(new Error('Invalid delivery review'), { statusCode: 400 });
  let review;
  await updateRun(runId, (existing) => {
    const current = existing.completionTargets?.[targetId];
    if (current?.state !== 'unknown_outcome') throw Object.assign(new Error('Delivery outcome is not unknown'), { statusCode: 409 });
    review = { observation, evidence: evidence.trim(), actorId: actor.principalId, reviewedAt: nowIso(), source: 'human' };
    return { ...existing, completionTargets: { ...existing.completionTargets,
      [targetId]: { ...current, manualReviews: [...(current.manualReviews || []).slice(-19), review] } } };
  });
  if (!review) throw Object.assign(new Error('Run not found'), { statusCode: 404 });
  return { runId, targetId, state: 'unknown_outcome', review };
}
