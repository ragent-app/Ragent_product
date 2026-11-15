#!/usr/bin/env node
// A1 edit-resend (frontend): editing a message and sending again replaces the
// last user bubble in place (run_regenerate marker carries the edited prompt),
// folds the old reply into the version rail, and drives the composer through
// the pending-edit-resend store state — adjacent cancel/update controls in the
// composer, optimistic
// bubble patch, tool-marker confirmation. History replay patches the bubble
// idempotently on reload.
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
  'static/chat/composer-store.js',
  'static/chat/compose.js',
].map((path) => readFileSync(join(repoRoot, path), 'utf8')).join('\n');
const inputCss = readFileSync(join(repoRoot, 'static/chat/chat-input.css'), 'utf8');

function createNode(tag = 'div') {
  const node = {
    tagName: String(tag).toUpperCase(),
    className: '',
    children: [],
    parentNode: null,
    dataset: {},
    type: '',
    listeners: {},
    attributes: {},
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
      if (child.parentNode) {
        const index = child.parentNode.children.indexOf(child);
        if (index >= 0) child.parentNode.children.splice(index, 1);
      }
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    append(...children) {
      children.forEach((child) => this.appendChild(child));
      return this;
    },
    prepend(child) {
      if (child.parentNode) {
        const index = child.parentNode.children.indexOf(child);
        if (index >= 0) child.parentNode.children.splice(index, 1);
      }
      child.parentNode = this;
      this.children.unshift(child);
      return child;
    },
    after(sibling) {
      if (!this.parentNode) return;
      const index = this.parentNode.children.indexOf(this);
      this.parentNode.children.splice(index + 1, 0, sibling);
      sibling.parentNode = this.parentNode;
    },
    replaceWith(replacement) {
      if (!this.parentNode) return;
      const index = this.parentNode.children.indexOf(this);
      this.parentNode.children.splice(index, 1, replacement);
      replacement.parentNode = this.parentNode;
      this.parentNode = null;
    },
    remove() {
      if (!this.parentNode) return;
      const index = this.parentNode.children.indexOf(this);
      if (index >= 0) this.parentNode.children.splice(index, 1);
      this.parentNode = null;
    },
    get nextElementSibling() {
      if (!this.parentNode) return null;
      const index = this.parentNode.children.indexOf(this);
      return this.parentNode.children[index + 1] || null;
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    removeAttribute(name) {
      delete this.attributes[name];
    },
    set innerHTML(html) {
      this.children = [];
      const re = /<([a-z]+)([^>]*)>(?:([^<]*))?<\/\1>/g;
      let match;
      while ((match = re.exec(html))) {
        const child = createNode(match[1]);
        const classMatch = /class="([^"]*)"/.exec(match[2] || '');
        if (classMatch) child.className = classMatch[1];
        child.textContent = match[3] || '';
        this.appendChild(child);
      }
    },
    get innerHTML() {
      return this.children.map((child) => `<${child.tagName.toLowerCase()}></${child.tagName.toLowerCase()}>`).join('');
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
    },
    closest(selector) {
      let current = this.parentNode;
      while (current) {
        if (current.matches?.(selector)) return current;
        current = current.parentNode;
      }
      return null;
    },
    matches(selector) {
      if (typeof selector !== 'string' || !selector.startsWith('.')) return false;
      const bracket = selector.indexOf('[');
      const classPart = bracket === -1 ? selector.slice(1) : selector.slice(1, bracket);
      const classes = classPart.split('.').filter(Boolean);
      if (!classes.every((cls) => this.hasClass(cls))) return false;
      const attr = bracket === -1 ? null : selector.slice(bracket + 1, -1);
      if (!attr) return true;
      const eq = attr.indexOf('=');
      const name = eq === -1 ? attr : attr.slice(0, eq);
      const camel = String(name).replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (eq === -1) return this.dataset[camel] !== undefined;
      const match = /^"([^"]*)"$/.exec(attr.slice(eq + 1));
      return !!match && this.dataset[camel] === match[1];
    },
    hasClass(name) {
      return ` ${this.className} `.includes(` ${name} `);
    },
    addEventListener(name, fn) {
      (this.listeners[name] ||= []).push(fn);
    },
    fire(name, event = {}) {
      (this.listeners[name] || []).forEach((fn) => fn(event));
    },
    querySelector(selector) {
      for (const part of String(selector).split(',')) {
        const found = this.querySelectorAll(part.trim())[0];
        if (found) return found;
      }
      return null;
    },
    querySelectorAll(selector) {
      const results = [];
      const walk = (node) => {
        for (const child of node.children || []) {
          if (child.matches?.(selector)) results.push(child);
          walk(child);
        }
      };
      walk(this);
      return results;
    },
  };
  // textContent aggregates the subtree (like a real DOM node): the own text
  // plus the text of every descendant.
  let ownText = '';
  Object.defineProperty(node, 'textContent', {
    get() {
      let acc = ownText;
      for (const child of node.children || []) {
        acc += child.textContent || '';
      }
      return acc;
    },
    set(value) {
      ownText = String(value);
    },
  });
  return node;
}

function createHarness() {
  const calls = [];
  const track = (name) => (...args) => {
    calls.push({ name, args });
    return {};
  };
  const messagesInner = createNode('div');
  const emptyState = createNode('div');
  emptyState.parentNode = messagesInner;
  const inputWrapper = createNode('div');
  inputWrapper.className = 'input-wrapper';
  const sendBtn = createNode('button');
  sendBtn.disabled = false;
  sendBtn.addEventListener = () => {};
  const editCancelBtn = createNode('button');
  const fullscreenEditCancelBtn = createNode('button');
  const msgInput = {
    value: '',
    style: {},
    scrollHeight: 0,
    readOnly: false,
    addEventListener() {},
    dispatchEvent() {},
    focus() {},
    setSelectionRange() {},
  };
  const storage = new Map();
  const context = {
    console,
    window: {},
    document: {
      createElement: (tag) => createNode(tag),
      getElementById: (id) => (id === 'scrollToBottomFab' ? fab : null),
      querySelector: (selector) => (selector === '.input-wrapper' ? inputWrapper : null),
      addEventListener() {},
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
    sessionStatus: 'idle',
    selectedTool: '',
    inThinkingBlock: false,
    currentThinkingBlock: null,
    renderedEventState: {},
    getComposerPendingSendSnapshot() { return null; },
    scrollToBottom() {},
    syncEditableMessageActions() {},
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
    getCurrentSession() { return { id: 'session-test', archived: false }; },
    messageTimeFormatter: { format: () => 'ts' },
    renderRealtimeIcon(name, className = '') { return `<svg class="${className}"></svg>`; },
    fetchJsonOrRedirect: track('fetchJsonOrRedirect'),
    showSystemToast: track('showSystemToast'),
    confirm() { return true; },
    // compose.js globals (normally supplied by chat.html / other scripts)
    msgInput,
    sendBtn,
    cancelBtn: { addEventListener() {} },
    compactBtn: { addEventListener() {} },
    dropToolsBtn: { addEventListener() {} },
    composerPendingState: {
      textContent: '',
      classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
    },
    inputArea: { classList: { toggle() {}, contains() { return false; } } },
    pendingNavigationState: {},
    normalizeSidebarTab: (tab) => tab,
    ACTIVE_SIDEBAR_TAB_STORAGE_KEY: 'ragent_active_tab',
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    getComputedStyle() { return { lineHeight: '24px' }; },
    matchMedia() { return { matches: false }; },
    addEventListener() {},
    Event: class Event { constructor(type) { this.type = type; } },
  };
  const fab = {
    classList: {
      add() {}, remove() {}, contains() { return false; }, toggle() {},
    },
    addEventListener() {},
  };
  context.document.getElementById = (id) => {
    if (id === 'scrollToBottomFab') return fab;
    if (id === 'composerEditCancelBtn') return editCancelBtn;
    if (id === 'composerFullscreenEditCancelBtn') return fullscreenEditCancelBtn;
    return null;
  };
  context.window = context;
  context.window.RagentRunActivity = {
    noteFormalOutput() {},
    applyEvent() {},
  };
  vm.createContext(context);
  vm.runInContext(`${source}\nthis.__api = {
    renderEvent,
    foldAssistantRepliesIntoVersionRail,
    applyEditedUserMessageContent,
    editUserMessageForResend,
    syncComposerEditResendControls,
    submitEditResend,
    parentReplyHasToolMarkers,
  };`, context);
  return {
    context,
    calls,
    api: context.__api,
    inputWrapper,
    msgInput,
    sendBtn,
    editCancelBtn,
    fullscreenEditCancelBtn,
  };
}

const userEvent = (requestId, seq, runId = 'run-1') => ({
  type: 'message',
  role: 'user',
  requestId,
  runId,
  content: 'do the thing',
  timestamp: seq,
  seq,
});
const assistantEvent = (requestId, runId, seq, content) => ({
  type: 'message',
  role: 'assistant',
  requestId,
  runId,
  content,
  timestamp: seq,
  seq,
});
const editMarkerEvent = (parentRequestId, requestId, runId, seq, prompt) => ({
  type: 'run_regenerate',
  parentRequestId,
  requestId,
  runId,
  state: 'accepted',
  editResend: true,
  prompt,
  timestamp: seq,
  seq,
});

async function main() {
  const harness = createHarness();
  const {
    api,
    context,
    calls,
    inputWrapper,
    msgInput,
    sendBtn,
    editCancelBtn,
    fullscreenEditCancelBtn,
  } = harness;

  // ---- Part A: bubble patch + version rail ----

  // 1. Render a normal turn.
  api.renderEvent(userEvent('req-1', 1), false, {});
  api.renderEvent(assistantEvent('req-1', 'run-1', 2, 'old answer'), false, {});
  let children = context.messagesInner.children;
  assert.equal(children.length, 2, 'turn renders user + assistant');
  const userNode = children[0];
  const reply = children[1];
  assert.equal(userNode.dataset.requestId, 'req-1', 'user node carries requestId');
  assert.equal(reply.dataset.requestId, 'req-1', 'assistant node carries run requestId');

  // 2. Optimistic bubble patch replaces the user text in place, keeping the
  //    node's dataset; idempotent for the later run_regenerate replay.
  assert.equal(api.applyEditedUserMessageContent('req-1', 'Edited question', []), true, 'patch reports success');
  children = context.messagesInner.children;
  assert.equal(children.length, 2, 'patch replaces in place, no extra nodes');
  const patchedUser = children[0];
  assert.ok(patchedUser.hasClass('msg-user'), 'replacement is still a user bubble');
  assert.equal(patchedUser.dataset.requestId, 'req-1', 'replacement keeps the requestId dataset');
  assert.ok(patchedUser.textContent.includes('Edited question'), 'bubble now shows the edited text');
  assert.ok(!patchedUser.textContent.includes('do the thing'), 'original text no longer visible');
  assert.equal(api.applyEditedUserMessageContent('req-1', 'Edited question', []), true, 'replay is idempotent');
  assert.equal(api.applyEditedUserMessageContent('req-missing', 'x', []), false, 'unknown requestId is a no-op');

  // 3. Edit-resend marker folds the old reply into the rail AND re-applies
  //    the edited prompt to the user bubble (server-confirmed patch).
  api.renderEvent(editMarkerEvent('req-1', 'edit-1', 'run-2', 3, 'Edited question'), false, {});
  children = context.messagesInner.children;
  assert.equal(children.length, 2, 'rail replaces the folded reply in the flow');
  assert.ok(children[1].hasClass('msg-version-rail'), 'version rail sits right after the user message');
  const rail = children[1];
  assert.equal(rail.dataset.foldedCount, '1', 'one folded version recorded');
  const body = rail.querySelector('.msg-version-rail__body');
  assert.ok(body.children.includes(reply), 'old reply moved into the rail body');
  assert.ok(children[0].textContent.includes('Edited question'), 'server marker re-applies the edited text');
  assert.ok(!reply.hasClass('is-regenerable'), 'folded reply is no longer regenerable');

  // 4. v2 streams after the rail and becomes the regenerable reply.
  api.renderEvent(assistantEvent('edit-1', 'run-2', 4, 'new answer'), false, {});
  children = context.messagesInner.children;
  assert.equal(children.length, 3, 'v2 renders after the rail');
  const v2 = children[2];
  assert.ok(v2.hasClass('msg-assistant') && v2.hasClass('is-regenerable'), 'v2 is the regenerable reply');
  assert.ok(!v2.closest('.msg-version-rail'), 'v2 stays outside the rail');

  // 5. Edited attachments render as the image strip on the patched bubble.
  const imgHarness = createHarness();
  imgHarness.api.renderEvent(userEvent('req-img', 1), false, {});
  assert.equal(
    imgHarness.api.applyEditedUserMessageContent('req-img', 'with image', [{ filename: 'a.png' }]),
    true,
    'image patch succeeds',
  );
  const imgUser = imgHarness.context.messagesInner.children[0];
  assert.ok(imgUser.querySelector('.msg-images'), 'patched bubble renders the image strip');
  assert.ok(imgUser.textContent.includes('with image'), 'patched bubble renders the edited text');

  // 6. History replay: marker folds and patches during reload replay too.
  const h = createHarness();
  h.api.renderEvent(userEvent('req-h', 1), false, { historyPrepend: true });
  h.api.renderEvent(assistantEvent('req-h', 'run-h', 2, 'old history answer'), false, { historyPrepend: true });
  h.api.renderEvent(editMarkerEvent('req-h', 'edit-h', 'run-h2', 3, 'Edited history question'), false, { historyPrepend: true });
  h.api.renderEvent(assistantEvent('edit-h', 'run-h2', 4, 'new history answer'), false, { historyPrepend: true });
  const hChildren = h.context.messagesInner.children;
  assert.equal(hChildren.length, 3, 'history replay renders user + rail + v2');
  assert.ok(hChildren[1].hasClass('msg-version-rail'), 'history replay folds the old reply');
  assert.ok(hChildren[0].textContent.includes('Edited history question'), 'history replay patches the user bubble');
  assert.ok(hChildren[2].hasClass('msg-assistant') && hChildren[2].hasClass('is-regenerable'), 'history replay marks v2 regenerable');

  // ---- Part B: composer store pending-edit-resend roundtrip ----

  const store = context;
  // Values from the vm realm are cross-realm objects, so compare as JSON.
  const json = (value) => JSON.stringify(value);
  store.setComposerPendingEditResend({
    sessionId: 'session-test',
    requestId: 'req-1',
    prompt: 'Edited question',
    attachments: [{ filename: 'a.png' }],
  });
  let pending = store.getComposerPendingEditResend();
  assert.equal(json(pending), json({
    sessionId: 'session-test',
    requestId: 'req-1',
    prompt: 'Edited question',
    attachments: [{ filename: 'a.png' }],
  }), 'pending edit-resend roundtrips through the store');

  // Invalid payloads are rejected by the normalizer.
  store.setComposerPendingEditResend({ sessionId: 'session-test' });
  assert.equal(json(store.getComposerPendingEditResend()), json(pending), 'invalid pending edit-resend is ignored');

  // clearSessionState for another session keeps the pending edit; for the
  // edited session it clears it.
  store.clearComposerSessionState('session-other');
  assert.equal(json(store.getComposerPendingEditResend()), json(pending), 'other-session clear keeps the pending edit');
  store.clearComposerSessionState('session-test');
  assert.equal(store.getComposerPendingEditResend(), null, 'edited-session clear drops the pending edit');

  // ---- Part C: edit action wires adjacent cancel/update controls ----

  api.renderEvent(userEvent('req-1', 1), false, {});
  api.renderEvent(assistantEvent('req-1', 'run-1', 2, 'old answer'), false, {});
  api.editUserMessageForResend({ requestId: 'req-1', content: 'do the thing', images: [] });
  pending = store.getComposerPendingEditResend();
  assert.equal(json(pending), json({
    sessionId: 'session-test',
    requestId: 'req-1',
    prompt: 'do the thing',
    attachments: [],
  }), 'edit action records the pending edit-resend');
  assert.equal(msgInput.value, 'do the thing', 'composer is refilled with the message text');
  assert.equal(editCancelBtn.getAttribute('data-icon'), 'close', 'edit cancel uses the close icon');
  assert.equal(editCancelBtn.classList.contains('is-visible'), true, 'editing shows the inline cancel control');
  assert.equal(editCancelBtn.getAttribute('aria-hidden'), null, 'visible cancel is exposed to assistive technology');
  assert.equal(editCancelBtn.getAttribute('tabindex'), '0', 'visible cancel is keyboard reachable');
  assert.equal(fullscreenEditCancelBtn.classList.contains('is-visible'), true, 'editing shows the fullscreen cancel control');
  assert.equal(sendBtn.getAttribute('data-icon'), 'refresh', 'edit mode swaps the send icon for refresh');
  assert.equal(sendBtn.getAttribute('data-i18n-title'), 'message.editResend.update', 'edit mode names the update action');
  assert.equal(inputWrapper.classList.contains('is-edit-resend'), true, 'edit mode removes the extra composer shell');

  assert.match(inputCss, /\.composer-edit-cancel-btn\s*\{[\s\S]*?width:\s*36px;[\s\S]*?height:\s*36px;[\s\S]*?background:\s*var\(--color-action\);/, 'edit cancel matches the desktop send button size and treatment');
  assert.match(inputCss, /\.composer-edit-cancel-btn\.is-visible\s*\{[\s\S]*?visibility:\s*visible;[\s\S]*?pointer-events:\s*auto;/, 'edit cancel becomes interactive only in edit mode');
  assert.match(inputCss, /\.composer-edit-cancel-btn:active\s*\{[\s\S]*?transform:\s*scale\(0\.92\);/, 'edit cancel has press feedback');

  // Cancel dismisses the edit state and restores the normal composer.
  editCancelBtn.fire('click');
  assert.equal(store.getComposerPendingEditResend(), null, 'cancel clears the pending edit');
  assert.equal(editCancelBtn.classList.contains('is-visible'), false, 'cancel hides the inline cancel control');
  assert.equal(editCancelBtn.getAttribute('aria-hidden'), 'true', 'hidden cancel is removed from the accessibility tree');
  assert.equal(editCancelBtn.getAttribute('tabindex'), '-1', 'hidden cancel is removed from keyboard navigation');
  assert.equal(fullscreenEditCancelBtn.classList.contains('is-visible'), false, 'cancel hides the fullscreen cancel control');
  assert.equal(sendBtn.getAttribute('data-icon'), 'send', 'cancel restores the normal send icon');
  assert.equal(inputWrapper.classList.contains('is-edit-resend'), false, 'cancel restores the normal composer shell');

  // The controls only show for the session being edited.
  store.setComposerPendingEditResend({ sessionId: 'session-other', requestId: 'req-x', prompt: 'x' });
  api.syncComposerEditResendControls();
  assert.equal(editCancelBtn.classList.contains('is-visible'), false, 'other-session edit hides the inline cancel control');
  store.setComposerPendingEditResend({ sessionId: 'session-test', requestId: 'req-1', prompt: 'x' });
  api.syncComposerEditResendControls();
  assert.equal(editCancelBtn.classList.contains('is-visible'), true, 'current-session edit shows the inline cancel control');
  store.clearComposerPendingEditResend();
  api.syncComposerEditResendControls();

  // ---- Part D: submitEditResend drives the real endpoint ----

  // 15. Plain reply: no confirmation, posts the edit, patches optimistically,
  //     clears the composer and the pending state.
  store.setComposerPendingEditResend({
    sessionId: 'session-test',
    requestId: 'req-1',
    prompt: 'Edited question',
    attachments: [],
  });
  api.syncComposerEditResendControls();
  msgInput.value = 'Edited question';
  await api.submitEditResend(store.getComposerPendingEditResend(), 'Edited question', []);
  const fetchCalls = calls.filter((c) => c.name === 'fetchJsonOrRedirect');
  assert.equal(fetchCalls.length, 1, 'edit send posts exactly once');
  const fetchCall = fetchCalls[0];
  assert.equal(fetchCall.args[0], '/api/sessions/session-test/resend-edited', 'posts to the resend-edited endpoint');
  assert.deepEqual(JSON.parse(fetchCall.args[1].body), {
    requestId: 'req-1',
    prompt: 'Edited question',
  }, 'posts the source requestId and the edited prompt');
  children = context.messagesInner.children;
  assert.ok(children[0].textContent.includes('Edited question'), 'optimistic patch updates the bubble');
  assert.equal(store.getComposerPendingEditResend(), null, 'success clears the pending edit');
  assert.equal(editCancelBtn.classList.contains('is-visible'), false, 'success hides the inline cancel control');
  assert.equal(msgInput.value, '', 'success empties the textarea');

  // 16. Busy session: blocked with a toast, no request.
  const toastBefore = calls.filter((c) => c.name === 'showSystemToast').length;
  context.sessionStatus = 'running';
  store.setComposerPendingEditResend({ sessionId: 'session-test', requestId: 'req-1', prompt: 'x', attachments: [] });
  await api.submitEditResend(store.getComposerPendingEditResend(), 'x', []);
  context.sessionStatus = 'idle';
  assert.equal(calls.filter((c) => c.name === 'fetchJsonOrRedirect').length, 1, 'busy session does not post');
  assert.ok(
    calls.filter((c) => c.name === 'showSystemToast').length > toastBefore,
    'busy session toasts the busy message',
  );
  store.clearComposerPendingEditResend();
  api.syncComposerEditResendControls();

  // 17. Tool markers on the reply being replaced require explicit consent —
  //     declined stops the request, confirmed proceeds.
  const mutating = context.messagesInner.querySelector('.msg-assistant[data-request-id="edit-1"]') || v2;
  const toolChild = createNode('div');
  toolChild.className = 'tool-use';
  mutating.appendChild(toolChild);
  assert.equal(api.parentReplyHasToolMarkers('edit-1'), true, 'reply with tool markers is detected');
  assert.equal(api.parentReplyHasToolMarkers('req-unknown'), false, 'unknown reply has no markers');

  context.confirm = () => false;
  store.setComposerPendingEditResend({ sessionId: 'session-test', requestId: 'edit-1', prompt: 'x', attachments: [] });
  await api.submitEditResend(store.getComposerPendingEditResend(), 'x', []);
  assert.equal(calls.filter((c) => c.name === 'fetchJsonOrRedirect').length, 1, 'declined confirm does not post');
  assert.equal(store.getComposerPendingEditResend()?.requestId, 'edit-1', 'declined confirm keeps the pending edit');

  context.confirm = () => true;
  await api.submitEditResend(store.getComposerPendingEditResend(), 'x', []);
  assert.equal(calls.filter((c) => c.name === 'fetchJsonOrRedirect').length, 2, 'confirmed confirm posts the edit');

  // ---- Part E: cross-agent resend carries the composer runtime selection ----
  // With a composer runtime selection present, the edit resend posts it as a
  // per-run override (tool/model/effort + agent picker id).
  context.selectedTool = 'claude';
  context.selectedModel = 'claude-sonnet-5';
  context.currentToolReasoningKind = 'enum';
  context.selectedEffort = 'high';
  context.thinkingEnabled = false;
  context.visitorMode = false;
  context.inlineAgentSelect = { disabled: false, value: 'claude' };
  store.setComposerPendingEditResend({
    sessionId: 'session-test',
    requestId: 'req-1',
    prompt: 'Edited question',
    attachments: [],
  });
  await api.submitEditResend(store.getComposerPendingEditResend(), 'Edited question', []);
  const crossFetch = calls.filter((c) => c.name === 'fetchJsonOrRedirect').at(-1);
  assert.deepEqual(JSON.parse(crossFetch.args[1].body), {
    requestId: 'req-1',
    prompt: 'Edited question',
    tool: 'claude',
    model: 'claude-sonnet-5',
    effort: 'high',
    agentId: 'claude',
  }, 'cross-agent resend posts tool/model/effort/agentId as per-run overrides');

  // Thinking-toggle runtimes send thinking instead of effort.
  context.currentToolReasoningKind = 'toggle';
  context.thinkingEnabled = true;
  store.setComposerPendingEditResend({
    sessionId: 'session-test',
    requestId: 'req-1',
    prompt: 'Edited question',
    attachments: [],
  });
  await api.submitEditResend(store.getComposerPendingEditResend(), 'Edited question', []);
  const toggleFetch = calls.filter((c) => c.name === 'fetchJsonOrRedirect').at(-1);
  assert.deepEqual(JSON.parse(toggleFetch.args[1].body), {
    requestId: 'req-1',
    prompt: 'Edited question',
    tool: 'claude',
    model: 'claude-sonnet-5',
    thinking: true,
    agentId: 'claude',
  }, 'thinking-toggle runtimes post thinking instead of effort');

  console.log('test-chat-resend-edited: PASS');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
