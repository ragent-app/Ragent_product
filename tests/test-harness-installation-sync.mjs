#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'ragent-harness-installation-sync-'));
process.env.HOME = home;
process.env.RAGENT_CONFIG_DIR = join(home, 'config');
process.env.RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
delete process.env.RAGENT_INSTANCE_ROOT;

const {
  HARNESS_INSTALLATION_SYNC_SCOPE,
  collectGloballyInstalledHarnessIds,
  harnessInstallationCatalogKey,
  listLocalHarnessInstallationCatalogEntries,
  parseHarnessInstallationCatalogKey,
} = await import('../lib/harness-installation-sync.mjs');

const activeEntries = await listLocalHarnessInstallationCatalogEntries({
  sourceInstanceId: 'computer-a',
  harnesses: [{ id: 'qwen-code', installed: true, supportedOnPlatform: true }],
});
assert.equal(activeEntries.length, 1);
assert.equal(activeEntries[0].scope, HARNESS_INSTALLATION_SYNC_SCOPE);
assert.equal(activeEntries[0].deletedAt, undefined);
assert.deepEqual(parseHarnessInstallationCatalogKey(activeEntries[0].key), {
  instanceId: 'computer-a',
  harnessId: 'qwen-code',
});

await writeFile(
  join(process.env.RAGENT_CONFIG_DIR, 'harness-installations.json'),
  JSON.stringify({
    'qwen-code': {
      installed: false,
      updatedAt: '2026-08-27T00:00:02.000Z',
    },
  }),
);
const tombstoneEntries = await listLocalHarnessInstallationCatalogEntries({
  sourceInstanceId: 'computer-a',
  harnesses: [{ id: 'qwen-code', installed: false, supportedOnPlatform: true }],
});
assert.equal(tombstoneEntries.length, 1);
assert.equal(tombstoneEntries[0].deletedAt, '2026-08-27T00:00:02.000Z');

const activeKey = harnessInstallationCatalogKey('computer-a', 'qwen-code');
const otherActiveKey = harnessInstallationCatalogKey('computer-b', 'pi');
const staleKey = harnessInstallationCatalogKey('revoked-computer', 'goose');
assert.deepEqual(
  [...collectGloballyInstalledHarnessIds({
    syncCatalog: [
      { scope: HARNESS_INSTALLATION_SYNC_SCOPE, key: activeKey },
      { scope: HARNESS_INSTALLATION_SYNC_SCOPE, key: otherActiveKey },
      { scope: HARNESS_INSTALLATION_SYNC_SCOPE, key: staleKey },
    ],
    activeInstanceIds: ['computer-a', 'computer-b'],
  })].sort(),
  ['pi', 'qwen-code'],
  'an active installation on any bound computer should expose its Harness globally',
);

assert.deepEqual(
  [...collectGloballyInstalledHarnessIds({
    syncCatalog: [
      { scope: HARNESS_INSTALLATION_SYNC_SCOPE, key: activeKey, deletedAt: '2026-08-27T00:00:03.000Z' },
      { scope: HARNESS_INSTALLATION_SYNC_SCOPE, key: otherActiveKey, deletedAt: '2026-08-27T00:00:04.000Z' },
    ],
    activeInstanceIds: ['computer-a', 'computer-b'],
  })],
  [],
  'when every computer has a tombstone, the Harness should no longer be global',
);

console.log('test-harness-installation-sync: ok');
