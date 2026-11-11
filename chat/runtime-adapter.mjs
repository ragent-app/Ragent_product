// Runtime read-only capability registry (Execution-Scope slice 4, design 7.1).
//
// A Run may only hold a 'read' WorkspaceLease when the runtime that will
// actually execute it is certified to enforce a read-only filesystem. Reviewer
// role, prompt wording or writablePaths=[] never constitute a read-only
// guarantee: without a verifiable sandbox the request falls back to a 'write'
// lease (or is rejected when the caller requires read-only).
//
// The honest default for the current local runners (micro-agent / codex /
// claude detached processes without an OS sandbox, worktree or container) is
// supportsReadOnlyFilesystem=false with enforcement='none'. Future sandboxed
// runtimes declare themselves via registerRuntimeAdapter() or through a deps
// injection point in prepareRunExecution.
//
// S12 (Organization Constitution §6.1/§2.5): the certified read-only reviewer
// runtime. Only the bubblewrap read-only sandbox (workspace mounted with
// `--ro-bind`) can carry the REVIEWER_RUNTIME_ID, and that runtime is only
// considered certified while REVIEWER_ENABLED activates the reviewer flow.
// Sandbox startup/build is verified separately by the reviewer admission path
// (buildReviewerReadOnlySandbox), which refuses with READ_ONLY_RUNTIME_REFUSED
// instead of ever downgrading to an unsandboxed launch.

import { buildBwrapArgs } from '../lib/runner-sandbox.mjs';
import { REVIEWER_ENABLED } from '../lib/config.mjs';

// The built-in certified read-only reviewer runtime id. A reviewer task is
// dispatched with this runner id so admission, the snapshot and the sandbox
// wiring all agree on which runtime will execute the review.
export const REVIEWER_RUNTIME_ID = 'runtime_reviewer_readonly';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

const registeredAdapters = [];

function normalizeCapability(capability, fallback = {}) {
  const raw = capability && typeof capability === 'object' && !Array.isArray(capability)
    ? capability
    : {};
  const supportsReadOnlyFilesystem = raw.supportsReadOnlyFilesystem === true;
  return {
    runtimeId: trimString(raw.runtimeId) || trimString(fallback.runtimeId) || 'runtime_local',
    supportsReadOnlyFilesystem,
    enforcement: trimString(raw.enforcement) || (supportsReadOnlyFilesystem ? 'sandbox' : 'none'),
    note: trimString(raw.note) || '',
  };
}

function contextMatchesId(context, id) {
  const normalized = trimString(id);
  if (!normalized) return false;
  if (trimString(context?.toolId) === normalized) return true;
  const runnerId = trimString(context?.runnerId);
  if (runnerId === normalized) return true;
  // runtime ids are hierarchical ("runtime/runner/..."): a registered prefix
  // matches the concrete runner identity.
  return runnerId.startsWith(`${normalized}/`);
}

/**
 * Resolve the read-only capability for a runtime candidate.
 *
 * @param {object} input
 * @param {string} [input.toolId]          tool id from the manifest
 * @param {string} [input.runnerId]        runner identity (options.runnerId)
 * @param {object} [input.envOverrides]    runner environment overrides
 * @param {string} [input.runnerUnitScope] systemd unit scope, if any
 * @param {string} [input.platform]        process.platform
 * @returns {{ runtimeId: string, supportsReadOnlyFilesystem: boolean,
 *             enforcement: string, note: string }}
 */
export function resolveRuntimeReadOnlyCapability({
  toolId,
  runnerId,
  envOverrides,
  runnerUnitScope,
  platform = process.platform,
} = {}) {
  const context = { toolId, runnerId, envOverrides, runnerUnitScope, platform };
  for (const entry of registeredAdapters) {
    if (typeof entry.predicate === 'function'
      ? entry.predicate(context) === true
      : contextMatchesId(context, entry.predicate)) {
      return normalizeCapability(entry.capability, { toolId, runnerId });
    }
  }
  // S12: the certified read-only reviewer runtime is a built-in capability
  // while REVIEWER_ENABLED is on. REVIEWER_RUNTIME_ID is the identity of the
  // read-only bubblewrap sandbox runtime, so a matching context is certified;
  // sandbox availability is verified at reviewer admission time and a build
  // failure there refuses the run (READ_ONLY_RUNTIME_REFUSED) rather than
  // downgrading. Explicitly registered adapters above always take precedence.
  if (REVIEWER_ENABLED && platform === 'linux' && contextMatchesId(context, REVIEWER_RUNTIME_ID)) {
    return {
      runtimeId: REVIEWER_RUNTIME_ID,
      supportsReadOnlyFilesystem: true,
      enforcement: 'sandbox',
      note: 'certified-readonly-bwrap',
    };
  }
  // Honest default: local detached runners have no verifiable read-only
  // filesystem, so read requests must downgrade to a write lease.
  return {
    runtimeId: trimString(runnerId) || trimString(toolId) || 'runner_local_detached',
    supportsReadOnlyFilesystem: false,
    enforcement: 'none',
    note: 'runtime-not-certified',
  };
}

/**
 * Register a future sandboxed runtime's read-only capability declaration.
 *
 * @param {string|function} predicateOrId toolId/runtimeId prefix, or a
 *        predicate (context) => boolean matching the runtime candidate.
 * @param {object} capability { runtimeId, supportsReadOnlyFilesystem,
 *        enforcement, note }
 * @returns {function} unregister function (test/teardown convenience)
 */
export function registerRuntimeAdapter(predicateOrId, capability) {
  if (typeof predicateOrId !== 'function' && typeof predicateOrId !== 'string') {
    throw new TypeError('registerRuntimeAdapter requires a predicate function or runtime id string');
  }
  if (!capability || typeof capability !== 'object' || Array.isArray(capability)) {
    throw new TypeError('registerRuntimeAdapter requires a capability object');
  }
  const entry = { predicate: predicateOrId, capability: normalizeCapability(capability) };
  registeredAdapters.push(entry);
  return function unregisterRuntimeAdapter() {
    const index = registeredAdapters.indexOf(entry);
    if (index !== -1) registeredAdapters.splice(index, 1);
  };
}

/**
 * Build the read-only bubblewrap argv for the certified reviewer runtime.
 * This is the S12 sandbox pre-flight: the reviewer admission path builds these
 * args before dispatching, and any construction failure (or a missing bwrap
 * binary) refuses the reviewer run with READ_ONLY_RUNTIME_REFUSED — the
 * reviewer is never downgraded to an unsandboxed launch.
 *
 * @param {object} [input]
 * @param {string} [input.command] probe command placed after the `--` separator
 * @param {string[]} [input.args] tool arguments
 * @param {string} [input.cwd] run workspace (mounted --ro-bind)
 * @param {string} [input.runnerHome] runner private home (kept read-only)
 * @param {string[]} [input.hidePaths] control-plane paths to hide
 * @returns {string[]} bwrap argv with the workspace read-only
 */
export function buildReviewerReadOnlySandbox({
  command = '/bin/true',
  args = [],
  cwd = '',
  runnerHome = '',
  hidePaths = [],
} = {}) {
  return buildBwrapArgs({ command, args, cwd, runnerHome, hidePaths, readOnly: true });
}
