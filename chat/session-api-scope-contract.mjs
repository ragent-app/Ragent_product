import { sessionApiError, sessionApiIdentifier, sessionApiProject } from './session-api-mutation-contract.mjs';

export const SESSION_API_SCOPE_HEADER = 'x-ragent-app-api-scope';
export const SESSION_API_SCOPE_HEADER_BYTES = 4096;
const revision = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** A concurrency condition, never a replacement for the authenticated PC principal. */
export function parseSessionApiScope(input, sessionId) {
  sessionApiIdentifier(sessionId, 256);
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !['version', 'sessionId', 'expectedScopeRevision', 'expectedProjectId'].includes(key)) ||
      input.version !== 1 || input.sessionId !== sessionId ||
      typeof input.expectedScopeRevision !== 'string' || !revision.test(input.expectedScopeRevision) ||
      !Object.hasOwn(input, 'expectedProjectId'))
    throw sessionApiError('INVALID_ARGUMENT', 400, 'Invalid Session scope condition');
  if (input.expectedProjectId !== null) sessionApiIdentifier(input.expectedProjectId, 256);
  return Object.freeze({ version: 1, sessionId, expectedScopeRevision: input.expectedScopeRevision,
    expectedProjectId: input.expectedProjectId });
}

export function readSessionApiScopeHeader(req, sessionId) {
  const value = req.headers?.[SESSION_API_SCOPE_HEADER];
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length > SESSION_API_SCOPE_HEADER_BYTES || !/^[A-Za-z0-9_-]+$/.test(value))
    throw sessionApiError('INVALID_ARGUMENT', 400, 'Invalid Session scope header');
  let input;
  try {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value || bytes.length > 2048) throw new Error();
    input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  }
  catch { throw sessionApiError('INVALID_ARGUMENT', 400, 'Invalid Session scope header'); }
  return parseSessionApiScope(input, sessionId);
}

export function assertSessionApiScope(meta, scope) {
  if (!meta || meta.id !== scope.sessionId)
    throw sessionApiError('RESOURCE_NOT_FOUND', 404, 'Session is unavailable');
  if (meta.appApiScopeRevision !== scope.expectedScopeRevision || sessionApiProject(meta) !== scope.expectedProjectId)
    throw sessionApiError('REVISION_CONFLICT', 409, 'Session resource scope changed');
}
