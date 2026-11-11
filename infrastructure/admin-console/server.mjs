#!/usr/bin/env node
import { createServer } from 'node:http';
import { createPublicKey, verify as verifySignature } from 'node:crypto';
import { createReadStream, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = resolve(HERE, '../../static/admin-console');
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_HELPER_RESPONSE_BYTES = 2 * 1024 * 1024;
const SESSION_CLOCK_SKEW_SECONDS = 60;

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store, max-age=0',
    Pragma: 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  });
  res.end(body);
}

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
}

function decodeJwtPart(value) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}

function normalizeAudiences(value) {
  return (Array.isArray(value) ? value : [value]).filter((item) => typeof item === 'string');
}

export function createAccessVerifier({
  accessDomain,
  audience,
  ownerEmail,
  fetchImpl = globalThis.fetch,
  clock = () => Date.now(),
} = {}) {
  const issuer = `https://${text(accessDomain).replace(/^https?:\/\//i, '').replace(/\/$/, '')}`;
  const expectedAudience = text(audience);
  const expectedEmail = text(ownerEmail).toLowerCase();
  let keysCache = null;
  let keysPromise = null;

  async function getKeys() {
    if (keysCache && keysCache.expiresAt > clock()) return keysCache.keys;
    if (keysPromise) return keysPromise;
    keysPromise = (async () => {
      const response = await fetchImpl(`${issuer}/cdn-cgi/access/certs`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error('Access verification keys unavailable');
      const document = await response.json();
      const keys = Array.isArray(document?.keys) ? document.keys : [];
      if (!keys.length) throw new Error('Access verification keys unavailable');
      keysCache = { keys, expiresAt: clock() + 10 * 60 * 1000 };
      return keys;
    })().finally(() => {
      keysPromise = null;
    });
    return keysPromise;
  }

  return async function verifyAccessToken(token) {
    const parts = text(token).split('.');
    if (parts.length !== 3 || !expectedAudience || !expectedEmail || !/^https:\/\//.test(issuer)) return null;
    let header;
    let claims;
    let signature;
    try {
      header = decodeJwtPart(parts[0]);
      claims = decodeJwtPart(parts[1]);
      signature = Buffer.from(parts[2], 'base64url');
    } catch {
      return null;
    }
    if (header.alg !== 'RS256' || !text(header.kid)) return null;
    let jwk;
    try {
      jwk = (await getKeys()).find((key) => key.kid === header.kid && key.kty === 'RSA');
    } catch {
      return null;
    }
    if (!jwk) return null;
    let validSignature = false;
    try {
      validSignature = verifySignature(
        'RSA-SHA256',
        Buffer.from(`${parts[0]}.${parts[1]}`),
        createPublicKey({ key: jwk, format: 'jwk' }),
        signature,
      );
    } catch {
      return null;
    }
    const now = Math.floor(clock() / 1000);
    const exp = Number(claims.exp);
    const nbf = Number(claims.nbf || 0);
    if (
      !validSignature ||
      claims.iss !== issuer ||
      !normalizeAudiences(claims.aud).includes(expectedAudience) ||
      text(claims.email).toLowerCase() !== expectedEmail ||
      !text(claims.sub) ||
      !Number.isFinite(exp) ||
      exp <= now - SESSION_CLOCK_SKEW_SECONDS ||
      (Number.isFinite(nbf) && nbf > now + SESSION_CLOCK_SKEW_SECONDS)
    ) return null;
    return { email: expectedEmail, subject: text(claims.sub) };
  };
}

function readRequestBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error('Request too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!size) return resolveBody({});
      if (!(req.headers['content-type'] || '').toLowerCase().includes('application/json')) {
        return reject(Object.assign(new Error('JSON required'), { statusCode: 415 }));
      }
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function callHelper(socketPath, request, timeoutMs = 90_000) {
  return new Promise((resolveResult, reject) => {
    const socket = net.createConnection({ path: socketPath });
    let buffer = '';
    let settled = false;
    const timer = setTimeout(() => finish(new Error('Admin helper timed out')), timeoutMs);
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolveResult(result);
    };
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_HELPER_RESPONSE_BYTES) {
        finish(new Error('Admin helper response too large'));
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try {
        const parsed = JSON.parse(buffer.slice(0, newline));
        if (!parsed?.ok) finish(Object.assign(new Error(parsed?.message || 'Admin operation failed'), { code: parsed?.code || 'ADMIN_OPERATION_FAILED' }));
        else finish(null, parsed.result);
      } catch {
        finish(new Error('Invalid admin helper response'));
      }
    });
    socket.on('error', (error) => finish(error));
    socket.on('close', () => {
      if (!settled) finish(new Error('Admin helper disconnected'));
    });
  });
}

function normalizeBackupId(value) {
  const id = text(value);
  return /^accounts-\d{8}T\d{6}Z-[a-f0-9]{8}\.dump$/.test(id) ? id : '';
}

function contentTypeFor(pathname) {
  if (pathname.endsWith('.css')) return 'text/css; charset=utf-8';
  if (pathname.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (pathname.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}

export function createAdminServer({
  host = process.env.AGENTOC_ADMIN_HOST || '127.0.0.1',
  port = Number(process.env.AGENTOC_ADMIN_PORT || 7722),
  expectedOrigin = process.env.AGENTOC_ADMIN_ORIGIN || 'https://ops.agentoncloud.com',
  socketPath = process.env.AGENTOC_ADMIN_SOCKET || '/run/agentoc-admin/helper.sock',
  backupDirectory = process.env.AGENTOC_ADMIN_BACKUP_DIR || '/var/lib/agentoc-admin/backups',
  accessVerifier = createAccessVerifier({
    accessDomain: process.env.AGENTOC_ADMIN_ACCESS_DOMAIN,
    audience: process.env.AGENTOC_ADMIN_ACCESS_AUD,
    ownerEmail: process.env.AGENTOC_ADMIN_OWNER_EMAIL,
  }),
  helperClient = (request, timeout) => callHelper(socketPath, request, timeout),
  publicDir = process.env.AGENTOC_ADMIN_PUBLIC_DIR || PUBLIC_DIR,
} = {}) {
  const expectedUrl = new URL(expectedOrigin);

  async function handle(req, res) {
    setSecurityHeaders(res);
    const requestUrl = new URL(req.url || '/', expectedOrigin);
    const pathname = decodeURIComponent(requestUrl.pathname);

    if (req.method === 'GET' && pathname === '/healthz') {
      return sendJson(res, 200, { ok: true });
    }

    const token = text(req.headers['cf-access-jwt-assertion']);
    const identity = await accessVerifier(token);
    if (!identity) return sendJson(res, 401, { error: 'access_denied' });

    if (req.method === 'GET' && pathname === '/') {
      const html = await readFile(join(publicDir, 'index.html'));
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': html.length,
        'Cache-Control': 'no-store, max-age=0',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'X-Frame-Options': 'DENY',
      });
      return res.end(html);
    }

    if (req.method === 'GET' && pathname.startsWith('/assets/')) {
      const assetName = pathname.slice('/assets/'.length);
      if (!['tabler.min.css', 'admin.css', 'admin.js'].includes(assetName)) return sendJson(res, 404, { error: 'not_found' });
      const asset = await readFile(join(publicDir, assetName));
      res.writeHead(200, {
        'Content-Type': contentTypeFor(assetName),
        'Content-Length': asset.length,
        'Cache-Control': 'private, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
      });
      return res.end(asset);
    }

    if (req.method === 'POST') {
      const origin = text(req.headers.origin);
      if (origin !== expectedUrl.origin) return sendJson(res, 403, { error: 'origin_denied' });
    }

    const simpleGetOps = new Map([
      ['/api/overview', 'overview'],
      ['/api/secrets', 'secrets'],
      ['/api/database', 'database'],
      ['/api/migrations', 'migrations'],
      ['/api/backups', 'list_backups'],
      ['/api/audit', 'audit'],
    ]);
    if (req.method === 'GET' && simpleGetOps.has(pathname)) {
      const result = await helperClient({ op: simpleGetOps.get(pathname), actor: identity.email, data: {} });
      return sendJson(res, 200, result);
    }

    if (req.method === 'GET' && pathname.startsWith('/api/backups/')) {
      const backupId = normalizeBackupId(pathname.slice('/api/backups/'.length).replace(/\/download$/, ''));
      if (!backupId || !pathname.endsWith('/download')) return sendJson(res, 404, { error: 'not_found' });
      const allowed = await helperClient({ op: 'check_backup', actor: identity.email, data: { backupId } });
      const filePath = join(backupDirectory, backupId);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${backupId}"`,
        'Content-Length': allowed.size,
        'Cache-Control': 'no-store, max-age=0',
        'X-Content-Type-Options': 'nosniff',
      });
      return createReadStream(filePath).pipe(res);
    }

    if (req.method === 'POST') {
      const body = await readRequestBody(req);
      const [,,resource,resourceId] = pathname.split('/');
      let operation = null;
      let data = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
      let timeout = 90_000;

      if (resource === 'secrets' && resourceId) {
        operation = 'set_secret';
        data.secretId = resourceId;
      } else if (pathname === '/api/asr') {
        operation = 'set_asr';
      } else if (pathname === '/api/database/password-rotation') {
        operation = 'rotate_database_password';
      } else if (pathname === '/api/database/backups') {
        operation = 'create_backup';
        timeout = 180_000;
      } else if (pathname === '/api/database/restore') {
        operation = 'restore_backup';
        timeout = 300_000;
      } else if (pathname === '/api/database/migrate') {
        operation = 'apply_migrations';
        timeout = 300_000;
      } else if (resource === 'services' && resourceId && pathname.endsWith('/restart')) {
        operation = 'restart_service';
        data.service = resourceId;
      }
      if (!operation) return sendJson(res, 404, { error: 'not_found' });
      const result = await helperClient({ op: operation, actor: identity.email, data }, timeout);
      return sendJson(res, 200, result);
    }

    return sendJson(res, 404, { error: 'not_found' });
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((error) => {
      if (res.headersSent) return res.destroy();
      if (error?.statusCode) return sendJson(res, error.statusCode, { error: error.statusCode === 413 ? 'request_too_large' : 'invalid_request' });
      const code = text(error?.code) || 'ADMIN_UNAVAILABLE';
      console.error(`[admin-console] operation failed (${code})`);
      return sendJson(res, 503, { error: code });
    });
  });
  server.requestTimeout = 300_000;
  server.headersTimeout = 310_000;
  return { server, listen: () => new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolveListen(server.address());
    });
  }) };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const app = createAdminServer();
  app.listen().then((address) => console.log(`[admin-console] listening on ${address.address}:${address.port}`))
    .catch((error) => {
      console.error(`[admin-console] failed to listen (${text(error?.code) || 'UNKNOWN'})`);
      process.exitCode = 1;
    });
}
