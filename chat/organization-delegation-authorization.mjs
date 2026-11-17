import { scopeContainsPath } from './execution-scope.mjs';
import { getOrganization, getRevision, getNode, listOrganizationEdges, listDelegationGrants } from './organization-store.mjs';
import { getRun, getRunManifest } from './runs.mjs';
import { getLiveOrganizationSessionReference, getFactoryMessageScope } from './organization-session-lifecycle.mjs';

// Only server-created delegation records are accepted; all binding and grant
// facts are re-read at dispatch and when resolving a notification recipient.
export async function verifyOrganizationDelegation({ organizationId, childNodeId, delegation, requireActiveRun = true } = {}) {
  const denied = () => Object.assign(new Error('Organization delegation is no longer authorized'), { code: 'ORG_DELEGATION_FORBIDDEN', statusCode: 403 });
  const org = await getOrganization(organizationId);
  const parent = await getNode(delegation?.parentNodeId);
  const child = await getNode(childNodeId);
  const revision = await getRevision(organizationId, delegation?.revision);
  const run = await getRun(delegation?.parentRunId);
  const manifest = await getRunManifest(delegation?.parentRunId);
  const channelScope = manifest?.options?.sessionControlChannel?.scope;
  if (!org || org.currentRevision !== delegation?.revision || revision?.state !== 'frozen'
      || !parent || parent.organizationId !== organizationId || parent.currentSessionId !== delegation.parentSessionId
      || parent.bindingGeneration !== delegation.bindingGeneration || parent.lifecycleState !== 'active' || parent.retiredRevision !== null || parent.grant?.canDelegate !== true
      || !Number.isInteger(parent.grant?.maxDepth) || parent.grant.maxDepth < 1
      || child?.depth !== parent.depth + 1 || !Number.isInteger(child?.grant?.maxDepth)
      || child.grant.maxDepth > parent.grant.maxDepth - 1
      || !Number.isInteger(parent.grant?.maxChildren) || parent.grant.maxChildren < 1
      || !Number.isInteger(parent.grant?.maxConcurrent) || parent.grant.maxConcurrent < 1
      || !child || child.organizationId !== organizationId || child.parentNodeId !== parent.id || child.lifecycleState !== 'active'
      || child.retiredRevision !== null || !child.currentSessionId || child.bindingGeneration < 1
      || channelScope?.kind !== 'organization_message' || channelScope.organizationId !== organizationId
      || channelScope.nodeId !== parent.id || channelScope.bindingGeneration !== parent.bindingGeneration
      || channelScope.organizationRevision !== delegation.revision
      || !run || run.sessionId !== delegation.parentSessionId || manifest?.sessionId !== delegation.parentSessionId
      || (requireActiveRun && ['completed', 'failed', 'cancelled'].includes(run.state))) throw denied();
  const live = await getLiveOrganizationSessionReference(delegation.parentSessionId);
  const scope = live?.kind === 'node' ? live : await getFactoryMessageScope(delegation.parentSessionId, '');
  if (!scope || scope.organizationId !== organizationId || scope.nodeId !== parent.id
      || scope.bindingGeneration !== parent.bindingGeneration || scope.organizationRevision !== delegation.revision) throw denied();
  const edges = await listOrganizationEdges(organizationId, { revision: delegation.revision });
  const grants = await listDelegationGrants(organizationId, { parentNodeId: parent.id, revision: delegation.revision });
  const matching = grants.filter((entry) => entry.childNodeId === child.id);
  const latestGeneration = Math.max(0, ...matching.map((entry) => entry.generation));
  const latest = matching.filter((entry) => entry.generation === latestGeneration);
  const grant = latest.length === 1 && latest[0].lifecycleState === 'active' ? latest[0] : null;
  const parentPaths = parent.grant?.writablePaths || [];
  const childPaths = grant?.scope?.writablePaths || [];
  const pathsAllowed = (await Promise.all(childPaths.map(async (path) =>
    (await Promise.all(parentPaths.map((allowed) => scopeContainsPath(allowed, path)))).some(Boolean)))).every(Boolean);
  const allowedCapabilities = parent.grant?.allowedCapabilities || [];
  const capabilitiesAllowed = (grant?.allowedCapabilities || []).every((capability) => allowedCapabilities.includes(capability));
  if (!grant || !Number.isInteger(grant.generation) || grant.generation < 1 || !pathsAllowed || !capabilitiesAllowed
      || (grant.accessMode !== 'read_only' && parent.grant?.accessMode === 'read_only')
      || grant.executionIsolation !== parent.grant?.executionIsolation
      || !edges.some((edge) => edge.edgeType === 'MANAGES' && edge.parentNodeId === parent.id && edge.childNodeId === child.id)) throw denied();
  return { organization: org, parent, child, grant, run, manifest };
}
