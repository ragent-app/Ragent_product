/**
 * Run-scoped capability for the Ragent-managed browser MCP.
 *
 * The manifest carries only the binding and a token hash.  The detached
 * runner reads the bearer token from a 0600 file next to the Run, then passes
 * it to the local MCP child through its private environment.  Browser actions
 * remain subject to Session Confirmation at the control plane.
 */

import { createHash, randomBytes } from 'node:crypto';

export const BROWSER_CAPABILITY_VERSION = 'browser-capability/v1';
export const BROWSER_CONFIRMATION_ENDPOINT = '/api/internal/browser/confirmations';
export const BROWSER_CAPABILITY_TOKEN_FILE = 'browser.cap';
export const BROWSER_PROFILE_DIR = 'browser/profile';
export const BROWSER_ARTIFACT_DIR = 'browser/artifacts';
export const BROWSER_CAPABILITY_TTL_MS = 24 * 60 * 60 * 1000;
export const BROWSER_MCP_RUNTIME_FAMILIES = Object.freeze([
  'codex-app-server-json',
  'claude-stream-json-bidi',
]);

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function hashToken(value) {
  return createHash('sha256').update(text(value), 'utf8').digest('hex');
}

export function createRunBrowserCapability({
  runId,
  sessionId,
  turnId,
  now = Date.now(),
  ttlMs = BROWSER_CAPABILITY_TTL_MS,
} = {}) {
  const normalizedRunId = text(runId);
  const normalizedSessionId = text(sessionId);
  const normalizedTurnId = text(turnId);
  const issuedAtMs = typeof now === 'number' ? now : Date.parse(now);
  const ttl = Number.isFinite(ttlMs) && ttlMs > 0
    ? Math.min(ttlMs, BROWSER_CAPABILITY_TTL_MS)
    : BROWSER_CAPABILITY_TTL_MS;
  if (!normalizedRunId || !normalizedSessionId || !normalizedTurnId || !Number.isFinite(issuedAtMs)) {
    return null;
  }

  const token = randomBytes(32).toString('base64url');
  return Object.freeze({
    version: BROWSER_CAPABILITY_VERSION,
    endpoint: BROWSER_CONFIRMATION_ENDPOINT,
    token,
    tokenHash: hashToken(token),
    runId: normalizedRunId,
    sessionId: normalizedSessionId,
    turnId: normalizedTurnId,
    tokenFile: BROWSER_CAPABILITY_TOKEN_FILE,
    profileDir: BROWSER_PROFILE_DIR,
    artifactDir: BROWSER_ARTIFACT_DIR,
    artifactChannel: 'run-artifacts/v1',
    issuedAt: new Date(issuedAtMs).toISOString(),
    expiresAt: new Date(issuedAtMs + ttl).toISOString(),
  });
}

export function isBrowserCapabilityExpired(channel, now = Date.now()) {
  const expiresAt = Date.parse(text(channel?.expiresAt));
  const nowMs = typeof now === 'number' ? now : Date.parse(now);
  return Number.isFinite(expiresAt) && Number.isFinite(nowMs) && nowMs >= expiresAt;
}

export function validateBrowserCapabilityChannel(channel, {
  runId = '',
  sessionId = '',
  turnId = '',
} = {}) {
  const errors = [];
  const input = channel && typeof channel === 'object' && !Array.isArray(channel)
    ? channel
    : {};
  if (input.enabled !== true) errors.push('enabled must be true');
  if (text(input.version) !== BROWSER_CAPABILITY_VERSION) errors.push('unsupported capability version');
  if (text(input.endpoint) !== BROWSER_CONFIRMATION_ENDPOINT) errors.push('endpoint is invalid');
  if (!text(input.runId)) errors.push('runId is required');
  if (!text(input.sessionId)) errors.push('sessionId is required');
  if (!text(input.turnId)) errors.push('turnId is required');
  if (!/^[a-f0-9]{64}$/.test(text(input.tokenHash))) errors.push('tokenHash is invalid');
  if (text(input.tokenFile) !== BROWSER_CAPABILITY_TOKEN_FILE) errors.push('tokenFile is invalid');
  if (text(input.profileDir) !== BROWSER_PROFILE_DIR) errors.push('profileDir is invalid');
  if (text(input.artifactDir) !== BROWSER_ARTIFACT_DIR) errors.push('artifactDir is invalid');
  if (text(input.artifactChannel) !== 'run-artifacts/v1') errors.push('artifactChannel is invalid');
  if (!Number.isFinite(Date.parse(text(input.issuedAt)))) errors.push('issuedAt is invalid');
  if (!Number.isFinite(Date.parse(text(input.expiresAt)))) errors.push('expiresAt is invalid');
  if (runId && text(input.runId) !== text(runId)) errors.push('runId does not match context');
  if (sessionId && text(input.sessionId) !== text(sessionId)) errors.push('sessionId does not match context');
  if (turnId && text(input.turnId) !== text(turnId)) errors.push('turnId does not match context');
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
}

export function hashBrowserCapabilityToken(value) {
  return hashToken(value);
}

export function supportsBrowserMcpRuntime(runtimeFamily, { acp = false } = {}) {
  return acp === true || BROWSER_MCP_RUNTIME_FAMILIES.includes(text(runtimeFamily));
}
