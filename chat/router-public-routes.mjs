import { readFile } from 'fs/promises';
import { collectCacheMetrics, getSamplerState } from './memory-registry.mjs';
import { getApiRequestMetrics } from './api-request-log.mjs';
import { SESSION_EXPIRY } from '../lib/config.mjs';
import {
  verifyPasswordAsync,
  issueSession,
  revokeSession,
  parseCookies,
  getAuthSession,
  setCookie,
  clearCookie,
  clearVisitorCookie,
} from '../lib/auth.mjs';
import {
  createInstallHandoff,
  normalizeInstallHandoffToken,
  redeemInstallHandoff,
} from '../lib/install-handoffs.mjs';
import { readBody } from '../lib/utils.mjs';
import {
  getClientIp,
  isRateLimited,
  recordFailedAttempt,
  clearFailedAttempts,
} from './middleware.mjs';

export async function handlePublicRoutes({
  req,
  res,
  parsedUrl,
  pathname,
  nonce,
  loginTemplatePath,
  mobileInstallTemplatePath,
  getPageBuildInfo,
  buildHeaders,
  renderPageTemplate,
  buildTemplateReplacements,
  serializeJsonForScript,
  writeJsonCached,
}) {
function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeForwardedPrefix(value) {
  const trimmed = trimString(value);
  if (!trimmed) return '';
  const normalized = `/${trimmed.replace(/^\/+|\/+$/g, '')}`;
  return normalized === '/' ? '' : normalized;
}

function getRequestProductBasePath(req) {
  return normalizeForwardedPrefix(req?.headers?.['x-forwarded-prefix']);
}

async function mintOwnerSessionFromInstallHandoff(handoffToken) {
  const handoffSession = await redeemInstallHandoff(handoffToken);
  if (!handoffSession) return null;

  const sessionToken = await issueSession({
    role: 'owner',
    ...(handoffSession.preferredLanguage ? { preferredLanguage: handoffSession.preferredLanguage } : {}),
  });
  if (!sessionToken) return null;

  return {
    redirect: '/?skipInstall=1',
    setCookie: setCookie(sessionToken),
  };
}

if (pathname === '/m/continue' && req.method === 'GET') {
  const authSession = getAuthSession(req);
  if (authSession?.role === 'owner') {
    res.writeHead(302, buildHeaders({
      'Location': '/?skipInstall=1',
      'Cache-Control': 'no-store, max-age=0, must-revalidate',
      'Referrer-Policy': 'no-referrer',
    }));
    res.end();
    return true;
  }

  const handoffToken = normalizeInstallHandoffToken(
    typeof parsedUrl.query?.h === 'string' ? parsedUrl.query.h : '',
  );
  if (!handoffToken) {
    res.writeHead(302, buildHeaders({
      'Location': '/login',
      'Cache-Control': 'no-store, max-age=0, must-revalidate',
      'Referrer-Policy': 'no-referrer',
    }));
    res.end();
    return true;
  }

  const nextSession = await mintOwnerSessionFromInstallHandoff(handoffToken);
  if (!nextSession) {
    res.writeHead(302, buildHeaders({
      'Location': '/login',
      'Cache-Control': 'no-store, max-age=0, must-revalidate',
      'Referrer-Policy': 'no-referrer',
    }));
    res.end();
    return true;
  }

  res.writeHead(302, buildHeaders({
    'Location': nextSession.redirect,
    'Cache-Control': 'no-store, max-age=0, must-revalidate',
    'Referrer-Policy': 'no-referrer',
    'Set-Cookie': nextSession.setCookie,
  }));
  res.end();
  return true;
}

if (pathname === '/api/install/handoff/redeem' && req.method === 'POST') {
  let payload = {};
  try {
    payload = JSON.parse(await readBody(req, 4096) || '{}');
  } catch {
    payload = {};
  }
  const handoffToken = normalizeInstallHandoffToken(payload?.token);
  if (!handoffToken) {
    res.writeHead(400, buildHeaders({
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, max-age=0, must-revalidate',
    }));
    res.end(JSON.stringify({ error: 'Install handoff token is required' }));
    return true;
  }
  const nextSession = await mintOwnerSessionFromInstallHandoff(handoffToken);
  if (!nextSession) {
    res.writeHead(401, buildHeaders({
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, max-age=0, must-revalidate',
    }));
    res.end(JSON.stringify({ error: 'Install handoff expired or is no longer valid' }));
    return true;
  }
  res.writeHead(200, buildHeaders({
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store, max-age=0, must-revalidate',
    'Set-Cookie': nextSession.setCookie,
  }));
  res.end(JSON.stringify({ ok: true, redirect: '/' }));
  return true;
}

if (pathname === '/m/install' && req.method === 'GET') {
  const authSession = getAuthSession(req);
  const currentHandoffToken = normalizeInstallHandoffToken(
    typeof parsedUrl.query?.h === 'string' ? parsedUrl.query.h : '',
  );

  if (!currentHandoffToken && authSession?.role === 'owner') {
    const handoff = await createInstallHandoff(authSession);
    const params = new URLSearchParams();
    params.set('h', handoff.token);
    const source = typeof parsedUrl.query?.source === 'string' ? parsedUrl.query.source.trim() : '';
    if (source) params.set('source', source);
    res.writeHead(302, { 'Location': `/m/install?${params.toString()}` });
    res.end();
    return true;
  }

  if (!currentHandoffToken) {
    res.writeHead(302, { 'Location': '/login' });
    res.end();
    return true;
  }

  let installHtml;
  const pageBuildInfo = await getPageBuildInfo();
  try { installHtml = await readFile(mobileInstallTemplatePath, 'utf8'); } catch { installHtml = '<h1>Mobile install template missing</h1>'; }
  const manifestHref = `manifest.install.json?h=${encodeURIComponent(currentHandoffToken)}&v=${encodeURIComponent(pageBuildInfo.assetVersion)}`;
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.writeHead(200, buildHeaders({
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
  }));
  res.end(renderPageTemplate(installHtml, nonce, {
    ...buildTemplateReplacements(pageBuildInfo, getRequestProductBasePath(req)),
    PAGE_TITLE: 'Install Ragent',
    BODY_CLASS: 'mobile-install-page',
    MANIFEST_HREF: manifestHref,
    BOOTSTRAP_JSON: serializeJsonForScript({
      mobileInstall: {
        handoffToken: currentHandoffToken,
      },
    }),
  }));
  return true;
}

// Login — POST (form submit)
if (pathname === '/login' && req.method === 'POST') {
  const ip = getClientIp(req);
  if (isRateLimited(ip)) {
    res.writeHead(429, { 'Content-Type': 'text/plain', 'Retry-After': '60' });
    res.end('Too many failed attempts. Please try again later.');
    return true;
  }
  let body;
  try { body = await readBody(req, 4096); } catch { body = ''; }
  const params = new URLSearchParams(body);
  // 静态 access token 登录已于安全加固中下线（2026-08-05），仅密码登录。
  const valid = await verifyPasswordAsync(params.get('username') || '', params.get('password') || '');
  if (valid) {
    clearFailedAttempts(ip);
    const sessionToken = await issueSession({ role: 'owner' });
    if (sessionToken) {
      res.writeHead(302, { 'Location': '/', 'Set-Cookie': setCookie(sessionToken) });
    } else {
      res.writeHead(302, { 'Location': '/login?error=1&mode=pw' });
    }
  } else {
    recordFailedAttempt(ip);
    res.writeHead(302, { 'Location': '/login?error=1&mode=pw' });
  }
  res.end();
  return true;
}

// Login — GET (show form)
if (pathname === '/login') {
  const hasError = parsedUrl.query.error === '1';
  const mode = parsedUrl.query.mode === 'token' ? 'token' : 'pw';
  let loginHtml;
  const pageBuildInfo = await getPageBuildInfo();
  try { loginHtml = await readFile(loginTemplatePath, 'utf8'); } catch { loginHtml = '<h1>Login template missing</h1>'; }
  res.writeHead(200, buildHeaders({
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
  }));
  res.end(renderPageTemplate(loginHtml, nonce, {
    ...buildTemplateReplacements(pageBuildInfo, getRequestProductBasePath(req)),
    ERROR_CLASS: hasError ? '' : 'hidden',
    MODE: mode,
  }));
  return true;
}

// Logout — clear both owner and visitor session cookies
if (pathname === '/logout') {
  const cookies = parseCookies(req.headers.cookie || '');
  const ownerToken = cookies.session_token;
  const visitorToken = cookies.visitor_session_token;
  if (ownerToken) { revokeSession(ownerToken); }
  if (visitorToken) { revokeSession(visitorToken); }
  res.writeHead(302, {
    'Location': '/login',
    'Set-Cookie': [clearCookie(), clearVisitorCookie()],
  });
  res.end();
  return true;
}

if (/^\/app\/[^/]+$/.test(pathname) && req.method === 'GET') {
  res.writeHead(404, buildHeaders({
    'Content-Type': 'text/plain',
    'Cache-Control': 'no-store, max-age=0, must-revalidate',
  }));
  res.end('Not found');
  return true;
}

if (pathname === '/api/build-info' && req.method === 'GET') {
  const pageBuildInfo = await getPageBuildInfo();
  writeJsonCached(req, res, pageBuildInfo, {
    cacheControl: 'no-store, max-age=0, must-revalidate',
    vary: '',
    headers: {
      'X-AgentoC-Runtime-Mode': pageBuildInfo.runtimeMode,
      'X-AgentoC-Release-Id': pageBuildInfo.releaseId || '',
      'X-AgentoC-Asset-Version': pageBuildInfo.assetVersion,
      'X-AgentoC-Service-Build': pageBuildInfo.serviceTitle,
      'X-AgentoC-Frontend-Build': pageBuildInfo.frontendTitle,
    },
  });
  return true;
}

// DS-06: owner-only memory/performance diagnostics. Same aggregates as
// /healthz plus the sampler history ring. Aggregates only — never session
// bodies, path secrets, tokens or cookies (registry contract).
if (pathname === '/api/diagnostics/memory' && req.method === 'GET') {
  const authSession = getAuthSession(req);
  if (authSession?.role !== 'owner') {
    res.writeHead(403, buildHeaders({
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, max-age=0, must-revalidate',
    }));
    res.end(JSON.stringify({ error: 'Forbidden' }));
    return true;
  }
  const memory = process.memoryUsage();
  const samplerState = getSamplerState();
  writeJsonCached(req, res, {
    collectedAtMs: Date.now(),
    process: {
      pid: process.pid,
      uptimeSec: Math.round(process.uptime()),
      memory: {
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        heapTotalBytes: memory.heapTotal,
        externalBytes: memory.external,
        arrayBuffersBytes: memory.arrayBuffers,
      },
    },
    caches: collectCacheMetrics(),
    requestMetrics: getApiRequestMetrics(),
    sampler: samplerState,
  }, {
    cacheControl: 'no-store, max-age=0, must-revalidate',
    vary: '',
  });
  return true;
}


  return false;
}
