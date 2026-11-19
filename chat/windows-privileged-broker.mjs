import { createConnection } from 'node:net';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { validateWindowsSelectedInstallerFacts } from './windows-winget-installer-facts.mjs';
import { windowsServiceControlSigningBytes } from './windows-service-grant.mjs';

import { readBody } from '../lib/utils.mjs';
import {
  currentWindowsBrokerApprovalRevision,
  publishWindowsBrokerApprovalInvalidation,
  waitForWindowsBrokerApprovalChange,
} from './windows-broker-approval-invalidation.mjs';

export const WINDOWS_BROKER_PROTOCOL_VERSION = 2;
export const WINDOWS_BROKER_MAX_FRAME_BYTES = 64 * 1024;
export const WINDOWS_BROKER_TARGET_ID = 'Ragent-Broker-QA-Target';
export const WINDOWS_BROKER_REQUESTS_PATH = '/api/windows-privileged-broker/requests';
export const WINDOWS_BROKER_ENROLLMENTS_PATH = '/api/windows-privileged-broker/enrollments';
export const WINDOWS_BROKER_SERVICE_REQUESTS_PATH = '/api/windows-privileged-broker/service-requests';

// The first Broker operation is never predelegated. Autonomous profiles may
// propose it, but an enrolled device must sign every exact restart challenge.
// Conservative-auto denies side-effecting Broker operations entirely.
export function resolveWindowsBrokerProfileDecision(riskMode, platform = process.platform) {
  if (platform !== 'win32') return { decision: 'deny', code: 'BROKER_PLATFORM_UNSUPPORTED' };
  if (riskMode === 'conservative-auto') return { decision: 'deny', code: 'BROKER_PERMISSION_PROFILE_DENIED' };
  if (['full-auto', 'recommended', 'safe'].includes(riskMode)) {
    return { decision: 'require_device', code: 'BROKER_DEVICE_APPROVAL_REQUIRED' };
  }
  return { decision: 'deny', code: 'BROKER_PERMISSION_PROFILE_UNAVAILABLE' };
}

const PIPE_PATHS = Object.freeze({
  health: String.raw`\\.\pipe\Ragent.PrivilegedBroker.Health.v2`,
  request: String.raw`\\.\pipe\Ragent.PrivilegedBroker.Request.v2`,
});
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const DEVICE_ID_PATTERN = /^[a-f0-9]{64}$/;
const SIGNATURE_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BASE_PATH = WINDOWS_BROKER_REQUESTS_PATH;

function brokerError(code, message = code) {
  return Object.assign(new Error(message), { code });
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value, allowed) {
  return isRecord(value) && Object.keys(value).every((key) => allowed.includes(key));
}

function validId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function validateRequest(request) {
  if (!isRecord(request) || request.version !== WINDOWS_BROKER_PROTOCOL_VERSION) {
    throw brokerError('BROKER_REQUEST_INVALID');
  }
  if (request.type === 'codex_history.read') {
    if (!hasOnlyKeys(request, ['version', 'type', 'sessionId', 'cursor']) ||
        typeof request.sessionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(request.sessionId) ||
        typeof request.cursor !== 'string' || !/^(?:0|[1-9][0-9]{0,18}:[0-9a-f]{64})$/.test(request.cursor)) throw brokerError('BROKER_REQUEST_INVALID');
    return;
  }
  if (request.type === 'health') {
    if (!hasOnlyKeys(request, ['version', 'type'])) throw brokerError('BROKER_REQUEST_INVALID');
    return;
  }
  if (request.type === 'status') {
    if (!hasOnlyKeys(request, ['version', 'type', 'requestId']) || !validId(request.requestId)) {
      throw brokerError('BROKER_REQUEST_INVALID');
    }
    return;
  }
  if (request.type === 'pending') {
    if (!hasOnlyKeys(request, ['version', 'type', 'deviceId', 'cursor']) ||
        typeof request.deviceId !== 'string' || !DEVICE_ID_PATTERN.test(request.deviceId) ||
        (request.cursor !== undefined && !validId(request.cursor))) {
      throw brokerError('BROKER_REQUEST_INVALID');
    }
    return;
  }
  if (request.type === 'enrollment.pending') {
    if (!hasOnlyKeys(request, ['version', 'type', 'deviceId']) ||
        typeof request.deviceId !== 'string' || !DEVICE_ID_PATTERN.test(request.deviceId)) {
      throw brokerError('BROKER_REQUEST_INVALID');
    }
    return;
  }
  if (request.type === 'enrollment.complete') {
    if (!hasOnlyKeys(request, ['version', 'type', 'enrollmentId', 'verificationCode', 'signature']) ||
        !validId(request.enrollmentId) || !/^[0-9]{8}$/.test(request.verificationCode) ||
        typeof request.signature !== 'string' || request.signature.length === 0 || request.signature.length > 1024 ||
        !SIGNATURE_PATTERN.test(request.signature)) {
      throw brokerError('BROKER_REQUEST_INVALID');
    }
    return;
  }
  if (request.type === 'propose') {
    const keys = ['version', 'type', 'requestId', 'sessionId', 'runId', 'turnId', 'actionId', 'operation', 'targetId'];
    if (!hasOnlyKeys(request, keys) || !keys.slice(2, 7).every((key) => validId(request[key])) ||
        request.operation !== 'service.restart' || request.targetId !== WINDOWS_BROKER_TARGET_ID) {
      throw brokerError('BROKER_REQUEST_INVALID');
    }
    return;
  }
  if (request.type === 'decision') {
    if (!hasOnlyKeys(request, ['version', 'type', 'requestId', 'deviceId', 'choice', 'signature']) ||
        !validId(request.requestId) || typeof request.deviceId !== 'string' || !DEVICE_ID_PATTERN.test(request.deviceId) ||
        !['approve', 'deny'].includes(request.choice) || typeof request.signature !== 'string' ||
        request.signature.length === 0 || request.signature.length > 1024 || !SIGNATURE_PATTERN.test(request.signature)) {
      throw brokerError('BROKER_REQUEST_INVALID');
    }
    return;
  }
  if (request.type === 'auto_install.inspect') {
    const query = request.autoInspect;
    if (!hasOnlyKeys(request, ['version', 'type', 'autoInspect']) || !hasOnlyKeys(query, ['packageId', 'packageVersion']) ||
        typeof query.packageId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(query.packageId) ||
        typeof query.packageVersion !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+:-]{0,127}$/.test(query.packageVersion)) throw brokerError('BROKER_REQUEST_INVALID');
    return;
  }
  if (request.type === 'service.inspect') {
    const query = request.serviceInspect;
    if (!hasOnlyKeys(request, ['version', 'type', 'serviceInspect']) || !hasOnlyKeys(query, ['serviceName']) ||
        typeof query.serviceName !== 'string' || !query.serviceName || query.serviceName !== query.serviceName.trim() ||
        query.serviceName.length > 256 || /[\\/*?\x00-\x1f]/.test(query.serviceName)) throw brokerError('BROKER_REQUEST_INVALID');
    return;
  }
  if (request.type === 'service.deny' || request.type === 'service.approve') {
    if (!hasOnlyKeys(request, ['version', 'type', 'requestId', 'deviceId', 'deviceSignature']) || !validId(request.requestId) ||
        typeof request.deviceId !== 'string' || !DEVICE_ID_PATTERN.test(request.deviceId) ||
        typeof request.deviceSignature !== 'string' || request.deviceSignature.length === 0 || request.deviceSignature.length > 1024 ||
        !SIGNATURE_PATTERN.test(request.deviceSignature)) throw brokerError('BROKER_REQUEST_INVALID');
    return;
  }
  if (request.type === 'service.execute') {
    if (!hasOnlyKeys(request, ['version', 'type', 'serviceControl', 'signature', 'deviceId', 'deviceSignature']) ||
        typeof request.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(request.signature) ||
        typeof request.deviceId !== 'string' || !DEVICE_ID_PATTERN.test(request.deviceId) ||
        typeof request.deviceSignature !== 'string' || request.deviceSignature.length === 0 || request.deviceSignature.length > 1024 ||
        !SIGNATURE_PATTERN.test(request.deviceSignature)) throw brokerError('BROKER_REQUEST_INVALID');
    try { windowsServiceControlSigningBytes(request.serviceControl); } catch { throw brokerError('BROKER_REQUEST_INVALID'); }
    return;
  }
  if (request.type === 'service.review') {
    if (!hasOnlyKeys(request, ['version', 'type', 'serviceControl', 'signature', 'deviceId']) ||
        typeof request.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(request.signature) ||
        typeof request.deviceId !== 'string' || !DEVICE_ID_PATTERN.test(request.deviceId)) throw brokerError('BROKER_REQUEST_INVALID');
    try { windowsServiceControlSigningBytes(request.serviceControl); } catch { throw brokerError('BROKER_REQUEST_INVALID'); }
    return;
  }
  if (request.type === 'service.propose') {
    if (!hasOnlyKeys(request, ['version', 'type', 'serviceControl', 'signature']) || typeof request.signature !== 'string' ||
        !/^[A-Za-z0-9_-]{86}$/.test(request.signature)) throw brokerError('BROKER_REQUEST_INVALID');
    try { windowsServiceControlSigningBytes(request.serviceControl); } catch { throw brokerError('BROKER_REQUEST_INVALID'); }
    return;
  }
  if (request.type === 'service.pending') {
    if (!hasOnlyKeys(request, ['version', 'type', 'deviceId', 'cursor']) || typeof request.deviceId !== 'string' ||
        !DEVICE_ID_PATTERN.test(request.deviceId) || (request.cursor !== undefined && !validId(request.cursor))) throw brokerError('BROKER_REQUEST_INVALID');
    return;
  }
  if (request.type === 'owner_install.identity') {
    if (!hasOnlyKeys(request, ['version', 'type'])) throw brokerError('BROKER_REQUEST_INVALID');
    return;
  }
  if (request.type === 'owner_install.execute') {
    const grant = request.ownerInstall;
    const keys = ['version', 'keyId', 'brokerInstallationId', 'policyGeneration', 'instanceId', 'ownerSid', 'requestId', 'sessionId',
      'runId', 'turnId', 'actionId', 'nonce', 'packageId', 'packageVersion', 'source', 'installScope', 'issuedMs', 'expiresMs'];
    if (!hasOnlyKeys(request, ['version', 'type', 'ownerInstall', 'signature']) || !hasOnlyKeys(grant, keys) ||
        keys.some((key) => !Object.hasOwn(grant, key)) || grant.version !== 1 ||
        !['keyId', 'brokerInstallationId', 'requestId', 'sessionId', 'runId', 'turnId', 'actionId'].every((key) => validId(grant[key])) ||
        !/^inst_[a-f0-9]{32}$/.test(grant.instanceId || '') || grant.keyId !== grant.instanceId || !/^S-1-5-21-(?:\d+-){3}\d+$/.test(grant.ownerSid || '') ||
        !Number.isSafeInteger(grant.policyGeneration) || grant.policyGeneration < 1 || !/^[A-Za-z0-9_-]{24,128}$/.test(grant.nonce || '') ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(grant.packageId || '') || !/^[A-Za-z0-9][A-Za-z0-9._+:-]{0,127}$/.test(grant.packageVersion || '') ||
        grant.source !== 'winget' || !['user', 'default'].includes(grant.installScope) || !Number.isSafeInteger(grant.issuedMs) || !Number.isSafeInteger(grant.expiresMs) ||
        grant.issuedMs <= 0 || grant.expiresMs <= grant.issuedMs || grant.expiresMs - grant.issuedMs > 60000 ||
        typeof request.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(request.signature)) throw brokerError('BROKER_REQUEST_INVALID');
    return;
  }
  if (request.type === 'msi_install.inspect') {
    const facts = request.msiInspect;
    if (!hasOnlyKeys(request, ['version', 'type', 'msiInspect']) || !hasOnlyKeys(facts, ['artifactPath', 'artifactSha256']) ||
        !validMSIPath(facts?.artifactPath) || !/^[a-f0-9]{64}$/.test(facts?.artifactSha256 || '')) throw brokerError('BROKER_REQUEST_INVALID');
    return;
  }
  if (request.type === 'msi_install.execute') {
    const grant = request.msiInstall;
    const keys = ['version','keyId','brokerInstallationId','policyGeneration','requestId','sessionId','runId','turnId','actionId','nonce','artifactPath','artifactSha256','publisherSha256','issuedMs','expiresMs'];
    if (!hasOnlyKeys(request, ['version','type','msiInstall','signature']) || !hasOnlyKeys(grant,keys) || keys.some((key)=>!Object.hasOwn(grant,key)) || grant.version !== 1 ||
      !['keyId','brokerInstallationId','requestId','sessionId','runId','turnId','actionId'].every((key)=>validId(grant[key])) ||
      !Number.isSafeInteger(grant.policyGeneration) || grant.policyGeneration < 1 || !/^[A-Za-z0-9_-]{24,128}$/.test(grant.nonce || '') ||
      !validMSIPath(grant.artifactPath) || !/^[a-f0-9]{64}$/.test(grant.artifactSha256 || '') || !/^[a-f0-9]{64}$/.test(grant.publisherSha256 || '') ||
      !Number.isSafeInteger(grant.issuedMs) || !Number.isSafeInteger(grant.expiresMs) || grant.issuedMs <= 0 || grant.expiresMs <= grant.issuedMs || grant.expiresMs - grant.issuedMs > 60000 ||
      typeof request.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(request.signature)) throw brokerError('BROKER_REQUEST_INVALID');
    return;
  }
  if (request.type === 'auto_install.execute') {
    const grant = request.autoInstall;
    const keys = ['version', 'keyId', 'brokerInstallationId', 'policyGeneration', 'requestId', 'sessionId',
      'runId', 'turnId', 'actionId', 'nonce', 'packageId', 'packageVersion', 'source', 'installScope', 'issuedMs', 'expiresMs'];
    const selectedKeys = ['id', 'version', 'source', 'scope', 'elevation', 'type', 'nestedType', 'architecture', 'locale'];
    const selected = grant?.selectedInstaller;
    const validSelection = selected === undefined || (hasOnlyKeys(selected, selectedKeys) && selectedKeys.every((key) => Object.hasOwn(selected, key)) &&
      Boolean(validateWindowsSelectedInstallerFacts(selected, { packageId: grant?.packageId, packageVersion: grant?.packageVersion })) &&
      selected.scope === 'System' && selected.elevation !== 'ElevationProhibited');
    if (!hasOnlyKeys(request, ['version', 'type', 'autoInstall', 'signature']) ||
        !hasOnlyKeys(grant, [...keys, 'selectedInstaller']) || !validSelection || keys.some((key) => !Object.hasOwn(grant, key)) || grant.version !== 1 ||
        !['keyId', 'brokerInstallationId', 'requestId', 'sessionId', 'runId', 'turnId', 'actionId'].every((key) => validId(grant[key])) ||
        !Number.isSafeInteger(grant.policyGeneration) || grant.policyGeneration < 1 ||
        typeof grant.nonce !== 'string' || !/^[A-Za-z0-9_-]{24,128}$/.test(grant.nonce) ||
        typeof grant.packageId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(grant.packageId) ||
        typeof grant.packageVersion !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+:-]{0,127}$/.test(grant.packageVersion) || grant.source !== 'winget' || grant.installScope !== 'machine' ||
        !Number.isSafeInteger(grant.issuedMs) || !Number.isSafeInteger(grant.expiresMs) || grant.issuedMs <= 0 ||
        grant.expiresMs <= grant.issuedMs || grant.expiresMs - grant.issuedMs > 60000 ||
        typeof request.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(request.signature)) {
      throw brokerError('BROKER_REQUEST_INVALID');
    }
    return;
  }
  throw brokerError('BROKER_REQUEST_INVALID');
}

function validMSIPath(value) {
  return typeof value === 'string' && /^[A-Za-z]:\\[^:*?"<>|%/\x00-\x1f]+\.msi$/i.test(value) &&
    value.slice(3).split('\\').every((part) => part && part !== '.' && part !== '..' && !/[. ]$/.test(part));
}

function validateResponse(response) {
  if (!isRecord(response) || response.version !== WINDOWS_BROKER_PROTOCOL_VERSION ||
      typeof response.type !== 'string' || !/^[a-z_]{1,48}$/.test(response.type)) {
    throw brokerError('BROKER_RESPONSE_INVALID');
  }
  return response;
}

function encodeFrame(request) {
  validateRequest(request);
  const payload = Buffer.from(JSON.stringify(request), 'utf8');
  if (payload.length === 0 || payload.length > WINDOWS_BROKER_MAX_FRAME_BYTES) {
    throw brokerError('BROKER_REQUEST_TOO_LARGE');
  }
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

function readResponseFrame(buffer, expectedLength) {
  let frameLength = expectedLength;
  if (frameLength === null && buffer.length >= 4) {
    frameLength = buffer.readUInt32LE(0);
    if (frameLength === 0 || frameLength > WINDOWS_BROKER_MAX_FRAME_BYTES) {
      throw brokerError('BROKER_RESPONSE_INVALID');
    }
  }
  if (frameLength === null || buffer.length < frameLength + 4) return { frameLength, response: null };
  if (buffer.length !== frameLength + 4) throw brokerError('BROKER_RESPONSE_INVALID');
  let response;
  try {
    response = JSON.parse(buffer.subarray(4).toString('utf8'));
  } catch {
    throw brokerError('BROKER_RESPONSE_INVALID');
  }
  return { frameLength, response: validateResponse(response) };
}

function exchangePipeFrame({ connect, pipePath, request, timeoutMs }) {
  const frame = encodeFrame(request);
  return new Promise((resolve, reject) => {
    let socket;
    let buffer = Buffer.alloc(0);
    let expectedLength = null;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        socket?.destroy();
        reject(error);
      } else {
        socket?.destroy();
        resolve(value);
      }
    };
    const timer = setTimeout(() => finish(brokerError('BROKER_PIPE_TIMEOUT')), timeoutMs);
    timer.unref?.();
    try {
      socket = connect({ path: pipePath, allowHalfOpen: true });
    } catch {
      finish(brokerError('BROKER_PIPE_UNAVAILABLE'));
      return;
    }
    socket.once('connect', () => {
      try {
        // Half-close the request direction. The Broker reads exactly one frame
        // and waits for request EOF before closing its response stream.
        socket.end(frame);
      } catch {
        finish(brokerError('BROKER_PIPE_UNAVAILABLE'));
      }
    });
    socket.on('data', (chunk) => {
      if (settled) return;
      buffer = Buffer.concat([buffer, chunk]);
      try {
        const parsed = readResponseFrame(buffer, expectedLength);
        expectedLength = parsed.frameLength;
        if (parsed.response) finish(null, parsed.response);
      } catch (error) {
        finish(error?.code ? error : brokerError('BROKER_RESPONSE_INVALID'));
      }
    });
    socket.once('error', () => finish(brokerError('BROKER_PIPE_UNAVAILABLE')));
    socket.once('close', () => {
      if (!settled) finish(brokerError('BROKER_PIPE_CLOSED'));
    });
  });
}

function exchangeViaServiceHost({ request, pipe, timeoutMs, serviceHostPath }) {
  const requestFrame = encodeFrame(request);
  const pipeArgument = pipe === 'health' ? 'health' : 'request';
  const executable = serviceHostPath || path.resolve(path.dirname(process.execPath), '..', 'Ragent.ServiceHost.exe');
  return new Promise((resolve, reject) => {
    let child;
    let buffer = Buffer.alloc(0);
    let settled = false;
    const finish = (error, response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        child?.kill();
        reject(error);
      } else {
        resolve(response);
      }
    };
    const timer = setTimeout(() => finish(brokerError('BROKER_PIPE_TIMEOUT')), timeoutMs + 5000);
    timer.unref?.();
    try {
      child = spawn(executable, ['--broker-pipe', pipeArgument], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch {
      finish(brokerError('BROKER_PIPE_UNAVAILABLE'));
      return;
    }
    child.once('error', () => finish(brokerError('BROKER_PIPE_UNAVAILABLE')));
    child.stdout.on('data', (chunk) => {
      if (settled) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > WINDOWS_BROKER_MAX_FRAME_BYTES + 4) {
        finish(brokerError('BROKER_RESPONSE_INVALID'));
      }
    });
    child.once('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        finish(brokerError('BROKER_PIPE_UNAVAILABLE'));
        return;
      }
      try {
        const parsed = readResponseFrame(buffer, null);
        if (!parsed.response) throw brokerError('BROKER_RESPONSE_INVALID');
        finish(null, parsed.response);
      } catch (error) {
        finish(error?.code ? error : brokerError('BROKER_RESPONSE_INVALID'));
      }
    });
    child.stdin.once('error', () => finish(brokerError('BROKER_PIPE_UNAVAILABLE')));
    child.stdin.end(requestFrame);
  });
}

export function createWindowsPrivilegedBrokerClient({
  connect = createConnection,
  platform = process.platform,
  timeoutMs = 5000,
  pipeExchange,
  serviceHostPath,
} = {}) {
  const useServiceHostBridge = platform === 'win32' && connect === createConnection;
  const rpc = (pipe, request, requestTimeoutMs = timeoutMs) => {
    if (platform !== 'win32') return Promise.reject(brokerError('BROKER_PLATFORM_UNSUPPORTED'));
    if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 100 || requestTimeoutMs > 30000) {
      return Promise.reject(brokerError('BROKER_CLIENT_CONFIGURATION_INVALID'));
    }
    try {
      if (pipeExchange) {
        encodeFrame(request);
        return pipeExchange({ pipe, request, timeoutMs: requestTimeoutMs });
      }
      if (useServiceHostBridge) return exchangeViaServiceHost({ request, pipe, timeoutMs: requestTimeoutMs, serviceHostPath });
      return exchangePipeFrame({ connect, pipePath: PIPE_PATHS[pipe], request, timeoutMs: requestTimeoutMs });
    } catch (error) {
      return Promise.reject(error?.code ? error : brokerError('BROKER_REQUEST_INVALID'));
    }
  };
  return Object.freeze({
    readCodexHistory: async ({ sessionId, cursor = '0' }) => {
      const response = await rpc('request', { version: WINDOWS_BROKER_PROTOCOL_VERSION, type: 'codex_history.read', sessionId, cursor }, 30000);
      if (response?.type === 'error') {
        const code = ['OWNER_HISTORY_NOT_FOUND', 'OWNER_HISTORY_ACCESS_DENIED', 'OWNER_HISTORY_CHANGED', 'OWNER_HISTORY_UNAVAILABLE', 'RATE_LIMITED'].includes(response.code)
          ? response.code : 'OWNER_HISTORY_UNAVAILABLE';
        throw brokerError(code);
      }
      const page = response?.codexHistory;
      const validCursor = typeof page?.nextCursor === 'string' && /^(?:0|[1-9][0-9]{0,18}:[0-9a-f]{64})$/.test(page.nextCursor);
      if (response?.type !== 'codex_history' || !isRecord(page) || page.sessionId?.toLowerCase() !== sessionId.toLowerCase() ||
          !Number.isSafeInteger(page.offset) || !Number.isSafeInteger(page.nextOffset) || !Number.isSafeInteger(page.size) ||
          page.offset < 0 || page.nextOffset < page.offset || page.size < page.nextOffset || page.size > 128 * 1024 * 1024 ||
          page.nextOffset - page.offset > 32768 || typeof page.complete !== 'boolean' ||
          page.complete !== (page.nextOffset === page.size) || (!page.complete && (!validCursor || page.nextOffset === page.offset)) ||
          typeof page.dataBase64 !== 'string' || !SIGNATURE_PATTERN.test(page.dataBase64)) throw brokerError('BROKER_RESPONSE_INVALID');
      const bytes = Buffer.from(page.dataBase64, 'base64');
      if (bytes.length !== page.nextOffset - page.offset || bytes.toString('base64') !== page.dataBase64) throw brokerError('BROKER_RESPONSE_INVALID');
      return page;
    },
    health: () => rpc('health', { version: WINDOWS_BROKER_PROTOCOL_VERSION, type: 'health' }),
    status: (requestId) => rpc('request', {
      version: WINDOWS_BROKER_PROTOCOL_VERSION, type: 'status', requestId,
    }),
    pending: ({ deviceId, cursor }) => rpc('request', {
      version: WINDOWS_BROKER_PROTOCOL_VERSION, type: 'pending', deviceId,
      ...(cursor ? { cursor } : {}),
    }),
    pendingEnrollment: ({ deviceId }) => rpc('request', {
      version: WINDOWS_BROKER_PROTOCOL_VERSION, type: 'enrollment.pending', deviceId,
    }),
    completeEnrollment: ({ enrollmentId, verificationCode, signature }) => rpc('request', {
      version: WINDOWS_BROKER_PROTOCOL_VERSION, type: 'enrollment.complete',
      enrollmentId, verificationCode, signature,
    }),
    propose: ({ requestId, sessionId, runId, turnId, actionId, operation, targetId }) => rpc('request', {
      version: WINDOWS_BROKER_PROTOCOL_VERSION, type: 'propose',
      requestId, sessionId, runId, turnId, actionId, operation, targetId,
    }),
    decision: ({ requestId, deviceId, choice, signature }) => rpc('request', {
      version: WINDOWS_BROKER_PROTOCOL_VERSION, type: 'decision',
      requestId, deviceId, choice, signature,
    }),
    executeMSIInstall: ({ grant, signature }) => rpc('request', {
      version: WINDOWS_BROKER_PROTOCOL_VERSION, type: 'msi_install.execute', msiInstall: grant, signature,
    }),
    inspectMSIInstall: async ({ artifactPath, artifactSha256 }) => {
      const response = await rpc('request', { version: WINDOWS_BROKER_PROTOCOL_VERSION, type: 'msi_install.inspect', msiInspect: { artifactPath, artifactSha256 } }, 30000);
      if (response?.type === 'error') throw brokerError(response.code || 'MSI_INSTALL_INSPECTION_FAILED');
      const facts = response?.msiFacts;
      if (response?.type !== 'msi_install_inspection' || !hasOnlyKeys(facts, ['artifactPath','artifactSha256','publisherSha256']) ||
          facts.artifactPath !== artifactPath || facts.artifactSha256 !== artifactSha256 || !/^[a-f0-9]{64}$/.test(facts.publisherSha256 || '')) throw brokerError('BROKER_RESPONSE_INVALID');
      return facts;
    },
    executeAutoInstall: ({ grant, signature }) => rpc('request', {
      version: WINDOWS_BROKER_PROTOCOL_VERSION, type: 'auto_install.execute', autoInstall: grant, signature,
    }),
    executeOwnerInstall: ({ grant, signature }) => rpc('request', {
      version: WINDOWS_BROKER_PROTOCOL_VERSION, type: 'owner_install.execute', ownerInstall: grant, signature,
    }),
    ownerInstallIdentity: async () => {
      const response = await rpc('request', { version: WINDOWS_BROKER_PROTOCOL_VERSION, type: 'owner_install.identity' });
      if (response?.type === 'error') throw brokerError(response.code || 'OWNER_INSTALL_POLICY_UNAVAILABLE');
      const identity = response?.ownerIdentity;
      if (response?.type !== 'owner_install_identity' || !hasOnlyKeys(identity, ['instanceId', 'ownerSid']) ||
          !/^inst_[a-f0-9]{32}$/.test(identity.instanceId || '') || !/^S-1-5-21-(?:\d+-){3}\d+$/.test(identity.ownerSid || '')) throw brokerError('BROKER_RESPONSE_INVALID');
      return identity;
    },
    inspectAutoInstall: async ({ packageId, packageVersion }) => {
      const response = await rpc('request', { version: WINDOWS_BROKER_PROTOCOL_VERSION, type: 'auto_install.inspect', autoInspect: { packageId, packageVersion } }, 30000);
      if (response?.type === 'error') throw brokerError(response.code || 'AUTO_INSTALL_INSPECTION_FAILED');
      const facts = validateWindowsSelectedInstallerFacts(response?.selectedInstaller, { packageId, packageVersion });
      if (response?.type !== 'auto_install_inspection' || !facts || facts.scope !== 'System') throw brokerError('BROKER_RESPONSE_INVALID');
      return facts;
    },
    inspectService: async ({ serviceName }) => {
      const response = await rpc('request', { version: WINDOWS_BROKER_PROTOCOL_VERSION, type: 'service.inspect', serviceInspect: { serviceName } });
      if (response?.type === 'error') throw brokerError(response.code || 'SERVICE_INSPECTION_FAILED');
      const facts = response?.serviceFacts;
      if (response?.type !== 'service_inspection' || !hasOnlyKeys(facts, ['serviceName', 'definitionHash']) ||
          facts.serviceName !== serviceName || !/^[a-f0-9]{64}$/.test(facts.definitionHash || '')) throw brokerError('BROKER_RESPONSE_INVALID');
      return { platform: 'win32', manager: 'windows-service', serviceName, exists: true, definitionHash: facts.definitionHash };
    },
    approveServiceControl: async ({ requestId, deviceId, deviceSignature }) => {
      const response = await rpc('request', { version: WINDOWS_BROKER_PROTOCOL_VERSION, type: 'service.approve', requestId, deviceId, deviceSignature });
      if (response?.type === 'error') throw brokerError(response.code || 'SERVICE_CONTROL_REJECTED');
      if (response?.type !== 'result' || response.requestId !== requestId ||
          !['executing', 'succeeded', 'failed', 'unknown', 'denied', 'expired'].includes(response.status)) throw brokerError('BROKER_RESPONSE_INVALID');
      return response;
    },
    denyServiceControl: async ({ requestId, deviceId, deviceSignature }) => {
      const response = await rpc('request', { version: WINDOWS_BROKER_PROTOCOL_VERSION, type: 'service.deny', requestId, deviceId, deviceSignature });
      if (response?.type === 'error') throw brokerError(response.code || 'SERVICE_CONTROL_REJECTED');
      if (response?.type !== 'result' || response.requestId !== requestId || response.status !== 'denied' || response.code !== 'DEVICE_DENIED') throw brokerError('BROKER_RESPONSE_INVALID');
      return response;
    },
    executeServiceControl: async ({ grant, signature, deviceId, deviceSignature }) => {
      const response = await rpc('request', { version: WINDOWS_BROKER_PROTOCOL_VERSION, type: 'service.execute', serviceControl: grant, signature, deviceId, deviceSignature });
      if (response?.type === 'error') throw brokerError(response.code || 'SERVICE_CONTROL_REJECTED');
      if (response?.type !== 'result' || response.requestId !== grant.requestId ||
          !['executing', 'succeeded', 'failed', 'unknown', 'denied', 'expired'].includes(response.status)) throw brokerError('BROKER_RESPONSE_INVALID');
      return response;
    },
    reviewServiceControl: async ({ grant, signature, deviceId }) => {
      const response = await rpc('request', { version: WINDOWS_BROKER_PROTOCOL_VERSION, type: 'service.review', serviceControl: grant, signature, deviceId });
      if (response?.type === 'error') throw brokerError(response.code || 'SERVICE_REVIEW_UNAVAILABLE');
      let actual;
      try { actual = windowsServiceControlSigningBytes(response?.serviceControl); } catch { throw brokerError('BROKER_RESPONSE_INVALID'); }
      if (response?.type !== 'service_review' || !actual.equals(windowsServiceControlSigningBytes(grant)) ||
          typeof response.brokerPublicKey !== 'string' || !response.brokerPublicKey ||
          typeof response.brokerSignature !== 'string' || !response.brokerSignature || !SIGNATURE_PATTERN.test(response.brokerSignature)) throw brokerError('BROKER_RESPONSE_INVALID');
      return response;
    },
    proposeServiceControl: async ({ grant, signature }) => {
      const response = await rpc('request', { version: WINDOWS_BROKER_PROTOCOL_VERSION, type: 'service.propose', serviceControl: grant, signature });
      if (response?.type === 'error') throw brokerError(response.code || 'SERVICE_PROPOSAL_REJECTED');
      if (response?.type !== 'result' || response.requestId !== grant.requestId ||
          !['awaiting_device', 'executing', 'succeeded', 'failed', 'unknown', 'expired', 'denied'].includes(response.status)) throw brokerError('BROKER_RESPONSE_INVALID');
      return response;
    },
    pendingServiceControls: async ({ deviceId, cursor }) => {
      const response = await rpc('request', { version: WINDOWS_BROKER_PROTOCOL_VERSION, type: 'service.pending', deviceId, ...(cursor ? { cursor } : {}) });
      if (response?.type === 'error') throw brokerError(response.code || 'SERVICE_PENDING_UNAVAILABLE');
      const items = response?.servicePending ?? [];
      if (response?.type !== 'service_pending' || !Array.isArray(items) || items.length > 16 || typeof response.hasMore !== 'boolean' ||
          (response.hasMore && !validId(response.nextCursor))) throw brokerError('BROKER_RESPONSE_INVALID');
      for (const item of items) {
        if (!hasOnlyKeys(item, ['grant', 'brokerPublicKey', 'brokerSignature']) || typeof item.brokerPublicKey !== 'string' || !item.brokerPublicKey ||
            typeof item.brokerSignature !== 'string' || !item.brokerSignature || !SIGNATURE_PATTERN.test(item.brokerSignature)) throw brokerError('BROKER_RESPONSE_INVALID');
        try { windowsServiceControlSigningBytes(item.grant); } catch { throw brokerError('BROKER_RESPONSE_INVALID'); }
      }
      return { items, hasMore: response.hasMore, nextCursor: response.nextCursor || '' };
    },
  });
}

const defaultWindowsBrokerClient = createWindowsPrivilegedBrokerClient();

function brokerHttpStatus(response) {
  if (response?.type !== 'error') return 200;
  if (response.code === 'REQUEST_INVALID' || response.code === 'PROTOCOL_UNSUPPORTED') return 400;
  if (response.code === 'REQUEST_ID_CONFLICT') return 409;
  if (response.code === 'RATE_LIMITED') return 429;
  if (response.code === 'ENROLLMENT_NOT_FOUND') return 404;
  if (response.code === 'ENROLLMENT_EXPIRED') return 410;
  if (response.code === 'ENROLLMENT_CODE_MISMATCH' || response.code === 'ENROLLMENT_SIGNATURE_INVALID') return 403;
  return 503;
}

function brokerHttpErrorStatus(error) {
  if (error?.code === 'BROKER_REQUEST_INVALID' || error?.code === 'BROKER_REQUEST_TOO_LARGE') return 400;
  if (error?.code === 'RATE_LIMITED') return 429;
  if (error?.code === 'BODY_TOO_LARGE') return 413;
  if (error?.code === 'BROKER_PLATFORM_UNSUPPORTED') return 501;
  return 503;
}

function decodeRequestId(value) {
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return '';
  }
  return validId(decoded) ? decoded : '';
}

async function readJsonBody(req) {
  const text = await readBody(req, 8192);
  let value;
  try {
    value = JSON.parse(text || '{}');
  } catch {
    throw brokerError('BROKER_REQUEST_INVALID');
  }
  if (!isRecord(value)) throw brokerError('BROKER_REQUEST_INVALID');
  return value;
}

function isOwner(authSession) {
  return authSession?.role === 'owner' && authSession?.principalKind !== 'run_capability';
}

function writeUnavailable(writeJson, res, error) {
  const status = brokerHttpErrorStatus(error);
  const code = status === 400 ? 'BROKER_REQUEST_INVALID'
    : status === 429 ? 'RATE_LIMITED'
    : status === 413 ? 'BROKER_REQUEST_TOO_LARGE'
      : status === 501 ? 'BROKER_PLATFORM_UNSUPPORTED'
        : error?.code === 'BROKER_PIPE_TIMEOUT' ? 'BROKER_PIPE_TIMEOUT'
          : 'BROKER_UNAVAILABLE';
  writeJson(res, status, { code, error: status === 501 ? 'Windows Broker is available only on Windows' : 'Windows Broker is unavailable' });
}

export async function handleWindowsPrivilegedBrokerRoutes({
  req,
  res,
  pathname,
  authSession,
  requireSessionAccess,
  getSession,
  resolveSessionRiskMode,
  authorizeServiceApproval,
  writeJson,
  reauthorizePending,
  brokerClient = defaultWindowsBrokerClient,
}) {
  const pendingPath = pathname === `${BASE_PATH}/pending`;
  const servicePendingPath = pathname === `${WINDOWS_BROKER_SERVICE_REQUESTS_PATH}/pending`;
  const serviceDecisionMatch = pathname.match(/^\/api\/windows-privileged-broker\/service-requests\/([^/]+)\/decision$/);
  const pendingEnrollmentPath = pathname === `${WINDOWS_BROKER_ENROLLMENTS_PATH}/pending`;
  const statusMatch = pendingPath ? null : pathname.match(/^\/api\/windows-privileged-broker\/requests\/([^/]+)$/);
  const decisionMatch = pathname.match(/^\/api\/windows-privileged-broker\/requests\/([^/]+)\/decision$/);
  const completeEnrollmentMatch = pathname.match(/^\/api\/windows-privileged-broker\/enrollments\/([^/]+)\/complete$/);
  if (pathname !== BASE_PATH && !statusMatch && !decisionMatch && !pendingPath && !servicePendingPath && !serviceDecisionMatch && !pendingEnrollmentPath && !completeEnrollmentMatch) return false;
  res.setHeader?.('Cache-Control', 'private, no-store');
  if (!isOwner(authSession)) {
    req.resume?.();
    writeJson(res, 403, { code: 'OWNER_ACCESS_REQUIRED', error: 'Owner access required' });
    return true;
  }

  if (servicePendingPath && req.method === 'GET') {
    try {
      const query = new URL(req.url, 'http://localhost').searchParams;
      const devices = query.getAll('deviceId'), cursors = query.getAll('cursor');
      if (devices.length !== 1 || !DEVICE_ID_PATTERN.test(devices[0]) || cursors.length > 1 ||
          (cursors.length && !validId(cursors[0])) || [...query.keys()].some(key => !['deviceId', 'cursor'].includes(key))) {
        throw brokerError('BROKER_REQUEST_INVALID');
      }
      const response = await brokerClient.pendingServiceControls({ deviceId: devices[0], ...(cursors.length ? { cursor: cursors[0] } : {}) });
      writeJson(res, 200, { type: 'service_pending', ...response });
    } catch (error) { writeUnavailable(writeJson, res, error); }
    return true;
  }

  if (serviceDecisionMatch && req.method === 'POST') {
    const requestId = decodeRequestId(serviceDecisionMatch[1]);
    try {
      if (!requestId) throw brokerError('BROKER_REQUEST_INVALID');
      const body = await readJsonBody(req);
      if (!hasOnlyKeys(body, ['deviceId', 'choice', 'deviceSignature']) || !DEVICE_ID_PATTERN.test(body.deviceId || '') ||
          !['approve', 'deny'].includes(body.choice) || typeof body.deviceSignature !== 'string' ||
          !body.deviceSignature || body.deviceSignature.length > 1024 || !SIGNATURE_PATTERN.test(body.deviceSignature)) {
        throw brokerError('BROKER_REQUEST_INVALID');
      }
      const current = await brokerClient.status(requestId);
      const grant = current?.serviceControl;
      if (current?.type !== 'result' || !grant || grant.requestId !== requestId || !validId(grant.sessionId) ||
          !validId(grant.runId) || !validId(grant.turnId)) {
        writeJson(res, 409, { code: 'BROKER_CHALLENGE_UNAVAILABLE', error: 'No Windows service request is available' });
        return true;
      }
      if (requireSessionAccess && !await requireSessionAccess(res, authSession, grant.sessionId)) return true;
      if (body.choice === 'approve') {
        if (typeof getSession !== 'function' || typeof resolveSessionRiskMode !== 'function') {
          writeJson(res, 503, { code: 'BROKER_SESSION_POLICY_UNAVAILABLE', error: 'Broker session policy is unavailable' });
          return true;
        }
        const session = await getSession(grant.sessionId);
        const riskMode = session && resolveSessionRiskMode(session);
        // Autonomous modes reject operations that require a human decision.
        if (!['safe', 'recommended'].includes(riskMode)) {
          writeJson(res, 403, { code: 'BROKER_PERMISSION_PROFILE_DENIED', error: 'Broker policy denied this operation' });
          return true;
        }
        if (typeof authorizeServiceApproval !== 'function' || !await authorizeServiceApproval(grant)) {
          writeJson(res, 409, { code: 'BROKER_RUN_NOT_ACTIVE', error: 'The original run or approval channel is no longer active' });
          return true;
        }
      }
      const payload = { requestId, deviceId: body.deviceId, deviceSignature: body.deviceSignature };
      const response = await (body.choice === 'approve' ? brokerClient.approveServiceControl(payload) : brokerClient.denyServiceControl(payload));
      publishWindowsBrokerApprovalInvalidation(response, { action: 'decision', requestId });
      writeJson(res, 200, response);
    } catch (error) { writeUnavailable(writeJson, res, error); }
    return true;
  }

  if (pathname === BASE_PATH && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const allowed = ['requestId', 'sessionId', 'runId', 'turnId', 'actionId', 'operation', 'targetId'];
      if (!hasOnlyKeys(body, allowed) || !allowed.every((key) => validId(body[key])) ||
          body.operation !== 'service.restart' || body.targetId !== WINDOWS_BROKER_TARGET_ID) {
        throw brokerError('BROKER_REQUEST_INVALID');
      }
      if (requireSessionAccess && !await requireSessionAccess(res, authSession, body.sessionId)) return true;
      if (typeof getSession !== 'function' || typeof resolveSessionRiskMode !== 'function') {
        writeJson(res, 503, { code: 'BROKER_SESSION_POLICY_UNAVAILABLE', error: 'Broker session policy is unavailable' });
        return true;
      }
      const session = await getSession(body.sessionId);
      if (!session) {
        writeJson(res, 404, { code: 'BROKER_SESSION_NOT_FOUND', error: 'Broker session was not found' });
        return true;
      }
      const profile = resolveWindowsBrokerProfileDecision(resolveSessionRiskMode(session));
      if (profile.decision !== 'require_device') {
        writeJson(res, 403, { code: profile.code, error: 'Broker policy denied this operation' });
        return true;
      }
      const response = await brokerClient.propose(body);
      publishWindowsBrokerApprovalInvalidation(response, { action: 'propose', requestId: body.requestId });
      writeJson(res, brokerHttpStatus(response), response);
    } catch (error) {
      writeUnavailable(writeJson, res, error);
    }
    return true;
  }

  if (statusMatch && req.method === 'GET') {
    const requestId = decodeRequestId(statusMatch[1]);
    if (!requestId) {
      writeJson(res, 400, { code: 'BROKER_REQUEST_INVALID', error: 'Invalid Broker request ID' });
      return true;
    }
    try {
      const response = await brokerClient.status(requestId);
      publishWindowsBrokerApprovalInvalidation(response, { action: 'status', requestId });
      writeJson(res, brokerHttpStatus(response), response);
    } catch (error) {
      writeUnavailable(writeJson, res, error);
    }
    return true;
  }

  if (decisionMatch && req.method === 'POST') {
    const requestId = decodeRequestId(decisionMatch[1]);
    if (!requestId) {
      writeJson(res, 400, { code: 'BROKER_REQUEST_INVALID', error: 'Invalid Broker request ID' });
      return true;
    }
    try {
      const body = await readJsonBody(req);
      if (!hasOnlyKeys(body, ['deviceId', 'choice', 'signature'])) throw brokerError('BROKER_REQUEST_INVALID');
      if (typeof getSession !== 'function' || typeof resolveSessionRiskMode !== 'function') {
        writeJson(res, 503, { code: 'BROKER_SESSION_POLICY_UNAVAILABLE', error: 'Broker session policy is unavailable' });
        return true;
      }
      const current = await brokerClient.status(requestId);
      const sessionId = trimString(current?.challenge?.sessionId);
      if (current?.type === 'error') {
        writeJson(res, brokerHttpStatus(current), current);
        return true;
      }
      if (current?.type !== 'result' || current.status !== 'awaiting_device' || !validId(sessionId)) {
        writeJson(res, 409, { code: 'BROKER_CHALLENGE_UNAVAILABLE', error: 'No pending Broker challenge is available' });
        return true;
      }
      const session = await getSession(sessionId);
      if (!session) {
        writeJson(res, 403, { code: 'BROKER_PERMISSION_PROFILE_DENIED', error: 'Broker policy denied this operation' });
        return true;
      }
      const profile = resolveWindowsBrokerProfileDecision(resolveSessionRiskMode(session));
      if (profile.decision !== 'require_device') {
        writeJson(res, 403, { code: profile.code, error: 'Broker policy denied this operation' });
        return true;
      }
      const response = await brokerClient.decision({ requestId, ...body });
      publishWindowsBrokerApprovalInvalidation(response, { action: 'decision', requestId });
      writeJson(res, brokerHttpStatus(response), response);
    } catch (error) {
      writeUnavailable(writeJson, res, error);
    }
    return true;
  }

  if (pendingEnrollmentPath && req.method === 'GET') {
    try {
      const query = new URL(req.url, 'http://localhost').searchParams;
      const deviceIds = query.getAll('deviceId');
      if (deviceIds.length !== 1 || !DEVICE_ID_PATTERN.test(deviceIds[0]) ||
          Array.from(query.keys()).some((key) => key !== 'deviceId')) {
        throw brokerError('BROKER_REQUEST_INVALID');
      }
      const response = await brokerClient.pendingEnrollment({ deviceId: deviceIds[0] });
      writeJson(res, brokerHttpStatus(response), response);
    } catch (error) {
      writeUnavailable(writeJson, res, error);
    }
    return true;
  }

  if (completeEnrollmentMatch && req.method === 'POST') {
    const enrollmentId = decodeRequestId(completeEnrollmentMatch[1]);
    if (!enrollmentId) {
      writeJson(res, 400, { code: 'BROKER_REQUEST_INVALID', error: 'Invalid Broker enrollment ID' });
      return true;
    }
    try {
      const body = await readJsonBody(req);
      if (!hasOnlyKeys(body, ['verificationCode', 'signature'])) throw brokerError('BROKER_REQUEST_INVALID');
      const response = await brokerClient.completeEnrollment({ enrollmentId, ...body });
      writeJson(res, brokerHttpStatus(response), response);
    } catch (error) {
      writeUnavailable(writeJson, res, error);
    }
    return true;
  }

  if (pendingPath && req.method === 'GET') {
    let deviceId;
    let cursor;
    try {
      const query = new URL(req.url, 'http://localhost').searchParams;
      const deviceIds = query.getAll('deviceId');
      const cursors = query.getAll('cursor');
      const revisions = query.getAll('afterRevision');
      const waits = query.getAll('waitMs');
      if (deviceIds.length !== 1 || cursors.length > 1 ||
          revisions.length > 1 || waits.length > 1 ||
          !DEVICE_ID_PATTERN.test(deviceIds[0]) || (cursors[0] && !validId(cursors[0])) ||
          (revisions.length && (!/^[0-9a-f-]{36}:[0-9]{1,16}$/.test(revisions[0]) || cursors.length)) ||
          (waits.length && (!revisions.length || !/^[1-9][0-9]{0,4}$/.test(waits[0]) || Number(waits[0]) > 15_000))) {
        throw brokerError('BROKER_REQUEST_INVALID');
      }
      deviceId = deviceIds[0];
      cursor = cursors[0] || undefined;
      for (const key of query.keys()) {
        if (!['deviceId', 'cursor', 'afterRevision', 'waitMs'].includes(key)) {
          throw brokerError('BROKER_REQUEST_INVALID');
        }
      }
      const afterRevision = revisions[0];
      const waitMs = afterRevision ? (waits.length ? Number(waits[0]) : 15_000) : 0;
      const controller = new AbortController();
      const onClose = () => controller.abort();
      res.on?.('close', onClose);
      try {
        // This wait holds no privileged pipe. Only the signed pending snapshot
        // below calls Broker, after a change or a bounded timeout.
        if (afterRevision) {
          await waitForWindowsBrokerApprovalChange(deviceId, afterRevision, waitMs, controller.signal);
        }
        if (controller.signal.aborted) return true;
        if (afterRevision) {
          const authorization = reauthorizePending && await reauthorizePending(req, authSession);
          if (controller.signal.aborted) return true;
          if (authorization !== true && authorization?.allowed !== true) {
            const status = authorization?.status === 401 ? 401 : 403;
            writeJson(res, status, {
              code: status === 401 ? 'AUTHENTICATION_REQUIRED' : 'OWNER_ACCESS_REQUIRED',
              error: status === 401 ? 'Authentication required' : 'Owner access required',
            });
            return true;
          }
        }
        const revision = currentWindowsBrokerApprovalRevision();
        const response = await brokerClient.pending({ deviceId, cursor });
        if (!controller.signal.aborted) {
          writeJson(res, brokerHttpStatus(response), response?.type === 'pending'
            ? { ...response, revision } : response);
        }
      } finally {
        res.off?.('close', onClose);
      }
    } catch (error) {
      if (error?.code === 'BROKER_WAIT_CAPACITY') {
        writeJson(res, 429, { code: error.code, error: 'Broker pending wait capacity reached', retryAfterMs: 1_000 });
      } else {
        writeUnavailable(writeJson, res, error);
      }
    }
    return true;
  }

  req.resume?.();
  res.setHeader?.('Allow', pathname === BASE_PATH || decisionMatch || completeEnrollmentMatch ? 'POST' : 'GET');
  writeJson(res, 405, { code: 'METHOD_NOT_ALLOWED', error: 'Method not allowed' });
  return true;
}
