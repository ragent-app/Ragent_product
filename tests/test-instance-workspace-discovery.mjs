import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createOwnerAuthBroker } from '../accounts/owner-auth-broker.mjs';
import { issueInstanceAccessGrant, revokeInstanceAccessGrant } from '../accounts/instance-access-grants.mjs';
import { createInstancePublicKeyFingerprint, buildAccountJoinIntentProofMessage } from '../lib/instance-proof-protocol.mjs';
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
  let signedClaims;
  const broker = createOwnerAuthBroker({ store: { mutate: async fn => {
    const result = await fn(draft);
    const saved = JSON.parse(JSON.stringify(draft));
    for (const key of Object.keys(draft)) delete draft[key];
    Object.assign(draft, saved);
    return JSON.parse(JSON.stringify(result));
  } }, clock: () => now,
    verifyGoogleCredential: async () => ({ providerSubject: 'fixture-member' }),
    verifyNativeGoogleCredential: async () => ({ providerSubject: 'fixture-member' }),
    resolveAccount: async () => ({ accountId: member }), signAssertion: async claims => { signedClaims = claims; return 'fixture'; } });
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
  const join = await broker.authorizeAccountJoinIntent(authorize, credential);
  assert.ok(join.accountJoinGrant);
  assert.equal(draft.accountJoinGrants.find(item => item.intentId === intent.intentId).workspaceGrantId, issued.grant.grantId);
  draft.bindingHistory = [{ instanceId, action: 'unbind' }, { instanceId, action: 'bind' }];
  assert.deepEqual((await discover()).instances, [], 'a rebind invalidates the old grant');
  await assert.rejects(broker.authorizeAccountJoinIntent({ ...authorize, requestId: 'request_workspace_authorize_002' }, credential),
    { code: 'owner_auth_binding_mismatch' });
  draft.bindingHistory = [];
  draft.accounts[0].disabledAt = new Date(now).toISOString();
  assert.deepEqual((await discover()).instances, [], 'a disabled owner cannot share a workspace');
  delete draft.accounts[0].disabledAt;
  const instance = { instanceId, publicKey: computerKey, keyFingerprint: createInstancePublicKeyFingerprint(computerKey) };
  const issuedAt = new Date(now).toISOString(), audience = 'agentoc-account-join';
  const instanceProof = buildAccountJoinIntentProofMessage({ instanceId, intentId: intent.intentId, deviceId,
    devicePublicKeyFingerprint: intent.devicePublicKeyFingerprint, nonce: intent.nonce, issuedAt, audience, publicEndpoint: '' });
  const completion = { intentId: intent.intentId, requestId: 'request_workspace_completion_001', nonce: intent.nonce,
    deviceIssuedAt: intent.issuedAt, device: { deviceId, devicePublicKeyFingerprint: intent.devicePublicKeyFingerprint },
    deviceSignature: authorize.deviceSignature, accountJoinGrant: join.accountJoinGrant, publicEndpoint: '', issuedAt, audience,
    instance, signature: sign(null, Buffer.from(instanceProof), computerKeys.privateKey).toString('base64url') };
  assert.equal((await broker.completeAccountJoinIntent(completion)).accountId, member);
  assert.equal(draft.instanceBindings[0].accountId, owner, 'the existing owner binding is unchanged');
  assert.deepEqual(signedClaims.workspaceAccess, { ownerAccountId: owner, grantId: issued.grant.grantId });
  assert.equal(signedClaims.sub, member);
  assert.equal((await broker.completeAccountJoinIntent(completion)).replayed, true);
  revokeInstanceAccessGrant(draft, { grantId: issued.grant.grantId, ownerAccountId: owner, now });
  assert.deepEqual((await discover()).instances, [], 'revocation removes it immediately');
  await assert.rejects(broker.createAccountRendezvous(rendezvousInput, credential), { code: 'owner_auth_binding_mismatch' });
  await assert.rejects(broker.completeAccountJoinIntent(completion), { code: 'owner_auth_binding_mismatch' });
  issueInstanceAccessGrant(draft, { instanceId, ownerAccountId: owner, accountId: member,
    requestId: 'request_access_discovery_002', now });
  await assert.rejects(broker.completeAccountJoinIntent(completion), { code: 'owner_auth_binding_mismatch' },
    'a new grant cannot revive a prior join');
  draft.instanceBindings[0].accountId = member;
  await assert.rejects(broker.completeAccountJoinIntent({ ...completion, accountJoinGrant: '', idToken: 'fixture' }),
    { code: 'owner_auth_binding_mismatch' }, 'a later owner transfer cannot revive a shared join');
});
