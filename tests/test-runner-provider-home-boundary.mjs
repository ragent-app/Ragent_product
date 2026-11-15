#!/usr/bin/env node

// Runner provider-home boundary contract.  The sidecar must bind Codex to the
// broker-provided per-provider home even when a user shell snapshot or the
// control service exports a personal CODEX_HOME mode.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const providerHomesDir = await mkdtemp(join(tmpdir(), 'ragent-runner-provider-home-'));
const runnerHome = await mkdtemp(join(tmpdir(), 'ragent-runner-home-'));
const previous = {
  HOME: process.env.HOME,
  CODEX_HOME: process.env.CODEX_HOME,
  RAGENT_CODEX_HOME_DIR: process.env.RAGENT_CODEX_HOME_DIR,
  RAGENT_CODEX_HOME_MODE: process.env.RAGENT_CODEX_HOME_MODE,
  RAGENT_RUNNER_LAUNCH_MODE: process.env.RAGENT_RUNNER_LAUNCH_MODE,
  RAGENT_PROVIDER_HOMES_DIR: process.env.RAGENT_PROVIDER_HOMES_DIR,
};

try {
  await mkdir(join(runnerHome, '.codex'), { recursive: true });
  await writeFile(join(runnerHome, '.codex', 'auth.json'), '{}\n', { mode: 0o600 });
  process.env.HOME = runnerHome;
  process.env.CODEX_HOME = '/home/example/.codex';
  // The explicit managed-home override is a separate compatibility escape
  // hatch. Clear host state so this test exercises provider-home selection
  // from the runner launch mode and provider-homes root.
  process.env.RAGENT_CODEX_HOME_DIR = '';
  process.env.RAGENT_CODEX_HOME_MODE = 'personal';
  process.env.RAGENT_RUNNER_LAUNCH_MODE = 'runner-lifecycle';
  process.env.RAGENT_PROVIDER_HOMES_DIR = providerHomesDir;

  const { resolveRunnerCodexHomeDir } = await import('../lib/runner-env.mjs');
  const { applyManagedRuntimeEnv } = await import('../chat/runtime-policy.mjs');
  const codexHomeDir = resolveRunnerCodexHomeDir();
  assert.equal(codexHomeDir, join(providerHomesDir, 'codex'));

  const finalEnv = await applyManagedRuntimeEnv(
    'codex',
    {
      HOME: '/home/example',
      CODEX_HOME: '/home/example/.codex',
    },
    {
      runtimeFamily: 'codex-app-server-json',
      codexHomeMode: 'managed',
      codexHomeDir,
    },
  );
  assert.equal(finalEnv.CODEX_HOME, join(providerHomesDir, 'codex'));
  assert.notEqual(finalEnv.CODEX_HOME, '/home/example/.codex');
  assert.equal(finalEnv.HOME, '/home/example');
  assert.ok(
    (await readFile(join(providerHomesDir, 'codex', 'config.toml'), 'utf8'))
      .includes('# Ragent-managed Codex runtime home.'),
    'managed runner home should be materialized before provider launch',
  );

  console.log('test-runner-provider-home-boundary: ok');
} finally {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(providerHomesDir, { recursive: true, force: true });
  await rm(runnerHome, { recursive: true, force: true });
}
