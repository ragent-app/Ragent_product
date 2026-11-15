#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tempHome = mkdtempSync(join(tmpdir(), 'ragent-plan-fallback-'));
const tempBin = join(tempHome, 'bin');
const configDir = join(tempHome, '.config', 'ragent');
const memoryDir = join(tempHome, '.ragent', 'memory');
const workDir = join(tempHome, '.ragent', 'workspace');

mkdirSync(tempBin, { recursive: true });
mkdirSync(configDir, { recursive: true });
mkdirSync(memoryDir, { recursive: true });
mkdirSync(workDir, { recursive: true });

const fakeCodexPath = join(tempBin, 'fake-codex');
writeFileSync(
  fakeCodexPath,
  `#!/usr/bin/env node
const plan = [
  '# Plain Markdown Plan',
  '',
  '1. Inspect current behavior',
  '2. Patch fallback plan rendering',
  '3. Verify the standalone plan UI',
].join('\\n');

console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-plan-fallback' }));
console.log(JSON.stringify({ type: 'turn.started' }));
console.log(JSON.stringify({
  type: 'item.completed',
  item: {
    id: 'progress-plan-fallback',
    type: 'todo_list',
    items: [
      { text: 'Inspect current behavior', completed: true },
      { text: 'Patch fallback plan rendering', completed: false },
    ],
  },
}));
console.log(JSON.stringify({
  type: 'item.completed',
  item: {
    id: 'message-plan-fallback',
    type: 'agent_message',
    text: plan,
  },
}));
console.log(JSON.stringify({
  type: 'turn.completed',
  usage: { input_tokens: 1, output_tokens: 1 },
}));
setTimeout(() => process.exit(0), 20);
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

process.env.HOME = tempHome;
process.env.RAGENT_CONFIG_DIR = configDir;
process.env.RAGENT_MEMORY_DIR = memoryDir;
process.env.RAGENT_WORK_ROOT_DIR = workDir;
process.env.RAGENT_DISABLE_SYSTEMD_DETACHED_RUNNER = '1';
process.env.PATH = `${tempBin}:${process.env.PATH}`;
process.env.RAGENT_REPLY_SELF_CHECK = 'off';

const sessionManager = await import(
  pathToFileURL(join(repoRoot, 'chat', 'session-manager.mjs')).href
);
const displayEvents = await import(
  pathToFileURL(join(repoRoot, 'chat', 'session-display-events.mjs')).href
);

const {
  createSession,
  getHistory,
  getSession,
  getSessionTimelineEvents,
  killAll,
  sendMessage,
  submitPlanAction,
} = sessionManager;
const { buildSessionDisplayEvents } = displayEvents;

async function waitFor(predicate, description, timeoutMs = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out: ${description}`);
}

try {
  const session = await createSession(tempHome, 'fake-codex', 'Plan Fallback Artifact', {
    group: 'Ragent',
    description: 'Verify plain markdown Plan Mode replies become plan artifacts.',
    internalRole: 'test_plan_fallback',
  });

  await sendMessage(session.id, '请先给一个普通 markdown 方案，不要使用 todo_list。', [], {
    tool: 'fake-codex',
    model: 'fake-model',
    effort: 'low',
    interactionMode: 'plan',
  });

  await waitFor(
    async () => (await getSession(session.id))?.activity?.run?.state === 'idle',
    'plan fallback session should become idle',
  );

  const history = await getHistory(session.id);
  const assistantMessage = history.find((event) =>
    event.type === 'message'
    && event.role === 'assistant'
    && (event.content || '').includes('Plain Markdown Plan'));
  assert.ok(assistantMessage, 'history should retain the original assistant markdown message');

  const nativeProgressPlan = history.find((event) =>
    event.type === 'plan'
    && event.source === 'codex'
    && event.runId === assistantMessage.runId);
  assert.ok(nativeProgressPlan, 'native update_plan progress should remain in durable history');
  assert.equal(nativeProgressPlan.bodyMarkdown, undefined);

  const fallbackPlan = history.find((event) =>
    event.type === 'plan'
    && event.source === 'ragent-plan-fallback'
    && event.runId === assistantMessage.runId);
  assert.ok(fallbackPlan, 'plan mode markdown replies should create a fallback plan artifact');
  assert.equal(fallbackPlan.sourceMessageSeq, assistantMessage.seq);
  assert.equal(fallbackPlan.state, 'awaiting_decision');
  assert.match(fallbackPlan.bodyMarkdown, /Patch fallback plan rendering/);

  const timeline = buildSessionDisplayEvents(await getSessionTimelineEvents(session.id), {
    sessionRunning: false,
  });
  assert.equal(
    timeline.some((event) =>
      event.type === 'message'
      && event.role === 'assistant'
      && (event.content || '').includes('Plain Markdown Plan')),
    false,
    'timeline should not duplicate the source assistant markdown when a fallback plan card exists',
  );
  assert.ok(
    timeline.some((event) =>
      event.type === 'plan'
      && event.planId === fallbackPlan.planId
      && event.source === 'ragent-plan-fallback'),
    'timeline should expose the fallback plan as a standalone plan event',
  );

  const reviseOutcome = await submitPlanAction(session.id, fallbackPlan.planId, {
    action: 'revise',
    text: '请修改这个方案。',
    tool: 'fake-codex',
    model: 'fake-model',
    effort: 'low',
  });
  assert.ok(reviseOutcome.run?.id, 'plan revise action should start a run');

  await waitFor(
    async () => (await getSession(session.id))?.activity?.run?.state === 'idle',
    'plan revise fallback session should become idle',
  );

  const revisedHistory = await getHistory(session.id);
  const revisedFallbackPlan = revisedHistory.find((event) =>
    event.type === 'plan'
    && event.source === 'ragent-plan-fallback'
    && event.runId === reviseOutcome.run.id);
  assert.ok(revisedFallbackPlan, 'plan revise markdown replies should create a new fallback plan artifact');
  assert.equal(
    revisedFallbackPlan.previousPlanId,
    fallbackPlan.planId,
    'revised fallback plans should point back to the plan being revised',
  );
  assert.ok(
    revisedHistory.some((event) =>
      event.type === 'plan'
      && event.source === 'ragent-plan-action'
      && event.planId === fallbackPlan.planId
      && event.runId === reviseOutcome.run.id
      && event.state === 'superseded'),
    'the plan being revised should still be marked superseded even though a new fallback plan is created',
  );

  console.log('test-plan-fallback-artifact: ok');
} finally {
  await killAll();
  rmSync(tempHome, { recursive: true, force: true });
}
