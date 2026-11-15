#!/usr/bin/env node
// The Android contract catalog is intentionally limited to the current
// connection rule: TURN-first bootstrap followed by a P2P upgrade.
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const schema = JSON.parse(readFileSync(join(repoRoot, 'docs/ragent-android-core-contract.schema.json'), 'utf8'));
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(schema);

function validate(name, value) {
  const check = ajv.compile({ $ref: `${schema.$id}#/definitions/${name}` });
  return { ok: check(value), errors: check.errors };
}

function expectValid(name, value) {
  const result = validate(name, value);
  assert.ok(result.ok, `${name}: ${JSON.stringify(result.errors)}`);
}

function expectInvalid(name, value) {
  assert.equal(validate(name, value).ok, false, `${name} should be rejected`);
}

const now = new Date().toISOString();
const expiresAt = new Date(Date.now() + 600000).toISOString();
const turnEndpoint = 'turn:turn.cloudflare.com:3478?transport=udp';
const turnCandidate = {
  id: 'cand_turn_1',
  kind: 'turn',
  provider: 'cloudflare-realtime',
  endpoint: turnEndpoint,
  priority: 120,
  expiresAt,
  requiresUserConsent: false,
  metadata: { carrier: 'cloudflare-realtime-turn' },
};
const p2pCandidate = {
  id: 'cand_p2p_1',
  kind: 'webrtc',
  provider: 'core_p2p',
  endpoint: 'https://signal.example.com',
  priority: 60,
  expiresAt,
  requiresUserConsent: false,
  metadata: { roomId: 'room_1', turnAllowed: true },
};
const turn = {
  provider: 'cloudflare-realtime',
  endpoint: turnEndpoint,
  iceServers: [{ urls: turnEndpoint, username: '1765432100:app-key', password: 'signed-password' }],
  expiresAt,
  transport: 'turn',
  appTrafficOnly: true,
  credentialScope: 'device-access',
  source: 'turn-broker',
  connectionId: 'turn-connection-1',
  authorization: {
    policyVersion: 'turn-account-quota-v1',
    authorized: true,
    status: 'authorized',
    reasonCode: 'turn_authorized',
    plan: 'free',
    maxDevices: 1,
    activeDeviceCount: 1,
    connectionId: 'turn-connection-1',
  },
};
const contract = {
  contractVersion: 2,
  instanceId: 'rli_1',
  deviceId: 'rdev_1',
  enrollmentKind: 'account-join',
  connectionMode: 'turn-first',
  issuedAt: now,
  expiresAt,
  candidates: [turnCandidate, p2pCandidate],
  initialCarrier: {
    candidateId: turnCandidate.id,
    kind: 'turn',
    provider: turnCandidate.provider,
    endpoint: turnCandidate.endpoint,
  },
  turn,
  turnAuthorization: turn.authorization,
  upgrade: {
    strategy: 'probe-after-bootstrap',
    targets: ['webrtc'],
    retainCurrentWhenNoP2PPath: true,
  },
  fallback: null,
  signature: { algorithm: 'ed25519', keyId: 'a'.repeat(64), signedAt: now, value: 'signature' },
};

expectValid('connectionBootstrapContract', contract);
expectValid('connectionBootstrapCandidate', turnCandidate);
expectValid('connectionBootstrapCandidate', p2pCandidate);
expectValid('connectionBootstrapInitialCarrier', contract.initialCarrier);
expectValid('connectionBootstrapPublicKey', {
  algorithm: 'ed25519', keyId: 'a'.repeat(64),
  publicKeyPem: '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA\n-----END PUBLIC KEY-----\n',
});
expectValid('connectionBootstrapReportAck', {
  recorded: false,
  duplicate: true,
  report: {
    deviceId: 'rdev_1', requestId: 'req-1', phase: 'migrated',
    transport: 'webrtc', recordedAt: now,
  },
});

expectInvalid('connectionBootstrapContract', {
  ...contract,
  connectionMode: 'unsupported-mode',
});
expectInvalid('connectionBootstrapContract', {
  ...contract,
  candidates: [{ ...turnCandidate, kind: 'unsupported' }, p2pCandidate],
});
expectInvalid('connectionBootstrapContract', {
  ...contract,
  fallback: { provider: 'future' },
});
expectInvalid('connectionState', {
  state: 'connected', transport: 'unsupported', reachable: true, authenticated: true, updatedAt: now,
});

console.log('test-android-core-contract-schema: TURN-first -> P2P PASS');
