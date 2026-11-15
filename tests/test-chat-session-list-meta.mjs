#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const sessionSurfaceUiSource = readFileSync(join(repoRoot, 'static', 'chat', 'session-surface-ui.js'), 'utf8');

function extractFunctionSource(source, functionName) {
  const marker = `function ${functionName}`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${functionName} should exist`);
  const paramsStart = source.indexOf('(', start);
  assert.notEqual(paramsStart, -1, `${functionName} should have parameters`);
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
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }
  throw new Error(`Unable to extract ${functionName}`);
}

const getSessionStatusItemClassSource = extractFunctionSource(sessionSurfaceUiSource, 'getSessionStatusItemClass');
const getSessionRunStateItemClassSource = extractFunctionSource(sessionSurfaceUiSource, 'getSessionRunStateItemClass');
const getSessionListIndicatorInfoSource = extractFunctionSource(sessionSurfaceUiSource, 'getSessionListIndicatorInfo');
const createActiveSessionItemSource = extractFunctionSource(sessionSurfaceUiSource, 'createActiveSessionItem');

const context = {
  console,
  t(key) {
    if (key === 'status.running') return 'running';
    if (key === 'workflow.status.unread') return 'new';
    return key;
  },
  getSessionStatusSummary() {
    return { primary: { key: 'running', label: 'running', title: 'Session is running' } };
  },
  getSessionReviewStatusInfo(session) {
    return session?.unread
      ? { key: 'unread', label: 'new', title: 'Updated since last review' }
      : null;
  },
  RagentSessionStateModel: {
    normalizeSessionActivity(session) {
      const running = session?.activity?.run?.state === 'running';
      return {
        run: { state: running ? 'running' : 'idle' },
      };
    },
  },
};
context.globalThis = context;
vm.runInNewContext(
  `${getSessionStatusItemClassSource}\n${getSessionRunStateItemClassSource}\n${getSessionListIndicatorInfoSource}\nglobalThis.getSessionStatusItemClass = getSessionStatusItemClass;\nglobalThis.getSessionRunStateItemClass = getSessionRunStateItemClass;\nglobalThis.getSessionListIndicatorInfo = getSessionListIndicatorInfo;`,
  context,
  { filename: 'static/chat/session-surface-ui.js' },
);

assert.equal(
  context.getSessionStatusItemClass({ key: 'waiting_user' }),
  'session-status-waiting_user',
  'session list items should keep compact status classes for compatibility',
);
assert.equal(
  context.getSessionStatusItemClass({ key: 'idle' }),
  '',
  'idle sessions should not receive a mobile status accent class',
);
assert.equal(
  context.getSessionRunStateItemClass({ activity: { run: { state: 'running' } } }),
  'session-is-running',
  'running sessions should keep the run-state class for compatibility',
);
assert.equal(
  context.getSessionRunStateItemClass({ activity: { run: { state: 'idle' } }, workflowState: 'done' }),
  '',
  'non-running sessions should not receive the run-state class',
);
assert.equal(
  JSON.stringify(context.getSessionListIndicatorInfo({ activity: { run: { state: 'running' } }, unread: true })),
  JSON.stringify({
    className: 'session-item-status--running',
    label: 'running',
    title: 'Session is running',
  }),
  'running sessions should show the right-side spinner, taking priority over unread state',
);
assert.equal(
  JSON.stringify(context.getSessionListIndicatorInfo({ activity: { run: { state: 'idle' } }, unread: true })),
  JSON.stringify({
    className: 'session-item-status--unread',
    label: 'new',
    title: 'Updated since last review',
  }),
  'unread sessions should show the right-side blue dot',
);
assert.equal(
  context.getSessionListIndicatorInfo({ activity: { run: { state: 'idle' } }, unread: false }),
  null,
  'idle reviewed sessions should not render a status indicator',
);
assert.match(
  createActiveSessionItemSource,
  /class="session-item-name"[\s\S]*\$\{esc\(displayName\)\}/,
  'session list item should render the session name',
);
assert.match(
  createActiveSessionItemSource,
  /createElement\("button"\)/,
  'session list items should use native button semantics',
);
assert.doesNotMatch(
  createActiveSessionItemSource,
  /<div class="session-item-info">/,
  'native session buttons should not contain non-phrasing div children',
);
assert.match(
  createActiveSessionItemSource,
  /session-item-status/,
  'session list item should render a single right-side status slot when needed',
);
assert.match(
  createActiveSessionItemSource,
  /session-item-time|formatSessionUpdatedTime/,
  'session list item should support a compact same-row updated time without a subtitle',
);
assert.doesNotMatch(
  createActiveSessionItemSource,
  /buildSessionMetaParts|session-item-meta|session-pin-badge|session-group-tag|session-item-count|session-source-tag|session-priority-tag|session-child-tag/,
  'active session list items should not render metadata, pins, source tags, priority tags, child tags, group tags, or counts',
);

console.log('test-chat-session-list-meta: ok');
