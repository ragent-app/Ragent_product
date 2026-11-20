// S10: Managed Input enforcement. Managed Sessions (sessionPlane ===
// 'organization', persisted by S8) may only receive input through the
// controlled Task -> Attempt -> child Session channel. This module is the
// central gate: every input-bypass surface (fork / fork-at / delegate /
// session-spawn / continuation / message) funnels through
// assertManagedInputAllowed, which rejects managed targets when
// MANAGED_INPUT_ENFORCEMENT is on.
//
// The controlled channel is the one exemption: internal injections from the
// collaboration orchestrator (chat/collaboration-orchestrator.mjs) carry an
// internalOperation marker (e.g. 'collaboration_task' / 'collaboration_resume')
// on their sendMessage options, which the gate treats as allowed input.
import {
  MANAGED_INPUT_ENFORCEMENT,
  ORG_SESSION_ADDRESSABILITY_ENABLED,
} from '../lib/config.mjs';

export const SESSION_CLASSES = Object.freeze([
  'ROOT_LEADERSHIP',
  'MANAGER',
  'WORKER',
  'REVIEWER',
]);
export const MANAGED_SESSION_CLASSES = Object.freeze([
  'MANAGER',
  'WORKER',
  'REVIEWER',
]);
export const SESSION_NOT_USER_ADDRESSABLE = 'SESSION_NOT_USER_ADDRESSABLE';
export const SESSION_CLASS_INVALID = 'SESSION_CLASS_INVALID';
export const MANAGED_SESSION_LINEAGE_INCOMPLETE = 'MANAGED_SESSION_LINEAGE_INCOMPLETE';
// C1: Managed scope is a two-state spectrum for managed sessions.
//   - 'organization'  : existing Organization lineage (root + node + role + revision + controller).
//   - 'consultation'  : Consultation expert sessions (root + consultationRoundId + expertAssignmentId + controller), no Organization node/role/revision required.
export const MANAGED_SCOPES = Object.freeze(['organization', 'consultation']);
export const CONSULTATION_LINEAGE_INCOMPLETE = 'CONSULTATION_LINEAGE_INCOMPLETE';

export function normalizeSessionClass(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.trim().toUpperCase();
  return SESSION_CLASSES.includes(normalized) ? normalized : '';
}

export function isManagedSessionClass(value) {
  return MANAGED_SESSION_CLASSES.includes(normalizeSessionClass(value));
}

// C1: Normalize a managed scope value to 'organization' | 'consultation'.
// Invalid/missing values fall back to 'organization' so existing managed
// sessions (which never carried a managedScope field) keep the legacy
// Organization lineage contract.
export function normalizeManagedScope(value) {
  if (typeof value !== 'string') return 'organization';
  const normalized = value.trim().toLowerCase();
  return MANAGED_SCOPES.includes(normalized) ? normalized : 'organization';
}

function sessionClassError(value) {
  const error = new Error(`Invalid sessionClass: ${String(value || '(empty)')}`);
  error.code = SESSION_CLASS_INVALID;
  error.statusCode = 400;
  return error;
}

export function resolveSessionClass(session) {
  if (!session || typeof session !== 'object') return null;
  const plane = typeof session.sessionPlane === 'string'
    ? session.sessionPlane.trim().toLowerCase()
    : 'user';
  const hasExplicitClass = Object.prototype.hasOwnProperty.call(session, 'sessionClass');
  if (plane === 'system') {
    if (hasExplicitClass) throw sessionClassError(session.sessionClass);
    return null;
  }

  if (!hasExplicitClass
      && plane === 'user'
      && typeof session.delegatedFromSessionId === 'string'
      && session.delegatedFromSessionId.trim()) {
    // Legacy delegated sessions remain legacy user-plane sessions. They are
    // not silently upgraded into the S15 root contract.
    return null;
  }

  if (hasExplicitClass) {
    const normalized = normalizeSessionClass(session.sessionClass);
    if (!normalized) throw sessionClassError(session.sessionClass);
    if (normalized === 'ROOT_LEADERSHIP' && plane !== 'user') throw sessionClassError(session.sessionClass);
    if (MANAGED_SESSION_CLASSES.includes(normalized) && plane !== 'organization') {
      throw sessionClassError(session.sessionClass);
    }
    return normalized;
  }

  // Compatibility projection: old user sessions remain user-addressable, but
  // old organization sessions are deliberately left unclassified.
  return plane === 'user' ? 'ROOT_LEADERSHIP' : null;
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export function assertManagedSessionLineage(session) {
  const sessionClass = resolveSessionClass(session);
  if (!isManagedSessionClass(sessionClass)) return sessionClass;
  const managedScope = normalizeManagedScope(session?.managedScope);
  const rootSessionId = session.organizationRootSessionId || session.rootSessionId;
  const controllerSessionId = session.controllerSessionId;
  if (managedScope === 'consultation') {
    // Consultation lineage: root + consultationRoundId + expertAssignmentId +
    // controller. It deliberately does NOT require Organization node/role/revision.
    const consultationRoundId = session.consultationRoundId;
    const expertAssignmentId = session.expertAssignmentId;
    const complete = hasText(rootSessionId)
      && hasText(consultationRoundId)
      && hasText(expertAssignmentId)
      && hasText(controllerSessionId);
    if (complete) return sessionClass;
    const error = new Error(
      `Consultation session ${session.id || '(unknown)'} has incomplete consultation lineage`,
    );
    error.code = CONSULTATION_LINEAGE_INCOMPLETE;
    error.statusCode = 409;
    throw error;
  }
  const nodeId = session.organizationNodeId || session.nodeId;
  const roleInstanceId = session.roleInstanceId || session.role;
  const revision = session.organizationRevision ?? session.revision;
  const revisionNumber = typeof revision === 'string' && revision.trim() ? Number(revision) : revision;
  const lifecycleMode = typeof session.lifecycleMode === 'string'
    ? session.lifecycleMode.trim().toLowerCase()
    : '';
  const complete = lifecycleMode === 'ephemeral_swarm'
    ? (hasText(rootSessionId)
      && hasText(session.organizationId)
      && hasText(nodeId)
      && hasText(roleInstanceId)
      && hasText(session.parentSessionId)
      && hasText(controllerSessionId)
      && Number.isInteger(revisionNumber)
      && revisionNumber === 0)
    : (hasText(rootSessionId)
      && hasText(nodeId)
      && hasText(roleInstanceId)
      && Number.isInteger(revisionNumber)
      && revisionNumber > 0
      && hasText(controllerSessionId));
  if (complete) return sessionClass;
  const error = new Error(`Managed session ${session.id || '(unknown)'} has incomplete lineage`);
  error.code = MANAGED_SESSION_LINEAGE_INCOMPLETE;
  error.statusCode = 409;
  throw error;
}

export function assertUserAddressable(session, { force = false } = {}) {
  if (!force && !ORG_SESSION_ADDRESSABILITY_ENABLED) return;
  const sessionClass = resolveSessionClass(session);
  const plane = typeof session?.sessionPlane === 'string'
    ? session.sessionPlane.trim().toLowerCase()
    : 'user';
  const userAddressable = session?.userAddressable !== false;
  if (sessionClass === 'ROOT_LEADERSHIP' && plane === 'user' && userAddressable) return;
  const error = new Error(`Session ${session?.id || '(unknown)'} is not user-addressable`);
  error.code = SESSION_NOT_USER_ADDRESSABLE;
  error.statusCode = 403;
  throw error;
}

// Contract §4 error code (HTTP 409 semantics). Registered here so both the
// gate and the HTTP-layer wiring share one constant.
export const MANAGED_SESSION_INPUT_BYPASS = 'MANAGED_SESSION_INPUT_BYPASS';

// Recognized input-bypass operations (constitution §2.10 / §2.16).
export const MANAGED_INPUT_OPERATIONS = Object.freeze([
  'fork',
  'fork-at',
  'delegate',
  'session-spawn',
  'message',
  'continuation',
]);

// C1: Consultation experts (managedScope='consultation') may only be driven by
// the Consultation dispatch channel. The only internalOperation markers the
// gate accepts for them are the consultation channel markers below; any other
// internal injection is treated as a bypass. Organization-scope sessions keep
// the legacy collaboration controlled-channel exemption ('collaboration_task' /
// 'collaboration_resume', plus 'swarm_wakeup' for Swarm @mention doorbells).
const CONSULTATION_INTERNAL_OPERATIONS = new Set([
  'consultation_task',
  'consultation_resume',
]);

export const SWARM_INTERNAL_OPERATIONS = Object.freeze([
  'swarm_wakeup',
]);

// A managed session is one bound to an organization plane (S8 persisted
// sessionPlane === 'organization'). user-plane sessions keep legacy behavior.
export function isManagedSession(session) {
  return !!session && session.sessionPlane === 'organization';
}

// Map an HTTP request path to the creation-type bypass operation it represents,
// or null when the path is not a managed-input bypass surface. Only
// fork/fork-at/delegate are intercepted at the router layer; the
// message/continuation surface lives in router-session-main-routes.mjs, and
// the CLI `session-spawn` command posts to the delegate endpoint, so it maps
// to 'delegate' here.
export function parseManagedInputBypassRoute(pathname) {
  if (typeof pathname !== 'string') return null;
  const match = /^\/api\/sessions\/([^/]+)\/(fork|fork-at|delegate)$/.exec(pathname);
  if (!match) return null;
  return { sessionId: match[1], operation: match[2] };
}

// Central managed-input gate. No-op unless MANAGED_INPUT_ENFORCEMENT is on
// (default behavior unchanged). When on and the target/source session is
// managed:
//   - fork / fork-at / delegate / session-spawn  -> rejected (creation bypass)
//   - continuation / message                     -> rejected UNLESS the message
//     is a controlled-channel internal injection (requestContext carries an
//     internalOperation marker from the collaboration orchestrator).
// Throws an Error with code MANAGED_SESSION_INPUT_BYPASS and HTTP 409
// semantics (statusCode = 409).
export function assertManagedInputAllowed({ session, operation, requestContext = {} } = {}) {
  if (!MANAGED_INPUT_ENFORCEMENT) return;
  if (!session || !isManagedSession(session)) return;
  const isMessagePath = operation === 'message' || operation === 'continuation';
  if (isMessagePath && requestContext?.internalOperation) {
    const managedScope = normalizeManagedScope(session.managedScope);
    if (managedScope !== 'consultation' || CONSULTATION_INTERNAL_OPERATIONS.has(requestContext.internalOperation)) {
      return;
    }
  }
  const error = new Error(
    `MANAGED_SESSION_INPUT_BYPASS: managed session ${session.id || '(unknown)'} rejected ${operation || 'unknown'} input bypass`,
  );
  error.code = MANAGED_SESSION_INPUT_BYPASS;
  error.statusCode = 409;
  throw error;
}
