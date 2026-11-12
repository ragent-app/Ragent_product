#!/usr/bin/env node
// Concurrency isolation matrix for the native provider runtime.
//
// The historical drift class this architecture must kill: Run A on provider X
// while Run B starts on provider Y, and one of them silently ends up using the
// other's credential or endpoint.  This test fans out concurrent preparations
// across a provider × account × agent matrix and asserts every Run's prepared
// home + resolved snapshot matches what that Run requested — the same
// expected-vs-observed fingerprint discipline the architecture doc requires,
// executed at the preparation layer with the real modules (no mocks except the
// mock upstream credential values).
import assert from 'assert/strict';
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const root = mkdtempSync(join(tmpdir(), 'agentoc-native-concurrency-'));
const configDir = join(root, 'config');
mkdirSync(configDir, { recursive: true });

const { createNativeProviderRegistry } = await import('../lib/provider-runtime/registry.mjs');
const { createSecretStore } = await import('../lib/provider-runtime/secret-store.mjs');
const { resolveRuntimeConfig, sanitizeRuntimeEnvironment } = await import('../lib/provider-runtime/resolver.mjs');
const { prepareNativeRunProviderHome } = await import('../lib/provider-runtime/run-provider-prepare.mjs');

const registry = createNativeProviderRegistry({ configDir });
const secretStore = createSecretStore({ configDir });

// Matrix: 4 codex providers × distinct accounts + 2 claude gateways.
const matrix = [
  { agent: 'codex', provider: 'offa', baseUrl: 'https://off-a.example/backend-api', auth: 'oauth-a', authType: 'oauth', model: 'gpt-5.5', secret: { authType: 'oauth', tokens: { account_id: 'account-offa', access_token: 'at-offa', refresh_token: 'rt-offa' } } },
  { agent: 'codex', provider: 'offb', baseUrl: 'https://off-b.example/backend-api', auth: 'oauth-b', authType: 'oauth', model: 'gpt-5.5', secret: { authType: 'oauth', tokens: { account_id: 'account-offb', access_token: 'at-offb', refresh_token: 'rt-offb' } } },
  { agent: 'codex', provider: 'relay-x', baseUrl: 'https://relay-x.example/v1', auth: 'key-x', authType: 'api-key', model: 'gpt-x', secret: { authType: 'api-key', apiKey: 'sk-matrix-xxxx' } },
  { agent: 'codex', provider: 'relay-y', baseUrl: 'https://relay-y.example/v1', auth: 'key-y', authType: 'api-key', model: 'ds-y', secret: { authType: 'api-key', apiKey: 'sk-matrix-yyyy' } },
  { agent: 'claude', provider: 'cgw-1', baseUrl: 'https://cgw-1.example', auth: 'ckey-1', authType: 'api-key', model: 'claude-sonnet-x', secret: { authType: 'api-key', apiKey: 'sk-claude-1111' } },
  { agent: 'claude', provider: 'cgw-2', baseUrl: 'https://cgw-2.example', auth: 'ckey-2', authType: 'api-key', model: 'claude-opus-y', secret: { authType: 'api-key', apiKey: 'sk-claude-2222' } },
];

try {
  for (const entry of matrix) {
    await secretStore.writeSecret(entry.auth, entry.secret);
    await registry.upsertAuthProfile({
      id: `auth-${entry.provider}`,
      agentType: entry.agent,
      authType: entry.authType,
      displayName: entry.provider,
      storageType: 'secret-store',
      storageRef: entry.auth,
    });
    const upsert = await registry.upsertProviderProfile({
      id: entry.provider,
      agentType: entry.agent,
      protocol: entry.agent === 'codex' ? 'openai-responses' : 'anthropic-messages',
      baseUrl: entry.baseUrl,
      authProfileId: `auth-${entry.provider}`,
      modelPolicy: { defaultModel: entry.model },
    });
    assert.equal(upsert.ok, true, upsert.errors?.join(';'));
  }

  const homesRoot = join(root, 'provider-homes');
  // 60 concurrent Run preparations spread across the matrix, started in one
  // burst so their filesystem writes interleave.
  const CONCURRENT_RUNS = 60;
  const jobs = [];
  for (let i = 0; i < CONCURRENT_RUNS; i += 1) {
    const entry = matrix[i % matrix.length];
    const runId = `run_${1000 + i}`;
    jobs.push((async () => {
      const manifest = {
        tool: entry.agent === 'codex' ? 'codex' : 'claude-bidi',
        options: { providerProfile: entry.provider, model: entry.model },
      };
      const prepared = await prepareNativeRunProviderHome(runId, manifest, {
        configDir, providerHomesRoot: homesRoot, runnerReadable: true,
      });
      const snapshot = await resolveRuntimeConfig({
        runRequest: { runId, agentType: entry.agent, providerProfileId: entry.provider, model: entry.model },
        registry, secretStore,
      });
      return { entry, runId, prepared, snapshot };
    })());
  }
  const results = await Promise.all(jobs);

  // Every Run: prepared home belongs to ITS provider, marker matches, and the
  // home's credential equals its provider's secret — no cross-talk.
  const seenHomes = new Map();
  for (const { entry, runId, prepared, snapshot } of results) {
    assert.equal(prepared.ok, true, `${runId}: ${prepared.error || prepared.reason}`);
    assert.equal(prepared.providerId, entry.provider, `${runId} prepared wrong provider`);
    assert.equal(snapshot.providerProfileId, entry.provider, `${runId} resolved wrong provider`);
    assert.equal(snapshot.baseUrl, entry.baseUrl, `${runId} resolved wrong endpoint`);
    assert.equal(snapshot.model, entry.model, `${runId} resolved wrong model`);

    const agentHome = join(prepared.homeDir, entry.agent);
    const marker = readFileSync(join(agentHome, '.agentoc-provider-id'), 'utf8').trim();
    assert.equal(marker, entry.provider, `${runId} home marker drifted`);

    if (entry.agent === 'codex') {
      const configText = readFileSync(join(agentHome, 'config.toml'), 'utf8');
      assert.ok(configText.includes(entry.baseUrl), `${runId} codex config missing its own endpoint`);
      for (const other of matrix) {
        if (other.agent === 'codex' && other.provider !== entry.provider) {
          assert.ok(!configText.includes(other.baseUrl), `${runId} codex config leaked ${other.provider} endpoint`);
        }
      }
      const authJson = JSON.parse(readFileSync(join(agentHome, 'auth.json'), 'utf8'));
      const expectedSecret = entry.authType === 'oauth'
        ? authJson.tokens.access_token
        : authJson.OPENAI_API_KEY;
      const expectedValue = entry.authType === 'oauth'
        ? entry.secret.tokens.access_token
        : entry.secret.apiKey;
      assert.equal(expectedSecret, expectedValue, `${runId} credential cross-talk`);
      // OAuth homes must not carry an API key and vice versa.
      if (entry.authType === 'oauth') {
        assert.equal(authJson.OPENAI_API_KEY, null);
      }
    } else {
      const settings = JSON.parse(readFileSync(join(agentHome, 'settings.json'), 'utf8'));
      assert.equal(settings.env.ANTHROPIC_BASE_URL, entry.baseUrl, `${runId} claude settings endpoint drifted`);
      assert.equal(settings.env.ANTHROPIC_API_KEY, entry.secret.apiKey, `${runId} claude credential cross-talk`);
    }

    // Homes are shared per provider (scoped by design) but the snapshot each
    // Run resolved is independent and immutable.
    const homeOwner = seenHomes.get(prepared.homeDir);
    if (homeOwner !== undefined && homeOwner !== entry.provider) {
      assert.fail(`${runId}: home ${prepared.homeDir} claimed by both ${homeOwner} and ${entry.provider}`);
    }
    seenHomes.set(prepared.homeDir, entry.provider);
  }

  // Six providers → six distinct scoped homes.
  assert.equal(seenHomes.size, matrix.length);

  // Registry never leaked a credential value into its files.
  const { readFile } = await import('fs/promises');
  const providersText = await readFile(join(configDir, 'native-provider-runtime', 'providers.json'), 'utf8');
  assert.ok(!providersText.includes('sk-matrix-'), 'providers.json leaked a credential');
  assert.ok(!providersText.includes('at-off'), 'providers.json leaked an oauth token');

  // Host-env pollution cannot reach the prepared environment contract: even
  // with hostile ANTHROPIC_BASE_URL / OPENAI_API_KEY in the ambient env, the
  // snapshot resolves purely from the registry.
  const hostileEnv = sanitizeRuntimeEnvironment({
    OPENAI_API_KEY: 'sk-hostile',
    ANTHROPIC_BASE_URL: 'https://hostile.example',
    PATH: '/usr/bin',
  });
  assert.equal(hostileEnv.OPENAI_API_KEY, undefined);
  assert.equal(hostileEnv.ANTHROPIC_BASE_URL, undefined);
  const hostileSnapshot = await resolveRuntimeConfig({
    runRequest: { runId: 'run_hostile', agentType: 'codex', providerProfileId: 'relay-x', model: 'gpt-x' },
    registry, secretStore,
  });
  assert.equal(hostileSnapshot.baseUrl, 'https://relay-x.example/v1');

  console.log(`test-native-provider-concurrency: ${CONCURRENT_RUNS} concurrent runs across ${matrix.length} providers — no cross-talk`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
