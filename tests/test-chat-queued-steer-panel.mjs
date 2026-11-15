#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const source = readFileSync(join(repoRoot, 'static', 'chat', 'session-surface-ui.js'), 'utf8');

function extractFunctionSource(functionName) {
  const asyncMarker = `async function ${functionName}`;
  const marker = `function ${functionName}`;
  const asyncStart = source.indexOf(asyncMarker);
  const start = asyncStart === -1 ? source.indexOf(marker) : asyncStart;
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

function makeClassList() {
  const values = new Set();
  return {
    add(token) {
      values.add(token);
    },
    remove(token) {
      values.delete(token);
    },
    toggle(token, force) {
      const shouldAdd = typeof force === 'boolean' ? force : !values.has(token);
      if (shouldAdd) values.add(token);
      else values.delete(token);
      return shouldAdd;
    },
    contains(token) {
      return values.has(token);
    },
  };
}

function matchesSelector(element, selector) {
  if (!element || typeof selector !== 'string') return false;
  const classNames = new Set(String(element.className || '').split(/\s+/).filter(Boolean));
  if (selector === '.queued-steer-menu') return classNames.has('queued-steer-menu');
  if (selector === '.queued-steer-menu-item') return classNames.has('queued-steer-menu-item');
  if (selector === '.queued-steer-action--more[aria-expanded="true"]') {
    return classNames.has('queued-steer-action--more') && element.attrs?.['aria-expanded'] === 'true';
  }
  if (selector.startsWith('.')) return classNames.has(selector.slice(1));
  return false;
}

function collectMatches(element, selector, results = []) {
  for (const child of element.children || []) {
    if (matchesSelector(child, selector)) results.push(child);
    collectMatches(child, selector, results);
  }
  return results;
}

function makeElement() {
  const listeners = new Map();
  const element = {
    children: [],
    className: '',
    textContent: '',
    title: '',
    type: '',
    dataset: {},
    attrs: {},
    style: {},
    parentNode: null,
    classList: makeClassList(),
    set innerHTML(value) {
      this.children = [];
      this._innerHTML = value;
    },
    get innerHTML() {
      return this._innerHTML || '';
    },
    setAttribute(name, value) {
      this.attrs[name] = String(value);
    },
    getAttribute(name) {
      return this.attrs[name];
    },
    addEventListener(type, handler) {
      const handlers = listeners.get(type) || [];
      handlers.push(handler);
      listeners.set(type, handlers);
    },
    dispatchEvent(event) {
      const nextEvent = event || {};
      if (!nextEvent.target) nextEvent.target = this;
      if (!nextEvent.preventDefault) nextEvent.preventDefault = () => {};
      let stopped = false;
      if (!nextEvent.stopPropagation) {
        nextEvent.stopPropagation = () => {
          stopped = true;
        };
      }
      for (const handler of listeners.get(nextEvent.type || 'input') || []) {
        handler(nextEvent);
      }
      if (!stopped && this.parentNode) {
        this.parentNode.dispatchEvent(nextEvent);
      }
      return true;
    },
    click() {
      this.dispatchEvent({ type: 'click', target: this });
    },
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    remove() {
      if (!this.parentNode) return;
      this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
      this.parentNode = null;
    },
    contains(target) {
      if (target === this) return true;
      return (this.children || []).some((child) => child.contains?.(target));
    },
    closest(selector) {
      let current = this;
      while (current) {
        if (matchesSelector(current, selector)) return current;
        current = current.parentNode;
      }
      return null;
    },
    querySelector(selector) {
      return collectMatches(this, selector)[0] || null;
    },
    querySelectorAll(selector) {
      return collectMatches(this, selector);
    },
    getBoundingClientRect() {
      return { bottom: 100, right: 200, top: 80, left: 180, width: 20, height: 20 };
    },
  };
  return element;
}

const queuedPanel = makeElement();
const msgInput = makeElement();
msgInput.value = '';
msgInput.style = {};
msgInput.focused = false;
msgInput.focus = () => {
  msgInput.focused = true;
};
msgInput.setSelectionRange = (start, end) => {
  msgInput.selectionStart = start;
  msgInput.selectionEnd = end;
};

const draftWrites = [];
const replacedAttachments = [];
const sendCalls = [];
const queueServerCalls = [];
const context = {
  console,
  queuedPanel,
  msgInput,
  // openQueuedSteerMenu pokes window.RagentBackHandler?.push?.() — an
  // absent handler must be a no-op in the harness.
  window: {},
  currentSessionId: 'session-a',
  Event: class {
    constructor(type, options = {}) {
      this.type = type;
      this.bubbles = options.bubbles === true;
    }
  },
  document: {
    createElement() {
      return makeElement();
    },
    addEventListener() {},
    removeEventListener() {},
    querySelector(selector) {
      return collectMatches(this.body, selector)[0] || null;
    },
    querySelectorAll(selector) {
      return collectMatches(this.body, selector);
    },
    body: makeElement(),
    documentElement: { clientWidth: 1024 },
  },
  t(key, vars = {}) {
    const dict = {
      'queue.attachmentOnly': '(attachment)',
      'queue.attachments': `Attachments: ${vars.names || ''}`,
      'queue.steerAction': 'Steer',
      'queue.editMessage': 'Edit message',
      'queue.turnOffQueueing': 'Turn off queueing',
      'queue.olderHidden.one': '1 older queued follow-up hidden',
      'queue.olderHidden.multiple': `${vars.count} older queued follow-ups hidden`,
      'action.delete': 'Delete',
      'action.more': 'More',
    };
    return dict[key] || key;
  },
  getAttachmentDisplayName(attachment) {
    return attachment?.filename || attachment?.originalName || '';
  },
  writeStoredDraft(sessionId, text) {
    draftWrites.push({ sessionId, text });
  },
  replaceComposerAttachmentsSnapshot(sessionId, attachments) {
    replacedAttachments.push({ sessionId, attachments });
  },
  autoResizeInput() {
    context.autoResizeCalls = (context.autoResizeCalls || 0) + 1;
  },
  renderImagePreviews() {
    context.previewCalls = (context.previewCalls || 0) + 1;
  },
  upsertSession(session) {
    context.lastUpsertedSession = session;
  },
  updateStatus(_status, session) {
    context.lastStatusSession = session;
  },
  sendMessage() {
    sendCalls.push({
      value: msgInput.value,
      attachments: replacedAttachments.at(-1)?.attachments || [],
    });
    msgInput.value = '';
  },
  pendingSend: null,
  clearedPendingRequestIds: [],
  syncComposerPendingUiCalls: 0,
  getComposerPendingSendState() {
    return context.pendingSend;
  },
  clearComposerPendingSendState(requestId = '') {
    context.clearedPendingRequestIds.push(requestId);
    if (!requestId || context.pendingSend?.requestId === requestId) {
      context.pendingSend = null;
    }
  },
  syncComposerPendingUi() {
    context.syncComposerPendingUiCalls += 1;
  },
  composerSendWillQueue(session) {
    return session?.activity?.run?.state === 'running';
  },
  async fetchJsonOrRedirect(url, options = {}) {
    queueServerCalls.push({ url, options });
    const body = JSON.parse(options.body || '{}');
    if (body.action === 'steer' || body.action === 'delete') {
      const remaining = [
        { requestId: 'queued-older', text: 'older steer' },
        { requestId: 'queued-latest', text: 'steer text' },
      ].filter((item) => item.requestId !== body.requestId);
      return {
        session: {
          id: 'session-a',
          activity: {
            run: {
              runtimeFamily: 'codex-app-server-json',
              providerCapabilities: { supportsSteer: true },
            },
          },
          queuedMessages: remaining,
        },
      };
    }
    if (body.action === 'clear') {
      return { session: { id: 'session-a', queuedMessages: [] } };
    }
    return { session: { id: 'session-a' } };
  },
};
context.globalThis = context;

vm.runInNewContext(
  [
    // Module-top state shared by the sliced functions: the slice starts at
    // function bodies and omits session-surface-ui.js:583's real
    // `let queuedSteerMenuBackEntryId = null;`. Without a hoisted
    // declaration in the vm realm the references in closeQueuedSteerMenu /
    // openQueuedSteerMenu throw "not defined". Browsers never hit this —
    // the module top-level runs before any call site.
    'let queuedSteerMenuBackEntryId = null;',
    extractFunctionSource('getQueuedMessageText'),
    extractFunctionSource('getQueuedMessageRequestId'),
    extractFunctionSource('getQueuedMessageAttachments'),
    extractFunctionSource('getQueuedMessageIndex'),
    extractFunctionSource('getQueuedMessageRemovalRequestIds'),
    extractFunctionSource('clearQueuedMessagePendingFeedback'),
    extractFunctionSource('getSessionQueuedToolId'),
    extractFunctionSource('getSessionQueuedRuntimeFamily'),
    extractFunctionSource('getSessionQueuedCapabilities'),
    extractFunctionSource('shouldRenderQueuedSteerActions'),
    extractFunctionSource('shouldAllowQueuedSteer'),
    extractFunctionSource('cloneSessionWithQueuedMessages'),
    extractFunctionSource('upsertQueuedSessionSnapshot'),
    extractFunctionSource('closeQueuedSteerMenu'),
    extractFunctionSource('setQueuedSteerRowBusy'),
    extractFunctionSource('setQueuedMessageIntoComposer'),
    extractFunctionSource('renderQueuedMessageOptimistically'),
    extractFunctionSource('updateQueuedMessageOnServer'),
    extractFunctionSource('steerQueuedMessageOnServer'),
    extractFunctionSource('removeQueuedMessage'),
    extractFunctionSource('submitQueuedMessage'),
    extractFunctionSource('handleQueuedSteerAction'),
    extractFunctionSource('renderQueuedSteerMenuItem'),
    extractFunctionSource('openQueuedSteerMenu'),
    extractFunctionSource('renderQueuedSteerAction'),
    extractFunctionSource('getQueuedMessageKey'),
    extractFunctionSource('isQueuedPanelChild'),
    extractFunctionSource('placeQueuedPanelChild'),
    extractFunctionSource('createQueuedSteerActions'),
    extractFunctionSource('syncQueuedMessageRowActions'),
    extractFunctionSource('updateQueuedMessageRow'),
    extractFunctionSource('renderQueuedMessageRow'),
    extractFunctionSource('renderQueuedMessageSummary'),
    extractFunctionSource('getQueuedPendingSendSnapshot'),
    extractFunctionSource('shouldRenderOptimisticQueuedMessage'),
    extractFunctionSource('clearQueuedPanelContent'),
    extractFunctionSource('cancelQueuedPanelExit'),
    extractFunctionSource('scheduleQueuedPanelExit'),
    extractFunctionSource('renderQueuedMessagePanel'),
    'globalThis.renderQueuedMessagePanel = renderQueuedMessagePanel;',
  ].join('\n\n'),
  context,
  { filename: 'static/chat/session-surface-ui.js' },
);

function appServerQueuedSession(extra = {}) {
  return {
    id: 'session-a',
    activity: {
      ...(extra.activity || {}),
      run: {
        ...(extra.activity?.run || {}),
        runtimeFamily: 'codex-app-server-json',
        providerCapabilities: {
          ...(extra.activity?.run?.providerCapabilities || {}),
          supportsSteer: true,
        },
      },
    },
    ...extra,
  };
}

context.renderQueuedMessagePanel(appServerQueuedSession({
  id: 'session-a',
  queuedMessages: [
    { requestId: 'queued-older', text: 'older steer' },
    { requestId: 'queued-latest', text: 'steer text', attachments: [{ filename: 'notes.txt', assetId: 'asset-1' }] },
  ],
}));

const stableSummary = queuedPanel.children[0];
const stableActiveRow = queuedPanel.children[1];
context.renderQueuedMessagePanel(appServerQueuedSession({
  activity: { run: { state: 'running' } },
  queuedMessages: [
    { requestId: 'queued-older', text: 'older steer' },
    { requestId: 'queued-latest', text: 'steer text', attachments: [{ filename: 'notes.txt', assetId: 'asset-1' }] },
  ],
}));
assert.equal(queuedPanel.children[0], stableSummary, 'queue refreshes should reuse the summary node');
assert.equal(queuedPanel.children[1], stableActiveRow, 'queue refreshes should reuse the keyed active row');
assert.equal(queuedPanel.children[1].classList.contains('is-entering'), false, 'reused rows should not replay their entrance class');

context.pendingSend = {
  sessionId: 'session-a',
  requestId: 'queued-pending',
  text: 'just sent while running',
  images: [],
  stage: 'sending',
  baselineActivity: { run: { state: 'running' } },
};
context.renderQueuedMessagePanel(appServerQueuedSession({
  activity: { run: { state: 'running' } },
  queuedMessages: [],
}));
assert.match(queuedPanel.children[0].className, /\bqueued-steer-row--optimistic\b/, 'a single optimistic queued message should not add a count summary');
const optimisticRow = queuedPanel.children[0];
assert.equal(optimisticRow.__queuedOptimistic, true, 'a busy-session send should appear optimistically in the queue');
assert.equal(optimisticRow.children[0].children[1].textContent, 'just sent while running', 'optimistic queue row should show the sent text');
assert.equal(optimisticRow.classList.contains('is-entering'), true, 'a genuinely new optimistic row should enter once');
context.renderQueuedMessagePanel(appServerQueuedSession({
  activity: { run: { state: 'running' } },
  queuedMessages: [{ requestId: 'queued-pending', text: 'just sent while running' }],
}));
assert.equal(queuedPanel.children[0], optimisticRow, 'server ACK should reconcile the optimistic row in place');
assert.equal(optimisticRow.__queuedOptimistic, false, 'server ACK should settle the optimistic queue row');
assert.equal(optimisticRow.classList.contains('is-entering'), false, 'server ACK should not replay the row entrance');
context.pendingSend = null;
context.renderQueuedMessagePanel(appServerQueuedSession({
  queuedMessages: [
    { requestId: 'queued-older', text: 'older steer' },
    { requestId: 'queued-latest', text: 'steer text', attachments: [{ filename: 'notes.txt', assetId: 'asset-1' }] },
  ],
}));

assert.equal(queuedPanel.classList.contains('visible'), true, 'queued panel should become visible for active queued messages');
assert.equal(queuedPanel.children[0].className, 'queued-summary', 'queued work should render a compact summary first');
assert.equal(queuedPanel.children[0].getAttribute('aria-expanded'), 'false', 'queue details should start collapsed');
assert.equal(queuedPanel.classList.contains('is-expanded'), false, 'queue details should not expand until requested');
assert.match(queuedPanel.children[1].className, /\bqueued-steer-row\b/, 'queued work should render an active steer strip after the summary');
assert.match(queuedPanel.children[1].className, /\bqueued-steer-row--active\b/, 'the first queued strip should be active');
assert.match(queuedPanel.children[2].className, /\bqueued-steer-row--waiting\b/, 'later queued strips should be waiting');
assert.equal(queuedPanel.children[1].children[0].className, 'queued-steer-content', 'steer strip should have a compact content area');
assert.equal(queuedPanel.children[1].children[0].children[1].textContent, 'older steer', 'steer strip should show the oldest queued text first');
assert.equal(queuedPanel.children[2].children[0].children[1].textContent, 'steer text', 'queued panel should stack later follow-ups underneath');
assert.equal(queuedPanel.children[2].children[0].children[1].dataset.attachments, 'Attachments: notes.txt', 'steer strip should retain attachment context');
assert.equal(queuedPanel.children[1].children[1].className, 'queued-steer-actions', 'steer strip should expose the action cluster');
assert.deepEqual(
  queuedPanel.children[1].children[1].children.map((child) => child.className),
  [
    'queued-steer-action queued-steer-action--steer',
    'queued-steer-action queued-steer-action--delete',
    'queued-steer-action queued-steer-action--more',
  ],
  'top queued steer strip should render steer, delete, and more affordances',
);
assert.deepEqual(
  queuedPanel.children[2].children[1].children.map((child) => child.className),
  [
    'queued-steer-action queued-steer-action--delete',
    'queued-steer-action queued-steer-action--more',
  ],
  'non-top queued strips should render only delete and more affordances',
);
assert.equal(queuedPanel.children.length, 3, 'queued panel should keep the summary plus every queued follow-up');

queuedPanel.children[0].click();
assert.equal(queuedPanel.classList.contains('is-expanded'), true, 'summary click should expand queued details');
assert.equal(queuedPanel.children[0].getAttribute('aria-expanded'), 'true', 'summary should expose its expanded state');
queuedPanel.children[0].click();
assert.equal(queuedPanel.classList.contains('is-expanded'), false, 'summary click should collapse queued details again');

const actions = queuedPanel.children[2].children[1].children;
actions[1].click();
const menu = context.document.querySelector('.queued-steer-menu');
assert.ok(menu, 'more action should open the queued steer menu');
assert.deepEqual(
  menu.children.map((child) => child.textContent),
  ['Edit message', 'Turn off queueing'],
  'queued steer menu should expose edit and turn-off queueing actions',
);
assert.equal(actions[1].attrs['aria-expanded'], 'true', 'more action should reflect expanded menu state');

menu.children[0].click();
assert.equal(msgInput.value, 'steer text', 'edit action should place queued text back into the composer');
assert.equal(msgInput.focused, true, 'edit action should focus the composer');
assert.deepEqual(draftWrites.at(-1), { sessionId: 'session-a', text: 'steer text' }, 'edit action should persist the restored draft');
assert.equal(replacedAttachments.at(-1)?.attachments[0]?.assetId, 'asset-1', 'edit action should restore queued attachments');
assert.equal(context.lastUpsertedSession.queuedMessages.length, 1, 'edit action should optimistically remove the edited queue entry');
assert.equal(context.lastUpsertedSession.queuedMessages[0].requestId, 'queued-older', 'edit action should preserve older queued entries');

context.renderQueuedMessagePanel(appServerQueuedSession({
  id: 'session-a',
  queuedMessages: [
    { requestId: 'queued-older', text: 'older steer' },
    { requestId: 'queued-latest', text: 'steer text', attachments: [{ filename: 'notes.txt', assetId: 'asset-1' }] },
  ],
}));
context.pendingSend = { sessionId: 'session-a', requestId: 'queued-latest', text: 'steer text', stage: 'processing' };
context.clearedPendingRequestIds = [];
context.syncComposerPendingUiCalls = 0;
queueServerCalls.length = 0;
const sendCountBeforeSteer = sendCalls.length;
msgInput.value = 'draft stays put';
queuedPanel.children[1].children[1].children[0].click();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(sendCalls.length, sendCountBeforeSteer, 'steer action should not route through ordinary composer send');
assert.equal(msgInput.value, 'draft stays put', 'steer action should not rewrite the composer while using backend steer');
assert.equal(queueServerCalls.at(-1)?.url, '/api/sessions/session-a/queue', 'steer action should use the queue endpoint');
assert.match(queueServerCalls.at(-1)?.options?.body || '', /"action":"steer"/, 'steer action should request backend steer');
assert.match(queueServerCalls.at(-1)?.options?.body || '', /"requestId":"queued-older"/, 'steer action should target the top queued request id');
assert.deepEqual(context.clearedPendingRequestIds, [], 'steer action should not clear unrelated pending turn feedback');
assert.equal(context.syncComposerPendingUiCalls, 0, 'steer action should leave unrelated pending turn feedback alone');
assert.equal(context.lastUpsertedSession.queuedMessages.length, 1, 'steer action should remove the steered queue entry from the returned session');
assert.equal(context.lastUpsertedSession.queuedMessages[0].requestId, 'queued-latest', 'steer action should promote the next queued entry');
assert.equal(queuedPanel.children.length, 1, 'a single remaining queued entry should not render a count summary');
assert.equal(queuedPanel.children[0].children[0].children[1].textContent, 'steer text', 'remaining queued entry should move to the top');
assert.deepEqual(
  queuedPanel.children[0].children[1].children.map((child) => child.className),
  [
    'queued-steer-action queued-steer-action--steer',
    'queued-steer-action queued-steer-action--delete',
    'queued-steer-action queued-steer-action--more',
  ],
  'promoted queued entry should gain the steer affordance',
);

context.renderQueuedMessagePanel(appServerQueuedSession({
  id: 'session-a',
  queuedMessages: [
    { requestId: 'queued-older', text: 'older steer' },
    { requestId: 'queued-latest', text: 'steer text' },
  ],
}));
context.pendingSend = { sessionId: 'session-a', requestId: 'queued-latest', text: 'steer text', stage: 'processing' };
context.clearedPendingRequestIds = [];
context.syncComposerPendingUiCalls = 0;
queuedPanel.children[2].children[1].children[0].click();
assert.equal(context.lastUpsertedSession.queuedMessages.length, 1, 'delete action should optimistically remove only the latest queue entry');
assert.equal(context.lastUpsertedSession.queuedMessages[0].requestId, 'queued-older', 'delete action should leave earlier queued entries intact');
assert.deepEqual(context.clearedPendingRequestIds, ['queued-latest'], 'delete action should clear matching pending turn feedback');
assert.equal(context.pendingSend, null, 'delete action should remove the matching composer pending send');
assert.equal(context.syncComposerPendingUiCalls, 1, 'delete action should resync pending turn feedback after clearing');

context.renderQueuedMessagePanel(appServerQueuedSession({
  id: 'session-a',
  queuedMessages: [
    { requestId: 'queued-older', text: 'older steer' },
    { requestId: 'queued-latest', text: 'steer text' },
  ],
}));
context.pendingSend = { sessionId: 'session-a', requestId: 'queued-older', text: 'older steer', stage: 'processing' };
context.clearedPendingRequestIds = [];
context.syncComposerPendingUiCalls = 0;
queuedPanel.children[2].children[1].children[1].click();
context.document.querySelector('.queued-steer-menu').children[1].click();
assert.equal(context.lastUpsertedSession.queuedMessages, undefined, 'turn off queueing should clear all queued entries optimistically');
assert.equal(queuedPanel.classList.contains('visible'), false, 'turn off queueing should hide the queued panel after clearing');
assert.deepEqual(context.clearedPendingRequestIds, ['queued-older'], 'turn off queueing should clear any matching queued pending turn feedback');
assert.equal(context.syncComposerPendingUiCalls, 1, 'turn off queueing should resync pending turn feedback after clearing');

context.renderQueuedMessagePanel({
  id: 'session-a',
  activity: {
    run: {
      runtimeFamily: 'codex-json',
      providerCapabilities: { supportsSteer: false },
    },
  },
  queuedMessages: [
    { requestId: 'queued-codex-cli', text: 'codex cli queued steer' },
  ],
});
assert.equal(queuedPanel.classList.contains('visible'), true, 'codex CLI queue should still show the queued text strip');
assert.equal(queuedPanel.children[0].querySelector('.queued-steer-actions'), null, 'codex CLI queue should hide native steer actions');

context.renderQueuedMessagePanel({
  id: 'session-a',
  tool: 'claude',
  queuedMessages: [
    { requestId: 'queued-claude', text: 'claude queued steer' },
  ],
});
assert.equal(queuedPanel.classList.contains('visible'), true, 'claude queue should still show the queued text strip');
assert.equal(queuedPanel.children[0].querySelector('.queued-steer-actions'), null, 'claude queue should hide unsupported steer actions');

context.renderQueuedMessagePanel({
  id: 'session-a',
  tool: 'agy',
  activity: {
    run: {
      runtimeFamily: 'agy-stream-json',
      providerCapabilities: {
        supportsSteer: false,
        supportsQueuedMessageMutations: true,
      },
    },
  },
  queuedMessages: [
    { requestId: 'queued-agy', text: 'edit this AgY follow-up' },
  ],
});
assert.equal(queuedPanel.children[0].querySelector('.queued-steer-action--steer'), null, 'AgY queue should hide steer');
assert.ok(queuedPanel.children[0].querySelector('.queued-steer-action--delete'), 'AgY queue should allow delete');
assert.ok(queuedPanel.children[0].querySelector('.queued-steer-action--more'), 'AgY queue should allow edit/clear menu');

context.selectedTool = 'claude';
context.renderQueuedMessagePanel({
  id: 'session-a',
  queuedMessages: [
    { requestId: 'queued-selected-claude', text: 'selected claude queued steer' },
  ],
});
assert.equal(queuedPanel.children[0].querySelector('.queued-steer-actions'), null, 'active claude runtime should hide steer actions even when session tool is missing');
context.selectedTool = 'codex';

context.renderQueuedMessagePanel({
  id: 'session-b',
  queuedMessages: [{ text: 'other session' }],
});

assert.equal(queuedPanel.classList.contains('visible'), false, 'queued panel should hide for non-active sessions');
assert.equal(queuedPanel.children.length, 0, 'queued panel should clear stale steer content when hidden');

console.log('test-chat-queued-steer-panel: ok');
