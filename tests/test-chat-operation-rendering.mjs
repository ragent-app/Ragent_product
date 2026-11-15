#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const uiSource = readFileSync(join(repoRoot, 'static', 'chat', 'ui.js'), 'utf8');
const runActivitySource = readFileSync(join(repoRoot, 'static', 'chat', 'run-activity-ui.js'), 'utf8');

function extractFunctionSource(source, functionName) {
  const marker = `function ${functionName}`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${functionName} should exist in ui.js`);
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

function classNames(element) {
  return new Set(String(element.className || '').split(/\s+/).filter(Boolean));
}

function matchesSelector(element, selector) {
  if (selector.startsWith('.')) return classNames(element).has(selector.slice(1));
  if (selector === '[data-operation-id]') return !!String(element.dataset?.operationId || '');
  return false;
}

function makeElement(tagName = 'div') {
  const listeners = new Map();
  const element = {
    tagName: String(tagName).toUpperCase(),
    className: '',
    dataset: {},
    children: [],
    parentNode: null,
    hidden: false,
    disabled: false,
    textContent: '',
    innerHTML: '',
    title: '',
    appendChild(child) {
      this.children.push(child);
      child.parentNode = this;
      return child;
    },
    replaceChildren(...children) {
      this.children = [];
      for (const child of children) this.appendChild(child);
    },
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    click() {
      listeners.get('click')?.({ currentTarget: this });
    },
    setAttribute(name, value) {
      this[name] = String(value);
    },
    querySelector(selector) {
      for (const child of this.children) {
        if (matchesSelector(child, selector)) return child;
        const nested = child.querySelector?.(selector);
        if (nested) return nested;
      }
      return null;
    },
    querySelectorAll(selector) {
      const matches = [];
      for (const child of this.children) {
        if (matchesSelector(child, selector)) matches.push(child);
        matches.push(...(child.querySelectorAll?.(selector) || []));
      }
      return matches;
    },
  };
  element.classList = {
    contains(name) {
      return classNames(element).has(name);
    },
    add(name) {
      const names = classNames(element);
      names.add(name);
      element.className = [...names].join(' ');
    },
    remove(name) {
      const names = classNames(element);
      names.delete(name);
      element.className = [...names].join(' ');
    },
    toggle(name, force) {
      const names = classNames(element);
      const enabled = typeof force === 'boolean' ? force : !names.has(name);
      if (enabled) names.add(name);
      else names.delete(name);
      element.className = [...names].join(' ');
      return enabled;
    },
  };
  return element;
}

const translations = {
  'activity.label.command': 'Localized command',
  'activity.label.working': 'Working',
  'activity.action.running.command': 'Running {subject}',
  'activity.action.completed.command': 'Ran {subject}',
  'operation.state.running': 'In progress',
  'operation.state.completed': 'Completed',
  'operation.state.failed': 'Failed',
  'operation.state.declined': 'Declined',
  'operation.state.interrupted': 'Interrupted',
  'operation.state.waiting_approval': 'Waiting for approval',
  'operation.output.omitted': ({ count }) => `${count} lines omitted`,
  'operation.files.changed': ({ count }) => `${count} files changed`,
  'operation.exitCode': ({ code }) => `exit ${code}`,
};

const context = {
  console,
  Map,
  Set,
  Date,
  document: { createElement: makeElement },
  renderedEventState: {
    operationNodesById: new Map(),
    operationSnapshotsById: new Map(),
    expandedOperationIds: new Set(),
  },
  t(key, vars = {}) {
    const value = translations[key];
    return typeof value === 'function' ? value(vars) : (value || key);
  },
  renderUiIcon(name) {
    return `<svg data-icon="${name}"></svg>`;
  },
  async hydrateLazyNodes() {},
};
context.globalThis = context;
// The real module keeps this cap in a module-scoped const. The focused VM
// below extracts selected functions, so provide the same immutable value on
// the sandbox for the extracted bounded-index helper.
context.MAX_OPERATION_RENDER_INDEX_ENTRIES = 4096;
context.ragentT = (key, vars = {}) => {
  const value = translations[key];
  const text = typeof value === 'function' ? value(vars) : (value || key);
  return String(text).replace(/\{(\w+)\}/g, (match, name) => (
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match
  ));
};
vm.runInNewContext(runActivitySource, context, { filename: 'static/chat/run-activity-ui.js' });

const functionNames = [
  'ensureOperationRenderState',
  'setBoundedOperationIndex',
  'getOperationEventId',
  'normalizeOperationState',
  'getOperationLifecycle',
  'parseActivityTimestamp',
  'formatActivityElapsed',
  'getOperationStateLabel',
  'getOperationElapsedMs',
  'getOperationActivitySummary',
  'buildOperationPreviewLines',
  'setOperationExpanded',
  'createOperationBody',
  'renderOperationNodeContent',
  'getOperationDisplayKind',
  'getOperationNodeKind',
  'findFoldContainer',
  'setFoldCountLabel',
  'toggleFoldExpanded',
  'createFoldContainer',
  'appendOperationNode',
  'refreshFoldCountForNode',
  'updateOperationNode',
  'renderOperationInto',
  'getExpandedOperationIds',
  'rebuildRenderedOperationIndexes',
];
vm.runInNewContext(
  [
    ...functionNames.map((name) => extractFunctionSource(uiSource, name)),
    ...functionNames.map((name) => `globalThis.${name} = ${name};`),
  ].join('\n\n'),
  context,
  { filename: 'static/chat/ui.js' },
);

const container = makeElement('div');
const running = {
  type: 'operation',
  operationId: 'operation:run-1:cmd-1',
  kind: 'command',
  state: 'running',
  title: 'Server-side English title',
  detail: 'npm test',
  startedAt: Date.now() - 2500,
  outputPreview: {
    head: ['first line'],
    tail: ['last line'],
    totalLines: 8,
    omittedLines: 6,
  },
};

const originalNode = context.renderOperationInto(container, running);
assert.equal(container.children.length, 1, 'a new operation should append exactly one timeline node');
assert.equal(originalNode.dataset.operationId, running.operationId);
assert.equal(
  originalNode.querySelector('.live-operation-row__label')?.textContent,
  'In progress',
  'running operation labels should describe lifecycle state instead of repeating the action kind',
);
assert.equal(
  originalNode.querySelector('.live-operation-row__summary-text')?.textContent,
  'Running npm test',
  'running operation summaries should use a natural-language action sentence',
);
assert.match(
  originalNode.querySelector('.live-operation-row__output')?.textContent || '',
  /6 lines omitted/,
  'output previews should preserve the bounded omitted-line marker',
);

originalNode.querySelector('.live-operation-row__summary')?.click();
assert.equal(originalNode.classList.contains('is-expanded'), true, 'clicking a row with details should expand it');
assert.equal(originalNode.querySelector('.live-operation-row__body')?.hidden, false);

const completed = {
  ...running,
  state: 'completed',
  completedAt: Date.now(),
  durationMs: 2500,
  outputPreview: {
    head: ['all tests passed'],
    tail: [],
    totalLines: 1,
    omittedLines: 0,
    bodyAvailable: true,
    bodySeq: 19,
  },
};
const updatedNode = context.renderOperationInto(container, completed);
assert.equal(updatedNode, originalNode, 'terminal updates should reuse the original operation node');
assert.equal(container.children.length, 1, 'terminal updates must not append a duplicate command row');
assert.equal(updatedNode.classList.contains('state-completed'), true);
assert.equal(updatedNode.classList.contains('is-expanded'), true, 'in-place updates should retain expansion state');
assert.equal(
  updatedNode.querySelector('.live-operation-row__summary-text')?.textContent,
  'Ran npm test',
  'completed operation summaries should use the completed-action form',
);
assert.equal(updatedNode.querySelector('.live-operation-row__body')?.hidden, false);
assert.equal(updatedNode.querySelector('.live-operation-row__output')?.dataset.eventSeq, '19');
assert.equal(updatedNode.querySelector('.live-operation-row__output')?.dataset.bodyPending, 'true');

const failedNode = context.updateOperationNode({
  ...completed,
  state: 'failed',
  exitCode: 2,
});
assert.equal(failedNode, originalNode);
assert.equal(failedNode.classList.contains('state-failed'), true);
assert.equal(failedNode.querySelector('.live-operation-row__exit')?.textContent, 'exit 2');
assert.equal(container.children.length, 1);

context.renderedEventState.operationNodesById.clear();
context.renderedEventState.operationSnapshotsById.clear();
context.rebuildRenderedOperationIndexes(container, [completed]);
assert.equal(
  context.renderedEventState.operationNodesById.get(running.operationId),
  originalNode,
  'snapshot DOM restore should rebuild the stable operation node index',
);
assert.equal(context.getExpandedOperationIds().has(running.operationId), true);

console.log('test-chat-operation-rendering: ok');
