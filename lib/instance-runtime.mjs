import { join } from 'node:path';

import {
  CLI_SOCKET_PATH,
  INSTANCE_IDENTITY_FILE,
  INSTANCE_ROOT,
  RUNTIME_DIR,
} from './config.mjs';
import { loadInstanceIdentity, loadOrCreateInstanceIdentity } from './instance-identity.mjs';
import { acquireInstanceOwnership } from './instance-ownership.mjs';
import { deriveWindowsEndpointName } from './windows-runtime-paths.mjs';

export const INSTANCE_RUNTIME_PLATFORM_REQUIRED = 'INSTANCE_RUNTIME_PLATFORM_REQUIRED';
export const INSTANCE_RUNTIME_IDENTITY_INVALID = 'INSTANCE_RUNTIME_IDENTITY_INVALID';
export const WINDOWS_SERVICE_OWNERSHIP_PROTOCOL_VERSION = 1;

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function runtimeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Establish the Windows per-user instance facts before the local CLI
 * endpoint is bound. The ownership marker is deliberately independent of
 * transport probing: a malformed or existing marker fails closed rather than
 * being treated as stale.
 */
export async function bootstrapInstanceRuntime({
  platform = process.platform,
  instanceRoot = INSTANCE_ROOT,
  identityFile = INSTANCE_IDENTITY_FILE,
  ownershipFile = join(RUNTIME_DIR, 'instance-ownership.json'),
  cliSocketPath = CLI_SOCKET_PATH,
  pid = process.pid,
  serviceOwnershipToken = process.env.RAGENT_WINDOWS_SERVICE_MODE === '1'
    && process.env.RAGENT_WINDOWS_SERVICE_ROLE === 'control'
    ? process.env.RAGENT_SERVICE_OWNERSHIP_TOKEN : undefined,
  loadIdentityImpl = loadOrCreateInstanceIdentity,
  acquireOwnershipImpl = acquireInstanceOwnership,
} = {}) {
  if (platform !== 'win32') {
    return Object.freeze({
      platform,
      instanceId: '',
      endpointName: trimString(cliSocketPath),
      release: async () => ({ ok: true, skipped: true }),
    });
  }

  const normalizedRoot = trimString(instanceRoot);
  if (!normalizedRoot) {
    throw runtimeError(
      INSTANCE_RUNTIME_PLATFORM_REQUIRED,
      'Windows instance runtime requires a per-user instance root',
    );
  }
  const identity = await loadIdentityImpl({ filePath: identityFile });
  const instanceId = trimString(identity?.instanceId);
  if (!instanceId) {
    throw runtimeError(
      INSTANCE_RUNTIME_IDENTITY_INVALID,
      'Windows instance identity did not contain an instanceId',
    );
  }
  const endpointName = deriveWindowsEndpointName({
    instanceRoot: normalizedRoot,
    instanceId,
  });
  // A per-child correlation nonce, not an authorization credential. The
  // native parent still proves process/file identity before any recovery.
  if (serviceOwnershipToken && !/^svc_[a-f0-9]{32}$/.test(serviceOwnershipToken)) {
    throw runtimeError(INSTANCE_RUNTIME_IDENTITY_INVALID, 'Invalid service ownership correlation token');
  }
  const ownership = await acquireOwnershipImpl({
    filePath: ownershipFile,
    instanceId,
    endpointName,
    pid,
    ...(serviceOwnershipToken ? { token: serviceOwnershipToken } : {}),
  });
  if (!ownership || typeof ownership.release !== 'function') {
    throw runtimeError(
      INSTANCE_RUNTIME_IDENTITY_INVALID,
      'Windows instance ownership did not return a release function',
    );
  }

  let releasePromise = null;
  const release = () => {
    if (!releasePromise) {
      releasePromise = Promise.resolve().then(() => ownership.release());
      releasePromise.catch(() => {
        releasePromise = null;
      });
    }
    return releasePromise;
  };

  return Object.freeze({
    platform,
    instanceId,
    endpointName,
    ownershipFile,
    release,
  });
}

/**
 * Resolve the endpoint for a local CLI caller without acquiring ownership.
 * The server owns the marker; clients only derive the same endpoint from the
 * durable instance identity.
 */
export async function resolveCliIpcEndpoint({
  platform = process.platform,
  cliSocketPath = CLI_SOCKET_PATH,
  instanceRoot = INSTANCE_ROOT,
  identityFile = INSTANCE_IDENTITY_FILE,
  loadIdentityImpl = loadInstanceIdentity,
} = {}) {
  if (platform !== 'win32') return trimString(cliSocketPath);
  const identity = await loadIdentityImpl({ filePath: identityFile });
  const instanceId = trimString(identity?.instanceId);
  if (!instanceId) {
    throw runtimeError(
      INSTANCE_RUNTIME_IDENTITY_INVALID,
      'Windows instance identity did not contain an instanceId',
    );
  }
  return deriveWindowsEndpointName({ instanceRoot, instanceId });
}
