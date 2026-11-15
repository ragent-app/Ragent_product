#!/usr/bin/env node
// Transport contract for paired browsers: an older P2P host may not know a
// newly added route, but that must not strand a valid request when the main
// HTTP control plane can serve it.
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
    window.__p2pResponses = [];
    window.__httpRequests = [];
    window.jsonResponseCache = new Map();
    window.RAGENT_P2P_REQUEST_TIMEOUT_MS = 250;
    window.RAGENT_P2P_FAILURE_COOLDOWN_MS = 1000;
    window.RagentP2P = {
      ready: true,
      tryRequest: async (url, method) => {
        window.__p2pResponses.push({ url, method });
        return window.__nextP2PResponse;
      },
    };
    window.fetch = async (url, options = {}) => {
      window.__httpRequests.push({ url, options });
      return {
        status: 200,
        ok: true,
        redirected: false,
        url: 'http://127.0.0.1/api/test',
        headers: { get: (name) => String(name).toLowerCase() === 'content-type' ? 'application/json' : '' },
        json: async () => ({ ok: true, transport: 'http' }),
      };
    };
    (0, eval)(source);
  }, helperSource);

  await page.evaluate(() => {
    window.__nextP2PResponse = {
      status: 404,
      ok: false,
      headers: { 'content-type': 'application/json' },
      text: JSON.stringify({ error: 'route missing on paired host' }),
    };
  });
  const fallbackResult = await page.evaluate(() => fetchJsonOrRedirect('/api/projects/prj_deadbeefdead', {
    method: 'DELETE',
    body: JSON.stringify({ deleteSessions: false }),
  }));
  assert.equal(fallbackResult.transport, 'http', 'P2P route misses should fall back to HTTP');
  assert.equal(await page.evaluate(() => window.__p2pResponses.length), 1, 'the P2P leg should be attempted first');
  assert.equal(await page.evaluate(() => window.__httpRequests.length), 1, 'HTTP should receive the retried request');
  assert.equal(await page.evaluate(() => window.__httpRequests[0].options.method), 'DELETE');

  await page.evaluate(() => {
    window.RagentP2P.tryRequest = async () => new Promise(() => {});
    window.__p2pResponses.length = 0;
    window.__httpRequests.length = 0;
  });
  const timeoutStartedAt = Date.now();
  const timeoutFallback = await page.evaluate(() => fetchJsonOrRedirect('/api/projects/prj_deadbeefdead', {
    method: 'DELETE',
  }));
  const timeoutElapsedMs = Date.now() - timeoutStartedAt;
  assert.equal(timeoutFallback.transport, 'http', 'a stalled P2P request should fall back to HTTP');
  assert.ok(timeoutElapsedMs < 1_500, `P2P fallback should use its short deadline (took ${timeoutElapsedMs}ms)`);
  assert.equal(await page.evaluate(() => window.__httpRequests.length), 1);

  await page.evaluate(() => {
    window.__p2pResponses.length = 0;
    window.__httpRequests.length = 0;
  });
  const cooldownFallback = await page.evaluate(() => fetchJsonOrRedirect('/api/projects/prj_deadbeefdead', {
    method: 'DELETE',
  }));
  assert.equal(cooldownFallback.transport, 'http', 'a timed-out P2P leg should enter HTTP cooldown');
  assert.equal(await page.evaluate(() => window.__p2pResponses.length), 0,
    'P2P cooldown should avoid paying the timeout on every request');
  await page.waitForTimeout(1_050);

  await page.evaluate(() => {
    window.RagentP2P.tryRequest = async () => window.__nextP2PResponse;
    window.__nextP2PResponse = {
      status: 401,
      ok: false,
      headers: { 'content-type': 'application/json' },
      text: JSON.stringify({ error: 'P2P cannot forward the HttpOnly owner cookie' }),
    };
    window.__httpRequests.length = 0;
  });
  const authFallback = await page.evaluate(() => fetchJsonOrRedirect('/api/sessions/session_deadbeef/events'));
  assert.equal(authFallback.transport, 'http', 'P2P authentication misses should fall back to browser HTTP');
  assert.equal(await page.evaluate(() => window.__httpRequests.length), 1,
    'the browser HTTP retry should be attempted after a P2P authentication miss');

  await page.evaluate(() => {
    window.__nextP2PResponse = {
      status: 405,
      ok: false,
      headers: { 'content-type': 'application/json' },
      text: JSON.stringify({ error: 'method missing on paired host' }),
    };
  });
  const methodFallback = await page.evaluate(() => fetchJsonOrRedirect('/api/projects/prj_deadbeefdead', {
    method: 'DELETE',
  }));
  assert.equal(methodFallback.transport, 'http', 'P2P method misses should also fall back to HTTP');

  await page.evaluate(() => {
    window.__nextP2PResponse = {
      status: 500,
      ok: false,
      headers: { 'content-type': 'application/json' },
      text: JSON.stringify({ error: 'server failure' }),
    };
    window.__httpRequests.length = 0;
  });
  await assert.rejects(
    () => page.evaluate(() => fetchJsonOrRedirect('/api/projects/prj_deadbeefdead', { method: 'DELETE' })),
    /server failure/,
    'real P2P server failures should remain visible instead of being retried as a different operation',
  );
  assert.equal(await page.evaluate(() => window.__httpRequests.length), 0,
    'non-capability P2P errors should not silently switch transports');

  await page.evaluate(() => {
    window.__nextP2PResponse = {
      status: 500,
      ok: false,
      headers: { 'content-type': 'application/json' },
      text: JSON.stringify({ error: 'P2P should be bypassed' }),
    };
    window.__p2pResponses.length = 0;
    window.__httpRequests.length = 0;
  });
  const bypassResult = await page.evaluate(() => fetchJsonOrRedirect('/api/projects/prj_deadbeefdead', {
    method: 'DELETE',
    skipP2P: true,
  }));
  assert.equal(bypassResult.transport, 'http', 'explicit P2P bypass should use HTTP directly');
  assert.equal(await page.evaluate(() => window.__p2pResponses.length), 0,
    'skipP2P should never invoke the paired transport');
  assert.equal(await page.evaluate(() => window.__httpRequests.length), 1);

  console.log('test-chat-p2p-http-fallback: ok');
} finally {
  await browser.close();
}
