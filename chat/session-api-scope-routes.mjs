import { SESSION_API_SCOPE_HEADER, SESSION_API_SCOPE_HEADER_BYTES } from './session-api-scope-contract.mjs';

/** Discover support before sending a condition an older PC would ignore. */
export async function handleSessionApiScopeRoutes({ req, res, pathname, parsedUrl, authSession, writeJson }) {
  if (pathname !== '/api/session-scope-contract') return false;
  res.setHeader?.('Cache-Control', 'private, no-store');
  if (authSession?.role !== 'owner' ||
      (authSession.principalKind && !['owner', 'trusted_device'].includes(authSession.principalKind))) {
    writeJson(res, 403, { code: 'PERMISSION_DENIED', error: 'Owner conditional access is required' });
  } else if (req.method !== 'GET') {
    res.setHeader?.('Allow', 'GET');
    writeJson(res, 405, { code: 'METHOD_NOT_ALLOWED', error: 'Unsupported scope contract method' });
  } else if (parsedUrl?.searchParams?.size || parsedUrl?.search || Object.keys(parsedUrl?.query || {}).length) {
    writeJson(res, 400, { code: 'INVALID_ARGUMENT', error: 'Scope contract query parameters are unsupported' });
  } else {
    writeJson(res, 200, { version: 1, header: SESSION_API_SCOPE_HEADER, encoding: 'base64url-utf8-json',
      maxHeaderBytes: SESSION_API_SCOPE_HEADER_BYTES, maxDecodedBytes: 2048,
      contextPath: '/api/sessions/{sessionId}/app-api-context',
      fields: ['version', 'sessionId', 'expectedScopeRevision', 'expectedProjectId'],
      effects: [{ id: 'run.cancel', method: 'POST', path: '/api/runs/{runId}/cancel',
        cancellationRequestedIsTerminal: false },
      { id: 'asset.upload.intent', method: 'POST', path: '/api/assets/upload-intents' },
      { id: 'asset.upload.body', method: 'POST', path: '/api/assets/{assetId}/upload', stagedBeforeGuard: true },
      { id: 'asset.upload.chunk', method: 'PATCH', path: '/api/assets/{assetId}/upload' },
      { id: 'asset.upload.checkpoint', method: 'GET', path: '/api/assets/{assetId}/upload-checkpoint', readonly: true },
      { id: 'asset.upload.finalize', method: 'POST', path: '/api/assets/{assetId}/finalize', verifiedBeforeGuard: true },
      { id: 'asset.upload.receipt', method: 'GET', path: '/api/assets/upload-intents?sessionId={sessionId}&requestId={requestId}', readonly: true },
      { id: 'message.prepare', method: 'POST', path: '/api/sessions/{sessionId}/app-api-message-preparations', startsRun: false },
      { id: 'message.preparation.receipt', method: 'GET', path: '/api/sessions/{sessionId}/app-api-message-preparations/{requestId}', readonly: true },
      { id: 'message.commit', method: 'POST', path: '/api/sessions/{sessionId}/app-api-message-preparations/{requestId}/commit', durableQueue: true },
      { id: 'message.commit.receipt', method: 'GET', path: '/api/sessions/{sessionId}/app-api-message-preparations/{requestId}/commit', readonly: true }] });
  }
  return true;
}
