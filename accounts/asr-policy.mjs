export const ACCOUNT_ASR_POLICY_VERSION = 'account-asr-monthly-v1';
export const ACCOUNT_ASR_CONSENT_POLICY_VERSION = 'account-asr-third-party-processing-v1';
export const ACCOUNT_ASR_PROVIDER = 'elevenlabs';
export const ACCOUNT_ASR_MODEL = 'scribe_v2';
export const ACCOUNT_ASR_PRICE_VERSION = 'elevenlabs-scribe-v2-2026-11';
export const ACCOUNT_ASR_PRICE_MICROUSD_PER_HOUR = 220_000;

const DEFAULT_MINUTES = Object.freeze({ free: 15, plus: 120, pro: 600 });

function positiveMinutes(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 100_000 ? parsed : fallback;
}

export function resolveAccountAsrLimits(plan, env = process.env) {
  const normalized = String(plan || '').trim().toLowerCase();
  const key = normalized === 'plus' || normalized === 'pro' ? normalized : 'free';
  const minutes = positiveMinutes(env[`AGENTOC_ACCOUNTS_ASR_${key.toUpperCase()}_MINUTES`], DEFAULT_MINUTES[key]);
  return {
    plan: key,
    policyVersion: ACCOUNT_ASR_POLICY_VERSION,
    monthlyLimitMs: minutes * 60_000,
    monthlyLimitMinutes: minutes,
  };
}

export function estimateAccountAsrCostMicroUsd(durationMs) {
  if (!Number.isSafeInteger(durationMs) || durationMs < 0) throw new TypeError('A non-negative audio duration is required');
  return Math.ceil(durationMs * ACCOUNT_ASR_PRICE_MICROUSD_PER_HOUR / 3_600_000);
}

export function accountAsrPeriodStart(now = Date.now()) {
  const at = new Date(now);
  if (!Number.isFinite(at.getTime())) throw new TypeError('A valid clock value is required');
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

export function normalizeAccountAsrPeriod(value, now = Date.now()) {
  if (value == null || value === '') return accountAsrPeriodStart(now).slice(0, 7);
  if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    throw Object.assign(new Error('The usage period must be YYYY-MM.'), { code: 'asr_usage_period_invalid', statusCode: 400 });
  }
  return value;
}
