#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const home = mkdtempSync(join(tmpdir(), 'ragent-follow-up-queue-'));
const configDir = join(home, '.config', 'ragent');
const memoryDir = join(home, '.ragent', 'memory');
const workDir = join(home, '.ragent', 'workspace');
const binDir = join(home, '.local', 'bin');
const fakeCodexPath = join(binDir, 'fake-codex');
const fakeAgyPath = join(binDir, 'fake-agy');
const fakeCodexThreadPath = join(home, 'fake-codex-thread-id');

mkdirSync(configDir, { recursive: true });
mkdirSync(memoryDir, { recursive: true });
mkdirSync(workDir, { recursive: true });
mkdirSync(binDir, { recursive: true });

writeFileSync(
  fakeCodexPath,
  `#!/usr/bin/env node
const delay = Number(process.env.FAKE_CODEX_DELAY_MS || '120');
const fs = require('fs');
const threadFile = ${JSON.stringify(fakeCodexThreadPath)};
const threadId = fs.existsSync(threadFile)
  ? fs.readFileSync(threadFile, 'utf8').trim() || 'thread-test'
  : 'thread-test';
console.log(JSON.stringify({ type: 'thread.started', thread_id: threadId }));
console.log(JSON.stringify({ type: 'turn.started' }));
setTimeout(() => {
  console.log(JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: 'reply from fake codex' },
  }));
  console.log(JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 1, output_tokens: 1 },
  }));
}, delay);
`,
  'utf8',
);
chmodSync(fakeCodexPath, 0o755);

writeFileSync(
  fakeAgyPath,
  `#!/usr/bin/env node
const delay = Number(process.env.FAKE_AGY_DELAY_MS || '120');
console.log(JSON.stringify({ event: 'init', conversation_id: 'agy-test-conversation' }));
console.log(JSON.stringify({
  event: 'step_update',
  step_update: { step_index: 1, step_type: 'agent_response', state: 'ACTIVE' },
}));
setTimeout(() => {
  console.log(JSON.stringify({
    event: 'result',
    result: {
      status: 'SUCCESS',
      response: 'reply from fake agy\\n',
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    },
  }));
}, delay);
`,
  'utf8',
);
chmodSync(fakeAgyPath, 0o755);

writeFileSync(
  join(configDir, 'tools.json'),
  JSON.stringify(
    [
      {
        id: 'fake-codex',
        name: 'Fake Codex',
        command: fakeCodexPath,
        runtimeFamily: 'codex-json',
        models: [{ id: 'fake-model', label: 'Fake model' }],
        reasoning: {
          kind: 'enum',
          label: 'Reasoning',
          levels: ['low'],
          default: 'low',
        },
      },
      {
        id: 'fake-agy',
        name: 'Fake AgY',
        command: fakeAgyPath,
        runtimeFamily: 'agy-stream-json',
        models: [{ id: 'fake-agy-model', label: 'Fake AgY model' }],
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

process.env.RAGENT_INSTANCE_ROOT = home;
if (process.platform === 'win32') process.env.USERPROFILE = home;
process.env.RAGENT_CONFIG_DIR = configDir;
process.env.RAGENT_MEMORY_DIR = memoryDir;
process.env.RAGENT_WORK_ROOT_DIR = workDir;
process.env.RAGENT_DISABLE_SYSTEMD_DETACHED_RUNNER = '1';
delete process.env.RAGENT_RUNNER_SUPERVISOR_SOCKET;
delete process.env.RAGENT_RUNNER_SUPERVISOR_REQUIRED;
process.env.PATH = `${binDir}${delimiter}${process.env.PATH}`;
process.env.FAKE_CODEX_DELAY_MS = '120';
writeFileSync(fakeCodexThreadPath, 'thread-test', 'utf8');

const { AGY_AUTH_RELATIVE_PATH } = await import('../lib/agy-runtime.mjs');
const agyControlHome = join(configDir, 'provider-runtime-homes', 'agy-control');
const agyAuthFile = join(agyControlHome, AGY_AUTH_RELATIVE_PATH);
mkdirSync(dirname(agyAuthFile), { recursive: true });
writeFileSync(agyAuthFile, 'fake-agy-auth-token\n', 'utf8');

const sessionManager = await import(
  pathToFileURL(join(repoRoot, 'chat', 'session-manager.mjs')).href
);

const {
  createSession,
  getHistory,
  getRunState,
  getSession,
  killAll,
  listSessions,
  steerQueuedFollowUp,
  submitHttpMessage,
  updateSessionFollowUpQueue,
} = sessionManager;
const { findRunByRequest, getRunManifest } = await import('../chat/runs.mjs');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeRm(target, attempts = 6, delayMs = 120) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      rmSync(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (error?.code !== 'ENOTEMPTY' && error?.code !== 'EBUSY') {
        throw error;
      }
      await sleep(delayMs * (i + 1));
    }
  }
  rmSync(target, { recursive: true, force: true });
}

async function waitFor(predicate, description, timeoutMs = 8000, intervalMs = 25) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out: ${description}`);
}

try {
  const session = await createSession(home, 'fake-codex', 'Follow-up queue test', {
    group: 'Tests',
    description: 'Verifies busy-session follow-up queue flushing',
  });

  const initialOutcome = await submitHttpMessage(session.id, 'First run', [], {
    requestId: 'req-first-run',
    tool: 'fake-codex',
    model: 'fake-model',
    effort: 'low',
  });

  assert.ok(initialOutcome.run?.id, 'initial run should start immediately');

  await waitFor(
    async () => (await getSession(session.id))?.activity?.run?.state === 'running',
    'initial run should enter running state',
  );

  const queuedFirst = await submitHttpMessage(session.id, 'Follow-up one', [], {
    requestId: 'req-follow-1',
    tool: 'fake-codex',
    model: 'fake-model',
    effort: 'low',
  });
  assert.equal(queuedFirst.queued, true, 'follow-up should queue while the current run is active');
  assert.equal(queuedFirst.run, null, 'queued follow-up should not create a new run yet');

  const duplicateWhileQueued = await submitHttpMessage(session.id, 'Duplicate follow-up one', [], {
    requestId: 'req-follow-1',
    tool: 'fake-codex',
    model: 'fake-model',
    effort: 'low',
  });
  assert.equal(duplicateWhileQueued.duplicate, true, 'queued follow-up request ids should dedupe');
  assert.equal(duplicateWhileQueued.queued, true, 'duplicate queued follow-up should report queued state');

  const queuedSecond = await submitHttpMessage(session.id, 'Actually prioritize the second follow-up', [], {
    requestId: 'req-follow-2',
    tool: 'fake-codex',
    model: 'fake-model',
    effort: 'low',
  });
  assert.equal(queuedSecond.queued, true, 'multiple follow-ups should continue to queue');

  const queuedSession = await getSession(session.id, { includeQueuedMessages: true });
  assert.equal(queuedSession?.activity?.queue?.count, 2, 'session detail should expose queued follow-up count');
  assert.equal(queuedSession?.queuedMessages?.length, 2, 'session detail should expose queued follow-up bodies');
  assert.equal(queuedSession?.queuedMessages?.[0]?.text, 'Follow-up one');
  assert.equal(
    (await listSessions()).find((entry) => entry.id === session.id)?.activity?.queue?.count,
    2,
    'session list should expose queued follow-up count',
  );

  await waitFor(
    async () => {
      const current = await getSession(session.id);
      const history = await getHistory(session.id);
      const messageEvents = history.filter((event) => event.type === 'message');
      return current?.activity?.run?.state === 'idle'
        && current?.activity?.queue?.count === 0
        && messageEvents.length >= 6;
    },
    'queued follow-ups should auto-flush one turn at a time',
    12000,
  );

  const history = await getHistory(session.id);
  const userMessages = history.filter((event) => event.type === 'message' && event.role === 'user');
  assert.equal(userMessages.length, 3, 'queued follow-ups should become separate user turns');
  assert.equal(userMessages[0].content, 'First run');
  assert.equal(userMessages[1].content, 'Follow-up one');
  assert.equal(userMessages[2].content, 'Actually prioritize the second follow-up');

  const drainedSession = await getSession(session.id, { includeQueuedMessages: true });
  assert.equal(drainedSession?.activity?.queue?.count, 0, 'queue should clear after the next run is accepted');
  assert.deepEqual(drainedSession?.queuedMessages, [], 'drained session should expose an empty queue');

  const duplicateAfterFlush = await submitHttpMessage(session.id, 'Late retry after flush', [], {
    requestId: 'req-follow-1',
    tool: 'fake-codex',
    model: 'fake-model',
    effort: 'low',
  });
  assert.equal(duplicateAfterFlush.duplicate, true, 'recent flushed follow-up ids should still dedupe');
  assert.equal(duplicateAfterFlush.queued, false, 'post-flush duplicate should no longer be pending in the queue');
  assert.equal(duplicateAfterFlush.run?.requestId, 'req-follow-1', 'duplicate retry should return the existing flushed run');

  await waitFor(
    () => getRunState(initialOutcome.run.id).then((run) => run && ['completed', 'failed', 'cancelled'].includes(run.state)),
    'initial run should reach a terminal state',
  );

  process.env.FAKE_CODEX_DELAY_MS = '5000';
  writeFileSync(fakeCodexThreadPath, 'thread-test', 'utf8');
  const truncateSession = await createSession(home, 'fake-codex', 'Follow-up truncate test', {
    group: 'Tests',
    description: 'Verifies editing an earlier queued follow-up cancels later queued items',
  });
  const truncateInitial = await submitHttpMessage(truncateSession.id, 'Long truncate first run', [], {
    requestId: 'req-truncate-first',
    tool: 'fake-codex',
    model: 'fake-model',
    effort: 'low',
  });
  assert.ok(truncateInitial.run?.id, 'truncate setup should start an initial run');
  await waitFor(
    async () => (await getSession(truncateSession.id))?.activity?.run?.state === 'running',
    'truncate setup run should enter running state',
  );
  await submitHttpMessage(truncateSession.id, 'Queued one', [], {
    requestId: 'req-truncate-1',
    tool: 'fake-codex',
    model: 'fake-model',
    effort: 'low',
  });
  await submitHttpMessage(truncateSession.id, 'Queued two', [], {
    requestId: 'req-truncate-2',
    tool: 'fake-codex',
    model: 'fake-model',
    effort: 'low',
  });
  await submitHttpMessage(truncateSession.id, 'Queued three', [], {
    requestId: 'req-truncate-3',
    tool: 'fake-codex',
    model: 'fake-model',
    effort: 'low',
  });
  const truncatedSession = await updateSessionFollowUpQueue(truncateSession.id, {
    requestId: 'req-truncate-2',
    truncateFrom: true,
  });
  assert.deepEqual(
    truncatedSession?.queuedMessages?.map((item) => item.requestId),
    ['req-truncate-1'],
    'truncating from an edited queued item should preserve earlier queue entries and cancel that item plus later entries',
  );

  const steerSession = await createSession(home, 'fake-codex', 'Follow-up steer test', {
    group: 'Tests',
    description: 'Verifies queued steer interrupts the active Codex run',
  });
  const steerInitial = await submitHttpMessage(steerSession.id, 'Long first run', [], {
    requestId: 'req-steer-first',
    tool: 'fake-codex',
    model: 'fake-model',
    effort: 'low',
  });
  assert.ok(steerInitial.run?.id, 'steer setup should start an initial run');

  await waitFor(
    async () => (await getSession(steerSession.id))?.activity?.run?.state === 'running',
    'steer setup run should enter running state',
  );

  const queuedSteer = await submitHttpMessage(steerSession.id, '签名不能变，否则无法更新', [], {
    requestId: 'req-steer-now',
    tool: 'fake-codex',
    model: 'fake-model',
    effort: 'low',
  });
  assert.equal(queuedSteer.queued, true, 'steer candidate should queue while the first run is active');

  process.env.FAKE_CODEX_DELAY_MS = '120';
  const steered = await steerQueuedFollowUp(steerSession.id, { requestId: 'req-steer-now' });
  assert.equal(steered.steered, true, 'steer should drain the queued follow-up into a new run');
  assert.equal(steered.queued, false, 'steer outcome should not remain queued after launch');
  assert.equal(steered.interruptedRunId, steerInitial.run.id, 'steer should interrupt the active run before launching');
  assert.ok(steered.run?.id && steered.run.id !== steerInitial.run.id, 'steer should launch a replacement run');

  const interrupted = await getRunState(steerInitial.run.id);
  assert.equal(interrupted?.state, 'cancelled', 'interrupted run should be marked cancelled');
  const steerDetail = await getSession(steerSession.id, { includeQueuedMessages: true });
  assert.equal(steerDetail?.queuedMessages?.some((item) => item.requestId === 'req-steer-now'), false, 'steered item should leave the visible queue');
  assert.equal(steerDetail?.activity?.queue?.count, 0, 'steered queue should be empty');

  await waitFor(
    () => getRunState(steered.run.id).then((run) => run && ['completed', 'failed', 'cancelled'].includes(run.state)),
    'steered run should reach a terminal state',
    10000,
  );

  process.env.FAKE_AGY_DELAY_MS = '5000';
  const agySession = await createSession(home, 'fake-agy', 'Follow-up AgY queue test', {
    group: 'Tests',
    description: 'Verifies non-interactive AgY rejects steer but keeps queue mutations available',
  });
  const agyInitial = await submitHttpMessage(agySession.id, 'Long AgY first run', [], {
    requestId: 'req-agy-first',
    tool: 'fake-agy',
    model: 'fake-agy-model',
    effort: 'low',
  });
  assert.ok(agyInitial.run?.id, 'AgY setup should start an initial run');

  await waitFor(
    async () => (await getSession(agySession.id))?.activity?.run?.state === 'running',
    'AgY setup run should enter running state',
  );

  const agyQueued = await submitHttpMessage(agySession.id, 'Edit this AgY follow-up', [], {
    requestId: 'req-agy-queued',
    tool: 'fake-agy',
    model: 'fake-agy-model',
    effort: 'low',
  });
  assert.equal(agyQueued.queued, true, 'AgY follow-up should queue while the current run is active');

  await assert.rejects(
    () => steerQueuedFollowUp(agySession.id, { requestId: 'req-agy-queued' }),
    (error) => {
      assert.equal(error?.code, 'STEER_UNSUPPORTED');
      return true;
    },
    'AgY steer should be rejected without consuming the queued item',
  );
  const agyStillQueued = await getSession(agySession.id, { includeQueuedMessages: true });
  assert.deepEqual(
    agyStillQueued?.queuedMessages?.map((item) => item.requestId),
    ['req-agy-queued'],
    'rejected AgY steer should leave the queued item intact',
  );

  const agyDeleted = await updateSessionFollowUpQueue(agySession.id, {
    requestId: 'req-agy-queued',
  });
  assert.deepEqual(agyDeleted?.queuedMessages, [], 'AgY queued item should still be deletable');
  assert.equal(agyDeleted?.activity?.queue?.count, 0, 'deleting AgY queued item should clear queue count');

  console.log('test-session-follow-up-queue: ok');
} finally {
  killAll();
  await sleep(250);
  await safeRm(home);
}
