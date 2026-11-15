import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, realpath, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { Readable } from 'node:stream';

const home = await mkdtemp(join(tmpdir(), 'ragent-handoff-bootstrap-'));
const config = join(home, 'config');
Object.assign(process.env, { RAGENT_CONFIG_DIR: config, RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES: '1',
  RAGENT_ACCOUNTS_URL: 'https://handoff.fixture.invalid/accounts', RAGENT_TURN_BROKER_URL: 'https://handoff.fixture.invalid/turn',
  RAGENT_P2P_SIGNALING_URL: 'https://handoff.fixture.invalid/signal' });
delete process.env.RAGENT_INSTANCE_ROOT;
await mkdir(config);
const accountId = 'acct_handoff_fixture', deviceId = 'rdev_handoff_fixture';
const key = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
await writeFile(join(config, 'owner-account-binding.json'), JSON.stringify({ accountId, provider: 'google' }));
await writeFile(join(config, 'trusted-devices.json'), JSON.stringify({ version: 1, instanceId: 'rli_fixture',
  instanceSecret: 'fixture-secret', devices: [{ id: deviceId, status: 'bound', accountId, enrollmentKind: 'account-join',
    devicePublicKey: key, revokedAt: '' }], invitations: [], challenges: [], authTokens: [], accountJoinIntents: [] }));
const oldFetch = globalThis.fetch;
const central = new Map(); let malformed = false;
globalThis.fetch = async (url, options = {}) => {
  const target = new URL(url); const body = JSON.parse(options.body || '{}');
  if (target.pathname.endsWith('/turn/connections/release')) { central.delete(body.connectionId); return Response.json({ released: true }); }
  if (target.pathname.endsWith('/turn/connections/reserve')) {
    const reason = /^handoff:(turn_[a-f0-9]{32}_[0-9]{13}_[a-f0-9]{32}):([0-9]{13})$/.exec(body.reason || '');
    let item = central.get(body.connectionId);
    if (!item) {
      if (reason) assert(central.has(reason[1]), 'Handoff must reference the existing central lease');
      item = { connectionId: body.connectionId, expiresAt: body.expiresAt,
        ...(reason ? { handoffFrom: reason[1], handoffDeadline: new Date(Math.min(+reason[2], Date.now() + 60_000)).toISOString() } : {}) };
      central.set(item.connectionId, item);
    }
    const authorization = { authorized: true, status: 'authorized', plan: 'free', connectionId: body.connectionId,
      limits: { phones: 1, computers: 1 } };
    return Response.json({ authorization, lease: malformed ? { ...item, handoffFrom: 'wrong' } : item,
      brokerCredential: { token: 'fixture-capability', idempotencyKey: `fixture-${Math.random()}` } });
  }
  if (target.pathname.startsWith('/turn')) return Response.json({ protocolVersion: 1, provider: 'cloudflare-realtime',
    transport: 'turn', endpoint: 'turn:fixture.invalid:3478', connectionId: body.connectionId,
    iceServers: [{ urls: 'turn:fixture.invalid:3478', username: 'fixture', password: 'fixture' }],
    expiresAt: new Date(Date.now() + 20 * 60_000).toISOString(), appTrafficOnly: true,
    credentialScope: 'device-access', source: 'turn-broker' });
  throw Error(`Unexpected fixture URL ${target.pathname}`);
};
try {
  const { buildDeviceConnectionBootstrapContract } = await import('../chat/connection-bootstrap-service.mjs');
  const { TURN_CONNECTION_LEASES_FILE } = await import('../lib/config.mjs');
  const { loadOrCreateInstanceIdentity } = await import('../lib/instance-identity.mjs');
  const { validateTurnHandoffRequest } = await import('../chat/turn-handoff-request.mjs');
  const old = await buildDeviceConnectionBootstrapContract({ deviceId });
  const identity = await loadOrCreateInstanceIdentity();
  const validated = validateTurnHandoffRequest({ contract: old, identity, accountId, deviceId });
  assert.equal(validated.from, old.turn.connectionId);
  assert.equal(validated.signedExpiry, Date.parse(old.expiresAt));
  for (const input of [
    { contract: { ...old, expiresAt: new Date(Date.now() + 600_000).toISOString() }, identity, accountId, deviceId },
    { contract: old, identity, accountId, deviceId: 'different-phone' },
    { contract: old, identity: { ...identity, keyFingerprint: 'different-key' }, accountId, deviceId },
    { contract: old, identity, accountId, deviceId, now: Date.parse(old.expiresAt) },
  ]) assert.throws(() => validateTurnHandoffRequest(input), { code: 'turn_handoff_plan_invalid' });
  const handoff = { from: old.turn.connectionId, signedExpiry: Date.now() + 45_000 };
  const host = await buildDeviceConnectionBootstrapContract({ deviceId, handoff });
  const phone = await buildDeviceConnectionBootstrapContract({ deviceId, handoff: { ...handoff, connectionId: host.turn.connectionId } });
  assert.equal(phone.turn.connectionId, host.turn.connectionId, 'Both peers must receive the same reservation generation');
  const state = JSON.parse(await readFile(TURN_CONNECTION_LEASES_FILE, 'utf8'));
  assert.equal(state.leases.find(x => x.connectionId === old.turn.connectionId).status, 'reserved');
  assert.equal(state.leases.find(x => x.connectionId === host.turn.connectionId).handoffFrom, old.turn.connectionId);
  assert.equal(central.size, 2);
  const registry = await import('../lib/p2p-host-registry.mjs');
  const { handleConnectionBootstrapRoutes } = await import('../chat/router-connection-bootstrap-routes.mjs');
  const agents = [];
  const makeAgent = options => {
    let end; const agent = { ready: Promise.resolve(), joined: Promise.resolve(), done: new Promise(r => { end = r; }),
      stop() { end(); }, suspendSignaling() {}, resumeSignaling() {}, requestCarrierHandoff() { return true; }, activateHandoff() {} };
    agents.push({ options, agent }); return agent;
  };
  await registry.startP2PHostForDevice(deviceId, { p2pAccess: { roomId: 'fixture', secret: 'fixture' },
    signalingUrl: 'https://handoff.fixture.invalid/signal', activeConnectionId: old.turn.connectionId,
    iceServers: old.turn.iceServers, expiresAt: old.turn.expiresAt, runHostAgent: async options => makeAgent(options),
    prepareHandoff: async () => ({ contract: host, connectionId: host.turn.connectionId,
      iceServers: host.turn.iceServers, expiresAt: host.turn.expiresAt }),
    commitHandoff: async () => {}, releaseHandoff: async () => {} });
  const callRoute = async (suffix, body, principal) => {
    const req = Readable.from([JSON.stringify(body)]); req.method = 'POST';
    let response;
    await handleConnectionBootstrapRoutes({ req, res: { setHeader() {} }, pathname: `/api/device-auth/turn/handoff/${suffix}`,
      authSession: principal, writeJson: (_, status, value) => { response = { status, value }; } });
    return response;
  };
  const principal = { principalKind: 'trusted_device', deviceId };
  assert.equal((await callRoute('request', { contract: old }, null)).status, 403);
  assert.equal((await callRoute('request', { contract: old }, principal)).status, 202);
  for (let n = 0; n < 80; n++) await Promise.resolve();
  const standby = agents[1], handoffId = standby.options.handoffId;
  assert.equal((await callRoute('plan', { handoffId }, { ...principal, deviceId: 'other' })).status, 409);
  assert.equal((await callRoute('plan', { handoffId }, principal)).value.turn.connectionId, host.turn.connectionId);
  assert.equal((await callRoute('commit', { handoffId }, principal)).status, 409);
  standby.options.onGatewayResponse({ path: '/api/auth/me', status: 200 });
  assert.equal((await callRoute('commit', { handoffId }, principal)).status, 200);
  standby.options.onGatewayResponse({ path: '/api/device-auth/turn/handoff/commit', status: 200 });
  await registry.stopAllP2PHosts();
  malformed = true;
  await assert.rejects(buildDeviceConnectionBootstrapContract({ deviceId, handoff: { ...handoff, connectionId: host.turn.connectionId } }),
    { code: 'turn_handoff_response_invalid' });
  console.log('PASS bootstrap shares one handoff lease and rejects an invalid Accounts binding');
} finally {
  globalThis.fetch = oldFetch;
  const root = await realpath(home), parent = await realpath(tmpdir());
  assert(root.startsWith(parent + sep) && root.includes('ragent-handoff-bootstrap-'));
  await rm(root, { recursive: true, force: true });
}
