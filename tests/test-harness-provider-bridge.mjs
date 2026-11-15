import assert from 'node:assert/strict';
import {
  buildHarnessProviderFiles,
  getHarnessProviderProtocols,
  resolveHarnessProviderCompatibility,
} from '../lib/provider-runtime/harness-bridge.mjs';

const claudeProfile = { protocol: 'anthropic-messages', baseUrl: 'https://gateway.example/v1' };
const codexProfile = { protocol: 'openai-chat', baseUrl: 'https://gateway.example/v1' };

for (const harness of ['pi', 'qwen-code', 'opencode', 'kimi-code', 'goose', 'openhands', 'copilot', 'hermes', 'cline', 'kilo']) {
  assert.ok(getHarnessProviderProtocols(harness).includes('openai-chat'));
  assert.equal(resolveHarnessProviderCompatibility(harness, claudeProfile).ok, true);
  assert.equal(resolveHarnessProviderCompatibility(harness, codexProfile).ok, true);
  const result = buildHarnessProviderFiles(harness, { ...codexProfile, model: 'test-model' }, { authType: 'api-key', apiKey: 'secret' });
  assert.equal(result.ok, true);
  assert.match(result.files[0].content, /RAGENT_PROVIDER_PROTOCOL="openai-chat"/);
  assert.ok(result.files.some((file) => file.name === '.ragent-provider.env'));
}

assert.equal(resolveHarnessProviderCompatibility('pi', { protocol: 'agy' }).ok, false);
assert.equal(buildHarnessProviderFiles('pi', { ...codexProfile, model: 'test-model' }, { authType: 'oauth', tokens: {} }).reason, 'harness-provider-api-key-required');
const goose = buildHarnessProviderFiles('goose', { ...codexProfile, model: 'test-model' }, { authType: 'api-key', apiKey: 'secret' });
assert.match(goose.files[0].content, /GOOSE_PROVIDER="openai"/);
assert.match(goose.files[0].content, /OPENAI_HOST="https:\/\/gateway.example\/v1"/);
const qwen = buildHarnessProviderFiles('qwen-code', { ...codexProfile, model: 'test-model' }, { authType: 'api-key', apiKey: 'secret' });
const qwenSettings = JSON.parse(qwen.files.find((file) => file.name === '.qwen/settings.json').content);
assert.ok(qwenSettings.modelProviders.openai);
assert.equal(qwenSettings.security.auth.selectedType, 'openai');
assert.equal(qwenSettings.model.name, 'test-model');
const kimi = buildHarnessProviderFiles('kimi-code', { protocol: 'openai-responses', baseUrl: 'https://gateway.example/v1', model: 'test-model' }, { authType: 'api-key', apiKey: 'secret' });
const kimiConfig = kimi.files.find((file) => file.name === '.kimi-code/config.toml').content;
assert.match(kimiConfig, /type = "openai_responses"/);
assert.match(kimiConfig, /api_key = "secret"/);
const kimiChat = buildHarnessProviderFiles('kimi-code', { ...codexProfile, model: 'test-model' },
  { authType: 'api-key', apiKey: 'secret' }).files.find((file) => file.name === '.kimi-code/config.toml').content;
assert.match(kimiChat, /type = "openai"/);
assert.doesNotMatch(kimiChat, /openai_legacy/);
const copilot = buildHarnessProviderFiles('copilot', {
  protocol: 'github-copilot', baseUrl: '', model: 'gpt-4o',
}, { authType: 'api-key', apiKey: 'github-pat' });
assert.equal(copilot.ok, true);
assert.match(copilot.files[0].content, /GH_TOKEN="github-pat"/);
assert.match(copilot.files[0].content, /COPILOT_MODEL="gpt-4o"/);
assert.doesNotMatch(copilot.files[0].content, /base_url/);
assert.doesNotMatch(copilot.files[0].content, /OPENAI_API_KEY/);
assert.doesNotMatch(copilot.files[0].content, /ANTHROPIC_API_KEY/);
const hermes = buildHarnessProviderFiles('hermes', {
  protocol: 'anthropic-messages', baseUrl: 'https://anthropic.example/v1', model: 'claude-sonnet',
}, { authType: 'api-key', apiKey: 'secret' });
assert.equal(hermes.ok, true);
assert.match(hermes.files.find((file) => file.name === 'config.yaml').content, /provider: "ragent"/);
assert.match(hermes.files.find((file) => file.name === 'config.yaml').content, /transport: anthropic_messages/);
const cline = buildHarnessProviderFiles('cline', {
  protocol: 'openai-chat', baseUrl: 'https://gateway.example/v1', model: 'test-model',
}, { authType: 'api-key', apiKey: 'secret' });
assert.equal(cline.ok, true);
const clineSettings = cline.files.find((file) => file.name === 'settings/providers.json');
assert.ok(clineSettings);
assert.match(clineSettings.content, /"lastUsedProvider": "openai-native"/);
assert.match(clineSettings.content, /"model": "test-model"/);
assert.doesNotMatch(clineSettings.content, /secret/);
const kilo = buildHarnessProviderFiles('kilo', {
  protocol: 'openai-chat', baseUrl: 'https://gateway.example/v1', model: 'test-model',
}, { authType: 'api-key', apiKey: 'secret' });
assert.equal(kilo.ok, true);
const kiloConfig = kilo.files.find((file) => file.name === 'kilo.jsonc');
assert.ok(kiloConfig);
assert.match(kiloConfig.content, /"model": "ragent\/test-model"/);
assert.match(kiloConfig.content, /"npm": "@ai-sdk\/openai-compatible"/);
assert.match(kiloConfig.content, /"env": \[\s*"RAGENT_PROVIDER_API_KEY"\s*\]/);
assert.match(kiloConfig.content, /"baseURL": "https:\/\/gateway\.example\/v1"/);
assert.match(kiloConfig.content, /"context": 128000/);
assert.doesNotMatch(kiloConfig.content, /"apiKey"/);
assert.doesNotMatch(kiloConfig.content, /secret/);
console.log('harness provider bridge tests passed');
