import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { TemporaryControlRegistry } from '../chat/temporary-control-registry.mjs';
import { TemporaryControlHost } from '../chat/temporary-control-host.mjs';
import { TemporaryControlService } from '../chat/temporary-control-service.mjs';
import { loadOrCreateInstanceIdentity } from '../lib/instance-identity.mjs';
import { buildTemporaryControlClaimMessage, temporaryControlInvitationDigest } from '../lib/temporary-control-protocol.mjs';

const id = (prefix) => `${prefix}_${randomBytes(24).toString('base64url')}`;

test('control service registers, imports a claimed phone, confirms it, and publishes only the confirmed credential', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ragent-temporary-control-service-'));
  t.after(async () => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); await rm(root, { recursive: true, force: true }); });
  let now = 1_800_000_000_000;
  const identity = await loadOrCreateInstanceIdentity({ filePath: join(root, 'identity.json') });
  const registry = new TemporaryControlRegistry({ filePath: join(root, 'control.json'), identity, clock: () => now });
  const host = new TemporaryControlHost({ registry, clock: () => now });
  const requests = []; let remoteClaim = null; let completion = null;
  const client = { request: async (action, invitationId, payload = {}) => {
    requests.push({ action, invitationId, payload });
    if (action === 'register') return { instanceId: identity.instanceId, invitationId, status: 'REGISTERED' };
    if (action === 'inbox') return { instanceId: identity.instanceId, invitationId, status: remoteClaim ? 'CLAIMED' : 'REGISTERED', claim: remoteClaim };
    if (action === 'complete') { completion = payload; return { instanceId: identity.instanceId, invitationId, status: 'ACTIVE', accessExpiresAt: payload.grant.grantedAt + 600_000 }; }
    if (action === 'revoke') return { instanceId: identity.instanceId, invitationId, status: 'REVOKED' };
    throw new Error(`unexpected ${action}`);
  } };
  const service = new TemporaryControlService({ registry, host, client });
  const ticket = await service.create(); const invitation = ticket.envelope.invitation;
  const device = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  remoteClaim = { instanceId: invitation.instanceId, invitationId: invitation.invitationId,
    invitationDigest: temporaryControlInvitationDigest(invitation), requestId: id('rtr'),
    devicePublicKey: device.publicKey.export({ type: 'spki', format: 'pem' }).toString(), token: ticket.token };
  remoteClaim.signature = sign('sha256', Buffer.from(buildTemporaryControlClaimMessage(remoteClaim)), device.privateKey).toString('base64url');
  const active = await service.confirm(invitation.invitationId);
  assert.equal(active.status, 'ACTIVE'); assert.equal(completion.grant.grantId, active.grant.grantId);
  assert.equal(completion.accessCredential.expires_at, active.accessExpiresAt);
  assert.deepEqual(requests.map((entry) => entry.action), ['register', 'inbox', 'complete']);
  now += 5_000;
  const recovered = await service.confirm(invitation.invitationId);
  assert.deepEqual(recovered.grant, active.grant);
  assert.equal(recovered.accessExpiresAt, active.accessExpiresAt);
  assert.equal(requests.at(-1).action, 'complete');
  const afterSync = await service.sync(invitation.invitationId);
  assert.equal(afterSync.accessExpiresAt, active.accessExpiresAt);
  assert.equal(requests.at(-1).action, 'complete');
  await service.revoke(invitation.invitationId);
  assert.equal((await registry.list())[0].status, 'REVOKED');
});
