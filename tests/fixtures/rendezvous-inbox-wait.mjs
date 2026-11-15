import { generateKeyPairSync, sign } from 'node:crypto';
import { createOwnerAuthBroker } from '../../accounts/owner-auth-broker.mjs';
import { buildAccountSessionMessage, buildAccountJoinIntentMessage, createDevicePublicKeyFingerprint }
  from '../../lib/device-auth-protocol.mjs';
import { buildAccountRendezvousPollMessage, createInstancePublicKeyFingerprint }
  from '../../lib/instance-proof-protocol.mjs';

export async function inboxWaitFixture({ store: suppliedStore, clock = Date.now } = {}) {
  let state = {}, reads = 0;
  const hooks = { afterRead: null, beforeCommit: null };
  const store = suppliedStore || {
    async mutate(fn) {
      const next = structuredClone(state), result = await fn(next);
      await hooks.beforeCommit?.(); state = JSON.parse(JSON.stringify(next)); return JSON.parse(JSON.stringify(result ?? null));
    },
    async readAccountRendezvousInboxSnapshot() {
      const snapshot = structuredClone(state); reads++; await hooks.afterRead?.(reads); return snapshot;
    },
  };
  const makeBroker = () => createOwnerAuthBroker({ store, clock,
    verifyGoogleCredential: async () => { throw new Error('No browser Google in inbox QA'); },
    verifyNativeGoogleCredential: async () => ({ providerSubject: 'inbox_qa' }),
    resolveAccount: async ({ draft }) => {
      draft.accounts ||= [];
      if (!draft.accounts.some(item => item.accountId === 'acct_inbox_qa')) draft.accounts.push({
        accountId: 'acct_inbox_qa', provider: 'fixture', providerSubject: 'inbox_qa', createdAt: new Date(clock()).toISOString(),
      });
      return { accountId: 'acct_inbox_qa' };
    },
    signAssertion: async () => 'fixture-assertion',
  });
  const broker = makeBroker();
  const host = generateKeyPairSync('ed25519');
  const publicKey = host.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const instance = { instanceId: 'inst_inbox_wait_fixture', publicKey,
    keyFingerprint: createInstancePublicKeyFingerprint(publicKey) };
  const phone = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const phoneKey = phone.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const fingerprint = createDevicePublicKeyFingerprint(phoneKey), deviceId = 'adev_inbox_wait_fixture';
  const device = { deviceId, publicKey: phoneKey, platform: 'android', alias: 'Synthetic inbox QA' };
  const requestId = 'inbox_wait_session_request_0001';
  const challenge = await broker.createAccountSessionChallenge({ requestId, device });
  const signature = sign('sha256', Buffer.from(buildAccountSessionMessage({
    transactionId: challenge.transactionId, requestId, deviceId, publicKeyFingerprint: fingerprint,
    nonce: challenge.nonce,
  })), phone.privateKey).toString('base64');
  const session = await broker.completeAccountSession({ transactionId: challenge.transactionId,
    requestId, idToken: 'synthetic-native-token', signature });
  const credential = { credential: session.credential.token };
  await store.mutate(draft => {
    draft.instanceBindings = [{ instanceId: instance.instanceId, instancePublicKey: publicKey,
      instanceKeyFingerprint: instance.keyFingerprint, accountId: 'acct_inbox_qa',
      boundAt: new Date(clock()).toISOString(), lastSeenAt: new Date(clock()).toISOString(), revokedAt: '' }];
  });
  let sequence = 0;
  async function prepareOffer() {
    const requestId = 'inbox_wait_rendezvous_request_'+(++sequence);
    const { intent } = JSON.parse(JSON.stringify(await broker.createAccountRendezvous({ requestId, targetInstanceId: instance.instanceId,
      device: { ...device, devicePublicKeyFingerprint: fingerprint } }, credential)));
    const authorization = { intentId: intent.intentId, requestId, deviceId: intent.deviceId,
      devicePublicKeyFingerprint: intent.devicePublicKeyFingerprint, nonce: intent.nonce, issuedAt: intent.issuedAt,
      deviceSignature: sign('sha256', Buffer.from(buildAccountJoinIntentMessage({ ...intent,
        audience: 'ragent-account-join' })), phone.privateKey).toString('base64') };
    return { intent, authorization };
  }
  function proof(waitMs) {
    const issuedAt = new Date(clock()).toISOString(), audience = 'ragent-account-rendezvous-poll';
    return { instance, issuedAt, audience, requestId: 'inbox', ...(waitMs === undefined ? {} : { waitMs }),
      signature: sign(null, Buffer.from(buildAccountRendezvousPollMessage({ instanceId: instance.instanceId,
        requestId: 'inbox', issuedAt, audience })), host.privateKey).toString('base64url') };
  }
  return { broker, makeBroker, store, instance, credential, proof, prepareOffer, hooks,
    get state() { return state; }, get reads() { return reads; } };
}
