#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const storeSource = await readFile(new URL('../static/chat/target-store.js', import.meta.url), 'utf8');
const runtimeSource = await readFile(new URL('../static/chat/target-runtime-client.js', import.meta.url), 'utf8');
const helpersSource = await readFile(new URL('../static/chat/session-http-helpers.js', import.meta.url), 'utf8');

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.evaluate(() => {
    window.__fetchCalls = [];
    window.fetch = async (url, options = {}) => {
      window.__fetchCalls.push({ url: String(url), method: options.method || 'GET' });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
  });
  await page.addScriptTag({ content: storeSource });
  await page.addScriptTag({ content: runtimeSource });
  await page.addScriptTag({ content: 'const jsonResponseCache = new Map();' });
  await page.addScriptTag({ content: helpersSource });

  const localRequestResult = await page.evaluate(async () => {
    const data = await fetchJsonOrRedirect('/api/sessions', { method: 'GET' });
    return {
      data,
      calls: window.__fetchCalls,
      active: window.RagentTargetRuntime.getActiveTarget(),
    };
  });
  assert.deepEqual(localRequestResult.data, { ok: true });
  assert.equal(localRequestResult.calls.some((call) => call.url === '/api/sessions'), true);
  assert.equal(localRequestResult.active.status, 'online');

  const switchResult = await page.evaluate(async () => {
    const store = window.RagentTargetStore;
    const runtime = window.RagentTargetRuntime;
    store.replaceTargets([
      {
        targetId: runtime.getLocalTargetId(),
        instanceId: runtime.getLocalTargetId(),
        label: 'This device',
        status: 'online',
      },
      {
        targetId: 'remote-a',
        instanceId: 'instance-remote-a',
        label: 'Remote A',
        status: 'online',
      },
    ], { activeTargetId: runtime.getLocalTargetId(), preserveActive: false });

    let cancelled = false;
    const pending = runtime.routeRequest({
      url: '/api/sessions',
      options: {},
      localRequest: ({ signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          cancelled = true;
          const error = new Error('Aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      }),
    });
    await runtime.selectTarget('remote-a');
    let error = null;
    try { await pending; } catch (caught) { error = caught; }
    return {
      cancelled,
      errorName: error?.name || '',
      activeTargetId: store.getSnapshot().activeTargetId,
    };
  });
  assert.deepEqual(switchResult, {
    cancelled: true,
    errorName: 'AbortError',
    activeTargetId: 'remote-a',
  });

  const remoteUnavailable = await page.evaluate(async () => {
    let error = null;
    try {
      await window.RagentTargetRuntime.routeRequest({
        url: '/api/sessions',
        options: {},
        localRequest: () => ({ accidentalLocalFallback: true }),
      });
    } catch (caught) {
      error = { code: caught.code, status: caught.status };
    }
    return error;
  });
  assert.deepEqual(remoteUnavailable, {
    code: 'TARGET_RUNTIME_UNAVAILABLE',
    status: 503,
  });

  const neutralPath = await page.evaluate(async () => {
    let localCalls = 0;
    const result = await window.RagentTargetRuntime.routeRequest({
      url: '/api/auth/me',
      options: {},
      localRequest: () => {
        localCalls += 1;
        return { local: true };
      },
    });
    return { result, localCalls };
  });
  assert.deepEqual(neutralPath, { result: { local: true }, localCalls: 1 });

  const remoteJson = await page.evaluate(async () => {
    const runtime = window.RagentTargetRuntime;
    await runtime.refreshTargets({
      fetchImpl: async () => new Response(JSON.stringify({
        revision: 0,
        activeTargetId: runtime.getLocalTargetId(),
        targets: [
          runtime.getSnapshot().targets[0],
          { targetId: 'remote-a', instanceId: 'instance-remote-a', label: 'Remote A', status: 'online' },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    });
    window.fetch = async (url) => String(url) === '/api/target-runtime/request'
      ? new Response(JSON.stringify({ remote: true }), {
          status: 200,
          headers: { 'content-type': 'application/json', 'x-ragent-target-revision': '4' },
        })
      : new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    const data = await fetchJsonOrRedirect('/api/sessions', { method: 'GET', revalidate: false });
    return { data, target: runtime.getActiveTarget() };
  });
  assert.deepEqual(remoteJson.data, { remote: true });
  assert.equal(remoteJson.target.snapshotVersion, 4);

  const remoteError = await page.evaluate(async () => {
    const runtime = window.RagentTargetRuntime;
    runtime.registerAdapter('remote-a', {
      request: async () => new Response(JSON.stringify({ error: 'stale', code: 'TARGET_RUNTIME_REVISION_CONFLICT' }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      }),
    });
    try {
      await fetchJsonOrRedirect('/api/sessions/session-1', { method: 'PATCH', revalidate: false });
      return null;
    } catch (error) {
      return { code: error.code, status: error.status };
    }
  });
  assert.deepEqual(remoteError, { code: 'TARGET_RUNTIME_REVISION_CONFLICT', status: 409 });

  const summaryEvents = await page.evaluate(async () => {
    const runtime = window.RagentTargetRuntime;
    const first = await runtime.readSummaryEvents('remote-a', {
      afterCursor: 0,
      fetchImpl: async () => new Response(JSON.stringify({
        cursor: '7',
        events: [{
          eventId: 'summary-event-7',
          targetId: 'remote-a',
          instanceId: 'instance-remote-a',
          revision: 7,
          cursor: 7,
          emittedAt: '2026-09-03T00:00:00.000Z',
          summary: { sessions: { total: 3 } },
        }, {
          eventId: 'summary-event-7',
          targetId: 'remote-a',
          instanceId: 'instance-remote-a',
          revision: 7,
          cursor: 7,
          emittedAt: '2026-09-03T00:00:00.000Z',
          summary: { sessions: { total: 3 } },
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    });
    let nextRequest = '';
    await runtime.readSummaryEvents('remote-a', {
      fetchImpl: async (url) => {
        nextRequest = String(url);
        return new Response(JSON.stringify({ cursor: '7', events: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    return { cursor: first.cursor, summary: runtime.getSummary('remote-a'), nextRequest };
  });
  assert.equal(summaryEvents.cursor, '7');
  assert.equal(summaryEvents.summary.sessions.total, 3);
  assert.match(summaryEvents.nextRequest, /afterCursor=7/);

  console.log('test-target-runtime-browser: ok');
} finally {
  await browser.close();
}
