#!/usr/bin/env node
// v2 connection contract evidence:
//   authenticated bootstrap -> TURN-first -> signed P2P upgrade.
// Only the active TURN-first/P2P contract is covered here.
import assert from 'assert/strict';
import { spawn } from 'child_process';
import { createServer } from 'http';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash, createHmac, createSign, generateKeyPairSync, sign as cryptoSign } from 'crypto';

import Ajv from 'ajv';
import addFormats from 'ajv-formats';

import {
  attachContractSignature,
  buildConnectionBootstrapContract,
  buildContractSigningPayload,
  canonicalJson,
  determineConnectionMode,
  verifyConnectionBootstrapContract,
} from '../lib/connection-bootstrap-contract.mjs';
import {
  cloudflareTurnCredentialsUrl,
  normalizeCloudflareTurnIceServers,
  resolveCloudflareTurnCredentialSource,
} from '../lib/turn-credentials.mjs';
import {
  createTurnAuthorizationProvider,
  evaluateTurnConnectionAuthorization,
} from '../lib/turn-authorization.mjs';
import { createTurnCredentialBrokerHandler } from '../infrastructure/turn-broker/turn-credential-broker.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const schema = JSON.parse(readFileSync(join(repoRoot, 'docs/ragent-android-core-contract.schema.json'), 'utf8'));
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(schema);
const validateContract = ajv.compile({ $ref: `${schema.$id}#/definitions/connectionBootstrapContract` });
const validateReportAck = ajv.compile({ $ref: `${schema.$id}#/definitions/connectionBootstrapReportAck` });

const sessionSecret = 'test-session-secret-connection-bootstrap';
const hashedOwnerSession = `s${createHmac('sha256', sessionSecret).update('test-session').digest('hex')}`;
let passed = 0;
let failed = 0;

function test(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    console.log(`  PASS: ${name}`);
    passed += 1;
  }).catch((error) => {
    console.error(`  FAIL: ${name} - ${error.message}`);
    failed += 1;
  });
}

function randomPort() {
  return 41000 + Math.floor(Math.random() * 3000);
}

async function waitFor(check, label, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function request(port, method, path, body, headers = {}) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      ...(payload ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: payload,
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return {
    status: response.status,
    text,
    json,
    headers: Object.fromEntries(response.headers.entries()),
  };
}

function setupTempInstance(prefix) {
  const home = mkdtempSync(join(tmpdir(), prefix));
  const configDir = join(home, 'config');
  const binDir = join(home, 'bin');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(configDir, 'auth.json'), JSON.stringify({ username: 'andy', passwordHash: 'unused' }));
  writeFileSync(join(configDir, 'auth-sessions.json'), JSON.stringify({
    [hashedOwnerSession]: { expiry: Date.now() + 60 * 60 * 1000, role: 'owner' },
  }));
  writeFileSync(join(configDir, 'tools.json'), '[]\n');
  const qrCommand = join(binDir, 'qrcode-terminal');
  writeFileSync(qrCommand, '#!/usr/bin/env node\nprocess.stdin.resume();\n');
  chmodSync(qrCommand, 0o755);
  return { home, configDir, binDir };
}

async function startServer({ home, configDir, binDir, port, extraEnv = {} }) {
  const child = spawn(process.execPath, ['chat-server.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      RAGENT_RUNNER_SUPERVISOR_SOCKET: '',
      RAGENT_RUNNER_SUPERVISOR_REQUIRED: '',
      HOME: home,
      PATH: `${binDir}:${process.env.PATH}`,
      CHAT_PORT: String(port),
      SECURE_COOKIES: '0',
      RAGENT_CONFIG_DIR: configDir,
      RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES: '1',
      RAGENT_AUTH_SESSION_SECRET: sessionSecret,
      RAGENT_REPLY_SELF_CHECK: 'off',
      RAGENT_ASSET_STORAGE_BASE_URL: '',
      RAGENT_ASSET_STORAGE_PUBLIC_BASE_URL: '',
      RAGENT_ASSET_STORAGE_PROVIDER: '',
      RAGENT_ASSET_STORAGE_REGION: '',
      RAGENT_ASSET_STORAGE_ACCESS_KEY_ID: '',
      RAGENT_ASSET_STORAGE_SECRET_ACCESS_KEY: '',
      RAGENT_TURN_BROKER_URL: '',
      RAGENT_TURN_BROKER_TOKEN: '',
      RAGENT_TURN_BROKER_AUTH_MODE: 'static',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stdout.on('data', () => {});
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  await waitFor(async () => {
    if (child.exitCode !== null) {
      throw new Error(`test server exited with ${child.exitCode}: ${stderr.slice(-1000)}`);
    }
    try {
      return (await request(port, 'GET', '/api/auth/me', undefined, {
        Cookie: 'session_token=test-session',
      })).status === 200;
    } catch {
      return false;
    }
  }, 'test server startup');
  return child;
}

async function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await waitFor(() => child.exitCode !== null || child.signalCode !== null, 'test server shutdown');
}

function readInstanceState(configDir) {
  return JSON.parse(readFileSync(join(configDir, 'trusted-devices.json'), 'utf8'));
}

function writeInstanceState(configDir, state) {
  writeFileSync(join(configDir, 'trusted-devices.json'), JSON.stringify(state, null, 2));
}

async function enrollDevice(port, configDir) {
  const invite = await request(port, 'POST', '/api/device-pairing/invitations', {
    ttlMs: 120000,
  }, { Cookie: 'session_token=test-session' });
  assert.equal(invite.status, 201, invite.text);
  const key = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const state = readInstanceState(configDir);
  const deviceId = 'rdev_bootstrap_contract';
  const deviceToken = 'rda_' + 'b'.repeat(64);
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  state.devices.push({
    id: deviceId,
    tokenHash: '',
    status: 'bound',
    enrollmentKind: 'account-join',
    accountId: '',
    deviceName: 'Bootstrap Contract Test Device',
    platform: 'android',
    publicEndpoint: '',
    devicePublicKey: key.publicKey,
    createdAt: new Date().toISOString(),
    boundAt: new Date().toISOString(),
    revokedAt: '',
    expiresAt: '',
  });
  state.authTokens.push({
    tokenHash: createHash('sha256').update(deviceToken).digest('hex'),
    deviceId,
    kind: 'bound',
    scope: 'device-access',
    createdAt: new Date().toISOString(),
    expiresAt,
  });
  writeInstanceState(configDir, state);
  const challengeResponse = await request(port, 'POST', '/api/device-auth/challenges', { deviceId });
  assert.equal(challengeResponse.status, 201, challengeResponse.text);
  const challenge = challengeResponse.json.challenge;
  const signer = createSign('SHA256');
  signer.update(challenge.message);
  signer.end();
  const verified = await request(port, 'POST', '/api/device-auth/verify', {
    deviceId,
    challengeId: challenge.challengeId,
    nonce: challenge.nonce,
    signature: signer.sign(key.privateKey).toString('base64'),
  });
  assert.equal(verified.status, 200, verified.text);
  assert.deepEqual(verified.json.bootstrap, { endpoint: '/api/device-auth/bootstrap', contractVersion: 2 });
  return { deviceId, token: deviceToken };
}

function turnFixture(overrides = {}) {
  return {
    provider: 'cloudflare-realtime',
    endpoint: 'turn:turn.cloudflare.com:3478?transport=udp',
    iceServers: [{
      urls: 'turn:turn.cloudflare.com:3478?transport=udp',
      username: '123:app',
      password: 'signed-password',
    }],
    expiresAt: '2099-01-01T00:00:00.000Z',
    transport: 'turn',
    appTrafficOnly: true,
    credentialScope: 'device-access',
    source: 'turn-broker',
    connectionId: 'turn-test-1',
    ...overrides,
  };
}

function contractFixture(turn = turnFixture()) {
  return buildConnectionBootstrapContract({
    instanceId: 'rli_test0001',
    deviceId: 'rdev_test0001',
    enrollmentKind: 'account-join',
    p2p: { signalingEndpoint: 'https://signal.example.com', roomId: 'room-test' },
    turn,
    issuedAtMs: Date.parse('2026-08-18T00:00:00.000Z'),
    ttlMs: 600000,
  });
}

await test('canonical JSON and mode are frozen to TURN-first', () => {
  assert.equal(canonicalJson({ b: 1, a: { z: 2 } }), canonicalJson({ a: { z: 2 }, b: 1 }));
  assert.equal(determineConnectionMode({ hasTurn: true }), 'turn-first');
  assert.throws(() => determineConnectionMode({ hasTurn: false }), /TURN credentials are required/);
});

await test('v2 contract contains only TURN initial carrier and P2P upgrade', () => {
  const contract = contractFixture();
  assert.equal(contract.contractVersion, 2);
  assert.equal(contract.connectionMode, 'turn-first');
  assert.equal(contract.allowDirectIce, false);
  assert.deepEqual(contract.candidates.map((entry) => entry.kind), ['turn', 'webrtc']);
  assert.equal(contract.initialCarrier.kind, 'turn');
  assert.equal(contract.initialCarrier.candidateId, contract.candidates[0].id);
  assert.deepEqual(contract.upgrade.targets, ['webrtc']);
  assert.equal(contract.upgrade.retainCurrentWhenNoP2PPath, true);
  assert.equal(contract.fallback, null);
  assert.equal(Object.keys(contract).some((key) => key.toLowerCase().includes('entry')), false);

  const direct = buildConnectionBootstrapContract({
    instanceId: 'rli_test0001',
    deviceId: 'rdev_test0001',
    enrollmentKind: 'account-join',
    p2p: { signalingEndpoint: 'https://signal.example.com', roomId: 'room-test' },
    turn: turnFixture(),
    allowDirectIce: true,
    issuedAtMs: Date.parse('2026-08-18T00:00:00.000Z'),
    ttlMs: 600000,
  });
  assert.equal(direct.allowDirectIce, true);
});

await test('v2 signature rejects tampering and shelved transport fields', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const base = contractFixture();
  const signed = attachContractSignature(base, {
    keyId: 'test-key-id',
    signedAt: '2026-08-18T00:00:01.000Z',
    value: cryptoSign(null, Buffer.from(buildContractSigningPayload(base)), privateKey).toString('base64url'),
  });
  assert.equal(verifyConnectionBootstrapContract(signed, publicKeyPem, {
    nowMs: Date.parse('2026-08-18T00:00:02.000Z'),
  }).valid, true);
  const tampered = structuredClone(signed);
  tampered.candidates[0].endpoint = 'turn:attacker.example';
  const withinTtl = { nowMs: Date.parse('2026-08-18T00:00:02.000Z') };
  assert.equal(verifyConnectionBootstrapContract(tampered, publicKeyPem, withinTtl).valid, false);
  const tamperedDirect = structuredClone(signed);
  tamperedDirect.allowDirectIce = true;
  assert.equal(verifyConnectionBootstrapContract(tamperedDirect, publicKeyPem, withinTtl).valid, false);

  const legacyBase = structuredClone(base);
  delete legacyBase.allowDirectIce;
  const legacySigned = attachContractSignature(legacyBase, {
    keyId: 'test-key-id',
    signedAt: '2026-08-18T00:00:01.000Z',
    value: cryptoSign(null, Buffer.from(buildContractSigningPayload(legacyBase)), privateKey).toString('base64url'),
  });
  assert.equal(verifyConnectionBootstrapContract(legacySigned, publicKeyPem, withinTtl).valid, true);

  const invalidDirect = structuredClone(signed);
  invalidDirect.allowDirectIce = 'yes';
  assert.equal(verifyConnectionBootstrapContract(invalidDirect, publicKeyPem, withinTtl).reason, 'invalid allowDirectIce');

  const oldMode = structuredClone(signed);
  oldMode.connectionMode = 'unsupported-mode';
  assert.equal(verifyConnectionBootstrapContract(oldMode, publicKeyPem, withinTtl).reason, 'invalid connectionMode');
  const oldCandidate = structuredClone(signed);
  oldCandidate.candidates[0].kind = 'unsupported';
  assert.equal(verifyConnectionBootstrapContract(oldCandidate, publicKeyPem, withinTtl).reason, 'unsupported candidate kind');
  const extension = structuredClone(signed);
  extension.fallback = { provider: 'future' };
  assert.equal(verifyConnectionBootstrapContract(extension, publicKeyPem, withinTtl).reason, 'fallback extension is not enabled in contract v2');
});

await test('Cloudflare TURN credentials fail closed and preserve provider-issued ICE shape', () => {
  assert.equal(resolveCloudflareTurnCredentialSource({ apiToken: '', turnKeyId: 'key-id' }), null);
  const source = resolveCloudflareTurnCredentialSource({
    turnKeyId: 'key-id',
    apiToken: '0123456789abcdef0123456789abcdef',
  });
  assert.equal(cloudflareTurnCredentialsUrl(source).endsWith('/v1/turn/keys/key-id/credentials/generate-ice-servers'), true);
  assert.deepEqual(normalizeCloudflareTurnIceServers({ iceServers: [{
    urls: [
      'stun:stun.cloudflare.com:3478',
      'turn:turn.cloudflare.com:3478?transport=udp',
      'turn:turn.cloudflare.com:3478?transport=tcp',
      'turns:turn.cloudflare.com:5349?transport=tcp',
    ],
    username: 'provider-issued-user',
    credential: 'provider-issued-password',
  }] }), [
    { urls: 'turn:turn.cloudflare.com:3478?transport=udp', username: 'provider-issued-user', password: 'provider-issued-password' },
    { urls: 'turn:turn.cloudflare.com:3478?transport=tcp', username: 'provider-issued-user', password: 'provider-issued-password' },
    { urls: 'turns:turn.cloudflare.com:5349?transport=tcp', username: 'provider-issued-user', password: 'provider-issued-password' },
  ]);
});

await test('TURN authorization is account and quota bound', async () => {
  const allowed = evaluateTurnConnectionAuthorization({
    accountId: 'acct_test', instanceId: 'rli_test', deviceId: 'rdev_1',
    accountPlan: 'free', activeDeviceIds: [], accountMatches: true,
  });
  assert.equal(allowed.authorized, true);
  const blocked = evaluateTurnConnectionAuthorization({
    accountId: 'acct_test', instanceId: 'rli_test', deviceId: 'rdev_2',
    accountPlan: 'free', activeDeviceIds: ['rdev_1'], accountMatches: true,
  });
  assert.equal(blocked.status, 'quota-exceeded');
  const provider = createTurnAuthorizationProvider({
    resolveAccountPlan: async () => 'pro',
    listActiveDeviceIds: async () => [],
    accountMatches: async () => true,
  });
  assert.equal((await provider({ accountId: 'acct_test', instanceId: 'rli_test', deviceId: 'rdev_3' })).authorized, true);

  const phoneBlocked = evaluateTurnConnectionAuthorization({
    accountId: 'acct_test', instanceId: 'rli_test', deviceId: 'phone_3',
    accountPlan: 'plus', deviceKind: 'phone', activeDeviceIds: ['phone_1', 'phone_2'], accountMatches: true,
  });
  assert.equal(phoneBlocked.reasonCode, 'turn_connection_quota_exceeded');
  assert.deepEqual(phoneBlocked.limits, { phones: 2, computers: 3 });
  const computerAllowed = evaluateTurnConnectionAuthorization({
    accountId: 'acct_test', instanceId: 'rli_test', deviceId: 'computer_3',
    accountPlan: 'plus', deviceKind: 'computer', activeDeviceIds: ['computer_1', 'computer_2'], accountMatches: true,
  });
  assert.equal(computerAllowed.authorized, true);

  const computerEndpoint = evaluateTurnConnectionAuthorization({
    accountId: 'acct_test', instanceId: 'rli_test_2', deviceId: 'computer_3',
    accountPlan: 'pro', deviceKind: 'computer', activeDeviceIds: ['computer_1'],
    activeInstanceIds: ['rli_test_1'], activePhones: 1, activeComputers: 1, accountMatches: true,
  });
  assert.equal(computerEndpoint.authorized, true);
  assert.equal(computerEndpoint.activePhones, 1);
  assert.equal(computerEndpoint.activeComputers, 2);
});

const noTurnInstance = setupTempInstance('ragent-bootstrap-no-turn-');
const noTurnPort = randomPort();
let noTurnServer = null;
try {
  noTurnServer = await startServer({ ...noTurnInstance, port: noTurnPort });
  const device = await enrollDevice(noTurnPort, noTurnInstance.configDir);
  await test('bootstrap without TURN is fail-closed', async () => {
    const response = await request(noTurnPort, 'GET', '/api/device-auth/bootstrap', undefined, {
      Authorization: `Bearer ${device.token}`,
    });
    assert.equal(response.status, 503, response.text);
    assert.match(response.json.code || '', /^turn_/);
  });
} finally {
  await stopServer(noTurnServer);
  rmSync(noTurnInstance.home, { recursive: true, force: true });
}

const instance = setupTempInstance('ragent-bootstrap-turn-');
const port = randomPort();
let server = null;
let brokerServer = null;
try {
  const brokerHandler = createTurnCredentialBrokerHandler({
    authMode: 'static',
    brokerToken: 'broker-test-token',
    turnKeyId: 'key-id',
    apiToken: '0123456789abcdef0123456789abcdef',
    issueTurnCredentials: async ({ ttlMs, nowMs }) => ({
      iceServers: turnFixture().iceServers,
      expiresAt: new Date(nowMs + ttlMs).toISOString(),
    }),
  });
  brokerServer = createServer((req, res) => void brokerHandler(req, res));
  await new Promise((resolve) => brokerServer.listen(0, '127.0.0.1', resolve));
  const brokerPort = brokerServer.address().port;
  server = await startServer({
    ...instance,
    port,
    extraEnv: {
      RAGENT_TURN_BROKER_URL: `http://127.0.0.1:${brokerPort}`,
      RAGENT_TURN_BROKER_TOKEN: 'broker-test-token',
    },
  });
  const device = await enrollDevice(port, instance.configDir);
  const state = readInstanceState(instance.configDir);
  const record = state.devices.find((entry) => entry.id === device.deviceId);
  record.accountId = 'acct_turn_test';
  record.enrollmentKind = 'account-join';
  writeInstanceState(instance.configDir, state);
  writeFileSync(join(instance.configDir, 'owner-account-binding.json'), JSON.stringify({
    version: 1, accountId: 'acct_turn_test', plan: 'free', provider: 'google',
  }));
  const auth = { Authorization: `Bearer ${device.token}` };

  await test('authenticated bootstrap signs TURN-first contract and supports P2P migration evidence', async () => {
    const identity = JSON.parse(readFileSync(join(instance.configDir, 'instance-identity.json'), 'utf8'));
    const publicKeyResponse = await request(port, 'GET', '/api/device-auth/bootstrap/public-key', undefined, auth);
    assert.equal(publicKeyResponse.status, 200, publicKeyResponse.text);
    assert.equal(publicKeyResponse.json.keyId, identity.keyFingerprint);
    assert.equal(publicKeyResponse.json.publicKeyPem, identity.publicKey);
    assert.match(publicKeyResponse.headers?.['cache-control'] || '', /no-store/);

    const response = await request(port, 'GET', '/api/device-auth/bootstrap', undefined, auth);
    assert.equal(response.status, 200, response.text);
    const contract = response.json;
    assert.equal(contract.instanceId, identity.instanceId);
    assert.equal(contract.contractVersion, 2);
    assert.equal(contract.connectionMode, 'turn-first');
    assert.equal(contract.allowDirectIce, true);
    assert.equal(contract.turn.provider, 'cloudflare-realtime');
    assert.equal(contract.turn.authorization.status, 'authorized');
    assert.equal(contract.turn.authorization.deviceKind, 'phone');
    assert.deepEqual(contract.turn.authorization.limits, { phones: 1, computers: 1 });
    assert.equal(contract.turn.authorization.activePhones, 1);
    assert.equal(contract.turn.authorization.activeComputers, 1);
    assert.deepEqual(contract.candidates.map((entry) => entry.kind), ['turn', 'webrtc']);
    assert.ok(validateContract(contract), JSON.stringify(validateContract.errors));
    assert.equal(verifyConnectionBootstrapContract(contract, identity.publicKey).valid, true);

    const connected = await request(port, 'POST', '/api/device-auth/bootstrap/report', {
      requestId: 'turn-connect-001', phase: 'connected', transport: 'turn',
      candidateId: contract.initialCarrier.candidateId, connectionId: contract.turn.connectionId,
      connectionMode: 'turn-first',
    }, auth);
    assert.equal(connected.status, 201, connected.text);
    assert.ok(validateReportAck(connected.json), JSON.stringify(validateReportAck.errors));

    const migrated = await request(port, 'POST', '/api/device-auth/bootstrap/report', {
      requestId: 'turn-migrate-001', phase: 'migrated', transport: 'webrtc',
      candidateId: contract.candidates.find((entry) => entry.kind === 'webrtc')?.id,
      connectionId: contract.turn.connectionId, connectionMode: 'turn-first',
    }, auth);
    assert.equal(migrated.status, 201, migrated.text);

    const duplicate = await request(port, 'POST', '/api/device-auth/bootstrap/report', {
      requestId: 'turn-migrate-001', phase: 'migrated', transport: 'webrtc',
    }, auth);
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.json.duplicate, true);

    const released = await request(port, 'POST', '/api/device-auth/turn/release', {
      connectionId: contract.turn.connectionId, reason: 'p2p-upgrade',
    }, auth);
    assert.equal(released.status, 200, released.text);
  });

  await test('TURN broker rejects unauthorized requests and is idempotent', async () => {
    const brokerPort = brokerServer.address().port;
    const denied = await request(brokerPort, 'POST', '/v1/turn/credentials', {
      protocolVersion: 1, accountId: 'acct_turn_test', instanceId: 'rli_test', deviceId: 'rdev_test',
      connectionId: 'turn-test', idempotencyKey: 'turn-test', authorization: { authorized: false },
    }, { Authorization: 'Bearer broker-test-token' });
    assert.equal(denied.status, 403);
    const body = {
      protocolVersion: 1, accountId: 'acct_turn_test', instanceId: 'rli_test', deviceId: 'rdev_test',
      connectionId: 'turn-idempotent', idempotencyKey: 'turn-idempotent',
      authorization: { authorized: true, status: 'authorized' },
    };
    const first = await request(brokerPort, 'POST', '/v1/turn/credentials', body, {
      Authorization: 'Bearer broker-test-token', 'Idempotency-Key': 'turn-idempotent',
    });
    const retry = await request(brokerPort, 'POST', '/v1/turn/credentials', body, {
      Authorization: 'Bearer broker-test-token', 'Idempotency-Key': 'turn-idempotent',
    });
    assert.equal(first.status, 201);
    assert.equal(retry.status, 200);
    assert.deepEqual(retry.json.iceServers, first.json.iceServers);
  });
} finally {
  await stopServer(server);
  if (brokerServer) await new Promise((resolve) => brokerServer.close(resolve));
  rmSync(instance.home, { recursive: true, force: true });
}

console.log(`\nconnection-bootstrap v2 tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
