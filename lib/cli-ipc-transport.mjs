// Local CLI IPC transport contract.
//
// Unix-like hosts keep the existing filesystem socket and its uid/inode
// ownership guard. Windows obtains its per-instance named-pipe endpoint and
// ownership lifecycle from P0-1's instance-runtime bootstrap. This module
// deliberately does not create, repair, or remove an instance marker.

export const CLI_IPC_BOOTSTRAP_REQUIRED = 'CLI_IPC_BOOTSTRAP_REQUIRED';
export const CLI_IPC_BOOTSTRAP_INVALID = 'CLI_IPC_BOOTSTRAP_INVALID';
export const CLI_IPC_REQUEST_BODY_REFUSED = 'CLI_IPC_REQUEST_BODY_REFUSED';
export const CLI_IPC_UNTRUSTED_PEER_CLAIM = 'CLI_IPC_UNTRUSTED_PEER_CLAIM';

const WINDOWS_PIPE_PREFIX = '\\\\.\\pipe\\ragent-';
const WINDOWS_PIPE_NAME = /^\\\\\.\\pipe\\ragent-[a-z0-9][a-z0-9._-]{0,159}$/i;
const UNTRUSTED_IDENTITY_HEADERS = Object.freeze([
  'x-ragent-instance-id',
  'x-ragent-peer-pid',
  'x-ragent-peer-sid',
  'x-windows-peer-pid',
  'x-windows-peer-sid',
]);

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function createContractError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function readHeader(headers, name) {
  if (!headers || typeof headers !== 'object') return '';
  const direct = headers[name];
  if (direct !== undefined) return Array.isArray(direct) ? direct.join(',') : String(direct);
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
  const value = key ? headers[key] : undefined;
  return Array.isArray(value) ? value.join(',') : value === undefined ? '' : String(value);
}

export function isWindowsCliPipeEndpoint(value) {
  const endpoint = trimString(value);
  return endpoint.startsWith(WINDOWS_PIPE_PREFIX) && WINDOWS_PIPE_NAME.test(endpoint);
}

/**
 * Resolve the platform transport before either listener starts.
 *
 * P0-1 owns bootstrapInstanceRuntime() and its marker semantics. The Windows
 * result consumed here is intentionally narrow:
 *   { instanceId, endpointName, release() }
 *
 * A missing/malformed hook fails closed. Unix/macOS never call the hook.
 */
export async function prepareCliIpcTransport({
  platform = process.platform,
  unixSocketPath,
  bootstrapInstanceRuntime,
} = {}) {
  if (platform !== 'win32') {
    const endpoint = trimString(unixSocketPath);
    if (!endpoint) {
      throw createContractError(CLI_IPC_BOOTSTRAP_INVALID, 'CLI Unix socket path is required');
    }
    return Object.freeze({
      kind: 'unix-socket',
      endpoint,
      instanceId: '',
      release: null,
    });
  }

  if (typeof bootstrapInstanceRuntime !== 'function') {
    throw createContractError(
      CLI_IPC_BOOTSTRAP_REQUIRED,
      'Windows CLI IPC requires the P0-1 instance-runtime bootstrap hook',
    );
  }

  const runtime = await bootstrapInstanceRuntime({
    purpose: 'local-cli',
    transport: 'named-pipe',
  });
  const instanceId = trimString(runtime?.instanceId);
  const endpoint = trimString(runtime?.endpointName);
  if (!instanceId || !isWindowsCliPipeEndpoint(endpoint) || typeof runtime?.release !== 'function') {
    throw createContractError(
      CLI_IPC_BOOTSTRAP_INVALID,
      'Windows instance-runtime bootstrap must return instanceId, a local Ragent pipe endpoint, and release()',
    );
  }

  return Object.freeze({
    kind: 'windows-named-pipe',
    endpoint,
    instanceId,
    // P0-4 invokes this lifecycle callback but never implements marker logic.
    release: runtime.release.bind(runtime),
  });
}

export function cliIpcListenTarget(transport) {
  if (transport?.kind === 'windows-named-pipe') {
    return Object.freeze({
      path: transport.endpoint,
      exclusive: true,
      // Node/libuv maps these flags to its IPC access policy. Never opt into
      // the documented all-users pipe permissions.
      readableAll: false,
      writableAll: false,
    });
  }
  return transport?.endpoint;
}

/**
 * The auth endpoint has no request body and trusts no caller-declared peer or
 * instance identity. Reject such claims before issuing an owner session.
 */
export function validateCliAuthRequest(req) {
  const headers = req?.headers || {};
  for (const name of UNTRUSTED_IDENTITY_HEADERS) {
    if (trimString(readHeader(headers, name))) {
      return Object.freeze({
        ok: false,
        statusCode: 400,
        code: CLI_IPC_UNTRUSTED_PEER_CLAIM,
      });
    }
  }

  const transferEncoding = trimString(readHeader(headers, 'transfer-encoding'));
  const rawContentLength = trimString(readHeader(headers, 'content-length'));
  const contentLength = rawContentLength ? Number(rawContentLength) : 0;
  if (transferEncoding || !Number.isSafeInteger(contentLength) || contentLength !== 0) {
    return Object.freeze({
      ok: false,
      statusCode: 413,
      code: CLI_IPC_REQUEST_BODY_REFUSED,
    });
  }
  return Object.freeze({ ok: true });
}
