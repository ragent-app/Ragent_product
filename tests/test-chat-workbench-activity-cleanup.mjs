#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const source = readFileSync(join(repoRoot, 'static', 'chat', 'workbench-inspector.js'), 'utf8');

function extractFunctionSource(sourceText, functionName) {
  const marker = `function ${functionName}`;
  const start = sourceText.indexOf(marker);
  assert.notEqual(start, -1, `${functionName} should exist`);
  const paramsStart = sourceText.indexOf('(', start);
  let paramsDepth = 0;
  let braceStart = -1;
  for (let index = paramsStart; index < sourceText.length; index += 1) {
    const char = sourceText[index];
    if (char === '(') paramsDepth += 1;
    if (char === ')') {
      paramsDepth -= 1;
      if (paramsDepth === 0) {
        braceStart = sourceText.indexOf('{', index);
        break;
      }
    }
  }
  assert.notEqual(braceStart, -1, `${functionName} should have a body`);
  let depth = 0;
  for (let index = braceStart; index < sourceText.length; index += 1) {
    const char = sourceText[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return sourceText.slice(start, index + 1);
    }
  }
  throw new Error(`Unable to extract ${functionName}`);
}

const context = {
  console,
  JSON,
  Map,
  state: {
    events: [],
    session: null,
  },
  getCurrentSessionSafe() {
    return null;
  },
  tr(key) {
    return key;
  },
  escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  },
};
context.globalThis = context;
context.root = context;

const functionNames = [
  'getWorkbenchEventNoiseText',
  'isProviderUsageLimitStatusPart',
  'isProviderUsageLimitStatusText',
  'isProviderUsageLimitStatusEvent',
  'isCodexAppServerLifecycleStatusText',
  'isCodexAppServerLifecycleStatusEvent',
  'isLowValueWorkbenchEvent',
  'compactWorkbenchActivityItems',
  'parseToolInput',
  'parseFileEdit',
  'computeLineDiff',
  'summarizeEditDiff',
  'getShortPath',
  'getFileNameFromPath',
  'normalizeSessionReferenceId',
  'normalizeSessionReferenceTitle',
  'readDelegatedSessionReference',
  'readFileChangeType',
  'normalizeFileChangeType',
  'getChangeLabel',
  'readFileChangeNumber',
  'getFileChangeStats',
  'hasReviewableDiffStats',
  'normalizeDiffPreviewType',
  'readDiffPreviewLine',
  'readFileChangePreview',
  'countDiffPreviewLines',
  'shouldIncludeFileChangeInReview',
  'normalizePlanItemStatus',
  'normalizePlanArtifactItems',
  'getPlanArtifactState',
  'getPlanArtifactTitle',
  'isPlanProgressArtifact',
  'formatPlanArtifactText',
  'collectPlanArtifacts',
  'isProductLocalArtifactUrl',
  'resolveProductPath',
  'resolveArtifactUrl',
  'resolveLegacyAttachmentUrl',
  'resolveArtifactAttachmentUrl',
  'isMarkdownMimeType',
  'isMarkdownArtifactName',
  'collectArtifacts',
  'collectArtifactFiles',
  'summarizeToolInput',
  'normalizeEvents',
  'buildInspectorModel',
  'orderArtifactsForDisplay',
  'getPlanArtifactSummary',
  'getPlanProgressArtifactSummary',
  'renderPlanArtifact',
];

vm.runInNewContext(
  [
    'const FILE_EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);',
    'const MAX_ACTIVITY_ITEMS = 10;',
    'const MAX_DIFF_PREVIEW_LINES = 80;',
    ...functionNames.map((name) => extractFunctionSource(source, name)),
    'globalThis.isLowValueWorkbenchEvent = isLowValueWorkbenchEvent;',
    'globalThis.compactWorkbenchActivityItems = compactWorkbenchActivityItems;',
    'globalThis.getFileChangeStats = getFileChangeStats;',
    'globalThis.hasReviewableDiffStats = hasReviewableDiffStats;',
    'globalThis.shouldIncludeFileChangeInReview = shouldIncludeFileChangeInReview;',
    'globalThis.collectPlanArtifacts = collectPlanArtifacts;',
    'globalThis.buildInspectorModel = buildInspectorModel;',
    'globalThis.orderArtifactsForDisplay = orderArtifactsForDisplay;',
    'globalThis.renderPlanArtifact = renderPlanArtifact;',
  ].join('\n\n'),
  context,
  { filename: 'static/chat/workbench-inspector.js' },
);

assert.equal(
  context.isLowValueWorkbenchEvent({ type: 'tool_use', toolName: 'System', content: 'thinking_tokens: 1024' }),
  true,
  'thinking token system events should be hidden by default',
);
assert.equal(
  context.isLowValueWorkbenchEvent({ type: 'status', content: 'thinking' }),
  true,
  'plain thinking status should be hidden by default',
);
assert.equal(
  context.isLowValueWorkbenchEvent({ type: 'status', content: 'Assistant self-check: kept the latest reply as-is.' }),
  true,
  'background reply self-check status should be hidden by default',
);
assert.equal(
  context.isLowValueWorkbenchEvent({
    type: 'context_operation',
    operation: 'continue_turn',
    trigger: 'automatic',
    title: 'Automatic continuation not needed',
  }),
  true,
  'background reply self-check operations should be hidden by default',
);
assert.equal(
  context.isLowValueWorkbenchEvent({
    type: 'context_operation',
    operation: 'write_memory',
    title: 'Durable memory updated',
  }),
  true,
  'automatic memory writeback operations should be hidden by default',
);
assert.equal(
  context.isLowValueWorkbenchEvent({
    type: 'status',
    content: 'Usage GPT-5.3-Codex-Spark · primary 0% / 300m · secondary 0% / 10080m · no credits',
    codexRateLimits: { limitName: 'GPT-5.3-Codex-Spark' },
  }),
  true,
  'provider usage-limit status rows should be hidden by default',
);
assert.equal(
  context.isLowValueWorkbenchEvent({
    type: 'status',
    content: 'Thread ready (019ef911-42e4-79e2-a8bd-b936c7393343)',
    runtimeFamily: 'codex-app-server-json',
  }),
  true,
  'Codex app-server lifecycle status rows should be hidden by default',
);
assert.equal(
  context.isLowValueWorkbenchEvent({ type: 'tool_use', toolName: 'Edit', toolInput: '{"file_path":"x"}' }),
  false,
  'real tool activity should stay visible',
);

const compacted = context.compactWorkbenchActivityItems([
  { type: 'tool', title: 'Edit', subtitle: 'static/chat/ui.js', seq: 4 },
  { type: 'tool', title: 'Edit', subtitle: 'static/chat/ui.js', seq: 8 },
  { type: 'file', title: 'static/chat/ui.js', subtitle: 'edited', seq: 6 },
]);

assert.equal(compacted.length, 2, 'matching activity entries should be grouped');
assert.equal(compacted[0].title, 'Edit', 'latest grouped activity should sort first');
assert.equal(compacted[0].count, 2, 'grouped activity should expose a count');

context.state.events = [
  {
    type: 'context_operation',
    operation: 'delegate_session',
    phase: 'applied',
    trigger: 'delegation',
    targetSessionId: 'child-1',
    targetSessionName: 'Child workflow',
    targetSessionFolder: '/tmp/ragent-child',
    reason: 'Handle the focused child task.',
    seq: 12,
  },
];
const delegatedModel = context.buildInspectorModel();
assert.equal(delegatedModel.activity.length, 1, 'delegated session events should render as audit activity');
assert.equal(delegatedModel.activity[0].type, 'session', 'delegated session activity should be typed as a session reference');
assert.equal(delegatedModel.activity[0].sessionId, 'child-1', 'delegated session activity should keep the child session id');
assert.equal(delegatedModel.activity[0].folder, '/tmp/ragent-child', 'delegated session activity should keep the child workspace folder');

const normalizedStats = context.getFileChangeStats({ additions: 3, deletions: 1 });
assert.equal(normalizedStats.added, 3, 'file change stats should normalize common addition field names');
assert.equal(normalizedStats.removed, 1, 'file change stats should normalize common deletion field names');
assert.equal(
  context.hasReviewableDiffStats({ added: 0, removed: 0, preview: [] }),
  false,
  'zero-stat tool edit summaries should not be reviewable',
);
assert.equal(
  context.hasReviewableDiffStats({ added: 0, removed: 0, preview: [{ type: 'add', text: 'x' }] }),
  true,
  'diff previews should make tool edit summaries reviewable',
);
assert.equal(
  context.shouldIncludeFileChangeInReview({ type: 'file_change', filePath: 'x', changeType: 'update' }, null),
  true,
  'zero-stat file change events should still create a review entry with unknown stats',
);
assert.equal(
  context.shouldIncludeFileChangeInReview({ type: 'file_change', filePath: 'x', changeType: 'update', added: 2 }, null),
  true,
  'file change events with line stats should be reviewable',
);
assert.equal(
  context.shouldIncludeFileChangeInReview({ type: 'file_change', filePath: 'x', changeType: 'delete' }, null),
  true,
  'structural file changes without line stats should still be visible in Review',
);
assert.equal(
  context.shouldIncludeFileChangeInReview({ type: 'file_change', filePath: 'x', changeType: 'update' }, { filePath: 'x' }),
  true,
  'file change events should preserve previous zero-stat edit-derived review entries as unknown',
);
assert.equal(
  context.shouldIncludeFileChangeInReview(
    { type: 'file_change', filePath: 'x', changeType: 'update' },
    { filePath: 'x', added: 1, removed: 0, preview: [] },
  ),
  true,
  'file change events should still refresh existing reviewable edit-derived entries',
);

context.state.events = [
  {
    seq: 1,
    type: 'tool_use',
    toolName: 'Write',
    toolInput: JSON.stringify({ file_path: '/tmp/empty.js' }),
  },
  {
    seq: 2,
    type: 'file_change',
    filePath: '/tmp/empty.js',
    changeType: 'add',
  },
];
let model = context.buildInspectorModel();
assert.equal(model.files.length, 1, 'zero-stat tool edits followed by no-stat file_change should still appear in Review');
assert.equal(model.files[0].hasLineStats, false, 'zero-stat review entries should be marked as unknown stats');
assert.equal(model.activity.find((item) => item.type === 'edit')?.hasLineStats, false, 'zero-stat tool edits should remain unknown in activity');

context.state.events = [
  {
    seq: 1,
    type: 'tool_use',
    toolName: 'Edit',
    toolInput: JSON.stringify({
      file_path: '/tmp/real.js',
      old_string: 'one\ntwo',
      new_string: 'one\nTWO\nthree',
    }),
  },
  {
    seq: 2,
    type: 'file_change',
    filePath: '/tmp/real.js',
    changeType: 'update',
  },
];
model = context.buildInspectorModel();
assert.equal(model.files.length, 1, 'real tool edits should still appear in Review when followed by no-stat file_change');
assert.equal(model.files[0].added, 2, 'real tool edit added count should be preserved');
assert.equal(model.files[0].removed, 1, 'real tool edit removed count should be preserved');
assert.equal(model.files[0].hasLineStats, true, 'real tool edit should mark the review entry as having line stats');

context.state.events = [
  {
    seq: 1,
    type: 'file_change',
    filePath: '/tmp/provider.js',
    changeType: 'update',
    added: 3,
    removed: 1,
  },
];
model = context.buildInspectorModel();
assert.equal(model.files.length, 1, 'provider file_change events with stats should appear in Review');
assert.equal(model.files[0].added, 3, 'provider added line stats should be preserved in Review');
assert.equal(model.files[0].removed, 1, 'provider removed line stats should be preserved in Review');
assert.equal(model.files[0].hasLineStats, true, 'provider file_change stats should mark the review entry as having line stats');

context.state.events = [
  {
    seq: 1,
    type: 'file_change',
    filePath: '/tmp/provider-preview.js',
    changeType: 'update',
    added: 1,
    preview: [{ type: 'add', text: 'next', newLine: 12 }],
  },
];
model = context.buildInspectorModel();
assert.equal(model.files.length, 1, 'provider file_change preview events should appear in Review');
assert.equal(model.files[0].preview.length, 1, 'provider file_change previews should be preserved for expandable Review details');
assert.equal(model.files[0].preview[0].type, 'add', 'provider preview should preserve diff line type');
assert.equal(model.files[0].preview[0].text, 'next', 'provider preview should preserve diff line text');
assert.equal(model.files[0].preview[0].newLine, 12, 'provider preview should preserve diff line number');

context.state.events = [
  {
    seq: 1,
    type: 'plan',
    planId: 'plan-artifact-test',
    title: 'Implementation plan',
    state: 'running',
    items: [
      { text: 'Inspect', status: 'completed' },
      { text: 'Patch', status: 'in_progress' },
    ],
    runId: 'run-plan-1',
    source: 'codex',
    interactionMode: 'agent',
    planIntent: 'progress',
  },
  {
    seq: 2,
    type: 'plan',
    planId: 'plan-artifact-test',
    title: 'Implementation plan',
    state: 'completed',
    items: [
      { text: 'Inspect', status: 'completed' },
      { text: 'Patch', status: 'completed' },
    ],
    runId: 'run-plan-1',
    source: 'codex',
    interactionMode: 'agent',
    planIntent: 'progress',
  },
];
model = context.buildInspectorModel();
assert.equal(model.artifacts.length, 1, 'plan events should appear as Workbench artifacts');
assert.equal(model.artifacts[0].kind, 'plan', 'plan artifacts should be typed separately from file artifacts');
assert.equal(model.artifacts[0].planId, 'plan-artifact-test', 'plan artifacts should preserve the provider plan id');
assert.equal(model.artifacts[0].state, 'completed', 'latest plan event should replace older plan artifact versions');
assert.equal(model.artifacts[0].planIntent, 'progress', 'plan artifacts should preserve progress intent');
assert.match(model.artifacts[0].text, /Patch/, 'plan artifact text should include executable steps');
assert.equal(model.artifactFiles.length, 0, 'plan artifacts should not appear in the Workbench Files tab');

const progressMarkup = context.renderPlanArtifact(model.artifacts[0]);
assert.match(progressMarkup, /<details[^>]+workbench-plan-progress/, 'agent progress should render as a collapsed details summary');
assert.doesNotMatch(progressMarkup, /data-plan-artifact-action/, 'agent progress should not expose plan actions');
assert.match(progressMarkup, /plan\.progress\.label/, 'agent progress should use the compact progress label');

const proposalArtifact = {
  ...model.artifacts[0],
  planId: 'proposal-artifact-test',
  planIntent: 'proposal',
  interactionMode: 'plan',
};
const proposalMarkup = context.renderPlanArtifact(proposalArtifact);
assert.match(proposalMarkup, /data-plan-artifact-action="revise"/, 'formal plans should retain revise actions');
assert.match(proposalMarkup, /data-plan-artifact-action="execute"/, 'formal plans should retain execute actions');

const orderedArtifacts = context.orderArtifactsForDisplay([
  model.artifacts[0],
  { kind: 'file', name: 'report.md' },
  proposalArtifact,
]);
assert.equal(orderedArtifacts.at(-1).planIntent, 'progress', 'agent progress should stay at the bottom of the result list');

context.state.events = [
  {
    seq: 1,
    type: 'message',
    role: 'assistant',
    attachments: [
      {
        assetId: 'fasset_1234567890abcdef12345678',
        originalName: 'mobile-report.md',
        mimeType: 'text/plain; charset=utf-8',
        sizeBytes: 128,
      },
      {
        assetId: 'fasset_abcdefabcdefabcdefabcdef',
        originalName: 'notes.txt',
        mimeType: 'text/markdown; charset=utf-8',
      },
    ],
  },
];
model = context.buildInspectorModel();
assert.equal(model.artifacts.length, 0, 'file attachments should move out of the Workbench outcome artifacts list');
assert.equal(model.artifactFiles.length, 2, 'assistant result attachments should appear in the Workbench Files tab');
assert.equal(model.artifactFiles[0].isMarkdown, true, 'md extension files should be marked for the Markdown reader');
assert.equal(model.artifactFiles[0].url, '/api/assets/fasset_1234567890abcdef12345678/download', 'md asset files should keep the stable asset source URL');
assert.equal(model.artifactFiles[1].isMarkdown, true, 'text/markdown files should be marked for the Markdown reader');

context.state.events = [
  {
    seq: 1,
    type: 'message',
    role: 'user',
    attachments: [
      {
        filename: '90b1a89ac7703d6c3bd6f56f.pdf',
        savedPath: '/srv/ragent-promoted-data/config/images/90b1a89ac7703d6c3bd6f56f.pdf',
        originalName: 'uploaded-notes.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 4096,
      },
    ],
  },
];
model = context.buildInspectorModel();
assert.equal(model.artifacts.length, 0, 'uploaded files should not appear in the Workbench outcome artifacts list');
assert.equal(model.artifactFiles.length, 1, 'uploaded files should appear in the Workbench Files tab');
assert.equal(model.artifactFiles[0].isPdf, true, 'uploaded PDFs should be marked readable');
assert.equal(model.artifactFiles[0].url, '/api/images/90b1a89ac7703d6c3bd6f56f.pdf', 'legacy uploaded files should resolve to the stable image/media route');

console.log('test-chat-workbench-activity-cleanup: ok');
