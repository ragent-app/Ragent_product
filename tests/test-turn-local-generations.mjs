import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
const home = await mkdtemp(join(tmpdir(), 'ragent-local-turn-generation-'));
Object.assign(process.env, { HOME: home, RAGENT_CONFIG_DIR: join(home, 'config'), RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES: '1' });
delete process.env.RAGENT_INSTANCE_ROOT;
const leases = await import('../chat/turn-connection-leases.mjs');
const { createTurnConnectionId } = await import('../lib/turn-authorization.mjs');
const { createTurnLeaseId } = await import('../lib/turn-lease-identity.mjs');
const { TURN_CONNECTION_LEASES_FILE } = await import('../lib/config.mjs');
let now = Date.now();
const pair = { accountId: 'acct-local-generation', instanceId: 'inst-local-generation', deviceId: 'phone-generation' };
const logical = createTurnConnectionId(pair), a = createTurnLeaseId(logical, undefined, now), b = createTurnLeaseId(logical, undefined, now);
const reserve = (connectionId, expiresAt = new Date(now + 300_000).toISOString()) => leases.reserveTurnConnectionLease({ ...pair,
  connectionId, expiresAt, deviceKind: 'phone', clock: () => now });
const release = connectionId => leases.releaseTurnConnectionLease({ deviceId: pair.deviceId, connectionId, clock: () => now });
try {
  assert.equal((await reserve(a)).connectionId, a);
  const second = await reserve(b); assert.equal(second.connectionId, b);
  assert.equal((await release(a)).released, 0);
  assert.equal((await leases.markTurnConnectionLeaseConnected({ deviceId: pair.deviceId, connectionId: a, clock: () => now })).updated, false);
  assert.equal((await leases.markTurnConnectionLeaseConnected({ deviceId: pair.deviceId, connectionId: b, clock: () => now })).updated, true);
  assert.equal((await reserve(b, new Date(now + 900_000).toISOString())).expiresAt, second.expiresAt);
  assert.equal((await leases.listActiveTurnConnectionCounts({ accountId: pair.accountId, clock: () => now })).activePhones, 1);
  await assert.rejects(release(''), { code: 'turn_connection_id_required' });
  await assert.rejects(leases.markTurnConnectionLeaseConnected({ deviceId: pair.deviceId }), { code: 'turn_connection_id_required' });
  assert.equal((await release(b)).released, 1);
  await assert.rejects(reserve(b), { code: 'turn_connection_generation_retired' });
  const old = createTurnLeaseId(logical, undefined, now), next = createTurnLeaseId(logical, undefined, now);
  await reserve(old);
  const handoff = { ...pair, connectionId: next, expiresAt: new Date(now + 300_000).toISOString(),
    handoffFrom: old, handoffDeadline: new Date(now + 30_000).toISOString(), deviceKind: 'phone', clock: () => now };
  await leases.reserveTurnConnectionLease(handoff);
  assert.equal((await leases.listActiveTurnConnectionCounts({ accountId: pair.accountId, clock: () => now })).activePhones, 1);
  assert.equal((await leases.markTurnConnectionLeaseConnected({ deviceId: pair.deviceId, connectionId: old, clock: () => now })).updated, true);
  await leases.commitLocalTurnHandoff({ deviceId: pair.deviceId, connectionId: next, clock: () => now });
  assert.equal((await release(old)).released, 1);
  assert.equal((await release(next)).released, 1);
  now += 181_000;
  const c = createTurnLeaseId(logical, undefined, now); await reserve(c); await release(c);
  await release(c); // Reopen JSON and prune old records while keeping the pair watermark.
  const state = JSON.parse(await readFile(TURN_CONNECTION_LEASES_FILE, 'utf8'));
  assert(!state.leases.some(lease => lease.connectionId === a)); assert(state.leases.length <= 2);
  now -= 181_000;
  await assert.rejects(reserve(a), { code: 'turn_connection_generation_retired' });
  console.log('PASS local TURN mirror: exact IDs, no bulk blank release, immutable expiry, bounded history and durable clock rollback fence');
} finally {
  const absolute = await realpath(home), parent = await realpath(tmpdir());
  assert(absolute.startsWith(parent + sep) && absolute.includes('ragent-local-turn-generation-'));
  await rm(absolute, { recursive: true, force: true });
}
