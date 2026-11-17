import { withDatabase } from './collaboration-store.mjs';

// Dispatch records, not model input, provide the task contract. The run ID is
// assigned by the server before the prompt and bound to its manifest at launch.
export async function buildOrganizationExecutionContext({ sessionId, runId, requestId, internalOperation, selectedRuntime, capabilities } = {}) {
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
  return ['<organization-execution>', JSON.stringify({ sessionId, runId, task,
    selectedRuntime, actualRuntime: null, canCreateCollaboration, canDelegate: false, remainingDepth: 0 }),
    'Selected runtime is the server request; actual runtime is unknown until independently observed. Delegation is limited to capabilities actually issued to this Run.',
    '</organization-execution>'].join('\n');
}
