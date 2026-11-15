#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'ragent-account-policy-'));
const home = join(root, 'home');
const configDir = join(home, '.config', 'ragent');
await mkdir(configDir, { recursive: true });
process.env.HOME = home;
process.env.RAGENT_CONFIG_DIR = configDir;
process.env.RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';

const policyFile = join(configDir, 'ui-account-policy.json');
const {
  ACCOUNT_POLICY_SYNC_KEY,
  accountPolicyToSessionRiskMode,
  loadAccountPolicy,
  loadAccountPermissionPolicy,
  normalizeAccountPermissionPolicy,
  saveAccountPolicy,
} = await import('../lib/account-policy.mjs');
const {
  createProviderSyncLedger,
} = await import('../lib/provider-runtime/sync-ledger.mjs');
const {
  buildAccountSyncSnapshot,
  mergeAccountSyncRecords,
  normalizeRuntimePolicySyncRecord,
} = await import('../lib/provider-runtime/sync.mjs');
const {
  applyAccountSyncRecords,
  listRuntimePolicySyncRecords,
  recordRuntimePolicySyncMutation,
} = await import('../chat/native-provider-management.mjs');

// --- Policy vocabulary and risk-mode mapping ---

assert.equal(normalizeAccountPermissionPolicy(' FULL-AUTO '), 'full-auto');
assert.equal(normalizeAccountPermissionPolicy('approval'), 'approval');
assert.equal(normalizeAccountPermissionPolicy('conservative-auto'), 'conservative-auto');
assert.equal(normalizeAccountPermissionPolicy('yolo'), '');
assert.equal(normalizeAccountPermissionPolicy(undefined), '');

assert.equal(accountPolicyToSessionRiskMode('full-auto'), 'full-auto');
assert.equal(accountPolicyToSessionRiskMode('approval'), 'recommended');
assert.equal(accountPolicyToSessionRiskMode('conservative-auto'), 'conservative-auto');
assert.equal(accountPolicyToSessionRiskMode(''), 'full-auto');

// --- Local persistence roundtrip ---

assert.deepEqual(await loadAccountPolicy(policyFile), { permissionPolicy: '', updatedAt: '' });
assert.equal(await loadAccountPermissionPolicy(policyFile), '');
const saved = await saveAccountPolicy({ permissionPolicy: 'FULL-AUTO' }, policyFile);
assert.equal(saved.permissionPolicy, 'full-auto');
assert.ok(saved.updatedAt);
assert.equal(await loadAccountPermissionPolicy(policyFile), 'full-auto');
await saveAccountPolicy({ permissionPolicy: 'conservative-auto' }, policyFile);
assert.equal(await loadAccountPermissionPolicy(policyFile), 'conservative-auto');
await saveAccountPolicy({ permissionPolicy: '' }, policyFile);
assert.equal((await loadAccountPolicy(policyFile)).permissionPolicy, '');

// --- Sync record normalization ---

const version = { updatedAt: '2026-09-01T00:00:00.000Z', counter: 1, writerId: 'inst_source' };
const record = normalizeRuntimePolicySyncRecord({
  scope: 'runtime-policy',
  key: ACCOUNT_POLICY_SYNC_KEY,
  version,
  policy: { permissionPolicy: 'full-auto' },
});
assert.deepEqual(record, {
  scope: 'runtime-policy',
  key: ACCOUNT_POLICY_SYNC_KEY,
  version,
  policy: { permissionPolicy: 'full-auto' },
});
// Metadata-only records are valid so version comparison can happen without
// the payload.
assert.deepEqual(normalizeRuntimePolicySyncRecord({ scope: 'runtime-policy', key: ACCOUNT_POLICY_SYNC_KEY, version }), {
  scope: 'runtime-policy',
  key: ACCOUNT_POLICY_SYNC_KEY,
  version,
});
assert.throws(() => normalizeRuntimePolicySyncRecord({
  scope: 'runtime-policy',
  key: ACCOUNT_POLICY_SYNC_KEY,
  version,
  deletedAt: version.updatedAt,
}), /cannot be deleted/);
assert.throws(() => normalizeRuntimePolicySyncRecord({ scope: 'runtime-policy', key: 'other-key', version, policy: {} }), /key is invalid|Account sync record key/);

const snapshot = buildAccountSyncSnapshot({
  accountId: 'acct_policy_test',
  sourceInstanceId: 'inst_source',
  records: [{ scope: 'runtime-policy', key: ACCOUNT_POLICY_SYNC_KEY, version, policy: { permissionPolicy: 'approval' } }],
});
assert.equal(snapshot.records.length, 1);

// --- LWW merge across instances ---

const merged = mergeAccountSyncRecords([], [record], 'inst_target');
assert.deepEqual(merged.accepted, [`runtime-policy:${ACCOUNT_POLICY_SYNC_KEY}`]);
const stale = mergeAccountSyncRecords(merged.records, [{
  ...record,
  version: { updatedAt: '2026-08-31T00:00:00.000Z', counter: 99, writerId: 'inst_target' },
}], 'inst_target');
assert.deepEqual(stale.accepted, []);

// --- Publishing: unset policies publish nothing ---

const ledger = createProviderSyncLedger({ configDir });
assert.deepEqual(await listRuntimePolicySyncRecords({ sourceInstanceId: 'inst_local', ledger, filePath: policyFile }), []);

await saveAccountPolicy({ permissionPolicy: 'full-auto' }, policyFile);
const unpublished = await listRuntimePolicySyncRecords({ sourceInstanceId: 'inst_local', ledger, filePath: policyFile });
assert.equal(unpublished.length, 1);
assert.equal(unpublished[0].policy.permissionPolicy, 'full-auto');

await recordRuntimePolicySyncMutation({ ledger, sourceInstanceId: 'inst_local' });
const published = await listRuntimePolicySyncRecords({ sourceInstanceId: 'inst_local', ledger, filePath: policyFile });
assert.equal(published[0].version.writerId, 'inst_local');
assert.ok(published[0].version.counter >= 1);

// A clear on a publishing instance emits an explicit empty-mode record.
await saveAccountPolicy({ permissionPolicy: '' }, policyFile);
const cleared = await listRuntimePolicySyncRecords({ sourceInstanceId: 'inst_local', ledger, filePath: policyFile });
assert.equal(cleared.length, 1);
assert.deepEqual(cleared[0].policy, { permissionPolicy: '' });

// --- Apply: a peer record lands in the local policy file ---

const applyLedger = createProviderSyncLedger({ configDir: join(configDir, 'apply-peer') });
const registryModule = await import('../lib/provider-runtime/registry.mjs');
const secretModule = await import('../lib/provider-runtime/secret-store.mjs');
const applied = await applyAccountSyncRecords({
  registry: registryModule.createNativeProviderRegistry({ configDir }),
  secretStore: secretModule.createSecretStore({ configDir }),
  ledger: applyLedger,
  localInstanceId: 'inst_apply_target',
  incoming: [{
    scope: 'runtime-policy',
    key: ACCOUNT_POLICY_SYNC_KEY,
    version: { updatedAt: '2026-09-01T01:00:00.000Z', counter: 3, writerId: 'inst_source' },
    policy: { permissionPolicy: 'approval' },
  }],
});
assert.deepEqual(applied.accepted, [`runtime-policy:${ACCOUNT_POLICY_SYNC_KEY}`]);
assert.equal(await loadAccountPermissionPolicy(), 'approval');

// A published clear resets the local policy back to the built-in default.
await applyAccountSyncRecords({
  registry: registryModule.createNativeProviderRegistry({ configDir }),
  secretStore: secretModule.createSecretStore({ configDir }),
  ledger: applyLedger,
  localInstanceId: 'inst_apply_target',
  incoming: [{
    scope: 'runtime-policy',
    key: ACCOUNT_POLICY_SYNC_KEY,
    version: { updatedAt: '2026-09-01T02:00:00.000Z', counter: 4, writerId: 'inst_source' },
    policy: { permissionPolicy: '' },
  }],
});
assert.equal(await loadAccountPermissionPolicy(), '');

// Unknown future modes cannot switch a peer to the built-in full-auto default.
await saveAccountPolicy({ permissionPolicy: 'approval' });
const unknownPolicyResult = await applyAccountSyncRecords({
  registry: registryModule.createNativeProviderRegistry({ configDir }),
  secretStore: secretModule.createSecretStore({ configDir }),
  ledger: applyLedger,
  localInstanceId: 'inst_apply_target',
  incoming: [{
    scope: 'runtime-policy',
    key: ACCOUNT_POLICY_SYNC_KEY,
    version: { updatedAt: '2026-09-01T03:00:00.000Z', counter: 5, writerId: 'inst_source' },
    policy: { permissionPolicy: 'unrestricted-everything' },
  }],
});
assert.equal(await loadAccountPermissionPolicy(), 'approval');
assert.equal(unknownPolicyResult.accepted.includes(`runtime-policy:${ACCOUNT_POLICY_SYNC_KEY}`), false);
assert.equal(unknownPolicyResult.ignored.includes(`runtime-policy:${ACCOUNT_POLICY_SYNC_KEY}`), true);

console.log('test-account-permission-policy: ok');
