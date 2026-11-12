import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createOwnerAuthBroker } from '../accounts/owner-auth-broker.mjs';
import { issueInstanceAccessGrant, revokeInstanceAccessGrant } from '../accounts/instance-access-grants.mjs';
import { createInstancePublicKeyFingerprint } from '../lib/instance-proof-protocol.mjs';
import { buildAccountSessionMessage, createDevicePublicKeyFingerprint } from '../lib/device-auth-protocol.mjs';

test('discovery exposes only workspaces with an active grant bound to the same owner', async () => {
  const now = Date.parse('2026-11-12T00:00:00Z');
  const owner = 'acct_workspace_owner', member = 'acct_workspace_member', instanceId = 'inst_workspace_discovery';
  const computerKeys = generateKeyPairSync('ed25519');
  const computerKey = computerKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const phoneKeys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const phoneKey = phoneKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const deviceId = 'adev_workspace_discovery';
  const draft = { accounts: [{ accountId: owner }, { accountId: member }], instanceBindings: [{
    instanceId, accountId: owner, instancePublicKey: computerKey,
    instanceKeyFingerprint: createInstancePublicKeyFingerprint(computerKey), boundAt: new Date(now).toISOString(),
  }] };
  const broker = createOwnerAuthBroker({ store: { mutate: async fn => fn(draft) }, clock: () => now,
    verifyGoogleCredential: async () => ({ providerSubject: 'fixture-member' }),
    verifyNativeGoogleCredential: async () => ({ providerSubject: 'fixture-member' }),
    resolveAccount: async () => ({ accountId: member }), signAssertion: async () => 'fixture' });
  const input = { requestId: 'request_session_discovery_001', device: { deviceId, publicKey: phoneKey, platform: 'android' } };
  const challenge = await broker.createAccountSessionChallenge(input);
  const signature = sign('sha256', Buffer.from(buildAccountSessionMessage({ transactionId: challenge.transactionId,
    requestId: input.requestId, deviceId, publicKeyFingerprint: createDevicePublicKeyFingerprint(phoneKey),
    nonce: challenge.nonce })), phoneKeys.privateKey).toString('base64');
  const session = await broker.completeAccountSession({ transactionId: challenge.transactionId,
    requestId: input.requestId, idToken: 'fixture', signature });
  const discover = () => broker.discoverInstances({}, { credential: session.credential.token });
  assert.deepEqual((await discover()).instances, []);
  const issued = issueInstanceAccessGrant(draft, { instanceId, ownerAccountId: owner, accountId: member,
    requestId: 'request_access_discovery_001', now });
  assert.deepEqual((await discover()).instances.map(item => item.instanceId), [instanceId]);
  draft.bindingHistory = [{ instanceId, action: 'unbind' }, { instanceId, action: 'bind' }];
  assert.deepEqual((await discover()).instances, [], 'a rebind invalidates the old grant');
  draft.bindingHistory = [];
  draft.accounts[0].disabledAt = new Date(now).toISOString();
  assert.deepEqual((await discover()).instances, [], 'a disabled owner cannot share a workspace');
  delete draft.accounts[0].disabledAt;
  revokeInstanceAccessGrant(draft, { grantId: issued.grant.grantId, ownerAccountId: owner, now });
  assert.deepEqual((await discover()).instances, [], 'revocation removes it immediately');
});
