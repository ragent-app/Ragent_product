// CLI socket ownership guard (P1-B).
//
// chat-server binds an identity socket that local CLI auth uses
// (ragent-cli.sock under the control CONFIG_DIR). A second instance must
// never unlink the first instance's live socket, and a stale socket must not
// be removed without proving it is ours. Node has no stable flock; the
// Unix-socket bind itself is the single-instance primitive, so this guard's
// job is to probe the existing path and only then allow bind/cleanup.
//
// Ownership rules:
//   - a live socket (connect succeeds)          -> E_SOCKET_ALREADY_ACTIVE, never unlink
//   - a stale socket (ECONNREFUSED, no listener)-> removeStale, but only when it is a
//     socket owned by the expected control uid
//   - a regular file or symlink at the path     -> E_CLI_SOCKET_UNSAFE, never touch
//   - nothing at the path                       -> bind
//
// Shutdown cleanup is additionally gated on the recorded (dev, ino) so a
// graceful stop only ever removes the socket this process created.

import { constants as FS_CONSTANTS, lstatSync, statSync } from 'fs';
import { connect as netConnect } from 'net';

export const E_SOCKET_ALREADY_ACTIVE = 'E_SOCKET_ALREADY_ACTIVE';
export const E_CLI_SOCKET_MISSING = 'E_CLI_SOCKET_MISSING';
export const E_CLI_SOCKET_UNSAFE = 'E_CLI_SOCKET_UNSAFE';

/**
 * Probe an existing unix-socket path and decide how the caller may proceed.
 *
 * @param {string} path            candidate socket path
 * @param {object} [opts]
 * @param {function} [opts.lstat]  lstatSync-like, returns fs.Stats or throws
 * @param {function} [opts.connect]  connect(path) -> net.Socket (default net.connect)
 * @param {number}  [opts.connectTimeoutMs]
 * @returns {Promise<{action:'bind'} | {action:'active', code:string} |
 *                    {action:'removeStale', stats:object} |
 *                    {action:'error', code:string, message:string}>}
 */
export async function probeCliSocketPath(path, {
  lstat = lstatSync,
  connect = netConnect,
  connectTimeoutMs = 250,
} = {}) {
  let stats;
  try {
    stats = lstat(path);
  } catch (err) {
    if (err?.code === 'ENOENT') return { action: 'bind' };
    return {
      action: 'error',
      code: E_CLI_SOCKET_UNSAFE,
      message: `cannot stat ${path}: ${err?.code || String(err)}`,
    };
  }
  // Must be a real unix socket; a regular file or symlink is a foreign object.
  // isSocket() follows the lstat result, so a symlink is correctly rejected
  // instead of being followed.
  if (!stats.isSocket()) {
    return {
      action: 'error',
      code: E_CLI_SOCKET_UNSAFE,
      message: `${path} exists but is not a unix socket`,
    };
  }
  return new Promise((resolve) => {
    let settled = false;
    const socket = connect(path);
    socket.setTimeout(connectTimeoutMs);
    socket.once('connect', () => {
      settled = true;
      socket.destroy();
      resolve({ action: 'active', code: E_SOCKET_ALREADY_ACTIVE });
    });
    socket.once('error', (err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      // Vanished between lstat and connect: nothing to remove, bind freely.
      if (err?.code === 'ENOENT') return resolve({ action: 'bind' });
      // Socket file exists but no process is listening: stale, ours to clean.
      if (err?.code === 'ECONNREFUSED') return resolve({ action: 'removeStale', stats });
      resolve({
        action: 'error',
        code: E_CLI_SOCKET_UNSAFE,
        message: `socket probe failed: ${err?.code || String(err)}`,
      });
    });
    socket.once('timeout', () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({
        action: 'error',
        code: E_CLI_SOCKET_UNSAFE,
        message: `socket probe timed out for ${path}`,
      });
    });
  });
}

/**
 * A stale socket may only be unlinked when it is a socket owned by the
 * expected control uid. Foreign sockets (root-owned, other users) are never
 * removed: a stale cleanup must not cross an ownership boundary.
 *
 * @param {object} stats          fs.Stats of the stale socket (from lstat)
 * @param {object} [opts]
 * @param {number|undefined} [opts.expectedUid]  uid that must own the socket
 * @returns {boolean}
 */
export function mayRemoveStaleSocket(stats, { expectedUid } = {}) {
  if (!stats || typeof stats.isSocket !== 'function' || !stats.isSocket()) return false;
  if (expectedUid === undefined) return true;
  return stats.uid === expectedUid;
}

/**
 * Record the (dev, ino) identity of the socket this process just bound, so
 * shutdown cleanup can prove it is still ours.
 *
 * @param {string} path
 * @param {function} [statSyncImpl]
 * @returns {{dev:number, ino:number}|null}
 */
export function recordSocketIdentity(path, statSyncImpl = statSync) {
  try {
    const stats = statSyncImpl(path);
    if (!stats.isSocket()) return null;
    return { dev: stats.dev, ino: stats.ino };
  } catch {
    return null;
  }
}

/**
 * True only when the path still holds the exact socket we created (same
 * device and inode). A replacement instance cannot bind the same path until
 * this process unlinks its own socket, so the (dev, ino) record is sound in
 * practice; the check also refuses non-sockets and missing paths. (Inode
 * numbers can be reused after an unlink, but only after our own socket is
 * gone, so a mismatch-free cleanup cannot remove a live replacement.)
 *
 * @param {string} path
 * @param {{dev:number, ino:number}|null} identity
 * @param {function} [lstatImpl]
 * @returns {boolean}
 */
export function shouldCleanupSocket(path, identity, lstatImpl = lstatSync) {
  if (!identity) return false;
  try {
    const stats = lstatImpl(path);
    if (!stats.isSocket()) return false;
    return stats.dev === identity.dev && stats.ino === identity.ino;
  } catch {
    return false;
  }
}
