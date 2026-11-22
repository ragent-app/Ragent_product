import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../static/chat/approval-explanation.js', import.meta.url), 'utf8');
const messages = { 'decisionSheet.operation.delete':'delete', 'decisionSheet.operation.may':'May {action}',
  'decisionSheet.operationRisk.partial':'Review conditional command', 'decisionSheet.operationRisk.delete':'Deletion may be irreversible',
  'decisionSheet.operationRisk.provider_conflict':'Description conflicts', 'decisionSheet.operation.git_force_push':'Force push', 'decisionSheet.operationRisk.force_push':'History may change', 'decisionSheet.operationSafer.force_push':'Consider --force-with-lease' };
const tr = (key, vars = {}) => (messages[key] || key).replace(/\{(\w+)\}/g, (_, k) => vars[k] || '');
const root = {};
vm.runInNewContext(source, { window: root });
const present = (value) => root.ragentApprovalExplanation(value, tr);
const original = { operation:'delete', targets:['/tmp/example'], conditional:true, partial:true,
  riskCode:'composite_unanalyzed', summary:'包含 3 步操作', reason:'old reason', providerConflict:true };
const shown = present(original);
assert.equal(shown.summary, 'May delete: /tmp/example');
assert.match(shown.reason, /Deletion may be irreversible/);
assert.match(shown.reason, /Review conditional command/);
assert.match(shown.reason, /Description conflicts/);
assert.equal(shown.saferAlternative, '');
assert.equal(present({ summary:'legacy' }).summary, 'legacy');
assert.match(present({ operation:'git_force_push', riskCode:'force_push' }).saferAlternative, /force-with-lease/);
assert.equal(present({ operation:'future_operation', riskCode:'unknown_command' }).operation, undefined);
assert.equal(present({ summary:'包含 3 步操作' }).summary, '');
const legacyComposite = present({summary:'包含 3 步操作', reason:'命令串联了多个步骤，部分行为无法静态确认', saferAlternative:'拆成单条命令逐步确认后再执行'});
assert.equal(legacyComposite.reason, 'Review conditional command');
assert.equal(legacyComposite.saferAlternative, '');
assert.equal(present(null), null);
await (async () => {
  const { default: assertMod } = await import('node:assert/strict');
  const fsMod = await import('node:fs');
  const vmMod = await import('node:vm');

  function makeMiniEl(tag) {
    const node = {
      tagName: String(tag || 'DIV').toUpperCase(),
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
      checked: false,
      placeholder: '',
      _text: '',
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
      hasAttribute(k) { return k in this.attrs; },
      removeAttribute(k) { delete this.attrs[k]; },
      classList: {
        add(...cs) { node.className = [...new Set([...node.className.split(/\s+/).filter(Boolean), ...cs])].join(' '); },
        remove(...cs) { node.className = node.className.split(/\s+/).filter(Boolean).filter((c) => !cs.includes(c)).join(' '); },
        toggle(c, f) { const has = this.contains(c); const next = f === undefined ? !has : Boolean(f); if (next) this.add(c); else this.remove(c); return next; },
        contains(c) { return node.className.split(/\s+/).filter(Boolean).includes(c); },
      },
      appendChild(c) { if (!c) return c; c.parentNode = this; this.children.push(c); return c; },
      insertBefore(c, ref) { c.parentNode = this; const i = ref ? this.children.indexOf(ref) : -1; if (i >= 0) this.children.splice(i, 0, c); else this.children.push(c); return c; },
      replaceChild(n, o) { const i = this.children.indexOf(o); if (i >= 0) { n.parentNode = this; this.children[i] = n; } return o; },
      addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); },
      dispatchEvent(e) { for (const fn of this.listeners[e?.type] || []) fn(e); },
      querySelectorAll(sel) {
        const out = [];
        const parts = String(sel).split(',').map((s) => s.trim()).filter(Boolean);
        const match = (n) => parts.some((p) => (p.startsWith('.') ? n.classList?.contains(p.slice(1).split(/[\[:]/)[0]) : n.tagName === p.toUpperCase()));
        const walk = (n) => { for (const c of n.children || []) { if (match(c)) out.push(c); walk(c); } };
        walk(this);
        return out;
      },
      querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
      get textContent() { return this._text || this.children.map((c) => c.textContent || '').join(''); },
      set textContent(v) { this._text = String(v ?? ''); },
      set innerHTML(v) { this.children = []; this._text = String(v ?? ''); },
    };
    return node;
  }

  const openedUrls = [];
  const dispatched = [];
  const streamBox = makeMiniEl('div');
  const doc = {
    createElement: makeMiniEl,
    createTextNode: (t) => ({ textContent: String(t), children: [] }),
    getElementById: (id) => (id === 'messagesInner' ? streamBox : null),
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
    messagesInner: streamBox,
    dispatchAction: async (p) => { dispatched.push(p); return { ok: true }; },
    open: (...args) => openedUrls.push(args),
    marked: { parse: (v) => `<p>${String(v ?? '')}</p>` },
    enhanceCodeBlocks: () => {},
    enhanceTables: () => {},
    enhanceRenderedContentLinks: () => {},
    formatDecodedDisplayText: (v) => String(v ?? ''),
    renderMarkdownIntoNode: () => false,
    appendUserMessageDisclosure: () => {},
    markLazyEventBodyNode: () => false,
    appendMessageMeta: () => {},
    currentSessionId: 's-pres',
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vmMod.runInNewContext(fsMod.readFileSync('static/chat/async-questions-ui.js', 'utf8'), ctx);
  vmMod.runInNewContext(fsMod.readFileSync('static/chat/ui.js', 'utf8'), ctx);

  // Track 1: prompt normalization, multiSelect, isOther, isSecret, isBlocking, submit forwarding
  const sections = ctx.getApprovalPromptSections({
    kind: 'question',
    isBlocking: false,
    questions: [
      { id: 'q1', header: 'Env', question: 'Select targets', multiSelect: true, isOther: false, options: [{ label: 'Prod', description: 'Live' }, { label: 'Staging' }] },
      { id: 'q2', header: 'Token', question: 'API Key', isSecret: true, options: [] },
    ],
  });
  assertMod.equal(sections.length, 2);
  assertMod.equal(sections[0].multiSelect, true);
  assertMod.equal(sections[0].isOther, false);
  assertMod.equal(sections[0].isBlocking, false);
  assertMod.equal(sections[0].options[0].description, 'Live');
  assertMod.equal(sections[1].isSecret, true);

  const sec0El = ctx.createApprovalPromptSection(sections[0], 0, { renderCustomInput: true });
  assertMod.equal(sec0El.querySelectorAll('.runtime-approval-card__option')[0].getAttribute('role'), 'checkbox');
  assertMod.equal(sec0El.querySelectorAll('.runtime-approval-card__custom-input').length, 0, 'isOther: false hides custom input when options exist');

  const sec1El = ctx.createApprovalPromptSection(sections[1], 1, { renderCustomInput: true });
  const secretInput = sec1El.querySelector('.runtime-approval-card__custom-input');
  assertMod.equal(secretInput.type, 'password');
  assertMod.equal(secretInput.getAttribute('autocomplete'), 'off');
  assertMod.equal(secretInput.getAttribute('spellcheck'), 'false');
  const toggleBtn = sec1El.querySelector('.runtime-approval-card__secret-toggle');
  toggleBtn.listeners.click[0]();
  assertMod.equal(secretInput.type, 'text');
  toggleBtn.listeners.click[0]();
  assertMod.equal(secretInput.type, 'password');
  assertMod.equal(ctx.redactApprovalSecretValue('my-secret-key'), '••••••');

  await ctx.submitRuntimeApprovalDecision(
    { approvalId: 'app-1', runId: 'run-1', kind: 'question', sessionId: 's-pres' },
    'approve',
    makeMiniEl('button'),
    [0, -1],
    '',
    { multiChoices: [[0, 1], []], customAnswers: ['', 'tok_123'] }
  );
  assertMod.equal(dispatched[0].decision, 'approve_with_multi_choices');
  assertMod.equal(dispatched[0].multiChoices[0].length, 2);
  assertMod.equal(JSON.stringify(dispatched[0].customAnswers), JSON.stringify(['', 'tok_123']));
  await ctx.submitRuntimeApprovalDecision(
    { approvalId: 'app-skip', runId: 'run-1', kind: 'question', sessionId: 's-pres' },
    'approve',
    makeMiniEl('button'),
    [-1],
    '',
    { emptySkip: true }
  );
  assertMod.equal(dispatched[1].decision, 'approve');
  assertMod.equal(dispatched[1].emptySkip, true);

  // Track 2: reply envelope round-trip, 512B fallback, user bubble chips & assistant cards
  const builtXml = ctx.buildAsyncQuestionReplyText([{ questionItemId: 'qi-1', question: 'Ship?', answer: 'Yes' }], 'Extra note');
  assertMod.ok(builtXml.startsWith('<send_user_message_question_reply>'));
  const parsedXml = ctx.parseQuestionReplyEnvelope(builtXml);
  assertMod.equal(parsedXml.hasEnvelope, true);
  assertMod.deepEqual(Array.from(parsedXml.answeredIds), ['qi-1']);
  assertMod.equal(parsedXml.trailingText, 'Extra note');
  assertMod.ok(!ctx.getMessageActionText({ content: builtXml }, 'user').includes('<send_user_message_question_reply>'));

  const longId = 'x'.repeat(513);
  const fallbackMd = ctx.buildAsyncQuestionReplyText([{ questionItemId: longId, question: 'Long?', answer: 'Fallback' }]);
  assertMod.ok(!fallbackMd.includes('<send_user_message_question_reply>'));
  assertMod.ok(fallbackMd.includes('> **Long?**'));

  const userNode = ctx.createUserMessageNode({ role: 'user', content: builtXml });
  assertMod.equal(userNode.querySelectorAll('.user-question-reply-chip').length, 1);
  assertMod.ok(!userNode.textContent.includes('<send_user_message_question_reply>'));

  const asyncMsgNode = ctx.renderMessageInto(streamBox, {
    role: 'assistant',
    seq: 9,
    itemId: 'item-async-9',
    content: '',
    messageDelivery: 'async',
    asyncQuestions: [{ id: 'qi-9', index: 0, question: 'Proceed?', options: ['Go', 'Wait'], status: 'pending' }],
  });
  assertMod.ok(asyncMsgNode.querySelector('.async-question-card'));
  const followUpNode = ctx.renderMessageInto(streamBox, {
    role: 'assistant',
    seq: 10,
    content: 'Quick status update',
    messageDelivery: 'async',
  });
  assertMod.ok(followUpNode.querySelector('.async-followup-card'));

  // Track 3: elicitation classification, form validation, URL scheme guard
  assertMod.equal(ctx.classifyCodexElicitation({ kind: 'permissions', elicitation: { codexApprovalKind: 'mcp_tool_call', requestedSchema: {} } }).kind, 'compact_mcp');
  assertMod.equal(ctx.classifyCodexElicitation({ kind: 'permissions', elicitation: { mode: 'openai/form', requestedSchema: { properties: { a: { type: 'string' } } } } }).kind, 'form');
  assertMod.equal(ctx.classifyCodexElicitation({ kind: 'permissions', elicitation: { mode: 'url', url: 'https://auth.example.com' } }).kind, 'url');
  assertMod.equal(ctx.classifyCodexElicitation({ kind: 'permissions', elicitation: { mode: 'openai/userVerification' } }).kind, 'unsupported');

  const formCtrl = ctx.buildElicitationSchemaForm({
    type: 'object',
    required: ['apiKey', 'retries'],
    properties: {
      apiKey: { type: 'string', format: 'password', title: 'API Key' },
      retries: { type: 'integer', minimum: 1, maximum: 5 },
      mode: { type: 'string', enum: ['fast', 'safe'], default: 'safe' },
      confirm: { type: 'boolean', default: true },
    },
  });
  assertMod.equal(formCtrl.collectAndValidate(true).valid, false, 'missing required fails validation');
  const [pwInput, numInput] = formCtrl.element.querySelectorAll('INPUT');
  assertMod.equal(pwInput.type, 'password');
  pwInput.value = 'sk-test';
  numInput.value = '3';
  const validForm = formCtrl.collectAndValidate(true);
  assertMod.equal(validForm.valid, true);
  assertMod.equal(JSON.stringify(validForm.content), JSON.stringify({ apiKey: 'sk-test', retries: 3, mode: 'safe', confirm: true }));

  const unsafeUrlCard = ctx.buildElicitationUrlCard({ mode: 'url', url: 'javascript:alert(1)' });
  assertMod.equal(unsafeUrlCard.valid, false);
  const safeUrlCard = ctx.buildElicitationUrlCard({ mode: 'url', serverName: 'gh', url: 'https://github.com/login/device' });
  assertMod.equal(safeUrlCard.valid, true);
  safeUrlCard.element.querySelectorAll('BUTTON')[0].listeners.click[0]();
  assertMod.equal(openedUrls[0][0], 'https://github.com/login/device');
  assertMod.equal(openedUrls[0][2], 'noopener,noreferrer');
})();

console.log('approval web presentation: passed');
