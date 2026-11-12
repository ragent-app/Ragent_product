import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadOrCreateInstanceIdentity } from '../lib/instance-identity.mjs';
import { deriveProviderPeerRoom } from '../lib/provider-runtime/peer-room.mjs';

const root = await mkdtemp(join(tmpdir(), 'ragent-provider-peer-room-'));
const left = await loadOrCreateInstanceIdentity({ filePath: join(root, 'left.json') });
const right = await loadOrCreateInstanceIdentity({ filePath: join(root, 'right.json') });
const directoryRow = value => ({ instanceId: value.instanceId, instancePublicKey: value.publicKey,
  instanceKeyFingerprint: value.keyFingerprint });
const leftRoom = deriveProviderPeerRoom({ identity: left, peer: directoryRow(right), accountId: 'acct_room' });
const rightRoom = deriveProviderPeerRoom({ identity: right, peer: directoryRow(left), accountId: 'acct_room' });
assert.equal(leftRoom.secret, rightRoom.secret);
assert.equal(leftRoom.roomId, rightRoom.roomId);
assert.notEqual(leftRoom.role, rightRoom.role);
assert.notEqual(leftRoom.roomId, deriveProviderPeerRoom({ identity: left, peer: directoryRow(right), accountId: 'acct_other' }).roomId);
assert.throws(() => deriveProviderPeerRoom({ identity: left, peer: { ...directoryRow(right), instanceKeyFingerprint: '0'.repeat(64) }, accountId: 'acct_room' }));
console.log('provider peer room identity agreement: ok');
