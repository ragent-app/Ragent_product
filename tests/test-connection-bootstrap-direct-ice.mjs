#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import WebSocket, { WebSocketServer } from 'ws';

import {
  attachContractSignature,
  buildConnectionBootstrapContract,
  buildContractSigningPayload,
  verifyConnectionBootstrapContract,
} from '../lib/connection-bootstrap-contract.mjs';
import { createP2PRoomId, signP2PSignal } from '../lib/p2p-signal-protocol.mjs';
import { runP2PHostAgent } from '../lib/p2p-host-agent.mjs';
import {
  restoreP2PHostsForDevices,
  stopAllP2PHosts,
} from '../lib/p2p-host-registry.mjs';
import { createP2PSignalingServer } from '../p2p/signaling-server.mjs';

const home = await mkdtemp(join(tmpdir(), 'ragent-direct-ice-test-'));
const configDir = join(home, 'config');
await mkdir(configDir, { recursive: true });
Object.assign(process.env, {
  HOME: home,
  RAGENT_CONFIG_DIR: configDir,
  RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES: '1',
  RAGENT_ACCOUNTS_URL: 'https://accounts.direct-ice.invalid',
  RAGENT_ACCOUNTS_ISSUER: 'https://accounts.direct-ice.invalid',
  RAGENT_TURN_BROKER_URL: 'https://turn-broker.direct-ice.invalid',
  RAGENT_TURN_BROKER_TOKEN: 'direct-ice-broker-token',
  RAGENT_TURN_BROKER_AUTH_MODE: 'static',
  RAGENT_P2P_SIGNALING_URL: 'https://signal.direct-ice.invalid',
});
delete process.env.RAGENT_INSTANCE_ROOT;

const accountId = 'acct_direct_ice_owner';
const memberAccountId = 'acct_direct_ice_member';
const ownerDeviceId = 'rdev_owner_direct_ice';
const sharedDeviceId = 'rdev_shared_workspace';
const provisionalDeviceId = 'rdev_provisional_device';
const temporaryDeviceId = 'rdev_temporary_device';
const grantId = `iag_${'a'.repeat(24)}`;
const revision = '7';

const { publicKey: devPub } = generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const { publicKey: edPub, privateKey: edPriv } = generateKeyPairSync('ed25519');
const edPubPem = edPub.export({ type: 'spki', format: 'pem' }).toString();
const accountsKeys = generateKeyPairSync('ed25519');
const accountsKid = 'direct-ice-accounts-1';
const accountsJwk = { ...accountsKeys.publicKey.export({ format: 'jwk' }), kid: accountsKid };

await writeFile(join(configDir, 'owner-account-binding.json'), JSON.stringify({
  version: 1,
  accountId,
  plan: 'plus',
  provider: 'google',
  bindingAuthorityRevision: revision,
  boundAt: new Date().toISOString(),
}));
await writeFile(join(configDir, 'trusted-devices.json'), JSON.stringify({
  version: 1,
  instanceId: 'rli_direct_ice_fixture',
  instanceSecret: 'direct-ice-fixture-instance-secret',
  invitations: [],
  devices: [
    {
      id: ownerDeviceId,
      status: 'bound',
      enrollmentKind: 'account-join',
      accountId,
      bindingAuthorityRevision: revision,
      deviceName: 'Owner Phone',
      platform: 'android',
      devicePublicKey: devPub,
      revokedAt: '',
    },
    {
      id: sharedDeviceId,
      status: 'bound',
      enrollmentKind: 'account-join',
      accountId: memberAccountId,
      bindingAuthorityRevision: revision,
      workspaceAccess: { ownerAccountId: accountId, grantId },
      deviceName: 'Shared Member Phone',
      platform: 'android',
      devicePublicKey: devPub,
      revokedAt: '',
    },
    {
      id: provisionalDeviceId,
      status: 'provisional',
      enrollmentKind: 'account-join',
      accountId,
      bindingAuthorityRevision: revision,
      deviceName: 'Provisional Phone',
      platform: 'android',
      devicePublicKey: devPub,
      revokedAt: '',
    },
    {
      id: temporaryDeviceId,
      status: 'bound',
      enrollmentKind: 'account-join',
      accountId,
      bindingAuthorityRevision: revision,
      temporaryExpiresAt: new Date(Date.now() + 600_000).toISOString(),
      deviceName: 'Temporary Phone',
      platform: 'android',
      devicePublicKey: devPub,
      revokedAt: '',
    },
  ],
  challenges: [],
  authTokens: [],
  accountJoinIntents: [],
}));

const { loadOrCreateInstanceIdentity } = await import('../lib/instance-identity.mjs');
const instanceIdentity = await loadOrCreateInstanceIdentity();

function signAccountsJwt(claims) {
  const encoded = [
    Buffer.from(JSON.stringify({ alg: 'EdDSA', kid: accountsKid })).toString('base64url'),
    Buffer.from(JSON.stringify(claims)).toString('base64url'),
  ].join('.');
  return `${encoded}.${cryptoSign(null, Buffer.from(encoded), accountsKeys.privateKey).toString('base64url')}`;
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  const target = new URL(url);
  if (target.hostname === 'accounts.direct-ice.invalid') {
    if (target.pathname.endsWith('/.well-known/jwks.json')) {
      return Response.json({ keys: [accountsJwk] });
    }
    const body = JSON.parse(options.body || '{}');
    const now = Math.floor(Date.now() / 1000);
    if (target.pathname.endsWith('/v1/owner-auth/instances/workspace-authority')) {
      return Response.json({
        assertion: signAccountsJwt({
          iss: 'https://accounts.direct-ice.invalid',
          aud: instanceIdentity.instanceId,
          tx: body.requestId,
          nonce: body.nonce,
          instanceKeyFingerprint: instanceIdentity.keyFingerprint,
          bindingAuthorityRevision: revision,
          authorityProtocol: 1,
          sub: memberAccountId,
          ownerAccountId: accountId,
          workspaceGrantId: grantId,
          purpose: 'workspace_authority',
          workspaceAuthorityState: 'active',
          iat: now,
          exp: now + 30,
        }),
      });
    }
    if (target.pathname.endsWith('/v1/owner-auth/instances/authority')) {
      return Response.json({
        assertion: signAccountsJwt({
          iss: 'https://accounts.direct-ice.invalid',
          aud: instanceIdentity.instanceId,
          tx: body.requestId,
          nonce: body.nonce,
          instanceKeyFingerprint: instanceIdentity.keyFingerprint,
          bindingAuthorityRevision: revision,
          authorityProtocol: 1,
          sub: accountId,
          purpose: 'binding_authority',
          bindingAuthorityState: 'active',
          iat: now,
          exp: now + 30,
        }),
      });
    }
    if (target.pathname.endsWith('/v1/owner-auth/turn/connections/reserve')) {
      return Response.json({
        authorization: {
          authorized: true,
          status: 'authorized',
          plan: 'pro',
          connectionId: body.connectionId,
          limits: { phones: 10, computers: 10 },
        },
        lease: { connectionId: body.connectionId, expiresAt: body.expiresAt },
        brokerCredential: {
          token: 'fixture-capability-token',
          idempotencyKey: `idem_${Math.random()}`,
        },
      });
    }
    if (target.pathname.endsWith('/v1/owner-auth/turn/connections/release')) {
      return Response.json({ released: true });
    }
  }
  if (target.hostname === 'turn-broker.direct-ice.invalid') {
    const body = JSON.parse(options.body || '{}');
    return Response.json({
      protocolVersion: 1,
      provider: 'cloudflare-realtime',
      transport: 'turn',
      endpoint: 'turn:turn.cloudflare.com:3478?transport=udp',
      iceServers: [{
        urls: 'turn:turn.cloudflare.com:3478?transport=udp',
        username: '1765432100:direct-ice',
        password: 'signed-turn-password',
      }],
      expiresAt: new Date(Date.now() + 20 * 60_000).toISOString(),
      appTrafficOnly: true,
      credentialScope: 'device-access',
      source: 'turn-broker',
      connectionId: body.connectionId,
    }, { status: 201 });
  }
  throw new Error(`Unexpected fetch in direct-ice test: ${url}`);
};

const authorityRuntime = await import('../lib/binding-authority-runtime.mjs');
await authorityRuntime.prepareBindingAuthorityRuntime();

let signaling = null;
try {
  // 1. Pure contract tests (default false, opt-in true, legacy omitted compatibility, tamper detection)
  const turnFixture = {
    provider: 'cloudflare-realtime',
    endpoint: 'turn:turn.cloudflare.com:3478?transport=udp',
    iceServers: [{ urls: 'turn:turn.cloudflare.com:3478?transport=udp', username: 'u', password: 'p' }],
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    connectionId: 'turn_conn_1',
  };
  const defaultContract = buildConnectionBootstrapContract({
    instanceId: 'rli_1',
    deviceId: ownerDeviceId,
    enrollmentKind: 'account-join',
    p2p: { signalingEndpoint: 'https://signal.direct-ice.invalid', roomId: 'a'.repeat(40) },
    turn: turnFixture,
  });
  assert.equal(defaultContract.allowDirectIce, false, 'allowDirectIce must default to false');

  const directContract = buildConnectionBootstrapContract({
    instanceId: 'rli_1',
    deviceId: ownerDeviceId,
    enrollmentKind: 'account-join',
    p2p: { signalingEndpoint: 'https://signal.direct-ice.invalid', roomId: 'a'.repeat(40) },
    turn: turnFixture,
    allowDirectIce: true,
  });
  assert.equal(directContract.allowDirectIce, true);
  const signedDirect = attachContractSignature(directContract, {
    keyId: 'k1',
    signedAt: new Date().toISOString(),
    value: cryptoSign(null, Buffer.from(buildContractSigningPayload(directContract)), edPriv).toString('base64url'),
  });
  assert.equal(verifyConnectionBootstrapContract(signedDirect, edPubPem).valid, true);

  const tampered = structuredClone(signedDirect);
  tampered.allowDirectIce = false;
  assert.equal(verifyConnectionBootstrapContract(tampered, edPubPem).valid, false, 'tampering allowDirectIce must invalidate signature');

  const legacyUnsigned = structuredClone(defaultContract);
  delete legacyUnsigned.allowDirectIce;
  const legacySigned = attachContractSignature(legacyUnsigned, {
    keyId: 'k1',
    signedAt: new Date().toISOString(),
    value: cryptoSign(null, Buffer.from(buildContractSigningPayload(legacyUnsigned)), edPriv).toString('base64url'),
  });
  assert.equal(verifyConnectionBootstrapContract(legacySigned, edPubPem).valid, true, 'legacy contracts omitting allowDirectIce must remain valid');

  const badType = structuredClone(signedDirect);
  badType.allowDirectIce = 'true';
  assert.equal(verifyConnectionBootstrapContract(badType, edPubPem).reason, 'invalid allowDirectIce');

  // 2. Use loaded instance identity for service & route signature verification
  const identity = instanceIdentity;

  // 3. Service + Route layer: owner trusted_device vs shared workspace vs browser override vs provisional
  const { buildDeviceConnectionBootstrapContract } = await import('../chat/connection-bootstrap-service.mjs');
  const { handleConnectionBootstrapRoutes } = await import('../chat/router-connection-bootstrap-routes.mjs');
  const { evaluateTurnConnectionAuthorization } = await import('../lib/turn-authorization.mjs');

  const allowTurn = async (input) => evaluateTurnConnectionAuthorization({
    ...input,
    accountMatches: true,
    accountPlan: 'pro',
    activeDeviceIds: [],
    activePhones: 0,
  });

  const ownerServiceContract = await buildDeviceConnectionBootstrapContract({
    deviceId: ownerDeviceId,
    turnAuthorizationProvider: allowTurn,
  });
  assert.equal(ownerServiceContract.allowDirectIce, true);
  assert.equal(verifyConnectionBootstrapContract(ownerServiceContract, identity.publicKey).valid, true);

  const browserOverrideContract = await buildDeviceConnectionBootstrapContract({
    deviceId: ownerDeviceId,
    allowDirectIce: false,
    turnAuthorizationProvider: allowTurn,
  });
  assert.equal(browserOverrideContract.allowDirectIce, false, 'explicit allowDirectIce:false (browser acceptance) must force relay-only');

  const sharedServiceContract = await buildDeviceConnectionBootstrapContract({
    deviceId: sharedDeviceId,
    allowDirectIce: true,
    turnAuthorizationProvider: allowTurn,
  });
  assert.equal(sharedServiceContract.allowDirectIce, false, 'workspaceAccess devices must never receive allowDirectIce:true');

  const tempServiceContract = await buildDeviceConnectionBootstrapContract({
    deviceId: temporaryDeviceId,
    allowDirectIce: true,
    turnAuthorizationProvider: allowTurn,
  });
  assert.equal(tempServiceContract.allowDirectIce, false, 'temporary trusted devices must never receive allowDirectIce:true');

  const provisionalServiceContract = await buildDeviceConnectionBootstrapContract({
    deviceId: provisionalDeviceId,
    allowDirectIce: true,
    turnAuthorizationProvider: allowTurn,
  });
  assert.equal(provisionalServiceContract.allowDirectIce, false, 'provisional devices must never receive allowDirectIce:true');

  async function callBootstrapRoute(authSession) {
    const req = Readable.from([]);
    req.method = 'GET';
    const headers = {};
    const res = { setHeader(k, v) { headers[k.toLowerCase()] = v; } };
    let status = 0;
    let body = null;
    const handled = await handleConnectionBootstrapRoutes({
      req,
      res,
      pathname: '/api/device-auth/bootstrap',
      authSession,
      writeJson: (_res, s, payload) => { status = s; body = payload; },
    });
    assert.equal(handled, true);
    return { status, body, headers };
  }

  const ownerRoute = await callBootstrapRoute({
    role: 'owner',
    principalKind: 'trusted_device',
    deviceId: ownerDeviceId,
    accountId,
  });
  assert.equal(ownerRoute.status, 200, JSON.stringify(ownerRoute.body));
  assert.equal(ownerRoute.body.allowDirectIce, true);
  assert.equal(verifyConnectionBootstrapContract(ownerRoute.body, identity.publicKey).valid, true);

  const sharedRoute = await callBootstrapRoute({
    role: 'owner',
    principalKind: 'trusted_device',
    deviceId: sharedDeviceId,
    accountId: memberAccountId,
    workspaceAccess: { ownerAccountId: accountId, grantId },
  });
  assert.equal(sharedRoute.status, 200, JSON.stringify(sharedRoute.body));
  assert.equal(sharedRoute.body.allowDirectIce, false, 'shared workspace session must receive allowDirectIce:false');
  assert.equal(verifyConnectionBootstrapContract(sharedRoute.body, identity.publicKey).valid, true);

  const browserRoute = await callBootstrapRoute({
    role: 'owner',
    principalKind: 'browser',
    deviceId: ownerDeviceId,
  });
  assert.equal(browserRoute.status, 403);

  const provisionalRoute = await callBootstrapRoute({
    role: 'visitor',
    principalKind: 'provisional_device',
    deviceId: provisionalDeviceId,
  });
  assert.equal(provisionalRoute.status, 403);

  // 4. End-to-end on-demand registry -> lazy sidecar spawn -> RAGENT_P2P_RELAY_ONLY env propagation
  const stubGo = join(home, 'env_stub.go');
  const stubExe = join(home, process.platform === 'win32' ? 'env-stub.exe' : 'env-stub');
  await writeFile(stubGo, `package main
import (
	"bufio"
	"fmt"
	"os"
)
func main() {
	fmt.Fprintf(os.Stderr, "SIDECAR_ENV relay_only=%s\\n", os.Getenv("RAGENT_P2P_RELAY_ONLY"))
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {}
}
`, 'utf8');
  execFileSync('go', ['build', '-o', stubExe, stubGo], { stdio: 'inherit' });

  signaling = createP2PSignalingServer({ host: '127.0.0.1', port: 0 });
  const sigAddr = await signaling.listen();
  const signalingUrl = `http://127.0.0.1:${sigAddr.port}`;

  await stopAllP2PHosts();
  const sidecarLogsByDevice = new Map([
    [ownerDeviceId, []],
    [sharedDeviceId, []],
  ]);
  const secretsByDevice = new Map([
    [ownerDeviceId, 'direct-ice-owner-secret-1'],
    [sharedDeviceId, 'direct-ice-shared-secret-2'],
  ]);
  const restored = await restoreP2PHostsForDevices(
    [
      { id: ownerDeviceId, status: 'bound', enrollmentKind: 'account-join', accountId, revokedAt: '' },
      {
        id: sharedDeviceId,
        status: 'bound',
        enrollmentKind: 'account-join',
        accountId: memberAccountId,
        workspaceAccess: { ownerAccountId: accountId, grantId },
        revokedAt: '',
      },
    ],
    {
      onDemand: true,
      binaryPath: stubExe,
      signalingUrl,
      getP2PAccess: async (id) => {
        const secret = secretsByDevice.get(id);
        return { roomId: createP2PRoomId(secret), secret };
      },
      getBootstrap: async ({ deviceId }) => buildDeviceConnectionBootstrapContract({
        deviceId,
        turnAuthorizationProvider: allowTurn,
      }),
      runHostAgent: (options) => {
        const logs = sidecarLogsByDevice.get(
          options.roomId === createP2PRoomId(secretsByDevice.get(ownerDeviceId)) ? ownerDeviceId : sharedDeviceId,
        );
        return runP2PHostAgent({
          ...options,
          onSidecarLog: (line) => logs?.push(line),
        });
      },
    },
  );
  assert.equal(restored.started, 2);
  await Promise.all(restored.results.map((r) => r.agent.joined));

  async function triggerOfferAndReadRelayEnv(deviceId) {
    const secret = secretsByDevice.get(deviceId);
    const roomId = createP2PRoomId(secret);
    const ws = new WebSocket(`ws://127.0.0.1:${sigAddr.port}/signal`);
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    try {
      ws.send(JSON.stringify({ type: 'join', roomId, role: 'mobile' }));
      await new Promise((r) => setTimeout(r, 40));
      ws.send(JSON.stringify({
        type: 'signal',
        roomId,
        envelope: signP2PSignal({ roomId, secret, seq: 1, payload: { type: 'offer', sdp: 'stub-offer' } }),
      }));
      const logs = sidecarLogsByDevice.get(deviceId);
      const deadline = Date.now() + 5_000;
      while (!logs.some((line) => line.startsWith('SIDECAR_ENV ')) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      const envLine = logs.find((line) => line.startsWith('SIDECAR_ENV ')) || '';
      assert.ok(envLine, `expected SIDECAR_ENV log for ${deviceId}, got: ${JSON.stringify(logs)}`);
      return envLine;
    } finally {
      ws.close();
    }
  }

  const ownerEnvLine = await triggerOfferAndReadRelayEnv(ownerDeviceId);
  assert.equal(ownerEnvLine, 'SIDECAR_ENV relay_only=0', 'owner trusted_device lazy spawn must set RAGENT_P2P_RELAY_ONLY=0');

  const sharedEnvLine = await triggerOfferAndReadRelayEnv(sharedDeviceId);
  assert.equal(sharedEnvLine, 'SIDECAR_ENV relay_only=1', 'shared workspace lazy spawn must enforce RAGENT_P2P_RELAY_ONLY=1');

  console.log('test-connection-bootstrap-direct-ice: all assertions passed');
} finally {
  await stopAllP2PHosts().catch(() => {});
  if (signaling) await signaling.close().catch(() => {});
  globalThis.fetch = originalFetch;
  await rm(home, { recursive: true, force: true }).catch(() => {});
}
