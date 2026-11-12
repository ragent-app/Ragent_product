// Building block for a future per-Run IPC channel. `peer` must come from the
// accepted socket's kernel SO_PEERCRED, never from the request body. The caller
// must load `expected` from root-controlled launch state, not from the peer.
// This check alone is not a complete authorization or result-publication flow.
import { readFile } from 'node:fs/promises';
import { isLinuxRunUnitLive, linuxRunUnitName, parseLinuxRunProcessIdentity } from './linux-run-unit-liveness.mjs';

export function matchesLinuxRunPeerCgroup(content, { runId, launchAttempt } = {}) {
  try {
    if (typeof content !== 'string' || content.length > 65536) return false;
    const unit = linuxRunUnitName(runId, launchAttempt);
    const entries = content.split('\n').filter(Boolean);
    return entries.length === 1 && entries[0] === `0::/agentoc.slice/agentoc-runners.slice/${unit}`;
  } catch { return false; }
}

export async function isLinuxRunPeerLive(expected, peer) {
  try {
    if (process.platform !== 'linux' || process.geteuid?.() !== 0 ||
        !Number.isSafeInteger(peer?.pid) || peer.pid <= 1 ||
        !Number.isSafeInteger(peer?.uid) || peer.uid <= 0 || peer.uid !== expected?.runnerUid ||
        !Number.isSafeInteger(peer?.gid) || peer.gid <= 0 || !await isLinuxRunUnitLive(expected)) return false;
    const base = `/proc/${peer.pid}`;
    const snapshot = async () => {
      const [status, stat, cgroup] = await Promise.all([
        readFile(`${base}/status`, 'utf8'), readFile(`${base}/stat`, 'utf8'), readFile(`${base}/cgroup`, 'utf8'),
      ]);
      const identity = parseLinuxRunProcessIdentity(status, stat, expected.runnerUid);
      const close = stat.lastIndexOf(')');
      const state = close < 0 ? '' : stat.slice(close + 1).trim().split(/\s+/, 1)[0];
      // SO_PEERCRED remains attached to a socket after its creator exits.
      // A zombie cannot remain an authorized sender through a passed fd.
      if (!/^[RSDTtI]$/.test(state)) return null;
      const groups = status.split('\n').filter(line => line.startsWith('Gid:'));
      const fields = groups.length === 1 ? groups[0].slice(4).trim().split(/\s+/) : [];
      if (fields.length !== 4 || fields.some(field => !/^\d+$/.test(field) || Number(field) !== peer.gid)) return null;
      return identity && matchesLinuxRunPeerCgroup(cgroup, expected) ? identity : null;
    };
    const first = await snapshot();
    if (!first || !await isLinuxRunUnitLive(expected)) return false;
    const second = await snapshot();
    return Boolean(second && first.startTime === second.startTime && await isLinuxRunUnitLive(expected));
  } catch { return false; }
}
