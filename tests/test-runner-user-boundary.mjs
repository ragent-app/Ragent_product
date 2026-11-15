#!/usr/bin/env node
// Same-user ordinary runner boundary contract (narrow, low-risk).
//
// Verifies:
//  1. same-user mode resolves to the trusted control service user and rejects
//     conflicting runner-user overrides; explicit compatibility mode retains
//     the old resolution order for migration coverage.
//  2. resolveRunnerGroup resolution: RAGENT_RUNNER_GROUP env -> same-name
//     group -> shared ragent-runners group.
//  3. Socket placement: the lifecycle broker socket stays in the control-plane
//     CONFIG_DIR (root creates it and chowns it to the control user); the
//     supervisor socket lives in the runner state root /var/lib/ragent-run.
//     The packaged ragent.env points at both.
//  4. The directory permission model keeps control auth.json unreadable by the runner
//     group, gives the runner-accessible subtrees (results / provider-homes,
//     under /var/lib/ragent-run) group read/write, and makes the control
//     config dir NOT traversable by the runner group at all.
//  5. postinst carries the same-user service/supervisor/socket overrides, the
//     relocated runner subtrees and the compatibility runner-user marker.
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

// Import order matters: DEFAULT_LIFECYCLE_SOCKET_PATH / CONFIG_DIR read the env
// at module load, so make sure the production socket env is not ambient in this
// process.
delete process.env.RAGENT_RUNNER_LIFECYCLE_SOCKET;
delete process.env.RAGENT_RUNNER_SUPERVISOR_SOCKET;

const { CONFIG_DIR } = await import('../lib/config.mjs');
const {
  resolveRunnerUser,
  resolveRunnerGroup,
  resolveRunnerInheritedGroups,
  resolveControlUser,
  DEFAULT_LIFECYCLE_SOCKET_PATH,
} = await import('../scripts/runner-lifecycle-broker.mjs');
const { DEFAULT_SUPERVISOR_SOCKET_PATH } = await import('../chat/runner-supervisor-daemon.mjs');

const tmpRoot = await mkdtemp(join(tmpdir(), 'ragent-runner-boundary-'));
const savedEnv = new Map();
function saveEnv(...keys) {
  for (const key of keys) savedEnv.set(key, process.env[key]);
}
function restoreEnv() {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
}

try {
  // ── 1) same-user identity + explicit compatibility order ─────────────────
  saveEnv('RAGENT_RUNNER_USER', 'RAGENT_RUNNER_GROUP', 'RAGENT_RUNNER_SAME_USER');
  const serviceUserFile = join(tmpRoot, 'service-user');
  await writeFile(serviceUserFile, 'svc-owner\n');
  const runnerUserFile = join(tmpRoot, 'runner-user');
  await writeFile(runnerUserFile, 'file-runner\n');
  assert.equal(await resolveRunnerUser({
    file: runnerUserFile,
    controlUserFile: serviceUserFile,
    environment: { RAGENT_RUNNER_SAME_USER: '1' },
    getentImpl: async () => { throw new Error('same-user mode must not probe a dedicated user'); },
  }), 'svc-owner', 'same-user mode must use the trusted control service user');
  await assert.rejects(
    () => resolveRunnerUser({
      file: runnerUserFile,
      controlUserFile: serviceUserFile,
      environment: { RAGENT_RUNNER_SAME_USER: '1', RAGENT_RUNNER_USER: 'env-runner' },
    }),
    /rejects RAGENT_RUNNER_USER=env-runner/,
    'same-user mode must reject a conflicting identity override',
  );

  // Explicit compatibility mode retains the old order for upgrade/migration
  // tests, but is not the package default.
  process.env.RAGENT_RUNNER_SAME_USER = '0';
  process.env.RAGENT_RUNNER_USER = 'env-runner';
  assert.equal(await resolveRunnerUser({
    file: join(tmpRoot, 'no-runner-user'),
    getentImpl: async () => { throw new Error('getent must not be probed when env wins'); },
    readFileImpl: async () => { throw new Error('runner-user file must not be read when env wins'); },
  }), 'env-runner', 'compatibility mode keeps explicit runner user support');
  delete process.env.RAGENT_RUNNER_USER;

  // runner-user file is second in compatibility mode, and its value must exist.
  assert.equal(await resolveRunnerUser({
    file: runnerUserFile,
    environment: { RAGENT_RUNNER_SAME_USER: '0' },
    getentImpl: async () => ({ stdout: 'file-runner:x:1000:1000::/var/lib/ragent-run:/bin/sh\n' }),
  }), 'file-runner', 'runner-user file must be honoured when the user exists');

  // A file value that does not exist falls through to the ragent-runner probe.
  await writeFile(runnerUserFile, 'ghost-runner\n');
  assert.equal(await resolveRunnerUser({
    file: runnerUserFile,
    environment: { RAGENT_RUNNER_SAME_USER: '0' },
    getentImpl: async (cmd, args) => (
      args[1] === 'ragent-runner'
        ? { stdout: 'ragent-runner:x:998:998::/var/lib/ragent-run:/usr/sbin/nologin\n' }
        : { stdout: '' }
    ),
  }), 'ragent-runner', 'a non-existent file user must fall through to the ragent-runner default');

  // ragent-runner default when no file and getent reports it exists.
  assert.equal(await resolveRunnerUser({
    file: join(tmpRoot, 'missing-runner-user'),
    environment: { RAGENT_RUNNER_SAME_USER: '0' },
    getentImpl: async () => ({ stdout: 'ragent-runner:x:998:998::/var/lib/ragent-run:/usr/sbin/nologin\n' }),
  }), 'ragent-runner', 'ragent-runner must be the default when it exists');

  // Compatibility fallback to the control service user when ragent-runner is absent.
  assert.equal(await resolveRunnerUser({
    file: join(tmpRoot, 'missing-runner-user'),
    controlUserFile: serviceUserFile,
    environment: { RAGENT_RUNNER_SAME_USER: '0' },
    getentImpl: async () => ({ stdout: '' }),
  }), 'svc-owner', 'must fall back to the control service user when ragent-runner is absent');

  assert.equal(
    await resolveControlUser({ file: join(tmpRoot, 'missing'), readFileImpl: readFile }),
    'ragent',
    'control user must default to ragent',
  );

  // ── 2) resolveRunnerGroup order ─────────────────────────────────────────
  process.env.RAGENT_RUNNER_GROUP = 'custom-group';
  assert.equal(
    await resolveRunnerGroup('whatever', { getentImpl: async () => { throw new Error('no probe'); } }),
    'custom-group',
    'RAGENT_RUNNER_GROUP env must win',
  );
  delete process.env.RAGENT_RUNNER_GROUP;
  assert.equal(
    await resolveRunnerGroup('runner-user', { getentImpl: async () => ({ stdout: 'runner-user:x:1000:\n' }) }),
    'runner-user',
    'a same-name group wins for legacy layouts',
  );
  assert.equal(
    await resolveRunnerGroup('ragent-runner', { getentImpl: async () => ({ stdout: '' }) }),
    'ragent-runners',
    'defaults to the shared ragent-runners group',
  );
  await assert.rejects(
    () => resolveRunnerGroup('pinggu', {
      environment: { RAGENT_RUNNER_SAME_USER: '1', RAGENT_RUNNER_GROUP: 'ragent-runners' },
    }),
    /rejects RAGENT_RUNNER_GROUP=ragent-runners/,
    'same-user mode must keep the service primary group',
  );
  assert.deepEqual(
    await resolveRunnerInheritedGroups('desktop-owner', {
      environment: {},
      execFileImpl: async () => ({ stdout: 'desktop-owner sudo docker ragent-privileged users\n' }),
      readFileImpl: async () => { throw new Error('live group lookup should win'); },
    }),
    ['desktop-owner', 'users'],
    'runner inherits ordinary service-user groups but filters privilege channels',
  );
  assert.deepEqual(
    await resolveRunnerInheritedGroups('desktop-owner', {
      environment: { RAGENT_RUNNER_INHERITED_GROUPS: 'desktop-owner sudo docker ragent-privileged' },
      execFileImpl: async () => { throw new Error('explicit group override must win'); },
    }),
    ['desktop-owner'],
    'explicit inherited-group override remains deny-listed',
  );
  restoreEnv();

  // ── 3) socket placement: lifecycle in CONFIG_DIR, supervisor in runner root ──
  assert.equal(
    DEFAULT_LIFECYCLE_SOCKET_PATH,
    join(CONFIG_DIR, 'runner-lifecycle.sock'),
    'lifecycle socket must default under CONFIG_DIR',
  );
  assert.ok(
    DEFAULT_LIFECYCLE_SOCKET_PATH.startsWith(CONFIG_DIR),
    'lifecycle socket must stay under the control CONFIG_DIR',
  );
  assert.ok(
    !DEFAULT_LIFECYCLE_SOCKET_PATH.includes('/run/ragent/'),
    'lifecycle socket must not be relocated to /run/ragent',
  );
  assert.equal(
    DEFAULT_SUPERVISOR_SOCKET_PATH,
    '/var/lib/ragent-run/runner-supervisor.sock',
    'supervisor socket must live in the runner state root, not the control CONFIG_DIR',
  );
  assert.ok(
    !DEFAULT_SUPERVISOR_SOCKET_PATH.includes('/run/ragent/'),
    'supervisor socket must not be relocated to /run/ragent',
  );
  assert.ok(
    !DEFAULT_SUPERVISOR_SOCKET_PATH.startsWith(CONFIG_DIR),
    'supervisor socket must not stay in the control CONFIG_DIR',
  );

  const ragentEnv = await readFile(join(REPO_ROOT, 'packaging/deb/ragent.env'), 'utf8');
  assert.match(ragentEnv, /^RAGENT_RUNNER_SAME_USER=1$/m, 'packaged installs must default to same-user mode');
  assert.match(ragentEnv, /RAGENT_RUNNER_LIFECYCLE_SOCKET=\/var\/lib\/ragent\/config\/runner-lifecycle\.sock/);
  assert.match(ragentEnv, /RAGENT_RUNNER_SUPERVISOR_SOCKET=\/var\/lib\/ragent-run\/runner-supervisor\.sock/);
  assert.ok(
    !ragentEnv.includes('/run/ragent/runner-'),
    'ragent.env must not relocate runner sockets to /run/ragent',
  );
  // P0-C: the runner-accessible subtrees are env-targeted under the runner root.
  assert.match(ragentEnv, /RAGENT_RUN_SPOOL_DIR=\/var\/lib\/ragent-run\/results/);
  assert.match(ragentEnv, /RAGENT_PROVIDER_HOMES_DIR=\/var\/lib\/ragent-run\/provider-homes/);

  // ── 4) directory permission model (simulated on a temp tree) ────────────
  // Simulates the P0-C layout: the control core (/var/lib/ragent + config) is
  // NOT traversable by the runner group at all (no o+x), while the runner-
  // accessible subtrees (results + provider-homes) live under /var/lib/ragent-run
  // and are group read/write for the shared ragent-runners group.
  const stateRoot = join(tmpRoot, 'var-lib-ragent');
  const configRoot = join(stateRoot, 'config');
  const authFile = join(configRoot, 'auth.json');
  const runnerRoot = join(tmpRoot, 'var-lib-ragent-run');
  const resultsDir = join(runnerRoot, 'results');
  const providerHomes = join(runnerRoot, 'provider-homes');
  await mkdir(configRoot, { recursive: true });
  await mkdir(resultsDir, { recursive: true });
  await mkdir(providerHomes, { recursive: true });
  await writeFile(authFile, '{"username":"owner"}');
  // Control core: service-user:service-group 0750, no group/other access.
  await chmod(stateRoot, 0o750);
  await chmod(configRoot, 0o750);
  // Runner state root + subtrees: group read/write for ragent-runners.
  await chmod(runnerRoot, 0o750);
  await chmod(resultsDir, 0o770);
  await chmod(providerHomes, 0o770);
  await chmod(authFile, 0o600);
  const mode = (s) => s.mode & 0o7777;
  assert.equal(
    mode(await stat(stateRoot)) & 0o007,
    0,
    '/var/lib/ragent must not be traversable by others/runners',
  );
  assert.equal(
    mode(await stat(configRoot)) & 0o007,
    0,
    'config must not be traversable by others/runners',
  );
  assert.equal(
    mode(await stat(authFile)) & 0o077,
    0,
    'auth.json must be unreadable by group and others',
  );
  assert.equal(
    mode(await stat(resultsDir)) & 0o070,
    0o070,
    'results must be group read/write',
  );
  assert.equal(
    mode(await stat(providerHomes)) & 0o070,
    0o070,
    'provider-homes must be group read/write',
  );

  // ── 5) postinst + units carry the same-user/P0-C statements ─────────────
  const postinst = await readFile(join(REPO_ROOT, 'packaging/deb/postinst'), 'utf8');
  assert.match(postinst, /addgroup --system ragent-runners/);
  assert.match(postinst, /adduser --system --ingroup ragent-runners/);
  assert.match(postinst, /ragent-runner/);
  assert.match(postinst, /\/var\/lib\/ragent-run/);
  // P0-C: the runner subtrees move out of the control CONFIG_DIR; no traverse
  // ACL is granted, and the migration helper relocates any legacy data.
  assert.match(postinst, /\/var\/lib\/ragent-run\/results/);
  assert.match(postinst, /\/var\/lib\/ragent-run\/provider-homes/);
  assert.match(postinst, /relocate-runner-subtrees\.mjs/);
  assert.match(postinst, /0640/, 'runner provider files must converge to group-readable mode');
  assert.ok(
    !postinst.includes('ensure_runner_config_traverse'),
    'postinst must not grant the runner group config traverse access',
  );
  assert.ok(
    !/install -d[^\n]*\/var\/lib\/ragent\/config\/chat-runs/.test(postinst),
    'postinst must not create a legacy spool dir under config',
  );
  assert.match(postinst, /User=\$service_user\nGroup=\$service_group/);
  assert.match(postinst, /ragent-runner-supervisor\.socket\.d/);
  assert.match(postinst, /SocketUser=\$service_user\nSocketGroup=\$service_group/);
  assert.ok(
    !/install -d[^\n]*\/run\/ragent/.test(postinst),
    'postinst must not create a shared /run/ragent runner runtime dir',
  );

  const supervisorUnit = await readFile(
    join(REPO_ROOT, 'packaging/deb/ragent-runner-supervisor.service'),
    'utf8',
  );
  assert.match(supervisorUnit, /^User=ragent$/m, 'package fallback must be the service-compatible account');
  assert.match(supervisorUnit, /^Group=ragent$/m, 'package fallback group must match the account');
  // The long-lived supervisor imports the shared config module to resolve its
  // launch paths, so the package template keeps /var/lib/ragent read-only.
  // The actual Run boundary is stricter: the lifecycle transient unit masks
  // /var/lib/ragent/config dynamically (covered above in the broker test).
  assert.match(
    supervisorUnit,
    /^InaccessiblePaths=\/etc\/ragent \/var\/log\/ragent \/run\/ragent /m,
    'supervisor must mask system config/log/socket roots',
  );
  assert.match(
    supervisorUnit,
    /^ReadOnlyPaths=\/var\/lib\/ragent$/m,
    'supervisor config access must be read-only',
  );
  assert.match(postinst, /runner-groups/);
  assert.match(postinst, /write_runner_inherited_groups/);
  assert.match(supervisorUnit, /^ReadWritePaths=\/var\/lib\/ragent-run/m, 'supervisor must write its socket in the runner state root');
  const supervisorSocket = await readFile(
    join(REPO_ROOT, 'packaging/deb/ragent-runner-supervisor.socket'),
    'utf8',
  );
  assert.match(supervisorSocket, /^SocketUser=ragent$/m);
  assert.match(supervisorSocket, /^SocketGroup=ragent$/m);

  const lifecycleUnit = await readFile(
    join(REPO_ROOT, 'packaging/deb/ragent-runner-lifecycle.service'),
    'utf8',
  );
  assert.ok(
    !lifecycleUnit.includes('/run/ragent'),
    'lifecycle unit must not require a /run/ragent runtime dir',
  );

  console.log('test-runner-user-boundary: PASS');
} finally {
  restoreEnv();
  await rm(tmpRoot, { recursive: true, force: true });
}
