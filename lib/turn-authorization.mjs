// TURN authorization is an account/device policy boundary, not a transport
// choice. The instance may provide the active-device lookup from a local
// lease store today and replace it with an Accounts-backed provider later.
import { createHash } from 'crypto';

export const TURN_AUTHORIZATION_POLICY_VERSION = 'turn-account-quota-v1';
// These are concurrent connection endpoint limits. They are not limits on
// how many devices an account may register or sign in on.
export const TURN_PLAN_DEVICE_LIMITS = Object.freeze({
  free: Object.freeze({ phones: 1, computers: 1 }),
  plus: Object.freeze({ phones: 2, computers: 3 }),
  pro: Object.freeze({ phones: 5, computers: 10 }),
  test: Object.freeze({ phones: 2147483647, computers: 2147483647 }),
});
// Kept for v1 callers that only understand one aggregate connection limit.
export const TURN_PLAN_CONNECTION_LIMITS = Object.freeze({
  free: 1,
  plus: 3,
  pro: 10,
  test: 2147483647,
});
export const TURN_AUTHORIZATION_STATUSES = Object.freeze([
  'authorized',
  'account-required',
  'account-mismatch',
  'quota-exceeded',
  'broker-unavailable',
  'broker-rejected',
  'disabled',
]);

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeTurnPlan(value, fallback = 'free') {
  const normalized = trimString(value).toLowerCase();
  if (Object.prototype.hasOwnProperty.call(TURN_PLAN_CONNECTION_LIMITS, normalized)) return normalized;
  const normalizedFallback = trimString(fallback).toLowerCase();
  return Object.prototype.hasOwnProperty.call(TURN_PLAN_CONNECTION_LIMITS, normalizedFallback)
    ? normalizedFallback
    : 'free';
}

export function normalizeTurnDeviceKind(value, fallback = '') {
  const normalized = trimString(value).toLowerCase();
  if (normalized === 'phone' || normalized === 'computer') return normalized;
  const normalizedFallback = trimString(fallback).toLowerCase();
  return normalizedFallback === 'phone' || normalizedFallback === 'computer' ? normalizedFallback : '';
}

export function resolveTurnDeviceLimits({ plan = 'free', limits = TURN_PLAN_DEVICE_LIMITS } = {}) {
  const normalizedPlan = normalizeTurnPlan(plan);
  const configured = limits?.[normalizedPlan]
    || (limits && (Object.prototype.hasOwnProperty.call(limits, 'phones')
      || Object.prototype.hasOwnProperty.call(limits, 'computers')) ? limits : {})
    || {};
  const fallback = TURN_PLAN_DEVICE_LIMITS[normalizedPlan];
  const phones = Number.isInteger(Number(configured.phones)) && Number(configured.phones) > 0
    ? Number(configured.phones)
    : fallback.phones;
  const computers = Number.isInteger(Number(configured.computers)) && Number(configured.computers) > 0
    ? Number(configured.computers)
    : fallback.computers;
  return { plan: normalizedPlan, phones, computers, ...(configured.unlimited === true ? { unlimited: true } : {}) };
}

export function resolveTurnConnectionLimit({ plan = 'free', limits = TURN_PLAN_CONNECTION_LIMITS, deviceKind = '' } = {}) {
  const normalizedPlan = normalizeTurnPlan(plan);
  const normalizedDeviceKind = normalizeTurnDeviceKind(deviceKind);
  if (normalizedDeviceKind) {
    const deviceLimits = resolveTurnDeviceLimits({ plan: normalizedPlan, limits });
    return {
      plan: normalizedPlan,
      deviceKind: normalizedDeviceKind,
      maxDevices: deviceLimits[normalizedDeviceKind === 'phone' ? 'phones' : 'computers'],
      limits: deviceLimits,
    };
  }
  const configured = Number(limits?.[normalizedPlan]);
  const limit = Number.isInteger(configured) && configured > 0 ? configured : TURN_PLAN_CONNECTION_LIMITS[normalizedPlan];
  return { plan: normalizedPlan, maxDevices: limit };
}

export function createTurnConnectionId({ accountId, instanceId, deviceId } = {}) {
  const value = [trimString(accountId), trimString(instanceId), trimString(deviceId)].join('\n');
  if (!value.replace(/\n/g, '')) return '';
  return `turn_${createHash('sha256').update(value).digest('hex').slice(0, 32)}`;
}

function normalizedDeviceIds(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(trimString).filter(Boolean))];
}

function normalizedInstanceIds(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(trimString).filter(Boolean))];
}

export function evaluateTurnConnectionAuthorization({
  accountId,
  deviceId,
  quotaDeviceId = deviceId, // Server-resolved physical identity; never a client quota override.
  instanceId,
  accountPlan = 'free',
  deviceKind = '',
  limits = TURN_PLAN_DEVICE_LIMITS,
  activeDeviceIds = [],
  activeInstanceIds = [],
  activePhones,
  activeComputers,
  accountMatches = true,
  nowMs = Date.now(),
} = {}) {
  const normalizedAccountId = trimString(accountId);
  const normalizedDeviceId = trimString(deviceId);
  const normalizedQuotaDeviceId = trimString(quotaDeviceId) || normalizedDeviceId;
  const normalizedInstanceId = trimString(instanceId);
  const active = normalizedDeviceIds(activeDeviceIds);
  const activeInstances = normalizedInstanceIds(activeInstanceIds);
  const { plan, maxDevices, limits: resolvedLimits } = resolveTurnConnectionLimit({
    plan: accountPlan,
    limits,
    deviceKind,
  });
  const connectionId = createTurnConnectionId({
    accountId: normalizedAccountId,
    instanceId: normalizedInstanceId,
    deviceId: normalizedDeviceId,
  });
  const pairAware = Boolean(normalizeTurnDeviceKind(deviceKind))
    && (Array.isArray(activeInstanceIds)
      || Number.isInteger(activePhones)
      || Number.isInteger(activeComputers));
  const alreadyActiveDevice = active.includes(normalizedQuotaDeviceId);
  const alreadyActiveInstance = activeInstances.includes(normalizedInstanceId);
  const nextActivePhones = Number.isInteger(activePhones) && activePhones >= 0
    ? activePhones + (normalizeTurnDeviceKind(deviceKind) === 'phone' && !alreadyActiveDevice ? 1 : 0)
    : undefined;
  const nextActiveComputers = Number.isInteger(activeComputers) && activeComputers >= 0
    ? activeComputers + (!alreadyActiveInstance ? 1 : 0)
    : undefined;
  const base = {
    policyVersion: TURN_AUTHORIZATION_POLICY_VERSION,
    plan,
    maxDevices,
    activeDeviceCount: active.length,
    ...(normalizeTurnDeviceKind(deviceKind) ? {
      deviceKind: normalizeTurnDeviceKind(deviceKind),
      limits: { phones: resolvedLimits.phones, computers: resolvedLimits.computers, ...(resolvedLimits.unlimited ? { unlimited: true } : {}) },
    } : {}),
    ...(Number.isInteger(activePhones) && activePhones >= 0 ? { activePhones } : {}),
    ...(Number.isInteger(activeComputers) && activeComputers >= 0 ? { activeComputers } : {}),
    connectionId,
    evaluatedAt: new Date(nowMs).toISOString(),
  };
  if (!normalizedAccountId) return { ...base, authorized: false, status: 'account-required', reasonCode: 'turn_account_required' };
  if (!normalizedDeviceId || !normalizedInstanceId) {
    return { ...base, authorized: false, status: 'account-mismatch', reasonCode: 'turn_device_identity_required' };
  }
  if (!accountMatches) {
    return { ...base, authorized: false, status: 'account-mismatch', reasonCode: 'turn_account_mismatch' };
  }
  if (!connectionId) {
    return { ...base, authorized: false, status: 'account-mismatch', reasonCode: 'turn_connection_identity_invalid' };
  }
  const exceedsDeviceLimit = !alreadyActiveDevice && active.length >= maxDevices;
  const exceedsPhoneLimit = pairAware && Number.isInteger(nextActivePhones)
    && nextActivePhones > resolvedLimits.phones;
  const exceedsComputerLimit = pairAware && Number.isInteger(nextActiveComputers)
    && nextActiveComputers > resolvedLimits.computers;
  if (!resolvedLimits?.unlimited && (exceedsDeviceLimit || exceedsPhoneLimit || exceedsComputerLimit)) {
    return {
      ...base,
      authorized: false,
      status: 'quota-exceeded',
      reasonCode: 'turn_connection_quota_exceeded',
    };
  }
  return {
    ...base,
    authorized: true,
    status: 'authorized',
    reasonCode: 'turn_authorized',
    activeDeviceCount: alreadyActiveDevice ? active.length : active.length + 1,
    ...(Number.isInteger(activePhones) && activePhones >= 0
      ? { activePhones: nextActivePhones }
      : {}),
    ...(Number.isInteger(activeComputers) && activeComputers >= 0
      ? { activeComputers: nextActiveComputers }
      : {}),
  };
}

export function publicTurnAuthorization(decision = {}) {
  const maxDevices = Number.isInteger(decision.maxDevices) && decision.maxDevices > 0
    ? decision.maxDevices
    : TURN_PLAN_CONNECTION_LIMITS.free;
  const activeDeviceCount = Number.isInteger(decision.activeDeviceCount) && decision.activeDeviceCount >= 0
    ? decision.activeDeviceCount
    : 0;
  return {
    policyVersion: TURN_AUTHORIZATION_POLICY_VERSION,
    authorized: decision.authorized === true,
    status: TURN_AUTHORIZATION_STATUSES.includes(decision.status) ? decision.status : 'disabled',
    reasonCode: trimString(decision.reasonCode) || 'turn_not_authorized',
    plan: normalizeTurnPlan(decision.plan),
    maxDevices,
    activeDeviceCount,
    ...(normalizeTurnDeviceKind(decision.deviceKind) ? {
      deviceKind: normalizeTurnDeviceKind(decision.deviceKind),
      limits: (() => {
        const resolved = resolveTurnDeviceLimits({ plan: decision.plan, limits: decision.limits });
        return { phones: resolved.phones, computers: resolved.computers, ...(resolved.unlimited ? { unlimited: true } : {}) };
      })(),
    } : {}),
    ...(Number.isInteger(decision.activePhones) && decision.activePhones >= 0
      ? { activePhones: decision.activePhones } : {}),
    ...(Number.isInteger(decision.activeComputers) && decision.activeComputers >= 0
      ? { activeComputers: decision.activeComputers } : {}),
    ...(trimString(decision.connectionId) ? { connectionId: trimString(decision.connectionId) } : {}),
  };
}

// Provider seam for the future central Accounts entitlement/lease service.
// The local instance can implement the same contract with a file-backed lease
// store; an Accounts-backed implementation can replace both callbacks without
// changing bootstrap or Android protocol fields.
export function createTurnAuthorizationProvider({
  resolveAccountPlan = async () => 'free',
  listActiveDeviceIds = async () => [],
  accountMatches = async () => true,
} = {}) {
  return async function authorizeTurnConnection(input = {}) {
    const accountPlan = await resolveAccountPlan(input);
    const activeDeviceIds = await listActiveDeviceIds(input);
    const matches = await accountMatches(input);
    return evaluateTurnConnectionAuthorization({ ...input, accountPlan, activeDeviceIds, accountMatches: matches });
  };
}
