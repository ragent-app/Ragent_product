import { withDatabase } from './collaboration-store.mjs';

// Dispatch records, not model input, provide the task contract. The run ID is
// assigned by the server before the prompt and bound to its manifest at launch.
export async function buildOrganizationExecutionContext({ sessionId, runId, requestId, internalOperation, selectedRuntime, capabilities, organizationToolScope = null } = {}) {
  let task = null;
  if (internalOperation === 'collaboration_task') {
    task = await withDatabase((db) => {
      const rows = db.prepare(`SELECT d.attempt_id,a.attempt_number,t.id,t.objective,t.acceptance_json,t.writable_paths_json,t.depends_on_json,t.access_mode,t.execution_isolation
        FROM collaboration_dispatch_commands d JOIN collaboration_attempts a ON a.id=d.attempt_id
        JOIN collaboration_tasks t ON t.id=d.task_id AND t.current_attempt=a.attempt_number
        WHERE d.session_id=? AND d.request_id=? AND d.state='claimed' AND a.state='running'`).all(sessionId, requestId);
      if (rows.length !== 1) return null;
      const row = rows[0];
      const parse = (value) => { try { return JSON.parse(value); } catch { return null; } };
      return { taskId: row.id, attemptId: row.attempt_id, attempt: row.attempt_number, objective: row.objective,
        acceptance: parse(row.acceptance_json), scope: { writablePaths: parse(row.writable_paths_json), accessMode: row.access_mode || null, executionIsolation: row.execution_isolation || null },
        dependencies: parse(row.depends_on_json) };
    });
    if (!task) throw Object.assign(new Error('Current organization dispatch binding is unavailable'), { code: 'ORG_EXECUTION_CONTEXT_UNAVAILABLE' });
  }
  const issued = Array.isArray(capabilities) ? capabilities : [];
  const canCreateCollaboration = issued.some((capability) => capability.operation === 'collaboration.create' && capability.resource?.type === 'session' && capability.resource?.id === sessionId);
  let canDelegate = false;
  let remainingDepth = 0;
  if (organizationToolScope?.nodeId) {
    const { getNode, getOrganization, listDelegationGrants } = await import('./organization-store.mjs');
    const node = await getNode(organizationToolScope.nodeId);
    const org = node && await getOrganization(node.organizationId);
    if (node?.currentSessionId === sessionId && node.bindingGeneration === organizationToolScope.bindingGeneration
        && node.organizationId === organizationToolScope.organizationId && org?.currentRevision === organizationToolScope.organizationRevision
        && node.lifecycleState === 'active' && node.retiredRevision === null && node.grant?.canDelegate === true
        && Number.isInteger(node.grant.maxDepth) && node.grant.maxDepth > 0) {
      const grants = await listDelegationGrants(node.organizationId, { parentNodeId: node.id, revision: org.currentRevision });
      const childIds = [...new Set(grants.map((grant) => grant.childNodeId).filter(Boolean))];
      canDelegate = childIds.some((childId) => {
        const entries = grants.filter((grant) => grant.childNodeId === childId);
        const generation = Math.max(...entries.map((grant) => grant.generation));
        const latest = entries.filter((grant) => grant.generation === generation);
        return latest.length === 1 && latest[0].lifecycleState === 'active';
      });
      if (canDelegate) remainingDepth = node.grant.maxDepth;
    }
  }
  return ['<organization-execution>', JSON.stringify({ sessionId, runId, task,
    selectedRuntime, actualRuntime: null, canCreateCollaboration, canDelegate, remainingDepth }),
    'Selected runtime is the server request; actual runtime is unknown until independently observed. Delegation is limited to capabilities actually issued to this Run.',
    '</organization-execution>'].join('\n');
}
