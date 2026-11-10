#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { createAccountAsrPostgresStore } from '../accounts/asr-postgres-store.mjs';
import { ACCOUNT_ASR_PRICE_VERSION, estimateAccountAsrCostMicroUsd } from '../accounts/asr-policy.mjs';

const databaseUrl = process.env.AGENTOC_ACCOUNTS_ISOLATED_TEST_DATABASE_URL || '';
assert(databaseUrl, 'Set AGENTOC_ACCOUNTS_ISOLATED_TEST_DATABASE_URL to an isolated scratch database URL');
const target = new URL(databaseUrl);
assert(/(?:test|scratch|qa)/i.test(target.pathname), 'The isolated test database name must contain test, scratch, or qa');
const schema = `qa_asr_reconcile_${randomBytes(12).toString('hex')}`;
assert(/^qa_asr_reconcile_[a-f0-9]{24}$/.test(schema));

const bootstrap = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000 });
const pool = new Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 5000,
  options: `-c search_path=${schema},public -c statement_timeout=15000` });
let created = false;
try {
  await bootstrap.query(`create schema "${schema}"`);
  created = true;
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`set local search_path to "${schema}", public`);
    const migrationDir = resolve('accounts/migrations');
    const migrations = (await readdir(migrationDir)).filter(name => name.endsWith('.up.sql')).sort();
    for (const file of migrations) {
      const sql = await readFile(resolve(migrationDir, file), 'utf8');
      assert(!/\b(?:create\s+database|drop\s+database|alter\s+system|create\s+extension)\b/i.test(sql),
        `Isolated ASR migration cannot contain global database operations: ${file}`);
      await client.query(sql);
    }
    await client.query('insert into accounts (account_id, provider, provider_subject) values ($1,$2,$3)',
      ['acct_asr_reconcile_pg', 'qa', 'asr-reconcile-postgres-fixture']);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally { client.release(); }

  const store = createAccountAsrPostgresStore({ pool, schema });
  const base = { accountId: 'acct_asr_reconcile_pg', deviceId: 'adev_asr_reconcile_pg',
    periodStart: '2026-11-01', audioBytes: 32_044, audioDurationMs: 1000, monthlyLimitMs: 60_000,
    audioSha256: 'a'.repeat(64), priceVersion: ACCOUNT_ASR_PRICE_VERSION, policyVersion: 'qa-policy' };
  for (const requestId of ['asr-reconcile-pg-processed', 'asr-reconcile-pg-rejected']) {
    assert.deepEqual(await store.reserve({ ...base, requestId }), { kind: 'reserved', reclaimed: false, reservedDurationMs: 1000 });
    assert.equal(await store.markProcessing({ accountId: base.accountId, requestId }), true);
    assert.equal(await store.markUnknown({ accountId: base.accountId, requestId,
      errorCode: 'asr_provider_outcome_unknown' }), true);
  }
  assert.equal((await store.listUnknownRequests()).length, 2);
  const preview = await store.previewUnknownReconciliation({ accountId: base.accountId,
    requestId: 'asr-reconcile-pg-processed', outcome: 'provider_processed_result_lost' });
  assert.equal(preview.kind, 'preview');
  assert.equal(preview.request.releaseDurationMs, 1000);
  assert.equal(preview.request.estimatedProviderCostMicroUsd, estimateAccountAsrCostMicroUsd(1000));

  const processed = await store.reconcileUnknown({ accountId: base.accountId,
    requestId: 'asr-reconcile-pg-processed', outcome: 'provider_processed_result_lost',
    operatorId: 'qa-operator', evidenceRef: 'fixture-provider-log-1', reason: 'Synthetic provider processing confirmed.' });
  assert.equal(processed.kind, 'reconciled');
  assert.equal(processed.releasedDurationMs, 1000);
  assert.equal(processed.providerCostMicroUsd, estimateAccountAsrCostMicroUsd(1000));
  assert.equal((await store.getUsage({ accountId: base.accountId, periodStart: base.periodStart })).reservedMs, 1000,
    'only the first of two requests has been released');
  const repeated = await store.reconcileUnknown({ accountId: base.accountId,
    requestId: 'asr-reconcile-pg-processed', outcome: 'provider_processed_result_lost',
    operatorId: 'qa-operator', evidenceRef: 'fixture-provider-log-1', reason: 'Idempotency check.' });
  assert.equal(repeated.kind, 'already_reconciled');

  const rejected = await store.reconcileUnknown({ accountId: base.accountId,
    requestId: 'asr-reconcile-pg-rejected', outcome: 'provider_not_processed',
    operatorId: 'qa-operator', evidenceRef: 'fixture-provider-log-2', reason: 'Synthetic rejection confirmed.' });
  assert.equal(rejected.kind, 'reconciled');
  assert.equal(rejected.providerCostMicroUsd, null);
  assert.deepEqual(await store.getUsage({ accountId: base.accountId, periodStart: base.periodStart }),
    { usedMs: 0, reservedMs: 0, requestCount: 2 });

  const raw = await pool.query(`select state, reserved_duration_ms, provider_cost_microusd, error_code
    from account_asr_requests where account_id=$1 order by request_id`, [base.accountId]);
  assert.equal(raw.rows.length, 2);
  assert(raw.rows.every(row => row.state === 'failed' && row.reserved_duration_ms === 0));
  assert.equal(raw.rows.find(row => row.error_code === 'asr_reconciled_result_lost').provider_cost_microusd,
    String(estimateAccountAsrCostMicroUsd(1000)));
  assert.equal(raw.rows.find(row => row.error_code === 'asr_reconciled_provider_not_processed').provider_cost_microusd, null);
  const audit = await pool.query(`select outcome, operator_id, evidence_ref from account_asr_reconciliations
    where account_id=$1 order by request_id`, [base.accountId]);
  assert.equal(audit.rows.length, 2);
  assert.deepEqual(audit.rows.map(row => row.outcome).sort(),
    ['provider_not_processed', 'provider_processed_result_lost'].sort());
  await pool.query('delete from accounts where account_id=$1', [base.accountId]);
  assert.equal((await pool.query('select count(*)::int as count from account_asr_reconciliations')).rows[0].count, 0,
    'account deletion cascades the reconciliation evidence with the request');
  console.log('account ASR reconciliation PostgreSQL integration passed');
} finally {
  await pool.end();
  if (created) await bootstrap.query(`drop schema "${schema}" cascade`);
  await bootstrap.end();
}
