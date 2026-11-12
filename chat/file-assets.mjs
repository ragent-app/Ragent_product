import { createHash, createHmac, randomBytes } from 'crypto';
import { createReadStream, createWriteStream } from 'fs';
import { basename, extname, isAbsolute, join, relative, resolve } from 'path';
import { copyFile, link, rename, open, readdir } from 'fs/promises';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import {
  CHAT_FILE_ASSETS_DIR,
  CHAT_FILE_ASSET_CACHE_DIR,
  FILE_ASSET_DIRECT_UPLOAD_ENABLED,
  FILE_ASSET_PUBLIC_BASE_URL,
  FILE_ASSET_STORAGE_ACCESS_KEY_ID,
  FILE_ASSET_STORAGE_BASE_URL,
  FILE_ASSET_STORAGE_ENABLED,
  FILE_ASSET_STORAGE_KEY_PREFIX,
  FILE_ASSET_STORAGE_PRESIGN_TTL_SECONDS,
  FILE_ASSET_STORAGE_PROVIDER,
  FILE_ASSET_STORAGE_REGION,
  FILE_ASSET_STORAGE_SECRET_ACCESS_KEY,
} from '../lib/config.mjs';
import {
  createSerialTaskQueue,
  createKeyedTaskQueue,
  ensureDir,
  pathExists,
  readJson,
  readJsonStrict,
  removePath,
  statOrNull,
  writeJsonAtomic,
} from './fs-utils.mjs';
import { parseUploadScope, storedUploadScope, withUploadScope } from './file-asset-scope.mjs';
import { assertOutsideSessionMetaTransaction } from './session-meta-store.mjs';
import { FileAssetUploadCheckpoints, MAX_STABLE_UPLOAD_BYTES, RESUMABLE_UPLOAD_CONTRACT,
  RESUMABLE_UPLOAD_BATCH_CONTRACT, UPLOAD_BATCH_BYTES, uploadChunkBytes } from './file-asset-upload-checkpoints.mjs';

const FILE_ASSET_ID_PATTERN = /^fasset_[a-f0-9]{24}$/;
const runFileAssetMutation = createSerialTaskQueue();
const runUploadMutation = createKeyedTaskQueue();
const CHAT_FILE_ASSET_OBJECTS_DIR = join(CHAT_FILE_ASSETS_DIR, 'objects');
const uploadCheckpoints = new FileAssetUploadCheckpoints(join(CHAT_FILE_ASSETS_DIR, 'upload-checkpoints'));
const FILE_ASSET_LOCALIZE_RETRY_DELAYS_MS = Object.freeze([250, 750, 1500]);
const FILE_ASSET_MATERIALIZE_CONCURRENCY = 4;
const fileAssetLocalizationInflight = new Map();
const STORAGE_SIGNING_PROFILES = Object.freeze({
  s3: Object.freeze({
    algorithm: 'AWS4-HMAC-SHA256',
    queryAlgorithmKey: 'X-Amz-Algorithm',
    queryCredentialKey: 'X-Amz-Credential',
    queryDateKey: 'X-Amz-Date',
    queryExpiresKey: 'X-Amz-Expires',
    querySignatureKey: 'X-Amz-Signature',
    querySignedHeadersKey: 'X-Amz-SignedHeaders',
    service: 's3',
    requestTerminator: 'aws4_request',
    secretPrefix: 'AWS4',
  }),
  tos: Object.freeze({
    algorithm: 'TOS4-HMAC-SHA256',
    queryAlgorithmKey: 'X-Tos-Algorithm',
    queryCredentialKey: 'X-Tos-Credential',
    queryDateKey: 'X-Tos-Date',
    queryExpiresKey: 'X-Tos-Expires',
    querySignatureKey: 'X-Tos-Signature',
    querySignedHeadersKey: 'X-Tos-SignedHeaders',
    service: 'tos',
    requestTerminator: 'request',
    secretPrefix: '',
  }),
});

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mapWithFileAssetConcurrency(items, mapper) {
  const list = Array.isArray(items) ? items : [];
  if (list.length <= 1) return Promise.all(list.map(mapper));
  const results = new Array(list.length);
  let cursor = 0;
  const workers = Array.from({
    length: Math.min(FILE_ASSET_MATERIALIZE_CONCURRENCY, list.length),
  }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= list.length) return;
      results[index] = await mapper(list[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeMimeType(value) {
  return normalizeString(value).toLowerCase() || 'application/octet-stream';
}

function normalizePositiveInteger(value) {
  const numeric = Number.parseInt(String(value || ''), 10);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function createError(message, code, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function sanitizeFilename(value, fallback = 'attachment') {
  const candidate = basename(normalizeString(value) || fallback)
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  return candidate.slice(0, 120) || fallback;
}

function sanitizeDisplayName(value, fallback = 'attachment') {
  const candidate = basename(normalizeString(value).replace(/\\/g, '/')) || fallback;
  return candidate.replace(/\s+/g, ' ').slice(0, 255) || fallback;
}

function buildAsciiFilenameFallback(value, fallback = 'attachment') {
  const displayName = sanitizeDisplayName(value, fallback);
  const extension = extname(displayName).toLowerCase();
  const safeExtension = /^\.[a-z0-9]+$/.test(extension) ? extension : '';
  const stemSource = safeExtension ? displayName.slice(0, -safeExtension.length) : displayName;
  const safeStem = stemSource
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^\.+/, '')
    .slice(0, 120);
  const stem = safeStem || fallback;
  return `${stem}${safeExtension}`.slice(0, 120) || fallback;
}

function escapeContentDispositionFilename(value) {
  return String(value || '').replace(/["\\]/g, '\\$&');
}

export function buildAttachmentContentDisposition(value, { attachment = false, fallback = 'attachment' } = {}) {
  const displayName = sanitizeDisplayName(value, fallback);
  const asciiFallback = buildAsciiFilenameFallback(displayName, fallback);
  const dispositionType = attachment ? 'attachment' : 'inline';
  return `${dispositionType}; filename="${escapeContentDispositionFilename(asciiFallback)}"; filename*=UTF-8''${encodeRfc3986(displayName)}`;
}

function sanitizeScopeSegment(value, fallback = 'session') {
  const candidate = normalizeString(value)
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  return candidate.slice(0, 80) || fallback;
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function encodeRfc3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function sha256File(filepath) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(filepath), async function* (source) {
    for await (const chunk of source) hash.update(chunk);
  });
  return hash.digest('hex');
}

function hmacDigest(key, value) {
  return createHmac('sha256', key).update(value).digest();
}

function getStorageSigningProfile() {
  return STORAGE_SIGNING_PROFILES[FILE_ASSET_STORAGE_PROVIDER] || STORAGE_SIGNING_PROFILES.s3;
}

function buildSigningKey(shortDate, profile = getStorageSigningProfile()) {
  const kDate = hmacDigest(`${profile.secretPrefix}${FILE_ASSET_STORAGE_SECRET_ACCESS_KEY}`, shortDate);
  const kRegion = hmacDigest(kDate, FILE_ASSET_STORAGE_REGION);
  const kService = hmacDigest(kRegion, profile.service);
  return hmacDigest(kService, profile.requestTerminator);
}

function formatAmzDate(date = new Date()) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

function canonicalUri(url) {
  const segments = url.pathname.split('/').map((segment) => encodeRfc3986(safeDecodeURIComponent(segment)));
  return segments.join('/') || '/';
}

function canonicalQuery(entries) {
  return [...entries]
    .map(([key, value]) => [encodeRfc3986(key), encodeRfc3986(value)])
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => {
      if (leftKey < rightKey) return -1;
      if (leftKey > rightKey) return 1;
      if (leftValue < rightValue) return -1;
      if (leftValue > rightValue) return 1;
      return 0;
    })
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

function requireFileAssetStorageEnabled() {
  if (FILE_ASSET_STORAGE_ENABLED) return;
  throw createError('File asset storage is not configured', 'FILE_ASSET_STORAGE_DISABLED', 503);
}

function isValidFileAssetId(id) {
  return typeof id === 'string' && FILE_ASSET_ID_PATTERN.test(id);
}

function generateFileAssetId() {
  return `fasset_${randomBytes(12).toString('hex')}`;
}

function fileAssetPath(id) {
  return join(CHAT_FILE_ASSETS_DIR, `${id}.json`);
}

function buildLocalObjectFilename(assetId, originalName) {
  const originalExtension = extname(originalName || '').toLowerCase();
  if (/^\.[a-z0-9]+$/.test(originalExtension)) {
    return `${assetId}${originalExtension}`;
  }
  return `${assetId}.bin`;
}

function resolveLocalObjectPath(record) {
  const localFilename = normalizeString(record?.storage?.localFilename)
    || buildLocalObjectFilename(record?.id || generateFileAssetId(), record?.originalName || 'attachment');
  const root = resolve(CHAT_FILE_ASSET_OBJECTS_DIR);
  const candidate = resolve(root, localFilename);
  const relativePath = relative(root, candidate);
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw createError('File asset local object path escapes the object store', 'FILE_ASSET_LOCAL_PATH_ESCAPE', 409);
  }
  return candidate;
}

function buildObjectKey(sessionId, assetId, originalName) {
  const now = new Date();
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  const sessionSegment = sanitizeScopeSegment(sessionId, 'session');
  const filename = sanitizeDisplayName(originalName, 'attachment');
  const prefix = FILE_ASSET_STORAGE_KEY_PREFIX ? `${FILE_ASSET_STORAGE_KEY_PREFIX}/` : '';
  return `${prefix}${sessionSegment}/${year}/${month}/${day}/${assetId}/${filename}`;
}

function buildStorageObjectUrl(baseUrl, objectKey) {
  const url = new URL(baseUrl);
  const normalizedBasePath = url.pathname.replace(/\/+$/, '');
  const encodedKey = objectKey.split('/').filter(Boolean).map((segment) => encodeRfc3986(segment)).join('/');
  url.pathname = `${normalizedBasePath}/${encodedKey}`;
  url.hash = '';
  url.search = '';
  return url.toString();
}

function presignStorageRequest(method, objectUrl, expiresInSeconds = FILE_ASSET_STORAGE_PRESIGN_TTL_SECONDS, additionalHeaders = {}) {
  requireFileAssetStorageEnabled();

  const signingProfile = getStorageSigningProfile();
  const url = new URL(objectUrl);
  const issuedAt = new Date();
  const amzDate = formatAmzDate(issuedAt);
  const shortDate = amzDate.slice(0, 8);
  const credentialScope = `${shortDate}/${FILE_ASSET_STORAGE_REGION}/${signingProfile.service}/${signingProfile.requestTerminator}`;

  const headersToSign = { host: url.host };
  for (const [key, value] of Object.entries(additionalHeaders)) {
    headersToSign[key.toLowerCase()] = String(value).trim();
  }
  const sortedHeaderNames = Object.keys(headersToSign).sort();
  const signedHeadersValue = sortedHeaderNames.join(';');

  const query = new URLSearchParams(url.search);
  query.set(signingProfile.queryAlgorithmKey, signingProfile.algorithm);
  query.set(signingProfile.queryCredentialKey, `${FILE_ASSET_STORAGE_ACCESS_KEY_ID}/${credentialScope}`);
  query.set(signingProfile.queryDateKey, amzDate);
  query.set(signingProfile.queryExpiresKey, String(expiresInSeconds));
  query.set(signingProfile.querySignedHeadersKey, signedHeadersValue);

  const canonicalHeaders = sortedHeaderNames
    .map((name) => `${name}:${headersToSign[name]}`)
    .join('\n') + '\n';

  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri(url),
    canonicalQuery(query.entries()),
    canonicalHeaders,
    signedHeadersValue,
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [
    signingProfile.algorithm,
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const signature = createHmac('sha256', buildSigningKey(shortDate, signingProfile))
    .update(stringToSign)
    .digest('hex');

  query.set(signingProfile.querySignatureKey, signature);
  url.search = canonicalQuery(query.entries());

  return {
    url: url.toString(),
    expiresAt: new Date(issuedAt.getTime() + expiresInSeconds * 1000).toISOString(),
  };
}

function normalizeFileAssetRecord(record) {
  if (!(record && typeof record === 'object')) return null;
  const id = normalizeString(record.id);
  if (!isValidFileAssetId(id)) return null;
  const sessionId = normalizeString(record.sessionId);
  const storageProvider = normalizeString(record?.storage?.provider) || 's3-compatible';
  return {
    id,
    sessionId,
    status: normalizeString(record.status) || 'pending_upload',
    createdAt: normalizeString(record.createdAt) || nowIso(),
    updatedAt: normalizeString(record.updatedAt) || nowIso(),
    createdBy: normalizeString(record.createdBy) || 'owner',
    originalName: sanitizeDisplayName(record.originalName || 'attachment'),
    mimeType: normalizeMimeType(record.mimeType),
    sizeBytes: normalizePositiveInteger(record.sizeBytes),
    // Preserve a non-empty malformed digest so the staging gate can reject it
    // as an invalid server descriptor instead of treating it as absent.
    sha256: normalizeString(record.sha256).toLowerCase(),
    etag: normalizeString(record.etag),
    storage: {
      provider: storageProvider === 'local' ? 'local' : 's3-compatible',
      objectKey: normalizeString(record?.storage?.objectKey),
      localFilename: normalizeString(record?.storage?.localFilename),
    },
    localizedPath: normalizeString(record.localizedPath),
    localizedAt: normalizeString(record.localizedAt),
    uploadCompletedAt: normalizeString(record.uploadCompletedAt),
    uploadRequest: record.uploadRequest ? {
      ...record.uploadRequest,
      quotaBatchId: normalizeString(record.uploadRequest.quotaBatchId) || normalizeString(record.uploadRequest.key),
    } : null,
  };
}

async function mutateFileAsset(id, mutator, options = {}) {
  if (!isValidFileAssetId(id)) return null;
  return runFileAssetMutation(async () => {
    const current = Object.hasOwn(options, 'scopeCondition') ? await readUploadAsset(id) : await getFileAsset(id);
    if (!current) return null;
    const publish = async () => {
      const draft = JSON.parse(JSON.stringify(current));
      const changed = await mutator(draft);
      if (changed === false) return current;
      draft.updatedAt = nowIso();
      await ensureDir(CHAT_FILE_ASSETS_DIR);
      await options.authorize?.(current);
      await writeJsonAtomic(fileAssetPath(id), draft, { durable: !!storedUploadScope(current) });
      return normalizeFileAssetRecord(draft);
    };
    // One lock order for upload publication: asset metadata, then Session scope.
    return Object.hasOwn(options, 'scopeCondition') ? withUploadScope(current, options.scopeCondition, publish, options.authorize) : publish();
  });
}

async function reuseLocalizedPath(record) {
  const localizedPath = normalizeString(record?.localizedPath);
  if (!localizedPath) return '';
  if (!await pathExists(localizedPath)) return '';
  return localizedPath;
}

function buildCachedFilename(record) {
  const originalExtension = extname(record?.originalName || '').toLowerCase();
  if (/^\.[a-z0-9]+$/.test(originalExtension)) {
    return `${record.id}${originalExtension}`;
  }
  return `${record.id}.bin`;
}

async function ensureReadyFileAssetRecord(recordOrId) {
  const record = typeof recordOrId === 'string'
    ? await getFileAsset(recordOrId)
    : normalizeFileAssetRecord(recordOrId);
  if (!record) {
    throw createError('File asset not found', 'FILE_ASSET_NOT_FOUND', 404);
  }
  if (record.status !== 'ready') {
    throw createError('File asset is not ready', 'FILE_ASSET_NOT_READY', 409);
  }
  return record;
}

function buildDownloadRoute(assetId, { attachment = false } = {}) {
  return attachment
    ? `/api/assets/${assetId}/download?download=1`
    : `/api/assets/${assetId}/download`;
}

function buildStorageDownloadUrl(baseUrl, record, { attachment = false } = {}) {
  const url = new URL(buildStorageObjectUrl(baseUrl, record.storage.objectKey));
  url.searchParams.set(
    'response-content-disposition',
    buildAttachmentContentDisposition(record.originalName, { attachment }),
  );
  return url.toString();
}

async function buildClientFileAsset(record, { includeDirectUrl = false } = {}) {
  const payload = {
    id: record.id,
    sessionId: record.sessionId,
    status: record.status,
    originalName: record.originalName,
    mimeType: record.mimeType,
    ...(record.sizeBytes ? { sizeBytes: record.sizeBytes } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.sha256 ? { sha256: record.sha256 } : {}),
    downloadUrl: buildDownloadRoute(record.id),
    ...(storedUploadScope(record) ? { scopeContractVersion: 1 } : {}),
  };
  if (includeDirectUrl && record.status === 'ready') {
    const direct = await buildFileAssetDirectUrl(record);
    payload.directUrl = direct.url;
    if (direct.expiresAt) payload.directUrlExpiresAt = direct.expiresAt;
  }
  return payload;
}

export function getFileAssetBootstrapConfig() {
  return {
    enabled: FILE_ASSET_STORAGE_ENABLED,
    directUpload: FILE_ASSET_DIRECT_UPLOAD_ENABLED,
    provider: FILE_ASSET_STORAGE_ENABLED ? FILE_ASSET_STORAGE_PROVIDER : '',
  };
}

export async function getFileAsset(assetId) {
  if (!isValidFileAssetId(assetId)) return null;
  return normalizeFileAssetRecord(await readJson(fileAssetPath(assetId), null));
}

export async function getFileAssetForClient(assetId, options = {}) {
  const record = await getFileAsset(assetId);
  if (!record) return null;
  return buildClientFileAsset(record, options);
}

export async function createFileAssetUploadIntent({
  sessionId,
  originalName,
  mimeType,
  sizeBytes,
  createdBy = 'owner',
  forceLocal = false,
  forceRemote = false,
  requestId,
  quotaBatchId,
  resumableChunkBytes,
  sha256,
  principalScope = 'owner',
  scopeCondition = null,
  authorize,
  budget,
} = {}) {
  assertOutsideSessionMetaTransaction();
  const normalizedSessionId = normalizeString(sessionId);
  if (!normalizedSessionId) {
    throw createError('sessionId is required', 'FILE_ASSET_SESSION_REQUIRED', 400);
  }

  const scope = parseUploadScope(scopeCondition, normalizedSessionId);
  if (scope && requestId === undefined)
    throw createError('Scoped uploads require a stable request identity', 'INVALID_ARGUMENT', 400);
  const uploadRequest = parseUploadRequest({ requestId, quotaBatchId, principalScope, sessionId: normalizedSessionId,
    originalName, mimeType, sizeBytes, sha256, scopeCondition: scope });
  if (uploadRequest && resumableChunkBytes === UPLOAD_BATCH_BYTES) uploadRequest.chunkBytes = UPLOAD_BATCH_BYTES;
  return runFileAssetMutation(async () => {
    const assetId = uploadRequest ? uploadRequest.assetId : generateFileAssetId();
    const existing = uploadRequest ? await readUploadRequestAsset(uploadRequest) : null;
    if (existing) {
      if (existing.uploadRequest.fingerprint !== uploadRequest.fingerprint) {
        throw createError('Upload request was already used with different file metadata', 'FILE_ASSET_IDEMPOTENCY_CONFLICT', 409);
      }
      return withUploadScope(existing, scope, () => buildUploadIntent(existing, true), authorize);
    }
    // Local uploads work without an object store. Explicit remote uploads
    // must still fail closed when their storage is not configured.
    if (forceRemote === true && forceLocal !== true) requireFileAssetStorageEnabled();
    const createdAt = nowIso();
    const record = normalizeFileAssetRecord({
      id: assetId,
      sessionId: normalizedSessionId,
      status: 'pending_upload',
      createdAt,
      updatedAt: createdAt,
      createdBy,
      originalName: sanitizeDisplayName(originalName, 'attachment'),
      mimeType: normalizeMimeType(mimeType),
      sizeBytes: normalizePositiveInteger(sizeBytes),
      sha256: uploadRequest ? normalizeString(sha256).toLowerCase() : '',
      uploadRequest,
      storage: {
        objectKey: buildObjectKey(normalizedSessionId, assetId, originalName),
      },
    });

    await ensureDir(CHAT_FILE_ASSETS_DIR);
    if (budget) {
      if (!uploadRequest || !Number.isSafeInteger(budget.maxFiles) || budget.maxFiles < 1
        || !Number.isSafeInteger(budget.maxBytes) || budget.maxBytes < 1)
        throw createError('Invalid upload budget', 'INVALID_ARGUMENT', 400);
      let count = 0; let bytes = 0;
      for (const name of await readdir(CHAT_FILE_ASSETS_DIR)) {
        if (!/^fasset_[a-f0-9]{24}\.json$/.test(name)) continue;
        const stored = await readJsonStrict(join(CHAT_FILE_ASSETS_DIR, name));
        if (stored?.uploadRequest?.principalScope !== principalScope) continue;
        if (!Number.isSafeInteger(stored.sizeBytes) || stored.sizeBytes < 1)
          throw createError('Upload budget storage is invalid', 'FILE_ASSET_RECEIPT_UNAVAILABLE', 503);
        count++; bytes += stored.sizeBytes;
      }
      if (count >= budget.maxFiles || bytes + record.sizeBytes > budget.maxBytes)
        throw createError('Upload budget exhausted', 'RESOURCE_LIMIT', 429);
    }
    if ((!FILE_ASSET_DIRECT_UPLOAD_ENABLED && forceRemote !== true) || forceLocal === true) {
      const localFilename = buildLocalObjectFilename(assetId, record.originalName);
      record.storage.provider = 'local';
      record.storage.localFilename = localFilename;
    }

    return withUploadScope(record, scope, async () => {
      await writeJsonAtomic(fileAssetPath(assetId), record, { durable: !!scope });
      return buildUploadIntent(record, false);
    }, authorize);
  });
}

async function buildUploadIntent(record, duplicate) {
  const identity = record.uploadRequest ? { uploadContractVersion: 1, duplicate,
    ...(record.storage.provider === 'local' ? { resumableUpload: uploadChunkBytes(record) === UPLOAD_BATCH_BYTES
      ? RESUMABLE_UPLOAD_BATCH_CONTRACT : RESUMABLE_UPLOAD_CONTRACT } : {}) } : {};
  if (record.status === 'ready') {
    return { ...identity, asset: await buildClientFileAsset(record), upload: null };
  }
  if (record.storage.provider === 'local') {
    return {
      ...identity,
      asset: await buildClientFileAsset(record),
      upload: {
        method: 'POST',
        url: `/api/assets/${record.id}/upload`,
        headers: {
          'Content-Type': record.mimeType,
        },
        expiresAt: null,
      },
    };
  }

  const upload = presignStorageRequest(
    'PUT',
    buildStorageObjectUrl(FILE_ASSET_STORAGE_BASE_URL, record.storage.objectKey),
    FILE_ASSET_STORAGE_PRESIGN_TTL_SECONDS,
    { 'content-type': record.mimeType },
  );
  return {
    ...identity,
    asset: await buildClientFileAsset(record),
    upload: {
      method: 'PUT',
      url: upload.url,
      headers: {
        'Content-Type': record.mimeType,
      },
      expiresAt: upload.expiresAt,
    },
  };
}

function parseUploadIdentity({ requestId, principalScope, sessionId }) {
  if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 200
    || typeof principalScope !== 'string' || !principalScope
    || typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 256) {
    throw createError('A bounded upload request identity and authenticated session are required', 'INVALID_ARGUMENT');
  }
  const key = requestId.trim();
  const normalizedSessionId = sessionId.trim();
  return { version: 1, key, principalScope, sessionId: normalizedSessionId,
    assetId: `fasset_${sha256Hex(JSON.stringify(['upload-v1', principalScope, normalizedSessionId, key])).slice(0, 24)}` };
}

function parseUploadRequest(input) {
  if (input.requestId === undefined) return null;
  const identity = parseUploadIdentity(input);
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0 || input.sizeBytes > MAX_STABLE_UPLOAD_BYTES
    || typeof input.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(input.sha256)
    || typeof input.originalName !== 'string' || !input.originalName.trim() || input.originalName.length > 512
    || typeof input.mimeType !== 'string' || input.mimeType.length > 256) {
    throw createError('Stable uploads require a filename, MIME type, SHA-256 and size from 1 byte to 1 GiB', 'INVALID_ARGUMENT');
  }
  const scope = input.scopeCondition;
  const quotaBatchId = typeof input.quotaBatchId === 'string' && input.quotaBatchId.trim()
    ? input.quotaBatchId.trim() : identity.key;
  if (quotaBatchId.length > 200 || /[\r\n]/.test(quotaBatchId)) {
    throw createError('Stable upload quota batch identity is invalid', 'INVALID_ARGUMENT');
  }
  return { ...identity, quotaBatchId, ...(scope ? { scopeVersion: 1, scopeCondition: scope } : {}),
    fingerprint: uploadFingerprint({ originalName: sanitizeDisplayName(input.originalName),
      mimeType: normalizeMimeType(input.mimeType), sizeBytes: input.sizeBytes, sha256: input.sha256.toLowerCase(),
      uploadRequest: scope ? { scopeVersion: 1, scopeCondition: scope } : null, sessionId: identity.sessionId }) };
}

function uploadFingerprint(record) {
  const fields = [record.originalName, record.mimeType, record.sizeBytes, record.sha256];
  const scope = storedUploadScope(record);
  if (scope) fields.push({ scopeVersion: 1, scopeCondition: scope });
  return sha256Hex(JSON.stringify(fields));
}

async function readUploadRequestAsset(identity) {
  let raw;
  try { raw = await readJsonStrict(fileAssetPath(identity.assetId)); }
  catch (error) {
    if (error.code === 'JSON_NOT_FOUND') return null;
    throw createError('Upload receipt could not be read', 'FILE_ASSET_RECEIPT_UNAVAILABLE', 503);
  }
  const record = normalizeFileAssetRecord(raw);
  if (!record || record.id !== identity.assetId || record.sessionId !== identity.sessionId
    || record.uploadRequest?.version !== 1 || record.uploadRequest?.key !== identity.key
    || record.uploadRequest?.principalScope !== identity.principalScope
    || record.uploadRequest?.sessionId !== identity.sessionId || record.uploadRequest?.assetId !== identity.assetId
    || typeof raw.createdAt !== 'string' || !Number.isFinite(Date.parse(raw.createdAt))
    || typeof raw.updatedAt !== 'string' || !Number.isFinite(Date.parse(raw.updatedAt))
    || !Number.isSafeInteger(raw.sizeBytes)
    || !['pending_upload', 'ready'].includes(record.status)
    || !/^[a-f0-9]{64}$/.test(record.sha256)
    || !Number.isSafeInteger(record.sizeBytes) || record.sizeBytes <= 0 || record.sizeBytes > MAX_STABLE_UPLOAD_BYTES
    || record.uploadRequest?.fingerprint !== uploadFingerprint(record)) {
    throw createError('Upload receipt identity is inconsistent', 'FILE_ASSET_RECEIPT_UNAVAILABLE', 503);
  }
  return record;
}

/** Read-only recovery; never creates an asset or issues an upload credential. */
export async function findFileAssetUploadReceipt({ sessionId, requestId, principalScope = 'owner', scopeCondition = null, authorize }) {
  assertOutsideSessionMetaTransaction();
  const record = await readUploadRequestAsset(parseUploadIdentity({ sessionId, requestId, principalScope }));
  return record ? withUploadScope(record, scopeCondition, async () =>
    ({ uploadContractVersion: 1, quotaBatchId: record.uploadRequest?.quotaBatchId || record.uploadRequest?.key,
      asset: await buildClientFileAsset(record) }), authorize) : null;
}

export async function ingestFileAssetUpload(assetId, readableStream, { scopeCondition = null, authorize, signal } = {}) {
  assertOutsideSessionMetaTransaction();
  return runUploadMutation(assetId, () => ingestFileAssetUploadLocked(assetId, readableStream, scopeCondition, authorize, signal));
}

async function checkpointAsset(assetId, scopeCondition, authorize, pending = true) {
  const record = await readUploadAsset(assetId);
  if (!record) throw createError('File asset not found', 'FILE_ASSET_NOT_FOUND', 404);
  await withUploadScope(record, scopeCondition, async () => {}, authorize);
  uploadCheckpoints.paths(record);
  if (pending && record.status !== 'pending_upload')
    throw createError('File asset is not pending upload', 'FILE_ASSET_NOT_PENDING', 409);
  return record;
}

/** Offset is a persisted PC receipt; client progress is never accepted as evidence. */
export async function readFileAssetUploadCheckpoint(assetId, { scopeCondition = null, authorize } = {}) {
  assertOutsideSessionMetaTransaction();
  return runUploadMutation(assetId, async () => {
    const record = await checkpointAsset(assetId, scopeCondition, authorize, false);
    const fence = effect => withUploadScope(record, scopeCondition, effect, authorize);
    if (record.status === 'ready') return fence(() => ({ uploadCheckpointVersion: 1, assetId,
      status: 'ready', offset: record.sizeBytes, totalBytes: record.sizeBytes, sha256: record.sha256,
      chunkBytes: uploadChunkBytes(record), expiresAt: null }));
    return uploadCheckpoints.state(record, fence);
  });
}

export async function appendFileAssetUploadChunk(assetId, readableStream,
  { offset, length, sha256, scopeCondition = null, authorize, signal } = {}) {
  assertOutsideSessionMetaTransaction();
  const closeInput = () => readableStream.destroy();
  signal?.addEventListener('abort', closeInput, { once: true });
  try {
    if (signal?.aborted) { closeInput(); signal.throwIfAborted(); }
    return await runUploadMutation(assetId, async () => {
      signal?.throwIfAborted();
      const record = await checkpointAsset(assetId, scopeCondition, authorize);
      return uploadCheckpoints.append(record, { offset, length, sha256 }, readableStream,
        effect => withUploadScope(record, scopeCondition, effect, authorize), signal);
    });
  } finally { signal?.removeEventListener('abort', closeInput); }
}

export async function cancelFileAssetUploadCheckpoint(assetId, { scopeCondition = null, authorize } = {}) {
  assertOutsideSessionMetaTransaction();
  return runUploadMutation(assetId, async () => {
    const record = await checkpointAsset(assetId, scopeCondition, authorize);
    return uploadCheckpoints.cancel(record, effect => withUploadScope(record, scopeCondition, effect, authorize));
  });
}

async function readUploadAsset(assetId) {
  const record = await getFileAsset(assetId);
  if (record?.uploadRequest) {
    if (record.uploadRequest.assetId !== assetId || record.uploadRequest.sessionId !== record.sessionId)
      throw createError('Upload receipt identity is inconsistent', 'FILE_ASSET_RECEIPT_UNAVAILABLE', 503);
    const strict = await readUploadRequestAsset(record.uploadRequest);
    if (!strict) throw createError('Upload receipt is unavailable', 'FILE_ASSET_RECEIPT_UNAVAILABLE', 503);
    return strict;
  }
  return record;
}

async function ingestFileAssetUploadLocked(assetId, readableStream, scopeCondition, authorize, signal, fromCheckpoint = false) {
  const record = await readUploadAsset(assetId);
  if (!record) {
    throw createError('File asset not found', 'FILE_ASSET_NOT_FOUND', 404);
  }
  if (record.status !== 'pending_upload') {
    throw createError('File asset is not pending upload', 'FILE_ASSET_NOT_PENDING', 409);
  }
  if (record.storage?.provider !== 'local') {
    throw createError('File asset does not accept local uploads', 'FILE_ASSET_UPLOAD_UNSUPPORTED', 409);
  }
  await withUploadScope(record, scopeCondition, async () => {}, authorize);
  if (!fromCheckpoint && record.uploadRequest && await uploadCheckpoints.exists(record))
    throw createError('Resume or cancel the existing chunk upload', 'FILE_ASSET_UPLOAD_MODE_CONFLICT', 409);

  const targetPath = resolveLocalObjectPath(record);
  const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  await ensureDir(CHAT_FILE_ASSET_OBJECTS_DIR);

  try {
    let total = 0;
    const hash = createHash('sha256');
    const gate = new Transform({ transform(chunk, encoding, callback) {
      const accept = () => {
        total += chunk.length;
        if (record.uploadRequest && total > record.sizeBytes) {
          callback(createError('File asset size mismatch', 'FILE_ASSET_SIZE_MISMATCH', 409)); return;
        }
        hash.update(chunk);
        callback(null, chunk);
      };
      if (authorize) Promise.resolve().then(() => authorize(record)).then(accept, callback);
      else accept();
    } });
    await pipeline(readableStream, gate, createWriteStream(tempPath,
      storedUploadScope(record) ? { flags: 'wx', mode: 0o600 } : undefined), ...(signal ? [{ signal }] : []));
    if (record.uploadRequest && total !== record.sizeBytes) {
      throw createError('File asset size mismatch', 'FILE_ASSET_SIZE_MISMATCH', 409);
    }
    if (record.uploadRequest && hash.digest('hex') !== record.sha256) {
      throw createError('File asset hash mismatch', 'FILE_ASSET_HASH_MISMATCH', 409);
    }
    if (storedUploadScope(record)) {
      const staged = await open(tempPath, 'r+');
      try { await staged.sync(); } finally { await staged.close(); }
    }
    return await mutateFileAsset(assetId, async draft => {
      await rename(tempPath, targetPath);
      draft.localizedPath = targetPath;
      draft.localizedAt = nowIso();
      draft.sizeBytes = total;
      return true;
    }, { scopeCondition, authorize });
  } catch (error) {
    await removePath(tempPath).catch(() => {});
    if (error?.name === 'AbortError' || /^temporary_[a-z_]+$/.test(error?.code || '')) throw error;
    if (['FILE_ASSET_SIZE_MISMATCH', 'FILE_ASSET_HASH_MISMATCH', 'REVISION_CONFLICT', 'INVALID_ARGUMENT',
      'FILE_ASSET_IDEMPOTENCY_CONFLICT', 'FILE_ASSET_RECEIPT_UNAVAILABLE',
      'SESSION_MUTATION_STORE_INVALID', 'SESSION_MUTATION_STORE_UNAVAILABLE', 'RESOURCE_NOT_FOUND'].includes(error?.code)) throw error;
    throw createError('Failed to store file asset upload', 'FILE_ASSET_UPLOAD_FAILED', 502);
  }
}

/** Verify a second name for the durable checkpoint, then atomically publish it
 * with the ready receipt. The checkpoint stays available across interruption.
 * Filesystems without hard links retain the verified-copy fallback. */
async function finalizeCheckpointLink(record, { sizeBytes, etag, scopeCondition, authorize }) {
  if (sizeBytes !== undefined && (!Number.isSafeInteger(sizeBytes) || sizeBytes !== record.sizeBytes))
    throw createError('File asset size mismatch', 'FILE_ASSET_SIZE_MISMATCH', 409);
  const normalizedEtag = normalizeString(etag).replace(/^W\//, '').replace(/^"|"$/g, '');
  const targetPath = resolveLocalObjectPath(record);
  const tempPath = `${targetPath}.link-${process.pid}-${randomBytes(8).toString('hex')}`;
  await ensureDir(CHAT_FILE_ASSET_OBJECTS_DIR);
  try {
    try { await link(uploadCheckpoints.paths(record).body, tempPath); }
    catch (error) {
      if (['EXDEV', 'EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EMLINK'].includes(error?.code)) return false;
      throw error;
    }
    const hash = createHash('sha256');
    let total = 0;
    for await (const bytes of createReadStream(tempPath)) {
      await authorize?.(record);
      total += bytes.length;
      if (total > record.sizeBytes) throw createError('File asset size mismatch', 'FILE_ASSET_SIZE_MISMATCH', 409);
      hash.update(bytes);
    }
    if (total !== record.sizeBytes) throw createError('File asset size mismatch', 'FILE_ASSET_SIZE_MISMATCH', 409);
    if (hash.digest('hex') !== record.sha256) throw createError('File asset hash mismatch', 'FILE_ASSET_HASH_MISMATCH', 409);
    const staged = await mutateFileAsset(record.id, async draft => {
      if (draft.status !== 'pending_upload' || draft.sha256 !== record.sha256 || draft.sizeBytes !== record.sizeBytes)
        throw createError('Upload receipt changed during finalization', 'FILE_ASSET_RECEIPT_UNAVAILABLE', 503);
      await rename(tempPath, targetPath);
      draft.status = 'ready';
      draft.uploadCompletedAt = nowIso();
      draft.localizedPath = targetPath;
      draft.localizedAt = nowIso();
      if (normalizedEtag) draft.etag = normalizedEtag;
      return true;
    }, { scopeCondition, authorize });
    if (!staged) throw createError('File asset not found', 'FILE_ASSET_NOT_FOUND', 404);
    return buildClientFileAsset(staged, { includeDirectUrl: true });
  } finally {
    await removePath(tempPath).catch(() => {});
  }
}

export async function finalizeFileAssetUpload(assetId, { sizeBytes, etag, scopeCondition = null, authorize } = {}) {
  assertOutsideSessionMetaTransaction();
  return runUploadMutation(assetId, async () => {
    const record = await readUploadAsset(assetId);
    if (record?.uploadRequest && record.storage.provider === 'local' && await uploadCheckpoints.exists(record)) {
      await withUploadScope(record, scopeCondition, async () => {}, authorize);
      if (record.status !== 'ready') {
        const state = await uploadCheckpoints.state(record,
          effect => withUploadScope(record, scopeCondition, effect, authorize));
        if (state.offset !== record.sizeBytes)
          throw createError('Attachment chunks are incomplete', 'FILE_ASSET_UPLOAD_INCOMPLETE', 409);
        // Keep the checkpoint name until ready, so interruption at any point
        // remains retryable. Verify and publish one hard-linked object where
        // supported; otherwise use the existing verified-copy path.
        const linkedReady = await finalizeCheckpointLink(record, { sizeBytes, etag, scopeCondition, authorize });
        if (linkedReady) {
          await uploadCheckpoints.clear(record);
          return linkedReady;
        } else {
          const source = createReadStream(uploadCheckpoints.paths(record).body);
          try { await ingestFileAssetUploadLocked(assetId, source, scopeCondition, authorize, undefined, true); }
          finally { source.destroy(); }
        }
      }
      const ready = await finalizeFileAssetUploadLocked(assetId, { sizeBytes, etag, scopeCondition, authorize });
      await uploadCheckpoints.clear(record);
      return ready;
    }
    return finalizeFileAssetUploadLocked(assetId, { sizeBytes, etag, scopeCondition, authorize });
  });
}

async function finalizeFileAssetUploadLocked(assetId, { sizeBytes, etag, scopeCondition, authorize }) {
  const current = await readUploadAsset(assetId);
  if (!current) {
    throw createError('File asset not found', 'FILE_ASSET_NOT_FOUND', 404);
  }
  await withUploadScope(current, scopeCondition, async () => {}, authorize);
  const normalizedSize = normalizePositiveInteger(sizeBytes);
  const normalizedEtag = normalizeString(etag).replace(/^W\//, '').replace(/^"|"$/g, '');
  if (current.uploadRequest) {
    if (sizeBytes !== undefined && (!Number.isSafeInteger(sizeBytes) || sizeBytes !== current.sizeBytes)) {
      throw createError('File asset size mismatch', 'FILE_ASSET_SIZE_MISMATCH', 409);
    }
    if (current.status === 'ready') {
      if (normalizedEtag && current.etag && normalizedEtag !== current.etag) {
        throw createError('File asset finalization receipt conflicts', 'FILE_ASSET_IDEMPOTENCY_CONFLICT', 409);
      }
      return withUploadScope(current, scopeCondition, () => buildClientFileAsset(current, { includeDirectUrl: true }), authorize);
    }
    if (current.storage?.provider !== 'local') {
      if (storedUploadScope(current)) {
        // A still-valid object-store PUT credential must not be able to change
        // bytes after the PC has accepted a scoped ready asset. Verify and copy
        // the same stream, then publish the private immutable PC snapshot.
        const localFilename = buildLocalObjectFilename(current.id, current.originalName);
        const targetPath = join(CHAT_FILE_ASSET_OBJECTS_DIR, localFilename);
        const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
        await ensureDir(CHAT_FILE_ASSET_OBJECTS_DIR);
        try {
          await verifyRemoteUpload(current, tempPath);
          const ready = await mutateFileAsset(current.id, async draft => {
            await rename(tempPath, targetPath);
            draft.status = 'ready';
            draft.uploadCompletedAt = nowIso();
            draft.storage.provider = 'local';
            draft.storage.localFilename = localFilename;
            draft.localizedPath = targetPath;
            draft.localizedAt = nowIso();
            if (normalizedEtag) draft.etag = normalizedEtag;
            return true;
          }, { scopeCondition, authorize });
          return buildClientFileAsset(ready || current, { includeDirectUrl: true });
        } finally { await removePath(tempPath).catch(() => {}); }
      }
      await verifyRemoteUpload(current);
    }
  }
  if (current.storage?.provider === 'local') {
    const localPath = resolveLocalObjectPath(current);
    const fileStats = await statOrNull(localPath);
    if (!fileStats?.isFile()) {
      throw createError(`Failed to locate local file asset: ${current.id}`, 'FILE_ASSET_LOCAL_MISSING', 404);
    }
    if ((normalizedSize && normalizedSize !== fileStats.size)
      || (current.sizeBytes && current.sizeBytes !== fileStats.size)) {
      throw createError(`File asset size mismatch: ${current.id}`, 'FILE_ASSET_SIZE_MISMATCH', 409);
    }
    const sha256 = await sha256File(localPath);
    if (current.sha256 && current.sha256 !== sha256) {
      throw createError(`File asset hash mismatch: ${current.id}`, 'FILE_ASSET_HASH_MISMATCH', 409);
    }
    const updated = await mutateFileAsset(current.id, (draft) => {
      draft.status = 'ready';
      draft.uploadCompletedAt = nowIso();
      draft.localizedPath = localPath;
      draft.localizedAt = draft.localizedAt || nowIso();
      if (normalizedEtag) draft.etag = normalizedEtag;
      if (Number.isInteger(fileStats.size) && fileStats.size >= 0) {
        draft.sizeBytes = fileStats.size;
      }
      draft.sha256 = sha256;
      return true;
    }, { scopeCondition, authorize });
    return buildClientFileAsset(updated || current, { includeDirectUrl: true });
  }
  const record = await mutateFileAsset(current.id, (draft) => {
    draft.status = 'ready';
    draft.uploadCompletedAt = nowIso();
    if (normalizedSize) draft.sizeBytes = normalizedSize;
    if (normalizedEtag) draft.etag = normalizedEtag;
    return true;
  }, { scopeCondition, authorize });
  return buildClientFileAsset(record || current, { includeDirectUrl: true });
}

async function verifyRemoteUpload(record, stagedPath = null) {
  let response;
  let staged;
  try {
    if (stagedPath) staged = await open(stagedPath, 'wx', 0o600);
    const signed = presignStorageRequest('GET', buildStorageObjectUrl(FILE_ASSET_STORAGE_BASE_URL, record.storage.objectKey));
    response = await fetch(signed.url, { signal: AbortSignal.timeout(60000), redirect: 'error' });
    if (!response.ok || !response.body) {
      throw createError('Uploaded object could not be verified', 'FILE_ASSET_UPLOAD_UNVERIFIED', 502);
    }
    const hash = createHash('sha256');
    let total = 0;
    for await (const chunk of response.body) {
      total += chunk.length;
      if (total > record.sizeBytes) throw createError('File asset size mismatch', 'FILE_ASSET_SIZE_MISMATCH', 409);
      hash.update(chunk);
      if (staged) {
        let offset = 0;
        while (offset < chunk.length) {
          const written = await staged.write(chunk, offset, chunk.length - offset);
          if (!written.bytesWritten) throw new Error('Incomplete private snapshot write');
          offset += written.bytesWritten;
        }
      }
    }
    if (total !== record.sizeBytes) throw createError('File asset size mismatch', 'FILE_ASSET_SIZE_MISMATCH', 409);
    if (hash.digest('hex') !== record.sha256) throw createError('File asset hash mismatch', 'FILE_ASSET_HASH_MISMATCH', 409);
    await staged?.sync();
  } catch (error) {
    await response?.body?.cancel().catch(() => {});
    if (['FILE_ASSET_SIZE_MISMATCH', 'FILE_ASSET_HASH_MISMATCH', 'FILE_ASSET_UPLOAD_UNVERIFIED'].includes(error.code)) throw error;
    throw createError('Uploaded object could not be verified', 'FILE_ASSET_UPLOAD_UNVERIFIED', 502);
  } finally { await staged?.close(); }
}

export async function buildFileAssetDirectUrl(recordOrId, {
  expiresInSeconds = FILE_ASSET_STORAGE_PRESIGN_TTL_SECONDS,
  attachment = false,
} = {}) {
  const record = await ensureReadyFileAssetRecord(recordOrId);
  if (record.storage.provider === 'local') {
    return {
      url: buildDownloadRoute(record.id, { attachment }),
      expiresAt: null,
    };
  }
  if (FILE_ASSET_PUBLIC_BASE_URL) {
    return {
      url: buildStorageDownloadUrl(FILE_ASSET_PUBLIC_BASE_URL, record, { attachment }),
      expiresAt: null,
    };
  }
  return presignStorageRequest(
    'GET',
    buildStorageDownloadUrl(FILE_ASSET_STORAGE_BASE_URL, record, { attachment }),
    expiresInSeconds,
  );
}

export async function localizeFileAsset(recordOrId) {
  const record = await ensureReadyFileAssetRecord(recordOrId);
  const pending = fileAssetLocalizationInflight.get(record.id);
  if (pending) return pending;
  const task = (async () => {
    const existingPath = await reuseLocalizedPath(record);
    if (existingPath) return existingPath;

    if (record.storage.provider === 'local') {
      const localPath = resolveLocalObjectPath(record);
      if (!await pathExists(localPath)) {
        throw createError(`Failed to locate local file asset: ${record.id}`, 'FILE_ASSET_LOCAL_MISSING', 404);
      }
      const updated = await mutateFileAsset(record.id, (draft) => {
        draft.localizedPath = localPath;
        draft.localizedAt = draft.localizedAt || nowIso();
        return true;
      });
      return normalizeString(updated?.localizedPath) || localPath;
    }

    let response = null;
    let downloadFailure = null;
    for (let attempt = 0; attempt <= FILE_ASSET_LOCALIZE_RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        const direct = await buildFileAssetDirectUrl(record, {
          expiresInSeconds: Math.max(FILE_ASSET_STORAGE_PRESIGN_TTL_SECONDS, 60 * 60),
        });
        response = await fetch(direct.url, { method: 'GET', redirect: 'follow' });
        if (response.ok && response.body) {
          downloadFailure = null;
          break;
        }
        const detail = response.ok
          ? 'empty response body'
          : `${response.status}${response.statusText ? ` ${response.statusText}` : ''}`;
        await response.body?.cancel?.().catch(() => {});
        response = null;
        downloadFailure = createError(
          `Failed to download file asset: ${record.id} (${detail})`,
          'FILE_ASSET_DOWNLOAD_FAILED',
          502,
        );
      } catch (error) {
        response = null;
        const message = normalizeString(error?.message) || 'request failed';
        downloadFailure = createError(
          `Failed to download file asset: ${record.id} (${message})`,
          'FILE_ASSET_DOWNLOAD_FAILED',
          502,
        );
      }

      const retryDelayMs = FILE_ASSET_LOCALIZE_RETRY_DELAYS_MS[attempt];
      if (!retryDelayMs) break;
      console.warn(
        `[file-assets] Retrying localization download for ${record.id} after ${retryDelayMs}ms: ${downloadFailure?.message || 'unknown failure'}`,
      );
      await sleep(retryDelayMs);
    }

    if (!response?.ok || !response.body) {
      throw downloadFailure || createError(`Failed to download file asset: ${record.id}`, 'FILE_ASSET_DOWNLOAD_FAILED', 502);
    }

    await ensureDir(CHAT_FILE_ASSET_CACHE_DIR);
    const targetPath = join(CHAT_FILE_ASSET_CACHE_DIR, buildCachedFilename(record));
    const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;

    try {
      await pipeline(Readable.fromWeb(response.body), createWriteStream(tempPath));
      await rename(tempPath, targetPath);
    } catch (error) {
      await removePath(tempPath).catch(() => {});
      throw createError(error.message || 'Failed to localize file asset', 'FILE_ASSET_LOCALIZE_FAILED', 502);
    }

    const fileStats = await statOrNull(targetPath);
    if (!fileStats?.isFile()) {
      throw createError(`Failed to localize file asset: ${record.id}`, 'FILE_ASSET_LOCALIZE_FAILED', 502);
    }
    if (record.sizeBytes && record.sizeBytes !== fileStats.size) {
      await removePath(targetPath).catch(() => {});
      throw createError(`File asset size mismatch: ${record.id}`, 'FILE_ASSET_SIZE_MISMATCH', 409);
    }
    const updated = await mutateFileAsset(record.id, (draft) => {
      draft.localizedPath = targetPath;
      draft.localizedAt = nowIso();
      if (Number.isInteger(fileStats.size) && fileStats.size >= 0) {
        draft.sizeBytes = fileStats.size;
      }
      return true;
    });

    return normalizeString(updated?.localizedPath) || targetPath;
  })();
  fileAssetLocalizationInflight.set(record.id, task);
  try {
    return await task;
  } finally {
    if (fileAssetLocalizationInflight.get(record.id) === task) {
      fileAssetLocalizationInflight.delete(record.id);
    }
  }
}

export async function materializeFileAssetAttachments(attachments) {
  const materialized = await mapWithFileAssetConcurrency(attachments, async (attachment) => {
    if (!(attachment && typeof attachment === 'object')) return null;
    const savedPath = normalizeString(attachment.savedPath);
    if (savedPath && await pathExists(savedPath)) {
      return attachment;
    }

    const assetId = normalizeString(attachment.assetId);
    if (!assetId) {
      return attachment;
    }

    const record = await ensureReadyFileAssetRecord(assetId);
    const localizedPath = await localizeFileAsset(record);
    return {
      ...attachment,
      assetId: record.id,
      filename: normalizeString(attachment.filename) || basename(localizedPath),
      savedPath: localizedPath,
      originalName: normalizeString(attachment.originalName) || record.originalName,
      mimeType: normalizeString(attachment.mimeType) || record.mimeType,
    };
  });

  return materialized.filter(Boolean);
}

export async function publishLocalFileAssetFromPath({
  sessionId,
  localPath,
  originalName,
  mimeType,
  createdBy = 'owner',
} = {}) {
  const filePath = normalizeString(localPath);
  const fileStats = await statOrNull(filePath);
  if (!filePath || !fileStats?.isFile()) {
    throw createError('localPath must point to a file', 'FILE_ASSET_LOCAL_PATH_INVALID', 400);
  }

  if (!FILE_ASSET_STORAGE_ENABLED) {
    const normalizedSessionId = normalizeString(sessionId);
    if (!normalizedSessionId) {
      throw createError('sessionId is required', 'FILE_ASSET_SESSION_REQUIRED', 400);
    }
    const assetId = generateFileAssetId();
    const createdAt = nowIso();
    const displayName = sanitizeDisplayName(originalName || basename(filePath), 'attachment');
    const localFilename = buildLocalObjectFilename(assetId, displayName);
    const targetPath = join(CHAT_FILE_ASSET_OBJECTS_DIR, localFilename);
    await ensureDir(CHAT_FILE_ASSET_OBJECTS_DIR);
    await copyFile(filePath, targetPath);
    const sha256 = await sha256File(targetPath);

    const record = normalizeFileAssetRecord({
      id: assetId,
      sessionId: normalizedSessionId,
      status: 'ready',
      createdAt,
      updatedAt: createdAt,
      createdBy,
      originalName: displayName,
      mimeType: normalizeMimeType(mimeType),
      sizeBytes: fileStats.size,
      sha256,
      storage: {
        provider: 'local',
        localFilename,
      },
      localizedPath: targetPath,
      localizedAt: createdAt,
      uploadCompletedAt: createdAt,
    });

    await ensureDir(CHAT_FILE_ASSETS_DIR);
    await writeJsonAtomic(fileAssetPath(assetId), record);
    return buildClientFileAsset(record, { includeDirectUrl: true });
  }

  requireFileAssetStorageEnabled();

  const intent = await createFileAssetUploadIntent({
    sessionId,
    originalName: originalName || basename(filePath),
    mimeType,
    sizeBytes: fileStats.size,
    createdBy,
    forceRemote: true,
  });

  if (intent.upload?.method === 'POST' || String(intent.upload?.url || '').startsWith('/')) {
    await ingestFileAssetUpload(intent.asset.id, createReadStream(filePath));
    return finalizeFileAssetUpload(intent.asset.id, {
      sizeBytes: fileStats.size,
      etag: '',
    });
  }

  const response = await fetch(intent.upload.url, {
    method: 'PUT',
    headers: intent.upload.headers,
    body: createReadStream(filePath),
    duplex: 'half',
  });
  if (!response.ok) {
    throw createError(`Failed to upload local file asset: ${response.status}`, 'FILE_ASSET_UPLOAD_FAILED', 502);
  }

  return finalizeFileAssetUpload(intent.asset.id, {
    sizeBytes: fileStats.size,
    etag: response.headers.get('etag') || '',
  });
}

export async function recordFileAssetContentDigest(assetId, { sha256, sizeBytes } = {}) {
  const normalizedHash = normalizeString(sha256).toLowerCase();
  const normalizedSize = Number.isInteger(sizeBytes) && sizeBytes >= 0 ? sizeBytes : null;
  if (!isValidFileAssetId(assetId) || !/^[0-9a-f]{64}$/.test(normalizedHash) || normalizedSize === null) {
    throw createError('Invalid file asset content digest', 'FILE_ASSET_DIGEST_INVALID', 400);
  }
  const updated = await mutateFileAsset(assetId, (draft) => {
    if (draft.sha256 && draft.sha256 !== normalizedHash) {
      throw createError(`File asset hash mismatch: ${assetId}`, 'FILE_ASSET_HASH_MISMATCH', 409);
    }
    if (draft.sizeBytes && draft.sizeBytes !== normalizedSize) {
      throw createError(`File asset size mismatch: ${assetId}`, 'FILE_ASSET_SIZE_MISMATCH', 409);
    }
    draft.sha256 = normalizedHash;
    draft.sizeBytes = normalizedSize;
    return true;
  });
  if (!updated) throw createError('File asset not found', 'FILE_ASSET_NOT_FOUND', 404);
  return updated;
}
