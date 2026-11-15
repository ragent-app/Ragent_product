#!/usr/bin/env node
// Behavioral contract for the send-time atomic flush (P1-9 jump fix):
// 1. sendMessage clears the textarea synchronously (optimistic clear) and
//    collapses the composer height in the same synchronous block as the
//    local echo insert, so the browser paints once at the new bottom
//    instead of twice (send + ACK) with a visible jump between.
// 2. The viewport pin goes through scrollToBottom({ immediate: true }) —
//    no rAF hop — so the pin lands in the same frame as the clear.
// 3. On ACK, clearComposerAcceptedSendArtifacts only clears a composer that
//    still holds the sent text (or is already empty): a next-message draft
//    typed during the round-trip survives.
// 4. Failed sends still refill the textarea via restoreFailedSendState.
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
    add(...tokens) {
      tokens.forEach((token) => values.add(token));
    },
    remove(...tokens) {
      tokens.forEach((token) => values.delete(token));
    },
    toggle(token, force) {
      if (typeof force === 'boolean') {
        if (force) values.add(token);
        else values.delete(token);
        return force;
      }
      if (values.has(token)) {
        values.delete(token);
        return false;
      }
      values.add(token);
      return true;
    },
    contains(token) {
      return values.has(token);
    },
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
    setAttribute(name, value) {
      this[name] = value;
    },
    removeAttribute(name) {
      delete this[name];
    },
    classList: makeClassList(),
  };
}

function createContext({
  storageSeed = {},
  chromeHeight = 48,
  windowInnerHeight = 900,
  visualViewportHeight = null,
} = {}) {
  const localStorage = new StorageMock();
  Object.entries(storageSeed).forEach(([key, value]) => {
    localStorage.setItem(key, value);
  });

  const inputAreaClassList = makeClassList();
  // scrollHeight is dynamic: a multi-line draft measures tall, an empty
  // textarea collapses back to its intrinsic minimum.
  let inputValue = '';
  const msgInput = {
    get value() {
      return inputValue;
    },
    set value(next) {
      inputValue = String(next);
    },
    get scrollHeight() {
      return inputValue ? 600 : 12;
    },
    style: { height: '' },
    readOnly: false,
    addEventListener() {},
    focus() {},
    getBoundingClientRect() {
      // 24px = single-line minimum (INPUT_MIN_LINES=1 since 02705ce).
      return { height: parseFloat(this.style.height) || 24 };
    },
  };
  const inputArea = {
    style: {},
    classList: inputAreaClassList,
    getBoundingClientRect() {
      return {
        height: (parseFloat(msgInput.style.height) || 24) + chromeHeight,
      };
    },
  };
  const document = {
    body: {
      classList: makeClassList(),
    },
    addEventListener() {},
    removeEventListener() {},
    getElementById(id) {
      return null;
    },
    createElement() {
      return {
        appendChild() {},
        remove() {},
        className: '',
        id: '',
        textContent: '',
        innerHTML: '',
        style: {},
      };
    },
  };
  const windowResizeListeners = [];
  const visualViewportResizeListeners = [];
  const layoutSubscribers = [];
  const windowTarget = {
    innerHeight: windowInnerHeight,
    addEventListener(type, listener) {
      if (type === 'resize') windowResizeListeners.push(listener);
    },
    visualViewport: {
      height: visualViewportHeight,
      addEventListener(type, listener) {
        if (type === 'resize') visualViewportResizeListeners.push(listener);
      },
    },
  };
  const focusComposerCalls = [];
  const consoleMock = { ...console, warn() {} };
  const agentoCLayout = {
    getViewportHeight() {
      const managedHeight = windowTarget.visualViewport?.height;
      if (Number.isFinite(managedHeight) && managedHeight > 0) {
        return managedHeight;
      }
      return windowTarget.innerHeight || 0;
    },
    subscribe(listener) {
      layoutSubscribers.push(listener);
      return () => {};
    },
  };
  windowTarget.RagentLayout = agentoCLayout;
  const context = {
    console: consoleMock,
    msgInput,
    inputArea,
    inputResizeHandle: makeEventTarget(),
    focusComposerCalls,
    pendingTurnFeedbackSyncs: 0,
    layoutSubscribers,
    windowResizeListeners,
    visualViewportResizeListeners,
    currentSessionId: 'session-a',
    localStorage,
    window: windowTarget,
    getComputedStyle() {
      return { lineHeight: '24' };
    },
    requestAnimationFrame(callback) {
      callback();
    },
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
    settingsPanel: {
      classList: {
        toggle() {},
      },
    },
    sessionList: { style: {} },
    sidebarOverlay: makeEventTarget(),
    pendingNavigationState: {},
    ACTIVE_SIDEBAR_TAB_STORAGE_KEY: 'activeSidebarTab',
    normalizeSidebarTab(value) {
      return value === 'settings' || value === 'progress' ? 'settings' : 'sessions';
    },
    syncBrowserState() {},
    pendingImages: [],
    getCurrentSession() {
      return { archived: false };
    },
    createRequestId() {
      return 'req_test';
    },
    visitorMode: false,
    isDesktop: true,
    selectedTool: null,
    selectedModel: null,
    currentToolReasoningKind: 'toggle',
    selectedEffort: null,
    selectedPermissionMode: null,
    thinkingEnabled: true,
    renderImagePreviews() {},
    fetchJsonOrRedirect() {
      throw new Error('Unexpected fetchJsonOrRedirect call');
    },
    dispatchAction() {},
    emptyState: { parentNode: null, remove() {} },
    messagesInner: { appendChild() {}, innerHTML: '', children: [] },
    appendMessageTimestamp() {},
    scrollToBottom() {},
    // Direction-4 stubs: a send is a fresh user intent, so the send-time pin
    // must release any active history-restore anchor lock first (otherwise the
    // lock's per-frame restore would fight the pin for ~8 frames).
    anchorLockClears: 0,
    clearMessageViewportAnchorLock() {
      context.anchorLockClears += 1;
    },
    hasActiveMessageViewportAnchorLock() {
      return context.anchorLockActive === true;
    },
    focusComposer(options) {
      focusComposerCalls.push(options ?? null);
      msgInput.focus(options);
      return true;
    },
    URL: {
      revokeObjectURL() {},
    },
    document,
  };
  context.syncComposerPendingTurnFeedback = () => {
    context.pendingTurnFeedbackSyncs += 1;
  };
  context.globalThis = context;
  return context;
}

function loadComposeContext(context) {
  vm.runInNewContext(composerStoreSource, context, { filename: 'static/chat/composer-store.js' });
  vm.runInNewContext(composeSource, context, { filename: 'static/chat/compose.js' });
  return context;
}

// --- Case 1: send-time optimistic clear + atomic flush ---
{
  const ctx = createContext();
  const scrollCalls = [];
  const echoSawEmptyValues = [];
  ctx.scrollToBottom = (opts) => scrollCalls.push(opts);
  ctx.insertComposerLocalEcho = (opts) => {
    echoSawEmptyValues.push(ctx.msgInput.value);
    return true;
  };
  ctx.dispatchAction = async () => true;
  loadComposeContext(ctx);

  // Multi-line draft: textarea is explicitly expanded above its minimum.
  ctx.msgInput.value = '第一行\n第二行\n第三行\n第四行\n第五行\n第六行\n第七行';
  ctx.msgInput.style.height = '240px';
  ctx.sendMessage();

  assert.equal(ctx.msgInput.value, '', 'send should clear the textarea synchronously (no ACK wait)');
  assert.equal(ctx.msgInput.style.height, '24px', 'send should collapse the composer to its single-line minimum in the same block');
  // vm realms produce cross-realm object prototypes, so compare properties
  // instead of deepStrictEqual against a host-side literal.
  assert.equal(scrollCalls.length, 1, 'send should pin the viewport exactly once');
  assert.equal(scrollCalls[0]?.immediate, true, 'send should pin the viewport with immediate scrollToBottom (no rAF hop)');
  assert.equal(typeof scrollCalls[0]?.minScrollTop, 'undefined', 'send-time pin should not carry a stale minScrollTop guard');
  assert.equal(echoSawEmptyValues.length, 1, 'local echo should still be inserted at send time');
  assert.equal(echoSawEmptyValues[0], '', 'local echo should be inserted after the optimistic clear, in the same synchronous block');
  assert.equal(ctx.getComposerPendingSendState()?.stage, 'sending', 'pending send state should be recorded before the async dispatch');
  assert.equal(ctx.msgInput.readOnly, true, 'composer should lock while the send is pending');
}

// --- Case 1b: send releases an active history-restore anchor lock ---
{
  const ctx = createContext();
  const scrollCalls = [];
  ctx.scrollToBottom = (opts) => scrollCalls.push(opts);
  ctx.dispatchAction = async () => true;
  ctx.anchorLockActive = true;
  loadComposeContext(ctx);

  ctx.msgInput.value = '锁中发送';
  ctx.sendMessage();

  assert.equal(ctx.anchorLockClears, 1, 'send should release an active anchor lock (fresh user intent)');
  assert.equal(scrollCalls.length, 1, 'send should still pin the viewport exactly once');
  assert.equal(scrollCalls[0]?.immediate, true, 'the pin should stay immediate after releasing the lock');

  // Without a lock the clear path must stay a no-op.
  const ctx2 = createContext();
  const scrollCalls2 = [];
  ctx2.scrollToBottom = (opts) => scrollCalls2.push(opts);
  ctx2.dispatchAction = async () => true;
  ctx2.anchorLockActive = false;
  loadComposeContext(ctx2);
  ctx2.msgInput.value = '无锁发送';
  ctx2.sendMessage();
  assert.equal(ctx2.anchorLockClears, 0, 'send without a lock should not call clearMessageViewportAnchorLock');
  assert.equal(scrollCalls2.length, 1, 'the no-lock send should still pin exactly once');
}

// --- Case 2: ACK must not wipe a next-message draft typed during the round-trip ---
{
  const ctx = createContext();
  ctx.dispatchAction = async () => true;
  loadComposeContext(ctx);
  ctx.msgInput.value = '原文内容';
  ctx.sendMessage();
  ctx.msgInput.value = '发送后立刻打的新草稿';
  ctx.acknowledgeComposerPendingSend('req_test', { nextStage: 'processing' });
  assert.equal(ctx.msgInput.value, '发送后立刻打的新草稿', 'ACK must not wipe a draft typed during the round-trip');
}

// --- Case 3: ACK on an already-empty composer stays idempotent ---
{
  const ctx = createContext();
  ctx.dispatchAction = async () => true;
  loadComposeContext(ctx);
  ctx.msgInput.value = '已发送文本';
  ctx.sendMessage();
  assert.equal(ctx.msgInput.value, '', 'composer should already be empty after the optimistic clear');
  ctx.acknowledgeComposerPendingSend('req_test', { nextStage: 'processing' });
  assert.equal(ctx.msgInput.value, '', 'ACK clear on an already-empty composer should be a no-op');
  assert.equal(ctx.msgInput.style.height, '24px', 'ACK re-collapse on an already-empty composer should not regrow the textarea');
}

// --- Case 4: ACK on a composer still holding the sent text re-clears it ---
{
  const ctx = createContext();
  ctx.dispatchAction = async () => true;
  loadComposeContext(ctx);
  ctx.msgInput.value = '原文内容';
  ctx.sendMessage();
  // Simulate a path that restored the sent text into the textarea (e.g. a
  // draft rehydration) before the ACK arrives.
  ctx.msgInput.value = '原文内容';
  ctx.acknowledgeComposerPendingSend('req_test', { nextStage: 'processing' });
  assert.equal(ctx.msgInput.value, '', 'ACK should clear a composer that still holds the exact sent text');
}

// --- Case 5: failed send refills the textarea ---
{
  const ctx = createContext();
  ctx.dispatchAction = async () => true;
  loadComposeContext(ctx);
  ctx.msgInput.value = '会失败的内容';
  ctx.sendMessage();
  assert.equal(ctx.msgInput.value, '', 'send-time clear applies before failure');
  ctx.restoreFailedSendState('session-a', '会失败的内容', [], 'req_test');
  assert.equal(ctx.msgInput.value, '会失败的内容', 'failed sends should refill the textarea for retry');
  assert.equal(ctx.msgInput.readOnly, false, 'failed sends should unlock the composer');
}

// --- Case 6: terminal completion retains an uncommitted echo until refresh ---
{
  const ctx = createContext();
  loadComposeContext(ctx);
  const echo = {};
  const marked = [];
  let refreshes = 0;
  ctx.findCommittedUserMessageNode = () => null;
  ctx.findLocalEchoUserMessageNode = () => echo;
  ctx.markLocalEchoAwaitingCommit = (requestId) => {
    marked.push(requestId);
    return true;
  };
  ctx.refreshCurrentSession = () => {
    refreshes += 1;
    return Promise.resolve();
  };
  ctx.setComposerPendingSendState({
    sessionId: 'session-a',
    requestId: 'req-retain',
    text: '暂未到达的已发送消息',
    images: [],
    startedAt: new Date().toISOString(),
    stage: 'processing',
  });
  ctx.finalizeComposerPendingSend('req-retain');
  assert.deepEqual(marked, ['req-retain'], 'an uncommitted echo should enter the sent-looking retention state');
  assert.equal(refreshes, 1, 'missing committed content should trigger one recovery refresh even when the echo exists');
  assert.equal(ctx.getComposerPendingSendSnapshot(), null, 'retention must not leave the composer locked');
}

console.log('test-chat-send-flush-atomic: ok');
