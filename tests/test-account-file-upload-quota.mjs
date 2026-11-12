import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrCreateInstanceIdentity, publicInstanceIdentity, signAccountFileUploadQuotaProof } from '../lib/instance-identity.mjs';
import { createInstancePublicKeyFingerprint } from '../lib/instance-proof-protocol.mjs';
import { createOwnerAuthBroker } from '../accounts/owner-auth-broker.mjs';
import { createDemoAccountAuth, createDemoAccountPolicy } from '../accounts/demo-credentials.mjs';
import { createAccountEntitlementResolver } from '../accounts/turn-lease-policy.mjs';
import { issueInstanceAccessGrant, revokeInstanceAccessGrant } from '../accounts/instance-access-grants.mjs';

const home = mkdtempSync(join(tmpdir(), 'agentoc-account-file-quota-'));
process.env.HOME = home;
process.env.AGENTOC_CONFIG_DIR = join(home, 'config');
process.env.AGENTOC_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
let now = Date.parse('2026-11-08T00:00:00.000Z');
const accountId = 'acct_file_quota_test';
const identity = await loadOrCreateInstanceIdentity({ filePath: join(home, 'instance.json') });
const state = {
  accounts: [{ accountId, provider: 'google', providerSubject: 'file-quota-test', createdAt: new Date(now).toISOString() }],
  accountEntitlements: [{ accountId, plan: 'free', source: 'test', expiresAt: '' }],
  instanceBindings: [{ instanceId: identity.instanceId, accountId, provider: 'google', boundAt: new Date(now).toISOString(),
    revokedAt: '', instancePublicKey: identity.publicKey, instanceKeyFingerprint: createInstancePublicKeyFingerprint(identity.publicKey) }],
  accountFileUploads: [],
};
let queue = Promise.resolve();
const store = { mutate(mutator) {
  const run = queue.then(() => mutator(state));
  queue = run.catch(() => {});
  return run;
} };
const broker = createOwnerAuthBroker({ store, clock: () => now,
  verifyGoogleCredential: async () => ({ providerSubject: 'unused' }),
  verifyNativeGoogleCredential: async () => ({ providerSubject: 'unused' }),
  resolveAccount: async () => ({ accountId }), signAssertion: async () => 'unused' });
const digest = (char) => char.repeat(64);
function request(operation, requestId, sizeBytes, sha256 = digest('a'), actor = identity, quotaBatchId = requestId, owner = accountId) {
  const fields = { accountId: owner, operation, requestId, quotaBatchId, sizeBytes, sha256, issuedAt: new Date(now).toISOString(),
    audience: 'agentoc-account-file-upload' };
  const proof = signAccountFileUploadQuotaProof(actor, fields);
  return { ...fields, instance: publicInstanceIdentity(actor), signature: proof.signature };
}

try {
  const fiftyMiB = 50 * 1024 * 1024;
  const beforePolicy = state.accountFileUploads.length;
  const freePolicy = await broker.getAccountFileUploadPolicy(request('policy', 'policy-free', 1));
  assert.equal(freePolicy.limits.maxFileBytes, fiftyMiB);
  assert.notEqual(freePolicy.limits.unlimited, true);
  assert.equal(state.accountFileUploads.length, beforePolicy, 'policy lookup does not create reservations');
  const tamperedPolicy = request('policy', 'policy-tampered', 1);
  tamperedPolicy.accountId = 'acct_other';
  await assert.rejects(() => broker.getAccountFileUploadPolicy(tamperedPolicy), { code: 'owner_auth_proof_invalid' });
  const first = await broker.reserveAccountFileUpload(request('reserve', 'upload-first', fiftyMiB, digest('a'), identity, 'message-first'));
  assert.equal(first.duplicate, false);
  assert.equal(first.reservedBytes, fiftyMiB);
  const replay = await broker.reserveAccountFileUpload(request('reserve', 'upload-first', fiftyMiB, digest('a'), identity, 'message-first'));
  assert.equal(replay.duplicate, true);
  assert.equal(state.accountFileUploads.length, 1, 'Retrying the same reservation must not consume quota twice');

  await assert.rejects(() => broker.reserveAccountFileUpload(request('reserve', 'oversize-file', fiftyMiB + 1,
    digest('a'), identity, 'message-first')),
    (error) => error.code === 'account_file_upload_file_limit' && error.statusCode === 413);
  const second = await broker.reserveAccountFileUpload(request('reserve', 'upload-second', fiftyMiB, digest('b'), identity, 'message-first'));
  assert.equal(second.reservedBytes, 2 * fiftyMiB);
  await assert.rejects(() => broker.reserveAccountFileUpload(request('reserve', 'over-total', 1, digest('c'), identity, 'message-first')),
    (error) => error.code === 'account_file_upload_total_limit' && error.statusCode === 429);
  await broker.releaseAccountFileUpload(request('release', 'upload-second', fiftyMiB, digest('b'), identity, 'message-first'));

  const completed = await broker.completeAccountFileUpload(request('complete', 'upload-first', fiftyMiB, digest('a'), identity, 'message-first'));
  assert.equal(completed.usedBytes, fiftyMiB);
  assert.equal(completed.reservedBytes, 0);
  await broker.completeAccountFileUpload(request('complete', 'upload-first', fiftyMiB, digest('a'), identity, 'message-first'));
  assert.equal(state.accountFileUploads.filter((item) => item.status === 'committed').length, 1,
    'Finalization retries must not double-count an upload');
  await assert.rejects(() => broker.reserveAccountFileUpload(request('reserve', 'upload-first', 7, digest('d'), identity, 'message-other')),
    (error) => error.code === 'account_file_upload_identity_conflict' && error.statusCode === 409);

  const nextMessage = await broker.reserveAccountFileUpload(request('reserve', 'next-message-file', fiftyMiB,
    digest('7'), identity, 'message-next'));
  assert.equal(nextMessage.reservedBytes, fiftyMiB);
  const nextMessageSecond = await broker.reserveAccountFileUpload(request('reserve', 'next-message-file-two', fiftyMiB,
    digest('5'), identity, 'message-next'));
  assert.equal(nextMessageSecond.reservedBytes, 100 * 1024 * 1024,
    'A later message receives its own 100 MiB batch limit regardless of earlier uploads');
  await assert.rejects(() => broker.reserveAccountFileUpload(request('reserve', 'next-message-over', 1,
    digest('6'), identity, 'message-next')),
    (error) => error.code === 'account_file_upload_total_limit' && error.statusCode === 429);

  const released = request('reserve', 'retryable-upload', 1, digest('e'), identity, 'message-retry');
  await broker.reserveAccountFileUpload(released);
  const release = await broker.releaseAccountFileUpload(request('release', 'retryable-upload', 1, digest('e'), identity, 'message-retry'));
  assert.equal(release.released, true);
  const renewed = await broker.reserveAccountFileUpload(request('reserve', 'retryable-upload', 1, digest('e'), identity, 'message-retry'));
  assert.equal(renewed.duplicate, false, 'Failed local intent creation can release and later retry its quota reservation');

  await broker.reserveAccountFileUpload(request('reserve', 'abandoned-before-expiry', 1, digest('f'), identity, 'message-expiry'));
  now += 31 * 24 * 60 * 60 * 1000;
  const afterReservationExpiry = await broker.reserveAccountFileUpload(request('reserve', 'new-after-expiry', 1, digest('f'), identity, 'message-expiry'));
  assert.equal(afterReservationExpiry.usedBytes, 0);
  assert.equal(afterReservationExpiry.reservedBytes, 1, 'Abandoned reservations stop consuming quota after their lease');

  state.accountEntitlements[0].plan = 'plus';
  const paid = await broker.reserveAccountFileUpload(request('reserve', 'paid-file', 200 * 1024 * 1024, digest('9'), identity, 'paid-message'));
  assert.equal(paid.limits.maxFileBytes, 1024 * 1024 * 1024);
  await assert.rejects(() => broker.reserveAccountFileUpload(request('reserve', 'paid-too-large', 1024 * 1024 * 1024 + 1)),
    { code: 'account_file_upload_file_limit' });

  const policy = await createDemoAccountPolicy({ username: 'ragent-fixture', password: 'long-test-fixture-password' });
  const demoAuth = createDemoAccountAuth(policy);
  state.accounts.push({ accountId: policy.accountId, provider: 'demo' });
  const secondIdentity = await loadOrCreateInstanceIdentity({ filePath: join(home, 'test-instance.json') });
  state.instanceBindings.push({ instanceId: secondIdentity.instanceId, accountId: policy.accountId, provider: 'demo',
    boundAt: new Date(now).toISOString(), revokedAt: '', instancePublicKey: secondIdentity.publicKey,
    instanceKeyFingerprint: createInstancePublicKeyFingerprint(secondIdentity.publicKey) });
  const testBroker = createOwnerAuthBroker({ store, clock: () => now, demoAccountAuth: demoAuth,
    resolveEntitlement: createAccountEntitlementResolver(demoAuth), signAssertion: async () => 'unused',
    verifyGoogleCredential: async () => ({ providerSubject: 'unused' }), resolveAccount: async () => ({ accountId }) });
  const rowsBeforeTestPolicy = state.accountFileUploads.length;
  const testPolicy = await testBroker.getAccountFileUploadPolicy(request('policy', 'policy-test', 1,
    digest('c'), secondIdentity, 'policy', policy.accountId));
  assert.equal(testPolicy.limits.unlimited, true);
  assert.equal(testPolicy.limits.maxFileBytes, Number.MAX_SAFE_INTEGER);
  assert.equal(state.accountFileUploads.length, rowsBeforeTestPolicy);
  const largeSize = 2 * 1024 * 1024 * 1024;
  const largeRequest = (op) => request(op, 'test-large', largeSize, digest('b'), secondIdentity, 'test-batch', policy.accountId);
  const testReservation = await testBroker.reserveAccountFileUpload(largeRequest('reserve'));
  assert.equal(testReservation.limits.unlimited, true);
  assert.equal(testReservation.reservedBytes, largeSize);
  assert.equal((await testBroker.completeAccountFileUpload(largeRequest('complete'))).usedBytes, largeSize);

  const grant = issueInstanceAccessGrant(state, { instanceId: identity.instanceId, ownerAccountId: accountId,
    accountId: policy.accountId, requestId: 'shared_quota_grant_0001', now }).grant;
  const sharedRequest = (operation, grantId = grant.grantId) => {
    const fields = { accountId: policy.accountId, operation, requestId: 'shared-large', quotaBatchId: 'shared-batch',
      sizeBytes: largeSize, sha256: digest('c'), issuedAt: new Date(now).toISOString(),
      audience: 'agentoc-account-file-upload', grantId };
    return { ...fields, instance: publicInstanceIdentity(identity), signature: signAccountFileUploadQuotaProof(identity, fields).signature };
  };
  assert.equal((await testBroker.getAccountFileUploadPolicy(sharedRequest('policy'))).limits.unlimited, true);
  assert.equal((await testBroker.reserveAccountFileUpload(sharedRequest('reserve'))).limits.unlimited, true);
  assert.equal(state.accountFileUploads.find(row => row.requestId === 'shared-large').accountId, policy.accountId);
  const tamperedGrant = sharedRequest('reserve');
  tamperedGrant.grantId = `iag_${'x'.repeat(32)}`;
  await assert.rejects(() => testBroker.reserveAccountFileUpload(tamperedGrant), { code: 'owner_auth_proof_invalid' });
  revokeInstanceAccessGrant(state, { grantId: grant.grantId, ownerAccountId: accountId, now });
  await assert.rejects(() => testBroker.completeAccountFileUpload(sharedRequest('complete')), { code: 'instance_access_unavailable' });
  issueInstanceAccessGrant(state, { instanceId: identity.instanceId, ownerAccountId: accountId,
    accountId: policy.accountId, requestId: 'shared_quota_grant_0002', now });
  await assert.rejects(() => testBroker.reserveAccountFileUpload(sharedRequest('reserve')), { code: 'instance_access_unavailable' });

  const forged = request('reserve', 'tampered-proof', 1, digest('8'));
  forged.quotaBatchId = 'changed-message';
  await assert.rejects(() => broker.reserveAccountFileUpload(forged),
    (error) => error.code === 'owner_auth_proof_invalid' && error.statusCode === 401);
  console.log('PASS account attachment quota: 50 MiB per free file, 100 MiB per message across devices, idempotent retries, reservation expiry/release, and paid-tier policy');
} finally {
  rmSync(home, { recursive: true, force: true });
}
