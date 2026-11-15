#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const home = mkdtempSync(join(tmpdir(), 'ragent-spool-delta-'));
process.env.RAGENT_INSTANCE_ROOT = home;
process.env.RAGENT_CONFIG_DIR = join(home, 'config');

try {
  const {
    appendRunSpoolRecord,
    createRun,
    materializeRunSpoolLine,
    readRunSpoolDelta,
    updateRun,
  } = await import('../chat/runs.mjs');

  const run = await createRun({
    status: {
      sessionId: 'session_spool_delta',
      requestId: 'req_spool_delta',
      state: 'accepted',
      tool: 'fake-codex',
    },
    manifest: {
      sessionId: 'session_spool_delta',
      requestId: 'req_spool_delta',
      folder: '~',
      tool: 'fake-codex',
      prompt: 'hi',
      options: {},
    },
  });

  await appendRunSpoolRecord(run.id, { stream: 'stdout', line: 'x'.repeat(4 * 1024 * 1024) });
  await appendRunSpoolRecord(run.id, { stream: 'stdout', line: 'small-1' });
  await appendRunSpoolRecord(run.id, { stream: 'stdout', line: 'small-2' });

  const recovered = await readRunSpoolDelta(run.id, { skipLines: 2 });
  assert.equal(recovered.records.length, 1);
  assert.equal(recovered.records[0].line, 'small-2');
  assert.match(recovered.records[0].recordId, /^spool_[a-f0-9]{24}$/);
  assert.equal(recovered.skippedLineCount, 2);
  assert.equal(recovered.processedLineCount, 1);
  assert.equal(recovered.nextOffset > 0, true);

  await updateRun(run.id, {
    normalizedLineCount: recovered.skippedLineCount + recovered.processedLineCount,
    normalizedByteOffset: recovered.nextOffset,
  });

  await appendRunSpoolRecord(run.id, { stream: 'stdout', line: 'small-3' });

  const delta = await readRunSpoolDelta(run.id, { startOffset: recovered.nextOffset });
  assert.equal(delta.records.length, 1);
  assert.equal(delta.records[0].line, 'small-3');
  assert.equal(delta.processedLineCount, 1);
  assert.equal(delta.nextOffset > recovered.nextOffset, true);

  const safeOffset = delta.nextOffset;
  await appendRunSpoolRecord(run.id, { stream: 'stdout', line: 'y'.repeat(3 * 1024 * 1024) });
  await appendRunSpoolRecord(run.id, { stream: 'stdout', line: 'small-4' });

  const oversizedDelta = await readRunSpoolDelta(run.id, { startOffset: safeOffset });
  assert.equal(oversizedDelta.processedLineCount, 2);
  assert.equal(oversizedDelta.records.length, 2);
  assert.equal(typeof oversizedDelta.records[0].lineArtifact, 'string');
  assert.equal((await materializeRunSpoolLine(run.id, oversizedDelta.records[0])).startsWith('y'), true);
  assert.equal(oversizedDelta.records[1].line, 'small-4');

  // P0-a: records[] is capped so a spool of many small records can't be
  // materialized into an unbounded JS array (the OOM vector). The cursor stops
  // at the cap and can be resumed, so unread records are never discarded.
  const capRun = await createRun({
    status: { sessionId: 'session_spool_cap', requestId: 'req_spool_cap', state: 'accepted', tool: 'fake-codex' },
    manifest: { sessionId: 'session_spool_cap', requestId: 'req_spool_cap', folder: '~', tool: 'fake-codex', prompt: 'cap', options: {} },
  });
  const overCap = 4010;
  for (let i = 0; i < overCap; i += 1) {
    await appendRunSpoolRecord(capRun.id, { stream: 'stdout', line: `cap-${i}` });
  }
  const capped = await readRunSpoolDelta(capRun.id, {});
  assert.equal(capped.truncated, true, 'default cap should mark the delta truncated');
  assert.equal(capped.records.length < overCap, true, 'records must be capped below the total line count');
  assert.equal(capped.processedLineCount, 4000, 'cursor must consume only the returned batch');
  assert.equal(capped.nextOffset > 0, true);
  const tail = await readRunSpoolDelta(capRun.id, {
    startOffset: capped.nextOffset,
    maxRecords: 10,
  });
  assert.equal(tail.records[0].line, 'cap-4000');
  assert.equal(tail.processedLineCount, 10);
  assert.equal(tail.nextOffset > capped.nextOffset, true);
  const smallCap = await readRunSpoolDelta(capRun.id, { maxRecords: 10 });
  assert.equal(smallCap.records.length, 10, 'explicit maxRecords is honored');
  assert.equal(smallCap.truncated, true);
  assert.equal(smallCap.processedLineCount, 10);

  // Structured records must not store a redundant `line` alongside `json`;
  // materializeRunSpoolLine derives the text from `json` instead, while raw
  // (non-structured) records still carry their own `line`.
  const dualRun = await createRun({
    status: { sessionId: 'session_spool_dual', requestId: 'req_spool_dual', state: 'accepted', tool: 'fake-codex' },
    manifest: { sessionId: 'session_spool_dual', requestId: 'req_spool_dual', folder: '~', tool: 'fake-codex', prompt: 'dual', options: {} },
  });
  await appendRunSpoolRecord(dualRun.id, { stream: 'stdout', json: { item: { text: 'structured-payload' } } });
  await appendRunSpoolRecord(dualRun.id, { stream: 'stdout', line: 'raw-payload' });
  const dual = await readRunSpoolDelta(dualRun.id, {});
  assert.equal(dual.records.length, 2);
  const structured = dual.records[0];
  assert.equal(structured.json.item.text, 'structured-payload');
  assert.match(structured.recordId, /^spool_[a-f0-9]{24}$/);
  assert.equal('line' in structured, false, 'structured record must not carry a redundant line');
  assert.equal(await materializeRunSpoolLine(dualRun.id, structured), JSON.stringify({ item: { text: 'structured-payload' } }));
  assert.equal(dual.records[1].line, 'raw-payload');
  assert.equal(await materializeRunSpoolLine(dualRun.id, dual.records[1]), 'raw-payload');

  console.log('test-run-spool-delta: ok');
} finally {
  rmSync(home, { recursive: true, force: true });
}
