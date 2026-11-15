#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'ragent-account-sync-agent-'));
const home = join(root, 'home');
const configDir = join(home, '.config', 'ragent');
await mkdir(configDir, { recursive: true });
process.env.HOME = home;
process.env.RAGENT_CONFIG_DIR = configDir;
process.env.RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';

const { createProviderSyncLedger } = await import('../lib/provider-runtime/sync-ledger.mjs');
const { createNativeProviderRegistry } = await import('../lib/provider-runtime/registry.mjs');
const { createSecretStore } = await import('../lib/provider-runtime/secret-store.mjs');
const { applyAccountSyncRecords } = await import('../chat/native-provider-management.mjs');
const { getAgent } = await import('../chat/apps.mjs');

const context = {
  registry: createNativeProviderRegistry({ configDir }),
  secretStore: createSecretStore({ configDir }),
  ledger: createProviderSyncLedger({ configDir }),
  localInstanceId: 'inst_agent_target',
};
const profile = {
  id: 'app_automation',
  name: 'Daily report',
  systemPrompt: 'Prepare the report.',
  welcomeMessage: 'Start here',
  tool: 'codex',
  skills: [],
  createdAt: '2026-08-23T00:00:00.000Z',
  updatedAt: '2026-08-23T00:00:01.000Z',
};
const imported = await applyAccountSyncRecords({
  ...context,
  incoming: [{
    scope: 'agent-profile',
    key: profile.id,
    version: { updatedAt: '2026-08-23T00:00:02.000Z', counter: 1, writerId: 'inst_agent_source' },
    agent: profile,
  }],
});
assert.deepEqual(imported.accepted, ['agent-profile:app_automation']);
assert.equal((await getAgent(profile.id)).name, 'Daily report');

const deleted = await applyAccountSyncRecords({
  ...context,
  incoming: [{
    scope: 'agent-profile',
    key: profile.id,
    version: { updatedAt: '2026-08-23T00:00:03.000Z', counter: 0, writerId: 'inst_agent_source' },
    deletedAt: '2026-08-23T00:00:03.000Z',
  }],
});
assert.deepEqual(deleted.accepted, ['agent-profile:app_automation']);
assert.equal(await getAgent(profile.id), null);

console.log('test-account-sync-apply-agent: ok');
