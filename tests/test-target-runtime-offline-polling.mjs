#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

import {
  __resetTargetRuntimeSummaryStateForTest,
  handleTargetRuntimeGatewayRoutes,
} from '../chat/router-target-runtime-routes.mjs';

function makeResponse(body, { status = 200, headers = {} } = {}) {
  const normalizedHeaders = new Map(
    Object.entries(headers).map(([key, value]) => [String(key).toLowerCase(), String(value)]),
  );
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get(name) {
        return normalizedHeaders.get(String(name).toLowerCase()) ?? null;
      },
    },
    async arrayBuffer() {
      return Buffer.from(text, 'utf8');
    },
  };
}

async function runGatewayRequest(urlPath, {
  method = 'GET',
  body = null,
  fetchImpl,
  authorizeImpl,
  catalog,
  identity,
  clock,
  summaryState,
}) {
  let statusCode = 0;
  let headers = {};
  let rawBody = '';
  const chunks = [];
  const req = {
    method,
    url: urlPath,
    headers: { 'content-type': 'application/json' },
    on(event, handler) {
      if (event === 'data' && body !== null) handler(Buffer.from(JSON.stringify(body), 'utf8'));
      if (event === 'end') handler();
      return req;
    },
  };
  const res = {
    writeHead(status, hdrs = {}) {
      statusCode = status;
      headers = hdrs;
    },
    end(chunk = '') {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'));
      rawBody = Buffer.concat(chunks).toString('utf8');
    },
  };
  const parsed = new URL(urlPath, 'https://gateway.invalid');
  await handleTargetRuntimeGatewayRoutes({
    req,
    res,
    pathname: parsed.pathname,
    parsedUrl: { query: Object.fromEntries(parsed.searchParams.entries()) },
    authSession: { role: 'owner' },
    writeJson(response, status, payload) {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(payload));
    },
    fetchImpl,
    authorizeImpl,
    identity,
    catalog,
    clock,
    summaryState,
  });
  return {
    status: statusCode,
    headers,
    body: rawBody ? JSON.parse(rawBody) : null,
  };
}

// 1. Server-side gateway: HTTP 200 degraded offline with cached summary/cursor,
//    exponential cooldown (30s -> 60s -> 120s -> max 300s), reset on reachability,
//    404 on unknown targetId, and 503 on /api/target-runtime/request.
{
  __resetTargetRuntimeSummaryStateForTest();
  let now = 1_000_000;
  const clock = () => now;
  const summaryState = new Map();
  const identity = { instanceId: 'inst_local' };
  const catalog = {
    schemaVersion: 1,
    revision: 1,
    activeTargetId: 'inst_local',
    targets: [
      { targetId: 'inst_local', instanceId: 'inst_local', label: 'Local', status: 'online', snapshotVersion: 1 },
      { targetId: 'inst_remote', instanceId: 'inst_remote', label: 'Remote', status: 'paired', snapshotVersion: 5 },
      { targetId: 'inst_endpointless', instanceId: 'inst_endpointless', label: 'No Endpoint', status: 'offline', hasEndpoint: false, snapshotVersion: 0 },
    ],
  };

  let online = true;
  let fetchCalls = 0;
  let authorizeCalls = 0;
  const authorizeImpl = async ({ targetInstanceId }) => {
    authorizeCalls += 1;
    return {
      grant: 'header.payload.sig',
      claims: { sourceInstanceId: 'inst_local' },
      target: {
        targetInstanceId,
        endpoint: targetInstanceId === 'inst_endpointless' ? '' : 'https://remote.example.test',
      },
    };
  };
  const fetchImpl = async (url) => {
    fetchCalls += 1;
    if (!online) {
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    }
    const parsed = new URL(url);
    if (parsed.pathname === '/api/runtime/summary') {
      return makeResponse({
        schemaVersion: 1,
        targetId: 'inst_remote',
        instanceId: 'inst_remote',
        revision: 9,
        eventCursor: '42',
        generatedAt: '2026-11-24T00:00:00.000Z',
        sessions: { total: 4, active: 1 },
        runs: { active: 1 },
        approvals: { pending: 0 },
      }, {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-ragent-target-revision': '9' },
      });
    }
    if (parsed.pathname === '/api/runtime/summary/events') {
      return makeResponse({
        schemaVersion: 1,
        revision: 9,
        cursor: '43',
        nextCursor: null,
        hasMore: false,
        events: [],
      }, {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-ragent-target-revision': '9' },
      });
    }
    return makeResponse({ ok: true }, { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const common = { fetchImpl, authorizeImpl, catalog, identity, clock, summaryState };

  // Unknown target stays 404 on both /summary and /summary/events.
  const unknownSummary = await runGatewayRequest('/api/target-runtime/summary?targetId=missing', common);
  assert.equal(unknownSummary.status, 404);
  assert.equal(unknownSummary.body.code, 'TARGET_NOT_FOUND');
  const unknownEvents = await runGatewayRequest('/api/target-runtime/summary/events?targetId=missing', common);
  assert.equal(unknownEvents.status, 404);
  assert.equal(unknownEvents.body.code, 'TARGET_NOT_FOUND');

  // Online target populates cached summary + cursor.
  const initialSummary = await runGatewayRequest('/api/target-runtime/summary?targetId=inst_remote', common);
  assert.equal(initialSummary.status, 200);
  assert.equal(initialSummary.body.sessions.total, 4);
  const initialEvents = await runGatewayRequest('/api/target-runtime/summary/events?targetId=inst_remote&afterCursor=0', common);
  assert.equal(initialEvents.status, 200);
  assert.equal(initialEvents.body.cursor, '43');

  // Take target offline -> /summary and /summary/events return 200 with cached summary/cursor + exponential cooldown.
  online = false;
  const expectedCooldowns = [30_000, 60_000, 120_000, 300_000, 300_000];
  for (let index = 0; index < expectedCooldowns.length; index += 1) {
    const expectedMs = expectedCooldowns[index];
    const beforeCalls = fetchCalls;
    const offlineSummary = await runGatewayRequest('/api/target-runtime/summary?targetId=inst_remote', common);
    assert.equal(offlineSummary.status, 200);
    assert.equal(offlineSummary.body.reachable, false);
    assert.equal(offlineSummary.body.state, 'offline');
    assert.equal(offlineSummary.body.degraded, true);
    assert.equal(offlineSummary.body.code, 'TARGET_RUNTIME_UNAVAILABLE');
    assert.equal(offlineSummary.body.retryAfterMs, expectedMs);
    assert.equal(offlineSummary.body.sessions.total, 4, 'cached summary should be preserved while offline');
    assert.equal(fetchCalls, beforeCalls + 1, 'should probe once when cooldown has elapsed');

    // Immediate poll during cooldown skips remote fetch and returns cached cursor + COOLDOWN code.
    now += 1_000;
    const cooldownEvents = await runGatewayRequest('/api/target-runtime/summary/events?targetId=inst_remote&afterCursor=10', common);
    assert.equal(cooldownEvents.status, 200);
    assert.equal(cooldownEvents.body.reachable, false);
    assert.equal(cooldownEvents.body.state, 'offline');
    assert.equal(cooldownEvents.body.degraded, true);
    assert.equal(cooldownEvents.body.code, 'TARGET_RUNTIME_SUMMARY_COOLDOWN');
    assert.equal(cooldownEvents.body.retryAfterMs, expectedMs - 1_000);
    assert.equal(cooldownEvents.body.cursor, '43', 'cached cursor should be preserved while offline');
    assert.deepEqual(cooldownEvents.body.events, []);
    assert.equal(fetchCalls, beforeCalls + 1, 'cooldown must suppress remote fetch');

    now += expectedMs - 1_000 + 1;
  }

  // Action execution on /api/target-runtime/request STILL returns 503 while target is offline!
  const actionFailure = await runGatewayRequest('/api/target-runtime/request', {
    ...common,
    method: 'POST',
    body: {
      targetId: 'inst_remote',
      method: 'GET',
      path: '/api/sessions',
      operation: 'session.read',
      resourceId: 'sessions',
      expectedRevision: 5,
      requestId: 'req-offline-1',
      idempotencyKey: 'idem-offline-1',
    },
  });
  assert.equal(actionFailure.status, 503);
  assert.equal(actionFailure.body.code, 'TARGET_RUNTIME_UNAVAILABLE');

  // Target recovers -> cooldown resets so a subsequent failure starts at 30_000ms again.
  online = true;
  const recovered = await runGatewayRequest('/api/target-runtime/summary?targetId=inst_remote', common);
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.reachable, undefined);
  assert.equal(recovered.body.sessions.total, 4);

  online = false;
  const failAfterReset = await runGatewayRequest('/api/target-runtime/summary?targetId=inst_remote', common);
  assert.equal(failAfterReset.status, 200);
  assert.equal(failAfterReset.body.reachable, false);
  assert.equal(failAfterReset.body.retryAfterMs, 30_000, 'server cooldown must reset after successful reachability');

  // Endpoint-less target returns 200 degraded offline without calling authorizeImpl.
  const authBeforeEndpointless = authorizeCalls;
  const endpointlessRes = await runGatewayRequest('/api/target-runtime/summary?targetId=inst_endpointless', common);
  assert.equal(endpointlessRes.status, 200);
  assert.equal(endpointlessRes.body.reachable, false);
  assert.equal(endpointlessRes.body.state, 'offline');
  assert.equal(endpointlessRes.body.degraded, true);
  assert.equal(endpointlessRes.body.endpointless, true);
  assert.equal(authorizeCalls, authBeforeEndpointless, 'endpoint-less target should not authorize against Accounts');
}

// 2. Client-side target-runtime-client.js: honors reachable:false / retryAfterMs,
//    exponential backoff (15s -> 30s -> 60s -> 120s -> 300s), resets on
//    ragent:target-selected / catalog revision change (respecting cooldown),
//    and skips endpoint-less targets until catalog revision changes.
{
  const storeSource = await readFile(new URL('../static/chat/target-store.js', import.meta.url), 'utf8');
  const runtimeSource = await readFile(new URL('../static/chat/target-runtime-client.js', import.meta.url), 'utf8');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><html><body></body></html>');
    await page.evaluate(() => {
      let fakeNow = 10_000_000;
      const RealDate = Date;
      window.__advanceTime = (ms) => { fakeNow += ms; };
      window.Date = class MockDate extends RealDate {
        constructor(...args) {
          super(...(args.length ? args : [fakeNow]));
        }
        static now() { return fakeNow; }
      };
      window.fetch = async (url) => {
        if (String(url) === '/api/target-runtime/catalog') {
          return new Response(JSON.stringify({
            revision: 0,
            activeTargetId: 'local-1',
            targets: [{ targetId: 'local-1', instanceId: 'local-1', label: 'This device', status: 'online' }],
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({ ok: true, reachable: true, sessions: { total: 1 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };
    });
    await page.addScriptTag({ content: storeSource });
    await page.addScriptTag({ content: runtimeSource });

    const clientResult = await page.evaluate(async () => {
      const runtime = window.RagentTargetRuntime;
      const store = window.RagentTargetStore;
      await new Promise((resolve) => setTimeout(resolve, 20));
      let catalogRevision = 1;
      let remoteOfflineStatus = 'offline';
      const summaryCalls = [];

      const catalogFetch = async (url) => {
        if (String(url) === '/api/target-runtime/catalog') {
          return new Response(JSON.stringify({
            revision: catalogRevision,
            activeTargetId: 'local-1',
            targets: [
              { targetId: 'local-1', instanceId: 'local-1', label: 'This device', status: 'online' },
              { targetId: 'remote-a', instanceId: 'remote-a', label: 'Remote A', status: 'paired' },
              { targetId: 'remote-no-ep', instanceId: 'remote-no-ep', label: 'No EP', status: remoteOfflineStatus },
            ],
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
      };

      await runtime.refreshTargets({ fetchImpl: catalogFetch });
      await new Promise((resolve) => setTimeout(resolve, 20));
      const trackedFetch = (retryAfterMs = 0, reachable = false) => async (url) => {
        summaryCalls.push(String(url));
        return new Response(JSON.stringify({
          schemaVersion: 1,
          targetId: 'remote-a',
          revision: 3,
          cursor: '5',
          events: [],
          reachable,
          state: reachable ? 'online' : 'offline',
          degraded: !reachable,
          ...(retryAfterMs > 0 ? { retryAfterMs } : {}),
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      };

      // Endpoint-less target must be skipped on both refreshTargetSummary and readSummaryEvents.
      await runtime.refreshTargetSummary('remote-no-ep', { fetchImpl: trackedFetch(0, false) });
      await runtime.readSummaryEvents('remote-no-ep', { fetchImpl: trackedFetch(0, false) });
      const endpointlessCallsBeforeRevBump = summaryCalls.length;

      // Client exponential backoff: 15s -> 30s -> 60s -> 120s -> 300s (no server retryAfterMs override).
      const steps = [15_000, 30_000, 60_000, 120_000, 300_000];
      const stepObservations = [];
      for (const stepMs of steps) {
        const before = summaryCalls.length;
        await runtime.readSummaryEvents('remote-a', { fetchImpl: trackedFetch(0, false) });
        const afterPoll = summaryCalls.length;
        window.__advanceTime(stepMs - 1);
        await runtime.readSummaryEvents('remote-a', { fetchImpl: trackedFetch(0, false) });
        const duringWindow = summaryCalls.length;
        window.__advanceTime(1);
        stepObservations.push({
          stepMs,
          polled: afterPoll === before + 1,
          skippedBeforeStepElapsed: duringWindow === afterPoll,
          statusAfter: store.getTarget('remote-a').status,
        });
      }

      // Now simulate server retryAfterMs = 45_000 (greater than 15s) and verify ragent:target-selected
      // resets failureCount while STILL respecting active serverCooldownUntil!
      await runtime.readSummaryEvents('remote-a', { fetchImpl: trackedFetch(45_000, false) });
      const beforeSelectDuringCooldown = summaryCalls.length;
      window.__advanceTime(20_000); // 25_000ms server cooldown still remaining
      window.dispatchEvent(new CustomEvent('ragent:target-selected', { detail: { target: { targetId: 'remote-a' } } }));
      await runtime.readSummaryEvents('remote-a', { fetchImpl: trackedFetch(0, false) });
      const callsAfterSelectDuringCooldown = summaryCalls.length;

      // Advance past the remaining 25_000ms server cooldown; because target-selected reset failureCount to 0,
      // the next failure starts back at 15_000ms (not 300_000ms).
      window.__advanceTime(25_000);
      await runtime.readSummaryEvents('remote-a', { fetchImpl: trackedFetch(0, false) });
      const callsAfterCooldownExpired = summaryCalls.length;
      window.__advanceTime(14_999);
      await runtime.readSummaryEvents('remote-a', { fetchImpl: trackedFetch(0, false) });
      const skippedBeforeReset15s = summaryCalls.length === callsAfterCooldownExpired;
      window.__advanceTime(1);
      await runtime.readSummaryEvents('remote-a', { fetchImpl: trackedFetch(0, false) });
      const polledAtReset15s = summaryCalls.length === callsAfterCooldownExpired + 1;

      // Catalog revision bump clears endpoint-less skip AND resets client backoff (respecting cooldown).
      catalogRevision = 2;
      remoteOfflineStatus = 'paired';
      window.fetch = async (url) => {
        summaryCalls.push(`bg:${String(url)}`);
        return new Response(JSON.stringify({ ok: true, reachable: true, sessions: { total: 1 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };
      await runtime.refreshTargets({ fetchImpl: catalogFetch });
      await new Promise((resolve) => setTimeout(resolve, 20));
      const polledAfterRevBumpViaRefresh = summaryCalls.some((u) => u.includes('targetId=remote-no-ep'));
      const beforeExplicitNoEp = summaryCalls.length;
      await runtime.refreshTargetSummary('remote-no-ep', { fetchImpl: trackedFetch(0, true) });
      const endpointlessPolledAfterRevBump = polledAfterRevBumpViaRefresh
        && summaryCalls.length === beforeExplicitNoEp + 1;

      return {
        endpointlessCallsBeforeRevBump,
        stepObservations,
        skippedDuringServerCooldownAfterSelect: callsAfterSelectDuringCooldown === beforeSelectDuringCooldown,
        polledAfterCooldownExpired: callsAfterCooldownExpired === beforeSelectDuringCooldown + 1,
        skippedBeforeReset15s,
        polledAtReset15s,
        endpointlessPolledAfterRevBump,
      };
    });

    assert.equal(clientResult.endpointlessCallsBeforeRevBump, 0, 'endpoint-less target must be skipped');
    for (const obs of clientResult.stepObservations) {
      assert.equal(obs.polled, true, `expected poll at step ${obs.stepMs}`);
      assert.equal(obs.skippedBeforeStepElapsed, true, `expected skip before ${obs.stepMs}ms`);
      assert.equal(obs.statusAfter, 'offline', 'reachable:false must keep target offline');
    }
    assert.equal(clientResult.skippedDuringServerCooldownAfterSelect, true, 'target-selected reset must still respect server cooldown');
    assert.equal(clientResult.polledAfterCooldownExpired, true, 'poll should resume once server cooldown expires');
    assert.equal(clientResult.skippedBeforeReset15s, true, 'backoff should reset to 15s after target-selected');
    assert.equal(clientResult.polledAtReset15s, true, 'reset 15s backoff should allow next poll at 15s');
    assert.equal(clientResult.endpointlessPolledAfterRevBump, true, 'catalog revision change should allow polling newly paired target');
  } finally {
    await browser.close();
  }
}

console.log('test-target-runtime-offline-polling: ok');
