#!/usr/bin/env node
// Run only against an isolated, migrated PostgreSQL database.
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createPostgresStoreFromUrl } from '../accounts/store/postgres.mjs';
import { createTemporaryPairingBroker } from '../accounts/temporary-pairing-broker.mjs';
import { createTemporaryClaimCipher } from '../accounts/temporary-pairing-cipher.mjs';
import { TemporaryPairingRegistry } from '../chat/temporary-pairing-registry.mjs';
import { loadOrCreateInstanceIdentity, signWithInstanceIdentity } from '../lib/instance-identity.mjs';
import { buildTemporaryClaimMessage, temporaryInvitationDigest } from '../lib/temporary-pairing-protocol.mjs';
import { buildTemporaryBrokerMessage } from '../lib/temporary-pairing-broker-protocol.mjs';

const databaseUrl = process.env.RAGENT_TEMPORARY_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('Set RAGENT_TEMPORARY_TEST_DATABASE_URL to an isolated migrated database');
const id = (prefix) => `${prefix}_${randomBytes(24).toString('base64url')}`;
const now = 1_800_000_000_000;
const clock = () => now;
const storeA = createPostgresStoreFromUrl(databaseUrl);
if (process.argv[2] === '--verify-child') {
  try {
    const invitationId = process.argv[3];
    const snapshot = await storeA.mutate((draft) => ({
      rows: draft.temporaryPairingExchanges.filter((row) => row.invitationId === invitationId),
      highWater: draft.temporaryPairingClock,
    }));
    assert.equal(snapshot.rows.length, 1);
    assert.equal(snapshot.rows[0].status, 'COMPLETED');
    assert.equal(snapshot.highWater, now);
    console.log('independent process recovered completed exchange');
  } finally { await storeA.close(); }
} else {
  const storeB = createPostgresStoreFromUrl(databaseUrl);
  const root = await mkdtemp(join(tmpdir(), 'ragent-temporary-pg-'));
  try {
    const identity = await loadOrCreateInstanceIdentity({ filePath: join(root, 'instance.json') });
    const accountId = id('acct');
    const boundAt = new Date(now).toISOString();
    await storeA.mutate((draft) => {
      draft.accounts.push({ accountId, provider: 'google', providerSubject: id('subject'), createdAt: boundAt });
      draft.instanceBindings.push({ instanceId: identity.instanceId, accountId, boundAt,
        instancePublicKey: identity.publicKey, instanceKeyFingerprint: identity.keyFingerprint, revokedAt: '' });
    });
    const keys = { activeKeyId: 'test', keys: { test: randomBytes(32).toString('base64') } };
    const brokerA = createTemporaryPairingBroker({ store: storeA, cipher: createTemporaryClaimCipher(keys), clock });
    const brokerB = createTemporaryPairingBroker({ store: storeB, cipher: createTemporaryClaimCipher(keys), clock });
    const pc = new TemporaryPairingRegistry({ filePath: join(root, 'pc.json'), identity, clock });
    const ticket = await pc.create();
    const invitationId = ticket.envelope.invitation.invitationId;
    const proof = (action, payload = {}, device) => {
      const input = { instanceId: identity.instanceId, invitationId,
        requestId: action === 'result' ? device.claim.requestId : id('rtr'),
        issuedAt: now, nonce: id('rtn'), payload };
      const message = buildTemporaryBrokerMessage(action, input);
      input.signature = action === 'result'
        ? sign('sha256', Buffer.from(message), device.key.privateKey).toString('base64url')
        : signWithInstanceIdentity(identity, message);
      return input;
    };
    await brokerA.register(proof('register', { envelope: ticket.envelope }));
    const phones = [0, 1].map(() => {
      const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const claim = { instanceId: identity.instanceId, invitationId,
        invitationDigest: temporaryInvitationDigest(ticket.envelope.invitation),
        requestId: id('rtr'), devicePublicKey: key.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        token: ticket.token };
      claim.signature = sign('sha256', Buffer.from(buildTemporaryClaimMessage(claim)), key.privateKey).toString('base64url');
      return { key, claim };
    });
    const outcomes = await Promise.allSettled([brokerA.claim(phones[0].claim), brokerB.claim(phones[1].claim)]);
    assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1);
    const winner = phones[outcomes.findIndex((result) => result.status === 'fulfilled')];
    const loser = outcomes.find((result) => result.status === 'rejected');
    assert.equal(loser.reason.code, 'temporary_broker_already_claimed');
    const forwarded = await brokerB.inbox(proof('inbox'));
    assert.equal(forwarded.claim.requestId, winner.claim.requestId);
    const accepted = await pc.claim(forwarded.claim);
    const result = { ...accepted.grant, requestId: winner.claim.requestId, accessExpiresAt: accepted.accessExpiresAt };
    await brokerA.complete(proof('complete', { result }));
    const delivered = await brokerB.result(proof('result', {}, winner));
    assert.equal(delivered.status, 'COMPLETED');
    assert.equal(delivered.completion.payload.result.grantId, result.grantId);

    const before = await storeA.mutate((draft) => draft.temporaryPairingExchanges.length);
    await assert.rejects(storeB.mutate((draft) => {
      draft.temporaryPairingExchanges.length = 0;
      throw new Error('rollback-check');
    }), /rollback-check/);
    assert.equal(await storeA.mutate((draft) => draft.temporaryPairingExchanges.length), before);
    const child = spawnSync(process.execPath, [new URL(import.meta.url).pathname, '--verify-child', invitationId], {
      env: process.env, encoding: 'utf8', timeout: 15_000,
    });
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /independent process recovered/);
    console.log('PostgreSQL concurrent claim, rollback, and cross-process recovery passed');
  } finally {
    await Promise.all([storeA.close(), storeB.close()]);
    await rm(root, { recursive: true, force: true });
  }
}
