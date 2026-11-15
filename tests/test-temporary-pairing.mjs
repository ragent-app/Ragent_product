import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadOrCreateInstanceIdentity } from '../lib/instance-identity.mjs';
import {
  TEMPORARY_PAIRING_CAPABILITIES, buildTemporaryClaimMessage, temporaryInvitationDigest,
  verifyTemporaryInvitation, temporaryPublicKey, buildTemporaryInvitationMessage, verifyTemporaryClaim,
} from '../lib/temporary-pairing-protocol.mjs';
import { TemporaryPairingRegistry } from '../chat/temporary-pairing-registry.mjs';

const now = 1_800_000_000_000;
const freshId = (prefix) => `${prefix}_${randomBytes(24).toString('base64url')}`;
const rejects = (promise, code) => assert.rejects(promise, (error) => error.code === code);
const phone = (algorithm = 'ec') => generateKeyPairSync(algorithm,
  algorithm === 'ec' ? { namedCurve: 'prime256v1' } : undefined);
function claimFor(ticket, key = phone(), patch = {}) {
  const i = ticket.envelope.invitation;
  const claim = { instanceId: i.instanceId, invitationId: i.invitationId,
    invitationDigest: temporaryInvitationDigest(i), requestId: freshId('rtr'),
    devicePublicKey: key.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    token: ticket.token, ...patch };
  claim.signature = sign(key.privateKey.asymmetricKeyType === 'ec' ? 'sha256' : null,
    Buffer.from(buildTemporaryClaimMessage(claim)), key.privateKey).toString('base64url');
  return claim;
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ragent-temporary-pairing-'));
  t.after(async () => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    await rm(root, { recursive: true, force: true });
  });
  const identity = await loadOrCreateInstanceIdentity({ filePath: join(root, 'identity.json') });
  const filePath = join(root, 'temporary.json');
  let time = now;
  const open = () => new TemporaryPairingRegistry({ filePath, identity, clock: () => time });
  return { root, identity, filePath, open, registry: open(), time: (value) => { time = value; } };
}

test('signed fixed-deadline invitation carries no account binding or transport endpoint', async (t) => {
  const f = await fixture(t); const ticket = await f.registry.create();
  const i = verifyTemporaryInvitation(ticket.envelope, f.identity);
  assert.equal(i.accessExpiresAt, now + 600_000);
  assert.equal(i.claimExpiresAt, now + 120_000);
  assert.equal(i.sessionScope, 'created-sessions');
  assert.deepEqual(i.capabilities, [...TEMPORARY_PAIRING_CAPABILITIES].sort());
  assert.equal('endpoint' in i, false); assert.equal('accountId' in i, false);
  const disk = await readFile(f.filePath, 'utf8');
  assert.equal(disk.includes(ticket.token), false);
  assert.equal(disk.includes(f.identity.privateKey), false);
});

test('Android shared fixture verifies both PC invitation and phone claim signatures', async () => {
  const fixture = JSON.parse(await readFile(new URL('../android/core/protocol/src/test/resources/fixtures/temporary-pairing-signed.json', import.meta.url), 'utf8'));
  const i = fixture.envelope.invitation;
  verifyTemporaryInvitation(fixture.envelope, { instanceId: i.instanceId, keyFingerprint: i.instanceKeyFingerprint });
  verifyTemporaryClaim(fixture.claim);
  assert.equal(buildTemporaryInvitationMessage(i), fixture.invitationMessage);
  assert.equal(buildTemporaryClaimMessage(fixture.claim), fixture.claimMessage);
});

test('a broker cannot substitute target key, privileges, scope or deadline', async (t) => {
  const f = await fixture(t); const ticket = await f.registry.create({ capabilities: ['task.read'] });
  const other = await loadOrCreateInstanceIdentity({ filePath: join(f.root, 'other.json') });
  assert.throws(() => verifyTemporaryInvitation({ ...ticket.envelope, publicKey: other.publicKey }, f.identity));
  for (const patch of [
    { capabilities: ['task.read', 'task.submit'] }, { accessExpiresAt: now + 599_999 },
    { sessionScope: 'all-sessions' }, { accountId: 'owner' }, { version: 3 },
    { instanceId: other.instanceId }, { createdAt: now + 1 },
  ]) {
    assert.throws(() => verifyTemporaryInvitation({ ...ticket.envelope,
      invitation: { ...ticket.envelope.invitation, ...patch } }, f.identity));
  }
});

test('wire bytes are stable across object/capability order and public key encodings', async (t) => {
  const f = await fixture(t); const ticket = await f.registry.create(); const key = phone();
  const i = ticket.envelope.invitation;
  const reordered = Object.fromEntries(Object.entries(i).reverse());
  reordered.capabilities = [...i.capabilities].reverse();
  assert.equal(buildTemporaryInvitationMessage(i), buildTemporaryInvitationMessage(reordered));
  const claim = claimFor(ticket, key);
  assert.equal(buildTemporaryClaimMessage(claim), buildTemporaryClaimMessage({ ...claim,
    devicePublicKey: key.publicKey.export({ type: 'spki', format: 'pem' }).toString() }));
});

for (const algorithm of ['ec', 'ed25519']) test(`${algorithm} proof claims once and persists across cold reopen`, async (t) => {
  const f = await fixture(t); const ticket = await f.registry.create(); const claim = claimFor(ticket, phone(algorithm));
  const receipt = await f.registry.claim(claim);
  assert.equal(receipt.status, 'CLAIMED');
  assert.equal(receipt.accessExpiresAt, ticket.envelope.invitation.accessExpiresAt);
  f.time(now + 180_000); // Claim window ended, but exact response-loss recovery is still valid.
  assert.deepEqual(await f.open().claim(claim), receipt);
  assert.deepEqual(await f.open().activeGrant(receipt.grant.grantId, receipt.grant.deviceKeyFingerprint), receipt);
});

test('stolen public metadata without token, altered request and different proof cannot claim', async (t) => {
  const f = await fixture(t); const ticket = await f.registry.create(); const claim = claimFor(ticket);
  await rejects(f.registry.claim({ ...claim, token: freshId('rtt') }), 'temporary_pairing_ticket_invalid');
  await rejects(f.registry.claim({ ...claim, requestId: freshId('rtr') }), 'temporary_pairing_proof_invalid');
  const other = claimFor(ticket);
  await rejects(f.registry.claim({ ...claim, devicePublicKey: other.devicePublicKey }), 'temporary_pairing_proof_invalid');
  await rejects(f.registry.claim({ ...claim, token: ticket.token.replace('rtt_', 'rpi_') }), 'temporary_pairing_invalid_id');
  await rejects(f.registry.claim({ ...claim, signature: claim.signature + '=' }), 'temporary_pairing_invalid_signature');
  assert.equal((await f.registry.list())[0].status, 'PENDING');
});

test('proof binds invitation digest and cannot be replayed against a second invitation or PC', async (t) => {
  const f = await fixture(t); const first = await f.registry.create(); const second = await f.registry.create();
  const claim = claimFor(first);
  await rejects(f.registry.claim({ ...claim, token: second.token, invitationId: second.envelope.invitation.invitationId }),
    'temporary_pairing_proof_invalid');
  const validButWrong = claimFor(first, phone(), { invitationDigest: temporaryInvitationDigest(second.envelope.invitation) });
  await rejects(f.registry.claim(validButWrong), 'temporary_pairing_ticket_invalid');
  const wrongInstance = claimFor(first, phone(), { instanceId: freshId('inst') });
  await rejects(f.registry.claim(wrongInstance), 'temporary_pairing_ticket_invalid');
});

test('concurrent registries admit only one device and one request identity per invitation', async (t) => {
  const f = await fixture(t); const ticket = await f.registry.create(); const first = claimFor(ticket);
  const results = await Promise.allSettled([f.registry.claim(first), f.open().claim(claimFor(ticket))]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'temporary_pairing_already_claimed');
  const again = await f.open().claim(first);
  assert.equal(again.grant.grantId, results[0].value.grant.grantId);
  // Re-signing a new request ID with the original phone also cannot renew or re-claim.
  const key = phone(); const another = await f.registry.create(); await f.registry.claim(claimFor(another, key));
  await rejects(f.registry.claim(claimFor(another, key)), 'temporary_pairing_already_claimed');
});

test('observed invitation expiry is durable even after clock rollback and rejected claim', async (t) => {
  const f = await fixture(t); const ticket = await f.registry.create(); const claim = claimFor(ticket);
  f.time(now + 120_000);
  await rejects(f.registry.claim(claim), 'temporary_pairing_inactive');
  f.time(now);
  await rejects(f.open().claim(claim), 'temporary_pairing_inactive');
  assert.equal((await f.open().list())[0].status, 'EXPIRED');
});

test('absolute grant expiry cannot be extended by recovery, reopen or clock rollback', async (t) => {
  const f = await fixture(t); const ticket = await f.registry.create(); f.time(now + 119_999);
  const claim = claimFor(ticket); const receipt = await f.registry.claim(claim);
  assert.equal(receipt.accessExpiresAt, now + 600_000);
  f.time(now + 600_000);
  await rejects(f.registry.activeGrant(receipt.grant.grantId, receipt.grant.deviceKeyFingerprint), 'temporary_pairing_inactive');
  f.time(now + 120_000);
  await rejects(f.open().claim(claim), 'temporary_pairing_inactive');
});

test('owner revocation survives reopen and does not stop an independently issued invitation', async (t) => {
  const f = await fixture(t); const first = await f.registry.create(); const second = await f.registry.create();
  const claim = claimFor(first); const receipt = await f.registry.claim(claim);
  await f.registry.revoke(first.envelope.invitation.invitationId);
  await rejects(f.open().claim(claim), 'temporary_pairing_inactive');
  await rejects(f.open().activeGrant(receipt.grant.grantId, receipt.grant.deviceKeyFingerprint), 'temporary_pairing_inactive');
  assert.equal((await f.open().claim(claimFor(second))).status, 'CLAIMED');
  const pending = await f.registry.create(); await f.registry.revoke(pending.envelope.invitation.invitationId);
  await rejects(f.open().claim(claimFor(pending)), 'temporary_pairing_inactive');
});

test('a new Node process observes the same durable grant and subsequent revocation', async (t) => {
  const f = await fixture(t); const ticket = await f.registry.create(); const receipt = await f.registry.claim(claimFor(ticket));
  const source = `
    import { TemporaryPairingRegistry } from ${JSON.stringify(new URL('../chat/temporary-pairing-registry.mjs', import.meta.url).href)};
    import { loadInstanceIdentity } from ${JSON.stringify(new URL('../lib/instance-identity.mjs', import.meta.url).href)};
    const [filePath, identityPath, grantId, fingerprint] = process.argv.slice(1);
    const identity = await loadInstanceIdentity({ filePath: identityPath });
    const registry = new TemporaryPairingRegistry({ filePath, identity, clock: () => ${now + 1} });
    try { console.log(JSON.stringify(await registry.activeGrant(grantId, fingerprint))); }
    catch (error) { console.log(JSON.stringify({ code: error.code })); }
  `;
  const read = async () => JSON.parse((await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source,
    f.filePath, join(f.root, 'identity.json'), receipt.grant.grantId, receipt.grant.deviceKeyFingerprint])).stdout);
  assert.deepEqual(await read(), receipt);
  await f.registry.revoke(ticket.envelope.invitation.invitationId);
  assert.deepEqual(await read(), { code: 'temporary_pairing_inactive' });
});

test('grant lookup is device-bound and returned arrays cannot mutate persisted authority', async (t) => {
  const f = await fixture(t); const ticket = await f.registry.create({ capabilities: ['task.read'] });
  const receipt = await f.registry.claim(claimFor(ticket));
  await rejects(f.registry.activeGrant(receipt.grant.grantId, '0'.repeat(64)), 'temporary_pairing_inactive');
  receipt.capabilities.push('task.submit');
  assert.deepEqual((await f.registry.activeGrant(receipt.grant.grantId, receipt.grant.deviceKeyFingerprint)).capabilities, ['task.read']);
});

test('invalid permissions, unbounded deadlines and unsafe wire fields fail closed', async (t) => {
  const f = await fixture(t);
  for (const options of [{ capabilities: [] }, { capabilities: ['owner'] }, { capabilities: ['task.read', 'task.read'] },
    { claimTtlMs: 120_001 }, { claimTtlMs: 0 }, { accessTtlMs: 600_001 },
    { accessTtlMs: 1 }, { accessTtlMs: Infinity }, { claimTtlMs: '100' }]) {
    await assert.rejects(f.registry.create(options));
  }
  assert.equal((await f.registry.list()).length, 0);
  const ticket = await f.registry.create(); const claim = claimFor(ticket);
  await rejects(f.registry.claim({ ...claim, requestId: `${claim.requestId}\nowner` }), 'temporary_pairing_invalid_id');
  assert.throws(() => temporaryPublicKey(generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).publicKey
    .export({ type: 'spki', format: 'pem' }).toString()));
});

test('corrupt, mismatched and unknown-version storage is never treated as a fresh empty registry', async (t) => {
  const f = await fixture(t); await f.registry.create();
  const valid = JSON.parse(await readFile(f.filePath, 'utf8'));
  for (const text of ['{broken', JSON.stringify({ ...valid, version: 2 }),
    JSON.stringify({ ...valid, instanceId: freshId('inst') }),
    JSON.stringify({ ...valid, records: [{ ...valid.records[0], status: 'CLAIMED' }] }),
    JSON.stringify({ ...valid, records: [valid.records[0], valid.records[0]] })]) {
    await writeFile(f.filePath, text);
    await rejects(f.open().create(), 'temporary_pairing_store_invalid');
    assert.equal(await readFile(f.filePath, 'utf8'), text);
  }
});

test('capacity includes revoked tickets until absolute expiry; discarded tickets cannot be reused', async (t) => {
  const f = await fixture(t); const ticket = await f.registry.create(); const claim = claimFor(ticket);
  const initial = JSON.parse(await readFile(f.filePath, 'utf8'));
  // Build 256 legitimate signatures in memory, avoiding 256 fsyncs in the fixture setup.
  const { signWithInstanceIdentity } = await import('../lib/instance-identity.mjs');
  for (let index = 1; index < 256; index++) {
    const invitation = { ...ticket.envelope.invitation, invitationId: freshId('rti') };
    initial.records.push({ envelope: { invitation, publicKey: f.identity.publicKey,
      signature: signWithInstanceIdentity(f.identity, buildTemporaryInvitationMessage(invitation)) }, status: 'PENDING', grant: null });
  }
  await writeFile(f.filePath, JSON.stringify(initial));
  await f.registry.revoke(ticket.envelope.invitation.invitationId);
  await rejects(f.registry.create(), 'temporary_pairing_capacity');
  f.time(now + 600_000); await f.registry.create();
  assert.equal((await f.registry.list()).length, 1);
  await rejects(f.registry.claim(claim), 'temporary_pairing_ticket_invalid');
});
