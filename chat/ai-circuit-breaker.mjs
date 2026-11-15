/**
 * Background AI circuit breaker + retry policy (DS-04).
 *
 * Sits on top of the DS-03 operation ledger error codes and decides whether a
 * provider/capability pair (e.g. `claude:task_card_suggestion`) may keep being
 * called:
 *
 *   - auth (401/403/unauthorized/forbidden): consecutive failures trip the
 *     breaker OPEN for a long cooldown (default 15 min). Enqueues during the
 *     cooldown are skipped with reason `breaker_open` and `retryAfterMs`.
 *   - unsupported (405/404/not implemented/unknown model): the capability is
 *     marked permanently `unsupported` — never retried, never re-enqueued.
 *   - input (null byte / INVAL / prompt too large / invalid JSON): consecutive
 *     failures mark the capability `code_error` (a bug in our own code —
 *     retrying cannot help). Enqueues are skipped with reason `code_error`.
 *   - timeout: no gating here; the backoff retrier (createBackoffRetrier)
 *     re-runs with limited exponential backoff inside the same queue entry.
 *   - transport / provider_exit / rate_limit / unknown: transient, no gate.
 *
 * Observation points feed the breaker the same terminal outcomes that are
 * recorded in the operation ledger (call-stage and queue-stage events are two
 * views of one failure; a short dedupe window prevents double counting).
 *
 * All state is in-memory: a process restart resets breakers, which is
 * acceptable because the cooldown's purpose is protecting the current host.
 * The module exposes a projection for the session UI / diagnostics.
 */

import { classifyProviderError, recordOperationEvent } from './operation-ledger.mjs';

const AUTH_COOLDOWN_ENV = 'RAGENT_BACKGROUND_AI_AUTH_COOLDOWN_MS';
const AUTH_TRIP_COUNT_ENV = 'RAGENT_BACKGROUND_AI_AUTH_TRIP_COUNT';
const INPUT_TRIP_COUNT_ENV = 'RAGENT_BACKGROUND_AI_INPUT_TRIP_COUNT';
const TIMEOUT_MAX_ATTEMPTS_ENV = 'RAGENT_BACKGROUND_AI_TIMEOUT_MAX_ATTEMPTS';
const TIMEOUT_BACKOFF_BASE_ENV = 'RAGENT_BACKGROUND_AI_TIMEOUT_BACKOFF_MS';
const TIMEOUT_BACKOFF_CAP_ENV = 'RAGENT_BACKGROUND_AI_TIMEOUT_BACKOFF_CAP_MS';
const OBSERVE_DEDUPE_ENV = 'RAGENT_BACKGROUND_AI_OBSERVE_DEDUPE_MS';

const DEFAULT_AUTH_COOLDOWN_MS = 15 * 60_000;
const DEFAULT_AUTH_TRIP_COUNT = 2;
const DEFAULT_INPUT_TRIP_COUNT = 3;
const DEFAULT_TIMEOUT_MAX_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_BACKOFF_MS = 2_000;
const DEFAULT_TIMEOUT_BACKOFF_CAP_MS = 30_000;
const DEFAULT_OBSERVE_DEDUPE_MS = 1_500;

export const BREAKER_STATES = Object.freeze(['closed', 'half_open', 'open', 'unsupported', 'code_error']);

function readPositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readNonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function readAiCircuitBreakerOptions(env = process.env) {
  return {
    authCooldownMs: readPositiveInt(env[AUTH_COOLDOWN_ENV], DEFAULT_AUTH_COOLDOWN_MS),
    authTripCount: readPositiveInt(env[AUTH_TRIP_COUNT_ENV], DEFAULT_AUTH_TRIP_COUNT),
    inputTripCount: readPositiveInt(env[INPUT_TRIP_COUNT_ENV], DEFAULT_INPUT_TRIP_COUNT),
    timeoutMaxAttempts: readPositiveInt(env[TIMEOUT_MAX_ATTEMPTS_ENV], DEFAULT_TIMEOUT_MAX_ATTEMPTS),
    timeoutBackoffBaseMs: readPositiveInt(env[TIMEOUT_BACKOFF_BASE_ENV], DEFAULT_TIMEOUT_BACKOFF_MS),
    timeoutBackoffCapMs: readPositiveInt(env[TIMEOUT_BACKOFF_CAP_ENV], DEFAULT_TIMEOUT_BACKOFF_CAP_MS),
    observeDedupeMs: readNonNegativeInt(env[OBSERVE_DEDUPE_ENV], DEFAULT_OBSERVE_DEDUPE_MS),
  };
}

function breakerKey(provider, operation) {
  return `${provider}:${operation}`;
}

function createGate() {
  return {
    state: 'closed',
    reason: '',
    consecutiveFailures: 0,
    consecutiveAuth: 0,
    consecutiveInput: 0,
    lastErrorCode: '',
    lastErrorMessage: '',
    lastErrorAt: 0,
    lastSuccessAt: 0,
    nextAllowedAt: 0,
    cooldownMs: 0,
    totalFailures: 0,
    totalSuccesses: 0,
  };
}

export function createAiCircuitBreaker(options = {}) {
  const opts = { ...readAiCircuitBreakerOptions(), ...options };
  const gates = new Map();

  function getOrCreateGate(provider, operation) {
    const key = breakerKey(provider, operation);
    let gate = gates.get(key);
    if (!gate) {
      gate = createGate();
      gates.set(key, gate);
    }
    return gate;
  }

  function isSameFailurePropagation(previousCode, previousMessage, previousAt, code, message, now) {
    return previousCode === code
      && previousMessage === message
      && now - previousAt < opts.observeDedupeMs;
  }

  /**
   * Feed one terminal outcome (same fields the ledger records) into the
   * breaker. `ok:true` closes the circuit; a failure with errorCode '' is
   * treated as an unknown failure and does not gate.
   */
  function observeOutcome({ provider, operation, errorCode, errorMessage = '', ok = false }) {
    if (!provider || !operation) return;
    const gate = getOrCreateGate(provider, operation);
    const now = Date.now();
    if (ok) {
      gate.consecutiveFailures = 0;
      gate.consecutiveAuth = 0;
      gate.consecutiveInput = 0;
      gate.lastSuccessAt = now;
      gate.totalSuccesses += 1;
      if (gate.state === 'half_open' || gate.state === 'open' && now >= gate.nextAllowedAt) {
        gate.state = 'closed';
        gate.reason = '';
        gate.nextAllowedAt = 0;
        gate.cooldownMs = 0;
      }
      return;
    }

    // Callers pass already-classified ledger codes (classifyProviderError
    // output); only accept known codes and never re-classify.
    const normalizedCode = typeof errorCode === 'string'
      && ['auth', 'timeout', 'transport', 'input', 'provider_exit', 'unsupported', 'rate_limit'].includes(errorCode)
      ? errorCode
      : '';
    if (!normalizedCode) return;

    const previousCode = gate.lastErrorCode;
    const previousMessage = gate.lastErrorMessage;
    const previousAt = gate.lastErrorAt;
    gate.lastErrorCode = normalizedCode;
    gate.lastErrorMessage = String(errorMessage || '').slice(0, 200);
    gate.lastErrorAt = now;
    if (isSameFailurePropagation(previousCode, previousMessage, previousAt, normalizedCode, gate.lastErrorMessage, now)) {
      // The same failure was already reported through a sibling ledger event
      // (call-stage then queue-stage); do not double-count it.
      return;
    }
    gate.consecutiveFailures += 1;
    gate.totalFailures += 1;

    switch (normalizedCode) {
      case 'auth':
        gate.consecutiveAuth += 1;
        if (gate.consecutiveAuth >= opts.authTripCount) {
          gate.state = 'open';
          gate.reason = 'auth';
          gate.cooldownMs = opts.authCooldownMs;
          gate.nextAllowedAt = now + opts.authCooldownMs;
        }
        break;
      case 'unsupported':
        gate.state = 'unsupported';
        gate.reason = 'unsupported';
        gate.nextAllowedAt = 0;
        gate.cooldownMs = 0;
        break;
      case 'input':
        gate.consecutiveInput += 1;
        if (gate.consecutiveInput >= opts.inputTripCount) {
          gate.state = 'code_error';
          gate.reason = 'input';
          gate.nextAllowedAt = 0;
          gate.cooldownMs = 0;
        }
        break;
      default:
        // timeout / transport / provider_exit / rate_limit: transient, no gate.
        break;
    }
  }

  /**
   * Decide whether a new call for provider:operation may be enqueued.
   * Returns { allow, status?, reason?, retryAfterMs? }.
   */
  function shouldEnqueue(provider, operation) {
    if (!provider || !operation) return { allow: true };
    const gate = gates.get(breakerKey(provider, operation));
    if (!gate || gate.state === 'closed') return { allow: true };
    const now = Date.now();
    if (gate.state === 'open' && gate.nextAllowedAt > 0 && now >= gate.nextAllowedAt) {
      // Cooldown expired: allow exactly one probe (half-open).
      gate.state = 'half_open';
      return { allow: true };
    }
    return {
      allow: false,
      status: gate.state,
      reason: gate.reason,
      retryAfterMs: gate.nextAllowedAt > 0 ? Math.max(0, gate.nextAllowedAt - now) : null,
    };
  }

  function getGate(provider, operation) {
    if (!provider || !operation) return null;
    const gate = gates.get(breakerKey(provider, operation));
    if (!gate) {
      return { state: 'closed', reason: '', nextAllowedAt: 0, retryAfterMs: 0, lastErrorCode: '', lastErrorAt: 0 };
    }
    const now = Date.now();
    return {
      state: gate.state,
      reason: gate.reason,
      nextAllowedAt: gate.nextAllowedAt,
      retryAfterMs: gate.state === 'open' && gate.nextAllowedAt > 0 ? Math.max(0, gate.nextAllowedAt - now) : null,
      cooldownMs: gate.cooldownMs,
      consecutiveFailures: gate.consecutiveFailures,
      lastErrorCode: gate.lastErrorCode,
      lastErrorAt: gate.lastErrorAt,
      lastSuccessAt: gate.lastSuccessAt,
    };
  }

  /** Full projection for diagnostics / UI: one entry per provider:operation. */
  function projection() {
    const now = Date.now();
    return [...gates.entries()].map(([key, gate]) => {
      const [provider, operation] = key.split(':');
      return {
        provider,
        operation,
        state: gate.state,
        reason: gate.reason,
        consecutiveFailures: gate.consecutiveFailures,
        consecutiveAuth: gate.consecutiveAuth,
        consecutiveInput: gate.consecutiveInput,
        totalFailures: gate.totalFailures,
        totalSuccesses: gate.totalSuccesses,
        lastErrorCode: gate.lastErrorCode,
        lastErrorAt: gate.lastErrorAt,
        lastSuccessAt: gate.lastSuccessAt,
        retryAfterMs: gate.state === 'open' && gate.nextAllowedAt > 0 ? Math.max(0, gate.nextAllowedAt - now) : null,
        nextAllowedAt: gate.nextAllowedAt,
      };
    });
  }

  function reset() {
    gates.clear();
  }

  return { observeOutcome, shouldEnqueue, getGate, projection, reset };
}

// Module-level singleton used by the chat server; tests create their own
// instances via createAiCircuitBreaker().
export const aiCircuitBreaker = createAiCircuitBreaker();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Limited exponential backoff retry for timeout failures (DS-04 contract:
 * "timeout 使用有限指数退避"). Non-timeout failures propagate immediately.
 *
 * The wrapper runs `task(attempt)`; on a classified timeout it records a
 * `retry` ledger event (same operationId, attempt + backoffMs) and re-runs
 * after `min(base * 2^(attempt-1), cap)` ms, up to `maxAttempts` total
 * attempts. Other failure codes are never retried.
 *
 * @param {Function} task `(attempt) => Promise<*>`
 * @param {object} options `{ operationId, operation, sessionId, provider,
 *   model, attempt, maxAttempts, baseBackoffMs, maxBackoffMs }` — knobs fall
 *   back to the breaker options (env).
 */
export function createBackoffRetrier(options = {}) {
  const breakerOpts = readAiCircuitBreakerOptions(options.env || process.env);
  const maxAttempts = Number.isInteger(options.maxAttempts) && options.maxAttempts > 0
    ? options.maxAttempts
    : breakerOpts.timeoutMaxAttempts;
  const baseBackoffMs = Number.isInteger(options.baseBackoffMs) && options.baseBackoffMs > 0
    ? options.baseBackoffMs
    : breakerOpts.timeoutBackoffBaseMs;
  const maxBackoffMs = Number.isInteger(options.maxBackoffMs) && options.maxBackoffMs > 0
    ? options.maxBackoffMs
    : breakerOpts.timeoutBackoffCapMs;

  return async function withBackoffRetry(task, callOptions = {}) {
    const {
      operationId,
      operation = 'background_prompt',
      sessionId = '',
      provider = '',
      model = '',
      attempt = 1,
    } = callOptions;
    let currentAttempt = attempt;
    for (;;) {
      try {
        return await task(currentAttempt);
      } catch (error) {
        const errorCode = classifyProviderError(error, { context: 'call' });
        if (errorCode !== 'timeout' || currentAttempt >= maxAttempts) {
          throw error;
        }
        const backoffMs = Math.min(baseBackoffMs * 2 ** (currentAttempt - 1), maxBackoffMs);
        if (operationId) {
          recordOperationEvent({
            kind: 'retry',
            operationId,
            operation,
            sessionId,
            provider,
            model,
            attempt: currentAttempt + 1,
            ts: new Date().toISOString(),
            stage: 'call',
            reason: 'timeout_backoff',
            errorCode: 'timeout',
            errorMessage: String(error?.message || '').slice(0, 200),
            ...(Number.isFinite(backoffMs) ? { durationMs: backoffMs } : {}),
          });
        }
        await sleep(backoffMs);
        currentAttempt += 1;
      }
    }
  };
}
