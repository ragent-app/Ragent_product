#!/usr/bin/env node
// Scroll-to-latest FAB: the floating "back to latest" button must appear only
// when the reader has scrolled away from the bottom of a non-empty transcript,
// and tapping it must return to the latest content and hide itself. Regression
// guard for the A3 gap (up-scroll freeze had no "back to latest" entry point).
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import vm from 'vm';

function createNode(tag = 'div') {
  return {
    tagName: String(tag).toUpperCase(),
    className: '',
    children: [],
    parentNode: null,
    dataset: {},
    textContent: '',
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
  };
}

function createClassList() {
  const classes = new Set();
  return {
    add(...tokens) {
      tokens.forEach((token) => classes.add(token));
    },
    remove(...tokens) {
      tokens.forEach((token) => classes.delete(token));
    },
    contains(token) {
      return classes.has(token);
    },
    toggle(token, force) {
      if (force === true) {
        classes.add(token);
        return true;
      }
      if (force === false) {
        classes.delete(token);
        return false;
      }
      if (classes.has(token)) {
        classes.delete(token);
        return false;
      }
      classes.add(token);
      return true;
    },
  };
}

function createHarness() {
  const source = readFileSync(new URL('../static/chat/realtime-render.js', import.meta.url), 'utf8');
  const messagesInner = createNode('div');
  const emptyState = createNode('div');
  emptyState.parentNode = messagesInner; // transcript starts empty
  const fab = {
    classList: createClassList(),
    listeners: {},
    addEventListener(name, fn) {
      (this.listeners[name] ||= []).push(fn);
    },
    fire(name, event) {
      (this.listeners[name] || []).forEach((fn) => fn(event));
    },
  };
  const viewportListeners = new Map();
  const rafQueue = [];
  let nextRafId = 0;
  let clock = 0;
  const messagesEl = {
    scrollHeight: 300,
    scrollTop: 0,
    clientHeight: 100,
    addEventListener(name, fn) {
      const listeners = viewportListeners.get(name) || [];
      listeners.push(fn);
      viewportListeners.set(name, listeners);
    },
  };

  const context = {
    console,
    window: {},
    performance: {
      now: () => clock,
    },
    document: {
      createElement: () => createNode(),
      getElementById: (id) => (id === 'scrollToBottomFab' ? fab : null),
    },
    messagesInner,
    emptyState,
    currentSessionId: 'session-test',
    messagesEl,
    requestAnimationFrame(callback) {
      const id = ++nextRafId;
      rafQueue.push({ id, callback });
      return id;
    },
    cancelAnimationFrame(id) {
      const index = rafQueue.findIndex((entry) => entry.id === id);
      if (index >= 0) rafQueue.splice(index, 1);
    },
    renderMarkdownIntoNode() {},
    inThinkingBlock: false,
    currentThinkingBlock: null,
    syncComposerPendingTurnFeedback() {},
    syncSessionTemplateControls() {},
    syncForkButton() {},
    syncShareButton() {},
    renderQueuedMessagePanel() {},
    resetRenderedEventState() {},
    renderedEventState: {},
    shouldAutoScrollMessages() {
      return false;
    },
    shouldCompactMobileThinking() {
      return false;
    },
    renderMessageInto(container, evt, options = {}) {
      const node = createNode();
      node.event = evt;
      node.options = options;
      container.appendChild(node);
      return node;
    },
    renderPlanEvent() {},
    renderPlanApprovalCard() {},
    updatePlanApprovalCardOnResponse() {},
    annotateRenderedEventViewportNodes() {},
    movePlanProgressCardToEnd() {},
    renderOperation() {},
    renderApprovalResponse() {},
  };
  context.window = context;
  context.window.RagentRunActivity = {
    noteFormalOutput() {},
    applyEvent() {},
  };
  context.window.RagentDecisions = {
    noteRequest() {},
    noteResponse() {},
  };
  vm.createContext(context);
  vm.runInContext(`${source}\nthis.__api = { syncScrollToBottomFab };`, context);
  return {
    syncScrollToBottomFab: context.__api.syncScrollToBottomFab,
    fab,
    messagesEl,
    messagesInner,
    emptyState,
    fireViewportEvent(name, event = {}) {
      (viewportListeners.get(name) || []).forEach((fn) => fn(event));
    },
    fireScroll() {
      this.fireViewportEvent('scroll');
    },
    flushRaf(time) {
      clock = Number.isFinite(time) ? time : clock;
      rafQueue.splice(0).forEach(({ callback }) => callback(clock));
    },
  };
}

const harness = createHarness();

// Empty transcript: even scrolled far from a zero-height viewport, the FAB
// must stay hidden (there is nothing to return to).
assert.equal(
  harness.fab.classList.contains('visible'),
  false,
  'FAB must not appear for an empty transcript',
);

// Add one real message (emptyState no longer marks the empty view).
harness.emptyState.parentNode = null;
const message = createNode('div');
harness.messagesInner.appendChild(message);

// Far from the bottom (distance 300 - 0 - 100 = 200 >= 120): FAB appears.
harness.messagesEl.scrollTop = 0;
harness.fireScroll();
assert.equal(
  harness.fab.classList.contains('visible'),
  true,
  'FAB must appear when scrolled away from the bottom of a non-empty transcript',
);

// Near the bottom (distance 300 - 180 - 100 = 20 < 120): FAB hides.
harness.messagesEl.scrollTop = 180;
harness.fireScroll();
assert.equal(
  harness.fab.classList.contains('visible'),
  false,
  'FAB must hide when the reader is back near the bottom',
);

// Scrolled away again, then tap: returns to latest and hides immediately.
harness.messagesEl.scrollTop = 0;
harness.fireScroll();
assert.equal(
  harness.fab.classList.contains('visible'),
  true,
  'FAB visible again after scrolling back up',
);
harness.fab.fire('click');
assert.equal(
  harness.fab.classList.contains('visible'),
  false,
  'tapping the FAB must hide it immediately',
);
harness.flushRaf(0); // schedule the animation from the click's rAF hop
assert.equal(
  harness.messagesEl.scrollTop,
  0,
  'the animated return should not jump on the scheduling frame',
);
harness.flushRaf(16);
assert.ok(
  harness.messagesEl.scrollTop > 0
    && harness.messagesEl.scrollTop < harness.messagesEl.scrollHeight - harness.messagesEl.clientHeight,
  'the animated return should pass through an observable mid-scroll position',
);
harness.flushRaf(400);
assert.equal(
  harness.messagesEl.scrollTop,
  harness.messagesEl.scrollHeight - harness.messagesEl.clientHeight,
  'tapping the FAB must scroll the transcript back to the latest content',
);

// A real gesture must win over the authored return motion instead of being
// dragged back to the bottom by the next animation frame.
harness.messagesEl.scrollTop = 0;
harness.fireScroll();
harness.fab.fire('click');
harness.flushRaf(500);
harness.flushRaf(516);
const interruptedTop = harness.messagesEl.scrollTop;
assert.ok(interruptedTop > 0, 'interruption scenario should reach a mid-scroll frame first');
harness.fireViewportEvent('wheel');
harness.flushRaf(900);
assert.equal(
  harness.messagesEl.scrollTop,
  interruptedTop,
  'a user wheel must interrupt the return animation',
);

console.log('ok — scroll-to-latest FAB visibility and tap behavior');
