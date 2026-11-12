// Direct computer-to-computer Provider sync client.
// Accounts is used as an authorization oracle during the peer handshake;
// provider payloads are sent only to the target instance.

import { randomBytes } from 'crypto';

import {
  CONFIG_DIR,
} from '../config.mjs';
import {
  createProviderSyncPeerProof,
  authorizeProviderSyncPeer,
  getOwnerAccountBinding,
  listOwnerAccountDevices,
  publishOwnerAccountSyncCatalog,
} from '../owner-account-auth.mjs';
import { loadOrCreateInstanceIdentity } from '../instance-identity.mjs';
import {
  createProviderSyncKeyStore,
  decryptAccountSyncEnvelope,
  encryptProviderSyncEnvelope,
  buildProviderSyncSnapshot,
  isMachineLocalOAuthSyncRecord,
  providerSyncKeyFingerprint,
} from './sync.mjs';
import {
  applyAccountSyncRecords,
  listAccountSyncRecords,
} from '../../chat/native-provider-management.mjs';
import { compareSyncVersions, syncRecordIdentity } from '../account-sync.mjs';

// A control-plane process can trigger sync from several independent paths:
// provider mutation callbacks, OAuth completion, startup recovery, and the
// periodic convergence worker.  They must share one in-flight operation per
// machine.  This is deliberately a sync-operation lock, not a Run/provider
// lock: concurrent model Runs remain unaffected.
let accountSyncInFlight = null;
// Each computer can actively send its local provider records to reachable
// peers. This is essential when the local computer cannot accept inbound
// connections. The cache contains only version metadata, never credentials.
const providerPushState = new Map();
const PROVIDER_PUSH_REFRESH_MS = 15 * 60 * 1000;

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function buildProviderSyncEndpointUrl(endpoint, path) {
  try {
    const url = new URL(trimString(endpoint));
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    const basePath = url.pathname.replace(/\/+$/, '');
    url.pathname = `${basePath}${path}`;
    url.search = '';
    url.hash = '';
    return url;
  } catch {
    return null;
  }
}

async function fetchJson(fetchImpl, url, options = {}) {
  let response;
  try {
    response = await fetchImpl(url, options);
  } catch (error) {
    const wrapped = new Error(`Provider sync peer is unavailable: ${error?.message || error}`);
    wrapped.code = 'provider_sync_peer_unavailable';
    throw wrapped;
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body?.error || `Provider sync peer rejected the request (${response.status}).`);
    error.code = body?.code || 'provider_sync_peer_rejected';
    error.statusCode = response.status;
    throw error;
  }
  return body;
}

async function verifyPeerResponse({ proof, peerInstanceId, localInstanceId, requestId, keyFingerprint, accountId, fetchImpl }) {
  if (!proof || proof.requestId !== requestId || proof.targetInstanceId !== localInstanceId
    || proof.instance?.instanceId !== peerInstanceId || proof.syncKeyFingerprint !== keyFingerprint) {
    const error = new Error('Provider sync peer response proof is invalid.');
    error.code = 'provider_sync_peer_response_invalid';
    throw error;
  }
  const authorization = await authorizeProviderSyncPeer({ sourceProof: proof, targetInstanceId: localInstanceId, fetchImpl });
  if (!authorization?.authorized || authorization.accountId !== accountId
    || authorization.sourceInstanceId !== peerInstanceId || authorization.targetInstanceId !== localInstanceId
    || trimString(authorization.sourcePublicKey) !== trimString(proof.instance.publicKey)) {
    const error = new Error('Provider sync peer identity is not authorized.');
    error.code = 'provider_sync_peer_response_invalid';
    throw error;
  }
  return authorization.sourcePublicKey;
}

export async function syncProviderSnapshotToPeer({
  targetEndpoint,
  targetInstanceId,
  snapshot,
  fetchImpl = globalThis.fetch,
  clock = Date.now,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('Provider sync requires fetch.');
  const target = trimString(targetInstanceId);
  const handshakeUrl = buildProviderSyncEndpointUrl(targetEndpoint, '/api/provider-sync/handshake');
  const applyUrl = buildProviderSyncEndpointUrl(targetEndpoint, '/api/provider-sync/apply');
  if (!target || !handshakeUrl || !applyUrl) {
    const error = new Error('Provider sync target endpoint is invalid.');
    error.code = 'provider_sync_target_invalid';
    throw error;
  }
  const identity = await loadOrCreateInstanceIdentity();
  const proof = await createProviderSyncPeerProof({
    targetInstanceId: target,
    requestId: `psync_${randomBytes(18).toString('base64url')}`,
    clock,
  });
  const handshake = await fetchJson(fetchImpl, handshakeUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ sourceProof: proof }),
  });
  if (handshake.targetInstanceId !== target || !trimString(handshake.targetPublicKey)) {
    const error = new Error('Provider sync peer returned an invalid encryption key.');
    error.code = 'provider_sync_peer_response_invalid';
    throw error;
  }
  await verifyPeerResponse({ proof: handshake.targetProof, peerInstanceId: target, localInstanceId: identity.instanceId,
    requestId: proof.requestId, keyFingerprint: providerSyncKeyFingerprint(handshake.targetPublicKey),
    accountId: proof.accountId, fetchImpl });
  const normalizedSnapshot = buildProviderSyncSnapshot(snapshot);
  const envelope = encryptProviderSyncEnvelope({
    snapshot: normalizedSnapshot,
    recipientPublicKeyPem: handshake.targetPublicKey,
    senderInstanceId: identity.instanceId,
    senderSigningPrivateKeyPem: identity.privateKey,
    senderSigningPublicKeyPem: identity.publicKey,
    recipientInstanceId: target,
    requestId: proof.requestId,
  });
  return fetchJson(fetchImpl, applyUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ sourceProof: proof, envelope }),
  });
}

export async function pullAccountSyncRecordsFromPeer({
  sourceEndpoint,
  sourceInstanceId,
  wants = [],
  have = [],
  fetchImpl = globalThis.fetch,
  clock = Date.now,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('Account sync requires fetch.');
  const source = trimString(sourceInstanceId);
  const pullUrl = buildProviderSyncEndpointUrl(sourceEndpoint, '/api/provider-sync/pull');
  if (!source || !pullUrl) {
    const error = new Error('Account sync source endpoint is invalid.');
    error.code = 'account_sync_source_invalid';
    throw error;
  }
  const identity = await loadOrCreateInstanceIdentity();
  const keyPair = await createProviderSyncKeyStore({ configDir: CONFIG_DIR }).getKeyPair();
  const proof = await createProviderSyncPeerProof({
    targetInstanceId: source,
    requestId: `async_pull_${randomBytes(18).toString('base64url')}`,
    syncKeyFingerprint: keyPair.fingerprint,
    clock,
  });
  const response = await fetchJson(fetchImpl, pullUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      sourceProof: proof,
      requesterSyncPublicKey: keyPair.publicKeyPem,
      wants,
      have,
    }),
  });
  if (response.sourceInstanceId !== source || !trimString(response.sourcePublicKey) || !response.envelope) {
    const error = new Error('Account sync peer returned an invalid pull response.');
    error.code = 'account_sync_peer_response_invalid';
    throw error;
  }
  const trustedKey = await verifyPeerResponse({ proof: response.targetProof, peerInstanceId: source,
    localInstanceId: identity.instanceId, requestId: proof.requestId, keyFingerprint: keyPair.fingerprint,
    accountId: proof.accountId, fetchImpl });
  if (response.envelope.requestId !== proof.requestId || trimString(response.sourcePublicKey) !== trimString(trustedKey)) {
    const error = new Error('Account sync peer response does not match its authorization.');
    error.code = 'account_sync_peer_response_invalid';
    throw error;
  }
  const snapshot = decryptAccountSyncEnvelope({
    envelope: response.envelope,
    recipientPrivateKeyPem: keyPair.privateKeyPem,
    expectedRecipientInstanceId: identity.instanceId,
    expectedSenderInstanceId: source,
    senderSigningPublicKeyPem: trustedKey,
  });
  if (snapshot.accountId !== proof.accountId) {
    const error = new Error('Account sync snapshot belongs to a different account.');
    error.code = 'provider_sync_account_mismatch';
    throw error;
  }
  return snapshot.records;
}

async function performAccountSyncFromAccountPeers({
  registry,
  secretStore,
  ledger,
  credentialLedger,
  fetchImpl = globalThis.fetch,
  clock = Date.now,
} = {}) {
  const binding = await getOwnerAccountBinding();
  if (!binding?.accountId) return { skipped: true, reason: 'not-bound', peers: [], pulled: [] };
  const identity = await loadOrCreateInstanceIdentity();
  const localRecords = await listAccountSyncRecords({
    registry,
    secretStore,
    ledger,
    credentialLedger,
    sourceInstanceId: identity.instanceId,
  });
  await publishOwnerAccountSyncCatalog({
    entries: localRecords.map((record) => ({
      scope: record.scope || 'provider',
      key: record.key,
      version: record.version,
      ...(record.deletedAt ? { deletedAt: record.deletedAt } : {}),
    })),
    fetchImpl,
    clock,
  });
  const directory = await listOwnerAccountDevices({ fetchImpl });
  const peers = (Array.isArray(directory?.devices) ? directory.devices : [])
    .filter((device) => device?.deviceKind === 'computer'
      && !device.unboundAt
      && trimString(device.instanceId)
      && device.instanceId !== identity.instanceId
      && trimString(device.endpoint));
  const catalog = Array.isArray(directory?.syncCatalog) ? directory.syncCatalog : [];
  const orderedPeers = [...peers].sort((left, right) => {
    const leftPreferred = catalog.some((entry) => entry.sourceInstanceId === left.instanceId);
    const rightPreferred = catalog.some((entry) => entry.sourceInstanceId === right.instanceId);
    return Number(rightPreferred) - Number(leftPreferred);
  });
  // Pulls update the local registry and ledger. Keep them sequential so two
  // peer responses cannot read the same old ledger state and overwrite one
  // another while applying different scopes.
  const results = [];
  for (const peer of orderedPeers) {
    try {
      const currentRecords = await listAccountSyncRecords({
        registry,
        secretStore,
        ledger,
        credentialLedger,
        sourceInstanceId: identity.instanceId,
      });
      const currentByIdentity = new Map(currentRecords.map((record) => [
        syncRecordIdentity(record.scope || 'provider', record.key),
        record,
      ]));
      const catalogByIdentity = new Map(catalog.map((entry) => [syncRecordIdentity(entry.scope, entry.key), entry]));
      const providersToPush = currentRecords.filter((record) => (record.scope || 'provider') === 'provider'
        && !isMachineLocalOAuthSyncRecord(record)
        && (record.deletedAt || (record.provider && record.auth && record.secret))
        && (() => {
          const latest = catalogByIdentity.get(syncRecordIdentity('provider', record.key));
          return !latest || compareSyncVersions(record.version, latest.version) >= 0;
        })());
      let pushError = null;
      if (providersToPush.length) {
        const fingerprint = JSON.stringify(providersToPush.map(({ key, version, deletedAt }) => ({ key, version, deletedAt }))
          .sort((a, b) => a.key.localeCompare(b.key)));
        const stateKey = `${binding.accountId}:${identity.instanceId}:${peer.instanceId}:${peer.endpoint}`;
        const previous = providerPushState.get(stateKey);
        if (!previous || previous.fingerprint !== fingerprint || clock() - previous.pushedAt >= PROVIDER_PUSH_REFRESH_MS) {
          try {
            await syncProviderSnapshotToPeer({ targetEndpoint: peer.endpoint, targetInstanceId: peer.instanceId,
              snapshot: { accountId: binding.accountId, sourceInstanceId: identity.instanceId, records: providersToPush },
              fetchImpl, clock });
            providerPushState.set(stateKey, { fingerprint, pushedAt: clock() });
          } catch (error) { pushError = error; }
        }
      }
      const wants = catalog
        .filter((entry) => !isMachineLocalOAuthSyncRecord(entry))
        .filter((entry) => {
          const local = currentByIdentity.get(syncRecordIdentity(entry.scope, entry.key));
          return !local || compareSyncVersions(entry.version, local.version) > 0;
        })
        .map((entry) => ({
          scope: entry.scope,
          key: entry.key,
          version: entry.version,
          ...(entry.deletedAt ? { deletedAt: entry.deletedAt } : {}),
        }));
      if (wants.length === 0) {
        if (pushError) throw pushError;
        results.push({ status: 'fulfilled', value: { skipped: true, reason: 'up-to-date', accepted: [] } });
        continue;
      }
      const pulled = await pullAccountSyncRecordsFromPeer({
        sourceEndpoint: peer.endpoint,
        sourceInstanceId: peer.instanceId,
        wants,
        have: currentRecords.map((record) => ({ scope: record.scope || 'provider', key: record.key, version: record.version })),
        fetchImpl,
        clock,
      });
      const applied = await applyAccountSyncRecords({
        registry,
        secretStore,
        ledger,
        credentialLedger,
        localInstanceId: identity.instanceId,
        incoming: pulled,
      });
      if (pushError) throw pushError;
      results.push({
        status: 'fulfilled',
        value: {
          skipped: false,
          accepted: applied.accepted,
          ignored: applied.ignored,
          machineLocalIgnored: applied.machineLocalIgnored,
        },
      });
    } catch (error) {
      results.push({ status: 'rejected', reason: error });
    }
  }
  const updatedRecords = await listAccountSyncRecords({
    registry,
    secretStore,
    ledger,
    credentialLedger,
    sourceInstanceId: identity.instanceId,
  });
  await publishOwnerAccountSyncCatalog({
    entries: updatedRecords.map((record) => ({
      scope: record.scope || 'provider',
      key: record.key,
      version: record.version,
      ...(record.deletedAt ? { deletedAt: record.deletedAt } : {}),
    })),
    fetchImpl,
    clock,
  }).catch(() => {});
  return {
    skipped: false,
    peers: orderedPeers.map((peer, index) => ({
      instanceId: peer.instanceId,
      ok: results[index]?.status === 'fulfilled',
      ...(results[index]?.status === 'fulfilled' ? { result: results[index].value } : {}),
      ...(results[index]?.status === 'rejected' ? { error: results[index].reason?.message || 'peer rejected' } : {}),
    })),
  };
}

export function syncAccountSyncFromAccountPeers(options = {}) {
  if (accountSyncInFlight) return accountSyncInFlight;
  const operation = performAccountSyncFromAccountPeers(options);
  const settled = operation.finally(() => {
    if (accountSyncInFlight === settled) accountSyncInFlight = null;
  });
  accountSyncInFlight = settled;
  return settled;
}

// Compatibility name retained for callers that used the old mutation hook.
// The operation now publishes local version metadata and pulls missing records
// from peers instead of pushing a full snapshot to every computer.
export async function syncProviderSnapshotToAccountPeers(options = {}) {
  return syncAccountSyncFromAccountPeers(options);
}
