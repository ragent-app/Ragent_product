#!/usr/bin/env node
// Regression: a Claude-compatible gateway may expose glm-5.3-flash in its
// live catalog while an imported profile still maps Haiku to glm-5-turbo.
// Every Claude Code request, including generate_session_title, must use the
// selected validated model rather than that stale tier mapping.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildClaudeModelContract,
  normalizeClaudeModelContract,
} from '../lib/provider-runtime/claude-model-contract.mjs';
import { createNativeProviderRegistry } from '../lib/provider-runtime/registry.mjs';
import { createSecretStore } from '../lib/provider-runtime/secret-store.mjs';
import { prepareNativeRunProviderHome } from '../lib/provider-runtime/run-provider-prepare.mjs';

const root = await mkdtemp(join(tmpdir(), 'ragent-claude-model-contract-'));
const configDir = join(root, 'config');
const homesRoot = join(root, 'homes');

try {
  const stalePolicy = {
    defaultModel: 'glm-5.2',
    sonnet: 'glm-5.2',
    opus: 'glm-5.2',
    haiku: 'glm-5-turbo',
  };
  const catalog = {
    providerProfileId: 'zai-glm',
    catalogVersion: 'catalog-53',
    status: 'fresh',
    models: [{ model: 'glm-5.3-flash' }],
  };

  const built = buildClaudeModelContract({
    providerProfileId: 'zai-glm',
    providerRevision: 'rev-1',
    requestedModel: 'glm-5.3-flash@zai-glm',
    modelPolicy: stalePolicy,
    catalog,
  });
  assert.equal(built.ok, true, built.message);
  assert.equal(built.contract.model, 'glm-5.3-flash');
  for (const value of Object.values(built.contract.aliases)) {
    assert.equal(value, 'glm-5.3-flash', 'all hidden Claude paths use the selected model');
  }

  const rejected = buildClaudeModelContract({
    providerProfileId: 'zai-glm',
    requestedModel: 'glm-5-turbo@zai-glm',
    modelPolicy: stalePolicy,
    catalog,
  });
  assert.equal(rejected.ok, false, 'an unavailable model must fail before process spawn');
  assert.equal(rejected.code, 'claude-model-contract-invalid');

  const profileDefault = buildClaudeModelContract({
    providerProfileId: 'zai-glm',
    requestedModel: '',
    modelPolicy: stalePolicy,
    catalog: { ...catalog, models: [{ model: 'glm-5.2' }] },
  });
  assert.equal(profileDefault.ok, true, 'legacy sessions without a selected model use the provider default');
  assert.equal(profileDefault.contract.model, 'glm-5.2');

  const normalized = normalizeClaudeModelContract({
    providerProfileId: 'zai-glm',
    model: 'glm-5.3-flash',
    aliases: { haiku: 'glm-5-turbo' },
  });
  assert.equal(normalized.aliases.haiku, 'glm-5.3-flash', 'stored stale aliases cannot be revived');

  const registry = createNativeProviderRegistry({ configDir });
  const secretStore = createSecretStore({ configDir });
  assert.equal((await secretStore.writeSecret('zai-key', {
    authType: 'api-key', apiKey: 'test-key',
  })).ok, true);
  assert.equal((await registry.upsertAuthProfile({
    id: 'zai-auth', agentType: 'claude', authType: 'api-key',
    displayName: 'ZAI', storageType: 'secret-store', storageRef: 'zai-key',
  })).ok, true);
  assert.equal((await registry.upsertProviderProfile({
    id: 'zai-glm', agentType: 'claude', protocol: 'anthropic-messages',
    displayName: 'ZAI GLM', baseUrl: 'https://example.invalid/anthropic',
    authProfileId: 'zai-auth', modelPolicy: stalePolicy,
  })).ok, true);

  const prepared = await prepareNativeRunProviderHome('control-model-contract', {
    tool: 'claude-bidi',
    options: {
      providerProfile: 'zai-glm',
      model: 'glm-5.3-flash@zai-glm',
      claudeModelContract: built.contract,
    },
  }, {
    configDir,
    providerHomesRoot: homesRoot,
    forceRunScopedHome: true,
  });
  assert.equal(prepared.ok, true, prepared.error || prepared.reason);
  const settings = JSON.parse(await readFile(join(prepared.claudeHomeDir, 'settings.json'), 'utf8'));
  for (const key of [
    'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_FABLE_MODEL',
    'ANTHROPIC_SMALL_FAST_MODEL',
  ]) {
    assert.equal(settings.env[key], 'glm-5.3-flash', `${key} must use the frozen Run model`);
  }
  assert.equal(prepared.snapshot.claudeModelContract.model, 'glm-5.3-flash');

  console.log('test-claude-model-contract: ok');
} finally {
  await rm(root, { recursive: true, force: true });
}
