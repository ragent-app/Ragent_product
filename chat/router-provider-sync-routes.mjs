// Provider-only peer synchronization. This route is intentionally outside
// the ordinary owner session gate: the source computer authenticates through
// Accounts, and the payload is accepted only after the target has authorized
// that exact peer and decrypts a signed envelope.

import { readBody } from '../lib/utils.mjs';
import { CONFIG_DIR } from '../lib/config.mjs';
import { compareSyncVersions } from '../lib/account-sync.mjs';
import {
  authorizeProviderSyncPeer,
  createProviderSyncPeerProof,
  getOwnerAccountBinding,
} from '../lib/owner-account-auth.mjs';
import { loadOrCreateInstanceIdentity } from '../lib/instance-identity.mjs';
import {
  createProviderSyncKeyStore,
  buildAccountSyncSnapshot,
  decryptAccountSyncEnvelope,
  decryptProviderSyncEnvelope,
  encryptAccountSyncEnvelope,
  providerSyncKeyFingerprint,
} from '../lib/provider-runtime/sync.mjs';
import {
  applyAccountSyncRecords,
  listAccountSyncRecords,
} from './native-provider-management.mjs';

const MAX_PROVIDER_SYNC_BODY_BYTES = 8 * 1024 * 1024;

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

async function readJsonBody(req) {
  const body = await readBody(req, MAX_PROVIDER_SYNC_BODY_BYTES);
  return body ? JSON.parse(body) : {};
}

async function authorizePeer(sourceProof, targetInstanceId) {
  const result = await authorizeProviderSyncPeer({ sourceProof, targetInstanceId });
  if (!result?.authorized
    || result.targetInstanceId !== targetInstanceId
    || !trimString(result.accountId)
    || !trimString(result.sourceInstanceId)
    || !trimString(result.sourcePublicKey)) {
    const error = new Error('Accounts returned an invalid provider sync authorization.');
    error.code = 'provider_sync_auth_response_invalid';
    error.statusCode = 502;
    throw error;
  }
  return result;
}

export async function handleProviderSyncRoutes({ req, res, pathname, writeJson }) {
  if (!['/api/provider-sync/handshake', '/api/provider-sync/apply', '/api/provider-sync/pull'].includes(pathname)
    || req.method !== 'POST') return false;

  try {
    const identity = await loadOrCreateInstanceIdentity();
    const binding = await getOwnerAccountBinding();
    if (!binding?.accountId) {
      writeJson(res, 403, { error: 'This instance has no Accounts binding.', code: 'owner_auth_not_bound' });
      return true;
    }
    const payload = await readJsonBody(req);
    const authorization = await authorizePeer(payload?.sourceProof, identity.instanceId);
    if (authorization.accountId !== binding.accountId) {
      writeJson(res, 403, { error: 'Provider sync account mismatch.', code: 'provider_sync_account_mismatch' });
      return true;
    }
    const keyStore = createProviderSyncKeyStore({ configDir: CONFIG_DIR });
    const syncKey = await keyStore.getKeyPair();

    if (pathname === '/api/provider-sync/handshake') {
      const targetProof = await createProviderSyncPeerProof({ targetInstanceId: authorization.sourceInstanceId,
        requestId: payload.sourceProof.requestId, syncKeyFingerprint: syncKey.fingerprint });
      writeJson(res, 200, {
        protocolVersion: 1,
        targetInstanceId: identity.instanceId,
        targetPublicKey: syncKey.publicKeyPem,
        sourceInstanceId: authorization.sourceInstanceId,
        expiresAt: authorization.expiresAt,
        targetProof,
      });
      return true;
    }

    if (pathname === '/api/provider-sync/pull') {
      const requesterSyncPublicKey = trimString(payload?.requesterSyncPublicKey);
      if (!requesterSyncPublicKey || authorization.sourceInstanceId !== trimString(payload?.sourceProof?.instance?.instanceId)) {
        writeJson(res, 400, { error: 'Account sync pull requester is invalid.', code: 'account_sync_request_invalid' });
        return true;
      }
      if (providerSyncKeyFingerprint(requesterSyncPublicKey) !== payload?.sourceProof?.syncKeyFingerprint) {
        writeJson(res, 403, { error: 'Requester encryption key is not signed.', code: 'provider_sync_key_mismatch' });
        return true;
      }
      const [{ createNativeProviderRegistry, createSecretStore, createProviderSyncLedger, createCredentialMutationLedger }] = await Promise.all([
        import('../lib/provider-runtime/index.mjs'),
      ]);
      const records = await listAccountSyncRecords({
        registry: createNativeProviderRegistry({ configDir: CONFIG_DIR }),
        secretStore: createSecretStore({ configDir: CONFIG_DIR }),
        ledger: createProviderSyncLedger({ configDir: CONFIG_DIR }),
        credentialLedger: createCredentialMutationLedger({ configDir: CONFIG_DIR }),
        sourceInstanceId: identity.instanceId,
      });
      const wants = new Map((Array.isArray(payload?.wants) ? payload.wants : []).map((entry) => [
        `${entry?.scope || 'provider'}:${entry?.key || ''}`,
        entry,
      ]));
      const have = new Map((Array.isArray(payload?.have) ? payload.have : []).map((entry) => [
        `${entry?.scope || 'provider'}:${entry?.key || ''}`,
        entry,
      ]));
      const wantedRecords = records.filter((record) => {
        const identity = `${record.scope || 'provider'}:${record.key}`;
        const want = wants.get(identity);
        if (!want) return false;
        // A catalog entry can refer to an offline instance's newer version.
        // A reachable peer's older copy is still useful if the requester has
        // nothing as new. Never use that fallback to bypass a newer deletion.
        if (want.deletedAt && compareSyncVersions(record.version, want.version) < 0) return false;
        const current = have.get(identity);
        return !current || compareSyncVersions(record.version, current.version) > 0;
      });
      const snapshot = buildAccountSyncSnapshot({
        accountId: binding.accountId,
        sourceInstanceId: identity.instanceId,
        records: wantedRecords,
      });
      const envelope = encryptAccountSyncEnvelope({
        snapshot,
        recipientPublicKeyPem: requesterSyncPublicKey,
        senderInstanceId: identity.instanceId,
        senderSigningPrivateKeyPem: identity.privateKey,
        senderSigningPublicKeyPem: identity.publicKey,
        recipientInstanceId: authorization.sourceInstanceId,
        requestId: trimString(payload?.sourceProof?.requestId),
      });
      const targetProof = await createProviderSyncPeerProof({ targetInstanceId: authorization.sourceInstanceId,
        requestId: payload.sourceProof.requestId, syncKeyFingerprint: providerSyncKeyFingerprint(requesterSyncPublicKey) });
      writeJson(res, 200, {
        ok: true,
        protocolVersion: snapshot.protocolVersion,
        sourceInstanceId: identity.instanceId,
        sourcePublicKey: identity.publicKey,
        recordCount: snapshot.records.length,
        envelope,
        targetProof,
      });
      return true;
    }

    const envelope = payload?.envelope;
    if (!envelope || envelope.senderInstanceId !== authorization.sourceInstanceId
      || envelope.requestId !== payload?.sourceProof?.requestId) {
      writeJson(res, 403, { error: 'Provider sync envelope sender mismatch.', code: 'provider_sync_peer_mismatch' });
      return true;
    }
    let snapshot;
    try {
      snapshot = decryptAccountSyncEnvelope({
        envelope,
        recipientPrivateKeyPem: syncKey.privateKeyPem,
        expectedRecipientInstanceId: identity.instanceId,
        expectedSenderInstanceId: authorization.sourceInstanceId,
        senderSigningPublicKeyPem: authorization.sourcePublicKey,
      });
    } catch (error) {
      // Older callers still send provider-only envelopes. Keep that wire
      // format readable while new account snapshots can carry credential and
      // Agent scopes.
      if (!['provider_sync_record_invalid', 'provider_sync_secret_missing', 'account_sync_scope_invalid'].includes(error?.code)) {
        throw error;
      }
      snapshot = decryptProviderSyncEnvelope({
        envelope,
        recipientPrivateKeyPem: syncKey.privateKeyPem,
        expectedRecipientInstanceId: identity.instanceId,
        expectedSenderInstanceId: authorization.sourceInstanceId,
        senderSigningPublicKeyPem: authorization.sourcePublicKey,
      });
    }
    if (snapshot.accountId !== binding.accountId) {
      writeJson(res, 403, { error: 'Provider sync account mismatch.', code: 'provider_sync_account_mismatch' });
      return true;
    }
    const [{ createNativeProviderRegistry, createSecretStore, createProviderSyncLedger, createCredentialMutationLedger }] = await Promise.all([
      import('../lib/provider-runtime/index.mjs'),
    ]);
    const result = await applyAccountSyncRecords({
      registry: createNativeProviderRegistry({ configDir: CONFIG_DIR }),
      secretStore: createSecretStore({ configDir: CONFIG_DIR }),
      ledger: createProviderSyncLedger({ configDir: CONFIG_DIR }),
      credentialLedger: createCredentialMutationLedger({ configDir: CONFIG_DIR }),
      localInstanceId: identity.instanceId,
      incoming: snapshot.records,
    });
    writeJson(res, 200, {
      ok: true,
      protocolVersion: snapshot.protocolVersion,
      accepted: result.accepted,
      ignored: result.ignored,
    });
  } catch (error) {
    writeJson(res, error?.statusCode || 400, {
      error: error?.message || 'Provider sync failed.',
      code: error?.code || 'provider_sync_failed',
    });
  }
  return true;
}
