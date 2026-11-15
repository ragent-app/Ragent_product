import { createHash, timingSafeEqual } from 'node:crypto';

import { readBody } from '../lib/utils.mjs';
import {
  BROWSER_CAPABILITY_VERSION,
  validateBrowserCapabilityChannel,
} from './browser-capability.mjs';

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseTime(value) {
  const parsed = Date.parse(text(value));
  return Number.isFinite(parsed) ? parsed : NaN;
}

function hashToken(value) {
  return createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function tokenMatches(provided, expectedHash) {
  const actual = Buffer.from(hashToken(provided), 'utf8');
  const expected = Buffer.from(text(expectedHash), 'utf8');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function isLoopback(req) {
  const address = text(req?.socket?.remoteAddress).replace(/^::ffff:/, '');
  return address === '127.0.0.1' || address === '::1' || address === 'localhost';
}

function header(req, name) {
  return text(req?.headers?.[name]);
}

function bindingInput(req, payload = {}) {
  return {
    token: header(req, 'x-ragent-browser-token'),
    sessionId: text(payload.sessionId) || header(req, 'x-ragent-browser-session-id'),
    runId: text(payload.runId) || header(req, 'x-ragent-browser-run-id'),
    turnId: text(payload.turnId) || header(req, 'x-ragent-browser-turn-id'),
  };
}

async function authenticateBrowserBinding({ req, payload, getRun, getRunManifest } = {}) {
  if (!isLoopback(req)) {
    const error = new Error('Browser control channel is local-only');
    error.code = 'BROWSER_CONTROL_LOCAL_ONLY';
    throw error;
  }
  const binding = bindingInput(req, payload);
  if (!binding.token || !binding.sessionId || !binding.runId || !binding.turnId) {
    const error = new Error('Browser control channel binding is incomplete');
    error.code = 'BROWSER_CONTROL_BINDING_REQUIRED';
    throw error;
  }
  const run = await getRun(binding.runId);
  if (!run) {
    const error = new Error('Run not found');
    error.code = 'BROWSER_CONTROL_RUN_NOT_FOUND';
    throw error;
  }
  if (['completed', 'failed', 'cancelled'].includes(text(run.state)) || text(run.finalizedAt)) {
    const error = new Error('Browser control channel is closed because the Run is terminal');
    error.code = 'BROWSER_CONTROL_RUN_TERMINAL';
    throw error;
  }
  const manifest = await getRunManifest(binding.runId);
  const channel = manifest?.options?.browserChannel;
  const channelValidation = validateBrowserCapabilityChannel(channel, {
    runId: binding.runId,
    sessionId: binding.sessionId,
  });
  if (!channelValidation.valid) {
    const error = new Error('Browser control channel capability is invalid');
    error.code = 'BROWSER_CONTROL_CAPABILITY_INVALID';
    throw error;
  }
  if (!channel?.tokenHash || !tokenMatches(binding.token, channel.tokenHash)) {
    const error = new Error('Browser control channel token is invalid');
    error.code = 'BROWSER_CONTROL_TOKEN_INVALID';
    throw error;
  }
  const expiresAt = parseTime(channel.expiresAt);
  if (Number.isFinite(expiresAt) && Date.now() >= expiresAt) {
    const error = new Error('Browser control channel has expired');
    error.code = 'BROWSER_CONTROL_CAPABILITY_EXPIRED';
    throw error;
  }
  if (binding.sessionId !== text(run.sessionId) || text(manifest?.sessionId) !== text(run.sessionId)) {
    const error = new Error('Browser control channel session does not match the Run');
    error.code = 'BROWSER_CONTROL_SESSION_MISMATCH';
    throw error;
  }
  if (binding.turnId !== text(channel.turnId) || text(channel.version) !== BROWSER_CAPABILITY_VERSION) {
    const error = new Error('Browser control channel turn does not match the Run');
    error.code = 'BROWSER_CONTROL_TURN_MISMATCH';
    throw error;
  }
  return { binding, run, manifest };
}

function normalizedConfirmationId(value) {
  const id = text(value);
  return id && /^browser_[a-zA-Z0-9_-]{8,180}$/.test(id) ? id : '';
}

function confirmationStatus(events, approvalId, runId) {
  const request = events.find((event) => event?.type === 'approval_request'
    && event?.source === 'ragent-confirmation'
    && text(event.approvalId) === approvalId
    && text(event.runId) === runId);
  if (!request) return { state: 'not_found' };
  const response = events.find((event) => event?.type === 'approval_response'
    && event?.source === 'ragent-confirmation'
    && text(event.approvalId) === approvalId
    && text(event.runId) === runId);
  if (!response) return { state: 'pending', approvalId };
  return {
    state: response.decision === 'approve' ? 'approved' : 'denied',
    approvalId,
    decision: text(response.decision),
    status: text(response.status),
  };
}

export async function handleBrowserInternalRoutes({
  req,
  res,
  pathname,
  writeJson,
  getRun,
  getRunManifest,
  readRuntimeApprovalEvents,
  requestSessionConfirmation,
} = {}) {
  const isCreate = pathname === '/api/internal/browser/confirmations' && req.method === 'POST';
  const statusMatch = /^\/api\/internal\/browser\/confirmations\/([^/]+)$/.exec(pathname);
  const isStatus = Boolean(statusMatch) && req.method === 'GET';
  if (!isCreate && !isStatus) return false;

  let payload = {};
  if (isCreate) {
    try {
      payload = JSON.parse(await readBody(req, 24 * 1024) || '{}');
    } catch (error) {
      writeJson(res, error.code === 'BODY_TOO_LARGE' ? 413 : 400, {
        error: 'Invalid browser confirmation request',
        code: 'BROWSER_CONFIRMATION_REQUEST_INVALID',
      });
      return true;
    }
  }

  try {
    const auth = await authenticateBrowserBinding({ req, payload, getRun, getRunManifest });
    if (isStatus) {
      const approvalId = normalizedConfirmationId(decodeURIComponent(statusMatch[1]));
      if (!approvalId) {
        writeJson(res, 400, { error: 'Invalid browser confirmation id', code: 'BROWSER_CONFIRMATION_ID_INVALID' });
        return true;
      }
      const events = typeof readRuntimeApprovalEvents === 'function'
        ? await readRuntimeApprovalEvents(auth.run.sessionId, auth.run.id, approvalId)
        : [];
      writeJson(res, 200, confirmationStatus(events, approvalId, auth.run.id));
      return true;
    }

    const approvalId = normalizedConfirmationId(payload.approvalId)
      || `browser_${createHash('sha256').update(`${auth.run.id}:${auth.binding.turnId}:${text(payload.requestKey) || text(payload.operation) || 'action'}`, 'utf8').digest('hex').slice(0, 32)}`;
    const operation = text(payload.operation).slice(0, 120);
    const title = text(payload.title).slice(0, 180) || 'Browser action needs approval';
    const reason = text(payload.reason || payload.description).slice(0, 1200);
    const confirmation = await requestSessionConfirmation(auth.run.sessionId, {
      approvalId,
      title,
      reason,
      confirmLabel: 'Approve browser action',
      denyLabel: 'Deny',
      runId: auth.run.id,
      turnId: auth.binding.turnId,
      operation: operation || 'browser.action',
    });
    writeJson(res, confirmation.duplicate ? 200 : 201, {
      duplicate: confirmation.duplicate === true,
      approvalId,
      state: 'pending',
    });
  } catch (error) {
    const notFound = new Set(['BROWSER_CONTROL_RUN_NOT_FOUND']);
    const denied = new Set(['BROWSER_CONTROL_LOCAL_ONLY', 'BROWSER_CONTROL_TOKEN_INVALID']);
    const closed = new Set(['BROWSER_CONTROL_RUN_TERMINAL', 'BROWSER_CONTROL_CAPABILITY_EXPIRED']);
    const status = notFound.has(error?.code) ? 404 : denied.has(error?.code) ? 401 : closed.has(error?.code) ? 409 : 400;
    writeJson(res, status, { error: error?.message || 'Browser control request failed', code: error?.code || 'BROWSER_CONTROL_FAILED' });
  }
  return true;
}
