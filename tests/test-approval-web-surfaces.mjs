import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
const read = async name => readFile(new URL(`../${name}`, import.meta.url), 'utf8');
const scripts = await Promise.all(['static/chat/approval-explanation.js', 'static/chat/attention-popup.js', 'static/chat/decisions-store.js', 'static/chat/decision-sheet.js'].map(read));
const html = await read('templates/chat.html');
assert.ok(html.indexOf('chat/approval-explanation.js') > 0);
assert.ok(html.indexOf('chat/approval-explanation.js') < html.indexOf('chat/attention-popup.js'));
assert.ok(html.indexOf('chat/approval-explanation.js') < html.indexOf('chat/decision-sheet.js'));
let browser;
try { browser = await chromium.launch({headless:true}); } catch { browser = await chromium.launch({headless:true,channel:'chrome'}); }
try {
  const page = await browser.newPage();
  await page.setContent('<!doctype html><div id="inputArea"><div id="liveBar"></div></div>');
  await page.evaluate(() => {
    window.getChatStoreStateSnapshot = () => ({currentSessionId:'foreground'});
    window.getChatStoreSession = id => ({id, name:'QA'});
    window.getApprovalTitle = () => 'Bash';
    window.ragentT = (key, vars = {}) => ({
      'decisionSheet.operation.delete':'delete', 'decisionSheet.operation.may':'May {action}',
      'decisionSheet.operationRisk.partial':'Review conditional command',
      'decisionSheet.operationRisk.delete':'Deletion may be irreversible',
      'decisionSheet.operationRisk.provider_conflict':'The provider description may conflict',
      'decisionSheet.providerDescription':'Provider description',
      'decisionSheet.explanation.reason':'Why attention',
      'decisionSheet.explanation.summary':'Summary',
      'decisionSheet.explanation.title':'Explanation',
    }[key] || key).replace(/\{(\w+)\}/g, (_, k) => vars[k] || '');
  });
  for (const content of scripts) await page.addScriptTag({content});
  const event = {type:'approval_request',approvalId:'qa',kind:'command',status:'pending',reason:'Read target',
    command:'if true; then rm -f /tmp/example_file.txt; fi',explanation:{operation:'delete', targets:['/tmp/example_file.txt'],conditional:true,partial:true,riskCode:'composite_unanalyzed',summary:'old',reason:'old',providerConflict:true}};
  await page.evaluate(event => window.RagentAttentionPopup.onRealtimeEvents('background',[event]), event);
  assert.equal(await page.locator('#attentionPopupTitle').textContent(), 'May delete: /tmp/example_file.txt');
  await page.locator('#attentionPopupTitle').click();
  const popup = page.locator('#attentionPopupHost');
  assert.match(await popup.innerText(), /Deletion may be irreversible/);
  assert.match(await popup.innerText(), /Read target/);
  assert.match(await popup.innerText(), /provider description may conflict/);
  assert.match(await popup.innerText(), /rm -f/);
  await page.evaluate(() => window.RagentAttentionPopup._reset());
  await page.evaluate(explanation => window.RagentAttentionPopup.onRealtimeEvents('background', [{
    type:'privileged_batch_request',batchId:'batch',runId:'r',other:[
      {opId:'one',description:'First',command:'rm /tmp/example_file.txt',explanation},
      {opId:'two',description:'Second',command:'rm /tmp/other.txt',explanation:{...explanation,targets:['/tmp/other.txt']}}
    ],delete:[]
  }]), event.explanation);
  assert.equal(await page.locator('#attentionPopupTitle').textContent(), 'attention.danger.title');
  await page.locator('#attentionPopupTitle').click();
  const batchText = await page.locator('#attentionPopupHost').innerText();
  assert.match(batchText, /example_file\.txt/);
  assert.match(batchText, /other\.txt/);
  assert.match(batchText, /First/);
  assert.match(batchText, /Second/);
  await page.evaluate(() => window.RagentAttentionPopup._reset());
  await page.evaluate(event => window.RagentDecisions.noteRequest(event), event);
  assert.equal(await page.locator('#decisionSheet .oneui-notification__title').textContent(), 'May delete: /tmp/example_file.txt');
  await page.locator('#decisionSheet .oneui-notification__summary').click();
  const sheetText = await page.locator('#decisionSheet').innerText();
  assert.match(sheetText, /Read target/);
  assert.match(sheetText, /provider description may conflict/);
  assert.match(sheetText, /Deletion may be irreversible/);
  assert.match(sheetText, /rm -f/);
  assert.equal((sheetText.match(/May delete: \/tmp\/example_file\.txt/g) || []).length, 1);
  await page.evaluate(() => { window.RagentDecisions.noteResponse({approvalId:'qa'}); window.getApprovalTitle = e => e.reason; });
  await page.waitForTimeout(250);
  await page.evaluate(() => window.RagentDecisions.noteRequest({type:'approval_request',approvalId:'legacy',kind:'command',
    reason:'Remove example',command:'if true; then rm example; fi',explanation:{summary:'包含 3 步操作',
      reason:'命令串联了多个步骤，部分行为无法静态确认',saferAlternative:'拆成单条命令逐步确认后再执行'}}));
  await page.locator('#decisionSheet .oneui-notification__summary').click();
  const legacyText = await page.locator('#decisionSheet').innerText();
  assert.equal((legacyText.match(/Remove example/g) || []).length, 1);
  assert.doesNotMatch(legacyText, /包含 3 步操作|Run command/);
  assert.match(legacyText, /Review conditional command/);
  const localePage = await browser.newPage();
  await localePage.setContent('<!doctype html><html><head></head><body></body></html>');
  await localePage.addScriptTag({content: await read('static/chat/i18n.js')});
  await localePage.addScriptTag({content: scripts[0]});
  const localized = await localePage.evaluate(explanation => {
    window.ragentSetUiLanguagePreference('zh-CN');
    const zh = window.ragentApprovalExplanation(explanation, window.ragentT);
    window.ragentSetUiLanguagePreference('en');
    const en = window.ragentApprovalExplanation(explanation, window.ragentT);
    return {zh, en};
  }, event.explanation);
  assert.equal(localized.zh.summary, '可能删除: /tmp/example_file.txt');
  assert.equal(localized.en.summary, 'May delete: /tmp/example_file.txt');
  assert.doesNotMatch(localized.en.reason, /[\u4e00-\u9fff]/);
  await localePage.close();
  if (process.env.RAGENT_APPROVAL_REPLAY_FILE) {
    const encoded = await readFile(process.env.RAGENT_APPROVAL_REPLAY_FILE, 'utf8');
    const captured = JSON.parse(Buffer.from(encoded.trim(), 'base64').toString('utf8')).events[0];
    const replay = await browser.newPage();
    await replay.setContent('<!doctype html><div id="inputArea"><div id="liveBar"></div></div>');
    await replay.addScriptTag({content: await read('static/chat/i18n.js')});
    await replay.evaluate(() => window.ragentSetUiLanguagePreference('en'));
    await replay.addScriptTag({content: scripts[0]});
    await replay.addScriptTag({content: scripts[2]});
    await replay.addScriptTag({content: scripts[3]});
    await replay.evaluate(e => window.RagentDecisions.noteRequest(e), captured);
    const title = await replay.locator('#decisionSheet .oneui-notification__title').textContent();
    assert.ok(title.startsWith('May delete: '));
    assert.ok(title.includes(captured.explanation.targets[0]));
    await replay.locator('#decisionSheet .oneui-notification__summary').click();
    const replayText = await replay.locator('#decisionSheet').innerText();
    assert.match(replayText, /rm -f/);
    assert.match(replayText, /conditional or compound shell syntax/);
    assert.doesNotMatch(replayText, /包含 3 步操作/);
    await replay.close();
  }
  await page.close();
} finally { await browser.close(); }
await (async () => {
  const { default: assertMod } = await import('node:assert/strict');
  const fsMod = await import('node:fs');
  const vmMod = await import('node:vm');

  function mkNode(tag, id = '') {
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
        if (c.parentNode && Array.isArray(c.parentNode.children)) {
          const oldIdx = c.parentNode.children.indexOf(c);
          if (oldIdx >= 0) c.parentNode.children.splice(oldIdx, 1);
        }
        c.parentNode = this;
        this.children.push(c);
        return c;
      },
      replaceChildren(...cs) { this.children = []; for (const c of cs) if (c) this.appendChild(c); },
      append(...cs) { for (const c of cs) if (c) this.appendChild(typeof c === 'string' ? { textContent: c, children: [] } : c); },
      get firstChild() { return this.children[0] || null; },
      focus() {},
      contains(target) { let cur = target; while (cur) { if (cur === this) return true; cur = cur.parentNode; } return false; },
      closest(sel) {
        const cls = sel.startsWith('.') ? sel.slice(1).split(/[\[:]/)[0] : null;
        let cur = this;
        while (cur) {
          if (cls ? cur.classList?.contains(cls) : cur.tagName === sel.toUpperCase()) return cur;
          cur = cur.parentNode;
        }
        return null;
      },
      insertBefore(c, ref) { c.parentNode = this; const i = ref ? this.children.indexOf(ref) : -1; if (i >= 0) this.children.splice(i, 0, c); else this.children.push(c); return c; },
      replaceChild(n, o) { const i = this.children.indexOf(o); if (i >= 0) { n.parentNode = this; this.children[i] = n; } return o; },
      remove() { if (this.parentNode) { const i = this.parentNode.children.indexOf(this); if (i >= 0) this.parentNode.children.splice(i, 1); } },
      addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); },
      querySelectorAll(sel) {
        const out = [];
        const parts = String(sel).split(',').map((s) => s.trim()).filter(Boolean);
        const match = (n) => parts.some((p) => {
          const base = p.split('[')[0];
          const m = p.match(/\[([^\]=]+)="([^"]+)"\]/);
          const clsMatch = base.startsWith('.') ? n.classList?.contains(base.slice(1)) : (!base || n.tagName === base.toUpperCase());
          if (!clsMatch) return false;
          if (m) {
            const attrName = m[1];
            const val = m[2];
            if (attrName.startsWith('data-')) {
              const camel = attrName.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
              return n.dataset?.[camel] === val || n.attrs?.[attrName] === val;
            }
            return n.attrs?.[attrName] === val;
          }
          return true;
        });
        const walk = (n) => { for (const c of n.children || []) { if (match(c)) out.push(c); walk(c); } };
        walk(this);
        return out;
      },
      querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
      get textContent() { return this._text || this.children.map((c) => c.textContent || '').join(''); },
      set textContent(v) { this._text = String(v ?? ''); },
      set innerHTML(v) { if (v === '') { this.children = []; this._text = ''; } },
    };
    return node;
  }

  const asyncPanel = mkNode('div', 'asyncQuestionsPanel');
  const messagesInner = mkNode('div', 'messagesInner');
  const postCalls = [];
  const doc = {
    createElement: (tag) => mkNode(tag),
    createTextNode: (t) => ({ textContent: String(t), children: [] }),
    getElementById: (id) => (id === 'asyncQuestionsPanel' ? asyncPanel : (id === 'messagesInner' ? messagesInner : null)),
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
    currentSessionId: 'sess-async',
    dispatchAction: async (payload) => {
      postCalls.push(payload);
      return { ok: true };
    },
    t: (k) => k,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;

  vmMod.runInNewContext(fsMod.readFileSync('static/chat/core/session-status.js', 'utf8'), ctx);
  vmMod.runInNewContext(fsMod.readFileSync('static/chat/core/decisions-store.js', 'utf8'), ctx);
  vmMod.runInNewContext(fsMod.readFileSync('static/chat/decisions-store.js', 'utf8'), ctx);
  vmMod.runInNewContext(fsMod.readFileSync('static/chat/async-questions-ui.js', 'utf8'), ctx);
  const rtCtx = { ...ctx, window: null, globalThis: null, stripHiddenDisplayBlocks: undefined };
  rtCtx.window = rtCtx;
  rtCtx.globalThis = rtCtx;
  vmMod.runInNewContext(fsMod.readFileSync('static/chat/realtime-render.js', 'utf8'), rtCtx);

  // Non-blocking approval status check
  const waitingStatus = ctx.RagentSessionStatusCore.resolveApprovalWaitingStatus({ kind: 'question', isBlocking: false });
  assertMod.equal(waitingStatus.key, 'awaiting_answer');
  assertMod.equal(waitingStatus.isBlocking, false);
  assertMod.equal(ctx.RagentSessionStatusCore.isApprovalBlocking({ kind: 'question', isBlocking: false }), false);

  // Async questions must NOT touch decisionsStore and must render + dismiss cross-client
  ctx.RagentDecisions.beginSessionContext('sess-async', 1);
  const asyncMsgEvt = {
    type: 'message',
    role: 'assistant',
    seq: 11,
    itemId: 'msg-a1',
    content: 'Need your preference',
    messageDelivery: 'async',
    asyncQuestions: [
      { id: 'aq-1', index: 0, question: 'Branch name?', options: ['feat/a', 'feat/b'], allowFreeText: true, status: 'pending' },
    ],
  };
  const streamGroup = ctx.RagentAsyncQuestions.renderInStreamMessageQuestions(asyncMsgEvt, { sessionId: 'sess-async' });
  messagesInner.appendChild(streamGroup);
  ctx.RagentAsyncQuestions.ingestEvents([asyncMsgEvt], { sessionId: 'sess-async' });

  assertMod.equal(ctx.RagentDecisions.getPending(), null, 'async questions must never enter decisionsStore');
  assertMod.equal(ctx.RagentAsyncQuestions.getPendingQuestions('sess-async').length, 1);
  assertMod.equal(asyncPanel.hidden, false);

  // Expand floating bar, choose option, click Send reply -> atomic send with asyncQuestionReplies + steerIfRunning
  asyncPanel.querySelector('.async-questions-panel__summary').listeners.click[0]();
  const optBtn = asyncPanel.querySelectorAll('.async-question-card__option')[0];
  optBtn.listeners.click[0]();
  const submitBtn = asyncPanel.querySelector('.async-question-card__submit');
  assertMod.equal(submitBtn.disabled, false);
  submitBtn.listeners.click[0]();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assertMod.equal(postCalls.length, 1);
  assertMod.equal(postCalls[0].action, 'send');
  assertMod.equal(postCalls[0].steerIfRunning, true);
  assertMod.equal(JSON.stringify(postCalls[0].asyncQuestionReplies), JSON.stringify([{ questionItemId: 'aq-1', question: 'Branch name?', answer: 'feat/a' }]));
  assertMod.equal(ctx.RagentAsyncQuestions.getPendingQuestions('sess-async').length, 0);
  assertMod.equal(asyncPanel.hidden, true);
  assertMod.equal(messagesInner.querySelector('.async-question-card').dataset.asyncQuestionState, 'answered');

  // Cross-client dismissal via WS user envelope event
  const asyncMsg2 = {
    type: 'message',
    role: 'assistant',
    seq: 12,
    itemId: 'msg-a2',
    messageDelivery: 'async',
    asyncQuestions: [{ id: 'aq-2', index: 0, question: 'Retry?', status: 'pending' }],
  };
  ctx.RagentAsyncQuestions.ingestEvents([asyncMsg2], { sessionId: 'sess-async' });
  assertMod.equal(ctx.RagentAsyncQuestions.getPendingQuestions('sess-async').length, 1);
  ctx.RagentAsyncQuestions.ingestEvents([
    {
      type: 'message',
      role: 'user',
      seq: 13,
      content: '<send_user_message_question_reply>[{"questionItemId":"aq-2","question":"Retry?","answer":"Yes"}]</send_user_message_question_reply>',
    },
  ], { sessionId: 'sess-async' });
  assertMod.equal(ctx.RagentAsyncQuestions.getPendingQuestions('sess-async').length, 0);
  assertMod.equal(asyncPanel.hidden, true);

  // Beautification checks in realtime-render.js (formatDecodedDisplayText / stripHiddenDisplayBlocks) and session-surface-ui.js
  const rawEnvelope = '<send_user_message_question_reply>[{"questionItemId":"aq-2","question":"Retry?","answer":"Yes"}]</send_user_message_question_reply>\n\nAlso check tests';
  const decodedDisplay = rtCtx.formatDecodedDisplayText(rawEnvelope);
  assertMod.ok(decodedDisplay.includes('Retry?: Yes') && decodedDisplay.includes('Also check tests'));
  assertMod.ok(!decodedDisplay.includes('<send_user_message_question_reply>'));
  assertMod.equal(rtCtx.stripHiddenDisplayBlocks('Done <send_user_message_quest'), 'Done');

  const queueCtx = {
    window: null,
    globalThis: null,
    document: doc,
    console,
    t: (k, v) => (k === 'asyncQuestion.queuedSummary' ? `Reply to ${v.question}: ${v.answer}` : k),
    queuedPanel: null,
    msgInput: { value: '' },
    parseQuestionReplyEnvelope: ctx.parseQuestionReplyEnvelope,
  };
  queueCtx.window = queueCtx;
  queueCtx.globalThis = queueCtx;
  vmMod.runInNewContext(fsMod.readFileSync('static/chat/session-surface-ui.js', 'utf8'), queueCtx);
  const queuedSummary = queueCtx.getQueuedMessageText({ text: rawEnvelope });
  assertMod.ok(queuedSummary.includes('Retry?: Yes') && queuedSummary.includes('Also check tests') && !queuedSummary.includes('<send_user_message_question_reply>'));

  // Decision sheet Track 1 (multiSelect + customAnswers + isSecret + isBlocking:false Skip) and Track 3 (form + url + unsupported)
  const sheetHost = mkNode('div', 'decisionSheet');
  const inputArea = mkNode('div', 'inputArea');
  inputArea.appendChild(sheetHost);
  const sheetDispatched = [];
  const sheetDoc = {
    body: inputArea,
    head: mkNode('head'),
    contains: () => true,
    createElement: (tag) => mkNode(tag),
    createTextNode: (t) => ({ textContent: String(t), children: [] }),
    getElementById: (id) => (id === 'decisionSheet' ? sheetHost : (id === 'inputArea' ? inputArea : null)),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
  };
  const sheetCtx = {
    window: null,
    globalThis: null,
    document: sheetDoc,
    navigator: { userAgent: '' },
    console,
    URL,
    TextEncoder,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (fn) => { fn(); return 1; },
    cancelAnimationFrame: () => {},
    inputArea,
    queuedPanel: null,
    currentSessionId: 'sess-sheet',
    t: (k) => k,
    dispatchAction: async (payload) => { sheetDispatched.push(payload); return { ok: true }; },
  };
  sheetCtx.window = sheetCtx;
  sheetCtx.globalThis = sheetCtx;
  vmMod.runInNewContext(fsMod.readFileSync('static/chat/core/decisions-store.js', 'utf8'), sheetCtx);
  vmMod.runInNewContext(fsMod.readFileSync('static/chat/decisions-store.js', 'utf8'), sheetCtx);
  vmMod.runInNewContext(fsMod.readFileSync('static/chat/ui.js', 'utf8'), sheetCtx);
  vmMod.runInNewContext(fsMod.readFileSync('static/chat/decision-sheet.js', 'utf8'), sheetCtx);
  sheetCtx.RagentDecisions.beginSessionContext('sess-sheet', 1);

  // Track 1 in decision-sheet: multiSelect + customAnswers + isSecret + isBlocking:false
  sheetCtx.RagentDecisions.noteRequest({
    approvalId: 'ds-q1',
    runId: 'run-ds',
    kind: 'question',
    isBlocking: false,
    questions: [
      { id: 'q0', header: 'Features', question: 'Select features', multiSelect: true, isOther: false, options: [{ label: 'Auth' }, { label: 'Logs' }] },
      { id: 'q1', header: 'Secret', question: 'Enter token', isSecret: true, options: [] },
    ],
  }, { sessionId: 'sess-sheet' });
  assertMod.ok(sheetHost.querySelector('.decision-sheet__nonblocking-badge'));
  const fireClick = async (el) => {
    for (const fn of [...(el.listeners.click || [])]) {
      await fn({ currentTarget: el, target: el, preventDefault() {}, stopPropagation() {} });
    }
  };
  const sheetOpts = sheetHost.querySelectorAll('.runtime-approval-card__option');
  await fireClick(sheetOpts[0]);
  await fireClick(sheetOpts[1]);
  const sheetSecret = sheetHost.querySelector('.decision-sheet__prompt-custom-input');
  assertMod.equal(sheetSecret.type, 'password');
  sheetSecret.value = 'tok-secret';
  sheetSecret.listeners.input[0]();
  const sheetSubmit = sheetHost.querySelector('.oneui-notification__action--primary');
  await fireClick(sheetSubmit);
  assertMod.equal(sheetDispatched[0].decision, 'approve_with_multi_choices');
  assertMod.equal(JSON.stringify(sheetDispatched[0].multiChoices), JSON.stringify([[0, 1], []]));
  assertMod.equal(JSON.stringify(sheetDispatched[0].customAnswers), JSON.stringify(['', 'tok-secret']));

  // Track 1 Skip button
  sheetCtx.RagentDecisions.noteRequest({
    approvalId: 'ds-q-skip',
    runId: 'run-ds',
    kind: 'question',
    isBlocking: false,
    questions: [{ question: 'Optional?', options: ['A', 'B'] }],
  }, { sessionId: 'sess-sheet' });
  const skipBtn = sheetHost.querySelector('.decision-sheet__skip-action');
  await fireClick(skipBtn);
  assertMod.equal(sheetDispatched[1].emptySkip, true);
  assertMod.equal(sheetDispatched[1].decision, 'approve');

  // Track 3 form elicitation in decision-sheet
  sheetCtx.RagentDecisions.noteRequest({
    approvalId: 'ds-el-form',
    runId: 'run-ds',
    kind: 'permissions',
    elicitation: {
      mode: 'form',
      serverName: 'slack',
      message: 'Configure channel',
      requestedSchema: {
        type: 'object',
        required: ['channel'],
        properties: {
          channel: { type: 'string', title: 'Channel' },
          notify: { type: 'boolean', default: true, title: 'Notify' },
        },
      },
    },
  }, { sessionId: 'sess-sheet' });
  const channelInput = sheetHost.querySelector('.elicitation-field__input');
  channelInput.value = '#releases';
  await fireClick(sheetHost.querySelector('.oneui-notification__action--primary'));
  assertMod.equal(sheetDispatched[2].decision, 'approve');
  assertMod.equal(JSON.stringify(sheetDispatched[2].elicitationResponse), JSON.stringify({ action: 'accept', content: { channel: '#releases', notify: true } }));

  // Track 3 unsupported openai/userVerification hides primary/Approve button and only keeps Decline & Cancel
  sheetCtx.RagentDecisions.noteRequest({
    approvalId: 'ds-el-uv',
    runId: 'run-ds',
    kind: 'permissions',
    elicitation: { mode: 'openai/userVerification', serverName: 'gh', message: 'Confirm' },
  }, { sessionId: 'sess-sheet' });
  assertMod.equal(sheetHost.querySelector('.oneui-notification__action--primary'), null);
  assertMod.equal(sheetHost.querySelectorAll('.oneui-notification__action').length, 2);
})();

console.log('approval web surfaces: passed');
