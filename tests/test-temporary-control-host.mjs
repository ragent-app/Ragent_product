import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { TemporaryControlRegistry } from '../chat/temporary-control-registry.mjs';
import { TemporaryControlHost } from '../chat/temporary-control-host.mjs';
import { loadOrCreateInstanceIdentity } from '../lib/instance-identity.mjs';
import { buildTemporaryControlClaimMessage, temporaryControlInvitationDigest } from '../lib/temporary-control-protocol.mjs';
import { temporaryDeviceJwk } from '../lib/temporary-device-access.mjs';

const initial = 1_800_000_000_000;
const targetUri = 'https://temporary-control.ragent.invalid/api/temporary-control/v1/instances/inst_abcdefghijklmnopqrstuvwx/projects';
const id = (prefix) => `${prefix}_${'a'.repeat(24)}`;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ragent-temporary-control-host-'));
  t.after(async () => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); await rm(root, { recursive: true, force: true }); });
  let now = initial;
  const identity = await loadOrCreateInstanceIdentity({ filePath: join(root, 'identity.json') });
  const registry = new TemporaryControlRegistry({ filePath: join(root, 'control.json'), identity, clock: () => now });
  const ticket = await registry.create(); const device = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const invitation = ticket.envelope.invitation;
  const claim = { instanceId: invitation.instanceId, invitationId: invitation.invitationId,
    invitationDigest: temporaryControlInvitationDigest(invitation), requestId: id('rtr'),
    devicePublicKey: device.publicKey.export({ type: 'spki', format: 'pem' }).toString(), token: ticket.token };
  claim.signature = sign('sha256', Buffer.from(buildTemporaryControlClaimMessage(claim)), device.privateKey).toString('base64url');
  await registry.claim(claim); const active = await registry.confirm(invitation.invitationId);
  const host = new TemporaryControlHost({ registry, clock: () => now });
  const credential = await host.credentialForGrant(active.grant.grantId);
  const dpop = (jti = id('proof')) => {
    const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const header = { typ: 'dpop+jwt', alg: 'ES256', jwk: temporaryDeviceJwk(claim.devicePublicKey).jwk };
    const payload = { jti, htm: 'GET', htu: targetUri, iat: Math.floor(now / 1000),
      ath: createHash('sha256').update(credential.access_token).digest('base64url') };
    const input = `${b64(header)}.${b64(payload)}`;
    return `${input}.${sign('sha256', Buffer.from(input), { key: device.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
  };
  return { registry, host, credential, dpop, active, advance: (ms) => { now += ms; } };
}

test('control host accepts one device-bound proof and rejects replay, revoke and expiry', async (t) => {
  const f = await fixture(t);
  const principal = await f.host.authenticateRequest({ credential: f.credential, proof: f.dpop(), method: 'GET', targetUri });
  assert.equal(principal.role, 'temporary'); assert.equal(principal.sessionScope, 'all-workbench');
  await assert.rejects(f.host.authenticateRequest({ credential: f.credential, proof: f.dpop(), method: 'GET', targetUri }),
    { code: 'temporary_control_proof_replayed' });
  await f.registry.revoke(f.active.invitationId);
  await assert.rejects(f.host.revalidatePrincipal(principal), { code: 'temporary_control_inactive' });
});
