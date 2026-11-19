#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(fileURLToPath(new URL('../', import.meta.url)));
const fixtureRoot = join(root, 'tests/fixtures/risk-datasets');
const manifest = JSON.parse(readFileSync(join(fixtureRoot, 'manifest.json'), 'utf8'));

for (const dataset of manifest.datasets) {
  const content = readFileSync(join(fixtureRoot, dataset.path));
  // Windows checkouts with core.autocrlf=true may materialize LF fixtures as CRLF;
  // verify LF-canonical bytes on win32 and exact bytes on POSIX CI.
  const verifiedContent = process.platform === 'win32' && !content.includes(0)
    ? Buffer.from(content.toString('utf8').replaceAll('\r\n', '\n'), 'utf8')
    : content;
  assert.equal(
    createHash('sha256').update(verifiedContent).digest('hex'),
    dataset.sha256,
    `${dataset.id} fixture must stay pinned by SHA-256`,
  );
  const rows = content.toString('utf8').trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(rows.length, dataset.records, `${dataset.id} record count must stay pinned`);
}

if (process.platform === 'win32') {
  console.log('risk-dataset-benchmark: fixture integrity verified (POSIX classifier smoke requires non-win32 host)');
} else {
  const result = spawnSync(process.execPath, ['scripts/risk-dataset-benchmark.mjs', '--smoke'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.ok, true);
  assert.equal(summary.policyVersion, 'risk-v3');
  assert.equal(summary.unsafeAsSafe, 0);
  assert.equal(summary.hardFailureCount, 0);
  assert.equal(summary.stability.unstable, 0);
  assert.ok(summary.performance.throughputPerSecond > 0);

  console.log(`risk-dataset-benchmark: ${summary.records} smoke records, unsafe-as-safe=0`);
}
