import assert from 'node:assert/strict';
import { createAccountAsrPostgresStore } from '../accounts/asr-postgres-store.mjs';
import { runAsrReconcileCommand } from '../accounts/asr-reconcile.mjs';
import { ACCOUNT_ASR_PRICE_VERSION, estimateAccountAsrCostMicroUsd } from '../accounts/asr-policy.mjs';

const calls = [];
let lockRequestState = 'unknown';
let usageReservedMs = 1000;
const requestRow = {
  account_id: 'acct_reconcile_test', request_id: 'request-1234567890', period_start: '2026-11-01',
  state: 'unknown', audio_duration_ms: 1000, reserved_duration_ms: 1000,
  provider_name: 'openai', model_id: 'gpt-transcribe', price_version: ACCOUNT_ASR_PRICE_VERSION,
  error_code: 'asr_provider_outcome_unknown', provider_cost_microusd: null,
  created_at: new Date('2026-11-10T00:00:00.000Z'), updated_at: new Date('2026-11-10T00:01:00.000Z'),
};
const client = {
  async query(sql, params = []) {
    const normalized = String(sql).replace(/\s+/g, ' ').trim();
    calls.push({ sql: normalized, params });
    if (normalized.includes('select period_start::text as period_start, state from account_asr_requests')) {
      return { rows: [{ period_start: requestRow.period_start, state: lockRequestState }] };
    }
    if (normalized.includes('select reserved_audio_ms from account_asr_usage')) {
      return { rows: [{ reserved_audio_ms: String(usageReservedMs) }] };
    }
    if (normalized.includes('select account_id, request_id, period_start::text as period_start')) {
      return { rows: [{ ...requestRow, state: lockRequestState }] };
    }
    if (normalized.includes('select outcome, operator_id, evidence_ref')) {
      return { rows: [{ outcome: 'provider_processed_result_lost', operator_id: 'qa',
        evidence_ref: 'QA-123', provider_cost_microusd: '62', created_at: new Date('2026-11-10T00:02:00Z') }] };
    }
    if (normalized.startsWith('update account_asr_requests set state=\'failed\'')) return { rowCount: 1, rows: [{ request_id: params[1] }] };
    if (normalized.startsWith('insert into account_asr_reconciliations')) return { rowCount: 1, rows: [] };
    return { rowCount: 1, rows: [] };
  },
  release() {},
};
const store = createAccountAsrPostgresStore({ pool: { connect: async () => client }, schema: 'tenant_asr_test' });

const preview = await store.previewUnknownReconciliation({ accountId: 'acct_reconcile_test',
  requestId: 'request-1234567890', outcome: 'provider_processed_result_lost' });
assert.equal(preview.kind, 'preview');
assert.equal(preview.request.releaseDurationMs, 1000);
assert.equal(preview.request.estimatedProviderCostMicroUsd, estimateAccountAsrCostMicroUsd(1000));

calls.length = 0;
const applied = await store.reconcileUnknown({ accountId: 'acct_reconcile_test', requestId: 'request-1234567890',
  outcome: 'provider_processed_result_lost', operatorId: 'qa-operator', evidenceRef: 'SUP-123',
  reason: 'Provider request was confirmed in its request log.' });
assert.deepEqual(applied, { kind: 'reconciled', outcome: 'provider_processed_result_lost',
  accountId: 'acct_reconcile_test', requestId: 'request-1234567890', releasedDurationMs: 1000,
  providerCostMicroUsd: estimateAccountAsrCostMicroUsd(1000), costSource: 'internal_estimate' });
const usageLock = calls.findIndex((call) => call.sql.includes('select reserved_audio_ms from account_asr_usage')
  && call.sql.includes('for update'));
const requestLock = calls.findIndex((call) => call.sql.includes('where account_id=$1 and request_id=$2 for update'));
assert(usageLock >= 0 && requestLock > usageLock, 'reconciliation must lock the usage aggregate before its request');
const releaseUpdate = calls.find((call) => call.sql.startsWith('update account_asr_usage set reserved_audio_ms=reserved_audio_ms-$3'));
assert(releaseUpdate, 'reconciliation must release the exact reserved minutes atomically');
assert.equal(releaseUpdate.params[2], 1000);
assert.equal(releaseUpdate.params[3], estimateAccountAsrCostMicroUsd(1000));
assert(!calls.some((call) => /update account_asr_usage set[^;]*used_audio_ms/i.test(call.sql)),
  'a lost transcript must not consume customer quota');
const reconciliationInsert = calls.find((call) => call.sql.startsWith('insert into account_asr_reconciliations'));
assert.deepEqual(reconciliationInsert.params.slice(2), ['provider_processed_result_lost', 'qa-operator', 'SUP-123',
  'Provider request was confirmed in its request log.', 'asr_provider_outcome_unknown',
  estimateAccountAsrCostMicroUsd(1000), 'internal_estimate']);

calls.length = 0;
const rejectedBeforeProcessing = await store.reconcileUnknown({ accountId: 'acct_reconcile_test',
  requestId: 'request-1234567890', outcome: 'provider_not_processed', operatorId: 'qa-operator',
  evidenceRef: 'SUP-124', reason: 'Provider log confirms rejection before processing.' });
assert.equal(rejectedBeforeProcessing.providerCostMicroUsd, null,
  'confirmed non-processing must not add an estimated provider cost');
const rejectedRecord = calls.find((call) => call.sql.startsWith('insert into account_asr_reconciliations'));
assert.equal(rejectedRecord.params[7], null);
assert.equal(rejectedRecord.params[8], null);

calls.length = 0;
usageReservedMs = 999;
await assert.rejects(() => store.reconcileUnknown({ accountId: 'acct_reconcile_test', requestId: 'request-1234567890',
  outcome: 'provider_not_processed', operatorId: 'qa-operator', evidenceRef: 'SUP-123', reason: 'Not processed.' }),
error => error.code === 'asr_reconciliation_usage_conflict');
assert(!calls.some((call) => call.sql.startsWith('update account_asr_requests')
  || call.sql.startsWith('update account_asr_usage') || call.sql.startsWith('insert into account_asr_reconciliations')),
'an inconsistent aggregate must not be changed');
usageReservedMs = 1000;

calls.length = 0;
lockRequestState = 'failed';
const repeated = await store.reconcileUnknown({ accountId: 'acct_reconcile_test', requestId: 'request-1234567890',
  outcome: 'provider_processed_result_lost', operatorId: 'qa-operator', evidenceRef: 'SUP-123', reason: 'Repeated request.' });
assert.equal(repeated.kind, 'already_reconciled', 'a repeated operator action must not release quota twice');
assert(!calls.some((call) => call.sql.startsWith('update account_asr_requests')
  || call.sql.startsWith('update account_asr_usage') || call.sql.startsWith('insert into account_asr_reconciliations')));
lockRequestState = 'unknown';

const outputs = [];
const mutations = [];
const commandRepository = {
  async listUnknownRequests() { return []; },
  async previewUnknownReconciliation() { return { kind: 'preview', request: { requestId: 'request-1234567890' } }; },
  async reconcileUnknown(input) { mutations.push(input); return { kind: 'reconciled', requestId: input.requestId }; },
};
const resolveArgs = ['resolve', '--account-id', 'acct_reconcile_test', '--request-id', 'request-1234567890',
  '--outcome', 'provider_not_processed', '--operator-id', 'qa-operator', '--evidence-ref', 'SUP-123',
  '--reason', 'Provider logs confirmed this request was rejected before processing.'];
assert.equal(await runAsrReconcileCommand({ argv: resolveArgs, repository: commandRepository,
  stdout: value => outputs.push(value), stderr: value => outputs.push(value) }), 0);
assert.equal(mutations.length, 0, 'resolve without --apply must remain read-only');
assert.equal(JSON.parse(outputs.at(-1)).changesApplied, false);
assert.equal(await runAsrReconcileCommand({ argv: [...resolveArgs, '--apply'], repository: commandRepository,
  stdout: value => outputs.push(value), stderr: value => outputs.push(value) }), 0);
assert.equal(mutations.length, 1, '--apply must be the only path to a reconciliation write');
assert.equal(await runAsrReconcileCommand({ argv: ['resolve', ...resolveArgs.slice(1, 7)], repository: commandRepository,
  stdout: value => outputs.push(value), stderr: value => outputs.push(value) }), 2,
'incomplete operator evidence must be rejected');

console.log('account ASR reconciliation tests passed');
