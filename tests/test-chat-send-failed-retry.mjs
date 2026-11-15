#!/usr/bin/env node
// Failed-send recovery (A2): after a send failure the local echo bubble stays
// in the transcript while the text is restored to the composer. It must get
// in-place retry / edit-and-resend / discard actions — error recovery at the
// error site — instead of being a ghost with no affordance.
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const source = [
  'static/chat/realtime-render.js',
  'static/chat/ui.js',
].map((path) => readFileSync(join(repoRoot, path), 'utf8')).join('\n');

function createNode(tag = 'div') {
  const node = {
    tagName: String(tag).toUpperCase(),
    className: '',
    children: [],
    parentNode: null,
    dataset: {},
    attributes: {},
    textContent: '',
    type: '',
    listeners: {},
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
    append(...children) {
      children.forEach((child) => this.appendChild(child));
      return this;
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
    addEventListener(name, fn) {
      (this.listeners[name] ||= []).push(fn);
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    fire(name, event = {}) {
      (this.listeners[name] || []).forEach((fn) => fn(event));
    },
    querySelector(selector) {
      if (selector.startsWith('.')) {
        return this.querySelectorAll(selector)[0] || null;
      }
      return null;
    },
    querySelectorAll(selector) {
      const results = [];
      const walk = (node) => {
        for (const child of node.children || []) {
          if (selector.startsWith('.') && child.hasClass(selector.slice(1))) results.push(child);
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
  const calls = [];
  const track = (name) => (...args) => {
    calls.push({ name, args });
  };
  const messagesInner = createNode('div');
  const emptyState = createNode('div');
  emptyState.parentNode = messagesInner;
  const fab = {
    classList: {
      add() {}, remove() {}, contains() { return false; }, toggle() {},
    },
    addEventListener() {},
  };
  const context = {
    console,
    window: {},
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
      return null;
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
    // A2 recovery wiring stubs
    t(key) { return `t:${key}`; },
    findLocalEchoUserMessageNode() { return null; },
    restoreFailedSendState: track('restoreFailedSendState'),
    focusComposer: track('focusComposer'),
    sendMessage: track('sendMessage'),
    clearDraft: track('clearDraft'),
    replaceComposerAttachmentsSnapshot: track('replaceComposerAttachmentsSnapshot'),
    renderImagePreviews: track('renderImagePreviews'),
    autoResizeInput: track('autoResizeInput'),
    saveDraft: track('saveDraft'),
    msgInput: { value: '' },
  };
  context.window = context;
  context.window.RagentRunActivity = {
    noteFormalOutput() {},
    applyEvent() {},
  };
  vm.createContext(context);
  vm.runInContext(`${source}\nthis.__api = { markComposerSendFailed };`, context);
  return {
    context,
    calls,
    markComposerSendFailed: context.__api.markComposerSendFailed,
  };
}

function buildFailedEcho(harness, requestId) {
  // Synthetic wrap mirroring createUserMessageNode's structure: the bubble is
  // a child of the wrap so findLocalEchoUserMessageNode can return it.
  const wrap = harness.context.messagesInner.appendChild(createNode('div'));
  wrap.classList.add('msg-user', 'msg-user-local-echo');
  wrap.dataset.requestId = requestId;
  const bubble = wrap.appendChild(createNode('div'));
  bubble.classList.add('msg-user-bubble');
  return wrap;
}

// ---- integration: compose.js failure path must call markComposerSendFailed
{
  const composeSource = readFileSync(join(repoRoot, 'static/chat/compose.js'), 'utf8');
  assert.match(
    composeSource,
    /markComposerSendFailed\(sessionId, requestId,\s*\{\s*text: failedText,\s*images: outboundImages,\s*\}\)/,
    'compose.js failure path must surface the failed echo for in-place recovery',
  );
}

// ---- no-op without an echo
{
  const harness = createHarness();
  harness.markComposerSendFailed('session-test', 'req-missing');
  assert.equal(
    harness.context.messagesInner.querySelectorAll('.msg-failed-actions').length,
    0,
    'no echo -> no failed actions',
  );
}

// ---- full lifecycle: mark -> retry
{
  const harness = createHarness();
  const wrap = buildFailedEcho(harness, 'req-1');
  harness.context.findLocalEchoUserMessageNode = (requestId) =>
    requestId === 'req-1' ? wrap : null;

  harness.markComposerSendFailed('session-test', 'req-1', {
    text: '继续处理',
    images: [{ localId: 'img-1' }],
  });
  const bubble = wrap.querySelector('.msg-user-bubble');
  assert.equal(wrap.hasClass('msg-user--failed'), true, 'message block must be marked failed');
  assert.equal(bubble.hasClass('msg-failed'), true, 'bubble must be marked failed');
  assert.ok(wrap.querySelector('.msg-failed-status'), 'failed status must render below the bubble');
  const actions = wrap.querySelector('.msg-failed-actions');
  assert.ok(actions, 'failed actions must render below the bubble');
  assert.equal(bubble.querySelector('.msg-failed-actions'), null, 'failed actions must not be nested inside the sent bubble');
  assert.equal(actions.children.length, 3, 'retry + edit + discard buttons');
  assert.equal(actions.children[0].className, 'msg-retry-btn', 'first action is retry');
  assert.equal(actions.children[1].className, 'msg-edit-btn', 'second action is edit');
  assert.equal(actions.children[2].className, 'msg-discard-btn', 'third action is discard');

  // Guard: a second failure notification must not stack a second action row.
  harness.markComposerSendFailed('session-test', 'req-1');
  assert.equal(
    wrap.querySelectorAll('.msg-failed-actions').length,
    1,
    'duplicate failure notification must not stack actions',
  );

  // Retry: same requestId -> refill composer with the original content, keep
  // the echo as the live pending echo, and resend.
  actions.children[0].fire('click');
  assert.equal(bubble.hasClass('msg-failed'), false, 'retry must clear the failed state');
  assert.equal(bubble.querySelector('.msg-failed-actions'), null, 'retry must remove the actions');
  assert.equal(wrap.parentNode, harness.context.messagesInner, 'retry must keep the echo node');
  assert.deepEqual(
    harness.calls.filter((call) => call.name === 'restoreFailedSendState').map((call) => call.args[1]),
    ['继续处理'],
    'retry must refill the composer with the original text',
  );
  assert.deepEqual(
    harness.calls.filter((call) => call.name === 'restoreFailedSendState').map((call) => call.args[4]),
    [true],
    'retry must force-refill the original text even if the composer changed',
  );
  assert.deepEqual(
    harness.calls.filter((call) => call.name === 'sendMessage').map((call) => call.args[0]),
    ['req-1'],
    'retry must resend with the same requestId',
  );
}

// ---- edit: composer refilled, echo removed, no auto-send
{
  const harness = createHarness();
  const wrap = buildFailedEcho(harness, 'req-2');
  harness.context.findLocalEchoUserMessageNode = (requestId) =>
    requestId === 'req-2' ? wrap : null;
  harness.markComposerSendFailed('session-test', 'req-2', { text: '编辑我' });
  const bubble = wrap.querySelector('.msg-user-bubble');
  wrap.querySelector('.msg-failed-actions').children[1].fire('click');
  assert.equal(wrap.parentNode, null, 'edit must remove the ghost echo');
  assert.equal(
    harness.calls.some((call) => call.name === 'restoreFailedSendState'),
    true,
    'edit must restore the original content to the composer',
  );
  assert.equal(
    harness.calls.some((call) => call.name === 'sendMessage'),
    false,
    'edit must not auto-send',
  );
}

// ---- discard: echo + full composer state cleared (input included)
{
  const harness = createHarness();
  const wrap = buildFailedEcho(harness, 'req-3');
  harness.context.findLocalEchoUserMessageNode = (requestId) =>
    requestId === 'req-3' ? wrap : null;
  harness.context.msgInput.value = '丢弃我';
  harness.markComposerSendFailed('session-test', 'req-3', { text: '丢弃我' });
  const bubble = wrap.querySelector('.msg-user-bubble');
  wrap.querySelector('.msg-failed-actions').children[2].fire('click');
  assert.equal(wrap.parentNode, null, 'discard must remove the echo');
  assert.equal(harness.context.msgInput.value, '', 'discard must clear the visible composer input');
  assert.equal(
    harness.calls.some((call) => call.name === 'autoResizeInput'),
    true,
    'discard must resize the composer after clearing',
  );
  assert.deepEqual(
    harness.calls.filter((call) => call.name === 'clearDraft').map((call) => call.args[0]),
    ['session-test'],
    'discard must clear the stored draft',
  );
  // Cross-realm arrays fail deepStrictEqual — normalize via JSON.
  const cleared = harness.calls
    .filter((call) => call.name === 'replaceComposerAttachmentsSnapshot')
    .map((call) => JSON.stringify(call.args[1]));
  assert.deepEqual(cleared, ['[]'], 'discard must clear restored attachments');
  assert.equal(
    harness.calls.some((call) => call.name === 'renderImagePreviews'),
    true,
    'discard must refresh image previews',
  );
  assert.equal(
    harness.calls.some((call) => call.name === 'focusComposer'),
    true,
    'discard must hand keyboard focus back to the composer',
  );
}

// ---- stale ghosts: a new send drops superseded failed echoes, retry keeps its own
{
  const harness = createHarness();
  const stale = buildFailedEcho(harness, 'req-stale');
  const current = buildFailedEcho(harness, 'req-current');
  const bubble = stale.querySelector('.msg-user-bubble');
  bubble.classList.add('msg-failed');
  const actions = bubble.appendChild(createNode('div'));
  actions.className = 'msg-failed-actions';
  const fresh = buildFailedEcho(harness, 'req-fresh');
  const freshBubble = fresh.querySelector('.msg-user-bubble');
  freshBubble.classList.add('msg-failed');
  const freshActions = freshBubble.appendChild(createNode('div'));
  freshActions.className = 'msg-failed-actions';

  // Expose removeStaleFailedEchoes from the vm context.
  const removeStale = harness.context.removeStaleFailedEchoes;
  assert.equal(typeof removeStale, 'function', 'removeStaleFailedEchoes must exist');

  removeStale('req-current');
  assert.equal(stale.parentNode, null, 'new send must drop a superseded failed echo');
  assert.equal(current.parentNode, harness.context.messagesInner, 'the reused requestId echo must be kept');
  assert.equal(fresh.parentNode, null, 'new send must drop every other failed echo');
}

// ---- retry across sessions: echo removed, no cross-session send
{
  const harness = createHarness();
  const wrap = buildFailedEcho(harness, 'req-4');
  harness.context.findLocalEchoUserMessageNode = (requestId) =>
    requestId === 'req-4' ? wrap : null;
  harness.context.currentSessionId = 'other-session';
  harness.markComposerSendFailed('session-test', 'req-4', { text: '跨会话' });
  const bubble = wrap.querySelector('.msg-user-bubble');
  wrap.querySelector('.msg-failed-actions').children[0].fire('click');
  assert.equal(wrap.parentNode, null, 'cross-session retry must drop the stale echo');
  assert.equal(
    harness.calls.some((call) => call.name === 'sendMessage'),
    false,
    'cross-session retry must not send into another session',
  );
}

console.log('ok — failed-send retry/edit/discard recovery UI');
