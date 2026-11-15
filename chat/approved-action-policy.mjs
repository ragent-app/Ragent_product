// Policy helpers for the approved action channel. These functions deliberately
// do not inspect credentials or execute commands; they only describe whether
// the current session/runtime can use a managed action request.
import { WORKBENCH_EXECUTION_POLICY } from '../lib/workbench-execution-policy.mjs';

export const APPROVED_ACTION_EXECUTION_CLASS = Object.freeze({
  SESSION: 'session',
  HOST: 'host',
  PRODUCT: 'product',
});

export const APPROVED_ACTION_HOST_CAPABILITY_TTL_MS = 15 * 60 * 1000;
export const APPROVED_ACTION_PRODUCT_CAPABILITY_TTL_MS = 2 * 60 * 1000;

export function approvedActionCapabilityTtlMs(executionClass) {
  return trimString(executionClass) === APPROVED_ACTION_EXECUTION_CLASS.PRODUCT
    ? APPROVED_ACTION_PRODUCT_CAPABILITY_TTL_MS
    : APPROVED_ACTION_HOST_CAPABILITY_TTL_MS;
}

export const APPROVED_ACTION_CAPABILITY_REASON = Object.freeze({
  RUNTIME_UNSUPPORTED: 'runtime_unsupported',
  EXECUTOR_UNHEALTHY: 'executor_unhealthy',
  PASSKEY_MISSING: 'passkey_missing',
  POLICY_DISABLED: 'policy_disabled',
});

// Owner policy switch for the approval surface. When disabled (default), a
// dangerous (host-class) approval is authorized by the explicit owner click
// alone on web and Android; the passkey/WebAuthn assertion layer is skipped
// end to end and the stored authorization records no credential. The warning
// UI stays. Set RAGENT_OWNER_HOST_PASSKEY_REQUIRED=1 to restore the passkey
// checkpoint without a code change. This switch only lowers the SECOND factor
// at approval time: the action manifest, selection hash, one-shot capability,
// executor revalidation, and audit chain all still apply.
export const OWNER_HOST_PASSKEY_ENV = 'RAGENT_OWNER_HOST_PASSKEY_REQUIRED';

export function isOwnerHostPasskeyRequired(env = process.env) {
  return /^(1|true|yes|on)$/i.test(trimString(env?.[OWNER_HOST_PASSKEY_ENV]));
}

const RISK_MODES = new Set(['safe', 'recommended', 'conservative-auto']);
const MANAGED_MCP_RUNTIME_FAMILIES = new Set([
  'codex-app-server-json',
  'claude-stream-json-bidi',
]);

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function isPrivilegeRoutingEnabled(session = {}, platform = process.platform) {
  if (WORKBENCH_EXECUTION_POLICY) return false;
  const riskMode = trimString(session?.riskMode).toLowerCase();
  return session?.privilegedMode === true || RISK_MODES.has(riskMode) || (platform === 'win32' && riskMode === 'full-auto');
}

export function supportsManagedApprovedActions(runtime = {}) {
  const family = trimString(runtime?.runtimeFamily || runtime?.providerCapabilities?.runtimeFamily);
  if (!MANAGED_MCP_RUNTIME_FAMILIES.has(family)) return false;
  return runtime?.providerCapabilities?.supportsManagedActionMcp === true
    || runtime?.supportsManagedActionMcp === true;
}

export function getApprovedActionCapability({
  session = {},
  runtime = {},
  policyEnabled = true,
  executorHealthy = true,
  passkeyAvailable = true,
  requiresHost = false,
} = {}) {
  if (!policyEnabled || !isPrivilegeRoutingEnabled(session)) {
    return { state: 'unavailable', reason: APPROVED_ACTION_CAPABILITY_REASON.POLICY_DISABLED };
  }
  if (!supportsManagedApprovedActions(runtime)) {
    return { state: 'unavailable', reason: APPROVED_ACTION_CAPABILITY_REASON.RUNTIME_UNSUPPORTED };
  }
  if (!executorHealthy) {
    return { state: 'unavailable', reason: APPROVED_ACTION_CAPABILITY_REASON.EXECUTOR_UNHEALTHY };
  }
  if (requiresHost && isOwnerHostPasskeyRequired() && !passkeyAvailable) {
    return { state: 'unavailable', reason: APPROVED_ACTION_CAPABILITY_REASON.PASSKEY_MISSING };
  }
  return { state: 'available', reason: '' };
}

export function normalizeApprovedActionCapability(value = {}) {
  const state = trimString(value?.state).toLowerCase();
  const reason = trimString(value?.reason).toLowerCase();
  if (state === 'available') return { state: 'available', reason: '' };
  if (state === 'unavailable' && Object.values(APPROVED_ACTION_CAPABILITY_REASON).includes(reason)) {
    return { state, reason };
  }
  return { state: 'unavailable', reason: APPROVED_ACTION_CAPABILITY_REASON.POLICY_DISABLED };
}

export function isHostExecutionClass(value) {
  return trimString(value) === APPROVED_ACTION_EXECUTION_CLASS.HOST;
}

export function isSessionExecutionClass(value) {
  return trimString(value) === APPROVED_ACTION_EXECUTION_CLASS.SESSION;
}

export function isProductExecutionClass(value) {
  return trimString(value) === APPROVED_ACTION_EXECUTION_CLASS.PRODUCT;
}
