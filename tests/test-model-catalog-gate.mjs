#!/usr/bin/env node
// End-to-end gate test: synthetic provider registry → getToolModelCatalog →
// validateRunModelSelection, plus the run-launcher rejection path shape.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'ragent-model-catalog-gate-'));

try {
  // Isolated CONFIG_DIR with one synthetic codex provider + api-key secret.
  const configDir = join(root, 'config');
  await mkdir(join(configDir, 'native-provider-runtime'), { recursive: true, mode: 0o700 });
  await mkdir(join(configDir, 'native-provider-runtime', 'secrets'), { recursive: true, mode: 0o700 });
  await writeFile(
    join(configDir, 'native-provider-runtime', 'providers.json'),
    JSON.stringify({
      profiles: [{
        id: 'synthetic-provider',
        agentType: 'codex',
        protocol: 'openai-responses',
        displayName: 'Synthetic',
        baseUrl: 'https://synthetic.invalid/v1',
        authProfileId: 'auth-synthetic',
        modelPolicy: { models: [{ id: 'model-one' }, { id: 'model-two' }] },
        quotaPolicy: null,
      }],
    }, null, 2),
  );
  await writeFile(
    join(configDir, 'native-provider-runtime', 'auth-profiles.json'),
    JSON.stringify({
      profiles: [{
        id: 'auth-synthetic',
        agentType: 'codex',
        authType: 'api-key',
        displayName: 'Synthetic',
        storageType: 'secret-store',
        storageRef: 'secret-synthetic',
        accountMetadata: null,
      }],
    }, null, 2),
  );
  await writeFile(
    join(configDir, 'native-provider-runtime', 'secrets', 'secret-synthetic.json'),
    JSON.stringify({ authType: 'api-key', apiKey: 'sk-test-only-not-a-real-key' }),
  );

  process.env.RAGENT_CONFIG_DIR = configDir;
  process.env.HOME = root;
  // Fresh import so CONFIG_DIR binds to the synthetic dir.
  const { getModelsForTool, getToolModelCatalog } = await import('../chat/models.mjs');
  const { validateRunModelSelection } = await import('../lib/provider-runtime/model-catalog.mjs');

  // Multi-provider absence: with exactly one provider the tool-level catalog resolves.
  const named = await getToolModelCatalog('codex', 'synthetic-provider');
  assert.ok(named, 'named provider catalog must resolve');
  assert.equal(named.providerProfileId, 'synthetic-provider');
  assert.equal(named.models.length, 2);
  assert.ok(named.catalogVersion.length === 16);
  assert.equal(named.models.every((entry) => entry.providerProfileId === 'synthetic-provider'), true);
  assert.equal(named.models.some((entry) => entry.model === 'model-one'), true);

  const scopedModels = await getModelsForTool('codex', { providerProfile: 'synthetic-provider' });
  assert.equal(scopedModels.models.length, 2);
  assert.equal(scopedModels.models.every((entry) => entry.id.endsWith('@synthetic-provider')), true);

  const good = validateRunModelSelection({ catalog: named, model: 'model-one', providerProfileId: 'synthetic-provider' });
  assert.equal(good.ok, true);
  assert.equal(good.model, 'model-one');
  assert.equal(good.catalogVersion, named.catalogVersion);

  const bad = validateRunModelSelection({ catalog: named, model: 'not-in-catalog', providerProfileId: 'synthetic-provider' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'model-not-available');

  const crossProvider = validateRunModelSelection({ catalog: named, model: 'model-one', providerProfileId: 'another-provider' });
  assert.equal(crossProvider.ok, false);
  assert.equal(crossProvider.code, 'model-not-available');

  // Unlisted tool → no catalog → gate skips (legacy behavior preserved).
  const legacy = await getToolModelCatalog('unknown-tool', '');
  assert.equal(legacy, null);

  console.log('test-model-catalog-gate: synthetic registry catalog + run selection validation OK');
} finally {
  await rm(root, { recursive: true, force: true });
}
