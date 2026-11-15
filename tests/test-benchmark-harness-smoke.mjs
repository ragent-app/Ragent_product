#!/usr/bin/env node
// DS-37 benchmark harness smoke test (B0).
//
// Verifies, at small scale (no heavy concurrency, no full test suite):
//   1. the deterministic fake provider emits an identical stream for a fixed
//      seed, with attachment refs on the final message;
//   2. the harness boots a clean instance, runs the restart/reconcile
//      scenario, writes JSON + Markdown reports, and removes its temp home.
import assert from 'assert/strict';
import { spawn } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const PROVIDER = join(repoRoot, 'scripts', 'benchmarks', 'fake-provider.mjs');
const HARNESS = join(repoRoot, 'scripts', 'benchmarks', 'run-benchmark.mjs');

function runNode(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function providerDeterminism() {
  const env = {
    FAKE_PROVIDER_EVENTS: '10',
    FAKE_PROVIDER_DELAY_MS: '1',
    FAKE_PROVIDER_BODY_BYTES: '64',
    FAKE_PROVIDER_ATTACHMENT_REFS: '2',
    FAKE_PROVIDER_SEED: '7',
  };
  const first = await runNode([PROVIDER], env);
  const second = await runNode([PROVIDER], env);
  assert.equal(first.code, 0, `fake provider should exit 0: ${first.stderr}`);
  assert.equal(first.stdout, second.stdout, 'fake provider output must be deterministic for a fixed seed');

  const lines = first.stdout.trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 10 + 4, 'provider should emit thread.started + turn.started + N lines + final message + turn.completed');
  assert.equal(JSON.parse(lines[0]).type, 'thread.started');
  assert.equal(JSON.parse(lines[1]).type, 'turn.started');
  assert.equal(JSON.parse(lines[lines.length - 1]).type, 'turn.completed');
  const finalItem = JSON.parse(lines[lines.length - 2]).item;
  assert.equal(finalItem.type, 'agent_message', 'final line before turn.completed should be an agent message');
  assert.equal(finalItem.attachments.length, 2, 'attachment refs should ride on the final message');
  console.log('benchmark-fake-provider-determinism: ok');
}

async function harnessSmoke() {
  const outDir = mkdtempSync(join(tmpdir(), 'ragent-bench-out-'));
  const run = await runNode([
    HARNESS,
    '--scenario', 'restart-reconcile',
    '--events', '40',
    '--delay-ms', '15',
    '--runs', '1',
    '--seed', '1',
    '--out-dir', outDir,
  ]);
  try {
    assert.equal(run.code, 0, `harness smoke should exit 0: ${run.stderr}`);

    const summary = JSON.parse(readFileSync(join(outDir, 'restart-reconcile.json'), 'utf8'));
    assert.equal(summary.task, 'DS-37');
    assert.equal(summary.scenario, 'restart-reconcile');
    assert.equal(summary.passed, true, 'restart/reconcile smoke run should pass');
    assert.equal(summary.run.state, 'completed');
    assert.equal(summary.run.count, 1);
    assert.ok(summary.events.all > 0, 'session events should be archived');
    assert.ok(summary.events.assistantMessages >= 1, 'final assistant message should be archived');
    assert.ok(summary.disk.totalBytes > 0, 'disk metrics should be measured');
    assert.ok(summary.disk.historyFiles > 0 && summary.disk.runsFiles > 0, 'history and run stores should exist');
    assert.ok(summary.rss.peakBytes > 0, 'server RSS should be sampled');
    assert.ok(summary.phases.serverBootMs > 0, 'server boot should be timed');
    assert.ok(summary.thresholdChecks.length > 0, 'thresholds should be evaluated');
    assert.deepEqual(summary.violations, [], 'no threshold violations on smoke run');

    const md = readFileSync(join(outDir, 'restart-reconcile.md'), 'utf8');
    assert.ok(md.includes('# DS-37 Benchmark: restart-reconcile'), 'markdown report should exist with a header');
    assert.ok(md.includes('**PASS**'), 'markdown report should carry the verdict');
    assert.ok(existsSync(join(outDir, 'index.json')), 'aggregate index should be written');

    assert.equal(existsSync(summary.tempHome), false, 'harness must remove its temp home');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
  console.log('benchmark-harness-smoke: ok');
}

await providerDeterminism();
await harnessSmoke();
console.log('test-benchmark-harness-smoke: all ok');
