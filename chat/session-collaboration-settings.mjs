import { getApp } from './apps.mjs';
import { findSessionMeta, flushSessionsMetaNow, mutateSessionMeta } from './session-meta-store.mjs';
import { normalizeCollaborationPolicy, normalizeSessionCollaborationOverrides, resolveSessionCollaborationPolicy } from './collaboration-policy.mjs';
import { normalizeUserRuntimeConstraints } from './organization-runtime-decision.mjs';

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

// Owner-authored constraints are separate from model-generated proposals. Each
// entry carries its explicit scope and the server-assigned settings revision.
export async function readSessionRuntimeConstraints(sessionId) {
  const session = await findSessionMeta(sessionId);
  assertRoot(session);
  return { sessionId, revision: Number.isSafeInteger(session.runtimeConstraintsRevision) ? session.runtimeConstraintsRevision : 0,
    constraints: normalizeScopedConstraints(session.runtimeConstraints || {}) };
}

function normalizeScopedConstraints(value) {
  const result = {};
  for (const [field, raw] of Object.entries(value || {})) {
    if (!['tool', 'provider', 'model', 'effort'].includes(field)) throw failure('Unknown runtime constraint field', 400, 'ORG_RUNTIME_CONSTRAINT_INVALID');
    const entries = Array.isArray(raw) ? raw : [raw];
    if (!entries.length || entries.length > 128) throw failure('Invalid runtime constraints', 400, 'ORG_RUNTIME_CONSTRAINT_INVALID');
    const normalized = entries.map((entry) => normalizeUserRuntimeConstraints({ [field]: entry })[field]);
    if (new Set(normalized.map((entry) => entry.scope)).size !== normalized.length) throw failure('Duplicate runtime constraint scope', 400, 'ORG_RUNTIME_CONSTRAINT_INVALID');
    result[field] = Array.isArray(raw) ? normalized : normalized[0];
  }
  return result;
}

export async function writeSessionRuntimeConstraints(sessionId, { expectedRevision, constraints } = {}) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw failure('Invalid expected revision', 400, 'INVALID_REVISION');
  if (constraints !== null && (!constraints || typeof constraints !== 'object' || Array.isArray(constraints)))
    throw failure('Invalid runtime constraints', 400, 'ORG_RUNTIME_CONSTRAINT_INVALID');
  const raw = constraints || {};
  if (Object.keys(raw).some((field) => !['tool', 'provider', 'model', 'effort'].includes(field)))
    throw failure('Unknown runtime constraint field', 400, 'ORG_RUNTIME_CONSTRAINT_INVALID');
  const requested = {};
  for (const [field, value] of Object.entries(raw)) {
    const entries = Array.isArray(value) ? value : [value];
    const mapped = entries.map((entry) => {
      if (!entry || typeof entry !== 'object' || !['root', 'organization', 'collaboration'].includes(entry.scope) &&
          !(typeof entry.scope === 'string' && /^node:[A-Za-z0-9_.-]{1,160}$/.test(entry.scope)))
        throw failure('Invalid runtime constraint scope', 400, 'ORG_RUNTIME_CONSTRAINT_INVALID');
      return { value: entry.value, mode: entry.mode, scope: entry.scope, source: 'owner', version: expectedRevision + 1 };
    });
    requested[field] = Array.isArray(value) ? mapped : mapped[0];
  }
  const normalized = normalizeScopedConstraints(requested);
  const result = await mutateSessionMeta(sessionId, (draft) => {
    assertRoot(draft);
    const revision = Number.isSafeInteger(draft.runtimeConstraintsRevision) ? draft.runtimeConstraintsRevision : 0;
    if (revision !== expectedRevision) throw failure('Runtime constraints changed', 409, 'ORG_RUNTIME_CONSTRAINT_CONFLICT');
    const previous = normalizeScopedConstraints(draft.runtimeConstraints || {});
    // An unrelated scope edit must not rewrite another lock's provenance.
    draft.runtimeConstraints = Object.fromEntries(Object.entries(normalized).map(([field, value]) => {
      const old = previous[field] === undefined ? [] : Array.isArray(previous[field]) ? previous[field] : [previous[field]];
      const preserve = (entry) => old.find((item) => item.scope === entry.scope && item.value === entry.value && item.mode === entry.mode) || entry;
      return [field, Array.isArray(value) ? value.map(preserve) : preserve(value)];
    }));
    draft.runtimeConstraintsRevision = revision + 1;
    draft.updatedAt = new Date().toISOString();
    return true;
  });
  if (!result.meta) throw failure('Session not found', 404, 'SESSION_NOT_FOUND');
  if (result.changed) await flushSessionsMetaNow();
  return readSessionRuntimeConstraints(sessionId);
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
