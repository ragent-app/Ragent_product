#!/usr/bin/env node
// P1-B: CLI socket ownership guard regression tests.
//
// Reproduces the single-instance accident: a second chat-server must never
// unlink the first instance's live identity socket, a stale socket must only
// be removed after proving ownership, and a foreign object (regular file /
// symlink) at the socket path must never be touched. Shutdown cleanup must
// only ever remove the exact socket this process created (same dev+ino).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync,
  unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import {
  E_CLI_SOCKET_UNSAFE,
  E_SOCKET_ALREADY_ACTIVE,
  mayRemoveStaleSocket,
  probeCliSocketPath,
  recordSocketIdentity,
  shouldCleanupSocket,
} from '../lib/cli-socket-guard.mjs';

function makeDir() {
  return mkdtempSync(join(tmpdir(), 'ragent-cli-socket-guard-'));
}

function socketFilePath(dir) {
  return join(dir, 'ragent-cli.sock');
}

function cleanPath(path) {
  try {
    unlinkSync(path);
  } catch {}
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Bind a net server on socketPath, run fn, close the server, and remove the
// socket file so the next case starts from a clean path.
async function withServer(socketPath, fn) {
  const server = net.createServer(() => {});
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  try {
    await fn();
  } finally {
    await new Promise((resolve) => server.close(resolve));
    cleanPath(socketPath);
  }
}

// A real stale unix socket is what a dead process leaves behind: the binding
// process exits without running server.close(), so the kernel keeps the socket
// file but no listener is attached (connect -> ECONNREFUSED). Reproduce that
// by spawning a short-lived child that binds the path and exits immediately.
async function spawnStaleSocket(socketPath, timeoutMs = 5000) {
  cleanPath(socketPath);
  let exited = false;
  const child = spawn(process.execPath, ['-e', `
    const net = require('net');
    const s = net.createServer(() => {});
    s.listen(${JSON.stringify(socketPath)}, () => process.exit(0));
  `], { stdio: 'ignore' });
  child.once('exit', () => {
    exited = true;
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // The socket file exists only after the child's listen() succeeded, and
    // the child exits right after; only then is the file genuinely stale
    // (kernel keeps it, no listener attached).
    if (exited && existsSync(socketPath)) {
      await sleep(20); // let the kernel drop the listener before probing
      return;
    }
    await sleep(10);
  }
  child.kill('SIGKILL');
  throw new Error(`timed out waiting for stale socket at ${socketPath}`);
}

async function main() {
  const dir = makeDir();
  const path = socketFilePath(dir);
  const target = `${path}.target`;
  try {
    // ── 1) nothing at the path -> bind ─────────────────────────────────────
    {
      const result = await probeCliSocketPath(path);
      assert.equal(result.action, 'bind', 'empty path must allow bind');
    }

    // ── 2) live socket -> active, and never unlinked ───────────────────────
    {
      await withServer(path, async () => {
        const result = await probeCliSocketPath(path);
        assert.equal(result.action, 'active', 'live socket must be detected as active');
        assert.equal(result.code, E_SOCKET_ALREADY_ACTIVE);
      });
      // The socket file is gone only because withServer cleaned it; the probe
      // itself must not have unlinked a live socket. Verify by re-probing
      // during the live window instead:
      const server = net.createServer(() => {});
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(path, resolve);
      });
      await probeCliSocketPath(path);
      assert.ok(existsSync(path), 'probing a live socket must never unlink it');
      await new Promise((resolve) => server.close(resolve));
      cleanPath(path);
    }

    // ── 3) stale socket (dead process left the file) -> removeStale + ownership ──
    {
      await spawnStaleSocket(path);
      const result = await probeCliSocketPath(path);
      assert.equal(result.action, 'removeStale', 'listener-less socket must be stale');
      const expectedUid = typeof process.getuid === 'function' ? process.getuid() : undefined;
      assert.equal(mayRemoveStaleSocket(result.stats, { expectedUid }), true, 'own stale socket must be removable');
      assert.equal(mayRemoveStaleSocket(result.stats, { expectedUid: 0 }), false, 'root-owned socket must not be removable by us');
      unlinkSync(path);
      const again = await probeCliSocketPath(path);
      assert.equal(again.action, 'bind', 'after cleanup the path must be bindable');
    }

    // ── 4) regular file at the path -> unsafe, never touched ───────────────
    {
      writeFileSync(path, 'i am not a socket');
      const result = await probeCliSocketPath(path);
      assert.equal(result.action, 'error', 'regular file must be refused');
      assert.equal(result.code, E_CLI_SOCKET_UNSAFE);
      assert.equal(readFileSync(path, 'utf8'), 'i am not a socket', 'foreign file must be untouched');
      cleanPath(path);
    }

    // ── 5) symlink at the path -> unsafe (lstat, not followed) ─────────────
    {
      writeFileSync(target, 'real target');
      symlinkSync(target, path);
      const result = await probeCliSocketPath(path);
      assert.equal(result.action, 'error', 'symlink must be refused');
      assert.equal(result.code, E_CLI_SOCKET_UNSAFE);
      cleanPath(path);
      cleanPath(target);
    }

    // ── 6) inode-tracked shutdown cleanup ──────────────────────────────────
    {
      const server = net.createServer(() => {});
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(path, resolve);
      });
      const identity = recordSocketIdentity(path);
      assert.ok(identity, 'bound socket identity must be recorded');
      assert.equal(shouldCleanupSocket(path, identity), true, 'our own socket must be cleanable');
      // Path disappears (external cleanup / crash already removed it).
      await new Promise((resolve) => server.close(resolve));
      assert.equal(shouldCleanupSocket(path, identity), false, 'missing socket must not be cleanable');
      // A foreign object at the path is never cleaned, even with a stale identity.
      writeFileSync(path, 'not a socket');
      assert.equal(shouldCleanupSocket(path, identity), false, 'foreign file must not be cleaned');
      cleanPath(path);
    }

    // ── 7) mayRemoveStaleSocket rejects non-sockets ────────────────────────
    {
      writeFileSync(path, 'data');
      const regular = statSync(path);
      assert.equal(
        mayRemoveStaleSocket(regular, { expectedUid: typeof process.getuid === 'function' ? process.getuid() : undefined }),
        false,
        'regular file is never a removable stale socket',
      );
      cleanPath(path);
    }

    console.log('test-cli-socket-guard: ok');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
