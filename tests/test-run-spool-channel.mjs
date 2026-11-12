#!/usr/bin/env node
// P0-A spool-channel contract.
//
// The sidecar runs with AGENTOC_CONFIG_DIR stripped (allowlist).  Without a
// controlled channel, CHAT_RUNS_DIR would fall back to ~/.config/agentoc and
// run-result write-back would break.  lib/config.mjs must therefore prefer
// AGENTOC_RUN_SPOOL_DIR and only then fall back to configDir/chat-runs.
import assert from 'assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const home = mkdtempSync(join(tmpdir(), 'agentoc-spool-channel-'));
// Windows runners derive the instance root from data/chat-runs; the same
// controlled path is valid on Linux and macOS.
const spoolDir = join(home, 'data', 'chat-runs');

const previousEnv = {
  HOME: process.env.HOME,
  AGENTOC_CONFIG_DIR: process.env.AGENTOC_CONFIG_DIR,
  AGENTOC_INSTANCE_ROOT: process.env.AGENTOC_INSTANCE_ROOT,
  AGENTOC_RUN_SPOOL_DIR: process.env.AGENTOC_RUN_SPOOL_DIR,
};

try {
  process.env.HOME = home;
  delete process.env.AGENTOC_CONFIG_DIR;
  delete process.env.AGENTOC_INSTANCE_ROOT;
  process.env.AGENTOC_RUN_SPOOL_DIR = spoolDir;

  // First import of lib/config.mjs in this process, so CHAT_RUNS_DIR is
  // resolved from the env above.
  const { CHAT_RUNS_DIR } = await import('../lib/config.mjs');
  assert.equal(
    CHAT_RUNS_DIR,
    spoolDir,
    'CHAT_RUNS_DIR must use the controlled AGENTOC_RUN_SPOOL_DIR channel',
  );
  assert.equal(
    CHAT_RUNS_DIR.includes(join('.config', 'agentoc')),
    false,
    'CHAT_RUNS_DIR must not fall back to ~/.config/agentoc when the spool channel is set',
  );

  console.log('test-run-spool-channel: ok');
} finally {
  if (previousEnv.HOME === undefined) delete process.env.HOME;
  else process.env.HOME = previousEnv.HOME;
  if (previousEnv.AGENTOC_CONFIG_DIR === undefined) delete process.env.AGENTOC_CONFIG_DIR;
  else process.env.AGENTOC_CONFIG_DIR = previousEnv.AGENTOC_CONFIG_DIR;
  if (previousEnv.AGENTOC_INSTANCE_ROOT === undefined) delete process.env.AGENTOC_INSTANCE_ROOT;
  else process.env.AGENTOC_INSTANCE_ROOT = previousEnv.AGENTOC_INSTANCE_ROOT;
  if (previousEnv.AGENTOC_RUN_SPOOL_DIR === undefined) delete process.env.AGENTOC_RUN_SPOOL_DIR;
  else process.env.AGENTOC_RUN_SPOOL_DIR = previousEnv.AGENTOC_RUN_SPOOL_DIR;
  rmSync(home, { recursive: true, force: true });
}
