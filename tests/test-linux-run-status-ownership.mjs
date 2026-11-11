#!/usr/bin/env node
import assert from 'node:assert/strict';
import { chmod, chown, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.platform !== 'linux' || process.getuid?.() !== 0) {
  console.log('test-linux-run-status-ownership: skipped (requires Linux root)');
  process.exit(0);
}
const root = await mkdtemp(join(tmpdir(), 'ragent-run-owner-'));
const spool = join(root, 'results');
const runId = 'run_0123456789abcdef';
const status = join(spool, runId, 'status.json');
try {
  process.env.HOME = root;
  process.env.AGENTOC_INSTANCE_ROOT = root;
  process.env.AGENTOC_CONFIG_DIR = join(root, 'config');
  process.env.AGENTOC_RUN_SPOOL_DIR = spool;
  process.env.AGENTOC_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
  await mkdir(join(spool, runId), { recursive: true });
  await writeFile(status, JSON.stringify({ id: runId, sessionId: 'fixture', state: 'accepted' }), { mode: 0o600 });
  // A different owner reproduces the root lifecycle broker updating the
  // unprivileged control service's existing Run file.
  await chown(status, 65534, 65534);
  await chmod(status, 0o600);
  const { persistProviderPreparation } = await import('../chat/run-launcher.mjs');
  await persistProviderPreparation(runId, { state: 'failed', stage: 'provider-home' });
  const saved = JSON.parse(await readFile(status, 'utf8'));
  const info = await stat(status);
  assert.equal(saved.providerPreparation.state, 'failed');
  assert.equal(info.uid, 65534);
  assert.equal(info.gid, 65534);
  assert.equal(info.mode & 0o777, 0o600);
  console.log('test-linux-run-status-ownership: ok');
} finally {
  await rm(root, { recursive: true, force: true });
}
