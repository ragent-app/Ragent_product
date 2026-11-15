#!/usr/bin/env node
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'ragent-agy-direct-command-'));
const home = join(root, 'home');
const configDir = join(home, '.config', 'ragent');
const command = join(root, 'agy');
const observedFile = join(root, 'observed-home');
const terminalAgyHome = join(home, 'terminal-agy');
const original = {
  HOME: process.env.HOME,
  AGY_HOME: process.env.AGY_HOME,
  RAGENT_CONFIG_DIR: process.env.RAGENT_CONFIG_DIR,
  RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES: process.env.RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES,
  RAGENT_AGY_COMMAND: process.env.RAGENT_AGY_COMMAND,
  AGY_OBSERVED_HOME: process.env.AGY_OBSERVED_HOME,
};

try {
  await writeFile(command, `#!/bin/sh
printf '%s' "$HOME" > "$AGY_OBSERVED_HOME"
if [ "$1" = "models" ]; then
  printf 'gemini-3.7-flash\\tGemini 3.7 Flash\\n'
else
  printf '%s\\n' 'ok'
fi
`, 'utf8');
  await chmod(command, 0o755);
  process.env.HOME = home;
  process.env.AGY_HOME = terminalAgyHome;
  process.env.RAGENT_CONFIG_DIR = configDir;
  process.env.RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
  process.env.RAGENT_AGY_COMMAND = command;
  process.env.AGY_OBSERVED_HOME = observedFile;

  const { createNativeProviderRegistry } = await import('../lib/provider-runtime/registry.mjs');
  const { createSecretStore } = await import('../lib/provider-runtime/secret-store.mjs');
  const { executeAgyCommand } = await import('../lib/agy-manager.mjs');
  const { getModelsForTool } = await import('../chat/models.mjs');
  const registry = createNativeProviderRegistry({ configDir });
  const secretStore = createSecretStore({ configDir });
  await secretStore.writeSecret('agy-account-secret', {
    authType: 'oauth',
    tokens: { tokenFile: 'agy-token' },
  });
  await registry.upsertAuthProfile({
    id: 'agy-account-auth',
    agentType: 'agy',
    authType: 'oauth',
    displayName: 'AgY account',
    storageType: 'secret-store',
    storageRef: 'agy-account-secret',
  });
  assert.equal((await registry.upsertProviderProfile({
    id: 'agy-account',
    agentType: 'agy',
    protocol: 'agy',
    displayName: 'AgY account',
    baseUrl: '',
    authProfileId: 'agy-account-auth',
  })).ok, true);

  const catalog = await getModelsForTool('agy');
  assert.deepEqual(catalog.models.map((model) => model.id), ['gemini-3.7-flash@agy-account']);
  assert.match(catalog.models[0].label, /AgY account/);

  const result = await executeAgyCommand(['--version'], {
    providerProfile: 'agy-account',
    env: { AGY_OBSERVED_HOME: observedFile },
  });
  assert.equal(result.stdout.trim(), 'ok');
  const observedHome = await readFile(observedFile, 'utf8');
  assert.notEqual(observedHome, terminalAgyHome);
  assert.match(observedHome, /provider-runtime-homes[\\/]direct/);

  console.log('test-agy-direct-command-isolation: direct AgY commands use the selected managed account HOME');
} finally {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
}
