import { randomBytes } from 'crypto';
import net from 'net';

// P3b — privileged executor client frame protocol
// (design: notes/current/privileged-approval-design.md §5.7;
// proposal: /var/lib/ragent/workspace/p3-executor-proposal-draft.md §2.1–§2.2).
//
// The frame contract is deliberately small: single-line JSON request with a
// `preq_` id prefix, single-line JSON response parsing, a
// MAX_RESPONSE_BYTES cap, and four socket-error codes. The request/response
// shapes carry a signed one-shot token (P3a) plus an optional auditLabel; the
// executor returns an `exec` result object aligned with spawnCaptured.
//
// This module is PURE TRANSPORT — no token logic, no signing, no auth. It owns
// the socket framing, timeouts, and error codes; the caller (P3d chat-server
// side) assembles the payload and handles the parsed response.

export const DEFAULT_PRIVILEGED_EXECUTOR_SOCKET_PATH = '/run/ragent-privileged-executor/sock';
export const PRIVILEGED_EXECUTOR_ACTION_EXEC = 'exec';
// A semantic capability is deliberately not valid for the legacy command
// string action. This action selects the executor's fixed-argv adapter path.
export const PRIVILEGED_EXECUTOR_ACTION_SEMANTIC_EXEC = 'semantic-exec';

const MAX_RESPONSE_BYTES = 6 * 1024 * 1024; // 6 MiB response framing limit

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function resolvePrivilegedExecutorSocketPath() {
  return trimString(process.env.RAGENT_PRIVILEGED_EXECUTOR_SOCKET) || DEFAULT_PRIVILEGED_EXECUTOR_SOCKET_PATH;
}

export function createPrivilegedExecutorRequestId() {
  return `preq_${randomBytes(10).toString('hex')}`;
}

/**
 * Send a request to the privileged executor over a Unix socket and return the
 * parsed single-line JSON response.
 *
 * @param {object} payload — request body (§2.2): `action`, `token`, and
 *   optionally `auditLabel`. `id` is auto-generated (preq_ prefix) when absent.
 * @param {object} [options]
 * @param {string} [options.socketPath] — override the socket path
 * @param {number} [options.timeoutMs] — socket timeout in ms (clamped [1s, 35min],
 *   default 15s)
 * @returns {Promise<object>} the parsed JSON response
 */
export function requestPrivilegedExecutor(payload = {}, options = {}) {
  const socketPath = trimString(options.socketPath) || resolvePrivilegedExecutorSocketPath();
  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(1_000, Math.min(35 * 60 * 1000, Number(options.timeoutMs)))
    : 15_000;
  const request = {
    ...payload,
    id: trimString(payload.id) || createPrivilegedExecutorRequestId(),
  };

  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    let responseBuffer = '';

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };

    socket.setTimeout(timeoutMs, () => {
      const error = new Error(`Privileged executor timed out after ${timeoutMs}ms`);
      error.code = 'PRIVILEGED_EXECUTOR_TIMEOUT';
      finish(error);
    });
    socket.on('connect', () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on('data', (chunk) => {
      responseBuffer += chunk.toString('utf8');
      if (Buffer.byteLength(responseBuffer, 'utf8') > MAX_RESPONSE_BYTES) {
        const error = new Error('Privileged executor response exceeded the size limit');
        error.code = 'PRIVILEGED_EXECUTOR_RESPONSE_TOO_LARGE';
        finish(error);
        return;
      }
      const newlineIndex = responseBuffer.indexOf('\n');
      if (newlineIndex < 0) return;
      try {
        finish(null, JSON.parse(responseBuffer.slice(0, newlineIndex)));
      } catch (error) {
        error.code = 'PRIVILEGED_EXECUTOR_INVALID_RESPONSE';
        finish(error);
      }
    });
    socket.on('error', (error) => finish(error));
    socket.on('end', () => {
      if (!settled) {
        const error = new Error('Privileged executor closed without a response');
        error.code = 'PRIVILEGED_EXECUTOR_EMPTY_RESPONSE';
        finish(error);
      }
    });
  });
}
