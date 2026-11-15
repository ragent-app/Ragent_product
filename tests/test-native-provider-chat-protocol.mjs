#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createNativeProviderRegistry } from '../lib/provider-runtime/registry.mjs';
import { createSecretStore } from '../lib/provider-runtime/secret-store.mjs';
import { resolveRuntimeConfig } from '../lib/provider-runtime/resolver.mjs';
import { prepareCodexRuntime } from '../lib/provider-runtime/adapters.mjs';

const configDir = await mkdtemp(join(tmpdir(), 'ragent-native-provider-chat-'));
const registry = createNativeProviderRegistry({ configDir });
const secretStore = createSecretStore({ configDir });

try {
  await secretStore.writeSecret('chat-key', { authType: 'api-key', apiKey: 'sk-chat-test' });
  assert.equal((await registry.upsertAuthProfile({
    id: 'chat-auth',
    agentType: 'codex',
    authType: 'api-key',
    displayName: 'Chat API key',
    storageType: 'secret-store',
    storageRef: 'chat-key',
  })).ok, true);
  assert.equal((await registry.upsertProviderProfile({
    id: 'chat-provider',
    agentType: 'codex',
    protocol: 'openai-chat',
    displayName: 'Chat provider',
    baseUrl: 'https://api.example/v1',
    authProfileId: 'chat-auth',
    modelPolicy: { defaultModel: 'gpt-chat' },
  })).ok, true);

  const snapshot = await resolveRuntimeConfig({
    runRequest: {
      runId: 'chat-run',
      agentType: 'codex',
      providerProfileId: 'chat-provider',
      model: 'gpt-chat',
    },
    registry,
    secretStore,
  });
  const runtime = await prepareCodexRuntime(snapshot, {
    runtimeRoot: join(configDir, 'runtime'),
    secretStore,
    baseEnv: {},
  });
  assert.equal(runtime.ok, true, runtime.reason);
  const config = await readFile(join(runtime.codexHomeDir, 'config.toml'), 'utf8');
  assert.match(config, /wire_api = "responses"/);
  assert.doesNotMatch(config, /requires_openai_auth = true/);
  assert.equal(runtime.env.RAGENT_RUNTIME_API_KEY, 'sk-chat-test');
  console.log('test-native-provider-chat-protocol: Chat upstream metadata with Responses client wire config OK');
} finally {
  await rm(configDir, { recursive: true, force: true });
}
