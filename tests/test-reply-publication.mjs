#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tempHome = mkdtempSync(join(tmpdir(), 'agentoc-reply-publication-'));
const tempBin = join(tempHome, 'bin');
const configDir = join(tempHome, '.config', 'agentoc');
const memoryDir = join(tempHome, '.agentoc', 'memory');
const workDir = join(tempHome, '.agentoc', 'workspace');

mkdirSync(tempBin, { recursive: true });
mkdirSync(configDir, { recursive: true });
mkdirSync(memoryDir, { recursive: true });
mkdirSync(workDir, { recursive: true });

const fakeCodexPath = join(tempBin, 'fake-codex');
writeFileSync(
  fakeCodexPath,
  `#!/usr/bin/env node
const prompt = process.argv[process.argv.length - 1] || '';
const isReplyReviewPrompt = prompt.includes("You are Ragent's hidden end-of-turn completion reviewer.");
const isRepairPrompt = prompt.includes('You are continuing the same user-facing reply after a hidden self-check found an avoidable early stop.');
const isDelayedContinuationScenario = prompt.includes('延迟续写场景');
const isDelayedBlockerScenario = prompt.includes('延迟复核场景');
const outputDelayMs = isReplyReviewPrompt && (isDelayedContinuationScenario || isDelayedBlockerScenario) ? 450 : 0;

let items = [{ type: 'agent_message', text: '我已经分析了机制问题。下一条我可以直接给你那份极短执行守则。' }];

if (prompt.includes('显式计划发布场景')) {
  items = [
    {
      type: 'todo_list',
      id: 'publication-plan',
      title: 'Publication plan',
      items: [
        { completed: true, text: 'inspect reply publication payload' },
        { completed: false, text: 'keep plan display event' },
      ],
    },
    {
      type: 'agent_message',
      text: '计划已生成，请确认后执行。',
    },
  ];
}

if (isDelayedBlockerScenario && !isReplyReviewPrompt && !isRepairPrompt) {
  items = [{ type: 'agent_message', text: '这一步涉及生产数据，在拿到你的确认前我不会继续。' }];
}

if (isReplyReviewPrompt) {
  items = [{
    type: 'agent_message',
    text: '<hide>' + JSON.stringify(
      isDelayedBlockerScenario
        ? {
            action: 'accept',
            reason: '这是明确依赖用户确认的破坏性动作。',
            continuationPrompt: '',
          }
        : {
            action: 'continue',
            reason: '上一条把本轮该直接交付的内容留到了后面。',
            continuationPrompt: '直接把极短执行守则给出来，不要再征求许可。',
          }
    ) + '</hide>',
  }];
}

if (isRepairPrompt) {
  items = [{ type: 'agent_message', text: '极短执行守则：默认先做完再汇报；没有真实阻塞就不要停。' }];
}

function emitTurn() {
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'reply-publication-thread' }));
  console.log(JSON.stringify({ type: 'turn.started' }));
  for (const item of items) {
    console.log(JSON.stringify({ type: 'item.completed', item }));
  }
  console.log(JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 1, output_tokens: 1 },
  }));
  setTimeout(() => process.exit(0), 20);
}

if (outputDelayMs > 0) {
  setTimeout(emitTurn, outputDelayMs);
} else {
  emitTurn();
}
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
process.env.AGENTOC_CONFIG_DIR = configDir;
process.env.AGENTOC_MEMORY_DIR = memoryDir;
process.env.AGENTOC_WORK_ROOT_DIR = workDir;
process.env.AGENTOC_DISABLE_SYSTEMD_DETACHED_RUNNER = '1';
process.env.AGENTOC_MEMORY_WRITEBACK = 'off';
process.env.PATH = `${tempBin}:${process.env.PATH}`;

const sessionManager = await import(
  pathToFileURL(join(repoRoot, 'chat', 'session-manager.mjs')).href
);

const {
  createSession,
  getRunState,
  getSessionReplyPublication,
  killAll,
  sendMessage,
  updateSessionGoal,
} = sessionManager;

// Reply self-check only fires inside goal-chasing sessions; the continuation
// and blocker scenarios here exercise the reviewer path, so those sessions
// start in chasing mode. The plan scenario is gated off by interactionMode
// regardless, but stays chasing for consistency.
async function createChasingSession(name, description, objective = 'Reply publication goal') {
  const created = await createSession(
    tempHome,
    'fake-codex',
    name,
    testSessionMeta(description),
  );
  await updateSessionGoal(created.id, {
    objective,
    enabled: true,
    chasing: true,
    tokenBudget: 200000,
  });
  return created;
}

async function waitFor(predicate, description, timeoutMs = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function testSessionMeta(description) {
  return {
    group: 'AgentoC',
    description,
  };
}

async function waitForRootRunId(sessionId, responseId, description) {
  let rootRunId = '';
  await waitFor(async () => {
    const publication = await getSessionReplyPublication(sessionId, responseId);
    rootRunId = trimString(publication?.rootRunId);
    return !!rootRunId;
  }, description);
  return rootRunId;
}

try {
  const continuationSession = await createChasingSession(
    'Reply Publication Continuation',
    'Exercise auto-continued reply publication state.',
  );

  const continuationOutcome = await sendMessage(
    continuationSession.id,
    '延迟续写场景：先分析问题，再把极短执行守则真的给出来。',
    [],
    { tool: 'fake-codex', model: 'fake-model', effort: 'low' },
  );

  const continuationResponseId = continuationOutcome.response?.id;
  assert.ok(continuationResponseId, 'continuation scenario should return a response id');
  const continuationRunId = continuationOutcome.run?.id
    || await waitForRootRunId(
      continuationSession.id,
      continuationResponseId,
      'continuation response to materialize a root run',
    );
  assert.ok(continuationRunId, 'continuation scenario should resolve a root run id');

  await waitFor(
    async () => (await getRunState(continuationRunId))?.state === 'completed',
    'continuation root run to complete',
  );

  await waitFor(
    async () => {
      const publication = await getSessionReplyPublication(continuationSession.id, continuationResponseId);
      return ['reviewing', 'continuing'].includes(publication?.state || '');
    },
    'continuation publication to enter reviewing/continuing before the final reply is ready',
  );

  const continuationDuringReview = await getSessionReplyPublication(continuationSession.id, continuationResponseId);
  assert.ok(
    ['reviewing', 'continuing'].includes(continuationDuringReview?.state),
    'continuation publication should stay in reviewing/continuing before the final reply is ready',
  );

  await waitFor(
    async () => (await getSessionReplyPublication(continuationSession.id, continuationResponseId))?.state === 'ready',
    'continuation publication to become ready',
  );

  const continuationFinal = await getSessionReplyPublication(continuationSession.id, continuationResponseId);
  assert.equal(continuationFinal?.resolution, 'auto_continued');
  assert.notEqual(continuationFinal?.finalRunId, continuationRunId, 'continuation should finish on a repair run');
  assert.match(String(continuationFinal?.payload?.text || ''), /极短执行守则：/, 'final payload should include the continued reply');
  assert.match(String(continuationFinal?.payload?.text || ''), /我已经分析了机制问题/, 'final payload should preserve the visible original reply');

  const blockerSession = await createChasingSession(
    'Reply Publication Blocker',
    'Exercise accepted blocker reply publication state.',
  );

  const blockerOutcome = await sendMessage(
    blockerSession.id,
    '延迟复核场景：这是明确依赖用户确认的破坏性动作，先停下来等我确认。',
    [],
    { tool: 'fake-codex', model: 'fake-model', effort: 'low' },
  );

  const blockerResponseId = blockerOutcome.response?.id;
  assert.ok(blockerResponseId, 'blocker scenario should return a response id');
  const blockerRunId = blockerOutcome.run?.id
    || await waitForRootRunId(
      blockerSession.id,
      blockerResponseId,
      'blocker response to materialize a root run',
    );
  assert.ok(blockerRunId, 'blocker scenario should resolve a root run id');

  await waitFor(
    async () => (await getRunState(blockerRunId))?.state === 'completed',
    'blocker root run to complete',
  );

  await waitFor(
    async () => (await getSessionReplyPublication(blockerSession.id, blockerResponseId))?.state === 'reviewing',
    'blocker publication to enter reviewing',
  );

  await waitFor(
    async () => (await getSessionReplyPublication(blockerSession.id, blockerResponseId))?.state === 'ready',
    'blocker publication to become ready',
  );

  const blockerFinal = await getSessionReplyPublication(blockerSession.id, blockerResponseId);
  assert.equal(blockerFinal?.resolution, 'accepted_as_is');
  assert.equal(blockerFinal?.finalRunId, blockerRunId);
  assert.equal(
    blockerFinal?.payload?.text,
    '这一步涉及生产数据，在拿到你的确认前我不会继续。',
    'accepted publication should keep the original assistant reply as the final payload',
  );

  const planSession = await createChasingSession(
    'Reply Publication Plan',
    'Exercise plan card reply publication display events.',
  );

  const planOutcome = await sendMessage(
    planSession.id,
    '显式计划发布场景：先给一个需要确认的计划。',
    [],
    {
      tool: 'fake-codex',
      model: 'fake-model',
      effort: 'low',
      interactionMode: 'plan',
    },
  );

  const planResponseId = planOutcome.response?.id;
  assert.ok(planResponseId, 'plan scenario should return a response id');
  const planRunId = planOutcome.run?.id
    || await waitForRootRunId(
      planSession.id,
      planResponseId,
      'plan response to materialize a root run',
    );
  assert.ok(planRunId, 'plan scenario should resolve a root run id');

  await waitFor(
    async () => (await getRunState(planRunId))?.state === 'completed',
    'plan root run to complete',
  );

  await waitFor(
    async () => (await getSessionReplyPublication(planSession.id, planResponseId))?.state === 'ready',
    'plan publication to become ready',
  );

  const planFinal = await getSessionReplyPublication(planSession.id, planResponseId);
  const planDisplayEvents = planFinal?.payload?.displayEvents || [];
  assert.ok(
    planDisplayEvents.some((event) =>
      event.type === 'plan'
      && event.planId === 'publication-plan'
      && event.state === 'awaiting_decision'),
    'ready reply publication payload should keep standalone plan display events',
  );
  assert.ok(
    planDisplayEvents.some((event) =>
      event.type === 'message'
      && event.role === 'assistant'
      && /计划已生成/.test(event.content || '')),
    'ready reply publication payload should keep the visible assistant message with the plan',
  );
  assert.equal(
    planFinal?.payload?.text,
    '计划已生成，请确认后执行。',
    'plain text publication payload should not duplicate plan checklist content',
  );
} finally {
  await killAll();
  await new Promise((resolve) => setTimeout(resolve, 1000));
  rmSync(tempHome, { recursive: true, force: true });
}

console.log('test-reply-publication: ok');
