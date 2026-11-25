import { buildSessionHierarchyProjection } from './session-hierarchy.mjs';
import { SESSION_API_PRIVATE_FIELDS } from './session-api-mutation-contract.mjs';
import { withTurnProgressText } from './session-display-events.mjs';

function cloneJson(value) {
  if (value === null || value === undefined) return value;
  return JSON.parse(JSON.stringify(value));
}

function stripSessionShape(session, {
  includeQueuedMessages = false,
} = {}) {
  if (!session || typeof session !== 'object') return null;
  const cloned = cloneJson(session);
  const hierarchy = cloned.sessionHierarchy && typeof cloned.sessionHierarchy === 'object'
    ? cloned.sessionHierarchy
    : buildSessionHierarchyProjection(cloned);
  cloned.sessionHierarchy = hierarchy;
  cloned.sessionLevel = hierarchy.level;
  cloned.sessionCategory = hierarchy.category;
  cloned.isRootSession = hierarchy.isRoot;
  if (hierarchy.rootSessionId) cloned.rootSessionId = hierarchy.rootSessionId;
  const forkSourceId = typeof cloned.forkedFromSessionId === 'string'
    ? cloned.forkedFromSessionId.trim()
    : '';
  const persistedParentSessionId = typeof cloned.parentSessionId === 'string'
    ? cloned.parentSessionId.trim()
    : '';
  const parentSessionId = typeof hierarchy.parentSessionId === 'string' && hierarchy.parentSessionId.trim()
    ? hierarchy.parentSessionId.trim()
    : (persistedParentSessionId && persistedParentSessionId !== forkSourceId
      ? persistedParentSessionId
      : (typeof cloned.delegatedFromSessionId === 'string' ? cloned.delegatedFromSessionId.trim() : ''));
  if (parentSessionId) {
    cloned.isDelegatedSession = true;
    cloned.parentSessionId = parentSessionId;
  } else if (cloned.isDelegatedSession !== true) {
    delete cloned.isDelegatedSession;
    delete cloned.parentSessionId;
    delete cloned.parentSessionName;
  }
  cloned.isInternalSession = typeof cloned.internalRole === 'string' && cloned.internalRole.trim() ? true : false;
  for (const field of SESSION_API_PRIVATE_FIELDS) delete cloned[field];
  delete cloned.task;
  delete cloned.sourceContext;
  delete cloned.forkIdempotencyKey;
  delete cloned.creationRequest;
  delete cloned.delegatedFromSessionId;
  delete cloned.delegatedAt;
  if (!includeQueuedMessages) {
    delete cloned.queuedMessages;
  }
  return cloned;
}

export function createSessionListItem(session) {
  return stripSessionShape(session, { includeQueuedMessages: false });
}

// Compact collection projection for clients that explicitly request summary
// view. Keep the fields used by the native session list and its status logic;
// detailed session and transcript data stay on the existing detail routes.
export function createCompactSessionListItem(session) {
  if (!session || typeof session !== 'object') return null;
  const fields = ['id', 'title', 'name', 'projectId', 'templateId', 'status', 'latestSeq',
    'lastActivityAt', 'lastEventAt', 'updatedAt', 'created', 'lastAssistantMessageAt',
    'lastReviewedAt', 'workflowStateChangedAt', 'workflowState', 'waitingAction', 'attentionKind'];
  const compact = Object.fromEntries(fields.filter((field) => Object.hasOwn(session, field))
    .map((field) => [field, session[field]]));
  const run = session.activity?.run;
  if (run && typeof run === 'object') {
    compact.activity = { run: Object.fromEntries(['state', 'kind']
      .filter((field) => Object.hasOwn(run, field)).map((field) => [field, run[field]])) };
  }
  return compact;
}

// Android's durable event DTO does not consume run-level provider capabilities.
// Keep every event and all other fields intact, including message/tool content.
export function compactMobileDurableEvents(events) {
  return events.map((event) => {
    if (!event || typeof event !== 'object' || Array.isArray(event)) return event;
    const { providerCapabilities, ...rest } = event;
    return withTurnProgressText(rest);
  });
}

export function createSessionDetail(session) {
  return stripSessionShape(session, { includeQueuedMessages: true });
}
