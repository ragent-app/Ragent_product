import { stripEventAttachmentSavedPaths } from './attachment-utils.mjs';
import { projectMessageTimelineIdentities, withMessageTimelineIdentity } from './message-timeline.mjs';
import {
  rewriteAssistantLocalResultFileReferences,
  rewriteAssistantLocalMarkdownImageTargets,
  stripAssistantArtifactDeliveryHints,
} from './session-result-files.mjs';
import {
  isClaudeLifecycleStatusEvent,
  isCodexAppServerLifecycleStatusEvent,
  isProviderUsageLimitStatusEvent,
  isTransientProviderReconnectStatusEvent,
} from './provider-runtime-noise.mjs';
import { buildOperationProjection } from './operation-projection.mjs';
import { createApprovedActionClientEventProjection } from './approved-actions.mjs';
import {
  createAssistantControlBlockStream,
  stripAssistantControlBlocks,
} from './assistant-control-blocks.mjs';
import { createClaudeFinalizedAssistantReplayFingerprint } from './provider-event-dedup.mjs';
import {
  extractAnsweredQuestionItemIds,
  normalizeAsyncQuestionReplies,
  parseAsyncQuestionItemId,
  parseAsyncQuestionReplyEnvelope,
} from './codex-async-question-reply.mjs';

const INTERNAL_TYPES = new Set(['manager_context']);
const STREAM_LIMIT = 128;
const MESSAGE_SCOPE_CANDIDATE_LIMIT = 64;
const activeControlStreams = new Map();

function clone(value) {
  if (value === null || value === undefined) return value;
  return JSON.parse(JSON.stringify(value));
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function seqOf(event) {
  return Number.isInteger(event?.seq) && event.seq > 0 ? event.seq : 0;
}

function isSuppressed(event) {
  return event?.systemPromptKey === 'agent.perMessageSystemPrompt'
    || event?.source === 'context_compaction_handoff'
    || event?.type === 'context_barrier'
    || (event?.type === 'context_operation' && event.operation === 'write_memory')
    || isClaudeLifecycleStatusEvent(event)
    || isCodexAppServerLifecycleStatusEvent(event)
    || isProviderUsageLimitStatusEvent(event)
    || isTransientProviderReconnectStatusEvent(event);
}

function isTransportStatus(event) {
  if (event?.type !== 'status') return false;
  const content = text(event.content).toLowerCase();
  return content === 'thinking' || content === 'completed';
}

function isVisible(event) {
  if (!(event && typeof event === 'object') || isSuppressed(event) || isTransportStatus(event)) return false;
  if (INTERNAL_TYPES.has(event.type)) return false;
  if (event.type === 'message') {
    const content = typeof event.content === 'string' ? stripAssistantControlBlocks(event.content).trim() : '';
    const hasAsyncQuestions = Array.isArray(event.asyncQuestions) && event.asyncQuestions.length > 0;
    const isAsyncDelivery = text(event.messageDelivery || event.delivery) === 'async';
    return Boolean(
      content
      || hasAsyncQuestions
      || isAsyncDelivery
      || (Array.isArray(event.attachments) && event.attachments.length > 0)
      || (Array.isArray(event.images) && event.images.length > 0)
    );
  }
  return [
    'plan', 'operation', 'attachment_delivery', 'approval_request', 'approval_response',
    'privileged_batch_request', 'privileged_batch_response', 'privileged_exec_result',
    'approved_action_batch_request', 'approved_action_batch_response', 'approved_action_state',
    'run_regenerate',
    'context_barrier', 'context_operation', 'usage', 'status',
  ].includes(event.type);
}

function buildRewriteMap(events, key) {
  const map = new Map();
  for (const event of events) {
    for (const entry of Array.isArray(event?.[key]) ? event[key] : []) {
      const seq = Number.isInteger(entry?.seq) ? entry.seq : 0;
      const candidate = text(entry?.candidate);
      const url = text(entry?.url);
      if (seq > 0 && candidate && url) {
        if (!map.has(seq)) map.set(seq, new Map());
        map.get(seq).set(candidate, url);
      }
    }
  }
  return map;
}

function sanitize(event, { markdownRewrites, resultRewrites } = {}) {
  const next = stripEventAttachmentSavedPaths(clone(event));
  if (!(next && typeof next === 'object')) return next;
  if (next.type === 'message' && next.role === 'assistant' && typeof next.content === 'string') {
    next.content = stripAssistantArtifactDeliveryHints(stripAssistantControlBlocks(next.content), {
      rewriteLocalResultFileReferences: false,
    });
    next.content = rewriteAssistantLocalMarkdownImageTargets(next.content, markdownRewrites?.get(seqOf(next)) || null);
    next.content = rewriteAssistantLocalResultFileReferences(next.content, resultRewrites?.get(seqOf(next)) || null);
  }
  for (const key of ['bodyRef', 'bodyField', 'bodyAvailable', 'bodyLoaded', 'bodyPreview', 'bodyBytes']) delete next[key];
  return createApprovedActionClientEventProjection(next);
}

function operationIdentity(event) {
  const id = text(event?.operationId || event?.toolCallId || event?.providerToolUseId || event?.providerItemId);
  return `operation:${id || `seq:${seqOf(event) || 'unknown'}`}`;
}

function messageIdentity(event) {
  const role = event?.role === 'user' ? 'user' : (event?.role === 'system' ? 'system' : 'assistant');
  const id = text(event?.messageId || event?.providerMessageId || event?.providerEventId || event?.providerItemId || event?.streamItemId || event?.entityId);
  return `message:${role}:${id || `seq:${seqOf(event) || 'unknown'}`}`;
}

function annotateEntities(events) {
  return events.map((event) => {
    if (text(event?.timelineEntityId)) return event;
    if (event.type === 'operation') return { ...event, timelineEntityId: operationIdentity(event) };
    if (event.type === 'message') return { ...event, timelineEntityId: messageIdentity(event) };
    if (event.type === 'thinking_block') return { ...event, timelineEntityId: `thinking:${event.blockStartSeq || seqOf(event) || 'unknown'}` };
    if (event.type === 'plan') return { ...event, timelineEntityId: `plan:${text(event.planId || event.artifactId) || seqOf(event) || 'unknown'}` };
    if (event.type === 'attachment_delivery') return { ...event, timelineEntityId: `attachment:${text(event.deliveryKey) || seqOf(event) || 'unknown'}` };
    return { ...event, timelineEntityId: `${event.type || 'notice'}:${text(event.id || event.eventId) || seqOf(event) || 'unknown'}` };
  });
}

function messageText(event) {
  return typeof event?.content === 'string' ? event.content : '';
}

function relatedMessageText(left, right) {
  const leftText = messageText(left);
  const rightText = messageText(right);
  return !leftText || !rightText
    || leftText === rightText
    || leftText.startsWith(rightText)
    || rightText.startsWith(leftText);
}

function sameMessageScope(left, right) {
  if (left.canonicalMessageId || right.canonicalMessageId) {
    return Boolean(left.canonicalMessageId && left.canonicalMessageId === right.canonicalMessageId);
  }
  const providerKeys = ['streamItemId', 'providerMessageId', 'providerEventId', 'providerItemId'];
  let conflictingSameKindProviderIdentity = false;
  for (const key of providerKeys) {
    const leftValue = text(left?.[key]);
    const rightValue = text(right?.[key]);
    if (!leftValue || !rightValue) continue;
    if (leftValue === rightValue) return true;
    // A live stream item and a final message naturally use different field
    // names, so they may still be aliases of one response. Two different ids
    // in the same provider field, however, are two distinct upstream messages
    // even when their visible bodies happen to match.
    conflictingSameKindProviderIdentity = true;
  }
  if (conflictingSameKindProviderIdentity) return false;
  for (const key of ['runId', 'responseId']) {
    const leftValue = text(left?.[key]);
    const rightValue = text(right?.[key]);
    if (leftValue && rightValue && leftValue !== rightValue) return false;
  }
  for (const key of ['runId', 'responseId', 'requestId']) {
    const leftValue = text(left?.[key]);
    const rightValue = text(right?.[key]);
    if (leftValue && leftValue === rightValue) return true;
  }
  return false;
}

function mergeMessageSnapshot(current, incoming) {
  const currentText = messageText(current);
  const incomingText = messageText(incoming);
  const next = {
    ...current,
    ...incoming,
    // The first snapshot owns chronology. A later provider snapshot is a
    // revision of that row, not a new message after it.
    seq: seqOf(current) || seqOf(incoming),
    timelineEntityId: current.timelineEntityId,
  };
  // Result-asset publication appends an assistant message with an empty
  // body so it can carry attachments and rewrite metadata. That event is a
  // metadata-only revision and must never erase an already-renderable reply.
  // Structured provider snapshots are accumulating, so retain the longest
  // available body when the incoming snapshot is shorter as well.
  next.content = incomingText.length >= currentText.length ? incomingText : currentText;
  if (incoming.canonicalMessageId) {
    next.content = incoming.textMode === 'metadata' ? currentText : incomingText;
    next.firstSeq = current.firstSeq || current.seq;
    next.lastEventSeq = incoming.lastEventSeq || incoming.seq;
  }
  if (Array.isArray(current.attachments) && current.attachments.length > 0
    && (!Array.isArray(incoming.attachments) || incoming.attachments.length === 0)) {
    next.attachments = current.attachments;
  }
  if (Array.isArray(current.images) && current.images.length > 0
    && (!Array.isArray(incoming.images) || incoming.images.length === 0)) {
    next.images = current.images;
  }
  if (Array.isArray(current.asyncQuestions) && current.asyncQuestions.length > 0
    && (!Array.isArray(incoming.asyncQuestions) || incoming.asyncQuestions.length === 0)) {
    next.asyncQuestions = current.asyncQuestions;
  }
  if (text(current.messageDelivery) && !text(incoming.messageDelivery)) {
    next.messageDelivery = current.messageDelivery;
  }
  if (text(current.delivery) && !text(incoming.delivery)) {
    next.delivery = current.delivery;
  }
  if (text(current.asyncQuestionMessageId) && !text(incoming.asyncQuestionMessageId)) {
    next.asyncQuestionMessageId = current.asyncQuestionMessageId;
  }
  if (text(current.asyncQuestionsState) && !text(incoming.asyncQuestionsState)) {
    next.asyncQuestionsState = current.asyncQuestionsState;
  }
  return next;
}

function messageScopeKeys(role, segment, event) {
  if (event.canonicalMessageId) return [`${role}|message:${event.canonicalMessageId}`];
  const prefix = `${role}|${segment}|`;
  const keys = [];
  for (const key of ['streamItemId', 'providerMessageId', 'providerEventId', 'providerItemId']) {
    const value = text(event?.[key]);
    if (value) keys.push(`${prefix}provider:${value}`);
  }
  for (const [label, key] of [['run', 'runId'], ['response', 'responseId'], ['request', 'requestId']]) {
    const value = text(event?.[key]);
    if (value) keys.push(`${prefix}${label}:${value}`);
  }
  return keys;
}

function isClaudeFinalizedSnapshotMessage(event) {
  if (event?.type !== 'message' || event?.role !== 'assistant') return false;
  if (event?.providerSnapshotKind !== 'finalized-assistant') return false;
  const provider = text(event?.provider).toLowerCase();
  const runtimeFamily = text(event?.runtimeFamily).toLowerCase();
  return provider === 'claude'
    || runtimeFamily === 'claude-stream-json'
    || runtimeFamily === 'claude-stream-json-bidi';
}

// Relay re-emissions of a finalized snapshot can arrive under a fresh
// provider message/frame id with an identical, truncated, or extended body.
// Within one unbroken assistant segment of one run, any containment
// relationship (identical, prefix, or shifted-overlap containment) marks the
// pair as revisions of one visible reply. A shifted re-emission (head
// trimmed, tail extended) additionally matches when a long shared
// suffix-of-one / prefix-of-other block exists; the thresholds keep short
// deliberate repetitions visible as two messages. Bodies that merely overlap
// below those bounds stay separate — no global text heuristics.
const CHAIN_OVERLAP_MIN_CHARS = 12;
const CHAIN_OVERLAP_SCAN_CAP = 2000;

function longSuffixPrefixOverlap(left, right) {
  const maxK = Math.min(CHAIN_OVERLAP_SCAN_CAP, left.length, right.length);
  if (maxK < CHAIN_OVERLAP_MIN_CHARS) return 0;
  for (let k = maxK; k >= CHAIN_OVERLAP_MIN_CHARS; k -= 1) {
    if (left.slice(left.length - k) === right.slice(0, k)) return k;
  }
  return 0;
}

function chainSnapshotBodiesRelate(chainEvent, incomingEvent) {
  const chainText = messageText(chainEvent);
  const incomingText = messageText(incomingEvent);
  if (!chainText || !incomingText) return false;
  if (chainText === incomingText
    || chainText.includes(incomingText)
    || incomingText.includes(chainText)) return true;
  const shorterLength = Math.min(chainText.length, incomingText.length);
  if (shorterLength < CHAIN_OVERLAP_MIN_CHARS * 2) return false;
  const overlap = longSuffixPrefixOverlap(chainText, incomingText)
    || longSuffixPrefixOverlap(incomingText, chainText);
  return overlap >= CHAIN_OVERLAP_MIN_CHARS && overlap * 2 >= shorterLength;
}

function messageReplayFingerprint(event) {
  if (event?.type !== 'message' || event?.role !== 'assistant') return '';
  const runId = text(event?.runId);
  if (!runId) return '';
  const provider = text(event?.provider).toLowerCase();
  const runtimeFamily = text(event?.runtimeFamily).toLowerCase();
  const isClaude = provider === 'claude' || runtimeFamily === 'claude-stream-json';
  if (!isClaude) return '';

  const persisted = text(event?.providerReplayFingerprint);
  if (persisted && event?.providerSnapshotKind === 'finalized-assistant') {
    return JSON.stringify([runId, persisted]);
  }

  // Compatibility projection for histories created before the fingerprint was
  // persisted. It is intentionally much narrower than generic same-text
  // merging: Claude stream-json, one run, one provider session, no upstream
  // message/frame/item id, and exact non-empty body only.
  const hasUpstreamIdentity = [
    event?.providerMessageId,
    event?.providerEventId,
    event?.providerItemId,
    event?.streamItemId,
  ].some((value) => text(value));
  if (hasUpstreamIdentity) return '';
  const fingerprint = createClaudeFinalizedAssistantReplayFingerprint(
    text(event?.providerSessionId),
    messageText(event),
  );
  return fingerprint ? JSON.stringify([runId, fingerprint]) : '';
}

// Structured providers may emit an accumulating assistant snapshot and then
// a final message with a different provider id. Keep those snapshots as one
// durable display entity. Operations seal a response segment, matching the
// Android projector's live-segment rule.
function mergeMessageSnapshots(events) {
  const output = [];
  const activeMessagesByScope = new Map();
  const replayMessagesByFingerprint = new Map();
  let segment = 0;
  // Single-slot chain of the most recent unbroken assistant-snapshot run
  // segment. Any non-message/non-thinking timeline item (user message,
  // operation, plan, status, usage) seals it; thinking_block is the fused
  // projection of the reasoning rows that accompany the same assistant turn
  // and must not.
  let activeChainKey = '';
  let activeChainEntry = null;
  for (const event of events) {
    if (event?.type === 'operation' || event?.type === 'plan') segment += 1;
    if (event?.type !== 'message') {
      if (event?.type !== 'thinking_block') {
        activeChainKey = '';
        activeChainEntry = null;
      }
      output.push(event);
      continue;
    }
    const role = event.role === 'user' ? 'user' : (event.role === 'system' ? 'system' : 'assistant');
    if (role !== 'assistant') {
      activeChainKey = '';
      activeChainEntry = null;
    }
    const replayFingerprint = event.canonicalMessageId ? '' : messageReplayFingerprint(event);
    const candidateSet = new Set();
    for (const key of messageScopeKeys(role, segment, event)) {
      const entries = activeMessagesByScope.get(key) || [];
      for (let index = entries.length - 1; index >= 0; index -= 1) candidateSet.add(entries[index]);
    }
    let previousEntry = replayFingerprint
      ? (replayMessagesByFingerprint.get(`${role}|${replayFingerprint}`) || null)
      : null;
    for (const entry of candidateSet) {
      if ((!previousEntry || entry.index > previousEntry.index)
        && sameMessageScope(entry.event, event)
        && (event.canonicalMessageId || relatedMessageText(entry.event, event))) {
        previousEntry = entry;
      }
    }
    if (!previousEntry
      && role === 'assistant'
      && !event.canonicalMessageId
      && isClaudeFinalizedSnapshotMessage(event)
      && activeChainEntry
      && activeChainKey === `assistant|${text(event?.runId)}|${segment}`
      && chainSnapshotBodiesRelate(activeChainEntry.event, event)) {
      previousEntry = activeChainEntry;
    }
    if (previousEntry) {
      output[previousEntry.index] = mergeMessageSnapshot(previousEntry.event, event);
      previousEntry.event = output[previousEntry.index];
      for (const key of messageScopeKeys(role, segment, event)) {
        const entries = activeMessagesByScope.get(key) || [];
        if (!entries.includes(previousEntry)) entries.push(previousEntry);
        if (entries.length > MESSAGE_SCOPE_CANDIDATE_LIMIT) entries.splice(0, entries.length - MESSAGE_SCOPE_CANDIDATE_LIMIT);
        activeMessagesByScope.set(key, entries);
      }
      if (replayFingerprint) replayMessagesByFingerprint.set(`${role}|${replayFingerprint}`, previousEntry);
      if (role === 'assistant' && isClaudeFinalizedSnapshotMessage(event)) {
        activeChainKey = `assistant|${text(event?.runId)}|${segment}`;
        activeChainEntry = previousEntry;
      }
      continue;
    }
    const index = output.length;
    output.push(event);
    const entry = { event, index, role, segment };
    for (const key of messageScopeKeys(role, segment, event)) {
      const entries = activeMessagesByScope.get(key) || [];
      entries.push(entry);
      if (entries.length > MESSAGE_SCOPE_CANDIDATE_LIMIT) entries.splice(0, entries.length - MESSAGE_SCOPE_CANDIDATE_LIMIT);
      activeMessagesByScope.set(key, entries);
    }
    if (replayFingerprint) replayMessagesByFingerprint.set(`${role}|${replayFingerprint}`, entry);
    if (role === 'assistant' && isClaudeFinalizedSnapshotMessage(event)) {
      activeChainKey = `assistant|${text(event?.runId)}|${segment}`;
      activeChainEntry = entry;
    } else if (role === 'assistant') {
      activeChainKey = '';
      activeChainEntry = null;
    }
  }
  return output;
}

function ordered(events) {
  return (Array.isArray(events) ? events : [])
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event && typeof event === 'object')
    .sort((left, right) => {
      const leftSeq = seqOf(left.event);
      const rightSeq = seqOf(right.event);
      if (leftSeq && rightSeq && leftSeq !== rightSeq) return leftSeq - rightSeq;
      if (leftSeq && !rightSeq) return -1;
      if (!leftSeq && rightSeq) return 1;
      return left.index - right.index;
    })
    .map(({ event }) => event);
}

function annotateAsyncQuestionReplies(projected) {
  const answersByItemId = new Map();
  const answersByMsgAndIndex = new Map();

  const recordReply = (reply, userEvent) => {
    const answer = text(reply?.answer);
    if (!answer) return;
    const itemId = text(reply?.questionItemId || reply?.id);
    const entry = {
      answer,
      question: text(reply?.question || reply?.title),
      answeredAt: Number.isFinite(userEvent?.timestamp) ? userEvent.timestamp : null,
      answeredBySeq: seqOf(userEvent) || null,
      answeredByRequestId: text(userEvent?.requestId) || null,
    };
    if (itemId) {
      if (!answersByItemId.has(itemId)) answersByItemId.set(itemId, []);
      answersByItemId.get(itemId).push(entry);
      const parsedId = parseAsyncQuestionItemId(itemId);
      if (parsedId) {
        const composite = `${parsedId.messageId}\u0000${parsedId.index}`;
        if (!answersByMsgAndIndex.has(composite)) answersByMsgAndIndex.set(composite, []);
        answersByMsgAndIndex.get(composite).push(entry);
      }
    }
  };

  for (const event of projected) {
    if (event?.type !== 'message' || event.role !== 'user') continue;
    const structured = normalizeAsyncQuestionReplies(event.asyncQuestionReplies);
    for (const reply of structured) recordReply(reply, event);
    const parsedEnvelope = parseAsyncQuestionReplyEnvelope(event.content);
    for (const reply of parsedEnvelope.replies) {
      if (structured.some((s) => s.questionItemId && s.questionItemId === reply.questionItemId)) continue;
      recordReply(reply, event);
    }
  }

  if (answersByItemId.size === 0 && answersByMsgAndIndex.size === 0) {
    return projected;
  }

  return projected.map((event) => {
    if (event?.type !== 'message' || event.role !== 'assistant'
      || !Array.isArray(event.asyncQuestions) || event.asyncQuestions.length === 0) {
      return event;
    }
    const eventSeq = seqOf(event);
    const msgId = text(event.asyncQuestionMessageId || event.providerMessageId);
    const updatedQuestions = event.asyncQuestions.map((q, idx) => {
      if (!q || typeof q !== 'object') return q;
      const qId = text(q.id);
      const candidates = (qId && answersByItemId.get(qId))
        || (msgId && answersByMsgAndIndex.get(`${msgId}\u0000${Number.isInteger(q.index) ? q.index : idx}`))
        || null;
      const hit = candidates
        ? candidates.find((entry) => !eventSeq || !entry.answeredBySeq || entry.answeredBySeq >= eventSeq)
        : null;
      if (!hit) {
        return {
          ...q,
          status: q.status === 'answered' ? 'answered' : 'pending',
        };
      }
      return {
        ...q,
        status: 'answered',
        answeredText: hit.answer,
        ...(hit.answeredAt ? { answeredAt: hit.answeredAt } : {}),
        ...(hit.answeredBySeq ? { answeredBySeq: hit.answeredBySeq } : {}),
      };
    });
    const answeredCount = updatedQuestions.filter((q) => q?.status === 'answered').length;
    const asyncQuestionsState = answeredCount === 0
      ? 'pending'
      : (answeredCount >= updatedQuestions.length ? 'answered' : 'partial');
    return {
      ...event,
      asyncQuestions: updatedQuestions,
      asyncQuestionsState,
    };
  });
}

// The durable baseline is a single chronological projection. There is no
// turn-level state, no completed-turn compaction, and no running-only branch.
// A tool's lifecycle revises one entity at its original sequence; all other
// visible events retain their append-only history position.
export function buildSessionDisplayEvents(history = [], { projectRoot = '', home = '' } = {}) {
  const source = projectMessageTimelineIdentities(ordered(history));
  const markdownRewrites = buildRewriteMap(source, 'localMarkdownImageRewrites');
  const resultRewrites = buildRewriteMap(source, 'localResultFileRewrites');
  const replacedMessageSeqs = new Set(source
    .filter((event) => event?.type === 'plan' && event.source === 'ragent-plan-fallback')
    .map((event) => Number.isInteger(event.sourceMessageSeq) ? event.sourceMessageSeq : 0)
    .filter((seq) => seq > 0));
  const operationProjection = buildOperationProjection(source, { projectRoot, home });
  const timeline = [];
  let reasoning = [];

  const reasoningIdentity = (event) => JSON.stringify([
    text(event?.runId), text(event?.providerMessageId), text(event?.providerBlockId),
  ]);

  const flushReasoning = () => {
    if (reasoning.length === 0) return;
    const first = reasoning[0];
    const last = reasoning.at(-1);
    const startSeq = seqOf(first);
    timeline.push({
      type: 'thinking_block',
      role: 'assistant',
      seq: startSeq,
      blockStartSeq: startSeq,
      blockEndSeq: seqOf(last) || startSeq,
      state: last.state === 'running' ? 'running' : 'completed',
      ...(first.runId ? { runId: first.runId } : {}),
      ...(first.requestId ? { requestId: first.requestId } : {}),
      ...(first.providerMessageId ? { providerMessageId: first.providerMessageId } : {}),
      ...(first.providerBlockId ? { providerBlockId: first.providerBlockId } : {}),
      content: reasoning.reduce((body, event) => {
        const part = String(event.content || '');
        // Providers may send incremental deltas followed by a complete
        // snapshot for the same block; the snapshot replaces those deltas.
        if ((event.reasoningLifecycle === 'completed' || event.state === 'completed') && part) return part;
        return body + part;
      }, ''),
    });
    reasoning = [];
  };

  for (const event of source) {
    const seq = seqOf(event);
    const operations = operationProjection.operationsByStartSeq.get(seq) || [];
    if (operations.length > 0) {
      flushReasoning();
      timeline.push(...operations);
    }
    if (seq && operationProjection.sourceSeqs.has(seq)) continue;
    if (isSuppressed(event) || isTransportStatus(event) || INTERNAL_TYPES.has(event.type)) continue;
    if (event.type === 'message' && replacedMessageSeqs.has(seq)) continue;
    if (event.type === 'reasoning') {
      if (reasoning.length > 0 && reasoningIdentity(reasoning[0]) !== reasoningIdentity(event)) flushReasoning();
      reasoning.push(event);
      continue;
    }
    flushReasoning();
    if (!isVisible(event)) continue;
    const next = sanitize(event, { markdownRewrites, resultRewrites });
    if (isVisible(next)) timeline.push(next);
  }
  flushReasoning();
  const projected = annotateAsyncQuestionReplies(
    annotateEntities(mergeMessageSnapshots(timeline))
      .map((event) => event.canonicalMessageId ? { ...event, seq: event.firstSeq || event.seq } : event),
  );
  // A provider may announce an empty assistant message before it emits its
  // first text block. Block indexes prove that an earlier thinking block came
  // first even when that empty message anchor has a smaller sequence.
  for (const thought of projected) {
    const block = /^thinking:(\d+)$/.exec(text(thought?.providerBlockId));
    if (thought?.type !== 'thinking_block' || !block || !text(thought.runId) || !text(thought.providerMessageId)) continue;
    const target = projected.find((event) => event?.type === 'message' && event.role === 'assistant'
      && event.runId === thought.runId && event.providerMessageId === thought.providerMessageId
      && Number.isInteger(event.providerContentBlockIndex)
      && Number(block[1]) < event.providerContentBlockIndex && seqOf(event) < seqOf(thought));
    if (target) {
      // Keep protocol/pagination sequence intact; only the client render
      // position is rebased to the matching message anchor.
      thought.displaySeq = target.seq;
      thought.beforeAssistantAtSameSeq = true;
    }
  }
  return projected.sort((left, right) => seqOf(left) - seqOf(right));
}

export function buildEventBlockEvents(history = [], startSeq = 0, endSeq = 0) {
  if (!Number.isInteger(startSeq) || !Number.isInteger(endSeq) || startSeq < 1 || endSeq < startSeq) return [];
  const source = ordered(history);
  const markdownRewrites = buildRewriteMap(source, 'localMarkdownImageRewrites');
  const resultRewrites = buildRewriteMap(source, 'localResultFileRewrites');
  return source
    .filter((event) => {
      const seq = seqOf(event);
      return seq >= startSeq && seq <= endSeq && !isSuppressed(event) && !isTransportStatus(event);
    })
    .map((event) => sanitize(event, { markdownRewrites, resultRewrites }))
    .filter(Boolean);
}

function streamKey(event) {
  for (const key of ['streamItemId', 'providerItemId', 'providerMessageId', 'providerEventId', 'runId', 'responseId', 'requestId']) {
    const value = text(event?.[key]);
    if (value) return `${key}:${value}:${Number.isInteger(event?.blockIndex) ? event.blockIndex : 0}`;
  }
  return '';
}

function controlStream(key) {
  let stream = activeControlStreams.get(key);
  if (!stream) {
    stream = createAssistantControlBlockStream();
    activeControlStreams.set(key, stream);
    while (activeControlStreams.size > STREAM_LIMIT) activeControlStreams.delete(activeControlStreams.keys().next().value);
  }
  return stream;
}

export function filterSessionDisplayPushEvents(events = []) {
  const output = [];
  for (const event of Array.isArray(events) ? events : []) {
    if (!(event && typeof event === 'object') || isSuppressed(event)) continue;
    const next = withMessageTimelineIdentity(clone(event));
    if (next.type === 'text_delta' && typeof next.text === 'string') {
      const key = streamKey(next) || 'anonymous';
      next.text = controlStream(key).push(next.text);
      if (!next.text) continue;
    } else if (next.type === 'message' && next.role === 'assistant' && typeof next.content === 'string') {
      next.content = stripAssistantControlBlocks(next.content);
      const key = streamKey(next);
      if (key) activeControlStreams.delete(key);
    } else if (next.type === 'message' && next.role === 'user') {
      const explicitIds = Array.isArray(next.answeredQuestionItemIds) ? next.answeredQuestionItemIds : [];
      const replyIds = extractAnsweredQuestionItemIds(normalizeAsyncQuestionReplies(next.asyncQuestionReplies));
      const envelopeIds = extractAnsweredQuestionItemIds(parseAsyncQuestionReplyEnvelope(next.content).replies);
      const mergedIds = [...new Set([...explicitIds, ...replyIds, ...envelopeIds].map(text).filter(Boolean))];
      if (mergedIds.length > 0) next.answeredQuestionItemIds = mergedIds;
    }
    output.push(createApprovedActionClientEventProjection(next));
  }
  return output;
}
