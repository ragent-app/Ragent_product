// Materialize the user-facing request fact from the durable collaboration plan.
// The plan and its recovery metadata are committed together by createRecord.
import { withDatabase } from './collaboration-store.mjs';
import { appendOrganizationEvent, listOrganizationEvents } from './organization-messaging.mjs';

export async function recoverOrganizationDispatchEvents(organization) {
  // Ensure the messaging schema exists before querying its event index.
  await listOrganizationEvents(organization.id, { limit: 1 });
  const pending = await withDatabase((db) => db.prepare(`
    SELECT c.policy_json, c.created_at, t.objective
    FROM collaborations c JOIN collaboration_tasks t ON t.collaboration_id = c.id
    WHERE c.root_session_id = ? AND json_valid(c.policy_json)
      AND json_extract(c.policy_json, '$.organizationId') = ?
      AND json_extract(c.policy_json, '$.organizationPhaseDispatch.eventKey') IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM organization_events e
        WHERE e.organization_id = ?
          AND e.event_key = json_extract(c.policy_json, '$.organizationPhaseDispatch.eventKey')
      )
    ORDER BY c.created_at, c.id, t.rowid
  `).all(organization.rootSessionId, organization.id, organization.id));
  for (const row of pending) {
    const policy = JSON.parse(row.policy_json);
    const metadata = policy.organizationPhaseDispatch;
    await appendOrganizationEvent({
      organizationId: organization.id, eventKey: metadata.eventKey,
      type: 'task.dispatch_requested', organizationRevision: metadata.revision,
      phaseId: metadata.phaseId, nodeId: policy.organizationNodeId, taskId: metadata.taskId,
      payload: { objective: row.objective, requestedAt: row.created_at },
    });
  }
}
