#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const toolingSource = readFileSync(join(repoRoot, 'static', 'chat', 'tooling.js'), 'utf8');
const sidebarUiSource = readFileSync(join(repoRoot, 'static', 'chat', 'sidebar-ui.js'), 'utf8');

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

function makeClassList() {
  const classes = new Set();
  return {
    toggle(token, force) {
      if (force) classes.add(token);
      else classes.delete(token);
    },
    contains(token) {
      return classes.has(token);
    },
  };
}

function makeButton() {
  return {
    classList: makeClassList(),
    disabled: false,
    attrs: {},
    setAttribute(name, value) {
      this.attrs[name] = value;
    },
  };
}

function makeSelect(value, options) {
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  return {
    value,
    selectedIndex,
    disabled: false,
    style: {},
    options,
    dispatched: [],
    dispatchEvent(event) {
      this.dispatched.push(event.type);
    },
  };
}

const context = {
  console,
  Event: class Event {
    constructor(type) {
      this.type = type;
    }
  },
  document: {
    createElement(tagName) {
      return { tagName: String(tagName).toUpperCase(), value: '', textContent: '' };
    },
  },
  window: {},
  t(key) {
    return {
      'action.switchMode': 'Switch mode',
      'compose.mode.chat': 'Chat',
      'compose.mode.plan': 'Plan',
      'compose.summary.default': 'Chat · default',
      'compose.placeholder.plan': 'Ask Ragent to draft a plan first...',
      'compose.add.planOn': 'Turn plan mode on',
      'compose.add.planOff': 'Turn plan mode off',
      'input.placeholder.archived': 'Archived',
      'input.placeholder.message': 'Message...',
      'input.placeholder.queueFollowUp': 'Queue follow-up...',
      'input.placeholder.readOnlySnapshot': 'Read-only snapshot',
      'tooling.defaultModel': 'default',
    }[key] || key;
  },
  inlineAgentSelect: makeSelect('', [
    { value: '', textContent: 'Agent' },
    { value: '__plan', textContent: 'Plan' },
  ]),
  inlineToolSelect: makeSelect('codex', [
    { value: 'codex', textContent: 'Claude Code' },
  ]),
  inlineModelSelect: makeSelect('', [
    { value: '', textContent: 'default' },
  ]),
  effortSelect: makeSelect('medium', [
    { value: 'medium', textContent: 'medium' },
  ]),
  thinkingToggle: { style: { display: 'none' } },
  contextTokens: {
    style: { display: '' },
    textContent: '29K context · 42%',
  },
  inputArea: { classList: makeClassList() },
  composerPlanChip: { hidden: true },
  composerPlanMenuItem: makeButton(),
  composerPlanMenuNote: { textContent: '' },
  msgInput: {
    dataset: {},
    placeholder: '',
  },
  currentSessionId: 'session_1',
  shareSnapshotMode: false,
  getCurrentSession() {
    return { id: 'session_1' };
  },
  isSessionBusy() {
    return false;
  },
};
context.globalThis = context;

const functionNames = [
  'isComposerPlanMode',
  'canToggleComposerPlanMode',
  'ensureComposerPlanOption',
  'getSelectDisplayLabel',
  'getVisibleContextSummary',
  'getComposerRuntimeSummaryParts',
  'getComposerPlaceholderKey',
  'syncComposerModeUi',
  'setComposerInteractionMode',
  'restoreComposerInteractionMode',
];

vm.runInNewContext(
  [
    ...functionNames.map((name) => extractFunctionSource(toolingSource, name)),
    'globalThis.syncComposerModeUi = syncComposerModeUi;',
    'globalThis.setComposerInteractionMode = setComposerInteractionMode;',
    'globalThis.restoreComposerInteractionMode = restoreComposerInteractionMode;',
  ].join('\n\n'),
  context,
  { filename: 'static/chat/tooling.js' },
);

context.syncComposerModeUi();

assert.equal(context.msgInput.placeholder, 'Message...', 'chat mode should keep the normal placeholder');
assert.equal(context.composerPlanChip.hidden, true, 'chat mode should not show the plan chip');
assert.equal(context.composerPlanMenuItem.attrs['aria-checked'], 'false', 'plan menu item should be unchecked by default');
assert.equal(context.composerPlanMenuNote.textContent, 'Turn plan mode on', 'plan menu item should describe enabling plan mode');

context.inlineAgentSelect.value = '__plan';
context.inlineAgentSelect.selectedIndex = 1;
context.syncComposerModeUi();

assert.equal(context.msgInput.placeholder, 'Ask Ragent to draft a plan first...', 'plan mode should use the plan placeholder');
assert.equal(context.composerPlanChip.hidden, false, 'plan mode should show the plan chip');
assert.equal(context.composerPlanMenuItem.attrs['aria-checked'], 'true', 'plan menu item should be checked in plan mode');
assert.equal(context.composerPlanMenuNote.textContent, 'Turn plan mode off', 'plan menu item should describe disabling plan mode');
assert.equal(context.inputArea.classList.contains('is-plan-mode'), true, 'input area should expose plan mode state');

context.inlineAgentSelect.value = '';
context.inlineAgentSelect.selectedIndex = 0;
context.setComposerInteractionMode('plan');

assert.equal(context.inlineAgentSelect.value, '__plan', 'setComposerInteractionMode should select the __plan pseudo-agent');
assert.deepEqual(context.inlineAgentSelect.dispatched, ['change'], 'setComposerInteractionMode should notify existing change handlers');

context.restoreComposerInteractionMode({ id: 'session_plan', interactionMode: 'plan' });
assert.equal(context.inlineAgentSelect.value, '__plan', 'a plan session should restore its own plan mode');
context.restoreComposerInteractionMode({ id: 'session_agent', interactionMode: 'agent' });
assert.equal(context.inlineAgentSelect.value, '', 'an agent session should not inherit plan mode from the previous session');
assert.deepEqual(context.inlineAgentSelect.dispatched, ['change'], 'restoring another session should not emit a preference change');

let createdSessionPayload = null;
const createSessionContext = {
  window: {
    ragentGetSelectedWorkspaceMode() {
      return 'default';
    },
    ragentGetSelectedSessionFolder() {
      return '/workspace';
    },
  },
  isDesktop: true,
  closeSidebarFn() {},
  preferredTool: 'codex',
  selectedTool: 'codex',
  selectedModel: 'gpt-5.5',
  toolsList: [{ id: 'codex' }],
  localStorage: {
    getItem() { return null; },
    setItem() {},
  },
  getCurrentSession() {
    return {
      id: 'session_1',
      tool: 'codex',
      providerProfile: 'codex-current',
      model: 'gpt-5.5',
    };
  },
  selectedCustomWorkspaceFolder: '',
  WORKSPACE_MODE_CUSTOM: 'custom',
  DEFAULT_APP_ID: 'default',
  DEFAULT_WEB_SOURCE_NAME: 'Web',
  switchTab() {},
  dispatchAction(payload) {
    createdSessionPayload = payload;
    return payload;
  },
};
createSessionContext.globalThis = createSessionContext;
vm.runInNewContext(extractFunctionSource(sidebarUiSource, 'createNewSessionShortcut'), createSessionContext, {
  filename: 'static/chat/sidebar-ui.js',
});
createSessionContext.createNewSessionShortcut();
assert.equal(createdSessionPayload?.interactionMode, undefined, 'a new conversation should not inherit plan mode from another session');
assert.equal(createdSessionPayload?.tool, 'codex', 'a new conversation should reuse the last runtime tool');
assert.equal(createdSessionPayload?.providerProfile, 'codex-current', 'a new conversation should reuse the last Provider');
assert.equal(createdSessionPayload?.model, 'gpt-5.5', 'a new conversation should reuse the last model');

console.log('test-chat-composer-plan-mode: ok');
