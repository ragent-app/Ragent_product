#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { createAccountAsrPostgresStore } from '../accounts/asr-postgres-store.mjs';
import { createAccountAsrService } from '../accounts/asr-service.mjs';
import { createOpenAiTranscriber } from '../accounts/asr-openai.mjs';
import { inspectAccountAsrWav } from '../accounts/asr-audio.mjs';
import { ACCOUNT_ASR_CONSENT_POLICY_VERSION, ACCOUNT_ASR_PRICE_VERSION, estimateAccountAsrCostMicroUsd } from '../accounts/asr-policy.mjs';

function syntheticWav() {
  const pcm = Buffer.alloc(32_000);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); header.writeUInt32LE(16_000, 24); header.writeUInt32LE(32_000, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

const databaseUrl = process.env.AGENTOC_ACCOUNTS_ISOLATED_TEST_DATABASE_URL || '';
assert(databaseUrl, 'Set AGENTOC_ACCOUNTS_ISOLATED_TEST_DATABASE_URL to an isolated scratch database URL');
const target = new URL(databaseUrl);
assert(/(?:test|scratch|qa)/i.test(target.pathname)
  || process.env.AGENTOC_ACCOUNTS_ISOLATED_TEST_ALLOW_SCHEMA === '1',
'Use a database named test/scratch/qa, or explicitly authorize a disposable schema inside a test database');
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
      assert(!/\bpublic\s*\.|\b(?:create\s+database|drop\s+database|alter\s+system|create\s+extension)\b/i.test(sql),
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

  // Exercise the actual service against PostgreSQL with two isolated fixture
  // accounts. The provider is synthetic, so this never sends audio externally.
  const accountIds = ['acct_asr_service_pg_a', 'acct_asr_service_pg_b'];
  for (const accountId of accountIds) {
    await pool.query('insert into accounts (account_id, provider, provider_subject) values ($1,$2,$3)',
      [accountId, 'qa', `${accountId}-fixture`]);
  }
  let providerCalls = 0;
  const service = createAccountAsrService({
    authenticateAccount: async ({ credential }) => {
      assert(accountIds.includes(credential));
      return { accountId: credential, deviceId: 'adev_asr_service_pg', plan: 'free' };
    },
    repository: store,
    transcribe: async () => { providerCalls += 1; return { text: 'fixture transcript' }; },
    clock: () => Date.UTC(2026, 10, 11),
    env: {},
  });
  const audio = syntheticWav();
  const input = { credential: accountIds[0], requestId: 'asr-service-pg-fixture-a', audio };
  await assert.rejects(() => service.transcribeAudio(input), { code: 'asr_consent_required' });
  await service.setConsent({ credential: accountIds[0], action: 'accept', policyVersion: ACCOUNT_ASR_CONSENT_POLICY_VERSION });
  const firstResult = await service.transcribeAudio(input);
  assert.equal(firstResult.text, 'fixture transcript');
  assert.deepEqual(await service.transcribeAudio(input), firstResult);
  assert.equal(providerCalls, 1, 'a repeated request must not call the provider twice');
  const firstUsage = await service.getUsage({ credential: accountIds[0] });
  assert.equal(firstUsage.usedMs, 1000);
  assert.equal(firstUsage.reservedMs, 0);
  assert.equal(firstUsage.requestCount, 1);
  const otherUsage = await service.getUsage({ credential: accountIds[1] });
  assert.equal(otherUsage.usedMs, 0, 'usage must remain isolated by account');
  assert.equal(otherUsage.consent.granted, false, 'consent must remain isolated by account');
  await assert.rejects(() => service.transcribeAudio({ ...input, credential: accountIds[1] }),
    { code: 'asr_consent_required' });
  await service.setConsent({ credential: accountIds[0], action: 'revoke' });
  await assert.rejects(() => service.transcribeAudio(input), { code: 'asr_consent_required' });
  await service.close();
  if (process.env.AGENTOC_ACCOUNTS_ASR_LIVE_QA === '1') {
    // Opt in only with synthetic speech and a disposable database. This makes
    // one billable provider request, without persisting the text or API key.
    const audioPath = process.env.AGENTOC_ACCOUNTS_ASR_LIVE_QA_AUDIO || '';
    assert(audioPath && process.env.OPENAI_API_KEY, 'Live QA requires synthetic audio and provider credentials');
    const spokenAudio = await readFile(audioPath);
    const liveService = createAccountAsrService({
      authenticateAccount: async () => ({ accountId: accountIds[1], deviceId: 'adev_asr_service_pg', plan: 'free' }),
      repository: store,
      transcribe: createOpenAiTranscriber({ apiKey: process.env.OPENAI_API_KEY }),
      clock: () => Date.UTC(2026, 10, 11),
      env: {},
    });
    await liveService.setConsent({ action: 'accept', policyVersion: ACCOUNT_ASR_CONSENT_POLICY_VERSION });
    const liveResult = await liveService.transcribeAudio({ requestId: `asr-live-pg-${randomBytes(16).toString('hex')}`, audio: spokenAudio });
    assert.match(liveResult.text.toLowerCase(), /speech recognition test/);
    const liveUsage = await liveService.getUsage();
    assert.equal(liveUsage.usedMs, inspectAccountAsrWav(spokenAudio).durationMs);
    assert.equal(liveUsage.reservedMs, 0);
    assert.equal(liveUsage.requestCount, 1);
    await liveService.close();
    console.log('account ASR live provider and PostgreSQL integration passed');
  }
  console.log('account ASR PostgreSQL reconciliation and account isolation passed');
} finally {
  await pool.end();
  if (created) await bootstrap.query(`drop schema "${schema}" cascade`);
  await bootstrap.end();
}
