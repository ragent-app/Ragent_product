// 实例侧 Google ID token 校验（Android 原生 Credential Manager ID token 端点专用）。
// 与 accounts/server.mjs 的 createGoogleIdTokenVerifier 同源逻辑，但两处差异：
//   - audience 可配置（Credential Manager 使用 Web/server client_id）
//   - nonce 可空：原生 token 没有 broker 事务 nonce，requireNonce=false 时不强制匹配
//     （设备通道 + exp 已提供防重放，Android 客户端 nonce 与任何事务无关）
// iss / exp / iat / sub / RS256 签名校验全部保留。
import { createPublicKey, verify } from 'node:crypto';

export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
const JWKS_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_IAT_SKEW_SEC = 5 * 60;
const MAX_TOKEN_AGE_SEC = 24 * 60 * 60;

// The native server-client audience is deployment configuration. Keep the
// legacy variable as a one-release compatibility path, but never invent an
// audience in source: an unset allowlist must fail closed.
export function resolveGoogleNativeServerClientIds(env = process.env) {
  const configured = typeof env?.RAGENT_GOOGLE_NATIVE_SERVER_CLIENT_IDS === 'string'
    && env.RAGENT_GOOGLE_NATIVE_SERVER_CLIENT_IDS.trim()
    ? env.RAGENT_GOOGLE_NATIVE_SERVER_CLIENT_IDS
    : env?.RAGENT_ANDROID_GOOGLE_CLIENT_ID;
  return String(configured || '')
    .split(',')
    .map((value) => text(value))
    .filter(Boolean);
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function unb64(value) {
  const raw = text(value).replace(/-/g, '+').replace(/_/g, '/');
  if (!raw) return Buffer.alloc(0);
  return Buffer.from(raw.padEnd(Math.ceil(raw.length / 4) * 4, '='), 'base64');
}

function verifierError(code, message, statusCode = 401) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

/**
 * 构造一个 Google ID token 校验器。
 * @param {object} options
 * @param {string[]} [options.clientIds] 可接受的 aud 白名单（必填，至少一个）
 * @param {Function} [options.fetchImpl] JWKS 拉取实现；缺省用 globalThis.fetch（调用时解析）
 * @param {string} [options.jwksUrl] Google JWKS URL
 * @param {Function} [options.clock] 时钟（测试注入）
 * @param {boolean} [options.requireNonce] 是否强制 nonce 匹配（Accounts 浏览器流用 true，原生 token 用 false）
 * @returns {(input: {idToken?: string, nonce?: string}) => Promise<{sub:string, email:string, name:string}>}
 */
export function createGoogleIdTokenVerifier({
  clientIds,
  fetchImpl,
  jwksUrl = GOOGLE_JWKS_URL,
  clock = Date.now,
  requireNonce = false,
} = {}) {
  const acceptedClientIds = Array.isArray(clientIds)
    ? clientIds.map((value) => text(value)).filter(Boolean)
    : [];
  const resolveFetch = () => fetchImpl || globalThis.fetch;
  let cached = null;

  return async ({ idToken, nonce } = {}) => {
    if (!acceptedClientIds.length || typeof resolveFetch() !== 'function') {
      throw verifierError('google_login_not_configured', 'Google ID token verification is not configured.', 409);
    }
    const parts = text(idToken).split('.');
    if (parts.length !== 3) throw verifierError('owner_auth_token_invalid', 'Invalid Google ID token.', 401);
    let header;
    let claims;
    try {
      header = JSON.parse(unb64(parts[0]).toString());
      claims = JSON.parse(unb64(parts[1]).toString());
    } catch {
      throw verifierError('owner_auth_token_invalid', 'Invalid Google ID token.', 401);
    }
    if (header?.alg !== 'RS256' || !text(header?.kid)) {
      throw verifierError('owner_auth_token_invalid', 'Unsupported Google ID token.', 401);
    }
    if (!cached || cached.expiresAt <= clock()) {
      let keysResponse;
      try {
        keysResponse = await resolveFetch()(jwksUrl, { headers: { Accept: 'application/json' } });
      } catch {
        throw verifierError('owner_auth_account_invalid', 'Google JWKS is unreachable.', 502);
      }
      if (!keysResponse.ok) throw verifierError('owner_auth_account_invalid', 'Google JWKS is unreachable.', 502);
      let body = null;
      try { body = await keysResponse.json(); } catch {}
      cached = { keys: Array.isArray(body?.keys) ? body.keys : [], expiresAt: clock() + JWKS_CACHE_TTL_MS };
    }
    const jwk = Array.isArray(cached.keys) ? cached.keys.find((item) => item?.kid === header.kid) : null;
    let signatureValid = false;
    try {
      signatureValid = Boolean(jwk)
        && verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: jwk, format: 'jwk' }), unb64(parts[2]));
    } catch {}
    const now = Math.floor(clock() / 1000);
    const iat = Number(claims.iat);
    const exp = Number(claims.exp);
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    const nonceOk = !requireNonce || (text(nonce) !== '' && text(claims.nonce) === text(nonce));
    if (
      !signatureValid ||
      !GOOGLE_ISSUERS.has(text(claims.iss)) ||
      !audiences.some((value) => acceptedClientIds.includes(text(value))) ||
      !nonceOk ||
      !text(claims.sub) ||
      !Number.isFinite(iat) ||
      iat > now + MAX_IAT_SKEW_SEC ||
      !Number.isFinite(exp) ||
      exp <= now ||
      exp - iat > MAX_TOKEN_AGE_SEC
    ) {
      throw verifierError('owner_auth_token_invalid', 'Google ID token rejected.', 401);
    }
    return {
      sub: text(claims.sub),
      email: text(claims.email),
      name: text(claims.name),
      picture: text(claims.picture),
    };
  };
}
