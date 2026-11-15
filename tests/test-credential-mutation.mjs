#!/usr/bin/env node
// Contract tests for versioned provider-credential mutations (CAS).
// Mirrors docs/cross-device-credential-recovery-and-model-catalog-plan.md §一.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  compareCredentialVersions,
  createCredentialMutationLedger,
  mergeCredentialSyncRecords,
  normalizeCredentialMutation,
  normalizeCredentialSyncRecord,
  rotateCredentialInstance,
  submitCredentialMutation,
} from '../lib/provider-runtime/credential-mutation.mjs';
import { normalizeAccountSyncRecord } from '../lib/provider-runtime/sync.mjs';

const root = await mkdtemp(join(tmpdir(), 'ragent-cred-mutation-'));

function mutation(overrides = {}) {
  return normalizeCredentialMutation({
    accountKey: 'agy-account-a',
    credentialInstanceId: 'inst-a',
    expectedVersion: 7,
    secretPayload: { authType: 'oauth', tokens: { tokenFile: 'opaque-token-v8' } },
    secretRef: 'secret-agy-a',
    sourceDeviceId: 'device-a',
    ...overrides,
  });
}

// --- pure submission semantics over an in-memory state -----------------------

{
  const empty = { credentials: new Map() };

  const first = submitCredentialMutation(empty, mutation({ expectedVersion: 0 }));
  assert.equal(first.status, 'accepted');
  assert.equal(first.record.credentialVersion, 1);
  assert.equal(first.record.credentialInstanceId, 'inst-a');
  assert.equal(first.record.scope, 'provider-credential');

  // version comparison is a deterministic integer chain
  assert.equal(compareCredentialVersions(8, 7) > 0, true);
  assert.equal(compareCredentialVersions(7, 8) < 0, true);
  assert.equal(compareCredentialVersions(7, 7), 0);

  // happy path: expected matches current → accepted at +1
  const state = {
    credentials: new Map([['agy-account-a', {
      scope: 'provider-credential',
      key: 'agy-account-a',
      credentialInstanceId: 'inst-a',
      credentialVersion: 7,
      secretRef: 'secret-agy-a',
      credentialFingerprint: 'fp-old',
      updatedByDeviceId: 'device-a',
      updatedAt: '2026-08-26T00:00:00.000Z',
    }]]),
  };
  const accepted = submitCredentialMutation(state, mutation());
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.record.credentialVersion, 8);
  assert.equal(accepted.record.previousFingerprint, 'fp-old');
  assert.equal(accepted.record.credentialFingerprint.length > 0, true);
  assert.equal(accepted.record.updatedByDeviceId, 'device-a');

  // two devices race at expectedVersion 7: first wins, second conflicts and
  // receives the authoritative record — never a silent overwrite.
  const afterFirst = submitCredentialMutation(state, mutation({ sourceDeviceId: 'device-a' }));
  assert.equal(afterFirst.status, 'accepted');
  assert.equal(afterFirst.record.credentialVersion, 8);
  const loser = submitCredentialMutation(afterFirst.state, mutation({
    sourceDeviceId: 'device-b',
    secretPayload: { authType: 'oauth', tokens: { tokenFile: 'opaque-token-b' } },
  }));
  assert.equal(loser.status, 'conflict');
  assert.equal(loser.authoritative.credentialVersion, 8);
  assert.equal(loser.authoritative.updatedByDeviceId, 'device-a');

  // stale writer: expectedVersion 7 while current is already 8
  const stale = submitCredentialMutation(afterFirst.state, mutation({ expectedVersion: 6 }));
  assert.equal(stale.status, 'conflict');
  assert.equal(stale.authoritative.credentialVersion, 8);

  // account mismatch: a different credential instance must not write the chain
  const mismatch = submitCredentialMutation(afterFirst.state, mutation({
    credentialInstanceId: 'inst-b',
    expectedVersion: 8,
  }));
  assert.equal(mismatch.status, 'account-mismatch');
  assert.equal(mismatch.authoritative.credentialInstanceId, 'inst-a');
  assert.equal(mismatch.authoritative.credentialVersion, 8);

  // rotation (re-login): new identity chain starts at 1 and supersedes the old
  const rotated = rotateCredentialInstance(afterFirst.state, {
    accountKey: 'agy-account-a',
    previousCredentialInstanceId: 'inst-a',
    newCredentialInstanceId: 'inst-a2',
    secretPayload: { authType: 'oauth', tokens: { tokenFile: 'opaque-token-fresh-login' } },
    secretRef: 'secret-agy-a',
    sourceDeviceId: 'device-c',
  });
  assert.equal(rotated.status, 'accepted');
  assert.equal(rotated.record.credentialVersion, 1);
  assert.equal(rotated.record.credentialInstanceId, 'inst-a2');
  const oldChain = submitCredentialMutation(rotated.state, mutation({ expectedVersion: 8 }));
  assert.equal(oldChain.status, 'account-mismatch');
  assert.equal(oldChain.authoritative.credentialInstanceId, 'inst-a2');

  // tombstone: deleted credentials cannot be revived by an offline stale writer
  const tombstoned = submitCredentialMutation(rotated.state, {
    ...mutation({ credentialInstanceId: 'inst-a2', expectedVersion: 1 }),
    deleted: true,
  });
  assert.equal(tombstoned.status, 'accepted');
  assert.ok(tombstoned.record.deletedAt);
  const revive = submitCredentialMutation(tombstoned.state, mutation({
    credentialInstanceId: 'inst-a2',
    expectedVersion: 1,
  }));
  assert.equal(revive.status, 'tombstoned');
  assert.ok(revive.authoritative.deletedAt);
}

// --- sync record normalization ------------------------------------------------

{
  const metadataOnly = normalizeAccountSyncRecord({
    scope: 'provider-credential',
    key: 'agy-account-a',
    version: { updatedAt: '2026-08-26T00:00:00.000Z', counter: 3, writerId: 'device-a' },
    credentialInstanceId: 'inst-a',
    credentialVersion: 8,
    credentialFingerprint: 'abcd1234',
  });
  assert.equal(metadataOnly.scope, 'provider-credential');
  assert.equal(metadataOnly.credentialVersion, 8);
  assert.equal('secret' in metadataOnly, false, 'metadata-only records must not invent payloads');

  const withPayload = normalizeAccountSyncRecord({
    scope: 'provider-credential',
    key: 'agy-account-a',
    version: { updatedAt: '2026-08-26T00:00:00.000Z', counter: 4, writerId: 'device-a' },
    credentialInstanceId: 'inst-a',
    credentialVersion: 9,
    credentialFingerprint: 'abcd1235',
    secret: { authType: 'oauth', tokens: { tokenFile: 'opaque' } },
  });
  assert.equal(withPayload.secret.tokens.tokenFile, 'opaque');

  assert.throws(
    () => normalizeCredentialSyncRecord({ scope: 'provider-credential', key: 'k' }),
    (error) => error.code === 'provider_sync_version_invalid',
  );
  assert.throws(
    () => normalizeCredentialSyncRecord({
      scope: 'provider-credential',
      key: 'k',
      version: { updatedAt: '2026-08-26T00:00:00.000Z', counter: 1, writerId: 'w' },
      credentialInstanceId: 'i',
      credentialVersion: -1,
    }),
    (error) => error.code === 'credential_sync_version_invalid',
  );

  // chain-based merge: higher version accepted, lower or foreign instance ignored
  const current = normalizeCredentialSyncRecord({
    scope: 'provider-credential',
    key: 'agy-account-a',
    version: { updatedAt: '2026-08-26T00:00:00.000Z', counter: 5, writerId: 'device-a' },
    credentialInstanceId: 'inst-a',
    credentialVersion: 8,
  });
  const merged = mergeCredentialSyncRecords(
    [current],
    [
      normalizeCredentialSyncRecord({ ...current, credentialVersion: 9, credentialFingerprint: 'fp9' }),
      normalizeCredentialSyncRecord({ ...current, credentialVersion: 7, credentialFingerprint: 'fp7' }),
      normalizeCredentialSyncRecord({ ...current, credentialInstanceId: 'inst-b', credentialVersion: 9 }),
    ],
  );
  assert.deepEqual(merged.accepted, ['provider-credential:agy-account-a']);
  assert.equal(merged.records[0].credentialVersion, 9);
  assert.equal(merged.records.filter((r) => r.key === 'agy-account-a').length, 1);
}

// --- file-backed ledger -------------------------------------------------------

try {
  // Separate ledger objects model concurrent HTTP requests, which must still
  // compare against one serialized file state.
  const raceA = createCredentialMutationLedger({ configDir: join(root, 'race-config') });
  const raceB = createCredentialMutationLedger({ configDir: join(root, 'race-config') });
  const raceResults = await Promise.all([
    raceA.submit(mutation({ expectedVersion: 0, sourceDeviceId: 'device-a' })),
    raceB.submit(mutation({ expectedVersion: 0, sourceDeviceId: 'device-b' })),
  ]);
  assert.deepEqual(
    raceResults.map((result) => result.status).sort(),
    ['accepted', 'conflict'],
    'concurrent ledger objects must preserve CAS semantics',
  );
  assert.equal((await raceA.getRecord('agy-account-a')).credentialVersion, 1);

  const ledger = createCredentialMutationLedger({ configDir: join(root, 'config') });
  const first = await ledger.submit(mutation({ expectedVersion: 0 }));
  assert.equal(first.status, 'accepted');
  assert.equal(first.record.credentialVersion, 1);

  const conflict = await ledger.submit(mutation({ expectedVersion: 0, sourceDeviceId: 'device-b' }));
  assert.equal(conflict.status, 'conflict');
  assert.equal(conflict.authoritative.credentialVersion, 1);

  const bumped = await ledger.submit(mutation({ expectedVersion: 1 }));
  assert.equal(bumped.status, 'accepted');
  assert.equal(bumped.record.credentialVersion, 2);

  const read = await ledger.getRecord('agy-account-a');
  assert.equal(read.credentialVersion, 2);
  assert.equal(read.credentialInstanceId, 'inst-a');

  const removed = await ledger.remove({
    accountKey: 'agy-account-a',
    credentialInstanceId: 'inst-a',
    expectedVersion: 2,
    sourceDeviceId: 'device-a',
  });
  assert.equal(removed.status, 'accepted');
  assert.ok((await ledger.getRecord('agy-account-a')).deletedAt);

  const revived = await ledger.submit(mutation({ expectedVersion: 2 }));
  assert.equal(revived.status, 'tombstoned');

  // persisted ledger must contain metadata only — no credential payloads
  const raw = await readFile(join(root, 'config', 'native-provider-runtime', 'credential-ledger.json'), 'utf8');
  assert.equal(raw.includes('opaque-token'), false, 'ledger file must never contain credential payloads');
  assert.equal(raw.includes('apiKey'), false);

  // rotating under the file ledger starts a fresh chain
  const rotated = await ledger.rotate({
    accountKey: 'agy-account-a',
    newCredentialInstanceId: 'inst-a2',
    secretPayload: { authType: 'oauth', tokens: { tokenFile: 'opaque-rotated' } },
    secretRef: 'secret-agy-a',
    sourceDeviceId: 'device-c',
  });
  assert.equal(rotated.status, 'accepted');
  assert.equal(rotated.record.credentialVersion, 1);
  assert.equal((await ledger.getRecord('agy-account-a')).credentialInstanceId, 'inst-a2');

  console.log('test-credential-mutation: CAS chain, rotation, tombstone, and sync records OK');
} finally {
  await rm(root, { recursive: true, force: true });
}
