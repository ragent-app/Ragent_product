#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const home = mkdtempSync(join(tmpdir(), 'ragent-claude-model-alias-'));
const configDir = join(home, '.config', 'ragent');
process.env.RAGENT_INSTANCE_ROOT = home;
process.env.RAGENT_CONFIG_DIR = configDir;
process.env.RAGENT_WORK_ROOT_DIR = join(home, 'workspace');
process.env.RAGENT_HARNESS_ROOT = join(home, 'harnesses');
process.env.RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
if (process.platform === 'win32') process.env.USERPROFILE = home;
const claudeBin = join(process.env.RAGENT_HARNESS_ROOT, 'claude', 'node_modules', '.bin');
mkdirSync(claudeBin, { recursive: true });
const fakeClaude = join(claudeBin, process.platform === 'win32' ? 'claude.cmd' : 'claude');
writeFileSync(fakeClaude, process.platform === 'win32' ? '@echo off\r\necho 2.1.310\r\n' : '#!/bin/sh\necho 2.1.310\n');
chmodSync(fakeClaude, 0o755);
const { CLAUDE_MANAGED_HOME_DIR: claudeHome } = await import('../lib/config.mjs');
mkdirSync(claudeHome, { recursive: true });
writeFileSync(
  join(claudeHome, 'settings.json'),
  JSON.stringify({
    env: {
      ANTHROPIC_MODEL: 'k3',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'k3-opus',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'k3-sonnet',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'k3-haiku',
      ANTHROPIC_SMALL_FAST_MODEL: 'k3-small',
    },
  }),
  'utf8',
);

const {
  createToolInvocation,
  resolveClaudeRuntimeModelAlias,
} = await import(pathToFileURL(join(repoRoot, 'chat', 'process-runner.mjs')).href);
const { applyManagedRuntimeEnv } = await import(pathToFileURL(join(repoRoot, 'chat', 'runtime-policy.mjs')).href);

assert.equal(await resolveClaudeRuntimeModelAlias('opus'), 'k3-opus');
assert.equal(await resolveClaudeRuntimeModelAlias('sonnet'), 'k3-sonnet');
assert.equal(await resolveClaudeRuntimeModelAlias('haiku'), 'k3-haiku');
assert.equal(await resolveClaudeRuntimeModelAlias('default'), 'k3');
assert.equal(await resolveClaudeRuntimeModelAlias('k3'), 'k3');

// Empty model should fall back to ANTHROPIC_MODEL from the managed env block,
// making it the single source of truth. Without this fallback, an empty model
// means no --model flag is passed and Claude Code falls back to settings.json's
// top-level "model" key, which can be a different model than the env block.
assert.equal(await resolveClaudeRuntimeModelAlias(''), 'k3');
assert.equal(await resolveClaudeRuntimeModelAlias(undefined), 'k3');
assert.equal(await resolveClaudeRuntimeModelAlias(null), 'k3');

// When the managed env has no ANTHROPIC_MODEL, an empty request stays empty
// rather than inventing a value.
{
  const emptyEnvHome = mkdtempSync(join(tmpdir(), 'ragent-claude-model-alias-noenv-'));
  const emptyEnvConfigDir = join(emptyEnvHome, '.config', 'ragent');
  const emptyEnvClaudeHome = join(emptyEnvConfigDir, 'provider-runtime-homes', 'claude');
  mkdirSync(emptyEnvClaudeHome, { recursive: true });
  writeFileSync(join(emptyEnvClaudeHome, 'settings.json'), JSON.stringify({ env: {} }), 'utf8');
  assert.equal(await resolveClaudeRuntimeModelAlias('', { claudeHomeDir: emptyEnvClaudeHome }), '');
  rmSync(emptyEnvHome, { recursive: true, force: true });
}

const invocation = await createToolInvocation('claude-bidi', 'hello', {
  runtimeFamily: 'claude-stream-json-bidi',
  model: 'opus',
});
const modelIndex = invocation.args.indexOf('--model');
assert.notEqual(modelIndex, -1);
assert.equal(invocation.args[modelIndex + 1], 'k3-opus');

// An empty model must still resolve to --model k3 (the ANTHROPIC_MODEL env
// value), proving the env block drives the launched process instead of being
// bypassed by a missing --model flag.
const emptyModelInvocation = await createToolInvocation('claude-bidi', 'hello', {
  runtimeFamily: 'claude-stream-json-bidi',
  model: '',
});
const emptyModelIndex = emptyModelInvocation.args.indexOf('--model');
assert.notEqual(emptyModelIndex, -1);
assert.equal(emptyModelInvocation.args[emptyModelIndex + 1], 'k3');

const runtimeEnv = await applyManagedRuntimeEnv('claude-bidi', { TEST_VALUE: 'ok' }, {
  runtimeFamily: 'claude-stream-json-bidi',
});
const claudeBridgeHome = claudeHome;
assert.equal(runtimeEnv.CLAUDE_CONFIG_DIR, claudeHome);
assert.equal(runtimeEnv.HOME, claudeBridgeHome);
assert.equal(runtimeEnv.TEST_VALUE, 'ok');
assert.equal(runtimeEnv.ANTHROPIC_MODEL, 'k3');
assert.equal(runtimeEnv.ANTHROPIC_DEFAULT_OPUS_MODEL, 'k3-opus');
assert.equal(runtimeEnv.ANTHROPIC_DEFAULT_SONNET_MODEL, 'k3-sonnet');
assert.equal(runtimeEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'k3-haiku');
assert.equal(runtimeEnv.ANTHROPIC_SMALL_FAST_MODEL, 'k3-small');
assert.equal(runtimeEnv.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST, '1');
assert.equal(runtimeEnv.CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP, '1');
if (process.platform !== 'win32') {
  assert.equal(readlinkSync(join(claudeBridgeHome, '.claude')), claudeHome);
  assert.ok(lstatSync(join(claudeBridgeHome, '.claude')).isSymbolicLink());
}


// Older provider exports may omit ANTHROPIC_SMALL_FAST_MODEL and
// without the Claude host-managed switches. Ragent must add them before
// spawning Claude Code so opus/sonnet/haiku aliases do not fall through to
// Claude Code's legacy model remap defaults.
{
  const noSmallFastHome = mkdtempSync(join(tmpdir(), 'ragent-claude-managed-env-'));
  const noSmallFastConfigDir = join(noSmallFastHome, '.config', 'ragent');
  const noSmallFastClaudeHome = join(noSmallFastConfigDir, 'provider-runtime-homes', 'claude');
  const noSmallFastBridgeHome = join(noSmallFastConfigDir, 'provider-runtime-homes', 'claude');
  mkdirSync(noSmallFastClaudeHome, { recursive: true });
  writeFileSync(join(noSmallFastClaudeHome, 'settings.json'), JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: 'https://example.invalid/anthropic',
      ANTHROPIC_MODEL: 'provider-main',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'provider-haiku',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'provider-sonnet',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'provider-opus',
    },
  }), 'utf8');
  const managedEnv = await applyManagedRuntimeEnv('claude-bidi', {}, {
    runtimeFamily: 'claude-stream-json-bidi',
    claudeHomeDir: noSmallFastClaudeHome,
    claudeHomeBridgeDir: noSmallFastBridgeHome,
  });
  assert.equal(managedEnv.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST, '1');
  assert.equal(managedEnv.CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP, '1');
  assert.equal(managedEnv.ANTHROPIC_SMALL_FAST_MODEL, 'provider-haiku');
  rmSync(noSmallFastHome, { recursive: true, force: true });
}

rmSync(home, { recursive: true, force: true });
console.log('test-claude-runtime-model-alias: ok');
