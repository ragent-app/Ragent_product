#!/usr/bin/env node
// Busy-session send (queue path) contract: a send into a running session
// skips the optimistic echo entirely — the bubble never flashes in "sending"
// before the server ACKs the queue, and the message lives only in the queue
// block. If the send never lands (POST fails), the composer refills. When a
// send finalizes without its committed bubble ever rendering, exactly one
// events refresh is triggered so the bubble appears without a manual reload.
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const composerStoreSource = readFileSync(join(repoRoot, 'static/chat/composer-store.js'), 'utf8');
const composeSource = readFileSync(join(repoRoot, 'static/chat/compose.js'), 'utf8');

class StorageMock {
  constructor() {
    this.store = new Map();
  }
  getItem(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }
  setItem(key, value) {
    this.store.set(key, String(value));
  }
  removeItem(key) {
    this.store.delete(key);
  }
}

function makeClassList(initial = []) {
  const values = new Set(initial);
  return {
    add(...tokens) { tokens.forEach((token) => values.add(token)); },
    remove(...tokens) { tokens.forEach((token) => values.delete(token)); },
    toggle(token, force) {
      if (typeof force === 'boolean') {
        if (force) values.add(token);
        else values.delete(token);
        return force;
      }
      if (values.has(token)) { values.delete(token); return false; }
      values.add(token);
      return true;
    },
    contains(token) { return values.has(token); },
  };
}

function makeEventTarget() {
  return {
    style: {},
    disabled: false,
    title: '',
    textContent: '',
    addEventListener() {},
    focus() {},
    click() {},
    setAttribute(name, value) { this[name] = value; },
    removeAttribute(name) { delete this[name]; },
    classList: makeClassList(),
  };
}

function createContext({ session = null } = {}) {
  const localStorage = new StorageMock();
  const msgInput = {
    value: '',
    scrollHeight: 12,
    style: { height: '' },
    readOnly: false,
    addEventListener() {},
    focus() {},
    getBoundingClientRect() { return { height: parseFloat(this.style.height) || 72 }; },
  };
  const document = {
    body: { classList: makeClassList() },
    addEventListener() {},
    removeEventListener() {},
    getElementById() { return null; },
    createElement() {
      return { appendChild() {}, remove() {}, className: '', id: '', textContent: '', innerHTML: '', style: {} };
    },
  };
  const calls = [];
  const track = (name) => (...args) => {
    calls.push({ name, args });
    return Promise.resolve();
  };
  const windowTarget = {
    innerHeight: 900,
    addEventListener() {},
    visualViewport: { height: null, addEventListener() {} },
  };
  const consoleMock = { ...console, warn() {} };
  windowTarget.RagentLayout = {
    getViewportHeight() { return 900; },
    subscribe() { return () => {}; },
  };
  const context = {
    console: consoleMock,
    msgInput,
    inputArea: { style: {}, classList: makeClassList(), getBoundingClientRect() { return { height: 72 }; } },
    inputResizeHandle: makeEventTarget(),
    currentSessionId: 'session-a',
    localStorage,
    window: windowTarget,
    getComputedStyle() { return { lineHeight: '24' }; },
    requestAnimationFrame(callback) { callback(); },
    cancelBtn: makeEventTarget(),
    compactBtn: makeEventTarget(),
    dropToolsBtn: makeEventTarget(),
    sendBtn: makeEventTarget(),
    composerPendingState: makeEventTarget(),
    sessionTemplateSelect: makeEventTarget(),
    saveTemplateBtn: makeEventTarget(),
    tabSessions: makeEventTarget(),
    sortSessionListBtn: makeEventTarget(),
    newSessionBtn: makeEventTarget(),
    settingsPanel: { classList: { toggle() {} } },
    sessionList: { style: {} },
    sidebarOverlay: makeEventTarget(),
    pendingNavigationState: {},
    ACTIVE_SIDEBAR_TAB_STORAGE_KEY: 'activeSidebarTab',
    normalizeSidebarTab(value) { return value === 'settings' || value === 'progress' ? 'settings' : 'sessions'; },
    syncBrowserState() {},
    pendingImages: [],
    getCurrentSession() { return session || { archived: false }; },
    createRequestId() { return 'req_test'; },
    visitorMode: false,
    isDesktop: true,
    selectedTool: null,
    selectedModel: null,
    currentToolReasoningKind: 'toggle',
    selectedEffort: null,
    selectedPermissionMode: null,
    thinkingEnabled: true,
    renderImagePreviews() {},
    fetchJsonOrRedirect() { throw new Error('Unexpected fetchJsonOrRedirect call'); },
    dispatchAction: async () => true,
    emptyState: { parentNode: null, remove() {} },
    messagesInner: { appendChild() {}, innerHTML: '', children: [] },
    appendMessageTimestamp() {},
    scrollToBottom() {},
    focusComposer() { return true; },
    URL: { revokeObjectURL() {} },
    document,
    insertComposerLocalEcho: track('insertComposerLocalEcho'),
    refreshCurrentSession: track('refreshCurrentSession'),
    syncComposerPendingTurnFeedback() {},
    findCommittedUserMessageNode() { return null; },
    findLocalEchoUserMessageNode() { return null; },
  };
  context.globalThis = context;
  return { context, calls };
}

function loadComposeContext(context) {
  vm.runInNewContext(composerStoreSource, context, { filename: 'static/chat/composer-store.js' });
  vm.runInNewContext(composeSource, context, { filename: 'static/chat/compose.js' });
  return context;
}

const busySession = {
  id: 'session-a',
  archived: false,
  activity: { run: { state: 'running', phase: 'running', runId: 'run-1' }, queue: { state: 'idle', count: 0 } },
};
const acceptedSession = {
  id: 'session-a',
  archived: false,
  activity: { run: { state: 'accepted', phase: 'accepted', runId: 'run-1' }, queue: { state: 'idle', count: 0 } },
};
const queuedSession = {
  id: 'session-a',
  archived: false,
  activity: { run: { state: 'idle' }, queue: { state: 'queued', count: 2 } },
};
const planningSession = {
  id: 'session-a',
  archived: false,
  activity: { run: { state: 'idle' }, planning: { state: 'checking', count: 1 } },
};
const compactSession = {
  id: 'session-a',
  archived: false,
  activity: { run: { state: 'idle' }, compact: { state: 'pending' } },
};
const idleSession = {
  id: 'session-a',
  archived: false,
  activity: { run: { state: 'idle' }, queue: { state: 'idle', count: 0 } },
};

function main() {
  // 1. composerSendWillQueue mirrors the server's queue condition.
  const { context } = createContext();
  loadComposeContext(context);
  assert.equal(context.composerSendWillQueue(busySession), true, 'running session queues the send');
  assert.equal(context.composerSendWillQueue(acceptedSession), true, 'accepted-phase session queues the send');
  assert.equal(context.composerSendWillQueue(queuedSession), true, 'non-empty queue queues the send');
  assert.equal(context.composerSendWillQueue(planningSession), true, 'planning-checking parks the send');
  assert.equal(context.composerSendWillQueue(compactSession), true, 'pending compaction queues the send');
  assert.equal(context.composerSendWillQueue(idleSession), false, 'idle session sends directly');
  assert.equal(context.composerSendWillQueue(null), false, 'no session never queues');
  assert.equal(
    context.composerSendWillQueue({ id: 'x', activity: { run: { state: 'completed' } } }),
    false,
    'completed run does not queue',
  );

  // 2. sendMessage skips the optimistic echo when the session is busy.
  const busyHarness = createContext({ session: busySession });
  loadComposeContext(busyHarness.context);
  busyHarness.context.msgInput.value = '排队消息';
  busyHarness.context.sendMessage();
  assert.equal(
    busyHarness.calls.filter((c) => c.name === 'insertComposerLocalEcho').length,
    0,
    'busy session: no optimistic echo bubble flashes before the queue ACK',
  );

  const idleHarness = createContext({ session: idleSession });
  loadComposeContext(idleHarness.context);
  idleHarness.context.msgInput.value = '直接发送';
  idleHarness.context.sendMessage();
  assert.equal(
    idleHarness.calls.filter((c) => c.name === 'insertComposerLocalEcho').length,
    1,
    'idle session: optimistic echo still appears',
  );

  // 3. finalizeComposerPendingSend: missing committed bubble triggers exactly
  // one events refresh so the bubble appears without a manual reload.
  const flushHarness = createContext({ session: idleSession });
  loadComposeContext(flushHarness.context);
  flushHarness.context.setComposerPendingSendState({
    sessionId: 'session-a',
    requestId: 'req-flush',
    text: '已发送但没渲染',
    images: [],
    startedAt: new Date().toISOString(),
    stage: 'processing',
  });
  flushHarness.context.finalizeComposerPendingSend('req-flush');
  const refreshCalls = flushHarness.calls.filter((c) => c.name === 'refreshCurrentSession');
  assert.equal(refreshCalls.length, 1, 'missing committed bubble triggers one refresh');
  // A second finalize for the same requestId (same snapshot absent) must not loop.
  flushHarness.context.setComposerPendingSendState({
    sessionId: 'session-a',
    requestId: 'req-flush',
    text: '已发送但没渲染',
    images: [],
    startedAt: new Date().toISOString(),
    stage: 'processing',
  });
  flushHarness.context.finalizeComposerPendingSend('req-flush');
  assert.equal(
    flushHarness.calls.filter((c) => c.name === 'refreshCurrentSession').length,
    1,
    'refresh stays one-shot per requestId',
  );

  // 4. A finalize with the committed bubble already rendered needs no refresh.
  const renderedHarness = createContext({ session: idleSession });
  loadComposeContext(renderedHarness.context);
  renderedHarness.context.findCommittedUserMessageNode = () => ({ requestId: 'req-ok' });
  renderedHarness.context.setComposerPendingSendState({
    sessionId: 'session-a',
    requestId: 'req-ok',
    text: '已渲染',
    images: [],
    startedAt: new Date().toISOString(),
    stage: 'processing',
  });
  renderedHarness.context.finalizeComposerPendingSend('req-ok');
  assert.equal(
    renderedHarness.calls.filter((c) => c.name === 'refreshCurrentSession').length,
    0,
    'committed bubble present: no refresh needed',
  );

  console.log('test-chat-send-busy-queue: PASS');
}

main();
