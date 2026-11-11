import { createHmac, randomBytes, timingSafeEqual, scrypt } from 'crypto';
import { readFile, writeFile } from 'fs/promises';
import { promisify } from 'util';
import {
  AUTH_FILE,
  AUTH_SESSIONS_FILE,
  AUTH_SESSIONS_DB_FILE,
  SESSION_EXPIRY,
  SECURE_COOKIES,
  LOCAL_WEB_AUTH_ENABLED,
} from './config.mjs';
import { resolveAuthSessionAgentId } from '../chat/session-source-resolution.mjs';
import { authenticateTrustedDeviceToken } from '../chat/trusted-devices.mjs';
import { shouldUseLocalWebAuth, isTunneledRequest } from './windows-local-runtime.mjs';
import { ensureWindowsOwnerAuth } from './windows-owner-auth-bootstrap.mjs';
import { openAuthSessionStore } from './auth-session-store.mjs';
import { allowsRemoteBinding, authorizeDeviceBinding } from './binding-authority-runtime.mjs';

const scryptAsync = promisify(scrypt);
const AUTH_COOKIE_NAME = 'session_token';
const VISITOR_COOKIE_NAME = 'visitor_session_token';
const AUTH_COOKIE_SAME_SITE = 'Lax';
const SESSION_REFRESH_WINDOW_MS = Math.min(
  12 * 60 * 60 * 1000,
  Math.max(60 * 1000, Math.floor(SESSION_EXPIRY / 2)),
);

// 会话 cookie 在事务库只存 HMAC 摘要，不存明文。旧 JSON 仅作一次迁移输入。
// secret 由 root 侧经 systemd EnvironmentFile 注入（/etc/agentoc/auth-secret），
// 会话进程（同 uid 兄弟进程）读不到服务进程环境/内存（yama ptrace_scope=1）。
const AUTH_SESSION_SECRET = process.env.AGENTOC_AUTH_SESSION_SECRET || '';
const SESSION_HASH_PREFIX = 's';
function sessionHashToken(token) {
  if (!AUTH_SESSION_SECRET) return '';
  return SESSION_HASH_PREFIX + createHmac('sha256', AUTH_SESSION_SECRET).update(token).digest('hex');
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeAuthSession(session) {
  if (!session || typeof session !== 'object') return null;
  const normalized = {
    ...session,
    role: session.role || 'owner',
  };
  const normalizedAgentId = resolveAuthSessionAgentId(session);
  if (normalizedAgentId) {
    normalized.agentId = normalizedAgentId;
    normalized.scope = session?.scope && typeof session.scope === 'object' && !Array.isArray(session.scope)
      ? {
          ...session.scope,
          agentId: normalizedAgentId,
        }
      : { agentId: normalizedAgentId };
  }
  if (Object.prototype.hasOwnProperty.call(normalized, 'appId')) {
    delete normalized.appId;
  }
  return normalized;
}

async function loadAuth() {
  try {
    return JSON.parse(await readFile(AUTH_FILE, 'utf8'));
  } catch (err) {
    if (process.platform === 'win32' && err?.code === 'ENOENT') {
      const bootstrap = await ensureWindowsOwnerAuth({
        authFile: AUTH_FILE,
        platform: process.platform,
      });
      if (bootstrap.created) {
        console.warn(`[auth] generated Windows owner credentials for ${bootstrap.auth.username}; local loopback auth is enabled`);
      }
      return bootstrap.auth;
    }
    console.error('Failed to load auth.json:', err.message);
    process.exit(1);
  }
}

export const auth = await loadAuth();

const sessionStore = AUTH_SESSION_SECRET ? openAuthSessionStore({legacyFile:AUTH_SESSIONS_FILE,
  databaseFile:AUTH_SESSIONS_DB_FILE,secret:AUTH_SESSION_SECRET,normalizeSession:normalizeAuthSession}) : null;
export async function loadAuthSessions() { return sessionStore?.snapshot() || new Map(); }
export function closeAuthSessionStore() { sessionStore?.close(); }

export const saveAuthSessions = saveAuthSessionsAsync;

export async function saveAuthSessionsAsync() {
  if(!sessionStore) throw Object.assign(new Error('AUTH_SESSION_SECRET_REQUIRED'),{code:'AUTH_SESSION_SECRET_REQUIRED'});
  return sessionStore.flush(); // Compatibility barrier; mutations already committed.
}

// Read-only live view. No caller can restore a stale full-map snapshot to disk.
export const sessions = Object.freeze({
  get size(){return sessionStore?.snapshot().size || 0;},
  get(key){return sessionStore?.get(key);},
  has(key){return !!sessionStore?.get(key);},
  [Symbol.iterator](){return (sessionStore?.snapshot() || new Map())[Symbol.iterator]();},
});

export function generateToken() {
  return randomBytes(32).toString('hex');
}

/**
 * COMMIT 完成后才返回 cookie；磁盘失败抛 typed error，不发布内存会话。
 */
export async function issueSession(sessionData) {
  const token = generateToken();
  const key = sessionHashToken(token);
  if (!key) return null;
  sessionStore.insert(key, { ...sessionData, expiry: Date.now() + SESSION_EXPIRY });
  return token;
}

export function revokeSession(token) {
  if (!token) return false;
  const key = sessionHashToken(token);
  if (!key) return false;
  return sessionStore.revoke(key); // Synchronous transaction, durable before true.
}

export const hashPassword = hashPasswordAsync;

export async function hashPasswordAsync(password) {
  const salt = randomBytes(16);
  const N = 16384, r = 8, p = 1;
  const hash = await scryptAsync(password, salt, 32, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export const verifyPassword = verifyPasswordAsync;

export async function verifyPasswordAsync(username, password) {
  if (!username || !password) return false;
  let currentAuth;
  try {
    currentAuth = JSON.parse(await readFile(AUTH_FILE, 'utf8'));
  } catch {
    return false;
  }
  if (!currentAuth.username || !currentAuth.passwordHash) return false;
  if (currentAuth.username !== username) return false;
  const parts = currentAuth.passwordHash.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltHex, hashHex] = parts;
  const salt = Buffer.from(saltHex, 'hex');
  const storedHash = Buffer.from(hashHex, 'hex');
  try {
    const inputHash = await scryptAsync(password, salt, 32, { N: parseInt(N, 10), r: parseInt(r, 10), p: parseInt(p, 10) });
    return timingSafeEqual(storedHash, inputHash);
  } catch {
    return false;
  }
}

/**
 * 修改 owner 密码（Web 自助改密端点用）。
 * 验证当前密码后写入新 scrypt hash；不触碰 token 等其余字段。
 */
export async function setOwnerPasswordAsync({ currentPassword, newPassword }) {
  if (!currentPassword || !newPassword) return { ok: false, error: 'missing-fields' };
  if (newPassword.length < 8) return { ok: false, error: 'weak-new-password' };
  let currentAuth;
  try {
    currentAuth = JSON.parse(await readFile(AUTH_FILE, 'utf8'));
  } catch {
    return { ok: false, error: 'auth-unavailable' };
  }
  if (!currentAuth.username || !currentAuth.passwordHash) {
    return { ok: false, error: 'password-login-disabled' };
  }
  if (!(await verifyPasswordAsync(currentAuth.username, currentPassword))) {
    return { ok: false, error: 'invalid-current-password' };
  }
  currentAuth.passwordHash = await hashPasswordAsync(newPassword);
  await writeFile(AUTH_FILE, JSON.stringify(currentAuth, null, 2) + '\n', 'utf8');
  return { ok: true };
}

export function parseCookies(cookieHeader) {
  const cookies = {};
  cookieHeader.split(';').forEach(cookie => {
    const [key, value] = cookie.trim().split('=');
    if (key && value) cookies[key] = value;
  });
  return cookies;
}

export function getSessionToken(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  return cookies[AUTH_COOKIE_NAME] || null;
}

export function getVisitorSessionToken(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  return cookies[VISITOR_COOKIE_NAME] || null;
}

function deleteExpiredSession(token) {
  const key = sessionHashToken(token);
  if (!key) return;
  sessionStore.revoke(key);
}

function getValidSession(token) {
  if (!token) return null;
  const key = sessionHashToken(token);
  if (!key) return null;
  let session;try{session=sessionStore?.get(key);}catch{return null;}
  if (!session) return null;
  if (Date.now() >= session.expiry) {
    try{deleteExpiredSession(token);}catch{} // Expired sessions always refuse.
    return null;
  }
  return session;
}

function requestPrefersVisitor(req) {
  try {
    const url = new URL(req?.url || '/', 'http://localhost');
    return url.searchParams.get('visitor') === '1';
  } catch {
    return false;
  }
}

function mayUseLocalWebAuth(req) {
  return sessionStore?.healthy === true && !requestPrefersVisitor(req)
    && !getVisitorSessionToken(req)
    && shouldUseLocalWebAuth({
      enabled: LOCAL_WEB_AUTH_ENABLED,
      remoteAddress: req?.socket?.remoteAddress,
      url: req?.url,
      accept: req?.headers?.accept,
      viaTunnel: isTunneledRequest(req),
    });
}

// local_web 会话只在本机直连时有效：这类 cookie 是 loopback 免登录时签发的，
// 一旦随请求经隧道从远端回来，不能再当作登录凭据，远程访问必须真正登录。
function getValidSessionForRequest(token, req) {
  const session = getValidSession(token);
  if (!session) return null;
  if (session.authMethod === 'local_web' && isTunneledRequest(req)) return null;
  if (!allowsRemoteBinding(session)) return null;
  return session;
}

// Reuse only a real, valid local-web cookie on an eligible loopback request.
// isAuthenticated() also recognizes cookie-free local requests and cannot be
// used here to decide whether a browser needs its first API cookie.
export function hasValidLocalWebCookie(req) {
  if (!mayUseLocalWebAuth(req)) return false;
  const session = getValidSessionForRequest(getSessionToken(req), req);
  return session?.authMethod === 'local_web' && session.role === 'owner';
}

// An explicit password, account or CLI owner session must survive a local
// navigation as well. Replacing it with local_web would silently change its
// authority and make a password/account login unusable over a tunnel.
export function hasValidOwnerSessionCookie(req) {
  if (!mayUseLocalWebAuth(req)) return false;
  const session = getValidSessionForRequest(getSessionToken(req), req);
  return session?.role === 'owner';
}

export async function authenticateAccountCookie(req) {
  if (mayUseLocalWebAuth(req)) return false;
  const session = getValidSession(getSessionToken(req));
  if (!session || !['google_accounts', 'google_accounts_poll'].includes(session.authMethod)) return false;
  try {
    await authorizeDeviceBinding({ accountId: session.accountId, bindingAuthorityRevision: session.bindingAuthorityRevision });
    return true;
  } catch { return false; }
}

export function isAuthenticated(req) {
  if (req._bearerAuthSession) return true;
  if (mayUseLocalWebAuth(req)) return true;
  if (requestPrefersVisitor(req)) {
    return !!getValidSessionForRequest(getVisitorSessionToken(req), req);
  }
  return !!getValidSessionForRequest(getSessionToken(req), req)
    || !!getValidSessionForRequest(getVisitorSessionToken(req), req);
}

/**
 * Get the auth session data for a request (role, agentId, visitorId, etc.).
 * Requests with ?visitor=1 use the visitor cookie only.
 * Other requests check the owner cookie first, then the visitor cookie.
 * Also supports Bearer token auth via req._bearerAuthSession (set by middleware).
 * Returns null if not authenticated.
 */
export function getAuthSession(req) {
  if (req._bearerAuthSession) return normalizeAuthSession(req._bearerAuthSession);
  if (mayUseLocalWebAuth(req)) {
    return normalizeAuthSession({ role: 'owner', authMethod: 'local_web' });
  }
  if (requestPrefersVisitor(req)) {
    const visitorSession = getValidSessionForRequest(getVisitorSessionToken(req), req);
    if (visitorSession) return normalizeAuthSession(visitorSession);
    return null;
  }
  const ownerSession = getValidSessionForRequest(getSessionToken(req), req);
  if (ownerSession) return normalizeAuthSession(ownerSession);
  const visitorSession = getValidSessionForRequest(getVisitorSessionToken(req), req);
  if (visitorSession) return normalizeAuthSession(visitorSession);
  return null;
}

function getBearerToken(req) {
  const header = req.headers?.authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  return header.slice(7).trim() || null;
}

export async function authenticateBearerToken(req) {
  const token = getBearerToken(req);
  if (!token) return false;
  const trustedDeviceSession = await authenticateTrustedDeviceToken(token);
  if (trustedDeviceSession) {
    req._bearerAuthSession = trustedDeviceSession;
    return true;
  }
  // 静态 owner access token 已于安全加固中下线（2026-08-05）；
  // Bearer 仅剩 trusted-device 短期设备凭据。
  return false;
}

export async function refreshAuthSession(req, { force = false } = {}) {
  const preferVisitor = requestPrefersVisitor(req);
  let token = preferVisitor ? getVisitorSessionToken(req) : getSessionToken(req);
  let session = getValidSessionForRequest(token, req);
  let cookieFn = preferVisitor ? setVisitorCookie : setCookie;
  if (!preferVisitor && (!token || !session)) {
    token = getVisitorSessionToken(req);
    session = getValidSessionForRequest(token, req);
    cookieFn = setVisitorCookie;
  }
  if (!token || !session) return null;
  if (!force && session.expiry - Date.now() > SESSION_REFRESH_WINDOW_MS) {
    return null;
  }
  const key = sessionHashToken(token);
  if (!key) return null;
  return sessionStore.refresh(key,{force,windowMs:SESSION_REFRESH_WINDOW_MS,expiryMs:SESSION_EXPIRY}) ? cookieFn(token) : null;
}

export function setCookie(token) {
  const maxAgeSeconds = Math.max(1, Math.floor(SESSION_EXPIRY / 1000));
  const expiry = new Date(Date.now() + SESSION_EXPIRY);
  const secure = SECURE_COOKIES ? '; Secure' : '';
  return `${AUTH_COOKIE_NAME}=${token}; HttpOnly${secure}; SameSite=${AUTH_COOKIE_SAME_SITE}; Path=/; Max-Age=${maxAgeSeconds}; Expires=${expiry.toUTCString()}`;
}

export function clearCookie() {
  const secure = SECURE_COOKIES ? '; Secure' : '';
  return `${AUTH_COOKIE_NAME}=; HttpOnly${secure}; SameSite=${AUTH_COOKIE_SAME_SITE}; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

export function setVisitorCookie(token) {
  const maxAgeSeconds = Math.max(1, Math.floor(SESSION_EXPIRY / 1000));
  const expiry = new Date(Date.now() + SESSION_EXPIRY);
  const secure = SECURE_COOKIES ? '; Secure' : '';
  return `${VISITOR_COOKIE_NAME}=${token}; HttpOnly${secure}; SameSite=${AUTH_COOKIE_SAME_SITE}; Path=/; Max-Age=${maxAgeSeconds}; Expires=${expiry.toUTCString()}`;
}

export function clearVisitorCookie() {
  const secure = SECURE_COOKIES ? '; Secure' : '';
  return `${VISITOR_COOKIE_NAME}=; HttpOnly${secure}; SameSite=${AUTH_COOKIE_SAME_SITE}; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

/**
 * Get the visitor auth session from the visitor-specific cookie.
 * Used when the request explicitly indicates visitor mode (e.g. ?visitor=1).
 */
export function getVisitorAuthSession(req) {
  const token = getVisitorSessionToken(req);
  const session = getValidSession(token);
  if (!session) return null;
  return normalizeAuthSession(session);
}
