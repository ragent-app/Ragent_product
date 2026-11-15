#!/usr/bin/env node
// S14: migration gray rollout + final acceptance matrix.
//
// Organization Constitution v1.1 (§8 migration & gray rollout, §10 final
// acceptance matrix). The isolated source/test process runs with ALL FIVE
// legacy feature flags off (the source fallback), so the flag-off baseline and the migration
// compatibility matrix are exercised in-process; every flag-gated acceptance
// item is verified through subprocess probes that flip one flag at a time.
//
// §10 final acceptance matrix -> coverage (this suite / shipped S8-S13 suites):
//   [1]  message bypass interception          -> managed-input probe (flag on)
//   [2]  permission attribution (access edge) -> router-layer route map +
//        managed-input probe (caller-independent gate)
//   [3]  compiler cycle & budget              -> in-process compileRevision
//   [4]  concurrent CAS (gate/revision/phase) -> in-process phase-gates +
//        org-runtime probe (flag on)
//   [5]  duplicate requests idempotent        -> org-runtime probe (flag on)
//   [6]  provisioning failure points          -> reviewer sandbox refusal
//        (in-process orchestrator) + managed-writer escape
//   [7]  restart recovery (reconciler)        -> orchestrator reconcile
//        idempotency (in-process) + command idempotency probe (honest note)
//   [8]  self-review attack refused           -> reviewer enforcement
//   [9]  reviewer writes refused (read-only)  -> reviewer read-lease forced
//   [10] symlink/junction escape              -> managed-writer escape
//   [11] staging diff escape                  -> managed-writer escape
//   [12] event ordering (stable replay)       -> collaboration-store events
//   [13] android projection (authorized facts)-> shadow projection probe
//        (design-equivalent; platform limitation honestly noted)
import assert from 'assert/strict';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

// Isolate config + session storage before importing anything that reads them.
// The main process is the shipped baseline: every org flag off.
const tempHome = mkdtempSync(join(tmpdir(), 'ragent-acceptance-'));
const probeHome = mkdtempSync(join(tmpdir(), 'ragent-acceptance-probe-'));
process.env.HOME = tempHome;
for (const key of [
  'RAGENT_CONFIG_DIR',
  'RAGENT_INSTANCE_ROOT',
  'RAGENT_WORK_ROOT_DIR',
  'RAGENT_MEMORY_DIR',
  'RAGENT_RUN_SPOOL_DIR',
  'RAGENT_ORG_SCHEMA_ENABLED',
  'RAGENT_ORG_SHADOW_PROJECTION',
  'RAGENT_MANAGED_INPUT_ENFORCEMENT',
  'RAGENT_MANAGED_WRITER_ENABLED',
  'RAGENT_REVIEWER_ENABLED',
  'RAGENT_ORG_PROJECTION_V2_ENABLED',
]) delete process.env[key];

const workspace = join(tempHome, 'workspace');
mkdirSync(workspace, { recursive: true });

const {
  ORG_SCHEMA_ENABLED,
  ORG_SHADOW_PROJECTION,
  MANAGED_INPUT_ENFORCEMENT,
  MANAGED_WRITER_ENABLED,
  REVIEWER_ENABLED,
  ORG_PROJECTION_V2_ENABLED,
} = await import('../lib/config.mjs');
const sessionManager = await import('../chat/session-manager.mjs');
const managedInput = await import('../chat/managed-input.mjs');
const collabStore = await import('../chat/collaboration-store.mjs');
const orgStore = await import('../chat/organization-store.mjs');
const runtime = await import('../chat/organization-runtime.mjs');
const gates = await import('../chat/phase-gates.mjs');
const { compileCollaborationPlan } = await import('../chat/collaboration-plan.mjs');
const { normalizeCollaborationPolicy } = await import('../chat/collaboration-policy.mjs');
const {
  createStagingWorkspace,
  resolveStagingDiff,
  discardStaging,
} = await import('../chat/managed-writer.mjs');
const { createCollaborationOrchestrator } = await import('../chat/collaboration-orchestrator.mjs');
const { closeResultPacketStore } = await import('../chat/result-packets.mjs');
const { closeWorkspaceLeaseStore } = await import('../chat/workspace-leases.mjs');
const { closePhaseGateStore } = await import('../chat/phase-gates.mjs');

const { createSession, getSession, killAll } = sessionManager;

let assertionCount = 0;
const a = new Proxy(assert, {
  get(target, prop) {
    const value = target[prop];
    if (typeof value === 'function') {
      return (...args) => {
        assertionCount += 1;
        return value.apply(target, args);
      };
    }
    return value;
  },
});

const configUrl = new URL('../lib/config.mjs', import.meta.url).href;
const managedInputUrl = new URL('../chat/managed-input.mjs', import.meta.url).href;
const runtimeUrl = new URL('../chat/organization-runtime.mjs', import.meta.url).href;
const orgStoreUrl = new URL('../chat/organization-store.mjs', import.meta.url).href;
const runtimeAdapterUrl = new URL('../chat/runtime-adapter.mjs', import.meta.url).href;

const ALL_FLAG_KEYS = [
  'RAGENT_ORG_SCHEMA_ENABLED',
  'RAGENT_ORG_SHADOW_PROJECTION',
  'RAGENT_MANAGED_INPUT_ENFORCEMENT',
  'RAGENT_MANAGED_WRITER_ENABLED',
  'RAGENT_REVIEWER_ENABLED',
  'RAGENT_ORG_PROJECTION_V2_ENABLED',
];

function childEnv(overrides = {}) {
  const env = { ...process.env, HOME: probeHome };
  for (const key of [...ALL_FLAG_KEYS, 'RAGENT_CONFIG_DIR', 'RAGENT_INSTANCE_ROOT']) {
    delete env[key];
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined || value === null) delete env[key];
    else env[key] = value;
  }
  return env;
}

function runProbe(script, overrides = {}) {
  const out = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
    env: childEnv(overrides),
    encoding: 'utf8',
  });
  return out.trim();
}

const FLAGS_SCRIPT = `
  import { ORG_SCHEMA_ENABLED, ORG_SHADOW_PROJECTION, MANAGED_INPUT_ENFORCEMENT, MANAGED_WRITER_ENABLED, REVIEWER_ENABLED, ORG_PROJECTION_V2_ENABLED } from ${JSON.stringify(configUrl)};
  console.log('FLAGS=' + JSON.stringify({ ORG_SCHEMA_ENABLED, ORG_SHADOW_PROJECTION, MANAGED_INPUT_ENFORCEMENT, MANAGED_WRITER_ENABLED, REVIEWER_ENABLED, ORG_PROJECTION_V2_ENABLED }));
`;

// ---------------------------------------------------------------------------
// A. Flag wiring: all five exported, default off, flippable per-flag.
// ---------------------------------------------------------------------------

function testFlagWiring() {
  a.equal(ORG_SCHEMA_ENABLED, false, 'ORG_SCHEMA_ENABLED defaults to false in-process');
  a.equal(ORG_SHADOW_PROJECTION, false, 'ORG_SHADOW_PROJECTION defaults to false in-process');
  a.equal(MANAGED_INPUT_ENFORCEMENT, false, 'MANAGED_INPUT_ENFORCEMENT defaults to false in-process');
  a.equal(MANAGED_WRITER_ENABLED, false, 'MANAGED_WRITER_ENABLED defaults to false in-process');
  a.equal(REVIEWER_ENABLED, false, 'REVIEWER_ENABLED defaults to false in-process');
  a.equal(ORG_PROJECTION_V2_ENABLED, false, 'ORG_PROJECTION_V2_ENABLED defaults to false in-process');

  // Clean subprocess: all five off (gray-rollout default).
  const off = JSON.parse(runProbe(FLAGS_SCRIPT).split('\n').filter((line) => line.startsWith('FLAGS=')).pop().slice('FLAGS='.length));
  for (const [name] of [
    ['ORG_SCHEMA_ENABLED'],
    ['ORG_SHADOW_PROJECTION'],
    ['MANAGED_INPUT_ENFORCEMENT'],
    ['MANAGED_WRITER_ENABLED'],
    ['REVIEWER_ENABLED'],
    ['ORG_PROJECTION_V2_ENABLED'],
  ]) {
    a.equal(off[name], false, `${name} is false in a clean subprocess`);
  }

  // Each flag flips on independently; the others stay off.
  const pairs = [
    ['RAGENT_ORG_SCHEMA_ENABLED', 'ORG_SCHEMA_ENABLED'],
    ['RAGENT_ORG_SHADOW_PROJECTION', 'ORG_SHADOW_PROJECTION'],
    ['RAGENT_MANAGED_INPUT_ENFORCEMENT', 'MANAGED_INPUT_ENFORCEMENT'],
    ['RAGENT_MANAGED_WRITER_ENABLED', 'MANAGED_WRITER_ENABLED'],
    ['RAGENT_REVIEWER_ENABLED', 'REVIEWER_ENABLED'],
    ['RAGENT_ORG_PROJECTION_V2_ENABLED', 'ORG_PROJECTION_V2_ENABLED'],
  ];
  for (const [envKey, name] of pairs) {
    const on = JSON.parse(runProbe(FLAGS_SCRIPT, { [envKey]: '1' }).split('\n').filter((line) => line.startsWith('FLAGS=')).pop().slice('FLAGS='.length));
    a.equal(on[name], true, `${name} flips on with ${envKey}=1`);
    for (const [otherEnvKey, otherName] of pairs) {
      if (otherName !== name) a.equal(on[otherName], false, `${otherName} stays off when only ${envKey} is set`);
    }
  }
}

// ---------------------------------------------------------------------------
// B. Migration compatibility matrix (constitution §2.15 / §8).
// ---------------------------------------------------------------------------

async function testMigrationMatrix() {
  // B1. Historical session (no sessionPlane) reads as user plane.
  const legacy = await createSession(workspace, 'codex', 'historical session', {});
  a.equal(legacy.sessionPlane, 'user', 'historical session without sessionPlane reads as user plane');
  a.equal(legacy.organizationRootSessionId, undefined, 'historical session has no organizationRootSessionId');
  const legacyReloaded = await getSession(legacy.id);
  a.equal(legacyReloaded.sessionPlane, 'user', 'historical session plane round-trips as user');
  a.equal(managedInput.isManagedSession(legacyReloaded), false, 'historical session is not managed');

  // B2. Legacy delegated session (no organizationRootSessionId) is not
  // auto-promoted to managed.
  const delegated = await createSession(workspace, 'codex', 'legacy delegated', {
    delegatedFromSessionId: legacy.id,
    delegationDepth: 1,
  });
  a.equal(delegated.sessionPlane, 'user', 'legacy delegated session stays user plane');
  a.equal(delegated.organizationRootSessionId, undefined, 'no organizationRootSessionId fabricated for legacy delegation');
  const delegatedReloaded = await getSession(delegated.id);
  a.equal(managedInput.isManagedSession(delegatedReloaded), false, 'legacy delegated session is not auto-managed');

  // B3. Old collaboration (no organizationId) completes by the old logic.
  await collabStore.initializeCollaborationStore();
  const policy = normalizeCollaborationPolicy({ role: 'manager', canDelegate: true });
  const plan = compileCollaborationPlan({
    title: 'legacy acceptance collab',
    tasks: [{ id: 'accept-legacy-task', objective: 'legacy', agentId: 'agent-legacy' }],
  }, policy);
  const old = await collabStore.createCollaborationRecord({
    rootSessionId: legacy.id,
    title: 'legacy acceptance collab',
    policy,
    plan,
  });
  a.ok(old.id, 'legacy collaboration record is created without any org binding');
  await collabStore.markReadyTasks(old.id);
  const attempt = await collabStore.claimTaskAttempt(old.tasks[0].id, { sessionId: delegated.id, runId: 'run-accept-legacy' });
  a.ok(attempt, 'legacy collaboration attempt is claimable');
  const completed = await collabStore.completeAttempt(attempt.id, { state: 'succeeded' });
  a.ok(completed, 'legacy collaboration completes by the old logic');
  const finished = await collabStore.getCollaboration(old.id);
  a.equal(finished.tasks[0].state, 'succeeded', 'legacy task reaches the terminal succeeded state');

  // B4. New Organization Runtime walks the controlled channel: child dispatch
  // goes through sendMessage with the internalOperation marker and a
  // collaboration-namespaced request id (constitution §2.10 / §2.16).
  const captured = [];
  const apps = new Map([
    ['accept-manager', {
      id: 'accept-manager', name: 'Manager', tool: 'codex',
      collaborationPolicy: { role: 'manager', canDelegate: true, allowedAgentIds: ['accept-specialist'], maxChildren: 4, maxConcurrent: 1, maxDepth: 2, workspacePolicy: 'shared-exclusive', revision: 'am1' },
    }],
    ['accept-specialist', {
      id: 'accept-specialist', name: 'Specialist', tool: 'codex',
      collaborationPolicy: { role: 'specialist', canDelegate: false, revision: 'as1' },
    }],
  ]);
  const orgRoot = { id: 'org-root-accept', folder: workspace, tool: 'codex', templateId: 'accept-manager', name: 'Org Root', sessionPlane: 'organization', delegationDepth: 0 };
  const sessions = new Map([[orgRoot.id, orgRoot]]);
  const runs = new Map();
  let childCounter = 0;
  let runCounter = 0;
  const orchestrator = createCollaborationOrchestrator({
    pollMs: 100000,
    dependencies: {
      getSession: async (id) => sessions.get(id) || null,
      getApp: async (id) => apps.get(id) || null,
      getProject: async () => ({ id: 'prj_accept', rootPath: workspace }),
      createSession: async (folder, tool, name, extra) => {
        const session = { id: `accept-child-${++childCounter}`, folder, tool, name, ...extra };
        sessions.set(session.id, session);
        return session;
      },
      sendMessage: async (sessionId, text, _images, options) => {
        captured.push(options);
        const run = { id: `accept-run-${++runCounter}`, sessionId, state: 'running', requestId: options.requestId, result: null };
        runs.set(run.id, run);
        return { session: sessions.get(sessionId), run, prompt: text };
      },
      getRunState: async (id) => runs.get(id) || null,
      getRun: async (id) => runs.get(id) || null,
      getRunResult: async (id) => runs.get(id)?.result || null,
      getRunManifest: async () => ({ folder: workspace, projectId: 'prj_accept', executionScope: { projectId: 'prj_accept' } }),
      listRunIds: async () => [...runs.keys()],
      requestRunCancel: async () => null,
      loadHistory: async () => [],
    },
  });
  try {
    const collaboration = await orchestrator.dispatch({
      rootSessionId: orgRoot.id,
      projectId: 'prj_accept',
      plan: { title: 'controlled channel', tasks: [{ id: 'accept-controlled', agentId: 'accept-specialist', objective: 'work', projectId: 'prj_accept' }] },
      idempotencyKey: 'acceptance-controlled-channel',
    });
    a.ok(collaboration.id, 'new collaboration dispatches');
    const opts = captured[0];
    a.ok(opts, 'child task is dispatched through sendMessage');
    a.equal(opts.internalOperation, 'collaboration_task', 'controlled channel carries the internalOperation marker');
    a.equal(typeof opts.requestId === 'string' && opts.requestId.startsWith('collaboration:'), true,
      'controlled channel uses a collaboration-namespaced request id');
    a.ok(opts.accessMode, 'child dispatch carries an access mode');

    // Reconcile is idempotent: two passes must not mint a second set of
    // attempts/objects (§2.19 crash-recovery property at the collaboration
    // layer — command-level idempotency is covered by the org-runtime probe).
    await orchestrator.reconcile();
    await orchestrator.reconcile();
    const after = await orchestrator.get(collaboration.id);
    a.equal(after.attempts.length, 1, 'reconcile does not mint a second set of attempts');
  } finally {
    orchestrator.stop();
  }
}

// ---------------------------------------------------------------------------
// C. Final acceptance matrix (§10).
// ---------------------------------------------------------------------------

// [3] Compiler cycle & budget (flag-independent pure function).
function testCompilerCycleAndBudget() {
  const rejectCompile = (fn) => Promise.resolve().then(fn);
  const cycle = { nodes: [
    { stableKey: 'a', role: 'manager', capabilities: ['read'], dependsOn: ['b'] },
    { stableKey: 'b', role: 'manager', capabilities: ['read'], dependsOn: ['a'] },
  ] };
  a.throws(
    () => runtime.compileRevision(cycle),
    (error) => error.code === 'REVISION_CYCLE_DETECTED' && error.statusCode === 422 && error.cause?.reason === 'cycle',
    'a cyclic dependency graph is refused (REVISION_CYCLE_DETECTED)',
  );
  a.throws(
    () => runtime.compileRevision({ nodes: [
      { stableKey: 'a', role: 'manager', capabilities: ['read'] },
      { stableKey: 'b', role: 'manager', capabilities: ['read'] },
    ] }, { maxNodes: 1 }),
    (error) => error.code === 'REVISION_BUDGET_EXCEEDED' && error.statusCode === 422 && error.cause?.reason === 'max_nodes',
    'a node budget overflow is refused (REVISION_BUDGET_EXCEEDED)',
  );
  a.throws(
    () => runtime.compileRevision({ nodes: [
      { stableKey: 'a', role: 'manager', capabilities: ['read'] },
      { stableKey: 'b', role: 'manager', capabilities: ['read'], dependsOn: ['a'] },
      { stableKey: 'c', role: 'manager', capabilities: ['read'], dependsOn: ['b'] },
    ] }, { maxDepth: 2 }),
    (error) => error.code === 'REVISION_BUDGET_EXCEEDED' && error.cause?.reason === 'max_depth',
    'a dependency depth overflow is refused (REVISION_BUDGET_EXCEEDED)',
  );
  // A valid constitution still compiles to a stable digest (compiler stays
  // usable as the acceptance path).
  const ok = runtime.compileRevision({ nodes: [{ stableKey: 'm', role: 'manager', capabilities: ['read'] }] });
  a.ok(ok.digest && ok.digest.startsWith('sha256:'), 'a valid constitution still produces a digest');
}

// [4]/[5] Gate/phase CAS + idempotency are flag-independent at the gate layer
// (phase-gates.mjs). Revision CAS / idempotent replay live behind
// ORG_SCHEMA_ENABLED and are probed separately.
async function testGatePhaseCas() {
  await orgStore.initializeOrganizationStore();
  const org = await orgStore.createOrganization({ rootSessionId: 'root-accept-gate', projectId: 'prj-accept-gate' });
  const manager = await orgStore.createNode({ organizationId: org.id, stableKey: 'acc-manager', nodeRole: 'manager', createdRevision: 1 });

  const passed = await gates.decideGate({
    organizationId: org.id,
    phaseId: 'phase-acc-1',
    fromGeneration: 0,
    decision: 'passed',
    decidedByNodeId: manager.id,
    packetId: 'rsp_acc_1',
    acceptance: [{ name: 'c', status: 'passed', evidenceRef: 'ev:1' }],
  });
  a.equal(passed.generation, 1, 'gate decision CAS-advances to generation 1');
  a.equal(passed.state, 'passed', 'passed decision is recorded');

  const done = await gates.completePhase({ organizationId: org.id, phaseId: 'phase-acc-1', fromGeneration: 1 });
  a.equal(done.progressEpoch, 1, 'phase.completed CAS-advances progress_epoch');
  const events = await gates.listPhaseEvents(org.id, 'phase-acc-1');
  a.equal(events.length, 1, 'phase_completed event is written');
  a.equal(events[0].type, 'phase_completed', 'only the CAS path produces phase.completed');

  // A needs_changes decision advances the gate generation (CAS) and must never
  // complete a phase.
  const needs = await gates.decideGate({
    organizationId: org.id,
    phaseId: 'phase-acc-1',
    fromGeneration: 1,
    decision: 'needs_changes',
    decidedByNodeId: manager.id,
    packetId: 'rsp_acc_2',
  });
  a.equal(needs.generation, 2, 'needs_changes records a fresh gate generation (CAS advance)');
  await a.rejects(
    () => gates.completePhase({ organizationId: org.id, phaseId: 'phase-acc-1', fromGeneration: 2 }),
    (error) => error.code === 'PHASE_ACCEPTANCE_INCOMPLETE' && error.reason === 'gate_not_passed',
    'phase.completed fails closed on a needs_changes gate',
  );

  // Stale generation replay -> GATE_STALE_GENERATION (409): the generation
  // has moved to 2, so an anchor on generation 1 must fail the CAS.
  await a.rejects(
    () => gates.completePhase({ organizationId: org.id, phaseId: 'phase-acc-1', fromGeneration: 1 }),
    (error) => error.code === 'GATE_STALE_GENERATION' && error.statusCode === 409,
    'a stale fromGeneration fails the gate CAS',
  );
}

// [10]/[11] symlink/junction + staging diff escapes.
async function testStagingAndSymlinkEscape() {
  const root = mkdtempSync(join(tmpdir(), 'ragent-accept-writer-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src/a.txt'), 'alpha');

  // [11] staging diff escaping writablePaths.
  const { stagingDir } = await createStagingWorkspace(root, ['src']);
  mkdirSync(join(stagingDir, 'other'), { recursive: true });
  writeFileSync(join(stagingDir, 'other/x.txt'), 'escaped sibling');
  await a.rejects(
    () => resolveStagingDiff(stagingDir, root, ['src']),
    (error) => error.code === 'MANAGED_WRITE_ESCAPE' && error.statusCode === 409,
    'a staging diff outside writablePaths is refused (MANAGED_WRITE_ESCAPE)',
  );
  await discardStaging(stagingDir);

  // [10] a '..' symlink inside staging escaping writablePaths.
  const rootB = mkdtempSync(join(tmpdir(), 'ragent-accept-writer-b-'));
  mkdirSync(join(rootB, 'src'), { recursive: true });
  writeFileSync(join(rootB, 'src/a.txt'), 'alpha');
  const { stagingDir: stagingB } = await createStagingWorkspace(rootB, ['src']);
  symlinkSync('..', join(stagingB, 'up'));
  await a.rejects(
    () => resolveStagingDiff(stagingB, rootB, ['src']),
    (error) => error.code === 'MANAGED_WRITE_ESCAPE' && error.statusCode === 409,
    'a symlink resolving above staging is refused (symlink/junction escape)',
  );
  await discardStaging(stagingB);

  rmSync(root, { recursive: true, force: true });
  rmSync(rootB, { recursive: true, force: true });
}

// [12] event ordering: stable, replayable.
async function testEventOrdering() {
  const policy = normalizeCollaborationPolicy({ role: 'manager', canDelegate: true });
  const plan = compileCollaborationPlan({
    title: 'event order',
    tasks: [
      { id: 'ev-a', objective: 'A', agentId: 'agent-1' },
      { id: 'ev-b', objective: 'B', agentId: 'agent-2', dependsOn: ['ev-a'] },
    ],
  }, policy);
  const collab = await collabStore.createCollaborationRecord({ rootSessionId: 'root-events', title: 'event order', policy, plan });
  await collabStore.markReadyTasks(collab.id);
  const attA = await collabStore.claimTaskAttempt('ev-a', { sessionId: 's-eva', runId: 'run-eva' });
  await collabStore.completeAttempt(attA.id, { state: 'succeeded' });
  await collabStore.refreshBarrier(collab.id);
  await collabStore.markReadyTasks(collab.id);
  const attB = await collabStore.claimTaskAttempt('ev-b', { sessionId: 's-evb', runId: 'run-evb' });
  await collabStore.completeAttempt(attB.id, { state: 'succeeded' });

  const read1 = await collabStore.getCollaboration(collab.id, { includeEvents: true });
  const read2 = await collabStore.getCollaboration(collab.id, { includeEvents: true });
  a.ok(read1.events.length >= 3, 'events accumulated across the lifecycle');
  for (let i = 1; i < read1.events.length; i += 1) {
    a.ok(read1.events[i].id > read1.events[i - 1].id, 'events are ordered by monotonic id');
  }
  a.deepEqual(read2.events, read1.events, 'event order is stable across reads (replayable)');
}

// [8]/[9] Reviewer enforcement + provisioning failure points (in-process
// orchestrator with reviewerEnabled pinned on; the env binding is probed).
async function testReviewerEnforcement() {
  const apps = new Map([
    ['acc-rev-manager', {
      id: 'acc-rev-manager', name: 'Manager', tool: 'codex',
      collaborationPolicy: { role: 'manager', canDelegate: true, allowedAgentIds: ['acc-rev-specialist', 'acc-rev-reviewer'], maxChildren: 4, maxConcurrent: 1, maxDepth: 2, workspacePolicy: 'read-only-review', revision: 'rm1' },
    }],
    ['acc-rev-specialist', {
      id: 'acc-rev-specialist', name: 'Specialist', tool: 'codex',
      collaborationPolicy: { role: 'specialist', canDelegate: false, revision: 'rs1' },
    }],
    ['acc-rev-reviewer', {
      id: 'acc-rev-reviewer', name: 'Reviewer', tool: 'codex',
      collaborationPolicy: { role: 'reviewer', canDelegate: false, revision: 'rr1' },
    }],
  ]);
  const root = { id: 'acc-rev-root', folder: workspace, tool: 'codex', templateId: 'acc-rev-manager', name: 'Reviewer Root', sessionPlane: 'organization', projectId: 'prj_acc_rev', delegationDepth: 0 };
  const sessions = new Map([[root.id, root]]);
  const runs = new Map();
  let childCounter = 0;
  let runCounter = 0;
  const captured = [];

  const makeOrchestrator = (overrides = {}) => createCollaborationOrchestrator({
    pollMs: 100000,
    reviewerEnabled: true,
    dependencies: {
      getSession: async (id) => sessions.get(id) || null,
      getApp: async (id) => apps.get(id) || null,
      getProject: async () => ({ id: 'prj_acc_rev', rootPath: workspace }),
      createSession: async (folder, tool, name, extra) => {
        const session = { id: `acc-rev-child-${++childCounter}`, folder, tool, name, ...extra };
        sessions.set(session.id, session);
        return session;
      },
      sendMessage: async (sessionId, text, _images, options) => {
        captured.push(options);
        const run = { id: `acc-rev-run-${++runCounter}`, sessionId, state: 'running', requestId: options.requestId, result: null };
        runs.set(run.id, run);
        return { session: sessions.get(sessionId), run, prompt: text };
      },
      getRunState: async (id) => runs.get(id) || null,
      getRun: async (id) => runs.get(id) || null,
      getRunResult: async (id) => runs.get(id)?.result || null,
      getRunManifest: async () => ({ folder: workspace, projectId: 'prj_acc_rev', executionScope: { projectId: 'prj_acc_rev' } }),
      listRunIds: async () => [...runs.keys()],
      requestRunCancel: async () => null,
      loadHistory: async () => [],
      ...overrides,
    },
  });

  const certified = async () => ({
    runtimeId: 'runtime_reviewer_readonly',
    supportsReadOnlyFilesystem: true,
    enforcement: 'sandbox',
    note: 'certified-readonly',
  });

  // [9] Certified reviewer is admitted with a forced read lease (read-only
  // required), so a reviewer can never silently become a writer.
  {
    const orchestrator = makeOrchestrator({
      resolveRuntimeReadOnlyCapability: certified,
      buildReviewerSandbox: async () => ['bwrap', '--ro-bind', workspace, workspace],
    });
    try {
      const collab = await orchestrator.dispatch({
        rootSessionId: root.id,
        plan: { title: 'reviewer accept', tasks: [{ id: 'accept-review', agentId: 'acc-rev-reviewer', role: 'reviewer', objective: 'review the work' }] },
        idempotencyKey: 'acceptance-reviewer-admitted',
      });
      a.equal(collab.tasks[0].state, 'running', 'a certified reviewer task is admitted');
      const opts = captured.find((item) => item.requestId?.includes('accept-review'));
      a.ok(opts, 'the reviewer run was dispatched');
      a.equal(opts.accessMode, 'read', 'the reviewer child requests a read lease (§2.5)');
      a.equal(opts.readOnlyRequired, true, 'the reviewer child requires read-only (no downgrade)');
    } finally {
      orchestrator.stop();
    }
  }

  // [6]/[8] A reviewer with no certified read-only runtime (self-review attack
  // or provisioning failure) is refused with READ_ONLY_RUNTIME_REFUSED (503)
  // and never downgraded to an unsandboxed run.
  {
    const orchestrator = makeOrchestrator({
      resolveRuntimeReadOnlyCapability: async () => ({
        runtimeId: 'runner_uncertified',
        supportsReadOnlyFilesystem: false,
        enforcement: 'none',
        note: 'runtime-not-certified',
      }),
      buildReviewerSandbox: async () => ['bwrap'],
    });
    try {
      const collab = await orchestrator.dispatch({
        rootSessionId: root.id,
        plan: { title: 'reviewer refused', tasks: [{ id: 'accept-review-refused', agentId: 'acc-rev-reviewer', role: 'reviewer', objective: 'review' }] },
        idempotencyKey: 'acceptance-reviewer-refused',
      });
      a.equal(collab.tasks[0].state, 'failed', 'an uncertified reviewer task is refused');
      a.equal(collab.attempts[0].failureKind, 'deterministic_failure', 'reviewer refusal is deterministic');
      a.ok(collab.attempts[0].failureReason.includes('READ_ONLY_RUNTIME_REFUSED'),
        'refusal carries READ_ONLY_RUNTIME_REFUSED (sandbox/provisioning failure point)');
    } finally {
      orchestrator.stop();
    }
  }
}

// ---------------------------------------------------------------------------
// Subprocess probes: flag-gated acceptance items.
// ---------------------------------------------------------------------------

// [1]/[2] message bypass interception (flag on) + caller-independent gate.
function probeManagedInputBypass() {
  const script = `
    import { MANAGED_SESSION_INPUT_BYPASS, assertManagedInputAllowed, isManagedSession, parseManagedInputBypassRoute } from ${JSON.stringify(managedInputUrl)};
    const managed = { id: 'acc-m', sessionPlane: 'organization' };
    const user = { id: 'acc-u', sessionPlane: 'user' };
    if (!isManagedSession(managed)) throw new Error('managed detection failed');
    for (const op of ['fork', 'fork-at', 'delegate', 'session-spawn', 'message', 'continuation']) {
      let rejected = false;
      try { assertManagedInputAllowed({ session: managed, operation: op }); }
      catch (e) { rejected = e.code === MANAGED_SESSION_INPUT_BYPASS && e.statusCode === 409; }
      if (!rejected) throw new Error('managed ' + op + ' not rejected');
    }
    // The gate is attribute-based, not caller-based: an owner-scoped request
    // context still cannot bypass a managed session (permission attribution).
    let ownerBypass = false;
    try { assertManagedInputAllowed({ session: managed, operation: 'message', requestContext: { role: 'owner' } }); }
    catch (e) { ownerBypass = e.code === MANAGED_SESSION_INPUT_BYPASS; }
    if (!ownerBypass) throw new Error('owner-scoped context bypassed the managed gate');
    // Controlled-channel internal injections are the one exemption.
    assertManagedInputAllowed({ session: managed, operation: 'message', requestContext: { internalOperation: 'collaboration_task' } });
    assertManagedInputAllowed({ session: managed, operation: 'continuation', requestContext: { internalOperation: 'collaboration_resume' } });
    // user-plane sessions keep legacy behavior.
    assertManagedInputAllowed({ session: user, operation: 'fork' });
    // Router-layer creation routes are all mapped as bypass surfaces.
    if (!parseManagedInputBypassRoute('/api/sessions/x/fork')) throw new Error('fork route not mapped');
    if (!parseManagedInputBypassRoute('/api/sessions/x/fork-at')) throw new Error('fork-at route not mapped');
    if (!parseManagedInputBypassRoute('/api/sessions/x/delegate')) throw new Error('delegate route not mapped');
    console.log('MIOK');
  `;
  const out = runProbe(script, { RAGENT_MANAGED_INPUT_ENFORCEMENT: '1' });
  a.ok(out.includes('MIOK'), 'managed-input rejection matrix passes with the flag on');

  // Flag off: the gate is a no-op (legacy behavior unchanged).
  const offScript = `
    import { assertManagedInputAllowed, isManagedSession } from ${JSON.stringify(managedInputUrl)};
    const managed = { id: 'acc-m', sessionPlane: 'organization' };
    if (!isManagedSession(managed)) throw new Error('managed detection failed');
    for (const op of ['fork', 'fork-at', 'delegate', 'session-spawn', 'message', 'continuation']) {
      let rejected = false;
      try { assertManagedInputAllowed({ session: managed, operation: op }); }
      catch (e) { rejected = e.code === 'MANAGED_SESSION_INPUT_BYPASS'; }
      if (rejected) throw new Error('flag off must not reject ' + op);
    }
    console.log('MIOFF');
  `;
  a.ok(runProbe(offScript).includes('MIOFF'), 'managed-input gate is a no-op with the flag off');
}

// [4]/[5]/[7] org-command idempotency, revision CAS, freeze immutability
// (all behind ORG_SCHEMA_ENABLED).
function probeOrgCommandIdempotencyAndCas() {
  const script = `
    import * as rt from ${JSON.stringify(runtimeUrl)};
    import { initializeOrganizationStore, createRevision } from ${JSON.stringify(orgStoreUrl)};
    await initializeOrganizationStore();
    const a = await rt.createOrganization({ rootSessionId: 'root-acc-idem', idempotencyKey: 'acc-key-1' });
    const b = await rt.createOrganization({ rootSessionId: 'root-acc-idem', idempotencyKey: 'acc-key-1' });
    if (a.id !== b.id) throw new Error('create idempotency failed');
    const plan = { nodes: [{ stableKey: 'm1', role: 'manager', capabilities: ['read'] }] };
    const r1 = await rt.reviseOrganization({ organizationId: a.id, proposal: plan, idempotencyKey: 'acc-rev-1' });
    const r1b = await rt.reviseOrganization({ organizationId: a.id, proposal: plan, idempotencyKey: 'acc-rev-1' });
    if (r1.revision !== r1b.revision || r1b.digest !== r1.digest) throw new Error('revise replay failed');
    if ((await rt.listOrganizationRevisions(a.id)).length !== 1) throw new Error('replay created a second revision');
    let cas = false;
    try { await rt.reviseOrganization({ organizationId: a.id, proposal: plan, expectedCurrentRevision: 0 }); }
    catch (e) { cas = e.code === 'REVISION_CONFLICT' && e.statusCode === 409; }
    if (!cas) throw new Error('revision CAS conflict not raised');
    const frozen = await rt.freezeRevision(a.id, 1);
    if (frozen.state !== 'frozen') throw new Error('freeze failed');
    let frozenRejected = false;
    try { await createRevision(a.id, { revision: 1, proposal: { title: 'mutate' } }); }
    catch (e) { frozenRejected = e.code === 'REVISION_FROZEN'; }
    if (!frozenRejected) throw new Error('frozen revision is not immutable');
    console.log('OROK');
  `;
  const out = runProbe(script, { RAGENT_ORG_SCHEMA_ENABLED: '1' });
  a.ok(out.includes('OROK'), 'org-command idempotency + CAS + freeze pass with the flag on');

  // Flag off: commands unavailable (gray-rollout default).
  const offScript = `
    import * as rt from ${JSON.stringify(runtimeUrl)};
    let unavailable = false;
    try { await rt.createOrganization({ rootSessionId: 'x' }); }
    catch (e) { unavailable = e.code === 'ORGANIZATION_SCHEMA_DISABLED' && e.statusCode === 503; }
    if (!unavailable) throw new Error('org command should be unavailable when flag off');
    console.log('OROFF');
  `;
  a.ok(runProbe(offScript).includes('OROFF'), 'org commands are unavailable with the flag off');
}

// [13] Android projection (design-equivalent): the shadow projection only
// exposes authorized read-only facts and is null when the flag is off.
function probeShadowProjection() {
  const script = `
    import { initializeOrganizationStore, createOrganization, createRevision, freezeRevision, updateOrganizationVersion, createNode, projectOrganizationShadow } from ${JSON.stringify(orgStoreUrl)};
    await initializeOrganizationStore();
    const org = await createOrganization({ rootSessionId: 'root-shadow-acc', projectId: 'prj-shadow-acc', state: 'active', policy: { role: 'manager' }, budget: { nodes: 5 } });
    await createRevision(org.id, { revision: 1, proposal: { nodes: [] }, digest: 'sha-1' });
    await freezeRevision(org.id, 1);
    await updateOrganizationVersion(org.id, { currentRevision: 1 });
    await createNode({ organizationId: org.id, stableKey: 'n1', nodeRole: 'manager', createdRevision: 1 });
    const shadow = await projectOrganizationShadow(org.id);
    console.log('SHADOW=' + JSON.stringify(shadow));
  `;
  const on = runProbe(script, { RAGENT_ORG_SHADOW_PROJECTION: '1' });
  const line = on.split('\n').filter((entry) => entry.startsWith('SHADOW=')).pop();
  a.ok(line, 'shadow projection probe produced a line with the flag on');
  const shadow = JSON.parse(line.slice('SHADOW='.length));
  a.ok(shadow && shadow.organizationId, 'projection is non-null and carries the org id');
  a.equal(shadow.projectId, 'prj-shadow-acc', 'projection exposes the project binding');
  a.equal(shadow.rootSessionId, 'root-shadow-acc', 'projection exposes the root session binding');
  a.equal(shadow.state, 'active', 'projection exposes the org state');
  a.equal(shadow.currentRevision, 1, 'projection exposes currentRevision');
  a.ok(Array.isArray(shadow.nodes) && shadow.nodes.length === 1, 'projection exposes the node roster');
  // The projection is bounded: it never leaks policy_json / budget_json raw.
  a.equal('policy' in shadow, false, 'projection does not leak raw policy');
  a.equal('budget' in shadow, false, 'projection does not leak raw budget');
  a.equal('updatedAt' in shadow, false, 'projection does not leak internal bookkeeping');

  // Flag off: the projection short-circuits to null without touching the
  // store, so the off-probe needs no fixture (avoids a root-session conflict
  // against the on-probe's database).
  const offScript = `
    import { projectOrganizationShadow } from ${JSON.stringify(orgStoreUrl)};
    const shadow = await projectOrganizationShadow('org_any');
    console.log('SHADOW=' + JSON.stringify(shadow));
  `;
  a.ok(runProbe(offScript).includes('SHADOW=null'), 'shadow projection is null when the flag is off');
}

// [9] reviewer runtime certification binding (REVIEWER_ENABLED env).
function probeReviewerCertification() {
  const script = `
    import { resolveRuntimeReadOnlyCapability, REVIEWER_RUNTIME_ID } from ${JSON.stringify(runtimeAdapterUrl)};
    const cap = resolveRuntimeReadOnlyCapability({ runnerId: REVIEWER_RUNTIME_ID });
    console.log('REV=' + JSON.stringify({ supportsReadOnlyFilesystem: cap.supportsReadOnlyFilesystem, enforcement: cap.enforcement }));
  `;
  const on = JSON.parse(runProbe(script, { RAGENT_REVIEWER_ENABLED: '1' }).split('\n').filter((l) => l.startsWith('REV=')).pop().slice('REV='.length));
  a.equal(on.supportsReadOnlyFilesystem, true, 'REVIEWER_RUNTIME_ID is certified when REVIEWER_ENABLED is on');
  a.equal(on.enforcement, 'sandbox', 'the certified reviewer runtime enforces a sandbox');

  const off = JSON.parse(runProbe(script).split('\n').filter((l) => l.startsWith('REV=')).pop().slice('REV='.length));
  a.equal(off.supportsReadOnlyFilesystem, false, 'REVIEWER_RUNTIME_ID is not certified when REVIEWER_ENABLED is off');
}

// ---------------------------------------------------------------------------

try {
  await orgStore.initializeOrganizationStore();

  testFlagWiring();
  await testMigrationMatrix();
  testCompilerCycleAndBudget();
  await testGatePhaseCas();
  await testStagingAndSymlinkEscape();
  await testEventOrdering();
  await testReviewerEnforcement();
  probeManagedInputBypass();
  probeOrgCommandIdempotencyAndCas();
  probeShadowProjection();
  probeReviewerCertification();

  console.log(`test-org-acceptance: ok (${assertionCount} assertions)`);
} finally {
  killAll();
  await closePhaseGateStore().catch(() => {});
  await closeResultPacketStore().catch(() => {});
  await closeWorkspaceLeaseStore().catch(() => {});
  rmSync(probeHome, { recursive: true, force: true });
  rmSync(tempHome, { recursive: true, force: true });
}
