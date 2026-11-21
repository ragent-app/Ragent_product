// attention-push.mjs — fire a web push when a session needs the user's
// attention (a pending approval / question the model is waiting on). Fired from
// history.mjs when a live approval_request event lands, so the user learns the
// exact waiting kind (plan / dangerous action / approve / answer) immediately.
//
// Deliberately decoupled: session + push are loaded lazily via dynamic import so
// this module can be used by low-level history.mjs without creating an import
// cycle. Debounced per approvalId so only the first live append notifies.
import { createKeyedTaskQueue } from './fs-utils.mjs';
import { createHash } from 'crypto';
import { enqueueAccountPush } from './account-push-outbox.mjs';

const notifyQueue = createKeyedTaskQueue();

// Map an approval_request event to a user-facing waiting label + kind.
function describeApproval(event = {}) {
  const kind = String(event?.kind || '').trim().toLowerCase();
  const risk = String(
    event?.risk ?? event?.riskLevel ?? event?.severity ?? event?.level ?? event?.tier ?? '',
  ).trim().toLowerCase();
  const danger = ['high', 'critical', 'danger', 'dangerous', 'severe', 'elevated'].includes(risk);
  if (kind === 'plan') {
    return { kind: 'plan', label: 'plan awaiting approval' };
  }
  if (kind === 'permissions' || kind === 'permission' || event?.permissions) {
    return { kind: 'permission', label: 'permission awaiting approval' };
  }
  if (kind === 'question' || event?.question || Array.isArray(event?.questions) && event.questions.length > 0) {
    return { kind: 'answer', label: 'awaiting your reply' };
  }
  if (danger) {
    return { kind: 'danger', label: 'dangerous action awaiting approval' };
  }
  return { kind: 'approval', label: 'an approval is needed' };
}

function isProgressPlan(event = {}) {
  const kind = String(event?.kind || '').trim().toLowerCase();
  const type = String(event?.type || '').trim().toLowerCase();
  if (kind !== 'plan' && type !== 'plan') return false;
  const intent = String(event?.planIntent || '').trim().toLowerCase();
  if (intent) return intent === 'progress';
  return String(event?.interactionMode || '').trim().toLowerCase() === 'agent';
}

function approvalEventId(event = {}) {
  const value = event.approvalId || event.providerApprovalId
    || (event.type === 'privileged_batch_request' || event.type === 'approved_action_batch_request' ? event.batchId : '');
  return typeof value === 'string' && value.length <= 512 && !/[\u0000-\u001f]/.test(value) ? value.trim() : '';
}

// Prepare the durable intent before the canonical history write. The outbox
// verifies this exact sequence and event before submitting it to Accounts.
export async function prepareApprovalPush(sessionId, event, requestSeq = null) {
  const request = ['approval_request', 'privileged_batch_request', 'approved_action_batch_request'].includes(event?.type);
  const response = ['approval_response', 'privileged_batch_response', 'approved_action_batch_response'].includes(event?.type);
  if ((!request && !response) || (request && isProgressPlan(event))) return;
  const approvalId = approvalEventId(event);
  if (!approvalId || !Number.isSafeInteger(event.seq)) return;
  const generation = String(request ? event.seq : requestSeq || '');
  if (!/^[1-9][0-9]*$/.test(generation)) return;
  const eventId = `${response ? 'resolved' : 'approval'}-${createHash('sha256').update(JSON.stringify([sessionId, approvalId, generation, ...(response ? [event.seq] : [])])).digest('hex')}`;
  await enqueueAccountPush({ sessionId, kind: response ? 'attention_resolved' : describeApproval(event).kind,
    eventId, awaitingKey: approvalId, generation, runId: typeof event.runId === 'string' ? event.runId : '',
    occurredAt: event.timestamp, historySource: { seq: event.seq, type: event.type } });
}

// A response with no run id is safe only when exactly one unresolved request
// with that approval id exists. Never borrow the current session's run id.
export function resolveApprovalRequestSeq(events, response) {
  const id = approvalEventId(response);
  if (!id) return null;
  const pairs = { approval_response: 'approval_request', privileged_batch_response: 'privileged_batch_request', approved_action_batch_response: 'approved_action_batch_request' };
  const requestType = pairs[response?.type];
  if (!requestType) return null;
  const open = [];
  for (const event of events) {
    if (approvalEventId(event) !== id) continue;
    if (event.type === requestType) open.push(event);
    else if (event.type === response.type) {
      const run = String(event.runId || '').trim();
      const matching = open.filter((item) => !run || String(item.runId || '').trim() === run);
      if (matching.length === 1) open.splice(open.indexOf(matching[0]), 1);
    }
  }
  const run = String(response.runId || '').trim();
  const candidates = open.filter((item) => !run || String(item.runId || '').trim() === run);
  return candidates.length === 1 && Number.isSafeInteger(candidates[0].seq) ? candidates[0].seq : null;
}

export async function maybeNotifyApprovalPending(sessionId, event) {
  if (!sessionId || !event) return false;
  if (event.type !== 'approval_request'
    && event.type !== 'privileged_batch_request'
    && event.type !== 'approved_action_batch_request') return false;
  if (isProgressPlan(event)) return false;
  // Privileged batches carry their id in batchId (no approvalId); the debounce
  // key uses whichever id the event type actually has.
  const approvalId = approvalEventId(event);
  if (!approvalId) return false;
  const key = `${sessionId}:${approvalId}`;
  return notifyQueue(key, async () => {
    try {
      const { getSession } = await import('./session-manager.mjs');
      const { sendUserAttentionPush } = await import('./push.mjs');
      const session = await getSession(sessionId).catch(() => null);
      if (!session?.id) return false;
      const detail = {
        ...describeApprovalEvent(event),
        eventId: `approval-${createHash('sha256').update(JSON.stringify([sessionId, approvalId, String(event.seq || '')])).digest('hex')}`,
        runId: typeof event.runId === 'string' && event.runId.length <= 256 ? event.runId : '',
        occurredAt: event.timestamp,
        webOnly: true,
      };
      await sendUserAttentionPush({ ...session, id: sessionId }, detail);
      return true;
    } catch (error) {
      console.error(`[attention-push] session ${String(sessionId).slice(0, 8)}: ${error?.message || error}`);
      return false;
    }
  });
}

export function describeApprovalEvent(event = {}) {
  const detail = describeApproval(event);
  const key = approvalEventId(event);
  return key ? { ...detail, key } : detail;
}

const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,160}$/;
const SAFE_TOKEN_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ATTENTION_TTL_MS = 15 * 60_000;
const TERMINAL_TTL_MS = 24 * 60 * 60_000;

const RESPONSIBILITY_EVENT_MAP = Object.freeze({
  plan_proposed: {
    category: 'plan_awaiting_approval',
    kind: 'plan',
    ttlMs: ATTENTION_TTL_MS,
    body: 'A responsibility plan is awaiting your approval.',
  },
  plan_awaiting_approval: {
    category: 'plan_awaiting_approval',
    kind: 'plan',
    ttlMs: ATTENTION_TTL_MS,
    body: 'A responsibility plan is awaiting your approval.',
  },
  planning_needs_input: {
    category: 'needs_user_input',
    kind: 'answer',
    ttlMs: ATTENTION_TTL_MS,
    body: 'A responsibility needs your input.',
  },
  needs_user_input: {
    category: 'needs_user_input',
    kind: 'answer',
    ttlMs: ATTENTION_TTL_MS,
    body: 'A responsibility needs your input.',
  },
  planning_invalid_output: {
    category: 'blocked',
    kind: 'attention',
    ttlMs: ATTENTION_TTL_MS,
    body: 'A responsibility planner output was rejected and needs attention.',
  },
  plan_admission_blocked: {
    category: 'blocked',
    kind: 'attention',
    ttlMs: ATTENTION_TTL_MS,
    body: 'A responsibility plan could not be admitted and needs attention.',
  },
  planning_evidence_blocked: {
    category: 'blocked',
    kind: 'attention',
    ttlMs: ATTENTION_TTL_MS,
    body: 'A responsibility is waiting on verification evidence.',
  },
  decision_waiting: {
    category: 'blocked',
    kind: 'attention',
    ttlMs: ATTENTION_TTL_MS,
    body: 'A responsibility is blocked and needs your attention.',
  },
  blocked: {
    category: 'blocked',
    kind: 'attention',
    ttlMs: ATTENTION_TTL_MS,
    body: 'A responsibility is blocked and needs your attention.',
  },
  budget_blocked: {
    category: 'budget_rejected',
    kind: 'attention',
    ttlMs: ATTENTION_TTL_MS,
    body: 'A responsibility was blocked by its admission budget.',
  },
  budget_rejected: {
    category: 'budget_rejected',
    kind: 'attention',
    ttlMs: ATTENTION_TTL_MS,
    body: 'A responsibility was blocked by its admission budget.',
  },
  execution_attempt_failed: {
    category: 'attempt_failed',
    kind: 'attention',
    ttlMs: ATTENTION_TTL_MS,
    body: 'A responsibility execution attempt failed.',
  },
  attempt_failed: {
    category: 'attempt_failed',
    kind: 'attention',
    ttlMs: ATTENTION_TTL_MS,
    body: 'A responsibility execution attempt failed.',
  },
  workflow_completed: {
    category: 'workflow_completed',
    kind: 'completion',
    ttlMs: TERMINAL_TTL_MS,
    body: 'A responsibility workflow finished and awaits review.',
  },
});

function safeBoundedId(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return SAFE_ID_RE.test(text) ? text : '';
}

function boundIdentity(prefix, raw) {
  if (Buffer.byteLength(raw, 'utf8') <= 256 && !/[\u0000-\u001f]/.test(raw)) return raw;
  return `${prefix}-${createHash('sha256').update(raw).digest('hex')}`;
}

export function describeResponsibilityNotification(type, details = {}) {
  const activityType = typeof type === 'string' ? type.trim() : '';
  const meta = RESPONSIBILITY_EVENT_MAP[activityType];
  if (!meta) return null;
  const parsed = details && typeof details === 'object' && !Array.isArray(details) ? details : {};
  return {
    category: meta.category,
    activityType,
    kind: meta.kind,
    ttlMs: meta.ttlMs,
    title: 'Ragent',
    body: meta.body,
    planId: safeBoundedId(parsed.planId),
    workflowInstanceId: safeBoundedId(parsed.workflowInstanceId),
    workItemId: safeBoundedId(parsed.workItemId),
  };
}

export function buildResponsibilityAwaitingKey({ responsibilityId, category, activityType, planId = '' }) {
  const rid = safeBoundedId(responsibilityId);
  const act = typeof category === 'string' ? category.trim() : '';
  const raw = typeof activityType === 'string' ? activityType.trim() : '';
  const pid = planId ? safeBoundedId(planId) : '';
  if (!rid || !SAFE_TOKEN_RE.test(act) || !SAFE_TOKEN_RE.test(raw) || (planId && !pid)) {
    throw new Error('Invalid responsibility notification identity');
  }
  const encoded = `resp:v1:rid=${rid}&act=${act}&raw=${raw}${pid ? `&pid=${pid}` : ''}`;
  if (Buffer.byteLength(encoded, 'utf8') > 512 || /[\u0000-\u001f]/.test(encoded)) {
    throw new Error('Responsibility notification key exceeds bounds');
  }
  return encoded;
}

export function parseResponsibilityAwaitingKey(value) {
  if (typeof value !== 'string' || !value.startsWith('resp:v1:') || Buffer.byteLength(value, 'utf8') > 512 || /[\u0000-\u001f]/.test(value)) {
    return null;
  }
  const fields = Object.create(null);
  for (const part of value.slice('resp:v1:'.length).split('&')) {
    const eq = part.indexOf('=');
    if (eq <= 0) return null;
    const key = part.slice(0, eq);
    const val = part.slice(eq + 1);
    if (Object.hasOwn(fields, key)) return null;
    fields[key] = val;
  }
  const responsibilityId = safeBoundedId(fields.rid);
  const category = typeof fields.act === 'string' && SAFE_TOKEN_RE.test(fields.act) ? fields.act : '';
  const activityType = typeof fields.raw === 'string' && SAFE_TOKEN_RE.test(fields.raw) ? fields.raw : '';
  const planId = fields.pid === undefined ? '' : safeBoundedId(fields.pid);
  if (!responsibilityId || !category || !activityType || (fields.pid !== undefined && !planId)) return null;
  return { responsibilityId, category, activityType, planId };
}

export function buildResponsibilityCloudPushEvent({ responsibilityId, sessionId, sequence, type, details = {}, occurredAt }) {
  const descriptor = describeResponsibilityNotification(type, details);
  if (!descriptor) throw new Error('Unsupported responsibility notification type');
  const rid = safeBoundedId(responsibilityId);
  const sid = safeBoundedId(sessionId);
  const seq = Number(sequence);
  if (!rid || !sid) throw new Error('Responsibility push target identity unavailable');
  if (!Number.isSafeInteger(seq) || seq <= 0 || String(seq).length > 20) {
    throw new Error('Responsibility notification sequence unavailable');
  }
  const when = typeof occurredAt === 'number' ? occurredAt : Date.parse(occurredAt || '');
  if (!Number.isSafeInteger(when) || when <= 0) {
    throw new Error('Responsibility notification timestamp unavailable');
  }
  const awaitingKey = buildResponsibilityAwaitingKey({
    responsibilityId: rid,
    category: descriptor.category,
    activityType: descriptor.activityType,
    planId: descriptor.planId,
  });
  const eventId = boundIdentity('responsibility', `responsibility:${rid}:${seq}`);
  const runId = descriptor.kind === 'completion'
    ? boundIdentity('resp-wf', descriptor.workflowInstanceId ? `resp_wf:${descriptor.workflowInstanceId}` : `resp:${rid}:seq:${seq}`)
    : boundIdentity('resp-seq', `resp:${rid}:seq:${seq}`);
  return {
    sessionId: sid,
    kind: descriptor.kind,
    runId,
    eventId,
    awaitingKey,
    generation: String(seq),
    occurredAt: when,
    expiresAt: when + descriptor.ttlMs,
    descriptor,
  };
}

export async function enqueueResponsibilityAccountPush({ responsibilityId, sessionId, sequence, type, details = {}, occurredAt }) {
  if (process.env.RAGENT_RESPONSIBILITY_PUSH_ENABLED !== '1') {
    throw Object.assign(new Error('Responsibility push delivery is disabled'), { code: 'RESPONSIBILITY_PUSH_DISABLED' });
  }
  const payload = buildResponsibilityCloudPushEvent({ responsibilityId, sessionId, sequence, type, details, occurredAt });
  if (payload.expiresAt <= Date.now()) {
    throw Object.assign(new Error('Responsibility notification expired before cloud push enqueue'), { code: 'RESPONSIBILITY_PUSH_EXPIRED' });
  }
  await enqueueAccountPush({
    sessionId: payload.sessionId,
    kind: payload.kind,
    runId: payload.runId,
    eventId: payload.eventId,
    awaitingKey: payload.awaitingKey,
    generation: payload.generation,
    occurredAt: payload.occurredAt,
  });
  return { persisted: true, ...payload };
}

export async function resolveResponsibilityAccountPush({
  responsibilityId,
  sessionId,
  sequence,
  originalSequence,
  originalType,
  originalDetails = {},
  occurredAt,
}) {
  if (process.env.RAGENT_RESPONSIBILITY_PUSH_ENABLED !== '1') {
    throw Object.assign(new Error('Responsibility push delivery is disabled'), { code: 'RESPONSIBILITY_PUSH_DISABLED' });
  }
  const rid = safeBoundedId(responsibilityId);
  const sid = safeBoundedId(sessionId);
  const seq = Number(sequence);
  const origSeq = Number(originalSequence);
  if (!rid || !sid || !Number.isSafeInteger(seq) || seq <= 0 || !Number.isSafeInteger(origSeq) || origSeq <= 0) {
    throw new Error('Responsibility push resolution identity unavailable');
  }
  const when = typeof occurredAt === 'number' ? occurredAt : Date.parse(occurredAt || '');
  if (!Number.isSafeInteger(when) || when <= 0 || when + TERMINAL_TTL_MS <= Date.now()) {
    throw Object.assign(new Error('Responsibility resolution notification expired'), { code: 'RESPONSIBILITY_PUSH_EXPIRED' });
  }
  const orig = buildResponsibilityCloudPushEvent({
    responsibilityId: rid,
    sessionId: sid,
    sequence: origSeq,
    type: originalType,
    details: originalDetails,
    occurredAt: when,
  });
  if (orig.kind === 'completion') {
    return { persisted: false, skipped: true, reason: 'terminal_not_resolvable' };
  }
  const eventId = boundIdentity('responsibility-resolved', `responsibility-resolved:${rid}:${seq}:${origSeq}`);
  await enqueueAccountPush({
    sessionId: sid,
    kind: 'attention_resolved',
    runId: '',
    eventId,
    awaitingKey: orig.awaitingKey,
    generation: orig.generation,
    occurredAt: when,
  });
  return {
    persisted: true,
    kind: 'attention_resolved',
    eventId,
    awaitingKey: orig.awaitingKey,
    generation: orig.generation,
    occurredAt: when,
    expiresAt: when + TERMINAL_TTL_MS,
  };
}
