#!/usr/bin/env node
import assert from 'node:assert/strict';
import http from 'node:http';
import { createElevenLabsScribeTranscriber } from '../accounts/asr-elevenlabs.mjs';
import { ACCOUNT_ASR_MAX_AUDIO_BYTES, inspectAccountAsrWav } from '../accounts/asr-audio.mjs';
import { accountAsrPeriodStart, estimateAccountAsrCostMicroUsd, resolveAccountAsrLimits } from '../accounts/asr-policy.mjs';
import { createAccountAsrService } from '../accounts/asr-service.mjs';
import { createAccountAsrPostgresStore } from '../accounts/asr-postgres-store.mjs';
import { startAccountsServer } from '../accounts/server.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function wav(durationMs = 1000, fill = 0) {
  const pcm = Buffer.alloc(durationMs * 32, fill);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); header.writeUInt32LE(16_000, 24); header.writeUInt32LE(32_000, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

class MemoryRepository {
  constructor() { this.requests = new Map(); this.usage = new Map(); }
  usageKey(accountId, periodStart) { return `${accountId}:${periodStart}`; }
  async reserve(input) {
    const usageKey = this.usageKey(input.accountId, input.periodStart);
    const usage = this.usage.get(usageKey) || { usedMs: 0, reservedMs: 0, providerCostMicroUsd: 0, requestCount: 0 };
    this.usage.set(usageKey, usage);
    const key = `${input.accountId}:${input.requestId}`;
    const existing = this.requests.get(key);
    if (existing) {
      if (existing.audioSha256 !== input.audioSha256) {
        throw Object.assign(new Error('conflict'), { code: 'asr_idempotency_conflict', statusCode: 409 });
      }
      if (existing.state === 'succeeded') return { kind: 'result_expired' };
      if (existing.state === 'failed') return { kind: 'failed', errorCode: existing.errorCode };
      if (existing.state === 'unknown') return { kind: 'unknown' };
      return { kind: 'pending' };
    }
    const active = [...this.requests.values()].filter((row) => row.accountId === input.accountId
      && ['reserved', 'processing'].includes(row.state)).length;
    if (active >= input.maxConcurrent) throw Object.assign(new Error('concurrency'), { code: 'asr_concurrency_limit', statusCode: 429 });
    if (usage.usedMs + usage.reservedMs + input.audioDurationMs > input.monthlyLimitMs) {
      throw Object.assign(new Error('quota'), { code: 'asr_monthly_quota_exceeded', statusCode: 429 });
    }
    const row = { ...input, reservedDurationMs: input.audioDurationMs, key, state: 'reserved', errorCode: null };
    this.requests.set(key, row); usage.reservedMs += input.audioDurationMs; usage.requestCount += 1;
    return { kind: 'reserved', reservedDurationMs: input.audioDurationMs };
  }
  async markProcessing({ accountId, requestId }) {
    const row = this.requests.get(`${accountId}:${requestId}`);
    if (!row || row.state !== 'reserved') return false;
    row.state = 'processing'; return true;
  }
  async settle(input) {
    const row = this.requests.get(`${input.accountId}:${input.requestId}`);
    const usage = this.usage.get(this.usageKey(input.accountId, input.periodStart));
    if (!row || row.state !== 'processing') throw Object.assign(new Error('state'), { code: 'asr_request_state_conflict', statusCode: 409 });
    row.state = 'succeeded'; row.errorCode = null;
    usage.reservedMs -= row.reservedDurationMs; usage.usedMs += input.billableDurationMs;
    usage.providerCostMicroUsd += input.costMicroUsd;
  }
  async fail(input) {
    const row = this.requests.get(`${input.accountId}:${input.requestId}`);
    const usage = this.usage.get(this.usageKey(input.accountId, input.periodStart));
    if (row && ['reserved', 'processing'].includes(row.state)) {
      row.state = 'failed'; row.errorCode = input.errorCode;
      usage.reservedMs -= row.reservedDurationMs;
    }
  }
  async markUnknown(input) {
    const row = this.requests.get(`${input.accountId}:${input.requestId}`);
    if (row) { row.state = 'unknown'; row.errorCode = input.errorCode; }
  }
  async getUsage({ accountId, periodStart }) {
    return this.usage.get(this.usageKey(accountId, periodStart))
      || { usedMs: 0, reservedMs: 0, providerCostMicroUsd: 0, requestCount: 0 };
  }
  async expireStaleReservations() { return 0; }
  async markStaleProcessingUnknown() { return 0; }
  async purgeTerminalRequests() { return 0; }
}

const audio = wav();
const inspected = inspectAccountAsrWav(audio);
assert.equal(inspected.durationMs, 1000);
assert.equal(inspected.dataBytes, 32_000);
assert.throws(() => inspectAccountAsrWav(Buffer.from('not wav')), { code: 'asr_audio_invalid' });
assert.throws(() => inspectAccountAsrWav(wav(21_000)), { code: 'asr_audio_too_long' });
const wrongRate = wav(); wrongRate.writeUInt32LE(8_000, 24);
assert.throws(() => inspectAccountAsrWav(wrongRate), { code: 'asr_audio_format_unsupported' });
assert.equal(ACCOUNT_ASR_MAX_AUDIO_BYTES, 1024 * 1024);
assert.equal(resolveAccountAsrLimits('free', { AGENTOC_ACCOUNTS_ASR_FREE_MINUTES: '2' }).monthlyLimitMs, 120_000);
assert.equal(estimateAccountAsrCostMicroUsd(1000), 62);
assert.equal(accountAsrPeriodStart(Date.UTC(2026, 10, 10)), '2026-11-01');

let providerRequest;
const transcriber = createElevenLabsScribeTranscriber({
  apiKey: 'server-key-for-test', modelId: 'scribe_v2', baseUrl: 'https://provider.example',
  fetchImpl: async (url, options) => {
    providerRequest = { url: String(url), options };
    return { ok: true, status: 200, json: async () => ({ text: ' 안녕하세요 ', language_code: 'ko' }) };
  },
});
const providerResult = await transcriber(audio);
assert.deepEqual(providerResult, { text: '안녕하세요', languageCode: 'ko' });
assert.equal(providerRequest.options.headers['xi-api-key'], 'server-key-for-test');
assert.equal(providerRequest.options.redirect, 'error', 'provider redirects must not receive the server key');
assert.equal(providerRequest.options.body.get('model_id'), 'scribe_v2');
assert.equal(providerRequest.options.body.get('language_code'), null, 'Scribe should auto-detect the language');
assert.equal(providerRequest.url, 'https://provider.example/v1/speech-to-text');
assert.equal(providerRequest.options.body.get('file').type, 'audio/wav');
assert.equal(providerRequest.options.signal instanceof AbortSignal, true, 'provider calls need a bounded cancellation signal');
const zeroRetentionProvider = createElevenLabsScribeTranscriber({ apiKey: 'test', zeroRetention: true,
  baseUrl: 'https://provider.example', fetchImpl: async (url) => {
    assert.equal(new URL(url).searchParams.get('enable_logging'), 'false');
    return { ok: true, status: 200, json: async () => ({ text: 'ok' }) };
  } });
await zeroRetentionProvider(audio);
const rejectedProvider = createElevenLabsScribeTranscriber({ apiKey: 'test', baseUrl: 'https://provider.example',
  fetchImpl: async () => ({ ok: false, status: 503, body: { cancel: async () => {} } }) });
await assert.rejects(() => rejectedProvider(audio), { code: 'asr_provider_outcome_unknown', statusCode: 503,
  definitelyNotProcessed: false });
const oversizedProviderResponse = createElevenLabsScribeTranscriber({ apiKey: 'test', baseUrl: 'https://provider.example',
  fetchImpl: async () => ({ ok: true, status: 200,
    body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(256 * 1024 + 1)); controller.close(); } }) }) });
await assert.rejects(() => oversizedProviderResponse(audio), { code: 'asr_provider_invalid_response', statusCode: 502 });

// Keep the ASR repository tenant-safe and free of aggregate/request lock-order
// inversions that can deadlock an idempotent retry against settlement.
const postgresCalls = [];
const postgresClient = {
  async query(sql, params = []) {
    const normalized = String(sql).replace(/\s+/g, ' ').trim();
    postgresCalls.push({ sql: normalized, params });
    if (normalized.includes('select used_audio_ms, reserved_audio_ms from account_asr_usage')) {
      return { rows: [{ used_audio_ms: '0', reserved_audio_ms: '0' }] };
    }
    if (normalized.includes('select state, audio_sha256, audio_duration_ms')) return { rows: [] };
    if (normalized.includes('select count(*)::int as count')) return { rows: [{ count: 0 }] };
    if (normalized.includes('select account_id from account_asr_usage') && normalized.includes('for update')) {
      return { rows: [{ account_id: 'acct_pg_test' }] };
    }
    if (normalized.includes('select reserved_duration_ms, period_start from account_asr_requests')) {
      return { rows: [{ reserved_duration_ms: '1000', period_start: '2026-11-01' }] };
    }
    if (normalized.includes('select used_audio_ms, reserved_audio_ms, request_count from account_asr_usage')) {
      return { rows: [{ used_audio_ms: '1000', reserved_audio_ms: '0', request_count: '1' }] };
    }
    if (normalized.includes('to_regclass')) return { rows: [{ usage_table: 'account_asr_usage', requests_table: 'account_asr_requests' }] };
    if (normalized.startsWith('update account_asr_requests set state=') || normalized.startsWith('update account_asr_usage set')) {
      return { rowCount: 1, rows: [] };
    }
    return { rowCount: 1, rows: [] };
  },
  release() {},
};
const pgStore = createAccountAsrPostgresStore({ pool: { connect: async () => postgresClient }, schema: 'tenant_asr_test' });
await pgStore.getUsage({ accountId: 'acct_pg_test', periodStart: '2026-11-01' });
const usageRead = postgresCalls.findIndex((call) => call.sql.includes('select used_audio_ms, reserved_audio_ms, request_count from account_asr_usage'));
assert.equal(postgresCalls[0].sql, 'begin');
assert.equal(postgresCalls[1].params[1], 'tenant_asr_test');
assert.ok(postgresCalls[1].sql.includes('set_config'));
assert.ok(postgresCalls.findIndex((call) => call.sql === 'commit') > usageRead,
  'the tenant query must commit after search_path is established');

postgresCalls.length = 0;
await pgStore.reserve({ accountId: 'acct_pg_test', deviceId: 'adev_pg_test', requestId: 'pg-request-1234567890',
  periodStart: '2026-11-01', audioSha256: 'a'.repeat(64), audioBytes: 32_044, audioDurationMs: 1000,
  monthlyLimitMs: 60_000, priceVersion: 'test-price', policyVersion: 'test-policy' });
const reserveUsageLock = postgresCalls.findIndex((call) => call.sql.includes('select used_audio_ms, reserved_audio_ms from account_asr_usage'));
const reserveRequestLock = postgresCalls.findIndex((call) => call.sql.includes('select state, audio_sha256, audio_duration_ms'));
assert.ok(reserveUsageLock >= 0 && reserveUsageLock < reserveRequestLock,
  'reservation must lock account-period usage before the idempotency request');

postgresCalls.length = 0;
await pgStore.settle({ accountId: 'acct_pg_test', requestId: 'pg-request-1234567890', periodStart: '2026-11-01',
  billableDurationMs: 1000, costMicroUsd: 62, latencyMs: 120, languageCode: 'en' });
const settleUsageLock = postgresCalls.findIndex((call) => call.sql.includes('select account_id from account_asr_usage') && call.sql.includes('for update'));
const settleRequestLock = postgresCalls.findIndex((call) => call.sql.includes('select reserved_duration_ms, period_start from account_asr_requests'));
assert.ok(settleUsageLock >= 0 && settleUsageLock < settleRequestLock,
  'settlement must lock account-period usage before its request');

postgresCalls.length = 0;
await pgStore.fail({ accountId: 'acct_pg_test', requestId: 'pg-request-1234567890', periodStart: '2026-11-01', errorCode: 'test' });
const failUsageLock = postgresCalls.findIndex((call) => call.sql.includes('select account_id from account_asr_usage') && call.sql.includes('for update'));
const failRequestLock = postgresCalls.findIndex((call) => call.sql.includes('select reserved_duration_ms, period_start from account_asr_requests'));
assert.ok(failUsageLock >= 0 && failUsageLock < failRequestLock,
  'failure settlement must use the same lock order');

const repository = new MemoryRepository();
const auditEvents = [];
let providerCalls = 0;
const credential = `rac_${'x'.repeat(40)}`;
const asrService = createAccountAsrService({
  authenticateAccount: async ({ credential: presented }) => {
    if (presented !== credential) throw Object.assign(new Error('auth'), { code: 'owner_auth_account_credential_invalid', statusCode: 401 });
    return { accountId: 'acct_asr_test', deviceId: 'adev_asr_test', plan: 'free' };
  },
  repository,
  transcribe: async () => { providerCalls += 1; return { text: '测试语音', languageCode: 'zh' }; },
  enabled: true,
  env: { AGENTOC_ACCOUNTS_ASR_FREE_MINUTES: '1' },
  clock: () => Date.UTC(2026, 10, 10),
  audit: (event) => auditEvents.push(event),
});
const requestId = '2a596b38-4340-4de6-bff6-9b6538944c4f';
const result = await asrService.transcribeAudio({ credential, requestId, audio });
assert.equal(result.text, '测试语音');
assert.equal(providerCalls, 1);
const pricedRequest = repository.requests.get(`acct_asr_test:${requestId}`);
assert.equal(pricedRequest.providerName, 'elevenlabs');
assert.equal(pricedRequest.modelId, 'scribe_v2');
assert.equal(pricedRequest.priceVersion, 'elevenlabs-scribe-v2-2026-11');
assert.equal(pricedRequest.policyVersion, 'account-asr-monthly-v1');
assert.deepEqual(await asrService.transcribeAudio({ credential, requestId, audio }), result);
assert.equal(providerCalls, 1, 'idempotent replay must not call the provider twice');
const cancelled = new AbortController(); cancelled.abort();
await assert.rejects(() => asrService.transcribeAudio({ credential,
  requestId: 'cancelled-request-id-1234', audio, signal: cancelled.signal }),
{ code: 'asr_request_cancelled', statusCode: 499 });
assert.equal(providerCalls, 1, 'a request cancelled before reservation must not call the provider');
await assert.rejects(() => asrService.transcribeAudio({ credential, requestId, audio: wav(1000, 1) }),
  { code: 'asr_idempotency_conflict', statusCode: 409 });
await assert.rejects(() => asrService.transcribeAudio({ credential: 'invalid', requestId: 'ab'.repeat(18), audio }),
  { code: 'owner_auth_account_credential_invalid', statusCode: 401 });
const usage = await asrService.getUsage({ credential });
assert.equal(usage.usedMs, 1000);
assert.equal(usage.reservedMs, 0);
assert.equal(usage.remainingMs, 59_000);
assert.equal(Object.hasOwn(usage, 'providerCostMicroUsd'), false,
  'customer usage must not expose Ragent provider cost');
assert.equal(repository.usage.get('acct_asr_test:2026-11-01').providerCostMicroUsd, 62,
  'estimated provider cost remains available to Accounts operations but is not returned to clients');
assert.deepEqual(await asrService.runMaintenance(), { unknownOutcomes: 0, expiredReservations: 0, purgedRequests: 0 });
assert.equal(JSON.stringify(auditEvents).includes('测试语音'), false, 'transcripts must not be written to audit events');
assert.equal(JSON.stringify(auditEvents).includes(credential), false, 'credentials must not be written to audit events');

const unknownRepository = new MemoryRepository();
let uncertainCalls = 0;
const uncertainService = createAccountAsrService({ authenticateAccount: async () => ({ accountId: 'acct_unknown', deviceId: 'adev', plan: 'free' }),
  repository: unknownRepository, transcribe: async () => { uncertainCalls += 1; throw Object.assign(new Error('timeout'), { code: 'asr_provider_outcome_unknown', statusCode: 503 }); },
  enabled: true, env: { AGENTOC_ACCOUNTS_ASR_FREE_MINUTES: '1' }, clock: () => Date.UTC(2026, 10, 10) });
const unknownId = '4d3c482d-558e-4e03-9ca5-5a65e58662e4';
await assert.rejects(() => uncertainService.transcribeAudio({ credential, requestId: unknownId, audio }), { code: 'asr_provider_outcome_unknown' });
await assert.rejects(() => uncertainService.transcribeAudio({ credential, requestId: unknownId, audio }), { code: 'asr_request_outcome_unknown' });
assert.equal(uncertainCalls, 1, 'uncertain provider outcomes must not be automatically retried');
assert.equal((await uncertainService.getUsage({ credential })).reservedMs, 1000, 'uncertain usage remains reserved');

const tempDir = mkdtempSync(join(tmpdir(), 'agentoc-account-asr-'));
const makeHttpRequest = (port, { method, path, headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const request = http.request({ hostname: '127.0.0.1', port, method, path, headers: {
    ...(body ? { 'content-length': body.length } : {}), ...headers,
  } }, (response) => {
    const chunks = [];
    response.on('data', (chunk) => chunks.push(chunk));
    response.on('end', () => resolve({ status: response.statusCode, headers: response.headers,
      body: Buffer.concat(chunks).toString('utf8') }));
  });
  request.on('error', reject);
  if (body) request.write(body);
  request.end();
});

let receivedAudio = null;
const injectedService = {
  enabled: true,
  async checkReady() { return true; },
  async transcribeAudio(input) {
    receivedAudio = input.audio;
    assert.equal(input.credential, credential);
    assert.equal(input.requestId, requestId);
    return { contractVersion: 1, requestId, text: '真实 HTTP 音频', languageCode: 'zh', durationMs: 1000 };
  },
  async getUsage(input) {
    assert.equal(input.credential, credential);
    return { contractVersion: 1, available: true, policyVersion: 'account-asr-monthly-v1',
      period: '2026-11', plan: 'free', limitMs: 60_000, usedMs: 1000, reservedMs: 0,
      remainingMs: 59_000, requestCount: 1 };
  },
};

const server = await startAccountsServer({ host: '127.0.0.1', port: 0, logger: { level: 'silent' },
  dataFile: join(tempDir, 'accounts.json'), signingKeyFile: join(tempDir, 'signing-key.json'),
  turnBrokerSigningKeyFile: join(tempDir, 'turn-key.json'), publicBaseUrl: 'http://127.0.0.1:0/accounts',
  allowInsecurePublicBaseUrl: true, asrService: injectedService });
try {
  const port = server.server.address().port;
  const post = await makeHttpRequest(port, { method: 'POST', path: '/accounts/v1/owner-auth/account/asr/transcriptions',
    headers: { authorization: `Bearer ${credential}`, 'content-type': 'audio/wav', 'idempotency-key': requestId }, body: audio });
  assert.equal(post.status, 200);
  assert.equal(JSON.parse(post.body).text, '真实 HTTP 音频');
  assert.equal(receivedAudio.equals(audio), true, 'Fastify must pass raw WAV bytes without JSON reconstruction');
  assert.equal(post.headers['cache-control'], 'no-store');

  const usageResponse = await makeHttpRequest(port, { method: 'GET',
    path: '/accounts/v1/owner-auth/account/asr/usage?period=2026-11', headers: { authorization: `Bearer ${credential}` } });
  assert.equal(usageResponse.status, 200);
  const usageBody = JSON.parse(usageResponse.body);
  assert.equal(usageBody.remainingMs, 59_000);
  assert.equal(Object.hasOwn(usageBody, 'providerCostMicroUsd'), false,
    'the public usage contract must not expose Ragent provider costs');

  const oversized = await makeHttpRequest(port, { method: 'POST', path: '/accounts/v1/owner-auth/account/asr/transcriptions',
    headers: { authorization: `Bearer ${credential}`, 'content-type': 'audio/wav', 'idempotency-key': requestId },
    body: Buffer.alloc(ACCOUNT_ASR_MAX_AUDIO_BYTES + 1) });
  assert.equal(oversized.status, 413);
  assert.equal(JSON.parse(oversized.body).code, 'asr_audio_too_large');

  const unsupported = await makeHttpRequest(port, { method: 'POST', path: '/accounts/v1/owner-auth/account/asr/transcriptions',
    headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json', 'idempotency-key': requestId },
    body: Buffer.from('{}') });
  assert.equal(unsupported.status, 415);
  assert.equal(JSON.parse(unsupported.body).code, 'asr_audio_content_type_unsupported');
} finally {
  await server.close();
  rmSync(tempDir, { recursive: true, force: true });
}

console.log('account ASR tests passed');
