// Runner-sidecar server for the real `agentoc-privileged` shim command
// (design docs/privileged-shim-channel-2026-09-03.md).
//
// The sidecar installs a per-Run launcher (`shim-bin/agentoc-privileged`) plus
// a per-Run unix socket (`shim.sock`), then
// prepends the launcher directory to the provider's PATH. A sentinel command
// that reaches a shell (Codex danger-full-access, agy, a bypassed gate) now
// executes the launcher instead of failing with "command not found".
//
// Each shim request is classified by the SAME risk pipeline the provider-gate
// path uses (classifyRisk + buildPrivilegedOp). Ops that do not require
// privileged execution are refused — the shim must never become a sandbox
// escape hatch for ordinary commands. Accepted ops are written onto the run
// record as `privilegedBatchPending` (+ `privilegedShimPending`), which routes
// them through the existing surface → owner approval → privileged-executor
// pipeline; the resolve/install-auto paths write `privilegedShimResult` back
// onto the Run record asynchronously after the client command has returned.

import { chmod, mkdir, mkdtemp, rm, rmdir, writeFile } from 'fs/promises';
import { delimiter, join, resolve } from 'path';
import { createServer } from 'net';
import { tmpdir } from 'os';

import { classifyRisk } from './risk-classifier.mjs';
import { buildPrivilegedBatch, buildPrivilegedOp } from './privileged-ops.mjs';
import { buildPrivilegedShimTerminalUpdate } from './privileged-approval.mjs';
import { getRun, isTerminalRunState, runDir, updateRun } from './runs.mjs';
import {
  DEFAULT_PRIVILEGED_SHIM_TIMEOUT_MS,
  MAX_PRIVILEGED_SHIM_REQUEST_BYTES,
  PRIVILEGED_SHIM_BIN_NAME,
  PRIVILEGED_SHIM_POLL_INTERVAL_MS,
  PRIVILEGED_SHIM_PROTOCOL_VERSION,
  PRIVILEGED_SHIM_RESULT_STATUS,
  PRIVILEGED_SHIM_SOCKET_ENV,
  PRIVILEGED_SHIM_TIMEOUT_ENV,
  parsePrivilegedShimRequest,
  shimOpRequiresPrivilegedExecution,
  shimResultFromRunPayload,
} from './privileged-shim-protocol.mjs';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeErrorMessage(error) {
  return error?.message || String(error);
}

function resolveShimTimeoutMs(explicitValue) {
  const explicit = Number(explicitValue);
  if (Number.isInteger(explicit) && explicit > 0) return Math.min(explicit, 24 * 60 * 60 * 1000);
  const configured = Number.parseInt(process.env[PRIVILEGED_SHIM_TIMEOUT_ENV] || '', 10);
  if (Number.isInteger(configured) && configured > 0) return Math.min(configured, 24 * 60 * 60 * 1000);
  return DEFAULT_PRIVILEGED_SHIM_TIMEOUT_MS;
}

// Launcher script: a plain POSIX sh trampoline so the provider's shell needs
// nothing but exec + the exact node runtime this sidecar itself runs on.
export function buildPrivilegedShimLauncherScript(nodePath, commandEntryPath) {
  const node = trimString(nodePath);
  const entry = trimString(commandEntryPath);
  if (!node || !entry || node.includes('"') || entry.includes('"')) {
    throw new Error('launcher node/entry paths must be non-empty and quote-free');
  }
  return [
    '#!/bin/sh',
    `exec "${node}" "${entry}" "$@"`,
    '',
  ].join('\n');
}

// Pure env injection so tests assert the provider-facing contract without a
// live sidecar.
export function applyPrivilegedShimSpawnEnv(spawnEnv, channel) {
  if (!spawnEnv || !channel?.binDir || !channel?.socketPath) return spawnEnv || null;
  const existing = trimString(spawnEnv.PATH);
  spawnEnv.PATH = existing ? `${channel.binDir}${delimiter}${existing}` : channel.binDir;
  spawnEnv[PRIVILEGED_SHIM_SOCKET_ENV] = channel.socketPath;
  return spawnEnv;
}

/**
 * Start the per-Run shim channel.
 *
 * @param {object} options
 * @param {string} options.runId — owning Run (also scopes the results dir).
 * @param {string} options.nodePath — node runtime for the launcher trampoline.
 * @param {string} options.commandEntryPath — absolute path to privileged-shim-command.mjs.
 * @param {string} [options.resultsDir] — defaults to the Run's own directory.
 * @param {Function} [options.getRun] / [options.updateRun] — store seams for tests.
 * @param {Function} [options.classifyRiskImpl] — risk seam for tests.
 * @param {Function} [options.isPrivilegeRoutingEnabledImpl] — routing seam (must be
 *   enabled; the server side re-checks as defense-in-depth).
 * @param {number} [options.timeoutMs] / [options.pollIntervalMs] — wait tuning.
 * @param {Function} [options.log] — diagnostic sink ({ message, details }).
 */
export async function startPrivilegedShimChannel({
  runId,
  nodePath,
  commandEntryPath,
  resultsDir = '',
  getRunImpl = getRun,
  updateRunImpl = updateRun,
  classifyRiskImpl = classifyRisk,
  timeoutMs = null,
  pollIntervalMs = PRIVILEGED_SHIM_POLL_INTERVAL_MS,
  log = null,
} = {}) {
  const normalizedRunId = trimString(runId);
  if (!normalizedRunId) throw new Error('runId is required');
  const node = trimString(nodePath) || process.execPath;
  const entry = trimString(commandEntryPath);
  if (!entry) throw new Error('commandEntryPath is required');

  const dir = trimString(resultsDir) || runDir(normalizedRunId);
  await mkdir(dir, { recursive: true });
  const baseDir = dir;
  const binDir = join(baseDir, 'shim-bin');
  const binPath = join(binDir, PRIVILEGED_SHIM_BIN_NAME);
  await mkdir(binDir, { recursive: true });
  await writeFile(binPath, buildPrivilegedShimLauncherScript(node, entry), { mode: 0o755 });
  await chmod(binPath, 0o755);

  let socketPath = join(baseDir, 'shim.sock');
  let shortSocketDir = '';
  // sockaddr_un is limited to 104 bytes on macOS and 108 on Linux. A Linux
  // sandbox also masks /tmp, /run and control-plane roots. In either case use
  // a private directory that can be bound into the sandbox without exposing
  // the Run results directory. mkdtemp creates it mode 0700.
  const resolvedSocketPath = resolve(socketPath);
  const masked = process.platform === 'linux' && ['/tmp', '/run', '/etc/agentoc', '/var/lib/agentoc/config'].some(
    (root) => resolvedSocketPath === root || resolvedSocketPath.startsWith(`${root}/`),
  );
  if (process.platform !== 'win32' && (Buffer.byteLength(socketPath) > 100 || masked)) {
    const temporaryRoot = resolve(tmpdir());
    // Bubblewrap hides these control-plane roots after other binds; a socket
    // created inside either root would disappear again inside the sandbox.
    const hidden = ['/etc/agentoc', '/var/lib/agentoc/config'].some(
      (root) => temporaryRoot === root || temporaryRoot.startsWith(`${root}/`),
    );
    let prefix = join(hidden ? '/tmp' : temporaryRoot, 'ragent-shim-');
    if (Buffer.byteLength(`${prefix}XXXXXX/shim.sock`) > 100) prefix = '/tmp/ragent-shim-';
    shortSocketDir = await mkdtemp(prefix);
    socketPath = join(shortSocketDir, 'shim.sock');
  }
  await rm(socketPath, { force: true });

  const channel = {
    runId: normalizedRunId,
    binDir,
    binPath,
    socketPath,
    // Only this fresh, private directory may be made visible to a provider
    // sandbox; the full results directory contains other Run credentials.
    socketBindDir: shortSocketDir,
    closed: false,
  };
  const timeoutBudgetMs = Math.max(1_000, resolveShimTimeoutMs(timeoutMs));

  const report = async (message, details = {}) => {
    if (typeof log === 'function') {
      await log(message, details);
    }
  };

  // One shim request at a time per Run: serializing keeps
  // privilegedBatchPending ownership unambiguous even though the client no
  // longer occupies a provider shell while approval is pending.
  let inflight = false;

  const writeFrame = (socket, frame) => {
    try {
      socket.write(`${JSON.stringify(frame)}\n`);
      return true;
    } catch {
      return false;
    }
  };

  const waitPrivileged = async (batch, pendingManifestHash) => {
    const deadlineAt = Date.now() + timeoutBudgetMs;
    const interval = Math.max(50, Number(pollIntervalMs) || PRIVILEGED_SHIM_POLL_INTERVAL_MS);
    while (true) {
      if (channel.closed) {
        return {
          status: PRIVILEGED_SHIM_RESULT_STATUS.CANCELLED,
          error: 'privileged shim channel closed before owner approval completed',
          writeBack: false,
        };
      }
      let current = null;
      try {
        current = await getRunImpl(normalizedRunId);
      } catch {
        // Transient store failure while the owner decides: keep waiting rather
        // than failing an op that may already be approved.
      }
      const result = current?.privilegedShimResult;
      if (result?.batchId === batch.batchId) {
        return {
          ...shimResultFromRunPayload(result, { manifestHash: pendingManifestHash }),
          writeBack: false,
        };
      }
      if (current?.cancelRequested === true || isTerminalRunState(current?.state)) {
        return {
          status: PRIVILEGED_SHIM_RESULT_STATUS.CANCELLED,
          error: 'run ended before owner approval completed',
          writeBack: true,
        };
      }
      if (Date.now() >= deadlineAt) {
        return {
          status: PRIVILEGED_SHIM_RESULT_STATUS.TIMEOUT,
          error: 'owner did not resolve the privileged batch in time',
          writeBack: true,
        };
      }
      await sleep(interval);
    }
  };

  const watchResolution = (batch, pendingManifestHash, requestId) => {
    const task = (async () => {
      const result = await waitPrivileged(batch, pendingManifestHash);
      if (result?.writeBack === true && !channel.closed) {
        const terminalUpdater = buildPrivilegedShimTerminalUpdate(
          { privilegedShimPending: { batchId: batch.batchId, requestId } },
          batch,
          { status: result.status, reason: result.error },
        );
        if (terminalUpdater) await updateRunImpl(normalizedRunId, terminalUpdater);
      }
      await report('Privileged shim request resolved asynchronously', {
        requestId,
        batchId: batch.batchId,
        status: result?.status || '',
      });
    })().catch(async (error) => {
      await report('Privileged shim asynchronous watcher failed', {
        requestId,
        batchId: batch.batchId,
        error: normalizeErrorMessage(error),
      });
    });
    return task;
  };

  const handleRequest = async (socket, raw) => {
    let payload = null;
    try {
      payload = JSON.parse(raw);
    } catch {
      writeFrame(socket, { v: PRIVILEGED_SHIM_PROTOCOL_VERSION, type: 'error', code: 'JSON_INVALID', message: 'request is not valid JSON' });
      return;
    }
    const parsed = parsePrivilegedShimRequest(payload);
    if (!parsed.ok) {
      writeFrame(socket, { v: PRIVILEGED_SHIM_PROTOCOL_VERSION, type: 'error', code: parsed.code, message: parsed.message });
      return;
    }
    const request = parsed.request;

    let risk = null;
    try {
      risk = classifyRiskImpl({
        command: request.command,
        toolName: 'Bash',
        toolInput: { command: request.command },
        cwd: request.cwd,
        declaredCategory: request.declaredCategory,
      });
    } catch (error) {
      writeFrame(socket, {
        v: PRIVILEGED_SHIM_PROTOCOL_VERSION,
        type: 'result',
        requestId: request.requestId,
        status: PRIVILEGED_SHIM_RESULT_STATUS.REFUSED,
        error: `risk classification failed: ${normalizeErrorMessage(error)}`,
      });
      return;
    }
    if (!shimOpRequiresPrivilegedExecution(risk)) {
      writeFrame(socket, {
        v: PRIVILEGED_SHIM_PROTOCOL_VERSION,
        type: 'result',
        requestId: request.requestId,
        status: PRIVILEGED_SHIM_RESULT_STATUS.REFUSED,
        error: 'command does not require privileged execution; run it directly in this session',
      });
      return;
    }
    // Session-level privileged routing is deliberately NOT checked here: the
    // config dir is masked inside the Run unit, so the sidecar cannot read the
    // session record. The server-side surface path is the authority and
    // declines with an explicit reason via privilegedShimResult.

    let op;
    try {
      op = buildPrivilegedOpForShim(request, risk);
    } catch (error) {
      writeFrame(socket, { v: PRIVILEGED_SHIM_PROTOCOL_VERSION, type: 'error', code: 'OP_INVALID', message: normalizeErrorMessage(error) });
      return;
    }
    const batch = buildPrivilegedBatch({ runId: normalizedRunId, turnId: '', ops: [op] });
    if (!batch?.batchId) {
      writeFrame(socket, { v: PRIVILEGED_SHIM_PROTOCOL_VERSION, type: 'error', code: 'BATCH_INVALID', message: 'unable to build the privileged batch' });
      return;
    }

    let claimed = false;
    const requestedAt = new Date();
    const expiresAt = new Date(requestedAt.getTime() + timeoutBudgetMs);
    try {
      await updateRunImpl(normalizedRunId, (current) => {
        // Never clobber a provider-gate batch already awaiting surfacing or an
        // in-flight shim request: the owner would see one batch while another
        // silently disappears.
        if (current?.privilegedBatchPending || current?.privilegedShimPending) return current;
        claimed = true;
        return {
          ...current,
          privilegedBatchPending: batch,
          privilegedShimPending: {
            requestId: request.requestId,
            batchId: batch.batchId,
            opId: op.opId,
            manifestHash: op.manifestHash,
            category: op.category,
            command: request.command,
            cwd: request.cwd,
            requestedAt: requestedAt.toISOString(),
            expiresAt: expiresAt.toISOString(),
          },
        };
      });
    } catch (error) {
      writeFrame(socket, { v: PRIVILEGED_SHIM_PROTOCOL_VERSION, type: 'error', code: 'RUN_STORE_FAILED', message: normalizeErrorMessage(error) });
      return;
    }
    if (!claimed) {
      writeFrame(socket, {
        v: PRIVILEGED_SHIM_PROTOCOL_VERSION,
        type: 'result',
        requestId: request.requestId,
        status: PRIVILEGED_SHIM_RESULT_STATUS.REFUSED,
        error: 'another privileged batch is already awaiting approval in this run; retry after it resolves',
      });
      return;
    }

    writeFrame(socket, {
      v: PRIVILEGED_SHIM_PROTOCOL_VERSION,
      type: 'accepted',
      requestId: request.requestId,
      batchId: batch.batchId,
    });
    // Start the watcher before diagnostic logging so a slow control-plane log
    // write cannot postpone timeout/cancellation handling.
    void watchResolution(batch, op.manifestHash, request.requestId);
    await report('Privileged shim request submitted for owner approval', {
      requestId: request.requestId,
      batchId: batch.batchId,
      category: op.category,
    });
  };

  const server = createServer((socket) => {
    if (channel.closed || inflight) {
      writeFrame(socket, {
        v: PRIVILEGED_SHIM_PROTOCOL_VERSION,
        type: 'error',
        code: 'BUSY',
        message: 'a privileged shim request is already in flight for this run',
      });
      socket.destroy();
      return;
    }
    inflight = true;
    let buffered = '';
    socket.on('data', (chunk) => {
      buffered += chunk.toString('utf8');
      if (Buffer.byteLength(buffered, 'utf8') > MAX_PRIVILEGED_SHIM_REQUEST_BYTES) {
        writeFrame(socket, { v: PRIVILEGED_SHIM_PROTOCOL_VERSION, type: 'error', code: 'REQUEST_TOO_LARGE', message: 'request exceeds size limit' });
        socket.destroy();
        return;
      }
      const newlineIndex = buffered.indexOf('\n');
      if (newlineIndex < 0) return;
      const raw = buffered.slice(0, newlineIndex);
      socket.removeAllListeners('data');
      void handleRequest(socket, raw.trim()).catch(async (error) => {
        writeFrame(socket, { v: PRIVILEGED_SHIM_PROTOCOL_VERSION, type: 'error', code: 'INTERNAL', message: normalizeErrorMessage(error) });
        await report('Privileged shim request failed', { error: normalizeErrorMessage(error) });
      }).finally(() => {
        inflight = false;
        socket.end();
      });
    });
    socket.on('error', () => {
      inflight = false;
    });
  });

  try {
    await new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(socketPath, () => resolveListen());
    });
  } catch (error) {
    if (shortSocketDir) await rmdir(shortSocketDir).catch(() => {});
    throw error;
  }
  await chmod(socketPath, 0o600).catch(() => {});

  channel.stop = async () => {
    if (channel.closed) return;
    channel.closed = true;
    await new Promise((resolveClose) => server.close(() => resolveClose()));
    await rm(socketPath, { force: true }).catch(() => {});
    if (shortSocketDir) await rmdir(shortSocketDir).catch(() => {});
  };

  return channel;
}

function buildPrivilegedOpForShim(request, risk) {
  // buildPrivilegedOp classifies via classifyPrivilegedOperation and computes
  // the manifest hash; the risk object rides along for the approval sheet
  // exactly like the provider-gate path (privileged-gate.mjs op shape).
  // buildPrivilegedBatch re-runs buildPrivilegedOp but preserves the opId, so
  // the pending record and the surfaced batch stay addressable.
  return buildPrivilegedOp({
    command: request.command,
    description: request.description,
    declaredCategory: request.declaredCategory,
    cwd: request.cwd,
    wrapperCommand: '',
    risk,
  });
}

export default startPrivilegedShimChannel;
