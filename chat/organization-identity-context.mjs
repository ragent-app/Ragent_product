// Identity is derived from current server bindings, never from a model's text.
import { getOrganization, getOrganizationByRootSession, getRevision, listOrganizationNodes, listOrganizationEdges, isOrganizationRevisionCompatible } from './organization-store.mjs';
import { getLiveOrganizationSessionReference, getFactoryMessageScope } from './organization-session-lifecycle.mjs';
import { withDatabase } from './collaboration-store.mjs';
import { isAppendOnlyRevisionCompatible } from './organization-revision-compatibility.mjs';

const text = (value) => typeof value === 'string' ? value.trim() : '';

// A formal-organization managedWriter staging child is not stored in
// organization_nodes.current_session_id; verify it only through an active
// durable dispatch command, running task/attempt, non-empty writablePaths,
// matching frozen plan managedSessionId, and an active frozen formal_org node.
export async function getManagedWriterStagingOrganizationReference(sessionId, requestId = '') {
  const normalizedSessionId = text(sessionId);
  if (!normalizedSessionId) return null;
  const normalizedRequestId = text(requestId);
  return withDatabase((db) => {
    for (const name of [
      'collaboration_dispatch_commands',
      'collaboration_attempts',
      'collaboration_tasks',
      'collaboration_plans',
      'collaborations',
      'organizations',
      'organization_nodes',
      'organization_revisions',
    ]) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)) return null;
    }
    const rows = db.prepare(`SELECT d.attempt_id, d.task_id,
        a.state AS attempt_state, a.attempt_number,
        t.current_attempt, t.state AS task_state, t.writable_paths_json,
        c.root_session_id AS collab_root_session_id,
        c.state AS collaboration_state, c.policy_json,
        p.plan_json
      FROM collaboration_dispatch_commands d
      JOIN collaboration_attempts a ON a.id = d.attempt_id AND a.task_id = d.task_id
      JOIN collaboration_tasks t ON t.id = d.task_id AND t.collaboration_id = d.collaboration_id
      JOIN collaborations c ON c.id = d.collaboration_id
      LEFT JOIN collaboration_plans p ON p.collaboration_id = c.id AND p.version = c.plan_version
      WHERE d.session_id = ?
        AND (? = '' OR d.request_id = ?)
        AND d.state IN ('pending', 'claimed', 'completed')`).all(normalizedSessionId, normalizedRequestId, normalizedRequestId);
    if (rows.length !== 1) return null;
    const row = rows[0];
    if (['completed', 'failed', 'cancelled'].includes(text(row.collaboration_state))) return null;
    if (text(row.attempt_state) !== 'running' || text(row.task_state) !== 'running') return null;
    if (Number(row.current_attempt) !== Number(row.attempt_number)) return null;
    let writablePaths;
    try { writablePaths = JSON.parse(row.writable_paths_json || '[]'); } catch { return null; }
    if (!Array.isArray(writablePaths) || writablePaths.length === 0) return null;
    let policy;
    try { policy = JSON.parse(row.policy_json || '{}'); } catch { return null; }
    if (policy?.factoryExecution) return null;
    const organizationId = text(policy?.organizationId);
    const organizationNodeId = text(policy?.organizationNodeId);
    if (!organizationId || !organizationNodeId) return null;
    let plan;
    try { plan = JSON.parse(row.plan_json || '{}'); } catch { return null; }
    const planTask = Array.isArray(plan?.tasks)
      ? plan.tasks.find((candidate) => candidate && candidate.id === row.task_id)
      : null;
    const managedSessionId = text(planTask?.managedSessionId);
    if (!managedSessionId || managedSessionId === normalizedSessionId) return null;
    const node = db.prepare(`SELECT n.id, n.organization_id, n.current_session_id, n.binding_generation,
        n.created_revision, n.retired_revision, n.lifecycle_mode,
        o.root_session_id AS org_root_session_id, o.current_revision, o.state AS org_state
      FROM organization_nodes n
      JOIN organizations o ON o.id = n.organization_id
      WHERE n.id = ? AND n.organization_id = ?`).get(organizationNodeId, organizationId);
    if (!node) return null;
    if (text(node.lifecycle_mode) === 'ephemeral_swarm') return null;
    if (node.retired_revision != null) return null;
    if (['archived', 'lifecycle_pending'].includes(text(node.org_state))) return null;
    if (text(node.org_root_session_id) !== text(row.collab_root_session_id)) return null;
    if (text(node.current_session_id) !== managedSessionId) return null;
    if (!Number.isInteger(node.binding_generation) || node.binding_generation < 1) return null;
    if (Number.isInteger(policy.organizationBindingGeneration) && node.binding_generation !== policy.organizationBindingGeneration) {
      return null;
    }
    if (!isAppendOnlyRevisionCompatible(db, organizationId, node.created_revision, node.current_revision)) return null;
    if (Number.isInteger(policy.organizationRevision)
      && !isAppendOnlyRevisionCompatible(db, organizationId, policy.organizationRevision, node.current_revision)) {
      return null;
    }
    const revRow = db.prepare('SELECT state FROM organization_revisions WHERE organization_id = ? AND revision = ?')
      .get(organizationId, node.current_revision);
    if (!revRow || text(revRow.state) !== 'frozen') return null;
    return {
      kind: 'node',
      organizationId,
      nodeId: node.id,
      bindingGeneration: node.binding_generation,
      organizationRevision: Number.isInteger(policy.organizationRevision) ? policy.organizationRevision : node.current_revision,
      managedSessionId,
      attemptId: row.attempt_id,
    };
  });
}

export async function buildOrganizationIdentityContext(session = {}) {
  const sessionId = text(session.id);
  if (!sessionId) return '';
  const managed = session.sessionPlane === 'organization' || !!text(session.organizationId);
  if (!managed && session.sessionClass !== 'ROOT_LEADERSHIP') return '';
  const unavailable = () => { throw Object.assign(new Error('Organization identity binding is unavailable or changed'), { code: 'ORG_IDENTITY_UNAVAILABLE' }); };
  const bound = await getLiveOrganizationSessionReference(sessionId);
  const factory = bound ? null : await getFactoryMessageScope(sessionId, '');
  const stagingRef = (bound || factory) ? null : await getManagedWriterStagingOrganizationReference(sessionId, '');
  const ref = bound || factory || stagingRef;
  if (!ref) return managed ? unavailable() : '';
  const org = await getOrganization(ref.organizationId);
  if (!org || ['archived', 'lifecycle_pending'].includes(org.state)) return unavailable();
  if ((text(session.organizationId) && session.organizationId !== org.id) ||
      (text(session.organizationNodeId) && session.organizationNodeId !== ref.nodeId) ||
      (stagingRef && text(session.parentSessionId) && text(session.parentSessionId) !== stagingRef.managedSessionId) ||
      (text(session.organizationRootSessionId) && text(session.organizationRootSessionId) !== org.rootSessionId)) return unavailable();
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
    attemptId: factory?.attemptId || stagingRef?.attemptId || null, workItemId: factory?.workItemId || null,
    // A node grant is a ceiling, not proof that this Run has delegation capability.
    canDelegate: null, remainingDepth: null,
  };
  const current = bound
    ? await getLiveOrganizationSessionReference(sessionId)
    : (factory ? await getFactoryMessageScope(sessionId, '') : await getManagedWriterStagingOrganizationReference(sessionId, ''));
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
