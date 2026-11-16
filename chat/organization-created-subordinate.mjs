import { listOrganizationNodes } from './organization-store.mjs';
import { hasCreatedOrganizationSubordinate } from './organization-messaging.mjs';

// A creation event survives unbinding; existing organizations without that
// event can still establish creation through a current non-root binding.
export async function organizationHasCreatedSubordinate(organization, nodes = null) {
  if (await hasCreatedOrganizationSubordinate(organization.id)) return true;
  const currentNodes = nodes || await listOrganizationNodes(organization.id);
  return currentNodes.some((node) => node.parentNodeId && node.currentSessionId
    && node.currentSessionId !== organization.rootSessionId && node.retiredRevision == null
    && !['retired', 'deleted'].includes(String(node.lifecycleState || '').toLowerCase()));
}
