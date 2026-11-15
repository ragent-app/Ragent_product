#!/usr/bin/env node
// Concurrent mutation callbacks, startup convergence, and an explicit refresh
// request must not apply overlapping sync snapshots to the same local ledger.
// This is intentionally a control-operation assertion: normal provider Runs
// are not serialized by this guard.

import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'ragent-provider-sync-single-flight-'));
process.env.HOME = home;
process.env.RAGENT_CONFIG_DIR = join(home, 'config');
process.env.RAGENT_ACCOUNTS_URL = 'https://accounts.example.test';
process.env.RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
delete process.env.RAGENT_INSTANCE_ROOT;

const { createCredentialMutationLedger, createNativeProviderRegistry, createProviderSyncLedger, createSecretStore } = await import('../lib/provider-runtime/index.mjs');
const { syncAccountSyncFromAccountPeers } = await import('../lib/provider-runtime/peer-sync.mjs');

const configDir = process.env.RAGENT_CONFIG_DIR;
await writeFile(join(configDir, 'owner-account-binding.json'), JSON.stringify({ accountId: 'acct_single_flight' }));
const context = {
  registry: createNativeProviderRegistry({ configDir }),
  secretStore: createSecretStore({ configDir }),
  ledger: createProviderSyncLedger({ configDir }),
  credentialLedger: createCredentialMutationLedger({ configDir }),
};

let calls = 0;
const fetchImpl = async (url) => {
  calls += 1;
  // Hold the first Accounts request open long enough for the second trigger
  // to arrive while the first operation is still in flight.
  await new Promise((resolve) => setTimeout(resolve, 25));
  const path = new URL(String(url)).pathname;
  if (path.includes('/sync/catalog/')) {
    return new Response(JSON.stringify({ accepted: [], ignored: [] }), { status: 200 });
  }
  assert.match(path, /\/v1\/owner-auth\/devices\//);
  return new Response(JSON.stringify({ devices: [], syncCatalog: [] }), { status: 200 });
};

const first = syncAccountSyncFromAccountPeers({ ...context, fetchImpl });
const second = syncAccountSyncFromAccountPeers({ ...context, fetchImpl });
assert.strictEqual(first, second, 'overlapping sync triggers must share one promise');
const [firstResult, secondResult] = await Promise.all([first, second]);
assert.deepEqual(firstResult, secondResult);
assert.equal(calls, 3, 'one sync cycle should make two catalog and one device-directory request');

console.log('test-provider-sync-single-flight: ok');
