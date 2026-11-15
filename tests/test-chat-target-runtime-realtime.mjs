#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const source = await readFile(new URL('../static/chat/realtime.js', import.meta.url), 'utf8');
assert.match(source, /TARGET_RUNTIME_REMOTE_POLL_INTERVAL_MS = 3_000/);
assert.match(source, /window\.addEventListener\("ragent:target-selected", syncTargetRuntimeRealtime\)/);
assert.match(source, /closeLocalRealtimeSocket\(\)/);

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ content: 'let ws = null; let reconnectTimer = null;' });
  await page.addScriptTag({ content: source });
  const result = await page.evaluate(async () => {
    let refreshCalls = 0;
    let summaryCalls = 0;
    let p2pCloseCalls = 0;
    const sockets = [];
    window.queueForegroundRefresh = () => {
      refreshCalls += 1;
      return Promise.resolve();
    };
    window.RagentP2P = { close: () => { p2pCloseCalls += 1; } };
    window.WebSocket = class FakeWebSocket {
      constructor() {
        this.readyState = 0;
        this.onclose = null;
        sockets.push(this);
      }
      close() { this.readyState = 3; }
    };
    let remote = true;
    window.RagentTargetRuntime = {
      getLocalTargetId: () => 'local',
      getActiveTarget: () => ({ targetId: remote ? 'remote-a' : 'local' }),
      readSummaryEvents: () => {
        summaryCalls += 1;
        return Promise.resolve();
      },
    };

    window.dispatchEvent(new CustomEvent('ragent:target-selected'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const remoteResult = { refreshCalls, summaryCalls, p2pCloseCalls, sockets: sockets.length };

    remote = false;
    window.dispatchEvent(new CustomEvent('ragent:target-selected'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    return {
      remoteResult,
      localSockets: sockets.length,
    };
  });
  assert.deepEqual(result.remoteResult, {
    refreshCalls: 1,
    summaryCalls: 1,
    p2pCloseCalls: 1,
    sockets: 0,
  });
  assert.equal(result.localSockets, 1, 'switching back to local must restore the local realtime socket');
  console.log('test-chat-target-runtime-realtime: ok');
} finally {
  await browser.close();
}
