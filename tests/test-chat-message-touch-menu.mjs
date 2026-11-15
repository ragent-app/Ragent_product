#!/usr/bin/env node
// Browser contract for the mobile user-message long-press menu. The layout
// breakpoint must not disable touch actions when a phone/tablet reports a
// desktop-style viewport, and Touch Events remain a compatibility fallback.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const uiSource = readFileSync(new URL('../static/chat/ui.js', import.meta.url), 'utf8');
const projectorSource = readFileSync(new URL('../static/chat/core/timeline-projector.js', import.meta.url), 'utf8');
const timelineSource = readFileSync(new URL('../static/chat/timeline-runtime.js', import.meta.url), 'utf8');

async function createPage(browser, { disablePointerEvents = false } = {}) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 720 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  await page.setContent('<!doctype html><html><body><div id="messages"><div id="messagesInner"></div></div></body></html>');
  await page.evaluate(({ disablePointerEvents: disable }) => {
    if (disable) {
      try { delete window.PointerEvent; } catch {}
    }
    window.marked = { parse: (value) => `<p>${String(value ?? '')}</p>` };
    window.ragentT = (key) => key;
    window.RagentIcons = { render: () => '' };
    window.RagentMotion = { subscribeReducedMotion: () => {} };
    window.RagentRunActivity = { applyEvent: () => {}, noteFormalOutput: () => {} };
    window.RagentDecisions = { reset: () => {} };
    window.visitorMode = false;
    window.shareSnapshotMode = false;
    window.currentSessionId = 'touch-menu-session';
    window.sessionStatus = 'idle';
    window.inThinkingBlock = false;
    window.hasAttachedSession = true;
    window.messagesInner = document.getElementById('messagesInner');
    window.messagesEl = document.getElementById('messages');
    window.emptyState = null;
    window.formatDecodedDisplayText = (value) => String(value ?? '');
    window.createMessageAttachmentNode = () => null;
    window.enhanceCodeBlocks = () => {};
    window.enhanceTables = () => {};
    window.enhanceRenderedContentLinks = () => {};
    // Reproduce the failure mode: layout state may still say desktop even
    // though this is a touch-capable mobile viewport.
    window.isDesktop = true;
  }, { disablePointerEvents });
  await page.addScriptTag({ content: uiSource });
  await page.addScriptTag({ content: projectorSource });
  await page.addScriptTag({ content: timelineSource });
  return { context, page };
}

async function appendUserMessage(page, requestId) {
  return page.evaluate((id) => {
    const node = createUserMessageNode({
      role: 'user',
      requestId: id,
      seq: 1,
      content: 'long press this user message',
    });
    node.classList.add('is-editable');
    messagesInner.appendChild(node);
    return node.querySelector('.msg-user-bubble') !== null;
  }, requestId);
}

async function readUserMessageDisclosure(page) {
  return page.evaluate(() => {
    const shortMessage = createUserMessageNode({
      role: 'user',
      requestId: 'short-disclosure-request',
      content: 'Short request.',
    });
    const longMessage = createUserMessageNode({
      role: 'user',
      requestId: 'long-disclosure-request',
      content: 'Line one\nLine two\nLine three\nLine four\nLine five\nLine six',
    });
    messagesInner.append(shortMessage, longMessage);
    const content = longMessage.querySelector('.md-content');
    const toggle = longMessage.querySelector('.msg-user-disclosure');
    const before = {
      shortToggle: shortMessage.querySelector('.msg-user-disclosure') !== null,
      label: toggle?.textContent,
      expanded: toggle?.getAttribute('aria-expanded'),
      collapsed: content?.classList.contains('msg-user-content--collapsed'),
    };
    toggle?.click();
    return {
      before,
      after: {
        label: toggle?.textContent,
        expanded: toggle?.getAttribute('aria-expanded'),
        collapsed: content?.classList.contains('msg-user-content--collapsed'),
      },
    };
  });
}

async function longPressPointer(page) {
  return page.evaluate(async () => {
    const bubble = document.querySelector('.msg-user-bubble');
    bubble.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true,
      pointerType: 'touch',
      clientX: 312,
      clientY: 280,
    }));
    await new Promise((resolve) => setTimeout(resolve, 580));
    return {
      menuCount: document.querySelectorAll('.msg-touch-menu').length,
      labels: [...document.querySelectorAll('.msg-touch-menu .msg-action-btn__label')]
        .map((node) => node.textContent),
      visible: (() => {
        const menu = document.querySelector('.msg-touch-menu');
        return !!menu && menu.classList.contains('is-open') && menu.style.visibility === 'visible';
      })(),
    };
  });
}

async function longPressThroughMessageReplacement(page) {
  return page.evaluate(async () => {
    const oldNode = document.querySelector('.msg-user');
    const oldBubble = oldNode?.querySelector('.msg-user-bubble');
    oldBubble?.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true,
      pointerType: 'touch',
      clientX: 312,
      clientY: 280,
    }));
    await new Promise((resolve) => setTimeout(resolve, 180));
    const replacement = createUserMessageNode({
      role: 'user',
      requestId: 'replacement-request',
      seq: 2,
      content: 'long press this user message',
    });
    replacement.classList.add('is-editable');
    oldNode?.replaceWith(replacement);
    await new Promise((resolve) => setTimeout(resolve, 420));
    const menu = document.querySelector('.msg-touch-menu');
    return {
      menuCount: document.querySelectorAll('.msg-touch-menu').length,
      visible: menu?.classList.contains('is-open') === true && menu?.style.visibility === 'visible',
    };
  });
}

const browser = await chromium.launch({ headless: true });
try {
  const pointerPage = await createPage(browser);
  try {
    assert.equal(await appendUserMessage(pointerPage.page, 'pointer-request'), true);
    const disclosure = await readUserMessageDisclosure(pointerPage.page);
    assert.equal(disclosure.before.shortToggle, false, 'short messages should not add an unnecessary disclosure control');
    assert.deepEqual(disclosure.before, {
      shortToggle: false,
      label: 'message.expand',
      expanded: 'false',
      collapsed: true,
    }, 'long user messages should begin collapsed with an accessible expand control');
    assert.deepEqual(disclosure.after, {
      label: 'message.collapse',
      expanded: 'true',
      collapsed: false,
    }, 'expanding should reveal the complete message and update the control state');
    const pointerResult = await longPressPointer(pointerPage.page);
    assert.equal(pointerResult.menuCount, 1, 'touch long press should open the message menu even in desktop layout state');
    assert.equal(pointerResult.visible, true, 'the opened message menu should be visible');
    assert.deepEqual(pointerResult.labels, ['action.copy', 'message.forkFromHere', 'message.editAndResend']);
  } finally {
    await pointerPage.context.close();
  }

  const replacementPage = await createPage(browser);
  try {
    assert.equal(await appendUserMessage(replacementPage.page, 'replacement-request'), true);
    const replacementResult = await longPressThroughMessageReplacement(replacementPage.page);
    assert.equal(replacementResult.menuCount, 1, 'a refreshed message should keep the pending long press attached');
    assert.equal(replacementResult.visible, true, 'a refreshed message should still show the long-press menu');
  } finally {
    await replacementPage.context.close();
  }

  const touchPage = await createPage(browser, { disablePointerEvents: true });
  try {
    assert.equal(await appendUserMessage(touchPage.page, 'touch-request'), true);
    const touchResult = await touchPage.page.evaluate(async () => {
      const bubble = document.querySelector('.msg-user-bubble');
      const touch = new Touch({
        identifier: 1,
        target: bubble,
        clientX: 312,
        clientY: 280,
      });
      bubble.dispatchEvent(new TouchEvent('touchstart', {
        bubbles: true,
        touches: [touch],
      }));
      await new Promise((resolve) => setTimeout(resolve, 580));
      return {
        menuCount: document.querySelectorAll('.msg-touch-menu').length,
        visible: document.querySelector('.msg-touch-menu')?.classList.contains('is-open') === true,
      };
    });
    assert.equal(touchResult.menuCount, 1, 'Touch Events fallback should open the message menu');
    assert.equal(touchResult.visible, true, 'Touch Events fallback menu should be visible');
  } finally {
    await touchPage.context.close();
  }

  const assistantPage = await createPage(browser);
  try {
    const appended = await assistantPage.page.evaluate(() => {
      const node = renderMessageInto(messagesInner, {
        role: 'assistant',
        requestId: 'assistant-test-request',
        seq: 2,
        content: 'This is an assistant response that can be copied or regenerated.',
      });
      return node !== null && node.classList.contains('msg-assistant');
    });
    assert.equal(appended, true, 'assistant message should be rendered');
    const assistantResult = await assistantPage.page.evaluate(async () => {
      const node = document.querySelector('.msg-assistant');
      node.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true,
        pointerType: 'touch',
        clientX: 100,
        clientY: 200,
      }));
      await new Promise((resolve) => setTimeout(resolve, 450));
      return {
        menuCount: document.querySelectorAll('.msg-touch-menu').length,
        labels: [...document.querySelectorAll('.msg-touch-menu .msg-action-btn__label')].map((n) => n.textContent),
        visible: (() => {
          const menu = document.querySelector('.msg-touch-menu');
          return !!menu && menu.classList.contains('is-open') && menu.style.visibility === 'visible';
        })(),
      };
    });
    assert.equal(assistantResult.menuCount, 1, 'assistant long press should open touch menu');
    assert.equal(assistantResult.visible, true, 'assistant touch menu should be visible');
    assert.deepEqual(assistantResult.labels, ['action.copy', 'message.forkFromHere', 'message.regenerate']);
  } finally {
    await assistantPage.context.close();
  }

  const streamingPage = await createPage(browser);
  try {
    const settled = await streamingPage.page.evaluate(() => {
      const streamingNode = document.createElement('div');
      streamingNode.className = 'msg-assistant msg-assistant-streaming';
      streamingNode.dataset.requestId = 'streaming-test-request';
      messagesInner.appendChild(streamingNode);
      const finalNode = renderMessageIntoStreamingNode(streamingNode, {
        role: 'assistant',
        requestId: 'streaming-test-request',
        seq: 3,
        content: 'Streamed message settled.',
      });
      return finalNode !== null;
    });
    assert.equal(settled, true, 'streaming node should settle');
    const result = await streamingPage.page.evaluate(async () => {
      const node = document.querySelector('.msg-assistant');
      node.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true,
        pointerType: 'touch',
        clientX: 100,
        clientY: 200,
      }));
      await new Promise((resolve) => setTimeout(resolve, 450));
      return {
        menuCount: document.querySelectorAll('.msg-touch-menu').length,
        visible: document.querySelector('.msg-touch-menu')?.classList.contains('is-open') === true,
      };
    });
    assert.equal(result.menuCount, 1, 'settled streaming assistant should open touch menu');
    assert.equal(result.visible, true, 'settled assistant touch menu should be visible');
  } finally {
    await streamingPage.context.close();
  }

  const jitterPage = await createPage(browser);
  try {
    assert.equal(await appendUserMessage(jitterPage.page, 'jitter-request'), true);
    const result = await jitterPage.page.evaluate(async () => {
      const bubble = document.querySelector('.msg-user-bubble');
      bubble.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true,
        pointerType: 'touch',
        clientX: 300,
        clientY: 200,
      }));
      // 12px x and 12px y movement -> distance = sqrt(144 + 144) ~= 16.97px <= 24px tolerance
      bubble.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true,
        pointerType: 'touch',
        clientX: 312,
        clientY: 212,
      }));
      await new Promise((resolve) => setTimeout(resolve, 450));
      return {
        menuCount: document.querySelectorAll('.msg-touch-menu').length,
        visible: document.querySelector('.msg-touch-menu')?.classList.contains('is-open') === true,
      };
    });
    assert.equal(result.menuCount, 1, 'minor jitter under tolerance should not cancel long press');
    assert.equal(result.visible, true);
  } finally {
    await jitterPage.context.close();
  }

  const movePage = await createPage(browser);
  try {
    assert.equal(await appendUserMessage(movePage.page, 'move-request'), true);
    const result = await movePage.page.evaluate(async () => {
      const bubble = document.querySelector('.msg-user-bubble');
      bubble.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true,
        pointerType: 'touch',
        clientX: 300,
        clientY: 200,
      }));
      // 20px x and 20px y movement -> distance = sqrt(400 + 400) ~= 28.28px > 24px tolerance
      bubble.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true,
        pointerType: 'touch',
        clientX: 320,
        clientY: 220,
      }));
      await new Promise((resolve) => setTimeout(resolve, 450));
      return {
        menuCount: document.querySelectorAll('.msg-touch-menu').length,
      };
    });
    assert.equal(result.menuCount, 0, 'large move exceeding tolerance should cancel long press');
  } finally {
    await movePage.context.close();
  }

  // Platform pan-hold contract. On phones the browser owns vertical panning
  // (touch-action: pan-y) and claims the gesture as soon as a real finger
  // drifts past its own scroll slop (~8px, well inside the 24px menu
  // tolerance) — the resulting pointercancel killed the press before the
  // threshold and the menu never opened. The hold must therefore block the
  // pan itself while the drift stays inside the tolerance: a non-passive
  // touchmove that preventDefaults in-tolerance movement and releases it past
  // the tolerance. Synthetic PointerEvents cannot express this (they carry no
  // scroll semantics), so drive it with cancelable TouchEvents.
  const panHoldPage = await createPage(browser);
  try {
    assert.equal(await appendUserMessage(panHoldPage.page, 'pan-hold-request'), true);
    const result = await panHoldPage.page.evaluate(async () => {
      const bubble = document.querySelector('.msg-user-bubble');
      const makeTouch = (x, y) => new Touch({ identifier: 1, target: bubble, clientX: x, clientY: y });
      const fire = (type, x, y) => {
        const touch = makeTouch(x, y);
        const event = new TouchEvent(type, {
          touches: type === 'touchend' ? [] : [touch],
          changedTouches: [touch],
          bubbles: true,
          cancelable: type !== 'touchend',
        });
        bubble.dispatchEvent(event);
        return event.defaultPrevented;
      };
      fire('touchstart', 300, 200);
      const pressingDuringHold = document.querySelector('.msg-user-bubble')?.classList.contains('is-touch-pressing');
      // 5px drift: under the platform scroll slop but a real finger does this
      // constantly — the hold must claim the pan (preventDefault) to survive.
      const driftPrevented = fire('touchmove', 303, 204);
      // 40px move: past the tolerance — release the pan and cancel the menu.
      const overshootPrevented = fire('touchmove', 340, 200);
      await new Promise((resolve) => setTimeout(resolve, 450));
      return {
        pressingDuringHold,
        driftPrevented,
        overshootPrevented,
        pressingAfterOvershoot: document.querySelector('.msg-user-bubble')?.classList.contains('is-touch-pressing'),
        menuCount: document.querySelectorAll('.msg-touch-menu').length,
      };
    });
    assert.equal(result.pressingDuringHold, true, 'a touch hold should show the pressing state');
    assert.equal(result.driftPrevented, true,
      'in-tolerance drift must block the platform pan (non-passive touchmove) or phones cancel the hold with pointercancel');
    assert.equal(result.overshootPrevented, false,
      'movement past the tolerance must release the pan so the transcript scrolls');
    assert.equal(result.pressingAfterOvershoot, false, 'movement past the tolerance should cancel the press state');
    assert.equal(result.menuCount, 0, 'movement past the tolerance should not open the menu');
  } finally {
    await panHoldPage.context.close();
  }

  // Real input pipeline: drive the hold through CDP touch dispatch (the same
  // path a phone's finger takes through the browser's gesture recognizer)
  // instead of synthetic dispatchEvent.
  const realInputPage = await createPage(browser);
  try {
    assert.equal(await appendUserMessage(realInputPage.page, 'real-input-request'), true);
    const cdp = await realInputPage.context.newCDPSession(realInputPage.page);
    const box = await realInputPage.page.evaluate(() => {
      const rect = document.querySelector('.msg-user-bubble').getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + Math.min(rect.height / 2, 40) };
    });
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: box.x, y: box.y, radiusX: 6, radiusY: 6, force: 0.6 }],
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: box.x + 3, y: box.y + 2, radiusX: 6, radiusY: 6, force: 0.6 }],
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const midHold = await realInputPage.page.evaluate(() => ({
      menuOpen: document.querySelectorAll('.msg-touch-menu').length,
      visible: document.querySelector('.msg-touch-menu')?.classList.contains('is-open') === true,
    }));
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    assert.equal(midHold.menuOpen, 1, 'a real touch hold should open the menu before the finger lifts');
    assert.equal(midHold.visible, true);
  } finally {
    await realInputPage.context.close();
  }

  const inlineCodePage = await createPage(browser);
  try {
    await inlineCodePage.page.evaluate(() => {
      const node = createUserMessageNode({
        role: 'user',
        requestId: 'inline-code-request',
        seq: 1,
        content: 'Check `git status` now',
      });
      node.classList.add('is-editable');
      messagesInner.appendChild(node);
      const bubble = node.querySelector('.msg-user-bubble');
      bubble.innerHTML = '<span class="md-content">Check <code>git status</code> now</span>';
    });
    const codeResult = await inlineCodePage.page.evaluate(async () => {
      const codeEl = document.querySelector('.msg-user-bubble code');
      codeEl.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true,
        pointerType: 'touch',
        clientX: 300,
        clientY: 200,
      }));
      await new Promise((resolve) => setTimeout(resolve, 450));
      return {
        menuCount: document.querySelectorAll('.msg-touch-menu').length,
        visible: document.querySelector('.msg-touch-menu')?.classList.contains('is-open') === true,
      };
    });
    assert.equal(codeResult.menuCount, 1, 'long press directly on inline code inside bubble should open touch menu');
    assert.equal(codeResult.visible, true);
  } finally {
    await inlineCodePage.context.close();
  }

  const timelinePage = await createPage(browser);
  try {
    const rendered = await timelinePage.page.evaluate(() => {
      const events = [
        {
          id: 'evt-1',
          seq: 1,
          type: 'user_message',
          role: 'user',
          requestId: 'tl-req-1',
          content: 'Hello timeline user',
        },
        {
          id: 'evt-2',
          seq: 2,
          type: 'assistant_message',
          role: 'assistant',
          requestId: 'tl-req-1',
          content: 'Hello timeline assistant',
        },
      ];
      window.RagentTimelineRuntime.reset('tl-session');
      window.RagentTimelineRuntime.renderBatch(events, { live: false });
      return {
        userBubble: !!document.querySelector('.msg-user-bubble'),
        assistantNode: !!document.querySelector('.msg-assistant'),
      };
    });
    assert.equal(rendered.userBubble, true, 'timeline runtime should render user bubble');
    assert.equal(rendered.assistantNode, true, 'timeline runtime should render assistant node');

    const userResult = await timelinePage.page.evaluate(async () => {
      const bubble = document.querySelector('.msg-user-bubble');
      bubble.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true,
        pointerType: 'touch',
        clientX: 250,
        clientY: 100,
      }));
      const pressing = bubble.classList.contains('is-touch-pressing');
      await new Promise((resolve) => setTimeout(resolve, 450));
      return {
        pressing,
        menuCount: document.querySelectorAll('.msg-touch-menu').length,
        visible: document.querySelector('.msg-touch-menu')?.classList.contains('is-open') === true,
        labels: [...document.querySelectorAll('.msg-touch-menu .msg-action-btn__label')].map((n) => n.textContent),
      };
    });
    assert.equal(userResult.pressing, true, 'timeline user message should show is-touch-pressing feedback');
    assert.equal(userResult.menuCount, 1, 'timeline user message should open touch menu on long press');
    assert.equal(userResult.visible, true);
    assert.ok(userResult.labels.includes('action.copy'));

    await timelinePage.page.evaluate(() => closeMessageTouchMenu());

    const assistantResult = await timelinePage.page.evaluate(async () => {
      const assistant = document.querySelector('.msg-assistant');
      assistant.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true,
        pointerType: 'touch',
        clientX: 100,
        clientY: 200,
      }));
      const pressing = assistant.classList.contains('is-touch-pressing');
      await new Promise((resolve) => setTimeout(resolve, 450));
      return {
        pressing,
        menuCount: document.querySelectorAll('.msg-touch-menu').length,
        visible: document.querySelector('.msg-touch-menu')?.classList.contains('is-open') === true,
        labels: [...document.querySelectorAll('.msg-touch-menu .msg-action-btn__label')].map((n) => n.textContent),
      };
    });
    assert.equal(assistantResult.pressing, true, 'timeline assistant message should show is-touch-pressing feedback');
    assert.equal(assistantResult.menuCount, 1, 'timeline assistant message should open touch menu on long press');
    assert.equal(assistantResult.visible, true);
    assert.ok(assistantResult.labels.includes('action.copy'));
  } finally {
    await timelinePage.context.close();
  }
} finally {
  await browser.close();
}

console.log('test-chat-message-touch-menu: ok');
