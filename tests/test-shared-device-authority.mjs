import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';

test('a shared device requires current owner and member authority and closes on revocation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ragent-shared-device-'));
  Object.assign(process.env, { AGENTOC_INSTANCE_ROOT: root, AGENTOC_CONFIG_DIR: join(root, 'config'), AGENTOC_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES: '1',
    AGENTOC_ACCOUNTS_URL: 'https://accounts.example.test', AGENTOC_ACCOUNTS_ISSUER: 'https://accounts.example.test' });
  const owner = 'acct_workspace_owner', member = 'acct_workspace_member', grantId = 'iag_' + 'a'.repeat(24), revision = '7';
  await mkdir(join(root, 'config'), { recursive: true });
  await writeFile(join(root, 'config', 'owner-account-binding.json'), JSON.stringify({ accountId: owner,
    provider: 'google', bindingAuthorityRevision: revision, boundAt: new Date().toISOString() }));
  const accounts = generateKeyPairSync('ed25519'), phone = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), kid = 'shared-device-fixture';
  const jwk = { ...accounts.publicKey.export({ format: 'jwk' }), kid }, phoneKey = phone.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const { createDevicePublicKeyFingerprint } = await import('../lib/device-auth-protocol.mjs');
  const identity = await (await import('../lib/instance-identity.mjs')).loadOrCreateInstanceIdentity();
  const protocol = await import('../lib/instance-proof-protocol.mjs');
  const runtime = await import('../lib/binding-authority-runtime.mjs');
  const trusted = await import('../chat/trusted-devices.mjs');
  const handshake = await import('../lib/device-handshake.mjs');
  const { getOwnerAccountFileUploadPolicy } = await import('../lib/owner-account-auth.mjs');
  const nativeFetch = globalThis.fetch, events = [];
  let memberActive = true, workspaceRequests = 0;
  function jwt(claims) {
    const encoded = [Buffer.from(JSON.stringify({ alg: 'EdDSA', kid })).toString('base64url'),
      Buffer.from(JSON.stringify(claims)).toString('base64url')].join('.');
    return `${encoded}.${sign(null, Buffer.from(encoded), accounts.privateKey).toString('base64url')}`;
  }
  globalThis.fetch = async (url, options = {}) => {
    if (new URL(url).pathname.endsWith('/.well-known/jwks.json')) return { ok: true, json: async () => ({ keys: [jwk] }) };
    const body = JSON.parse(options.body), now = Math.floor(Date.now() / 1000);
    if (/\/uploads\/(policy|reserve|release|complete)$/.test(new URL(url).pathname)) {
      assert.equal(body.accountId, member);
      assert.equal(body.grantId, grantId);
      assert.equal(protocol.verifyInstanceProofSignature({ publicKey: body.instance.publicKey,
        message: protocol.buildAccountFileUploadQuotaMessage({ ...body, instanceId: body.instance.instanceId }), signature: body.signature }), true);
      return { ok: true, json: async () => ({ contractVersion: 2, tracked: true, limits: { unlimited: true, maxFileBytes: Number.MAX_SAFE_INTEGER } }) };
    }
    const base = { iss: 'https://accounts.example.test', aud: identity.instanceId, tx: body.requestId,
      nonce: body.nonce, instanceKeyFingerprint: identity.keyFingerprint, bindingAuthorityRevision: revision,
      authorityProtocol: 1, iat: now, exp: now + 30 };
    if (new URL(url).pathname.endsWith('/workspace-authority')) {
      workspaceRequests++;
      assert.equal(protocol.verifyInstanceProofSignature({ publicKey: body.instance.publicKey,
        message: protocol.buildWorkspaceAuthorityProofMessage({ ...body, instanceId: body.instance.instanceId,
          keyFingerprint: body.instance.keyFingerprint }), signature: body.signature }), true);
      return { ok: true, json: async () => ({ assertion: jwt({ ...base, sub: member, ownerAccountId: owner,
        workspaceGrantId: grantId, purpose: 'workspace_authority', workspaceAuthorityState: memberActive ? 'active' : 'inactive' }) }) };
    }
    return { ok: true, json: async () => ({ assertion: jwt({ ...base, sub: owner,
      purpose: 'binding_authority', bindingAuthorityState: 'active' }) }) };
  };
  const unsubscribe = runtime.subscribeBindingAuthority(event => events.push(event));
  try {
    await runtime.prepareBindingAuthorityRuntime();
    const deviceId = 'rdev_shared_device_fixture', intentId = 'rji_shared_device_fixture';
    const intent = { intentId, deviceId, devicePublicKey: phoneKey,
      devicePublicKeyFingerprint: createDevicePublicKeyFingerprint(phoneKey), deviceName: 'Fixture phone', platform: 'android',
      expiresAt: new Date(Date.now() + 120_000).toISOString() };
    const workspaceAccess = { ownerAccountId: owner, grantId };
    const completed = await trusted.completeTrustedDeviceAccountIntent({ intentId, intent, deviceSignature: 'verified-by-accounts',
      accountId: member, requestId: 'shared_device_request_001', bindingAuthorityRevision: revision, workspaceAccess,
      verifiedAccountCompletion: true });
    assert.equal(completed.device.accountId, member); assert.deepEqual(completed.device.workspaceAccess, workspaceAccess);
    const session = await trusted.authenticateTrustedDeviceToken(completed.credential.token);
    assert.equal(session.accountId, member); assert.deepEqual(session.workspaceAccess, workspaceAccess);
    assert.equal((await getOwnerAccountFileUploadPolicy({ expectedAccountId: member, workspacePrincipal: session })).limits.unlimited, true);
    assert.equal(await getOwnerAccountFileUploadPolicy({ expectedAccountId: owner, workspacePrincipal: session }), null);
    const { handleControlRoutes } = await import('../chat/router-control-routes.mjs');
    async function route(method, pathname, principal, payload = null, query = {}, fileAssetRoute = null) {
      const req = new PassThrough(); req.method = method; req.headers = {};
      req.end(payload === null ? '' : JSON.stringify(payload));
      const res = { setHeader() {} };
      assert.equal(await handleControlRoutes({ req, res, pathname, fileAssetRoute, parsedUrl: { query }, authSession: principal,
        requireSessionAccess: async () => true, writeJson: (_response, status, body) => Object.assign(res, { status, body }) }), true);
      return res;
    }
    const payload = { sessionId: 'shared-session', requestId: 'shared-upload', quotaBatchId: 'shared-batch',
      originalName: 'large.bin', mimeType: 'application/octet-stream', sizeBytes: 2 * 1024 * 1024 * 1024, sha256: 'a'.repeat(64) };
    const created = await route('POST', '/api/assets/upload-intents', session, payload);
    assert.equal(created.status, 200);
    assert.equal(created.body.asset.sizeBytes, payload.sizeBytes);
    const receipt = await route('GET', '/api/assets/upload-intents', session, null,
      { sessionId: payload.sessionId, requestId: payload.requestId });
    assert.equal(receipt.status, 200);
    const ownerSession = { role: 'owner', principalKind: 'trusted_device', deviceId: 'other-device', accountId: owner };
    const foreign = await route('GET', '/api/assets/upload-intents', ownerSession, null,
      { sessionId: payload.sessionId, requestId: payload.requestId });
    assert.equal(foreign.status, 404);
    const checkpoint = await route('GET', `/api/assets/${created.body.asset.id}/upload-checkpoint`, ownerSession, null, {},
      { assetId: created.body.asset.id, action: 'upload-checkpoint' });
    assert.equal(checkpoint.status, 403);
    assert.equal(runtime.allowsRemoteBinding(session), true);
    assert.equal(runtime.allowsRemoteBinding({ role: 'owner', principalKind: 'trusted_device', accountId: owner,
      bindingAuthorityRevision: revision, expiry: Date.now() + 60_000 }), true);
    await assert.rejects(handshake.issueDeviceHandshakeToken({ deviceId, ownerId: owner }), { code: 'workspace_capability_unsupported' });
    memberActive = false;
    await assert.rejects(runtime.refreshWorkspaceBindingAuthority({ ownerAccountId: owner, accountId: member, grantId, revision }),
      { code: 'workspace_authority_superseded' });
    assert.equal(runtime.allowsRemoteBinding(session), false);
    await assert.rejects(getOwnerAccountFileUploadPolicy({ expectedAccountId: member, workspacePrincipal: session }));
    assert.equal(await trusted.authenticateTrustedDeviceToken(completed.credential.token), null);
    assert.ok(events.some(event => event.type === 'device-invalidated' && event.deviceId === deviceId));
    assert.ok(workspaceRequests >= 2);
  } finally {
    unsubscribe(); runtime.stopBindingAuthorityMonitor(); globalThis.fetch = nativeFetch;
    await rm(root, { recursive: true, force: true });
  }
});
