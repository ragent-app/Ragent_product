#!/usr/bin/env node
// P2-C: systemd socket activation for the runner services.
//
// Covers:
//  1. inheritedSocketFd() env parsing (LISTEN_PID / LISTEN_FDS / LISTEN_FDNAMES).
//  2. The supervisor daemon accepting a systemd-inherited listening fd (and
//     NOT removing the systemd-owned socket file on close).
//  3. The lifecycle broker accepting a systemd-inherited listening fd (and NOT
//     removing the socket file on close).
//  4. The shipped unit files (socket + service + postinst + build-deb wiring).
//
// The fd-inheritance path is exercised with a real already-listening socket fd,
// transferred into this process the same way systemd transfers it (as a live fd
// that already has listen() applied), then passed to the daemons via inheritFd.

import assert from 'assert/strict';
import { spawn } from 'child_process';
import { connect } from 'net';
import { mkdtemp, readFile, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import {
  createRunnerSupervisorServer,
  validateScopedProviderHomesDir,
} from '../chat/runner-supervisor-daemon.mjs';
import {
  RUNNER_LIFECYCLE_SOCKET_UNIT,
  RUNNER_SUPERVISOR_SOCKET_UNIT,
  SD_LISTEN_FDS_START,
  inheritedSocketFd,
} from '../lib/systemd-socket-activation.mjs';
import { createRunnerLifecycleServer } from '../scripts/runner-lifecycle-broker.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ── helpers ─────────────────────────────────────────────────────────────────

// Child source: bind a real unix socket and hand the listening fd to the parent
// over IPC, then exit WITHOUT server.close() — net.Server.close() would unlink
// the socket path, but in a real systemd handoff the socket FILE is systemd's
// and persists.  Exiting just closes the child's fd copy; the parent's
// duplicated fd keeps the socket listening and the path file intact.
const LISTEN_HANDLE_CHILD = `
  const net = require('net');
  const socketPath = process.argv[1];
  const server = net.createServer(() => {});
  server.on('error', (err) => { process.send({ error: err.message }); process.exit(1); });
  server.listen(socketPath, () => {
    process.send('ready', server._handle, () => process.exit(0));
  });
  setTimeout(() => process.exit(2), 5000);
`;

function createListeningFd(socketPath) {
  const child = spawn(process.execPath, ['-e', LISTEN_HANDLE_CHILD, socketPath], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    child.once('message', (message, handle) => {
      if (settled) return;
      if (message === 'ready' && handle && Number.isInteger(handle.fd)) {
        settled = true;
        resolve({ fd: handle.fd, child });
      } else if (message && message.error) {
        settled = true;
        reject(new Error(`listen-handle child error: ${message.error}`));
      } else {
        settled = true;
        reject(new Error('listen-handle child did not provide a listening fd'));
      }
    });
    child.once('error', (error) => {
      if (!settled) { settled = true; reject(error); }
    });
    child.once('exit', (code) => {
      if (!settled) { settled = true; reject(new Error(`listen-handle child exited ${code}`)); }
    });
  });
}

function requestSocket(socketPath, payload) {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let buffer = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`request to ${socketPath} timed out`));
    }, 3000);
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on('data', (chunk) => { buffer += chunk; });
    socket.once('error', (error) => { clearTimeout(timer); reject(error); });
    socket.once('end', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(buffer)); } catch (error) { reject(new Error(`bad response: ${error.message}`)); }
    });
  });
}

// ── 1) inheritedSocketFd() env parsing ──────────────────────────────────────

assert.equal(SD_LISTEN_FDS_START, 3);
assert.equal(inheritedSocketFd({ env: {}, pid: 100 }), null, 'no fds in env');
assert.equal(
  inheritedSocketFd({ env: { LISTEN_PID: '999', LISTEN_FDS: '1' }, pid: 100 }),
  null,
  'LISTEN_PID must match the current process',
);
assert.equal(
  inheritedSocketFd({ env: { LISTEN_PID: '100', LISTEN_FDS: '0' }, pid: 100 }),
  null,
  'LISTEN_FDS must be >= 1',
);
assert.equal(
  inheritedSocketFd({ env: { LISTEN_FDS: '1' }, pid: 100 }),
  null,
  'LISTEN_PID is required',
);
assert.deepEqual(
  inheritedSocketFd({ env: { LISTEN_PID: '100', LISTEN_FDS: '1' }, pid: 100, expectedName: 'x.socket' }),
  { fd: 3, count: 1, name: 'x.socket' },
  'single inherited fd maps to SD_LISTEN_FDS_START',
);
assert.deepEqual(
  inheritedSocketFd({
    env: { LISTEN_PID: '100', LISTEN_FDS: '2', LISTEN_FDNAMES: 'a.socket:b.socket' },
    pid: 100,
    expectedName: 'b.socket',
  }),
  { fd: 4, count: 2, name: 'b.socket' },
  'fd index is located via LISTEN_FDNAMES',
);
assert.equal(
  inheritedSocketFd({
    env: { LISTEN_PID: '100', LISTEN_FDS: '2', LISTEN_FDNAMES: 'a.socket:b.socket' },
    pid: 100,
    expectedName: 'c.socket',
  }),
  null,
  'name mismatch must not claim another socket fd',
);
assert.equal(
  inheritedSocketFd({
    env: { LISTEN_PID: '100', LISTEN_FDS: '2', LISTEN_FDNAMES: 'a.socket:b.socket' },
    pid: 100,
  }),
  null,
  'names present without expectedName cannot be claimed safely',
);

const providerHomesRoot = '/var/lib/ragent-run/provider-homes';
const scopedProviderHomes = join(providerHomesRoot, 'by-provider', '0123456789abcdef0123456789abcdef');
assert.equal(
  validateScopedProviderHomesDir(scopedProviderHomes, { providerHomesRoot }),
  scopedProviderHomes,
  'supervisor should accept only the hashed per-Provider home shape',
);
const scopedProviderRunHome = join(
  providerHomesRoot,
  'by-provider',
  'a'.repeat(32),
  'by-run',
  'b'.repeat(32),
);
assert.equal(
  validateScopedProviderHomesDir(scopedProviderRunHome, { providerHomesRoot }),
  scopedProviderRunHome,
  'supervisor should accept the native per-Provider per-Run home shape',
);
assert.throws(
  () => validateScopedProviderHomesDir('/tmp/provider-homes', { providerHomesRoot }),
  /Invalid scoped Provider homes directory/,
  'supervisor must reject a caller-controlled Provider home outside its configured root',
);

// ── 2) supervisor inherits a listening fd ───────────────────────────────────

{
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'ragent-p2c-supervisor-'));
  const socketPath = join(temporaryDirectory, 'supervisor.sock');
  const { fd, child } = await createListeningFd(socketPath);
  await new Promise((resolve) => child.once('exit', resolve));

  let launchedRunId = '';
  let launchedOptions = null;
  const supervisor = await createRunnerSupervisorServer({
    socketPath,
    providerHomesRoot,
    inheritFd: { fd },
    spawnRunner(runId, options) {
      launchedRunId = runId;
      launchedOptions = options;
      return { pid: 76543 };
    },
  });
  try {
    assert.equal(supervisor.inherited, true, 'supervisor should report inherited socket');
    const health = await requestSocket(socketPath, { type: 'health' });
    assert.deepEqual(health, { ok: true, status: 'ready' });
    const launched = await requestSocket(socketPath, {
      type: 'launch',
      runId: 'run_p2c_super_123',
      providerHomesDir: scopedProviderHomes,
    });
    assert.equal(launched.ok, true);
    assert.equal(launched.pid, 76543);
    assert.equal(launchedRunId, 'run_p2c_super_123');
    assert.deepEqual(launchedOptions, { providerHomesDir: scopedProviderHomes });
    const rejected = await requestSocket(socketPath, {
      type: 'launch',
      runId: 'run_p2c_super_456',
      providerHomesDir: '/tmp/untrusted-provider-home',
    });
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /Invalid scoped Provider homes directory/);
  } finally {
    await supervisor.close();
    // P2-C invariant: a systemd-owned socket is systemd's to remove.  The
    // daemon must leave the socket file in place on shutdown.
    const st = await stat(socketPath);
    assert.ok(st.isSocket(), 'supervisor must not remove a systemd-owned socket');
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

// ── 3) lifecycle broker inherits a listening fd ─────────────────────────────

{
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'ragent-p2c-lifecycle-'));
  const socketPath = join(temporaryDirectory, 'lifecycle.sock');
  const { fd, child } = await createListeningFd(socketPath);
  await new Promise((resolve) => child.once('exit', resolve));

  let launchedRunId = '';
  let launchedOptions = null;
  const broker = await createRunnerLifecycleServer({
    socketPath,
    inheritFd: { fd },
    serviceUser: 'ragent-runner',
    serviceGroup: 'ragent-runners',
    launchRunner: async (runId, options) => {
      launchedRunId = runId;
      launchedOptions = options;
      return { pid: 43210, unitName: `ragent-runner-${runId}` };
    },
  });
  try {
    assert.equal(broker.inherited, true, 'broker should report inherited socket');
    const health = await requestSocket(socketPath, { type: 'health' });
    assert.deepEqual(health, { ok: true, status: 'ready' });
    const launched = await requestSocket(socketPath, {
      type: 'launch',
      runId: 'run_p2c_life_456',
      guiEnvironment: {
        DISPLAY: ':1',
        XAUTHORITY: '/run/user/1000/gdm/Xauthority',
        XDG_RUNTIME_DIR: '/run/user/1000',
        INVALID_GUI_VALUE: 'should-not-pass',
      },
    });
    assert.equal(launched.ok, true);
    assert.equal(launched.pid, 43210);
    assert.equal(launchedRunId, 'run_p2c_life_456');
    assert.deepEqual(launchedOptions, {
      serviceUser: 'ragent-runner',
      serviceGroup: 'ragent-runners',
      controlUser: 'ragent',
      guiEnvironment: {
        DISPLAY: ':1',
        XAUTHORITY: '/run/user/1000/gdm/Xauthority',
        XDG_RUNTIME_DIR: '/run/user/1000',
      },
    });
  } finally {
    await broker.close();
    const st = await stat(socketPath);
    assert.ok(st.isSocket(), 'broker must not remove a systemd-owned socket');
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

// ── 4) shipped unit wiring ──────────────────────────────────────────────────

const supervisorSocketUnit = await readFile(
  join(REPO_ROOT, 'packaging/deb/ragent-runner-supervisor.socket'),
  'utf8',
);
assert.match(supervisorSocketUnit, /^ListenStream=\/var\/lib\/ragent-run\/runner-supervisor\.sock$/m);
assert.match(supervisorSocketUnit, /^SocketUser=ragent$/m);
assert.match(supervisorSocketUnit, /^SocketGroup=ragent$/m);
assert.match(supervisorSocketUnit, /^SocketMode=0660$/m);
assert.match(supervisorSocketUnit, /^Service=ragent-runner-supervisor\.service$/m);
assert.match(supervisorSocketUnit, /^WantedBy=sockets\.target$/m);

const lifecycleSocketUnit = await readFile(
  join(REPO_ROOT, 'packaging/deb/ragent-runner-lifecycle.socket'),
  'utf8',
);
assert.match(lifecycleSocketUnit, /^ListenStream=\/var\/lib\/ragent\/config\/runner-lifecycle\.sock$/m);
assert.match(lifecycleSocketUnit, /^SocketUser=ragent$/m);
assert.match(lifecycleSocketUnit, /^SocketGroup=ragent$/m);
assert.match(lifecycleSocketUnit, /^SocketMode=0660$/m);
assert.match(lifecycleSocketUnit, /^Service=ragent-runner-lifecycle\.service$/m);
assert.match(lifecycleSocketUnit, /^WantedBy=sockets\.target$/m);

const supervisorService = await readFile(
  join(REPO_ROOT, 'packaging/deb/ragent-runner-supervisor.service'),
  'utf8',
);
assert.match(supervisorService, /^Sockets=ragent-runner-supervisor\.socket$/m);

const lifecycleService = await readFile(
  join(REPO_ROOT, 'packaging/deb/ragent-runner-lifecycle.service'),
  'utf8',
);
assert.match(lifecycleService, /^Sockets=ragent-runner-lifecycle\.socket$/m);

const postinst = await readFile(join(REPO_ROOT, 'packaging/deb/postinst'), 'utf8');
assert.match(postinst, /systemctl enable ragent-runner-lifecycle\.socket/);
assert.match(postinst, /systemctl enable ragent-runner-supervisor\.socket/);

const buildDeb = await readFile(join(REPO_ROOT, 'scripts/build-deb.sh'), 'utf8');
assert.match(buildDeb, /ragent-runner-lifecycle\.socket/);
assert.match(buildDeb, /ragent-runner-supervisor\.socket/);

console.log('test-runner-socket-activation: PASS');
