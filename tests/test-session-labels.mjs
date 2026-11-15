#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  applyAssistantSessionLabelsToSession,
  claimPendingSessionTitleForRun,
  buildSessionLabelsPromptBlock,
  parseSessionLabelsFromAssistantContent,
} from '../chat/session-labels.mjs';

const prompt = buildSessionLabelsPromptBlock({
  name: '分析会话标题生成机制',
  autoRenamePending: true,
}, {
  knownGroups: ['Ragent', 'Ragent', '视频工作流'],
});
assert.match(prompt, /Session presentation metadata \(hidden protocol\)/);
assert.match(prompt, /<ragent-session-labels>/);
assert.match(prompt, /user's language/);
assert.match(prompt, /For English requests, write the title, group, and description in English/);
assert.match(prompt, /Existing reusable groups: "Ragent", "视频工作流"/);

assert.equal(
  buildSessionLabelsPromptBlock({
    name: 'Stable title',
    autoRenamePending: false,
    group: 'Ragent',
    description: 'Improve session naming.',
  }),
  '',
  'complete labels should not add prompt overhead to later turns',
);

assert.match(
  buildSessionLabelsPromptBlock({
    name: 'Stable title',
    autoRenamePending: false,
  }),
  /missing grouping metadata/,
  'an explicit title may still fill missing group metadata without being renamed',
);

const parsed = parseSessionLabelsFromAssistantContent([
  'Visible final answer.',
  '<ragent-session-labels>{"schemaVersion":1,"title":"Ragent 标题机制修复","group":"Ragent","description":"修复会话标题生成与持久化链路。"}</ragent-session-labels>',
].join('\n'));
assert.deepEqual(parsed, {
  schemaVersion: 1,
  title: '标题机制修复',
  group: 'Ragent',
  description: '修复会话标题生成与持久化链路。',
});

assert.equal(
  parseSessionLabelsFromAssistantContent('<ragent-session-labels>{bad json}</ragent-session-labels>'),
  null,
  'malformed metadata should fail closed',
);
assert.equal(
  parseSessionLabelsFromAssistantContent('<ragent-session-labels>{"schemaVersion":2,"title":"Future"}</ragent-session-labels>'),
  null,
  'unknown schema versions should not mutate session metadata',
);

const pendingSession = {
  name: 'Fix the naming flow…',
  autoRenamePending: true,
  titleAnchorRunId: 'run-1',
};
assert.equal(applyAssistantSessionLabelsToSession(pendingSession, parsed, {
  runId: 'run-1',
  now: '2026-09-08T00:00:00.000Z',
}), true);
assert.equal(pendingSession.name, '标题机制修复');
assert.equal(pendingSession.autoRenamePending, false);
assert.equal(pendingSession.titleSource, 'assistant');
assert.equal(pendingSession.group, 'Ragent');

const manuallyRenamed = {
  name: 'Owner title',
  autoRenamePending: false,
  titleSource: 'user',
  group: 'Owner group',
};
assert.equal(applyAssistantSessionLabelsToSession(manuallyRenamed, parsed, {
  runId: 'run-1',
  now: '2026-09-08T00:00:00.000Z',
}), true, 'a missing description can still be filled');
assert.equal(manuallyRenamed.name, 'Owner title', 'assistant metadata must not overwrite a manual rename');
assert.equal(manuallyRenamed.group, 'Owner group', 'assistant metadata must not overwrite manual grouping');
assert.equal(manuallyRenamed.description, '修复会话标题生成与持久化链路。');

const newerRunSession = {
  name: 'Newer provisional title',
  autoRenamePending: true,
  titleAnchorRunId: 'run-2',
  group: 'Existing group',
  description: 'Existing description.',
};
assert.equal(applyAssistantSessionLabelsToSession(newerRunSession, parsed, {
  runId: 'run-1',
  now: '2026-09-08T00:00:00.000Z',
}), false, 'stale Run metadata should lose the compare-and-set race');
assert.equal(newerRunSession.name, 'Newer provisional title');

const retrySession = { name: 'new session', autoRenamePending: true };
assert.equal(claimPendingSessionTitleForRun(retrySession, 'first', 'Prepare the weekly report', 't1'), true);
assert.equal(retrySession.name, 'Prepare the weekly report');
assert.equal(claimPendingSessionTitleForRun(retrySession, 'second', '', 't2'), true);
assert.equal(applyAssistantSessionLabelsToSession(retrySession, parsed, { runId: 'first' }), false);
assert.equal(applyAssistantSessionLabelsToSession(retrySession, parsed, { runId: 'second' }), true);
assert.equal(retrySession.autoRenamePending, false);
assert.equal(claimPendingSessionTitleForRun(manuallyRenamed, 'third', 'Another request'), false);
assert.equal(manuallyRenamed.name, 'Owner title');

console.log('test-session-labels: ok');
