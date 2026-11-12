import { createHash } from 'node:crypto';
import { parseSessionApiScope } from './session-api-scope-contract.mjs';
import { sessionApiError, sessionApiIdentifier } from './session-api-mutation-contract.mjs';
import { MAX_STABLE_UPLOAD_BYTES } from './file-asset-upload-checkpoints.mjs';

export const MESSAGE_PREPARATION_LIMIT = 64;
export const MESSAGE_PREPARATION_TEXT_BYTES = 64 * 1024;
export const MESSAGE_PREPARATION_BODY_BYTES = 128 * 1024;
export const MESSAGE_PREPARATION_OPTION_KEYS = Object.freeze([
  'tool', 'model', 'effort', 'serviceTier', 'providerProfile', 'uiLanguage',
  'interactionMode', 'permissionMode', 'templateId', 'planAction', 'planId',
  'thinking', 'freshThread', 'browserMcpEnabled',
]);
const BOOLEAN_OPTIONS = new Set(['thinking', 'freshThread', 'browserMcpEnabled']);
const HASH = /^[a-f0-9]{64}$/;
const PREPARATION_ID = /^mprep_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

function keys(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !allowed.includes(key)))
    throw sessionApiError('INVALID_ARGUMENT', 400, 'Unsupported message preparation fields');
}
export function parseMessagePreparation(value, { maximumFileBytes = MAX_STABLE_UPLOAD_BYTES,
  maximumTotalBytes = 100 * 1024 * 1024 } = {}) {
  keys(value, ['version', 'requestId', 'text', 'attachments', 'runOptions', 'expiresAt']);
  if (value.version !== 1 || typeof value.text !== 'string' || !value.text.trim() ||
      Buffer.byteLength(value.text, 'utf8') > MESSAGE_PREPARATION_TEXT_BYTES || value.text.includes('\0') ||
      Buffer.from(value.text, 'utf8').toString('utf8') !== value.text)
    throw sessionApiError('INVALID_ARGUMENT', 400, 'Invalid prepared message text or version');
  sessionApiIdentifier(value.requestId);
  if (value.requestId !== value.requestId.trim())
    throw sessionApiError('INVALID_ARGUMENT', 400, 'Message identity must be canonical');
  if (typeof value.expiresAt !== 'string' || value.expiresAt.length > 32 || !Number.isFinite(Date.parse(value.expiresAt)) ||
      new Date(value.expiresAt).toISOString() !== value.expiresAt)
    throw sessionApiError('INVALID_ARGUMENT', 400, 'A canonical UTC preparation expiry is required');
  const runOptions = {};
  const rawOptions = value.runOptions === undefined ? {} : value.runOptions;
  keys(rawOptions, MESSAGE_PREPARATION_OPTION_KEYS);
  for (const key of [...MESSAGE_PREPARATION_OPTION_KEYS].sort()) {
    if (!Object.hasOwn(rawOptions, key)) continue;
    const input = rawOptions[key];
    if (BOOLEAN_OPTIONS.has(key)) {
      if (typeof input !== 'boolean') throw sessionApiError('INVALID_ARGUMENT', 400, 'Invalid boolean Run option');
    } else if (typeof input !== 'string' || !input.trim() || input !== input.trim() || input.length > 256 || /[\x00-\x1f\x7f]/.test(input)) {
      throw sessionApiError('INVALID_ARGUMENT', 400, 'Invalid Run option');
    }
    if ((key === 'interactionMode' && !['agent', 'plan'].includes(input)) ||
        (key === 'planAction' && !['revise', 'execute'].includes(input)))
      throw sessionApiError('INVALID_ARGUMENT', 400, 'Unsupported Run mode');
    runOptions[key] = input;
  }
  const rawAttachments = value.attachments === undefined ? [] : value.attachments;
  if (!Array.isArray(rawAttachments) || rawAttachments.length > 16)
    throw sessionApiError('INVALID_ARGUMENT', 400, 'Too many prepared attachments');
  const ids = new Set();
  let bytes = 0;
  const attachments = rawAttachments.map(input => {
    keys(input, ['assetId', 'sha256', 'sizeBytes', 'renderAs']);
    if (typeof input.assetId !== 'string' || !/^fasset_[a-f0-9]{24}$/.test(input.assetId) || ids.has(input.assetId) ||
        typeof input.sha256 !== 'string' || !HASH.test(input.sha256) || !Number.isSafeInteger(input.sizeBytes) ||
        input.sizeBytes < 1 || input.sizeBytes > maximumFileBytes)
      throw sessionApiError('INVALID_ARGUMENT', 400, 'Invalid prepared attachment');
    if (Object.hasOwn(input, 'renderAs') && input.renderAs !== 'file')
      throw sessionApiError('INVALID_ARGUMENT', 400, 'Invalid prepared attachment rendering');
    ids.add(input.assetId); bytes += input.sizeBytes;
    if (!Number.isSafeInteger(bytes)) throw sessionApiError('INVALID_ARGUMENT', 400, 'Prepared attachment total is too large');
    return { assetId: input.assetId, sha256: input.sha256, sizeBytes: input.sizeBytes,
      ...(Object.hasOwn(input, 'renderAs') ? { renderAs: input.renderAs } : {}) };
  });
  if (bytes > maximumTotalBytes) throw sessionApiError('INVALID_ARGUMENT', 400, 'Prepared attachment total is too large');
  return { version: 1, requestId: value.requestId, text: value.text,
    attachments, runOptions, expiresAt: value.expiresAt };
}
export function messagePreparationFingerprint(sessionId, scope, request) {
  return createHash('sha256').update(JSON.stringify([sessionId, parseSessionApiScope(scope, sessionId),
    parseMessagePreparation(request, { maximumFileBytes: Number.MAX_SAFE_INTEGER,
      maximumTotalBytes: Number.MAX_SAFE_INTEGER })])).digest('hex');
}

/** Private records are validated, never normalized away or evicted for a new identity. */
export function messagePreparations(meta) {
  if (!Object.hasOwn(meta, 'appApiMessagePreparations')) return [];
  const rows = meta.appApiMessagePreparations;
  try {
    if (!Array.isArray(rows) || rows.length > MESSAGE_PREPARATION_LIMIT) throw new Error();
    const requests = new Set(); const preparations = new Set();
    for (const row of rows) {
      keys(row, ['version', 'preparationId', 'sessionId', 'requestId', 'scope', 'request', 'fingerprint', 'createdAt']);
      const scope = parseSessionApiScope(row.scope, meta.id);
      const request = parseMessagePreparation(row.request, { maximumFileBytes: Number.MAX_SAFE_INTEGER,
        maximumTotalBytes: Number.MAX_SAFE_INTEGER });
      if (row.version !== 1 || row.sessionId !== meta.id || row.requestId !== request.requestId ||
          !PREPARATION_ID.test(row.preparationId) || requests.has(row.requestId) || preparations.has(row.preparationId) ||
          typeof row.fingerprint !== 'string' || !HASH.test(row.fingerprint) ||
          row.fingerprint !== messagePreparationFingerprint(meta.id, scope, request) ||
          typeof row.createdAt !== 'string' || !Number.isFinite(Date.parse(row.createdAt)) ||
          new Date(row.createdAt).toISOString() !== row.createdAt || Date.parse(row.createdAt) >= Date.parse(request.expiresAt))
        throw new Error();
      requests.add(row.requestId); preparations.add(row.preparationId);
    }
  } catch {
    throw sessionApiError('MESSAGE_PREPARATION_STORE_INVALID', 503, 'Message preparation storage is unavailable');
  }
  return structuredClone(rows);
}

export function projectMessagePreparation(record, { duplicate = false, now = Date.now() } = {}) {
  return { version: 1, sessionId: record.sessionId, requestId: record.requestId,
    preparationId: record.preparationId, state: Date.parse(record.request.expiresAt) <= now ? 'expired' : 'prepared',
    duplicate, createdAt: record.createdAt, expiresAt: record.request.expiresAt,
    accepted: false, dispatched: false };
}
