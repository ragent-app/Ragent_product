#!/usr/bin/env node
// Regression test: concurrent writes to the same target from the same
// process in the same millisecond must not collide on a tmp file name.
// Before the sequence suffix in atomicTempPath, both calls shared
// `${path}.tmp-${pid}-${Date.now()}`; the first rename succeeded and the
// second failed with ENOENT, silently dropping the write (observed as lost
// session meta/events under suite load, e.g. test-session-follow-up-queue).
import assert from 'assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const { writeJsonAtomic, writeTextAtomic } = await import('../chat/fs-utils.mjs');

const home = mkdtempSync(join(tmpdir(), 'ragent-fs-utils-atomic-'));

// Pin Date.now so every write lands in the same millisecond (same process
// pid), which is the worst-case collision window.
const realNow = Date.now;
Date.now = () => 1234567890123;

try {
  const jsonPath = join(home, 'state.json');
  const jsonResults = await Promise.allSettled(
    Array.from({ length: 8 }, (_, i) => writeJsonAtomic(jsonPath, { writer: i, payload: `value-${i}` })),
  );
  const jsonRejected = jsonResults.filter((r) => r.status === 'rejected');
  assert.equal(jsonRejected.length, 0, `writeJsonAtomic rejected: ${jsonRejected.map((r) => r.reason).join('; ')}`);
  assert.ok(existsSync(jsonPath), 'json target must exist after concurrent writes');
  const jsonContent = JSON.parse(readFileSync(jsonPath, 'utf8'));
  assert.ok(Number.isInteger(jsonContent.writer) && jsonContent.writer >= 0 && jsonContent.writer < 8, `unexpected final content: ${JSON.stringify(jsonContent)}`);

  const textPath = join(home, 'body.txt');
  const textResults = await Promise.allSettled(
    Array.from({ length: 8 }, (_, i) => writeTextAtomic(textPath, `text-${i}`)),
  );
  const textRejected = textResults.filter((r) => r.status === 'rejected');
  assert.equal(textRejected.length, 0, `writeTextAtomic rejected: ${textRejected.map((r) => r.reason).join('; ')}`);
  assert.ok(/^text-\d$/.test(readFileSync(textPath, 'utf8')), 'unexpected final text content');

  const leftovers = readdirSync(home).filter((f) => f.includes('.tmp-'));
  assert.equal(leftovers.length, 0, `tmp files leaked: ${leftovers.join(', ')}`);

  console.log('test-fs-utils-atomic-write: ok');
} finally {
  Date.now = realNow;
  rmSync(home, { recursive: true, force: true });
}
