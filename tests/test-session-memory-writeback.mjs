#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const previousHome = process.env.HOME;
const previousWritebackSetting = process.env.RAGENT_MEMORY_WRITEBACK;
const previousMinCharsSetting = process.env.RAGENT_MEMORY_WRITEBACK_MIN_CHARS;
const previousCooldownSetting = process.env.RAGENT_MEMORY_WRITEBACK_COOLDOWN_MS;

const tempHome = await mkdtemp(join(tmpdir(), 'ragent-memory-writeback-'));
process.env.HOME = tempHome;

const { maybeRunMemoryWriteback } = await import('../chat/session-memory-writeback.mjs');

let promptCalls = 0;
let lastPrompt = '';
const runPrompt = async (prompt) => {
  promptCalls += 1;
  lastPrompt = prompt;
  return `<hide>{"shouldWrite":true,"learnings":[{"category":"workflow","content":"User prefers compact audit summaries.","layer":"user"}]}</hide>`;
};

delete process.env.RAGENT_MEMORY_WRITEBACK;
const defaultResult = await maybeRunMemoryWriteback({
  sessionId: 'sess_memory_default',
  session: { name: 'Memory audit', group: 'Testing' },
  run: { id: 'run_default' },
  userMessage: 'Remember that I prefer short summaries for this kind of audit.',
  assistantTurnText: 'This is a sufficiently long assistant message intended to exercise the memory writeback path and confirm that the unset environment variable still allows the reviewer flow to run by default.',
  runPrompt,
});
assert.deepEqual(defaultResult, { attempted: false, written: false }, 'memory writeback must be opt-in so normal turns never launch a hidden provider');

process.env.RAGENT_MEMORY_WRITEBACK = 'on';
const enabledResult = await maybeRunMemoryWriteback({
  sessionId: 'sess_memory_enabled',
  session: { name: 'Memory audit', group: 'Testing' },
  run: { id: 'run_enabled' },
  userMessage: 'Remember that I prefer short summaries for this kind of audit.',
  assistantTurnText: 'This is a sufficiently long assistant message intended to exercise the memory writeback path and confirm that the enabled reviewer flow persists durable learnings.',
  runPrompt,
});
assert.equal(enabledResult.attempted, true, 'memory writeback should attempt review only after explicit enablement');
const persistedResult = enabledResult;
assert.equal(persistedResult.written, true, 'memory writeback should persist learnings when the reviewer approves them');
assert.equal(persistedResult.promotedCount, 1, 'memory writeback should promote new learnings into a durable memory file');
assert.deepEqual(
  persistedResult.promotedFiles,
  [join(tempHome, '.ragent', 'memory', 'model-context', 'auto-user-memory.md')],
  'memory writeback should report the durable file it updated',
);
assert.equal(promptCalls, 1, 'memory writeback should invoke the reviewer prompt only when enabled');
assert.match(lastPrompt, /Available memory targets:/, 'writeback prompt should now expose candidate memory targets');
assert.match(lastPrompt, /user_preferences \| user \| ~\/\.ragent\/memory\/model-context\/preferences\.md/, 'prompt should expose specific user memory targets');
assert.match(lastPrompt, /user_auto_memory \| user \| ~\/\.ragent\/memory\/model-context\/auto-user-memory\.md/, 'prompt should keep the auto fallback target');

const auditLog = await readFile(
  join(tempHome, '.ragent', 'memory', 'model-context', 'session-learnings', 'learnings.jsonl'),
  'utf8',
);
assert.match(auditLog, /User prefers compact audit summaries\./);

const userAutoMemory = await readFile(
  join(tempHome, '.ragent', 'memory', 'model-context', 'auto-user-memory.md'),
  'utf8',
);
assert.match(userAutoMemory, /# Auto-Promoted User Memory/);
assert.match(userAutoMemory, /- User prefers compact audit summaries\./);

const duplicateResult = await maybeRunMemoryWriteback({
  sessionId: 'sess_memory_duplicate',
  session: { name: 'Memory audit', group: 'Testing' },
  run: { id: 'run_duplicate' },
  userMessage: 'Repeat the same durable preference.',
  assistantTurnText: 'This is another long assistant message to exercise the same memory writeback path with a duplicate learning payload.',
  runPrompt,
});
assert.equal(duplicateResult.promotedCount, 0, 'duplicate learnings should not be re-appended to the durable memory file');

await mkdir(join(tempHome, '.ragent', 'memory'), { recursive: true });
await writeFile(
  join(tempHome, '.ragent', 'memory', 'writeback-targets.json'),
  `${JSON.stringify({
    extraTargets: [
      {
        id: 'custom_identity',
        path: '~/.ragent/memory/reference/personal/identity.md',
        layer: 'user',
        description: 'Stable identity and personal background facts.',
        categories: ['environment', 'decision'],
      },
    ],
  }, null, 2)}\n`,
  'utf8',
);

const routedResult = await maybeRunMemoryWriteback({
  sessionId: 'sess_memory_routed',
  session: { name: 'Identity memory', group: 'Testing' },
  run: { id: 'run_routed' },
  userMessage: 'Remember that I am building a stable personal profile for repeated self-introductions.',
  assistantTurnText: 'This is a sufficiently long assistant message that should still qualify for memory writeback while explicitly routing the extracted learning into a configured custom memory target.',
  runPrompt: async (prompt) => {
    promptCalls += 1;
    lastPrompt = prompt;
    return `<hide>{"shouldWrite":true,"learnings":[{"category":"environment","content":"The user maintains a stable personal profile for repeated self-introductions.","layer":"user","targetId":"custom_identity"}]}</hide>`;
  },
});
assert.equal(routedResult.promotedCount, 1, 'configured targets should allow routing a learning into a specific user memory file');
assert.deepEqual(
  routedResult.promotedFiles,
  [join(tempHome, '.ragent', 'memory', 'reference', 'personal', 'identity.md')],
  'configured routing should promote learnings into the requested custom target file',
);
assert.match(lastPrompt, /custom_identity \| user \| ~\/\.ragent\/memory\/reference\/personal\/identity\.md/, 'prompt should expose custom configured memory targets');

const routedMemory = await readFile(
  join(tempHome, '.ragent', 'memory', 'reference', 'personal', 'identity.md'),
  'utf8',
);
assert.match(routedMemory, /## Auto-Promoted Learnings/, 'custom targets should receive a dedicated auto-promoted learnings section');
assert.match(routedMemory, /The user maintains a stable personal profile for repeated self-introductions\./);

process.env.RAGENT_MEMORY_WRITEBACK_MIN_CHARS = '800';
const shortTurnResult = await maybeRunMemoryWriteback({
  sessionId: 'sess_memory_short',
  session: { name: 'Short turn', group: 'Testing' },
  run: { id: 'run_short' },
  userMessage: 'A short exchange.',
  assistantTurnText: 'This reply is too short to justify a memory-review model call.',
  runPrompt,
});
assert.equal(shortTurnResult.attempted, false, 'short turns should skip the memory reviewer');
assert.equal(shortTurnResult.skipped, 'assistant_turn_too_short', 'short turns should report the skip reason');

const failedRunResult = await maybeRunMemoryWriteback({
  sessionId: 'sess_memory_failed_run',
  session: { name: 'Failed run', group: 'Testing' },
  run: { id: 'run_failed', state: 'failed' },
  userMessage: 'This turn failed midway.',
  assistantTurnText: 'This is a long assistant message, but the run itself failed so it should never reach the memory reviewer.',
  runPrompt,
});
assert.equal(failedRunResult.attempted, false, 'failed runs should skip the memory reviewer');
assert.equal(failedRunResult.skipped, 'run_not_completed', 'failed runs should report the skip reason');

process.env.RAGENT_MEMORY_WRITEBACK_MIN_CHARS = '10';
process.env.RAGENT_MEMORY_WRITEBACK_COOLDOWN_MS = '60000';
const firstCooldownResult = await maybeRunMemoryWriteback({
  sessionId: 'sess_memory_cooldown',
  session: { name: 'Cooldown session', group: 'Testing' },
  run: { id: 'run_cooldown_1', state: 'completed' },
  userMessage: 'Remember this durable preference.',
  assistantTurnText: 'This is a long enough assistant message to pass the length gate and exercise the cooldown behavior for the same session.',
  runPrompt,
});
assert.equal(firstCooldownResult.attempted, true, 'first writeback for a session should run');
const secondCooldownResult = await maybeRunMemoryWriteback({
  sessionId: 'sess_memory_cooldown',
  session: { name: 'Cooldown session', group: 'Testing' },
  run: { id: 'run_cooldown_2', state: 'completed' },
  userMessage: 'Another turn in the same session.',
  assistantTurnText: 'This is another long enough assistant message in the same session that should be suppressed by the writeback cooldown.',
  runPrompt,
});
assert.equal(secondCooldownResult.attempted, false, 'second writeback within the cooldown window should skip');
assert.equal(secondCooldownResult.skipped, 'cooldown', 'cooldown skips should report the reason');

process.env.RAGENT_MEMORY_WRITEBACK = 'off';
const explicitOffResult = await maybeRunMemoryWriteback({
  sessionId: 'sess_memory_disabled',
  session: { name: 'Memory audit', group: 'Testing' },
  run: { id: 'run_disabled' },
  userMessage: 'This should not run the reviewer.',
  assistantTurnText: 'This message is also long enough to qualify, but the feature should stay disabled because the env var explicitly turned it off.',
  runPrompt,
});
assert.deepEqual(explicitOffResult, { attempted: false, written: false }, 'memory writeback should still respect an explicit off setting');
assert.equal(promptCalls, 4, 'explicit off should prevent the reviewer prompt from running');

if (previousWritebackSetting === undefined) delete process.env.RAGENT_MEMORY_WRITEBACK;
else process.env.RAGENT_MEMORY_WRITEBACK = previousWritebackSetting;
if (previousMinCharsSetting === undefined) delete process.env.RAGENT_MEMORY_WRITEBACK_MIN_CHARS;
else process.env.RAGENT_MEMORY_WRITEBACK_MIN_CHARS = previousMinCharsSetting;
if (previousCooldownSetting === undefined) delete process.env.RAGENT_MEMORY_WRITEBACK_COOLDOWN_MS;
else process.env.RAGENT_MEMORY_WRITEBACK_COOLDOWN_MS = previousCooldownSetting;
if (previousHome === undefined) delete process.env.HOME;
else process.env.HOME = previousHome;
await rm(tempHome, { recursive: true, force: true });

console.log('test-session-memory-writeback: ok');
