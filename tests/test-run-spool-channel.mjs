#!/usr/bin/env node
// P0-A spool-channel contract.
//
// The sidecar runs with RAGENT_CONFIG_DIR stripped (allowlist).  Without a
// controlled channel, CHAT_RUNS_DIR would fall back to ~/.config/ragent and
// run-result write-back would break.  lib/config.mjs must therefore prefer
// RAGENT_RUN_SPOOL_DIR and only then fall back to configDir/chat-runs.
import assert from 'assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const home = mkdtempSync(join(tmpdir(), 'ragent-spool-channel-'));
// Windows runners derive the instance root from data/chat-runs; the same
// controlled path is valid on Linux and macOS.
const spoolDir = join(home, 'data', 'chat-runs');

const previousEnv = {
  HOME: process.env.HOME,
  RAGENT_CONFIG_DIR: process.env.RAGENT_CONFIG_DIR,
  RAGENT_INSTANCE_ROOT: process.env.RAGENT_INSTANCE_ROOT,
  RAGENT_RUN_SPOOL_DIR: process.env.RAGENT_RUN_SPOOL_DIR,
};

try {
  process.env.HOME = home;
  delete process.env.RAGENT_CONFIG_DIR;
  delete process.env.RAGENT_INSTANCE_ROOT;
  process.env.RAGENT_RUN_SPOOL_DIR = spoolDir;

  // First import of lib/config.mjs in this process, so CHAT_RUNS_DIR is
  // resolved from the env above.
  const { CHAT_RUNS_DIR } = await import('../lib/config.mjs');
  assert.equal(
    CHAT_RUNS_DIR,
    spoolDir,
    'CHAT_RUNS_DIR must use the controlled RAGENT_RUN_SPOOL_DIR channel',
  );
  assert.equal(
    CHAT_RUNS_DIR.includes(join('.config', 'ragent')),
    false,
    'CHAT_RUNS_DIR must not fall back to ~/.config/ragent when the spool channel is set',
  );

  console.log('test-run-spool-channel: ok');
} finally {
  if (previousEnv.HOME === undefined) delete process.env.HOME;
  else process.env.HOME = previousEnv.HOME;
  if (previousEnv.RAGENT_CONFIG_DIR === undefined) delete process.env.RAGENT_CONFIG_DIR;
  else process.env.RAGENT_CONFIG_DIR = previousEnv.RAGENT_CONFIG_DIR;
  if (previousEnv.RAGENT_INSTANCE_ROOT === undefined) delete process.env.RAGENT_INSTANCE_ROOT;
  else process.env.RAGENT_INSTANCE_ROOT = previousEnv.RAGENT_INSTANCE_ROOT;
  if (previousEnv.RAGENT_RUN_SPOOL_DIR === undefined) delete process.env.RAGENT_RUN_SPOOL_DIR;
  else process.env.RAGENT_RUN_SPOOL_DIR = previousEnv.RAGENT_RUN_SPOOL_DIR;
  rmSync(home, { recursive: true, force: true });
}
