#!/usr/bin/env node
// DS-15: providerCapabilities persist-boundary coverage audit.
//
// Provider capabilities are run-level metadata whose single record is the run
// (chat/runs.mjs); the history persist boundary (appendEvent/appendEvents in
// chat/history.mjs) strips the per-event clone. This test pins the audit
// result: every history write path funnels through those two exported entry
// points and no event with providerCapabilities can land on disk.
//
// Covers: exported surface (no unlocked bypass), single + batch boundary,
// caller's in-memory event keeps its field, fork path (forkSession →
// appendEvents, runId dropped by sanitizeForkedEvent so nothing to join),
// run-join read compatibility (run record enriches field-free events by
// runId), legacy files keep their embedded value on read, the backfill script
// reports exact duplicated-field bytes in dry-run and apply mode, and the
// path-family source audit (no module may import the unlocked appends).
import assert from 'assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { spawn } from 'child_process';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const home = mkdtempSync(join(tmpdir(), 'ragent-capabilities-boundary-'));
const workspace = join(home, 'workspace');
const configDir = join(home, '.config', 'ragent');
const localBin = join(home, '.local', 'bin');
mkdirSync(workspace, { recursive: true });
mkdirSync(configDir, { recursive: true });
mkdirSync(localBin, { recursive: true });
process.env.HOME = home;
process.env.RAGENT_CONFIG_DIR = configDir;
process.env.RAGENT_MEMORY_DIR = join(home, 'memory');
process.env.RAGENT_WORK_ROOT_DIR = workspace;
delete process.env.RAGENT_INSTANCE_ROOT;

// Fake codex (absolute command path — absolute commands skip the
// preferred-path lookup) so forkSession's native-thread probe succeeds.
writeFileSync(
  join(localBin, 'codex-fake-fork'),
  `#!/usr/bin/env node
const readline = require('readline');
let initialized = false;
function send(message) {
  process.stdout.write(JSON.stringify(message) + '\\n');
}
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    initialized = true;
    send({ id: message.id, result: { userAgent: 'fake', platformFamily: 'linux', platformOs: 'linux' } });
    return;
  }
  if (message.method === 'thread/fork') {
    if (!initialized) {
      send({ id: message.id, error: { message: 'not initialized' } });
      return;
    }
    send({ id: message.id, result: { thread: { id: 'codex-child-thread-native', forkedFromId: message.params.threadId } } });
    process.exit(0);
  }
});
`,
  'utf8',
);
chmodSync(join(localBin, 'codex-fake-fork'), 0o755);
writeFileSync(
  join(configDir, 'tools.json'),
  JSON.stringify([{
    id: 'codex-fake-fork',
    name: 'Fake Codex Fork',
    command: join(localBin, 'codex-fake-fork'),
    runtimeFamily: 'codex-app-server-json',
    models: [{ id: 'fake-model', label: 'Fake model', defaultEffort: 'low' }],
    reasoning: { kind: 'enum', label: 'Reasoning', levels: ['low'], default: 'low' },
  }], null, 2),
  'utf8',
);

const sessionManager = await import(pathToFileURL(join(repoRoot, 'chat', 'session-manager.mjs')).href);
const { createSession, forkSession, getSessionEventsAfter, killAll } = sessionManager;
const history = await import(pathToFileURL(join(repoRoot, 'chat', 'history.mjs')).href);
const { appendEvent, appendEvents } = history;
const runs = await import(pathToFileURL(join(repoRoot, 'chat', 'runs.mjs')).href);
const { createRun } = runs;

const CAPABILITIES = {
  provider: 'zen',
  runtimeFamily: 'codex',
  supportsExternalUsageProjection: true,
  supportsInterrupt: false,
  supportsSteer: true,
};

function eventFilesOnDisk(sessionId) {
  const dir = join(configDir, 'chat-history', sessionId, 'events');
  return readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
}

function loadDiskEvents(sessionId) {
  return eventFilesOnDisk(sessionId).map((name) => (
    JSON.parse(readFileSync(join(configDir, 'chat-history', sessionId, 'events', name), 'utf8'))
  ));
}

function runScript(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(repoRoot, 'scripts', 'strip-run-capabilities-events.mjs'), ...args], {
      env: { ...process.env, HOME: home, RAGENT_CONFIG_DIR: configDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`script failed (${code}): ${err.slice(0, 400)}`));
      else resolve();
    });
  });
}

try {
  // --- 1. exported surface: the two public appends are the only boundary ---
  {
    assert.equal(typeof history.appendEvent, 'function');
    assert.equal(typeof history.appendEvents, 'function');
    assert.equal(history.appendEventUnlocked, undefined, 'no unlocked appendEvent export');
    assert.equal(history.appendEventsUnlocked, undefined, 'no unlocked appendEvents export');
  }

  // --- 2. boundary strips on write, caller's in-memory event keeps the field ---
  {
    const session = await createSession(workspace, 'codex-fake-fork', 'Boundary session');
    const input = {
      type: 'run_event',
      id: 'evt_inline',
      runId: 'run_boundary_1',
      payload: 'x',
      providerCapabilities: CAPABILITIES,
    };
    const stored = await appendEvent(session.id, input);
    assert.equal(stored.providerCapabilities, undefined, 'returned event must be field-free');
    assert.deepEqual(input.providerCapabilities, CAPABILITIES, 'caller object must keep its field (streaming paths rely on it)');
    const onDisk = loadDiskEvents(session.id);
    assert.equal(onDisk.length, 1);
    assert.equal(onDisk[0].providerCapabilities, undefined, 'disk event must be field-free');
    assert.equal(onDisk[0].payload, 'x', 'other fields preserved');
    await history.removeSessionHistory(session.id).catch(() => {});
  }

  // --- 3. fork path: parent events stay in the source and read field-free ---
  {
    const parent = await createSession(workspace, 'codex-fake-fork', 'Fork parent');
    await createRun({
      status: { provider: 'zen', runtimeFamily: 'codex', providerCapabilities: CAPABILITIES },
      manifest: { tool: 'codex-fake-fork' },
    });
    await appendEvents(parent.id, [
      { type: 'message', id: 'fork_m1', role: 'user', text: 'hello' },
      { type: 'run_event', id: 'fork_r1', runId: 'run_fork_1', payload: 'a', providerCapabilities: CAPABILITIES },
      { type: 'run_event', id: 'fork_r2', runId: 'run_fork_1', payload: 'b', providerCapabilities: CAPABILITIES },
    ]);
    const child = await forkSession(parent.id);
    assert.ok(child, 'forkSession should succeed');
    const forked = loadDiskEvents(child.id);
    assert.equal(forked.length, 0, 'shared-prefix fork must not copy parent event files');
    // Read side: no fabrication, no crash.
    const readBack = await getSessionEventsAfter(child.id, 0);
    assert.equal(readBack.length, 3);
    for (const event of readBack) {
      assert.equal(event.providerCapabilities, undefined, 'forked read must not fabricate capabilities');
    }
    await history.removeSessionHistory(parent.id).catch(() => {});
    await history.removeSessionHistory(child.id).catch(() => {});
  }

  // --- 4. run-join read compatibility: field-free events enrich from the run ---
  {
    const session = await createSession(workspace, 'codex-fake-fork', 'Run join session');
    const run = await createRun({
      status: { provider: 'zen', runtimeFamily: 'codex', providerCapabilities: CAPABILITIES },
      manifest: { tool: 'codex-fake-fork' },
    });
    await appendEvents(session.id, [
      { type: 'message', id: 'join_m1', role: 'user', text: 'hi' },
      { type: 'run_event', id: 'join_r1', runId: run.id, payload: 'a' },
      { type: 'run_event', id: 'join_r2', runId: 'run-gone', payload: 'b' },
    ]);
    const events = await getSessionEventsAfter(session.id, 0);
    assert.deepEqual(
      events.find((e) => e.id === 'join_r1').providerCapabilities,
      CAPABILITIES,
      'run event enriched from the run record by runId',
    );
    assert.equal(
      events.find((e) => e.id === 'join_r2').providerCapabilities,
      undefined,
      'missing run record never fabricates',
    );
    assert.equal(events.find((e) => e.id === 'join_m1').providerCapabilities, undefined, 'run-less events never enriched');
    await history.removeSessionHistory(session.id).catch(() => {});
  }

  // --- 5. legacy files (pre-migration) keep their embedded value on read ---
  {
    const legacySessionId = 'd'.repeat(32);
    mkdirSync(join(configDir, 'chat-history', legacySessionId, 'events'), { recursive: true });
    writeFileSync(join(configDir, 'chat-history', legacySessionId, 'meta.json'), JSON.stringify({
      latestSeq: 1,
      lastEventAt: 1785000000000,
      lastAssistantMessageAt: null,
      size: 1,
      counts: {},
    }));
    writeFileSync(join(configDir, 'chat-history', legacySessionId, 'events', '000000001.json'), JSON.stringify({
      type: 'run_event',
      seq: 1,
      timestamp: 1785000000000,
      runId: 'legacy-run',
      payload: 'old',
      providerCapabilities: { provider: 'legacy', runtimeFamily: 'codex' },
    }));
    const legacy = await getSessionEventsAfter(legacySessionId, 0);
    assert.deepEqual(
      legacy[0].providerCapabilities,
      { provider: 'legacy', runtimeFamily: 'codex' },
      'legacy embedded value preserved on read (idempotent, never overwritten)',
    );
    await history.removeSessionHistory(legacySessionId).catch(() => {});
  }

  // --- 6. backfill script: dry-run reports exact duplicated-field bytes ---
  {
    const backfillRoot = join(home, 'backfill-fixture');
    const withField1 = {
      type: 'run_event',
      seq: 1,
      timestamp: 1785000000000,
      runId: 'run_backfill_1',
      payload: 'first',
      providerCapabilities: CAPABILITIES,
    };
    const withField2 = {
      type: 'run_event',
      seq: 1,
      timestamp: 1785000000000,
      runId: 'run_backfill_2',
      payload: 'second',
      providerCapabilities: { provider: 'zen', runtimeFamily: 'codex' },
    };
    const withoutField = { type: 'message', seq: 1, timestamp: 1785000000000, role: 'user', text: 'plain' };
    const corrupt = '{ this is not json';

    const expectedDelta = (event) => {
      const raw = `${JSON.stringify(event, null, 2)}\n`;
      const stripped = { ...event };
      delete stripped.providerCapabilities;
      return raw.length - `${JSON.stringify(stripped, null, 2)}\n`.length;
    };

    mkdirSync(join(backfillRoot, 'sess-backfill-1', 'events'), { recursive: true });
    writeFileSync(join(backfillRoot, 'sess-backfill-1', 'events', '000000001.json'), `${JSON.stringify(withField1, null, 2)}\n`);
    writeFileSync(join(backfillRoot, 'sess-backfill-1', 'events', '000000002.json'), `${JSON.stringify(withoutField, null, 2)}\n`);
    writeFileSync(join(backfillRoot, 'sess-backfill-1', 'events', '000000003.json'), corrupt);
    mkdirSync(join(backfillRoot, 'sess-backfill-2', 'events'), { recursive: true });
    writeFileSync(join(backfillRoot, 'sess-backfill-2', 'events', '000000001.json'), `${JSON.stringify(withField2, null, 2)}\n`);

    // Dry-run: reports withField + exact releasedBytes, writes nothing.
    const dryRunOut = join(home, 'dry-run.json');
    await runScript(['--root', backfillRoot, '--json-out', dryRunOut]);
    const dryRun = JSON.parse(readFileSync(dryRunOut, 'utf8'));
    assert.equal(dryRun.mode, 'dry-run');
    assert.equal(dryRun.sessions, 2);
    assert.equal(dryRun.scanned, 4);
    assert.equal(dryRun.withField, 2);
    assert.equal(dryRun.rewritten, 0, 'dry-run must not rewrite');
    assert.equal(dryRun.corrupt, 1);
    assert.equal(dryRun.releasedBytes, expectedDelta(withField1) + expectedDelta(withField2), 'dry-run releasedBytes = exact duplicated-field bytes');

    // Apply: same quantity, files rewritten, idempotent second pass.
    await runScript(['--root', backfillRoot, '--apply', '--throttle-ms', '0', '--json-out', join(home, 'apply.json')]);
    const applied = JSON.parse(readFileSync(join(home, 'apply.json'), 'utf8'));
    assert.equal(applied.mode, 'apply');
    assert.equal(applied.rewritten, 2);
    assert.equal(applied.releasedBytes, dryRun.releasedBytes, 'apply releasedBytes matches dry-run estimate exactly');
    const after = JSON.parse(readFileSync(join(backfillRoot, 'sess-backfill-1', 'events', '000000001.json'), 'utf8'));
    assert.equal(after.providerCapabilities, undefined, 'field stripped on disk');
    assert.equal(after.payload, 'first', 'other fields preserved');

    await runScript(['--root', backfillRoot, '--json-out', join(home, 'second-dry.json')]);
    const secondDry = JSON.parse(readFileSync(join(home, 'second-dry.json'), 'utf8'));
    assert.equal(secondDry.withField, 0, 'idempotent: second dry-run finds nothing');
    assert.equal(secondDry.releasedBytes, 0);
  }

  // --- 7. path-family source audit: no module imports the unlocked appends ---
  {
    // Every module that appends history events (history.mjs itself is the
    // definition site and is asserted separately below).
    const modules = [
      'chat/bootstrap-sessions.mjs',
      'chat/privileged-approval.mjs',
      'chat/router-session-main-routes.mjs',
      'chat/session-auto-compaction.mjs',
      'chat/session-dispatch.mjs',
      'chat/session-manager.mjs',
      'chat/session-turn-completion.mjs',
      'chat/triggers.mjs',
    ];
    for (const modulePath of modules) {
      const source = readFileSync(join(repoRoot, modulePath), 'utf8');
      assert.ok(
        !source.includes('appendEventUnlocked') && !source.includes('appendEventsUnlocked'),
        `${modulePath} must not reference the unlocked appends`,
      );
    }
    const historySource = readFileSync(join(repoRoot, 'chat', 'history.mjs'), 'utf8');
    assert.equal((historySource.match(/export async function appendEvents?\b/g) || []).length, 2, 'only appendEvent/appendEvents are exported');
  }

  console.log('provider capabilities boundary: all sections passed');
} finally {
  if (typeof killAll === 'function') {
    try { await killAll(); } catch {}
  }
  rmSync(home, { recursive: true, force: true });
}
