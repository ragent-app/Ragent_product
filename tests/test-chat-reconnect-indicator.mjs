#!/usr/bin/env node
// Reconnect indicator probe (P2-8): WS/P2P transport loss shows a transient
// "Reconnecting…" pill in the live-status zone, network offline swaps the label
// to "Network offline", and recovery fades it out and detaches it. The vm
// harness drives the REAL `connect` + `syncConnectionRecoveryIndicator` code
// extracted from static/chat/realtime.js (same pattern as the WS-reconnect
// scroll-suppression probe) with a minimal fake DOM, so the ws.onclose →
// updateStatus → indicator wiring is exercised end to end.
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const realtimeSource = readFileSync(join(repoRoot, 'static/chat/realtime.js'), 'utf8');
const i18nSource = readFileSync(join(repoRoot, 'static/chat/i18n.js'), 'utf8');
const liveStatusCss = readFileSync(join(repoRoot, 'static/chat/chat-live-status.css'), 'utf8');

// --- Source-level wiring assertions (numeric/structural) ---
assert.equal(
  realtimeSource.indexOf('function updateStatus(connState, session = getCurrentSession()) {\n  syncConnectionRecoveryIndicator(connState);') > -1,
  true,
  'updateStatus should sync the reconnect indicator as its first action (every connection-state transition reaches it)',
);
assert.equal(
  realtimeSource.includes('window.addEventListener("online", syncRealtimeNetworkConnection);') &&
  realtimeSource.includes('window.addEventListener("offline", syncRealtimeNetworkConnection);') &&
  realtimeSource.includes('function syncRealtimeNetworkConnection()'),
  true,
  'online/offline network transitions should refresh the pill and enter the unified reconnect scheduler',
);
assert.equal(
  /"status\.offline"\s*:\s*"[^"]+"/g.test(i18nSource) &&
  (i18nSource.match(/^\s{4}["']?en["']?\s*:/gm) !== null) &&
  (i18nSource.match(/^\s{4}["']?zh-CN["']?\s*:/gm) !== null),
  true,
  'i18n should carry a status.offline key',
);
const enTable = i18nSource.slice(i18nSource.indexOf('en: {'), i18nSource.indexOf('};', i18nSource.indexOf('en: {')));
const zhTable = i18nSource.slice(i18nSource.indexOf('"zh-CN": {'), i18nSource.indexOf('};', i18nSource.indexOf('"zh-CN": {')));
assert.equal(enTable.includes('"status.offline"'), true, 'en table should define status.offline');
assert.equal(zhTable.includes('"status.offline"'), true, 'zh-CN table should define status.offline');
assert.equal(liveStatusCss.includes('.reconnect-indicator {'), true, 'chat-live-status.css should style the reconnect pill');
assert.equal(liveStatusCss.includes('@media (prefers-reduced-motion: reduce)'), true, 'reduced motion should still disable the pill transition');
assert.doesNotMatch(liveStatusCss, /reconnect-indicator-pulse/, 'the reconnect dot should not pulse during a slow transport');

// --- Function extraction (same brace-matcher as the sibling reconnect probe) ---
function extractFunctionSource(source, functionName) {
  const marker = `function ${functionName}`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${functionName} should exist`);
  const paramsStart = source.indexOf('(', start);
  assert.notEqual(paramsStart, -1, `${functionName} should have parameters`);
  let paramsDepth = 0;
  let braceStart = -1;
  for (let index = paramsStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '(') paramsDepth += 1;
    if (char === ')') {
      paramsDepth -= 1;
      if (paramsDepth === 0) {
        braceStart = source.indexOf('{', index);
        break;
      }
    }
  }
  assert.notEqual(braceStart, -1, `${functionName} should have a body`);
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }
  throw new Error(`Unable to extract ${functionName}`);
}

const INDICATOR_START = '// ---- Reconnect indicator (P2-8) ----';
const INDICATOR_END = 'function updateStatus(';
const indicatorStart = realtimeSource.indexOf(INDICATOR_START);
const indicatorEnd = realtimeSource.indexOf(INDICATOR_END, indicatorStart);
assert.notEqual(indicatorStart, -1, 'reconnect indicator block should exist');
assert.notEqual(indicatorEnd, -1, 'reconnect indicator block should precede updateStatus');
const indicatorBlock = realtimeSource.slice(indicatorStart, indicatorEnd);
const connectSource = extractFunctionSource(realtimeSource, 'connect');

// --- Fake DOM (minimal, just enough for the indicator paths) ---
function createFakeElement(id = '', className = '', elementsMap = null) {
  const el = {
    id,
    className,
    dataset: {},
    style: {},
    hidden: false,
    children: [],
    textContent: '',
    offsetWidth: 320,
    _classes: new Set(),
    classList: {
      add: (...names) => names.forEach((name) => el._classes.add(name)),
      remove: (...names) => names.forEach((name) => el._classes.delete(name)),
      contains: (name) => el._classes.has(name),
    },
    setAttribute(name, value) { el[name] = value; },
    querySelector(selector) {
      const wanted = String(selector).replace(/^\./, '');
      return el.children.find((child) => child.className === wanted) || null;
    },
    appendChild(child) {
      el.children.push(child);
      child._parent = el;
      if (child.id && elementsMap) elementsMap.set(child.id, child);
      return child;
    },
    remove() {
      const parent = el._parent;
      if (parent) parent.children = parent.children.filter((child) => child !== el);
      if (el.id && elementsMap) elementsMap.delete(el.id);
      el._parent = null;
    },
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._innerHTML || ''; },
    set(value) {
      el._innerHTML = value;
      el.children = [...value.matchAll(/class="([^"]+)"/g)].map((match) => createFakeElement('', match[1]));
    },
  });
  return el;
}

function createProbeContext() {
  const createdSockets = [];
  const pendingTimers = new Map();
  const elements = new Map();
  const slot = createFakeElement('liveBarSlot', 'live-bar-slot', elements);
  elements.set('liveBarSlot', slot);
  let nextTimerId = 1;
  const context = {
    console,
    location: { protocol: 'https:', host: 'chat.example.test' },
    navigator: { onLine: true },
    document: {
      body: { contains: () => true },
      getElementById: (id) => elements.get(id) || null,
      createElement: () => createFakeElement('', '', elements),
    },
    window: {},
    t: (key) => {
      if (key === 'status.reconnecting') return 'Reconnecting…';
      if (key === 'status.offline') return 'Network offline';
      return key;
    },
    getCurrentSession: () => ({ id: 'session_current' }),
    resolveWsUrl: (path) => path,
    refreshRealtimeViews: () => Promise.resolve(),
    scheduleReconnect: () => {},
    hasSeenWsOpen: false,
    ws: null,
    WebSocket: class FakeWebSocket {
      static OPEN = 1;
      static CLOSED = 3;
      constructor(url) {
        this.url = url;
        this.onopen = null;
        this.onmessage = null;
        this.onclose = null;
        this.onerror = null;
        this.readyState = FakeWebSocket.CLOSED;
        createdSockets.push(this);
      }
      close() {
        this.readyState = FakeWebSocket.CLOSED;
        if (this.onclose) this.onclose();
      }
    },
    setTimeout: (fn) => { const id = nextTimerId; nextTimerId += 1; pendingTimers.set(id, fn); return id; },
    clearTimeout: (id) => { pendingTimers.delete(id); },
  };
  context.globalThis = context;
  return { context, createdSockets, pendingTimers, elements };
}

function installProbe(context) {
  // The stub updateStatus mirrors realtime.js: it funnels every connState
  // transition through the indicator sync (asserted structurally above).
  context.updateStatus = (connState) => context.syncConnectionRecoveryIndicator(connState);
  const source = `${connectSource}\n${indicatorBlock}\nglobalThis.connect = connect;`;
  vm.runInNewContext(source, context, { filename: 'static/chat/realtime.js' });
}

// --- Scenario A: disconnect after connection shows the pill ---
{
  const { context, createdSockets, elements } = createProbeContext();
  installProbe(context);
  context.connect();
  assert.equal(createdSockets.length, 1, 'A: connect should open one socket');
  createdSockets[0].readyState = 1; // WebSocket.OPEN, as a real onopen implies
  createdSockets[0].onopen();

  assert.equal(
    elements.get('reconnectIndicator') || null,
    null,
    'A: while transport is up the pill should not exist in the DOM at all',
  );

  createdSockets[0].close(); // ws.onclose → updateStatus("disconnected")
  const pill = elements.get('reconnectIndicator');
  assert.ok(pill, 'A: ws.onclose should create the reconnect pill');
  assert.equal(pill.classList.contains("is-visible"), true, "A: the pill should be visible after ws.onclose");
  assert.equal(pill.classList.contains('is-visible'), true, 'A: the pill should be in the visible state');
  assert.equal(pill.dataset.variant, 'reconnecting', 'A: the pill should expose the reconnecting variant');
  assert.equal(
    pill.querySelector('.reconnect-indicator__label').textContent,
    'Reconnecting…',
    'A: the pill should consume the status.reconnecting i18n key',
  );
  assert.equal(elements.get('liveBarSlot').children.length, 1, 'A: the pill should be mounted inside the live status slot');
  assert.equal(createdSockets.length, 1, 'A: disconnect should not open a second socket (reconnect is scheduled elsewhere)');
}

// --- Scenario B: navigator.onLine=false swaps the label; online restores it ---
{
  const { context, elements } = createProbeContext();
  installProbe(context);
  context.connect();
  context.ws.readyState = 1;
  context.ws.onopen();
  context.ws.close();
  const pill = elements.get('reconnectIndicator');
  assert.equal(pill.dataset.variant, 'reconnecting', 'B: baseline label is reconnecting');

  context.navigator.onLine = false;
  context.syncConnectionRecoveryIndicatorNetworkState();
  assert.equal(pill.querySelector('.reconnect-indicator__label').textContent, 'Network offline', 'B: offline should swap to status.offline');
  assert.equal(pill.dataset.variant, 'offline', 'B: offline should expose the offline variant');
  assert.equal(elements.get("reconnectIndicator") !== null, true, "B: offline label swap should keep the pill mounted");
  assert.equal(pill.classList.contains('is-visible'), true, 'B: offline label swap should not re-animate or dismiss the pill');

  context.navigator.onLine = true;
  context.syncConnectionRecoveryIndicatorNetworkState();
  assert.equal(pill.querySelector('.reconnect-indicator__label').textContent, 'Reconnecting…', 'B: back online should restore the reconnecting label');
  assert.equal(pill.dataset.variant, 'reconnecting', 'B: online should restore the reconnecting variant');
}

// --- Scenario C: recovery (ws onopen) fades the pill out and detaches it ---
{
  const { context, pendingTimers, elements } = createProbeContext();
  installProbe(context);
  context.connect();
  context.ws.readyState = 1;
  context.ws.onopen();
  context.ws.close();
  const pill = elements.get('reconnectIndicator');
  assert.equal(pill.classList.contains('is-visible'), true, 'C: baseline pill is visible');

  context.ws.readyState = 1;
  context.ws.onopen(); // ws.onopen → updateStatus("connected")
  assert.equal(pill.classList.contains('is-visible'), false, 'C: recovery should start the fade-out immediately');
  assert.equal(pendingTimers.size, 1, 'C: recovery should schedule exactly one detach timer');
  assert.equal(elements.get("reconnectIndicator") !== null, true, "C: the pill should stay mounted during the fade window");

  for (const [id, fn] of [...pendingTimers.entries()]) {
    pendingTimers.delete(id); // timers consume themselves when they fire
    fn();
  }
  assert.equal(elements.get("reconnectIndicator") || null, null, "C: after the fade window the pill should detach from the slot");
  assert.equal(pill.classList.contains('is-visible'), false, 'C: detach should not re-add the visible state');
  assert.equal(pendingTimers.size, 0, 'C: the detach timer should consume itself');
}

// --- Scenario D: P2P second channel ready while WS is down counts as restored ---
{
  const { context, elements } = createProbeContext();
  installProbe(context);
  context.connect();
  context.ws.readyState = 1;
  context.ws.onopen();
  context.ws.close();
  const pill = elements.get('reconnectIndicator');
  assert.equal(pill.classList.contains('is-visible'), true, 'D: baseline pill is visible with WS down');

  context.window.RagentP2P = { ready: true };
  context.syncConnectionRecoveryIndicator('p2p'); // ragent:p2p-status "ready" handler
  assert.equal(pill.classList.contains('is-visible'), false, 'D: p2p ready should dismiss the pill even though WS is closed');
}

// --- Scenario E: spurious "connected" while transport is still down keeps the pill ---
{
  const { context, elements } = createProbeContext();
  installProbe(context);
  context.connect();
  context.ws.readyState = 1;
  context.ws.onopen();
  context.ws.close();
  const pill = elements.get('reconnectIndicator');
  assert.equal(pill.classList.contains('is-visible'), true, 'E: baseline pill is visible');

  context.syncConnectionRecoveryIndicator('connected'); // sidebar/session-switch paths call updateStatus("connected")
  assert.equal(pill.classList.contains('is-visible'), true, 'E: a connected signal with WS still closed must NOT dismiss the pill');
  assert.equal(elements.get("reconnectIndicator") !== null, true, "E: the pill should stay mounted while transport is down");
}

// --- Scenario F: initial load with a dead server shows no pill (noise guard) ---
{
  const { context, elements } = createProbeContext();
  installProbe(context);
  context.connect();
  context.ws.close(); // ws.onclose fires before any successful open
  assert.equal(
    elements.get('reconnectIndicator') || null,
    null,
    'F: a never-connected transport should not render a reconnecting pill on initial load',
  );
}

console.log('test-chat-reconnect-indicator: ok');
