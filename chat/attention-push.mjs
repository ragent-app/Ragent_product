// attention-push.mjs — fire a web push when a session needs the user's
// attention (a pending approval / question the model is waiting on). Fired from
// history.mjs when a live approval_request event lands, so the user learns the
// exact waiting kind (plan / dangerous action / approve / answer) immediately.
//
// Deliberately decoupled: session + push are loaded lazily via dynamic import so
// this module can be used by low-level history.mjs without creating an import
// cycle. Debounced per approvalId so only the first live append notifies.
import { createKeyedTaskQueue } from './fs-utils.mjs';

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
        eventId: approvalId.length <= 256 ? approvalId : '',
        runId: typeof event.runId === 'string' && event.runId.length <= 256 ? event.runId : '',
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
