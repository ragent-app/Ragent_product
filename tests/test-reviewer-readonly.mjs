#!/usr/bin/env node
// S12: certified read-only reviewer runtime (Organization Constitution §6.1).
//
// Covers the reviewer read-only enforcement end to end:
//   1. bwrap arg construction: readOnly=true mounts the run workspace with
//      --ro-bind (never --bind RW for it); the default stays RW; the runner
//      home stays read-only so aliases cannot reopen workspace files.
//   2. runtime-adapter certification: only REVIEWER_RUNTIME_ID is certified
//      while REVIEWER_ENABLED is on; every other runtime keeps the honest
//      default (supportsReadOnlyFilesystem=false). The off state is verified
//      in a child process so the module-level flag can be flipped.
//   3. run admission: a reviewer read request against the certified runtime
//      keeps accessMode 'read' (read lease, no downgrade); a readOnlyRequired
//      request without a certified runtime refuses with
//      READ_ONLY_RUNTIME_UNAVAILABLE (409, S4 regression).
//   4. orchestrator reviewer enforcement: capability-insufficient or a failed
//      read-only sandbox build refuses the reviewer with
//      READ_ONLY_RUNTIME_REFUSED (503) and never downgrades to an unsandboxed
//      run; a certified runtime + buildable sandbox admits the reviewer with a
//      read lease (accessMode read + readOnlyRequired + reviewer runner id);
//      reviewerEnabled=false keeps the S6 reader code (409) unchanged.
import assert from 'assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

const configDir = mkdtempSync(join(tmpdir(), 'agentoc-reviewer-readonly-'));
process.env.AGENTOC_CONFIG_DIR = configDir;
// S12 is on for this process so the runtime-adapter certification branch is
// active; each scenario that needs the off state pins it explicitly (either
// with an injected resolver or through a child process below).
process.env.AGENTOC_REVIEWER_ENABLED = '1';

const {
  buildBwrapArgs,
  buildSandboxedSpawn,
} = await import('../lib/runner-sandbox.mjs');
const {
  resolveRuntimeReadOnlyCapability,
  REVIEWER_RUNTIME_ID,
  registerRuntimeAdapter,
  buildReviewerReadOnlySandbox,
} = await import('../chat/runtime-adapter.mjs');
const { prepareRunExecution } = await import('../chat/run-admission.mjs');
const { createProject } = await import('../chat/projects.mjs');
const { createCollaborationOrchestrator } = await import('../chat/collaboration-orchestrator.mjs');

const createdDirs = [];
function makeDir(prefix) {
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
function rejects(promiseFactory, predicate, message) {
  countAssertions();
  return assert.rejects(promiseFactory, predicate, message);
}
const sections = [];
function finishSection() {
  if (currentSection) sections.push(currentSection);
  currentSection = null;
}

// The bind flag bwrap uses for `path` (`--bind` or `--ro-bind`), or null.
function bindModeOf(args, path) {
  for (let i = 0; i < args.length - 2; i += 1) {
    if ((args[i] === '--bind' || args[i] === '--ro-bind') && args[i + 1] === path && args[i + 2] === path) {
      return args[i];
    }
  }
  return null;
}

try {
  // ── 1) bwrap arg construction: readOnly variant + unchanged default ────────
  beginSection('bwrap-args');

  const ws = makeDir('agentoc-reviewer-ws-');
  const rh = makeDir('agentoc-reviewer-home-');
  const hide = join(configDir, 'agentoc-reviewer-hide');
  mkdirSync(hide, { recursive: true });

  // readOnly=true: the run workspace is mounted with --ro-bind and never with
  // a RW --bind; the runner home is not reopened writable.
  const roArgs = buildBwrapArgs({
    command: '/bin/true',
    args: ['--flag'],
    cwd: ws,
    runnerHome: rh,
    readOnly: true,
  });
  eq(bindModeOf(roArgs, ws), '--ro-bind', 'readOnly=true mounts the workspace with --ro-bind');
  eq(bindModeOf(roArgs, rh), null, 'runner home stays read-only under readOnly=true');
  ok(roArgs.includes('--ro-bind') && roArgs[roArgs.indexOf('--ro-bind') + 1] === '/', 'root stays read-only');
  ok(roArgs[roArgs.indexOf('--') + 1] === '/bin/true', 'command follows the -- separator');
  ok(roArgs.includes('--flag'), 'tool args preserved');

  // buildReviewerReadOnlySandbox is the runtime-adapter wrapper the reviewer
  // admission path uses; it must produce the same read-only workspace binding.
  const roWrapper = buildReviewerReadOnlySandbox({ command: '/bin/true', cwd: ws, runnerHome: rh });
  eq(bindModeOf(roWrapper, ws), '--ro-bind', 'buildReviewerReadOnlySandbox binds the workspace read-only');
  eq(bindModeOf(roWrapper, rh), null, 'buildReviewerReadOnlySandbox does not reopen the runner home');

  // default readOnly=false keeps the exact pre-S12 behavior: workspace --bind RW.
  const rwArgs = buildBwrapArgs({ command: '/bin/true', cwd: ws, runnerHome: rh });
  eq(bindModeOf(rwArgs, ws), '--bind', 'default bwrap args bind the workspace read-write');
  eq(bindModeOf(rwArgs, rh), '--bind', 'default bwrap args bind the runner home read-write');

  const defaultSpawn = buildSandboxedSpawn({ command: '/bin/true', cwd: ws, runnerHome: rh, mkdtemp: () => hide });
  eq(bindModeOf(defaultSpawn.args, ws), '--bind', 'buildSandboxedSpawn default keeps the workspace RW');
  eq(defaultSpawn.sandboxed, true, 'sandboxed flag stays true');

  const roSpawn = buildSandboxedSpawn({ command: '/bin/true', cwd: ws, runnerHome: rh, readOnly: true, mkdtemp: () => hide });
  eq(bindModeOf(roSpawn.args, ws), '--ro-bind', 'buildSandboxedSpawn readOnly=true mounts the workspace read-only');
  eq(bindModeOf(roSpawn.args, rh), null, 'buildSandboxedSpawn readOnly=true does not reopen the runner home');

  finishSection();

  // ── 2) runtime-adapter certification ───────────────────────────────────────
  beginSection('runtime-certification');

  eq(resolveRuntimeReadOnlyCapability({ runnerId: REVIEWER_RUNTIME_ID }).supportsReadOnlyFilesystem, true,
    'REVIEWER_RUNTIME_ID is certified while REVIEWER_ENABLED is on');
  eq(resolveRuntimeReadOnlyCapability({ runnerId: REVIEWER_RUNTIME_ID }).enforcement, 'sandbox',
    'certified reviewer runtime enforces a sandbox');
  eq(resolveRuntimeReadOnlyCapability({ runnerId: REVIEWER_RUNTIME_ID, platform: 'darwin' }).supportsReadOnlyFilesystem, false,
    'macOS must not claim the Linux-only reviewer sandbox');

  eq(resolveRuntimeReadOnlyCapability({ runnerId: 'runner_uncertified' }).supportsReadOnlyFilesystem, false,
    'an unrelated runner keeps the honest uncertified default');
  eq(resolveRuntimeReadOnlyCapability({ toolId: 'codex' }).supportsReadOnlyFilesystem, false,
    'a bare toolId is not certified');

  // An explicitly registered adapter wins over the built-in branch.
  const unregister = registerRuntimeAdapter('runtime_custom_ro', {
    runtimeId: 'runtime_custom_ro',
    supportsReadOnlyFilesystem: true,
    enforcement: 'sandbox',
    note: 'test-registered',
  });
  const registered = resolveRuntimeReadOnlyCapability({ runnerId: 'runtime_custom_ro' });
  eq(registered.supportsReadOnlyFilesystem, true, 'a registered read-only adapter is honored');
  eq(registered.runtimeId, 'runtime_custom_ro', 'registered adapter carries its own runtime id');
  unregister();
  eq(resolveRuntimeReadOnlyCapability({ runnerId: 'runtime_custom_ro' }).supportsReadOnlyFilesystem, false,
    'unregistering restores the honest default');

  finishSection();

  // ── 3) run admission: reviewer read lease ─────────────────────────────────
  beginSection('admission-read-lease');

  const root = makeDir('agentoc-reviewer-adm-root-');
  mkdirSync(join(root, '.git'), { recursive: true });
  const project = await createProject({ name: 'Reviewer Admission', rootPath: root });
  const session = { id: 's_rev', folder: root, projectId: project.id, templateId: 'app_rev' };
  const manifest = { sessionId: 's_rev', requestId: 'req_rev', folder: root, tool: 'codex', prompt: 'review' };

  const admitted = await prepareRunExecution({
    sessionId: 's_rev',
    session,
    manifest,
    options: { accessMode: 'read', readOnlyRequired: true, runnerId: REVIEWER_RUNTIME_ID },
  });
  eq(admitted.accessMode, 'read', 'reviewer read admission keeps accessMode read (read lease)');
  eq(admitted.executionScope.accessMode, 'read', 'the frozen snapshot freezes accessMode read');
  eq(admitted.runtimeCapability.supportsReadOnlyFilesystem, true, 'admission carries the certified capability proof');
  eq(admitted.readOnlyDowngrade, undefined, 'a certified reviewer is never downgraded to a write lease');

  // readOnlyRequired without a certified runtime is the S4 regression: refused
  // with READ_ONLY_RUNTIME_UNAVAILABLE (409), never silently run as a writer.
  await rejects(
    () => prepareRunExecution({
      sessionId: 's_rev2',
      session,
      manifest: { ...manifest, sessionId: 's_rev2' },
      options: { accessMode: 'read', readOnlyRequired: true, runnerId: 'runner_uncertified' },
    }),
    (error) => error.code === 'READ_ONLY_RUNTIME_UNAVAILABLE'
      && error.statusCode === 409
      && error.downgrade?.reason === 'runtime-not-certified',
    'readOnlyRequired without a certified runtime refuses with READ_ONLY_RUNTIME_UNAVAILABLE (409)',
  );

  finishSection();

  // ── 4) reviewer certification off-state (child process) ───────────────────
  beginSection('certification-off-state');

  const childEnv = { ...process.env, AGENTOC_CONFIG_DIR: configDir };
  delete childEnv.AGENTOC_REVIEWER_ENABLED;
  const childScript = `
    import { resolveRuntimeReadOnlyCapability, REVIEWER_RUNTIME_ID } from ${JSON.stringify(pathToFileURL(join(repoRoot, 'chat/runtime-adapter.mjs')).href)};
    const cap = resolveRuntimeReadOnlyCapability({ runnerId: REVIEWER_RUNTIME_ID });
    console.log(JSON.stringify({ supportsReadOnlyFilesystem: cap.supportsReadOnlyFilesystem, note: cap.note }));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', childScript], {
    env: childEnv,
    encoding: 'utf8',
  });
  eq(child.status, 0, `child process resolves the off-state capability (stderr: ${child.stderr.trim()})`);
  const offState = JSON.parse(child.stdout.trim());
  eq(offState.supportsReadOnlyFilesystem, false, 'REVIEWER_RUNTIME_ID is NOT certified when REVIEWER_ENABLED is off');
  eq(offState.note, 'runtime-not-certified', 'the off state reports the honest runtime-not-certified note');

  finishSection();

  // ── 5) orchestrator reviewer enforcement ───────────────────────────────────
  beginSection('orchestrator-reviewer');

  const apps = new Map([
    ['manager-agent', {
      id: 'manager-agent',
      name: 'Manager',
      tool: 'codex',
      collaborationPolicy: {
        role: 'manager', canDelegate: true, allowedAgentIds: ['specialist-agent', 'reviewer-agent'],
        maxChildren: 4, maxConcurrent: 1, maxDepth: 2, workspacePolicy: 'read-only-review', revision: 'm1',
      },
    }],
    ['specialist-agent', {
      id: 'specialist-agent',
      name: 'Specialist',
      tool: 'codex',
      collaborationPolicy: { role: 'specialist', canDelegate: false, revision: 's1' },
    }],
    ['reviewer-agent', {
      id: 'reviewer-agent',
      name: 'Reviewer',
      tool: 'codex',
      collaborationPolicy: { role: 'reviewer', canDelegate: false, revision: 'r1' },
    }],
  ]);
  const rootSession = {
    id: 'reviewer-root',
    folder: configDir,
    tool: 'codex',
    templateId: 'manager-agent',
    name: 'Reviewer Manager',
    projectId: 'prj_reviewer',
    delegationDepth: 0,
  };
  const sessions = new Map([[rootSession.id, rootSession]]);
  const runs = new Map();
  let childCounter = 0;
  let runCounter = 0;

  function makeOrchestrator(overrides = {}) {
    const captured = [];
    return {
      captured,
      orchestrator: createCollaborationOrchestrator({
        pollMs: 100000,
        reviewerEnabled: true,
        dependencies: {
          getSession: async (id) => sessions.get(id) || null,
          getApp: async (id) => apps.get(id) || null,
          getProject: async () => ({ id: 'prj_reviewer', rootPath: configDir }),
          createSession: async (_folder, tool, name, extra) => {
            const session = { id: `reviewer-child-${++childCounter}`, folder: configDir, tool, name, ...extra };
            sessions.set(session.id, session);
            return session;
          },
          sendMessage: async (sessionId, text, _images, options) => {
            captured.push(options);
            const run = { id: `reviewer-run-${++runCounter}`, sessionId, state: 'running', requestId: options.requestId, result: null };
            runs.set(run.id, run);
            return { session: sessions.get(sessionId), run, prompt: text };
          },
          getRunState: async (id) => runs.get(id) || null,
          getRun: async (id) => runs.get(id) || null,
          getRunResult: async (id) => runs.get(id)?.result || null,
          getRunManifest: async () => ({ folder: configDir }),
          listRunIds: async () => [...runs.keys()],
          requestRunCancel: async (id) => {
            const run = runs.get(id);
            if (run) run.state = 'cancelled';
            return run || null;
          },
          loadHistory: async () => [],
          ...overrides,
        },
      }),
    };
  }

  const certified = async () => ({
    runtimeId: REVIEWER_RUNTIME_ID,
    supportsReadOnlyFilesystem: true,
    enforcement: 'sandbox',
    note: 'certified-readonly-bwrap',
  });

  // 5a) certified runtime + buildable sandbox -> reviewer admitted with a read
  //     lease (accessMode read + readOnlyRequired + reviewer runner id).
  {
    const { orchestrator, captured } = makeOrchestrator({
      resolveRuntimeReadOnlyCapability: certified,
      buildReviewerSandbox: async () => ['bwrap', '--ro-bind', configDir, configDir],
    });
    const collaboration = await orchestrator.dispatch({
      rootSessionId: rootSession.id,
      plan: {
        title: 'reviewer runtime',
        tasks: [{ id: 'review-task', agentId: 'reviewer-agent', role: 'reviewer', objective: 'review the work' }],
      },
      idempotencyKey: 'reviewer-admitted',
    });
    const task = collaboration.tasks.find((candidate) => candidate.id === 'review-task');
    eq(task.state, 'running', 'a certified reviewer task is admitted and running');
    ok(captured.length >= 1, 'the reviewer run is dispatched through sendMessage');
    const opts = captured[0];
    eq(opts.accessMode, 'read', 'the reviewer child requests a read lease');
    eq(opts.readOnlyRequired, true, 'the reviewer child requires read-only (no downgrade)');
    eq(opts.runnerId, REVIEWER_RUNTIME_ID, 'the reviewer child is dispatched on the certified reviewer runtime');
    orchestrator.stop();
  }

  // 5b) capability-insufficient -> READ_ONLY_RUNTIME_REFUSED (503), never a
  //     silent writer; the attempt is a deterministic failure.
  {
    const { orchestrator } = makeOrchestrator({
      resolveRuntimeReadOnlyCapability: async () => ({
        runtimeId: 'runner_uncertified',
        supportsReadOnlyFilesystem: false,
        enforcement: 'none',
        note: 'runtime-not-certified',
      }),
      buildReviewerSandbox: async () => ['bwrap'],
    });
    const collaboration = await orchestrator.dispatch({
      rootSessionId: rootSession.id,
      plan: {
        title: 'reviewer refused',
        tasks: [{ id: 'review-refused', agentId: 'reviewer-agent', role: 'reviewer', objective: 'review' }],
      },
      idempotencyKey: 'reviewer-refused-capability',
    });
    const task = collaboration.tasks.find((candidate) => candidate.id === 'review-refused');
    eq(task.state, 'failed', 'an uncertified reviewer task is refused');
    eq(collaboration.attempts[0].failureKind, 'deterministic_failure', 'reviewer refusal is deterministic (no retry)');
    ok(collaboration.attempts[0].failureReason.includes('READ_ONLY_RUNTIME_REFUSED'),
      'refusal reason carries READ_ONLY_RUNTIME_REFUSED');
    orchestrator.stop();
  }

  // 5c) sandbox build failure -> READ_ONLY_RUNTIME_REFUSED (503) / refusal,
  //     even though the runtime is certified. No downgrade to unsandboxed.
  {
    const { orchestrator } = makeOrchestrator({
      resolveRuntimeReadOnlyCapability: certified,
      buildReviewerSandbox: async () => { throw new Error('bwrap build exploded'); },
    });
    const collaboration = await orchestrator.dispatch({
      rootSessionId: rootSession.id,
      plan: {
        title: 'reviewer sandbox fail',
        tasks: [{ id: 'review-sandbox', agentId: 'reviewer-agent', role: 'reviewer', objective: 'review' }],
      },
      idempotencyKey: 'reviewer-refused-sandbox',
    });
    const task = collaboration.tasks.find((candidate) => candidate.id === 'review-sandbox');
    eq(task.state, 'failed', 'a reviewer whose sandbox cannot be built is refused');
    eq(collaboration.attempts[0].failureKind, 'deterministic_failure', 'sandbox failure is a deterministic refusal');
    ok(collaboration.attempts[0].failureReason.includes('READ_ONLY_RUNTIME_REFUSED'),
      'sandbox failure refuses with READ_ONLY_RUNTIME_REFUSED');
    orchestrator.stop();
  }

  // 5d) regression: reviewerEnabled=false keeps the S6 reader refusal code
  //     READ_ONLY_RUNTIME_UNAVAILABLE (409) instead of the S12 503.
  {
    const plain = createCollaborationOrchestrator({
      pollMs: 100000,
      reviewerEnabled: false,
      dependencies: {
        getSession: async (id) => sessions.get(id) || null,
        getApp: async (id) => apps.get(id) || null,
        getProject: async () => ({ id: 'prj_reviewer', rootPath: configDir }),
        createSession: async (_folder, tool, name, extra) => {
          const session = { id: `legacy-child-${++childCounter}`, folder: configDir, tool, name, ...extra };
          sessions.set(session.id, session);
          return session;
        },
        sendMessage: async (sessionId, text, _images, options) => {
          const run = { id: `legacy-run-${++runCounter}`, sessionId, state: 'running', requestId: options.requestId, result: null };
          runs.set(run.id, run);
          return { session: sessions.get(sessionId), run, prompt: text };
        },
        getRunState: async (id) => runs.get(id) || null,
        getRun: async (id) => runs.get(id) || null,
        getRunResult: async (id) => runs.get(id)?.result || null,
        getRunManifest: async () => ({ folder: configDir }),
        listRunIds: async () => [...runs.keys()],
        requestRunCancel: async () => null,
        loadHistory: async () => [],
        resolveRuntimeReadOnlyCapability: async () => ({
          runtimeId: 'runner_uncertified',
          supportsReadOnlyFilesystem: false,
          enforcement: 'none',
          note: 'runtime-not-certified',
        }),
      },
    });
    const collaboration = await plain.dispatch({
      rootSessionId: rootSession.id,
      plan: {
        title: 'reader regression',
        tasks: [{ id: 'reader-legacy', agentId: 'specialist-agent', objective: 'read only' }],
      },
      idempotencyKey: 'reader-legacy',
    });
    const task = collaboration.tasks.find((candidate) => candidate.id === 'reader-legacy');
    eq(task.state, 'failed', 'an uncertified reader task stays refused when reviewerEnabled is off');
    eq(collaboration.attempts[0].failureKind, 'deterministic_failure', 'S6 reader refusal stays deterministic');
    ok(collaboration.attempts[0].failureReason.includes('READ_ONLY_RUNTIME_UNAVAILABLE'),
      'S6 reader refusal keeps READ_ONLY_RUNTIME_UNAVAILABLE (409)');
    plain.stop();
  }

  finishSection();

  console.log('test-reviewer-readonly: ok');
  console.log(`  total assertions: ${totalAssertions}`);
  for (const section of sections) {
    console.log(`  ${section.name}: ${section.count} assertions`);
  }
} finally {
  rmSync(configDir, { recursive: true, force: true });
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
}
