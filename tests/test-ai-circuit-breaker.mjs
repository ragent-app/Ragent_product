#!/usr/bin/env node
// DS-04 circuit breaker + backoff retrier tests: auth cooldown trip, half-open
// probe, permanent unsupported, input code_error, failure dedupe window,
// success reset, and limited exponential backoff with ledger 'retry' events.
import assert from 'assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tempHome = mkdtempSync(join(tmpdir(), 'ragent-ai-circuit-breaker-'));
const ledgerDir = join(tempHome, 'operations');

process.env.HOME = tempHome;
process.env.RAGENT_CONFIG_DIR = tempHome;
process.env.RAGENT_OPERATION_LEDGER_DIR = ledgerDir;
mkdirSync(ledgerDir, { recursive: true });

const { createAiCircuitBreaker, createBackoffRetrier } = await import(
  pathToFileURL(join(repoRoot, 'chat', 'ai-circuit-breaker.mjs')).href
);
const operationLedger = await import(
  pathToFileURL(join(repoRoot, 'chat', 'operation-ledger.mjs')).href
);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readLedgerEvents() {
  // Writes are buffered by the open stream; close it first so the reads see
  // everything (same pattern as test-operation-ledger.mjs).
  await operationLedger.closeOperationLedger();
  const files = readdirSync(ledgerDir).filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name));
  const events = [];
  for (const name of files.sort()) {
    for (const line of readFileSync(join(ledgerDir, name), 'utf8').trim().split('\n')) {
      if (!line.trim()) continue;
      events.push(JSON.parse(line));
    }
  }
  return events;
}

let scenario = 0;
function checkpoint() {
  scenario += 1;
  return scenario;
}

try {
  await operationLedger.initOperationLedger();

  // 1. Two consecutive auth failures trip the breaker OPEN; enqueue is denied
  // with retryAfterMs inside the cooldown. Other capabilities on the same
  // provider stay closed.
  {
    const breaker = createAiCircuitBreaker({ authCooldownMs: 60_000, authTripCount: 2, observeDedupeMs: 0 });
    breaker.observeOutcome({
      provider: 'claude', operation: 'task_card_suggestion', errorCode: 'auth', errorMessage: '401 invalid api key', ok: false,
    });
    assert.equal(breaker.getGate('claude', 'task_card_suggestion').state, 'closed', 'single auth failure must not trip');
    breaker.observeOutcome({
      provider: 'claude', operation: 'task_card_suggestion', errorCode: 'auth', errorMessage: '401 invalid api key', ok: false,
    });
    const gate = breaker.getGate('claude', 'task_card_suggestion');
    assert.equal(gate.state, 'open');
    assert.equal(gate.reason, 'auth');
    assert.ok(gate.retryAfterMs > 0 && gate.retryAfterMs <= 60_000, 'retryAfterMs within cooldown');
    const decision = breaker.shouldEnqueue('claude', 'task_card_suggestion');
    assert.equal(decision.allow, false);
    assert.equal(decision.status, 'open');
    assert.equal(decision.reason, 'auth');
    assert.ok(decision.retryAfterMs > 0 && decision.retryAfterMs <= 60_000, 'decision carries retryAfterMs');
    // Sibling capability on the same provider is unaffected.
    assert.equal(breaker.shouldEnqueue('claude', 'workflow_state_suggestion').allow, true);
    assert.equal(breaker.shouldEnqueue('other-provider', 'task_card_suggestion').allow, true);
    checkpoint();
  }

  // 2. Cooldown expiry allows exactly one probe (half-open); success closes
  // the circuit, another failure re-opens it.
  {
    const breaker = createAiCircuitBreaker({ authCooldownMs: 60, authTripCount: 2, observeDedupeMs: 0 });
    breaker.observeOutcome({ provider: 'claude', operation: 'memory_writeback_review', errorCode: 'auth', errorMessage: '403 forbidden', ok: false });
    breaker.observeOutcome({ provider: 'claude', operation: 'memory_writeback_review', errorCode: 'auth', errorMessage: '403 forbidden', ok: false });
    assert.equal(breaker.getGate('claude', 'memory_writeback_review').state, 'open');
    await sleep(80);
    const probe = breaker.shouldEnqueue('claude', 'memory_writeback_review');
    assert.equal(probe.allow, true, 'expired cooldown must allow a probe');
    assert.equal(breaker.getGate('claude', 'memory_writeback_review').state, 'half_open');
    breaker.observeOutcome({ provider: 'claude', operation: 'memory_writeback_review', ok: true });
    const afterSuccess = breaker.getGate('claude', 'memory_writeback_review');
    assert.equal(afterSuccess.state, 'closed', 'probe success closes the circuit');
    assert.equal(afterSuccess.consecutiveFailures, 0);
    checkpoint();
  }

  // 3. Cooldown expiry + failed probe re-opens with a fresh cooldown.
  {
    const breaker = createAiCircuitBreaker({ authCooldownMs: 60, authTripCount: 2, observeDedupeMs: 0 });
    breaker.observeOutcome({ provider: 'claude', operation: 'workflow_state_suggestion', errorCode: 'auth', errorMessage: '401 x', ok: false });
    breaker.observeOutcome({ provider: 'claude', operation: 'workflow_state_suggestion', errorCode: 'auth', errorMessage: '401 x', ok: false });
    await sleep(80);
    assert.equal(breaker.shouldEnqueue('claude', 'workflow_state_suggestion').allow, true);
    breaker.observeOutcome({ provider: 'claude', operation: 'workflow_state_suggestion', errorCode: 'auth', errorMessage: '401 x', ok: false });
    const reopened = breaker.getGate('claude', 'workflow_state_suggestion');
    assert.equal(reopened.state, 'open', 'failed probe must re-open the circuit');
    assert.ok(reopened.retryAfterMs > 0, 're-opened circuit has a fresh cooldown');
    checkpoint();
  }

  // 4. unsupported is permanent: never retried, success cannot close it.
  {
    const breaker = createAiCircuitBreaker({ observeDedupeMs: 0 });
    breaker.observeOutcome({ provider: 'claude', operation: 'task_card_suggestion', errorCode: 'unsupported', errorMessage: '405 Method Not Allowed', ok: false });
    const gate = breaker.getGate('claude', 'task_card_suggestion');
    assert.equal(gate.state, 'unsupported');
    const decision = breaker.shouldEnqueue('claude', 'task_card_suggestion');
    assert.equal(decision.allow, false);
    assert.equal(decision.status, 'unsupported');
    assert.equal(decision.retryAfterMs, null, 'unsupported has no retry window');
    breaker.observeOutcome({ provider: 'claude', operation: 'task_card_suggestion', ok: true });
    assert.equal(breaker.getGate('claude', 'task_card_suggestion').state, 'unsupported', 'success must not re-enable unsupported');
    checkpoint();
  }

  // 5. input failures xN trip code_error; fewer than the trip count does not.
  {
    const breaker = createAiCircuitBreaker({ inputTripCount: 3, observeDedupeMs: 0 });
    breaker.observeOutcome({ provider: 'claude', operation: 'session_label_suggestion', errorCode: 'input', errorMessage: 'null byte in input', ok: false });
    breaker.observeOutcome({ provider: 'claude', operation: 'session_label_suggestion', errorCode: 'input', errorMessage: 'null byte in input', ok: false });
    assert.equal(breaker.getGate('claude', 'session_label_suggestion').state, 'closed', '2 inputs must not trip a 3-trip breaker');
    breaker.observeOutcome({ provider: 'claude', operation: 'session_label_suggestion', errorCode: 'input', errorMessage: 'null byte in input', ok: false });
    const gate = breaker.getGate('claude', 'session_label_suggestion');
    assert.equal(gate.state, 'code_error');
    const decision = breaker.shouldEnqueue('claude', 'session_label_suggestion');
    assert.equal(decision.allow, false);
    assert.equal(decision.status, 'code_error');
    assert.equal(decision.retryAfterMs, null);
    checkpoint();
  }

  // 6. Dedupe window: two views of the same failure (call-stage + queue-stage)
  // count once; a genuinely new failure after the window counts again.
  {
    const breaker = createAiCircuitBreaker({ authCooldownMs: 60_000, authTripCount: 2, observeDedupeMs: 100 });
    const observe = () => breaker.observeOutcome({
      provider: 'claude', operation: 'task_card_suggestion', errorCode: 'auth', errorMessage: '401 same message', ok: false,
    });
    observe();
    observe();
    assert.equal(breaker.getGate('claude', 'task_card_suggestion').state, 'closed', 'same failure within dedupe window counts once');
    await sleep(120);
    observe();
    assert.equal(breaker.getGate('claude', 'task_card_suggestion').state, 'open', 'failure after the window counts again');
    checkpoint();
  }

  // 7. timeout / transport / provider_exit / rate_limit / unknown never gate;
  // a success resets consecutive auth failures.
  {
    const breaker = createAiCircuitBreaker({ authCooldownMs: 60_000, authTripCount: 2, observeDedupeMs: 0 });
    for (const code of ['timeout', 'transport', 'provider_exit', 'rate_limit']) {
      breaker.observeOutcome({ provider: 'claude', operation: 'task_card_suggestion', errorCode: code, errorMessage: `boom ${code}`, ok: false });
    }
    breaker.observeOutcome({ provider: 'claude', operation: 'task_card_suggestion', errorCode: 'unknown', errorMessage: 'weird', ok: false });
    assert.equal(breaker.getGate('claude', 'task_card_suggestion').state, 'closed', 'transient codes must not gate');
    assert.equal(breaker.shouldEnqueue('claude', 'task_card_suggestion').allow, true);
    // auth x1, success, auth x1 -> still closed (success resets the counter).
    breaker.observeOutcome({ provider: 'claude', operation: 'task_card_suggestion', errorCode: 'auth', errorMessage: '401 a', ok: false });
    breaker.observeOutcome({ provider: 'claude', operation: 'task_card_suggestion', ok: true });
    breaker.observeOutcome({ provider: 'claude', operation: 'task_card_suggestion', errorCode: 'auth', errorMessage: '401 b', ok: false });
    assert.equal(breaker.getGate('claude', 'task_card_suggestion').state, 'closed', 'success must reset the auth counter');
    // Unknown / empty errorCode observations are ignored entirely.
    breaker.observeOutcome({ provider: 'claude', operation: 'task_card_suggestion', errorCode: 'bogus_code', errorMessage: 'x', ok: false });
    assert.equal(breaker.getGate('claude', 'task_card_suggestion').consecutiveFailures, 1);
    checkpoint();
  }

  // 8. Env knobs: readAiCircuitBreakerOptions parses env and falls back to
  // sensible defaults.
  {
    const { readAiCircuitBreakerOptions } = await import(
      pathToFileURL(join(repoRoot, 'chat', 'ai-circuit-breaker.mjs')).href
    );
    const defaults = readAiCircuitBreakerOptions({});
    assert.equal(defaults.authCooldownMs, 15 * 60_000);
    assert.equal(defaults.authTripCount, 2);
    assert.equal(defaults.inputTripCount, 3);
    assert.equal(defaults.timeoutMaxAttempts, 3);
    assert.equal(defaults.timeoutBackoffBaseMs, 2_000);
    assert.equal(defaults.timeoutBackoffCapMs, 30_000);
    const custom = readAiCircuitBreakerOptions({
      RAGENT_BACKGROUND_AI_AUTH_COOLDOWN_MS: '1000',
      RAGENT_BACKGROUND_AI_TIMEOUT_MAX_ATTEMPTS: '5',
      RAGENT_BACKGROUND_AI_OBSERVE_DEDUPE_MS: '0',
      RAGENT_BACKGROUND_AI_AUTH_TRIP_COUNT: 'garbage',
    });
    assert.equal(custom.authCooldownMs, 1000);
    assert.equal(custom.timeoutMaxAttempts, 5);
    assert.equal(custom.observeDedupeMs, 0);
    assert.equal(custom.authTripCount, 2, 'invalid env falls back to default');
    checkpoint();
  }

  // 9. Backoff retrier: timeout failures retry with limited exponential
  // backoff up to maxAttempts, each retry recorded as a ledger 'retry' event.
  {
    const attempts = [];
    const retrier = createBackoffRetrier({ maxAttempts: 3, baseBackoffMs: 5, maxBackoffMs: 10 });
    const result = await retrier(async (attempt) => {
      attempts.push(attempt);
      if (attempt < 3) throw new Error('ETIMEDOUT');
      return 'done';
    }, {
      operationId: 'op_retry_test',
      operation: 'task_card_suggestion',
      sessionId: 'sess_retry',
      provider: 'claude',
      model: 'fake-model',
    });
    assert.equal(result, 'done');
    assert.deepEqual(attempts, [1, 2, 3], 'timeout must retry up to maxAttempts');
    const events = await readLedgerEvents();
    const retryEvents = events.filter((e) => e.kind === 'retry' && e.operationId === 'op_retry_test');
    assert.equal(retryEvents.length, 2, 'two retries recorded');
    assert.deepEqual(retryEvents.map((e) => e.attempt), [2, 3], 'retry events carry the next attempt number');
    for (const event of retryEvents) {
      assert.equal(event.reason, 'timeout_backoff');
      assert.equal(event.errorCode, 'timeout');
      assert.equal(event.stage, 'call');
      assert.equal(event.operation, 'task_card_suggestion');
      assert.ok(Number.isInteger(event.durationMs) && event.durationMs > 0, 'retry event carries backoff duration');
    }
    assert.equal(retryEvents[0].durationMs, 5, 'first backoff = base');
    assert.equal(retryEvents[1].durationMs, 10, 'second backoff = base*2 capped');
    checkpoint();
  }

  // 10. Backoff retrier: maxAttempts reached -> rejects; non-timeout failures
  // are never retried.
  {
    let calls = 0;
    const exhausted = createBackoffRetrier({ maxAttempts: 2, baseBackoffMs: 1 });
    await assert.rejects(
      exhausted(async () => {
        calls += 1;
        throw new Error('ETIMEDOUT');
      }, { operationId: 'op_retry_exhausted' }),
      /ETIMEDOUT/,
    );
    assert.equal(calls, 2, 'timeout stops after maxAttempts');

    let nonTimeoutCalls = 0;
    const nonTimeout = createBackoffRetrier({ maxAttempts: 3, baseBackoffMs: 1 });
    await assert.rejects(
      nonTimeout(async () => {
        nonTimeoutCalls += 1;
        throw new Error('405 Method Not Allowed');
      }, { operationId: 'op_retry_non_timeout' }),
      /405/,
    );
    assert.equal(nonTimeoutCalls, 1, 'non-timeout failure must not be retried');
    const events = await readLedgerEvents();
    assert.equal(events.filter((e) => e.kind === 'retry' && e.operationId === 'op_retry_non_timeout').length, 0);
    assert.equal(events.filter((e) => e.kind === 'retry' && e.operationId === 'op_retry_exhausted').length, 1, 'one retry then give up');
    checkpoint();
  }

  console.log(`test-ai-circuit-breaker: ok (${scenario} scenarios)`);
} finally {
  await operationLedger.closeOperationLedger();
  rmSync(tempHome, { recursive: true, force: true });
}
