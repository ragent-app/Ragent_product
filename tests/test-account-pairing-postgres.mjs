// Uses a fresh schema only; never truncates or migrates an existing schema.
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Pool } from 'pg';
import { createPostgresStore } from '../accounts/store/postgres.mjs';
import { createTemporaryControlBroker } from '../accounts/temporary-control-broker.mjs';
import { createTemporaryClaimCipher } from '../accounts/temporary-pairing-cipher.mjs';
import { TemporaryControlRegistry } from '../chat/temporary-control-registry.mjs';
import { TemporaryControlHost } from '../chat/temporary-control-host.mjs';
import { loadOrCreateInstanceIdentity, signWithInstanceIdentity } from '../lib/instance-identity.mjs';
import { buildTemporaryControlClaimMessage, temporaryControlInvitationDigest } from '../lib/temporary-control-protocol.mjs';
import { buildTemporaryControlBrokerMessage } from '../lib/temporary-control-broker-protocol.mjs';

const url = process.env.RAGENT_PAIRING_PG_URL;
if (!url) throw new Error('RAGENT_PAIRING_PG_URL is required for the isolated schema test');
const schema = `qa_account_pairing_${randomBytes(10).toString('hex')}`;
assert.match(schema, /^qa_account_pairing_[a-f0-9]{20}$/);
const pool = new Pool({ connectionString: url, max: 2 });
const controlRoot = await mkdtemp(join(tmpdir(), 'ragent-pg-anonymous-control-'));
let created = false;
let scopedPool;
try {
  const client = await pool.connect();
  try {
    await client.query(`create schema "${schema}"`); created = true;
    await client.query('begin');
    await client.query(`set local search_path to "${schema}"`);
    const dir = new URL('../accounts/migrations/', import.meta.url);
    for (const name of (await readdir(dir)).filter((x) => x.endsWith('.up.sql')).sort()) {
      await client.query(await readFile(new URL(name, dir), 'utf8'));
    }
    await client.query('commit');
  } catch (error) { await client.query('rollback'); throw error; }
  finally { client.release(); }
  scopedPool = new Pool({ connectionString: url, max: 2, options: `-c search_path=${schema}` });
  assert.equal((await scopedPool.query('select current_schema() as schema')).rows[0].schema, schema);
  const store = createPostgresStore({ pool: scopedPool, schema });
  const record = { instanceId: 'inst_pg_pairing', invitationId: 'rpinv_pg_pairing', accountId: 'acct_pg_pairing',
    status: 'CLAIMED', expiresAt: Date.now() + 120000, observedAt: Date.now(), nonces: [],
    claim: { transactionId: 'oasc_pg_pairing' }, sealedSession: null };
  await store.mutate((draft) => { draft.accountPairingExchanges.push(record); });
  assert.deepEqual(await store.mutate((draft) => draft.accountPairingExchanges), [record]);
  await assert.rejects(store.mutate((draft) => {
    draft.accountPairingExchanges[0].status = 'APPROVED';
    throw new Error('test rollback');
  }), /test rollback/);
  assert.equal(await store.mutate((draft) => draft.accountPairingExchanges[0].status), 'CLAIMED');
  await store.mutate((draft) => { draft.accountPairingExchanges = []; });
  assert.deepEqual(await store.mutate((draft) => draft.accountPairingExchanges), []);
  const identity = await loadOrCreateInstanceIdentity({ filePath: join(controlRoot, 'identity.json') });
  const registry = new TemporaryControlRegistry({ identity, filePath: join(controlRoot, 'control.json') });
  const host = new TemporaryControlHost({ registry });
  const broker = createTemporaryControlBroker({ store, issuer: 'https://qa.example',
    cipher: createTemporaryClaimCipher({ activeKeyId: 'qa', keys: { qa: randomBytes(32).toString('base64') } }),
    signTurnBrokerCapability: async () => 'qa-capability' });
  const proof = (action, invitationId, payload = {}) => {
    const input = { instanceId: identity.instanceId, invitationId, requestId: `rtr_${randomBytes(24).toString('hex')}`,
      issuedAt: Date.now(), nonce: `rtn_${randomBytes(24).toString('hex')}`, payload };
    input.signature = signWithInstanceIdentity(identity, buildTemporaryControlBrokerMessage(action, input)); return input;
  };
  const ticket = await registry.create(); const invitation = ticket.envelope.invitation;
  await broker.register(proof('register', invitation.invitationId, { envelope: ticket.envelope }));
  const device = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const claim = { instanceId: identity.instanceId, invitationId: invitation.invitationId,
    invitationDigest: temporaryControlInvitationDigest(invitation), token: ticket.token,
    requestId: `rtr_${randomBytes(24).toString('hex')}`, devicePublicKey: device.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
  claim.signature = sign('sha256', Buffer.from(buildTemporaryControlClaimMessage(claim)), device.privateKey).toString('base64url');
  await broker.claim(claim); await registry.claim(claim);
  const active = await registry.confirm(invitation.invitationId);
  await broker.complete(proof('complete', invitation.invitationId, { grant: active.grant,
    accessCredential: await host.credentialForGrant(active.grant.grantId) }));
  const reservation = await broker['turn-reserve'](proof('turn-reserve', invitation.invitationId));
  assert.match(reservation.lease.accountId, /^temporary_[a-f0-9]{64}$/);
  assert.equal((await broker['turn-reserve'](proof('turn-reserve', invitation.invitationId))).lease.connectionId, reservation.lease.connectionId);
  assert.equal(await store.mutate((draft) => draft.accounts.length), 0, 'anonymous relay creates no account');
  assert.equal(await store.mutate((draft) => draft.instanceBindings.length), 0, 'anonymous relay creates no binding');
  assert.equal(await store.mutate((draft) => draft.turnConnectionLeases.length), 0, 'account FK lease table stays account-only');
  await broker.revoke(proof('revoke', invitation.invitationId));
  assert.equal(await store.mutate((draft) => draft.temporaryControlExchanges[0].turn.lease.status), 'released');
  await store.close();
  console.log('test-account-pairing-postgres: isolated account exchange and anonymous control relay passed');
} finally {
  if (scopedPool) await scopedPool.end();
  if (created) await pool.query(`drop schema "${schema}" cascade`);
  await pool.end();
  assert.ok(resolve(controlRoot).startsWith(resolve(tmpdir()) + sep));
  await rm(controlRoot, { recursive: true, force: true });
}
