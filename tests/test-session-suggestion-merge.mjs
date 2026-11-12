#!/usr/bin/env node
// DS-04 merged session suggestion slot: task-card and workflow-state for the
// same session join one queued suggestion unit per window (no infinite
// alternation), each kind's result is routed back to its caller, and a second
// pair of triggers within the throttle window is skipped without any new LLM
// call. Uses the fake-codex tool pattern from test-operation-ledger.mjs.
import assert from 'assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tempHome = mkdtempSync(join(tmpdir(), 'agentoc-suggestion-merge-'));
const integrationHome = join(tempHome, 'integration');
const tempBin = join(integrationHome, 'bin');
const configDir = join(tempHome, '.config', 'agentoc');
const ledgerDir = join(configDir, 'usage-ledger');
const operationLedgerDir = join(ledgerDir, 'operations');

mkdirSync(tempBin, { recursive: true });
mkdirSync(configDir, { recursive: true });

process.env.HOME = tempHome;
process.env.AGENTOC_CONFIG_DIR = configDir;
process.env.AGENTOC_USAGE_LEDGER_DIR = ledgerDir;
process.env.AGENTOC_OPERATION_LEDGER_DIR = operationLedgerDir;

const fakeCodexPath = join(tempBin, 'fake-codex');
writeFileSync(
  fakeCodexPath,
  `#!/usr/bin/env node
const prompt = process.argv[process.argv.length - 1] || '';
const isWorkflowPrompt = prompt.includes('You are updating Ragent workflow state for a developer session.');
const isTaskCardPrompt = prompt.includes('You are updating backend-owned task memory for a Ragent session.');
let text = 'fallback';
if (isWorkflowPrompt) {
  text = JSON.stringify({
    shouldSetWorkflowState: true,
    workflowState: 'waiting_user',
    workflowPriority: 'high',
    reason: 'merge test: waiting for user approval',
  });
} else if (isTaskCardPrompt) {
  text = JSON.stringify({
    mode: 'task',
    summary: 'Merge suggestion test summary.',
    goal: 'Prove one queued suggestion unit per session window.',
    background: ['Test session.'],
    rawMaterials: [],
    assumptions: [],
    knownConclusions: [],
    reusablePatterns: [],
    nextSteps: [],
    memory: [],
    needsFromUser: [],
  });
}
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'merge-thread' }));
console.log(JSON.stringify({ type: 'turn.started' }));
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
process.exit(0);
`,
  'utf8',
);
chmodSync(fakeCodexPath, 0o755);

writeFileSync(
  join(configDir, 'tools.json'),
  JSON.stringify([
    {
      id: 'fake-codex',
      name: 'Fake Codex',
      command: 'fake-codex',
      runtimeFamily: 'codex-app-server-json',
      models: [{ id: 'fake-model', label: 'Fake model' }],
    },
  ], null, 2),
  'utf8',
);

process.env.PATH = `${tempBin}:${process.env.PATH}`;

const operationLedger = await import(
  pathToFileURL(join(repoRoot, 'chat', 'operation-ledger.mjs')).href
);
const { createSession, killAll } = await import(
  pathToFileURL(join(repoRoot, 'chat', 'session-manager.mjs')).href
);
const { appendEvent } = await import(pathToFileURL(join(repoRoot, 'chat', 'history.mjs')).href);
const { messageEvent } = await import(pathToFileURL(join(repoRoot, 'chat', 'normalizer.mjs')).href);
const { triggerSessionTaskCardSuggestion, triggerSessionWorkflowStateSuggestion } = await import(
  pathToFileURL(join(repoRoot, 'chat', 'summarizer.mjs')).href
);

async function readLedgerEvents() {
  await operationLedger.closeOperationLedger();
  const files = readdirSync(operationLedgerDir).filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name));
  const events = [];
  for (const name of files.sort()) {
    for (const line of readFileSync(join(operationLedgerDir, name), 'utf8').trim().split('\n')) {
      if (!line.trim()) continue;
      events.push(JSON.parse(line));
    }
  }
  return events;
}

const eventCount = (events, predicate) => events.filter(predicate).length;

let scenario = 0;
function checkpoint() {
  scenario += 1;
  return scenario;
}

try {
  await operationLedger.initOperationLedger();

  const session = await createSession(integrationHome, 'fake-codex', '');
  await appendEvent(session.id, messageEvent('user', 'Merge test: please keep this short.'));
  await appendEvent(session.id, messageEvent('assistant', 'I will continue with the merge test.'));

  const sessionMeta = {
    id: session.id,
    folder: integrationHome,
    name: session.name,
    group: '',
    description: '',
    workflowState: '',
    workflowPriority: '',
    runState: 'completed',
    queuedCount: 0,
    sourceName: '',
    taskCard: null,
    tool: 'fake-codex',
    model: 'fake-model',
  };

  // 1. Both kinds triggered back-to-back for the same session: the second
  // trigger joins the open slot while the first entry is still queued, so the
  // pair runs as ONE merged queued suggestion, and each caller gets its own
  // kind's result.
  {
    // Fire both synchronously (no await in between) so the task-card trigger
    // joins the slot before the merged unit's run-time kinds snapshot.
    const workflowPromise = triggerSessionWorkflowStateSuggestion(sessionMeta);
    const taskCardPromise = triggerSessionTaskCardSuggestion(sessionMeta);
    const workflowResult = await workflowPromise;
    const taskCardResult = await taskCardPromise;
    assert.equal(workflowResult.ok, true, 'workflow-state suggestion should succeed');
    assert.equal(workflowResult.workflowState, 'waiting_user');
    assert.equal(workflowResult.workflowPriority, 'high');
    assert.equal(taskCardResult.ok, true, 'task-card suggestion should succeed');
    assert.equal(taskCardResult.taskCard?.mode, 'task');
    assert.match(String(taskCardResult.taskCard?.goal || ''), /one queued suggestion/i,
      'task-card result must be routed back to the task-card caller');
    checkpoint();
  }

  // 2. Ledger shows one unit per kind under a shared session_suggestion
  // operation: exactly one started event per kind, no duplicated alternation.
  {
    const events = await readLedgerEvents();
    const perKind = (operation) => ({
      started: eventCount(events, (e) => e.operation === operation && e.kind === 'started' && e.provider === 'fake-codex'),
      succeeded: eventCount(events, (e) => e.operation === operation && e.kind === 'succeeded' && e.provider === 'fake-codex'),
    });
    const workflow = perKind('workflow_state_suggestion');
    const taskCard = perKind('task_card_suggestion');
    assert.deepEqual(workflow, { started: 1, succeeded: 1 }, 'workflow-state kind must run exactly once');
    assert.deepEqual(taskCard, { started: 1, succeeded: 1 }, 'task-card kind must run exactly once');
    const unitStarts = events.filter((e) => e.operation === 'session_suggestion' && e.kind === 'started' && e.provider === 'fake-codex');
    assert.equal(unitStarts.length, 1,
      `back-to-back kinds must merge into exactly one queued suggestion, got ${unitStarts.length}`);
    for (const unit of unitStarts) {
      assert.equal(unit.sessionId, session.id);
      assert.equal(unit.provider, 'fake-codex');
      assert.equal(unit.model, 'fake-model');
      assert.match(unit.operationId, /^op_session_suggestion_/);
    }
    const unitSucceeded = events.filter((e) => e.operation === 'session_suggestion' && e.kind === 'succeeded' && e.provider === 'fake-codex');
    assert.equal(unitSucceeded.length, unitStarts.length, 'each merged unit settles with a succeeded event');
    checkpoint();
  }

  // 3. Alternation guard: a second pair of triggers within the 5-minute
  // throttle window is skipped per-kind and produces zero new LLM calls.
  {
    const eventsBefore = await readLedgerEvents();
    const startedBefore = eventCount(eventsBefore, (e) => e.provider === 'fake-codex' && e.kind === 'started');
    const throttledWorkflow = await triggerSessionWorkflowStateSuggestion(sessionMeta);
    const throttledTaskCard = await triggerSessionTaskCardSuggestion(sessionMeta);
    assert.equal(throttledWorkflow.ok, false);
    assert.equal(throttledWorkflow.throttled, true, 'workflow-state must be throttled');
    assert.equal(throttledTaskCard.ok, false);
    assert.equal(throttledTaskCard.throttled, true, 'task-card must be throttled');
    assert.equal(throttledTaskCard.taskCard, null, 'throttled task-card caller must receive its kind placeholder');
    const eventsAfter = await readLedgerEvents();
    const startedAfter = eventCount(eventsAfter, (e) => e.provider === 'fake-codex' && e.kind === 'started');
    assert.equal(startedAfter, startedBefore, 'throttled pair must not spawn any new LLM call');
    const throttledSkips = eventsAfter.filter((e) => e.kind === 'skipped' && e.stage === 'gate' && e.reason === 'throttled' && e.provider === 'fake-codex');
    assert.equal(throttledSkips.length, 2, 'both kinds must record a gate skip for the throttled pair');
    checkpoint();
  }

  killAll();
  console.log(`test-session-suggestion-merge: ok (${scenario} scenarios)`);
} finally {
  killAll();
  await operationLedger.closeOperationLedger();
  rmSync(tempHome, { recursive: true, force: true });
}
