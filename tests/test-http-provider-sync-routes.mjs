#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'agentoc-provider-sync-http-'));
process.env.HOME = home;
process.env.AGENTOC_CONFIG_DIR = join(home, 'config');
process.env.AGENTOC_ACCOUNTS_URL = 'https://accounts.example.test';
process.env.AGENTOC_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
delete process.env.AGENTOC_INSTANCE_ROOT;

const { loadOrCreateInstanceIdentity, publicInstanceIdentity, signProviderSyncPeerProof } = await import('../lib/instance-identity.mjs');
const {
  createProviderSyncKeyStore,
  decryptAccountSyncEnvelope,
  encryptAccountSyncEnvelope,
} = await import('../lib/provider-runtime/sync.mjs');
const { createNativeProviderRegistry } = await import('../lib/provider-runtime/registry.mjs');
const { createSecretStore } = await import('../lib/provider-runtime/secret-store.mjs');
const { handleProviderSyncRoutes } = await import('../chat/router-provider-sync-routes.mjs');

const configDir = process.env.AGENTOC_CONFIG_DIR;
await writeFile(join(configDir, 'owner-account-binding.json'), JSON.stringify({ accountId: 'acct_same' }));
const targetIdentity = await loadOrCreateInstanceIdentity();
const sourceIdentity = await loadOrCreateInstanceIdentity({ filePath: join(home, 'source-identity.json') });
const sourceProof = (() => {
  const requestId = 'psync_http_1';
  const issuedAt = new Date().toISOString();
  return {
    requestId,
    accountId: 'acct_same',
    targetInstanceId: targetIdentity.instanceId,
    issuedAt,
    audience: 'agentoc-provider-sync',
    instance: publicInstanceIdentity(sourceIdentity),
    signature: signProviderSyncPeerProof(sourceIdentity, {
      requestId,
      targetInstanceId: targetIdentity.instanceId,
      issuedAt,
      audience: 'agentoc-provider-sync',
    }).signature,
  };
})();

const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  assert.equal(String(url), 'https://accounts.example.test/v1/owner-auth/provider-sync/authorize');
  const request = JSON.parse(options.body);
  return new Response(JSON.stringify({
    authorized: true,
    accountId: 'acct_same',
    sourceInstanceId: request.sourceProof.instance.instanceId,
    sourcePublicKey: request.sourceProof.instance.publicKey.trim(),
    targetInstanceId: request.targetInstanceId,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

function request(body) {
  const chunk = Buffer.from(JSON.stringify(body));
  return {
    method: 'POST',
    on(event, handler) {
      if (event === 'data') queueMicrotask(() => handler(chunk));
      if (event === 'end') queueMicrotask(() => handler());
      return this;
    },
    destroy() {},
  };
}

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body = '') {
      this.body = body;
    },
  };
}

function writeJson(res, statusCode, value) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}

const handshakeResponse = response();
await handleProviderSyncRoutes({
  req: request({ sourceProof }),
  res: handshakeResponse,
  pathname: '/api/provider-sync/handshake',
  writeJson,
});
assert.equal(handshakeResponse.statusCode, 200);
const handshake = JSON.parse(handshakeResponse.body);
assert.equal(handshake.targetInstanceId, targetIdentity.instanceId);
assert.ok(handshake.targetPublicKey);

const snapshot = {
  protocolVersion: 1,
  accountId: 'acct_same',
  sourceInstanceId: sourceIdentity.instanceId,
  records: [{
    key: 'provider-http',
    version: { updatedAt: new Date().toISOString(), counter: 1, writerId: sourceIdentity.instanceId },
    provider: {
      id: 'provider-http',
      syncId: 'provider-http',
      agentType: 'codex',
      protocol: 'openai-responses',
      displayName: 'HTTP test',
      baseUrl: 'https://api.example.test/v1',
      authProfileId: 'auth-http',
    },
    auth: {
      id: 'auth-http',
      agentType: 'codex',
      authType: 'api-key',
      displayName: 'HTTP test',
      storageType: 'secret-store',
      storageRef: 'secret-http',
      accountMetadata: { accountKey: 'account-http' },
    },
    secret: { authType: 'api-key', apiKey: 'sk-http-secret' },
  }, {
    scope: 'provider-credential',
    key: 'account-http',
    credentialInstanceId: 'instance-http',
    credentialVersion: 1,
    secretRef: 'secret-http',
    credentialFingerprint: 'fingerprint-http',
    version: { updatedAt: new Date().toISOString(), counter: 2, writerId: sourceIdentity.instanceId },
    secret: { authType: 'api-key', apiKey: 'sk-http-secret' },
  }],
};
const sourceKeys = createProviderSyncKeyStore({ configDir: join(home, 'source-config') });
const sourceSyncKey = await sourceKeys.getKeyPair();
const pullProof = { ...sourceProof, syncKeyFingerprint: sourceSyncKey.fingerprint,
  signature: signProviderSyncPeerProof(sourceIdentity, { requestId: sourceProof.requestId,
    targetInstanceId: targetIdentity.instanceId, issuedAt: sourceProof.issuedAt,
    audience: sourceProof.audience, syncKeyFingerprint: sourceSyncKey.fingerprint }).signature };
const envelope = encryptAccountSyncEnvelope({
  snapshot,
  recipientPublicKeyPem: handshake.targetPublicKey,
  senderInstanceId: sourceIdentity.instanceId,
  senderSigningPrivateKeyPem: sourceIdentity.privateKey,
  senderSigningPublicKeyPem: sourceIdentity.publicKey,
  recipientInstanceId: targetIdentity.instanceId,
  requestId: sourceProof.requestId,
});
assert.ok(sourceSyncKey.publicKeyPem, 'source key store should be initialized');

const applyResponse = response();
await handleProviderSyncRoutes({
  req: request({ sourceProof, envelope }),
  res: applyResponse,
  pathname: '/api/provider-sync/apply',
  writeJson,
});
assert.equal(applyResponse.statusCode, 200);
assert.deepEqual(JSON.parse(applyResponse.body).accepted, ['provider-credential:account-http', 'provider-http']);
const registry = createNativeProviderRegistry({ configDir });
const secretStore = createSecretStore({ configDir });
assert.equal((await registry.getProviderProfile('provider-http')).displayName, 'HTTP test');
assert.equal((await secretStore.resolveSecret('secret-http')).apiKey, 'sk-http-secret');
const importedAuth = await registry.getAuthProfile('auth-http');
assert.equal(importedAuth.accountMetadata.accountKey, 'account-http');
assert.equal(importedAuth.accountMetadata.credentialInstanceId, 'instance-http');
assert.equal(importedAuth.accountMetadata.credentialVersion, 1);
const ledger = await readFile(join(configDir, 'native-provider-runtime', 'provider-sync-ledger.json'), 'utf8');
assert.equal(ledger.includes('sk-http-secret'), false);
const credentialLedger = await readFile(join(configDir, 'native-provider-runtime', 'credential-ledger.json'), 'utf8');
assert.equal(credentialLedger.includes('sk-http-secret'), false);

const pullResponse = response();
const tamperedPull = response();
await handleProviderSyncRoutes({ req: request({ sourceProof, requesterSyncPublicKey: sourceSyncKey.publicKeyPem, wants: [] }),
  res: tamperedPull, pathname: '/api/provider-sync/pull', writeJson });
assert.equal(tamperedPull.statusCode, 403, 'an unsigned recipient key must never receive an encrypted snapshot');
await handleProviderSyncRoutes({
  req: request({
    sourceProof: pullProof,
    requesterSyncPublicKey: sourceSyncKey.publicKeyPem,
    wants: [{
      scope: 'provider',
      key: 'provider-http',
      version: snapshot.records[0].version,
    }, {
      scope: 'provider-credential',
      key: 'account-http',
      version: { updatedAt: '2020-01-01T00:00:00.000Z', counter: 0, writerId: 'old-peer' },
    }],
  }),
  res: pullResponse,
  pathname: '/api/provider-sync/pull',
  writeJson,
});
assert.equal(pullResponse.statusCode, 200);
const pulled = JSON.parse(pullResponse.body);
const pulledSnapshot = decryptAccountSyncEnvelope({
  envelope: pulled.envelope,
  recipientPrivateKeyPem: sourceSyncKey.privateKeyPem,
  expectedRecipientInstanceId: sourceIdentity.instanceId,
  expectedSenderInstanceId: targetIdentity.instanceId,
  senderSigningPublicKeyPem: targetIdentity.publicKey,
});
assert.deepEqual(pulledSnapshot.records.map((record) => record.key), ['provider-http', 'account-http']);

globalThis.fetch = originalFetch;
console.log('test-http-provider-sync-routes: ok');
