import { execFile as execFileCallback } from 'node:child_process';
import { WORKBENCH_EXECUTION_POLICY } from '../lib/workbench-execution-policy.mjs';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';

import { computeOpManifestHash, privilegedExecResultEvent } from './privileged-ops.mjs';
import {
  executePrivilegedOpAsEvent,
  executeSemanticCapability,
  getActivePrivilegedSigningKey,
} from './privileged-signing-keys.mjs';
import { isApprovedActionManifestIntact, redactApprovedActionText } from './approved-actions.mjs';
import {
  SEMANTIC_ADAPTER_APT_INSTALL_V1,
  SEMANTIC_CAPABILITY_AUTH_MODE_OWNER,
  SEMANTIC_CAPABILITY_AUTH_MODE_OWNER_CLICK,
  SEMANTIC_CAPABILITY_TTL_MAX_MS,
  createSemanticCapability,
} from './semantic-capability.mjs';
import { isOwnerHostPasskeyRequired } from './approved-action-policy.mjs';
import { PRIVILEGED_TOKEN_AUTH_MODE_OWNER_CLICK } from './privileged-token.mjs';
import {
  PERMISSION_MODES,
  PERMISSION_REASON_CODES,
  PERMISSION_REASON_MESSAGES,
  buildPermissionFacts,
  evaluatePermissionSet,
} from './permission-policy.mjs';
import { computeSemanticManifestHash } from './semantic-operation.mjs';
import { APPS_FILE } from '../lib/config.mjs';
import { resolveExecutableCommandPathAsync } from '../lib/executable-resolution.mjs';
import { getToolDefinitionAsync } from '../lib/tools.mjs';
import {
  buildManagedProcessSpawnSpec,
  spawnManagedProcess,
  terminateManagedProcessTree,
} from '../lib/windows-managed-spawn.mjs';
import { createApp } from './apps.mjs';
import { findSessionMeta } from './session-meta-store.mjs';
import { getRun, getRunManifest, isTerminalRunState } from './runs.mjs';
import { ensureWorkspaceForRoot, getWorkspaceById } from './workspaces.mjs';
import { executeMutation } from './mutation-coordinator.mjs';
import {
  AGENT_CREATE_TARGET_KIND,
  computeAgentCreatePayloadHash,
  hasAgentScopeSessionProvenance,
  isAgentCreateApprovedAction,
  isAgentCreateApprovedActionEnabled,
  isAgentCreateSessionEligible,
  validateAgentCreatePayloadRegistries,
} from './approved-agent-create.mjs';

const execFile = promisify(execFileCallback);
const MAX_OUTPUT_BYTES = 16 * 1024;
const COMMAND_TIMEOUT_MS = 2 * 60 * 1000;

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function boundedOutput(value) {
  const text = redactApprovedActionText(value);
  if (Buffer.byteLength(text, 'utf8') <= MAX_OUTPUT_BYTES) return text;
  return `${Buffer.from(text, 'utf8').subarray(0, MAX_OUTPUT_BYTES - 3).toString('utf8')}...`;
}

function resultRef({ exitCode = null, stdout = '', stderr = '', error = '', auditId = '', stdoutRef = '' } = {}) {
  return {
    exitCode: Number.isInteger(exitCode) ? exitCode : null,
    ...(stdout ? { stdout: boundedOutput(stdout) } : {}),
    ...(stderr ? { stderr: boundedOutput(stderr) } : {}),
    ...(auditId ? { auditId: trimString(auditId) } : {}),
    ...(stdoutRef ? { stdoutRef: boundedOutput(stdoutRef) } : {}),
    ...(error ? { error: boundedOutput(error) } : {}),
  };
}

function executorOp(action, selectionManifestHash = '') {
  const command = trimString(action?.canonicalCommand);
  const category = trimString(action?.category);
  const cwd = trimString(action?.cwd);
  return {
    opId: trimString(action?.actionId),
    command,
    category,
    cwd,
    manifestHash: computeOpManifestHash({ command, category, cwd }),
    ...(selectionManifestHash ? { batchManifestHash: selectionManifestHash } : {}),
  };
}

function isSemanticAptAction(action) {
  const projection = action?.semanticProjection;
  const decisions = Array.isArray(projection?.decisions) ? projection.decisions : [];
  return process.env.RAGENT_SEMANTIC_APT_ADAPTER_ENABLED === '1'
    && trimString(action?.executionClass) === 'host'
    && trimString(projection?.decision) === 'ASK'
    && decisions.length > 0
    && decisions.every((entry) => entry?.decision === 'ASK')
    && decisions.every((entry) => entry?.operation?.target?.platform === 'linux')
    && decisions.every((entry) => entry?.operation?.target?.kind === 'package')
    && decisions.every((entry) => entry?.operation?.target?.manager === 'apt'
      || entry?.operation?.target?.manager === 'apt-get');
}

function hostPolicyResult(decision, reasonCode, error) {
  return { ok: false, event: null, decision, reasonCode, resultRef: resultRef({ error }) };
}

async function claimGrantSetCompat(grantStore, claims) {
  // Compatibility seam for injected test stores created before the durable
  // claim-set API. Production uses claimGrantSet, which is all-or-nothing.
  for (const claim of claims) {
    const result = await grantStore.claimGrant(claim);
    if (!result?.ok) return result;
  }
  return { ok: true };
}

/**
 * Build the execution-time revalidation context from the approved (server-
 * computed) decision facts and the persisted projection. The resource snapshot
 * identity and canonical resource/selection come from the approved action
 * envelope — never from caller-declared scope facts.
 *
 * `entries` may be policy-gate decision entries (each carrying a built
 * `{ operation, facts }` envelope) or raw projection decisions (carrying only
 * `operation`); the snapshot identity falls back to the operation target's
 * `resourceSnapshot.identity`.
 */
export function approvedRevalidationContext({
  executionClass = '',
  entries = [],
  action = {},
  argv = [],
} = {}) {
  const first = Array.isArray(entries) ? entries[0] : undefined;
  const operation = first?.operation || action?.semanticProjection?.operation || null;
  const snapshot = operation?.target?.resourceSnapshot && typeof operation.target.resourceSnapshot === 'object'
    ? operation.target.resourceSnapshot
    : {};
  return {
    executionClass: trimString(executionClass),
    resourceSnapshotIdentity: trimString(first?.facts?.resourceSnapshotIdentity) || trimString(snapshot.identity),
    operation,
    resource: first?.facts?.resource || {},
    selection: first?.facts?.selection || {},
    actionId: trimString(action?.actionId),
    argv: Array.isArray(argv) ? argv.map((part) => String(part)) : [],
    cwd: trimString(action?.cwd),
    canonicalCommand: trimString(action?.canonicalCommand),
  };
}

/**
 * Phase 2B-4 execution-time revalidation seam (security invariant 8).
 *
 * A policy ALLOW is a preflight, not an executor grant. This seam runs
 * immediately before argv construction / privileged exec and re-resolves and
 * revalidates the target against the approved resource snapshot. It mirrors the
 * injectable `revalidate` parameter of `windows-executor-dispatch.mjs`:
 *
 *   revalidate(context, { execFile }) => Promise<{ ok, code?, error? }>
 *
 * The provider never replaces argv: the fixed argv/command already comes from
 * the approved manifest, so revalidation is a pure check (fail-closed on any
 * mismatch). When a provider is not supplied the context-aware default fails
 * closed for every target that must be revalidated — host privileged ops and
 * any target carrying an approved resource snapshot — and passes through only
 * for a plain session target with no approved snapshot, whose approved manifest
 * (command/cwd/executionClass) is the revalidation basis and was already
 * verified intact on entry.
 */
export async function runApprovedActionRevalidation(revalidate, context, deps) {
  if (typeof revalidate !== 'function') {
    const requiresRevalidation = trimString(context?.executionClass) === 'host'
      || Boolean(trimString(context?.resourceSnapshotIdentity));
    if (!requiresRevalidation) {
      // Plain session target with no approved resource snapshot: the approved
      // target IS the fixed argv carried by the approved manifest (verified
      // intact on entry where a manifest hash is present); there is no separate
      // snapshot to re-resolve at execution time.
      return { ok: true, code: '' };
    }
    return {
      ok: false,
      code: PERMISSION_REASON_CODES.NON_REVALIDATABLE_HOST_EFFECT,
      error: 'execution-time target revalidation is not configured; refusing to execute on an unverified target',
    };
  }
  try {
    const result = await revalidate(context, deps);
    if (result && result.ok === true) return { ok: true, code: result.code || '' };
    return {
      ok: false,
      code: result?.code || PERMISSION_REASON_CODES.NON_REVALIDATABLE_HOST_EFFECT,
      error: result?.error || 'execution-time target revalidation failed',
    };
  } catch (error) {
    return {
      ok: false,
      code: PERMISSION_REASON_CODES.NON_REVALIDATABLE_HOST_EFFECT,
      error: `execution-time target revalidation threw: ${error?.message || String(error)}`,
    };
  }
}

/**
 * Derive the permission-facts `resource`/`selection` envelopes from the
 * server-computed SemanticOperation target and its resolver snapshot. The
 * approved action never carries caller scope facts; every value here comes
 * from the persisted projection produced by the server resolver. Unknown or
 * unmodeled target kinds are left to `validatePermissionTargetIdentity` inside
 * `buildPermissionFacts`, which fails them closed.
 */
function deriveHostResourceSelection(target = {}, snapshot = {}) {
  const kind = trimString(target?.kind);
  const snapshotPackages = Array.isArray(snapshot?.packages) ? snapshot.packages : [];
  const targetPackages = Array.isArray(target?.packages) ? target.packages.map(trimString).filter(Boolean) : [];
  const targetPaths = Array.isArray(target?.paths) ? target.paths.map(trimString).filter(Boolean) : [];
  const snapshotPaths = Array.isArray(snapshot?.paths) ? snapshot.paths.map((entry) => trimString(entry?.canonical)).filter(Boolean) : [];
  const exact = target?.exact === true;
  const recursive = target?.recursive === true;
  const force = target?.force === true || target?.forced === true;

  if (kind === AGENT_CREATE_TARGET_KIND) {
    return {
      resource: {
        catalog: 'apps',
        payloadHash: trimString(target?.payloadHash),
        sessionId: trimString(snapshot?.sessionId),
        runId: trimString(snapshot?.runId),
        turnId: trimString(snapshot?.turnId),
      },
      selection: {
        payloadHash: trimString(target?.payloadHash),
        exact: true,
      },
    };
  }

  if (kind === 'package' || kind === 'package_source') {
    const resource = {};
    if (trimString(target?.manager)) resource.manager = trimString(target.manager);
    if (trimString(target?.source)) resource.source = trimString(target.source);
    if (targetPackages.length) resource.packages = [...targetPackages];
    else if (snapshotPackages.length) resource.packages = snapshotPackages.map((entry) => trimString(entry?.name)).filter(Boolean);
    if (Array.isArray(snapshot?.repositories) && snapshot.repositories.length) resource.repositories = snapshot.repositories;
    if (force) resource.force = true;
    if (Object.keys(resource).length === 0) resource.manager = trimString(snapshot?.manager) || 'unknown';
    return {
      resource,
      selection: {
        packages: targetPackages.length ? [...targetPackages] : snapshotPackages.map((entry) => trimString(entry?.name)).filter(Boolean),
        exact,
        ...(recursive ? { recursive: true } : {}),
      },
    };
  }
  if (kind === 'package_artifact') {
    return {
      resource: {
        manager: trimString(target?.manager) || trimString(snapshot?.manager) || 'unknown',
        source: trimString(target?.source) || 'local_artifact',
        artifact: trimString(target?.root) || trimString(snapshot?.artifactPath) || 'unknown',
        digest: trimString(target?.digest) || trimString(snapshot?.artifactDigest) || 'unknown',
        ...(force ? { force: true } : {}),
      },
      selection: {
        artifact: trimString(target?.root) || trimString(snapshot?.artifactPath) || 'unknown',
        exact,
        ...(recursive ? { recursive: true } : {}),
      },
    };
  }
  if (kind === 'windows_service') {
    return {
      resource: { kind, manager: trimString(target.manager), serviceName: trimString(target.serviceName), definitionHash: trimString(snapshot.definitionHash) },
      selection: { serviceName: trimString(target.serviceName), action: trimString(target.action), exact: true },
    };
  }
  const paths = targetPaths.length ? targetPaths : snapshotPaths;
  if (String(kind).startsWith('filesystem') || ['credential_dir', 'systemd_unit', 'systemd_manager', 'systemd_unit_file', 'git_remote', 'git_remote_config'].includes(kind)) {
    const resource = { paths: paths.length ? paths : ['unresolved'] };
    const selection = { paths: paths.length ? paths : ['unresolved'], exact };
    if (recursive) { resource.recursive = true; selection.recursive = true; }
    if (force) resource.force = true;
    return { resource, selection };
  }
  // Unknown / dynamic / unmodeled kinds fail closed in validatePermissionTargetIdentity.
  return {
    resource: { kind, paths: paths.length ? paths : ['unresolved'], ...(force ? { force: true } : {}) },
    selection: { kind, exact },
  };
}

/**
 * Build the server-computed PermissionFacts envelope for one approved-action
 * policy decision. This is exported so the approval server and tests can
 * reproduce byte-for-byte the same facts envelope the executor verifies.
 *
 * Facts are derived only from the persisted server projection
 * (`entry.operation` and the decision's server-computed manifest hash). Any
 * missing or unknown fact makes `buildPermissionFacts` throw, which the caller
 * treats as DENY (fail closed).
 */
export function buildHostPermissionFacts(entry) {
  const operation = entry?.operation;
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
    throw new Error('semantic operation is missing from the policy decision');
  }
  const target = operation.target && typeof operation.target === 'object' ? operation.target : {};
  const snapshot = target.resourceSnapshot && typeof target.resourceSnapshot === 'object' ? target.resourceSnapshot : {};
  const impact = operation.impact && typeof operation.impact === 'object' ? operation.impact : {};
  const { resource, selection } = deriveHostResourceSelection(target, snapshot);
  const effectEnumerationProof = trimString(entry?.effectEnumerationProof)
    || trimString(entry?.operationManifestHash)
    || computeSemanticManifestHash(operation);
  const facts = buildPermissionFacts({
    operation,
    executionClass: trimString(operation.executionClass) || 'host',
    impact: {
      reversible: impact.reversible === true,
      containsSensitiveMaterial: impact.containsSensitiveMaterial === true,
      containsGitMetadata: impact.containsGitMetadata === true,
    },
    resource,
    selection,
    resourceSnapshotIdentity: trimString(snapshot.identity),
    effectEnumerationProof,
    hostEffects: { dynamic: false, revalidatable: true },
    unknowns: Array.isArray(operation.analysis?.unknowns) ? [...operation.analysis.unknowns] : [],
  });
  const proof = entry?.factsProof;
  if (proof && typeof proof === 'object' && !Array.isArray(proof)) {
    facts.proof = {
      kid: trimString(proof.kid),
      sig: trimString(proof.sig),
      expiresAt: trimString(proof.expiresAt),
    };
  }
  return facts;
}

export async function revalidateApprovedAgentCreateAction(action, {
  sessionId = '',
  runId = '',
  turnId = '',
  getRunImpl = getRun,
  getRunManifestImpl = getRunManifest,
  getSessionImpl = findSessionMeta,
  getToolDefinitionImpl = getToolDefinitionAsync,
  env = process.env,
} = {}) {
  const deny = (code, error) => ({ ok: false, code, error });
  if (!isAgentCreateApprovedActionEnabled(env)) {
    return deny('AGENT_CREATE_FEATURE_DISABLED', 'managed Agent creation is disabled');
  }
  if (!isAgentCreateApprovedAction(action)) {
    return deny('AGENT_CREATE_OPERATION_INVALID', 'approved action is not agent.create');
  }
  let payloadHash;
  try {
    payloadHash = computeAgentCreatePayloadHash(action.agentPayload);
  } catch (error) {
    return deny(error?.code || 'AGENT_CREATE_PAYLOAD_INVALID', error?.message || String(error));
  }
  if (payloadHash !== trimString(action.agentPayloadHash)) {
    return deny('AGENT_CREATE_PAYLOAD_MISMATCH', 'Agent payload does not match the approved canonical hash');
  }
  const expectedSessionId = trimString(sessionId);
  const expectedRunId = trimString(runId);
  const expectedTurnId = trimString(turnId);
  if (!expectedSessionId || !expectedRunId || !expectedTurnId
    || trimString(action.sessionId) !== expectedSessionId
    || trimString(action.runId) !== expectedRunId
    || trimString(action.turnId) !== expectedTurnId) {
    return deny('AGENT_CREATE_BINDING_MISMATCH', 'Agent creation action binding does not match the executor request');
  }
  const [run, manifest, session] = await Promise.all([
    getRunImpl(expectedRunId),
    getRunManifestImpl(expectedRunId),
    getSessionImpl(expectedSessionId),
  ]);
  if (!run || !manifest || !session) {
    return deny('AGENT_CREATE_CONTEXT_UNRESOLVED', 'run, manifest, or session could not be re-resolved');
  }
  if (isTerminalRunState(run.state) || trimString(session.activeRunId) !== expectedRunId) {
    return deny('AGENT_CREATE_RUN_STALE', 'Agent creation run is no longer active');
  }
  const channel = manifest?.options?.approvedActionChannel;
  if (trimString(run.sessionId) !== expectedSessionId
    || trimString(manifest.sessionId) !== expectedSessionId
    || !trimString(channel?.turnId)
    || trimString(channel.turnId) !== expectedTurnId
    || channel?.productAgentCreate !== true
    || trimString(channel?.authenticatedPrincipalKind) !== 'owner') {
    return deny('AGENT_CREATE_MANIFEST_MISMATCH', 'run manifest does not authorize this Agent creation operation');
  }
  if (hasAgentScopeSessionProvenance(session)) {
    return deny('AGENT_CREATE_SESSION_PROVENANCE_DENIED', 'session carries agent/template-scoped provenance');
  }
  if (!isAgentCreateSessionEligible(session)) {
    return deny('AGENT_CREATE_OWNER_REQUIRED', 'only an owner-authenticated turn in an eligible owner root session may create an Agent');
  }
  const operation = action?.semanticProjection?.decisions?.[0]?.operation;
  if (!operation
    || trimString(operation.primaryAction) !== 'agent.create'
    || trimString(operation.requestBinding?.sessionId) !== expectedSessionId
    || trimString(operation.requestBinding?.runId) !== expectedRunId
    || trimString(operation.requestBinding?.turnId) !== expectedTurnId
    || trimString(operation.target?.payloadHash) !== payloadHash
    || trimString(operation.target?.resourceSnapshot?.identity)
      !== trimString(action?.semanticProjection?.decisions?.[0]?.resolverSnapshotIdentity)) {
    return deny('AGENT_CREATE_SEMANTIC_MISMATCH', 'Agent creation semantic operation cannot be revalidated');
  }
  let registry;
  try {
    registry = await validateAgentCreatePayloadRegistries(action.agentPayload, { getToolDefinitionImpl });
  } catch (error) {
    return deny(error?.code || 'AGENT_CREATE_TOOL_UNRESOLVED', error?.message || String(error));
  }
  // The approved operation must bind a server-resolved tool fingerprint, and
  // that fingerprint must still match the registry at execution time. A same-ID
  // tool whose runtimeFamily/command/provider changed after approval must fail
  // closed even though id/available still resolve.
  const storedFingerprint = trimString(operation?.target?.resourceSnapshot?.toolFingerprint);
  if (!storedFingerprint) {
    return deny('AGENT_CREATE_TOOL_FINGERPRINT_UNBOUND', 'Agent creation did not bind a tool registry fingerprint at approval');
  }
  if (trimString(registry?.toolFingerprint) !== storedFingerprint) {
    return deny('AGENT_CREATE_TOOL_FINGERPRINT_MISMATCH', 'Tool registry definition changed after approval');
  }
  return { ok: true, code: '' };
}

function buildHostPolicyEntries(decisions, factsProofs = {}) {
  const list = Array.isArray(decisions) ? decisions : [];
  if (list.length === 0) {
    return { ok: false, code: PERMISSION_REASON_CODES.FACTS_REQUIRED, error: 'Host action has no server-computed semantic policy decisions' };
  }
  const entries = [];
  for (const entry of list) {
    const operation = entry?.operation;
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
      return { ok: false, code: PERMISSION_REASON_CODES.OPERATION_INVALID, error: 'Host policy decision lacks a server-computed semantic operation' };
    }
    let facts;
    const operationId = trimString(operation.operationId);
    const suppliedProof = entry?.factsProof
      || (factsProofs && typeof factsProofs === 'object' ? factsProofs[operationId] : null);
    try {
      facts = buildHostPermissionFacts({ ...entry, ...(suppliedProof ? { factsProof: suppliedProof } : {}) });
    } catch (error) {
      // Preserve specific deterministic policy failures from fact construction
      // (notably unknown host effects); only unexpected construction failures
      // are normalized to the generic missing-facts denial.
      const code = error?.code === PERMISSION_REASON_CODES.UNKNOWN_HOST_EFFECT
        ? error.code
        : PERMISSION_REASON_CODES.FACTS_REQUIRED;
      return { ok: false, code, error: `Host permission facts could not be built: ${error?.message || String(error)}` };
    }
    entries.push({ operation, facts, operationId });
  }
  return { ok: true, entries };
}

/**
 * Phase 2B-3 policy gate. `evaluatePermissionSet` (backed by
 * `evaluatePermissionOperation`) is the single authority for the approved-action
 * host route. A host action proceeds only when the aggregate decision is ALLOW
 * AND every member matched an exact signed capability. Missing facts, missing
 * proofs, and default ALLOWs without a grant all fail closed to DENY/ASK.
 */
function evaluateHostPolicyGate({
  semantic,
  mode,
  capability,
  capabilities,
  verifyFactsProof,
  verifyGrantProof,
  useNonce,
  useNonces,
  usageConsumed,
  consumedUseNonces,
  usageStates,
  factsProofs,
  now,
}) {
  const decisions = Array.isArray(semantic?.decisions) ? semantic.decisions : [];
  const built = buildHostPolicyEntries(decisions, factsProofs);
  if (!built.ok) {
    return { decision: 'DENY', reasonCode: built.code, error: built.error };
  }
  let evaluated;
  try {
    const grantList = Array.isArray(capabilities)
      ? capabilities.filter((entry) => entry && typeof entry === 'object')
      : (capability && typeof capability === 'object' ? [capability] : []);
    const grantsByOperationId = new Map(grantList
      .filter((grant) => trimString(grant?.constraints?.operationId) || trimString(grant?.workload?.operationId))
      .map((grant) => [
        trimString(grant?.constraints?.operationId) || trimString(grant?.workload?.operationId),
        grant,
      ]));
    const fallbackGrant = grantList.length === 1 ? grantList[0] : capability;
    const policyEntries = built.entries.map((entry) => {
      const selectedCapability = grantsByOperationId.get(entry.operationId) || fallbackGrant || null;
      const grantId = trimString(selectedCapability?.grantId);
      const state = usageStates && grantId ? usageStates[grantId] : null;
      return {
        ...entry,
        capability: selectedCapability,
        useNonce: grantId && useNonces && typeof useNonces === 'object'
          ? (trimString(useNonces[grantId]) || useNonce)
          : useNonce,
        ...(state ? {
          usageConsumed: state.consumed,
          consumedUseNonces: state.useNonces,
        } : {}),
      };
    });
    evaluated = evaluatePermissionSet(policyEntries, {
      mode,
      verifyFactsProof,
      verifyGrantProof,
      useNonce,
      usageConsumed,
      consumedUseNonces,
      now,
    });
  } catch (error) {
    return {
      decision: 'DENY',
      reasonCode: PERMISSION_REASON_CODES.OPERATION_INVALID,
      error: `Permission policy evaluation failed: ${error?.message || String(error)}`,
    };
  }
  if (evaluated.decision === 'DENY') {
    const firstDeny = (evaluated.results || []).find((result) => result.decision === 'DENY');
    const reasonCode = firstDeny?.reasonCode || PERMISSION_REASON_CODES.DENY_DEFAULT;
    return { decision: 'DENY', reasonCode, error: `Host action denied by permission policy: ${PERMISSION_REASON_MESSAGES[reasonCode] || reasonCode}` };
  }
  if (evaluated.decision === 'ASK') {
    const reasonCode = evaluated.results?.[0]?.reasonCode || PERMISSION_REASON_CODES.ASK_DEFAULT;
    return { decision: 'ASK', reasonCode, error: 'Host action requires owner approval or an exact capability' };
  }
  // ALLOW — for a host action a default ALLOW is a checkpoint, not a grant. The
  // executor proceeds only when every member was authorized by an exact signed
  // capability (capabilityMatched === true).
  const allCapabilityMatched = Array.isArray(evaluated.results) && evaluated.results.length > 0
    && evaluated.results.every((result) => result.capabilityMatched === true);
  if (!allCapabilityMatched) {
    return {
      decision: 'ASK',
      reasonCode: PERMISSION_REASON_CODES.ASK_DEFAULT,
      error: 'Host action requires an exact owner-approved capability',
    };
  }
  // The ALLOW result carries the server-computed decision entries so the
  // executor can revalidate the approved target (invariant 8) immediately
  // before argv construction / privileged exec.
  return {
    decision: 'ALLOW',
    reasonCode: evaluated.results[0].reasonCode,
    error: '',
    entries: built.entries,
    results: evaluated.results,
  };
}

// Approved privileged host operations take the workspace-level mutation lock so
// they serialize with checkpoint captures and other mutations on the same
// Workspace. The soft TTL spans the full command timeout; the hard TTL bounds a
// crashed executor without blocking the Workspace forever.
const APPROVED_MUTATION_TTL_MS = COMMAND_TIMEOUT_MS + 5_000;
const APPROVED_MUTATION_HARD_TTL_MS = COMMAND_TIMEOUT_MS + 60_000;

function sessionCommandTimeout(timeoutMs) {
  return Number.isFinite(Number(timeoutMs))
    ? Math.max(1_000, Number(timeoutMs))
    : COMMAND_TIMEOUT_MS;
}

function collectChildOutput(stream, chunks, onLimit) {
  let bytes = 0;
  const maxBytes = MAX_OUTPUT_BYTES * 2;
  if (stream && typeof stream.on === 'function') {
    stream.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk || ''));
      const remaining = maxBytes - bytes;
      if (remaining <= 0) {
        onLimit?.();
        return;
      }
      if (buffer.length > remaining) {
        chunks.push(buffer.subarray(0, remaining));
        bytes = maxBytes;
        onLimit?.();
        return;
      }
      chunks.push(buffer);
      bytes += buffer.length;
    });
  }
}

/**
 * Execute the non-host portion of an approved action through the same
 * platform-managed lifecycle as provider processes. The approved argv remains
 * the source of truth; resolution only turns argv[0] into an absolute native
 * executable and maps Windows .cmd/.bat/.ps1 targets to their fixed runtime
 * wrappers. No shell is introduced.
 *
 * The dependency seams keep the Windows contract testable from Linux without
 * weakening the production path, which always uses the shared resolver and Job
 * Object-aware spawn implementation.
 */
export async function executeApprovedSessionCommand({
  action = {},
  argv = [],
  timeoutMs = COMMAND_TIMEOUT_MS,
  resolveExecutableImpl = resolveExecutableCommandPathAsync,
  buildSpawnSpecImpl = buildManagedProcessSpawnSpec,
  spawnManagedImpl = spawnManagedProcess,
  terminateProcessTreeImpl = terminateManagedProcessTree,
  assertAuthorization = () => {},
} = {}) {
  const executableName = trimString(argv[0]);
  if (!executableName) {
    return { ok: false, resultRef: resultRef({ error: 'Approved action has no executable argv' }) };
  }

  let executablePath;
  try {
    executablePath = await resolveExecutableImpl(executableName, { cwd: trimString(action?.cwd) });
  } catch (error) {
    return {
      ok: false,
      resultRef: resultRef({ error: error?.message || String(error) }),
    };
  }
  if (!trimString(executablePath)) {
    return {
      ok: false,
      resultRef: resultRef({ error: `Approved action executable was not found: ${executableName}` }),
    };
  }

  let spawnSpec;
  try {
    spawnSpec = buildSpawnSpecImpl({
      file: executablePath,
      args: argv.slice(1),
      cwd: trimString(action?.cwd),
      // execFile inherited the executor environment. Keep that behavior
      // explicit across the Windows Job host so CreateProcess receives the
      // same PATH and provider/runtime variables.
      env: process.env,
    });
  } catch (error) {
    return {
      ok: false,
      resultRef: resultRef({ error: error?.message || String(error) }),
    };
  }

  let child;
  try {
    assertAuthorization();
    child = await spawnManagedImpl(spawnSpec, {
      stdio: ['ignore', 'pipe', 'pipe'],
      assertAuthorization,
    });
  } catch (error) {
    return {
      ok: false,
      resultRef: resultRef({ error: error?.message || String(error) }),
    };
  }

  const stdoutChunks = [];
  const stderrChunks = [];
  let timedOut = false;
  let outputLimitExceeded = false;
  let terminationRequested = false;
  const terminateChild = () => {
    if (terminationRequested) return;
    terminationRequested = true;
    try {
      void Promise.resolve(terminateProcessTreeImpl(child, 'SIGTERM')).catch(() => {});
    } catch {}
  };
  const markOutputLimit = () => {
    outputLimitExceeded = true;
    terminateChild();
  };
  collectChildOutput(child?.stdout, stdoutChunks, markOutputLimit);
  collectChildOutput(child?.stderr, stderrChunks, markOutputLimit);
  const timeout = sessionCommandTimeout(timeoutMs);
  const outcome = await new Promise((resolve) => {
    let settled = false;
    let timer;
    let childError = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    child?.once?.('error', (error) => { childError = error; });
    child?.once?.('close', (code, signal) => finish({ code, signal, error: childError }));
    timer = setTimeout(() => {
      timedOut = true;
      terminateChild();
    }, timeout);
  });

  const stdout = Buffer.concat(stdoutChunks).toString('utf8');
  const stderr = Buffer.concat(stderrChunks).toString('utf8');
  if (timedOut) {
    return {
      ok: false,
      resultRef: resultRef({
        exitCode: Number.isInteger(outcome?.code) ? outcome.code : null,
        stdout,
        stderr,
        error: 'Approved action timed out',
      }),
    };
  }
  if (outputLimitExceeded) {
    return {
      ok: false,
      resultRef: resultRef({
        exitCode: Number.isInteger(outcome?.code) ? outcome.code : null,
        stdout,
        stderr,
        error: `Approved action output exceeded ${MAX_OUTPUT_BYTES * 2} bytes`,
      }),
    };
  }
  if (outcome?.error || Number(outcome?.code) !== 0) {
    const error = outcome?.error?.message
      || (outcome?.signal ? `Approved action terminated by ${outcome.signal}` : `Approved action exited with code ${outcome?.code}`);
    return {
      ok: false,
      resultRef: resultRef({
        exitCode: Number.isInteger(outcome?.code) ? outcome.code : null,
        stdout,
        stderr,
        error,
      }),
    };
  }
  return {
    ok: true,
    resultRef: resultRef({ exitCode: 0, stdout, stderr }),
  };
}

/**
 * Resolve the Workspace context a host action mutates: prefer the run's frozen
 * executionScope.workspaceId (precise), fall back to resolving the action cwd
 * as a workspace root. Returns null when neither is available — the op then
 * runs without a mutation lock (best effort).
 */
async function resolveWorkspaceContext(runId, cwd) {
  const manifest = trimString(runId)
    ? await getRunManifest(trimString(runId)).catch(() => null)
    : null;
  const snapshotWorkspaceId = trimString(manifest?.executionScope?.workspaceId);
  if (snapshotWorkspaceId) {
    const workspace = await getWorkspaceById(snapshotWorkspaceId).catch(() => null);
    if (workspace?.physicalKey) {
      return { workspaceId: workspace.id, physicalKey: workspace.physicalKey };
    }
  }
  try {
    if (trimString(cwd)) {
      const workspace = await ensureWorkspaceForRoot(trimString(cwd));
      if (workspace?.physicalKey) {
        return { workspaceId: workspace.id, physicalKey: workspace.physicalKey };
      }
    }
  } catch {
    // unresolved root -> no lock context; run unlocked
  }
  return null;
}

export async function executeApprovedAction(action, {
  sessionId = '',
  runId = '',
  turnId = '',
  authorization = null,
  timeoutMs = COMMAND_TIMEOUT_MS,
  mode = PERMISSION_MODES.STANDARD,
  verifyFactsProof = null,
  verifyGrantProof = null,
  capability = null,
  capabilities = null,
  useNonce = '',
  useNonces = null,
  usageConsumed = 0,
  consumedUseNonces = [],
  usageStates = null,
  factsProofs = null,
  grantStore = null,
  now = Date.now(),
  revalidate = null,
  createAppImpl = createApp,
  executeMutationImpl = executeMutation,
  getRunImpl = getRun,
  getRunManifestImpl = getRunManifest,
  getSessionImpl = findSessionMeta,
  getToolDefinitionImpl = getToolDefinitionAsync,
  env = process.env,
} = {}) {
  const executionClass = trimString(action?.executionClass);
  if (WORKBENCH_EXECUTION_POLICY) {
    return hostPolicyResult('DENY', 'WORKBENCH_EXECUTION_POLICY_DENIED', 'This workbench only permits its sandboxed Codex runtime');
  }
  const productExecution = executionClass === 'product' && isAgentCreateApprovedAction(action);
  const semantic = action?.semanticProjection;
  const temporaryDeadline = authorization?.temporaryControlExpiresAt;
  const assertTemporaryAuthorization = () => {
    if (temporaryDeadline !== undefined && Date.now() >= temporaryDeadline) {
      throw Object.assign(new Error('Temporary control approval expired'), { code: 'TEMPORARY_CONTROL_APPROVAL_DENIED' });
    }
  };
  const temporaryDeadlineValid = temporaryDeadline === undefined
    || (Number.isSafeInteger(temporaryDeadline) && temporaryDeadline > Date.now());
  if (!temporaryDeadlineValid) {
    return hostPolicyResult('DENY', 'TEMPORARY_CONTROL_APPROVAL_DENIED', 'Temporary control approval expired');
  }
  if ((executionClass === 'host' || semantic || action?.manifestHash)
    && !isApprovedActionManifestIntact(action)) {
    return {
      ok: false,
      event: null,
      resultRef: resultRef({ error: 'Approved action manifest or semantic projection is invalid' }),
    };
  }
  if (executionClass === 'host' || productExecution) {
    const grantList = Array.isArray(capabilities)
      ? capabilities.filter((entry) => entry && typeof entry === 'object')
      : (capability && typeof capability === 'object' ? [capability] : []);
    const effectiveFactsProofs = factsProofs && typeof factsProofs === 'object' ? factsProofs : {};
    const effectiveUsageStates = usageStates && typeof usageStates === 'object' ? usageStates : {};
    if (grantStore && grantList.length > 0) {
      for (const grant of grantList) {
        const grantId = trimString(grant?.grantId);
        if (!grantId) continue;
        const state = await grantStore.getGrantState({ grantId });
        if (!state?.ok) {
          return hostPolicyResult('DENY', state?.code || PERMISSION_REASON_CODES.CAPABILITY_INVALID, state?.error || 'capability usage state is unavailable');
        }
        effectiveUsageStates[grantId] = state.state;
      }
    }
    let effectiveVerifyFactsProof = verifyFactsProof;
    let effectiveVerifyGrantProof = verifyGrantProof;
    // Production callers may omit the verifier wiring because the signing-key
    // boundary is server-owned. Keep the low-level unit-test path injectable,
    // but resolve the trusted verifier whenever an actual grant is supplied.
    if (grantList.length > 0 && (!effectiveVerifyFactsProof || !effectiveVerifyGrantProof)) {
      const { createPermissionProofVerifier } = await import('./permission-proof-verifier.mjs');
      const { getPrivilegedPublicKeys } = await import('./privileged-signing-keys.mjs');
      const verifier = createPermissionProofVerifier({
        publicKeyByKid: getPrivilegedPublicKeys(),
        now,
      });
      effectiveVerifyFactsProof ||= verifier.verifyFactsProof;
      effectiveVerifyGrantProof ||= verifier.verifyGrantProof;
    }
    // A durable semantic projection is a server-side prerequisite. Once it
    // exists, a host effect the server did not project as ASK is never routed
    // to any executor; the policy gate below is the authorization authority.
    if (semantic && typeof semantic === 'object' && trimString(semantic.decision) !== 'ASK') {
      return hostPolicyResult(
        'DENY',
        PERMISSION_REASON_CODES.DENY_DEFAULT,
        'Semantic policy denied or could not resolve this host action',
      );
    }
    // The permission policy gate (Phase 2B-3) is authoritative for every host
    // action. It runs before any capability creation or privileged exec.
    const gate = evaluateHostPolicyGate({
      semantic,
      mode,
      capability,
      capabilities: grantList,
      verifyFactsProof: effectiveVerifyFactsProof,
      verifyGrantProof: effectiveVerifyGrantProof,
      useNonce: trimString(useNonce) || randomBytes(24).toString('base64url'),
      useNonces,
      usageConsumed,
      consumedUseNonces,
      usageStates: effectiveUsageStates,
      factsProofs: effectiveFactsProofs,
      now,
    });
    if (gate.decision === 'DENY') {
      return hostPolicyResult('DENY', gate.reasonCode, gate.error);
    }
    if (gate.decision === 'ASK') {
      if (productExecution && grantList.length > 0) {
        return hostPolicyResult(
          'DENY',
          gate.reasonCode,
          'Agent creation capability is invalid, expired, mismatched, or already consumed',
        );
      }
      return hostPolicyResult('ASK', gate.reasonCode, gate.error);
    }
    if (grantList.length > 0 && (!grantStore || typeof grantStore.claimGrantSet !== 'function')) {
      return hostPolicyResult(
        'DENY',
        PERMISSION_REASON_CODES.CAPABILITY_INVALID,
        'durable capability grant store is required for host capability execution',
      );
    }
    const claimCapabilitySet = async () => {
      if (temporaryDeadline !== undefined && Date.now() >= temporaryDeadline) {
        return { ok: false, code: 'TEMPORARY_CONTROL_APPROVAL_DENIED', error: 'Temporary control approval expired' };
      }
      const claims = [];
      const claimed = new Set();
      for (const grant of grantList) {
        const grantId = trimString(grant?.grantId);
        if (!grantId || claimed.has(grantId)) continue;
        claimed.add(grantId);
        claims.push({
          grantId,
          useNonce: useNonces && typeof useNonces === 'object'
            ? trimString(useNonces[grantId])
            : trimString(useNonce),
          usageMax: grant?.usageBudget?.max,
          expiresAt: grant?.expiresAt,
          now: Date.now(),
        });
      }
      const claim = typeof grantStore.claimGrantSet === 'function'
        ? await grantStore.claimGrantSet({ claims })
        : await claimGrantSetCompat(grantStore, claims);
      return claim?.ok === true
        ? { ok: true }
        : { ok: false, code: claim?.code || PERMISSION_REASON_CODES.CAPABILITY_INVALID, error: claim?.error || 'capability use could not be claimed' };
    };
    // gate.decision === 'ALLOW': an exact signed capability authorized this
    // action. Proceed only to a supported typed adapter.
    const gateEntries = Array.isArray(gate.entries) ? gate.entries : [];
    if (productExecution) {
      try {
        const mutation = await executeMutationImpl({
          workspaceId: 'ragent-product-state',
          runId,
          resourceKeys: [`file:${APPS_FILE}`],
          mutate: async () => {
            // Re-resolve every server-owned binding inside the mutation window,
            // immediately before the nonce claim and durable catalog write.
            const fresh = await revalidateApprovedAgentCreateAction(action, {
              sessionId,
              runId,
              turnId,
              getRunImpl,
              getRunManifestImpl,
              getSessionImpl,
              getToolDefinitionImpl,
              env,
            });
            if (!fresh.ok) {
              const error = new Error(fresh.error);
              error.code = fresh.code;
              throw error;
            }
            const claim = await claimCapabilitySet();
            if (!claim.ok) {
              const error = new Error(claim.error);
              error.code = claim.code;
              throw error;
            }
            assertTemporaryAuthorization();
            return createAppImpl(action.agentPayload, { assertAuthorization: assertTemporaryAuthorization });
          },
          deps: {},
        });
        const created = mutation?.result;
        if (!created?.id) {
          return hostPolicyResult('DENY', PERMISSION_REASON_CODES.DENY_DEFAULT, 'Agent creation adapter returned no Agent id');
        }
        return {
          ok: true,
          event: null,
          decision: 'ALLOW',
          reasonCode: gate.reasonCode,
          resultRef: resultRef({ stdout: `created Agent ${created.id}` }),
        };
      } catch (error) {
        return hostPolicyResult(
          'DENY',
          error?.code || PERMISSION_REASON_CODES.DENY_DEFAULT,
          error?.message || String(error),
        );
      }
    }
    if (action?.semanticProjection && isSemanticAptAction(action)) {
      const activeKey = getActivePrivilegedSigningKey();
      if (!activeKey) {
        return { ok: false, event: null, decision: 'ALLOW', reasonCode: gate.reasonCode, resultRef: resultRef({ error: 'Semantic capability signing key is unavailable' }) };
      }
      let aptCapability;
      try {
        // The owner-click policy lowers the approval-time factor only; the
        // capability still carries the exact operation set, one-shot nonce,
        // and TTL, and records honestly that no passkey credential exists.
        const hostPasskeyRequired = isOwnerHostPasskeyRequired();
        const semanticNow = Date.now();
        const semanticTtlMs = Math.min(SEMANTIC_CAPABILITY_TTL_MAX_MS,
          temporaryDeadline === undefined ? Number.POSITIVE_INFINITY : temporaryDeadline - semanticNow);
        if (semanticTtlMs < 1) return hostPolicyResult('DENY', 'TEMPORARY_CONTROL_APPROVAL_DENIED', 'Temporary control approval expired');
        aptCapability = createSemanticCapability({
          selectedDecisions: action.semanticProjection.decisions,
          adapter: SEMANTIC_ADAPTER_APT_INSTALL_V1,
          sessionId,
          runId,
          turnId,
          credentialId: trimString(authorization?.credentialId),
          authMode: hostPasskeyRequired
            ? SEMANTIC_CAPABILITY_AUTH_MODE_OWNER
            : SEMANTIC_CAPABILITY_AUTH_MODE_OWNER_CLICK,
          kid: trimString(activeKey.kid),
          now: semanticNow,
          ttlMs: semanticTtlMs,
        });
      } catch (error) {
        return { ok: false, event: null, decision: 'ALLOW', reasonCode: gate.reasonCode, resultRef: resultRef({ error: error?.message || String(error) }) };
      }
      const claim = await claimCapabilitySet();
      if (!claim.ok) return hostPolicyResult('DENY', claim.code, claim.error);
      try { assertTemporaryAuthorization(); }
      catch (error) { return hostPolicyResult('DENY', error.code, error.message); }
      const semanticResult = await executeSemanticCapability(aptCapability, {
        auditLabel: trimString(action?.originalRequest?.description) || 'semantic apt install',
      });
      return {
        ok: semanticResult.ok === true,
        event: null,
        decision: 'ALLOW',
        reasonCode: gate.reasonCode,
        resultRef: resultRef({
          exitCode: semanticResult.exitCode,
          auditId: semanticResult.auditId,
          stdoutRef: semanticResult.stdoutRef,
          error: semanticResult.error,
        }),
      };
    }
    if (action?.semanticProjection) {
      return {
        ok: false,
        event: null,
        decision: 'ALLOW',
        reasonCode: gate.reasonCode,
        resultRef: resultRef({ error: 'No enabled semantic adapter exists for this host action' }),
      };
    }
    // Legacy privileged host path. It is only reachable behind a passing
    // policy gate; without a server semantic projection no permission facts can
    // be produced, so the gate denies (fail closed) and this branch never runs.
    const op = executorOp(action, trimString(authorization?.selectionManifestHash));
    // Invariant 8: the policy gate above is a preflight, not a grant. Revalidate
    // the target against the approved resource snapshot identity / canonical
    // resource immediately before privileged exec. A missing provider or a
    // failed check DENYs (fail closed) — never execute on a stale or
    // unverifiable target.
    const hostRevalidation = await runApprovedActionRevalidation(
      revalidate,
      approvedRevalidationContext({ executionClass: 'host', entries: gateEntries, action }),
      { execFile },
    );
    if (!hostRevalidation.ok) {
      return hostPolicyResult('DENY', hostRevalidation.code, hostRevalidation.error);
    }
    const workspaceContext = await resolveWorkspaceContext(runId, action?.cwd);
    const resourceKeys = workspaceContext?.physicalKey ? [`workspace:${workspaceContext.physicalKey}`] : [];
    let claimFailure = null;
    const runOp = async () => {
      const claim = await claimCapabilitySet();
      if (!claim.ok) {
        claimFailure = claim;
        return privilegedExecResultEvent({ opId: op.opId, category: op.category, error: claim.error });
      }
      try { assertTemporaryAuthorization(); }
      catch (error) {
        claimFailure = { code: error.code, error: error.message };
        return privilegedExecResultEvent({ opId: op.opId, category: op.category, error: error.message });
      }
      return executePrivilegedOpAsEvent(op, {
        sessionId,
        runId,
        turnId,
        authMode: isOwnerHostPasskeyRequired() ? 'passkey' : PRIVILEGED_TOKEN_AUTH_MODE_OWNER_CLICK,
        webauthnCredentialId: trimString(authorization?.credentialId),
        signedManifestHash: trimString(authorization?.selectionManifestHash),
        batchManifestHash: trimString(authorization?.selectionManifestHash),
        ...(authorization?.temporaryControlExpiresAt ? { temporaryControlExpiresAt: authorization.temporaryControlExpiresAt } : {}),
        auditLabel: trimString(action?.originalRequest?.description) || op.command.slice(0, 300),
      });
    };
    // Host privileged ops mutate the Workspace: run them under the short
    // workspace-level mutation lock so a concurrent checkpoint capture or a
    // second privileged op serializes instead of interleaving.
    const event = resourceKeys.length > 0
      ? (await executeMutation({
          workspaceId: workspaceContext.workspaceId,
          runId,
          resourceKeys,
          ttlMs: APPROVED_MUTATION_TTL_MS,
          hardTtlMs: APPROVED_MUTATION_HARD_TTL_MS,
          mutate: runOp,
          deps: {},
        })).result
      : await runOp();
    const failed = Boolean(event?.error) || Number(event?.exitCode) !== 0;
    if (claimFailure) return hostPolicyResult('DENY', claimFailure.code, claimFailure.error);
    return {
      ok: !failed,
      event: event || privilegedExecResultEvent({ opId: op.opId, category: op.category, error: 'No executor result' }),
      decision: 'ALLOW',
      reasonCode: gate.reasonCode,
      resultRef: resultRef({
        exitCode: event?.exitCode,
        auditId: event?.auditId,
        stdoutRef: event?.stdoutRef,
        error: event?.error,
      }),
    };
  }

  if (executionClass !== 'session') {
    return {
      ok: false,
      event: null,
      resultRef: resultRef({ error: 'Unsupported approved action execution class' }),
    };
  }

  const argv = Array.isArray(action?.argv) ? action.argv.map((part) => String(part || '')) : [];
  if (!argv[0]) {
    return { ok: false, event: null, resultRef: resultRef({ error: 'Approved action has no executable argv' }) };
  }
  // Invariant 8: revalidate argv[0]/target against the approved manifest or
  // resource snapshot immediately before argv construction/exec. A supplied
  // provider must pass; a target carrying an approved resource snapshot with no
  // provider DENYs (fail closed); a plain session target (no snapshot) is
  // covered by the manifest-integrity check already run on entry.
  const sessionRevalidation = await runApprovedActionRevalidation(
    revalidate,
    approvedRevalidationContext({
      executionClass: 'session',
      entries: Array.isArray(action?.semanticProjection?.decisions) ? action.semanticProjection.decisions : [],
      action,
      argv,
    }),
    { execFile },
  );
  if (!sessionRevalidation.ok) {
    return {
      ok: false,
      event: null,
      decision: 'DENY',
      reasonCode: sessionRevalidation.code,
      resultRef: resultRef({ error: sessionRevalidation.error }),
    };
  }
  try { assertTemporaryAuthorization(); }
  catch (error) { return hostPolicyResult('DENY', error.code, error.message); }
  const result = await executeApprovedSessionCommand({ action, argv, timeoutMs, assertAuthorization: assertTemporaryAuthorization });
  return { event: null, ...result };
}
