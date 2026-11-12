import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOwnerAuthBroker } from '../accounts/owner-auth-broker.mjs';
import { issueInstanceAccessGrant } from '../accounts/instance-access-grants.mjs';
import { loadOrCreateInstanceIdentity, publicInstanceIdentity, signOwnerAuthDeviceProof, signWithInstanceIdentity } from '../lib/instance-identity.mjs';
import { buildInstanceAccessGrantMessage } from '../lib/instance-proof-protocol.mjs';
import { createTurnConnectionId } from '../lib/turn-authorization.mjs';
import { createTurnLeaseId, createTurnOperationRequestId } from '../lib/turn-lease-identity.mjs';

test('shared TURN leases use member quota and an exact revocable grant', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ragent-shared-turn-'));
  try {
    const now = Date.now(), owner = 'acct_turn_owner', member = 'acct_turn_member', deviceId = 'rdev_turn_shared';
    const identity = await loadOrCreateInstanceIdentity({ filePath: join(root, 'identity.json') });
    const state = { accounts: [{ accountId: owner, provider: 'google' }, { accountId: member, provider: 'google' }],
      accountEntitlements: [{ accountId: owner, plan: 'free' }, { accountId: member, plan: 'test' }],
      instanceBindings: [{ instanceId: identity.instanceId, accountId: owner, boundAt: new Date(now).toISOString(),
        instancePublicKey: identity.publicKey, instanceKeyFingerprint: identity.keyFingerprint, revokedAt: '' }],
      devices: [{ deviceId, instanceId: identity.instanceId, accountId: member, deviceKind: 'phone', unboundAt: '' }],
      turnConnectionLeases: [] };
    const store = { mutate: async callback => callback(state) };
    const broker = createOwnerAuthBroker({ store, clock: () => now, issuer: 'https://accounts.example.test',
      verifyGoogleCredential: async () => ({}), resolveAccount: async () => ({ accountId: owner }),
      signAssertion: async () => 'unused', signTurnBrokerCapability: async () => 'signed-capability' });
    const grant = issueInstanceAccessGrant(state, { instanceId: identity.instanceId, ownerAccountId: owner,
      accountId: member, requestId: 'grant_request_00000001', now }).grant;
    const connectionId = createTurnLeaseId(createTurnConnectionId({ accountId: member, instanceId: identity.instanceId, deviceId }),
      'a'.repeat(32), now);
    const expiresAt = new Date(now + 60_000).toISOString(), issuedAt = new Date(now).toISOString();
    const makeRequest = (purpose, actualGrant = grant.grantId, leaseId = connectionId) => {
      const requestId = createTurnOperationRequestId({ purpose, protocolVersion: 2, accountId: member,
        grantId: actualGrant, instanceId: identity.instanceId, deviceId, deviceKind: 'phone', connectionId: leaseId,
        expiresAt: purpose === 'turn-reserve' ? expiresAt : '', reason: '' });
      const proof = signOwnerAuthDeviceProof(identity, { transactionId: requestId, purpose, issuedAt, audience: 'agentoc-owner-auth-device' });
      return { requestId, protocolVersion: 2, accountId: member, grantId: actualGrant, deviceId, deviceKind: 'phone',
        connectionId: leaseId, ...(purpose === 'turn-reserve' ? { expiresAt } : {}), instance: publicInstanceIdentity(identity),
        issuedAt, audience: 'agentoc-owner-auth-device', signature: proof.signature };
    };
    const reserved = await broker.reserveTurnConnection(makeRequest('turn-reserve'));
    assert.equal(reserved.lease.accountId, member);
    assert.equal(reserved.authorization.plan, 'test');
    const forged = makeRequest('turn-reserve'); forged.grantId = `iag_${'b'.repeat(24)}`;
    await assert.rejects(broker.reserveTurnConnection(forged), { code: 'turn_connection_proof_mismatch' });
    const revoke = { instance: publicInstanceIdentity(identity), ownerAccountId: owner, accountId: member,
      operation: 'revoke', grantId: grant.grantId, requestId: 'revoke_request_00000001', issuedAt,
      audience: 'agentoc-instance-access-grant' };
    revoke.signature = signWithInstanceIdentity(identity, buildInstanceAccessGrantMessage({ ...revoke,
      instanceId: identity.instanceId, keyFingerprint: identity.keyFingerprint }));
    assert.equal((await broker.manageInstanceAccessGrant(revoke)).releasedConnections, 1);
    assert.equal(state.turnConnectionLeases[0].status, 'released');
    await assert.rejects(broker.reserveTurnConnection(makeRequest('turn-reserve')), { code: 'instance_access_unavailable' });
    const replacement = issueInstanceAccessGrant(state, { instanceId: identity.instanceId, ownerAccountId: owner,
      accountId: member, requestId: 'grant_request_00000002', now }).grant;
    const nextConnection = createTurnLeaseId(createTurnConnectionId({ accountId: member, instanceId: identity.instanceId, deviceId }),
      'b'.repeat(32), now);
    assert.equal((await broker.reserveTurnConnection(makeRequest('turn-reserve', replacement.grantId, nextConnection))).lease.accountId, member);
    assert.equal((await broker.manageInstanceAccessGrant(revoke)).releasedConnections, 0);
    assert.equal(state.turnConnectionLeases.find(lease => lease.connectionId === nextConnection).status, 'reserved');
  } finally { await rm(root, { recursive: true, force: true }); }
});
