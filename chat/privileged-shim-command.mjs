#!/usr/bin/env node
// Real `agentoc-privileged` command (design docs/privileged-shim-channel-2026-09-03.md).
//
// The sidecar installs a per-Run launcher for this module on the provider's
// PATH (see privileged-shim-listener.mjs). When the privileged sentinel
// reaches a shell — because the provider has no approval gate (agy) or its
// sandbox auto-runs commands (Codex danger-full-access) — this process
// connects to the Run's shim socket and hands the op to the SAME
// batch → owner approval → privileged-executor pipeline the gate path uses.
//
// The command never executes anything itself and never reads stdin: it only
// submits the declared op and prints the immediate pending acknowledgement.
// When the callback channel is missing it fails with a self-describing error
// instead of the historical "command not found".

import { connect } from 'net';
import { pathToFileURL } from 'url';

import {
  MAX_PRIVILEGED_SHIM_OUTPUT_BYTES,
  MAX_PRIVILEGED_SHIM_REQUEST_BYTES,
  PRIVILEGED_SHIM_EXIT,
  PRIVILEGED_SHIM_PROTOCOL_VERSION,
  PRIVILEGED_SHIM_SOCKET_ENV,
  buildPrivilegedShimUsageText,
  createPrivilegedShimRequestId,
  joinShimCommandTokens,
  parsePrivilegedShimRequest,
  resolveShimAccepted,
  resolveShimExit,
} from './privileged-shim-protocol.mjs';

function fail(code, message) {
  process.stderr.write(`agentoc-privileged: ${message}\n`);
  process.exit(code);
}

function failUsage(message) {
  process.stderr.write(`agentoc-privileged: ${message}\n\n${buildPrivilegedShimUsageText()}\n`);
  process.exit(PRIVILEGED_SHIM_EXIT.USAGE);
}

// Parse argv with the same grammar the sentinel parser accepts at the provider
// gate: --description/--desc <value>, --category <value>, then "--" and the
// real command. Unknown flags before "--" are usage errors (never silently
// treated as part of the command).
export function parsePrivilegedShimArgv(argv) {
  const tokens = Array.isArray(argv) ? argv : [];
  let description = '';
  let category = '';
  let separatorSeen = false;
  const commandTokens = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = String(tokens[index] ?? '');
    if (separatorSeen) {
      commandTokens.push(token);
      continue;
    }
    if (token === '--') {
      separatorSeen = true;
      continue;
    }
    if (token === '--description' || token === '--desc') {
      const value = tokens[index + 1];
      if (typeof value !== 'string' || !value.trim()) {
        return { ok: false, message: `${token} requires a value` };
      }
      description = value.trim();
      index += 1;
      continue;
    }
    if (token === '--category') {
      const value = tokens[index + 1];
      if (typeof value !== 'string' || !value.trim()) {
        return { ok: false, message: '--category requires a value' };
      }
      category = value.trim();
      index += 1;
      continue;
    }
    if (token.startsWith('--')) {
      return { ok: false, message: `unknown option ${token}` };
    }
    // Bare words before "--" have no sentinel meaning; refuse instead of
    // guessing where the command starts.
    return { ok: false, message: `unexpected argument "${token}" (real command must follow "--")` };
  }
  if (!separatorSeen) {
    return { ok: false, message: 'missing "--" separator before the real command' };
  }
  const command = joinShimCommandTokens(commandTokens);
  if (!command.trim()) {
    return { ok: false, message: 'empty command after "--"' };
  }
  return { ok: true, description, declaredCategory: category, command };
}

function clampOutput(value) {
  const text = typeof value === 'string' ? value : '';
  if (Buffer.byteLength(text, 'utf8') <= MAX_PRIVILEGED_SHIM_OUTPUT_BYTES) return text;
  return `${Buffer.from(text, 'utf8').subarray(0, MAX_PRIVILEGED_SHIM_OUTPUT_BYTES - 3).toString('utf8')}...`;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${buildPrivilegedShimUsageText()}\n`);
    process.exit(0);
  }
  const parsedArgv = parsePrivilegedShimArgv(argv);
  if (!parsedArgv.ok) failUsage(parsedArgv.message);

  const socketPath = (process.env[PRIVILEGED_SHIM_SOCKET_ENV] || '').trim();
  if (!socketPath) {
    fail(
      PRIVILEGED_SHIM_EXIT.CHANNEL_UNAVAILABLE,
      'no privileged callback channel: AGENTOC_PRIVILEGED_SHIM_SOCKET is not set. '
      + 'This process was not started by a Ragent Run sidecar, so the privileged-approval '
      + 'flow cannot be reached from here. Report that managed approval is unavailable; '
      + 'do not bypass the approval channel.',
    );
  }

  const request = {
    v: PRIVILEGED_SHIM_PROTOCOL_VERSION,
    type: 'request',
    requestId: createPrivilegedShimRequestId(),
    runId: (process.env.AGENTOC_RUN_ID || '').trim(),
    command: parsedArgv.command,
    description: parsedArgv.description,
    declaredCategory: parsedArgv.declaredCategory,
    cwd: process.cwd(),
  };
  const payload = JSON.stringify(request);
  if (Buffer.byteLength(payload, 'utf8') > MAX_PRIVILEGED_SHIM_REQUEST_BYTES) {
    fail(PRIVILEGED_SHIM_EXIT.USAGE, 'command exceeds the shim request size limit');
  }

  const socket = connect(socketPath);
  let buffered = '';
  let settled = false;
  const connectTimer = setTimeout(() => {
    if (settled) return;
    settled = true;
    socket.destroy();
    fail(
      PRIVILEGED_SHIM_EXIT.CHANNEL_UNAVAILABLE,
      `privileged callback channel did not accept the request within 10 seconds at ${socketPath}`,
    );
  }, 10_000);
  connectTimer.unref?.();

  const finishWith = (result) => {
    if (settled) return;
    settled = true;
    clearTimeout(connectTimer);
    socket.destroy();
    const exit = resolveShimExit(result);
    if (exit.message) process.stderr.write(`agentoc-privileged: ${exit.message}\n`);
    if (result?.status === 'completed') {
      const stdout = clampOutput(result.stdout);
      const stderr = clampOutput(result.stderr);
      if (stdout) process.stdout.write(stdout.endsWith('\n') || !stdout ? stdout : `${stdout}\n`);
      if (stderr) process.stderr.write(stderr.endsWith('\n') || !stderr ? stderr : `${stderr}\n`);
    }
    process.exit(exit.code);
  };

  const finishAccepted = (frame) => {
    if (settled) return;
    settled = true;
    clearTimeout(connectTimer);
    socket.end();
    const accepted = resolveShimAccepted(frame);
    process.stderr.write(`agentoc-privileged: ${accepted.message}\n`);
    process.exit(accepted.code);
  };

  socket.on('connect', () => {
    socket.write(`${payload}\n`);
  });
  socket.on('data', (chunk) => {
    buffered += chunk.toString('utf8');
    let newlineIndex = buffered.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = buffered.slice(0, newlineIndex).trim();
      buffered = buffered.slice(newlineIndex + 1);
      newlineIndex = buffered.indexOf('\n');
      if (!line) continue;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        continue;
      }
      if (frame?.type === 'accepted') finishAccepted(frame);
      if (frame?.type === 'result') finishWith(frame);
      if (frame?.type === 'error') {
        finishWith({ status: 'failed', error: frame.message || frame.code || 'channel error' });
      }
    }
  });
  socket.on('error', (error) => {
    if (settled) return;
    clearTimeout(connectTimer);
    const missing = error?.code === 'ENOENT';
    const refused = error?.code === 'EACCES' || error?.code === 'ECONNREFUSED';
    fail(
      PRIVILEGED_SHIM_EXIT.CHANNEL_UNAVAILABLE,
      `privileged callback channel unavailable (${error?.code || error?.message || 'unknown error'}) at ${socketPath}. `
      + `${missing ? 'The Run sidecar is not serving the shim socket (run may have ended or the channel failed to start). ' : ''}`
      + `${refused ? 'The socket exists but is not connectable from this sandbox. ' : ''}`
      + 'Report that managed approval is unavailable; do not bypass the approval channel.',
    );
  });
  socket.on('close', () => {
    if (!settled) finishWith({ status: 'failed', error: 'callback channel closed before a result arrived' });
  });

  const onSignal = (signal) => {
    if (settled) return;
    settled = true;
    socket.destroy();
    clearTimeout(connectTimer);
    process.stderr.write(`agentoc-privileged: aborted by ${signal}; the declared operation may still be pending owner review\n`);
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));
}

// Testable entry: tests import parsePrivilegedShimArgv directly; the CLI only
// runs as main (same pathToFileURL guard as the runner sidecar).
const isMainEntry = (() => {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();
if (isMainEntry) {
  main();
}
