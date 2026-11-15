#!/usr/bin/env node
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'ragent-provider-model-capabilities-'));
const configDir = join(home, 'config');
mkdirSync(configDir, { recursive: true });
process.env.RAGENT_INSTANCE_ROOT = home;
process.env.RAGENT_CONFIG_DIR = configDir;
process.env.RAGENT_HARNESS_ROOT = join(home, 'harnesses');
process.env.RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
if (process.platform === 'win32') process.env.USERPROFILE = home;
const claudeBin = join(process.env.RAGENT_HARNESS_ROOT, 'claude', 'node_modules', '.bin');
mkdirSync(claudeBin, { recursive: true });
const fakeClaude = join(claudeBin, process.platform === 'win32' ? 'claude.cmd' : 'claude');
writeFileSync(fakeClaude, process.platform === 'win32' ? '@echo off\r\necho 2.1.310\r\n' : '#!/bin/sh\necho 2.1.310\n');
chmodSync(fakeClaude, 0o755);

const originalFetch = globalThis.fetch;
try {
  const { createNativeProviderRegistry, createSecretStore } = await import('../lib/provider-runtime/index.mjs');
  const registry = createNativeProviderRegistry({ configDir });
  const secretStore = createSecretStore({ configDir });
  await secretStore.writeSecret('claude-capability-secret', {
    authType: 'api-key',
    apiKey: 'claude-capability-key',
  });
  await registry.upsertAuthProfile({
    id: 'claude-capability-auth',
    agentType: 'claude',
    authType: 'api-key',
    displayName: 'Capability Claude',
    storageType: 'secret-store',
    storageRef: 'claude-capability-secret',
  });
  await registry.upsertProviderProfile({
    id: 'claude-capability-provider',
    agentType: 'claude',
    protocol: 'anthropic-messages',
    displayName: 'Capability Claude',
    baseUrl: 'https://claude-relay.example/v1',
    authProfileId: 'claude-capability-auth',
    modelPolicy: { defaultModel: 'claude-opus-4-6' },
  });

  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push(String(url));
    assert.equal(String(url), 'https://claude-relay.example/v1/models');
    assert.equal(options.headers?.Authorization, 'Bearer claude-capability-key');
    return new Response(JSON.stringify({
      data: [
        {
          id: 'claude-opus-4-6',
          display_name: 'Claude Opus 4.6',
          supported_reasoning_levels: ['low', 'medium', 'high'],
          default_effort: 'high',
        },
        { id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5' },
        { id: 'other-model', display_name: 'Other' },
      ],
      model_capabilities: {
        'claude-haiku-4-5': { supports_reasoning: false },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const { getModelsForTool, parseModelCapabilities } = await import('../chat/models.mjs');
  const result = await getModelsForTool('claude');
  const opus = result.models.find((model) => model.id === 'claude-opus-4-6@claude-capability-provider');
  const haiku = result.models.find((model) => model.id === 'claude-haiku-4-5@claude-capability-provider');

  assert.deepEqual(opus.effortLevels, ['low', 'medium', 'high']);
  assert.equal(opus.defaultEffort, 'high');
  assert.deepEqual(opus.capabilities.effort, {
    supported: true,
    levels: ['low', 'medium', 'high'],
    default: 'high',
    source: 'upstream',
  });
  assert.equal(haiku.capabilities.effort.supported, false, 'top-level model capability maps must be applied');
  assert.equal(Object.hasOwn(haiku, 'effortLevels'), false);
  assert.equal(Object.hasOwn(haiku, 'reasoning'), true);
  assert.equal(haiku.reasoning.kind, 'none');
  const other = result.models.find((model) => model.id === 'other-model@claude-capability-provider');
  assert.deepEqual(other.effortLevels, ['none', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(other.defaultEffort, 'medium');
  assert.equal(other.capabilities.effort.source, 'builtin');
  assert.ok(calls.length >= 1);

  assert.deepEqual(
    parseModelCapabilities({
      reasoning: { supported_levels: ['minimal', 'medium'] },
      capabilities: { serviceTier: { supportsFast: true } },
    }),
    {
      effort: { supported: true, levels: ['minimal', 'medium'], source: 'upstream' },
      serviceTier: { supportsFast: true, values: ['standard', 'fast'], source: 'upstream' },
    },
  );
  assert.equal(parseModelCapabilities({}).effort.supported, null);
  assert.equal(parseModelCapabilities({}).serviceTier.supportsFast, null);

  console.log('test-provider-model-capabilities: upstream effort metadata and unknown state OK');
} finally {
  globalThis.fetch = originalFetch;
  rmSync(home, { recursive: true, force: true });
}
