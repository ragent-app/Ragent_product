// MutationCoordinator (mutation-scoped lease redesign).
//
// Runs no longer hold a workspace lease for their whole lifetime (see
// chat/run-admission.mjs). Write locks belong to a single mutation: acquire a
// short lease on each resource key -> verify expected versions -> run the
// mutation -> release the leases (always, even on error).
//
// Resource keys are opaque lockKey strings reused directly by the lease store:
//   'file:<path>'          one file inside the workspace
//   'git-index:<ws>'       a git index-level lock for a workspace
//   'workspace:<physical>' the whole-workspace exclusive lock (used by
//                          checkpoint capture and approved privileged ops)
//
// Locks are per resource key (sorted deterministically so two mutations that
// need the same set of keys can never deadlock by acquiring in different
// orders). Multiple mutations on DISJOINT keys run concurrently; mutations on
// the SAME key conflict via the store's WORKSPACE_LEASE_CONFLICT (409).
//
// Version check (optimistic concurrency): each expectedVersions entry is read
// with readResourceVersion(key) BEFORE mutate runs; a mismatch raises
// MUTATION_VERSION_CONFLICT (409) with { resourceKey, expected, current } so
// the caller can re-read and rebase instead of silently losing an update.
import { createHash } from 'crypto';
import { readFile } from 'fs/promises';

import {
  acquireWorkspaceLease,
  releaseLease,
} from './workspace-leases.mjs';

const DEFAULT_TTL_MS = 10 * 1000;
const DEFAULT_HARD_TTL_MS = 30 * 1000;

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function createMutationError(message, code, statusCode, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  Object.assign(error, details);
  return error;
}

/**
 * Default resource version reader: `file:<path>` hashes the file content
 * (missing file -> ''); every other key has no intrinsic version and returns ''
 * (the caller injects a real reader via deps when it needs git-head/git-index
 * or workspace-level versions).
 */
async function defaultReadResourceVersion(key) {
  const normalized = trimString(key);
  if (normalized.startsWith('file:')) {
    const filePath = normalized.slice('file:'.length);
    try {
      const content = await readFile(filePath);
      return `sha256:${createHash('sha256').update(content).digest('hex')}`;
    } catch (error) {
      if (error && error.code === 'ENOENT') return '';
      throw error;
    }
  }
  return '';
}

async function releaseAll(releases, leases) {
  for (const lease of leases) {
    if (lease?.leaseId && Number.isInteger(lease?.generation)) {
      await releases(lease.leaseId, lease.generation, { reason: 'mutation-complete' }).catch(() => {});
    }
  }
}

/**
 * executeMutation({ workspaceId, runId, resourceKeys, expectedVersions, ttlMs,
 *                   hardTtlMs, mutate, deps })
 *
 * resourceKeys: ordered/deduped internally, then acquired sorted (deterministic
 *   lock order).
 * expectedVersions: { '<resourceKey>': '<version>' } checked before mutate.
 * mutate: async (leases) => result; runs exactly once after every key is held.
 * deps (test injection): { acquireWorkspaceLease, releaseLease,
 *                           readResourceVersion }
 *
 * Returns { result, leases } where leases are the held lease rows (for callers
 * that need leaseIds for audit). Leases are ALWAYS released before returning
 * or throwing.
 *
 * Throws: WORKSPACE_LEASE_CONFLICT (409, from the store, augmented with the
 * conflicting resourceKey), MUTATION_VERSION_CONFLICT (409, with
 * { resourceKey, expected, current }).
 */
export async function executeMutation({
  workspaceId,
  runId,
  resourceKeys = [],
  expectedVersions = {},
  mode = 'write',
  ttlMs = DEFAULT_TTL_MS,
  hardTtlMs = DEFAULT_HARD_TTL_MS,
  nonReclaimable = false,
  mutate,
  deps = {},
} = {}) {
  if (typeof mutate !== 'function') {
    throw createMutationError('executeMutation requires a mutate function', 'EINVAL', 400);
  }
  const acquire = typeof deps.acquireWorkspaceLease === 'function'
    ? deps.acquireWorkspaceLease
    : acquireWorkspaceLease;
  const release = typeof deps.releaseLease === 'function'
    ? deps.releaseLease
    : releaseLease;
  const readVersion = typeof deps.readResourceVersion === 'function'
    ? deps.readResourceVersion
    : defaultReadResourceVersion;
  const normalizedMode = mode === 'read' ? 'read' : 'write';

  // Normalize + sort for a deterministic lock order (deadlock avoidance).
  const keys = [...new Set(
    (Array.isArray(resourceKeys) ? resourceKeys : []).map((key) => trimString(key)).filter(Boolean),
  )].sort();

  const leases = [];
  try {
    for (const key of keys) {
      let lease;
      try {
        lease = await acquire({
          lockKey: key,
          mode: normalizedMode,
          workspaceId: trimString(workspaceId) || null,
          runId: trimString(runId) || null,
          runtimeId: nonReclaimable ? 'factory-integration' : 'mutation-coordinator',
          ttlMs: Number(ttlMs) > 0 ? Number(ttlMs) : DEFAULT_TTL_MS,
          hardTtlMs: Number(hardTtlMs) > 0 ? Number(hardTtlMs) : DEFAULT_HARD_TTL_MS,
          // Mutation leases are never heartbeated; skip the ttl >= 3*heartbeat
          // assertion that guards renewable run-lifecycle leases.
          heartbeatMs: null,
        });
      } catch (error) {
        if (error && error.code === 'WORKSPACE_LEASE_CONFLICT' && !error.resourceKey) {
          error.resourceKey = key;
        }
        throw error;
      }
      leases.push(lease);
    }

    // Optimistic concurrency: read + compare every expected version while all
    // resource locks are held, so the comparison is race-free against other
    // writers on the same keys.
    for (const [key, expected] of Object.entries(expectedVersions || {})) {
      const current = await readVersion(key);
      if (String(current) !== String(expected)) {
        throw createMutationError(
          `Resource version changed for ${key}: expected ${expected}, current ${current}`,
          'MUTATION_VERSION_CONFLICT',
          409,
          { resourceKey: key, expected, current },
        );
      }
    }

    const result = await mutate(leases);
    return { result, leases };
  } finally {
    await releaseAll(release, leases);
  }
}
