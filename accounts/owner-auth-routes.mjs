// Accounts 服务的 owner-auth HTTP/UI adapter。
// 接入 accounts/server.mjs 时调用 handleOwnerAuthRoutes()；它不保存 OAuth secret，
// Google Identity Services 只在受控 Accounts origin 上运行。
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { deriveDesktopReplayValues, OWNER_AUTH_TRANSACTION_TTL_MS } from './owner-auth-broker.mjs';

const OWNER_AUTH_COOKIE_MAX_AGE_SECONDS = Math.ceil(OWNER_AUTH_TRANSACTION_TTL_MS / 1000);

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function bearerCredential(req) {
  const authorization = trimString(req?.headers?.authorization);
  const matched = /^Bearer[ \t]+([^ \t]+)$/i.exec(authorization);
  return matched ? trimString(matched[1]) : '';
}

function parseCookies(req) {
  const result = new Map();
  for (const part of trimString(req?.headers?.cookie).split(';')) {
    const index = part.indexOf('=');
    if (index > 0) result.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }
  return result;
}

function jsonResponse(res, statusCode, value, headers = {}) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store, max-age=0',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
    ...headers,
  });
  res.end(JSON.stringify(value));
}

function stateCookieName(kind, transactionId) {
  const suffix = createHash('sha256').update(trimString(transactionId)).digest('hex').slice(0, 24);
  return `agentoc_owner_broker_${kind}_${suffix}`;
}

function clearPhoneCookies(transactionId) {
  return [
    `${stateCookieName('phone_state', transactionId)}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,
    `${stateCookieName('phone_csrf', transactionId)}=; Secure; SameSite=Lax; Path=/; Max-Age=0`,
  ];
}

function browserCookie(transactionId, browserState) {
  return `${stateCookieName('state', transactionId)}=${encodeURIComponent(transactionId)}.${browserState}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${OWNER_AUTH_COOKIE_MAX_AGE_SECONDS}`;
}

function csrfCookie(transactionId, browserState) {
  return `${stateCookieName('csrf', transactionId)}=${browserState}; Secure; SameSite=Lax; Path=/; Max-Age=${OWNER_AUTH_COOKIE_MAX_AGE_SECONDS}`;
}

function phoneCookie(transactionId, phoneState) {
  return `${stateCookieName('phone_state', transactionId)}=${encodeURIComponent(transactionId)}.${phoneState}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${OWNER_AUTH_COOKIE_MAX_AGE_SECONDS}`;
}

function phoneCsrfCookie(transactionId, phoneState) {
  return `${stateCookieName('phone_csrf', transactionId)}=${phoneState}; Secure; SameSite=Lax; Path=/; Max-Age=${OWNER_AUTH_COOKIE_MAX_AGE_SECONDS}`;
}

function browserStateFromCookie(req, transactionId) {
  const cookies = parseCookies(req);
  const raw = cookies.get(stateCookieName('state', transactionId)) || cookies.get('agentoc_owner_broker_state') || '';
  const index = raw.indexOf('.');
  if (index < 1) return '';
  try {
    return decodeURIComponent(raw.slice(0, index)) === transactionId ? raw.slice(index + 1) : '';
  } catch {
    return '';
  }
}

function phoneStateFromCookie(req, transactionId) {
  const cookies = parseCookies(req);
  const raw = cookies.get(stateCookieName('phone_state', transactionId)) || cookies.get('agentoc_owner_broker_phone_state') || '';
  const index = raw.indexOf('.');
  if (index < 1) return '';
  try {
    return decodeURIComponent(raw.slice(0, index)) === transactionId ? raw.slice(index + 1) : '';
  } catch {
    return '';
  }
}

// The QR/link is already a one-time bearer. Deriving the browser state from
// that exact ticket lets a browser retry the initial GET before its cookie jar
// has committed Set-Cookie (prefetch, restore, or local HTTP) without creating
// a second phone session. The state is still sent as an HttpOnly cookie and a
// CSRF header; a different ticket cannot reproduce it.
function derivePhoneReplayState(transactionId, phoneTicket) {
  const txId = trimString(transactionId);
  const ticket = trimString(phoneTicket);
  if (!txId || !ticket) return '';
  return createHash('sha256')
    .update(`agentoc-owner-auth-phone-v1\n${txId}\n${ticket}`)
    .digest('base64url');
}

// Native account-session browser handoff: same cookie/CSRF machinery as the
// transaction phone page, with the state derived from the one-time ticket the
// app received alongside its challenge.
function deriveNativePhoneReplayState(transactionId, browserTicket) {
  const txId = trimString(transactionId);
  const ticket = trimString(browserTicket);
  if (!txId || !ticket) return '';
  return createHash('sha256')
    .update(`agentoc-owner-auth-native-phone-v1\n${txId}\n${ticket}`)
    .digest('base64url');
}

function hasValidPhoneCsrf(req, phoneState, publicBaseUrl, transactionId) {
  const cookies = parseCookies(req);
  const csrfCookieValue = trimString(cookies.has(stateCookieName('phone_state', transactionId))
    ? cookies.get(stateCookieName('phone_csrf', transactionId)) : cookies.get('agentoc_owner_broker_phone_csrf'));
  const csrfHeader = trimString(req?.headers?.['x-agentoc-csrf']);
  const origin = trimString(req?.headers?.origin);
  try {
    return (
      Boolean(phoneState) &&
      csrfCookieValue === phoneState &&
      csrfHeader === phoneState &&
      origin === new URL(publicBaseUrl).origin
    );
  } catch {
    return false;
  }
}

async function readJsonBody(req, limit = 64 * 1024) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > limit) throw Object.assign(new Error('Request body is too large'), { statusCode: 413 });
    chunks.push(Buffer.from(chunk));
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invalid JSON body'), { statusCode: 400 });
  }
}

function scriptValue(value) {
  return JSON.stringify(String(value || '')).replace(/</g, '\\u003c');
}

function inlineScript(value) {
  return String(value || '').replace(/<\/script/gi, '<\\/script');
}

let accountPageAssets;
async function loadAccountPageAssets() {
  if (!accountPageAssets) {
    accountPageAssets = Promise.all([
      readFile(new URL('../static/m3-pages.css', import.meta.url), 'utf8'),
      readFile(new URL('../static/qr-pages.css', import.meta.url), 'utf8'),
      readFile(new URL('../static/qr-creator.min.js', import.meta.url), 'utf8'),
    ]).then(([pageStyles, qrStyles, qrCreator]) => ({ pageStyles, qrStyles, qrCreator }));
  }
  return accountPageAssets;
}

function authPageHeaders(page, cookies = []) {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${page.cspNonce}' https://accounts.google.com/gsi/client; connect-src 'self'; frame-src https://accounts.google.com; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'`,
    ...(cookies.length ? { 'Set-Cookie': cookies } : {}),
  };
}

function renderGoogleIdentityPage({ nonce, phoneState, googleWebClientId, credentialEndpoint, completionUrl, styles, demoEnabled = false }) {
  const cspNonce = randomBytes(18).toString('base64');
  const safeNonce = scriptValue(nonce);
  const safePhoneState = scriptValue(phoneState);
  const safeClientId = scriptValue(googleWebClientId);
  const safeEndpoint = scriptValue(credentialEndpoint);
  const safeCompletionUrl = scriptValue(completionUrl);
  return {
    cspNonce,
    body: `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="color-scheme" content="light dark"><meta name="theme-color" content="#faf8ff" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#121318" media="(prefers-color-scheme: dark)"><title>继续 Google 登录</title><style>${styles.pageStyles}\n${styles.qrStyles}</style></head>
<body class="qr-login-page"><main class="qr-login-shell card"><header class="qr-login-header"><h1>继续 Google 登录</h1><p>此操作仅确认 Ragent owner 身份，不会请求 Calendar、Drive 或 Gmail 权限。</p></header><section class="qr-login-body"><div id="google-button"></div>${demoEnabled ? '<form id="demo-login"><h2>Test account sign-in</h2><label>Username <input id="demo-username" name="username" autocomplete="username" required maxlength="80"></label><label>Password <input id="demo-password" name="password" type="password" autocomplete="current-password" required maxlength="256"></label><button type="submit">Sign in to this Ragent instance</button></form>' : ''}<p id="error" class="qr-login-status" role="status" aria-live="polite"></p></section></main>
<script id="google-gsi-client" src="https://accounts.google.com/gsi/client" async></script>
<script nonce="${cspNonce}">
(function () {
  const endpoint = ${safeEndpoint};
  const csrf = ${safePhoneState};
  const completionUrl = ${safeCompletionUrl};
  const error = document.getElementById('error');
  function credentialErrorMessage(data) {
    const code = data && typeof data.code === 'string' ? data.code.trim() : '';
    const messages = {
      owner_auth_account_invalid: 'Google 身份校验失败，请确认账号后重试。',
      owner_auth_csrf_invalid: '授权页面已过期，请重新打开安全链接。',
      owner_auth_phone_state_invalid: '手机授权状态已过期，请重新打开安全链接。',
      owner_auth_phone_replayed: '这次授权已经使用过，请重新开始。',
      owner_auth_transaction_invalid: '授权事务已过期，请重新开始。',
    };
    if (code && messages[code]) return messages[code] + ' [' + code + ']';
    if (code) return '认证未完成，请重试。 [' + code + ']';
    return '认证未完成，请重试。';
  }
  async function credential(response) {
    try {
      const result = await fetch(endpoint, { method: 'POST', credentials: 'same-origin', headers: {'Content-Type':'application/json','X-AgentoC-CSRF': csrf}, body: JSON.stringify({idToken: response.credential}) });
      const data = await result.json();
      if (!result.ok || !data.completeUrl) throw new Error(credentialErrorMessage(data));
      location.assign(completionUrl || data.completeUrl);
    } catch (err) { error.textContent = err.message || '认证未完成，请重试。'; }
  }
  const demoForm = document.getElementById('demo-login');
  if (demoForm) demoForm.addEventListener('submit', async function (event) {
    event.preventDefault();
    const button = demoForm.querySelector('button');
    if (button.disabled) return;
    button.disabled = true;
    const password = document.getElementById('demo-password');
    const body = JSON.stringify({username: document.getElementById('demo-username').value, password: password.value});
    password.value = '';
    try {
      const result = await fetch(endpoint.replace('/phone-google-credential', '/phone-demo-credential'), {
        method: 'POST', credentials: 'same-origin', headers: {'Content-Type':'application/json','X-AgentoC-CSRF': csrf}, body});
      const data = await result.json();
      if (!result.ok || !data.completeUrl) throw new Error(credentialErrorMessage(data));
      location.assign(completionUrl || data.completeUrl);
    } catch (err) { error.textContent = err.message || 'Sign-in failed. Retry.'; }
    finally { button.disabled = false; }
  });
  let initialized = false;
  function initialize() {
    if (!window.google || !google.accounts || !google.accounts.id) return;
    if (initialized) return;
    initialized = true;
    google.accounts.id.initialize({ client_id: ${safeClientId}, nonce: ${safeNonce}, callback: credential, auto_select: false });
    google.accounts.id.renderButton(document.getElementById('google-button'), { theme: 'outline', size: 'large', text: 'continue_with' });
  }
  window.agentocGoogleIdentityReady = initialize;
  const googleScript = document.getElementById('google-gsi-client');
  if (googleScript) googleScript.addEventListener('load', initialize, { once: true });
  initialize();
}());
</script>
</body></html>`,
  };
}

// Browser sign-in handoff for native account sessions (non-GMS Android):
// same GIS button, but a success marks the challenge browser-verified and
// the page tells the user to return to the app instead of redirecting.
function renderNativeIdentityPage({ transactionId, nonce, nativeState, googleWebClientId, credentialEndpoint, styles }) {
  const cspNonce = randomBytes(18).toString('base64');
  const safeNonce = scriptValue(nonce);
  const safeNativeState = scriptValue(nativeState);
  const safeTransactionId = scriptValue(transactionId);
  const safeClientId = scriptValue(googleWebClientId);
  const safeEndpoint = scriptValue(credentialEndpoint);
  return {
    cspNonce,
    body: `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="color-scheme" content="light dark"><meta name="theme-color" content="#faf8ff" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#121318" media="(prefers-color-scheme: dark)"><title>继续 Google 登录</title><style>${styles.pageStyles}\n${styles.qrStyles}</style></head>
<body class="qr-login-page"><main class="qr-login-shell card"><header class="qr-login-header"><h1>继续 Google 登录</h1><p>此操作仅确认 Ragent 账号身份。完成后请回到 Ragent 应用继续。</p></header><section class="qr-login-body"><div id="google-button"></div><p id="error" class="qr-login-status" role="status" aria-live="polite"></p></section></main>
<script id="google-gsi-client" src="https://accounts.google.com/gsi/client" async></script>
<script nonce="${cspNonce}">
(function () {
  const endpoint = ${safeEndpoint};
  const csrf = ${safeNativeState};
  const transactionId = ${safeTransactionId};
  const error = document.getElementById('error');
  const buttonHost = document.getElementById('google-button');
  function credentialErrorMessage(data) {
    const code = data && typeof data.code === 'string' ? data.code.trim() : '';
    const messages = {
      owner_auth_account_invalid: 'Google 身份校验失败，请确认账号后重试。',
      owner_auth_csrf_invalid: '授权页面已过期，请重新打开安全链接。',
      owner_auth_account_session_browser_ticket_invalid: '登录链接已失效，请在应用中重新发起登录。',
      owner_auth_account_session_expired: '登录会话已过期，请在应用中重新发起登录。',
      owner_auth_account_session_consumed: '这次登录已经完成，请直接返回 Ragent 应用。',
    };
    if (code && messages[code]) return messages[code] + ' [' + code + ']';
    if (code) return '认证未完成，请重试。 [' + code + ']';
    return '认证未完成，请重试。';
  }
  async function credential(response) {
    try {
      const result = await fetch(endpoint, { method: 'POST', credentials: 'same-origin', headers: {'Content-Type':'application/json','X-AgentoC-CSRF': csrf}, body: JSON.stringify({transactionId, idToken: response.credential}) });
      const data = await result.json();
      if (!result.ok || !data.ok) throw new Error(credentialErrorMessage(data));
      if (buttonHost) buttonHost.textContent = '';
      error.textContent = '登录完成，请返回 Ragent 应用继续。';
    } catch (err) { error.textContent = err.message || '认证未完成，请重试。'; }
  }
  let initialized = false;
  function initialize() {
    if (!window.google || !google.accounts || !google.accounts.id) return;
    if (initialized) return;
    initialized = true;
    google.accounts.id.initialize({ client_id: ${safeClientId}, nonce: ${safeNonce}, callback: credential, auto_select: false });
    google.accounts.id.renderButton(buttonHost, { theme: 'outline', size: 'large', text: 'continue_with' });
  }
  window.agentocGoogleIdentityReady = initialize;
  const googleScript = document.getElementById('google-gsi-client');
  if (googleScript) googleScript.addEventListener('load', initialize, { once: true });
  initialize();
}());
</script>
</body></html>`,
  };
}

function renderDesktopQrPage({ transactionId, phoneUrl, statusEndpoint, deliveryGrant, styles }) {
  const cspNonce = randomBytes(18).toString('base64');
  const safeTx = scriptValue(transactionId);
  const safePhoneUrl = scriptValue(phoneUrl);
  const safeStatusEndpoint = scriptValue(statusEndpoint);
  const safeDeliveryGrant = scriptValue(deliveryGrant);
  return {
    cspNonce,
    body: `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="color-scheme" content="light dark"><meta name="theme-color" content="#faf8ff" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#121318" media="(prefers-color-scheme: dark)"><title>使用手机登录</title><style>${styles.pageStyles}\n${styles.qrStyles}</style></head>
<body class="qr-login-page"><main class="qr-login-shell card"><header class="qr-login-header"><h1>使用手机继续登录</h1><p>在手机完成 Google 登录后，这台设备会自动继续。电脑不需要访问 Google。</p></header><section class="qr-login-body"><div class="qr-login-frame" id="ownerAuthQr" role="img" aria-label="使用手机扫描此二维码继续登录"></div><div class="qr-login-status" id="ownerAuthStatus" role="status" aria-live="polite">正在准备安全链接…</div><div class="qr-login-actions"><a class="btn primary" id="ownerAuthContinue" href="${phoneUrl}">手机就在此页？直接继续登录</a><button class="btn secondary" id="ownerAuthCopy" type="button">复制手机授权链接</button></div><details class="qr-login-details" id="ownerAuthDetails"><summary>无法扫码？打开安全链接</summary><code id="ownerAuthUrl"></code></details></section></main>
<script nonce="${cspNonce}">${inlineScript(styles.qrCreator)}</script>
<script nonce="${cspNonce}">
(function () {
  const tx = ${safeTx};
  const phoneUrl = ${safePhoneUrl};
  const statusEndpoint = ${safeStatusEndpoint};
  const deliveryGrant = ${safeDeliveryGrant};
  const qr = document.getElementById('ownerAuthQr');
  const status = document.getElementById('ownerAuthStatus');
  const copy = document.getElementById('ownerAuthCopy');
  const details = document.getElementById('ownerAuthDetails');
  const url = document.getElementById('ownerAuthUrl');
  const storageKey = 'agentoc_owner_auth_delivery_' + tx;
  try { sessionStorage.setItem(storageKey, deliveryGrant); } catch {}
  if (url) url.textContent = phoneUrl;
  if (qr && window.QrCreator && window.QrCreator.render) {
    window.QrCreator.render({ text: phoneUrl, size: 260, ecLevel: 'M', radius: 0, quiet: 2 }, qr);
  } else if (qr) {
    qr.textContent = '二维码不可用，请使用下方安全链接。';
  }
  async function copyLink() {
    try {
      await navigator.clipboard.writeText(phoneUrl);
      copy.textContent = '链接已复制';
      window.setTimeout(function () { copy.textContent = '复制手机授权链接'; }, 1600);
    } catch {
      if (details) details.open = true;
      if (status) status.textContent = '无法自动复制，请打开下方安全链接。';
    }
  }
  async function poll() {
    try {
      const response = await fetch(statusEndpoint, { credentials: 'same-origin', cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data && data.error ? data.error : '登录链接已失效，请返回 Ragent 后重试。');
      if (data.status === 'completed' && data.returnUrl) {
        const target = new URL(data.returnUrl);
        target.searchParams.set('grant', deliveryGrant);
        location.replace(target.toString());
        return;
      }
      if (status) status.textContent = '等待手机完成 Google 登录…';
      window.setTimeout(poll, 1800);
    } catch (error) {
      if (status) status.textContent = error && error.message ? error.message : '登录状态暂不可用，请稍后重试。';
    }
  }
  copy && copy.addEventListener('click', function () { void copyLink(); });
  poll();
}());
</script></body></html>`,
  };
}

function renderDesktopPollPage({ transactionId, phoneUrl, statusEndpoint, styles }) {
  const cspNonce = randomBytes(18).toString('base64');
  const safeTx = scriptValue(transactionId);
  const safePhoneUrl = scriptValue(phoneUrl);
  const safeStatusEndpoint = scriptValue(statusEndpoint);
  return {
    cspNonce,
    body: `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="color-scheme" content="light dark"><meta name="theme-color" content="#faf8ff" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#121318" media="(prefers-color-scheme: dark)"><title>使用手机登录</title><style>${styles.pageStyles}\n${styles.qrStyles}</style></head>
<body class="qr-login-page"><main class="qr-login-shell card"><header class="qr-login-header"><h1>使用手机继续登录</h1><p>在手机完成 Google 登录后，这台电脑会自动完成登录。电脑不需要访问 Google，也不需要公网地址。</p></header><section class="qr-login-body"><div class="qr-login-frame" id="ownerAuthQr" role="img" aria-label="使用手机扫描此二维码继续登录"></div><div class="qr-login-status" id="ownerAuthStatus" role="status" aria-live="polite">正在准备安全链接…</div><div class="qr-login-actions"><a class="btn primary" id="ownerAuthContinue" href="${phoneUrl}">手机就在此页？直接继续登录</a><button class="btn secondary" id="ownerAuthCopy" type="button">复制手机授权链接</button></div><details class="qr-login-details" id="ownerAuthDetails"><summary>无法扫码？打开安全链接</summary><code id="ownerAuthUrl"></code></details></section></main>
<script nonce="${cspNonce}">${inlineScript(styles.qrCreator)}</script>
<script nonce="${cspNonce}">
(function () {
  const phoneUrl = ${safePhoneUrl};
  const statusEndpoint = ${safeStatusEndpoint};
  const qr = document.getElementById('ownerAuthQr');
  const status = document.getElementById('ownerAuthStatus');
  const copy = document.getElementById('ownerAuthCopy');
  const details = document.getElementById('ownerAuthDetails');
  const url = document.getElementById('ownerAuthUrl');
  if (url) url.textContent = phoneUrl;
  if (qr && window.QrCreator && window.QrCreator.render) {
    window.QrCreator.render({ text: phoneUrl, size: 260, ecLevel: 'M', radius: 0, quiet: 2 }, qr);
  } else if (qr) {
    qr.textContent = '二维码不可用，请使用下方安全链接。';
  }
  async function copyLink() {
    try {
      await navigator.clipboard.writeText(phoneUrl);
      copy.textContent = '链接已复制';
      window.setTimeout(function () { copy.textContent = '复制手机授权链接'; }, 1600);
    } catch {
      if (details) details.open = true;
      if (status) status.textContent = '无法自动复制，请打开下方安全链接。';
    }
  }
  async function poll() {
    try {
      const response = await fetch(statusEndpoint, { credentials: 'same-origin', cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data && data.error ? data.error : '登录链接已失效，请返回 Ragent 后重试。');
      if (data.status === 'completed') {
        if (status) status.textContent = '电脑正在自动完成登录，请稍候…';
        window.setTimeout(poll, 5000);
        return;
      }
      if (status) status.textContent = '等待手机完成 Google 登录…';
      window.setTimeout(poll, 1800);
    } catch (error) {
      if (status) status.textContent = error && error.message ? error.message : '登录状态暂不可用，请稍后重试。';
      window.setTimeout(poll, 3000);
    }
  }
  copy && copy.addEventListener('click', function () { void copyLink(); });
  poll();
}());
</script></body></html>`,
  };
}

function renderPhoneCompletionPage({ transactionId, statusEndpoint, styles }) {
  const cspNonce = randomBytes(18).toString('base64');
  const safeTx = scriptValue(transactionId);
  const safeStatusEndpoint = scriptValue(statusEndpoint);
  return {
    cspNonce,
    body: `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="color-scheme" content="light dark"><meta name="theme-color" content="#faf8ff" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#121318" media="(prefers-color-scheme: dark)"><title>登录已确认</title><style>${styles.pageStyles}\n${styles.qrStyles}</style></head>
<body class="qr-complete-page"><main class="qr-complete-shell card"><header class="qr-complete-header"><div class="qr-complete-icon" aria-hidden="true">✓</div><h1>手机登录已确认</h1><p id="ownerAuthCompleteStatus">请返回显示二维码的设备；它会自动继续登录。</p></header></main>
<script nonce="${cspNonce}">
(function () {
  const tx = ${safeTx};
  const endpoint = ${safeStatusEndpoint};
  const status = document.getElementById('ownerAuthCompleteStatus');
  const grant = (function () { try { return sessionStorage.getItem('agentoc_owner_auth_delivery_' + tx) || ''; } catch { return ''; } }());
  if (!grant) return;
  fetch(endpoint, { credentials: 'same-origin', cache: 'no-store' }).then(function (response) {
    return response.json().then(function (data) { return { response: response, data: data }; });
  }).then(function (result) {
    if (!result.response.ok || result.data.status !== 'completed' || !result.data.returnUrl) return;
    const target = new URL(result.data.returnUrl);
    target.searchParams.set('grant', grant);
    if (status) status.textContent = '正在完成此设备的登录…';
    location.replace(target.toString());
  }).catch(function () {});
}());
</script></body></html>`,
  };
}

// broker = createOwnerAuthBroker(...), publicBaseUrl = Accounts 的固定 HTTPS origin/path。
// verifyGoogleCredential 由 broker 注入，故本层永远看不到 Google OAuth client secret。
export async function handleOwnerAuthRoutes({
  req,
  res,
  pathname,
  broker,
  publicBaseUrl,
  googleWebClientId,
  allowInsecurePublicBaseUrl = false,
  audit = () => {},
}) {
  const base = trimString(publicBaseUrl).replace(/\/$/, '');
  let baseUrl;
  try {
    baseUrl = new URL(base);
    if (
      (baseUrl.protocol !== 'https:' && !allowInsecurePublicBaseUrl) ||
      baseUrl.username ||
      baseUrl.password ||
      baseUrl.hash ||
      baseUrl.search
    )
      throw new Error('invalid base');
  } catch {
    return false;
  }
  if (!broker) return false;
  const qIndex = pathname.indexOf('?');
  const requestPath = qIndex >= 0 ? pathname.slice(0, qIndex) : pathname;
  const basePath = baseUrl.pathname.replace(/\/+$/, '');
  // 反代可能保留或剥掉 PUBLIC_BASE_URL 的路径前缀：两种形式都接受。
  const path =
    basePath && basePath !== '/' && requestPath.startsWith(`${basePath}/`)
      ? requestPath.slice(basePath.length)
      : requestPath;
  const query = new URLSearchParams(qIndex >= 0 ? pathname.slice(qIndex + 1) : '');
  if (!path) return false;
  const isNativeApi = path.startsWith('/v1/owner-auth/native/');
  const isDiscoveryApi = path === '/v1/owner-auth/discovery';
  const isBindingAuthorityApi = path === '/v1/owner-auth/instances/authority';
  const isTurnConnectionApi = ['/v1/owner-auth/turn/connections/reserve', '/v1/owner-auth/turn/connections/release', '/v1/owner-auth/turn/connections/handoff/commit'].includes(path);
  const isProviderSyncApi = path === '/v1/owner-auth/provider-sync/authorize';
  const isAccountSyncCatalogApi = /^\/v1\/owner-auth\/sync\/catalog\/[^/]+$/.test(path);
  const isAccountJoinApi = path === '/v1/owner-auth/account-intents'
    || /^\/v1\/owner-auth\/account-intents\/[^/]+\/(complete|authorize)$/.test(path);
  const isAccountRendezvousApi = path === '/v1/owner-auth/rendezvous'
    || path === '/v1/owner-auth/rendezvous/inbox'
    || /^\/v1\/owner-auth\/rendezvous\/[^/]+\/(poll|grant|complete|result)$/.test(path);
  const isAccountDirectoryApi = ['/v1/owner-auth/account/devices', '/v1/owner-auth/account/usage',
    '/v1/owner-auth/account/session/logout', '/v1/owner-auth/account/turn/connections',
    '/v1/owner-auth/account/turn/connections/release'].includes(path)
    || /^\/v1\/owner-auth\/account\/devices\/[^/]+\/(rename|revoke)$/.test(path);
  const isAccountFileUploadQuotaApi = /^\/v1\/owner-auth\/instances\/uploads\/(reserve|complete|release)$/.test(path);
  if (!trimString(googleWebClientId) && !isNativeApi && !isDiscoveryApi && !isBindingAuthorityApi && !isTurnConnectionApi && !isAccountJoinApi && !isAccountRendezvousApi && !isProviderSyncApi && !isAccountSyncCatalogApi && !isAccountDirectoryApi && !isAccountFileUploadQuotaApi) return false;

  try {
    if (isBindingAuthorityApi && req.method === 'POST') {
      const result = await broker.readBindingAuthority(await readJsonBody(req));
      jsonResponse(res, 200, result);
      return true;
    }
    if (isAccountFileUploadQuotaApi && req.method === 'POST') {
      const method = path.endsWith('/reserve') ? broker.reserveAccountFileUpload
        : path.endsWith('/complete') ? broker.completeAccountFileUpload : broker.releaseAccountFileUpload;
      const result = await method(await readJsonBody(req));
      jsonResponse(res, 200, result);
      return true;
    }
    if (path === '/v1/owner-auth/transactions' && req.method === 'POST') {
      const started = await broker.start(await readJsonBody(req));
      const authPage = new URL(`${base}/owner/google`);
      authPage.searchParams.set('tx', started.transactionId);
      authPage.searchParams.set('bootstrap', started.bootstrap);
      jsonResponse(res, 201, {
        transactionId: started.transactionId,
        authUrl: authPage.toString(),
        expiresAt: started.expiresAt,
        deliveryMode: started.deliveryMode,
      });
      return true;
    }

    if (path === '/owner/google' && req.method === 'GET') {
      const transactionId = trimString(query.get('tx'));
      const bootstrap = trimString(query.get('bootstrap'));
      const desktopState = deriveDesktopReplayValues({
        transactionId,
        bootstrap,
      }).desktopState;
      const desktop = await broker.beginDesktop({
        transactionId,
        bootstrap,
        desktopState,
      });
      const phoneUrl = new URL(`${base}/owner/google/phone`);
      phoneUrl.searchParams.set('tx', transactionId);
      phoneUrl.searchParams.set('ticket', desktop.phoneTicket);
      // Browser-callback mode needs its waiting page to retain the delivery
      // grant; only instance-poll mode can safely skip directly to the form.
      if (query.get('flow') === 'demo' && broker.canSignInDemoInstances === true && !desktop.deliveryGrant) {
        phoneUrl.hash = 'demo-login';
        res.writeHead(302, {
          Location: phoneUrl.toString(),
          'Cache-Control': 'no-store',
          'Set-Cookie': [browserCookie(transactionId, desktopState), csrfCookie(transactionId, desktopState)],
        });
        res.end();
        return true;
      }
      const statusEndpoint = `${base}/v1/owner-auth/transactions/${encodeURIComponent(transactionId)}/desktop-status`;
      const styles = await loadAccountPageAssets();
      // instance_poll：页面只是等待端，不携带 delivery grant，也不回跳实例。
      const page = desktop.deliveryGrant
        ? renderDesktopQrPage({
          transactionId,
          phoneUrl: phoneUrl.toString(),
          statusEndpoint,
          deliveryGrant: desktop.deliveryGrant,
          styles,
        })
        : renderDesktopPollPage({
          transactionId,
          phoneUrl: phoneUrl.toString(),
          statusEndpoint,
          styles,
        });
      res.writeHead(200, authPageHeaders(page, [browserCookie(transactionId, desktopState), csrfCookie(transactionId, desktopState)]));
      res.end(page.body);
      return true;
    }

    if (path === '/owner/google/phone' && req.method === 'GET') {
      const transactionId = trimString(query.get('tx'));
      // A browser may restore or retry the phone page before its first
      // Set-Cookie has committed. Reuse the cookie when available; otherwise
      // derive the same state from the exact one-time ticket.
      const phoneTicket = trimString(query.get('ticket'));
      const phoneState = phoneStateFromCookie(req, transactionId)
        || derivePhoneReplayState(transactionId, phoneTicket);
      const phone = await broker.beginPhone({
        transactionId,
        phoneTicket,
        phoneState,
      });
      const completionUrl = new URL(`${base}/owner/google/phone-complete`);
      completionUrl.searchParams.set('tx', transactionId);
      const page = renderGoogleIdentityPage({
        transactionId,
        nonce: phone.nonce,
        phoneState,
        googleWebClientId,
        demoEnabled: broker.canSignInDemoInstances === true,
        credentialEndpoint: `${base}/v1/owner-auth/transactions/${encodeURIComponent(transactionId)}/phone-google-credential`,
        completionUrl: completionUrl.toString(),
        styles: await loadAccountPageAssets(),
      });
      res.writeHead(200, authPageHeaders(page, [phoneCookie(transactionId, phoneState), phoneCsrfCookie(transactionId, phoneState)]));
      res.end(page.body);
      return true;
    }

    if (path === '/owner/google/phone-complete' && req.method === 'GET') {
      const transactionId = trimString(query.get('tx'));
      const page = renderPhoneCompletionPage({
        transactionId,
        statusEndpoint: `${base}/v1/owner-auth/transactions/${encodeURIComponent(transactionId)}/desktop-status`,
        styles: await loadAccountPageAssets(),
      });
      res.writeHead(200, authPageHeaders(page));
      res.end(page.body);
      return true;
    }

    const phoneCredential = /^\/v1\/owner-auth\/transactions\/([^/]+)\/phone-(google|demo)-credential$/.exec(path);
    if (phoneCredential && req.method === 'POST') {
      const transactionId = decodeURIComponent(phoneCredential[1]);
      const phoneState = phoneStateFromCookie(req, transactionId);
      if (!hasValidPhoneCsrf(req, phoneState, base, transactionId)) {
        const error = new Error('Invalid browser CSRF state');
        error.code = 'owner_auth_csrf_invalid';
        error.statusCode = 403;
        throw error;
      }
      const body = await readJsonBody(req);
      if (phoneCredential[2] === 'demo') {
        await broker.completePhoneDemoCredential({ transactionId, phoneState,
          username: body.username, password: body.password, idToken: body.idToken });
      } else {
        await broker.completePhoneGoogleCredential({ transactionId, phoneState, idToken: trimString(body.idToken) });
      }
      const completeUrl = new URL(`${base}/owner/google/phone-complete`);
      completeUrl.searchParams.set('tx', transactionId);
      jsonResponse(res, 200, { completeUrl: completeUrl.toString() }, { 'Set-Cookie': clearPhoneCookies(transactionId) });
      return true;
    }

    const desktopStatus = /^\/v1\/owner-auth\/transactions\/([^/]+)\/desktop-status$/.exec(path);
    if (desktopStatus && req.method === 'GET') {
      const transactionId = decodeURIComponent(desktopStatus[1]);
      const desktopState = browserStateFromCookie(req, transactionId);
      const result = await broker.getDesktopStatus({ transactionId, desktopState });
      jsonResponse(res, 200, result);
      return true;
    }

    const redeem = /^\/v1\/owner-auth\/transactions\/([^/]+)\/redeem$/.exec(path);
    if (redeem && req.method === 'POST') {
      const body = await readJsonBody(req);
      const result = await broker.redeem({ ...body, transactionId: decodeURIComponent(redeem[1]) });
      jsonResponse(res, 200, result);
      return true;
    }

    // instance_poll 领取端点：只接受创建事务的原实例 proof（独立 audience 与
    // canonical message）。断言只出现在本端点的 completed 响应中。
    const instanceRedeem = /^\/v1\/owner-auth\/transactions\/([^/]+)\/instance-redeem$/.exec(path);
    if (instanceRedeem && req.method === 'POST') {
      const body = await readJsonBody(req);
      const transactionId = decodeURIComponent(instanceRedeem[1]);
      const result = await broker.instanceRedeem({
        ...body,
        transactionId,
      }, { requestPath: `/v1/owner-auth/transactions/${transactionId}/instance-redeem` });
      jsonResponse(res, 200, result);
      return true;
    }

    // 设备管理：实例用签名 proof（purpose=devices/history/unbind）按账号查询/解绑。
    // 统一 POST 承载 proof（GET 无 body 且 query 会把签名泄进访问日志）。
    if (path === '/owner/google/native-phone' && req.method === 'GET') {
      const transactionId = trimString(query.get('tx'));
      const browserTicket = trimString(query.get('ticket'));
      const nativeState = phoneStateFromCookie(req, transactionId)
        || deriveNativePhoneReplayState(transactionId, browserTicket);
      const phone = await broker.beginAccountSessionBrowserVerify({
        transactionId,
        ticket: browserTicket,
      });
      const page = renderNativeIdentityPage({
        transactionId,
        nonce: phone.nonce,
        nativeState,
        googleWebClientId,
        credentialEndpoint: `${base}/v1/owner-auth/native/session/browser-verified`,
        styles: await loadAccountPageAssets(),
      });
      res.writeHead(200, authPageHeaders(page, [phoneCookie(transactionId, nativeState), phoneCsrfCookie(transactionId, nativeState)]));
      res.end(page.body);
      return true;
    }

    if (path === '/v1/owner-auth/native/session/browser-verified' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const transactionId = trimString(body.transactionId);
      const nativeState = phoneStateFromCookie(req, transactionId);
      if (!hasValidPhoneCsrf(req, nativeState, base, transactionId)) {
        const error = new Error('Invalid browser CSRF state');
        error.code = 'owner_auth_csrf_invalid';
        error.statusCode = 403;
        throw error;
      }
      await broker.markAccountSessionBrowserVerified({
        transactionId,
        idToken: trimString(body.idToken),
      });
      jsonResponse(res, 200, { ok: true }, { 'Set-Cookie': clearPhoneCookies(transactionId) });
      return true;
    }

    if (path === '/v1/owner-auth/native/session/challenge' && req.method === 'POST') {
      const result = await broker.createAccountSessionChallenge(await readJsonBody(req));
      jsonResponse(res, 201, result);
      return true;
    }

    if (path === '/v1/owner-auth/native/session/demo' && req.method === 'POST') {
      const result = await broker.completeDemoAccountSession(await readJsonBody(req));
      jsonResponse(res, 200, result, { 'Cache-Control': 'no-store' });
      return true;
    }

    if (path === '/v1/owner-auth/native/session/complete' && req.method === 'POST') {
      const result = await broker.completeAccountSession(await readJsonBody(req));
      jsonResponse(res, 200, result);
      return true;
    }

    if (path === '/v1/owner-auth/native/session/refresh' && req.method === 'POST') {
      const result = await broker.refreshAccountSession(await readJsonBody(req));
      jsonResponse(res, 200, result);
      return true;
    }

    if (path === '/v1/owner-auth/native/complete' && req.method === 'POST') {
      const result = await broker.completeNativeCredential(await readJsonBody(req));
      jsonResponse(res, 200, result);
      return true;
    }

    if (path === '/v1/owner-auth/native/rollback' && req.method === 'POST') {
      const result = await broker.rollbackNativeCredential(await readJsonBody(req));
      jsonResponse(res, 200, result);
      return true;
    }

    if (path === '/v1/owner-auth/discovery' && req.method === 'POST') {
      const result = await broker.discoverInstances(await readJsonBody(req), { credential: bearerCredential(req) });
      jsonResponse(res, 200, result);
      return true;
    }

    // Android and other Account-session clients read the central directory
    // directly with their `rac_` bearer. Unlike the instance-proof endpoint
    // below, this route never accepts an accountId from the caller.
    if (path === '/v1/owner-auth/account/devices' && req.method === 'GET') {
      const result = await broker.listAccountDirectoryDevices({ credential: bearerCredential(req) });
      jsonResponse(res, 200, result);
      return true;
    }

    if (path === '/v1/owner-auth/account/usage' && req.method === 'GET') {
      const result = await broker.getAccountUsage({ credential: bearerCredential(req) });
      jsonResponse(res, 200, result);
      return true;
    }

    if (path === '/v1/owner-auth/account/turn/connections' && req.method === 'GET') {
      const result = await broker.listOwnTurnConnections({ credential: bearerCredential(req),
        afterConnectionId: query.get('after') || '', limit: query.get('limit') ?? 100 });
      jsonResponse(res, 200, result);
      return true;
    }
    if (path === '/v1/owner-auth/account/turn/connections/release' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const result = await broker.releaseOwnTurnConnections({ credential: bearerCredential(req),
        connectionIds: body.connectionIds, reason: body.reason ?? 'client-release' });
      jsonResponse(res, 200, result);
      return true;
    }

    const accountDeviceRename = /^\/v1\/owner-auth\/account\/devices\/([^/]+)\/rename$/.exec(path);
    if (accountDeviceRename && req.method === 'POST') {
      const body = await readJsonBody(req);
      const result = await broker.renameAccountDirectoryDevice({
        deviceId: decodeURIComponent(accountDeviceRename[1]), alias: body.alias,
        credential: bearerCredential(req),
      });
      jsonResponse(res, 200, result);
      return true;
    }

    if (path === '/v1/owner-auth/account/session/logout' && req.method === 'POST') {
      await readJsonBody(req);
      const result = await broker.logoutAccountSession({ credential: bearerCredential(req) });
      jsonResponse(res, 200, result);
      return true;
    }

    const accountDeviceRevoke = /^\/v1\/owner-auth\/account\/devices\/([^/]+)\/revoke$/.exec(path);
    if (accountDeviceRevoke && req.method === 'POST') {
      const result = await broker.revokeAccountDirectoryDevice({
        deviceId: decodeURIComponent(accountDeviceRevoke[1]),
        credential: bearerCredential(req),
      });
      jsonResponse(res, 200, result);
      return true;
    }

    if (path === '/v1/owner-auth/provider-sync/authorize' && req.method === 'POST') {
      const result = await broker.authorizeProviderSync(await readJsonBody(req));
      jsonResponse(res, 200, result);
      return true;
    }

    if (path === '/v1/target-runtime/authorize' && req.method === 'POST') {
      const result = await broker.authorizeTargetRuntime(await readJsonBody(req));
      jsonResponse(res, 200, result);
      return true;
    }

    const accountSyncCatalog = /^\/v1\/owner-auth\/sync\/catalog\/([^/]+)$/.exec(path);
    if (accountSyncCatalog && req.method === 'POST') {
      const body = await readJsonBody(req);
      const result = await broker.publishAccountSyncCatalog({
        ...body,
        accountId: decodeURIComponent(accountSyncCatalog[1]),
      });
      jsonResponse(res, 200, result);
      return true;
    }

    if (path === '/v1/owner-auth/account-intents' && req.method === 'POST') {
      const result = await broker.createAccountJoinIntent(await readJsonBody(req));
      jsonResponse(res, 201, result);
      return true;
    }

    if (path === '/v1/owner-auth/rendezvous' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const result = await broker.createAccountRendezvous(body, { credential: bearerCredential(req) });
      jsonResponse(res, 201, result);
      return true;
    }

    if (path === '/v1/owner-auth/rendezvous/inbox' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const controller = new AbortController();
      const disconnect = () => controller.abort(Object.assign(new Error('Inbox requester disconnected'), { name: 'AbortError' }));
      const close = () => { if (!res.writableEnded) disconnect(); };
      req.once?.('aborted', disconnect);
      res.once?.('close', close);
      if (req.aborted || res.destroyed) disconnect();
      try {
        const result = await broker.pollAccountRendezvousInbox(body, { signal: controller.signal });
        if (!controller.signal.aborted && !res.destroyed) jsonResponse(res, 200, result);
      } catch (error) {
        if (!controller.signal.aborted) throw error;
      } finally {
        req.off?.('aborted', disconnect);
        res.off?.('close', close);
      }
      return true;
    }

    const rendezvousRoute = /^\/v1\/owner-auth\/rendezvous\/([^/]+)\/(poll|grant|complete|result)$/.exec(path);
    if (rendezvousRoute && req.method === 'POST') {
      const requestId = decodeURIComponent(rendezvousRoute[1]);
      const action = rendezvousRoute[2];
      const body = await readJsonBody(req);
      if (action === 'result' && body.waitMs !== undefined && body.waitMs !== 0) {
        const controller = new AbortController();
        const disconnect = () => controller.abort(Object.assign(new Error('Rendezvous requester disconnected'), { name: 'AbortError' }));
        const close = () => { if (!res.writableEnded) disconnect(); };
        req.once?.('aborted', disconnect);
        res.once?.('close', close);
        if (req.aborted || res.destroyed) disconnect();
        try {
          const result = await broker.getAccountRendezvousResult({ ...body, requestId },
            { credential: bearerCredential(req), signal: controller.signal });
          if (!controller.signal.aborted && !res.destroyed) jsonResponse(res, 200, result);
        } catch (error) {
          if (!controller.signal.aborted) throw error;
        } finally {
          req.off?.('aborted', disconnect);
          res.off?.('close', close);
        }
        return true;
      }
      const result = action === 'poll'
        ? await broker.pollAccountRendezvous({ ...body, requestId })
        : action === 'grant'
          ? await broker.submitAccountRendezvousGrant({ ...body, requestId }, { credential: bearerCredential(req) })
        : action === 'complete'
          ? await broker.completeAccountRendezvous({ ...body, requestId })
          : await broker.getAccountRendezvousResult({ ...body, requestId }, { credential: bearerCredential(req) });
      jsonResponse(res, 200, result);
      return true;
    }

    const accountIntentComplete = /^\/v1\/owner-auth\/account-intents\/([^/]+)\/complete$/.exec(path);
    if (accountIntentComplete && req.method === 'POST') {
      const body = await readJsonBody(req);
      const requestId = trimString(req.headers?.['idempotency-key']);
      const result = await broker.completeAccountJoinIntent({
        ...body,
        intentId: decodeURIComponent(accountIntentComplete[1]),
        requestId,
      });
      jsonResponse(res, 200, result);
      return true;
    }

    const accountIntentAuthorize = /^\/v1\/owner-auth\/account-intents\/([^/]+)\/authorize$/.exec(path);
    if (accountIntentAuthorize && req.method === 'POST') {
      const body = await readJsonBody(req);
      const result = await broker.authorizeAccountJoinIntent({
        ...body,
        intentId: decodeURIComponent(accountIntentAuthorize[1]),
      }, { credential: bearerCredential(req) });
      jsonResponse(res, 200, result);
      return true;
    }

    const deviceList = /^\/v1\/owner-auth\/devices\/([^/]+)$/.exec(path);
    if (deviceList && req.method === 'POST') {
      const body = await readJsonBody(req);
      const result = await broker.listDevices({ ...body, accountId: decodeURIComponent(deviceList[1]) });
      jsonResponse(res, 200, result);
      return true;
    }

    const deviceHistory = /^\/v1\/owner-auth\/devices\/([^/]+)\/history$/.exec(path);
    if (deviceHistory && req.method === 'POST') {
      const body = await readJsonBody(req);
      const result = await broker.listBindingHistory({ ...body, accountId: decodeURIComponent(deviceHistory[1]) });
      jsonResponse(res, 200, result);
      return true;
    }

    const deviceUnbind = /^\/v1\/owner-auth\/devices\/([^/]+)\/unbind$/.exec(path);
    if (deviceUnbind && req.method === 'POST') {
      const body = await readJsonBody(req);
      const result = await broker.unbindInstance({ ...body, accountId: decodeURIComponent(deviceUnbind[1]) });
      jsonResponse(res, 200, result);
      return true;
    }

    const deviceEndpoint = /^\/v1\/owner-auth\/devices\/([^/]+)\/endpoint$/.exec(path);
    if (deviceEndpoint && req.method === 'POST') {
      const body = await readJsonBody(req);
      const result = await broker.publishInstanceEndpoint({
        ...body,
        accountId: decodeURIComponent(deviceEndpoint[1]),
      });
      jsonResponse(res, 200, result);
      return true;
    }

    const deviceIdentity = /^\/v1\/owner-auth\/devices\/([^/]+)\/identity$/.exec(path);
    if (deviceIdentity && req.method === 'POST') {
      const body = await readJsonBody(req);
      const result = await broker.publishInstanceIdentity({
        ...body,
        accountId: decodeURIComponent(deviceIdentity[1]),
      });
      jsonResponse(res, 200, result);
      return true;
    }

    if (path === '/v1/owner-auth/turn/connections/reserve' && req.method === 'POST') {
      const result = await broker.reserveTurnConnection(await readJsonBody(req));
      jsonResponse(res, 201, result);
      return true;
    }

    if (path === '/v1/owner-auth/turn/connections/release' && req.method === 'POST') {
      const result = await broker.releaseTurnConnection(await readJsonBody(req));
      jsonResponse(res, 200, result);
      return true;
    }

    if (path === '/v1/owner-auth/turn/connections/handoff/commit' && req.method === 'POST') {
      const result = await broker.commitTurnConnectionHandoff(await readJsonBody(req));
      jsonResponse(res, 200, result);
      return true;
    }
  } catch (error) {
    audit({ event: 'security.rejected', code: error?.code || 'owner_auth_failed', path });
    jsonResponse(res, error?.statusCode || 500, {
      code: error?.code || 'owner_auth_failed',
      error: 'Owner authentication could not be completed.',
      ...(error?.details && typeof error.details === 'object' ? { details: error.details } : {}),
    }, error?.code === 'owner_auth_rendezvous_wait_busy' ? { 'Retry-After': '1' } : {});
    return true;
  }
  return false;
}
