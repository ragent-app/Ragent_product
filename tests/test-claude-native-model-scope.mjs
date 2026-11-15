#!/usr/bin/env node
// Native-mode claude model scoping: the registry keeps the model env contract,
// prepare regenerates it into the scoped home, /api/models emits per-provider
// tier entries, and the alias resolver strips the `@providerId` suffix before
// the tier alias lookup.  Regression: without these, every claude provider
// showed only the single managed-home model and z.ai served glm-4.7 for a
// glm-5.2 selection.
import assert from 'assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const root = mkdtempSync(join(tmpdir(), 'ragent-claude-native-scope-'));
process.env.HOME = root;
process.env.RAGENT_CONFIG_DIR = join(root, 'config');

try {
  // 1. /api/models (claude) enumerates registry profiles per provider.
  const { createNativeProviderRegistry, createSecretStore } = await import('../lib/provider-runtime/index.mjs');
  const configDir = process.env.RAGENT_CONFIG_DIR;
  mkdirSync(join(configDir, 'native-provider-runtime'), { recursive: true });
  const registry = createNativeProviderRegistry({ configDir });
  const secretStore = createSecretStore({ configDir });
  assert.equal((await secretStore.writeSecret('zai-secret', { authType: 'api-key', apiKey: 'sk-zai' })).ok, true);
  assert.equal((await registry.upsertAuthProfile({
    id: 'auth-zai', agentType: 'claude', authType: 'api-key',
    displayName: 'zai auth', storageType: 'secret-store', storageRef: 'zai-secret',
  })).ok, true);
  assert.equal((await registry.upsertProviderProfile({
    id: 'zai-glm', agentType: 'claude', protocol: 'anthropic-messages',
    displayName: 'zai-glm', baseUrl: 'https://api.z.ai/api/anthropic',
    authProfileId: 'auth-zai',
    modelPolicy: { defaultModel: 'glm-5.2', sonnet: 'glm-5.2', opus: 'glm-5.2', haiku: 'glm-5-turbo' },
  })).ok, true);
  assert.equal((await registry.upsertProviderProfile({
    id: 'ds-claude', agentType: 'claude', protocol: 'anthropic-messages',
    displayName: 'deepseek-claude', baseUrl: 'https://api.deepseek.com/anthropic',
    authProfileId: 'auth-zai',
    modelPolicy: { defaultModel: 'deepseek-v4-flash' },
  })).ok, true);

  const { getModelsForTool } = await import('../chat/models.mjs');
  const claudeModels = await getModelsForTool('claude');
  const ids = claudeModels.models.map((m) => m.id);
  // Live /v1/models discovery is unreachable for the fixture's fake keys, so
  // the catalog falls back to the modelPolicy targets.  Entries now carry the
  // concrete model id (one config exposes every usable model), not the tier
  // alias names.
  // glm-5.2 has a 1M window in the static fallback table → the catalog entry
  // carries the `[1m]` suffix Claude Code reads to opt into 1M context; the
  // 200k-class glm-5-turbo and deepseek entries keep the bare id.
  assert.ok(ids.includes('glm-5.2[1m]@zai-glm'), `expected glm-5.2[1m]@zai-glm in ${JSON.stringify(ids)}`);
  assert.ok(ids.includes('glm-5-turbo@zai-glm'), `expected glm-5-turbo@zai-glm in ${JSON.stringify(ids)}`);
  assert.ok(ids.includes('deepseek-v4-flash@ds-claude'), `expected deepseek-v4-flash@ds-claude in ${JSON.stringify(ids)}`);
  assert.ok(!ids.includes('sonnet'), 'unscoped alias must not appear in native mode');
  const glmZai = claudeModels.models.find((m) => m.id === 'glm-5.2[1m]@zai-glm');
  assert.ok(/glm-5\.2/.test(glmZai.label), `label carries the model name: ${glmZai.label}`);
  assert.equal(glmZai.contextWindow, 1_000_000, 'context window exposed on the catalog entry');
  const haikuZai = claudeModels.models.find((m) => m.id === 'glm-5-turbo@zai-glm');
  assert.ok(/glm-5-turbo/.test(haikuZai.label), `haiku keeps its own target: ${haikuZai.label}`);

  // 2. Alias resolution strips the provider suffix.
  const scopedHome = join(root, 'scoped-home');
  mkdirSync(scopedHome, { recursive: true });
  writeFileSync(join(scopedHome, 'settings.json'), JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
      ANTHROPIC_API_KEY: 'sk-zai',
      ANTHROPIC_MODEL: 'glm-5.2',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.2',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.2',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5-turbo',
    },
  }), 'utf8');
  const { resolveClaudeRuntimeModelAlias } = await import('../chat/process-runner.mjs');
  assert.equal(
    await resolveClaudeRuntimeModelAlias('sonnet@zai-glm', { claudeHomeDir: scopedHome }),
    'glm-5.2',
    'scoped sonnet alias resolves through the provider env',
  );
  assert.equal(
    await resolveClaudeRuntimeModelAlias('haiku@zai-glm', { claudeHomeDir: scopedHome }),
    'glm-5-turbo',
  );
  assert.equal(
    await resolveClaudeRuntimeModelAlias('glm-5.2', { claudeHomeDir: scopedHome }),
    'glm-5.2',
    'concrete model ids pass through untouched',
  );
  assert.equal(
    await resolveClaudeRuntimeModelAlias('glm-5.2[1m]@zai-glm', { claudeHomeDir: scopedHome }),
    'glm-5.2[1m]',
    'the [1m] long-context suffix survives alias resolution and reaches --model',
  );

  // 3. Served-model context window lands on the usage event.
  const { lookupModelContextWindowTokens } = await import('../chat/model-context-windows.mjs');
  assert.equal(lookupModelContextWindowTokens('glm-5.2'), 1_000_000);
  assert.equal(lookupModelContextWindowTokens('glm-4.7'), 200_000);
  assert.equal(lookupModelContextWindowTokens('no-such-model'), null);

  const { createClaudeAdapter } = await import('../chat/adapters/claude.mjs');
  const adapter = createClaudeAdapter();
  const events = [];
  for (const line of [
    JSON.stringify({ type: 'stream_event', session_id: 's1', event: { type: 'message_start', message: { model: 'glm-5.2', usage: { input_tokens: 0, output_tokens: 0 } } } }),
    JSON.stringify({ type: 'result', session_id: 's1', usage: { input_tokens: 1000, output_tokens: 50 } }),
  ]) {
    events.push(...adapter.parseLine(line));
  }
  const usage = events.filter((e) => e.type === 'usage').pop();
  assert.ok(usage, 'usage event emitted');
  assert.equal(usage.contextWindowTokens, 1_000_000, 'glm-5.2 window attached from served model');

  console.log('test-claude-native-model-scope: ok');
} finally {
  rmSync(root, { recursive: true, force: true });
}
