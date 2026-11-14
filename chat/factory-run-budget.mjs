// Resolve budget authority only from the durable Factory outbox and reservation.
// A request or provider event is never an authority for its own limit.
import { stat } from 'node:fs/promises';
import { CHAT_COLLABORATIONS_DB } from '../lib/config.mjs';
import { withDatabase } from './collaboration-store.mjs';

const conflict = message => { throw Object.assign(new Error(message), { code: 'FACTORY_RUN_BUDGET_CONFLICT', statusCode: 409 }); };
const parse = value => { try { return JSON.parse(value); } catch { return null; } };

export async function resolveFactoryRunBudget({ sessionId, requestId, runId, managed = false } = {}) {
  if (!sessionId || !requestId || !runId) { if (managed) conflict('Managed Run identity is incomplete'); return null; }
  if (!await stat(CHAT_COLLABORATIONS_DB).then(() => true, error => error?.code === 'ENOENT' ? false : Promise.reject(error))) {
    if (managed) conflict('Managed Run authority is unavailable');
    return null;
  }
  return withDatabase(db => {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='collaboration_dispatch_commands'").get()) return null;
    const rows = db.prepare(`SELECT d.id AS command_id,d.task_id,d.attempt_id,d.run_id AS command_run_id,d.state AS command_state,
      a.run_id AS attempt_run_id,a.session_id AS attempt_session_id,a.state AS attempt_state,a.lifecycle_phase AS attempt_phase,
      c.id AS collaboration_id,c.idempotency_key,c.policy_json
      FROM collaboration_dispatch_commands d JOIN collaboration_attempts a ON a.id=d.attempt_id AND a.task_id=d.task_id
      JOIN collaborations c ON c.id=d.collaboration_id JOIN collaboration_tasks t ON t.id=d.task_id AND t.collaboration_id=c.id
      WHERE d.session_id=? AND d.request_id=?`).all(sessionId, requestId);
    const policies = rows.map(row => ({ row, policy: parse(row.policy_json) }));
    if (policies.some(x => !x.policy || typeof x.policy !== 'object' || Array.isArray(x.policy))) conflict('Dispatch policy is invalid');
    const factory = policies.filter(x => x.policy.factoryExecution);
    if (!factory.length) return null;
    if (factory.length !== 1 || rows.length !== 1) conflict('Ambiguous Factory dispatch identity');
    const { row, policy } = factory[0];
    const context = policy.factoryExecution;
    if (!['pending','claimed','completed'].includes(row.command_state) || row.attempt_state !== 'running' || row.attempt_phase !== 'dispatching'
      || (row.attempt_session_id && row.attempt_session_id !== sessionId) || (row.command_run_id && row.command_run_id !== runId)
      || (row.attempt_run_id && row.attempt_run_id !== runId) || row.task_id !== context.workItemId
      || row.idempotency_key !== context.dispatchKey) conflict('Factory dispatch identity changed');
    const item = db.prepare('SELECT * FROM factory_work_items WHERE id=? AND organization_id=?').get(context.workItemId, context.organizationId);
    const binding = db.prepare('SELECT * FROM factory_execution_bindings WHERE work_item_id=? AND execution_epoch=? AND binding_generation=?').get(context.workItemId, context.executionEpoch, context.bindingGeneration);
    const contract = db.prepare('SELECT * FROM factory_work_contracts WHERE work_item_id=? AND revision=?').get(context.workItemId, context.contractRevision);
    if (!item || !binding || !contract || item.ownership !== 'active' || item.state !== 'claimed' || item.control_state !== 'none'
      || binding.status !== 'intent' || item.contract_revision !== context.contractRevision || item.execution_epoch !== context.executionEpoch
      || item.binding_generation !== context.bindingGeneration || binding.contract_revision !== context.contractRevision
      || binding.dispatch_key !== context.dispatchKey || (binding.collaboration_id && binding.collaboration_id !== row.collaboration_id)
      || (binding.attempt_id && binding.attempt_id !== row.attempt_id) || (binding.run_id && binding.run_id !== runId)) conflict('Factory binding changed');
    const body = parse(contract.contract_json);
    if (!body || body.organizationRevision !== context.organizationRevision || context.budgetKey !== `factory:${binding.id}`) conflict('Factory contract identity changed');
    const counter = db.prepare('SELECT reservations_json FROM organization_budget_counters WHERE organization_id=? AND revision=?').get(context.organizationId, context.organizationRevision);
    const reservation = parse(counter?.reservations_json)?.[context.budgetKey];
    if (!reservation || reservation.state !== 'reserved' || reservation.reservationId !== context.budgetKey || reservation.factoryWorkItemId !== item.id) conflict('Factory budget reservation unavailable');
    const tokens = reservation.delta?.tokens;
    const cost = reservation.delta?.cost;
    if (!Number.isSafeInteger(tokens) || tokens <= 0) conflict('Factory token limit is required; provider cost is not observable');
    return { schemaVersion: 1, organizationId: context.organizationId, workItemId: item.id, bindingId: binding.id,
      contractRevision: context.contractRevision, contractDigest: contract.digest, executionEpoch: context.executionEpoch,
      bindingGeneration: context.bindingGeneration, collaborationId: row.collaboration_id, attemptId: row.attempt_id,
      dispatchCommandId: row.command_id, sessionId, requestId, runId, reservationId: context.budgetKey,
      tokenLimit: Number.isSafeInteger(tokens) && tokens > 0 ? tokens : null,
      costLimit: Number.isFinite(cost) && cost > 0 ? cost : null, costObservation: 'unknown' };
  });
}
