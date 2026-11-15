import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createNativeProviderRegistry } from '../lib/provider-runtime/registry.mjs';
import { createSecretStore } from '../lib/provider-runtime/secret-store.mjs';
import {
  createProviderQuotaStore,
  queryProviderQuota,
  refreshProviderQuota,
} from '../lib/provider-runtime/quota.mjs';

const configDir = await mkdtemp(join(tmpdir(), 'ragent-provider-quota-'));
const registry = createNativeProviderRegistry({ configDir });
const secretStore = createSecretStore({ configDir });
const quotaStore = createProviderQuotaStore({ configDir });
const now = () => '2026-08-17T12:00:00.000Z';

function response(status, body) {
  return { status, json: async () => body };
}
async function addProvider({ id, agentType, authType, token, apiKey, baseUrl, quotaPolicy, accountId }) {
  const authId = `${id}-auth`;
  const secretRef = `${id}-secret`;
  await secretStore.writeSecret(secretRef, authType === 'oauth'
    ? {
      authType,
      tokens: agentType === 'agy'
        ? { tokenFile: token }
        : { access_token: token, refresh_token: 'refresh-secret' },
    }
    : authType === 'oauth-token'
      ? { authType, token }
      : { authType, apiKey });
  assert.equal((await registry.upsertAuthProfile({
    id: authId,
    agentType,
    authType,
    displayName: id,
    storageType: 'secret-store',
    storageRef: secretRef,
    ...(accountId ? { accountMetadata: { accountId } } : {}),
  })).ok, true);
  assert.equal((await registry.upsertProviderProfile({
    id,
    agentType,
    protocol: agentType === 'agy'
      ? 'agy'
      : agentType === 'claude' ? 'anthropic-messages' : 'openai-responses',
    displayName: id,
    baseUrl,
    authProfileId: authId,
    quotaPolicy,
  })).ok, true);
  return {
    provider: await registry.getProviderProfile(id),
    authProfile: await registry.getAuthProfile(authId),
  };
}

try {
  const codex = await addProvider({
    id: 'codex-official',
    agentType: 'codex',
    authType: 'oauth',
    token: 'codex-access-secret',
    accountId: 'acct-codex-1',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    quotaPolicy: { mode: 'official_subscription', adapter: 'codex' },
  });
  const codexSnapshot = await refreshProviderQuota({
    ...codex,
    secretStore,
    quotaStore,
    now,
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://chatgpt.com/backend-api/wham/usage');
      assert.equal(options.headers.Authorization, 'Bearer codex-access-secret');
      assert.equal(options.headers['ChatGPT-Account-Id'], 'acct-codex-1');
      return response(200, {
        plan_type: 'pro',
        rate_limit: {
          primary_window: { used_percent: 12, limit_window_seconds: 18000, reset_at: 1_800_000_000 },
          secondary_window: { used_percent: 35, limit_window_seconds: 604800, reset_at: 1_800_100_000 },
        },
        credits: { has_credits: true },
      });
    },
  });
  assert.equal(codexSnapshot.status, 'ok');
  assert.equal(codexSnapshot.planName, 'pro');
  assert.deepEqual(codexSnapshot.windows.map((window) => [window.id, window.remainingPercent]), [
    ['five_hour', 88],
    ['weekly', 65],
  ]);
  assert.deepEqual(codexSnapshot.extraUsage, { hasCredits: true });
  assert.doesNotMatch(JSON.stringify(codexSnapshot), /codex-access-secret|refresh-secret/);
  assert.deepEqual(await quotaStore.get('codex-official'), codexSnapshot);

  const claude = await addProvider({
    id: 'claude-official',
    agentType: 'claude',
    authType: 'oauth-token',
    token: 'claude-access-secret',
    baseUrl: 'https://api.anthropic.com',
    quotaPolicy: { mode: 'official_subscription', adapter: 'claude' },
  });
  const claudeSnapshot = await queryProviderQuota({
    ...claude,
    secretStore,
    now,
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.anthropic.com/api/oauth/usage');
      assert.equal(options.headers['anthropic-beta'], 'oauth-2025-04-20');
      return response(200, {
        five_hour: { utilization: 20, resets_at: '2026-08-17T15:00:00Z' },
        seven_day: { utilization: 40, resets_at: '2026-08-20T00:00:00Z' },
        monthly: { utilization: 10, resets_at: '2026-09-01T00:00:00Z' },
        extra_usage: { is_enabled: true, monthly_limit: 100, used_credits: 25, currency: 'USD' },
      });
    },
  });
  assert.deepEqual(claudeSnapshot.windows.map((window) => [window.id, window.remainingPercent]), [
    ['five_hour', 80],
    ['weekly', 60],
    ['monthly', 90],
  ]);
  assert.equal(claudeSnapshot.extraUsage.remaining, 75);

  const kimi = await addProvider({
    id: 'kimi-coding',
    agentType: 'codex',
    authType: 'api-key',
    apiKey: 'kimi-api-secret',
    baseUrl: 'https://api.kimi.com/coding/v1',
    quotaPolicy: { mode: 'coding_plan', adapter: 'kimi' },
  });
  const kimiSnapshot = await queryProviderQuota({
    ...kimi,
    secretStore,
    now,
    fetchImpl: async (url) => {
      assert.equal(url, 'https://api.kimi.com/coding/v1/usages');
      return response(200, {
        limits: [{ detail: { limit: 1000, remaining: 800, resetTime: 1_800_200_000 } }],
        usage: { limit: 5000, remaining: 3500, resetTime: 1_800_300_000 },
      });
    },
  });
  assert.deepEqual(kimiSnapshot.windows.map((window) => [window.id, window.remainingPercent, window.unit]), [
    ['five_hour', 80, 'tokens'],
    ['weekly', 70, 'tokens'],
  ]);

  const openrouter = await addProvider({
    id: 'openrouter-payg',
    agentType: 'codex',
    authType: 'api-key',
    apiKey: 'openrouter-api-secret',
    baseUrl: 'https://openrouter.ai/api/v1',
    quotaPolicy: { mode: 'payg_balance', adapter: 'openrouter' },
  });
  const balanceSnapshot = await queryProviderQuota({
    ...openrouter,
    secretStore,
    now,
    fetchImpl: async (url) => {
      assert.equal(url, 'https://openrouter.ai/api/v1/credits');
      return response(200, { data: { total_credits: 20, total_usage: 6.25 } });
    },
  });
  assert.equal(balanceSnapshot.balance.remaining, 13.75);
  assert.equal(balanceSnapshot.balance.total, 20);
  assert.equal(balanceSnapshot.balance.used, 6.25);
  assert.equal(balanceSnapshot.balance.currency, 'USD');

  const stale = await refreshProviderQuota({
    ...codex,
    secretStore,
    quotaStore,
    now: () => '2026-08-17T12:05:00.000Z',
    fetchImpl: async () => { throw new Error('offline'); },
  });
  assert.equal(stale.status, 'stale');
  assert.equal(stale.windows[0].remainingPercent, 88);
  assert.equal(stale.error.code, 'network');

  const unknown = await addProvider({
    id: 'unknown-api',
    agentType: 'codex',
    authType: 'api-key',
    apiKey: 'unknown-api-secret',
    baseUrl: 'https://gateway.example/v1',
    quotaPolicy: { mode: 'payg_balance' },
  });
  let fetchCalled = false;
  const unsupported = await queryProviderQuota({
    ...unknown,
    secretStore,
    now,
    fetchImpl: async () => { fetchCalled = true; return response(500, {}); },
  });
  assert.equal(unsupported.status, 'unsupported');
  assert.equal(unsupported.error.code, 'quota_adapter_unsupported');
  assert.equal(fetchCalled, false);

  const agyCalls = [];
  const agy = await addProvider({
    id: 'agy-official',
    agentType: 'agy',
    authType: 'oauth',
    token: 'agy-token-file',
    quotaPolicy: { mode: 'official_subscription', adapter: 'agy' },
  });
  const agySnapshot = await queryProviderQuota({
    ...agy,
    secretStore,
    resolveCommand: async () => '/home/test/.local/bin/agy',
    spawnImpl: (file, args, options) => {
      agyCalls.push({ file, args, options });
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from(JSON.stringify({
          command: {
            data: {
              groups: [
                {
                  name: 'Gemini Models',
                  buckets: [
                    {
                      name: 'Weekly Limit Remaining',
                      window: 'weekly',
                      remaining_fraction: 0.905,
                      reset_time: '2026-08-22T04:50:42Z',
                    },
                    {
                      name: 'Five Hour Limit Remaining',
                      window: '5h',
                      remaining_fraction: 0.81,
                      reset_time: '2026-08-17T17:06:40Z',
                    },
                  ],
                },
              ],
            },
          },
        })));
        child.emit('close', 0, null);
      });
      return child;
    },
    now,
  });
  assert.equal(agySnapshot.status, 'ok');
  assert.equal(agySnapshot.adapter, 'agy');
  assert.deepEqual(agySnapshot.windows.map((window) => [
    window.id,
    window.remainingPercent,
    window.label,
    window.group,
  ]), [
    ['gemini_models_weekly', 90.5, 'Weekly Limit Remaining', 'Gemini Models'],
    ['gemini_models_five_hour', 81, 'Five Hour Limit Remaining', 'Gemini Models'],
  ]);
  assert.deepEqual(agyCalls[0].args, ['-p', '/quota', '--output-format', 'json', '--print-timeout', '25s']);
  assert.equal(agyCalls[0].options.shell, false);

  console.log('test-provider-quota: official windows, coding plans, payg balances, agy quota, stale cache and safe unsupported handling OK');
} finally {
  await rm(configDir, { recursive: true, force: true });
}
