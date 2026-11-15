import { readBody } from '../lib/utils.mjs';
import { temporaryAccessExpiryHint } from '../lib/temporary-device-access.mjs';
import { temporaryCarrierRoute } from '../lib/temporary-carrier-routes.mjs';
import { temporaryPairingError } from '../lib/temporary-pairing-protocol.mjs';
import { uploadChunkHeaders } from './file-asset-upload-checkpoints.mjs';

const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' };
const fail = (code, status) => { throw temporaryPairingError(code, status); };
function send(res, status, value) { res.writeHead(status, headers); res.end(JSON.stringify(value)); }
function scopeFrom(req) {
  const encoded = req.headers['x-ragent-app-api-scope'];
  if (typeof encoded !== 'string' || !/^[A-Za-z0-9_-]{1,2048}$/.test(encoded)) fail('temporary_scope_invalid', 400);
  try {
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.toString('base64url') !== encoded) throw new Error();
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch { fail('temporary_scope_invalid', 400); }
}
async function jsonFrom(req) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(String(req.headers['content-type'] || '')))
    fail('temporary_body_invalid', 415);
  const body = await readBody(req, 256 * 1024);
  try { return JSON.parse(body); }
  catch { fail('temporary_body_invalid', 400); }
}
function queryFrom(route) {
  const q = route.query;
  if (q.size !== 3 || ['revision', 'offset', 'length'].some(key => q.getAll(key).length !== 1))
    fail('temporary_query_invalid', 400);
  return { revision: q.get('revision'), offset: q.get('offset'), length: q.get('length') };
}

/** P2P proxy only: each request carries a fresh device proof and a fixed carrier grant. */
export async function handleTemporaryCarrierRequest(req, res, { host, temporaryDevice }) {
  const route = temporaryCarrierRoute(req.method, req.url);
  if (!route || route.instanceId !== temporaryDevice?.instanceId) {
    req.resume(); send(res, 403, { code: 'temporary_route_denied' }); return;
  }
  try {
    if (req.headers.cookie || req.headers['x-ragent-browser-principal'] || req.headers['x-ragent-target-grant']
      || req.headers.upgrade || req.headers['sec-websocket-key']) fail('temporary_credential_mixed', 401);
    const authorization = req.headers.authorization;
    const match = typeof authorization === 'string' ? /^DPoP ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(authorization) : null;
    if (!match || typeof req.headers.dpop !== 'string' || req.headers.dpop.length > 8192)
      fail('temporary_access_required', 401);
    const credential = { token_type: 'DPoP', access_token: match[1], expires_at: temporaryAccessExpiryHint(match[1]) };
    const principal = await host.authenticateRequest({ credential, proof: req.headers.dpop,
      method: req.method, targetUri: route.targetUri });
    if (principal.grantId !== temporaryDevice.grantId || principal.deviceId !== temporaryDevice.deviceId
      || principal.instanceId !== temporaryDevice.instanceId || principal.expiry !== temporaryDevice.accessExpiresAt)
      fail('temporary_carrier_binding_invalid', 403);
    if (route.action !== 'result.chunk' && route.query.size) fail('temporary_query_invalid', 400);
    const [sessionId, resourceId] = route.args;
    const scope = ['runtime.list', 'session.create'].includes(route.action) ? null : scopeFrom(req);
    if (scope && scope.sessionId !== sessionId) fail('temporary_scope_invalid', 400);
    let value;
    switch (route.action) {
      case 'runtime.list':
        if (req.method !== 'GET' || req.headers['content-type']) fail('temporary_body_invalid', 400);
        req.resume();
        value = await host.sessions.listRuntimes(principal);
        break;
      case 'session.create': value = await host.sessions.create(principal, await jsonFrom(req)); break;
      case 'session.read': value = await host.sessions.read(principal, scope); break;
      case 'message.prepare': value = await host.messages.prepare(principal, scope, await jsonFrom(req)); break;
      case 'message.preparation': value = await host.messages.preparation(principal, scope, resourceId); break;
      case 'message.commit': value = await host.messages.commit(principal, scope, resourceId, await jsonFrom(req)); break;
      case 'message.receipt': value = await host.messages.receipt(principal, scope, resourceId); break;
      case 'upload.create': value = await host.files.create(principal, scope, await jsonFrom(req)); break;
      case 'upload.receipt': value = await host.files.receipt(principal, scope, resourceId); break;
      case 'upload.write': value = await host.files.upload(principal, scope, resourceId, req); break;
      case 'upload.chunk': value = await host.files.uploadChunk(principal, scope, resourceId, uploadChunkHeaders(req.headers), req); break;
      case 'upload.checkpoint': value = await host.files.checkpointState(principal, scope, resourceId); break;
      case 'upload.cancel': value = await host.files.cancel(principal, scope, resourceId); break;
      case 'upload.finalize': value = await host.files.finalize(principal, scope, resourceId, await jsonFrom(req)); break;
      case 'run.read': value = await host.results.run(principal, scope, resourceId); break;
      case 'result.read': value = await host.results.preview(principal, scope, resourceId); break;
      case 'result.export': value = await host.results.manifest(principal, scope, resourceId); break;
      case 'result.chunk': value = await host.results.chunk(principal, scope, resourceId, route.args[2], queryFrom(route)); break;
      case 'run.cancel': value = await host.results.cancel(principal, scope, resourceId, await jsonFrom(req)); break;
      default: fail('temporary_route_denied', 403);
    }
    await host.revalidatePrincipal(principal);
    send(res, value === null ? 404 : 200, value === null ? { code: 'RESOURCE_NOT_FOUND' } : value);
  } catch (error) {
    if (res.headersSent || res.destroyed) return;
    req.resume();
    const code = typeof error?.code === 'string' && /^[A-Za-z0-9_]{1,80}$/.test(error.code)
      ? error.code : 'temporary_request_failed';
    const status = Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode <= 599
      ? error.statusCode : 503;
    send(res, status, { code });
  }
}
