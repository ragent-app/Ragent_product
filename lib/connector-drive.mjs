// Google Drive connector — list, fetch and upload files in the authorized
// Google account's Drive. Uses drive.file scope: the connector only sees
// files it created itself or that were explicitly shared with the app.
// Shares the instance's Google OAuth credentials and token file with the
// calendar connector (see connector-google-common.mjs).

import { createHash } from 'node:crypto';
import { resolveDriveConnectorBinding } from './connector-bindings.mjs';
import {
  buildAuthenticatedClient,
  GOOGLE_DRIVE_SCOPE,
  pathExists,
  readJson,
  tokenScopeCompliance,
} from './connector-google-common.mjs';
import { createConnectorActionResult } from './connector-state.mjs';

const DEFAULT_MAX_FILES = 50;
const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';
const FILE_FIELDS = 'id,name,mimeType,size,modifiedTime,webViewLink,parents,headRevisionId,md5Checksum,version,trashed,appProperties';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function buildDriveError(message, { code = 'CONNECTOR_DRIVE_ERROR', statusCode = 500, details = null } = {}) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = statusCode;
  if (details) err.details = details;
  return err;
}

function assertSafeDriveId(value, fieldName = 'fileId') {
  const trimmed = trimString(value);
  if (!trimmed || trimmed === '.' || trimmed === '..' || !/^[A-Za-z0-9_.-]{1,256}$/.test(trimmed)) {
    throw buildDriveError(`Invalid Drive ${fieldName}.`, {
      code: 'CONNECTOR_INVALID_INPUT',
      statusCode: 400,
    });
  }
  return trimmed;
}

function assertSafeDriveName(value, fieldName = 'name') {
  const trimmed = trimString(value);
  if (!trimmed || trimmed === '.' || trimmed === '..' || trimmed.length > 255 || /[\/\\\0-\x1f]/.test(trimmed)) {
    throw buildDriveError(`Invalid Drive ${fieldName}.`, {
      code: 'CONNECTOR_INVALID_INPUT',
      statusCode: 400,
    });
  }
  return trimmed;
}

function normalizeAllowedFolderIds(allowedFolderIds) {
  if (allowedFolderIds === undefined || allowedFolderIds === null) return null;
  if (!Array.isArray(allowedFolderIds)) {
    throw buildDriveError('allowedFolderIds must be an array.', {
      code: 'CONNECTOR_INVALID_INPUT',
      statusCode: 400,
    });
  }
  return allowedFolderIds.map((id) => assertSafeDriveId(id, 'allowedFolderId'));
}

function assertDriveParentInScope(parentId, allowedFolders, label = 'parentId') {
  if (!allowedFolders) return;
  const normalized = trimString(parentId);
  if (!normalized || !allowedFolders.includes(normalized)) {
    throw buildDriveError(`Drive ${label} "${normalized || '(empty)'}" is outside allowedFolderIds scope.`, {
      code: 'CONNECTOR_SCOPE_VIOLATION',
      statusCode: 403,
    });
  }
}

function assertDriveFileParentsInScope(file, allowedFolders) {
  if (!allowedFolders) return;
  const parents = Array.isArray(file?.parents) ? file.parents.map(trimString).filter(Boolean) : [];
  if (!parents.some((parent) => allowedFolders.includes(parent))) {
    throw buildDriveError(`Drive file "${trimString(file?.id)}" is outside allowedFolderIds scope.`, {
      code: 'CONNECTOR_SCOPE_VIOLATION',
      statusCode: 403,
    });
  }
}

function deriveDriveEtag(file = {}) {
  return trimString(file.etag)
    || trimString(file.headRevisionId)
    || (file.version !== undefined && file.version !== null ? String(file.version) : '');
}

function deriveDriveRevisionId(file = {}) {
  return trimString(file.headRevisionId)
    || (file.version !== undefined && file.version !== null ? String(file.version) : '')
    || trimString(file.etag);
}

function resolveBindingError(binding) {
  if (!binding) {
    return createConnectorActionResult({
      connectorId: 'drive',
      capabilityState: 'binding_required',
      deliveryState: 'drafted',
    });
  }
  if (binding.capabilityState === 'binding_required') {
    return createConnectorActionResult({
      connectorId: 'drive',
      bindingId: binding.id,
      capabilityState: 'binding_required',
      deliveryState: 'drafted',
    });
  }
  if (binding.capabilityState === 'authorization_required') {
    return createConnectorActionResult({
      connectorId: 'drive',
      bindingId: binding.id,
      capabilityState: 'authorization_required',
      deliveryState: 'drafted',
    });
  }
  return null;
}

function mapDriveFile(file = {}) {
  return {
    id: trimString(file.id),
    name: trimString(file.name),
    mimeType: trimString(file.mimeType),
    size: typeof file.size === 'string' ? file.size : (typeof file.size === 'number' ? String(file.size) : ''),
    modifiedTime: trimString(file.modifiedTime),
    webViewLink: trimString(file.webViewLink),
    parents: Array.isArray(file.parents) ? file.parents.map(trimString).filter(Boolean) : [],
    headRevisionId: trimString(file.headRevisionId),
    etag: deriveDriveEtag(file),
    revisionId: deriveDriveRevisionId(file),
    md5Checksum: trimString(file.md5Checksum),
    version: file.version !== undefined && file.version !== null ? String(file.version) : '',
    trashed: file.trashed === true,
    appProperties: file.appProperties && typeof file.appProperties === 'object' ? { ...file.appProperties } : {},
  };
}

async function resolveDriveClient({ bindingId, credentialsPath, driveClient } = {}) {
  const binding = bindingId || !driveClient ? await resolveDriveConnectorBinding({ bindingId }) : null;
  if (bindingId || !driveClient) {
    const bindingError = resolveBindingError(binding);
    if (bindingError) return { error: bindingError, binding, drive: null };
  }
  const effectiveBinding = binding || { id: trimString(bindingId) || 'binding_drive_mock', capabilityState: 'ready' };
  if (driveClient) {
    return { error: null, binding: effectiveBinding, drive: driveClient };
  }
  const { google, client } = await buildAuthenticatedClient(effectiveBinding, credentialsPath);
  return { error: null, binding: effectiveBinding, drive: google.drive({ version: 'v3', auth: client }) };
}

export async function getDriveStatus({ binding, credentialsPath, tokenPath } = {}) {
  const credentialsPresent = await pathExists(credentialsPath);
  const token = tokenPath ? await readJson(tokenPath, null) : null;
  const tokenPresent = !!token;
  const scopeCompliant = !token || tokenScopeCompliance(token, [GOOGLE_DRIVE_SCOPE]);

  let capabilityState = 'authorization_required';
  if (binding?.capabilityState === 'binding_required') {
    capabilityState = 'binding_required';
  } else if (tokenPresent && scopeCompliant) {
    capabilityState = 'ready';
  }

  return {
    provider: 'google',
    service: 'drive',
    credentialsPresent,
    tokenPresent,
    scopeCompliant,
    capabilityState,
    accountHint: trimString(binding?.accountHint),
    binding: binding
      ? {
          id: trimString(binding.id),
          title: trimString(binding.title),
          provider: trimString(binding.provider),
          accountHint: trimString(binding.accountHint),
          capabilityState: trimString(binding.capabilityState),
        }
      : null,
  };
}

function assertSafeDriveQuery(query) {
  const q = trimString(query);
  if (!q) return '';
  if (/[\r\n\0]/.test(q)) {
    throw buildDriveError('Invalid Drive query: control characters are forbidden.', {
      code: 'CONNECTOR_INVALID_INPUT',
      statusCode: 400,
    });
  }
  let inSingleQuote = false;
  let parenDepth = 0;
  for (let i = 0; i < q.length; i += 1) {
    const ch = q[i];
    if (ch === '\\' && inSingleQuote) {
      i += 1;
      continue;
    }
    if (ch === "'") {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (!inSingleQuote) {
      if (ch === '(') parenDepth += 1;
      else if (ch === ')') {
        parenDepth -= 1;
        if (parenDepth < 0) {
          throw buildDriveError('Invalid Drive query: unbalanced parentheses.', {
            code: 'CONNECTOR_INVALID_INPUT',
            statusCode: 400,
          });
        }
      }
    }
  }
  if (inSingleQuote || parenDepth !== 0) {
    throw buildDriveError('Invalid Drive query: unbalanced quotes or parentheses.', {
      code: 'CONNECTOR_INVALID_INPUT',
      statusCode: 400,
    });
  }
  return q;
}

export async function listDriveFiles({
  bindingId,
  credentialsPath,
  maxResults = DEFAULT_MAX_FILES,
  query = '',
  folderId = '',
  allowedFolderIds,
  driveClient,
} = {}) {
  const allowedFolders = normalizeAllowedFolderIds(allowedFolderIds);
  const safeFolderId = trimString(folderId) ? assertSafeDriveId(folderId, 'folderId') : '';
  if (allowedFolders) {
    assertDriveParentInScope(safeFolderId, allowedFolders, 'folderId');
  }
  const safeQuery = allowedFolders ? assertSafeDriveQuery(query) : trimString(query);

  const { error, binding, drive } = await resolveDriveClient({ bindingId, credentialsPath, driveClient });
  if (error) return { files: [], error };

  const clauses = [];
  if (safeFolderId) {
    clauses.push(`'${safeFolderId}' in parents and trashed = false`);
  }
  if (safeQuery) {
    clauses.push(`(${safeQuery})`);
  }

  const response = await drive.files.list({
    pageSize: Math.min(Math.max(1, Number(maxResults) || DEFAULT_MAX_FILES), 200),
    fields: `nextPageToken, files(${FILE_FIELDS})`,
    ...(clauses.length > 0 ? { q: clauses.join(' and ') } : {}),
  });

  const mapped = (response?.data?.files || []).map(mapDriveFile);
  const scopedFiles = allowedFolders
    ? mapped.filter((file) => Array.isArray(file.parents) && file.parents.length > 0
        && file.parents.some((p) => allowedFolders.includes(p)))
    : mapped;

  return {
    files: scopedFiles,
    bindingId: binding.id,
  };
}

export async function getDriveFile({ bindingId, credentialsPath, fileId, allowedFolderIds, driveClient } = {}) {
  const normalizedFileId = trimString(fileId);
  if (!normalizedFileId) {
    return { file: null, error: 'Drive file id is required.' };
  }
  const safeFileId = assertSafeDriveId(normalizedFileId, 'fileId');
  const allowedFolders = normalizeAllowedFolderIds(allowedFolderIds);

  const { error, binding, drive } = await resolveDriveClient({ bindingId, credentialsPath, driveClient });
  if (error) return { file: null, error };

  const response = await drive.files.get({
    fileId: safeFileId,
    fields: FILE_FIELDS,
  });
  const mapped = mapDriveFile(response?.data);
  assertDriveFileParentsInScope(mapped, allowedFolders);

  return {
    file: mapped,
    bindingId: binding.id,
  };
}

export async function readDriveFileContent({ bindingId, credentialsPath, fileId, allowedFolderIds, driveClient } = {}) {
  const safeFileId = assertSafeDriveId(fileId, 'fileId');
  const allowedFolders = normalizeAllowedFolderIds(allowedFolderIds);

  const { error, binding, drive } = await resolveDriveClient({ bindingId, credentialsPath, driveClient });
  if (error) return { file: null, content: null, error };

  const metaResponse = await drive.files.get({
    fileId: safeFileId,
    fields: FILE_FIELDS,
  });
  const file = mapDriveFile(metaResponse?.data);
  assertDriveFileParentsInScope(file, allowedFolders);
  if (file.trashed) {
    throw buildDriveError(`Drive file ${safeFileId} is trashed.`, {
      code: 'CONNECTOR_CONFLICT',
      statusCode: 409,
    });
  }

  const mediaResponse = await drive.files.get({
    fileId: safeFileId,
    alt: 'media',
  });
  const content = mediaResponse?.data !== undefined ? mediaResponse.data : mediaResponse;
  return {
    file,
    content,
    etag: file.etag,
    revisionId: file.revisionId,
    bindingId: binding.id,
  };
}

export async function createDriveFolder({
  bindingId,
  credentialsPath,
  name,
  parentId = '',
  allowedFolderIds,
  idempotencyKey = '',
  driveClient,
  onBeforeWire,
} = {}) {
  const folderName = assertSafeDriveName(name, 'folder name');
  const allowedFolders = normalizeAllowedFolderIds(allowedFolderIds);
  const safeParentId = trimString(parentId) ? assertSafeDriveId(parentId, 'parentId') : '';
  if (allowedFolders) {
    assertDriveParentInScope(safeParentId, allowedFolders, 'parentId');
  }

  const { error, binding, drive } = await resolveDriveClient({ bindingId, credentialsPath, driveClient });
  if (error) return error;

  const requestBody = {
    name: folderName,
    mimeType: FOLDER_MIME_TYPE,
    ...(safeParentId ? { parents: [safeParentId] } : {}),
    ...(trimString(idempotencyKey) ? { appProperties: { ragentIdempotencyKey: trimString(idempotencyKey) } } : {}),
  };

  if (typeof onBeforeWire === 'function') await onBeforeWire();
  const response = await drive.files.create({
    requestBody,
    fields: FILE_FIELDS,
  });
  const createdId = trimString(response?.data?.id);
  if (!createdId) {
    throw buildDriveError('Drive folder creation did not return an authoritative folder ID.', {
      code: 'CONNECTOR_RECEIPT_MISSING',
      statusCode: 502,
    });
  }
  const file = mapDriveFile(response.data);
  return {
    ...createConnectorActionResult({
      connectorId: 'drive',
      bindingId: binding.id,
      targetId: `folder:${createdId}`,
      capabilityState: 'ready',
      deliveryState: 'delivered',
      externalId: createdId,
      message: `Created Drive folder "${folderName}"`,
    }),
    file,
    etag: file.etag,
    revisionId: file.revisionId,
  };
}

export async function uploadDriveFile({
  bindingId,
  credentialsPath,
  name,
  mimeType = 'text/plain',
  content,
  parentId = '',
  allowedFolderIds,
  idempotencyKey = '',
  driveClient,
  onBeforeWire,
} = {}) {
  const allowedFolders = normalizeAllowedFolderIds(allowedFolderIds);
  const safeParentId = trimString(parentId) ? assertSafeDriveId(parentId, 'parentId') : '';
  if (allowedFolders) {
    assertDriveParentInScope(safeParentId, allowedFolders, 'parentId');
  }

  const { error, binding, drive } = await resolveDriveClient({ bindingId, credentialsPath, driveClient });
  if (error) return error;

  const rawName = trimString(name);
  if (!rawName) {
    return createConnectorActionResult({
      connectorId: 'drive',
      bindingId: binding.id,
      capabilityState: 'ready',
      deliveryState: 'drafted',
      message: 'Drive file name is required.',
    });
  }
  const fileName = assertSafeDriveName(rawName, 'file name');

  const requestBody = {
    name: fileName,
    mimeType: trimString(mimeType) || 'text/plain',
    ...(safeParentId ? { parents: [safeParentId] } : {}),
    ...(trimString(idempotencyKey) ? { appProperties: { ragentIdempotencyKey: trimString(idempotencyKey) } } : {}),
  };

  if (typeof onBeforeWire === 'function') await onBeforeWire();
  const response = await drive.files.create({
    requestBody,
    media: {
      mimeType: trimString(mimeType) || 'text/plain',
      body: typeof content === 'string' ? content : (content ?? ''),
    },
    fields: FILE_FIELDS,
  });
  const createdId = trimString(response?.data?.id);
  if (!createdId) {
    throw buildDriveError('Drive file upload did not return an authoritative file ID.', {
      code: 'CONNECTOR_RECEIPT_MISSING',
      statusCode: 502,
    });
  }
  const file = mapDriveFile(response.data);

  return {
    ...createConnectorActionResult({
      connectorId: 'drive',
      bindingId: binding.id,
      targetId: `file:${createdId}`,
      capabilityState: 'ready',
      deliveryState: 'delivered',
      externalId: createdId,
      message: `Uploaded Drive file "${fileName}"`,
    }),
    file,
    etag: file.etag,
    revisionId: file.revisionId,
  };
}

export async function createDriveFile(options = {}) {
  return await uploadDriveFile(options);
}

async function verifyDriveFilePrecondition(drive, fileId, { expectedEtag, expectedRevisionId, allowedFolders } = {}) {
  let meta;
  try {
    meta = await drive.files.get({ fileId, fields: FILE_FIELDS });
  } catch (error) {
    if (error?.code === 404 || error?.status === 404 || /not found/i.test(error?.message || '')) {
      throw buildDriveError(`Drive file ${fileId} was not found.`, {
        code: 'CONNECTOR_CONFLICT',
        statusCode: 409,
      });
    }
    throw error;
  }
  const current = mapDriveFile(meta?.data);
  if (!current.id) {
    throw buildDriveError(`Drive file ${fileId} was not found.`, {
      code: 'CONNECTOR_CONFLICT',
      statusCode: 409,
    });
  }
  assertDriveFileParentsInScope(current, allowedFolders);
  if (current.trashed) {
    throw buildDriveError(`Drive file ${fileId} is trashed.`, {
      code: 'CONNECTOR_CONFLICT',
      statusCode: 409,
    });
  }
  if (expectedEtag !== undefined && current.etag !== trimString(expectedEtag)) {
    throw buildDriveError(
      `Drive file ${fileId} ETag conflict: expected "${trimString(expectedEtag)}", found "${current.etag}".`,
      {
        code: 'CONNECTOR_CONFLICT',
        statusCode: 409,
        details: { expectedEtag: trimString(expectedEtag), actualEtag: current.etag },
      },
    );
  }
  if (expectedRevisionId !== undefined && current.revisionId !== trimString(expectedRevisionId)) {
    throw buildDriveError(
      `Drive file ${fileId} revision conflict: expected "${trimString(expectedRevisionId)}", found "${current.revisionId}".`,
      {
        code: 'CONNECTOR_CONFLICT',
        statusCode: 409,
        details: { expectedRevisionId: trimString(expectedRevisionId), actualRevisionId: current.revisionId },
      },
    );
  }
  return current;
}

export async function updateDriveFile({
  bindingId,
  credentialsPath,
  fileId,
  name,
  mimeType,
  content,
  expectedEtag,
  expectedRevisionId,
  requireConflictCheck = true,
  allowedFolderIds,
  idempotencyKey = '',
  mutationDigest = '',
  driveClient,
  onBeforeWire,
} = {}) {
  const safeFileId = assertSafeDriveId(fileId, 'fileId');
  const allowedFolders = normalizeAllowedFolderIds(allowedFolderIds);
  const hasPrecondition = expectedEtag !== undefined || expectedRevisionId !== undefined;
  if (requireConflictCheck && !hasPrecondition) {
    throw buildDriveError('Drive file update requires expectedEtag or expectedRevisionId.', {
      code: 'CONNECTOR_CONFLICT_CHECK_REQUIRED',
      statusCode: 400,
    });
  }

  const { error, binding, drive } = await resolveDriveClient({ bindingId, credentialsPath, driveClient });
  if (error) return error;

  const current = await verifyDriveFilePrecondition(drive, safeFileId, {
    expectedEtag,
    expectedRevisionId,
    allowedFolders,
  });

  const requestBody = {};
  if (name !== undefined) requestBody.name = assertSafeDriveName(name, 'file name');
  if (mimeType !== undefined) requestBody.mimeType = trimString(mimeType) || current.mimeType || 'text/plain';
  if (mutationDigest || idempotencyKey) {
    requestBody.appProperties = {
      ...(current.appProperties || {}),
      ...(mutationDigest ? { ragentMutationDigest: trimString(mutationDigest) } : {}),
      ...(idempotencyKey ? { ragentIdempotencyKey: trimString(idempotencyKey) } : {}),
    };
  }

  const effectiveMime = trimString(mimeType) || current.mimeType || 'text/plain';
  if (typeof onBeforeWire === 'function') await onBeforeWire();
  const response = await drive.files.update({
    fileId: safeFileId,
    requestBody,
    ...(content !== undefined
      ? {
          media: {
            mimeType: effectiveMime,
            body: typeof content === 'string' ? content : (content ?? ''),
          },
        }
      : {}),
    ...(expectedEtag !== undefined ? { headers: { 'If-Match': trimString(expectedEtag) } } : {}),
    fields: FILE_FIELDS,
  });
  const updatedId = trimString(response?.data?.id);
  if (!updatedId) {
    throw buildDriveError('Drive file update did not return an authoritative file ID.', {
      code: 'CONNECTOR_RECEIPT_MISSING',
      statusCode: 502,
    });
  }
  const file = mapDriveFile(response.data);

  return {
    ...createConnectorActionResult({
      connectorId: 'drive',
      bindingId: binding.id,
      targetId: `file:${updatedId}`,
      capabilityState: 'ready',
      deliveryState: 'delivered',
      externalId: updatedId,
      message: `Updated Drive file "${file.name || updatedId}"`,
    }),
    file,
    etag: file.etag,
    revisionId: file.revisionId,
  };
}

export async function shareDriveFile({
  bindingId,
  credentialsPath,
  fileId,
  role = 'reader',
  type = 'user',
  emailAddress = '',
  domain = '',
  sendNotificationEmail = false,
  allowPublicExposure = false,
  allowedFolderIds,
  allowedShareEmails,
  allowedShareDomains,
  driveClient,
  onBeforeWire,
} = {}) {
  const safeFileId = assertSafeDriveId(fileId, 'fileId');
  const shareType = trimString(type).toLowerCase() || 'user';
  const shareRole = trimString(role).toLowerCase() || 'reader';
  if (!['user', 'group', 'domain', 'anyone'].includes(shareType)) {
    throw buildDriveError('Drive permission type must be user, group, domain, or anyone.', {
      code: 'CONNECTOR_INVALID_INPUT',
      statusCode: 400,
    });
  }
  if (!['reader', 'commenter', 'writer'].includes(shareRole)) {
    throw buildDriveError('Drive permission role must be reader, commenter, or writer.', {
      code: 'CONNECTOR_INVALID_INPUT',
      statusCode: 400,
    });
  }
  if (shareType === 'anyone' && allowPublicExposure !== true) {
    throw buildDriveError('Public Drive sharing ("anyone") is forbidden unless allowPublicExposure=true.', {
      code: 'CONNECTOR_PUBLIC_SHARE_FORBIDDEN',
      statusCode: 403,
    });
  }
  const normalizedEmail = trimString(emailAddress).toLowerCase();
  const normalizedDomain = trimString(domain).toLowerCase();
  if ((shareType === 'user' || shareType === 'group') && (!normalizedEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalizedEmail))) {
    throw buildDriveError('Valid emailAddress is required for user/group Drive sharing.', {
      code: 'CONNECTOR_INVALID_INPUT',
      statusCode: 400,
    });
  }
  if (shareType === 'domain' && (!normalizedDomain || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(normalizedDomain))) {
    throw buildDriveError('Valid domain is required for domain Drive sharing.', {
      code: 'CONNECTOR_INVALID_INPUT',
      statusCode: 400,
    });
  }
  if (Array.isArray(allowedShareEmails) && (shareType === 'user' || shareType === 'group')) {
    const allowedSet = new Set(allowedShareEmails.map((e) => trimString(e).toLowerCase()).filter(Boolean));
    if (!allowedSet.has(normalizedEmail)) {
      throw buildDriveError(`Drive share recipient "${normalizedEmail}" is outside allowedShareEmails.`, {
        code: 'CONNECTOR_SCOPE_VIOLATION',
        statusCode: 403,
      });
    }
  }
  if (Array.isArray(allowedShareDomains)) {
    const domainSet = new Set(allowedShareDomains.map((d) => trimString(d).toLowerCase()).filter(Boolean));
    const targetDomain = shareType === 'domain' ? normalizedDomain : (normalizedEmail.split('@')[1] || '');
    if (shareType === 'anyone' || !targetDomain || !domainSet.has(targetDomain)) {
      throw buildDriveError(`Drive share target is outside allowedShareDomains.`, {
        code: 'CONNECTOR_SCOPE_VIOLATION',
        statusCode: 403,
      });
    }
  }

  const allowedFolders = normalizeAllowedFolderIds(allowedFolderIds);
  const { error, binding, drive } = await resolveDriveClient({ bindingId, credentialsPath, driveClient });
  if (error) return error;

  await verifyDriveFilePrecondition(drive, safeFileId, { allowedFolders });

  const requestBody = {
    type: shareType,
    role: shareRole,
    ...(shareType === 'user' || shareType === 'group' ? { emailAddress: normalizedEmail } : {}),
    ...(shareType === 'domain' ? { domain: normalizedDomain } : {}),
  };

  if (typeof onBeforeWire === 'function') await onBeforeWire();
  const response = await drive.permissions.create({
    fileId: safeFileId,
    sendNotificationEmail: sendNotificationEmail === true,
    requestBody,
    fields: 'id,type,role,emailAddress,domain',
  });
  const permissionId = trimString(response?.data?.id);
  if (!permissionId) {
    throw buildDriveError('Drive permission grant did not return an authoritative permission ID.', {
      code: 'CONNECTOR_RECEIPT_MISSING',
      statusCode: 502,
    });
  }

  return {
    ...createConnectorActionResult({
      connectorId: 'drive',
      bindingId: binding.id,
      targetId: `permission:${safeFileId}:${permissionId}`,
      capabilityState: 'ready',
      deliveryState: 'delivered',
      externalId: permissionId,
      message: `Shared Drive file ${safeFileId} (${shareType}:${shareRole})`,
    }),
    permission: {
      id: permissionId,
      type: trimString(response.data.type) || shareType,
      role: trimString(response.data.role) || shareRole,
      emailAddress: trimString(response.data.emailAddress) || normalizedEmail,
      domain: trimString(response.data.domain) || normalizedDomain,
    },
  };
}

export async function findDriveActionReceipt({
  bindingId,
  credentialsPath,
  actionKind = 'create_file',
  fileId = '',
  folderId = '',
  name = '',
  idempotencyKey = '',
  mutationDigest = '',
  permissionId = '',
  shareType = '',
  shareRole = '',
  shareEmail = '',
  shareDomain = '',
  driveClient,
} = {}) {
  const { error, drive } = await resolveDriveClient({ bindingId, credentialsPath, driveClient });
  if (error || !drive) return null;

  if (actionKind === 'create_file' || actionKind === 'create_folder') {
    if (trimString(fileId)) {
      const resp = await drive.files.get({ fileId: trimString(fileId), fields: FILE_FIELDS }).catch(() => null);
      if (resp?.data?.id) {
        const mapped = mapDriveFile(resp.data);
        if (!idempotencyKey || mapped.appProperties?.ragentIdempotencyKey === idempotencyKey) {
          return { verified: true, externalId: mapped.id, receipt: mapped };
        }
      }
    }
    if (typeof drive.files?.list === 'function') {
      const clauses = ['trashed = false'];
      if (trimString(folderId)) clauses.push(`'${assertSafeDriveId(folderId, 'folderId')}' in parents`);
      const resp = await drive.files.list({
        pageSize: 100,
        fields: `files(${FILE_FIELDS})`,
        q: clauses.join(' and '),
      }).catch(() => null);
      const match = (resp?.data?.files || []).map(mapDriveFile).find((file) => {
        if (idempotencyKey && file.appProperties?.ragentIdempotencyKey === idempotencyKey) return true;
        if (!idempotencyKey && trimString(name) && file.name === trimString(name)) return true;
        return false;
      });
      if (match?.id) {
        return { verified: true, externalId: match.id, receipt: match };
      }
    }
    return null;
  }

  const safeFileId = trimString(fileId) ? assertSafeDriveId(fileId, 'fileId') : '';
  if (!safeFileId) return null;

  if (actionKind === 'update_file') {
    const resp = await drive.files.get({ fileId: safeFileId, fields: FILE_FIELDS }).catch(() => null);
    if (!resp?.data?.id) return null;
    const mapped = mapDriveFile(resp.data);
    if (mutationDigest && mapped.appProperties?.ragentMutationDigest !== mutationDigest) return null;
    if (idempotencyKey && mapped.appProperties?.ragentIdempotencyKey && mapped.appProperties.ragentIdempotencyKey !== idempotencyKey) return null;
    return { verified: true, externalId: mapped.id, receipt: mapped };
  }

  if (actionKind === 'share_file') {
    const resp = await drive.permissions?.list?.({
      fileId: safeFileId,
      fields: 'permissions(id,type,role,emailAddress,domain)',
    }).catch(() => null);
    const list = resp?.data?.permissions || [];
    const match = list.find((perm) => {
      if (permissionId && trimString(perm.id) === trimString(permissionId)) return true;
      return (!shareType || trimString(perm.type).toLowerCase() === trimString(shareType).toLowerCase())
        && (!shareRole || trimString(perm.role).toLowerCase() === trimString(shareRole).toLowerCase())
        && (!shareEmail || trimString(perm.emailAddress).toLowerCase() === trimString(shareEmail).toLowerCase())
        && (!shareDomain || trimString(perm.domain).toLowerCase() === trimString(shareDomain).toLowerCase());
    });
    if (!match?.id) return null;
    return { verified: true, externalId: trimString(match.id), receipt: match };
  }

  return null;
}

export const DRIVE_ACTION_CONTRACTS = Object.freeze({
  'drive.file.list': Object.freeze({
    capability: 'drive.file.list',
    connectorId: 'drive',
    actionClass: 'read',
    riskLevel: 'read',
    confirmationPolicy: 'auto_within_policy',
    timeoutMs: 15_000,
    receiptVerifier: Object.freeze({
      kind: 'none_readonly',
      supported: false,
      description: 'Read-only Drive folder listing requires no mutation receipt.',
    }),
    compensation: Object.freeze({
      supported: false,
      mode: 'none_readonly',
      description: 'Read-only action has no side effects to compensate.',
    }),
  }),
  'drive.file.get': Object.freeze({
    capability: 'drive.file.get',
    connectorId: 'drive',
    actionClass: 'read',
    riskLevel: 'read',
    confirmationPolicy: 'auto_within_policy',
    timeoutMs: 15_000,
    receiptVerifier: Object.freeze({
      kind: 'none_readonly',
      supported: false,
      description: 'Read-only Drive metadata fetch requires no mutation receipt.',
    }),
    compensation: Object.freeze({
      supported: false,
      mode: 'none_readonly',
      description: 'Read-only action has no side effects to compensate.',
    }),
  }),
  'drive.file.read': Object.freeze({
    capability: 'drive.file.read',
    connectorId: 'drive',
    actionClass: 'read',
    riskLevel: 'read',
    confirmationPolicy: 'auto_within_policy',
    timeoutMs: 20_000,
    receiptVerifier: Object.freeze({
      kind: 'none_readonly',
      supported: false,
      description: 'Read-only Drive content fetch requires no mutation receipt.',
    }),
    compensation: Object.freeze({
      supported: false,
      mode: 'none_readonly',
      description: 'Read-only action has no side effects to compensate.',
    }),
  }),
  'drive.folder.create': Object.freeze({
    capability: 'drive.folder.create',
    connectorId: 'drive',
    actionClass: 'write',
    riskLevel: 'reversible_write',
    confirmationPolicy: 'require_approval',
    timeoutMs: 20_000,
    receiptVerifier: Object.freeze({
      kind: 'provider_lookup',
      supported: true,
      description: 'Verify created Drive folder via files.get/list matching ragentIdempotencyKey.',
    }),
    compensation: Object.freeze({
      supported: true,
      mode: 'manual_only',
      description: 'Trash or delete the created empty folder inside the scoped directory.',
    }),
  }),
  'drive.file.create': Object.freeze({
    capability: 'drive.file.create',
    connectorId: 'drive',
    actionClass: 'write',
    riskLevel: 'reversible_write',
    confirmationPolicy: 'require_approval',
    timeoutMs: 25_000,
    receiptVerifier: Object.freeze({
      kind: 'provider_lookup',
      supported: true,
      description: 'Verify created Drive file via files.get/list matching ragentIdempotencyKey.',
    }),
    compensation: Object.freeze({
      supported: true,
      mode: 'manual_only',
      description: 'Trash or delete the created file inside the scoped directory.',
    }),
  }),
  'drive.file.update': Object.freeze({
    capability: 'drive.file.update',
    connectorId: 'drive',
    actionClass: 'write',
    riskLevel: 'reversible_write',
    confirmationPolicy: 'require_approval',
    timeoutMs: 25_000,
    receiptVerifier: Object.freeze({
      kind: 'provider_lookup',
      supported: true,
      description: 'Verify updated Drive file via files.get matching ragentMutationDigest and revision.',
    }),
    compensation: Object.freeze({
      supported: true,
      mode: 'compensating_action',
      compensatingCapability: 'drive.file.update',
      description: 'Restore previous Drive file content or revision with current ETag/revision check.',
    }),
  }),
  'drive.file.share': Object.freeze({
    capability: 'drive.file.share',
    connectorId: 'drive',
    actionClass: 'broadcast',
    riskLevel: 'external_broadcast',
    confirmationPolicy: 'require_approval',
    timeoutMs: 20_000,
    receiptVerifier: Object.freeze({
      kind: 'provider_lookup',
      supported: true,
      description: 'Verify granted Drive permission via permissions.list.',
    }),
    compensation: Object.freeze({
      supported: false,
      mode: 'manual_only',
      description: 'Revoking Drive permissions stops future access but cannot retract already viewed/copied data.',
    }),
  }),
});

export function createDriveConnectorAction(capability, params = {}, options = {}) {
  const template = DRIVE_ACTION_CONTRACTS[capability];
  if (!template) {
    throw buildDriveError(`Unknown Drive connector capability: ${capability}`, {
      code: 'CONNECTOR_UNSUPPORTED_CAPABILITY',
      statusCode: 400,
    });
  }
  const idempotencyKey = trimString(options.idempotencyKey || params.idempotencyKey);
  const timeoutMs = Number.isInteger(options.timeoutMs) ? options.timeoutMs : template.timeoutMs;
  const confirmationPolicy = trimString(options.confirmationPolicy) || template.confirmationPolicy;
  const bindingId = trimString(params.bindingId || options.bindingId);
  const credentialsPath = trimString(params.credentialsPath || options.credentialsPath);
  const driveClient = params.driveClient || options.driveClient;
  const allowedFolderIds = normalizeAllowedFolderIds(params.allowedFolderIds ?? options.allowedFolderIds);

  if (capability === 'drive.file.list') {
    const folderId = trimString(params.folderId) ? assertSafeDriveId(params.folderId, 'folderId') : '';
    const scope = {
      connectorId: 'drive',
      resource: folderId ? `folder:${folderId}` : 'drive:files',
      ...(folderId ? { folderId } : {}),
      ...(allowedFolderIds ? { allowedFolderIds } : {}),
      ...(bindingId ? { bindingId } : {}),
    };
    return {
      contract: { ...template, idempotencyKey, confirmationPolicy, timeoutMs, scope },
      payload: { folderId, query: trimString(params.query), maxResults: params.maxResults ?? DEFAULT_MAX_FILES },
      precheck: async () => {
        if (allowedFolderIds) assertDriveParentInScope(folderId, allowedFolderIds, 'folderId');
        return { ok: true };
      },
      execute: async (ctx = {}) => await listDriveFiles({
        bindingId,
        credentialsPath,
        folderId,
        query: params.query,
        maxResults: params.maxResults ?? DEFAULT_MAX_FILES,
        allowedFolderIds,
        driveClient: ctx.driveClient || driveClient,
      }),
    };
  }

  if (capability === 'drive.file.get' || capability === 'drive.file.read') {
    const fileId = assertSafeDriveId(params.fileId, 'fileId');
    const isReadContent = capability === 'drive.file.read';
    const scope = {
      connectorId: 'drive',
      resource: `file:${fileId}`,
      fileId,
      ...(allowedFolderIds ? { allowedFolderIds } : {}),
      ...(bindingId ? { bindingId } : {}),
    };
    return {
      contract: { ...template, idempotencyKey, confirmationPolicy, timeoutMs, scope },
      payload: { fileId },
      execute: async (ctx = {}) => isReadContent
        ? await readDriveFileContent({
            bindingId,
            credentialsPath,
            fileId,
            allowedFolderIds,
            driveClient: ctx.driveClient || driveClient,
          })
        : await getDriveFile({
            bindingId,
            credentialsPath,
            fileId,
            allowedFolderIds,
            driveClient: ctx.driveClient || driveClient,
          }),
    };
  }

  if (capability === 'drive.folder.create' || capability === 'drive.file.create') {
    const isFolder = capability === 'drive.folder.create';
    const name = assertSafeDriveName(params.name, isFolder ? 'folder name' : 'file name');
    const parentId = trimString(params.parentId) ? assertSafeDriveId(params.parentId, 'parentId') : '';
    const scope = {
      connectorId: 'drive',
      resource: parentId ? `folder:${parentId}/${name}` : `file:${name}`,
      ...(parentId ? { parentId } : {}),
      ...(allowedFolderIds ? { allowedFolderIds } : {}),
      ...(bindingId ? { bindingId } : {}),
    };
    const receiptVerifier = {
      ...template.receiptVerifier,
      verify: async (ctx = {}) => await findDriveActionReceipt({
        bindingId,
        credentialsPath,
        actionKind: isFolder ? 'create_folder' : 'create_file',
        fileId: ctx.result?.externalId || ctx.externalId,
        folderId: parentId,
        name,
        idempotencyKey,
        driveClient: ctx.driveClient || driveClient,
      }),
    };
    return {
      contract: { ...template, idempotencyKey, confirmationPolicy, timeoutMs, scope, receiptVerifier },
      payload: isFolder
        ? { name, parentId }
        : { name, parentId, mimeType: trimString(params.mimeType) || 'text/plain', content: params.content ?? '' },
      precheck: async () => {
        if (allowedFolderIds) assertDriveParentInScope(parentId, allowedFolderIds, 'parentId');
        return { ok: true };
      },
      execute: async (ctx = {}) => isFolder
        ? await createDriveFolder({
            bindingId,
            credentialsPath,
            name,
            parentId,
            allowedFolderIds,
            idempotencyKey,
            driveClient: ctx.driveClient || driveClient,
            onBeforeWire: ctx.onBeforeWire,
          })
        : await uploadDriveFile({
            bindingId,
            credentialsPath,
            name,
            mimeType: params.mimeType,
            content: params.content,
            parentId,
            allowedFolderIds,
            idempotencyKey,
            driveClient: ctx.driveClient || driveClient,
            onBeforeWire: ctx.onBeforeWire,
          }),
    };
  }

  if (capability === 'drive.file.update') {
    const fileId = assertSafeDriveId(params.fileId, 'fileId');
    const hasPrecondition = params.expectedEtag !== undefined || params.expectedRevisionId !== undefined;
    const mutationDigest = createHash('sha256')
      .update(JSON.stringify({ capability, fileId, idempotencyKey }))
      .digest('hex');
    const scope = {
      connectorId: 'drive',
      resource: `file:${fileId}`,
      fileId,
      ...(allowedFolderIds ? { allowedFolderIds } : {}),
      ...(bindingId ? { bindingId } : {}),
    };
    const receiptVerifier = {
      ...template.receiptVerifier,
      verify: async (ctx = {}) => await findDriveActionReceipt({
        bindingId,
        credentialsPath,
        actionKind: 'update_file',
        fileId,
        idempotencyKey,
        mutationDigest,
        driveClient: ctx.driveClient || driveClient,
      }),
    };
    return {
      contract: { ...template, idempotencyKey, confirmationPolicy, timeoutMs, scope, receiptVerifier },
      payload: {
        fileId,
        ...(params.name !== undefined ? { name: assertSafeDriveName(params.name, 'file name') } : {}),
        ...(params.mimeType !== undefined ? { mimeType: trimString(params.mimeType) } : {}),
        ...(params.content !== undefined ? { content: params.content } : {}),
        expectedEtag: params.expectedEtag ?? null,
        expectedRevisionId: params.expectedRevisionId ?? null,
      },
      precheck: async (ctx = {}) => {
        if (!hasPrecondition) {
          throw buildDriveError('Drive file update requires expectedEtag or expectedRevisionId.', {
            code: 'CONNECTOR_CONFLICT_CHECK_REQUIRED',
            statusCode: 400,
          });
        }
        const resolved = await resolveDriveClient({
          bindingId,
          credentialsPath,
          driveClient: ctx.driveClient || driveClient,
        });
        if (resolved.error) {
          throw buildDriveError(resolved.error.message || 'Drive binding error', { code: 'CONNECTOR_BINDING_ERROR', statusCode: 409 });
        }
        const current = await verifyDriveFilePrecondition(resolved.drive, fileId, {
          expectedEtag: params.expectedEtag,
          expectedRevisionId: params.expectedRevisionId,
          allowedFolders: allowedFolderIds,
        });
        return { ok: true, current };
      },
      execute: async (ctx = {}) => await updateDriveFile({
        bindingId,
        credentialsPath,
        fileId,
        name: params.name,
        mimeType: params.mimeType,
        content: params.content,
        expectedEtag: params.expectedEtag,
        expectedRevisionId: params.expectedRevisionId,
        requireConflictCheck: true,
        allowedFolderIds,
        idempotencyKey,
        mutationDigest,
        driveClient: ctx.driveClient || driveClient,
        onBeforeWire: ctx.onBeforeWire,
      }),
    };
  }

  if (capability === 'drive.file.share') {
    const fileId = assertSafeDriveId(params.fileId, 'fileId');
    const shareType = trimString(params.type).toLowerCase() || 'user';
    const shareRole = trimString(params.role).toLowerCase() || 'reader';
    const emailAddress = trimString(params.emailAddress).toLowerCase();
    const domain = trimString(params.domain).toLowerCase();
    const allowPublicExposure = params.allowPublicExposure === true;
    const scope = {
      connectorId: 'drive',
      resource: `share:${fileId}`,
      fileId,
      shareType,
      shareRole,
      ...(emailAddress ? { emailAddress } : {}),
      ...(domain ? { domain } : {}),
      publicExposure: shareType === 'anyone',
      ...(allowedFolderIds ? { allowedFolderIds } : {}),
      ...(bindingId ? { bindingId } : {}),
    };
    const receiptVerifier = {
      ...template.receiptVerifier,
      verify: async (ctx = {}) => await findDriveActionReceipt({
        bindingId,
        credentialsPath,
        actionKind: 'share_file',
        fileId,
        permissionId: ctx.result?.externalId || ctx.externalId,
        shareType,
        shareRole,
        shareEmail: emailAddress,
        shareDomain: domain,
        driveClient: ctx.driveClient || driveClient,
      }),
    };
    return {
      contract: { ...template, idempotencyKey, confirmationPolicy, timeoutMs, scope, receiptVerifier },
      payload: {
        fileId,
        type: shareType,
        role: shareRole,
        emailAddress,
        domain,
        sendNotificationEmail: params.sendNotificationEmail === true,
        allowPublicExposure,
      },
      precheck: async (ctx = {}) => {
        if (shareType === 'anyone' && !allowPublicExposure) {
          throw buildDriveError('Public Drive sharing ("anyone") is forbidden unless allowPublicExposure=true.', {
            code: 'CONNECTOR_PUBLIC_SHARE_FORBIDDEN',
            statusCode: 403,
          });
        }
        const resolved = await resolveDriveClient({
          bindingId,
          credentialsPath,
          driveClient: ctx.driveClient || driveClient,
        });
        if (resolved.error) {
          throw buildDriveError(resolved.error.message || 'Drive binding error', { code: 'CONNECTOR_BINDING_ERROR', statusCode: 409 });
        }
        const current = await verifyDriveFilePrecondition(resolved.drive, fileId, {
          allowedFolders: allowedFolderIds,
        });
        return { ok: true, current };
      },
      execute: async (ctx = {}) => await shareDriveFile({
        bindingId,
        credentialsPath,
        fileId,
        type: shareType,
        role: shareRole,
        emailAddress,
        domain,
        sendNotificationEmail: params.sendNotificationEmail === true,
        allowPublicExposure,
        allowedFolderIds,
        allowedShareEmails: params.allowedShareEmails ?? options.allowedShareEmails,
        allowedShareDomains: params.allowedShareDomains ?? options.allowedShareDomains,
        driveClient: ctx.driveClient || driveClient,
        onBeforeWire: ctx.onBeforeWire,
      }),
    };
  }

  throw buildDriveError(`Unsupported Drive connector capability: ${capability}`, {
    code: 'CONNECTOR_UNSUPPORTED_CAPABILITY',
    statusCode: 400,
  });
}

export async function executeDriveConnectorAction(capability, params = {}, context = {}) {
  const { dispatchConnectorAction } = await import('./connector-action-dispatcher.mjs');
  const action = createDriveConnectorAction(capability, params, {
    idempotencyKey: context.idempotencyKey || params.idempotencyKey,
    timeoutMs: context.timeoutMs,
    confirmationPolicy: context.confirmationPolicy,
    bindingId: context.bindingId,
    credentialsPath: context.credentialsPath,
    driveClient: context.driveClient,
    allowedFolderIds: context.allowedFolderIds,
    allowedShareEmails: context.allowedShareEmails,
    allowedShareDomains: context.allowedShareDomains,
  });
  return await dispatchConnectorAction(action, context);
}
