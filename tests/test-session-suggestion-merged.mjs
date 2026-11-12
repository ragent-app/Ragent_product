#!/usr/bin/env node
// DS-05 merged suggestion: after a completed turn, task-card and
// workflow-state suggestions coalesce into ONE model call. The fake provider
// logs every prompt kind it sees, so the test can prove both writebacks came
// from a single merged call, and that the legacy per-kind triggers still work
// when AGENTOC_SUGGESTION_MERGED=off.
import assert from 'assert/strict';
import { appendFileSync, chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tempHome = mkdtempSync(join(tmpdir(), 'agentoc-suggestion-merged-'));
const tempBin = join(tempHome, 'bin');
const configDir = join(tempHome, '.config', 'agentoc');
const callLogPath = join(tempHome, 'fake-call-log.jsonl');

mkdirSync(tempBin, { recursive: true });
mkdirSync(configDir, { recursive: true });

const fakeCodexPath = join(tempBin, 'fake-codex');
writeFileSync(
  fakeCodexPath,
  `#!/usr/bin/env node
const { appendFileSync } = require('fs');
const prompt = process.argv[process.argv.length - 1] || '';
const logPath = process.env.FAKE_CALL_LOG;

function log(kind) {
  if (logPath) appendFileSync(logPath, JSON.stringify({ kind }) + '\\n');
}

const isMerged = prompt.includes('You are updating Ragent backend session memory after a completed turn.');
const isLegacyTaskCard = prompt.includes('You are updating backend-owned task memory for a Ragent session.');
const isLegacyWorkflow = prompt.includes('You are updating Ragent workflow state for a developer session.');

let text = '我先继续推进。';
if (isMerged) {
  log('merged');
  const hasTaskCardRequest = prompt.includes('MERGED_WITH_CARD_CASE');
  text = JSON.stringify({
    taskCard: hasTaskCardRequest ? {
      mode: 'task',
      summary: 'DS-05 合并建议单次调用验证。',
      goal: '验证单次调用同时更新卡片与状态。',
      nextSteps: ['检查测试输出'],
    } : null,
    workflowState: 'done',
    workflowPriority: 'low',
    shouldSetWorkflowState: true,
    nextAction: '查看测试报告。',
    confidence: 0.9,
    reason: '请求已交付且无残留阻塞。',
  });
} else if (isLegacyTaskCard) {
  log('legacy-task-card');
  text = JSON.stringify({
    mode: 'task',
    summary: '旧路径单独触发验证。',
    goal: '验证旧 API 兼容。',
    nextSteps: ['检查旧路径输出'],
  });
} else if (isLegacyWorkflow) {
  log('legacy-workflow');
  text = JSON.stringify({
    shouldSetWorkflowState: true,
    workflowState: 'waiting_user',
    workflowPriority: 'high',
    reason: 'legacy 单独触发验证',
  });
}

console.log(JSON.stringify({ type: 'thread.started', thread_id: 'suggestion-thread' }));
console.log(JSON.stringify({ type: 'turn.started' }));
console.log(JSON.stringify({
  type: 'item.completed',
  item: { type: 'agent_message', text },
}));
console.log(JSON.stringify({
  type: 'turn.completed',
  usage: { input_tokens: 1, output_tokens: 1 },
}));
process.exit(0);
`,
  'utf8',
);
chmodSync(fakeCodexPath, 0o755);

writeFileSync(
  join(configDir, 'tools.json'),
  JSON.stringify(
    [
      {
        id: 'fake-codex',
        name: 'Fake Codex',
        command: 'fake-codex',
        runtimeFamily: 'codex-json',
        models: [{ id: 'fake-model', label: 'Fake model' }],
        reasoning: {
          kind: 'enum',
          label: 'Reasoning',
          levels: ['low'],
          default: 'low',
        },
      },
    ],
    null,
    2,
  ),
  'utf8',
);

const previousMergedSetting = process.env.AGENTOC_SUGGESTION_MERGED;
process.env.HOME = tempHome;
process.env.PATH = `${tempBin}:${process.env.PATH}`;
process.env.FAKE_CALL_LOG = callLogPath;

const sessionManager = await import(pathToFileURL(join(repoRoot, 'chat', 'session-manager.mjs')).href);
const {
  createSession,
  getSession,
  sendMessage,
  killAll,
} = sessionManager;

function readCallLog() {
  try {
    return readFileSync(callLogPath, 'utf8').trim().split('\n').filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function countKind(kind) {
  return readCallLog().filter((entry) => entry.kind === kind).length;
}

async function waitFor(predicate, description, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out: ${description}`);
}

try {
  // Phase A: merged mode (default) — both schedulers fire in one turn, but
  // exactly ONE merged model call updates task card AND workflow state.
  const mergedSession = await createSession(tempHome, 'fake-codex', 'Merged Case');
  await sendMessage(mergedSession.id, 'MERGED_WITH_CARD_CASE 这个请求已经交付完了，请更新后台建议。', [], {
    tool: 'fake-codex',
    model: 'fake-model',
    effort: 'low',
  });

  await waitFor(
    async () => (await getSession(mergedSession.id))?.activity?.run?.state === 'idle',
    'merged session should finish running',
  );
  await waitFor(
    async () => (await getSession(mergedSession.id))?.taskCard?.summary === 'DS-05 合并建议单次调用验证。',
    'merged suggestion should write the task card',
  );
  await waitFor(
    async () => (await getSession(mergedSession.id))?.workflowState === 'done',
    'merged suggestion should write the workflow state',
  );
  const merged = await getSession(mergedSession.id);
  assert.equal(merged?.workflowPriority, 'low');

  // The two schedulers coalesced: exactly one model call in this turn.
  assert.equal(countKind('merged'), 1, 'merged mode must use exactly one model call per turn');
  assert.equal(countKind('legacy-task-card'), 0, 'merged mode must not call the legacy task-card trigger');
  assert.equal(countKind('legacy-workflow'), 0, 'merged mode must not call the legacy workflow trigger');

  // Phase B: legacy mode (AGENTOC_SUGGESTION_MERGED=off) — the old separate
  // triggers still update each part independently.
  process.env.AGENTOC_SUGGESTION_MERGED = 'off';
  const legacySession = await createSession(tempHome, 'fake-codex', 'Legacy Case');
  await sendMessage(legacySession.id, 'LEGACY_CASE 旧路径单独触发，验证兼容。', [], {
    tool: 'fake-codex',
    model: 'fake-model',
    effort: 'low',
  });

  await waitFor(
    async () => (await getSession(legacySession.id))?.activity?.run?.state === 'idle',
    'legacy session should finish running',
  );
  await waitFor(
    async () => (await getSession(legacySession.id))?.taskCard?.summary === '旧路径单独触发验证。',
    'legacy task-card trigger should write the task card',
  );
  await waitFor(
    async () => (await getSession(legacySession.id))?.workflowState === 'waiting_user',
    'legacy workflow trigger should write the workflow state',
  );
  const legacy = await getSession(legacySession.id);
  assert.equal(legacy?.workflowPriority, 'high');
  assert.equal(countKind('merged'), 1, 'legacy mode must not add merged calls');
  assert.equal(countKind('legacy-task-card'), 1, 'legacy task-card trigger should have run once');
  assert.equal(countKind('legacy-workflow'), 1, 'legacy workflow trigger should have run once');

  console.log('test-session-suggestion-merged: ok');
} finally {
  if (previousMergedSetting === undefined) delete process.env.AGENTOC_SUGGESTION_MERGED;
  else process.env.AGENTOC_SUGGESTION_MERGED = previousMergedSetting;
  killAll();
  rmSync(tempHome, { recursive: true, force: true });
}
