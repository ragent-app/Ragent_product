import { MESSAGE_PREPARATION_LIMIT, MESSAGE_PREPARATION_BODY_BYTES, MESSAGE_PREPARATION_TEXT_BYTES,
  MESSAGE_PREPARATION_OPTION_KEYS } from './message-preparation-contract.mjs';
import { prepareSessionApiMessage, readSessionApiMessagePreparation } from './message-preparation-store.mjs';
import { SESSION_API_SCOPE_HEADER, readSessionApiScopeHeader } from './session-api-scope-contract.mjs';
import { sessionApiError, sessionApiIdentifier } from './session-api-mutation-contract.mjs';

export async function readPreparationBody(req, limit = MESSAGE_PREPARATION_BODY_BYTES) {
  if (String(req.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json')
    throw sessionApiError('INVALID_ARGUMENT', 415, 'Message preparation requires application/json');
  const declared = Number(req.headers?.['content-length']);
  if (Number.isFinite(declared) && declared > limit)
    throw sessionApiError('RESOURCE_LIMIT', 413, 'Message preparation body is too large');
  const chunks = []; let size = 0;
  for await (const raw of req.iterator({ destroyOnReturn: false })) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    size += chunk.length;
    if (size > limit)
      throw sessionApiError('RESOURCE_LIMIT', 413, 'Message preparation body is too large');
    chunks.push(chunk);
  }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw sessionApiError('INVALID_ARGUMENT', 400, 'Invalid message preparation JSON'); }
}

const PUBLIC_ERRORS = new Set(['INVALID_ARGUMENT', 'PERMISSION_DENIED', 'METHOD_NOT_ALLOWED',
  'RESOURCE_NOT_FOUND', 'RESOURCE_LIMIT', 'REVISION_CONFLICT', 'REQUEST_EXPIRED', 'CAPABILITY_UNSUPPORTED',
  'MESSAGE_IDEMPOTENCY_CONFLICT', 'MESSAGE_ATTACHMENT_CONFLICT', 'MESSAGE_PREPARATION_STORE_INVALID',
  'SESSION_MUTATION_STORE_INVALID', 'SESSION_MUTATION_STORE_UNAVAILABLE', 'FILE_ASSET_RECEIPT_UNAVAILABLE',
  'FILE_ASSET_IDEMPOTENCY_CONFLICT']);

/** Pure durable preparation; no message, queue entry, Run, planner or provider. */
export async function handleMessagePreparationRoutes({ req, res, pathname, parsedUrl, authSession,
  requireSessionAccess, writeJson }) {
  const contract = pathname === '/api/message-preparation-contract';
  const match = pathname.match(/^\/api\/sessions\/([^/]+)\/app-api-message-preparations(?:\/([^/]+))?$/);
  if (!contract && !match) return false;
  res.setHeader?.('Cache-Control', 'private, no-store');
  try {
    if (authSession?.role !== 'owner' ||
        (authSession.principalKind && !['owner', 'trusted_device'].includes(authSession.principalKind)))
      throw sessionApiError('PERMISSION_DENIED', 403, 'Owner message preparation access is required');
    if (parsedUrl?.searchParams?.size || parsedUrl?.search || Object.keys(parsedUrl?.query || {}).length)
      throw sessionApiError('INVALID_ARGUMENT', 400, 'Message preparation query parameters are unsupported');
    const method = contract || match?.[2] ? 'GET' : 'POST';
    if (req.method !== method) {
      res.setHeader?.('Allow', method);
      throw sessionApiError('METHOD_NOT_ALLOWED', 405, 'Unsupported message preparation method');
    }
    if (contract) {
      writeJson(res, 200, { version: 1, preparesOnly: true, commitSupported: true, startsRun: false,
        commitBodyBytes: 4096,
        commitPath: '/api/sessions/{sessionId}/app-api-message-preparations/{requestId}/commit',
        commitReceiptPath: '/api/sessions/{sessionId}/app-api-message-preparations/{requestId}/commit',
        scopeHeader: SESSION_API_SCOPE_HEADER, scopeContractPath: '/api/session-scope-contract',
        maxBodyBytes: MESSAGE_PREPARATION_BODY_BYTES, maxTextBytes: MESSAGE_PREPARATION_TEXT_BYTES,
        maxAttachments: 16, attachmentOptionKeys: ['renderAs'], retainedPerSession: MESSAGE_PREPARATION_LIMIT, maxLifetimeSeconds: 86400,
        runOptionKeys: MESSAGE_PREPARATION_OPTION_KEYS,
        preparePath: '/api/sessions/{sessionId}/app-api-message-preparations',
        receiptPath: '/api/sessions/{sessionId}/app-api-message-preparations/{requestId}' });
      return true;
    }
    const sessionId = sessionApiIdentifier(decodeURIComponent(match[1]), 256);
    const requestId = match[2] == null ? null : sessionApiIdentifier(decodeURIComponent(match[2]));
    const scope = readSessionApiScopeHeader(req, sessionId);
    if (!scope) throw sessionApiError('INVALID_ARGUMENT', 400, 'The original Session scope header is required');
    if (!await requireSessionAccess(res, authSession, sessionId, { metadataOnly: true })) return true;
    const result = requestId === null
      ? await prepareSessionApiMessage(sessionId, scope, await readPreparationBody(req), { authSession })
      : await readSessionApiMessagePreparation(sessionId, requestId, scope);
    writeJson(res, 200, result);
  } catch (error) {
    req.resume?.();
    const encoding = error instanceof URIError;
    const known = PUBLIC_ERRORS.has(error?.code) && Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode <= 599;
    writeJson(res, encoding ? 400 : known ? error.statusCode : 503, {
      code: encoding ? 'INVALID_ARGUMENT' : known ? error.code : 'MESSAGE_PREPARATION_UNAVAILABLE',
      error: encoding ? 'Invalid message identity encoding' : known ? error.message : 'Message preparation is unavailable',
    });
  }
  return true;
}
