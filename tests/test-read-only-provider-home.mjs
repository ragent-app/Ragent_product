import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { buildSandboxedSpawn, isBwrapPresent } from '../lib/runner-sandbox.mjs';
import { openReadOnlyProviderSeeds, closeReadOnlyProviderSeeds, deliverReadOnlyProviderSeeds } from '../chat/read-only-provider-home.mjs';

const root = mkdtempSync(join(realpathSync(tmpdir()), 'agentoc-ro-provider-'));
try {
  const workspace = join(root, 'project');
  const runId = 'isolated-fixture';
  const runKey = createHash('sha256').update(runId).digest('hex').slice(0, 32);
  const home = join(root, 'by-run', runKey, 'codex');
  mkdirSync(workspace); mkdirSync(home, { recursive: true });
  const auth = join(home, 'auth.json');
  const config = join(home, 'config.toml');
  const sourceAuth = JSON.stringify({ OPENAI_API_KEY: 'fixture-key' });
  writeFileSync(auth, sourceAuth, { mode: 0o600 });
  writeFileSync(config, 'model = "fixture"\n', { mode: 0o600 });
  const seeds = openReadOnlyProviderSeeds({ family: 'codex', env: { CODEX_HOME: home }, runId });
  let sandbox;
  try {
    assert.equal(seeds.seeds.length, 2);
    sandbox = buildSandboxedSpawn({ command: '/bin/sh', cwd: workspace, readOnly: true,
      bindReadOnlyPaths: [workspace], readOnlyProviderSeeds: seeds.seeds, readOnlyProviderFamily: seeds.family,
      args: ['-c', 'test -f "$CODEX_HOME/auth.json" && test -f "$CODEX_HOME/config.toml" && test -d "$HOME" && echo scratch > "$HOME/.cache/example" && echo changed > "$CODEX_HOME/config.toml" && test "$(cat "$CODEX_HOME/config.toml")" = changed'] });
    if (isBwrapPresent()) {
      const child = spawn(sandbox.command, sandbox.args, { stdio: ['ignore', 'pipe', 'pipe', ...seeds.seeds.map(() => 'pipe')] });
      let stderr = '';
      child.stderr.setEncoding('utf8'); child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.stdout.resume();
      deliverReadOnlyProviderSeeds(child, seeds);
      const status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
      if (status !== 0 && /Operation not permitted/u.test(stderr)) {
        console.log('Read-only provider sandbox execution unavailable on this host');
      } else {
        assert.equal(status, 0, `isolated provider home failed: ${stderr}`);
        assert.equal(readFileSync(config, 'utf8'), 'model = "fixture"\n');
        assert.equal(readFileSync(auth, 'utf8'), sourceAuth);
        console.log('Read-only provider used a writable tmpfs home without changing source files');
      }
    }
  } finally {
    closeReadOnlyProviderSeeds(seeds);
    if (sandbox) rmSync(sandbox.emptyDir, { recursive: true, force: true });
  }
  assert.throws(() => openReadOnlyProviderSeeds({ family: 'codex', env: { CODEX_HOME: home }, runId: 'another-run' }),
    { code: 'READ_ONLY_PROVIDER_HOME_UNAVAILABLE' });
  const claudeHome = join(root, 'by-run', runKey, 'claude');
  mkdirSync(claudeHome, { recursive: true });
  writeFileSync(join(claudeHome, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_API_KEY: 'fixture-key' } }));
  const claudeSeeds = openReadOnlyProviderSeeds({ family: 'claude', env: { CLAUDE_CONFIG_DIR: claudeHome }, runId });
  let claudeSandbox;
  try {
    assert.equal(claudeSeeds.seeds.length, 1);
    claudeSandbox = buildSandboxedSpawn({ command: '/bin/sh', cwd: workspace, readOnly: true,
      bindReadOnlyPaths: [workspace], readOnlyProviderSeeds: claudeSeeds.seeds, readOnlyProviderFamily: claudeSeeds.family,
      args: ['-c', 'test -f "$CLAUDE_CONFIG_DIR/settings.json" && echo test > "$CLAUDE_CONFIG_DIR/writable"'] });
    if (isBwrapPresent()) {
      const child = spawn(claudeSandbox.command, claudeSandbox.args, { stdio: ['ignore', 'pipe', 'pipe', ...claudeSeeds.seeds.map(() => 'pipe')] });
      let stderr = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', (chunk) => { stderr += chunk; }); child.stdout.resume();
      deliverReadOnlyProviderSeeds(child, claudeSeeds);
      const status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
      if (!(status !== 0 && /Operation not permitted/u.test(stderr))) assert.equal(status, 0, `Claude isolated home failed: ${stderr}`);
    }
  } finally {
    closeReadOnlyProviderSeeds(claudeSeeds);
    if (claudeSandbox) rmSync(claudeSandbox.emptyDir, { recursive: true, force: true });
  }
  writeFileSync(join(claudeHome, '.credentials.json'), JSON.stringify({ claudeAiOauth: { refreshToken: 'fake' } }));
  assert.throws(() => openReadOnlyProviderSeeds({ family: 'claude', env: { CLAUDE_CONFIG_DIR: claudeHome }, runId }),
    { code: 'READ_ONLY_PROVIDER_HOME_UNAVAILABLE' });
  writeFileSync(auth, JSON.stringify({ auth_mode: 'chatgpt', tokens: { refresh_token: 'fake' } }));
  assert.throws(() => openReadOnlyProviderSeeds({ family: 'codex', env: { CODEX_HOME: home }, runId }), { code: 'READ_ONLY_PROVIDER_HOME_UNAVAILABLE' });
  rmSync(auth); symlinkSync(config, auth);
  assert.throws(() => openReadOnlyProviderSeeds({ family: 'codex', env: { CODEX_HOME: home }, runId }), { code: 'READ_ONLY_PROVIDER_HOME_UNAVAILABLE' });
  console.log('read-only provider home checks passed');
} finally { rmSync(root, { recursive: true, force: true }); }
