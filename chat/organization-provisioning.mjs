// Organization provisioning: materializes a Frozen Revision into real
// organization nodes and managed Sessions (S21 provisioning).
//
// The Root Leader ingress only freezes a revision; it never creates managed
// Sessions. Provisioning is the explicit runtime command that turns that frozen
// plan into a live team. This module owns the materialization order contract
// that the S21 slice left open:
//
//   1. Nodes are materialized topologically — a parent node always exists before
//      its children, so a child can reference a stable parent node ID and bind
//      its MANAGES edge to it.
//   2. Within a node the order is fixed:
//        createRoleInstance -> createNode (node ID exists) -> managed-session
//        factory (binds that node ID) -> bindNodeSession -> bindRoleInstanceNode
//        -> createOrganizationEdge(parent -> child).
//      The managed-session factory therefore never needs to invent or guess a
//      node ID; the node is the source of truth for the binding.
//   3. Every store write carries an idempotency key derived from the
//      provisioning operation, so a crash/replay converges to the same facts and
//      never duplicates nodes or sessions.
//
// The module stays store-adjacent: it takes an injected `createManagedSession`
// factory (the real one lives in organization-managed-session-factory.mjs and
// is wired by session-manager), mirroring replan/hierarchy so the orchestration
// logic stays unit-testable without a running provider.
import {
  ORG_AUTONOMOUS_PROVISIONING_ENABLED,
  ORG_SCHEMA_ENABLED,
} from '../lib/config.mjs';
import { getCompiledRevision } from './organization-runtime.mjs';
import {
  bindNodeSession,
  bindRoleInstanceNode,
  createDelegationGrant,
  createNode,
  createOrganizationEdge,
  createRoleInstance,
  getOrganization,
  getNode,
  getRevision,
  listOrganizationNodes,
  materializeFrozenNodeGrants,
} from './organization-store.mjs';
import { organizationGrantForNode } from './organization-role-contract.mjs';
import { appendOrganizationEvent } from './organization-messaging.mjs';

export const ORG_PROVISIONING_DISABLED = 'ORG_PROVISIONING_DISABLED';

function provisioningError(message, code, statusCode = 503, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return Object.assign(error, details);
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function sessionClassForRole(role) {
  return role === 'reviewer'
    ? 'REVIEWER'
    : ['worker', 'specialist'].includes(role)
      ? 'WORKER'
      : 'MANAGER';
}

// resolveParentKey returns the authoritative parent for a node. The compiled
// MANAGES edge list is the source of truth; node.parentKey mirrors it for
// single-parent trees, so we prefer the edge map and fall back to the node.
function buildParentByChild(compiled) {
  const parentByChild = new Map();
  for (const edge of Array.isArray(compiled?.manages) ? compiled.manages : []) {
    if (edge?.childKey && edge?.parentKey) parentByChild.set(edge.childKey, edge.parentKey);
  }
  return parentByChild;
}

export async function provisionFrozenRevision({
  organizationId,
  revision,
  createManagedSession,
  idempotencyKey = '',
} = {}) {
  if (!ORG_SCHEMA_ENABLED) {
    throw provisioningError('organization schema is disabled', 'ORGANIZATION_SCHEMA_DISABLED', 503);
  }
  const org = await getOrganization(organizationId);
  if (!org) throw provisioningError('organization not found', 'ORGANIZATION_NOT_FOUND', 404);
  if (['archived','lifecycle_pending'].includes(org.state)) throw provisioningError('organization cannot be provisioned during archive or rebind', 'ORGANIZATION_ARCHIVED', 409);
  const revisionRow = await getRevision(organizationId, revision);
  if (!revisionRow) throw provisioningError('revision not found', 'REVISION_NOT_FOUND', 404);
  if (revisionRow.state !== 'frozen') {
    throw provisioningError(
      `revision ${revision} is ${revisionRow.state || 'not frozen'}; only frozen revisions can be provisioned`,
      'ORG_PROVISIONING_REVISION_NOT_FROZEN',
      409,
    );
  }
  const compiled = await getCompiledRevision(organizationId, revision);
  if (!compiled) throw provisioningError('revision not found', 'REVISION_NOT_FOUND', 404);
  const nodes = Array.isArray(compiled.nodes) ? compiled.nodes : [];
  if (nodes.length === 0) {
    return {
      attempted: true,
      state: 'noop',
      organizationId: org.id,
      revision,
      createdManagedSessions: 0,
      sessions: [],
    };
  }
  if (typeof createManagedSession !== 'function') {
    throw provisioningError(
      'managed session factory is required to provision a frozen revision',
      'ORG_PROVISIONING_FACTORY_REQUIRED',
      503,
    );
  }

  const order = Array.isArray(compiled.order?.nodes) && compiled.order.nodes.length > 0
    ? compiled.order.nodes
    : nodes.map((node) => node.stableKey);
  const defByKey = new Map(nodes.map((node) => [node.stableKey, node]));
  const parentByChild = buildParentByChild(compiled);

  // Existing facts make replay converge: nodes already materialized by a prior
  // attempt are reused, while nodes without a session binding are resumed.
  const existingNodes = await listOrganizationNodes(organizationId);
  const nodeByKey = new Map(existingNodes.map((node) => [node.stableKey, node]));
  // A Frozen Revision describes one immutable desired team. The organization /
  // revision key deduplicates the materialized facts even when a retry arrives
  // with a new request key.
  const baseKey = `provision:${org.id}:${revision}`;
  const created = [];
  const materialized = new Set();
  const visiting = new Set();

  async function bindSessionWithReplay(node, sessionId, roleInstanceId) {
    try {
      return await bindNodeSession(node.id, {
        expectedBindingGeneration: node.bindingGeneration,
        sessionId,
        roleInstanceId,
      });
    } catch (error) {
      // Two explicit provisioning commands may race after both observe an
      // unbound node. If the other command already bound the same durable
      // Session, treat that CAS conflict as a successful replay.
      if (error?.code === 'ORG_OPERATION_CONFLICT') {
        const current = await getNode(node.id);
        if (current?.currentSessionId === sessionId
            && (!current.roleInstanceId || current.roleInstanceId === roleInstanceId)) {
          return current;
        }
      }
      throw error;
    }
  }

  async function materialize(stableKey) {
    if (materialized.has(stableKey)) return;
    if (visiting.has(stableKey)) {
      throw provisioningError(
        `compiled organization contains a parent cycle at ${stableKey}`,
        'ORG_PROVISIONING_PARENT_CYCLE',
        422,
      );
    }
    visiting.add(stableKey);
    try {
    const def = defByKey.get(stableKey);
    if (!def) {
      throw provisioningError(`compiled node ${stableKey} is missing`, 'ORG_PROVISIONING_NODE_MISSING', 422);
    }
    const parentKey = text(parentByChild.get(stableKey) || def.parentKey);
    if (parentKey) {
      if (!defByKey.has(parentKey)) {
        throw provisioningError(
          `parent node ${parentKey} is missing from the compiled revision`,
          'ORG_PROVISIONING_PARENT_MISSING',
          422,
        );
      }
      await materialize(parentKey);
    }
    const parentNode = parentKey ? nodeByKey.get(parentKey) : null;
    if (parentKey && !parentNode) {
      throw provisioningError(
        `parent node ${parentKey} is not materialized`,
        'ORG_PROVISIONING_PARENT_MISSING',
        422,
      );
    }

    const opKey = `${baseKey}:${stableKey}`;
    const agentId = text(def.resolver?.selectedAgentId || def.agentId);
    const grant = organizationGrantForNode(def, parentNode?.grant || {});
    const roleInstance = await createRoleInstance({
      organizationId: org.id,
      organizationRevision: revision,
      stableKey,
      role: def.role,
      agentId,
      capabilityProfile: {
        capabilities: def.capabilities || [],
        scope: object(def.scope),
        scopes: object(def.scopes),
        grant,
      },
      policy: { ...object(def.policy), organizationRole: def.role },
      budget: object(def.budget),
      idempotencyKey: `${opKey}:role`,
    });

    let node = nodeByKey.get(stableKey);
    if (node) {
      if (Number(node.createdRevision) !== Number(revision)) {
        throw provisioningError(
          `node ${stableKey} belongs to revision ${node.createdRevision}, not ${revision}`,
          'ORG_PROVISIONING_NODE_REVISION_CONFLICT',
          409,
        );
      }
      if (node.roleInstanceId && node.roleInstanceId !== roleInstance.id) {
        throw provisioningError(
          `node ${stableKey} is bound to a different role instance`,
          'ORG_PROVISIONING_ROLE_INSTANCE_CONFLICT',
          409,
        );
      }
      if (parentNode && node.parentNodeId && node.parentNodeId !== parentNode.id) {
        throw provisioningError(
          `node ${stableKey} is bound to a different parent`,
          'ORG_PROVISIONING_PARENT_CONFLICT',
          409,
        );
      }
    } else {
      node = await createNode({
        organizationId: org.id,
        stableKey,
        nodeRole: def.role,
        createdRevision: revision,
        parentNodeId: parentNode ? parentNode.id : '',
        depth: parentNode ? Number(parentNode.depth || 0) + 1 : 0,
        roleInstanceId: roleInstance.id,
        sessionClass: sessionClassForRole(def.role),
        grant,
        currentSessionId: '',
        idempotencyKey: `${opKey}:node`,
      });
    }

    await materializeFrozenNodeGrants({ organizationId: org.id, nodeId: node.id, revision, expectedGrant: grant });

    let session = null;
    let createdSession = false;
    let sessionId = text(node.currentSessionId);
    if (!sessionId) {
      try {
        session = await createManagedSession({
          organizationId: org.id,
          organizationRevision: revision,
          organizationNodeId: node.id,
          roleInstanceId: roleInstance.id,
          stableKey,
          name: text(def.displayName),
          role: def.role,
          agentId,
          sessionClass: sessionClassForRole(def.role),
          parentNodeId: parentNode ? parentNode.id : '',
          parentSessionId: parentNode ? parentNode.currentSessionId : '',
          idempotencyKey: `${opKey}:session`,
          replacementKey: opKey,
          runtime: object(def.runtime),
        });
      } catch (cause) {
        throw provisioningError(
          `managed session creation failed for ${stableKey}`,
          'ORG_PROVISIONING_SESSION_FACTORY_FAILED',
          503,
          // keep the cause on the error without leaking raw stack internals
          { causeCode: text(cause?.code), causeMessage: text(cause?.message) || String(cause) },
        );
      }
      sessionId = text(session?.sessionId);
      if (!sessionId) {
        throw provisioningError(
          `provisioning ${stableKey} did not produce a managed session`,
          'ORG_PROVISIONING_SESSION_MISSING',
          503,
        );
      }
      node = await bindSessionWithReplay(node, sessionId, roleInstance.id);
      createdSession = true;
    } else if (!node.roleInstanceId) {
      // A crash after session binding but before role binding leaves the node
      // with a session and no role_instance_id. Rebind the same session to
      // restore the missing lineage without creating another Session.
      node = await bindSessionWithReplay(node, sessionId, roleInstance.id);
    }
    await bindRoleInstanceNode(roleInstance.id, node.id);

    let edge = null;
    let delegationGrant = null;
    if (parentNode) {
      edge = await createOrganizationEdge({
        organizationId: org.id,
        organizationRevision: revision,
        stableKey: `${parentNode.stableKey}:${stableKey}`,
        edgeType: 'MANAGES',
        parentNodeId: parentNode.id,
        childNodeId: node.id,
        idempotencyKey: `${opKey}:edge`,
      });
      delegationGrant = await createDelegationGrant({
        organizationId: org.id,
        organizationRevision: revision,
        parentNodeId: parentNode.id,
        childNodeId: node.id,
        roleInstanceId: roleInstance.id,
        allowedCapabilities: grant.allowedCapabilities,
        scope: {
          writablePaths: grant.writablePaths,
          workspaceScope: grant.workspaceScope,
          projectId: grant.projectId,
        },
        accessMode: grant.accessMode,
        executionIsolation: grant.executionIsolation,
        maxDepth: grant.maxDepth,
        maxChildren: grant.maxChildren,
        maxConcurrent: grant.maxConcurrent,
        canDelegate: grant.canDelegate,
        idempotencyKey: `${opKey}:delegation`,
      });
      if (node.currentSessionId && node.currentSessionId !== org.rootSessionId) {
        await appendOrganizationEvent({ organizationId: org.id, eventKey: `node-created:${node.id}`, type: 'node.created', organizationRevision: revision, nodeId: node.id, actorNodeId: parentNode.id });
      }
    }

    nodeByKey.set(stableKey, node);
    if (createdSession) {
      created.push({
        stableKey,
        node,
        roleInstance,
        edge,
        delegationGrant,
        sessionId,
        runId: text(session?.runId),
      });
    }
    materialized.add(stableKey);
    } finally {
      visiting.delete(stableKey);
    }
  }

  for (const key of order) {
    await materialize(key);
  }

  return {
    attempted: true,
    state: 'provisioned',
    organizationId: org.id,
    revision,
    createdManagedSessions: created.length,
    sessions: created,
  };
}

// Explicit runtime command surface. Kept separate from the Root Leader ingress
// so freeze and provisioning stay distinct operations (the plan contract: a
// frozen revision is immutable evidence, provisioning is an explicit command).
export async function provisionRootLeadershipRevision({
  organizationId,
  revision,
  createManagedSession,
  idempotencyKey = '',
} = {}) {
  if (!ORG_SCHEMA_ENABLED) {
    throw provisioningError('organization schema is disabled', 'ORGANIZATION_SCHEMA_DISABLED', 503);
  }
  if (!ORG_AUTONOMOUS_PROVISIONING_ENABLED) {
    return { attempted: false, skipped: ORG_PROVISIONING_DISABLED };
  }
  return provisionFrozenRevision({
    organizationId,
    revision,
    createManagedSession,
    idempotencyKey,
  });
}
