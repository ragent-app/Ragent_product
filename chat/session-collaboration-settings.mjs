import { getApp } from './apps.mjs';
import { findSessionMeta, flushSessionsMetaNow, mutateSessionMeta } from './session-meta-store.mjs';
import { normalizeCollaborationPolicy, normalizeSessionCollaborationOverrides, resolveSessionCollaborationPolicy } from './collaboration-policy.mjs';

function failure(message, statusCode, code) {
  return Object.assign(new Error(message), { statusCode, code });
}

function assertRoot(session) {
  if (!session) throw failure('Session not found', 404, 'SESSION_NOT_FOUND');
  if (session.sessionClass !== 'ROOT_LEADERSHIP' || (session.sessionPlane || 'user') !== 'user'
      || session.userAddressable === false || session.parentSessionId || session.delegatedFromSessionId) {
    throw failure('Only a user root session can configure collaboration', 403, 'COLLABORATION_ROOT_REQUIRED');
  }
}

async function view(session) {
  assertRoot(session);
  const app = session.templateId ? await getApp(session.templateId) : null;
  const baseSession = { ...session, collaborationPolicyOverrides: undefined };
  const base = resolveSessionCollaborationPolicy(baseSession, app);
  const overrides = normalizeSessionCollaborationOverrides(session.collaborationPolicyOverrides);
  const source = Object.keys(overrides).length ? 'session_override'
    : normalizeCollaborationPolicy(app?.collaborationPolicy) ? 'agent'
      : normalizeCollaborationPolicy(session.collaborationPolicy) ? 'session' : 'root_default';
  return { sessionId: session.id, override: Object.keys(overrides).length ? overrides : null,
    effective: resolveSessionCollaborationPolicy(session, app), source,
    baseCanDelegate: base.role === 'manager' && base.canDelegate === true,
    revision: Number.isSafeInteger(session.collaborationPolicyOverrideRevision) ? session.collaborationPolicyOverrideRevision : 0,
    appliesTo: 'ragent_collaboration', nativeHarnessEnforced: false, existingOrganizationsChanged: false };
}

export async function readSessionCollaborationSettings(sessionId) {
  return view(await findSessionMeta(sessionId));
}

export async function writeSessionCollaborationSettings(sessionId, { expectedRevision, override } = {}) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
    throw failure('Invalid expected revision', 400, 'INVALID_REVISION');
  const requested = override === null ? {} : normalizeSessionCollaborationOverrides(override, { strict: true });
  const before = await readSessionCollaborationSettings(sessionId);
  if (override?.canDelegate === true && !before.baseCanDelegate)
    throw failure('The base policy does not allow delegation', 403, 'COLLABORATION_POLICY_DENIED');
  const result = await mutateSessionMeta(sessionId, (draft) => {
    assertRoot(draft);
    const revision = Number.isSafeInteger(draft.collaborationPolicyOverrideRevision) ? draft.collaborationPolicyOverrideRevision : 0;
    if (revision !== expectedRevision) throw failure('Collaboration settings changed', 409, 'COLLABORATION_SETTINGS_CONFLICT');
    const current = normalizeSessionCollaborationOverrides(draft.collaborationPolicyOverrides);
    if (JSON.stringify(current) === JSON.stringify(requested)) return false;
    if (Object.keys(requested).length) draft.collaborationPolicyOverrides = requested;
    else delete draft.collaborationPolicyOverrides;
    draft.collaborationPolicyOverrideRevision = revision + 1;
    draft.updatedAt = new Date().toISOString();
    return true;
  });
  if (!result.meta) throw failure('Session not found', 404, 'SESSION_NOT_FOUND');
  if (result.changed) await flushSessionsMetaNow();
  return view(result.meta);
}
