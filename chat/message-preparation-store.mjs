import { randomUUID } from 'node:crypto';
import { findSessionMeta, readSessionMessagePreparations, mutateScopedSessionMetaDurably, withSessionApiScope } from './session-meta-store.mjs';
import { sessionApiError, sessionApiIdentifier } from './session-api-mutation-contract.mjs';
import { parseSessionApiScope } from './session-api-scope-contract.mjs';
import { MESSAGE_PREPARATION_LIMIT, messagePreparations,
  messagePreparationFingerprint, projectMessagePreparation } from './message-preparation-contract.mjs';
import { withMessageRequestIdentity } from './message-request-identity.mjs';
import { getFileAsset, findFileAssetUploadReceipt } from './file-assets.mjs';
import { requireUploadScope } from './file-asset-scope.mjs';
import { findRunByRequest } from './runs.mjs';
import { withoutMessageExecution } from './message-execution-context.mjs';
import { authorizeMessageAttachmentSizes } from './message-attachment-account-policy.mjs';

export async function assertNoMessagePreparationReuse(sessionId, requestId) {
  if ((await readSessionMessagePreparations(sessionId)).some(row => row.requestId === requestId))
    throw sessionApiError('MESSAGE_PREPARATION_REQUIRED', 409, 'Use the prepared message commit protocol; ordinary ingress cannot reuse this identity');
}

export async function validatePreparedMessageAttachments(sessionId, scope, attachments) {
  // Asset receipt verification opens its own scoped read. The Run's message
  // execution context is configuration, not a parent Session transaction;
  // inheriting it here would open a nested scope effect and reject the Run.
  return withoutMessageExecution(async () => {
    for (const attachment of attachments) {
      const asset = await getFileAsset(attachment.assetId);
      if (!asset || asset.sessionId !== sessionId || asset.status !== 'ready' ||
          asset.sha256 !== attachment.sha256 || asset.sizeBytes !== attachment.sizeBytes)
        throw sessionApiError('MESSAGE_ATTACHMENT_CONFLICT', 409, 'Prepared attachment is unavailable or changed');
      if (!asset.uploadRequest?.scopeVersion)
        throw sessionApiError('CAPABILITY_UNSUPPORTED', 409, 'Prepared messages require scoped upload receipts');
      requireUploadScope(asset, scope);
      // Validate the retained immutable upload identity and fingerprint. This
      // readonly path returns no external credentials and holds no stream lock.
      const receipt = await findFileAssetUploadReceipt({ sessionId, requestId: asset.uploadRequest.key,
        principalScope: asset.uploadRequest.principalScope, scopeCondition: scope });
      if (!receipt || receipt.asset.id !== attachment.assetId || receipt.asset.status !== 'ready' ||
          receipt.asset.sha256 !== attachment.sha256 || receipt.asset.sizeBytes !== attachment.sizeBytes)
        throw sessionApiError('MESSAGE_ATTACHMENT_CONFLICT', 409, 'Prepared attachment receipt is unavailable');
    }
  });
}

export async function prepareSessionApiMessage(sessionId, scopeInput, payload, { authorize, authSession } = {}) {
  sessionApiIdentifier(sessionId, 256);
  const scope = parseSessionApiScope(scopeInput, sessionId);
  const request = await authorizeMessageAttachmentSizes(payload, authSession);
  const fingerprint = messagePreparationFingerprint(sessionId, scope, request);
  return withMessageRequestIdentity(sessionId, request.requestId, async () => {
    const existingRun = await findRunByRequest(sessionId, request.requestId);
    const replay = await withSessionApiScope(sessionId, scope, async () => {
      const meta = await findSessionMeta(sessionId);
      await authorize?.(meta);
      const existing = messagePreparations(meta).find(row => row.requestId === request.requestId);
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw sessionApiError('MESSAGE_IDEMPOTENCY_CONFLICT', 409, 'Message identity has different frozen facts');
        return projectMessagePreparation(existing, { duplicate: true });
      }
      if (existingRun ||
          [...(meta.followUpQueue || []), ...(meta.pendingPlanningQueue || [])].some(row => row.requestId === request.requestId) ||
          (meta.recentFollowUpRequestIds || []).includes(request.requestId))
        throw sessionApiError('MESSAGE_IDEMPOTENCY_CONFLICT', 409, 'Message identity was already used by ordinary ingress');
      return null;
    });
    if (replay) return replay;
    const now = Date.now();
    if (Date.parse(request.expiresAt) <= now)
      throw sessionApiError('REQUEST_EXPIRED', 410, 'Message preparation has expired');
    if (Date.parse(request.expiresAt) > now + 24 * 60 * 60 * 1000)
      throw sessionApiError('INVALID_ARGUMENT', 400, 'Message preparation lifetime exceeds 24 hours');
    // Attachment reads/validation occur outside the metadata transaction.
    // Final publication checks scope again; no Run or user event is created.
    await validatePreparedMessageAttachments(sessionId, scope, request.attachments);
    return withSessionApiScope(sessionId, scope, async () => {
      await authorize?.(await findSessionMeta(sessionId));
      const record = { version: 1, preparationId: 'mprep_' + randomUUID(), sessionId,
        requestId: request.requestId, scope, request, fingerprint, createdAt: new Date().toISOString() };
      if (Date.parse(record.createdAt) >= Date.parse(request.expiresAt))
        throw sessionApiError('REQUEST_EXPIRED', 410, 'Message preparation expired before publication');
      await mutateScopedSessionMetaDurably(sessionId, draft => {
        const rows = messagePreparations(draft);
        if (rows.length >= MESSAGE_PREPARATION_LIMIT)
          throw sessionApiError('RESOURCE_LIMIT', 429, 'Retained message preparation limit reached');
        draft.appApiMessagePreparations = [...rows, record];
        return true;
      });
      return projectMessagePreparation(record);
    });
  });
}

export async function readSessionApiMessagePreparation(sessionId, requestId, scopeInput, { authorize } = {}) {
  sessionApiIdentifier(requestId);
  const scope = parseSessionApiScope(scopeInput, sessionId);
  return withSessionApiScope(sessionId, scope, async () => {
    const meta = await findSessionMeta(sessionId);
    await authorize?.(meta);
    const record = messagePreparations(meta).find(row => row.requestId === requestId);
    if (!record) throw sessionApiError('RESOURCE_NOT_FOUND', 404, 'Message preparation is unavailable');
    if (JSON.stringify(record.scope) !== JSON.stringify(scope))
      throw sessionApiError('MESSAGE_IDEMPOTENCY_CONFLICT', 409, 'Message preparation has a different original scope');
    return projectMessagePreparation(record);
  });
}
