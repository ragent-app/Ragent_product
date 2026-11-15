#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const uiSource = readFileSync(join(repoRoot, 'static', 'chat', 'ui.js'), 'utf8');
const inputCss = readFileSync(join(repoRoot, 'static', 'chat', 'chat-input.css'), 'utf8');
const messagesCss = readFileSync(join(repoRoot, 'static', 'chat', 'chat-messages.css'), 'utf8');
const workbenchCss = readFileSync(join(repoRoot, 'static', 'chat', 'chat-workbench.css'), 'utf8');

function extractFunctionSource(source, functionName) {
  const marker = `function ${functionName}`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${functionName} should exist`);
  const paramsStart = source.indexOf('(', start);
  let paramsDepth = 0;
  let braceStart = -1;
  for (let index = paramsStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '(') paramsDepth += 1;
    if (char === ')') {
      paramsDepth -= 1;
      if (paramsDepth === 0) {
        braceStart = source.indexOf('{', index);
        break;
      }
    }
  }
  assert.notEqual(braceStart, -1, `${functionName} should have a body`);
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`Unable to extract ${functionName}`);
}

function makeClassList(element) {
  const classes = new Set();
  return {
    add(name) {
      classes.add(name);
      element.className = Array.from(classes).join(' ');
    },
    remove(name) {
      classes.delete(name);
      element.className = Array.from(classes).join(' ');
    },
    contains(name) {
      return classes.has(name);
    },
  };
}

function makeElement(tagName = 'div') {
  const element = {
    tagName: String(tagName).toUpperCase(),
    className: '',
    dataset: {},
    children: [],
    id: '',
    textContent: '',
    innerHTML: '',
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    addEventListener(type, handler) {
      this[`on${type}`] = handler;
    },
    setAttribute(name, value) {
      this[name] = String(value);
    },
    insertBefore(child, before) {
      const index = this.children.indexOf(before);
      if (index >= 0) {
        this.children.splice(index, 0, child);
      } else {
        this.children.push(child);
      }
      child.parentElement = this;
      child.parentNode = this;
      return child;
    },
  };
  element.classList = makeClassList(element);
  return element;
}

const context = {
  console,
  Set,
  JSON,
  document: {
    createElement: makeElement,
  },
  window: {
    RagentIcons: {
      render(name, options = {}) {
        return `<svg class="rl-icon ${options.className || ''}" data-name="${name}"></svg>`;
      },
    },
    ragentT(key, vars = {}) {
      if (key === 'workbench.editing') return 'Editing';
      if (key === 'workbench.editingStats') {
        return `${vars.added} lines added, ${vars.removed} lines removed`;
      }
      if (key === 'workbench.editingStatsUnknown') return 'Line changes updating';
      if (key === 'ui.toolFallback') return 'tool';
      return key;
    },
  },
  esc(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  },
};
context.globalThis = context;

vm.runInNewContext(
  [
    'const FILE_EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);',
    extractFunctionSource(uiSource, 't'),
    extractFunctionSource(uiSource, 'renderUiIcon'),
    extractFunctionSource(uiSource, 'parseFileEditToolInput'),
    extractFunctionSource(uiSource, 'computeLineDiff'),
    extractFunctionSource(uiSource, 'getFileNameForEditingStatus'),
    extractFunctionSource(uiSource, 'summarizeFileEditEvent'),
    extractFunctionSource(uiSource, 'readEditingStatNumber'),
    extractFunctionSource(uiSource, 'summarizeFileChangeEditingEvent'),
    extractFunctionSource(uiSource, 'renderEditingStatsHtml'),
    extractFunctionSource(uiSource, 'getEditingStatsAriaLabel'),
    extractFunctionSource(uiSource, 'applyEditingSummaryToThinkingBlock'),
    extractFunctionSource(uiSource, 'getContainingThinkingBlock'),
    extractFunctionSource(uiSource, 'shouldUseLiveThinkingBlockForEditing'),
    extractFunctionSource(uiSource, 'renderFileEditInlineStatusInto'),
    'globalThis.shouldUseLiveThinkingBlockForEditing = shouldUseLiveThinkingBlockForEditing;',
    'globalThis.renderFileEditInlineStatusInto = renderFileEditInlineStatusInto;',
    'globalThis.applyEditingSummaryToThinkingBlock = applyEditingSummaryToThinkingBlock;',
  ].join('\n\n'),
  context,
  { filename: 'static/chat/ui.js' },
);

const liveThinkingBlock = makeElement('div');
const liveThinkingBody = makeElement('div');
context.currentThinkingBlock = { block: liveThinkingBlock, body: liveThinkingBody };
assert.equal(
  context.shouldUseLiveThinkingBlockForEditing(makeElement('div'), liveThinkingBlock),
  false,
  'loaded or unrelated edit containers should not rewrite the live thinking header',
);
assert.equal(
  context.shouldUseLiveThinkingBlockForEditing(liveThinkingBody, liveThinkingBlock),
  true,
  'live edit containers should still update the current thinking header',
);

const fileChangeSummary = context.summarizeFileChangeEditingEvent({
  type: 'file_change',
  filePath: '/srv/ragent-promoted/static/chat/ui.js',
  changeType: 'modified',
});
assert.ok(fileChangeSummary, 'file changes should be usable as editing signals');
assert.equal(fileChangeSummary.fileName, 'ui.js', 'file change editing signals should expose the active filename');
assert.equal(fileChangeSummary.hasLineStats, false, 'plain file changes should not pretend to have diff stats');
assert.equal(context.renderEditingStatsHtml(fileChangeSummary), '', 'unknown file change stats should not render fake +0/-0 values');
assert.match(
  context.renderEditingStatsHtml(fileChangeSummary, { showUnknown: true }),
  /class="diff-stat-add editing-stat editing-stat-unknown">\+…<\/span>/,
  'unknown file change stats should still render an animated added-lines placeholder',
);
assert.match(
  context.renderEditingStatsHtml(fileChangeSummary, { showUnknown: true }),
  /class="diff-stat-del editing-stat editing-stat-unknown">-…<\/span>/,
  'unknown file change stats should still render an animated removed-lines placeholder',
);

const thinkingHeader = makeElement('div');
const thinkingLabel = makeElement('span');
const thinkingChevron = makeElement('span');
const thinkingBlock = makeElement('div');
thinkingHeader.querySelector = (selector) => {
  if (selector === '.thinking-label') return thinkingLabel;
  if (selector === '.thinking-edit-stats') {
    return thinkingHeader.children.find((child) => child.className === 'thinking-edit-stats') || null;
  }
  if (selector === '.thinking-chevron') return thinkingChevron;
  return null;
};
thinkingBlock.querySelector = (selector) => (selector === '.thinking-header' ? thinkingHeader : null);
thinkingHeader.appendChild(thinkingLabel);
thinkingHeader.appendChild(thinkingChevron);
thinkingBlock.appendChild(thinkingHeader);
assert.equal(
  context.applyEditingSummaryToThinkingBlock(thinkingBlock, {
    filePath: '/srv/ragent-promoted/static/chat/ui.js',
    fileName: 'ui.js',
    totalAdded: 2,
    totalRemoved: 1,
  }),
  true,
  'thinking header should accept a real edit summary',
);
const statsAfterRealEdit = thinkingHeader.querySelector('.thinking-edit-stats');
assert.match(statsAfterRealEdit.innerHTML, /\+2/, 'thinking header should show real added line count');
assert.match(statsAfterRealEdit.innerHTML, /-1/, 'thinking header should show real removed line count');
context.applyEditingSummaryToThinkingBlock(thinkingBlock, fileChangeSummary);
assert.match(
  thinkingHeader.querySelector('.thinking-edit-stats').innerHTML,
  /\+2/,
  'a later same-file file_change without stats should not erase real added line count',
);
assert.match(
  thinkingHeader.querySelector('.thinking-edit-stats').innerHTML,
  /-1/,
  'a later same-file file_change without stats should not erase real removed line count',
);

const row = context.renderFileEditInlineStatusInto(makeElement('div'), {
  id: 'edit_1',
  toolName: 'Edit',
  toolInput: JSON.stringify({
    file_path: '/srv/ragent-promoted/static/chat/ui.js',
    old_string: 'one\ntwo\nthree',
    new_string: 'one\nTWO\nfour',
  }),
}, { updateThinkingHeader: false });

assert.ok(row, 'file edit tools should render an inline editing status row');
assert.equal(row.className, 'thinking-edit-status', 'file edit status should use the thinking-line layout instead of a card');
assert.match(row.innerHTML, /class="thinking-edit-action">Editing</, 'editing label should be visible');
assert.match(row.innerHTML, /class="thinking-edit-file"[^>]*>ui\.js</, 'only the active filename should lead the editing status');
assert.match(row.innerHTML, /class="diff-stat-add editing-stat">\+2</, 'added line count should be shown');
assert.match(row.innerHTML, /class="diff-stat-del editing-stat">-2</, 'removed line count should be shown');

const notebookRow = context.renderFileEditInlineStatusInto(makeElement('div'), {
  id: 'notebook_1',
  toolName: 'NotebookEdit',
  toolInput: JSON.stringify({
    notebook_path: '/srv/ragent-promoted-data/workspace/report.ipynb',
    edit_mode: 'insert',
    new_source: 'print("done")',
  }),
}, { updateThinkingHeader: false });
assert.ok(notebookRow, 'NotebookEdit should reuse the inline editing status');
assert.match(notebookRow.innerHTML, />report\.ipynb</, 'NotebookEdit should display the notebook filename');
assert.match(uiSource, /renderFileEditInlineStatusInto\(container, evt\)/, 'live edit tool events should update the thinking-line editing status');
assert.match(uiSource, /renderFileEditInlineStatusInto\(container, event\)/, 'loaded hidden edit events should use the same inline status');
assert.match(uiSource, /renderFileChangeEditingStatusInto\(container, evt\)/, 'live file change events should update the thinking-line editing status');
assert.match(uiSource, /renderFileChangeEditingStatusInto\(container, event\)/, 'loaded hidden file changes should use the same thinking-line editing status');

assert.match(inputCss, /\.send-btn::before\s*\{[\s\S]*border-left:\s*12px solid #fff;/, 'send button should draw a white solid triangle');
assert.match(inputCss, /\.cancel-btn::before\s*\{[\s\S]*background:\s*#fff;/, 'cancel button should draw a white solid square');
assert.match(messagesCss, /@keyframes thinking-breathe/, 'thinking should use a breathing light animation');
assert.match(messagesCss, /\.thinking-block\.running \.thinking-icon\s*\{[^}]*color:\s*var\(--status-running, var\(--notice\)\);/, 'running thinking dot should share the Live Bar running blue');
assert.doesNotMatch(messagesCss, /@keyframes thinking-sweep/, 'the running-thinking text sweep was removed — persistent status text stays still (calm motion)');
assert.doesNotMatch(messagesCss, /@keyframes thinking-spin/, 'thinking should no longer use a spinning gear animation');
assert.match(messagesCss, /\.editing-stat\s*\{[\s\S]*animation:\s*editing-stat-pop/, 'editing counts should animate when they update');
assert.match(messagesCss, /\.thinking-block\.running:not\(\.editing\) \.thinking-label\s*\{[^}]*flex:\s*0 1 auto;[^}]*color:\s*var\(--text-muted\);/, 'plain running thinking text should render calm muted text instead of a sweeping gradient');
assert.doesNotMatch(messagesCss, /\.thinking-block\.running:not\(\.editing\) \.thinking-label\s*\{[^}]*\banimation\s*:|\.thinking-block\.running:not\(\.editing\) \.thinking-label\s*\{[^}]*background:/, 'plain running thinking text should not animate or carry a gradient fill');
assert.match(messagesCss, /\.thinking-block\.running\.editing \.thinking-label\s*\{[^}]*animation:\s*none;/, 'editing thinking text should explicitly stay still');
assert.doesNotMatch(messagesCss, /\.thinking-block\.running\.editing \.thinking-edit-action\s*\{[^}]*animation:|\.thinking-block\.running\.editing \.thinking-edit-file\s*\{[^}]*animation:/, 'editing action and filename text should not sweep');
assert.match(workbenchCss, /\.workbench-activity-editing/, 'workbench activity should expose a compact editing row');

console.log('test-chat-codex-status-ui: ok');
