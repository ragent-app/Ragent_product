import assert from 'node:assert/strict';
import { resolveImplicitCodexAppServerModel } from '../chat/codex-app-server-default-model.mjs';

const home = 'D:\\Ragent-QA\\codex-model-fixture';
const official = async () => ({ auth_mode: 'chatgpt', tokens: { access_token: 'fixture' } });
const staleConfig = async () => { throw new Error('stale config must not be selected'); };

assert.equal(await resolveImplicitCodexAppServerModel({
  codexHomeDir: home,
  readAuth: official,
  listModels: async () => [
    { id: 'gpt-5.6-sol', isDefault: true },
    { id: 'gpt-5.6-terra' },
  ],
  readPreferred: staleConfig,
}), 'gpt-5.6-sol');

assert.equal(await resolveImplicitCodexAppServerModel({
  codexHomeDir: home,
  readAuth: official,
  listModels: async () => [
    { id: 'gpt-6-astra', isDefault: true },
    { id: 'gpt-5.6-sol' },
  ],
  readPreferred: staleConfig,
}), 'gpt-6-astra');

assert.equal(await resolveImplicitCodexAppServerModel({
  codexHomeDir: home,
  readAuth: official,
  listModels: async () => [{ id: 'first-visible' }, { id: 'second-visible' }],
  readPreferred: staleConfig,
}), 'first-visible');

await assert.rejects(resolveImplicitCodexAppServerModel({
  codexHomeDir: home,
  readAuth: official,
  listModels: async () => [],
  readPreferred: staleConfig,
}), /CODEX_ACCOUNT_MODEL_CATALOG_EMPTY/);

await assert.rejects(resolveImplicitCodexAppServerModel({
  codexHomeDir: home,
  readAuth: official,
  listModels: async () => { throw new Error('catalog unavailable'); },
  readPreferred: staleConfig,
}), /CODEX_ACCOUNT_MODEL_CATALOG_UNAVAILABLE/);

assert.equal(await resolveImplicitCodexAppServerModel({
  codexHomeDir: home,
  readAuth: async () => ({ auth_mode: 'apikey' }),
  listModels: async () => { throw new Error('non-ChatGPT must not query catalog'); },
  readPreferred: async () => 'custom-provider-model',
}), 'custom-provider-model');

assert.equal(await resolveImplicitCodexAppServerModel({
  codexHomeDir: home,
  readAuth: async () => ({ auth_mode: 'chatgpt' }),
  listModels: async () => { throw new Error('missing login must not query catalog'); },
  readPreferred: async () => 'configured-model',
}), 'configured-model');

console.log('test-codex-app-server-default-model: ok');
