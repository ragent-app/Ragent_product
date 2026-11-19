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
