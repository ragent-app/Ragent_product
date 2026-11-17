// Scoped, read-only runtime recommendation for an authorized root Run.
// Task requirements narrow results; they never confer capabilities or policy.
import { authorizeRootOrganizationCreate } from './collaboration-capability.mjs';
import { getApp } from './apps.mjs';
import { buildAgentCapabilityProfile } from './agent-capability-registry.mjs';
import { assertAgentAllowed, assertManagerCanDelegate, resolveSessionCollaborationPolicy, ROLES } from './collaboration-policy.mjs';
import { buildOrganizationRuntimeCatalog, resolveRuntimeSelection } from './organization-runtime-selection.mjs';
import { applyRuntimeConstraints, queryRuntimeCandidates } from './organization-runtime-decision.mjs';
import { readSessionRuntimeConstraints } from './session-collaboration-settings.mjs';

const fail = (message) => Object.assign(new Error(message), { code: 'ORG_CANDIDATES_FORBIDDEN', statusCode: 403 });
const text = (value) => typeof value === 'string' ? value.trim() : '';
export async function queryAuthorizedRuntimeCandidates({ authSession, session, args = {} } = {}) {
  if (authSession?.principalKind !== 'run_capability' || authSession.capabilityOperation !== 'session.organization.tools'
      || !session || session.sessionClass !== 'ROOT_LEADERSHIP' || (session.sessionPlane || 'user') !== 'user'
      || session.userAddressable === false || session.parentSessionId || session.delegatedFromSessionId) throw fail('A user root Run is required');
  await authorizeRootOrganizationCreate({ session, runId: authSession.runId, turnId: authSession.turnId });
  const agentId = text(args.agentId);
  if (!agentId || agentId.length > 200) throw fail('An authorized Agent is required');
  const app = await getApp(agentId);
  if (!app) throw fail('Agent is unavailable');
  const profile = await buildAgentCapabilityProfile(app);
  const parentApp = session.templateId ? await getApp(session.templateId) : null;
  const parentPolicy = resolveSessionCollaborationPolicy(session, parentApp);
  assertManagerCanDelegate(parentPolicy, { depth: session.delegationDepth || 0 });
  const taskRole = args.taskRole === undefined ? profile.role : text(args.taskRole).toLowerCase();
  if (!ROLES.has(taskRole)) throw Object.assign(new Error('Invalid collaboration task role'), { code: 'ORG_CANDIDATES_INVALID', statusCode: 400 });
  assertAgentAllowed(parentPolicy, agentId, taskRole);
  const requirements = args.requirements && typeof args.requirements === 'object' && !Array.isArray(args.requirements) ? args.requirements : {};
  if (Object.keys(requirements).some((key) => !['tools', 'environment', 'minimumContextTokens', 'advancedRequired', 'qualityFloor'].includes(key))
      || (requirements.tools !== undefined && (!Array.isArray(requirements.tools) || requirements.tools.length > 32 || requirements.tools.some((v) => typeof v !== 'string' || !v.trim() || v.length > 120)))
      || (requirements.environment !== undefined && (typeof requirements.environment !== 'string' || requirements.environment.length > 120))
      || (requirements.minimumContextTokens !== undefined && (!Number.isSafeInteger(requirements.minimumContextTokens) || requirements.minimumContextTokens < 1))
      || (requirements.advancedRequired !== undefined && typeof requirements.advancedRequired !== 'boolean')
      || (requirements.qualityFloor !== undefined && (typeof requirements.qualityFloor !== 'string' || requirements.qualityFloor.length > 500))) {
    throw Object.assign(new Error('Invalid task requirements'), { code: 'ORG_CANDIDATES_INVALID', statusCode: 400 });
  }
  const stableKey = text(args.nodeKey);
  if (stableKey && !/^[A-Za-z0-9_.-]{1,160}$/.test(stableKey)) throw Object.assign(new Error('Invalid node key'), { statusCode: 400 });
  const saved = await readSessionRuntimeConstraints(session.id);
  const constraints = Object.fromEntries(Object.entries(saved.constraints).filter(([, value]) =>
    value.scope === 'organization' || (stableKey && value.scope === `node:${stableKey}`)));
  const catalog = await buildOrganizationRuntimeCatalog();
  // Intersect the catalog with the same parent/child runtime policy compiler.
  // Reuse this snapshot; do not call an upstream once per candidate.
  const filters = { tool: text(args.tool), provider: text(args.provider), model: text(args.model) };
  if (Object.values(filters).some((value) => value.length > 240)) throw Object.assign(new Error('Invalid candidate filter'), { statusCode: 400 });
  const all = queryRuntimeCandidates(catalog, { ...filters, requirements, constraints, limit: 80 });
  const valid = [];
  let offset = 0;
  do {
    const page = offset === 0 ? all : queryRuntimeCandidates(catalog, { ...filters, requirements, constraints, offset, limit: 80 });
    for (const candidate of page.items) {
      if (candidate.assessment.status === 'ineligible') continue;
      try {
        const requested = applyRuntimeConstraints({ tool: candidate.tool, provider: candidate.provider, model: candidate.model }, constraints);
        await resolveRuntimeSelection({ requested, profile, parentGrant: { runtimePolicy: parentPolicy.runtimePolicy },
          getModels: async () => ({ models: [{ id: candidate.model, effortLevels: candidate.effortLevels }] }),
          getProviders: async () => [candidate.provider], getTool: async () => null });
        valid.push(candidate);
      } catch (error) {
        if (error?.code !== 'ORG_RUNTIME_USER_LOCKED' && !String(error?.code || '').startsWith('ORG_RUNTIME_')) throw error;
      }
    }
    offset = page.nextOffset;
  } while (offset !== null);
  const start = Number.isSafeInteger(args.offset) && args.offset >= 0 ? args.offset : 0;
  const limit = Number.isSafeInteger(args.limit) ? Math.max(1, Math.min(80, args.limit)) : 40;
  const items = valid.slice(start, start + limit);
  const nextOffset = start + items.length < valid.length ? start + items.length : null;
  const catalogStatus = catalog.some((entry) => (entry.providerCatalogs || []).some((provider) => (provider.models || []).length))
    ? 'present' : 'unknown';
  return { items, total: valid.length, nextOffset, truncated: nextOffset !== null, constraintsRevision: saved.revision, catalogStatus,
    guidance: catalogStatus === 'unknown'
      ? 'No provider-scoped catalog facts are available; refresh before concluding there are no candidates.'
      : 'Unknown health, quality or cost is not proof of availability or suitability. Verify task needs and use actual granted capabilities.' };
}
