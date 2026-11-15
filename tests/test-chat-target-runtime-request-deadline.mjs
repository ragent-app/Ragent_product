#!/usr/bin/env node
// The target-runtime delegation inside fetchJsonOrRedirect forwards every
// /api/* request to routeRequest (local fetch or a remote runtime adapter)
// BEFORE the direct path's request deadline is applied. Neither leg times out
// on its own, so a half-open tunnel socket leaves the single-flight refresh
// registry entry in flight forever and every later refresh for that session
// coalesces onto the wedged request — the "blank session until reload"
// report. The delegation must inherit the same user-visible request deadline
// as the direct path and must discard responses that land after it.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const repoRoot = new URL('../', import.meta.url);
const helperSource = await readFile(new URL('static/chat/session-http-helpers.js', repoRoot), 'utf8');

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.evaluate((source) => {
    window.ragentResolveProductPath = (url) => new URL(url, 'http://127.0.0.1/').toString();
    window.jsonResponseCache = new Map();
    // The helper floors the deadline at 5s; keep each timeout case short.
    window.RAGENT_HTTP_REQUEST_TIMEOUT_MS = '1200';
    window.__delegatedCalls = [];
    const responseLike = (data) => ({
      status: 200,
      ok: true,
      redirected: false,
      url: 'http://127.0.0.1/api/test',
      headers: { get: (name) => String(name).toLowerCase() === 'content-type' ? 'application/json' : '' },
      json: async () => data,
    });
    window.RagentTargetRuntime = {
      isRuntimePath: (url) => String(url).startsWith('/api/'),
      routeRequest: ({ url, options }) => {
        const call = { url, signal: options?.signal || null, signalAbortedAfterAbort: null };
        options?.signal?.addEventListener('abort', () => {
          call.signalAbortedAfterAbort = options.signal.aborted === true;
        }, { once: true });
        window.__delegatedCalls.push(call);
        return window.__nextDelegatedResult(options);
      },
    };
    window.__nextDelegatedResult = () => responseLike({ ok: true, transport: 'delegated' });
    (0, eval)(source);
  }, helperSource);

  // 1. Healthy delegated response passes through unchanged.
  const healthy = await page.evaluate(() => fetchJsonOrRedirect('/api/sessions/abc/current', {}));
  assert.equal(healthy.transport, 'delegated');

  // 2. A delegated request that never settles must reject with the request
  //    deadline error instead of hanging its registry key forever.
  await page.evaluate(() => {
    window.__nextDelegatedResult = () => new Promise(() => {});
  });
  const hangStartedAt = Date.now();
  const hangOutcome = await page.evaluate(() => fetchJsonOrRedirect('/api/sessions/abc/current', {})
    .then(() => null, (error) => ({ name: error.name, code: error.code })));
  const hangElapsedMs = Date.now() - hangStartedAt;
  assert.equal(hangOutcome?.code, 'REQUEST_TIMEOUT', 'a never-settling delegated request must hit the deadline');
  assert.ok(hangElapsedMs >= 4_500 && hangElapsedMs < 7_000, `deadline should fire near the 5s floor (took ${hangElapsedMs}ms)`);

  // 3. A response that lands after the deadline is discarded, not applied —
  //    the caller rejects at the deadline, not when the late value arrives.
  await page.evaluate(() => {
    window.__nextDelegatedResult = () => new Promise((resolve) => {
      setTimeout(() => resolve({ status: 200, ok: true, headers: { get: () => 'application/json' }, json: async () => ({ ok: true, transport: 'late' }) }), 8_000);
    });
  });
  const lateStartedAt = Date.now();
  const lateOutcome = await page.evaluate(() => fetchJsonOrRedirect('/api/sessions/abc/current', {})
    .then(() => null, (error) => ({ name: error.name, code: error.code })));
  const lateElapsedMs = Date.now() - lateStartedAt;
  assert.equal(lateOutcome?.code, 'REQUEST_TIMEOUT', 'a late delegated response must be discarded');
  assert.ok(lateElapsedMs < 7_000, `late response must not hold the caller past the deadline (took ${lateElapsedMs}ms)`);

  // 4. Caller cancellation still propagates into the delegated options and
  //    surfaces as AbortError (scheduler contract: abort → resolve null).
  await page.evaluate(() => {
    window.__nextDelegatedResult = ({ signal }) => new Promise(() => {});
    window.__delegatedCalls.length = 0;
  });
  const abortOutcome = await page.evaluate(async () => {
    const controller = new AbortController();
    const pending = fetchJsonOrRedirect('/api/sessions/abc/current', { signal: controller.signal })
      .then(() => null, (error) => ({ name: error.name, code: error.code }));
    setTimeout(() => controller.abort(), 50);
    return pending;
  });
  assert.equal(abortOutcome?.name, 'AbortError', 'caller abort must surface as AbortError');
  const sawAborted = await page.evaluate(() => window.__delegatedCalls.at(-1)?.signalAbortedAfterAbort === true);
  assert.equal(sawAborted, true, 'the deadline signal must be threaded into routeRequest options');

  await browser.close();
  console.log('test-chat-target-runtime-request-deadline: ok');
} catch (error) {
  console.error(error);
  process.exit(1);
} finally {
  await browser?.close().catch(() => {});
}
