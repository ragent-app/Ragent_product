import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const releaseRoot = resolve(process.argv[2] || '.');
const { createAccountPairingBroker } = await import(pathToFileURL(resolve(releaseRoot, 'accounts/account-pairing-broker.mjs')));
const { createOwnerAuthBroker } = await import(pathToFileURL(resolve(releaseRoot, 'accounts/owner-auth-broker.mjs')));
import { createTemporaryClaimCipher } from '../accounts/temporary-pairing-cipher.mjs';
import { accountPairingHash, buildAccountPairingProof } from '../lib/account-pairing-protocol.mjs';
import { buildAccountSessionMessage, buildDesktopAccountSessionAuthorization, createDevicePublicKeyFingerprint } from '../lib/device-auth-protocol.mjs';
import { createInstancePublicKeyFingerprint } from '../lib/instance-proof-protocol.mjs';
import { AccountPairingService } from '../chat/account-pairing-service.mjs';
import { createAccountPairingClient } from '../lib/account-pairing-client.mjs';

let now = Date.now();
const pc = generateKeyPairSync('ed25519');
const phone = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pcKey = pc.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const phoneKey = phone.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const instanceId = 'inst_pairing_desktop_0001'; const invitationId = 'rpinv_pairing_ticket_0001';
let state = { instanceBindings: [{ instanceId, accountId: 'acct_pairing_owner', instancePublicKey: pcKey,
  instanceKeyFingerprint: createInstancePublicKeyFingerprint(pcKey), boundAt: new Date(now).toISOString() }] };
let inTransaction = false;
const store = { mutate: async (fn) => {
  assert.equal(inTransaction, false, 'issuance must not open a nested transaction'); inTransaction = true;
  try { const draft = structuredClone(state); const result = await fn(draft); state = draft; return result; }
  finally { inTransaction = false; }
} };
const owner = createOwnerAuthBroker({ store, clock: () => now,
  verifyGoogleCredential: async () => { throw new Error('Google must not be required'); },
  resolveAccount: async () => { throw new Error('Google must not be required'); }, signAssertion: async () => 'unused' });
const cipher = createTemporaryClaimCipher({ activeKeyId: 'test', keys: { test: randomBytes(32).toString('base64') } });
const broker = createAccountPairingBroker({ store, cipher, clock: () => now,
  issueSession: owner.completeDelegatedAccountSessionInTransaction });
const request = (action, payload = {}, key = pc) => {
  const input = { instanceId, invitationId, issuedAt: now, nonce: randomBytes(18).toString('hex'), payload };
  input.signature = sign(key === pc ? null : 'sha256', Buffer.from(buildAccountPairingProof(action, input)), key.privateKey).toString('base64url');
  return input;
};
const token = randomBytes(32).toString('base64url');
let consumed = 0; let localInvitation;
const serviceOptions = { identity: { instanceId, publicKey: pcKey,
  privateKey: pc.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() },
  binding: async () => state.instanceBindings[0], clock: () => now,
  createInvitation: async (options) => {
    localInvitation = { id: invitationId, tokenHash: accountPairingHash(token), accountHandoffAccountId: options.accountHandoffAccountId,
      expiresAt: new Date(now + 120_000).toISOString() };
    return { ...localInvitation, pairingUri: 'ragent://pair?v=3&t=example' };
  },
  getInvitation: async () => localInvitation,
  listPendingInvitations: async () => [localInvitation],
  consumeInvitation: async () => { consumed++; localInvitation.usedAt ||= new Date(now).toISOString(); },
  client: createAccountPairingClient({ baseUrl: 'https://accounts.example.test', clock: () => now,
    identity: { instanceId, publicKey: pcKey, privateKey: pc.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() },
    fetchImpl: async (url, options) => {
      const input = JSON.parse(options.body);
      assert.equal(options.redirect, 'error'); assert.equal(options.headers.Authorization, undefined);
      return Response.json(await broker[new URL(url).pathname.split('/').at(-1)](input));
    } }),
};
const service = new AccountPairingService(serviceOptions);
const qr = await service.create();
assert.equal(qr.accountHandoff, true); assert.equal(new URL(qr.pairingUri).searchParams.get('v'), '4');
assert.equal(new URL(qr.pairingUri).searchParams.get('q'), invitationId);
await assert.rejects(service.approve(invitationId), { code: 'account_pairing_not_claimed' });
const requestId = 'phone_account_request_0001'; const deviceId = 'adev_pairing_phone_0001';
const challenge = await owner.createAccountSessionChallenge({ requestId, device: { deviceId, publicKey: phoneKey, platform: 'android' } });
const material = { transactionId: challenge.transactionId, requestId, deviceId,
  publicKeyFingerprint: createDevicePublicKeyFingerprint(phoneKey), nonce: challenge.nonce };
const deviceSignature = sign('sha256', Buffer.from(buildAccountSessionMessage(material)), phone.privateKey).toString('base64');
const claim = { token, transactionId: challenge.transactionId, requestId, deviceSignature };
await assert.rejects(broker.claim(request('claim', { ...claim, token: 'wrong' }, phone)), { code: 'account_pairing_ticket_invalid' });
await broker.claim(request('claim', claim, phone));
await assert.rejects(broker.inbox(request('inbox', {}, phone)), { code: 'account_pairing_proof_invalid' });
assert.equal((await broker.result(request('result', {}, phone))).session, null);
assert.equal((await broker.inbox(request('inbox'))).claim.publicKeyFingerprint, material.publicKeyFingerprint);
const proof = { instanceId, accountId: 'acct_pairing_owner', issuedAt: new Date(now).toISOString() };
proof.signature = sign(null, Buffer.from(buildDesktopAccountSessionAuthorization({ ...material, ...proof })), pc.privateKey).toString('base64url');
await assert.rejects(broker.approve(request('approve', { desktopProof: { ...proof, signature: 'bad' } })), { code: 'owner_auth_desktop_authorization_invalid' });
assert.equal(state.accountCredentials?.length || 0, 0, 'failed approval commits no credential');
// The browser panel is absent. Recover the persisted QR consent in a new service.
const resumed = new AccountPairingService(serviceOptions);
localInvitation.accountHandoffAccountId = 'acct_another_owner';
await resumed.pollPending();
assert.equal(state.accountCredentials?.length || 0, 0, 'changed source account must not auto-authorize');
await assert.rejects(resumed.approve(invitationId), { code: 'account_pairing_source_changed' });
localInvitation.accountHandoffAccountId = '';
await resumed.pollPending();
assert.equal(state.accountCredentials?.length || 0, 0, 'legacy or temporary invitations have no automatic consent');
localInvitation.accountHandoffAccountId = 'acct_pairing_owner';
await Promise.all([resumed.pollPending(), resumed.pollPending()]);
const approved = await resumed.status(invitationId);
assert.equal(approved.status, 'APPROVED'); assert.equal(approved.credential, undefined); assert.equal(approved.session, undefined);
const result = await broker.result(request('result', {}, phone));
assert.match(result.session.credential.token, /^rac_/);
assert.equal(result.session.accountId, 'acct_pairing_owner');
assert.equal(JSON.stringify(state).includes(result.session.credential.token), false, 'delivery is encrypted at rest');
assert.equal(JSON.stringify(state).includes(token), false, 'QR secret is hashed at rest');
await service.approve(invitationId);
assert.equal(consumed, 2, 'lost approval response recovers consumption without another credential');
assert.equal((await broker.result(request('result', {}, phone))).session.credential.token, result.session.credential.token,
  'response loss must return the same session');
assert.equal(state.accountCredentials.length, 1);
await resumed.pollPending();
assert.equal(consumed, 2, 'consumed consent must stop polling');
const replay = request('result', {}, phone); await broker.result(replay);
await assert.rejects(broker.result(replay), { code: 'account_pairing_proof_replayed' });
now += 120_000;
await assert.rejects(broker.result(request('result', {}, phone)), { code: 'account_pairing_inactive' });
now -= 120_000;
await assert.rejects(broker.result(request('result', {}, phone)), { code: 'account_pairing_inactive' });
assert.equal(state.accountPairingExchanges[0].sealedSession, null);
console.log('test-account-pairing-broker: passed');
