// Scoped, read-only runtime recommendation for an authorized root Run.
// Task requirements narrow results; they never confer capabilities or policy.
import { authorizeRootOrganizationCreate } from './collaboration-capability.mjs';
import { getApp } from './apps.mjs';
import { buildAgentCapabilityProfile } from './agent-capability-registry.mjs';
import { assertAgentAllowed, assertManagerCanDelegate, resolveSessionCollaborationPolicy, ROLES } from './collaboration-policy.mjs';
import { buildOrganizationRuntimeCatalog, resolveRuntimeSelection } from './organization-runtime-selection.mjs';
import { applyRuntimeConstraints, queryRuntimeCandidates, selectRuntimeConstraints } from './organization-runtime-decision.mjs';
import { readSessionRuntimeConstraints } from './session-collaboration-settings.mjs';
import { getOrganization, getRevision, getNode, listOrganizationNodes, isOrganizationRevisionCompatible } from './organization-store.mjs';

const fail = (message) => Object.assign(new Error(message), { code: 'ORG_CANDIDATES_FORBIDDEN', statusCode: 403 });
const text = (value) => typeof value === 'string' ? value.trim() : '';
export async function queryAuthorizedRuntimeCandidates({ authSession, session, args = {} } = {}) {
  if (authSession?.principalKind !== 'run_capability' || !session) throw fail('A scoped Run is required');
  let rootSession = session;
  let nodeGrant = null;
  let managerNode = null;
  if (authSession.capabilityOperation === 'session.organization.tools') {
    if (session.sessionClass !== 'ROOT_LEADERSHIP' || (session.sessionPlane || 'user') !== 'user'
        || session.userAddressable === false || session.parentSessionId || session.delegatedFromSessionId) throw fail('A user root Run is required');
    await authorizeRootOrganizationCreate({ session, runId: authSession.runId, turnId: authSession.turnId });
  } else if (authSession.capabilityOperation === 'organization.tools') {
    const scope = authSession.organizationMessageScope;
    const node = scope && await getNode(scope.nodeId);
    const org = node && await getOrganization(node.organizationId);
    const revision = org && await getRevision(org.id, org.currentRevision);
    if (!scope || !node || !org || revision?.state !== 'frozen' || !await isOrganizationRevisionCompatible(org.id, scope.organizationRevision, org.currentRevision)
        || node.organizationId !== scope.organizationId || node.currentSessionId !== authSession.sessionId
        || node.bindingGeneration !== scope.bindingGeneration || node.lifecycleState !== 'active' || node.retiredRevision !== null
        || node.grant?.canDelegate !== true || !Number.isInteger(node.grant.maxDepth) || node.grant.maxDepth < 1
        || !Number.isInteger(node.grant.maxChildren) || node.grant.maxChildren < 1) throw fail('Current manager delegation is unavailable');
    const { getSession } = await import('./session-manager.mjs');
    rootSession = await getSession(org.rootSessionId);
    if (!rootSession) throw fail('Owner policy is unavailable');
    nodeGrant = node.grant;
    managerNode = node;
  } else throw fail('A scoped Run is required');
  const agentId = text(args.agentId);
  if (!agentId || agentId.length > 200) throw fail('An authorized Agent is required');
  const app = await getApp(agentId);
  if (!app) throw fail('Agent is unavailable');
  const profile = await buildAgentCapabilityProfile(app);
  const parentApp = rootSession.templateId ? await getApp(rootSession.templateId) : null;
  const parentPolicy = resolveSessionCollaborationPolicy(rootSession, parentApp);
  assertManagerCanDelegate(parentPolicy, { depth: rootSession.delegationDepth || 0 });
  const taskRole = args.taskRole === undefined ? profile.role : text(args.taskRole).toLowerCase();
  if (!ROLES.has(taskRole)) throw Object.assign(new Error('Invalid collaboration task role'), { code: 'ORG_CANDIDATES_INVALID', statusCode: 400 });
  assertAgentAllowed(parentPolicy, agentId, taskRole);
  if (nodeGrant) {
    const managerApp = session.templateId ? await getApp(session.templateId) : null;
    const managerPolicy = resolveSessionCollaborationPolicy(session, managerApp);
    assertManagerCanDelegate(managerPolicy, { depth: session.delegationDepth || 0 });
    assertAgentAllowed(managerPolicy, agentId, taskRole);
  }
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
  if (managerNode && stableKey) {
    const nodes = await listOrganizationNodes(managerNode.organizationId);
    const existing = nodes.find((entry) => entry.stableKey === stableKey && entry.retiredRevision === null);
    if (existing) {
      const byId = new Map(nodes.map((entry) => [entry.id, entry]));
      let cursor = existing, allowed = false;
      const visited = new Set();
      while (cursor?.parentNodeId && !visited.has(cursor.id)) {
        visited.add(cursor.id);
        if (cursor.parentNodeId === managerNode.id) { allowed = true; break; }
        cursor = byId.get(cursor.parentNodeId);
      }
      if (!allowed) throw fail('Node is outside the delegated subtree');
    }
  }
  const saved = await readSessionRuntimeConstraints(rootSession.id);
  const constraints = selectRuntimeConstraints(saved.constraints, ['organization', ...(stableKey ? [`node:${stableKey}`] : [])]);
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
        if (nodeGrant) await resolveRuntimeSelection({ requested, profile, parentGrant: nodeGrant,
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
