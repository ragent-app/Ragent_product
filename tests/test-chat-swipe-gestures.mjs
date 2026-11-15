#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const gesturesSource = readFileSync(join(repoRoot, 'static/chat/gestures.js'), 'utf8');
const responsiveCss = readFileSync(join(repoRoot, 'static/chat/chat-responsive.css'), 'utf8');

assert.match(responsiveCss, /\.sidebar-overlay\.is-gesture-dragging \.sidebar\s*\{[\s\S]*?transform:\s*var\(--sidebar-gesture-transform,[\s\S]*?transition:\s*none;[\s\S]*?will-change:\s*transform;[\s\S]*?touch-action:\s*none;[\s\S]*?user-select:\s*none;/, 'drawer drag state should use direct compositor-friendly manipulation');
assert.match(responsiveCss, /\.sidebar-overlay\.is-gesture-settling \.sidebar\s*\{[\s\S]*?transition:\s*transform var\(--motion-exit/, 'drawer cancellation should settle through a short transform transition');

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

function makeStyle() {
  const values = new Map();
  return {
    setProperty(name, value) {
      values.set(name, value);
    },
    removeProperty(name) {
      values.delete(name);
    },
    getPropertyValue(name) {
      return values.get(name) || '';
    },
  };
}

class FakeElement {
  constructor({ blocked = false, blockedSelector = "" } = {}) {
    this.blocked = blocked;
    this.blockedSelector = blockedSelector;
  }

  closest(selector) {
    return this.blocked || (this.blockedSelector && selector.includes(this.blockedSelector)) ? this : null;
  }
}

function createHarness({ sidebarOpen = false, rightSidebarOpen = false, canNavigateBack = false, composerPanelOpen = false, projectLevel = false } = {}) {
  const listeners = new Map();
  const sidebarOverlay = {
    classList: makeClassList(sidebarOpen ? ['open'] : []),
    style: makeStyle(),
    setAttribute() {},
  };
  const sidebar = {
    getBoundingClientRect() {
      return { width: 390 };
    },
  };
  const bodyClassList = makeClassList(rightSidebarOpen ? ['right-sidebar-open'] : []);
  const context = {
    console,
    Promise,
    Element: FakeElement,
    isDesktop: false,
    visitorMode: false,
    sidebarOverlay,
    sidebar,
    addToolModal: { hidden: true },
    openSessionsSidebarCalls: 0,
    closeSidebarFnCalls: 0,
    openWorkbenchInspectorTabCalls: 0,
    closeRightSidebarCalls: 0,
    navigateBackCalls: 0,
    projectBeginCalls: 0,
    projectUpdateDistances: [],
    projectSettles: [],
    openSessionsSidebar() {
      context.openSessionsSidebarCalls += 1;
      return true;
    },
    closeSidebarFn() {
      context.closeSidebarFnCalls += 1;
      return true;
    },
    window: {
      innerWidth: 390,
      requestAnimationFrame(callback) {
        callback();
        return 1;
      },
      setTimeout(callback) {
        callback();
        return 1;
      },
      ragentOpenWorkbenchInspectorTab() {
        context.openWorkbenchInspectorTabCalls += 1;
        return true;
      },
      closeRightSidebar() {
        context.closeRightSidebarCalls += 1;
        return true;
      },
      ragentCanNavigateBack() {
        return canNavigateBack;
      },
      ragentNavigateBack() {
        context.navigateBackCalls += 1;
        return true;
      },
      RagentProjectView: projectLevel
        ? {
            canStartEdgeBackSwipe() {
              return true;
            },
            beginEdgeBackSwipe() {
              context.projectBeginCalls += 1;
              return true;
            },
            updateEdgeBackSwipe(distance) {
              context.projectUpdateDistances.push(distance);
              return true;
            },
            getEdgeBackSwipeTriggerDistance() {
              return 120;
            },
            settleEdgeBackSwipe(committed, onSettled) {
              context.projectSettles.push(committed);
              onSettled?.();
            },
          }
        : null,
    },
    document: {
      body: { classList: bodyClassList },
      documentElement: {
        clientWidth: 390,
      },
      getElementById(id) {
        return null;
      },
      querySelector(selector) {
        return composerPanelOpen && selector === '.composer-add-panel:not([hidden])' ? {} : null;
      },
      addEventListener(type, listener) {
        const existing = listeners.get(type) || [];
        existing.push(listener);
        listeners.set(type, existing);
      },
    },
  };
  context.globalThis = context;
  // Mirror window.* helpers onto the context so bare references resolve too.
  context.ragentOpenWorkbenchInspectorTab = context.window.ragentOpenWorkbenchInspectorTab;
  context.closeRightSidebar = context.window.closeRightSidebar;
  vm.runInNewContext(gesturesSource, context, { filename: 'static/chat/gestures.js' });
  return { context, listeners };
}

function emit(listeners, type, event) {
  for (const listener of listeners.get(type) || []) {
    listener(event);
  }
}

function touch(clientX, clientY) {
  return { clientX, clientY };
}

async function runSwipe(harness, {
  startX,
  startY = 420,
  moveX,
  moveY = startY,
  endX = moveX,
  endY = moveY,
  target = new FakeElement(),
} = {}) {
  let prevented = false;
  emit(harness.listeners, 'touchstart', {
    touches: [touch(startX, startY)],
    target,
  });
  emit(harness.listeners, 'touchmove', {
    touches: [touch(moveX, moveY)],
    preventDefault() {
      prevented = true;
    },
  });
  const sidebarTransformDuringMove = harness.context.sidebarOverlay.style.getPropertyValue('--sidebar-gesture-transform');
  emit(harness.listeners, 'touchend', {
    changedTouches: [touch(endX, endY)],
  });
  await Promise.resolve();
  return {
    prevented,
    sidebarTransformDuringMove,
    sidebarTransform: harness.context.sidebarOverlay.style.getPropertyValue('--sidebar-gesture-transform'),
  };
}

// Viewport is 390px wide: left edge zone = x <= 117, right edge zone = x >= 273.

// 1. Left-edge right-swipe always opens the sessions sidebar. Session history
// back is owned by Android/browser history, not the gesture recognizer.
const leftEdgeHarness = createHarness({ canNavigateBack: true });
const leftEdgeResult = await runSwipe(leftEdgeHarness, { startX: 20, moveX: 90, endX: 120 });
assert.equal(leftEdgeResult.prevented, true, 'left-edge right swipe should lock the gesture');
assert.equal(leftEdgeHarness.context.openSessionsSidebarCalls, 1, 'left-edge right swipe should open the session list');
assert.equal(leftEdgeResult.sidebarTransformDuringMove, 'translateX(calc(-100% + 70px))', 'left-edge right swipe should move the drawer with the finger');
assert.equal(leftEdgeHarness.context.sidebarOverlay.classList.contains('is-gesture-dragging'), false, 'opening gesture should settle after release');
assert.equal(leftEdgeHarness.context.sidebarOverlay.style.getPropertyValue('--sidebar-gesture-transform'), '', 'opening gesture should clear its transform after settling');
assert.equal(leftEdgeHarness.context.openWorkbenchInspectorTabCalls, 0, 'left-edge right swipe should not open the audit inspector');
assert.equal(leftEdgeHarness.context.navigateBackCalls, 0, 'left-edge right swipe should not consume Android history back');

// The expanded 30% left zone still accepts a swipe that starts near its inner edge.
const expandedLeftEdgeHarness = createHarness();
const expandedLeftEdgeResult = await runSwipe(expandedLeftEdgeHarness, { startX: 110, moveX: 180, endX: 210 });
assert.equal(expandedLeftEdgeResult.prevented, true, 'left-edge zone should extend to 30% of the viewport');
assert.equal(expandedLeftEdgeHarness.context.openSessionsSidebarCalls, 1, 'expanded left-edge right swipe should open the session list');

// A below-threshold edge drag previews the drawer but returns it to its
// starting position without opening the session history.
const cancelledOpenHarness = createHarness();
const cancelledOpenResult = await runSwipe(cancelledOpenHarness, { startX: 20, moveX: 52, endX: 52 });
assert.equal(cancelledOpenResult.prevented, true, 'partial left-edge drag should still directly manipulate the drawer');
assert.equal(cancelledOpenHarness.context.openSessionsSidebarCalls, 0, 'partial left-edge drag should not open the session list');
assert.equal(cancelledOpenHarness.context.sidebarOverlay.classList.contains('open'), false, 'cancelled opening drag should return the drawer to closed');

// 2. Inside L2, a strict left-edge right-swipe moves the project panel with
// the finger. The distance threshold is owned by the project view, so a
// release below it rebounds without opening/closing the sidebar.
const cancelledProjectBackHarness = createHarness({ sidebarOpen: true, projectLevel: true });
const cancelledProjectBackResult = await runSwipe(cancelledProjectBackHarness, {
  startX: 12,
  moveX: 76,
  endX: 76,
});
assert.equal(cancelledProjectBackResult.prevented, true, 'L2 edge back should take over once horizontal intent locks');
assert.equal(cancelledProjectBackHarness.context.projectBeginCalls, 1, 'L2 edge back should begin direct manipulation');
assert.deepEqual(cancelledProjectBackHarness.context.projectUpdateDistances, [64], 'L2 panel should receive the finger distance');
assert.deepEqual(cancelledProjectBackHarness.context.projectSettles, [false], 'below-threshold L2 back should rebound instead of committing');
assert.equal(cancelledProjectBackHarness.context.openSessionsSidebarCalls, 0, 'L2 edge back should not reopen the sidebar');

const committedProjectBackHarness = createHarness({ sidebarOpen: true, projectLevel: true });
const committedProjectBackResult = await runSwipe(committedProjectBackHarness, {
  startX: 12,
  moveX: 142,
  endX: 142,
});
assert.equal(committedProjectBackResult.prevented, true, 'committed L2 edge back should prevent native horizontal navigation');
assert.deepEqual(committedProjectBackHarness.context.projectUpdateDistances, [130], 'committed L2 edge back should stay directly linked to the finger');
assert.deepEqual(committedProjectBackHarness.context.projectSettles, [true], 'L2 edge back should commit only after crossing its threshold');

const nonEdgeProjectBackHarness = createHarness({ sidebarOpen: true, projectLevel: true });
const nonEdgeProjectBackResult = await runSwipe(nonEdgeProjectBackHarness, {
  startX: 42,
  moveX: 112,
  endX: 112,
});
assert.equal(nonEdgeProjectBackResult.prevented, false, 'L2 back should only arm from the left edge');
assert.equal(nonEdgeProjectBackHarness.context.projectBeginCalls, 0, 'inner-sidebar swipes should not start L2 back');

// 3. On the main surface, right-edge left-swipes remain passive.
const rightEdgeHarness = createHarness();
const rightEdgeResult = await runSwipe(rightEdgeHarness, { startX: 372, moveX: 300, endX: 272 });
assert.equal(rightEdgeResult.prevented, false, 'main-surface right-edge left swipe should remain passive');
assert.equal(rightEdgeHarness.context.openWorkbenchInspectorTabCalls, 0, 'main-surface right-edge left swipe should not open the audit inspector');
assert.equal(rightEdgeHarness.context.openSessionsSidebarCalls, 0, 'right-edge left swipe should not open the session list');

// 4. Center swipes (either direction) do nothing under the edge-zone model.
const centerRightHarness = createHarness();
await runSwipe(centerRightHarness, { startX: 195, moveX: 280, endX: 300 });
assert.equal(centerRightHarness.context.openSessionsSidebarCalls, 0, 'center right swipe should not open the session list');
assert.equal(centerRightHarness.context.openWorkbenchInspectorTabCalls, 0, 'center right swipe should not open the audit inspector');

const centerLeftHarness = createHarness();
await runSwipe(centerLeftHarness, { startX: 195, moveX: 110, endX: 90 });
assert.equal(centerLeftHarness.context.openSessionsSidebarCalls, 0, 'center left swipe should not open the session list');
assert.equal(centerLeftHarness.context.openWorkbenchInspectorTabCalls, 0, 'center left swipe should not open the audit inspector');

// 5. Inside an open sessions sidebar, a right-edge left-swipe still closes it.
const closeSessionsHarness = createHarness({ sidebarOpen: true });
const closeSessionsResult = await runSwipe(closeSessionsHarness, { startX: 372, moveX: 300, endX: 272 });
assert.equal(closeSessionsResult.prevented, true, 'right-edge left swipe should lock while sessions sidebar is open');
assert.equal(closeSessionsHarness.context.closeSidebarFnCalls, 1, 'right-edge left swipe should close the open sessions sidebar');
assert.equal(closeSessionsResult.sidebarTransformDuringMove, 'translateX(-72px)', 'right-edge left swipe should pull the drawer toward closed');
assert.equal(closeSessionsHarness.context.sidebarOverlay.classList.contains('is-gesture-dragging'), false, 'closing gesture should settle after release');

const cancelledCloseHarness = createHarness({ sidebarOpen: true });
await runSwipe(cancelledCloseHarness, { startX: 372, moveX: 340, endX: 340 });
assert.equal(cancelledCloseHarness.context.closeSidebarFnCalls, 0, 'partial right-edge drag should not close the session list');
assert.equal(cancelledCloseHarness.context.sidebarOverlay.classList.contains('open'), true, 'cancelled closing drag should return the drawer to open');

// 6. Inside the legacy right sidebar, a left-edge right-swipe closes it.
const closeAuditHarness = createHarness({ rightSidebarOpen: true });
const closeAuditResult = await runSwipe(closeAuditHarness, { startX: 20, moveX: 90, endX: 120 });
assert.equal(closeAuditResult.prevented, true, 'left-edge right swipe should lock while audit sidebar is open');
assert.equal(closeAuditHarness.context.closeRightSidebarCalls, 1, 'left-edge right swipe should close the open audit sidebar');

// 6. Vertical motion never steals scrolling or triggers an action.
const verticalHarness = createHarness();
const verticalResult = await runSwipe(verticalHarness, {
  startX: 20,
  moveX: 36,
  moveY: 520,
  endX: 36,
  endY: 520,
});
assert.equal(verticalResult.prevented, false, 'vertical motion should not steal scrolling');
assert.equal(verticalHarness.context.openSessionsSidebarCalls, 0, 'vertical motion should not open the session list');

// 7. Blocked interactive targets (e.g. composer) never arm a swipe.
const blockedHarness = createHarness();
await runSwipe(blockedHarness, {
  startX: 20,
  moveX: 120,
  endX: 140,
  target: new FakeElement({ blocked: true }),
});
assert.equal(blockedHarness.context.openSessionsSidebarCalls, 0, 'blocked interactive targets should ignore swipe shortcuts');

// 8. Portaled composer panels must remain scrollable and never arm edge swipes.
const portaledPanelHarness = createHarness();
await runSwipe(portaledPanelHarness, {
  startX: 20,
  moveX: 120,
  endX: 140,
  target: new FakeElement({ blockedSelector: '.composer-add-panel' }),
});
assert.equal(portaledPanelHarness.context.openSessionsSidebarCalls, 0, 'portaled composer panels should ignore edge swipe shortcuts');
assert.equal(portaledPanelHarness.context.openWorkbenchInspectorTabCalls, 0, 'portaled composer panels should not open the inspector while scrolling');

// 9. Even if a mobile browser retargets a panel swipe to the body, an open
// panel keeps global edge actions passive.
const openComposerPanelHarness = createHarness({ composerPanelOpen: true });
const openComposerPanelResult = await runSwipe(openComposerPanelHarness, {
  startX: 20,
  moveX: 120,
  endX: 140,
});
assert.equal(openComposerPanelResult.prevented, false, 'open composer panels should keep edge gestures passive');
assert.equal(openComposerPanelHarness.context.openSessionsSidebarCalls, 0, 'open composer panels should not open the session list');

console.log('test-chat-swipe-gestures: ok');
