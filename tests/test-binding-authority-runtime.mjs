import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash, sign } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import WebSocket from 'ws';
import { createOwnerAuthBroker } from '../accounts/owner-auth-broker.mjs';
import { handleOwnerAuthRoutes } from '../accounts/owner-auth-routes.mjs';
import { createBindingAuthorityCarrierLifecycle } from '../chat/binding-authority-carriers.mjs';
import { listenFetchLoopback } from './helpers/listen-fetch-loopback.mjs';

const home = await mkdtemp(join(tmpdir(), 'ragent-binding-authority-'));
const config = join(home, 'config'), accountId = 'acct_runtime_authority', deviceId = 'rdev_runtime_authority';
Object.assign(process.env, { HOME: home, RAGENT_CONFIG_DIR: config, RAGENT_WORK_ROOT_DIR: join(home, 'work'),
  RAGENT_MEMORY_DIR: join(home, 'memory'), RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES: '1',
  RAGENT_ACCOUNTS_URL: 'https://authority.fixture.invalid/accounts', RAGENT_ACCOUNTS_ISSUER: 'https://authority.fixture.invalid/accounts',
  RAGENT_AUTH_SESSION_SECRET: 'synthetic-binding-authority-session-secret', SECURE_COOKIES: '0' });
delete process.env.RAGENT_INSTANCE_ROOT;
await mkdir(config, { recursive: true });
await writeFile(join(config, 'auth.json'), JSON.stringify({ username: 'fixture', passwordHash: 'not-used' }));
await writeFile(join(config, 'owner-account-binding.json'), JSON.stringify({ accountId, provider: 'google', boundAt: new Date().toISOString() }));
const phone = generateKeyPairSync('ed25519'), accountsKeys = generateKeyPairSync('ed25519');
const legacyToken = 'rdt_' + 'e'.repeat(64);
await writeFile(join(config, 'trusted-devices.json'), JSON.stringify({ version: 1, instanceId: 'rli_authority_fixture',
  instanceSecret: 'ris_authority_fixture', createdAt: new Date().toISOString(), invitations: [], challenges: [], authTokens: [],
  devices: [{ id: deviceId, status: 'bound', accountId, enrollmentKind: 'account-join',
    tokenHash: createHash('sha256').update(legacyToken).digest('hex'),
    devicePublicKey: phone.publicKey.export({ type: 'spki', format: 'pem' }).toString(), keyAlgorithm: 'ed25519',
    createdAt: new Date().toISOString(), boundAt: new Date().toISOString(), revokedAt: '' }] }));
const identityApi = await import('../lib/instance-identity.mjs'), identity = await identityApi.loadOrCreateInstanceIdentity();
const trusted = await import('../chat/trusted-devices.mjs'), runtime = await import('../lib/binding-authority-runtime.mjs');
const { handleDeviceAuthPublicRoutes } = await import('../chat/router-device-auth-routes.mjs');
const { handleDevicePairingOwnerRoutes } = await import('../chat/router-device-pairing-routes.mjs');
let revision = '7', revokedAt = '', blockedRead = null, enteredRead;
const postgresFixture = process.env.RAGENT_TEST_BINDING_RUNTIME_POSTGRES === '1'
  ? await (await import('./helpers/postgres-binding-authority-fixture.mjs')).createPostgresBindingAuthorityFixture({ identity, accountId })
  : null;
const signAssertion = claims => {
  const payload = [Buffer.from(JSON.stringify({ alg: 'EdDSA', kid: 'runtime-authority' })).toString('base64url'),
    Buffer.from(JSON.stringify(claims)).toString('base64url')].join('.');
  return payload + '.' + sign(null, Buffer.from(payload), accountsKeys.privateKey).toString('base64url');
};
const broker = createOwnerAuthBroker({ issuer: process.env.RAGENT_ACCOUNTS_ISSUER,
  store: { mutate: () => { throw Error('Status must not mutate'); }, readInstanceAuthority: async instanceId => {
    assert.equal(instanceId, identity.instanceId); enteredRead?.(); if (blockedRead) await blockedRead;
    if (postgresFixture) return postgresFixture.store.readInstanceAuthority(instanceId);
    return { instanceId, revision, binding: { instanceId, accountId, instanceKeyFingerprint: identity.keyFingerprint, revokedAt } };
  } }, verifyGoogleCredential: async () => ({}), resolveAccount: async () => ({}), signAssertion });
const accountsServer = createServer(async (req, res) => {
  if (req.url === '/accounts/.well-known/jwks.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ keys: [
      { ...accountsKeys.publicKey.export({ format: 'jwk' }), kid: 'runtime-authority' },
    ] })); return;
  }
  try {
    if (!await handleOwnerAuthRoutes({ req, res, pathname: req.url, broker,
      publicBaseUrl: process.env.RAGENT_ACCOUNTS_URL, googleWebClientId: '' })) { res.writeHead(404); res.end('{}'); }
  } catch { if (!res.headersSent) res.writeHead(500); res.end('{}'); }
});
await listenFetchLoopback(accountsServer);
const realFetch = globalThis.fetch;
// Substitute only fixture TLS routing. The source status handler, HTTP traffic,
// PC proof and Accounts assertion signatures are real; this is not TLS/real TURN acceptance.
globalThis.fetch = (url, options) => {
  const target = new URL(url);
  if (target.origin === 'https://authority.fixture.invalid') {
    return realFetch(`http://127.0.0.1:${accountsServer.address().port}${target.pathname}`, options);
  }
  return realFetch(url, options);
};
const auth = await import('../lib/auth.mjs'), wsApi = await import('../chat/ws.mjs'), clients = await import('../chat/ws-clients.mjs');
const registry = await import('../lib/p2p-host-registry.mjs'), handshake = await import('../lib/device-handshake.mjs');
const sockets = [], agents = [];
let lifecycle, targetServer, wss, releaseBlockedRead;
function fakeAgent() {
  let done; const agent = { ready: Promise.resolve(), done: new Promise(resolve => { done = resolve; }),
    stops: 0, stop() { this.stops++; done({ code: 0 }); } }; agents.push(agent); return agent;
}
async function startHost() {
  return registry.startP2PHostForDevice(deviceId, { p2pAccess: await trusted.getTrustedDeviceP2PAccess(deviceId),
    signalingUrl: 'https://signal.fixture.invalid', runHostAgent: fakeAgent });
}
async function connect(headers = {}) {
  const socket = new WebSocket(`ws://127.0.0.1:${targetServer.address().port}/ws`, { headers }); sockets.push(socket);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); }); return socket;
}
function closes(socket, timeout = 2000) {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Expected remote WebSocket to close')), timeout);
    socket.once('close', () => { clearTimeout(timer); resolve(); });
  });
}
async function request(headers = {}, path = '/protected') {
  return realFetch(`http://127.0.0.1:${targetServer.address().port}${path}`, { headers, signal: AbortSignal.timeout(5000) });
}
async function publishBinding(nextRevision) {
  return runtime.commitVerifiedOwnerBinding({ accountId, bindingAuthorityRevision: nextRevision }, identity,
    () => writeFile(join(config, 'owner-account-binding.json'), JSON.stringify({ accountId, provider: 'google', bindingAuthorityRevision: nextRevision })));
}
async function publicAuth(path, body) {
  return realFetch(`http://127.0.0.1:${targetServer.address().port}/api/device-auth/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
  });
}
async function renewByKey(expectedStatus, expectedCode) {
  const created = await publicAuth('challenges', { devicePublicKey: phone.publicKey.export({ type: 'spki', format: 'pem' }).toString() });
  assert.equal(created.status, 201); const { challenge } = await created.json();
  assert.equal(created.headers.get('cache-control'), 'no-store');
  assert.equal(challenge.deviceId, deviceId); assert.equal(challenge.instanceId, identity.instanceId);
  const verified = await publicAuth('verify', { deviceId, challengeId: challenge.challengeId, nonce: challenge.nonce,
    signature: sign(null, Buffer.from(challenge.message), phone.privateKey).toString('base64url') });
  assert.equal(verified.status, expectedStatus); const response = await verified.json();
  assert.equal(verified.headers.get('cache-control'), 'no-store');
  if (expectedCode) assert.equal(response.code, expectedCode);
  return response;
}
try {
  assert.equal((await trusted.authenticateTrustedDeviceToken(legacyToken)).role, 'owner', 'Legacy protocol remains explicitly legacy until verified enrollment');
  lifecycle = createBindingAuthorityCarrierLifecycle({ subscribe: runtime.subscribeBindingAuthority,
    closeClients: clients.closeInvalidBindingClients, stopHosts: () => registry.stopAllP2PHosts(), restoreHosts: async () => {}, shouldRestore: () => false });
  await runtime.prepareBindingAuthorityRuntime();
  assert.equal(await trusted.authenticateTrustedDeviceToken(legacyToken), null,
    'Server preparation refuses legacy account access before the initial signed response');
  await runtime.refreshCurrentOwnerBindingAuthority();
  assert.equal(await trusted.authenticateTrustedDeviceToken(legacyToken), null,
    'A verified current status activates enforcement without upgrading a legacy bearer');
  await publishBinding('7');
  assert.equal(await trusted.authenticateTrustedDeviceToken(legacyToken), null, 'A legacy bearer cannot inherit new binding authority');
  targetServer = createServer(async (req, res) => {
    if (await handleDeviceAuthPublicRoutes({ req, res, pathname: req.url,
      writeJson: (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); } })) return;
    await auth.authenticateAccountCookie(req); await auth.authenticateBearerToken(req);
    const principal = auth.getAuthSession(req);
    if (principal?.role === 'owner' && await handleDevicePairingOwnerRoutes({ req, res, pathname: req.url,
      authSession: principal, writeJson: (res, status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body));
      } })) return;
    res.writeHead(principal?.role === 'owner' ? 200 : 401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ owner: principal?.role === 'owner' }));
  });
  wss = wsApi.attachWebSocket(targetServer, { authorizeP2PJoin: () => false });
  await listenFetchLoopback(targetServer);
  await renewByKey(401, 'owner_auth_authority_upgrade_required');
  const renewalIntent = await trusted.createTrustedDeviceAccountIntent({
    devicePublicKey: phone.publicKey.export({ type: 'spki', format: 'pem' }).toString(), renewExistingDeviceId: deviceId,
  });
  assert.equal(renewalIntent.deviceId, deviceId);
  const first = await trusted.completeTrustedDeviceAccountIntent({ intentId: renewalIntent.intentId, accountId,
    requestId: 'renewal-upgrade-7', verifiedAccountCompletion: true, bindingAuthorityRevision: '7' });
  const token = first.credential.token;
  assert.equal((await trusted.authenticateTrustedDeviceToken(token)).bindingAuthorityRevision, '7');
  const renewed = await renewByKey(200);
  assert.equal((await trusted.authenticateTrustedDeviceToken(renewed.credential.token)).bindingAuthorityRevision, '7');
  const freshAccess = await trusted.getTrustedDeviceP2PAccess(deviceId);
  assert.equal(renewed.deviceP2P.secret, freshAccess.secret);
  assert.equal(renewed.deviceP2P.roomId, freshAccess.roomId);
  assert(renewed.deviceP2P.signalingEndpoint.startsWith('https://'));
  assert(Date.parse(renewed.credential.expiresAt) <= Date.now() + 15 * 60_000);
  const stranger = generateKeyPairSync('ed25519');
  assert.equal((await publicAuth('challenges', { deviceId,
    devicePublicKey: stranger.publicKey.export({ type: 'spki', format: 'pem' }).toString() })).status, 404);
  assert.equal((await publicAuth('challenges', {})).status, 404);
  assert.equal((await publicAuth('challenges', { devicePublicKey: 'invalid' })).status, 400);
  const entryToken = await handshake.issueDeviceHandshakeToken({ deviceId, ownerId: accountId });
  const googleCookie = await auth.issueSession({ role: 'owner', authMethod: 'google_accounts', accountId, bindingAuthorityRevision: '7' });
  const localCookie = await auth.issueSession({ role: 'owner', authMethod: 'local_web' });
  const oldInvitation = await trusted.createTrustedDeviceInvitation({ accountHandoffAccountId: accountId });
  const remote = await connect({ authorization: 'Bearer ' + token, 'x-ragent-tunnel': 'fixture' });
  const browser = await connect({ cookie: 'session_token=' + googleCookie, 'x-ragent-tunnel': 'fixture' });
  const local = await connect({ cookie: 'session_token=' + localCookie });
  assert.equal((await request({ authorization: 'Bearer ' + token })).status, 200);
  assert.equal((await startHost()).started, true); assert.equal(registry.p2pHostCount(), 1);
  revision = '8'; revokedAt = new Date().toISOString();
  await postgresFixture?.transition(revision, revokedAt);
  await runtime.refreshCurrentOwnerBindingAuthority(); await lifecycle.drain();
  assert.equal(await (await import('../lib/owner-account-auth.mjs')).getOwnerAccountBinding(), null,
    'Verified central revocation clears stale local binding metadata so ordinary pairing can start again');
  assert.equal(await trusted.hasTrustedDeviceAccountClaimTicket(createHash('sha256').update(oldInvitation.token).digest('hex')), false,
    'An old QR claim ticket cannot survive central revocation');
  const freshInvitationResponse = await realFetch(`http://127.0.0.1:${targetServer.address().port}/api/device-pairing/invitations`, {
    method: 'POST', headers: { cookie: 'session_token=' + localCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ protocolVersion: 3 }), signal: AbortSignal.timeout(5000),
  });
  assert.equal(freshInvitationResponse.status, 201, 'Local Owner can create an ordinary fresh claim QR after central revocation');
  const freshInvitation = (await freshInvitationResponse.json()).invitation;
  assert.equal(new URL(freshInvitation.pairingUri).searchParams.get('v'), '3');
  assert.equal(await trusted.hasTrustedDeviceAccountClaimTicket(createHash('sha256').update(freshInvitation.token).digest('hex')), true);
  await Promise.all([closes(remote), closes(browser)]);
  assert.equal(registry.p2pHostCount(), 0); assert.equal(agents[0].stops, 1);
  assert.equal(local.readyState, WebSocket.OPEN);
  assert.equal((await request({ authorization: 'Bearer ' + token })).status, 401);
  assert.equal((await request({ cookie: 'session_token=' + googleCookie, 'x-ragent-tunnel': 'fixture' })).status, 401);
  assert.equal((await request({ cookie: 'session_token=' + localCookie })).status, 200);
  assert.equal((await request({ accept: 'text/html' }, '/local')).status, 200);
  assert.equal(await handshake.consumeDeviceHandshakeToken(entryToken.token), null);
  await assert.rejects(publishBinding('7'), { code: 'owner_auth_authority_superseded' });
  const retained = JSON.parse(await readFile(runtime.OWNER_ACCOUNT_AUTHORITY_FILE, 'utf8'));
  assert.equal(retained.revision, '8'); assert.deepEqual(retained.deniedAccounts, [accountId]);
  const coldSource = `const fs=await import('node:fs'); const t=await import(process.argv[1]); const r=await t.authenticateTrustedDeviceToken(fs.readFileSync(0,'utf8'));
    if(r!==null)throw Error('Revoked credential survived cold process'); process.stdout.write('cold-revocation-denied');`;
  assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', coldSource,
    pathToFileURL(resolve('chat/trusted-devices.mjs')).href], { env: process.env, input: token, encoding: 'utf8' }), 'cold-revocation-denied');
  revision = '9'; revokedAt = ''; await postgresFixture?.transition(revision, revokedAt);
  await runtime.refreshCurrentOwnerBindingAuthority();
  assert.equal(await trusted.authenticateTrustedDeviceToken(token), null, 'A rebind does not upgrade the old token');
  await renewByKey(401, 'owner_auth_authority_required');
  await publishBinding('9');
  const rebound = await trusted.convergeTrustedDevice(deviceId, accountId, { bindingAuthorityRevision: '9' });
  assert.equal((await request({ authorization: 'Bearer ' + rebound.credential.token })).status, 200);
  const recovered = await connect({ authorization: 'Bearer ' + rebound.credential.token });
  assert.equal((await startHost()).started, true);
  const readEntered = new Promise(resolve => { enteredRead = resolve; });
  blockedRead = new Promise(resolve => { releaseBlockedRead = resolve; });
  const stalledStartedAt = Date.now();
  const stalled = runtime.refreshCurrentOwnerBindingAuthority().catch(error => error);
  await readEntered;
  await closes(recovered, 31_000); await lifecycle.drain();
  assert.equal(registry.p2pHostCount(), 0); assert.equal(agents[1].stops, 1);
  assert.equal(local.readyState, WebSocket.OPEN, 'Localweb remains available while remote authority expires');
  // The preceding proof can expire slightly before this newer request's own
  // deadline. Hold the new request beyond its actual start+30s as well.
  await new Promise(resolve => setTimeout(resolve, Math.max(0, stalledStartedAt + 30_050 - Date.now())));
  releaseBlockedRead(); blockedRead = null; enteredRead = null;
  assert.equal((await stalled).code, 'owner_auth_authority_assertion_invalid');
  assert.equal((await (await import('../lib/owner-account-auth.mjs')).getOwnerAccountBinding()).bindingAuthorityRevision, '9',
    'A stalled or expired status response must not clear a still-authorized binding');
  assert.equal((await request({ authorization: 'Bearer ' + rebound.credential.token })).status, 200, 'Fresh status safely restores the same still-authorized generation');
  const racingRenewal = await trusted.createTrustedDeviceAccountIntent({
    devicePublicKey: phone.publicKey.export({ type: 'spki', format: 'pem' }).toString(), renewExistingDeviceId: deviceId,
  });
  const historicalDuplicate = await trusted.createTrustedDeviceAccountIntent({
    devicePublicKey: phone.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  });
  const duplicateCredential = await trusted.completeTrustedDeviceAccountIntent({ intentId: historicalDuplicate.intentId, accountId,
    requestId: 'duplicate-enrollment-9', verifiedAccountCompletion: true, bindingAuthorityRevision: '9' });
  assert.equal((await trusted.authenticateTrustedDeviceToken(duplicateCredential.credential.token)).role, 'owner');
  await trusted.revokeTrustedDevice(deviceId); await lifecycle.drain();
  assert.equal(await trusted.authenticateTrustedDeviceToken(duplicateCredential.credential.token), null,
    'Revoking the phone also denies historical IDs sharing its installation key');
  await assert.rejects(trusted.completeTrustedDeviceAccountIntent({ intentId: racingRenewal.intentId, accountId,
    requestId: 'renewal-raced-revoke', verifiedAccountCompletion: true, bindingAuthorityRevision: '9' }), { code: 'device_enrollment_revoked' });
  await assert.rejects(trusted.createTrustedDeviceAccountIntent({
    devicePublicKey: phone.publicKey.export({ type: 'spki', format: 'pem' }).toString(), renewExistingDeviceId: deviceId,
  }), { code: 'device_enrollment_revoked' });
  assert.equal((await publicAuth('challenges', {
    devicePublicKey: phone.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  })).status, 404, 'A revoked enrollment cannot renew or silently re-enroll by key');
  await writeFile(runtime.OWNER_ACCOUNT_AUTHORITY_FILE, 'null');
  const corruptSource = `const r=await import(process.argv[1]);const i=await import(process.argv[2]);let blocked=false;
    try{await r.commitVerifiedOwnerBinding({accountId:'acct_runtime_authority',bindingAuthorityRevision:'9'},await i.loadOrCreateInstanceIdentity(),()=>{throw Error('Corrupt state was accepted');});}
    catch(e){if(e.code!=='owner_auth_authority_state_invalid')throw e;blocked=true;}
    if(!blocked)throw Error('Corrupt state was not refused');r.stopBindingAuthorityMonitor();process.stdout.write('corrupt-state-denied');`;
  assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', corruptSource,
    pathToFileURL(resolve('lib/binding-authority-runtime.mjs')).href, pathToFileURL(resolve('lib/instance-identity.mjs')).href],
    { env: process.env, encoding: 'utf8' }), 'corrupt-state-denied');
  console.log('binding authority runtime: actual HTTP/Ed25519/SQLite/WebSocket, cold-process revocation, rebind fencing, stalled-refresh hard expiry and localweb preservation passed; P2P process substituted');
  if (postgresFixture) console.log(JSON.stringify({ pass: true, actualLocalPostgres: true,
    legacyWriterCommit: postgresFixture.legacyWriterCommit, migrations: postgresFixture.migrations,
    signedStatusToPcLedger: true, actualHttpEd25519SqliteWebSocket: true,
    coldProcessDenial: true, localwebPreserved: true, actualScm: false, actualTurn: false,
    freshGoogleLogin: false, fixtureTlsRoutingSubstituted: true, realPhone: false }));
} catch (error) {
  // Let owned asynchronous handles finish closing even when a regression
  // fails early. Keep a failing process status and the original assertion.
  console.error(error); process.exitCode = 1;
} finally {
  releaseBlockedRead?.(); runtime.stopBindingAuthorityMonitor(); await lifecycle?.dispose();
  await registry.stopAllP2PHosts();
  for (const socket of sockets) socket.terminate();
  if (wss) await wsApi.closeWebSocketServer(wss, { timeoutMs: 500 });
  if (targetServer) { targetServer.closeAllConnections(); await new Promise(done => targetServer.close(done)); }
  accountsServer.closeAllConnections(); await new Promise(done => accountsServer.close(done));
  auth.closeAuthSessionStore(); globalThis.fetch = realFetch;
  await postgresFixture?.close();
  (await import('../chat/router.mjs')).stopFrontendBuildWatchers();
  const absolute = await realpath(home), base = await realpath(tmpdir());
  assert(absolute.startsWith(base + sep) && absolute.includes('ragent-binding-authority-'));
  await rm(absolute, { recursive: true, force: true });
}
