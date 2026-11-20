// Identity is derived from current server bindings, never from a model's text.
import { getOrganization, getOrganizationByRootSession, getRevision, listOrganizationNodes, listOrganizationEdges, isOrganizationRevisionCompatible } from './organization-store.mjs';
import { getLiveOrganizationSessionReference, getFactoryMessageScope } from './organization-session-lifecycle.mjs';

const text = (value) => typeof value === 'string' ? value.trim() : '';

export async function buildOrganizationIdentityContext(session = {}) {
  const sessionId = text(session.id);
  if (!sessionId) return '';
  const managed = session.sessionPlane === 'organization' || !!text(session.organizationId);
  if (!managed && session.sessionClass !== 'ROOT_LEADERSHIP') return '';
  const unavailable = () => { throw Object.assign(new Error('Organization identity binding is unavailable or changed'), { code: 'ORG_IDENTITY_UNAVAILABLE' }); };
  const bound = await getLiveOrganizationSessionReference(sessionId);
  const factory = bound ? null : await getFactoryMessageScope(sessionId, '');
  const ref = bound || factory;
  if (!ref) return managed ? unavailable() : '';
  const org = await getOrganization(ref.organizationId);
  if (!org || ['archived', 'lifecycle_pending'].includes(org.state)) return unavailable();
  if ((text(session.organizationId) && session.organizationId !== org.id) ||
      (text(session.organizationNodeId) && session.organizationNodeId !== ref.nodeId)) return unavailable();
  const nodes = (await listOrganizationNodes(org.id)).filter((node) => node.retiredRevision == null);
  const roots = nodes.filter((node) => node.currentSessionId === org.rootSessionId);
  const rootNode = roots.length === 1 ? roots[0] : null;
  const target = ref.kind === 'root' ? rootNode : nodes.find((node) => node.id === ref.nodeId);
  if (ref.kind !== 'root' && (!target || target.bindingGeneration !== ref.bindingGeneration)) return unavailable();
  if (ref.kind !== 'root' && text(session.sessionClass) && text(target.sessionClass) && session.sessionClass !== target.sessionClass) return unavailable();
  if (ref.kind !== 'root' && (sessionId !== org.rootSessionId && !target)) return unavailable();
  if (ref.kind === 'root' && (sessionId !== org.rootSessionId || !(await getOrganizationByRootSession(sessionId)))) return unavailable();
  // Formal organizations strictly require a frozen revision and >=1 append-only compatibility;
  // ephemeral Swarm nodes operate under active revision 0 only when policy.swarmEnabled is set.
  const isEphemeralSwarm = org.policy?.swarmEnabled === true
    && (ref.kind === 'node'
      ? target?.lifecycleMode === 'ephemeral_swarm'
      : (org.currentRevision === 0 && rootNode?.lifecycleMode === 'ephemeral_swarm'));
  if (ref.organizationRevision != null) {
    const revOk = isEphemeralSwarm
      ? ref.organizationRevision === org.currentRevision
      : await isOrganizationRevisionCompatible(org.id, ref.organizationRevision, org.currentRevision);
    if (!revOk) return unavailable();
  }
  const revision = await getRevision(org.id, org.currentRevision);
  if (!isEphemeralSwarm && (!revision || revision.state !== 'frozen')) return managed ? unavailable() : '';
  const definitions = new Map((revision?.compiled?.nodes || []).map((node) => [node.stableKey, node]));
  const definition = target ? definitions.get(target.stableKey) : null;
  const edges = await listOrganizationEdges(org.id, { revision: null });
  const parentEdges = target ? edges.filter((edge) => edge.edgeType === 'MANAGES' && edge.childNodeId === target.id) : [];
  const parentId = parentEdges.length === 1 && parentEdges[0].parentNodeId === target?.parentNodeId ? target.parentNodeId : '';
  const parent = parentId ? nodes.find((node) => node.id === parentId) : null;
  const parentDefinition = parent ? definitions.get(parent.stableKey) : null;
  let parentSessionId = parent?.currentSessionId || null;
  // A display level is known only if a validated chain reaches a root-bound
  // node, or a parentless node's actual managed session names the root as its controller.
  let displayLevel = ref.kind === 'root' ? 0 : null;
  if (target && ref.kind !== 'root') {
    let cursor = target;
    const seen = new Set();
    let distance = 0;
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      if (rootNode && cursor.id === rootNode.id) { displayLevel = distance; break; }
      const incoming = edges.filter((edge) => edge.edgeType === 'MANAGES' && edge.childNodeId === cursor.id);
      if (!incoming.length && !cursor.parentNodeId && !rootNode) {
        const { getSession } = await import('./session-manager.mjs');
        const topSession = cursor.currentSessionId ? await getSession(cursor.currentSessionId) : null;
        if (topSession?.parentSessionId === org.rootSessionId && topSession.organizationNodeId === cursor.id) {
          displayLevel = distance + 1;
          if (cursor.id === target.id) parentSessionId = org.rootSessionId;
        }
        break;
      }
      if (incoming.length !== 1 || incoming[0].parentNodeId !== cursor.parentNodeId) break;
      cursor = nodes.find((node) => node.id === cursor.parentNodeId);
      distance++;
    }
  }
  const identity = {
    organizationId: org.id, nodeId: target?.id || null, nodeStableKey: text(target?.stableKey) || null, sessionId,
    rootSessionId: org.rootSessionId, rootNodeId: rootNode?.id || null,
    parentNodeId: parent?.id || null, parentSessionId, parentDisplayName: text(parentDefinition?.displayName) || text(parent?.grant?.swarmName) || null,
    displayName: text(definition?.displayName) || text(target?.grant?.swarmName) || null, structuralRole: target?.nodeRole || (ref.kind === 'root' ? 'root' : null),
    domain: text(definition?.domain) || text(target?.grant?.swarmDomain) || null, responsibility: text(definition?.responsibility) || text(target?.grant?.swarmResponsibility) || null,
    nodeDepth: target && Number.isInteger(target.depth) ? target.depth : null, displayLevel,
    revision: org.currentRevision, bindingGeneration: target?.bindingGeneration ?? null,
    attemptId: factory?.attemptId || null, workItemId: factory?.workItemId || null,
    // A node grant is a ceiling, not proof that this Run has delegation capability.
    canDelegate: null, remainingDepth: null,
  };
  const current = bound ? await getLiveOrganizationSessionReference(sessionId) : await getFactoryMessageScope(sessionId, '');
  const currentOrg = await getOrganization(org.id);
  if (!current || current.kind !== ref.kind || current.organizationId !== ref.organizationId ||
      current.nodeId !== ref.nodeId || current.bindingGeneration !== ref.bindingGeneration ||
      current.organizationRevision !== ref.organizationRevision || current.attemptId !== ref.attemptId ||
      currentOrg?.currentRevision !== org.currentRevision || currentOrg?.rootSessionId !== org.rootSessionId ||
      ['archived', 'lifecycle_pending'].includes(currentOrg?.state)) return unavailable();
  let reviewerSkill = '';
  if (target?.sessionClass === 'REVIEWER') {
    // Read-only harnesses cannot safely mount arbitrary MCP servers. Supply the
    // role's trusted built-in guidance directly, without granting tool access.
    const { readBuiltinSkill } = await import('./builtin-skills.mjs');
    const skill = await readBuiltinSkill({ id: 'ragent:builtin:reviewer', authorize: async ({ id }) => id === 'ragent:builtin:reviewer' });
    reviewerSkill = `<organization-role-skill id="${skill.id}" sha256="${skill.contentHash}">\n${skill.content}\n</organization-role-skill>`;
  }
  return ['<organization-identity>', JSON.stringify(identity),
    'Identity is server-derived; null means unknown. Role and display names do not grant permissions. Follow only capabilities actually issued to this Run. Report task results and blockers to the authorized parent through the available channel.',
    '</organization-identity>', reviewerSkill].filter(Boolean).join('\n');
}
