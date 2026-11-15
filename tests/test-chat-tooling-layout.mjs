#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const responsiveSource = readFileSync(join(repoRoot, 'static/chat/layout-tooling.js'), 'utf8');
assert.match(responsiveSource, /addEventListener\("touchmove"/);
assert.match(responsiveSource, /passive:\s*false/);
assert.match(responsiveSource, /selector:\s*"?:scope > \.messages/);

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

function createMatchMedia(initialMatch) {
  const listeners = [];
  return {
    matches: initialMatch,
    addEventListener(type, listener) {
      if (type === 'change') listeners.push(listener);
    },
    dispatch(nextMatch) {
      this.matches = nextMatch;
      for (const listener of listeners) listener({ matches: nextMatch });
    },
  };
}

function createContext({
  isDesktop = false,
  innerHeight = 812,
  visualHeight = 812,
  viewportSnapshot = null,
} = {}) {
  const documentElementStyle = new Map();
  const documentElement = {
    clientHeight: innerHeight,
    style: {
      setProperty(name, value) {
        documentElementStyle.set(name, value);
      },
    },
    classList: makeClassList(),
  };
  const body = {
    classList: makeClassList(),
  };
  const resizeListeners = [];
  const viewportResizeListeners = [];
  const animationFrames = [];
  let scrollToBottomCalls = 0;
  const mq = createMatchMedia(isDesktop);
  const focusCalls = [];
  const msgInput = {
    focus(options) {
      focusCalls.push(options ?? null);
    },
  };
  const messagesEl = {
    scrollHeight: 1600,
    scrollTop: 900,
    get clientHeight() {
      return visualHeight;
    },
  };
  const windowTarget = {
    innerHeight,
    scrollX: 0,
    scrollY: 0,
    scrollTo() {},
    addEventListener(type, listener) {
      if (type === 'resize') resizeListeners.push(listener);
    },
    requestAnimationFrame(callback) {
      animationFrames.push(callback);
      return animationFrames.length;
    },
    matchMedia() {
      return mq;
    },
    visualViewport: {
      get height() {
        return visualHeight;
      },
      addEventListener(type, listener) {
        if (type === 'resize') viewportResizeListeners.push(listener);
      },
    },
  };
  const context = {
    console,
    isDesktop,
    sidebarOverlay: {
      classList: makeClassList(),
    },
    msgInput,
    document: {
      documentElement,
      body,
      querySelector() {
        return null;
      },
    },
    window: windowTarget,
    messagesEl,
    scrollToBottom() {
      scrollToBottomCalls += 1;
      messagesEl.scrollTop = messagesEl.scrollHeight;
    },
    ...(viewportSnapshot
      ? {
        getMessageViewportStabilitySnapshot() {
          return viewportSnapshot;
        },
        syncMessageViewportStabilitySnapshot() {
          return { stickyBottom: false };
        },
      }
      : {}),
  };
  context.globalThis = context;
  return {
    context,
    documentElementStyle,
    body,
    mq,
    resizeListeners,
    viewportResizeListeners,
    focusCalls,
    get scrollToBottomCalls() {
      return scrollToBottomCalls;
    },
    flushAnimationFrames() {
      const callbacks = animationFrames.splice(0, animationFrames.length);
      callbacks.forEach((callback) => callback());
    },
    setViewport(nextHeight) {
      visualHeight = nextHeight;
    },
    setInnerHeight(nextHeight) {
      innerHeight = nextHeight;
      windowTarget.innerHeight = nextHeight;
      documentElement.clientHeight = nextHeight;
    },
  };
}

const mobileHarness = createContext({
  isDesktop: false,
  innerHeight: 812,
  visualHeight: 812,
});
vm.runInNewContext(responsiveSource, mobileHarness.context, { filename: 'static/chat/layout-tooling.js' });

assert.ok(mobileHarness.context.window.RagentLayout, 'tooling should expose a single shared layout controller');

mobileHarness.context.syncViewportHeight();
assert.equal(mobileHarness.documentElementStyle.get('--app-height'), '812px', 'app shell should track the active viewport height');
assert.equal(mobileHarness.documentElementStyle.get('--keyboard-inset-height'), '0px', 'keyboard inset should default to zero when the viewport is fully open');
assert.equal(mobileHarness.body.classList.contains('keyboard-open'), false, 'keyboard-open should stay off when no keyboard inset exists');
const initialBottomPinCalls = mobileHarness.scrollToBottomCalls;

mobileHarness.setViewport(498);
mobileHarness.context.syncViewportHeight();
assert.equal(mobileHarness.documentElementStyle.get('--app-height'), '498px', 'app shell should shrink with the keyboard-aware visual viewport');
assert.equal(mobileHarness.documentElementStyle.get('--keyboard-inset-height'), '314px', 'keyboard inset should be derived from layout minus visual viewport height');
assert.equal(mobileHarness.body.classList.contains('keyboard-open'), true, 'mobile shells should enter keyboard-open mode when the keyboard consumes meaningful space');
assert.equal(mobileHarness.scrollToBottomCalls, initialBottomPinCalls + 1, 'bottom-pinned messages should move above the mobile keyboard');

// A real mobile browser can clamp a nested scroll container to its top while
// the visual viewport is being resized for the keyboard. The post-resize
// distance then looks like a history scroll even though the reader was pinned
// to the latest message before the transaction. The pre-layout snapshot must
// still restore the latest content above the keyboard.
const clampedHarness = createContext({
  isDesktop: false,
  innerHeight: 812,
  visualHeight: 812,
  viewportSnapshot: { stickyBottom: true },
});
clampedHarness.context.messagesEl.scrollTop = 0;
vm.runInNewContext(responsiveSource, clampedHarness.context, { filename: 'static/chat/layout-tooling.js' });
clampedHarness.setViewport(498);
clampedHarness.context.syncViewportHeight();
assert.equal(clampedHarness.scrollToBottomCalls, 1, 'pre-keyboard bottom intent should survive a browser scroll clamp');
assert.equal(clampedHarness.context.messagesEl.scrollTop, clampedHarness.context.messagesEl.scrollHeight, 'clamped viewport should be restored to the latest message');

const historyHarness = createContext({
  isDesktop: false,
  innerHeight: 812,
  visualHeight: 812,
  viewportSnapshot: { stickyBottom: false },
});
historyHarness.context.messagesEl.scrollTop = 0;
vm.runInNewContext(responsiveSource, historyHarness.context, { filename: 'static/chat/layout-tooling.js' });
historyHarness.setViewport(498);
historyHarness.context.syncViewportHeight();
assert.equal(historyHarness.scrollToBottomCalls, 0, 'keyboard opening must not pull a reader out of history back to the latest message');
assert.equal(historyHarness.context.messagesEl.scrollTop, 0, 'history scroll position should remain untouched');

const composerKeyboardHarness = createContext({
  isDesktop: false,
  innerHeight: 812,
  visualHeight: 812,
  viewportSnapshot: { stickyBottom: false },
});
composerKeyboardHarness.body.classList.add('composer-input-focused');
vm.runInNewContext(responsiveSource, composerKeyboardHarness.context, { filename: 'static/chat/layout-tooling.js' });
composerKeyboardHarness.setViewport(498);
composerKeyboardHarness.context.syncViewportHeight();
assert.equal(composerKeyboardHarness.scrollToBottomCalls, 1, 'opening the keyboard from the composer should explicitly reveal the latest content');
assert.equal(composerKeyboardHarness.context.messagesEl.scrollTop, composerKeyboardHarness.context.messagesEl.scrollHeight, 'composer keyboard focus should pin the latest content above the dock');

mobileHarness.setInnerHeight(700);
mobileHarness.setViewport(700);
mobileHarness.context.syncViewportHeight();
assert.equal(mobileHarness.documentElementStyle.get('--keyboard-inset-height'), '0px', 'keyboard inset should clear once the layout and visual viewports realign');
assert.equal(mobileHarness.body.classList.contains('keyboard-open'), false, 'keyboard-open should clear once the viewport is fully restored');

const layoutNotifications = [];
mobileHarness.context.window.RagentLayout.subscribe((state, reason) => {
  layoutNotifications.push({ state, reason });
});
mobileHarness.setViewport(520);
mobileHarness.context.requestLayoutPass('viewport-a');
mobileHarness.context.requestLayoutPass('viewport-b');
assert.equal(layoutNotifications.length, 0, 'layout pass requests should batch until the next animation frame');
mobileHarness.flushAnimationFrames();
assert.equal(layoutNotifications.length, 1, 'multiple layout requests in one frame should collapse into a single pass');
assert.equal(layoutNotifications[0].reason, 'viewport-b', 'the latest queued reason should win for a batched layout pass');
assert.equal(layoutNotifications[0].state.viewportHeight, 520, 'subscribers should receive the resolved viewport height from the unified pass');

assert.equal(mobileHarness.context.focusComposer(), false, 'mobile session attachment should no longer auto-focus the composer by default');
assert.deepEqual(mobileHarness.focusCalls, [], 'mobile default focus policy should not trigger the keyboard implicitly');
assert.equal(mobileHarness.context.focusComposer({ force: true, preventScroll: true }), true, 'forced focus should still be available when the app needs recovery input');
assert.equal(mobileHarness.focusCalls.length, 1, 'forced focus should invoke the composer exactly once');
assert.equal(mobileHarness.focusCalls[0]?.preventScroll, true, 'forced focus should request preventScroll for steadier mobile viewport behavior');

const desktopHarness = createContext({
  isDesktop: true,
  innerHeight: 900,
  visualHeight: 900,
});
vm.runInNewContext(responsiveSource, desktopHarness.context, { filename: 'static/chat/layout-tooling.js' });
desktopHarness.context.sidebarOverlay.classList.add('open');
desktopHarness.context.sidebarOverlay.classList.add('collapsed');
desktopHarness.context.initResponsiveLayout();

assert.equal(desktopHarness.resizeListeners.length, 1, 'layout init should watch window resize in one place');
assert.equal(desktopHarness.viewportResizeListeners.length, 1, 'layout init should watch visual viewport resize in one place');
assert.equal(desktopHarness.context.sidebarOverlay.classList.contains('open'), false, 'desktop breakpoint init should clear any transient mobile overlay state');
assert.equal(desktopHarness.context.sidebarOverlay.classList.contains('collapsed'), false, 'desktop breakpoint init should keep the sidebar fully expanded');
assert.equal(desktopHarness.context.focusComposer({ preventScroll: true }), true, 'desktop session attachment should still auto-focus the composer');
assert.equal(desktopHarness.focusCalls.length, 1, 'desktop focus should invoke the composer exactly once');
assert.equal(desktopHarness.focusCalls[0]?.preventScroll, true, 'desktop focus should pass through preventScroll when requested');

desktopHarness.body.classList.add('keyboard-open');
desktopHarness.mq.dispatch(true);
assert.equal(desktopHarness.body.classList.contains('keyboard-open'), false, 'desktop breakpoint changes should clear any stale mobile keyboard state');

console.log('test-chat-tooling-layout: ok');
