import { createHash } from 'node:crypto';
import { sessionApiError, sessionApiIdentifier } from './session-api-mutation-contract.mjs';

export const RUN_API_LIST_LIMIT = 32;
export const RUN_API_LIST_SCAN_LIMIT = 2048;
export const RUN_API_EVENT_SCAN_LIMIT = 128;
export const RUN_API_EVENT_TEXT_BYTES = 8192;
export const RUN_API_RESPONSE_BYTES = 128 * 1024;
export const RUN_API_MAX_WAIT_MS = 30000;
export const RUN_API_PATH = '/api/sessions/{sessionId}/app-api-runs';
export const RUN_API_ITEM_PATH = `${RUN_API_PATH}/{runId}`;
export const runApiHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function runApiIdentifier(value, maximum = 256) {
  sessionApiIdentifier(value, maximum);
  if (value !== value.trim() || !value.isWellFormed() || ['.', '..'].includes(value) || /[\\/]/.test(value))
    throw sessionApiError('INVALID_ARGUMENT', 400, 'Invalid Run resource identity');
  return value;
}
export function runApiInteger(value, minimum, maximum, fallback) {
  if (value == null) return fallback;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw sessionApiError('INVALID_ARGUMENT', 400, 'Invalid Run query integer');
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum)
    throw sessionApiError('INVALID_ARGUMENT', 400, 'Run query integer is outside its limit');
  return number;
}
export function runApiText(value, maximum) {
  if (typeof value !== 'string') return { text: null, truncated: false };
  const bytes = Buffer.from(value, 'utf8');
  let end = Math.min(bytes.length, maximum);
  if (end < bytes.length) while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return { text: bytes.subarray(0, end).toString('utf8'), truncated: end < bytes.length };
}
function stamp(value) {
  return typeof value === 'string' && value.length <= 32 && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString() : null;
}
export function projectApiRun(run) {
  runApiIdentifier(run?.id); runApiIdentifier(run?.sessionId);
  if (typeof run.state !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(run.state) || !stamp(run.createdAt) || !stamp(run.updatedAt))
    throw sessionApiError('RUN_PUBLICATION_UNAVAILABLE', 503, 'Run state publication is invalid');
  const value = { version: 1, sessionId: run.sessionId, runId: run.id, state: run.state,
    terminal: ['completed', 'failed', 'cancelled'].includes(run.state),
    createdAt: stamp(run.createdAt), updatedAt: stamp(run.updatedAt), startedAt: stamp(run.startedAt),
    completedAt: stamp(run.completedAt), cancelRequested: run.cancelRequested === true,
    cancelRequestedAt: stamp(run.cancelRequestedAt),
    ...(run.cancelRequested === true && ['attempted', 'unconfirmed'].includes(run.cancellationCleanupStatus)
      ? { cancellationCleanupStatus: run.cancellationCleanupStatus } : {}),
    launchAdmittedAt: stamp(run.messageLaunchAdmittedAt), dispatched: Boolean(run.runnerStartedAt || run.runnerLifecycleAcceptedAt) };
  return { ...value, revision: runApiHash(value) };
}
const EVENT_TYPES = new Set(['message', 'status', 'tool_use', 'tool_result', 'text_delta', 'reasoning',
  'plan', 'approval_request', 'approval_response', 'usage', 'context_operation', 'work_state_update', 'file_change', 'attachment_delivery']);
export function projectApiRunEvent(event, runId) {
  // Explicitly attributed durable events only. A response/request ID is not
  // enough to adopt another Run's record; inherited fork events have no Run ID.
  if (event?.runId !== runId && !(event?.runId == null && event?.resultRunId === runId)) return null;
  if (!Number.isSafeInteger(event.seq) || event.seq < 1)
    throw sessionApiError('SESSION_HISTORY_CORRUPT', 503, 'Invalid Run event sequence');
  const type = EVENT_TYPES.has(event.type) ? event.type : 'other';
  const timestamp = typeof event.timestamp === 'number' && Number.isFinite(event.timestamp)
    ? stamp(new Date(event.timestamp).toISOString()) : stamp(event.timestamp);
  const raw = ['message', 'status', 'reasoning', 'context_operation', 'work_state_update'].includes(type) ? event.content
    : type === 'text_delta' ? event.text : type === 'tool_result' ? event.output : null;
  const body = runApiText(raw, RUN_API_EVENT_TEXT_BYTES);
  const role = ['user', 'assistant', 'system'].includes(event.role) ? event.role : null;
  return { seq: event.seq, runId, type, role, timestamp, text: body.text,
    textTruncated: body.truncated || event.bodyTruncated === true || (event.bodyAvailable === true && event.bodyLoaded === false),
    toolName: type === 'tool_use' || type === 'tool_result' ? runApiText(event.toolName, 256).text : null };
}
export function parseRunCancellation(value, now = Date.now()) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== 2 || value.version !== 1 || !Object.hasOwn(value, 'expiresAt') ||
      typeof value.expiresAt !== 'string' || value.expiresAt.length !== 24 ||
      !Number.isFinite(Date.parse(value.expiresAt)) || new Date(value.expiresAt).toISOString() !== value.expiresAt)
    throw sessionApiError('INVALID_ARGUMENT', 400, 'Invalid Run cancellation deadline');
  const end = Date.parse(value.expiresAt);
  if (end <= now) throw sessionApiError('REQUEST_EXPIRED', 410, 'Run cancellation request expired');
  if (end - now > 86400000) throw sessionApiError('INVALID_ARGUMENT', 400, 'Run cancellation deadline is too distant');
  return Object.freeze({ version: 1, expiresAt: value.expiresAt });
}
