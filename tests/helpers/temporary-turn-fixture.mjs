import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createAccountsServer, createFileStore } from '../../accounts/server.mjs';
import { TemporaryPairingRegistry } from '../../chat/temporary-pairing-registry.mjs';
import { TemporaryPairingHost } from '../../chat/temporary-pairing-host.mjs';
import { createTemporaryPairingClient } from '../../lib/temporary-pairing-client.mjs';
import { loadOrCreateInstanceIdentity, signWithInstanceIdentity } from '../../lib/instance-identity.mjs';
import { buildTemporaryClaimMessage, temporaryInvitationDigest } from '../../lib/temporary-pairing-protocol.mjs';
import { buildTemporaryBrokerMessage } from '../../lib/temporary-pairing-broker-protocol.mjs';
import { issueTemporaryAccessCredential } from '../../lib/temporary-device-access.mjs';
import { createTurnCredentialBrokerHandler } from '../../infrastructure/turn-broker/turn-credential-broker.mjs';
import { requestTurnCredentials } from '../../lib/turn-credential-broker-client.mjs';

export const initial = 1_800_000_000_000;
export const id = (prefix) => `${prefix}_${randomBytes(24).toString('base64url')}`;
const issuer = 'http://127.0.0.1';
// Windows may allocate an ephemeral port that Node fetch refuses before sending HTTP.
// These are the blocked ports in the bundled Undici/Fetch implementation, not a service retry.
const fetchBlockedPorts = new Set(('1 7 9 11 13 15 17 19 20 21 22 23 25 37 42 43 53 69 77 79 87 95 '
  + '101 102 103 104 109 110 111 113 115 117 119 123 135 137 139 143 161 179 389 427 465 '
  + '512 513 514 515 526 530 531 532 540 548 554 556 563 587 601 636 989 990 993 995 '
  + '1719 1720 1723 2049 3659 4045 4190 5060 5061 6000 6566 6665 6666 6667 6668 6669 6679 6697 10080').split(' ').map(Number));
async function listen(t, handler) {
  const server = createServer((req, res) => { void handler(req, res); });
  for (let attempt = 0; ; attempt++) {
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    if (!fetchBlockedPorts.has(server.address().port)) break;
    await new Promise((done) => server.close(done));
    if (attempt >= 31) throw new Error('No fetch-compatible loopback test port');
  }
  t.after(() => new Promise((done) => { server.closeAllConnections(); server.close(done); }));
  return `http://127.0.0.1:${server.address().port}`;
}
export async function fixture(t, { initialTime = initial } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ragent-temporary-turn-'));
  t.after(async () => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); await rm(root, { recursive: true, force: true }); });
  let now = initialTime; const clock = () => now;
  const identity = await loadOrCreateInstanceIdentity({ filePath: join(root, 'identity.json') });
  const store = createFileStore(join(root, 'accounts.json'));
  const binding = { accountId: 'acct_temporary_turn', boundAt: new Date(initialTime).toISOString(), instanceId: identity.instanceId,
    instancePublicKey: identity.publicKey, instanceKeyFingerprint: identity.keyFingerprint, revokedAt: '' };
  await store.mutate((d) => {
    d.accounts = [{ accountId: binding.accountId, provider: 'google', providerSubject: 'fixture', createdAt: binding.boundAt }];
    d.instanceBindings = [binding];
  });
  const keys = { activeKeyId: 'test', keys: { test: randomBytes(32).toString('base64') } };
  const app = await createAccountsServer({ store, publicBaseUrl: `${issuer}/accounts`, allowInsecurePublicBaseUrl: true,
    signingKeyFile: join(root, 'signing.json'), turnBrokerSigningKeyFile: join(root, 'turn.json'), clock,
    temporaryPairingKeyRing: keys, verifyGoogleCredential: () => { throw new Error('No phone Google login'); },
    verifyNativeGoogleCredential: () => { throw new Error('No phone Google login'); } });
  const accountsUrl = `${await listen(t, async (req, res) => { if (!await app.handler(req, res)) { res.writeHead(404); res.end(); } })}/accounts`;
  const registry = new TemporaryPairingRegistry({ filePath: join(root, 'registry.json'), identity, clock });
  const client = createTemporaryPairingClient({ baseUrl: accountsUrl, identity, clock, allowInsecure: true });
  const host = new TemporaryPairingHost({ registry, client, binding: async () => binding, clock });
  const proof = (action, ticket, payload = {}) => {
    const input = { instanceId: identity.instanceId, invitationId: ticket.envelope.invitation.invitationId,
      requestId: id('rtr'), issuedAt: now, nonce: id('rtn'), payload };
    input.signature = signWithInstanceIdentity(identity, buildTemporaryBrokerMessage(action, input)); return input;
  };
  const enroll = async (device = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), options = {}) => {
    const ticket = await host.create(options);
    await app.temporaryBroker.register(proof('register', ticket, { envelope: ticket.envelope }));
    const claim = { instanceId: identity.instanceId, invitationId: ticket.envelope.invitation.invitationId,
      invitationDigest: temporaryInvitationDigest(ticket.envelope.invitation), requestId: id('rtr'), token: ticket.token,
      devicePublicKey: device.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
    claim.signature = sign('sha256', Buffer.from(buildTemporaryClaimMessage(claim)), device.privateKey).toString('base64url');
    await app.temporaryBroker.claim(claim); await registry.claim(claim);
    const row = (await registry.deliverySnapshot((await host.context()).bindingStamp)).records
      .find((r) => r.envelope.invitation.invitationId === claim.invitationId);
    const result = { grantId: row.grant.grantId, deviceId: row.grant.deviceId, deviceKeyFingerprint: row.grant.deviceKeyFingerprint,
      requestId: row.grant.requestId, grantedAt: row.grant.grantedAt, accessExpiresAt: row.envelope.invitation.accessExpiresAt };
    const accessCredential = issueTemporaryAccessCredential({ identity, envelope: row.envelope, grant: row.grant });
    await app.temporaryBroker.complete(proof('complete', ticket, { result, accessCredential }));
    await registry.recordDelivery(claim.invitationId, { completedGrantId: result.grantId });
    return { ticket, claim, result, device, accessCredential };
  };
  const jwks = await (await fetch(`${accountsUrl}/.well-known/turn-broker-jwks.json`)).json();
  const mintCalls = []; let mintHook;
  const turnHandler = createTurnCredentialBrokerHandler({ authMode: 'accounts-capability', accountsIssuer: issuer, jwks, clock,
    turnKeyId: 'fixture-key', apiToken: 'fixture-api-token-only-123456789', issueTurnCredentials: async (input) => {
      mintCalls.push(input); if (mintHook) return mintHook(input);
      return { iceServers: [{ urls: 'turn:fixture.invalid:3478', username: 'fixture-user', credential: 'fixture-password' }],
        expiresAt: new Date(clock() + input.ttlMs).toISOString() };
    } });
  const turnUrl = await listen(t, turnHandler);
  const reserve = (phone) => client.request('turn-reserve', phone.claim.invitationId);
  const mint = (reservation, phone, extra = {}) => requestTurnCredentials({ brokerUrl: turnUrl, authMode: 'accounts-capability',
    capabilityToken: reservation.brokerCredential.token, accountId: reservation.lease.accountId, instanceId: identity.instanceId,
    deviceId: phone.result.deviceId, connectionId: reservation.lease.connectionId,
    idempotencyKey: reservation.brokerCredential.idempotencyKey, nowMs: clock(), clock, attempts: 1,
    temporaryGrant: { grantId: phone.result.grantId, invitationId: phone.claim.invitationId, accessExpiresAt: phone.accessCredential.expires_at }, ...extra });
  return { root, app, store, keys, identity, registry, host, client, clock, proof, jwks, mintCalls, enroll, reserve, mint, turnUrl, binding,
    setMintHook: (hook) => { mintHook = hook; }, advance: (ms) => { now += ms; } };
}
