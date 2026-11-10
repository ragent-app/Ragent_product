// Unified Run admission (Execution-Scope slice 2, design section 6.4).
//
// Every Run creation entry point in session-manager.mjs funnels through
// prepareRunExecution(): it re-resolves the Session -> Project -> Workspace
// binding, freezes candidate revisions, collects Git provenance, builds the
// immutable ExecutionScopeSnapshot, re-checks revisions (EXECUTION_SCOPE_STALE
// on change), and attaches executionScope + executionScopeDigest to the
// manifest handed to createRun().
//
// Run admission no longer takes a workspace lease (mutation-scoped lease
// redesign): a Run exists for a long time and must never hold a write lock on
// its Workspace. Write locks belong to short-lived mutations coordinated by
// chat/mutation-coordinator.mjs; this module only freezes the snapshot.
//
// Legacy passthrough (manifest returned unchanged, legacy=true):
// - explicit options.legacy=true,
// - internal sessions (visitor/compactor...),
// - internalOperation values that are not user-visible project-bound new runs.
//   regenerate / editResend are new runs and MUST build a fresh snapshot (never
//   reuse the parent run's executionScope); compaction/delivery and
//   other internal dispatches stay legacy.
import { posix as POSIX_PATH, win32 as WIN32_PATH } from 'node:path';

import { getProject, findProjectByRootPath } from './projects.mjs';
import { ensureWorkspaceForRoot, getWorkspaceById } from './workspaces.mjs';
import {
  buildExecutionScopeSnapshot,
  computeExecutionScopeDigest,
  isUnresolvableRootError,
} from './execution-scope.mjs';
import { collectGitProvenance } from './git-provenance.mjs';
import { resolveRuntimeReadOnlyCapability } from './runtime-adapter.mjs';
import { checkRunnerCapacity } from './runner-capacity.mjs';
import { recoverMutationLeases } from './workspace-leases.mjs';
import {
  API_REQUEST_LOGS_DIR,
  CAPABILITY_GRANT_USAGE_DIR,
  CHAT_COLLABORATIONS_DIR,
  CHAT_FILE_ASSETS_DIR,
  CHAT_FILE_ASSET_CACHE_DIR,
  CHAT_HISTORY_DIR,
  CHAT_IMAGES_DIR,
  CHAT_MANAGED_PROCESSES_DIR,
  CHAT_RUNS_DIR,
  CODEX_CONTROL_HOME_DIR,
  CODEX_MANAGED_HOME_DIR,
  CONFIG_DIR,
  AGY_CONTROL_HOME_DIR,
  AGY_MANAGED_HOME_DIR,
  CLAUDE_MANAGED_HOME_DIR,
  MEMORY_DIR,
  PLATFORM_SKILLS_DIR,
  SHARED_TOOLS_DIR,
  SYSTEM_MEMORY_DIR,
  USAGE_LEDGER_DIR,
} from '../lib/config.mjs';
import { resolvePrivilegedExecutorSocketPath } from '../lib/privileged-executor-protocol.mjs';
import { ownerWindowsOsPaths } from '../lib/windows-owner-os-paths.mjs';
import {
  RISK_POLICY_CONTEXT_VERSION,
  systemPathRootsForPlatform,
} from './risk-policy.mjs';

export const PROJECT_BOUND_NEW_RUN_OPERATIONS = new Set(['regenerate', 'editResend']);

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function pathApiForRiskPlatform(platform) {
  return platform === 'win32' ? WIN32_PATH : POSIX_PATH;
}

function normalizedRiskRoot(value, platform) {
  const path = trimString(value);
  return path ? pathApiForRiskPlatform(platform).resolve(path) : '';
}

function uniqueRiskRoots(values, platform) {
  return [...new Set(values.map((value) => normalizedRiskRoot(value, platform)).filter(Boolean))];
}

/**
 * Build the immutable path facts consumed by the risk classifier.
 *
 * The roots are instance-local configuration paths, not a broad Linux parent
 * such as `/var`. A workspace below a system directory can therefore be
 * trusted only when this exact Run snapshot binds it, while AgentoC's own
 * control roots remain protected by precedence.
 */
export function buildRunRiskContext(executionScope, { protectedRoots = [], windowsOsPaths = process.platform === 'win32' ? ownerWindowsOsPaths() : null } = {}) {
  const scope = executionScope && typeof executionScope === 'object' ? executionScope : {};
  const platform = typeof scope.platform === 'string' && scope.platform ? scope.platform : process.platform;
  const pathApi = pathApiForRiskPlatform(platform);
  const workspaceRoot = trimString(scope.workspaceRoot?.realPath);
  const trustedWorkspaceRoot = trimString(scope.scopeRoot?.realPath) || workspaceRoot;
  const cwd = trimString(scope.cwd?.realPath) || trustedWorkspaceRoot;
  const executorSocket = trimString(resolvePrivilegedExecutorSocketPath());
  const providerHomesRoot = CODEX_MANAGED_HOME_DIR ? pathApi.dirname(CODEX_MANAGED_HOME_DIR) : '';
  const defaults = [
    CONFIG_DIR,
    MEMORY_DIR,
    SYSTEM_MEMORY_DIR,
    CHAT_HISTORY_DIR,
    CHAT_RUNS_DIR,
    CHAT_MANAGED_PROCESSES_DIR,
    CHAT_COLLABORATIONS_DIR,
    CHAT_IMAGES_DIR,
    CHAT_FILE_ASSETS_DIR,
    CHAT_FILE_ASSET_CACHE_DIR,
    API_REQUEST_LOGS_DIR,
    CAPABILITY_GRANT_USAGE_DIR,
    USAGE_LEDGER_DIR,
    PLATFORM_SKILLS_DIR,
    SHARED_TOOLS_DIR,
    providerHomesRoot,
    CODEX_MANAGED_HOME_DIR,
    CLAUDE_MANAGED_HOME_DIR,
    AGY_MANAGED_HOME_DIR,
    CODEX_CONTROL_HOME_DIR,
    AGY_CONTROL_HOME_DIR,
    executorSocket ? pathApi.dirname(executorSocket) : '',
  ];
  const allProtectedRoots = uniqueRiskRoots([...defaults, ...protectedRoots], platform);
  return {
    schemaVersion: RISK_POLICY_CONTEXT_VERSION,
    platform,
    workspaceRoot,
    trustedWorkspaceRoot,
    cwd,
    // The owner workspace can be below ProgramData. Bind that concrete OS
    // root into the signed Run snapshot so reads inside the exact workspace
    // can be distinguished from unrelated ProgramData contents.
    ...(platform === 'win32' && typeof windowsOsPaths?.programData === 'string'
      ? { programDataRoot: windowsOsPaths.programData }
      : {}),
    protectedRoots: allProtectedRoots,
    // Add OS-derived roots when available; retain environment-derived roots
    // as additional restrictions for redirected or custom installations.
    systemPathRoots: uniqueRiskRoots([
      ...systemPathRootsForPlatform(platform),
      ...(platform === 'win32' && windowsOsPaths
        ? [windowsOsPaths.windows, windowsOsPaths.programData, windowsOsPaths.programFiles, windowsOsPaths.programFilesX86] : []),
    ], platform),
  };
}

function createAdmissionError(message, code, statusCode, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  Object.assign(error, details);
  return error;
}

// True when a run should keep the pre-snapshot legacy path (no executionScope
// attached). Internal sessions and non-project-bound internal operations are
// conservative passthroughs; regenerate/edit-resend are project-bound new runs.
export function isInternalLegacyRun({ session, internalOperation }) {
  if (session && typeof session === 'object' && session.isInternalSession === true) return true;
  const operation = trimString(internalOperation);
  if (!operation) return false;
  return !PROJECT_BOUND_NEW_RUN_OPERATIONS.has(operation);
}

function isUnresolvableScopeError(error) {
  return isUnresolvableRootError(error);
}

/**
 * prepareRunExecution({ sessionId, session, manifest, options, deps })
 *
 * options: { internalOperation, legacy, accessMode, readOnlyRequired, runnerId,
 *            runnerUnitScope, executionIsolation, agent, gitTimeoutMs,
 *            gitMaxOutputBytes }
 * deps (test injection): { loadProject, findProjectByFolder, ensureWorkspace,
 *                          loadWorkspace, collectGit, runtimeAdapter }
 *
 * Returns:
 *   { manifest, legacy: false, executionScope, executionScopeDigest,
 *     project, workspace, accessMode, runtimeId, runtimeCapability,
 *     readOnlyDowngrade? }  -- manifest carries the frozen snapshot
 *   { manifest, legacy: true, reason } -- manifest passed through unchanged
 *
 * Throws frozen error codes: WORKSPACE_ROOT_UNRESOLVED (409),
 * EXECUTION_SCOPE_STALE (409), EXECUTION_SCOPE_UNAVAILABLE (409),
 * WORKSPACE_ROOT_DRIFT (409, from the Workspace store),
 * PROJECT_SCOPE_ESCAPE (400, from the Path Resolver),
 * READ_ONLY_RUNTIME_UNAVAILABLE (409, readOnlyRequired without a certified
 * read-only runtime).
 */
export async function prepareRunExecution({ sessionId, session, manifest, options = {}, deps = {} } = {}) {
  const loadProject = typeof deps.loadProject === 'function'
    ? deps.loadProject
    : (async (projectId) => getProject(projectId));
  const findProjectByFolder = typeof deps.findProjectByFolder === 'function'
    ? deps.findProjectByFolder
    : (async (folder) => findProjectByRootPath(folder));
  const ensureWorkspace = typeof deps.ensureWorkspace === 'function'
    ? deps.ensureWorkspace
    : (async (rootPath) => ensureWorkspaceForRoot(rootPath));
  const loadWorkspace = typeof deps.loadWorkspace === 'function'
    ? deps.loadWorkspace
    : (async (workspaceId) => getWorkspaceById(workspaceId));
  const collectGit = typeof deps.collectGit === 'function'
    ? deps.collectGit
    : (async (cwd, gitOptions) => collectGitProvenance(cwd, gitOptions));
  const resolveRuntimeCapability = typeof deps.runtimeAdapter === 'function'
    ? deps.runtimeAdapter
    : (async (context) => resolveRuntimeReadOnlyCapability(context));
  const checkCapacity = typeof deps.checkCapacity === 'function'
    ? deps.checkCapacity
    : checkRunnerCapacity;

  const sessionKey = trimString(sessionId) || trimString(session?.id);
  if (!sessionKey || !manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { manifest, legacy: true, reason: 'no-session-binding' };
  }
  if (options.legacy === true) {
    return { manifest, legacy: true, reason: 'explicit-legacy' };
  }

  const internalOperation = trimString(manifest.internalOperation) || trimString(options.internalOperation);
  if (isInternalLegacyRun({ session, internalOperation })) {
    return { manifest, legacy: true, reason: internalOperation
      ? `internal-operation-legacy:${internalOperation}`
      : 'internal-session-legacy' };
  }

  // Check capacity before persisting a Run or preparing a provider. A full
  // runner slice must return an actionable retry error instead of amplifying
  // the pressure that can starve the control plane.
  const capacity = await checkCapacity();
  if (capacity?.accepted === false) {
    throw createAdmissionError(
      'Runner capacity is currently exhausted; wait for an active run to finish and retry',
      'RUNNER_CAPACITY_EXHAUSTED',
      503,
      {
        capacityReasons: Array.isArray(capacity.reasons) ? capacity.reasons : [],
        capacityLimits: capacity.limits || null,
        capacitySnapshot: capacity.snapshot || null,
      },
    );
  }

  // Resolve the Project by session binding (projectId first, folder fallback).
  const projectId = trimString(session?.projectId);
  let project = null;
  if (projectId) project = await loadProject(projectId);
  if (!project && trimString(session?.folder)) {
    project = await findProjectByFolder(session.folder);
  }
  if (!project) {
    return { manifest, legacy: true, reason: 'no-project-binding' };
  }
  const candidateProjectRevision = Number.isInteger(project.revision) && project.revision > 0 ? project.revision : 1;

  // Workspace: drift-checked ensure (raises WORKSPACE_ROOT_DRIFT when the root
  // moved), then a non-mutating re-read for the revision check.
  const workspace = await ensureWorkspace(project.rootPath);
  if (!workspace || workspace.resolutionState === 'unresolved') {
    throw createAdmissionError(
      'Workspace root is unresolved or not accessible',
      'WORKSPACE_ROOT_UNRESOLVED',
      409,
      { projectId: project.id, workspaceId: workspace?.id || '' },
    );
  }
  const candidateWorkspaceRevision = Number.isInteger(workspace.revision) && workspace.revision > 0
    ? workspace.revision
    : 1;

  const git = await collectGit(workspace.realRootPath || project.rootPath, {
    timeoutMs: options.gitTimeoutMs,
    maxOutputBytes: options.gitMaxOutputBytes,
  });

  const scopeMode = project.scopeMode === 'subpath' ? 'subpath' : 'shared';
  const requestedAccessMode = options.accessMode === 'read' ? 'read' : 'write';
  const executionIsolation = options.executionIsolation === 'worktree' || options.executionIsolation === 'container'
    ? options.executionIsolation
    : 'shared';
  const agent = options.agent && typeof options.agent === 'object' ? options.agent : undefined;

  // S4: runtime read-only certification gate. Resolved BEFORE the snapshot is
  // built so the frozen snapshot.accessMode always matches the lease mode.
  // A certified reader keeps accessMode='read' and carries its runtime id +
  // capability proof into the lease; an uncertified read request downgrades to
  // a write lease (readOnlyDowngrade recorded, no throw) unless the caller
  // requires read-only, in which case admission is refused with
  // READ_ONLY_RUNTIME_UNAVAILABLE (409).
  let effectiveAccessMode = requestedAccessMode;
  let runtimeCapability = null;
  let readOnlyDowngrade = null;
  if (requestedAccessMode === 'read') {
    const capability = await resolveRuntimeCapability({
      toolId: trimString(manifest.tool),
      runnerId: trimString(options.runnerId),
      envOverrides: manifest?.options?.envOverrides || options.envOverrides || null,
      runnerUnitScope: trimString(options.runnerUnitScope),
      platform: process.platform,
    });
    if (capability && capability.supportsReadOnlyFilesystem === true) {
      effectiveAccessMode = 'read';
      runtimeCapability = capability;
    } else {
      effectiveAccessMode = 'write';
      const runtimeId = trimString(capability?.runtimeId)
        || trimString(options.runnerId)
        || trimString(manifest.tool)
        || 'runner_local_detached';
      readOnlyDowngrade = {
        requested: 'read',
        reason: 'runtime-not-certified',
        runtimeId,
      };
      if (options.readOnlyRequired === true) {
        throw createAdmissionError(
          'Read-only runtime is not available for this run; refusing to start a writer',
          'READ_ONLY_RUNTIME_UNAVAILABLE',
          409,
          { requestedAccessMode: 'read', downgrade: readOnlyDowngrade },
        );
      }
    }
  }

  let snapshot;
  let digest;
  try {
    const built = await buildExecutionScopeSnapshot({
      project,
      workspace,
      session,
      agent,
      scopeMode,
      accessMode: effectiveAccessMode,
      executionIsolation,
      git,
    });
    snapshot = built.snapshot;
    const riskContext = buildRunRiskContext(snapshot);
    // Bind the risk context into the same immutable snapshot/digest as the
    // execution scope. A later observer or sidecar cannot silently replace the
    // protected roots or the trusted workspace with caller-provided values.
    snapshot = { ...snapshot, riskContext };
    digest = computeExecutionScopeDigest(snapshot);
  } catch (error) {
    if (error?.code === 'PROJECT_SCOPE_ESCAPE') throw error;
    if (isUnresolvableScopeError(error)) {
      throw createAdmissionError(
        `Execution scope is not available: ${error?.code || 'unresolvable'}`,
        'EXECUTION_SCOPE_UNAVAILABLE',
        409,
        { projectId: project.id, causeCode: error?.code || '' },
      );
    }
    throw error;
  }

  // Revision re-check: a change between resolve and commit invalidates the
  // candidate snapshot; the caller must recompute instead of starting a stale
  // Run (design 6.2 / EXECUTION_SCOPE_STALE).
  const verifyProject = projectId ? await loadProject(projectId) : await findProjectByFolder(session.folder);
  const verifyProjectRevision = verifyProject
    ? (Number.isInteger(verifyProject.revision) && verifyProject.revision > 0 ? verifyProject.revision : 1)
    : -1;
  if (verifyProjectRevision !== candidateProjectRevision) {
    throw createAdmissionError(
      'Execution scope revision changed during admission; recompute the snapshot',
      'EXECUTION_SCOPE_STALE',
      409,
      { projectId: project.id, candidateRevision: candidateProjectRevision, currentRevision: verifyProjectRevision },
    );
  }
  if (workspace?.id) {
    const verifyWorkspace = await loadWorkspace(workspace.id);
    const verifyWorkspaceRevision = verifyWorkspace
      ? (Number.isInteger(verifyWorkspace.revision) && verifyWorkspace.revision > 0 ? verifyWorkspace.revision : 1)
      : -1;
    if (verifyWorkspaceRevision !== candidateWorkspaceRevision) {
      throw createAdmissionError(
        'Workspace revision changed during admission; recompute the snapshot',
        'EXECUTION_SCOPE_STALE',
        409,
        { workspaceId: workspace.id, candidateRevision: candidateWorkspaceRevision, currentRevision: verifyWorkspaceRevision },
      );
    }
  }

  // Run admission no longer acquires a workspace lease. A Run exists for a
  // long time (user messaging, agent reasoning, reads) and must never hold a
  // write lock on its Workspace; write locks belong to short-lived mutations
  // only (see chat/mutation-coordinator.mjs). The runtime id is still resolved
  // for the snapshot + manifest provenance.
  const runtimeId = runtimeCapability?.runtimeId
    || trimString(options.runnerId)
    || trimString(manifest.tool)
    || null;

  const nextManifest = {
    ...manifest,
    executionScope: snapshot,
    executionScopeDigest: digest,
    legacyExecutionScope: false,
    ...(readOnlyDowngrade ? { readOnlyDowngrade } : {}),
  };
  return {
    manifest: nextManifest,
    legacy: false,
    executionScope: snapshot,
    executionScopeDigest: digest,
    project,
    workspace,
    accessMode: effectiveAccessMode,
    runtimeId,
    runtimeCapability: runtimeCapability || undefined,
    ...(readOnlyDowngrade ? { readOnlyDowngrade } : {}),
  };
}

/**
 * Startup recovery for mutation-scoped leases. Runs no longer hold workspace
 * leases, so recovery only reclaims expired short mutation leases (abandoned
 * by a crashed writer). Fail-safe: recovery errors must never block server
 * startup.
 */
export async function initWorkspaceLeaseRecovery({ now = new Date() } = {}) {
  const audits = await recoverMutationLeases({ now });
  return { audits };
}

/**
 * Legacy runs no longer hold write leases after the mutation-scoped lease
 * redesign; backfilling synthetic leases would re-create the run-lifecycle
 * lock that blocks a second run on the same Workspace. Kept exported for
 * interface stability, but a no-op.
 */
export async function ensureLegacySyntheticLeases() {
  return { created: [], skipped: [] };
}
