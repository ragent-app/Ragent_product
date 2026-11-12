// Protocol + policy for the real `agentoc-privileged` shim command (design
// docs/privileged-shim-channel-2026-09-03.md).
//
// The privileged sentinel (`chat/privileged-sentinel.mjs`) was historically
// interceptable ONLY at the provider permission gate (Claude bidi
// `can_use_tool` / Codex `requestApproval`). Runtimes whose sandbox auto-runs
// commands (Codex `danger-full-access`) or that have no gate at all (agy) let
// the sentinel text fall through to `/bin/sh`, which failed with
// "command not found" — the false-negative every misdiagnosis since 8-31
// started from.
//
// This module defines the provider-independent fallback: the runner sidecar
// installs a real `agentoc-privileged` launcher on the Run's PATH. When the
// sentinel reaches a shell, the launcher connects to a per-Run unix socket
// served by the sidecar, and the sidecar routes the op through the SAME
// batch → owner approval → privileged-executor pipeline the gate path uses.
// Pure logic + constants; I/O lives in privileged-shim-command.mjs (client)
// and privileged-shim-listener.mjs (sidecar).

export const PRIVILEGED_SHIM_PROTOCOL_VERSION = 1;

// Env names used by the per-Run sidecar and its provider-facing launcher.
export const PRIVILEGED_SHIM_SOCKET_ENV = 'AGENTOC_PRIVILEGED_SHIM_SOCKET';
export const PRIVILEGED_SHIM_TIMEOUT_ENV = 'AGENTOC_PRIVILEGED_SHIM_TIMEOUT_MS';
export const PRIVILEGED_SHIM_BIN_NAME = 'agentoc-privileged';

// Owner approval is a human checkpoint on a phone; mirror the gate path's
// unbounded waiting_user posture with a generous ceiling instead of a chatty
// retry loop.
export const DEFAULT_PRIVILEGED_SHIM_TIMEOUT_MS = 30 * 60 * 1000;
export const PRIVILEGED_SHIM_POLL_INTERVAL_MS = 500;

export const MAX_PRIVILEGED_SHIM_REQUEST_BYTES = 64 * 1024;
// Display cap per stream when handing executor output back to the provider.
// The durable audit copy stays in the approved-action resultRef.
export const MAX_PRIVILEGED_SHIM_OUTPUT_BYTES = 256 * 1024;

// Reserved shim outcomes use a distinct range from the common command exit
// values. `completed` still passes the executed command's own exit code through.
export const PRIVILEGED_SHIM_EXIT = Object.freeze({
  COMPLETED: 0,
  USAGE: 64, // bad arguments / unknown flag
  CHANNEL_UNAVAILABLE: 69, // no socket env, connect refused, channel dropped
  REFUSED: 70, // not a privileged op, channel busy, run went away
  DENIED: 74, // owner reviewed and denied the op
  TIMEOUT: 75, // owner did not resolve within the deadline
  EXEC_FAILED: 76, // approved but the privileged executor failed
  PENDING: 78, // accepted for owner approval; execution has not happened yet
});

export const PRIVILEGED_SHIM_RESULT_STATUS = Object.freeze({
  COMPLETED: 'completed',
  DENIED: 'denied',
  DECLINED: 'declined',
  REFUSED: 'refused',
  FAILED: 'failed',
  TIMEOUT: 'timeout',
  CANCELLED: 'cancelled',
});

const REQUEST_ID_RE = /^[A-Za-z0-9_.-]{6,128}$/;
const MAX_COMMAND_CHARS = 8 * 1024;
const MAX_DESCRIPTION_CHARS = 512;
const MAX_CWD_CHARS = 1024;

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function hasControlChars(value) {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f]/.test(value);
}

export function createPrivilegedShimRequestId() {
  const bytes = Math.random().toString(36).slice(2, 10);
  return `pshim_${Date.now().toString(36)}_${bytes}`;
}

/**
 * Validate one shim request frame (client → sidecar).
 * Returns { ok: true, request } or { ok: false, code, message }.
 */
export function parsePrivilegedShimRequest(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, code: 'REQUEST_INVALID', message: 'request must be a JSON object' };
  }
  if (payload.v !== PRIVILEGED_SHIM_PROTOCOL_VERSION) {
    return { ok: false, code: 'REQUEST_VERSION', message: `unsupported protocol version ${JSON.stringify(payload.v ?? null)}` };
  }
  if (payload.type !== 'request') {
    return { ok: false, code: 'REQUEST_TYPE', message: 'frame type must be "request"' };
  }
  const requestId = trimString(payload.requestId);
  if (!REQUEST_ID_RE.test(requestId)) {
    return { ok: false, code: 'REQUEST_ID_INVALID', message: 'requestId must match [A-Za-z0-9_.-]{6,128}' };
  }
  const command = trimString(payload.command);
  if (!command) {
    return { ok: false, code: 'COMMAND_REQUIRED', message: 'command is required (text after "--")' };
  }
  if (command.length > MAX_COMMAND_CHARS) {
    return { ok: false, code: 'COMMAND_TOO_LONG', message: `command exceeds ${MAX_COMMAND_CHARS} characters` };
  }
  if (hasControlChars(command)) {
    return { ok: false, code: 'COMMAND_INVALID', message: 'command contains control characters' };
  }
  const description = trimString(payload.description);
  if (description.length > MAX_DESCRIPTION_CHARS) {
    return { ok: false, code: 'DESCRIPTION_TOO_LONG', message: `description exceeds ${MAX_DESCRIPTION_CHARS} characters` };
  }
  const declaredCategory = trimString(payload.declaredCategory);
  if (declaredCategory && !['install', 'other', 'delete'].includes(declaredCategory)) {
    return { ok: false, code: 'CATEGORY_INVALID', message: 'category must be install, other or delete' };
  }
  const cwd = trimString(payload.cwd);
  if (cwd.length > MAX_CWD_CHARS || hasControlChars(cwd)) {
    return { ok: false, code: 'CWD_INVALID', message: 'cwd must be a plain absolute path' };
  }
  return {
    ok: true,
    request: {
      requestId,
      runId: trimString(payload.runId),
      command,
      description,
      declaredCategory,
      cwd,
    },
  };
}

/**
 * The shim is a privilege-approval channel, not a sidecar-command escape hatch.
 * Inside a sandboxed provider (e.g. Codex workspace-write) any command could
 * otherwise be laundered through the socket and executed outside the sandbox.
 * Only ops the risk classifier already routes to privileged execution are
 * accepted; everything else must run in the provider's own shell.
 */
export function shimOpRequiresPrivilegedExecution(risk) {
  if (!risk || typeof risk !== 'object') return false;
  if (risk.tier === 'danger') return true;
  return risk?.signals?.needsPrivilegedExecution === true;
}

/**
 * Map a terminal shim outcome to the client process exit code + message.
 * `result` is the sidecar result frame (or a local error shape).
 */
export function resolveShimExit(result) {
  const status = trimString(result?.status);
  const error = trimString(result?.error);
  switch (status) {
    case PRIVILEGED_SHIM_RESULT_STATUS.COMPLETED:
      if (!Number.isInteger(result?.exitCode) || result.exitCode < 0 || result.exitCode > 255 || error) {
        return { code: PRIVILEGED_SHIM_EXIT.EXEC_FAILED, message: 'privileged execution outcome is unknown; do not repeat it automatically' };
      }
      return {
        code: result.exitCode,
        message: '',
      };
    case PRIVILEGED_SHIM_RESULT_STATUS.DENIED:
      return {
        code: PRIVILEGED_SHIM_EXIT.DENIED,
        message: error || 'owner denied this privileged operation',
      };
    case PRIVILEGED_SHIM_RESULT_STATUS.DECLINED:
      return {
        code: PRIVILEGED_SHIM_EXIT.REFUSED,
        message: error || 'privileged routing is not enabled for this session',
      };
    case PRIVILEGED_SHIM_RESULT_STATUS.REFUSED:
      return {
        code: PRIVILEGED_SHIM_EXIT.REFUSED,
        message: error || 'command does not require privileged execution; run it directly',
      };
    case PRIVILEGED_SHIM_RESULT_STATUS.FAILED:
      return {
        code: PRIVILEGED_SHIM_EXIT.EXEC_FAILED,
        message: error || 'privileged execution failed',
      };
    case PRIVILEGED_SHIM_RESULT_STATUS.TIMEOUT:
      return {
        code: PRIVILEGED_SHIM_EXIT.TIMEOUT,
        message: error || 'timed out waiting for owner approval',
      };
    case PRIVILEGED_SHIM_RESULT_STATUS.CANCELLED:
      return {
        code: PRIVILEGED_SHIM_EXIT.REFUSED,
        message: error || 'run ended before this privileged operation was resolved',
      };
    default:
      return {
        code: PRIVILEGED_SHIM_EXIT.EXEC_FAILED,
        message: error || `unknown shim result status ${status || '(empty)'}`,
      };
  }
}

// The provider command must not hold a shell slot open while a human reviews
// the request. Accepted means only that the request was persisted, never that
// the command ran.
export function resolveShimAccepted(frame = {}) {
  const batchId = trimString(frame?.batchId);
  return {
    code: PRIVILEGED_SHIM_EXIT.PENDING,
    message: `privileged operation submitted for owner approval${batchId ? ` (batch ${batchId})` : ''}; command has not run yet`,
  };
}

/**
 * Serialize the CLI argv tail (tokens after "--") back into one shell command
 * string. The provider's shell already split argv, so quoting must be rebuilt:
 * tokens that contain anything outside the conservative safe set are wrapped in
 * single quotes with the standard `'\''` escape.
 */
export function joinShimCommandTokens(tokens) {
  const list = Array.isArray(tokens) ? tokens : [];
  if (list.length === 0) return '';
  return list.map((token) => {
    const value = String(token);
    if (!value) return "''";
    if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
    return `'${value.replaceAll("'", `'\\''`)}'`;
  }).join(' ');
}

export function buildPrivilegedShimUsageText(program = PRIVILEGED_SHIM_BIN_NAME) {
  return [
    `Usage: ${program} --description "<why>" --category install|other|delete -- <real command>`,
    '',
    'Declares one privileged operation for owner approval. The request returns',
    'after it is accepted; the command runs as root via the AgentoC privileged',
    'executor only after the owner approves it, and the final result is recorded',
    'asynchronously on the Run.',
  ].join('\n');
}

/**
 * Translate the raw `privilegedShimResult` run-record payload written by the
 * chat server into a client result frame. `expect` carries the pending op's
 * manifestHash so the sidecar picks its own op out of a batch's results.
 */
export function shimResultFromRunPayload(runResult, expect = {}) {
  const status = trimString(runResult?.status);
  if (status === 'declined') {
    return {
      status: PRIVILEGED_SHIM_RESULT_STATUS.DECLINED,
      error: trimString(runResult?.reason) || 'privileged routing is not enabled for this session',
    };
  }
  if (status === 'timeout') {
    return {
      status: PRIVILEGED_SHIM_RESULT_STATUS.TIMEOUT,
      error: trimString(runResult?.reason) || 'timed out waiting for owner approval',
    };
  }
  if (status === 'cancelled') {
    return {
      status: PRIVILEGED_SHIM_RESULT_STATUS.CANCELLED,
      error: trimString(runResult?.reason) || 'run ended before this privileged operation was resolved',
    };
  }
  if (status !== 'resolved') {
    return {
      status: PRIVILEGED_SHIM_RESULT_STATUS.FAILED,
      error: trimString(runResult?.reason) || `unexpected shim result status ${status || '(empty)'}`,
    };
  }
  const results = Array.isArray(runResult?.results) ? runResult.results : [];
  const wanted = trimString(expect.manifestHash);
  const wantedOpId = trimString(expect.opId);
  const entry = wanted
    ? results.find((candidate) => trimString(candidate?.manifestHash) === wanted
        && (!wantedOpId || !trimString(candidate?.opId) || trimString(candidate?.opId) === wantedOpId))
      || results.find((candidate) => !trimString(candidate?.manifestHash)
        && wantedOpId && trimString(candidate?.opId) === wantedOpId)
    : wantedOpId
      ? results.find((candidate) => trimString(candidate?.opId) === wantedOpId)
      : results.length === 1 ? results[0] : null;
  if (!entry) {
    return {
      status: PRIVILEGED_SHIM_RESULT_STATUS.FAILED,
      error: 'privileged batch resolved without a matching per-op result',
    };
  }
  const state = trimString(entry.state);
  const ref = entry.resultRef && typeof entry.resultRef === 'object' ? entry.resultRef : {};
  const error = trimString(ref.error);
  if (state === 'completed') {
    if (!Number.isInteger(ref.exitCode) || ref.exitCode < 0 || ref.exitCode > 255 || error) {
      return { status: PRIVILEGED_SHIM_RESULT_STATUS.FAILED, error: 'privileged execution outcome is unknown; do not repeat it automatically' };
    }
    return {
      status: PRIVILEGED_SHIM_RESULT_STATUS.COMPLETED,
      exitCode: ref.exitCode,
      stdout: typeof ref.stdout === 'string' ? ref.stdout : '',
      stderr: typeof ref.stderr === 'string' ? ref.stderr : '',
      error: '',
    };
  }
  if (state === 'denied') {
    return {
      status: PRIVILEGED_SHIM_RESULT_STATUS.DENIED,
      error: error || 'owner denied this privileged operation',
    };
  }
  if (state === 'expired') {
    return {
      status: PRIVILEGED_SHIM_RESULT_STATUS.DECLINED,
      error: error || 'privileged batch expired before owner resolution',
    };
  }
  return {
    status: PRIVILEGED_SHIM_RESULT_STATUS.FAILED,
    error: error || `privileged execution did not complete (state ${state || 'unknown'})`,
  };
}
