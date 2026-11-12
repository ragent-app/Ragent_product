import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createOwnerAuthBroker } from '../accounts/owner-auth-broker.mjs';
import { issueInstanceAccessGrant, revokeInstanceAccessGrant } from '../accounts/instance-access-grants.mjs';
import { createInstancePublicKeyFingerprint } from '../lib/instance-proof-protocol.mjs';
import { buildAccountSessionMessage, buildAccountJoinIntentMessage, createDevicePublicKeyFingerprint } from '../lib/device-auth-protocol.mjs';

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
  const broker = createOwnerAuthBroker({ store: { mutate: async fn => {
    const result = await fn(draft);
    const saved = JSON.parse(JSON.stringify(draft));
    for (const key of Object.keys(draft)) delete draft[key];
    Object.assign(draft, saved);
    return JSON.parse(JSON.stringify(result));
  } }, clock: () => now,
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
  const rendezvousInput = { requestId: 'request_workspace_rendezvous_001', targetInstanceId: instanceId,
    device: { deviceId, publicKey: phoneKey, devicePublicKeyFingerprint: createDevicePublicKeyFingerprint(phoneKey) } };
  const credential = { credential: session.credential.token };
  const { intent } = await broker.createAccountRendezvous(rendezvousInput, credential);
  const authorize = { intentId: intent.intentId, requestId: 'request_workspace_authorize_001', deviceId,
    devicePublicKeyFingerprint: intent.devicePublicKeyFingerprint, nonce: intent.nonce, issuedAt: intent.issuedAt,
    deviceSignature: sign('sha256', Buffer.from(buildAccountJoinIntentMessage({ ...intent,
      audience: 'agentoc-account-join' })), phoneKeys.privateKey).toString('base64') };
  for (const [field, min] of Object.entries({ intentId: 8, requestId: 16, deviceId: 8,
    devicePublicKeyFingerprint: 64, nonce: 16, issuedAt: 20, deviceSignature: 1 })) {
    assert.ok(typeof authorize[field] === 'string' && authorize[field].length >= min, `Missing ${field}`);
  }
  assert.ok((await broker.authorizeAccountJoinIntent(authorize, credential)).accountJoinGrant);
  draft.bindingHistory = [{ instanceId, action: 'unbind' }, { instanceId, action: 'bind' }];
  assert.deepEqual((await discover()).instances, [], 'a rebind invalidates the old grant');
  await assert.rejects(broker.authorizeAccountJoinIntent({ ...authorize, requestId: 'request_workspace_authorize_002' }, credential),
    { code: 'owner_auth_binding_mismatch' });
  draft.bindingHistory = [];
  draft.accounts[0].disabledAt = new Date(now).toISOString();
  assert.deepEqual((await discover()).instances, [], 'a disabled owner cannot share a workspace');
  delete draft.accounts[0].disabledAt;
  revokeInstanceAccessGrant(draft, { grantId: issued.grant.grantId, ownerAccountId: owner, now });
  assert.deepEqual((await discover()).instances, [], 'revocation removes it immediately');
  await assert.rejects(broker.createAccountRendezvous(rendezvousInput, credential), { code: 'owner_auth_binding_mismatch' });
  await assert.rejects(broker.authorizeAccountJoinIntent({ ...authorize, requestId: 'request_workspace_authorize_003' }, credential),
    { code: 'owner_auth_binding_mismatch' });
});
