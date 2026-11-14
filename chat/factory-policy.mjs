// Owner-controlled Factory concurrency is bounded by the Organization budget.
import { createHash } from 'node:crypto';
import { withDatabase } from './collaboration-store.mjs';

const fail = (message, statusCode = 409) => Object.assign(new Error(message), { code: 'FACTORY_POLICY_CONFLICT', statusCode });
const text = value => typeof value === 'string' ? value.trim() : '';

export async function getFactoryConcurrencyPolicy(organizationId, actor) {
  if (actor?.kind !== 'user' || actor?.role !== 'owner' || !text(actor.principalId)) throw fail('Owner access required', 403);
  const orgId = text(organizationId);
  if (!orgId) throw fail('Organization id is required', 400);
  return withDatabase(db => {
    const org = db.prepare('SELECT version,state,policy_json,budget_json FROM organizations WHERE id=?').get(orgId);
    if (!org) throw fail('Organization not found', 404);
    let policy, budget;
    try { policy = JSON.parse(org.policy_json); budget = JSON.parse(org.budget_json); } catch { throw fail('Organization policy or budget is invalid'); }
    if (!policy || typeof policy !== 'object' || Array.isArray(policy) || !budget || typeof budget !== 'object' || Array.isArray(budget)) throw fail('Organization policy or budget is invalid');
    return { organizationId: orgId, organizationVersion: org.version, state: org.state,
      factoryMaxConcurrent: Number.isSafeInteger(policy.factoryMaxConcurrent) && policy.factoryMaxConcurrent > 0 ? policy.factoryMaxConcurrent : null,
      budgetMaxConcurrent: Number.isSafeInteger(budget.maxConcurrent) && budget.maxConcurrent > 0 ? budget.maxConcurrent : null, schemaVersion: 1 };
  });
}

export async function setFactoryConcurrencyPolicy(input, actor) {
  if (actor?.kind !== 'user' || actor?.role !== 'owner' || !text(actor.principalId)) throw fail('Owner access required', 403);
  const organizationId = text(input?.organizationId), commandId = text(input?.commandId);
  const expectedVersion = input?.expectedVersion, limit = input?.factoryMaxConcurrent;
  if (!organizationId || !commandId || commandId.length > 160 || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0
      || !Number.isSafeInteger(limit) || limit < 1) throw fail('Invalid Factory policy command', 400);
  const digest = createHash('sha256').update(JSON.stringify({ organizationId, commandId, expectedVersion, factoryMaxConcurrent: limit })).digest('hex');
  return withDatabase(db => {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS factory_policy_receipts (
        command_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, actor_id TEXT NOT NULL,
        payload_digest TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL)`);
      const prior = db.prepare('SELECT * FROM factory_policy_receipts WHERE command_id=?').get(commandId);
      if (prior) {
        if (prior.organization_id !== organizationId || prior.actor_id !== actor.principalId || prior.payload_digest !== digest) throw fail('Command id belongs to a different request');
        db.exec('COMMIT');
        return { ...JSON.parse(prior.result_json), replayed: true };
      }
      const org = db.prepare('SELECT * FROM organizations WHERE id=?').get(organizationId);
      if (!org) throw fail('Organization not found', 404);
      if (['archived', 'lifecycle_pending'].includes(org.state) || org.version !== expectedVersion) throw fail('Organization version or lifecycle changed');
      let budget, policy;
      try { budget = JSON.parse(org.budget_json); policy = JSON.parse(org.policy_json); } catch { throw fail('Organization policy or budget is invalid'); }
      if (!budget || typeof budget !== 'object' || Array.isArray(budget) || !Number.isSafeInteger(budget.maxConcurrent) || budget.maxConcurrent < 1
          || limit > budget.maxConcurrent) throw fail('Factory concurrency requires an Organization maxConcurrent budget at least as large');
      if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw fail('Organization policy is invalid');
      const updatedAt = new Date().toISOString(), nextVersion = org.version + 1;
      const updated = db.prepare('UPDATE organizations SET policy_json=?,version=?,updated_at=? WHERE id=? AND version=?')
        .run(JSON.stringify({ ...policy, factoryMaxConcurrent: limit }), nextVersion, updatedAt, organizationId, expectedVersion);
      if (Number(updated.changes) !== 1) throw fail('Organization version changed');
      const result = { organizationId, organizationVersion: nextVersion, factoryMaxConcurrent: limit, operation: { commandId, state: 'completed' }, schemaVersion: 1 };
      db.prepare('INSERT INTO factory_policy_receipts VALUES(?,?,?,?,?,?)').run(commandId, organizationId, actor.principalId, digest, JSON.stringify(result), updatedAt);
      db.exec('COMMIT');
      return result;
    } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  }, { mutate: true });
}
