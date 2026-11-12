import { readPreparationBody } from './message-preparation-routes.mjs';
import { commitSessionApiMessage, readSessionApiMessageCommit } from './message-commit-store.mjs';
import { scheduleScopedMessageRun } from './session-manager.mjs';
import { readSessionApiScopeHeader } from './session-api-scope-contract.mjs';
import { sessionApiError, sessionApiIdentifier } from './session-api-mutation-contract.mjs';
import { authenticatedOwnerDeviceDescriptor } from './windows-owner-device-authority.mjs';

const ERRORS = new Set(['INVALID_ARGUMENT', 'PERMISSION_DENIED', 'METHOD_NOT_ALLOWED', 'RESOURCE_LIMIT',
  'RESOURCE_NOT_FOUND', 'REVISION_CONFLICT', 'REQUEST_EXPIRED', 'CAPABILITY_UNSUPPORTED',
  'MESSAGE_IDEMPOTENCY_CONFLICT', 'MESSAGE_ATTACHMENT_CONFLICT', 'MESSAGE_PREPARATION_STORE_INVALID',
  'SESSION_MUTATION_STORE_INVALID', 'SESSION_MUTATION_STORE_UNAVAILABLE', 'FILE_ASSET_RECEIPT_UNAVAILABLE',
  'RUN_PUBLICATION_UNAVAILABLE', 'MESSAGE_RUN_BINDING_INVALID', 'RUN_ALREADY_EXISTS']);
export async function handleMessageCommitRoutes({ req, res, pathname, parsedUrl, authSession,
  requireSessionAccess, writeJson }) {
  const match = pathname.match(/^\/api\/sessions\/([^/]+)\/app-api-message-preparations\/([^/]+)\/commit$/);
  if (!match) return false;
  res.setHeader?.('Cache-Control', 'private, no-store');
  try {
    if (authSession?.role !== 'owner' ||
        (authSession.principalKind && !['owner', 'trusted_device'].includes(authSession.principalKind)))
      throw sessionApiError('PERMISSION_DENIED', 403, 'Owner conditional message access is required');
    if (parsedUrl?.searchParams?.size || parsedUrl?.search || Object.keys(parsedUrl?.query || {}).length)
      throw sessionApiError('INVALID_ARGUMENT', 400, 'Message commit query parameters are unsupported');
    if (!['GET', 'POST'].includes(req.method)) {
      res.setHeader?.('Allow', 'GET, POST');
      throw sessionApiError('METHOD_NOT_ALLOWED', 405, 'Unsupported message commit method');
    }
    const sessionId = sessionApiIdentifier(decodeURIComponent(match[1]), 256);
    const requestId = sessionApiIdentifier(decodeURIComponent(match[2]));
    const scope = readSessionApiScopeHeader(req, sessionId);
    if (!scope) throw sessionApiError('INVALID_ARGUMENT', 400, 'The original Session scope header is required');
    if (!await requireSessionAccess(res, authSession, sessionId, { metadataOnly: true })) return true;
    const result = req.method === 'GET'
      ? await readSessionApiMessageCommit(sessionId, scope, requestId)
      : await commitSessionApiMessage(sessionId, scope, requestId, await readPreparationBody(req, 4096),
        authSession.principalKind || 'owner', { authSession, ownerDevice: process.platform === 'win32' ? authenticatedOwnerDeviceDescriptor(authSession) : null });
    // Persistence precedes both continuation and reply. GET never resumes execution.
    if (req.method === 'POST' && result.accepted && result.runId) scheduleScopedMessageRun(sessionId, result.runId);
    writeJson(res, 200, result);
  } catch (error) {
    req.resume?.();
    const encoding = error instanceof URIError;
    const known = ERRORS.has(error?.code) && Number.isInteger(error.statusCode);
    writeJson(res, encoding ? 400 : known ? error.statusCode : 503, {
      code: encoding ? 'INVALID_ARGUMENT' : known ? error.code : 'MESSAGE_COMMIT_UNAVAILABLE',
      error: encoding ? 'Invalid message identity encoding' : known ? error.message : 'Message commit is unavailable' });
  }
  return true;
}
