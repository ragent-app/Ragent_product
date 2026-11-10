import { createHash } from 'node:crypto';
import { inspectAccountAsrWav } from './asr-audio.mjs';
import {
  ACCOUNT_ASR_MODEL,
  ACCOUNT_ASR_PRICE_VERSION,
  ACCOUNT_ASR_PROVIDER,
  accountAsrPeriodStart,
  estimateAccountAsrCostMicroUsd,
  normalizeAccountAsrPeriod,
  resolveAccountAsrLimits,
} from './asr-policy.mjs';

const REQUEST_ID = /^[A-Za-z0-9_-]{16,128}$/;
const RESULT_CACHE_TTL_MS = 5 * 60_000;
const RESULT_CACHE_MAX = 256;
const ASR_MAINTENANCE_INTERVAL_MS = 15 * 60_000;
const ASR_REQUEST_RETENTION_MS = 90 * 24 * 60 * 60_000;

function asrError(code, statusCode, message = code) {
  return Object.assign(new Error(message), { code, statusCode });
}

function normalizeError(error) {
  if (Number.isInteger(error?.statusCode) && typeof error?.code === 'string') return error;
  return asrError('asr_unavailable', 503);
}

function safeLanguageCode(value) {
  return typeof value === 'string' && /^[A-Za-z0-9-]{2,16}$/.test(value) ? value : null;
}

export function createAccountAsrService({
  authenticateAccount,
  repository,
  transcribe,
  enabled = true,
  env = process.env,
  clock = Date.now,
  audit = () => {},
  maxConcurrentPerAccount = 2,
} = {}) {
  if (typeof authenticateAccount !== 'function') throw new TypeError('Account authentication is required');
  if (!repository || typeof repository.reserve !== 'function' || typeof repository.getUsage !== 'function') {
    throw new TypeError('An ASR usage repository is required');
  }
  const resultCache = new Map();
  const inFlight = new Map();
  let maintenanceTimer = null;
  let maintenancePromise = null;

  function purgeResultCache(now) {
    for (const [key, entry] of resultCache) if (entry.expiresAt <= now) resultCache.delete(key);
    while (resultCache.size > RESULT_CACHE_MAX) resultCache.delete(resultCache.keys().next().value);
  }

  async function getUsage({ credential = '', period: rawPeriod } = {}) {
    const principal = await authenticateAccount({ credential });
    const period = normalizeAccountAsrPeriod(rawPeriod, clock());
    const limits = resolveAccountAsrLimits(principal.plan, env);
    const usage = await repository.getUsage({ accountId: principal.accountId, periodStart: `${period}-01` });
    const remainingMs = Math.max(0, limits.monthlyLimitMs - usage.usedMs - usage.reservedMs);
    return {
      contractVersion: 1,
      available: enabled && typeof transcribe === 'function',
      policyVersion: limits.policyVersion,
      period,
      plan: limits.plan,
      limitMs: limits.monthlyLimitMs,
      usedMs: usage.usedMs,
      reservedMs: usage.reservedMs,
      remainingMs,
      requestCount: usage.requestCount,
    };
  }

  async function runMaintenance() {
    if (maintenancePromise) return maintenancePromise;
    maintenancePromise = (async () => {
      const unknownOutcomes = typeof repository.markStaleProcessingUnknown === 'function'
        ? await repository.markStaleProcessingUnknown({ olderThanMs: 120_000, batchSize: 500 }) : 0;
      const expiredReservations = typeof repository.expireStaleReservations === 'function'
        ? await repository.expireStaleReservations({ olderThanMs: 120_000, batchSize: 500 }) : 0;
      const purgedRequests = typeof repository.purgeTerminalRequests === 'function'
        ? await repository.purgeTerminalRequests({ olderThanMs: ASR_REQUEST_RETENTION_MS, batchSize: 1_000 }) : 0;
      if (unknownOutcomes || expiredReservations || purgedRequests) {
        audit({ event: 'account_asr.maintenance', unknownOutcomes, expiredReservations, purgedRequests });
      }
      return { unknownOutcomes, expiredReservations, purgedRequests };
    })();
    try { return await maintenancePromise; } finally { maintenancePromise = null; }
  }

  function startMaintenance() {
    if (maintenanceTimer || (typeof repository.expireStaleReservations !== 'function'
      && typeof repository.purgeTerminalRequests !== 'function')) return;
    runMaintenance().catch((error) => audit({ event: 'account_asr.maintenance_failed',
      code: typeof error?.code === 'string' ? error.code : 'maintenance_unavailable' }));
    maintenanceTimer = setInterval(() => {
      runMaintenance().catch((error) => audit({ event: 'account_asr.maintenance_failed',
        code: typeof error?.code === 'string' ? error.code : 'maintenance_unavailable' }));
    }, ASR_MAINTENANCE_INTERVAL_MS);
    maintenanceTimer.unref?.();
  }

  async function close() {
    if (maintenanceTimer) clearInterval(maintenanceTimer);
    maintenanceTimer = null;
    await maintenancePromise?.catch(() => {});
  }

  async function transcribeAudio({ credential = '', requestId = '', audio, signal } = {}) {
    if (!enabled || typeof transcribe !== 'function') throw asrError('asr_unavailable', 503);
    if (signal?.aborted) throw asrError('asr_request_cancelled', 499);
    if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) {
      throw asrError('asr_idempotency_key_invalid', 400, 'A valid Idempotency-Key header is required.');
    }
    const inspected = inspectAccountAsrWav(audio);
    const principal = await authenticateAccount({ credential });
    const periodStart = accountAsrPeriodStart(clock());
    const limits = resolveAccountAsrLimits(principal.plan, env);
    const audioSha256 = createHash('sha256').update(audio).digest('hex');
    const cacheKey = `${principal.accountId}:${requestId}`;
    const now = clock();
    purgeResultCache(now);
    const cached = resultCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      if (cached.audioSha256 !== audioSha256) {
        throw asrError('asr_idempotency_conflict', 409,
          'The idempotency key was already used for different audio.');
      }
      return cached.result;
    }

    const reservation = await repository.reserve({
      accountId: principal.accountId,
      deviceId: principal.deviceId,
      requestId,
      periodStart,
      providerName: ACCOUNT_ASR_PROVIDER,
      modelId: ACCOUNT_ASR_MODEL,
      priceVersion: ACCOUNT_ASR_PRICE_VERSION,
      policyVersion: limits.policyVersion,
      audioSha256,
      audioBytes: audio.length,
      audioDurationMs: inspected.durationMs,
      monthlyLimitMs: limits.monthlyLimitMs,
      maxConcurrent: maxConcurrentPerAccount,
    });
    if (reservation.kind === 'result_expired') {
      throw asrError('asr_idempotency_result_expired', 409,
        'This request has already been processed. Record a new utterance to try again.');
    }
    if (reservation.kind === 'failed') throw asrError(reservation.errorCode || 'asr_request_failed', 502);
    if (reservation.kind === 'unknown') {
      throw asrError('asr_request_outcome_unknown', 409,
        'The provider outcome could not be confirmed. This request will not be submitted twice.');
    }
    if (reservation.kind === 'pending') {
      const existing = inFlight.get(cacheKey);
      if (existing) return existing;
      throw asrError('asr_request_in_progress', 409, 'This transcription request is still in progress.');
    }
    const existingFlight = inFlight.get(cacheKey);
    if (existingFlight) return existingFlight;

    const operation = (async () => {
      const start = clock();
      if (!await repository.markProcessing({ accountId: principal.accountId, requestId })) {
        throw asrError('asr_request_state_conflict', 409);
      }
      try {
        if (signal?.aborted) throw Object.assign(asrError('asr_request_cancelled', 499), { definitelyNotProcessed: true });
        const result = await transcribe(audio, { signal });
        const text = typeof result?.text === 'string' ? result.text.trim() : '';
        if (!text || text.length > 20_000) throw asrError('asr_provider_invalid_response', 502);
        const languageCode = safeLanguageCode(result.languageCode);
        const latencyMs = Math.max(0, clock() - start);
        const costMicroUsd = estimateAccountAsrCostMicroUsd(inspected.durationMs);
        await repository.settle({
          accountId: principal.accountId,
          requestId,
          periodStart,
          billableDurationMs: inspected.durationMs,
          costMicroUsd,
          latencyMs,
          languageCode,
        });
        const response = { contractVersion: 1, requestId, text, languageCode, durationMs: inspected.durationMs };
        resultCache.set(cacheKey, { result: response, audioSha256, expiresAt: clock() + RESULT_CACHE_TTL_MS });
        purgeResultCache(clock());
        audit({ event: 'account_asr.transcribed', accountId: principal.accountId, deviceId: principal.deviceId,
          requestId, durationMs: inspected.durationMs, provider: ACCOUNT_ASR_PROVIDER, model: ACCOUNT_ASR_MODEL,
          priceVersion: ACCOUNT_ASR_PRICE_VERSION, policyVersion: limits.policyVersion,
          latencyMs, providerCostMicroUsd: costMicroUsd });
        return response;
      } catch (error) {
        const normalized = normalizeError(error);
        try {
          if (normalized.definitelyNotProcessed === true) {
            await repository.fail({ accountId: principal.accountId, requestId, periodStart,
              errorCode: normalized.code });
          } else {
            await repository.markUnknown({ accountId: principal.accountId, requestId,
              errorCode: normalized.code || 'asr_provider_outcome_unknown' });
          }
        } catch {
          // Keep the reservation if settlement itself fails; a retry must not
          // issue a second provider request based on incomplete ledger state.
        }
        audit({ event: 'account_asr.failed', accountId: principal.accountId, deviceId: principal.deviceId,
          requestId, code: normalized.code || 'asr_unavailable' });
        throw normalized;
      }
    })();
    inFlight.set(cacheKey, operation);
    try { return await operation; } finally { inFlight.delete(cacheKey); }
  }

  return Object.freeze({ enabled: Boolean(enabled && typeof transcribe === 'function'), getUsage, transcribeAudio,
    startMaintenance, runMaintenance, close,
    checkReady: typeof repository.checkReady === 'function' ? () => repository.checkReady() : async () => true });
}
