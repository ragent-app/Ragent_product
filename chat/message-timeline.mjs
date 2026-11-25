// Message identity belongs to the protocol, never to a particular UI surface.
const value = (input) => typeof input === 'string' ? input.trim() : '';
export const MESSAGE_TIMELINE_VERSION = 2;
export function isMessageTimelineEvent(event) {
  return ['message', 'message_start', 'user_message', 'assistant_message', 'text_delta', 'assistant_delta'].includes(event?.type);
}
export function withMessageTimelineIdentity(event) {
  if (!isMessageTimelineEvent(event)) return event;
  const role = event.role || (event.type === 'user_message' ? 'user' : 'assistant');
  const upstream = value(event.messageId || event.providerMessageId || event.providerItemId || event.streamItemId || event.entityId);
  const block = event.providerContentBlockIndex ?? event.messageBlockIndex ?? 0;
  const fallback = value(event.providerReplayFingerprint || event.id || event.eventId || event.providerEventId) || `seq:${event.seq || 0}`;
  const providerScope = event.provider === 'codex' && value(event.providerThreadId) && value(event.providerTurnId)
    ? [value(event.providerThreadId), value(event.providerTurnId)] : [];
  const identity = value(event.canonicalMessageId) || `m2:${JSON.stringify([value(event.runId), role, upstream || fallback, block, ...providerScope])}`;
  const delta = event.type.includes('delta');
  return {
    ...event, canonicalMessageId: identity, timelineEntityId: identity,
    messageProtocolVersion: MESSAGE_TIMELINE_VERSION,
    textMode: event.textMode || (delta ? 'delta' : 'snapshot'),
    messageState: event.messageState || (delta ? 'streaming' : 'completed'),
    ...(event.seq > 0 ? { firstSeq: event.firstSeq || event.seq, lastEventSeq: event.lastEventSeq || event.seq } : {}),
  };
}

/** Compatibility projection for old histories. Distinct upstream ids remain distinct. */
export function projectMessageTimelineIdentities(events) {
  const firstById = new Map();
  return events.map((source) => {
    const event = withMessageTimelineIdentity(source);
    if (!event.canonicalMessageId) return event;
    const firstSeq = firstById.get(event.canonicalMessageId) ?? event.firstSeq;
    firstById.set(event.canonicalMessageId, firstSeq);
    return { ...event, firstSeq };
  });
}
