import { randomBytes } from 'crypto';
import { isAuthenticated, issueSession, setCookie, hasValidOwnerSessionCookie } from '../lib/auth.mjs';
import { FILE_ASSET_ALLOWED_ORIGINS, LOCAL_WEB_AUTH_ENABLED } from '../lib/config.mjs';
import { shouldUseLocalWebAuth, isTunneledRequest } from '../lib/windows-local-runtime.mjs';

// ---- Rate limiting ----

const failedAttempts = new Map();
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

// Sliding-window rate limiter for device public endpoints (30 req/min per IP).
const devicePublicRateLog = new Map();
const DEVICE_PUBLIC_RATE_LIMIT = 30;
const DEVICE_PUBLIC_RATE_WINDOW_MS = 60 * 1000;

export function getClientIp(req) {
  return (
    req.headers['cf-connecting-ip'] ||
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket.remoteAddress ||
    'unknown'
  );
}

export function isRateLimited(ip) {
  const state = failedAttempts.get(ip);
  if (!state) return false;
  if (state.lockedUntil && Date.now() < state.lockedUntil) return true;
  return false;
}

export function recordFailedAttempt(ip) {
  const state = failedAttempts.get(ip) || { count: 0, lockedUntil: null };
  state.count += 1;
  if (state.count >= RATE_LIMIT_MAX) {
    const exponent = state.count - RATE_LIMIT_MAX;
    const backoffMs = Math.min(RATE_LIMIT_WINDOW_MS * Math.pow(2, exponent), 15 * 60 * 1000);
    state.lockedUntil = Date.now() + backoffMs;
  }
  failedAttempts.set(ip, state);
}

export function clearFailedAttempts(ip) {
  failedAttempts.delete(ip);
}

/**
 * Sliding-window rate limit check for device public endpoints.
 * Returns { exceeded: boolean, retryAfterMs: number }.
 */
export function checkDevicePublicRateLimit(ip) {
  const now = Date.now();
  let log = devicePublicRateLog.get(ip);
  if (!log) {
    log = [];
    devicePublicRateLog.set(ip, log);
  }
  // Prune timestamps outside the window.
  const windowStart = now - DEVICE_PUBLIC_RATE_WINDOW_MS;
  while (log.length > 0 && log[0] < windowStart) {
    log.shift();
  }
  if (log.length >= DEVICE_PUBLIC_RATE_LIMIT) {
    const retryAfterMs = log[0] + DEVICE_PUBLIC_RATE_WINDOW_MS - now;
    return { exceeded: true, retryAfterMs: Math.max(0, retryAfterMs) };
  }
  log.push(now);
  return { exceeded: false, retryAfterMs: 0 };
}

// ---- Security headers ----

const BASE_SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-UA-Compatible': 'IE=edge',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(self), geolocation=()',
};

export function setSecurityHeaders(res, nonce) {
  const connectSrc = ["'self'", 'ws:', 'wss:', ...FILE_ASSET_ALLOWED_ORIGINS];
  const mediaSrc = ["'self'", 'data:', 'blob:', ...FILE_ASSET_ALLOWED_ORIGINS];
  for (const [key, value] of Object.entries(BASE_SECURITY_HEADERS)) {
    res.setHeader(key, value);
  }
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    `connect-src ${connectSrc.join(' ')}`,
    `img-src ${mediaSrc.join(' ')}`,
    `media-src ${mediaSrc.join(' ')}`,
  ].join('; '));
}

export function generateNonce() {
  return randomBytes(16).toString('base64');
}

// ---- Auth middleware ----

/**
 * Returns true if the request is authenticated.
 * If not, writes a 401 JSON response for API routes or a 302 redirect for pages.
 */
export async function requireAuth(req, res) {
  if (shouldUseLocalWebAuth({
    enabled: LOCAL_WEB_AUTH_ENABLED,
    remoteAddress: req?.socket?.remoteAddress,
    url: req?.url,
    accept: req?.headers?.accept,
    viaTunnel: isTunneledRequest(req),
  })) {
    if (hasValidOwnerSessionCookie(req)) return true;
    const sessionToken = await issueSession({ role: 'owner', authMethod: 'local_web' });
    if (sessionToken) {
      if (!res.headersSent) res.setHeader('Set-Cookie', setCookie(sessionToken));
      return true;
    }
  }
  if (isAuthenticated(req)) return true;
  const { authenticateBearerToken } = await import('../lib/auth.mjs');
  if (await authenticateBearerToken(req)) return true;
  if ((req.url || '').startsWith('/api/')) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not authenticated' }));
    return false;
  }
  res.writeHead(302, { 'Location': '/login' });
  res.end();
  return false;
}
