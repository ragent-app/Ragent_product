#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = mkdtempSync(join(tmpdir(), 'ragent-endpointless-claim-'));
process.env.RAGENT_CONFIG_DIR = join(root, 'config');
process.env.RAGENT_AUTH_SESSION_SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
mkdirSync(process.env.RAGENT_CONFIG_DIR, { recursive: true });

try {
  const { createTrustedDeviceInvitation, loadState } = await import('../chat/trusted-devices.mjs');
  const { createConnectivityPolicyEngine } = await import('../lib/connectivity-policy-engine.mjs');
  const invitation = await createTrustedDeviceInvitation();
  const uri = new URL(invitation.pairingUri);
  assert.equal(invitation.endpoint, '');
  assert.equal(uri.searchParams.get('v'), '3');
  assert.equal(uri.searchParams.get('i'), invitation.instanceId);
  assert.equal(uri.searchParams.get('i'), invitation.instance.instanceId);
  assert.equal(uri.searchParams.get('t'), invitation.token);
  assert.equal(uri.searchParams.has('e'), false);
  assert.equal(uri.searchParams.has('signal'), false);
  assert.equal((await loadState()).invitations[0].endpoint, '');
  const decision = createConnectivityPolicyEngine().decide({ method: 'POST', url: '/api/device-pairing/redeem' });
  assert.equal(decision.kind, 'unauthorized');
  assert.equal(decision.statusCode, 401);
  console.log('test-endpointless-account-claim: ok');
} finally {
  rmSync(root, { recursive: true, force: true });
}
