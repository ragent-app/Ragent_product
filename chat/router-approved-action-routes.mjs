import { timingSafeEqual, createHash } from 'crypto';

import { readBody } from '../lib/utils.mjs';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}
function hashToken(value) {
  return createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function tokenMatches(provided, expectedHash) {
  const actual = Buffer.from(hashToken(provided), 'utf8');
  const expected = Buffer.from(trimString(expectedHash), 'utf8');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function isLoopback(req) {
  const address = trimString(req?.socket?.remoteAddress).replace(/^::ffff:/, '');
  return address === '127.0.0.1' || address === '::1' || address === 'localhost';
}

export async function handleApprovedActionInternalRoutes({
  req,
  res,
  pathname,
  writeJson,
  proposeApprovedActions,
} = {}) {
  if (pathname !== '/api/internal/approved-actions/propose' || req.method !== 'POST') return false;
  if (!isLoopback(req)) {
    writeJson(res, 403, { error: 'Approved action channel is local-only', code: 'APPROVED_ACTION_LOCAL_ONLY' });
    return true;
  }
  const token = trimString(req.headers?.['x-ragent-approved-action-token']);
  if (!token) {
    writeJson(res, 401, { error: 'Approved action channel token is required', code: 'APPROVED_ACTION_TOKEN_REQUIRED' });
    return true;
  }
  let payload;
  try {
    const body = await readBody(req, 64 * 1024);
    payload = body ? JSON.parse(body) : {};
  } catch (error) {
    writeJson(res, error.code === 'BODY_TOO_LARGE' ? 413 : 400, { error: 'Invalid approved action request', code: 'APPROVED_ACTION_REQUEST_INVALID' });
    return true;
  }
  try {
    const result = await proposeApprovedActions({ ...payload, token, tokenMatches });
    writeJson(res, result?.duplicate ? 200 : 202, result);
  } catch (error) {
    const status = ['APPROVED_ACTION_RUN_NOT_FOUND', 'APPROVED_ACTION_SESSION_NOT_FOUND'].includes(error?.code)
      ? 404
      : ['AGENT_CREATE_NOT_AUTHORIZED', 'APPROVED_ACTION_AUTO_DENIED'].includes(error?.code)
        ? 403
      : ['APPROVED_ACTION_TOKEN_INVALID', 'APPROVED_ACTION_LOCAL_ONLY'].includes(error?.code)
        ? 401
        : 400;
    writeJson(res, status, { error: error?.message || 'Approved action proposal failed', code: error?.code || 'APPROVED_ACTION_PROPOSAL_FAILED' });
  }
  return true;
}
