#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

const chatMessagesCss = readFileSync(join(repoRoot, 'static', 'chat', 'chat-messages.css'), 'utf8');
const chatInputCss = readFileSync(join(repoRoot, 'static', 'chat', 'chat-input.css'), 'utf8');
const chatBaseCss = readFileSync(join(repoRoot, 'static', 'chat', 'chat-base.css'), 'utf8');
const chatResponsiveCss = readFileSync(join(repoRoot, 'static', 'chat', 'chat-responsive.css'), 'utf8');
const chatHtml = readFileSync(join(repoRoot, 'templates', 'chat.html'), 'utf8');
const realtimeRenderSource = readFileSync(join(repoRoot, 'static', 'chat', 'realtime-render.js'), 'utf8');

console.log('--- 1. Verify CSS styles for streaming caret & unread FAB dot ---');
assert.match(
  chatMessagesCss,
  /\.streaming-caret\s*\{[\s\S]*?width:\s*0;[\s\S]*?position:\s*relative;/,
  '.streaming-caret should have zero layout width to prevent premature line wrapping',
);
assert.match(
  chatMessagesCss,
  /\.streaming-caret::after\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?width:\s*3px;[\s\S]*?height:\s*1\.05em;[\s\S]*?background:\s*currentColor;[\s\S]*?animation:\s*streaming-caret-pulse/,
  '.streaming-caret::after should render the classic thin vertical bar cursor',
);
assert.match(
  chatMessagesCss,
  /@keyframes streaming-caret-pulse\s*\{\s*0%, 100%\s*\{\s*opacity:\s*0\.85;\s*\}\s*50%\s*\{\s*opacity:\s*0\.3;\s*\}\s*\}/,
  '@keyframes streaming-caret-pulse should be a soft opacity-only blink',
);
assert.doesNotMatch(
  chatMessagesCss,
  /@keyframes streaming-caret-pulse\s*\{[^{}]*transform:/,
  '@keyframes streaming-caret-pulse should not scale or glow the bar',
);
assert.match(
  chatMessagesCss,
  /\.scroll-to-bottom-fab\.is-streaming-unread::after\s*\{[\s\S]*?animation:\s*streaming-fab-dot-pulse/,
  '.scroll-to-bottom-fab.is-streaming-unread should display an unread pulse dot',
);
assert.match(
  chatMessagesCss,
  /@keyframes streaming-fab-dot-pulse\s*\{/,
  '@keyframes streaming-fab-dot-pulse should be defined',
);

console.log('--- 2. Verify mobile touch user message long-press menu & ChatGPT-style assistant actions ---');
assert.match(
  chatMessagesCss,
  /\.msg-user\s*\.msg-meta,\s*\.msg-user-local-echo\s*\.msg-meta\s*\{[\s\S]*?display:\s*none !important;/,
  '.msg-user .msg-meta should be hidden on touch devices, reserving actions for long-press',
);
assert.match(
  chatMessagesCss,
  /\.msg-touch-menu\s*\{[\s\S]*?padding:\s*0;[\s\S]*?overflow:\s*hidden;[\s\S]*?border:\s*0;[\s\S]*?border-radius:\s*13px;/,
  '.msg-touch-menu should use a flat borderless OneUI edge-to-edge container layout',
);
assert.match(
  chatMessagesCss,
  /\.msg-touch-menu \.msg-action-btn\s*\{[\s\S]*?border-radius:\s*0;/,
  '.msg-touch-menu .msg-action-btn should use edge-to-edge rows without nested card radii',
);
assert.match(
  chatMessagesCss,
  /\.msg-assistant \.msg-actions\s*\{[\s\S]*?gap:\s*3px;/,
  '.msg-assistant .msg-actions should use compact ChatGPT-style gap',
);

console.log('--- 3. Verify composer add menu & panel origin-aware animations ---');
assert.match(
  chatInputCss,
  /\.composer-add-menu\.is-open\s*\{[\s\S]*?animation:\s*composer-menu-rise-in/,
  '.composer-add-menu.is-open should use composer-menu-rise-in',
);
assert.match(
  chatInputCss,
  /\.composer-add-menu\.is-closing\s*\{[\s\S]*?animation:\s*composer-menu-sink-out/,
  '.composer-add-menu.is-closing should use composer-menu-sink-out',
);
assert.match(
  chatInputCss,
  /\.composer-add-panel\.is-open\s*\{[\s\S]*?animation:\s*composer-menu-rise-in/,
  '.composer-add-panel.is-open should use composer-menu-rise-in',
);
assert.match(
  chatInputCss,
  /@keyframes composer-menu-rise-in\s*\{[\s\S]*?transform:\s*translateY\(10px\) scale\(0\.94\)[\s\S]*?transform:\s*translateY\(0\) scale\(1\)/,
  '@keyframes composer-menu-rise-in should ascend from below',
);
assert.match(
  chatInputCss,
  /@keyframes composer-menu-sink-out\s*\{[\s\S]*?transform:\s*translateY\(0\) scale\(1\)[\s\S]*?transform:\s*translateY\(8px\) scale\(0\.96\)/,
  '@keyframes composer-menu-sink-out should descend back towards the trigger button',
);

console.log('--- 4. Verify mobile header overflow bottom sheet ---');
assert.match(
  chatBaseCss,
  /@keyframes sheet-slide-up\s*\{[\s\S]*?transform:\s*translateY\(100%\)[\s\S]*?transform:\s*translateY\(0\)/,
  '@keyframes sheet-slide-up should be defined in chat-base.css',
);
assert.match(
  chatBaseCss,
  /@keyframes sheet-slide-down\s*\{[\s\S]*?transform:\s*translateY\(0\)[\s\S]*?transform:\s*translateY\(100%\)/,
  '@keyframes sheet-slide-down should be defined in chat-base.css',
);
assert.match(
  chatResponsiveCss,
  /\.header-overflow-menu\s*\{[\s\S]*?bottom:\s*0;[\s\S]*?border-radius:\s*24px 24px 0 0 !important;/,
  '.header-overflow-menu should position as bottom sheet on mobile screens',
);
assert.match(
  chatResponsiveCss,
  /\.header-overflow-menu::before\s*\{[\s\S]*?border-radius:\s*999px;/,
  '.header-overflow-menu should include a drag handle pill on mobile',
);
assert.match(
  chatResponsiveCss,
  /\.header-overflow-menu\.is-open\s*\{[\s\S]*?animation:\s*sheet-slide-up/,
  '.header-overflow-menu.is-open should slide up on mobile',
);

console.log('--- 5. Verify emptyState initial hidden state in chat.html ---');
assert.match(
  chatHtml,
  /<div class="empty-state" id="emptyState" hidden>/,
  '#emptyState should have initial hidden attribute in templates/chat.html to prevent FOES',
);

console.log('--- 6. Verify runtime caret deep anchoring in VM ---');
function createMockNode(tagName = 'div') {
  const children = [];
  const classes = new Set();
  const node = {
    tagName: tagName.toUpperCase(),
    children,
    parentNode: null,
    appendChild(c) {
      c.parentNode = this;
      children.push(c);
      return c;
    },
    querySelector(sel) {
      if (sel === 'code') return children.find((ch) => ch.tagName === 'CODE') || null;
      return null;
    },
    classList: {
      add(c) { classes.add(c); },
      remove(c) { classes.delete(c); },
      contains(c) { return classes.has(c); },
      toggle(c, force) {
        if (force === true) { classes.add(c); return true; }
        if (force === false) { classes.delete(c); return false; }
        return classes.has(c) ? (classes.delete(c), false) : (classes.add(c), true);
      },
    },
    get className() { return Array.from(classes).join(' '); },
    set className(v) {
      classes.clear();
      (v || '').split(/\s+/).filter(Boolean).forEach((c) => classes.add(c));
    },
  };
  return node;
}

const sandbox = {
  console,
  window: {},
  document: {
    createElement: (tag) => createMockNode(tag),
    getElementById: () => null,
  },
  performance: { now: () => 1000 },
  requestAnimationFrame: (cb) => setTimeout(cb, 0),
  cancelAnimationFrame: () => {},
  messagesEl: {
    scrollHeight: 1000,
    scrollTop: 900,
    clientHeight: 200,
    addEventListener: () => {},
  },
  messagesInner: createMockNode('div'),
  emptyState: createMockNode('div'),
};

const script = new vm.Script(realtimeRenderSource);
const context = vm.createContext(sandbox);
script.runInContext(context);

// Test getStreamingCaretAnchor
const body = createMockNode('div');
const table = createMockNode('table');
const tbody = createMockNode('tbody');
const tr = createMockNode('tr');
const td = createMockNode('td');
tr.appendChild(td);
tbody.appendChild(tr);
table.appendChild(tbody);
body.appendChild(table);

const anchor = context.getStreamingCaretAnchor(body);
assert.equal(anchor, td, 'getStreamingCaretAnchor should deep-dive through table/tbody/tr into the td leaf');

// Test pre > code anchor
const codeBody = createMockNode('div');
const pre = createMockNode('pre');
const code = createMockNode('code');
pre.appendChild(code);
codeBody.appendChild(pre);

const codeAnchor = context.getStreamingCaretAnchor(codeBody);
assert.equal(codeAnchor, code, 'getStreamingCaretAnchor should anchor directly inside code rather than wrapping pre');

// Test streamingUserScrollDetached trigger & reset
assert.equal(typeof context.window.RagentStreamingPresentation.isScrollDetached, 'function', 'isScrollDetached should be exposed');
assert.equal(context.window.RagentStreamingPresentation.isScrollDetached(), false, 'should initially be false');

context.window.RagentStreamingPresentation.setScrollDetached(true);
assert.equal(context.window.RagentStreamingPresentation.isScrollDetached(), true, 'setScrollDetached(true) should set isScrollDetached to true');

// Scroll-detach is user intent: pacing resets fire at every inter-chunk drain
// and on presentation cancel, so they must NOT re-attach mid-turn. Only turn
// boundaries clear the flag (new streaming bubble, transcript reset, FAB
// click, near-bottom attach).
context.resetStreamingPacingState();
assert.equal(context.window.RagentStreamingPresentation.isScrollDetached(), true, 'resetStreamingPacingState must preserve isScrollDetached (only turn boundaries clear it)');

context.window.RagentStreamingPresentation.setScrollDetached(false);
context.resetStreamingPacingState();
assert.equal(context.window.RagentStreamingPresentation.isScrollDetached(), false, 'resetStreamingPacingState must not set isScrollDetached on its own');

console.log('test-chat-streaming-and-menu-motion: ok');
