#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const uiSource = readFileSync(join(repoRoot, 'static', 'chat', 'ui.js'), 'utf8');

function extractFunctionSource(source, functionName) {
  const marker = `function ${functionName}`;
  const functionStart = source.indexOf(marker);
  assert.notEqual(functionStart, -1, `${functionName} should exist`);
  const asyncPrefixStart = source.lastIndexOf('async ', functionStart);
  const start = asyncPrefixStart >= 0 && asyncPrefixStart + 'async '.length === functionStart
    ? asyncPrefixStart
    : functionStart;
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

function makeElement(tagName = 'div') {
  const element = {
    tagName: String(tagName || 'div').toUpperCase(),
    type: '',
    className: '',
    textContent: '',
    innerHTML: '',
    dataset: {},
    attrs: {},
    hidden: false,
    children: [],
    parentNode: null,
    classList: null,
    setAttribute(name, value) {
      this.attrs[name] = String(value);
    },
    getAttribute(name) {
      return this.attrs[name];
    },
    appendChild(child) {
      if (child.parentNode && Array.isArray(child.parentNode.children)) {
        const previousIndex = child.parentNode.children.indexOf(child);
        if (previousIndex >= 0) child.parentNode.children.splice(previousIndex, 1);
      }
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    replaceChild(nextChild, previousChild) {
      const index = this.children.indexOf(previousChild);
      if (index >= 0) {
        nextChild.parentNode = this;
        previousChild.parentNode = null;
        this.children[index] = nextChild;
      }
      return previousChild;
    },
    querySelectorAll(selector) {
      const matches = [];
      const visit = (node) => {
        const classMatch = selector.match(/\.([A-Za-z0-9_-]+)/);
        const wantsPlanId = /\[data-plan-id\]/.test(selector);
        const wantsRunId = /\[data-run-id\]/.test(selector);
        const className = classMatch ? classMatch[1] : '';
        const hasClass = !className || String(node.className || '').split(/\s+/).includes(className);
        const hasPlanId = !wantsPlanId || !!node.dataset?.planId;
        const hasRunId = !wantsRunId || !!node.dataset?.runId;
        if (hasClass && hasPlanId && hasRunId) matches.push(node);
        for (const child of node.children || []) visit(child);
      };
      visit(this);
      return matches;
    },
    addEventListener(type, handler) {
      this[`on${type}`] = handler;
    },
  };
  element.classList = {
    contains(token) {
      return String(element.className || '').split(/\s+/).includes(token);
    },
    toggle(token, force) {
      const classes = new Set(String(element.className || '').split(/\s+/).filter(Boolean));
      const shouldAdd = force === undefined ? !classes.has(token) : !!force;
      if (shouldAdd) classes.add(token);
      else classes.delete(token);
      element.className = [...classes].join(' ');
    },
    add(token) {
      this.toggle(token, true);
    },
    remove(token) {
      this.toggle(token, false);
    },
  };
  return element;
}

function collectText(node) {
  return [
    node.textContent || '',
    node.innerHTML || '',
    ...(node.children || []).map(collectText),
  ].flat().join('\n');
}

const functionNames = [
  'renderUiIcon',
  'renderMarkdownFragmentIntoNode',
  'getPlanProposalTitle',
  'stripPlanProposalTitleHeading',
  'copyPlanProposalText',
  'createPlanCopyButton',
  'setPendingComposerPlanAction',
  'consumePendingComposerPlanAction',
  'setPendingComposerPlanId',
  'consumePendingComposerPlanId',
  'submitPlanArtifactAction',
  'insertPlanPromptIntoComposer',
  'createPlanProposalAction',
  'renderPlanProposalCard',
  'normalizePlanItemStatus',
  'normalizePlanEventItems',
  'getPlanEventState',
  'getPlanEventTitle',
  'getPlanEventSummary',
  'getPlanEventId',
  'isPlanProgressEvent',
  'isPlanActionStateUpdate',
  'getPlanProgressSummary',
  'formatPlanEventText',
  'createPlanEventItemNode',
  'isPlanEventActionDisabled',
  'createCodexPlanCard',
  'findRenderedPlanCard',
  'renderPlanEventInto',
  'movePlanProgressCardToEnd',
  'renderPlanAwareMarkdownIntoNode',
  'renderMarkdownIntoNode',
];

const modeChanges = [];
let sendCount = 0;
const dispatchedActions = [];

const context = {
  console,
  document: {
    createElement: makeElement,
  },
  Event: class Event {
    constructor(type) {
      this.type = type;
    }
  },
  marked: {
    parse(markdown) {
      return String(markdown || '').trim() ? `<p>${markdown}</p>` : '';
    },
  },
  formatDecodedDisplayText(value) {
    return typeof value === 'string' ? value : '';
  },
  enhanceTables() {},
  enhanceCodeBlocks() {},
  enhanceRenderedContentLinks() {},
  t(key, vars = {}) {
    return {
      'action.copied': 'Copied',
      'action.copyFailed': 'Copy failed',
      'plan.card.label': 'Plan',
      'plan.card.untitled': 'Proposed plan',
      'plan.card.codexTitle': 'Codex plan',
      'plan.card.summary': `${vars?.completed}/${vars?.total} complete · ${vars?.status}`,
      'plan.card.empty': 'No plan steps yet.',
      'plan.progress.label': 'Progress',
      'plan.progress.summary': `${vars?.completed}/${vars?.total} · ${vars?.current}`,
      'plan.progress.complete': `${vars?.completed}/${vars?.total} · Complete`,
      'plan.progress.empty': 'Preparing steps',
      'plan.status.running': 'updating',
      'plan.status.drafting': 'drafting',
      'plan.status.awaiting_decision': 'ready',
      'plan.status.revising': 'revising',
      'plan.status.approved': 'approved',
      'plan.status.executing': 'executing',
      'plan.status.superseded': 'superseded',
      'plan.status.failed': 'failed',
      'plan.status.completed': 'complete',
      'plan.action.copy': 'Copy',
      'plan.action.revise': 'Revise',
      'plan.action.execute': 'Execute',
      'plan.action.revising': 'Revising',
      'plan.action.executing': 'Executing',
      'plan.action.revisePrompt': 'Please revise the proposed plan above.',
      'plan.action.executePrompt': 'Please implement the proposed plan above.',
    }[key] || key;
  },
  window: {
    setTimeout() {},
    RagentIcons: {
      render() {
        return '';
      },
    },
  },
  msgInput: {
    value: '',
    dispatched: [],
    dispatchEvent(event) {
      this.dispatched.push(event.type);
    },
    focus() {
      this.focused = true;
    },
  },
  modeChanges,
  setComposerInteractionMode(mode) {
    modeChanges.push(mode);
  },
  sendMessage() {
    sendCount += 1;
  },
  currentSessionId: 'session-ui-test',
  async dispatchAction(action) {
    dispatchedActions.push(action);
    return true;
  },
};
context.globalThis = context;

vm.runInNewContext(
  [
    ...functionNames.map((name) => extractFunctionSource(uiSource, name)),
    'globalThis.renderMarkdownIntoNode = renderMarkdownIntoNode;',
    'globalThis.renderPlanEventInto = renderPlanEventInto;',
  ].join('\n\n'),
  context,
  { filename: 'static/chat/ui.js' },
);

const planNode = makeElement('div');
const didRenderPlan = context.renderMarkdownIntoNode(
  planNode,
  [
    'Before the handoff:',
    '',
    '<proposed_plan>',
    '# Ragent UI Plan',
    '',
    '## Summary',
    '',
    'Make Plan mode clear.',
    '</proposed_plan>',
    '',
    'After the card.',
  ].join('\n'),
);

assert.equal(didRenderPlan, true, 'plan markdown should render');
assert.equal(planNode.children.length, 3, 'surrounding markdown and plan card should all render');
assert.equal(planNode.children[1].className, 'plan-card', 'plan block should become a plan card');
assert.equal(collectText(planNode).includes('<proposed_plan>'), false, 'raw opening tag should not be visible');
assert.equal(collectText(planNode).includes('</proposed_plan>'), false, 'raw closing tag should not be visible');
assert.equal(collectText(planNode).includes('Ragent UI Plan'), true, 'plan title should be visible');
assert.equal(collectText(planNode).includes('Make Plan mode clear.'), true, 'plan body should be visible');
assert.equal(planNode.children[1].children.at(-1).className, 'plan-card__actions', 'plan card should expose an action row');
assert.equal(planNode.children[1].children.at(-1).children.length, 3, 'plan card should expose copy/revise/execute actions');

const markdownReviseButton = planNode.children[1].children.at(-1).children[1];
markdownReviseButton.onclick({ currentTarget: markdownReviseButton });
assert.deepEqual(context.modeChanges.at(-1), 'plan', 'markdown plan revise should switch composer to plan mode');
assert.equal(context.consumePendingComposerPlanAction(), 'revise', 'markdown plan revise should mark a revise action');

const markdownExecuteButton = planNode.children[1].children.at(-1).children[2];
markdownExecuteButton.onclick({ currentTarget: markdownExecuteButton });
assert.deepEqual(context.modeChanges.at(-1), 'agent', 'markdown plan execute should switch composer to agent mode');
assert.equal(context.consumePendingComposerPlanAction(), 'execute', 'markdown plan execute should mark an execute action');

const plainNode = makeElement('div');
const didRenderPlain = context.renderMarkdownIntoNode(plainNode, 'Plain **markdown**');

assert.equal(didRenderPlain, true, 'ordinary markdown should still render');
assert.equal(plainNode.children.length, 0, 'ordinary markdown should not create a plan card');
assert.equal(plainNode.innerHTML, '<p>Plain **markdown**</p>', 'ordinary markdown should keep the normal renderer path');

const codexPlanContainer = makeElement('div');
const codexPlan = {
  type: 'plan',
  role: 'assistant',
  planId: 'plan-ui-test',
  state: 'running',
  items: [
    { text: 'Inspect current behavior', status: 'completed' },
    { text: 'Patch plan rendering', status: 'in_progress' },
    { text: 'Verify interaction', status: 'pending' },
  ],
};
const codexCard = context.renderPlanEventInto(codexPlanContainer, codexPlan);
assert.ok(codexCard.className.includes('codex-plan-card'), 'Codex plan events should render as dedicated plan cards');
assert.equal(codexPlanContainer.children.length, 1, 'first plan event should append one card');
assert.equal(collectText(codexCard).includes('2/3 complete · drafting'), false, 'summary should use completed count from event data');
assert.equal(collectText(codexCard).includes('1/3 complete · drafting'), true, 'summary should show progress');
const codexBody = codexCard.querySelectorAll('.plan-card__body')[0];
assert.equal(codexBody.hidden, false, 'plan card body should start expanded');

codexCard.children[0].onclick();
assert.equal(codexCard.classList.contains('collapsed'), true, 'clicking the plan header should collapse the card');
assert.equal(codexBody.hidden, true, 'collapsed plan cards should hide the body');

const emptyPlanContainer = makeElement('div');
const emptyPlanCard = context.renderPlanEventInto(emptyPlanContainer, {
  ...codexPlan,
  planId: 'empty-plan-ui-test',
  state: 'awaiting_decision',
  items: [],
});
assert.ok(emptyPlanCard, 'empty plan events should render a plan card');
assert.equal(emptyPlanCard.querySelectorAll('.plan-card__title').length, 0, 'Codex plan cards should use the kind label as headline, not duplicate the generic title');
assert.equal(collectText(emptyPlanCard).includes('ready'), false, 'empty plan headers should not expose a bare status word');
assert.equal(collectText(emptyPlanCard).includes('No plan steps yet.'), true, 'empty plan cards should explain the missing steps');

const updatedCard = context.renderPlanEventInto(codexPlanContainer, {
  ...codexPlan,
  state: 'completed',
  items: codexPlan.items.map((item) => ({ ...item, status: 'completed' })),
});
assert.equal(codexPlanContainer.children.length, 1, 'later plan events with the same planId should update the existing card');
assert.equal(updatedCard.classList.contains('collapsed'), true, 'plan card updates should preserve collapsed state');
assert.equal(collectText(updatedCard).includes('3/3 complete · complete'), true, 'updated cards should show the latest plan state');

const executeButton = updatedCard.children.at(-1).children[2];
const modeChangeCountBeforeDirectExecute = context.modeChanges.length;
await executeButton.onclick({ currentTarget: executeButton });
assert.equal(sendCount, 1, 'direct plan execute should not submit a synthetic composer prompt');
assert.equal(dispatchedActions.at(-1)?.action, 'plan_action', 'execute should call the plan action API');
assert.equal(dispatchedActions.at(-1)?.sessionId, 'session-ui-test', 'execute should target the current session');
assert.equal(dispatchedActions.at(-1)?.planId, 'plan-ui-test', 'execute should target the concrete plan artifact');
assert.equal(dispatchedActions.at(-1)?.planAction, 'execute', 'execute should request the execute action');
assert.equal(dispatchedActions.at(-1)?.text, '', 'direct execute should not expose a synthetic prompt');
assert.equal(context.modeChanges.length, modeChangeCountBeforeDirectExecute + 1, 'successful direct execute should update the composer mode');
assert.equal(context.modeChanges.at(-1), 'agent', 'successful direct execute should deselect plan mode');

const reviseButton = updatedCard.children.at(-1).children[1];
reviseButton.onclick({ currentTarget: reviseButton });
assert.deepEqual(context.modeChanges.at(-1), 'plan', 'revise should switch the composer to plan mode');
assert.equal(context.consumePendingComposerPlanAction(), 'revise', 'revise should mark the next send as a plan revision');
assert.equal(context.consumePendingComposerPlanId(), 'plan-ui-test', 'revise should target the concrete plan artifact');
assert.equal(context.msgInput.value.includes('Patch plan rendering'), false, 'revise should not expose the full hidden plan prompt in the composer');

const progressContainer = makeElement('div');
const progressCard = context.renderPlanEventInto(progressContainer, {
  ...codexPlan,
  planId: 'progress-ui-test',
  runId: 'run-progress-ui-test',
  planIntent: 'progress',
});
assert.ok(progressCard.className.includes('codex-plan-progress'), 'agent plans should render as progress summaries');
assert.equal(progressCard.className.includes('plan-card'), false, 'agent progress should not use the proposal/approval card shell');
assert.ok(progressCard.className.includes('collapsed'), 'progress summaries should start collapsed');
assert.equal(progressCard.children.length, 2, 'progress summaries should omit the action footer');
assert.equal(collectText(progressCard).includes('Progress'), true, 'progress summaries should use the progress label');
assert.equal(collectText(progressCard).includes('1/3 · Patch plan rendering'), true, 'progress summaries should show count and current step');
assert.equal(progressCard.children[1].hidden, true, 'progress steps should start hidden');

progressCard.children[0].onclick();
assert.equal(progressCard.classList.contains('collapsed'), false, 'clicking progress summary should expand it');
assert.equal(progressCard.children[1].hidden, false, 'expanded progress summary should show all steps');

const laterOutput = makeElement('div');
laterOutput.dataset.runId = 'run-progress-ui-test';
progressContainer.appendChild(laterOutput);
context.movePlanProgressCardToEnd(progressContainer, 'run-progress-ui-test');
assert.equal(progressContainer.children.at(-1), laterOutput, 'progress summary should keep its event-order position after later output');
assert.equal(progressContainer.children[0], progressCard, 'progress summary should not be moved to the end of the transcript');

const formalPlanCard = context.renderPlanEventInto(progressContainer, {
  ...codexPlan,
  planId: 'formal-plan-ui-test',
  runId: 'run-progress-ui-test',
  planIntent: 'proposal',
});
assert.equal(formalPlanCard.children.length, 4, 'formal plan cards should retain copy, body, and action footer');
assert.equal(formalPlanCard.children.at(-1).className, 'plan-card__actions', 'formal plan cards should retain their action footer');
assert.equal(progressContainer.children[0], progressCard, 'progress summaries should retain their original event-order position');
assert.equal(progressContainer.children.at(-1), formalPlanCard, 'later formal plan cards should append after earlier progress and output');

const crossRunContainer = makeElement('div');
const originalProposalCard = context.renderPlanEventInto(crossRunContainer, {
  ...codexPlan,
  planId: 'shared-plan-ui-test',
  runId: 'run-original-plan',
  planIntent: 'proposal',
  source: 'ragent-plan-fallback',
});
const executingProposalCard = context.renderPlanEventInto(crossRunContainer, {
  ...codexPlan,
  planId: 'shared-plan-ui-test',
  runId: 'run-execute-plan',
  planIntent: 'proposal',
  source: 'ragent-plan-action',
  state: 'executing',
});
assert.equal(crossRunContainer.children.length, 1, 'same proposal plan id from an executing run should update the original card');
assert.equal(crossRunContainer.children[0], executingProposalCard, 'the executing state should stay anchored to the original proposal position');
assert.notEqual(crossRunContainer.children[0], originalProposalCard, 'the original proposal node should be replaced in place');

const completedProposalCard = context.renderPlanEventInto(crossRunContainer, {
  ...codexPlan,
  planId: 'shared-plan-ui-test',
  runId: 'run-execute-plan',
  planIntent: 'proposal',
  source: 'ragent-plan-action',
  state: 'completed',
});
assert.equal(crossRunContainer.children.length, 1, 'later proposal updates should not append at the end of the transcript');
assert.equal(crossRunContainer.children[0], completedProposalCard, 'the completed card should remain anchored to the original proposal position');

const orphanPlanActionContainer = makeElement('div');
const orphanPlanActionCard = context.renderPlanEventInto(orphanPlanActionContainer, {
  ...codexPlan,
  planId: 'orphan-action-plan-ui-test',
  runId: 'run-orphan-action-plan',
  planIntent: 'proposal',
  source: 'ragent-plan-action',
  state: 'completed',
});
assert.equal(orphanPlanActionCard, null, 'proposal state updates without an existing anchor should not render as orphan cards');
assert.equal(orphanPlanActionContainer.children.length, 0, 'orphan proposal updates should not append at the bottom of a paged transcript');

const crossRunProgressContainer = makeElement('div');
const originalProgressCard = context.renderPlanEventInto(crossRunProgressContainer, {
  ...codexPlan,
  planId: 'shared-progress-ui-test',
  runId: 'run-original-progress',
  planIntent: 'progress',
});
const otherProgressCard = context.renderPlanEventInto(crossRunProgressContainer, {
  ...codexPlan,
  planId: 'shared-progress-ui-test',
  runId: 'run-other-progress',
  planIntent: 'progress',
});
assert.equal(crossRunProgressContainer.children.length, 2, 'progress cards with matching ids but different runs should keep separate positions');
assert.equal(crossRunProgressContainer.children[0], originalProgressCard, 'the original progress card should remain in place');
assert.equal(crossRunProgressContainer.children[1], otherProgressCard, 'a different run progress update should append as its own card');

console.log('test-chat-plan-card-rendering: ok');
