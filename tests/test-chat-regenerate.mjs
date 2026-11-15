#!/usr/bin/env node
// A1 regenerate (branch + fold): the last assistant reply gets a Regenerate
// action; triggering it folds the previous reply into a collapsible version
// rail under the original user message (v1/v2/v3 stack), keeps the folded
// reply auditable, and confirms before re-running a mutating reply.
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
    textContent: '',
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
    after(sibling) {
      if (!this.parentNode) return;
      const index = this.parentNode.children.indexOf(this);
      this.parentNode.children.splice(index + 1, 0, sibling);
      sibling.parentNode = this.parentNode;
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
    sessionStatus: 'idle',
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
    t(key) { return `t:${key}`; },
    confirm() { return true; },
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
    requestMessageRegenerate,
    syncRegenerateActions,
  };`, context);
  return {
    context,
    calls,
    api: context.__api,
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
const markerEvent = (parentRequestId, requestId, runId, seq) => ({
  type: 'run_regenerate',
  parentRequestId,
  requestId,
  runId,
  state: 'accepted',
  timestamp: seq,
  seq,
});

async function main() {
  const harness = createHarness();
  const { api, context, calls } = harness;

  // 1. Render a normal turn: user + assistant reply.
  api.renderEvent(userEvent('req-1', 1), false, {});
  api.renderEvent(assistantEvent('req-1', 'run-1', 2, 'old answer'), false, {});
  let children = context.messagesInner.children;
  assert.equal(children.length, 2, 'turn renders user + assistant');
  const userNode = children[0];
  const reply = children[1];
  assert.ok(userNode.hasClass('msg-user'), 'first child is the user message');
  assert.ok(reply.hasClass('msg-assistant'), 'second child is the assistant reply');
  assert.ok(reply.hasClass('is-regenerable'), 'latest assistant reply is marked regenerable');
  assert.equal(reply.dataset.requestId, 'req-1', 'assistant node carries its run requestId');

  // 2. Regenerate marker folds the old reply into a version rail.
  api.renderEvent(markerEvent('req-1', 'regen-1', 'run-2', 3), false, {});
  children = context.messagesInner.children;
  assert.equal(children.length, 2, 'rail replaces the folded reply in the flow');
  assert.ok(children[1].hasClass('msg-version-rail'), 'version rail sits right after the user message');
  const rail = children[1];
  const toggle = rail.querySelector('.msg-version-rail__toggle');
  assert.ok(toggle, 'rail has a toggle button');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false', 'rail starts collapsed');
  const body = rail.querySelector('.msg-version-rail__body');
  assert.ok(body.children.includes(reply), 'old reply moved into the rail body');
  assert.equal(rail.dataset.foldedCount, '1', 'one folded version recorded');
  assert.ok(!reply.hasClass('is-regenerable'), 'folded reply is no longer regenerable');

  // 3. v2 streams after the rail and becomes the regenerable reply.
  api.renderEvent(assistantEvent('regen-1', 'run-2', 4, 'new answer'), false, {});
  children = context.messagesInner.children;
  assert.equal(children.length, 3, 'v2 renders after the rail');
  const v2 = children[2];
  assert.ok(v2.hasClass('msg-assistant'), 'v2 is the assistant reply');
  assert.ok(v2.hasClass('is-regenerable'), 'v2 is the regenerable reply');
  assert.ok(!isInsideRail(v2), 'v2 stays outside the rail');

  // 4. Second regenerate stacks v2 into the same rail (v1 + v2).
  api.renderEvent(markerEvent('req-1', 'regen-2', 'run-3', 5), false, {});
  children = context.messagesInner.children;
  assert.equal(children.length, 2, 'v2 folds into the existing rail');
  assert.equal(rail.dataset.foldedCount, '2', 'two folded versions recorded');
  const label = rail.querySelector('.msg-version-rail__label');
  assert.ok(label.textContent.includes('message.versionRail.folded'), 'rail label uses folded copy');
  assert.ok(label.textContent.includes('2'), 'rail label shows the version count');

  // 5. Expand toggle flips aria-expanded and shows the body.
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  toggle.fire('click');
  assert.equal(toggle.getAttribute('aria-expanded'), 'true', 'expand sets aria-expanded=true');
  assert.ok(rail.hasClass('is-expanded'), 'rail gains is-expanded class');

  // 6. Regenerate request path: mutating reply requires confirmation.
  const mutatingNode = createNode('div');
  mutatingNode.classList.add('msg-assistant');
  mutatingNode.dataset.requestId = 'req-1';
  const toolChild = createNode('div');
  toolChild.classList.add('tool-use');
  mutatingNode.appendChild(toolChild);
  context.confirm = () => false;
  await api.requestMessageRegenerate(mutatingNode);
  assert.ok(
    !calls.some((c) => c.name === 'fetchJsonOrRedirect'),
    'declined confirmation does not call the regenerate endpoint',
  );
  context.confirm = () => true;
  const before = calls.filter((c) => c.name === 'fetchJsonOrRedirect').length;
  await api.requestMessageRegenerate(mutatingNode);
  const fetchCalls = calls.filter((c) => c.name === 'fetchJsonOrRedirect');
  assert.equal(fetchCalls.length, before + 1, 'confirmed regenerate calls the endpoint');
  const lastFetch = fetchCalls[fetchCalls.length - 1];
  assert.equal(lastFetch.args[0], '/api/sessions/session-test/regenerate', 'posts to the regenerate endpoint');
  assert.deepEqual(JSON.parse(lastFetch.args[1].body), { requestId: 'req-1' }, 'posts the source requestId');

  // 7. Pure-text reply skips the confirmation.
  const plainNode = createNode('div');
  plainNode.classList.add('msg-assistant');
  plainNode.dataset.requestId = 'req-9';
  const confirmSpy = { count: 0 };
  context.confirm = () => {
    confirmSpy.count += 1;
    return true;
  };
  const beforePlain = calls.filter((c) => c.name === 'fetchJsonOrRedirect').length;
  await api.requestMessageRegenerate(plainNode);
  assert.equal(confirmSpy.count, 0, 'plain reply does not ask for confirmation');
  assert.equal(
    calls.filter((c) => c.name === 'fetchJsonOrRedirect').length,
    beforePlain + 1,
    'plain reply regenerates directly',
  );

  // 8. History prepend: marker folds during reload replay too.
  const h = createHarness();
  h.api.renderEvent(userEvent('req-h', 1), false, { historyPrepend: true });
  h.api.renderEvent(assistantEvent('req-h', 'run-h', 2, 'old history answer'), false, { historyPrepend: true });
  h.api.renderEvent(markerEvent('req-h', 'regen-h', 'run-h2', 3), false, { historyPrepend: true });
  h.api.renderEvent(assistantEvent('regen-h', 'run-h2', 4, 'new history answer'), false, { historyPrepend: true });
  const hChildren = h.context.messagesInner.children;
  assert.equal(hChildren.length, 3, 'history replay renders user + rail + v2');
  assert.ok(hChildren[1].hasClass('msg-version-rail'), 'history replay folds the old reply');
  assert.ok(hChildren[2].hasClass('msg-assistant') && hChildren[2].hasClass('is-regenerable'), 'history replay marks v2 regenerable');

  console.log('test-chat-regenerate: PASS');
}

function isInsideRail(node) {
  return !!node.closest?.('.msg-version-rail');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
