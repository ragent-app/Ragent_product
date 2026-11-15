#!/usr/bin/env node
// Provider Profile -> bridged Harness catalog contract.  This intentionally
// uses an unreachable endpoint so the test proves configured-model fallback
// without making a network request part of the test suite.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'ragent-bridged-catalog-'));
try {
  const configDir = join(root, 'config');
  const runtimeDir = join(configDir, 'native-provider-runtime');
  await mkdir(join(runtimeDir, 'secrets'), { recursive: true, mode: 0o700 });
  await writeFile(join(runtimeDir, 'providers.json'), JSON.stringify({ profiles: [
    {
      id: 'openai-source', agentType: 'codex', protocol: 'openai-chat',
      displayName: 'OpenAI source', baseUrl: 'https://catalog.invalid/v1',
      authProfileId: 'auth-openai', modelPolicy: { models: [{ id: 'model-a' }] },
    },
    {
      id: 'anthropic-source', agentType: 'claude', protocol: 'anthropic-messages',
      displayName: 'Anthropic source', baseUrl: 'https://catalog.invalid',
      authProfileId: 'auth-anthropic', modelPolicy: { defaultModel: 'model-b' },
    },
  ] }));
  await writeFile(join(runtimeDir, 'auth-profiles.json'), JSON.stringify({ profiles: [
    { id: 'auth-openai', agentType: 'codex', authType: 'api-key', storageType: 'secret-store', storageRef: 'secret-openai' },
    { id: 'auth-anthropic', agentType: 'claude', authType: 'api-key', storageType: 'secret-store', storageRef: 'secret-anthropic' },
  ] }));
  await writeFile(join(runtimeDir, 'secrets', 'secret-openai.json'), JSON.stringify({ authType: 'api-key', apiKey: 'sk-test-openai' }));
  await writeFile(join(runtimeDir, 'secrets', 'secret-anthropic.json'), JSON.stringify({ authType: 'api-key', apiKey: 'sk-test-anthropic' }));

  process.env.RAGENT_CONFIG_DIR = configDir;
  process.env.HOME = root;
  const { getModelsForTool, getToolModelCatalog } = await import('../chat/models.mjs');
  const openCode = await getModelsForTool('opencode');
  assert.deepEqual(openCode.models.map((model) => model.id), [
    'model-a@openai-source',
    'model-b@anthropic-source',
  ]);
  const openHands = await getToolModelCatalog('openhands', 'anthropic-source');
  assert.ok(openHands);
  assert.equal(openHands.models[0].model, 'model-b');
  assert.equal(openHands.models[0].providerProfileId, 'anthropic-source');
  const openHandsModels = await getModelsForTool('openhands');
  assert.equal(openHandsModels.serviceRequired, true);
  assert.equal(openHandsModels.serviceRuntimeFamily, 'openhands-agent-server');
  console.log('test-bridged-harness-model-catalog: protocol-filtered catalog OK');
} finally {
  await rm(root, { recursive: true, force: true });
}
