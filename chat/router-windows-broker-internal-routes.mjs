import { createHash, timingSafeEqual } from 'node:crypto';

import { readBody } from '../lib/utils.mjs';
import { isPrivilegeRoutingEnabled } from './approved-action-policy.mjs';
import { publishWindowsBrokerApprovalInvalidation } from './windows-broker-approval-invalidation.mjs';
import { validateWindowsOwnerDevice } from './windows-owner-device-authority.mjs';
import { readManagedCodexConversation, readOwnerCodexConversation } from './windows-owner-codex-history.mjs';
import { readEventsPage } from './history.mjs';
import {
  createWindowsPrivilegedBrokerClient,
  resolveWindowsBrokerProfileDecision,
  WINDOWS_BROKER_TARGET_ID,
} from './windows-privileged-broker.mjs';

const BASE = '/api/internal/windows-broker/service-restart';
const defaultClient = createWindowsPrivilegedBrokerClient();

function value(input) { return typeof input === 'string' ? input.trim() : ''; }
function id(input) { return /^[A-Za-z0-9._:-]{1,128}$/.test(value(input)); }
function error(code, message = code) { return Object.assign(new Error(message), { code }); }
function requestIdFor(runId, turnId, requestKey) {
  return `run-${createHash('sha256').update(JSON.stringify([runId, turnId, requestKey])).digest('hex').slice(0, 48)}`;
}
function loopback(req) {
  return ['127.0.0.1', '::1'].includes(value(req?.socket?.remoteAddress).replace(/^::ffff:/, ''));
}
function tokenMatches(provided, hash) {
  if (!provided || !/^[a-f0-9]{64}$/.test(value(hash))) return false;
  const actual = createHash('sha256').update(provided).digest();
  return timingSafeEqual(actual, Buffer.from(hash, 'hex'));
}

export async function handleWindowsBrokerInternalRoutes({
  req, res, pathname, writeJson, getRun, getRunManifest, getSession, listSessions,
  resolveSessionRiskMode, brokerClient = defaultClient, platform = process.platform, validateOwnerDevice = validateWindowsOwnerDevice,
} = {}) {
  if (pathname === '/api/internal/windows-broker/codex-history' && req.method === 'POST') {
    res.setHeader?.('Cache-Control', 'private, no-store');
    const controller = new AbortController();
    let disconnected = false;
    const timer = setTimeout(() => {
      controller.abort();
      if (!disconnected && !res.writableEnded) writeJson(res, 504, { code: 'OWNER_HISTORY_UNAVAILABLE', error: 'OWNER_HISTORY_UNAVAILABLE' });
    }, 115_000);
    timer.unref?.();
    const onClose = () => { if (!res.writableEnded) { disconnected = true; controller.abort(); } };
    res.once?.('close', onClose);
    try {
      if (!loopback(req) || platform !== 'win32') throw error('OWNER_HISTORY_UNAVAILABLE');
      const payload = JSON.parse(await readBody(req, 4096) || '{}');
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
          Object.keys(payload).some((key) => !['sessionId', 'runId', 'turnId'].includes(key)) ||
          !id(payload.sessionId) || !id(payload.runId) || !id(payload.turnId)) throw error('OWNER_HISTORY_UNAVAILABLE');
      const run = await getRun(payload.runId);
      const manifest = await getRunManifest(payload.runId);
      const channel = manifest?.options?.sessionControlChannel;
      const brokerChannel = manifest?.options?.windowsBrokerChannel;
      const requested = manifest?.options?.codexHistoryRequest?.sessionId;
      const principal = value(manifest?.options?.authenticatedPrincipalKind);
      const ownerDevice = manifest?.options?.authenticatedOwnerDevice || brokerChannel?.windowsOwnerDevice;
      const authorized = principal === 'owner' || (principal === 'trusted_device' && ownerDevice &&
        !manifest?.options?.temporaryControlAuthority && await validateOwnerDevice(ownerDevice));
      if (!authorized || run?.id !== payload.runId || run?.sessionId !== payload.sessionId || run?.state !== 'running' ||
          run.finalizedAt || run.cancelRequested || manifest?.sessionId !== payload.sessionId || manifest?.requestId !== payload.turnId ||
          channel?.runId !== payload.runId || channel?.sessionId !== payload.sessionId || channel?.turnId !== payload.turnId || channel?.scope ||
          !Number.isFinite(Date.parse(channel?.expiresAt)) || Date.parse(channel.expiresAt) <= Date.now() ||
          !tokenMatches(value(req.headers?.['x-ragent-session-control-token']), channel?.tokenHash) ||
          typeof requested !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requested)) {
        throw error('OWNER_HISTORY_UNAVAILABLE');
      }
      const matches = typeof listSessions === 'function' ? (await listSessions({ listSummary: true }))
        .filter((session) => typeof session.codexThreadId === 'string' && session.codexThreadId.toLowerCase() === requested.toLowerCase()) : [];
      if (matches.length > 1) throw error('OWNER_HISTORY_UNAVAILABLE');
      const assertActive = async () => {
        const current = await getRun(payload.runId);
        if (controller.signal.aborted || !current || current.state !== 'running' || current.finalizedAt || current.cancelRequested || Date.parse(channel.expiresAt) <= Date.now()) throw error('OWNER_HISTORY_UNAVAILABLE');
      };
      if (matches.length === 1) {
        const result = await readManagedCodexConversation(readEventsPage, matches[0], requested, { assertActive });
        await assertActive();
        if (principal === 'trusted_device' && !await validateOwnerDevice(ownerDevice)) throw error('OWNER_HISTORY_UNAVAILABLE');
        writeJson(res, 200, result);
        return true;
      }
      const scopedClient = { readCodexHistory: async (request) => {
        await assertActive();
        return brokerClient.readCodexHistory(request);
      } };
      const result = await readOwnerCodexConversation(scopedClient, requested, { signal: controller.signal });
      await assertActive();
      if (principal === 'trusted_device' && !await validateOwnerDevice(ownerDevice)) throw error('OWNER_HISTORY_UNAVAILABLE');
      writeJson(res, 200, result);
    } catch (cause) {
      const code = ['OWNER_HISTORY_NOT_FOUND', 'OWNER_HISTORY_ACCESS_DENIED', 'OWNER_HISTORY_CHANGED', 'OWNER_HISTORY_UNAVAILABLE', 'RATE_LIMITED'].includes(cause?.code)
        ? cause.code : 'OWNER_HISTORY_UNAVAILABLE';
      if (!controller.signal.aborted && !res.writableEnded && !disconnected) writeJson(res, 403, { code, error: code });
    } finally {
      clearTimeout(timer);
      res.removeListener?.('close', onClose);
    }
    return true;
  }
  if (pathname !== BASE || !['POST', 'GET'].includes(req.method)) return false;
  res.setHeader?.('Cache-Control', 'private, no-store');
  try {
    if (!loopback(req)) throw error('BROKER_RUN_LOCAL_ONLY');
    const token = value(req.headers?.['x-ragent-windows-broker-token']);
    if (!token) throw error('BROKER_RUN_TOKEN_REQUIRED');
    const query = req.method === 'GET' ? new URL(req.url, 'http://localhost').searchParams : null;
    if (query && [...query.keys()].length !== new Set(query.keys()).size) {
      throw error('BROKER_RUN_REQUEST_INVALID');
    }
    const payload = req.method === 'POST'
      ? JSON.parse(await readBody(req, 8192) || '{}')
      : Object.fromEntries(query);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
        Object.keys(payload).some((key) => !['sessionId', 'runId', 'turnId', 'requestKey'].includes(key)) ||
        !id(payload.sessionId) || !id(payload.runId) || !id(payload.turnId) || !id(payload.requestKey)) {
      throw error('BROKER_RUN_REQUEST_INVALID');
    }
    const run = await getRun(payload.runId);
    if (!run) throw error('BROKER_RUN_NOT_FOUND');
    if (value(run.id) !== payload.runId || value(run.sessionId) !== payload.sessionId) {
      throw error('BROKER_RUN_BINDING_INVALID');
    }
    const manifest = await getRunManifest(payload.runId);
    const channel = manifest?.options?.windowsBrokerChannel;
    if (value(manifest?.sessionId) !== payload.sessionId ||
        value(manifest?.requestId) !== payload.turnId ||
        value(channel?.turnId) !== payload.turnId ||
        !tokenMatches(token, channel?.tokenHash)) {
      throw error('BROKER_RUN_BINDING_INVALID');
    }
    const principal = value(manifest?.options?.authenticatedPrincipalKind);
    const ownerRun = principal === 'owner' || (principal === 'trusted_device' && channel?.windowsOwnerDevice &&
      !manifest?.options?.temporaryControlAuthority && await validateOwnerDevice(channel.windowsOwnerDevice));
    if (!ownerRun) throw error('BROKER_RUN_BINDING_INVALID');
    const requestId = requestIdFor(payload.runId, payload.turnId, payload.requestKey);
    if (req.method === 'POST') {
      if (value(run.state) !== 'running' || run.finalizedAt || run.cancelRequested) {
        throw error('BROKER_RUN_TERMINAL');
      }
      const session = await getSession(payload.sessionId);
      if (!session) throw error('BROKER_RUN_SESSION_NOT_FOUND');
      if (!isPrivilegeRoutingEnabled(session)) throw error('BROKER_PERMISSION_PROFILE_DENIED');
      const decision = resolveWindowsBrokerProfileDecision(resolveSessionRiskMode(session), platform);
      if (decision.decision !== 'require_device') throw error(decision.code);
      if (principal === 'trusted_device' && !await validateOwnerDevice(channel.windowsOwnerDevice)) {
        throw error('BROKER_RUN_BINDING_INVALID');
      }
      const response = await brokerClient.propose({
        requestId,
        sessionId: payload.sessionId,
        runId: payload.runId,
        turnId: payload.turnId,
        actionId: `restart-${requestId.slice(4, 36)}`,
        operation: 'service.restart',
        targetId: WINDOWS_BROKER_TARGET_ID,
      });
      publishWindowsBrokerApprovalInvalidation(response, { action: 'propose', requestId });
      writeJson(res, response?.type === 'error' ? 409 : 200, { requestId, ...response });
    } else {
      const response = await brokerClient.status(requestId);
      publishWindowsBrokerApprovalInvalidation(response, { action: 'status', requestId });
      writeJson(res, response?.type === 'error' ? 404 : 200, { requestId, ...response });
    }
  } catch (cause) {
    const code = cause?.code || 'BROKER_RUN_REQUEST_INVALID';
    const status = code === 'BROKER_RUN_NOT_FOUND' || code === 'BROKER_RUN_SESSION_NOT_FOUND' ? 404
      : code === 'BROKER_RUN_TERMINAL' ? 409
        : code === 'BROKER_RUN_LOCAL_ONLY' || code === 'BROKER_RUN_TOKEN_REQUIRED' || code === 'BROKER_RUN_BINDING_INVALID' ? 401
          : code.startsWith('BROKER_PERMISSION_') || code === 'BROKER_PLATFORM_UNSUPPORTED' ? 403
            : code === 'BROKER_PIPE_TIMEOUT' || code === 'BROKER_PIPE_UNAVAILABLE' ? 503 : 400;
    writeJson(res, status, { code, error: cause?.message || code });
  }
  return true;
}
