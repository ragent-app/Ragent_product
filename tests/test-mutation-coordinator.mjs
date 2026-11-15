#!/usr/bin/env node
// Mutation-scoped lease redesign.
//
// 1) Run admission (prepareRunExecution) no longer acquires a workspace lease:
//    multiple project-bound runs coexist on the same Workspace, and no lease
//    field / workspaceLeaseId reaches the manifest. The accessMode + runtime
//    read-only certification gates are unchanged.
// 2) MutationCoordinator (executeMutation): per-resource-key write leases with
//    deterministic (sorted) acquisition order, write/write conflicts surface as
//    WORKSPACE_LEASE_CONFLICT, optimistic version checks raise
//    MUTATION_VERSION_CONFLICT before mutate runs, and leases are ALWAYS
//    released (even when mutate throws).
// 3) readOnlyRequired without a certified runtime still fails with
//    READ_ONLY_RUNTIME_UNAVAILABLE (409).
import assert from 'assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const configDir = mkdtempSync(join(tmpdir(), 'ragent-mutation-coordinator-'));
process.env.RAGENT_CONFIG_DIR = configDir;

const { prepareRunExecution } = await import('../chat/run-admission.mjs');
const { createProject } = await import('../chat/projects.mjs');
const {
  listActiveLeases,
  closeWorkspaceLeaseStore,
} = await import('../chat/workspace-leases.mjs');
const { executeMutation } = await import('../chat/mutation-coordinator.mjs');

const createdDirs = [];
function makeRoot(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

// ── assertion accounting ───────────────────────────────────────────────────
let totalAssertions = 0;
let currentSection = null;
function beginSection(name) {
  currentSection = { name, count: 0 };
}
function countAssertions(n = 1) {
  totalAssertions += n;
  if (currentSection) currentSection.count += n;
}
function eq(actual, expected, message) { countAssertions(); assert.equal(actual, expected, message); }
function ok(value, message) { countAssertions(); assert.ok(value, message); }
function notOk(value, message) { countAssertions(); assert.ok(!value, message); }
function deepEq(actual, expected, message) { countAssertions(); assert.deepEqual(actual, expected, message); }
function rejects(promiseFactory, predicate, message) {
  countAssertions();
  return assert.rejects(promiseFactory, predicate, message);
}
const sections = [];
function finishSection() {
  if (currentSection) sections.push(currentSection);
  currentSection = null;
}

function makeSession(id, folder, projectId) {
  return { id, folder, projectId, templateId: 'app_mc' };
}
function makeManifest(sessionId, folder, tool = 'codex') {
  return { sessionId, requestId: `req_${sessionId}`, folder, tool, prompt: 'mc prompt' };
}

// Certified read-only runtime injected via deps.
async function certifiedRuntimeAdapter() {
  return {
    runtimeId: 'runtime_certified_read',
    supportsReadOnlyFilesystem: true,
    enforcement: 'sandbox',
    note: 'test-certified-reader',
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

try {
  // ── run admission takes no workspace lease ────────────────────────────────
  beginSection('admission-no-lease');
  const root = makeRoot('ragent-mc-root-');
  mkdirSync(join(root, '.git'), { recursive: true });
  const projectA = await createProject({ name: 'MC A', rootPath: root });
  const projectB = await createProject({ name: 'MC B', rootPath: root });

  const runA = await prepareRunExecution({
    sessionId: 'mc_a',
    session: makeSession('mc_a', root, projectA.id),
    manifest: makeManifest('mc_a', root),
    options: { runId: 'run_mc_a' },
  });
  eq(runA.legacy, false, 'project-bound run is not legacy');
  eq(runA.lease, undefined, 'run admission returns no run-scoped lease');
  eq(runA.manifest.workspaceLeaseId, undefined, 'manifest carries no workspace lease id');

  // A second run on the SAME workspace is admitted (no run-lifecycle lease
  // conflict). This is the core of the redesign: runs coexist.
  const runB = await prepareRunExecution({
    sessionId: 'mc_b',
    session: makeSession('mc_b', root, projectB.id),
    manifest: makeManifest('mc_b', root),
    options: { runId: 'run_mc_b' },
  });
  eq(runB.lease, undefined, 'second run returns no lease either');
  eq(runB.executionScope.workspaceId, runA.executionScope.workspaceId,
    'both runs share the same Workspace without a lease conflict');
  ok((await listActiveLeases()).length === 0, 'no workspace lease exists after admission');
  finishSection();

  // ── certified reader keeps accessMode read, still no lease ───────────────
  beginSection('certified-reader-no-lease');
  const reader = await prepareRunExecution({
    sessionId: 'mc_reader',
    session: makeSession('mc_reader', root, projectA.id),
    manifest: makeManifest('mc_reader', root),
    options: { accessMode: 'read', runId: 'run_mc_reader' },
    deps: { runtimeAdapter: certifiedRuntimeAdapter },
  });
  eq(reader.accessMode, 'read', 'certified reader keeps accessMode read');
  eq(reader.executionScope.accessMode, 'read', 'snapshot freezes accessMode read');
  eq(reader.runtimeId, 'runtime_certified_read', 'admission carries the certified runtime id');
  eq(reader.runtimeCapability.supportsReadOnlyFilesystem, true, 'admission carries the capability proof');
  eq(reader.lease, undefined, 'certified reader holds no run-scoped lease');
  finishSection();

  // ── readOnlyRequired without certification -> READ_ONLY_RUNTIME_UNAVAILABLE ─
  beginSection('readonly-required');
  const rootReq = makeRoot('ragent-mc-required-root-');
  mkdirSync(join(rootReq, '.git'), { recursive: true });
  const projectReq = await createProject({ name: 'MC Required', rootPath: rootReq });
  await rejects(
    () => prepareRunExecution({
      sessionId: 'mc_req',
      session: makeSession('mc_req', rootReq, projectReq.id),
      manifest: makeManifest('mc_req', rootReq),
      options: { accessMode: 'read', readOnlyRequired: true, runId: 'run_mc_req' },
    }),
    (error) => error.code === 'READ_ONLY_RUNTIME_UNAVAILABLE'
      && error.statusCode === 409
      && error.downgrade?.reason === 'runtime-not-certified'
      && error.downgrade?.requested === 'read',
    'readOnlyRequired without a certified runtime must fail with READ_ONLY_RUNTIME_UNAVAILABLE (409)',
  );
  finishSection();

  // ── coordinator: deterministic sorted acquisition ─────────────────────────
  beginSection('coordinator-sorted-keys');
  const acquiredOrder = [];
  const { result: sortedResult } = await executeMutation({
    resourceKeys: ['workspace:z', 'workspace:a', 'workspace:a', 'workspace:m'],
    mutate: async (leases) => {
      acquiredOrder.push(...leases.map((lease) => lease.lockKey));
      return 'sorted-ok';
    },
  });
  eq(sortedResult, 'sorted-ok', 'mutate returns the caller result');
  deepEq(acquiredOrder, ['workspace:a', 'workspace:m', 'workspace:z'],
    'resource keys are deduped and acquired in sorted order');
  ok((await listActiveLeases()).every((lease) => !acquiredOrder.includes(lease.lockKey)),
    'held leases are released after the mutation');
  finishSection();

  // ── coordinator: write x write conflict on the same resource key ──────────
  beginSection('coordinator-write-conflict');
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const firstMutation = executeMutation({
    resourceKeys: ['workspace:exclusive'],
    mutate: async () => { await firstGate; return 'first'; },
  });
  await sleep(50); // let the first acquire+hold settle
  await rejects(
    () => executeMutation({
      resourceKeys: ['workspace:exclusive'],
      mutate: async () => 'second',
    }),
    (error) => error.code === 'WORKSPACE_LEASE_CONFLICT'
      && error.resourceKey === 'workspace:exclusive',
    'a second writer on the same resource key must conflict with WORKSPACE_LEASE_CONFLICT',
  );
  releaseFirst();
  eq((await firstMutation).result, 'first', 'first mutation completes after the conflict');
  ok((await listActiveLeases()).every((lease) => lease.lockKey !== 'workspace:exclusive'),
    'conflicting writer never holds the lease; first writer released it');
  finishSection();

  // ── coordinator: disjoint keys are not blocked ────────────────────────────
  beginSection('coordinator-disjoint-keys');
  const results = await Promise.all([
    executeMutation({ resourceKeys: ['workspace:disjoint-a'], mutate: async () => 'a' }),
    executeMutation({ resourceKeys: ['workspace:disjoint-b'], mutate: async () => 'b' }),
  ]);
  deepEq(results.map((r) => r.result).sort(), ['a', 'b'],
    'mutations on disjoint resource keys run concurrently');
  finishSection();

  // ── coordinator: optimistic version check ─────────────────────────────────
  beginSection('coordinator-version-conflict');
  let mutateCalled = false;
  await rejects(
    () => executeMutation({
      resourceKeys: ['file:/tmp/mc-a.ts'],
      expectedVersions: { 'file:/tmp/mc-a.ts': 'sha256:old' },
      mutate: async () => { mutateCalled = true; },
      deps: {
        readResourceVersion: async () => 'sha256:new',
      },
    }),
    (error) => error.code === 'MUTATION_VERSION_CONFLICT'
      && error.statusCode === 409
      && error.resourceKey === 'file:/tmp/mc-a.ts'
      && error.expected === 'sha256:old'
      && error.current === 'sha256:new',
    'a version mismatch must raise MUTATION_VERSION_CONFLICT before mutate',
  );
  eq(mutateCalled, false, 'mutate must not run on a version mismatch');
  ok((await listActiveLeases()).every((lease) => lease.lockKey !== 'file:/tmp/mc-a.ts'),
    'leases are released even when the version check fails');
  finishSection();

  // ── coordinator: leases always released, even when mutate throws ─────────
  beginSection('coordinator-release-on-error');
  await rejects(
    () => executeMutation({
      resourceKeys: ['workspace:boom'],
      mutate: async () => { throw new Error('mutation failed'); },
    }),
    (error) => error.message === 'mutation failed',
    'mutate errors propagate to the caller',
  );
  ok((await listActiveLeases()).every((lease) => lease.lockKey !== 'workspace:boom'),
    'leases are released even when mutate throws');
  finishSection();

  // ── coordinator: hard TTL flows through to the lease row ──────────────────
  beginSection('coordinator-hard-ttl');
  let captured = null;
  await executeMutation({
    resourceKeys: ['workspace:ttl'],
    ttlMs: 5000,
    hardTtlMs: 10000,
    mutate: async (leases) => { captured = leases[0]; },
  });
  ok(captured?.hardExpiresAt, 'coordinator passes hardTtlMs through to the lease row');
  ok(Date.parse(captured.hardExpiresAt) > Date.parse(captured.expiresAt),
    'hard expiry is later than the soft expiry');
  finishSection();

  await closeWorkspaceLeaseStore();
  console.log('test-mutation-coordinator: ok');
  console.log(`  total assertions: ${totalAssertions}`);
  for (const section of sections) {
    console.log(`  ${section.name}: ${section.count} assertions`);
  }
} finally {
  await closeWorkspaceLeaseStore().catch(() => {});
  rmSync(configDir, { recursive: true, force: true });
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
}
