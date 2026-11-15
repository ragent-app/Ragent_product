#!/usr/bin/env node
// Verifies the Run Sheet keeps its model warm while the sheet is closed:
// entering a conversation triggers one background projection preload, update
// hooks keep landing without the sheet being open, and bursts are debounced
// into a single background refresh instead of hammering the endpoint.
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const source = readFileSync(join(repoRoot, 'static', 'chat', 'run-sheet.js'), 'utf8');

function makeElement() {
  const classes = new Set();
  const listeners = new Map();
  return {
    hidden: false,
    textContent: '',
    innerHTML: '',
    className: '',
    id: '',
    dataset: {},
    style: {},
    attributes: {},
    children: [],
    classList: {
      add(...names) { names.forEach((n) => classes.add(n)); },
      remove(...names) { names.forEach((n) => classes.delete(n)); },
      toggle(name, force) {
        const on = force === undefined ? !classes.has(name) : Boolean(force);
        if (on) classes.add(name); else classes.delete(name);
        return on;
      },
      contains(name) { return classes.has(name); },
    },
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type) { listeners.delete(type); },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    removeAttribute(name) { delete this.attributes[name]; },
    getAttribute(name) { return this.attributes[name] ?? null; },
    appendChild(child) { this.children.push(child); return child; },
    remove() {},
    focus() {},
    setPointerCapture() {},
    releasePointerCapture() {},
    getBoundingClientRect() { return { height: 400, width: 360 }; },
    closest() { return null; },
    querySelector() { return makeElement(); },
    querySelectorAll() { return []; },
  };
}

function buildContext({ currentSessionId, sessions, projectedSession = null }) {
  let nextTimerId = 1;
  let fakeNow = 1_000_000;
  const RealDate = Date;
  const pending = new Map();
  const captured = { ids: [], count: 0 };
  captured.terminalRefreshes = [];
  const storeSubscribers = new Set();
  const activitySubscribers = new Set();
  const document = {
    readyState: 'complete',
    hidden: false,
    body: { appendChild() {} },
    getElementById() { return null; },
    createElement() { return makeElement(); },
    addEventListener() {},
  };
  const context = vm.createContext({
    document,
    Date: { now: () => fakeNow, parse: (value) => RealDate.parse(value) },
    window: {
      RagentRunActivity: {
        subscribe(subscriber) {
          activitySubscribers.add(subscriber);
          subscriber();
          return () => activitySubscribers.delete(subscriber);
        },
      },
      refreshCurrentSession(options) {
        captured.terminalRefreshes.push(options);
        return Promise.resolve(null);
      },
    },
    PointerEvent: function PointerEvent() {},
    requestAnimationFrame() { return 0; },
    setTimeout(callback, delay) {
      const id = nextTimerId++;
      pending.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { pending.delete(id); },
    fetch(url) {
      const match = /\/api\/sessions\/([^/]+)\/run-sheet/.exec(String(url));
      const id = match ? decodeURIComponent(match[1]) : '';
      captured.ids.push(id);
      captured.count += 1;
      return Promise.resolve({
        ok: true,
        json: async () => ({
          runSheet: {
            session: projectedSession ? projectedSession(id) : { id },
            artifactFiles: [],
            changedFiles: [],
            progressPlan: null,
          },
        }),
      });
    },
    getChatStore() {
      return {
        subscribe(subscriber) {
          storeSubscribers.add(subscriber);
          return () => storeSubscribers.delete(subscriber);
        },
      };
    },
    getChatStoreStateSnapshot() { return { sessions }; },
    currentSessionId,
  });
  vm.runInContext(source, context);
  return {
    context,
    pending,
    captured,
    storeSubscribers,
    activitySubscribers,
  };
}

// Flush only the short background refresh timers (debounce / min-interval).
// The long fallback polls (10s/30s) stay pending and must not drive fetches.
async function flushBackground(pending) {
  for (;;) {
    let fired = false;
    for (const [id, timer] of [...pending.entries()]) {
      if (timer.delay <= 2000) {
        pending.delete(id);
        timer.callback();
        fired = true;
      }
    }
    // Drain the whole microtask queue (the in-flight refresh completes its
    // finally block) plus any chained 0-delay real timers before re-checking.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (!fired) break;
  }
}

const sessions = [
  {
    id: 'session-current',
    archived: false,
    lastEventAt: '2026-08-02T09:00:00.000Z',
    activity: { run: { state: 'idle' } },
  },
];

// Scenario 1: entering a conversation preloads the projection once in the
// background while the sheet stays closed.
{
  const { captured, storeSubscribers, pending } = buildContext({
    currentSessionId: 'session-current',
    sessions,
  });
  await flushBackground(pending);
  const afterInit = captured.count;
  assert.ok(
    afterInit >= 1 && captured.ids.includes('session-current'),
    `closed Run Sheet should preload the current conversation in the background, got ${JSON.stringify(captured.ids)}`,
  );

  // Simulate the session-entry / catalog-load store update.
  for (const subscriber of [...storeSubscribers]) subscriber();
  await flushBackground(pending);
  assert.ok(
    captured.count > afterInit,
    `session entry should trigger another background preload, got ${afterInit} -> ${captured.count}`,
  );
  assert.ok(
    captured.ids.every((id) => id === 'session-current'),
    `all background fetches should pin to the current conversation, got ${JSON.stringify(captured.ids)}`,
  );
}

// Scenario 2: a burst of background update hooks coalesces into a single
// throttled refresh instead of one fetch per hook.
{
  const { captured, activitySubscribers, pending } = buildContext({
    currentSessionId: 'session-current',
    sessions,
  });
  await flushBackground(pending);
  const beforeBurst = captured.count;

  const hooks = [...activitySubscribers];
  hooks.forEach((fn) => fn());
  hooks.forEach((fn) => fn());
  await flushBackground(pending);
  assert.equal(
    captured.count,
    beforeBurst + 1,
    `a burst of activity hooks should coalesce into one background refresh, got ${beforeBurst} -> ${captured.count}`,
  );

  // A hook right after a refresh is throttled: the refresh is scheduled at the
  // minimum interval instead of the 140ms debounce, and nothing fetches yet.
  for (const fn of hooks) fn();
  const throttled = [...pending.entries()].filter(([, timer]) => timer.delay >= 1000 && timer.delay < 10000);
  assert.equal(throttled.length, 1, 'an immediately re-fired hook should schedule one throttled background refresh');
  assert.equal(captured.count, beforeBurst + 1, 'the throttled refresh must not fetch until its timer runs');
  await flushBackground(pending);
  assert.equal(
    captured.count,
    beforeBurst + 2,
    `after the minimum interval the throttled background refresh should land, got ${captured.count}`,
  );
}

// Scenario 3: the detail projection can observe an idle/terminal server
// session before the session catalog has received that transition. Reconcile
// the full current-session snapshot so the composer and live message do not
// remain in a stale running state. A terminal projection for an older run must
// not clear a newer local run.
{
  const sessions = [{
    id: 'session-current',
    archived: false,
    activity: { run: { state: 'running', runId: 'run-current' } },
  }];
  const { captured, pending } = buildContext({
    currentSessionId: 'session-current',
    sessions,
    projectedSession: (id) => ({ id, activity: { run: null } }),
  });
  await flushBackground(pending);
  assert.equal(captured.terminalRefreshes.length, 1, 'an idle authoritative projection should refresh the stale current session');
  assert.equal(captured.terminalRefreshes[0].forceFresh, true, 'terminal reconciliation should bypass stale session caches');
  assert.equal(captured.terminalRefreshes[0].essential, true, 'terminal reconciliation should use the essential session refresh path');
}

{
  const sessions = [{
    id: 'session-current',
    archived: false,
    activity: { run: { state: 'running', runId: 'run-current' } },
  }];
  const { captured, pending } = buildContext({
    currentSessionId: 'session-current',
    sessions,
    projectedSession: (id) => ({
      id,
      activity: { run: { state: 'completed', runId: 'run-older' } },
    }),
  });
  await flushBackground(pending);
  assert.equal(captured.terminalRefreshes.length, 0, 'a terminal projection for an older run must not clear the currently running run');
}

console.log('test-chat-run-sheet-background-refresh: ok');
