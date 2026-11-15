#!/usr/bin/env node
// DS-03 operation ledger tests: structured events, error classification,
// safe prompt meta, queue integration, usage-ledger association, query
// summary and the 24h CLI script.
import assert from 'assert/strict';
import { spawnSync } from 'child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tempHome = mkdtempSync(join(tmpdir(), 'ragent-operation-ledger-'));
const configDir = join(tempHome, '.config', 'ragent');
const ledgerDir = join(configDir, 'usage-ledger');
const operationLedgerDir = join(ledgerDir, 'operations');

process.env.HOME = tempHome;
process.env.RAGENT_CONFIG_DIR = configDir;
process.env.RAGENT_USAGE_LEDGER_DIR = ledgerDir;
process.env.RAGENT_OPERATION_LEDGER_DIR = operationLedgerDir;

const operationLedger = await import(
  pathToFileURL(join(repoRoot, 'chat', 'operation-ledger.mjs')).href
);
const { createBackgroundAiQueue } = await import(
  pathToFileURL(join(repoRoot, 'chat', 'background-ai-queue.mjs')).href
);
const usageLedger = await import(
  pathToFileURL(join(repoRoot, 'chat', 'usage-ledger.mjs')).href
);

async function readLedgerEvents() {
  // Writes are buffered by the open stream; close it first so the reads see
  // everything (same pattern as test-usage-ledger.mjs).
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

function eventCount(events, predicate) {
  return events.filter(predicate).length;
}

let scenario = 0;
function checkpoint() {
  scenario += 1;
  return scenario;
}

try {
  await operationLedger.initOperationLedger();

  // 1. Safe prompt meta: length + stable hash + truncated preview, never the full text.
  {
    const promptText = 'You are a hidden reviewer. '.repeat(20);
    const meta = operationLedger.buildSafePromptMeta(promptText);
    assert.equal(meta.promptLength, promptText.length);
    assert.match(meta.promptHash, /^[0-9a-f]{12}$/);
    assert.ok(meta.promptPreview.length < promptText.length, 'preview must be truncated');
    assert.ok(!meta.promptPreview.includes('hidden reviewer. hidden reviewer. hidden reviewer. hidden reviewer.'),
      'preview must not contain the full prompt tail');
    const meta2 = operationLedger.buildSafePromptMeta(promptText);
    assert.equal(meta2.promptHash, meta.promptHash, 'hash must be deterministic');
    assert.deepEqual(operationLedger.buildSafePromptMeta(''), { promptLength: 0, promptHash: '', promptPreview: '' });
    checkpoint();
  }

  // 2. Error classification: all eight DS-03 codes.
  {
    const classify = operationLedger.classifyProviderError;
    assert.equal(classify(new Error('401 Unauthorized')), 'auth');
    assert.equal(classify(new Error('403 forbidden: invalid api key')), 'auth');
    assert.equal(classify(new Error('429 Too Many Requests')), 'rate_limit');
    assert.equal(classify(new Error('rate limit exceeded')), 'rate_limit');
    assert.equal(classify(new Error('405 Method Not Allowed')), 'unsupported');
    assert.equal(classify(new Error('unsupported model foo')), 'unsupported');
    assert.equal(classify(new Error('ETIMEDOUT')), 'timeout');
    assert.equal(classify(new Error('deadline exceeded')), 'timeout');
    assert.equal(classify(new Error('ENOTFOUND api.example.com')), 'transport');
    assert.equal(classify(new Error('socket hang up')), 'transport');
    assert.equal(classify(new Error('null byte in input')), 'input');
    assert.equal(classify(new Error('structured summarizer prompt too large (12345 chars)')), 'input');
    assert.equal(classify(new Error('claude exited with code 3')), 'provider_exit');
    assert.equal(classify(1), 'provider_exit');
    assert.equal(classify(0), 'unknown');
    assert.equal(classify(new Error('something else entirely')), 'unknown');
    // ENOENT is transport only in spawn context; file-write ENOENT stays unknown.
    assert.equal(classify(new Error('ENOENT: no such file'), { context: 'spawn' }), 'transport');
    assert.equal(classify(new Error('ENOENT: no such file'), { context: 'file' }), 'unknown');
    checkpoint();
  }

  // 3. beginOperation + recordOperationEvent: events land on disk, full
  // prompt never appears in the ledger file.
  {
    // Marker sits beyond the 120-char preview boundary: the preview may
    // contain the prompt head, but never the tail.
    const secret = `${'x'.repeat(150)}NEVER-LEAK-MARKER${'y'.repeat(500)}`;
    const op = operationLedger.beginOperation({
      operation: 'task_card_suggestion',
      sessionId: 'sess_events',
      provider: 'claude',
      model: 'claude-sonnet',
      promptText: secret,
      attempt: 2,
    });
    assert.match(op.operationId, /^op_task_card_suggestion_\d+_\d+$/);
    assert.equal(op.attempt, 2);
    assert.equal(op.promptLength, secret.length);
    assert.ok(op.promptHash, 'hash present');

    assert.equal(operationLedger.recordOperationEvent({
      kind: 'started',
      operationId: op.operationId,
      operation: op.operation,
      sessionId: op.sessionId,
      provider: op.provider,
      model: op.model,
      attempt: op.attempt,
      ts: new Date().toISOString(),
      stage: 'call',
      promptLength: op.promptLength,
      promptHash: op.promptHash,
      promptPreview: op.promptPreview,
      junkField: 'dropped',
    }), true, 'event should append');

    assert.equal(operationLedger.recordOperationEvent({
      kind: 'succeeded',
      operationId: op.operationId,
      operation: op.operation,
      sessionId: op.sessionId,
      provider: op.provider,
      model: op.model,
      attempt: op.attempt,
      ts: new Date().toISOString(),
      durationMs: 42,
      result: 'ok',
      stage: 'call',
      usageRunId: op.operationId,
      usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.001 },
    }), true, 'terminal event should append');

    assert.equal(operationLedger.recordOperationEvent({ kind: 'bogus', operationId: op.operationId, ts: new Date().toISOString() }), false, 'unknown kind must be rejected');
    assert.equal(operationLedger.recordOperationEvent({ kind: 'started', operationId: '', ts: new Date().toISOString() }), false, 'missing operationId must be rejected');

    const events = await readLedgerEvents();
    assert.equal(eventCount(events, (e) => e.operationId === op.operationId), 2);
    const startedEvent = events.find((e) => e.kind === 'started' && e.operationId === op.operationId);
    assert.equal(startedEvent.operation, 'task_card_suggestion');
    assert.equal(startedEvent.provider, 'claude');
    assert.equal(startedEvent.model, 'claude-sonnet');
    assert.equal(startedEvent.attempt, 2);
    assert.equal(startedEvent.junkField, undefined, 'unknown fields must be dropped');
    const succeededEvent = events.find((e) => e.kind === 'succeeded' && e.operationId === op.operationId);
    assert.equal(succeededEvent.durationMs, 42);
    assert.equal(succeededEvent.usageRunId, op.operationId);
    assert.deepEqual(succeededEvent.usage, { inputTokens: 100, outputTokens: 20, costUsd: 0.001 });

    const rawLedgerText = readdirSync(operationLedgerDir)
      .map((name) => readFileSync(join(operationLedgerDir, name), 'utf8'))
      .join('');
    assert.ok(!rawLedgerText.includes('NEVER-LEAK-MARKER'),
      'prompt text beyond the preview boundary must never be written to the ledger');
    checkpoint();
  }

  // 4. trackBackgroundOperation success / failure / timeout.
  {
    const success = await operationLedger.trackBackgroundOperation({
      operation: 'workflow_state_suggestion',
      sessionId: 'sess_track',
      provider: 'codex',
      model: 'gpt-5.4',
      promptText: 'classify this turn',
      task: async () => ({ ok: true, workflowState: 'done' }),
    });
    assert.equal(success.errorCode, '');
    assert.match(success.operationId, /^op_workflow_state_suggestion_/);
    assert.ok(success.durationMs >= 0);

    const failure = await operationLedger.trackBackgroundOperation({
      operation: 'session_label_suggestion',
      sessionId: 'sess_track',
      provider: 'claude',
      model: 'claude-sonnet',
      task: async () => { throw new Error('401 Unauthorized'); },
    });
    assert.equal(failure.errorCode, 'auth');
    assert.equal(failure.result, null);

    const timeoutResult = await operationLedger.trackBackgroundOperation({
      operation: 'memory_writeback_review',
      sessionId: 'sess_track',
      provider: 'claude',
      timeoutMs: 40,
      task: () => new Promise(() => {}), // never settles
    });
    assert.equal(timeoutResult.timedOut, true, 'timeout should be reported on the result');
    assert.equal(timeoutResult.errorCode, 'timeout', 'timeout result should carry the timeout code');

    const events = await readLedgerEvents();
    assert.equal(eventCount(events, (e) => e.operationId === success.operationId && e.kind === 'succeeded'), 1);
    assert.equal(eventCount(events, (e) => e.operationId === failure.operationId && e.kind === 'failed' && e.errorCode === 'auth'), 1);
    assert.equal(eventCount(events, (e) => e.kind === 'timeout' && e.errorCode === 'timeout'), 1);
    checkpoint();
  }

  // 5. Queue integration: enqueue/started/succeeded + skipped (dedupe,
  // queue_full) events; no events without an operationId (back-compat).
  {
    const queue = createBackgroundAiQueue({ enabled: true, concurrency: 1, delayMs: 0, maxQueue: 2 });
    const optsFor = (op) => ({
      operationId: op.operationId,
      operation: op.operation,
      sessionId: op.sessionId,
      provider: op.provider,
      model: op.model,
      attempt: op.attempt,
    });
    const opA = operationLedger.beginOperation({ operation: 'task_card_suggestion', sessionId: 'sess_queue', provider: 'claude' });
    const opDup = operationLedger.beginOperation({ operation: 'task_card_suggestion', sessionId: 'sess_queue', provider: 'claude' });
    const opBlock = operationLedger.beginOperation({ operation: 'task_card_suggestion', sessionId: 'sess_queue', provider: 'claude' });
    const opFull = operationLedger.beginOperation({ operation: 'task_card_suggestion', sessionId: 'sess_queue', provider: 'claude' });
    const opFull2 = operationLedger.beginOperation({ operation: 'task_card_suggestion', sessionId: 'sess_queue', provider: 'claude' });

    // Dedupe only applies while the key is queued/running — enqueue the
    // duplicate while the first task is still in flight.
    const first = queue.enqueue('queue-op', async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return 'A';
    }, optsFor(opA));
    const duplicate = await queue.enqueue('queue-op', async () => 'B', optsFor(opDup));
    assert.deepEqual(duplicate, { ok: false, skipped: 'dedupe' });
    assert.equal(await first, 'A');

    const blocker = queue.enqueue('blocker', async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return 'blocker-done';
    }, optsFor(opBlock));
    const fullOne = queue.enqueue('full-1', async () => 'full-1', optsFor(opFull));
    const overflow = await queue.enqueue('full-2', async () => 'full-2', optsFor(opFull2));
    assert.deepEqual(overflow, { ok: false, skipped: 'queue_full' });
    assert.equal(await blocker, 'blocker-done');
    assert.equal(await fullOne, 'full-1');

    // Back-compat: no operationId -> no events.
    const eventsBefore = (await readLedgerEvents()).length;
    await queue.enqueue('no-opid', async () => 'plain');
    const eventsAfter = (await readLedgerEvents()).length;
    assert.equal(eventsAfter, eventsBefore, 'unkeyed legacy enqueues must not emit ledger events');

    const events = await readLedgerEvents();
    assert.equal(eventCount(events, (e) => e.operationId === opA.operationId && e.kind === 'enqueue'), 1);
    assert.equal(eventCount(events, (e) => e.operationId === opA.operationId && e.kind === 'started' && e.stage === 'queue'), 1);
    assert.equal(eventCount(events, (e) => e.operationId === opA.operationId && e.kind === 'succeeded'), 1);
    assert.equal(eventCount(events, (e) => e.operationId === opDup.operationId && e.kind === 'skipped' && e.reason === 'dedupe'), 1);
    assert.equal(eventCount(events, (e) => e.operationId === opBlock.operationId && e.kind === 'succeeded'), 1);
    assert.equal(eventCount(events, (e) => e.operationId === opFull.operationId && e.kind === 'succeeded'), 1);
    assert.equal(eventCount(events, (e) => e.operationId === opFull2.operationId && e.kind === 'skipped' && e.reason === 'queue_full'), 1);
    assert.equal(queue.stats().timeoutMs, 3 * 60_000, 'default timeoutMs should be a finite three-minute deadline');
    checkpoint();
  }

  // 6. Queue timeout: rejects with timeout and emits a timeout event; the
  // late settlement of the underlying task is ignored.
  {
    const queue = createBackgroundAiQueue({ enabled: true, concurrency: 1, delayMs: 0, maxQueue: 10 });
    const op = operationLedger.beginOperation({ operation: 'session_label_suggestion', sessionId: 'sess_timeout', provider: 'claude' });
    let lateSettled = false;
    const pending = queue.enqueue('timeout-op', async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      lateSettled = true;
      return 'late';
    }, {
      operationId: op.operationId,
      operation: op.operation,
      sessionId: op.sessionId,
      provider: op.provider,
      model: op.model,
      timeoutMs: 50,
    });
    await assert.rejects(pending, (error) => error?.name === 'OperationTimeoutError');
    await new Promise((resolve) => setTimeout(resolve, 250));
    const events = await readLedgerEvents();
    assert.equal(eventCount(events, (e) => e.operationId === op.operationId && e.kind === 'timeout'), 1);
    assert.ok(lateSettled, 'underlying task keeps running after queue timeout');
    const succeededCount = eventCount(events, (e) => e.operationId === op.operationId && e.kind === 'succeeded');
    assert.equal(succeededCount, 0, 'late settlement must not emit a second terminal event');
    checkpoint();
  }

  // 7. Usage ledger association: detached record carries the operationId and
  // uses it as runId, and the query can filter by operationId.
  {
    const op = operationLedger.beginOperation({
      operation: 'session_label_suggestion',
      sessionId: 'sess_usage_link',
      provider: 'claude',
      model: 'claude-sonnet',
    });
    const record = usageLedger.buildDetachedUsageLedgerRecord({
      session: { id: 'sess_usage_link', name: 'Usage link', tool: 'claude' },
      usageEvent: { inputTokens: 11, outputTokens: 7 },
      tracking: {
        operation: 'session_label_suggestion',
        operationId: op.operationId,
        runId: op.operationId,
        tool: 'claude',
        model: 'claude-sonnet',
        completedAt: new Date().toISOString(),
      },
    });
    assert.ok(record, 'record should build');
    assert.equal(record.operationId, op.operationId, 'usage record must carry the operationId');
    assert.equal(record.runId, op.operationId, 'usage record runId must equal the operationId');
    assert.equal(usageLedger.appendUsageLedgerRecord(record), true);
    await usageLedger.closeUsageLedger();
    const linked = await usageLedger.queryUsageLedger({
      days: 1,
      operationId: op.operationId,
    });
    assert.equal(linked.runCount, 1, 'usage query should find the record by operationId');
    assert.equal(linked.byOperation[0]?.key, 'session_label_suggestion');
    checkpoint();
  }

  // 8. queryOperationLedger rollup + 24h CLI script against a temp dir.
  {
    const summary = await operationLedger.queryOperationLedger({ days: 1 });
    assert.ok(summary.events >= 10, 'summary should see the events written above');
    const taskCardOps = summary.operations.find((op) => op.key === 'task_card_suggestion');
    assert.ok(taskCardOps, 'task_card_suggestion should be bucketed');
    assert.ok(taskCardOps.skipped >= 2, 'dedupe + queue_full skips should be counted');
    assert.ok(taskCardOps.succeeded >= 1);
    assert.ok(taskCardOps.successRate > 0);
    const authFailures = summary.byErrorCode.find(([code]) => code === 'auth');
    assert.ok(authFailures && authFailures[1] >= 1, 'auth error code should be counted');
    assert.ok(summary.usageTotals.inputTokens >= 100, 'inline usage should be aggregated');

    const script = join(repoRoot, '..', 'scripts', 'operation-ledger-summary-24h.mjs');
    const result = spawnSync(process.execPath, [script, '--days', '1', '--json', '--ledger-dir', operationLedgerDir], {
      encoding: 'utf8',
      env: { ...process.env, HOME: tempHome, RAGENT_CONFIG_DIR: configDir, RAGENT_USAGE_LEDGER_DIR: ledgerDir },
    });
    assert.equal(result.status, 0, `summary script should exit 0: ${result.stderr?.slice(0, 300)}`);
    const scriptSummary = JSON.parse(result.stdout);
    assert.ok(scriptSummary.operations.length >= 2, 'script JSON should include per-operation buckets');
    assert.ok(scriptSummary.byKind.some(([kind]) => kind === 'failed'));

    const humanResult = spawnSync(process.execPath, [script, '--days', '1', '--ledger-dir', operationLedgerDir], {
      encoding: 'utf8',
      env: { ...process.env, HOME: tempHome, RAGENT_CONFIG_DIR: configDir, RAGENT_USAGE_LEDGER_DIR: ledgerDir },
    });
    assert.equal(humanResult.status, 0);
    assert.match(humanResult.stdout, /By operation:/);
    assert.match(humanResult.stdout, /task_card_suggestion/);
    checkpoint();
  }

  // 9. End-to-end through the summarizer subprocess path: provider_exit
  // classification on a failing fake tool, and a hard timeout that SIGKILLs
  // a hanging fake tool (RAGENT_SUMMARIZER_TIMEOUT_MS).
  //
  // Note: lib/config.mjs resolves configDir at import time, so tools.json
  // must go into the already-resolved configDir rather than a new env value.
  {
    const integrationHome = join(tempHome, 'integration');
    const tempBin = join(integrationHome, 'bin');
    mkdirSync(tempBin, { recursive: true });
    mkdirSync(integrationHome, { recursive: true });

    const fakeCodexPath = join(tempBin, 'fake-codex');
    writeFileSync(
      fakeCodexPath,
      `#!/usr/bin/env node
const mode = process.env.FAKE_TOOL_MODE || 'ok';
if (process.env.FAKE_PID_FILE) require('fs').writeFileSync(process.env.FAKE_PID_FILE, String(process.pid));
if (mode === 'fail') process.exit(3);
if (mode === 'hang') setTimeout(() => {}, 60000);
const text = JSON.stringify({ title: 'Ledger Rename Flow', group: 'Ragent', description: 'Ledger test.' });
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'ledger-thread' }));
console.log(JSON.stringify({ type: 'turn.started' }));
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
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

    const previousPath = process.env.PATH;
    const previousTimeout = process.env.RAGENT_SUMMARIZER_TIMEOUT_MS;
    process.env.RAGENT_OPERATION_LEDGER_DIR = operationLedgerDir;
    process.env.PATH = `${tempBin}:${previousPath}`;

    const { createSession, getSession, renameSession, killAll } = await import(
      pathToFileURL(join(repoRoot, 'chat', 'session-manager.mjs')).href
    );
    const { appendEvent } = await import(pathToFileURL(join(repoRoot, 'chat', 'history.mjs')).href);
    const { messageEvent } = await import(pathToFileURL(join(repoRoot, 'chat', 'normalizer.mjs')).href);
    const { triggerSessionLabelSuggestion } = await import(pathToFileURL(join(repoRoot, 'chat', 'summarizer.mjs')).href);

    const makeSession = async () => {
      const session = await createSession(integrationHome, 'fake-codex', '');
      await appendEvent(session.id, messageEvent('user', 'Rename from the ledger integration test.'));
      await appendEvent(session.id, messageEvent('assistant', 'I will repair the rename path.'));
      return session;
    };
    const triggerLabel = (session) => triggerSessionLabelSuggestion({
      id: session.id,
      folder: integrationHome,
      name: session.name,
      autoRenamePending: session.autoRenamePending,
      tool: 'fake-codex',
      model: 'fake-model',
    }, (newName) => renameSession(session.id, newName));

    // 9a. Failing tool -> provider_exit event.
    process.env.FAKE_TOOL_MODE = 'fail';
    const failSession = await makeSession();
    const failResult = await triggerLabel(failSession);
    assert.equal(failResult.ok, false, 'failing tool should not produce a suggestion');

    // 9b. Hanging tool -> timeout event, child process SIGKILLed.
    const hangPidFile = join(integrationHome, 'hang.pid');
    process.env.FAKE_TOOL_MODE = 'hang';
    process.env.FAKE_PID_FILE = hangPidFile;
    process.env.RAGENT_SUMMARIZER_TIMEOUT_MS = '300';
    const hangSession = await makeSession();
    const hangResult = await triggerLabel(hangSession);
    assert.equal(hangResult.ok, false, 'hanging tool should time out');
    assert.match(hangResult.error || '', /timed out/i, 'timeout error should surface to the trigger');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(existsSync(hangPidFile), 'fake tool should have written its pid');
    const hangPid = Number.parseInt(readFileSync(hangPidFile, 'utf8'), 10);
    const deadline = Date.now() + 3000;
    while (existsSync(`/proc/${hangPid}`) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(!existsSync(`/proc/${hangPid}`), 'hung tool process should be killed on timeout');

    killAll();
    await operationLedger.closeOperationLedger();
    const events = await readLedgerEvents();
    assert.equal(
      eventCount(events, (e) => e.operation === 'session_label_suggestion'
        && e.kind === 'failed'
        && e.errorCode === 'provider_exit'
        && e.provider === 'fake-codex'
        && e.stage === 'call'),
      1,
      'failing provider exit should be classified provider_exit',
    );
    // Scoped to provider fake-codex: scenario 6's queue-level timeout probe
    // shares the session_label_suggestion operation name and would otherwise
    // inflate this count.
    assert.equal(
      eventCount(events, (e) => e.operation === 'session_label_suggestion' && e.kind === 'timeout' && e.errorCode === 'timeout' && e.provider === 'fake-codex'),
      1,
      'hang timeout should be ledgered with the timeout code',
    );
    // Earlier scenarios reuse the session_label_suggestion operation name for
    // track/queue probes, so scenario-9 assertions are scoped to fake-codex.
    const failedEvent = events.find((e) => e.operation === 'session_label_suggestion' && e.kind === 'failed' && e.provider === 'fake-codex');
    assert.ok(failedEvent.operationId.startsWith('op_'), 'failed event must carry an operationId');
    assert.ok(failedEvent.provider === 'fake-codex' && failedEvent.model === 'fake-model', 'provider/model must be attributed');
    const succeededEvents = events.filter((e) => e.operation === 'session_label_suggestion' && e.kind === 'succeeded' && e.provider === 'fake-codex');
    assert.ok(succeededEvents.length === 0, 'no succeeded event should be emitted for fail/hang runs');
    assert.ok(Number.isInteger(failedEvent.durationMs), 'duration must be recorded');

    // Restore env for the rest of the file.
    if (previousTimeout === undefined) delete process.env.RAGENT_SUMMARIZER_TIMEOUT_MS;
    else process.env.RAGENT_SUMMARIZER_TIMEOUT_MS = previousTimeout;
    process.env.PATH = previousPath;
    delete process.env.FAKE_TOOL_MODE;
    delete process.env.FAKE_PID_FILE;
    checkpoint();
  }

  console.log(`test-operation-ledger: ok (${scenario} scenarios)`);
} finally {
  await operationLedger.closeOperationLedger();
  await usageLedger.closeUsageLedger();
  rmSync(tempHome, { recursive: true, force: true });
}
