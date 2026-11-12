// 服务端 signed bootstrap contract 组装层（ADR-0001 2026-08-17 修订）：
// 输入只来自实例持久状态与实例配置——设备记录、实例签名密钥和
// TURN broker 返回的短期凭据；连接模式由服务端判定并整体签名。
import {
  P2P_SIGNALING_URL,
  TURN_BROKER_AUTH_MODE,
  TURN_BROKER_URL,
  TURN_BROKER_TOKEN,
  TURN_BROKER_TIMEOUT_MS,
} from '../lib/config.mjs';
import {
  getOwnerAccountBinding,
  getOwnerAccountBrokerStatus,
  releaseOwnerAccountTurnConnection,
  reserveOwnerAccountTurnConnection,
} from '../lib/owner-account-auth.mjs';
import {
  loadOrCreateInstanceIdentity,
  publicInstanceIdentity,
  signWithInstanceIdentity,
} from '../lib/instance-identity.mjs';
import {
  getTrustedDeviceP2PRoom,
  getTrustedDeviceStatus,
} from './trusted-devices.mjs';
import {
  buildConnectionBootstrapContract,
  buildContractSigningPayload,
  attachContractSignature,
} from '../lib/connection-bootstrap-contract.mjs';
import {
  createTurnAuthorizationProvider,
  publicTurnAuthorization,
} from '../lib/turn-authorization.mjs';
import { requestTurnCredentials } from '../lib/turn-credential-broker-client.mjs';
import { createTurnLeaseId, matchesTurnLeasePair } from '../lib/turn-lease-identity.mjs';
import { reserveRendezvousTurnConnection } from '../lib/rendezvous-turn-reservation.mjs';
import { authorizeDeviceBinding, assertDeviceBindingNow } from '../lib/binding-authority-runtime.mjs';
import {
  listActiveTurnConnectionDeviceIds,
  listActiveTurnConnectionInstanceIds,
  listActiveTurnConnectionCounts,
  releaseTurnConnectionLease,
  reserveTurnConnectionLease,
} from './turn-connection-leases.mjs';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function nowIso() {
  return new Date().toISOString();
}

// TURN is authorized only after server-side account/device checks. The
// provider secret stays in the independent broker; this process receives only
// short-lived credentials for the signed bootstrap contract.
async function resolveInstanceTurnRouting({ device, instanceId, turnAuthorizationProvider = null,
  rendezvousExpiresAt = '', clock = Date.now, signal, handoff = null } = {}) {
  const accountId = trimString(device?.accountId);
  let accountBinding = null;
  try {
    accountBinding = await getOwnerAccountBinding();
  } catch {
    accountBinding = null;
  }
  let accountMatches = Boolean(accountId && trimString(accountBinding?.accountId)
    && accountId === trimString(accountBinding.accountId));
  if (device?.workspaceAccess) {
    const authority = await authorizeDeviceBinding(device);
    accountMatches = authority?.accountId === accountId && authority.workspaceAccess?.ownerAccountId === accountBinding?.accountId;
  }
  const accountPlan = trimString(accountBinding?.plan || accountBinding?.tier || accountBinding?.subscriptionPlan) || 'free';
  const deviceKind = trimString(accountBinding?.deviceKind) || 'phone';
  const accountLimits = accountBinding?.limits && typeof accountBinding.limits === 'object'
    ? accountBinding.limits
    : undefined;
  const activeDeviceIds = accountId
    ? await listActiveTurnConnectionDeviceIds({ accountId, deviceKind }).catch(() => [])
    : [];
  const activeInstanceIds = accountId
    ? await listActiveTurnConnectionInstanceIds({ accountId }).catch(() => [])
    : [];
  const activeCounts = accountId
    ? await listActiveTurnConnectionCounts({ accountId }).catch(() => ({ activePhones: 0, activeComputers: 0 }))
    : { activePhones: 0, activeComputers: 0 };
  const authorizeTurnConnection = typeof turnAuthorizationProvider === 'function'
    ? turnAuthorizationProvider
    : createTurnAuthorizationProvider({
        resolveAccountPlan: async () => accountPlan,
        listActiveDeviceIds: async () => activeDeviceIds,
    accountMatches: async () => accountMatches,
      });
  let decision = await authorizeTurnConnection({
    accountId,
    instanceId,
    deviceId: device?.id,
    accountPlan,
    deviceKind,
    limits: accountLimits,
    activeDeviceIds,
    activeInstanceIds,
    ...activeCounts,
    accountMatches,
  });
  // Accounts owns shared quotas. A cached local plan cannot reject a valid
  // current central entitlement; identity and explicit custom denials still apply.
  const accountsConfigured = getOwnerAccountBrokerStatus().configured;
  const staleLocalQuota = accountsConfigured && typeof turnAuthorizationProvider !== 'function'
    && decision.status === 'quota-exceeded';
  if (!decision.authorized && !staleLocalQuota) return { turn: null, authorization: publicTurnAuthorization(decision) };
  const logicalId = decision.connectionId;
  if (handoff && (!accountsConfigured || !matchesTurnLeasePair(handoff.from, logicalId)
    || (handoff.connectionId && !matchesTurnLeasePair(handoff.connectionId, logicalId))
    || !Number.isSafeInteger(handoff.signedExpiry) || handoff.signedExpiry <= clock())) {
    throw Object.assign(new Error('Invalid TURN handoff identity or deadline'), { code: 'turn_handoff_request_invalid', statusCode: 400 });
  }
  decision = { ...decision, connectionId: handoff?.connectionId || createTurnLeaseId(logicalId) };

  // Accounts is authoritative for cross-instance connection slots when it is
  // configured. The local lease remains a restart/release mirror for the
  // instance and is retained as the development fallback when Accounts is
  // intentionally absent.
  let centralLease = null;
  const brokerAuthMode = accountsConfigured ? 'accounts-capability' : TURN_BROKER_AUTH_MODE;
  if (accountsConfigured) {
    try {
      const reservation = {
        deviceId: device?.id,
        deviceKind,
        connectionId: decision.connectionId,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        ...(handoff ? { protocolVersion: 3, reason: `handoff:${handoff.from}:${handoff.signedExpiry}` } : {}),
      };
      centralLease = rendezvousExpiresAt
        ? await reserveRendezvousTurnConnection({ reserve: reserveOwnerAccountTurnConnection,
          reservation, expiresAt: rendezvousExpiresAt, clock, signal })
        : await reserveOwnerAccountTurnConnection(reservation);
      if (handoff && (centralLease?.lease?.connectionId !== decision.connectionId
        || centralLease?.authorization?.connectionId !== decision.connectionId
        || centralLease?.lease?.handoffFrom !== handoff.from
        || !Number.isFinite(Date.parse(centralLease?.lease?.handoffDeadline || ''))
        || Date.parse(centralLease.lease.handoffDeadline) <= clock()
        || Date.parse(centralLease.lease.handoffDeadline) > handoff.signedExpiry)) {
        await releaseOwnerAccountTurnConnection({ deviceId: device?.id, connectionId: decision.connectionId,
          reason: 'turn-handoff-response-invalid', protocolVersion: 3 }).catch(() => {});
        throw Object.assign(new Error('Accounts returned an invalid TURN handoff'), { code: 'turn_handoff_response_invalid', statusCode: 503 });
      }
      decision = centralLease.authorization || decision;
      if (!decision.authorized) return { turn: null, authorization: publicTurnAuthorization(decision) };
      if (!centralLease?.brokerCredential?.token) {
        await releaseOwnerAccountTurnConnection({
          deviceId: device?.id,
          connectionId: decision.connectionId,
          reason: 'turn-capability-missing',
        }).catch(() => {});
        return {
          turn: null,
          authorization: publicTurnAuthorization({
            ...decision,
            authorized: false,
            status: 'broker-unavailable',
            reasonCode: 'turn_broker_capability_missing',
          }),
        };
      }
    } catch (error) {
      signal?.throwIfAborted();
      return {
        turn: null,
        authorization: publicTurnAuthorization({
          ...decision,
          authorized: false,
          status: error?.statusCode === 429 ? 'quota-exceeded' : 'broker-unavailable',
          reasonCode: error?.code || 'turn_account_lease_unavailable',
        }),
      };
    }
  }

  let brokerResponse;
  try {
    // A connection can be bootstrapped more than once during TURN recovery.
    // In capability mode each freshly issued capability needs its own broker
    // idempotency key; the connection id remains the authorization binding.
    const brokerIdempotencyKey = brokerAuthMode === 'accounts-capability'
      ? (centralLease?.brokerCredential?.idempotencyKey || decision.connectionId)
      : decision.connectionId;
    brokerResponse = await requestTurnCredentials({
      brokerUrl: TURN_BROKER_URL,
      brokerToken: brokerAuthMode === 'accounts-capability' ? '' : TURN_BROKER_TOKEN,
      capabilityToken: brokerAuthMode === 'accounts-capability' ? centralLease?.brokerCredential?.token : '',
      authMode: brokerAuthMode,
      accountId,
      instanceId,
      deviceId: device.id,
      connectionId: decision.connectionId,
      idempotencyKey: brokerIdempotencyKey,
      authorization: publicTurnAuthorization(decision),
      timeoutMs: TURN_BROKER_TIMEOUT_MS,
    });
  } catch (error) {
    if (centralLease) {
      await releaseOwnerAccountTurnConnection({
        deviceId: device?.id,
        connectionId: decision.connectionId,
        reason: 'turn-broker-failed',
      }).catch(() => {});
    }
    return {
      turn: null,
      authorization: publicTurnAuthorization({
        ...decision,
        authorized: false,
        status: error?.statusCode >= 400 && error.statusCode < 500 ? 'broker-rejected' : 'broker-unavailable',
        reasonCode: error?.code || 'turn_broker_unavailable',
      }),
    };
  }

  try {
    const lease = await reserveTurnConnectionLease({
      accountId,
      instanceId,
      deviceId: device.id,
      deviceKind,
      plan: decision.plan,
      limits: centralLease ? decision.limits : accountLimits,
      ...activeCounts,
      connectionId: decision.connectionId,
      expiresAt: brokerResponse.expiresAt,
      ...(handoff ? { handoffFrom: centralLease?.lease?.handoffFrom,
        handoffDeadline: centralLease?.lease?.handoffDeadline } : {}),
    });
    return {
      turn: {
        provider: brokerResponse.provider,
        endpoint: brokerResponse.endpoint,
        iceServers: brokerResponse.iceServers,
        expiresAt: brokerResponse.expiresAt,
        transport: brokerResponse.transport,
        appTrafficOnly: brokerResponse.appTrafficOnly,
        credentialScope: brokerResponse.credentialScope,
        source: brokerResponse.source,
        connectionId: brokerResponse.connectionId,
        authorization: publicTurnAuthorization(lease),
      },
      authorization: publicTurnAuthorization(lease),
    };
  } catch (error) {
    await releaseTurnConnectionLease({ deviceId: device.id, connectionId: decision.connectionId, reason: 'quota-reservation-failed' }).catch(() => {});
    if (centralLease) {
      await releaseOwnerAccountTurnConnection({
        deviceId: device?.id,
        connectionId: decision.connectionId,
        reason: 'local-lease-failed',
      }).catch(() => {});
    }
    return {
      turn: null,
      authorization: publicTurnAuthorization(error?.turnAuthorization || {
        ...decision,
        authorized: false,
        status: 'quota-exceeded',
        reasonCode: error?.code || 'turn_connection_quota_exceeded',
      }),
    };
  }
}

export async function buildDeviceConnectionBootstrapContract({ deviceId, turnAuthorizationProvider = null,
  rendezvousExpiresAt = '', clock = Date.now, signal, handoff = null } = {}) {
  const normalizedDeviceId = trimString(deviceId);
  if (!normalizedDeviceId) {
    const error = new Error('deviceId is required');
    error.statusCode = 400;
    throw error;
  }
  const device = await getTrustedDeviceStatus(normalizedDeviceId);
  if (!device) {
    const error = new Error('Trusted device not found');
    error.statusCode = 404;
    throw error;
  }
  if (device.revokedAt) {
    const error = new Error('Trusted device is revoked');
    error.statusCode = 403;
    throw error;
  }
  // Account TURN proofs and the signed bootstrap contract must use the same
  // Ed25519-derived identity. trusted-devices state may still contain the
  // retired rli_* invitation id, which cannot be used for Accounts leases.
  const instanceIdentity = await loadOrCreateInstanceIdentity();
  const instanceId = trimString(instanceIdentity.instanceId);
  const [p2pRoom, turnResult] = await Promise.all([
    getTrustedDeviceP2PRoom(normalizedDeviceId),
    resolveInstanceTurnRouting({ device, instanceId, turnAuthorizationProvider, rendezvousExpiresAt, clock, signal, handoff }),
  ]);
  if (!turnResult.turn) {
    const error = new Error('TURN bootstrap is unavailable for this device');
    error.code = turnResult.authorization?.reasonCode || 'turn_bootstrap_unavailable';
    error.statusCode = 503;
    throw error;
  }
  if (device.workspaceAccess) {
    try { assertDeviceBindingNow(device); }
    catch (error) {
      await releaseTurnConnectionLease({ deviceId: normalizedDeviceId, connectionId: turnResult.turn.connectionId,
        reason: 'workspace-authority-expired' }).catch(() => {});
      await releaseOwnerAccountTurnConnection({ deviceId: normalizedDeviceId, connectionId: turnResult.turn.connectionId,
        reason: 'workspace-authority-expired' }).catch(() => {});
      throw error;
    }
  }
  const contract = buildConnectionBootstrapContract({
    instanceId,
    deviceId: normalizedDeviceId,
    enrollmentKind: device.enrollmentKind,
    p2p: {
      signalingEndpoint: trimString(P2P_SIGNALING_URL),
      roomId: p2pRoom?.roomId || '',
    },
    turn: turnResult.turn,
    turnAuthorization: turnResult.authorization,
  });
  const publicIdentity = publicInstanceIdentity(instanceIdentity);
  const signatureValue = signWithInstanceIdentity(
    instanceIdentity,
    buildContractSigningPayload(contract),
  );
  return attachContractSignature(contract, {
    keyId: publicIdentity.keyFingerprint,
    signedAt: nowIso(),
    value: signatureValue,
  });
}
