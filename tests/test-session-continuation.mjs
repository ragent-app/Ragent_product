#!/usr/bin/env node
import assert from 'assert/strict';

const {
  prepareSessionContinuationBody,
  buildSessionContinuationContextFromBody,
} = await import('../chat/session-continuation.mjs');

const defaultContext = buildSessionContinuationContextFromBody('[User]\ncontinue');
assert.match(defaultContext, /Ragent session continuity handoff for this existing conversation/);

const switchedContext = buildSessionContinuationContextFromBody('[User]\ncontinue', {
  fromTool: 'claude',
  toTool: 'codex',
});
assert.match(switchedContext, /Ragent session continuity handoff: the user switched tools from claude to codex/);

const attachmentBody = prepareSessionContinuationBody([
  {
    type: 'message',
    role: 'user',
    content: 'Please keep using the uploaded file.',
    images: [{
      filename: 'abc123.csv',
      originalName: 'report.csv',
      savedPath: '/tmp/agentoc/report-abc123.csv',
      mimeType: 'text/csv',
    }],
  },
]);
assert.match(attachmentBody, /\[Attached files: report\.csv -> \/tmp\/agentoc\/report-abc123\.csv\]/);

const fileChangeBody = prepareSessionContinuationBody([
  {
    type: 'file_change',
    filePath: '/tmp/agentoc/chat/session-continuation.mjs',
    changeType: {
      type: 'update',
      move_path: null,
    },
  },
]);
assert.match(fileChangeBody, /\[File change: update\] \/tmp\/agentoc\/chat\/session-continuation\.mjs/);

const planBody = prepareSessionContinuationBody([
  {
    type: 'plan',
    planId: 'plan-context-test',
    title: 'Approved implementation plan',
    state: 'awaiting_decision',
    revision: 2,
    source: 'codex',
    bodyMarkdown: '# Approved implementation plan\n\nPatch the context handoff paths.',
    items: [
      { text: 'Inspect the plan event shape', status: 'completed' },
      { step: 'Patch continuation and compaction formatters', state: 'in_progress' },
      'Run focused regression tests',
    ],
  },
]);
assert.match(planBody, /\[Plan artifact: Approved implementation plan\]/);
assert.match(planBody, /Plan id: plan-context-test/);
assert.match(planBody, /State: awaiting_decision/);
assert.match(planBody, /Revision: 2/);
assert.match(planBody, /# Approved implementation plan/);
assert.match(planBody, /- \[completed\] Inspect the plan event shape/);
assert.match(planBody, /- \[in_progress\] Patch continuation and compaction formatters/);
assert.match(planBody, /- \[pending\] Run focused regression tests/);

console.log('test-session-continuation: ok');
