import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { createOwnerAuthBroker } from '../../accounts/owner-auth-broker.mjs';
import { createRendezvousResultWaiters } from '../../accounts/rendezvous-result-waiters.mjs';
import { normalizeDevicePublicKey, createDevicePublicKeyFingerprint } from '../../lib/device-auth-protocol.mjs';
import { createInstancePublicKeyFingerprint, buildAccountRendezvousPollMessage } from '../../lib/instance-proof-protocol.mjs';

export function rendezvousWaitFixture({ clock = Date.now, lifetimeMs = 60_000, capacities } = {}) {
  const phone = normalizeDevicePublicKey(generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    .publicKey.export({ type: 'spki', format: 'pem' }).toString());
  const hostKeys = generateKeyPairSync('ed25519');
  const hostKey = hostKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const instance = { instanceId: 'inst_wait_fixture', publicKey: hostKey,
    keyFingerprint: createInstancePublicKeyFingerprint(hostKey) };
  const requestId = 'rendezvous_bounded_wait_fixture_0001';
  const token = 'rac_'+randomBytes(32).toString('hex');
  const now = new Date(clock()).toISOString(), future = new Date(clock()+lifetimeMs).toISOString();
  let state = {
    accounts: [{ accountId: 'acct_wait_fixture', provider: 'fixture', providerSubject: 'wait_fixture', createdAt: now }],
    accountCredentials: [{ credentialId: 'cred_wait_fixture', tokenHash: createHash('sha256').update(token).digest('hex'),
      accountId: 'acct_wait_fixture', deviceId: 'adev_wait_fixture', keyId: phone.keyId,
      scope: 'account-directory', issuedAt: now, expiresAt: new Date(clock()+300_000).toISOString(), lastUsedAt: now }],
    accountDevices: [{ accountId: 'acct_wait_fixture', deviceId: 'adev_wait_fixture', createdAt: now, lastSeenAt: now }],
    accountDeviceKeys: [{ ...phone, deviceId: 'adev_wait_fixture', accountId: 'acct_wait_fixture',
      fingerprint: createDevicePublicKeyFingerprint(phone.publicKey), createdAt: now }],
    accountJoinIntents: [{ intentId: 'rji_wait_fixture', rendezvousRequestId: requestId,
      instanceId: instance.instanceId, instance, deviceId: 'rdev_wait_fixture',
      accountDeviceId: 'adev_wait_fixture', accountId: 'acct_wait_fixture',
      devicePublicKey: phone.publicKey, devicePublicKeyFingerprint: createDevicePublicKeyFingerprint(phone.publicKey),
      nonceHash: '0'.repeat(64), issuedAt: now, createdAt: now, expiresAt: future,
      status: 'completed', completedAt: now, rendezvousResult: null }],
  };
  const hub = createRendezvousResultWaiters(capacities);
  const hooks = { afterRead: null, beforeCommit: null };
  const activity = { reads: 0, heldReadConnections: 0 };
  const store = {
    async readAccountRendezvousSnapshot() {
      activity.reads++; activity.heldReadConnections++;
      let snapshot;
      try { snapshot = structuredClone(state); } finally { activity.heldReadConnections--; }
      await hooks.afterRead?.(activity.reads);
      return snapshot;
    },
    async mutate(fn) {
      const next = structuredClone(state), result = await fn(next);
      await hooks.beforeCommit?.(); state = next; return result;
    },
  };
  function completion(result = { fixture: 'ready' }) {
    const issuedAt = new Date(clock()).toISOString(), audience = 'ragent-account-rendezvous-poll';
    return { instance, issuedAt, audience, requestId, result,
      signature: sign(null, Buffer.from(buildAccountRendezvousPollMessage({ instanceId: instance.instanceId,
        issuedAt, audience, requestId })), hostKeys.privateKey).toString('base64url') };
  }
  return { get state() { return state; }, hub, hooks, activity, store, requestId, token, completion,
    broker: makeRendezvousWaitBroker(store, { clock, rendezvousResultWaiters: hub }) };
}

export function makeRendezvousWaitBroker(store, options = {}) {
  return createOwnerAuthBroker({ store,
    verifyGoogleCredential: async () => { throw new Error('No Google credential exchange in wait fixture'); },
    resolveAccount: async () => { throw new Error('No account resolution in result wait'); },
    signAssertion: async () => { throw new Error('No assertion issuance in result wait'); },
    ...options,
  });
}

export async function until(condition, timeoutMs = 1000) {
  const deadline = performance.now()+timeoutMs;
  while (!condition()) {
    if (performance.now() >= deadline) throw new Error('Fixture condition deadline exceeded');
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}
