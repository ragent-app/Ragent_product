#!/usr/bin/env node
// Verifies the Run Sheet pins to the currently viewed conversation instead of
// jumping to whatever session is running / most recent globally. This is a
// runtime test (vm + stub DOM) because the bug is a target-resolution order
// error that source-pattern assertions cannot catch.
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

function buildContext({ currentSessionId, sessions }) {
  let nextTimerId = 1;
  const pending = new Map();
  const captured = { ids: [] };
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
    window: { RagentRunActivity: { subscribe() { return () => {}; } } },
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
      return Promise.resolve({
        ok: true,
        json: async () => ({
          runSheet: {
            session: { id },
            artifactFiles: [],
            changedFiles: [],
            progressPlan: null,
          },
        }),
      });
    },
    getChatStore() { return { subscribe() { return () => {}; } }; },
    getChatStoreStateSnapshot() { return { sessions }; },
    currentSessionId,
  });
  vm.runInContext(source, context);
  // This harness never fires the store/activity background hooks, so open the
  // sheet to drive a refresh through the open-state path and flush it.
  if (typeof context.window?.openRunSheet === "function") context.window.openRunSheet();
  return { context, pending, captured };
}

function flushZeroDelay(pending) {
  // Run only the immediate (delay 0) refresh callbacks scheduled by the sheet.
  for (const [id, timer] of [...pending.entries()]) {
    if (timer.delay === 0) {
      pending.delete(id);
      timer.callback();
    }
  }
}

// Catalog: an idle "current" conversation plus a DIFFERENT running background
// session that is older. Before the fix, the sheet showed the running session.
const sessions = [
  {
    id: 'session-current',
    archived: false,
    lastEventAt: '2026-08-02T09:00:00.000Z',
    activity: { run: { state: 'idle' } },
  },
  {
    id: 'session-running',
    archived: false,
    lastEventAt: '2026-08-02T08:00:00.000Z',
    activity: { run: { state: 'running', runId: 'run-bg' } },
  },
];

// Scenario 1: a current conversation is attached — the sheet must pin to it
// even though another session is running.
{
  const { pending, captured } = buildContext({ currentSessionId: 'session-current', sessions });
  flushZeroDelay(pending);
  assert.ok(
    captured.ids.includes('session-current'),
    `Run Sheet should target the current conversation, got ${JSON.stringify(captured.ids)}`,
  );
  assert.ok(
    !captured.ids.includes('session-running'),
    'Run Sheet must not leak a background running session into the current conversation view',
  );
}

// Scenario 2: no current conversation attached — fall back to the running one.
{
  const { pending, captured } = buildContext({ currentSessionId: '', sessions });
  flushZeroDelay(pending);
  assert.ok(
    captured.ids.includes('session-running'),
    `Run Sheet should fall back to the running session when no conversation is attached, got ${JSON.stringify(captured.ids)}`,
  );
}

// Scenario 3: current conversation is not yet in the local catalog (deep link)
// — still pin to its id so the sheet fetches its own data.
{
  const { pending, captured } = buildContext({
    currentSessionId: 'session-deeplink',
    sessions,
  });
  flushZeroDelay(pending);
  assert.ok(
    captured.ids.includes('session-deeplink'),
    `Run Sheet should pin to the current conversation id even before it appears in the catalog, got ${JSON.stringify(captured.ids)}`,
  );
}

console.log('test-chat-run-sheet-target-session: ok');
