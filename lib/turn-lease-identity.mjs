import { createHash, randomBytes } from 'node:crypto';

const text = value => typeof value === 'string' ? value.trim() : '';
const LOGICAL_ID = /^turn_[a-f0-9]{32}$/;
const LEASE_ID = /^turn_[a-f0-9]{32}_([0-9]{13})_[a-f0-9]{32}$/;
export const TURN_LEASE_ADMISSION_WINDOW_MS = 2 * 60_000;

/** A reservation generation lives in the existing durable connection_id PK. */
export function createTurnLeaseId(logicalId, nonce = randomBytes(16).toString('hex'), issuedAt = Date.now()) {
  if (!LOGICAL_ID.test(text(logicalId)) || !/^[a-f0-9]{32}$/.test(text(nonce))
    || !Number.isSafeInteger(issuedAt) || !/^[0-9]{13}$/.test(String(issuedAt))) throw new TypeError('Invalid TURN reservation identity');
  return `${text(logicalId)}_${issuedAt}_${text(nonce)}`;
}
export function isTurnLeaseId(value) { return LEASE_ID.test(text(value)); }
export function turnLeaseObservedAt(lease) {
  return Math.max(Date.parse(lease?.createdAt) || 0, Date.parse(lease?.updatedAt) || 0);
}
export function turnLeasePairClock(leases, connectionId, nowMs) {
  return leases.reduce((observed, lease) => lease.connectionId.slice(0, 37) === connectionId.slice(0, 37)
    ? Math.max(observed, turnLeaseObservedAt(lease)) : observed, nowMs);
}
export function canAdmitTurnLeaseId(value, nowMs = Date.now(), observedNowMs = nowMs) {
  const issuedAt = Number(LEASE_ID.exec(text(value))?.[1]);
  return issuedAt > 0 && issuedAt <= nowMs + 30_000 && issuedAt >= Math.max(nowMs, observedNowMs) - TURN_LEASE_ADMISSION_WINDOW_MS;
}
export function retainTurnLease(lease, nowMs) {
  if (!isTurnLeaseId(lease?.connectionId)) return true;
  if (['reserved', 'connected'].includes(lease.status) && Date.parse(lease.expiresAt) > nowMs) return true;
  return Number(LEASE_ID.exec(lease.connectionId)[1]) + TURN_LEASE_ADMISSION_WINDOW_MS >= nowMs;
}
/** Keep one durable clock watermark per pair even after older tombstones expire. */
export function pruneTurnLeases(leases, nowMs) {
  const newest = new Map();
  for (const lease of leases) {
    if (!isTurnLeaseId(lease.connectionId)) continue;
    const pair = lease.connectionId.slice(0, 37), previous = newest.get(pair);
    if (!previous || turnLeaseObservedAt(lease) > turnLeaseObservedAt(previous)
      || (turnLeaseObservedAt(lease) === turnLeaseObservedAt(previous) && lease.connectionId > previous.connectionId)) newest.set(pair, lease);
  }
  return leases.filter(lease => retainTurnLease(lease, nowMs) || newest.get(lease.connectionId.slice(0, 37)) === lease);
}
export function matchesTurnLeasePair(leaseId, logicalId) {
  return isTurnLeaseId(leaseId) && LOGICAL_ID.test(text(logicalId)) && leaseId.slice(0, 37) === logicalId;
}

/** The existing PC proof signs this digest as its transaction ID. */
export function createTurnOperationRequestId({ purpose, accountId, instanceId, deviceId, deviceKind, connectionId, expiresAt, reason, grantId = '', protocolVersion = 2 } = {}) {
  return 'turnop_' + createHash('sha256').update(JSON.stringify([
    grantId ? `ragent-turn-operation-shared-v${protocolVersion}` : protocolVersion === 3 ? 'agentoc-turn-operation-v3' : 'agentoc-turn-operation-v2', text(purpose), text(accountId), text(instanceId), text(deviceId),
    text(deviceKind), text(connectionId), text(expiresAt), text(reason).slice(0, 128),
    ...(grantId ? [text(grantId)] : []),
  ])).digest('hex');
}
