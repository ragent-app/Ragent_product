#!/usr/bin/env node
// Behavioral contract for the optimistic send echo: created at send time,
// kept and status-advanced while uncommitted, upgraded in place to the
// committed identity when the server echoes the user turn back (the element
// survives so the launch animation is never cancelled mid-flight), removed on
// failure/cleanup.
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

function createNode(tag = 'div') {
  const node = {
    tagName: String(tag).toUpperCase(),
    className: '',
    children: [],
    parentNode: null,
    dataset: {},
    textContent: '',
    get isConnected() {
      return !!node.parentNode;
    },
    get innerHTML() {
      return node._innerHTML || '';
    },
    set innerHTML(value) {
      node._innerHTML = String(value ?? '');
      if (node._innerHTML === '') {
        for (const child of node.children) child.parentNode = null;
        node.children = [];
      }
    },
    classList: {
      _set: new Set(),
      _sync() {
        for (const cls of String(node.className).split(' ').filter(Boolean)) this._set.add(cls);
      },
      add(...names) {
        this._sync();
        for (const name of names) this._set.add(name);
        node.className = [...this._set].join(' ');
      },
      remove(...names) {
        this._sync();
        for (const name of names) this._set.delete(name);
        node.className = [...this._set].join(' ');
      },
      contains(name) {
        this._sync();
        return this._set.has(name);
      },
      toggle(name, force) {
        this._sync();
        const on = force === undefined ? !this._set.has(name) : !!force;
        if (on) this._set.add(name);
        else this._set.delete(name);
        node.className = [...this._set].join(' ');
        return on;
      },
    },
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    insertBefore(child, reference) {
      child.parentNode = this;
      const index = this.children.indexOf(reference);
      if (index < 0) this.children.push(child);
      else this.children.splice(index, 0, child);
      return child;
    },
    append(...children) {
      for (const child of children) this.appendChild(child);
    },
    replaceChildren(...next) {
      for (const child of this.children) child.parentNode = null;
      this.children = [];
      for (const child of next) this.appendChild(child);
    },
    remove() {
      if (!this.parentNode) return;
      const index = this.parentNode.children.indexOf(this);
      if (index >= 0) this.parentNode.children.splice(index, 1);
      this.parentNode = null;
    },
    hasClass(name) {
      return ` ${this.className} `.includes(` ${name} `);
    },
    setAttribute(name, value) {
      this.dataset[name] = value;
    },
    getAttribute(name) {
      return this.dataset[name] || null;
    },
    removeAttribute(name) {
      delete this.dataset[name];
    },
    addEventListener() {},
    removeEventListener() {},
    querySelector(selector) {
      if (selector === '.msg-meta' || selector === '.msg-timestamp' || selector.startsWith(':scope > .msg-meta')) {
        return null;
      }
      if (selector.startsWith('.')) {
        return this.querySelectorAll(selector)[0] || null;
      }
      return null;
    },
    querySelectorAll(selector) {
      const results = [];
      const selectorMatch = /^\.([^\[]+)(?:\[data-([^=\]]+)(?:="([^"]*)")?\])?$/.exec(selector);
      const walk = (node) => {
        for (const child of node.children || []) {
          const matchesClass = selectorMatch
            ? child.hasClass(selectorMatch[1])
            : selector.startsWith('.') && child.hasClass(selector.slice(1));
          const dataKey = selectorMatch?.[2]
            ? selectorMatch[2].replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())
            : '';
          const matchesData = !dataKey
            || Object.prototype.hasOwnProperty.call(child.dataset, dataKey)
            && (!selectorMatch[3] || String(child.dataset[dataKey]) === selectorMatch[3]);
          if (matchesClass && matchesData) results.push(child);
          walk(child);
        }
      };
      walk(this);
      return results;
    },
  };
  return node;
}

function createHarness() {
  const source = readFileSync(join(repoRoot, 'static/chat/realtime-render.js'), 'utf8')
    + '\n'
    + readFileSync(join(repoRoot, 'static/chat/ui.js'), 'utf8');
  const messagesInner = createNode('div');
  const emptyState = createNode('div');
  emptyState.parentNode = messagesInner;
  const pendingState = { value: null };
  const retainedState = { value: [] };
  // Scroll-to-latest FAB is enhancement-only chrome; a no-op stub keeps the
  // harness from crashing while exercising the realtime-render script.
  const fab = {
    classList: {
      add() {},
      remove() {},
      contains() { return false; },
      toggle() {},
    },
    addEventListener() {},
  };
  const context = {
    console,
    window: {},
    ragentT(key) {
      return key === 'message.sendStatus.sending' ? 'sending' : key;
    },
    document: {
      createElement: (tag) => createNode(tag),
      getElementById: (id) => (id === 'scrollToBottomFab' ? fab : null),
    },
    performance: { now: () => Date.now() },
    requestAnimationFrame(cb) { return setTimeout(cb, 0); },
    cancelAnimationFrame(id) { clearTimeout(id); },
    setTimeout,
    clearTimeout,
    messagesInner,
    emptyState,
    messagesEl: {
      scrollHeight: 0,
      scrollTop: 0,
      clientHeight: 0,
      addEventListener() {},
    },
    currentSessionId: 'session-test',
    inThinkingBlock: false,
    currentThinkingBlock: null,
    renderedEventState: {},
    getComposerPendingSendSnapshot() {
      return pendingState.value;
    },
    getComposerRetainedSendsState(sessionId = '') {
      return retainedState.value.filter((entry) => !sessionId || entry.sessionId === sessionId);
    },
    getComposerRetainedSendState(requestId = '') {
      return retainedState.value.find((entry) => entry.requestId === requestId) || null;
    },
    setComposerRetainedSendState(entry) {
      retainedState.value = retainedState.value.filter((item) => item.requestId !== entry.requestId).concat(entry);
    },
    patchComposerRetainedSendState(requestId, patch) {
      retainedState.value = retainedState.value.map((entry) =>
        entry.requestId === requestId ? { ...entry, ...patch } : entry);
    },
    clearComposerRetainedSendState(requestId) {
      retainedState.value = retainedState.value.filter((entry) => entry.requestId !== requestId);
    },
    scrollToBottom() {},
    syncEditableMessageActions() {},
    appendMessageMeta() {},
    appendMessageTimestamp() {},
    renderQueuedMessagePanel() {},
    resetRenderedEventState() {},
    syncSessionTemplateControls() {},
    syncForkButton() {},
    syncShareButton() {},
    shouldAutoScrollMessages() { return false; },
    shouldCompactMobileThinking() { return false; },
    renderMessageInto() { return null; },
    annotateRenderedEventViewportNodes() {},
    movePlanProgressCardToEnd() {},
    renderOperation() {},
    applyFinishedTurnCollapseState() {},
  };
  context.window = context;
  context.window.RagentRunActivity = {
    noteFormalOutput() {},
    applyEvent() {},
  };
  vm.createContext(context);
  vm.runInContext(`${source}\nthis.__echoApi = { insertComposerLocalEcho, syncComposerPendingTurnFeedback, markLocalEchoAwaitingCommit, createUserMessageNode, renderMessageInto, clearMessages, collectComposerEchoesForRefresh };`, context);
  return {
    messagesInner,
    setPending(snapshot) {
      pendingState.value = snapshot;
    },
    setRetained(entries) {
      retainedState.value = Array.isArray(entries) ? entries.slice() : [];
    },
    setCurrentSessionId(sessionId) {
      context.currentSessionId = sessionId;
    },
    insertComposerLocalEcho: context.__echoApi.insertComposerLocalEcho,
    syncComposerPendingTurnFeedback: context.__echoApi.syncComposerPendingTurnFeedback,
    markLocalEchoAwaitingCommit: context.__echoApi.markLocalEchoAwaitingCommit,
    createUserMessageNode: context.__echoApi.createUserMessageNode,
    renderMessageInto: context.__echoApi.renderMessageInto,
    clearMessages: context.__echoApi.clearMessages,
    collectComposerEchoesForRefresh: context.__echoApi.collectComposerEchoesForRefresh,
  };
}

function findEcho(harness) {
  return harness.messagesInner.querySelectorAll('.msg-user')
    .find((node) => node.hasClass('msg-user-local-echo')) || null;
}

function findCommitted(harness) {
  return harness.messagesInner.querySelectorAll('.msg-user')
    .find((node) => !node.hasClass('msg-user-local-echo')) || null;
}

function findByRequestId(harness, requestId) {
  return harness.messagesInner.querySelectorAll('.msg-user')
    .find((node) => node.dataset.requestId === requestId) || null;
}

function hasStatusRow(node) {
  return !!node.querySelector('.msg-user-status');
}

function getSendStatus(node) {
  return node.querySelector('.msg-user-send-status');
}

{
  const harness = createHarness();
  harness.setPending({
    sessionId: 'session-test',
    requestId: 'req-1',
    text: '继续处理',
    images: [],
    stage: 'sending',
  });
  assert.equal(
    harness.insertComposerLocalEcho({ requestId: 'req-1', text: '继续处理', sessionId: 'session-test' }),
    true,
    'echo insertion should succeed for the pending request',
  );
  const echo = findEcho(harness);
  assert.ok(echo, 'send should create a visible optimistic echo bubble');
  assert.equal(echo.dataset.requestId, 'req-1', 'echo should carry the send request id');
  assert.equal(hasStatusRow(echo), false, 'echo bubble should carry no inline sending/status text');
  const sendStatus = getSendStatus(echo);
  assert.ok(sendStatus, 'sending feedback should render outside the bubble');
  assert.equal(sendStatus.textContent, 'sending', 'sending feedback should use the localized short label');
  assert.equal(echo.children.at(-1), sendStatus, 'sending feedback should sit below the bubble');
  assert.equal(harness.messagesInner.querySelectorAll('.msg-user').length, 1, 'exactly one user node before commit');
}

{
  const harness = createHarness();
  harness.setPending({
    sessionId: 'session-test',
    requestId: 'req-2',
    text: '改一下格式',
    images: [],
    stage: 'checking',
  });
  harness.insertComposerLocalEcho({ requestId: 'req-2', text: '改一下格式', sessionId: 'session-test' });
  harness.syncComposerPendingTurnFeedback();
  const echo = findEcho(harness);
  assert.ok(echo, 'pending-turn sync must keep the uncommitted echo');
  assert.equal(hasStatusRow(echo), false, 'sync must not reintroduce status text on the echo');
  assert.equal(getSendStatus(echo), null, 'sending feedback should clear once the send leaves the sending stage');
}

{
  const harness = createHarness();
  harness.setPending({
    sessionId: 'session-test',
    requestId: 'req-3',
    text: '完成之后告诉我',
    images: [],
    stage: 'processing',
  });
  harness.insertComposerLocalEcho({ requestId: 'req-3', text: '完成之后告诉我', sessionId: 'session-test' });
  // Server echoes the user turn back: a committed node for the same request id appears.
  const committed = harness.createUserMessageNode({ requestId: 'req-3', content: '完成之后告诉我' });
  harness.messagesInner.appendChild(committed);
  harness.syncComposerPendingTurnFeedback();
  assert.equal(findEcho(harness), null, 'the committed node should replace the echo');
  const kept = findCommitted(harness);
  assert.ok(kept, 'the server-committed node should remain');
  assert.equal(hasStatusRow(kept), false, 'committed node should carry no inline status text either');
}

{
  const harness = createHarness();
  harness.setPending({
    sessionId: 'session-test',
    requestId: 'req-4',
    text: '临时内容',
    images: [],
    stage: 'sending',
  });
  harness.insertComposerLocalEcho({ requestId: 'req-4', text: '临时内容', sessionId: 'session-test' });
  assert.ok(findEcho(harness), 'echo visible while pending');
  harness.setPending(null);
  harness.syncComposerPendingTurnFeedback();
  assert.equal(findEcho(harness), null, 'failure/cleanup should remove the echo');
}

{
  // A terminal state can arrive before the persisted user event. The echo is
  // promoted to a sent-looking placeholder and must stay visible until the
  // committed render can replace it.
  const harness = createHarness();
  harness.setPending({
    sessionId: 'session-test',
    requestId: 'req-retain',
    text: '等待服务端确认',
    images: [],
    stage: 'processing',
  });
  harness.insertComposerLocalEcho({ requestId: 'req-retain', text: '等待服务端确认', sessionId: 'session-test' });
  assert.equal(harness.markLocalEchoAwaitingCommit('req-retain'), true, 'the echo should enter the awaiting-commit state');
  harness.setPending(null);
  harness.syncComposerPendingTurnFeedback();
  const retained = findEcho(harness);
  assert.ok(retained, 'cleanup must not remove an echo awaiting its committed event');
  assert.equal(retained.dataset.sendAwaitingCommit, 'true');
  assert.equal(retained.dataset.sendStage, 'sent');
  assert.equal(retained.querySelector('.msg-user-bubble').classList.contains('msg-pending'), false);
  assert.equal(getSendStatus(retained), null, 'awaiting-commit state should not retain sending feedback');

  const committed = harness.renderMessageInto(harness.messagesInner, {
    type: 'message',
    role: 'user',
    requestId: 'req-retain',
    content: '等待服务端确认',
  });
  assert.ok(committed, 'the delayed committed message should render');
  assert.equal(findEcho(harness), null, 'the committed render should atomically replace the retained echo');
  assert.equal(harness.messagesInner.querySelectorAll('.msg-user').length, 1);
}

{
  // Committed render swaps the echo in the same frame: the canvas never shows
  // echo + committed simultaneously, and the committed bubble skips the
  // fade-in slide (the source of the "sending jitter" position jump).
  const harness = createHarness();
  harness.setPending({
    sessionId: 'session-test',
    requestId: 'req-5',
    text: '同帧换回',
    images: [],
    stage: 'processing',
  });
  harness.insertComposerLocalEcho({ requestId: 'req-5', text: '同帧换回', sessionId: 'session-test' });
  const echoBefore = findEcho(harness);
  assert.ok(echoBefore, 'echo visible before the committed render');
  const committed = harness.renderMessageInto(harness.messagesInner, {
    type: 'message',
    role: 'user',
    requestId: 'req-5',
    content: '同帧换回',
  });
  assert.ok(committed, 'committed user bubble renders');
  assert.equal(committed, echoBefore, 'commit upgrades the echo element in place — the launch animation element never changes identity');
  assert.equal(findEcho(harness), null, 'committed render clears the echo state in the same frame');
  assert.equal(committed.hasClass('msg-user-local-echo'), false, 'upgraded bubble no longer carries the echo class');
  assert.equal(committed.dataset.sendStage, undefined, 'upgraded bubble drops the sending stage marker');
  assert.equal(committed.dataset.sendAwaitingCommit, undefined, 'upgraded bubble drops the awaiting-commit marker');
  assert.equal(harness.messagesInner.querySelectorAll('.msg-user').length, 1, 'never both echo and committed');
}

{
  // A second send replaces the singular transport pending state, but must not
  // make the first optimistic bubble eligible for the cleanup pass.
  const harness = createHarness();
  harness.setPending({
    sessionId: 'session-test',
    requestId: 'req-older',
    text: '第一条消息',
    images: [],
    stage: 'processing',
  });
  harness.setRetained([
    {
      sessionId: 'session-test',
      requestId: 'req-older',
      text: '第一条消息',
      images: [],
      stage: 'processing',
      localEcho: true,
    },
  ]);
  harness.insertComposerLocalEcho({ requestId: 'req-older', text: '第一条消息', sessionId: 'session-test' });

  harness.setPending({
    sessionId: 'session-test',
    requestId: 'req-newer',
    text: '第二条消息',
    images: [],
    stage: 'processing',
  });
  harness.setRetained([
    {
      sessionId: 'session-test',
      requestId: 'req-older',
      text: '第一条消息',
      images: [],
      stage: 'processing',
      localEcho: true,
    },
    {
      sessionId: 'session-test',
      requestId: 'req-newer',
      text: '第二条消息',
      images: [],
      stage: 'processing',
      localEcho: true,
    },
  ]);
  harness.insertComposerLocalEcho({ requestId: 'req-newer', text: '第二条消息', sessionId: 'session-test' });
  harness.syncComposerPendingTurnFeedback();
  assert.ok(findByRequestId(harness, 'req-older'), 'the older echo must survive a later pending-send replacement');
  assert.ok(findByRequestId(harness, 'req-newer'), 'the current echo must remain visible too');

  const committedOlder = harness.renderMessageInto(harness.messagesInner, {
    type: 'message',
    role: 'user',
    requestId: 'req-older',
    content: '第一条消息',
  });
  assert.ok(committedOlder, 'the delayed canonical event should render');
  assert.equal(findByRequestId(harness, 'req-older')?.hasClass('msg-user-local-echo'), false);
  assert.ok(findByRequestId(harness, 'req-newer'), 'committing one request must not remove a newer outbound echo');
}

{
  // ACK, websocket replay, and a full refresh may all deliver the same
  // committed request. Once the canonical node exists, later deliveries must
  // reuse it instead of appending another bubble.
  const harness = createHarness();
  harness.insertComposerLocalEcho({ requestId: 'req-duplicate', text: '只显示一次', sessionId: 'session-test' });
  const first = harness.renderMessageInto(harness.messagesInner, {
    type: 'message',
    role: 'user',
    requestId: 'req-duplicate',
    content: '只显示一次',
  });
  const second = harness.renderMessageInto(harness.messagesInner, {
    type: 'message',
    role: 'user',
    requestId: 'req-duplicate',
    content: '只显示一次',
  });
  assert.equal(second, first, 'a duplicate committed event should reuse the canonical node');
  assert.equal(harness.messagesInner.querySelectorAll('.msg-user').length, 1,
    'duplicate committed deliveries must leave one user bubble');
}

{
  // requestId is scoped to a session. A matching id from another session must
  // not suppress or replace the currently rendered session's message.
  const harness = createHarness();
  harness.insertComposerLocalEcho({ requestId: 'req-cross-session', text: '会话一', sessionId: 'session-test' });
  harness.renderMessageInto(harness.messagesInner, {
    type: 'message',
    role: 'user',
    requestId: 'req-cross-session',
    content: '会话一',
  });
  harness.setCurrentSessionId('session-other');
  const other = harness.renderMessageInto(harness.messagesInner, {
    type: 'message',
    role: 'user',
    requestId: 'req-cross-session',
    content: '会话二',
  });
  assert.ok(other, 'the same requestId in another session should render independently');
  assert.equal(harness.messagesInner.querySelectorAll('.msg-user').length, 2,
    'session-scoped request ids must not cross-deduplicate');
  assert.deepEqual(
    [...harness.messagesInner.querySelectorAll('.msg-user')].map((node) => node.dataset.sessionId),
    ['session-test', 'session-other'],
  );
}

{
  // A full transcript reset with an empty/old response must keep a retained
  // echo in place; the later canonical event then replaces it exactly once.
  const harness = createHarness();
  harness.setPending(null);
  harness.setRetained([{
    sessionId: 'session-test',
    requestId: 'req-refresh-race',
    text: '刷新竞态消息',
    images: [],
    stage: 'sent',
    awaitingCommit: true,
    localEcho: true,
  }]);
  harness.insertComposerLocalEcho({
    requestId: 'req-refresh-race',
    text: '刷新竞态消息',
    sessionId: 'session-test',
  });
  harness.markLocalEchoAwaitingCommit('req-refresh-race');
  assert.equal(harness.collectComposerEchoesForRefresh().length, 1, 'the retained store record should make the echo refresh-protected');
  harness.clearMessages();
  assert.ok(findByRequestId(harness, 'req-refresh-race'), 'empty refresh must not erase the retained echo');
  harness.renderMessageInto(harness.messagesInner, {
    type: 'message',
    role: 'user',
    requestId: 'req-refresh-race',
    content: '刷新竞态消息',
  });
  assert.equal(
    harness.messagesInner.querySelectorAll('.msg-user').length,
    1,
    'canonical delivery after a retained refresh must leave exactly one bubble',
  );
  assert.equal(findByRequestId(harness, 'req-refresh-race')?.hasClass('msg-user-local-echo'), false);
}

console.log('test-chat-send-local-echo: ok');
