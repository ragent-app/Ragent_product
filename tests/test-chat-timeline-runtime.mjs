#!/usr/bin/env node

import assert from 'assert/strict';
import { chromium } from '@playwright/test';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

try {
  await page.setContent('<!doctype html><div id="messagesInner"></div>');
  await page.evaluate(() => {
    window.currentSessionId = 'timeline-runtime';
    window.messagesInner = document.getElementById('messagesInner');
    window.emptyState = document.createElement('div');
    window.renderedEventState = {
      sessionId: 'timeline-runtime', latestSeq: 0, earliestSeq: 0,
      nextBeforeSeq: null, hasMoreBefore: false, loadingOlder: false,
      runState: 'idle', timelineItemCount: 0,
      operationNodesById: new Map(), operationSnapshotsById: new Map(), expandedOperationIds: new Set(),
    };
    window.normalizeRenderedRunState = (state) => state;
    window.syncLiveMessageMetadataForRunState = () => {};
    window.syncEditableMessageActions = () => {};
    window.reconcileComposerPendingSendWithEvent = () => {};
    window.decisionCalls = [];
    window.decisionResetCalls = 0;
    window.RagentDecisions = {
      noteRequest: (event) => window.decisionCalls.push(['approval', event.approvalId || '']),
      notePrivilegedBatch: (event) => window.decisionCalls.push(['batch', event.batchId]),
      noteApprovedActionState: (event) => window.decisionCalls.push(['action', event.actionId]),
      noteResponse: (event) => window.decisionCalls.push(['response', event.approvalId]),
      reset: () => { window.decisionResetCalls += 1; },
    };
    window.unknownRenderCalls = 0;
    window.renderUnknownEventInto = () => {
      window.unknownRenderCalls += 1;
      const node = document.createElement('pre');
      node.textContent = 'must not render';
      return node;
    };
    window.usageUpdates = [];
    window.renderUsageInto = (_container, event, options) => {
      window.usageUpdates.push({ event, options });
      return null;
    };
    window.renderMessageInto = (container, event) => {
      const node = document.createElement('article');
      node.className = event.role === 'user' ? 'user-message' : 'assistant-message';
      node.dataset.runId = event.runId || '';
      node.textContent = event.content || event.text || '';
      container.appendChild(node);
      return node;
    };
    window.renderOperationNodeContent = (node, event) => {
      node.className = 'operation';
      node.dataset.operationId = event.operationId || '';
      node.dataset.operationState = event.state || '';
      node.textContent = event.detail || '';
    };
  });
  await page.addScriptTag({ content: readFileSync(join(repoRoot, 'static/chat/core/timeline-projector.js'), 'utf8') });
  await page.addScriptTag({ content: readFileSync(join(repoRoot, 'static/chat/timeline-runtime.js'), 'utf8') });

  const result = await page.evaluate(() => {
    const runtime = window.RagentTimelineRuntime;
    runtime.renderBatch([
      { id: 'u1', seq: 1, type: 'message', role: 'user', timelineEntityId: 'message:user:req', content: 'Inspect' },
      { id: 'a1', seq: 2, type: 'message', role: 'assistant', runId: 'run-1', timelineEntityId: 'message:assistant:before', content: 'Checking.' },
      { id: 'o1', seq: 3, type: 'operation', operationId: 'op-1', timelineEntityId: 'operation:op-1', state: 'running', detail: 'Read file' },
      { id: 'usage-1', seq: 4, type: 'usage', contextTokens: 128 },
      { id: 'batch-1', seq: 5, type: 'privileged_batch_request', batchId: 'batch-1', other: ['restart'] },
      { id: 'action-1', seq: 6, type: 'approved_action_state', batchId: 'batch-1', actionId: 'action-1', state: 'waiting_user' },
      { id: 'unknown-1', seq: 7, type: 'provider_runtime_capabilities_v2', permissionModes: ['danger-full-access'] },
    ], { sessionId: 'timeline-runtime', runState: 'running', pagination: { latestSeq: 3, hasMoreBefore: true, nextBeforeSeq: 1 } });

    runtime.renderIncremental([{ id: 'delta-1', type: 'text_delta', role: 'assistant', runId: 'run-1', text: 'Found ' }], {
      sessionId: 'timeline-runtime', runState: 'running', source: 'ws',
    });
    runtime.renderIncremental([{ id: 'delta-2', type: 'text_delta', role: 'assistant', runId: 'run-1', text: 'it.' }], {
      sessionId: 'timeline-runtime', runState: 'running', source: 'ws',
    });
    const live = [...messagesInner.children].at(-1);

    runtime.renderBatch([{ id: 'a2', seq: 4, type: 'message', role: 'assistant', runId: 'run-1', content: 'Found it.' }], {
      sessionId: 'timeline-runtime', runState: 'idle', pagination: { latestSeq: 4, hasMoreBefore: true, nextBeforeSeq: 1 },
    });
    const completed = [...messagesInner.children].at(-1);

    runtime.renderBatch([{ id: 'older', seq: 0, startSeq: 0, type: 'message', role: 'user', timelineEntityId: 'ignored', content: 'ignored' }, {
      id: 'older-real', seq: 1, type: 'message', role: 'user', timelineEntityId: 'message:user:older', content: 'Earlier',
    }], { sessionId: 'timeline-runtime', historyPrepend: true, paginationMode: 'before', pagination: { hasMoreBefore: false } });

    // A full-sync page with no live approval may contain historical control
    // records. They must remain cursor input without re-opening the sheet.
    runtime.renderBatch([
      { id: 'stale-batch', seq: 8, type: 'privileged_batch_request', batchId: 'stale-batch', other: ['restart'] },
      { id: 'stale-action', seq: 9, type: 'approved_action_state', batchId: 'stale-batch', actionId: 'stale-action', state: 'completed' },
    ], {
      sessionId: 'timeline-runtime',
      runState: 'idle',
      renderOptions: { approvalRequestLiveId: '' },
    });

    // A provider approval is often followed by the privileged batch
    // projection for the same run. The generic request must not render a
    // second sheet before the batch arrives.
    runtime.renderBatch([
      { id: 'old-error', seq: 10, type: 'status', runId: 'old-run', content: 'error: old run' },
      { id: 'paired-approval', seq: 11, type: 'approval_request', approvalId: 'provider-approval', runId: 'live-run', status: 'pending' },
      { id: 'paired-batch', seq: 12, type: 'privileged_batch_request', batchId: 'live-batch', runId: 'live-run', other: [{ approvalId: 'provider-approval', opId: 'op-1', command: 'echo protected' }] },
    ], { sessionId: 'timeline-runtime', runState: 'waiting_user', latestSeq: 12 });
    const liveResetCalls = window.decisionResetCalls;
    runtime.renderBatch([
      { id: 'new-error', seq: 13, type: 'status', runId: 'old-run', content: 'error: old run again' },
    ], { sessionId: 'timeline-runtime', runState: 'idle', latestSeq: 13 });

    return {
      ids: [...messagesInner.children].map((node) => node.dataset.timelineId),
      texts: [...messagesInner.children].map((node) => node.textContent),
      liveSame: live === completed,
      liveCount: [...messagesInner.children].filter((node) => node.dataset.timelineId === 'message:assistant:live:run-1:segment:0').length,
      usageUpdates: window.usageUpdates.length,
      decisionCalls: window.decisionCalls,
      decisionResetCalls: window.decisionResetCalls,
      liveResetCalls,
      unknownRenderCalls: window.unknownRenderCalls,
      snapshot: runtime.getSnapshot(),
    };
  });

  // Regression: an HTTP refresh can report idle before its event projection
  // catches up. A terminal status from an older run must not clear the live
  // approval that is already in the decision store, or the sheet flashes when
  // the approval event is applied again.
  await page.evaluate(() => {
    const before = window.decisionResetCalls;
    window.RagentDecisions.getPending = () => ({ approvalId: 'race-approval', runId: 'live-run' });
    window.RagentDecisions.getPendingBatch = () => null;
    window.RagentDecisions.getPendingAction = () => null;
    window.RagentTimelineRuntime.renderBatch([
      { id: 'race-approval', seq: 14, type: 'approval_request', approvalId: 'race-approval', runId: 'live-run', status: 'pending' },
      { id: 'race-old-status', seq: 15, type: 'status', runId: 'old-run', content: 'error: stale run' },
    ], { sessionId: 'timeline-runtime', runState: 'idle', latestSeq: 15 });
    window.__raceResetDelta = window.decisionResetCalls - before;
  });
  assert.equal(await page.evaluate(() => window.__raceResetDelta), 0, 'stale terminal status must not reset a live approval during an idle refresh');

  assert.deepEqual(result.ids, [
    'message:user:older', 'message:user:req', 'message:assistant:before', 'message:assistant:live:run-1:segment:0',
  ]);
  assert.deepEqual(result.texts, ['Earlier', 'Inspect', 'Checking.', 'Found it.']);
  assert.equal(result.liveSame, true, 'durable completion must update the streaming root instead of mounting a duplicate');
  assert.equal(result.liveCount, 1);
  assert.equal(result.usageUpdates, 1, 'usage updates context metadata without becoming a transcript row');
  assert.deepEqual(result.decisionCalls, [
    ['batch', 'batch-1'],
    ['action', 'action-1'],
    ['batch', 'live-batch'],
  ]);
  assert.equal(result.liveResetCalls, 0, 'historical terminal status must not clear a live approval sheet');
  assert.equal(result.decisionResetCalls, 1, 'terminal status still clears approvals once the run is idle');
  assert.equal(result.unknownRenderCalls, 0, 'unknown event payloads must never enter transcript rendering');
  assert.equal(result.snapshot.items.length, 7);

  // End-to-end bubble chronology: a long summary streams over WS while page
  // refreshes deliver durable tool activity and a mid-run user message. The
  // settled DOM must read in server sequence order with the streamed answer
  // below its own run activity and no duplicated stream fragment left over.
  const streamOrder = await page.evaluate(() => {
    const runtime = window.RagentTimelineRuntime;
    const sessionId = 'timeline-stream-order';
    runtime.reset(sessionId);
    const render = (events, options = {}) => runtime.renderBatch(events, { sessionId, ...options });
    render([
      { seq: 100, type: 'message', role: 'user', content: '帮我修一下这个 bug' },
      { seq: 101, type: 'message', role: 'assistant', runId: 'run-a', content: '修好了。' },
    ], { runState: 'idle', latestSeq: 101 });
    runtime.renderIncremental([{ type: 'text_delta', role: 'assistant', runId: 'run-b', text: '这是一条很长的收' }], {
      sessionId, runState: 'running', source: 'ws',
    });
    render([
      { seq: 103, type: 'operation', operationId: 'op-1', runId: 'run-b', state: 'completed', title: 'Bash', detail: 'npm test' },
      { seq: 105, type: 'operation', operationId: 'op-2', runId: 'run-b', state: 'completed', title: 'Read', detail: 'src/a.js' },
      { seq: 107, type: 'message', role: 'user', content: 'run 中间插入的新问题' },
      { seq: 109, type: 'operation', operationId: 'op-3', runId: 'run-b', state: 'completed', title: 'Bash', detail: 'git commit' },
    ], { runState: 'running', latestSeq: 109 });
    runtime.renderIncremental([{ type: 'text_delta', role: 'assistant', runId: 'run-b', text: '结：全部完成。' }], {
      sessionId, runState: 'running', source: 'ws',
    });
    render([
      { seq: 120, type: 'message', role: 'assistant', runId: 'run-b', content: '这是一条很长的收结：全部完成。' },
    ], { runState: 'idle', latestSeq: 120 });
    return [...messagesInner.children].map((node) => node.textContent);
  });
  assert.deepEqual(streamOrder, [
    '帮我修一下这个 bug',
    '修好了。',
    'run 中间插入的新问题',
    '这是一条很长的收结：全部完成。',
  ], 'streamed output must settle into server chronology with no duplicate fragments');

  const cachedSwitch = await page.evaluate(() => {
    const runtime = window.RagentTimelineRuntime;
    runtime.reset('cache-a');
    runtime.renderBatch([
      { seq: 1, type: 'message', role: 'user', content: 'cached A' },
    ], { sessionId: 'cache-a', latestSeq: 1 });
    runtime.renderBatch([
      { seq: 1, type: 'message', role: 'user', content: 'cached B' },
    ], { sessionId: 'cache-b', latestSeq: 1 });
    const restored = runtime.restoreCachedSession('cache-a');
    return {
      sessionId: restored?.sessionId || null,
      text: [...messagesInner.children].map((node) => node.textContent),
      initialized: runtime.getSnapshot()?.initialized === true,
    };
  });
  assert.deepEqual(cachedSwitch, {
    sessionId: 'cache-a',
    text: ['cached A'],
    initialized: true,
  }, 're-entering a cached session should repaint without waiting for network data');

  const durableWsDelta = await page.evaluate(() => {
    window.currentSessionId = 'timeline-durable-ws';
    const runtime = window.RagentTimelineRuntime;
    runtime.reset('timeline-durable-ws');
    runtime.renderDurableDelta([
      { id: 'ws-durable-user', seq: 21, type: 'message', role: 'user', content: 'WS durable user message' },
      { id: 'ws-durable-answer', seq: 22, type: 'message', role: 'assistant', content: 'WS durable answer' },
    ], { sessionId: 'timeline-durable-ws', latestSeq: 22, runState: 'idle' });
    return {
      text: [...messagesInner.children].map((node) => node.textContent),
      latestSeq: runtime.getSnapshot()?.latestSeq,
    };
  });
  assert.deepEqual(durableWsDelta, {
    text: ['WS durable user message', 'WS durable answer'],
    latestSeq: 22,
  }, 'a persisted WS delta should be visible before the delayed HTTP reconciliation');

  const coalescedStream = await page.evaluate(async () => {
    window.currentSessionId = 'timeline-coalesced-ws';
    const runtime = window.RagentTimelineRuntime;
    runtime.reset('timeline-coalesced-ws');
    const before = window.ragentGetTimelineRuntimeMetrics().commits;
    for (const text of ['one ', 'two ', 'three']) {
      runtime.renderIncremental([{ type: 'text_delta', role: 'assistant', runId: 'coalesced-run', text }], {
        sessionId: 'timeline-coalesced-ws', runState: 'running', source: 'ws',
      });
    }
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return {
      commits: window.ragentGetTimelineRuntimeMetrics().commits - before,
      text: [...messagesInner.children].map((node) => node.textContent),
    };
  });
  assert.ok(coalescedStream.commits <= 2, 'several WS frames in one browser frame should coalesce into one follow-up DOM commit');
  assert.deepEqual(coalescedStream.text, ['one two three']);
} finally {
  await browser.close();
}

await (async () => {
  const { default: assertMod } = await import('node:assert/strict');
  const fsMod = await import('node:fs');
  const vmMod = await import('node:vm');

  function makeRtEl(tag, id = '') {
    const node = {
      tagName: String(tag || 'DIV').toUpperCase(),
      id,
      className: '',
      children: [],
      dataset: {},
      attrs: {},
      style: { setProperty() {}, removeProperty() {} },
      listeners: {},
      hidden: false,
      disabled: false,
      type: '',
      value: '',
      placeholder: '',
      _text: '',
      setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'hidden') this.hidden = true; },
      removeAttribute(k) { delete this.attrs[k]; if (k === 'hidden') this.hidden = false; },
      getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
      hasAttribute(k) { return k in this.attrs; },
      classList: {
        add(...cs) { node.className = [...new Set([...node.className.split(/\s+/).filter(Boolean), ...cs])].join(' '); },
        remove(...cs) { node.className = node.className.split(/\s+/).filter(Boolean).filter((c) => !cs.includes(c)).join(' '); },
        toggle(c, f) { const has = this.contains(c); const next = f === undefined ? !has : Boolean(f); if (next) this.add(c); else this.remove(c); return next; },
        contains(c) { return node.className.split(/\s+/).filter(Boolean).includes(c); },
      },
      appendChild(c) {
        if (!c) return c;
        if (c.tagName === 'FRAGMENT') {
          for (const k of [...c.children]) this.appendChild(k);
          c.children = [];
          return c;
        }
        if (c.parentNode && Array.isArray(c.parentNode.children)) {
          const oldIdx = c.parentNode.children.indexOf(c);
          if (oldIdx >= 0) c.parentNode.children.splice(oldIdx, 1);
        }
        c.parentNode = this;
        this.children.push(c);
        return c;
      },
      replaceChildren(...cs) { this.children = []; for (const c of cs) this.appendChild(c); },
      get childNodes() { return this.children; },
      get firstElementChild() { return this.children[0] || null; },
      insertBefore(c, ref) {
        if (!c) return c;
        if (c.parentNode && Array.isArray(c.parentNode.children)) {
          const oldIdx = c.parentNode.children.indexOf(c);
          if (oldIdx >= 0) c.parentNode.children.splice(oldIdx, 1);
        }
        c.parentNode = this;
        const i = ref ? this.children.indexOf(ref) : -1;
        if (i >= 0) this.children.splice(i, 0, c);
        else this.children.push(c);
        return c;
      },
      replaceChild(n, o) { const i = this.children.indexOf(o); if (i >= 0) { n.parentNode = this; this.children[i] = n; } return o; },
      remove() { if (this.parentNode) { const i = this.parentNode.children.indexOf(this); if (i >= 0) this.parentNode.children.splice(i, 1); } },
      addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); },
      querySelectorAll(sel) {
        const out = [];
        const parts = String(sel).split(',').map((s) => s.trim()).filter(Boolean);
        const match = (n) => parts.some((p) => {
          const base = p.split('[')[0];
          const clsMatch = base.startsWith('.') ? n.classList?.contains(base.slice(1)) : (!base || n.tagName === base.toUpperCase());
          return clsMatch;
        });
        const walk = (n) => { for (const c of n.children || []) { if (match(c)) out.push(c); walk(c); } };
        walk(this);
        return out;
      },
      querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
      get textContent() { return this._text || this.children.map((c) => c.textContent || '').join(''); },
      set textContent(v) { this._text = String(v ?? ''); },
      set innerHTML(v) { this.children = []; this._text = String(v ?? ''); },
      contains(target) {
        let cur = target;
        while (cur) {
          if (cur === this) return true;
          cur = cur.parentNode;
        }
        return false;
      },
    };
    return node;
  }

  const messagesInner = makeRtEl('div', 'messagesInner');
  const asyncPanel = makeRtEl('div', 'asyncQuestionsPanel');
  const emptyState = makeRtEl('div', 'emptyState');
  const doc = {
    createElement: (tag) => makeRtEl(tag),
    createDocumentFragment: () => makeRtEl('fragment'),
    createTextNode: (t) => ({ textContent: String(t), children: [] }),
    getElementById: (id) => (id === 'messagesInner' ? messagesInner : (id === 'asyncQuestionsPanel' ? asyncPanel : (id === 'emptyState' ? emptyState : null))),
  };
  const ctx = {
    window: null,
    document: doc,
    globalThis: null,
    console,
    URL,
    TextEncoder,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (fn) => { fn(); return 1; },
    cancelAnimationFrame: () => {},
    currentSessionId: 'rt-async-sess',
    messagesInner,
    emptyState,
    renderedEventState: { sessionId: 'rt-async-sess', latestSeq: 0 },
    resetRenderedEventState: () => {},
    marked: { parse: (v) => `<p>${String(v ?? '')}</p>` },
    enhanceCodeBlocks: () => {},
    enhanceTables: () => {},
    enhanceRenderedContentLinks: () => {},
    renderMarkdownIntoNode: () => false,
    formatDecodedDisplayText: (v) => String(v ?? ''),
    appendUserMessageDisclosure: () => {},
    markLazyEventBodyNode: () => false,
    appendMessageMeta: () => {},
    t: (k) => k,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;

  vmMod.runInNewContext(fsMod.readFileSync('static/chat/async-questions-ui.js', 'utf8'), ctx);
  vmMod.runInNewContext(fsMod.readFileSync('static/chat/ui.js', 'utf8'), ctx);
  vmMod.runInNewContext(fsMod.readFileSync('static/chat/core/timeline-projector.js', 'utf8'), ctx);
  vmMod.runInNewContext(fsMod.readFileSync('static/chat/timeline-runtime.js', 'utf8'), ctx);

  ctx.RagentTimelineRuntime.renderBatch([
    {
      seq: 1,
      type: 'message',
      role: 'assistant',
      itemId: 'item-rt-1',
      content: 'Pick environment',
      messageDelivery: 'async',
      asyncQuestions: [{ id: 'rt-q1', index: 0, question: 'Environment?', options: ['Dev', 'Prod'], status: 'pending' }],
    },
    {
      seq: 2,
      type: 'message',
      role: 'assistant',
      itemId: 'item-rt-2',
      content: 'Also checking logs...',
      messageDelivery: 'async',
    },
  ], { sessionId: 'rt-async-sess', runState: 'running', reset: true });

  assertMod.equal(ctx.RagentAsyncQuestions.getPendingQuestions('rt-async-sess').length, 1);
  assertMod.equal(asyncPanel.hidden, false);
  assertMod.equal(messagesInner.querySelectorAll('.async-question-card').length, 1);
  assertMod.equal(messagesInner.querySelector('.async-question-card').dataset.asyncQuestionState, 'pending');
  assertMod.equal(messagesInner.querySelectorAll('.async-followup-card').length, 1);

  // Delta user message reply settles both the floating panel and in-stream card cleanly
  ctx.RagentTimelineRuntime.renderDurableDelta([
    {
      seq: 3,
      type: 'message',
      role: 'user',
      content: '<send_user_message_question_reply>[{"questionItemId":"rt-q1","question":"Environment?","answer":"Prod"}]</send_user_message_question_reply>',
      answeredQuestionItemIds: ['rt-q1'],
    },
  ], { sessionId: 'rt-async-sess', runState: 'running' });

  assertMod.equal(ctx.RagentAsyncQuestions.getPendingQuestions('rt-async-sess').length, 0);
  assertMod.equal(asyncPanel.hidden, true);
  assertMod.equal(messagesInner.querySelector('.async-question-card').dataset.asyncQuestionState, 'answered');
  assertMod.equal(messagesInner.querySelectorAll('.user-question-reply-chip').length, 1);
})();

console.log('test-chat-timeline-runtime: ok');
