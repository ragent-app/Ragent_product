#!/usr/bin/env node
// Regression: readRunSpoolRecords must keep the TAIL of an oversized spool
// (bounded by MAX_SPOOL_DELTA_RECORDS) instead of truncating the head. The
// final assistant message lives at the end of the spool; head-first truncation
// dropped it and silently broke result-file asset publishing (QR/APK
// attachments) for long runs.
import assert from 'assert/strict';
import { gzipSync } from 'zlib';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tmp = mkdtempSync(join(tmpdir(), 'ragent-spool-tail-'));
process.env.RAGENT_CONFIG_DIR = tmp;
const { readRunSpoolRecords } = await import('../chat/runs.mjs');

const RUN_ID = 'run_spool_tail_test';
const RECORDS = 4500;
const CAP = 4000;
const runDir = join(tmp, 'chat-runs', RUN_ID);
mkdirSync(runDir, { recursive: true });
const spoolPath = join(runDir, 'spool.jsonl');

function lineFor(index) {
  return JSON.stringify({ ts: new Date(1700000000000 + index).toISOString(), stream: 'stdout', line: `record-${index}` });
}

try {
  let body = '';
  for (let i = 0; i < RECORDS; i += 1) body += `${lineFor(i)}\n`;

  // Plain (non-gzipped) spool
  writeFileSync(spoolPath, body);
  const plain = await readRunSpoolRecords(RUN_ID);
  assert.equal(plain.length, CAP, `plain spool should cap at ${CAP}`);
  assert.equal(plain[0].line, 'record-500', 'plain spool should start at the tail window');
  assert.equal(plain[plain.length - 1].line, `record-${RECORDS - 1}`, 'plain spool should end at the final record');
  assert.ok(plain.some((r) => r.line === `record-${RECORDS - 1}`), 'final record must survive');

  // Archived (gzipped) spool
  rmSync(spoolPath);
  const gzPath = join(runDir, 'spool.jsonl.gz');
  writeFileSync(gzPath, gzipSync(body));
  const archived = await readRunSpoolRecords(RUN_ID);
  assert.equal(archived.length, CAP, `archived spool should cap at ${CAP}`);
  assert.equal(archived[0].line, 'record-500', 'archived spool should start at the tail window');
  assert.equal(archived[archived.length - 1].line, `record-${RECORDS - 1}`, 'archived spool should end at the final record');
  assert.ok(archived.some((r) => r.line === `record-${RECORDS - 1}`), 'final record must survive in archived spool');

  // Small spool must be unaffected
  writeFileSync(spoolPath, `${lineFor(0)}\n${lineFor(1)}\n`);
  const small = await readRunSpoolRecords(RUN_ID);
  assert.deepEqual(small.map((r) => r.line), ['record-0', 'record-1'], 'small spool passes through unchanged');

  console.log('OK: readRunSpoolRecords keeps the spool tail (plain + gzipped + small)');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
