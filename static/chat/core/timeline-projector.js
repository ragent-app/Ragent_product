"use strict";

// Web implementation of android/core/timeline's durable-baseline + live-overlay
// reducer.  Transport events never own DOM nodes: immutable source events update
// an entity, and the renderer receives one ordered item list.
(function attachRagentTimelineProjector(root) {
  const MAX_SEEN_KEYS = 8192;
  const MAX_DURABLE_ITEMS = 4000;
  // These events are durable protocol/control records. They must still be
  // accepted so the cursor and Decision Sheet can converge, but they never
  // own a transcript row. The Android timeline follows the same split between
  // rendered timeline entities and protocol state.
  const CONTROL_EVENT_TYPES = new Set([
    "approval_request",
    "privileged_batch_request",
    "privileged_batch_response",
    "privileged_exec_result",
    "approved_action_batch_request",
    "approved_action_batch_response",
    "approved_action_state",
    "run_regenerate",
    "run_terminal",
  ]);

  const NOTICE_EVENT_TYPES = new Set([
    "approval_response",
    "status",
    "context_barrier",
    "context_operation",
  ]);
  // A short suffix/prefix match is ambiguous for normal delta text (for
  // example, a real stream can append the same one or two characters twice).
  // Longer overlaps are the reliable signature of a provider replaying an
  // already-emitted window, which is the case this projector must suppress.
  const MIN_LIVE_TEXT_OVERLAP = 12;
  const MESSAGE_SCOPE_CANDIDATE_LIMIT = 64;
  const MAX_LIVE_SEGMENTS = 8192;
  const MAX_LIVE_ENTITIES = 2048;
  const MAX_LIVE_TEXT_CHARS = 512 * 1024;
  const IDENTITY_TEXT_CHARS = 4096;
  // Provider frames can contain arbitrarily nested tool payloads.  Identity
  // comparisons run on every frame, so traversing that payload verbatim turns
  // a harmless duplicate check into an unbounded main-thread allocation.
  const IDENTITY_MAX_DEPTH = 3;
  const IDENTITY_MAX_KEYS = 40;
  const IDENTITY_MAX_ARRAY_ITEMS = 20;

  function positiveInteger(value) {
    return Number.isInteger(value) && value > 0 ? value : 0;
  }

  function getEventStartSeq(event) {
    const values = [event?.startSeq, event?.blockStartSeq, event?.mergedStartSeq, event?.seq]
      .map(positiveInteger)
      .filter(Boolean);
    return values.length ? Math.min(...values) : getEventBoundarySeq(event);
  }

  function getEventBoundarySeq(event) {
    const values = [event?.endSeq, event?.blockEndSeq, event?.mergedEndSeq, event?.boundarySeq, event?.seq]
      .map(positiveInteger)
      .filter(Boolean);
    return values.length ? Math.max(...values) : 0;
  }

  function normalizedType(event) {
    const type = typeof event?.type === "string" ? event.type.trim().toLowerCase() : "unknown";
    return type === "collapsed_block" ? "thinking_block" : type;
  }

  function isControlEvent(event) {
    return CONTROL_EVENT_TYPES.has(normalizedType(event));
  }

  function normalizedRole(event) {
    const role = typeof event?.role === "string" ? event.role.trim().toLowerCase() : "";
    if (role === "user" || role === "system" || role === "assistant") return role;
    return normalizedType(event) === "user_message" ? "user" : "assistant";
  }

  function textValue(event) {
    for (const key of ["content", "text", "delta", "bodyMarkdown", "body", "detail", "output"]) {
      if (typeof event?.[key] === "string") return event[key];
    }
    return "";
  }

  function boundedIdentityText(value) {
    if (typeof value !== "string" || value.length <= IDENTITY_TEXT_CHARS) return value;
    const tail = Math.floor(IDENTITY_TEXT_CHARS / 4);
    return `${value.slice(0, IDENTITY_TEXT_CHARS - tail)}…${value.slice(-tail)}`;
  }

  function boundLiveText(value) {
    if (typeof value !== "string" || value.length <= MAX_LIVE_TEXT_CHARS) return value || "";
    const tail = Math.floor(MAX_LIVE_TEXT_CHARS / 4);
    return `${value.slice(0, MAX_LIVE_TEXT_CHARS - tail)}\n\n[… live output trimmed …]\n\n${value.slice(-tail)}`;
  }

  function findTextOverlap(previousText, incomingText) {
    // Do not test every possible suffix with slice()/endsWith().  For two
    // unrelated 512 KiB frames that used to make roughly half a million
    // allocations and comparisons on the UI thread.  KMP finds the longest
    // suffix of `previousText` that is a prefix of `incomingText` in linear
    // time while retaining exact overlap semantics for large provider replay
    // windows.
    const maxOverlap = Math.min(previousText.length, incomingText.length);
    if (maxOverlap < MIN_LIVE_TEXT_OVERLAP) return 0;

    const prefix = incomingText.slice(0, maxOverlap);
    const lps = new Uint32Array(prefix.length);
    for (let index = 1, matched = 0; index < prefix.length; index += 1) {
      while (matched > 0 && prefix[index] !== prefix[matched]) matched = lps[matched - 1];
      if (prefix[index] === prefix[matched]) matched += 1;
      lps[index] = matched;
    }

    let matched = 0;
    const start = Math.max(0, previousText.length - maxOverlap);
    for (let index = start; index < previousText.length; index += 1) {
      while (matched > 0 && previousText[index] !== prefix[matched]) matched = lps[matched - 1];
      if (previousText[index] === prefix[matched]) matched += 1;
      // A complete match before the final input character can still be
      // extended only by following the prefix table; retaining it here would
      // incorrectly report an interior match rather than a suffix match.
      if (matched === prefix.length && index !== previousText.length - 1) matched = lps[matched - 1];
    }
    return matched >= MIN_LIVE_TEXT_OVERLAP ? matched : 0;
  }

  function mergeLiveText(previousText, incomingText, { complete = false } = {}) {
    if (!previousText) return incomingText;
    if (!incomingText) return previousText;
    if (previousText === incomingText) return previousText;

    // Both delta streams and completed snapshots appear in the wild. A
    // cumulative snapshot replaces the previous prefix; a stale snapshot is
    // ignored; an overlapped window contributes only its unseen suffix.
    if (incomingText.startsWith(previousText)) return incomingText;
    if (complete || incomingText.length >= MIN_LIVE_TEXT_OVERLAP) {
      if (previousText.startsWith(incomingText)) return previousText;
    }
    const overlap = findTextOverlap(previousText, incomingText);
    if (overlap > 0) return `${previousText}${incomingText.slice(overlap)}`;

    // A completed message is authoritative when it is unrelated to the live
    // prefix (for example, a provider correction). Deltas remain append-only.
    return complete ? incomingText : `${previousText}${incomingText}`;
  }

  function areLiveTextsRelated(leftText, rightText) {
    if (!leftText || !rightText) return true;
    return leftText === rightText
      || leftText.startsWith(rightText)
      || rightText.startsWith(leftText)
      || findTextOverlap(leftText, rightText) > 0
      || findTextOverlap(rightText, leftText) > 0;
  }

  function stableValue(value, depth = 0) {
    if (value === null || typeof value !== "object") return value;
    if (depth >= IDENTITY_MAX_DEPTH) {
      return Array.isArray(value) ? "[array]" : "[object]";
    }
    if (Array.isArray(value)) {
      const values = value.slice(0, IDENTITY_MAX_ARRAY_ITEMS)
        .map((entry) => stableValue(entry, depth + 1));
      if (value.length > IDENTITY_MAX_ARRAY_ITEMS) values.push(`[+${value.length - IDENTITY_MAX_ARRAY_ITEMS}]`);
      return values;
    }
    const keys = Object.keys(value).sort();
    const visibleKeys = keys.slice(0, IDENTITY_MAX_KEYS);
    const result = visibleKeys.reduce((next, key) => {
      const entry = value[key];
      next[key] = typeof entry === "string"
        ? boundedIdentityText(entry)
        : stableValue(entry, depth + 1);
      return next;
    }, {});
    if (keys.length > IDENTITY_MAX_KEYS) {
      result.__truncatedKeys = keys.length - IDENTITY_MAX_KEYS;
    }
    return result;
  }

  function stableStringify(value) {
    try { return JSON.stringify(stableValue(value)); } catch { return String(value); }
  }

  function sourceKeyFor(event) {
    const keys = normalizedType(event) === "text_delta"
      ? ["providerEventId", "eventId", "id"]
      : ["id", "eventId", "providerEventId"];
    for (const key of keys) {
      const value = typeof event?.[key] === "string" ? event[key].trim() : "";
      if (value) return `${key}:${value}`;
    }
    return `event:${stableStringify({
      type: normalizedType(event),
      start: getEventStartSeq(event),
      end: getEventBoundarySeq(event),
      entity: entityIdFor(event),
      revision: event?.revision ?? null,
      content: boundedIdentityText(textValue(event)),
    })}`;
  }

  function operationId(event) {
    const explicit = [
      event?.operationId,
      event?.toolCallId,
      event?.toolCall?.toolCallId,
      event?.providerToolUseId,
      event?.providerItemId,
      event?.entityId,
    ].find((value) => typeof value === "string" && value.trim());
    if (explicit) return String(explicit).trim();
    return `seq:${getEventStartSeq(event) || getEventBoundarySeq(event) || "unknown"}`;
  }

  function messageSourceId(event) {
    const explicit = [
      event?.messageId,
      event?.providerMessageId,
      event?.providerItemId,
      event?.streamItemId,
      event?.entityId,
    ].find((value) => typeof value === "string" && value.trim());
    if (explicit) return String(explicit).trim();
    const seq = getEventStartSeq(event) || getEventBoundarySeq(event);
    if (seq) return `seq:${seq}`;
    const scope = [event?.runId, event?.responseId, event?.requestId]
      .find((value) => typeof value === "string" && value.trim());
    return `live:${scope ? String(scope).trim() : "anonymous"}`;
  }

  function isAsyncDeliveryMessageEvent(event) {
    if (!event || typeof event !== "object") return false;
    const delivery = String(event.messageDelivery ?? event.delivery ?? "").trim().toLowerCase();
    return delivery === "async" || (Array.isArray(event.asyncQuestions) && event.asyncQuestions.length > 0);
  }

  function asyncDeliveryMessageIdentity(event) {
    if (!event || typeof event !== "object") return "";
    const itemId = typeof event.itemId === "string" ? event.itemId.trim() : "";
    if (itemId) return `item:${itemId}`;
    const qId = Array.isArray(event.asyncQuestions)
      ? String(event.asyncQuestions[0]?.id ?? event.asyncQuestions[0]?.questionItemId ?? "").trim()
      : "";
    if (qId) return `q:${qId}`;
    const seq = Number(event.seq);
    if (Number.isFinite(seq) && seq > 0) return `seq:${seq}`;
    const id = typeof event.id === "string" ? event.id.trim() : "";
    return id ? `id:${id}` : "";
  }

  function sameAsyncDeliveryIdentity(a, b) {
    const idA = asyncDeliveryMessageIdentity(a);
    const idB = asyncDeliveryMessageIdentity(b);
    if (idA && idB) return idA === idB;
    return false;
  }

  function entityIdFor(event) {
    const explicit = typeof event?.timelineEntityId === "string" ? event.timelineEntityId.trim() : "";
    if (!explicit && isAsyncDeliveryMessageEvent(event) && kindFor(event) === "message" && normalizedRole(event) === "assistant") {
      const asyncId = asyncDeliveryMessageIdentity(event);
      if (asyncId) return `message:assistant:async:${asyncId}`;
    }
    if (explicit) return explicit;
    const type = normalizedType(event);
    if (type === "operation" || type === "tool_use" || type === "tool_result" || type === "file_change") {
      return `operation:${operationId(event)}`;
    }
    if (type === "plan" || event?.planId || event?.artifactId) {
      return `plan:${event?.planId || event?.artifactId || getEventStartSeq(event) || "unknown"}`;
    }
    if (type === "thinking_block" || type === "reasoning") {
      return `thinking:${event?.blockId || event?.entityId || getEventStartSeq(event) || "live"}`;
    }
    if (type === "attachment_delivery") {
      return `attachment:${event?.deliveryKey || getEventStartSeq(event) || "unknown"}`;
    }
    if (type.includes("message") || type.includes("delta") || type.includes("stream")) {
      return `message:${normalizedRole(event)}:${messageSourceId(event)}`;
    }
    return `notice:${event?.id || event?.eventId || getEventStartSeq(event) || "unknown"}`;
  }

  function messageScopeKeys(event) {
    const role = normalizedRole(event);
    const keys = [];
    for (const key of ["streamItemId", "providerMessageId", "providerItemId"]) {
      const value = typeof event?.[key] === "string" ? event[key].trim() : "";
      if (value) keys.push(`${role}|provider:${value}`);
    }
    for (const [label, key] of [["run", "runId"], ["response", "responseId"], ["request", "requestId"]]) {
      const value = typeof event?.[key] === "string" ? event[key].trim() : "";
      if (value) keys.push(`${role}|${label}:${value}`);
    }
    return keys;
  }

  function kindFor(event) {
    const type = normalizedType(event);
    // Usage is run metadata. It updates the activity/context surfaces but
    // never owns a transcript row.
    if (type === "usage") return "metadata";
    if (isControlEvent(event)) return "control";
    if (type === "operation" || type === "tool_use" || type === "tool_result" || type === "file_change") return "operation";
    if (type === "plan" || event?.planId || event?.artifactId) return "plan";
    if (type === "thinking_block" || type === "reasoning") return "thinking";
    if (type === "attachment_delivery") return "attachment";
    if (type.includes("message") || type.includes("delta") || type.includes("stream")) return "message";
    // A new protocol event must be opt-in to the transcript renderer. This
    // prevents provider/runtime metadata from becoming user-visible JSON when
    // the server adds a field or event type before the UI knows its semantics.
    return NOTICE_EVENT_TYPES.has(type) ? "notice" : "control";
  }

  function isDurableUserRecord(record) {
    return record?.source === "durable"
      && record?.kind === "message"
      && normalizedRole(record?.event) === "user";
  }

  function compareTimelineRecords(left, right) {
    const startOrder = left.startSeq - right.startSeq;
    if (startOrder !== 0) return startOrder;
    const endOrder = left.endSeq - right.endSeq;
    if (endOrder !== 0) return endOrder;

    // Sequence-free live output is tentatively placed after the latest known
    // durable cursor. If the POSTed user event reaches HTTP just after the
    // first live token, both records can receive the same synthetic sequence.
    // The durable user event is the turn boundary and must remain first.
    const leftIsDurableUser = isDurableUserRecord(left);
    const rightIsDurableUser = isDurableUserRecord(right);
    if (leftIsDurableUser !== rightIsDurableUser) return leftIsDurableUser ? -1 : 1;
    return left.id.localeCompare(right.id);
  }

  function isEphemeral(event) {
    if (getEventBoundarySeq(event) > 0) return false;
    const type = normalizedType(event);
    return type === "text_delta" || type === "reasoning" || type === "thinking_block"
      || (type === "message" && normalizedRole(event) === "assistant")
      || type.includes("stream");
  }

  function isCompleted(event) {
    const type = normalizedType(event);
    const state = String(event?.state || event?.status || "").toLowerCase();
    return type === "message" || type === "tool_result" || type === "attachment_delivery"
      || type.includes("completed") || type.includes("finished")
      || ["completed", "complete", "done", "finished", "failed", "cancelled", "canceled", "denied"].includes(state);
  }

  function normalizeRegenerationEntry(event, source, startSeq = 0, revision = 0) {
    const parentRequestId = typeof event?.parentRequestId === "string"
      ? event.parentRequestId.trim()
      : "";
    if (!parentRequestId) return null;
    const requestId = typeof event?.requestId === "string" ? event.requestId.trim() : "";
    const runId = typeof event?.runId === "string" ? event.runId.trim() : "";
    const parentRunId = typeof event?.parentRunId === "string" ? event.parentRunId.trim() : "";
    const editResend = event?.editResend === true;
    const prompt = editResend && typeof event?.prompt === "string" ? event.prompt : "";
    const images = editResend && Array.isArray(event?.images) ? [...event.images] : [];
    const attachments = editResend && Array.isArray(event?.attachments) ? [...event.attachments] : [];
    const seq = positiveInteger(startSeq) || getEventStartSeq(event);
    const rev = positiveInteger(revision) || positiveInteger(event?.revision) || seq || 1;
    const key = requestId || runId || `seq:${seq || "live"}`;
    return {
      key,
      parentRequestId,
      requestId,
      runId,
      parentRunId,
      seq,
      revision: rev,
      source: source === "durable" ? "durable" : "live",
      editResend,
      prompt,
      images,
      attachments,
      signature: stableStringify({
        seq,
        requestId,
        runId,
        parentRunId,
        editResend,
        prompt,
        images,
        attachments,
      }),
    };
  }

  function compareRegenerationEntries(left, right) {
    const seqOrder = (left?.seq || 0) - (right?.seq || 0);
    if (seqOrder !== 0) return seqOrder;
    const revOrder = (left?.revision || 0) - (right?.revision || 0);
    if (revOrder !== 0) return revOrder;
    const leftDurable = left?.source === "durable" ? 1 : 0;
    const rightDurable = right?.source === "durable" ? 1 : 0;
    if (leftDurable !== rightDurable) return leftDurable - rightDurable;
    return String(left?.key || "").localeCompare(String(right?.key || ""));
  }

  function regenerationMatches(left, right) {
    if (!left || !right) return false;
    if (left.key && right.key && left.key === right.key) return true;
    if (left.requestId && right.requestId && left.requestId === right.requestId) return true;
    if (left.runId && right.runId && left.runId === right.runId) return true;
    return false;
  }

  function mergePagination(current, incoming, mode) {
    const previous = current && typeof current === "object" ? current : {};
    const next = incoming && typeof incoming === "object" ? incoming : {};
    const merged = { ...previous, ...next };
    const oldBefore = positiveInteger(previous.nextBeforeSeq) || positiveInteger(previous.oldestSeq);
    const newBefore = positiveInteger(next.nextBeforeSeq) || positiveInteger(next.oldestSeq);
    const before = oldBefore && newBefore ? Math.min(oldBefore, newBefore) : (oldBefore || newBefore);
    if (before) {
      merged.nextBeforeSeq = before;
      merged.oldestSeq = before;
    }
    if (mode === "before" && Object.prototype.hasOwnProperty.call(next, "hasMoreBefore")) {
      merged.hasMoreBefore = next.hasMoreBefore === true;
    } else if (mode !== "before" && oldBefore) {
      merged.hasMoreBefore = previous.hasMoreBefore === true;
    }
    return merged;
  }

  class TimelineProjector {
    constructor({ sessionId = "", maxSeenKeys = MAX_SEEN_KEYS, maxDurableItems = MAX_DURABLE_ITEMS } = {}) {
      this.maxSeenKeys = Math.max(64, Number(maxSeenKeys) || MAX_SEEN_KEYS);
      this.maxDurableItems = Math.max(256, Number(maxDurableItems) || MAX_DURABLE_ITEMS);
      this.sessionId = sessionId;
      this.durable = new Map();
      this.live = new Map();
      this.durableMessageScopeIndex = new Map();
      this.liveMessageScopeIndex = new Map();
      this.liveSegments = new Map();
      this.liveTouchedAt = new Map();
      this.liveTouchClock = 0;
      this.durableRegenerations = new Map();
      this.liveRegenerations = new Map();
      this.sealedOperationIds = new Set();
      this.seen = new Map();
      this.pagination = {};
      this.durableCursor = 0;
      this.liveSeqCursor = 0;
      this.lastChange = this.emptyChange();
      this._durablePrependMode = false;
      // Most streaming updates replace one entity. Keep the immutable
      // rendered item for every untouched record so change detection does not
      // serialize or clone the whole transcript on every token.
      this._itemCacheByRecord = new WeakMap();
      this._itemsCache = null;
    }

    emptyChange() {
      return { changedIds: [], removedIds: [], changedItems: [], acceptedEvents: [], insertedIds: [], updatedIds: [], reset: false, gapExpectedSeq: null };
    }

    clear({ sessionId = this.sessionId } = {}) {
      this.sessionId = sessionId || "";
      this.durable.clear();
      this.live.clear();
      this.durableMessageScopeIndex.clear();
      this.liveMessageScopeIndex.clear();
      this.liveSegments.clear();
      this.liveTouchedAt.clear();
      this.liveTouchClock = 0;
      this.durableRegenerations.clear();
      this.liveRegenerations.clear();
      this.sealedOperationIds.clear();
      this.seen.clear();
      this.pagination = {};
      this.durableCursor = 0;
      this.liveSeqCursor = 0;
      this.lastChange = this.emptyChange();
      this._itemCacheByRecord = new WeakMap();
      this._itemsCache = null;
      return this.snapshot();
    }

    replace(events, options = {}) {
      const before = this.snapshot();
      this.clear({ sessionId: options.sessionId || this.sessionId });
      // clear() returns an empty snapshot for callers that use it directly;
      // the replacement that follows must invalidate that temporary cache.
      this._itemsCache = null;
      this._durablePrependMode = false;
      const accepted = this.applyDurable(events);
      this.trimDurable({ historyPrepend: false });
      this.durableCursor = Math.max(positiveInteger(options.latestSeq), ...[...this.durable.values()].map((record) => record.endSeq));
      this.liveSeqCursor = this.durableCursor;
      this.pagination = { ...(options.pagination || {}) };
      return this.finish(before, accepted, true);
    }

    replaceDurable(events, options = {}) {
      const before = this.snapshot();
      this._itemsCache = null;
      this._durablePrependMode = options.historyPrepend === true || options.paginationMode === "before";
      const accepted = this.applyDurable(events);
      this.trimDurable({ historyPrepend: this._durablePrependMode });
      this.durableCursor = Math.max(this.durableCursor, positiveInteger(options.latestSeq), ...[...this.durable.values()].map((record) => record.endSeq));
      this.liveSeqCursor = Math.max(this.liveSeqCursor, this.durableCursor);
      this.pagination = mergePagination(this.pagination, options.pagination, options.paginationMode || "latest");
      return this.finish(before, accepted, false);
    }

    ingest(events, options = {}) {
      const before = this.snapshot();
      this._itemsCache = null;
      const accepted = [];
      for (const event of Array.isArray(events) ? events : []) {
        if (getEventBoundarySeq(event) <= 0 && normalizedType(event) === "run_regenerate") {
          const key = sourceKeyFor(event);
          const identity = stableStringify(event);
          const priorIdentity = this.seen.get(key);
          if (priorIdentity === identity) continue;
          if (priorIdentity && priorIdentity !== identity) continue;
          this.seen.set(key, identity);
          const seq = this.liveSeqCursor = Math.max(this.liveSeqCursor, this.durableCursor) + 1;
          const entry = normalizeRegenerationEntry(event, "live", seq, positiveInteger(event?.revision) || seq);
          if (entry && !this.hasDurableRegeneration(entry)) {
            this.storeRegeneration(this.liveRegenerations, entry, MAX_LIVE_ENTITIES);
            accepted.push({ ...event, seq });
          }
          continue;
        }
        if (!isEphemeral(event)) continue;
        const key = sourceKeyFor(event);
        const identity = stableStringify(event);
        const priorIdentity = this.seen.get(key);
        if (priorIdentity === identity) continue;
        if (priorIdentity && priorIdentity !== identity) continue;
        this.seen.set(key, identity);
        const entityId = this.liveEntityId(event);
        const prior = this.live.get(entityId);
        const previousText = prior?.event?.content || prior?.event?.text || "";
        const incomingText = textValue(event);
        const complete = isCompleted(event)
          && normalizedType(event) !== "text_delta";
        const text = boundLiveText(mergeLiveText(previousText, incomingText, { complete }));
        // Live rows borrow a provisional sequence above everything the client
        // has seen so far (Android's nextLiveRenderSeq discipline). A small
        // counter over the durable cursor would hand out sequences that the
        // next durable page then reuses for real events, and those collisions
        // reorder user and agent rows against each other.
        const seq = prior?.startSeq
          || (this.liveSeqCursor = Math.max(this.liveSeqCursor, this.durableCursor) + 1);
        const merged = {
          ...(prior?.event || {}),
          ...event,
          type: kindFor(event) === "message" ? "text_delta" : event.type,
          entityId,
          timelineEntityId: entityId,
          seq,
          startSeq: seq,
          endSeq: seq,
          boundarySeq: seq,
          content: text,
          text,
          liveSegment: this.liveSegments.get(this.liveScope(event)) || 0,
          oneShotMessage: prior?.event?.oneShotMessage === true
            || (normalizedType(event) === "message" && normalizedRole(event) === "assistant"),
        };
        const liveRecord = this.record(merged, "live", seq);
        if (prior) this.unindexMessageRecord(this.liveMessageScopeIndex, prior);
        this.live.set(entityId, liveRecord);
        this.liveTouchedAt.set(entityId, ++this.liveTouchClock);
        this.indexMessageRecord(this.liveMessageScopeIndex, liveRecord);
        accepted.push(merged);
      }
      this.trimLive();
      this.trimSeen();
      return this.finish(before, accepted, false);
    }

    reconcileCursor(latestSeq, options = {}) {
      const before = this.snapshot();
      this.durableCursor = Math.max(this.durableCursor, positiveInteger(latestSeq));
      this.liveSeqCursor = Math.max(this.liveSeqCursor, this.durableCursor);
      this.pagination = mergePagination(this.pagination, options.pagination, options.paginationMode || "latest");
      return this.finish(before, [], false);
    }

    upsertTransient(id, event) {
      return this.ingest([{ ...(event || {}), id: id || event?.id, type: event?.type || "text_delta" }]);
    }

    remove(id) {
      const before = this.snapshot();
      this._itemsCache = null;
      this.deleteLive(id);
      this.deleteDurable(id);
      return this.finish(before, [], false);
    }

    unindexMessageRecord(index, record) {
      if (!record || record.kind !== "message" || normalizedRole(record.event) !== "assistant") return;
      for (const key of messageScopeKeys(record.event)) {
        const entries = index.get(key);
        if (!entries) continue;
        const next = entries.filter((candidate) => candidate !== record);
        if (next.length > 0) index.set(key, next);
        else index.delete(key);
      }
    }

    deleteLive(id) {
      const record = this.live.get(id);
      if (record) this.unindexMessageRecord(this.liveMessageScopeIndex, record);
      this.live.delete(id);
      this.liveTouchedAt.delete(id);
      return record;
    }

    trimLive() {
      const excess = this.live.size - MAX_LIVE_ENTITIES;
      if (excess <= 0) return;
      const victims = [...this.live.keys()]
        .sort((left, right) => (this.liveTouchedAt.get(left) || 0) - (this.liveTouchedAt.get(right) || 0))
        .slice(0, excess);
      for (const id of victims) this.deleteLive(id);
    }

    deleteDurable(id) {
      const record = this.durable.get(id);
      if (record) this.unindexMessageRecord(this.durableMessageScopeIndex, record);
      this.durable.delete(id);
      return record;
    }

    applyDurable(events) {
      const accepted = [];
      for (const event of Array.isArray(events) ? events : []) {
        if (!event || typeof event !== "object") continue;
        if (getEventBoundarySeq(event) <= 0) continue;
        let entityId = entityIdFor(event);
        let liveMatch = null;
        let durableMatch = null;
        if (kindFor(event) === "message" && normalizedRole(event) === "assistant") {
          liveMatch = this.findIndexedMessage(this.liveMessageScopeIndex, event, (live) =>
            this.sameMessageScope(live.event, event)
              && this.sameMessageContent(live.event, event),
          ) || null;
          if (liveMatch) entityId = liveMatch.id;
          if (!liveMatch) {
            durableMatch = this.findIndexedMessage(this.durableMessageScopeIndex, event, (durable) =>
              this.sameMessageScope(durable.event, event)
                && this.sameMessageContent(durable.event, event, { allowOverlap: false }),
            ) || null;
            if (durableMatch) entityId = durableMatch.id;
          }
        }
        // A few structured-provider completion frames contain identity only.
        // Preserve the already-rendered stream in that case instead of
        // replacing it with a blank durable row while the server recovers it.
        const liveText = liveMatch ? textValue(liveMatch.event) : "";
        // Result-file publication appends a second assistant message carrying
        // attachments and rewrite metadata.  That record intentionally has an
        // empty body, but it shares the run/response/request scope with the
        // already-settled final answer.  Keep the authoritative text when the
        // durable match is the existing assistant row; otherwise the empty
        // publication event would blank the final summary at stream end.
        const durableText = durableMatch ? textValue(durableMatch.event) : "";
        const preservedText = liveText || durableText;
        const durableEvent = kindFor(event) === "message"
          && normalizedRole(event) === "assistant"
          && !textValue(event)
          && preservedText
          ? { ...event, content: preservedText, text: preservedText }
          : event;
        const next = this.record({ ...durableEvent, entityId, timelineEntityId: entityId }, "durable");
        if (liveMatch) {
          // The live row's sequence was a provisional borrow from the client
          // cursor, so it can sit above durable rows that chronologically
          // precede the settled message (tool activity streamed into the page
          // while this message was still streaming). Keep the live entity
          // identity — completion must update the streaming row, never
          // duplicate it — but the durable boundary sequence is authoritative
          // and moves the settled row to its chronological place, matching
          // Android's overlay eviction on durable advance.
          next.event.endSeq = Math.max(liveMatch.endSeq, next.endSeq);
          next.event.boundarySeq = next.event.endSeq;
        }
        const current = this.durable.get(entityId);
        if (current && current.identity === next.identity) continue;
        if (current && current.revision > next.revision) continue;
        if (current) {
          this.unindexMessageRecord(this.durableMessageScopeIndex, current);
          // Durable revisions stay anchored at their first layout sequence.
          next.startSeq = current.startSeq;
          next.event.startSeq = current.startSeq;
          next.event.seq = current.startSeq;
          next.event.endSeq = Math.max(current.endSeq, next.endSeq);
          next.event.boundarySeq = next.event.endSeq;
        }
        this.durable.set(entityId, next);
        this.indexMessageRecord(this.durableMessageScopeIndex, next);
        this.liveSeqCursor = Math.max(this.liveSeqCursor, next.endSeq);
        if (next.kind === "control" && normalizedType(next.event) === "run_regenerate") {
          this.recordDurableRegeneration(next.event, next.startSeq, next.revision);
        }
        // Android reconciles a durable advance by removing its live overlay.
        // Providers often do not expose the same message id for the final
        // persisted message, so run/request scope is the explicit fallback.
        if (next.kind === "message" && normalizedRole(next.event) === "assistant") {
          this.retireSettledLiveStream(next);
        } else {
          this.deleteLive(entityId);
          if (next.kind === "operation") this.advanceLiveSegmentFor(next.event, entityId);
        }
        accepted.push(next.event);
        // Full-history compatibility callers can still hand the projector a
        // very large array. Trim in coarse batches while replaying so the
        // temporary model cannot grow linearly with the transcript.
        if (this.durable.size > this.maxDurableItems * 2) {
          this.trimDurable({ historyPrepend: this._durablePrependMode });
        }
      }
      return accepted;
    }

    trimDurable({ historyPrepend = false } = {}) {
      const excess = this.durable.size - this.maxDurableItems;
      if (excess <= 0) return;
      const records = [...this.durable.values()].sort(compareTimelineRecords);
      const victims = historyPrepend ? records.slice(-excess) : records.slice(0, excess);
      for (const record of victims) this.deleteDurable(record.id);
    }

    // A streamed assistant message can be split across several provisional
    // live rows (a durable operation seals the segment mid-stream). When the
    // authoritative message lands, every same-scope live fragment whose text
    // is already contained in the durable content is retired — otherwise the
    // settled row keeps a stale duplicate tail below or above it.
    retireSettledLiveStream(durableRecord) {
      const durableText = textValue(durableRecord.event);
      if (!durableText) return;
      for (const [id, live] of this.live) {
        if (live.kind !== "message" || normalizedRole(live.event) !== "assistant") continue;
        if (!this.sameMessageScope(live.event, durableRecord.event)) continue;
        const liveText = textValue(live.event);
        if (liveText && !durableText.includes(liveText) && liveText !== durableText) continue;
        this.deleteLive(id);
      }
    }

    sameMessageScope(left, right) {
      const providerKeys = ["streamItemId", "providerMessageId", "providerItemId"];
      const leftProviders = new Set(providerKeys
        .map((key) => left?.[key])
        .filter((value) => typeof value === "string" && value.trim())
        .map((value) => value.trim()));
      const rightProviders = new Set(providerKeys
        .map((key) => right?.[key])
        .filter((value) => typeof value === "string" && value.trim())
        .map((value) => value.trim()));
      for (const value of leftProviders) {
        if (rightProviders.has(value)) return true;
      }
      for (const key of ["runId", "responseId"]) {
        const leftValue = typeof left?.[key] === "string" ? left[key].trim() : "";
        const rightValue = typeof right?.[key] === "string" ? right[key].trim() : "";
        if (leftValue && rightValue && leftValue !== rightValue) return false;
      }
      for (const key of ["runId", "responseId", "requestId"]) {
        const leftValue = typeof left?.[key] === "string" ? left[key].trim() : "";
        const rightValue = typeof right?.[key] === "string" ? right[key].trim() : "";
        if (leftValue && rightValue && leftValue === rightValue) return true;
      }
      return false;
    }

    sameMessageContent(left, right, { allowOverlap = true } = {}) {
      const leftText = textValue(left);
      const rightText = textValue(right);
      if (allowOverlap) return areLiveTextsRelated(leftText, rightText);
      if (!leftText || !rightText) return true;
      return leftText === rightText
        || leftText.startsWith(rightText)
        || rightText.startsWith(leftText);
    }

    liveScope(event) {
      const scope = [event?.streamItemId, event?.providerMessageId, event?.providerItemId, event?.runId, event?.responseId, event?.requestId]
        .find((value) => typeof value === "string" && value.trim());
      return scope ? String(scope).trim() : "anonymous";
    }

    liveEntityId(event) {
      if (kindFor(event) !== "message" || normalizedRole(event) !== "assistant") return entityIdFor(event);
      const matchingLive = this.findIndexedMessage(this.liveMessageScopeIndex, event, (live) =>
        this.canReuseLiveMessageEntity(live.event, event),
      );
      if (matchingLive) return matchingLive.id;
      const hasProviderIdentity = [event?.messageId, event?.providerMessageId, event?.providerItemId, event?.streamItemId, event?.entityId]
        .some((value) => typeof value === "string" && value.trim());
      if (hasProviderIdentity) return entityIdFor(event);
      const scope = this.liveScope(event);
      const segment = this.liveSegments.get(scope) || 0;
      return `message:assistant:live:${encodeURIComponent(scope)}:segment:${segment}`;
    }

    indexMessageRecord(index, record) {
      if (record?.kind !== "message" || normalizedRole(record.event) !== "assistant") return;
      for (const key of messageScopeKeys(record.event)) {
        const entries = index.get(key) || [];
        if (!entries.includes(record)) entries.push(record);
        if (entries.length > MESSAGE_SCOPE_CANDIDATE_LIMIT) {
          entries.splice(0, entries.length - MESSAGE_SCOPE_CANDIDATE_LIMIT);
        }
        index.set(key, entries);
      }
    }

    findIndexedMessage(index, event, predicate) {
      const candidates = new Set();
      for (const key of messageScopeKeys(event)) {
        const entries = index.get(key) || [];
        for (let i = entries.length - 1; i >= 0; i -= 1) {
          const record = entries[i];
          if (record && (this.live.get(record.id) === record || this.durable.get(record.id) === record)) {
            candidates.add(record);
          }
        }
      }
      let match = null;
      for (const record of candidates) {
        if ((!match || record.startSeq >= match.startSeq) && predicate(record)) match = record;
      }
      return match;
    }

    canReuseLiveMessageEntity(previous, incoming) {
      if (!this.sameMessageScope(previous, incoming)) return false;
      const currentSegment = this.liveSegments.get(this.liveScope(incoming)) || 0;
      const previousSegment = positiveInteger(previous?.liveSegment);
      if (currentSegment !== previousSegment) return false;
      const previousText = textValue(previous);
      const incomingText = textValue(incoming);
      const previousType = normalizedType(previous);
      const incomingType = normalizedType(incoming);
      const incomingComplete = isCompleted(incoming) && incomingType !== "text_delta";
      const sameProvider = ["streamItemId", "providerMessageId", "providerItemId"]
        .some((key) => {
          const left = typeof previous?.[key] === "string" ? previous[key].trim() : "";
          const right = typeof incoming?.[key] === "string" ? incoming[key].trim() : "";
          return left && right && left === right;
        });
      if (sameProvider || this.sameMessageContent(previous, incoming) && incomingComplete) return true;
      // A delta stream is one assistant message even when the provider emits
      // a fresh item id for each update. Do not continue a one-shot complete
      // message unless the incoming payload is an exact/prefix replay.
      return !incomingComplete
        && previousType === "text_delta"
        && previous?.oneShotMessage !== true;
    }

    advanceLiveSegmentFor(event, operationEntityId) {
      if (this.sealedOperationIds.has(operationEntityId)) return;
      this.sealedOperationIds.add(operationEntityId);
      while (this.sealedOperationIds.size > MAX_SEEN_KEYS) {
        this.sealedOperationIds.delete(this.sealedOperationIds.values().next().value);
      }
      const scope = this.liveScope(event);
      const hasLiveMessage = [...this.live.values()].some((live) => this.liveScope(live.event) === scope);
      if (hasLiveMessage) {
        if (!this.liveSegments.has(scope) && this.liveSegments.size >= MAX_LIVE_SEGMENTS) {
          this.liveSegments.delete(this.liveSegments.keys().next().value);
        }
        this.liveSegments.set(scope, (this.liveSegments.get(scope) || 0) + 1);
      }
    }

    record(event, source, forcedSeq = 0) {
      const startSeq = forcedSeq || getEventStartSeq(event);
      const endSeq = forcedSeq || getEventBoundarySeq(event) || startSeq;
      return {
        id: entityIdFor(event),
        kind: kindFor(event),
        event,
        source,
        startSeq,
        endSeq,
        revision: positiveInteger(event?.revision) || endSeq || startSeq || 1,
        completed: isCompleted(event),
        identity: stableStringify(event),
      };
    }

    trimSeen() {
      while (this.seen.size > this.maxSeenKeys) this.seen.delete(this.seen.keys().next().value);
    }

    storeRegeneration(targetMap, entry, maxParents = this.maxDurableItems) {
      if (!entry?.parentRequestId) return;
      let group = targetMap.get(entry.parentRequestId);
      if (!group) {
        if (targetMap.size >= maxParents) {
          targetMap.delete(targetMap.keys().next().value);
        }
        group = new Map();
      } else {
        targetMap.delete(entry.parentRequestId);
      }
      targetMap.set(entry.parentRequestId, group);
      group.set(entry.key, entry);
    }

    hasDurableRegeneration(entry) {
      if (!entry) return false;
      for (const group of this.durableRegenerations.values()) {
        for (const candidate of group.values()) {
          if (regenerationMatches(candidate, entry)) return true;
        }
      }
      return false;
    }

    recordDurableRegeneration(event, startSeq, revision) {
      const entry = normalizeRegenerationEntry(event, "durable", startSeq, revision);
      if (!entry) return;
      this.storeRegeneration(this.durableRegenerations, entry, this.maxDurableItems);
      for (const [parentId, liveGroup] of this.liveRegenerations) {
        for (const [key, liveEntry] of liveGroup) {
          if (regenerationMatches(liveEntry, entry)) {
            liveGroup.delete(key);
          }
        }
        if (liveGroup.size === 0) this.liveRegenerations.delete(parentId);
      }
    }

    buildTurnRegenerationStateMap() {
      if (this.durableRegenerations.size === 0 && this.liveRegenerations.size === 0) {
        return null;
      }
      const allEntries = [];
      const childToParent = new Map();
      for (const group of this.durableRegenerations.values()) {
        for (const entry of group.values()) {
          allEntries.push(entry);
          if (entry.requestId && entry.parentRequestId && entry.requestId !== entry.parentRequestId) {
            childToParent.set(entry.requestId, entry.parentRequestId);
          }
        }
      }
      for (const group of this.liveRegenerations.values()) {
        for (const entry of group.values()) {
          if (allEntries.some((existing) => regenerationMatches(existing, entry))) continue;
          allEntries.push(entry);
          if (entry.requestId && entry.parentRequestId && entry.requestId !== entry.parentRequestId) {
            childToParent.set(entry.requestId, entry.parentRequestId);
          }
        }
      }
      if (allEntries.length === 0) return null;

      const resolveRootParent = (parentId) => {
        let current = parentId;
        const visited = new Set();
        while (childToParent.has(current) && !visited.has(current)) {
          visited.add(current);
          current = childToParent.get(current);
        }
        return current;
      };

      const grouped = new Map();
      for (const entry of allEntries) {
        const rootParent = resolveRootParent(entry.parentRequestId);
        let list = grouped.get(rootParent);
        if (!list) {
          list = [];
          grouped.set(rootParent, list);
        }
        list.push(entry);
      }

      const states = new Map();
      for (const [parentRequestId, list] of grouped) {
        list.sort(compareRegenerationEntries);
        const latestRegen = list[list.length - 1];
        let latestEdit = null;
        const supersededRequestIds = new Set([parentRequestId]);
        const supersededRunIds = new Set();
        for (const entry of list) {
          if (entry.editResend) latestEdit = entry;
          if (entry.requestId) supersededRequestIds.add(entry.requestId);
          if (entry.parentRequestId) supersededRequestIds.add(entry.parentRequestId);
          if (entry.parentRunId) supersededRunIds.add(entry.parentRunId);
          if (entry.runId) supersededRunIds.add(entry.runId);
        }
        if (latestRegen.requestId) supersededRequestIds.delete(latestRegen.requestId);
        if (latestRegen.runId) supersededRunIds.delete(latestRegen.runId);
        states.set(parentRequestId, {
          parentRequestId,
          latestRegen,
          latestEdit,
          supersededRequestIds,
          supersededRunIds,
        });
      }
      return states;
    }

    isRecordSupersededInTurn(record, turnState) {
      if (!turnState?.latestRegen) return false;
      const latest = turnState.latestRegen;
      const reqId = typeof record?.event?.requestId === "string" ? record.event.requestId.trim() : "";
      const runId = typeof record?.event?.runId === "string" ? record.event.runId.trim() : "";
      if ((latest.requestId && reqId === latest.requestId) || (latest.runId && runId === latest.runId)) {
        return false;
      }
      if ((reqId && turnState.supersededRequestIds.has(reqId))
        || (runId && turnState.supersededRunIds.has(runId))) {
        return true;
      }
      if (latest.seq > 0) {
        return record.startSeq <= latest.seq;
      }
      return false;
    }

    items() {
      if (this._itemsCache) return this._itemsCache;
      const entities = new Map(this.durable);
      for (const [id, record] of this.live) if (!entities.has(id)) entities.set(id, record);
      const regenStates = this.buildTurnRegenerationStateMap();
      const sortedRecords = [...entities.values()]
        .filter((record) => record.kind !== "metadata" && record.kind !== "control")
        .sort(compareTimelineRecords);

      let activeTurn = null;
      this._itemsCache = sortedRecords.map((record) => {
        const isUser = record.kind === "message" && normalizedRole(record.event) === "user";
        let latestEdit = null;
        let foldedParent = "";
        if (isUser) {
          const requestId = typeof record.event?.requestId === "string" ? record.event.requestId.trim() : "";
          activeTurn = requestId && regenStates ? (regenStates.get(requestId) || null) : null;
          latestEdit = activeTurn?.latestEdit || null;
        } else if (activeTurn) {
          if (this.isRecordSupersededInTurn(record, activeTurn)) {
            foldedParent = activeTurn.parentRequestId;
          }
        }

        const regenSignature = latestEdit
          ? `edit:${latestEdit.signature}`
          : (foldedParent ? `fold:${foldedParent}` : "");
        const cached = this._itemCacheByRecord.get(record);
        if (cached && cached.regenSignature === regenSignature) {
          return cached.item;
        }

        const projectedEvent = { ...record.event };
        let revision = record.revision;
        if (latestEdit) {
          projectedEvent.content = latestEdit.prompt;
          projectedEvent.text = latestEdit.prompt;
          projectedEvent.images = [...latestEdit.images];
          projectedEvent.attachments = [...latestEdit.attachments];
          projectedEvent.bodyAvailable = false;
          projectedEvent.bodyLoaded = true;
          delete projectedEvent.bodyPreview;
          delete projectedEvent.bodyRef;
          revision = Math.max(revision, latestEdit.revision || latestEdit.seq || 0);
        }

        const item = {
          id: record.id,
          kind: record.kind,
          seq: record.startSeq,
          startSeq: record.startSeq,
          endSeq: record.endSeq,
          revision,
          completed: record.completed,
          source: record.source,
          ...(foldedParent ? { foldedParentRequestId: foldedParent } : {}),
          event: projectedEvent,
          sourceEvent: { ...record.event },
        };
        this._itemCacheByRecord.set(record, { regenSignature, item });
        return item;
      });
      return this._itemsCache;
    }

    snapshot() {
      const items = this.items();
      const earliestSeq = items.reduce((value, item) => !value || (item.startSeq && item.startSeq < value) ? item.startSeq : value, 0);
      return {
        sessionId: this.sessionId,
        items,
        latestSeq: this.durableCursor,
        earliestSeq,
        nextBeforeSeq: positiveInteger(this.pagination.nextBeforeSeq) || positiveInteger(this.pagination.oldestSeq) || earliestSeq || null,
        hasMoreBefore: this.pagination.hasMoreBefore === true,
        gapExpectedSeq: null,
        pendingCount: 0,
        invalidEvents: [],
        changeSet: this.lastChange,
      };
    }

    finish(before, acceptedEvents, reset) {
      const after = this.snapshot();
      const previous = new Map((before.items || []).map((item) => [item.id, item]));
      const current = new Map(after.items.map((item) => [item.id, item]));
      const changedIds = [];
      const insertedIds = [];
      const updatedIds = [];
      const removedIds = [];
      for (const [id, item] of current) {
        const prior = previous.get(id);
        // Record identity is stable for an unchanged entity. This keeps the
        // hot path O(number of visible entities) without recursively
        // stringifying every message body for each streamed event.
        if (prior && prior === item) continue;
        changedIds.push(id);
        (prior ? updatedIds : insertedIds).push(id);
      }
      for (const id of previous.keys()) if (!current.has(id)) removedIds.push(id);
      this.lastChange = {
        changedIds,
        removedIds,
        changedItems: changedIds.map((id) => current.get(id)).filter(Boolean),
        acceptedEvents: acceptedEvents.map((event) => ({ ...event })),
        insertedIds,
        updatedIds,
        reset: reset === true,
        gapExpectedSeq: null,
      };
      return this.snapshot();
    }

    getChangeSet() { return this.lastChange; }
  }

  const proto = TimelineProjector.prototype;
  const baseLiveScope = proto.liveScope;
  const baseSameMessageScope = proto.sameMessageScope;
  const baseCanReuseLive = proto.canReuseLiveMessageEntity;

  proto.liveScope = function liveScopeWithAsyncIsolation(event) {
    const scope = baseLiveScope.call(this, event);
    if (!scope || !isAsyncDeliveryMessageEvent(event)) return scope;
    const identity = asyncDeliveryMessageIdentity(event);
    return identity ? `${scope}:async:${identity}` : `${scope}:async`;
  };

  proto.sameMessageScope = function sameMessageScopeWithAsyncIsolation(a, b) {
    const asyncA = isAsyncDeliveryMessageEvent(a);
    const asyncB = isAsyncDeliveryMessageEvent(b);
    if (asyncA !== asyncB) return false;
    if (asyncA && asyncB) return sameAsyncDeliveryIdentity(a, b);
    return baseSameMessageScope.call(this, a, b);
  };

  proto.canReuseLiveMessageEntity = function canReuseLiveWithAsyncIsolation(previous, incoming) {
    const asyncPrev = isAsyncDeliveryMessageEvent(previous);
    const asyncInc = isAsyncDeliveryMessageEvent(incoming);
    if (asyncPrev || asyncInc) {
      return asyncPrev && asyncInc && sameAsyncDeliveryIdentity(previous, incoming);
    }
    return baseCanReuseLive.call(this, previous, incoming);
  };

  root.RagentTimelineProjector = Object.freeze({
    TimelineProjector,
    getEventStartSeq,
    getEventBoundarySeq,
    getEventEntityId: entityIdFor,
    getEventSourceKey: sourceKeyFor,
    getEventKind: kindFor,
    isControlEvent,
    stableStringify,
  });
})(typeof globalThis !== "undefined" ? globalThis : {});
