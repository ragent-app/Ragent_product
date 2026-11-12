#!/usr/bin/env node
import assert from 'assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'agentoc-build-prompt-'));
process.env.AGENTOC_INSTANCE_ROOT = path.join(tempHome, 'instance');
if (process.platform === 'win32') {
  process.env.USERPROFILE = tempHome;
  process.env.LOCALAPPDATA = path.join(tempHome, 'AppData', 'Local');
  process.env.APPDATA = path.join(tempHome, 'AppData', 'Roaming');
}
process.env.AGENTOC_PUBLIC_BASE_URL = '';

const { TOOLS_FILE } = await import('../lib/config.mjs');
await fs.mkdir(path.dirname(TOOLS_FILE), { recursive: true });
await fs.writeFile(
  TOOLS_FILE,
  `${JSON.stringify([
    {
      id: 'micro-agent',
      name: 'Micro Agent',
      command: process.execPath,
      runtimeFamily: 'codex-json',
      promptMode: 'bare-user',
      flattenPrompt: true,
      models: [{ id: 'gpt-5.4', label: 'gpt-5.4' }],
      reasoning: { kind: 'none', label: 'Thinking' },
    },
    {
      id: 'micro-agent-custom',
      name: 'Micro Agent Custom',
      toolProfile: 'micro-agent',
      command: process.execPath,
      runtimeFamily: 'claude-stream-json',
      promptMode: 'bare-user',
      flattenPrompt: true,
      models: [{ id: 'gpt-5.4', label: 'gpt-5.4' }],
      reasoning: { kind: 'none', label: 'Thinking' },
    },
  ], null, 2)}\n`,
  'utf8',
);

const {
  buildPrompt,
  buildPromptEnvelope,
  resolveResumeState,
} = await import('../chat/session-manager.mjs');
const { appendEvent } = await import('../chat/history.mjs');
const { defaultContinuityStore } = await import('../chat/continuity-store.mjs');
const { reduceContinuityEvents } = await import('../chat/continuity-core.mjs');

const baseSession = {
  systemPrompt: '',
  visitorId: '',
  claudeSessionId: null,
  codexThreadId: null,
  activeAgreements: [
    '默认用自然连贯的段落表达，不要自己起标题和列表。',
    'Agent 更像执行器，Manager 负责统一任务语义和边界。',
  ],
};

const freshPrompt = await buildPrompt(
  'session-test-1',
  baseSession,
  '聊一下产品方向。',
  'codex',
  'codex',
  null,
  { skipSessionContinuation: true },
);

assert.match(freshPrompt, /<private>[\s\S]*lightweight external context hook/);
assert.match(freshPrompt, /User message:/);
assert.match(freshPrompt, /do not mirror its headings, bullets, or checklist structure back to the user/);
assert.match(freshPrompt, /active working agreements/);
assert.match(freshPrompt, /默认用自然连贯的段落表达，不要自己起标题和列表/);
assert.match(freshPrompt, /Stable context entry points:/);
const portablePrompt = freshPrompt.replaceAll('\\', '/');
assert.match(portablePrompt, /Projects: .*\/memory\/projects\.md/);
assert.match(portablePrompt, /Memory writeback targets config: .*\/memory\/writeback-targets\.json/);
assert.match(portablePrompt, /Auto user memory: .*\/memory\/model-context\/auto-user-memory\.md/);
assert.match(portablePrompt, /Auto system memory: .*\/memory\/auto-system-memory\.md/);
assert.match(freshPrompt, /Model-managed writable context root:/);
assert.match(portablePrompt, /\/memory\/model-context/);
assert.match(freshPrompt, /The host is an execution surface; do not assume whether the user can access it locally/);
assert.match(freshPrompt, /use only connectors and delivery channels actually authorized for this session/);
assert.doesNotMatch(freshPrompt, /Subscription link \(webcal\): webcal:\/\/127\.0\.0\.1:/);
assert.doesNotMatch(freshPrompt, /Subscription link \(https\): http:\/\/127\.0\.0\.1:/);
assert.match(freshPrompt, /Session presentation metadata \(hidden protocol\)/);

for (const runtime of [
  ['claude', 'claude-stream-json-bidi'],
  ['claude', 'claude-stream-json'],
  ['codex', 'codex-app-server-json'],
  ['codex-cli', 'codex-json'],
  ['agy', 'agy-stream-json'],
  ['pi', 'pi-rpc-jsonl'],
  ['deepseek-harness', 'deepseek-harness-acp'],
  ['qwen-code', 'qwen-code-acp'],
  ['opencode', 'opencode-json'],
  ['kimi-code', 'kimi-code-acp'],
  ['goose', 'goose-headless'],
  ['openhands', 'openhands-headless'],
  ['copilot', 'copilot-json'],
  ['hermes', 'hermes-acp'],
  ['cline', 'cline-json'],
  ['kilo', 'kilo-json'],
]) {
  const [tool, runtimeFamily] = runtime;
  const envelope = await buildPromptEnvelope(
    `session-title-contract-${tool}`,
    { ...baseSession, name: 'new session', autoRenamePending: true },
    'Create a durable title for this task.',
    tool,
    tool,
    null,
    { skipSessionContinuation: true, runtimeFamily },
  );
  assert.ok(
    [envelope.prompt, envelope.developerInstructions, envelope.systemPrefix]
      .some((carrier) => String(carrier || '').includes('<agentoc-session-labels>')),
    `${runtimeFamily} should receive the shared inline session-label contract`,
  );
}

const resumedPrompt = await buildPrompt(
  'session-test-1',
  {
    ...baseSession,
    codexThreadId: 'thread-test-1',
  },
  '继续。',
  'codex',
  'codex',
  null,
  {},
);

assert.match(resumedPrompt, /<private>[\s\S]*lightweight external context hook/);
assert.match(resumedPrompt, /User message:/);
assert.match(resumedPrompt, /Stable context entry points:/);
assert.match(resumedPrompt, /Agent 更像执行器，Manager 负责统一任务语义和边界/);

const codexResumeOptInPrompt = await buildPrompt(
  'session-test-1',
  {
    ...baseSession,
    codexThreadId: 'thread-test-1',
  },
  '继续。',
  'codex',
  'codex',
  null,
  { codexResume: true },
);

assert.match(codexResumeOptInPrompt, /<private>[\s\S]*lightweight external context hook/);
assert.match(codexResumeOptInPrompt, /Current user message:/);
assert.doesNotMatch(codexResumeOptInPrompt, /Memory System — Pointer-First Activation/);
assert.match(resumedPrompt, /Agent 更像执行器，Manager 负责统一任务语义和边界/);

const codexResumeOptInEnvelope = await buildPromptEnvelope(
  'session-test-1',
  {
    ...baseSession,
    codexThreadId: 'thread-test-1',
  },
  '继续。',
  'codex',
  'codex',
  null,
  { codexResume: true, runtimeFamily: 'codex-json' },
);

assert.match(codexResumeOptInEnvelope.prompt, /Current user message:/);
assert.equal(codexResumeOptInEnvelope.metadata.runtimeFamily, 'codex-json');
assert.equal(codexResumeOptInEnvelope.metadata.resumeUsed, true);
assert.equal(codexResumeOptInEnvelope.metadata.contextResumeMode, 'provider_resume');
assert.ok(codexResumeOptInEnvelope.metadata.includedSections.includes('managerTurnContext'));

const copilotResumeState = resolveResumeState('copilot', {
  ...baseSession,
  providerContext: {
    copilot: { resumeId: 'copilot-thread-1', coveredThroughSeq: 3 },
  },
}, {
  runtimeFamily: 'copilot-json',
  runtimeFingerprint: 'copilot-fingerprint',
  instructionRevision: 'copilot-instructions',
});
assert.deepEqual(copilotResumeState, {
  hasResume: true,
  providerKey: 'copilot',
  providerResumeId: 'copilot-thread-1',
  claudeSessionId: null,
  codexThreadId: null,
  agyConversationId: null,
  reason: 'BINDING_MATCHED',
});

const hermesResumeState = resolveResumeState('hermes', {
  ...baseSession,
  providerContext: {
    hermes: { resumeId: 'hermes-session-1', coveredThroughSeq: 3 },
  },
}, { runtimeFamily: 'hermes-acp' });
assert.equal(hermesResumeState.hasResume, true);
assert.equal(hermesResumeState.providerKey, 'hermes');
assert.equal(hermesResumeState.providerResumeId, 'hermes-session-1');

const clineResumeState = resolveResumeState('cline', {
  ...baseSession,
  providerContext: {
    cline: { resumeId: 'cline-session-1', coveredThroughSeq: 3 },
  },
}, { runtimeFamily: 'cline-json' });
assert.equal(clineResumeState.hasResume, true);
assert.equal(clineResumeState.providerKey, 'cline');
assert.equal(clineResumeState.providerResumeId, 'cline-session-1');

const kiloResumeState = resolveResumeState('kilo-code', {
  ...baseSession,
  providerContext: {
    kilo: { resumeId: 'kilo-session-1', coveredThroughSeq: 3 },
  },
}, { runtimeFamily: 'kilo-json' });
assert.equal(kiloResumeState.hasResume, true);
assert.equal(kiloResumeState.providerKey, 'kilo');
assert.equal(kiloResumeState.providerResumeId, 'kilo-session-1');

const checkpointSessionId = 'session-test-checkpoint-envelope';
await appendEvent(checkpointSessionId, {
  type: 'message', role: 'user', content: 'Repair the durable continuity path.',
});
await appendEvent(checkpointSessionId, {
  type: 'status', content: 'ready',
});
await defaultContinuityStore.write(checkpointSessionId, reduceContinuityEvents(checkpointSessionId, [
  { seq: 1, type: 'message', role: 'user', content: 'Repair the durable continuity path.' },
  { seq: 2, type: 'status', content: 'ready' },
]), { expectedRevision: 0 });
const checkpointEnvelope = await buildPromptEnvelope(
  checkpointSessionId,
  { ...baseSession, codexThreadId: 'thread-checkpoint', systemPrompt: 'TEMPLATE_INSTRUCTIONS' },
  'Continue from the checkpoint.',
  'codex',
  'codex',
  null,
  { codexResume: true, runtimeFamily: 'codex-app-server-json' },
);
assert.match(checkpointEnvelope.prompt, /AgentoC continuity checkpoint/);
assert.match(checkpointEnvelope.prompt, /Repair the durable continuity path/);
assert.match(checkpointEnvelope.freshRecoveryPrompt, /AgentoC continuity checkpoint/);
assert.match(checkpointEnvelope.freshRecoveryDeveloperInstructions, /AgentoC system context:/);
assert.match(checkpointEnvelope.freshRecoveryDeveloperInstructions, /TEMPLATE_INSTRUCTIONS/);
assert.equal(checkpointEnvelope.metadata.runtimeContextCompiler, 'runtime-context-compiler-v1');
assert.equal(checkpointEnvelope.metadata.contextPlanMode, 'compatibility-shadow');
assert.equal(checkpointEnvelope.metadata.contextPlan.schemaVersion, 1);

const attentionCheckpointEnvelope = await buildPromptEnvelope(
  checkpointSessionId,
  { ...baseSession, codexThreadId: 'thread-checkpoint', systemPrompt: 'TEMPLATE_INSTRUCTIONS' },
  'Continue from the selected context plan.',
  'codex',
  'codex',
  null,
  { codexResume: true, runtimeFamily: 'codex-app-server-json', useAttentionPlan: true },
);
assert.equal(attentionCheckpointEnvelope.metadata.contextPlanMode, 'attention-v1');
assert.match(attentionCheckpointEnvelope.prompt, /task_goal/);

const longGapSessionId = 'session-test-long-gap-checkpoint';
const longGapEvents = Array.from({ length: 205 }, (_, index) => ({
  seq: index + 1,
  type: 'message',
  role: index === 0 ? 'user' : 'assistant',
  content: index === 0 ? 'Long gap objective.' : `checkpoint fact ${index + 1}`,
}));
for (const event of longGapEvents) {
  await appendEvent(longGapSessionId, event);
}
await defaultContinuityStore.write(longGapSessionId, reduceContinuityEvents(longGapSessionId, longGapEvents), { expectedRevision: 0 });
const longGapEnvelope = await buildPromptEnvelope(
  longGapSessionId,
  {
    ...baseSession,
    codexThreadId: 'thread-long-gap',
    providerContext: { codex: { resumeId: 'thread-long-gap', coveredThroughSeq: 1 } },
  },
  'Continue after the long gap.',
  'codex',
  'codex',
  null,
  { codexResume: true, runtimeFamily: 'codex-app-server-json' },
);
assert.equal(longGapEnvelope.metadata.contextReceipt.coverage.coveredThroughSeq, 205, 'a complete checkpoint may cover a >200 event provider gap');
assert.deepEqual(longGapEnvelope.metadata.contextReceipt.coverage.omittedRanges, [], 'a verified complete checkpoint has no omitted range');

const codexCrossProviderSessionId = 'session-test-cross-provider-codex';
await appendEvent(codexCrossProviderSessionId, {
  type: 'message',
  role: 'assistant',
  content: 'Codex already knew the old packaging status.',
  runId: 'run-old-codex',
});
await appendEvent(codexCrossProviderSessionId, {
  type: 'message',
  role: 'assistant',
  content: 'Claude verified 14.12 live incident: the Deb omits web-push and must be rebuilt.',
  runId: 'run-new-claude',
});
const codexCrossProviderEnvelope = await buildPromptEnvelope(
  codexCrossProviderSessionId,
  {
    ...baseSession,
    codexThreadId: 'thread-codex-cross-provider',
    providerContext: {
      codex: {
        resumeId: 'thread-codex-cross-provider',
        coveredThroughSeq: 1,
      },
    },
  },
  '继续修复打包流程。',
  'claude-bidi',
  'codex',
  null,
  { codexResume: true, runtimeFamily: 'codex-app-server-json' },
);

assert.equal(codexCrossProviderEnvelope.metadata.resumeUsed, true);
assert.equal(codexCrossProviderEnvelope.metadata.contextResumeMode, 'provider_resume');
assert.ok(codexCrossProviderEnvelope.metadata.includedSections.includes('continuationContext'));
assert.ok(codexCrossProviderEnvelope.metadata.charCounts.continuationContext > 0);
assert.match(codexCrossProviderEnvelope.prompt, /Claude verified 14\.12 live incident/);
assert.match(codexCrossProviderEnvelope.prompt, /Deb omits web-push/);
assert.match(codexCrossProviderEnvelope.prompt, /Current user message:/);
assert.doesNotMatch(codexCrossProviderEnvelope.prompt, /Memory System — Pointer-First Activation/);

const claudeCrossProviderSessionId = 'session-test-cross-provider-claude';
await appendEvent(claudeCrossProviderSessionId, {
  type: 'message',
  role: 'assistant',
  content: 'Claude covered this earlier checkpoint.',
  runId: 'run-old-claude',
});
await appendEvent(claudeCrossProviderSessionId, {
  type: 'message',
  role: 'assistant',
  content: 'Codex patched build-deb to validate production dependency files.',
  runId: 'run-new-codex',
});
const claudeCrossProviderEnvelope = await buildPromptEnvelope(
  claudeCrossProviderSessionId,
  {
    ...baseSession,
    claudeSessionId: 'thread-claude-cross-provider',
    providerContext: {
      claude: {
        resumeId: 'thread-claude-cross-provider',
        coveredThroughSeq: 1,
      },
    },
  },
  '核对 Codex 的修复。',
  'codex',
  'claude-bidi',
  null,
  { runtimeFamily: 'claude-stream-json-bidi' },
);

assert.equal(claudeCrossProviderEnvelope.metadata.resumeUsed, true);
assert.equal(claudeCrossProviderEnvelope.metadata.contextResumeMode, 'provider_resume');
assert.ok(claudeCrossProviderEnvelope.metadata.includedSections.includes('continuationContext'));
assert.ok(claudeCrossProviderEnvelope.metadata.charCounts.continuationContext > 0);
assert.match(claudeCrossProviderEnvelope.prompt, /Codex patched build-deb/);
assert.match(claudeCrossProviderEnvelope.prompt, /Current user message:/);

const agyGoalEnvelope = await buildPromptEnvelope(
  'session-test-agy-goal',
  {
    ...baseSession,
    goal: {
      objective: 'Normalize the input files',
      tokenBudget: 5000,
      enabled: true,
    },
  },
  '继续处理输入文件。',
  'agy',
  'agy',
  null,
  { runtimeFamily: 'agy-stream-json' },
);

assert.match(agyGoalEnvelope.prompt, /Active goal.*"Normalize the input files"/);
assert.match(agyGoalEnvelope.prompt, /Token budget: 5000/);
assert.match(agyGoalEnvelope.prompt, /User message:\n继续处理输入文件。/);
assert.equal(agyGoalEnvelope.metadata.includedCarrierBySection.goalInstructions, 'prompt');

const splitPrompt = await buildPrompt(
  'session-test-6',
  baseSession,
  `现在手上都有哪些任务，我觉得需要关注两点：
1. 现在都积压了哪些任务，我们看下接下来做什么
2. 我们的 TODO 记录是标准流程吗，需不需要做一个定型？`,
  'codex',
  'codex',
  null,
  { skipSessionContinuation: true },
);

assert.match(splitPrompt, /lightweight external context hook/);
assert.match(splitPrompt, /Stable context entry points:/);
assert.doesNotMatch(splitPrompt, /Routing principle for this turn/);

const observerSourcePrompt = await buildPrompt(
  'session-test-4',
  {
    ...baseSession,
    sourceId: 'observer',
    sourceName: 'Home Coach',
  },
  'Current task:\nWelcome the user home.',
  'codex',
  'codex',
  null,
  { skipSessionContinuation: true },
);

assert.match(observerSourcePrompt, /Output only the text that should be spoken aloud through the speaker/);

const githubSourcePrompt = await buildPrompt(
  'session-test-5',
  {
    ...baseSession,
    sourceId: 'github',
    sourceName: 'GitHub',
  },
  'Source: GitHub\n\nUser message:\nPlease inspect the failure.',
  'codex',
  'codex',
  null,
  { skipSessionContinuation: true },
);

assert.match(githubSourcePrompt, /Produce plain text or markdown suitable for posting back through GitHub/);

const microAgentPrompt = await buildPrompt(
  'session-test-2',
  baseSession,
  '看一下这个项目的背景。',
  'micro-agent',
  'micro-agent',
  null,
  { skipSessionContinuation: true },
);

assert.equal(microAgentPrompt, '看一下这个项目的背景。');

const promptWithTaskCard = await buildPrompt(
  'session-test-7',
  {
    ...baseSession,
    taskCard: {
      mode: 'project',
      summary: '先吃透用户丢来的 Excel 和 PPT，再决定如何组织项目态。',
      rawMaterials: ['sales.xlsx', 'deck.pptx'],
      reusablePatterns: ['先接住原始材料，再决定是否把经验抽象成流程。'],
      nextSteps: ['检查材料结构', '整理第一版任务摘要'],
      memory: ['用户偏好直接给原始材料，不想先写长说明。'],
    },
  },
  '继续推进。',
  'codex',
  'codex',
  null,
  { skipSessionContinuation: true },
);

assert.match(promptWithTaskCard, /Current carried task card/);
assert.match(promptWithTaskCard, /Execution mode: project/);
assert.match(promptWithTaskCard, /sales\.xlsx/);
assert.match(promptWithTaskCard, /Reusable patterns/);
assert.match(promptWithTaskCard, /Durable user memory/);

const welcomePrompt = await buildPrompt(
  'session-test-8',
  {
    ...baseSession,
    starterPreset: 'welcome',
    systemPrompt: 'WELCOME SYSTEM PROMPT',
  },
  '先帮我接住这个需求。',
  'codex',
  'codex',
  null,
  { skipSessionContinuation: true },
);

assert.match(welcomePrompt, /WELCOME SYSTEM PROMPT/);

const retiredWelcomePrompt = await buildPrompt(
  'session-test-9',
  {
    ...baseSession,
    starterPreset: 'welcome',
    systemPrompt: 'WELCOME SYSTEM PROMPT',
    welcomeOnboardingRetiredAt: '2025-01-01T00:00:00.000Z',
  },
  '继续执行。',
  'codex',
  'codex',
  null,
  { skipSessionContinuation: true },
);

assert.doesNotMatch(retiredWelcomePrompt, /WELCOME SYSTEM PROMPT/);

// --- Regression: bare-user micro-agent with claude-stream-json should include continuation context ---

const { setForkContext } = await import('../chat/history.mjs');
await setForkContext('session-test-bare-user-cont', {
  mode: 'history',
  summary: '',
  continuationBody: '[User]\n记住 13 这个数\n\n[Assistant]\nGot it. 13.',
  activeFromSeq: 0,
  preparedThroughSeq: 0,
  source: 'history',
});

const bareUserContinuationPrompt = await buildPrompt(
  'session-test-bare-user-cont',
  baseSession,
  '刚才是啥',
  'micro-agent-custom',
  'micro-agent-custom',
  null,
  {},
);

assert.match(bareUserContinuationPrompt, /记住 13 这个数/, 'bare-user prompt must include continuation history');
assert.match(bareUserContinuationPrompt, /Got it\. 13\./, 'bare-user prompt must include assistant reply from history');
assert.match(bareUserContinuationPrompt, /刚才是啥/, 'bare-user prompt must include current user message');

console.log('test-session-manager-build-prompt: ok');
