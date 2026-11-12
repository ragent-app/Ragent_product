/**
 * Signed, one-shot capability for semantic adapters.
 *
 * This module is pure. It does not load keys, consume a nonce, resolve a path,
 * or execute a command. The server signs only an owner-selected policy result;
 * the root executor verifies again, consumes the nonce, and re-resolves every
 * resource immediately before fixed-argv execution.
 */

import { randomBytes, sign as edSign, verify as edVerify } from 'node:crypto';
import { validateWindowsSelectedInstallerFacts } from './windows-winget-installer-facts.mjs';
import { createLinuxTargetBinding, hashLinuxTargetBinding } from './linux-target-binding.mjs';
import { canonicalLinuxTargetContext } from './linux-target-attestation.mjs';

import {
  SEMANTIC_CAPABILITY_VERSION,
  SEMANTIC_COMPILER_VERSION,
  SEMANTIC_OPERATION_VERSION,
  SEMANTIC_POLICY_VERSION,
  SEMANTIC_RESOLVER_VERSION,
  canonicalSemanticJson,
  computeSemanticManifestHash,
  sha256Hex,
  validateSemanticOperation,
} from './semantic-operation.mjs';
import {
  SEMANTIC_ADAPTER_MSI_INSTALL_V1,
  SEMANTIC_ADAPTER_WINGET_INSTALL_V1,
} from './semantic-windows-adapter.mjs';

export {
  SEMANTIC_ADAPTER_MSI_INSTALL_V1,
  SEMANTIC_ADAPTER_WINGET_INSTALL_V1,
} from './semantic-windows-adapter.mjs';

export const SEMANTIC_CAPABILITY_TTL_MAX_MS = 60_000;
export const SEMANTIC_CAPABILITY_AUTH_MODE_OWNER = 'owner-selection';
// Owner-click authorization (passkey policy off): the capability records the
// explicit owner approval without a WebAuthn credential. Validation requires
// the credentialId to be EMPTY in this mode so a capability never claims a
// passkey proof that does not exist.
export const SEMANTIC_CAPABILITY_AUTH_MODE_OWNER_CLICK = 'owner-click';
// Server policy can authorize a narrowly classified Windows package install
// without claiming that a human selected it. The signed adapter and exact
// operation bindings remain mandatory and are revalidated by the executor.
export const SEMANTIC_CAPABILITY_AUTH_MODE_POLICY_AUTO = 'policy-auto';
export const SEMANTIC_ADAPTER_APT_INSTALL_V1 = 'linux-apt-install/v1';
// Capability schema only. The Linux privileged executor must independently
// verify the root observation, policy and replay state before enabling it.
export const SEMANTIC_ADAPTER_LINUX_FILE_DELETE_V1 = 'linux-file-delete/v1';
export const SEMANTIC_ADAPTER_WINDOWS_SERVICE_CONTROL_V1 = 'windows-service-control/v1';

export const SEMANTIC_CAPABILITY_ERROR = Object.freeze({
  ADAPTER_DENIED: 'SEMANTIC_CAPABILITY_ADAPTER_DENIED',
  BINDING_REQUIRED: 'SEMANTIC_CAPABILITY_BINDING_REQUIRED',
  EXPIRED: 'SEMANTIC_CAPABILITY_EXPIRED',
  INVALID: 'SEMANTIC_CAPABILITY_INVALID',
  MANIFEST_MISMATCH: 'SEMANTIC_CAPABILITY_MANIFEST_MISMATCH',
  NONCE_REQUIRED: 'SEMANTIC_CAPABILITY_NONCE_REQUIRED',
  OWNER_SELECTION_REQUIRED: 'SEMANTIC_CAPABILITY_OWNER_SELECTION_REQUIRED',
  POLICY_DENIED: 'SEMANTIC_CAPABILITY_POLICY_DENIED',
  REVALIDATION_FAILED: 'SEMANTIC_CAPABILITY_REVALIDATION_FAILED',
  SIGNATURE_INVALID: 'SEMANTIC_CAPABILITY_SIGNATURE_INVALID',
  VERSION_MISMATCH: 'SEMANTIC_CAPABILITY_VERSION_MISMATCH',
});

const SIGNABLE_FIELDS = Object.freeze([
  'v', 'kid', 'capabilityId', 'nonce', 'adapter', 'operations',
  'operationSetHash', 'selectionManifestHash', 'sessionId', 'runId', 'turnId',
  'policyVersion', 'compilerVersion', 'resolverVersion', 'issuedAt', 'expiresAt',
  'authMode', 'credentialId', 'windowsExecutionSid',
]);

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isNonEmptyString(value) {
  return trimString(value) !== '';
}

function clone(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function nonEmpty(value, label) {
  const text = trimString(value);
  if (!text) fail(SEMANTIC_CAPABILITY_ERROR.BINDING_REQUIRED, `${label} is required`);
  return text;
}

function isSha256(value) {
  return /^[0-9a-f]{64}$/.test(trimString(value));
}

function isSafeAptPackageName(value) {
  // The first adapter deliberately accepts only conventional named packages.
  // Version pins, local artifacts, paths, options, globs, and repositories
  // need their own descriptors/adapters rather than an argv escape hatch.
  return /^[a-z0-9][a-z0-9.+:~-]*$/i.test(trimString(value));
}

// Keep the signed native observation inside the owner selection and eventual
// executor input. This checks structure and binding only; a trusted root
// public key must independently verify the signature before any execution.
function linuxDeleteObservation(operation) {
  const observation = operation?.target?.resourceSnapshot?.linuxTargetAttestation;
  if (observation === undefined) return null;
  try {
    const keys = ['version', 'purpose', 'keyId', 'context', 'binding', 'bindingHash', 'issuedAt', 'expiresAt', 'signature'];
    if (!observation || typeof observation !== 'object' || Array.isArray(observation) ||
        Object.keys(observation).length !== keys.length || keys.some((key) => !Object.hasOwn(observation, key)) ||
        ![1, 2].includes(observation.version) || observation.purpose !== `linux-target-inspect/v${observation.version}` ||
        typeof observation.keyId !== 'string' || !/^[a-f0-9]{64}$/.test(observation.keyId) ||
        typeof observation.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(observation.signature) ||
        operation?.primaryAction !== 'fs.delete' || operation?.executionClass !== 'host' ||
        operation?.target?.platform !== 'linux' || operation?.target?.kind !== 'filesystem_file') throw new Error('invalid observation');
    const context = observation.context;
    const normalizedContext = canonicalLinuxTargetContext(context);
    if ((observation.version === 2) !== Object.hasOwn(normalizedContext, 'invocationId')) throw new Error('context version mismatch');
    if (context.sessionId !== operation.requestBinding?.sessionId || context.runId !== operation.requestBinding?.runId ||
        context.turnId !== operation.requestBinding?.turnId || context.requestId !== operation.requestBinding?.requestKey) throw new Error('context mismatch');
    const { path, ...snapshot } = observation.binding || {};
    const binding = createLinuxTargetBinding(path, snapshot);
    if (path !== operation.target.root || hashLinuxTargetBinding(path, snapshot) !== observation.bindingHash ||
        canonicalSemanticJson(binding) !== canonicalSemanticJson(observation.binding)) throw new Error('identity mismatch');
    const issued = Date.parse(observation.issuedAt), expires = Date.parse(observation.expiresAt);
    if (!Number.isFinite(issued) || !Number.isFinite(expires) ||
        new Date(issued).toISOString() !== observation.issuedAt || new Date(expires).toISOString() !== observation.expiresAt ||
        expires <= issued || expires - issued > 5 * 60 * 1000) throw new Error('invalid observation lifetime');
    return clone(observation);
  } catch {
    fail(SEMANTIC_CAPABILITY_ERROR.REVALIDATION_FAILED, 'Linux target observation is malformed or mismatched');
  }
}

function canonicalBoundOperation(policyDecision) {
  const operation = policyDecision?.operation;
  const validation = validateSemanticOperation(operation);
  if (!validation.ok || operation?.analysis?.resolverVersion !== SEMANTIC_RESOLVER_VERSION) {
    fail(SEMANTIC_CAPABILITY_ERROR.REVALIDATION_FAILED, 'operation lacks a server-bound resolver result');
  }
  if (policyDecision?.decision !== 'ASK') {
    fail(SEMANTIC_CAPABILITY_ERROR.POLICY_DENIED, 'only an owner-approved ASK decision may receive a capability');
  }
  if (Array.isArray(policyDecision?.unknowns) && policyDecision.unknowns.length > 0) {
    fail(SEMANTIC_CAPABILITY_ERROR.POLICY_DENIED, 'unknown semantic facts cannot receive a capability');
  }
  const snapshotIdentity = trimString(operation?.target?.resourceSnapshot?.identity);
  const resolverVersion = trimString(operation?.target?.resourceSnapshot?.resolverVersion);
  if (!snapshotIdentity || resolverVersion !== SEMANTIC_RESOLVER_VERSION) {
    fail(SEMANTIC_CAPABILITY_ERROR.REVALIDATION_FAILED, 'operation lacks a complete resolver snapshot');
  }
  for (const field of ['sessionId', 'runId', 'turnId', 'requestKey']) {
    const value = trimString(operation?.requestBinding?.[field]);
    if (!value || value === 'unknown') {
      fail(SEMANTIC_CAPABILITY_ERROR.BINDING_REQUIRED, `operation request binding.${field} is not server-bound`);
    }
  }
  if (operation.target?.kind === 'package') {
    const snapshot = operation.target.resourceSnapshot;
    const targetManager = trimString(operation.target.manager);
    const targetSource = trimString(operation.target.source);
    const snapshotPackages = Array.isArray(snapshot.packages) ? snapshot.packages : [];
    const targetPackages = [...(operation.target.packages || [])].map(trimString).sort();
    const resolvedPackages = snapshotPackages.map((entry) => trimString(entry?.name)).sort();
    if (!targetManager || snapshot.manager !== targetManager
      || !targetSource || snapshot.source !== targetSource
      || targetPackages.length === 0
      || JSON.stringify(targetPackages) !== JSON.stringify(resolvedPackages)) {
      fail(SEMANTIC_CAPABILITY_ERROR.REVALIDATION_FAILED, 'package resolver snapshot does not match the requested target');
    }
    if (snapshot.selectedInstaller != null && (targetManager !== 'winget' || snapshotPackages.length !== 1 ||
        !validateWindowsSelectedInstallerFacts(snapshot.selectedInstaller, { packageId: snapshotPackages[0]?.name, packageVersion: snapshotPackages[0]?.availableVersion }))) {
      fail(SEMANTIC_CAPABILITY_ERROR.REVALIDATION_FAILED, 'selected installer does not match the resolved package');
    }
  }
  if (operation.target?.kind === 'package_artifact') {
    const snapshot = operation.target.resourceSnapshot;
    if (trimString(operation.target.platform) !== 'win32'
      || trimString(operation.target.manager) !== 'msiexec'
      || trimString(operation.target.source) !== 'local_artifact'
      || trimString(operation.target.root) !== trimString(snapshot.artifactPath)
      || trimString(operation.target.digest) !== trimString(snapshot.artifactDigest)
      || !trimString(snapshot.artifactIdentity)
      || !/^[0-9a-f]{64}$/i.test(trimString(snapshot.artifactDigest))) {
      fail(SEMANTIC_CAPABILITY_ERROR.REVALIDATION_FAILED, 'Windows package artifact snapshot does not match the requested target');
    }
  }
  if (operation.target?.kind === 'windows_service') {
    const target = operation.target;
    const snapshot = target.resourceSnapshot;
    if (target.platform !== 'win32' || target.manager !== 'windows-service' ||
        typeof target.serviceName !== 'string' || target.serviceName !== target.serviceName.trim() ||
        !target.serviceName || target.serviceName.length > 256 || /[\\/*?\x00-\x1f]/.test(target.serviceName) ||
        !['start-service', 'stop-service', 'restart-service'].includes(target.action) ||
        snapshot.serviceName !== target.serviceName || !/^[a-f0-9]{64}$/.test(snapshot.definitionHash || '') ||
        operation.scope?.serviceName !== target.serviceName || operation.scope?.action !== target.action ||
        operation.scope?.definitionHash !== snapshot.definitionHash) {
      fail(SEMANTIC_CAPABILITY_ERROR.REVALIDATION_FAILED, 'Windows service snapshot does not match the requested operation');
    }
  }
  const manifestHash = computeSemanticManifestHash(operation);
  if (manifestHash !== trimString(policyDecision?.operationManifestHash)) {
    fail(SEMANTIC_CAPABILITY_ERROR.MANIFEST_MISMATCH, 'policy operation manifest does not match its operation');
  }
  return {
    operationId: operation.operationId,
    requestBinding: {
      sessionId: trimString(operation.requestBinding?.sessionId),
      runId: trimString(operation.requestBinding?.runId),
      turnId: trimString(operation.requestBinding?.turnId),
      requestKey: trimString(operation.requestBinding?.requestKey),
    },
    platform: trimString(operation.target?.platform),
    primaryAction: operation.primaryAction,
    effects: [...operation.effects].sort(),
    executionClass: trimString(operation.executionClass),
    operationManifestHash: manifestHash,
    resourceSnapshotIdentity: snapshotIdentity,
    resourceDescriptorHash: sha256Hex(canonicalSemanticJson({
      target: operation.target,
      scope: operation.scope,
      impact: operation.impact,
    })),
    adapterInput: {
      manager: trimString(operation.target?.manager),
      packages: [...(operation.target?.packages || [])].map(trimString).sort(),
      source: trimString(operation.target?.source),
      ...(operation.target?.platform === 'win32' && operation.target?.manager === 'winget'
        ? { requestedInstallScope: trimString(operation.target?.requestedInstallScope) } : {}),
      requestedVersions: [...(operation.target?.packages || [])]
        .map(trimString)
        .sort()
        .map((name) => {
          const packageFact = (Array.isArray(operation.target?.resourceSnapshot?.packages)
            ? operation.target.resourceSnapshot.packages : [])
            .find((entry) => trimString(entry?.name) === name);
          return trimString(packageFact?.requestedVersion);
        }),
      resolvedVersions: [...(operation.target?.packages || [])]
        .map(trimString)
        .sort()
        .map((name) => {
          const packageFact = (Array.isArray(operation.target?.resourceSnapshot?.packages)
            ? operation.target.resourceSnapshot.packages : [])
            .find((entry) => trimString(entry?.name) === name);
          return trimString(packageFact?.availableVersion);
        }),
      repositories: (Array.isArray(operation.target?.resourceSnapshot?.repositories)
        ? operation.target.resourceSnapshot.repositories : [])
        .map((entry) => ({
          id: trimString(entry?.id),
          trust: trimString(entry?.trust),
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
      exact: operation.target?.exact === true,
      sourceTrust: trimString(operation.target?.resourceSnapshot?.sourceTrust),
      ...(operation.target?.resourceSnapshot?.selectedInstaller ? { selectedInstaller: clone(operation.target.resourceSnapshot.selectedInstaller) } : {}),
      ...(operation.target?.kind === 'package_artifact' ? {
        artifactPath: trimString(operation.target?.root),
        artifactIdentity: trimString(operation.target?.resourceSnapshot?.artifactIdentity),
        artifactDigest: trimString(operation.target?.resourceSnapshot?.artifactDigest),
      } : {}),
      ...(operation.target?.kind === 'windows_service' ? {
        serviceName: operation.target.serviceName,
        serviceAction: operation.target.action,
        definitionHash: operation.target.resourceSnapshot.definitionHash,
      } : {}),
      ...(operation.target?.resourceSnapshot?.linuxTargetAttestation !== undefined
        ? { linuxTargetAttestation: linuxDeleteObservation(operation), linuxDeleteOperation: clone(operation) } : {}),
    },
  };
}

function adapterAllows(adapter, operations) {
  if (adapter === SEMANTIC_ADAPTER_LINUX_FILE_DELETE_V1) {
    if (operations.length !== 1) return false;
    const entry = operations[0];
    const operation = entry?.adapterInput?.linuxDeleteOperation;
    if (entry?.primaryAction !== 'fs.delete' || entry.platform !== 'linux' || entry.executionClass !== 'host' ||
        JSON.stringify(entry.effects) !== JSON.stringify(['process.execute']) || !operation ||
        operation.scope?.computed !== true || !['project', 'project_generated', 'project_root', 'tmp'].includes(operation.scope?.kind) ||
        operation.scope?.selfProtection?.computed !== true ||
        operation.scope?.selfProtection?.matched !== false || operation.impact?.estimatedItems !== 1 ||
        operation.impact?.containsSensitiveMaterial !== false || operation.impact?.containsGitMetadata !== false ||
        !Array.isArray(operation.analysis?.unknowns) || operation.analysis.unknowns.length !== 0) return false;
    try {
      const rebuilt = canonicalBoundOperation({ decision: 'ASK', operation, unknowns: [], operationManifestHash: entry.operationManifestHash });
      return canonicalSemanticJson(rebuilt) === canonicalSemanticJson(entry);
    } catch { return false; }
  }
  if (adapter === SEMANTIC_ADAPTER_WINDOWS_SERVICE_CONTROL_V1) {
    return operations.length === 1 && operations.every(entry => {
      const input = entry?.adapterInput || {};
      return entry.primaryAction === 'service.control' && entry.platform === 'win32' && entry.executionClass === 'host' &&
        JSON.stringify(entry.effects) === JSON.stringify(['process.execute']) && input.manager === 'windows-service' &&
        typeof input.serviceName === 'string' && input.serviceName === input.serviceName.trim() && input.serviceName.length > 0 &&
        input.serviceName.length <= 256 && !/[\\/*?\x00-\x1f]/.test(input.serviceName) &&
        ['start-service', 'stop-service', 'restart-service'].includes(input.serviceAction) && /^[a-f0-9]{64}$/.test(input.definitionHash || '');
    });
  }
  if (adapter === SEMANTIC_ADAPTER_APT_INSTALL_V1) {
    return operations.length > 0 && operations.every((entry) => (
      entry.primaryAction === 'package.install'
        && entry.platform === 'linux'
        && entry.executionClass === 'host'
        && JSON.stringify(entry.effects) === JSON.stringify(['process.execute'])
        && ['apt', 'apt-get'].includes(trimString(entry?.adapterInput?.manager))
        && entry?.adapterInput?.source === 'trusted_repository'
        && Array.isArray(entry?.adapterInput?.packages)
        && entry.adapterInput.packages.length === 1
        && entry.adapterInput.packages.every(isSafeAptPackageName)
        && Array.isArray(entry?.adapterInput?.requestedVersions)
        && entry.adapterInput.requestedVersions.length === entry.adapterInput.packages.length
        && entry.adapterInput.requestedVersions.every((version) => typeof version === 'string')
        && Array.isArray(entry?.adapterInput?.resolvedVersions)
        && entry.adapterInput.resolvedVersions.length === entry.adapterInput.packages.length
        && entry.adapterInput.resolvedVersions.every((version) => isNonEmptyString(version))
        && Array.isArray(entry?.adapterInput?.repositories)
        && entry.adapterInput.repositories.length > 0
        && entry.adapterInput.repositories.every((repository) => (
          isNonEmptyString(repository?.id) && repository?.trust === 'configured'
        ))
    ));
  }
  if (adapter === SEMANTIC_ADAPTER_WINGET_INSTALL_V1) {
    return operations.length === 1 && operations.every((entry) => {
      const input = entry?.adapterInput || {};
      return entry.primaryAction === 'package.install'
        && entry.platform === 'win32'
        && entry.executionClass === 'host'
        && JSON.stringify(entry.effects) === JSON.stringify(['process.execute'])
        && input.manager === 'winget'
        && input.source === 'winget'
        && input.exact === true
        && input.sourceTrust === 'configured'
        && Array.isArray(input.packages) && input.packages.length === 1
        && input.packages.every((name) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(trimString(name)))
        && ['', 'machine', 'user'].includes(input.requestedInstallScope)
        && Array.isArray(input.requestedVersions) && input.requestedVersions.length === 1
        && input.requestedVersions.every((version) => typeof version === 'string')
        && Array.isArray(input.resolvedVersions) && input.resolvedVersions.length === 1
        && input.resolvedVersions.every((version) => isNonEmptyString(version))
        && (input.selectedInstaller == null || Boolean(validateWindowsSelectedInstallerFacts(input.selectedInstaller, {
          packageId: input.packages[0], packageVersion: input.resolvedVersions[0],
        })));
    });
  }
  if (adapter === SEMANTIC_ADAPTER_MSI_INSTALL_V1) {
    return operations.length === 1 && operations.every((entry) => {
      const input = entry?.adapterInput || {};
      return entry.primaryAction === 'package.install'
        && entry.platform === 'win32'
        && entry.executionClass === 'host'
        && JSON.stringify(entry.effects) === JSON.stringify(['process.execute'])
        && input.manager === 'msiexec'
        && input.source === 'local_artifact'
        && /^[A-Za-z]:\\[^:*?"<>|]+$/.test(trimString(input.artifactPath))
        && /^[0-9a-f]{64}$/i.test(trimString(input.artifactDigest))
        && isNonEmptyString(input.artifactIdentity);
    });
  }
  return false;
}

function canonicalOperations(decisions) {
  const operations = (Array.isArray(decisions) ? decisions : []).map(canonicalBoundOperation)
    .sort((left, right) => left.operationId.localeCompare(right.operationId));
  if (operations.length === 0) {
    fail(SEMANTIC_CAPABILITY_ERROR.OWNER_SELECTION_REQUIRED, 'at least one selected policy decision is required');
  }
  const unique = new Set(operations.map((entry) => entry.operationId));
  if (unique.size !== operations.length) {
    fail(SEMANTIC_CAPABILITY_ERROR.OWNER_SELECTION_REQUIRED, 'selected operation ids must be unique');
  }
  return operations;
}

function operationBindingsMatch(operations, binding = {}) {
  return operations.every((operation) => ['sessionId', 'runId', 'turnId'].every((field) => (
    trimString(operation?.requestBinding?.[field]) === trimString(binding[field])
  )));
}

/**
 * Build the deterministic subset representation used both in the owner
 * WebAuthn challenge and in the signed capability. It contains no nonce or
 * credential and is therefore safe to construct before the owner responds.
 */
export function buildSemanticCapabilitySelection(selectedDecisions = []) {
  const operations = canonicalOperations(selectedDecisions);
  return {
    operations,
    operationSetHash: computeSemanticOperationSetHash(operations),
    selectionManifestHash: computeSemanticSelectionManifestHash(operations),
  };
}

export function computeSemanticOperationSetHash(operations = []) {
  return sha256Hex(canonicalJson((Array.isArray(operations) ? operations : [])
    .map((entry) => ({
      operationId: trimString(entry?.operationId),
      platform: trimString(entry?.platform),
      executionClass: trimString(entry?.executionClass),
      operationManifestHash: trimString(entry?.operationManifestHash),
      resourceSnapshotIdentity: trimString(entry?.resourceSnapshotIdentity),
      requestBinding: clone(entry?.requestBinding || {}),
      adapterInput: clone(entry?.adapterInput || {}),
    }))
    .sort((left, right) => left.operationId.localeCompare(right.operationId))));
}

export function computeSemanticSelectionManifestHash(operations = []) {
  return sha256Hex(canonicalJson((Array.isArray(operations) ? operations : [])
    .map((entry) => ({
      operationId: trimString(entry?.operationId),
      platform: trimString(entry?.platform),
      executionClass: trimString(entry?.executionClass),
      primaryAction: trimString(entry?.primaryAction),
      effects: [...(entry?.effects || [])].map(trimString).sort(),
      operationManifestHash: trimString(entry?.operationManifestHash),
      resourceDescriptorHash: trimString(entry?.resourceDescriptorHash),
      requestBinding: clone(entry?.requestBinding || {}),
      adapterInput: clone(entry?.adapterInput || {}),
    }))
    .sort((left, right) => left.operationId.localeCompare(right.operationId))));
}

export function canonicalSemanticCapability(capability = {}) {
  const canonical = {};
  for (const field of SIGNABLE_FIELDS) {
    if (capability[field] !== undefined) canonical[field] = capability[field];
  }
  return canonicalJson(canonical);
}

/**
 * Authorization-mode invariant. 'owner-selection' (passkey path) must carry the
 * WebAuthn credentialId that proves the owner selection; 'owner-click' must
 * carry none. A capability may never claim a credential it does not have.
 */
function isValidSemanticCapabilityAuthMode(capability) {
  const authMode = trimString(capability?.authMode);
  const credentialId = trimString(capability?.credentialId);
  if (authMode === SEMANTIC_CAPABILITY_AUTH_MODE_OWNER) return Boolean(credentialId);
  if (authMode === SEMANTIC_CAPABILITY_AUTH_MODE_OWNER_CLICK) return !credentialId;
  if (authMode === SEMANTIC_CAPABILITY_AUTH_MODE_POLICY_AUTO) {
    return !credentialId && [SEMANTIC_ADAPTER_WINGET_INSTALL_V1, SEMANTIC_ADAPTER_MSI_INSTALL_V1].includes(capability?.adapter);
  }
  return false;
}

export function validateSemanticCapability(capability, { now = Date.now() } = {}) {
  if (!capability || typeof capability !== 'object' || Array.isArray(capability)) {
    return { ok: false, code: SEMANTIC_CAPABILITY_ERROR.INVALID, error: 'capability must be an object' };
  }
  if (capability.v !== SEMANTIC_CAPABILITY_VERSION
    || capability.policyVersion !== SEMANTIC_POLICY_VERSION
    || capability.compilerVersion !== SEMANTIC_COMPILER_VERSION
    || capability.resolverVersion !== SEMANTIC_RESOLVER_VERSION) {
    return { ok: false, code: SEMANTIC_CAPABILITY_ERROR.VERSION_MISMATCH, error: 'capability versions do not match' };
  }
  for (const field of ['kid', 'capabilityId', 'nonce', 'adapter', 'sessionId', 'runId', 'turnId', 'operationSetHash', 'selectionManifestHash']) {
    if (!trimString(capability[field])) {
      return { ok: false, code: field === 'nonce' ? SEMANTIC_CAPABILITY_ERROR.NONCE_REQUIRED : SEMANTIC_CAPABILITY_ERROR.BINDING_REQUIRED, error: `${field} is required` };
    }
  }
  if (!isValidSemanticCapabilityAuthMode(capability)) {
    return { ok: false, code: SEMANTIC_CAPABILITY_ERROR.OWNER_SELECTION_REQUIRED, error: 'owner selection proof is required' };
  }
  const expiresAt = Date.parse(trimString(capability.expiresAt));
  const issuedAt = Date.parse(trimString(capability.issuedAt));
  if (!Number.isFinite(expiresAt) || !Number.isFinite(issuedAt) || expiresAt <= issuedAt || expiresAt - issuedAt > SEMANTIC_CAPABILITY_TTL_MAX_MS) {
    return { ok: false, code: SEMANTIC_CAPABILITY_ERROR.INVALID, error: 'capability TTL is invalid' };
  }
  if (now >= expiresAt) {
    return { ok: false, code: SEMANTIC_CAPABILITY_ERROR.EXPIRED, error: 'capability has expired' };
  }
  if (!isSha256(capability.operationSetHash) || !isSha256(capability.selectionManifestHash)) {
    return { ok: false, code: SEMANTIC_CAPABILITY_ERROR.INVALID, error: 'capability hash is invalid' };
  }
  const operations = Array.isArray(capability.operations) ? capability.operations : [];
  if (operations.length === 0 || !adapterAllows(trimString(capability.adapter), operations)) {
    return { ok: false, code: SEMANTIC_CAPABILITY_ERROR.ADAPTER_DENIED, error: 'capability adapter or operation set is unsupported' };
  }
  if (capability.authMode === SEMANTIC_CAPABILITY_AUTH_MODE_POLICY_AUTO
      && capability.adapter === SEMANTIC_ADAPTER_WINGET_INSTALL_V1
      && ['', 'user'].includes(operations[0]?.adapterInput?.requestedInstallScope)
      && !/^S-1-\d+(?:-\d+)+$/i.test(capability.windowsExecutionSid || '')) {
    return { ok: false, code: SEMANTIC_CAPABILITY_ERROR.BINDING_REQUIRED, error: 'Windows execution SID is required' };
  }
  if (!operationBindingsMatch(operations, capability)) {
    return { ok: false, code: SEMANTIC_CAPABILITY_ERROR.BINDING_REQUIRED, error: 'operation bindings do not match capability binding' };
  }
  if (computeSemanticOperationSetHash(operations) !== capability.operationSetHash
    || computeSemanticSelectionManifestHash(operations) !== capability.selectionManifestHash) {
    return { ok: false, code: SEMANTIC_CAPABILITY_ERROR.MANIFEST_MISMATCH, error: 'capability operation set does not match its hashes' };
  }
  return { ok: true, code: '' };
}

/** Build an unsigned capability after the server has verified the owner proof. */
export function createSemanticCapability({
  selectedDecisions = [],
  adapter = '',
  sessionId = '',
  runId = '',
  turnId = '',
  credentialId = '',
  authMode = SEMANTIC_CAPABILITY_AUTH_MODE_OWNER,
  kid = '',
  capabilityId = '',
  nonce = '',
  now = Date.now(),
  ttlMs = SEMANTIC_CAPABILITY_TTL_MAX_MS,
} = {}) {
  const selection = buildSemanticCapabilitySelection(selectedDecisions);
  const { operations } = selection;
  const normalizedAdapter = nonEmpty(adapter, 'adapter');
  if (!adapterAllows(normalizedAdapter, operations)) {
    fail(SEMANTIC_CAPABILITY_ERROR.ADAPTER_DENIED, 'adapter does not support the selected operation set');
  }
  if (!operationBindingsMatch(operations, { sessionId, runId, turnId })) {
    fail(SEMANTIC_CAPABILITY_ERROR.BINDING_REQUIRED, 'operation bindings do not match capability binding');
  }
  const boundedTtl = Number(ttlMs);
  if (!Number.isFinite(boundedTtl) || boundedTtl < 1 || boundedTtl > SEMANTIC_CAPABILITY_TTL_MAX_MS) {
    fail(SEMANTIC_CAPABILITY_ERROR.INVALID, 'capability TTL must be within the allowed maximum');
  }
  const issuedAt = new Date(now).toISOString();
  return {
    v: SEMANTIC_CAPABILITY_VERSION,
    kid: nonEmpty(kid, 'kid'),
    capabilityId: trimString(capabilityId) || `scap_${randomBytes(12).toString('hex')}`,
    nonce: trimString(nonce) || randomBytes(24).toString('base64url'),
    adapter: normalizedAdapter,
    operations,
    operationSetHash: selection.operationSetHash,
    selectionManifestHash: selection.selectionManifestHash,
    sessionId: nonEmpty(sessionId, 'sessionId'),
    runId: nonEmpty(runId, 'runId'),
    turnId: nonEmpty(turnId, 'turnId'),
    policyVersion: SEMANTIC_POLICY_VERSION,
    compilerVersion: SEMANTIC_COMPILER_VERSION,
    resolverVersion: SEMANTIC_RESOLVER_VERSION,
    issuedAt,
    expiresAt: new Date(Number(now) + boundedTtl).toISOString(),
    authMode,
    credentialId: [SEMANTIC_CAPABILITY_AUTH_MODE_OWNER_CLICK, SEMANTIC_CAPABILITY_AUTH_MODE_POLICY_AUTO].includes(authMode)
      ? ''
      : nonEmpty(credentialId, 'credentialId'),
  };
}

export function signSemanticCapability(capability, privateKey) {
  const validation = validateSemanticCapability(capability, { now: Date.parse(capability?.issuedAt) });
  if (!validation.ok) fail(validation.code, validation.error);
  if (!privateKey) fail(SEMANTIC_CAPABILITY_ERROR.SIGNATURE_INVALID, 'private key is required');
  return {
    ...clone(capability),
    sig: edSign(null, Buffer.from(canonicalSemanticCapability(capability), 'utf8'), privateKey).toString('base64url'),
  };
}

export function verifySemanticCapability(capability, { publicKey, now = Date.now() } = {}) {
  const validation = validateSemanticCapability(capability, { now });
  if (!validation.ok) return validation;
  if (!publicKey || !trimString(capability?.sig)) {
    return { ok: false, code: SEMANTIC_CAPABILITY_ERROR.SIGNATURE_INVALID, error: 'capability signature is required' };
  }
  try {
    const verified = edVerify(
      null,
      Buffer.from(canonicalSemanticCapability(capability), 'utf8'),
      publicKey,
      Buffer.from(capability.sig, 'base64url'),
    );
    return verified
      ? { ok: true, code: '' }
      : { ok: false, code: SEMANTIC_CAPABILITY_ERROR.SIGNATURE_INVALID, error: 'capability signature is invalid' };
  } catch {
    return { ok: false, code: SEMANTIC_CAPABILITY_ERROR.SIGNATURE_INVALID, error: 'capability signature is invalid' };
  }
}

/**
 * Compare freshly server-resolved, bound policy decisions with the signed set.
 * This is the pure half of execute-time revalidation; the executor supplies the
 * freshly resolved decisions and refuses before it builds an argv.
 */
export function revalidateSemanticCapability(capability, currentDecisions = []) {
  const current = canonicalOperations(currentDecisions);
  if (computeSemanticOperationSetHash(current) !== trimString(capability?.operationSetHash)
    || computeSemanticSelectionManifestHash(current) !== trimString(capability?.selectionManifestHash)) {
    return { ok: false, code: SEMANTIC_CAPABILITY_ERROR.REVALIDATION_FAILED, error: 'resource or operation snapshot changed' };
  }
  return { ok: true, code: '' };
}
