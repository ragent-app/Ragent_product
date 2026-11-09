import { readFile, readdir } from 'fs/promises';
import { createReadStream, watch } from 'fs';
import { request as httpRequest } from 'http';
import { homedir } from 'os';
import { join, resolve, dirname, basename, extname, relative, isAbsolute, sep } from 'path';
import { parse as parseUrl, fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { CHAT_IMAGES_DIR, MANAGED_WORK_ROOT_DIR } from '../lib/config.mjs';
import {
  authenticateBearerToken, authenticateAccountCookie, getAuthSession, refreshAuthSession,
} from '../lib/auth.mjs';
import { authenticateTrustedDeviceToken } from './trusted-devices.mjs';
import { createWindowsBrokerPendingReauthorizer } from './windows-broker-pending-reauthorization.mjs';
import { normalizeInstallHandoffToken } from '../lib/install-handoffs.mjs';
import { saveUiRuntimeSelection } from '../lib/runtime-selection.mjs';
import { findSessionMeta } from './session-meta-store.mjs';
import { rejectUnadaptedTemporaryRequest } from './temporary-http-isolation.mjs';
import { authorizeTemporaryControl } from '../lib/temporary-control-policy.mjs';
import { getAvailableToolsAsync, saveSimpleToolAsync } from '../lib/tools.mjs';
import {
  appendAssistantMessage,
  cancelActiveRun,
  compactSession,
  createSession,
  delegateSession,
  dropToolUse,
  forkSession,
  getHistory,
  getRunState,
  resolveSavedAttachments,
  saveAttachments,
  getSession,
  getSessionEventsAfter,
  requestSessionConfirmation,
  getSessionSourceContext,
  getSessionTimelineEvents,
  listSessions,
  renameSession,
  resolveAttachmentMimeType,
  saveSessionAsTemplate,
  sendMessage,
  sendUserMessage,
  setSessionPinned,
  updateSessionEntryMode,
  updateSessionLastReviewedAt,
  updateSessionGrouping,
  updateSessionAgreements,
  updateSessionWorkflowClassification,
  updateSessionRuntimePreferences,
  proposeApprovedActions,
  recoverRunAuthFailure,
  resolveSessionRiskModeForRun,
} from './session-manager.mjs';
import { normalizeSessionEntryMode } from './session-entry-mode.mjs';
import {
  createTrigger,
  deleteTrigger,
  getTrigger,
  listTriggers,
  updateTrigger,
} from './triggers.mjs';
import {
  normalizeSessionWorkflowPriority,
  normalizeSessionWorkflowState,
} from './session-workflow-state.mjs';
import { readEventBody, readRuntimeApprovalEvents } from './history.mjs';
import { getPublicKey, addSubscription } from './push.mjs';
import { getModelsForTool } from './models.mjs';
import { createSessionDetail, createSessionListItem } from './session-api-shapes.mjs';
import { getRun, getRunManifest, renewRunSessionControlCapability } from './runs.mjs';
import { buildEventBlockEvents, buildSessionDisplayEvents } from './session-display-events.mjs';
import { parseSessionGetRoute } from './session-route-utils.mjs';
import { escapeHtml, readBody } from '../lib/utils.mjs';
import {
  getClientIp, isRateLimited, recordFailedAttempt, clearFailedAttempts,
  setSecurityHeaders, generateNonce, requireAuth,
} from './middleware.mjs';
import { BoundedLruMap } from './cache-utils.mjs';
import { registerLruOrMap } from './memory-registry.mjs';
import { statOrNull } from './fs-utils.mjs';
import { broadcastAll } from './ws-clients.mjs';
import { cacheBudget } from '../lib/cache-budget.mjs';

// In-memory static-asset cache (bounded; see the static branch below).
const staticAssetCache = new BoundedLruMap({
  maxEntries: 160,
  maxBytes: cacheBudget('router.staticAssets', 1),
  bytesOf: (entry) => entry?.bytes?.length || 0,
});
// Memory registry (DS-06): static asset read-through cache.
registerLruOrMap('router.staticAssets', staticAssetCache, { kind: 'static-assets' });

// `utimes(2)` and Node's floating-point mtime conversion can differ by a
// fraction of a millisecond even when the underlying filesystem timestamp is
// restored to the same value.  Compare the stable millisecond bucket so a
// harmless sub-ms representation drift does not defeat the read-through
// cache; writes that cross a millisecond still invalidate normally.
function staticAssetMtimeFingerprint(mtimeMs) {
  return Number.isFinite(mtimeMs) ? Math.trunc(mtimeMs) : null;
}

function isStaticAssetCacheVersionEqual(cached, stats) {
  return Boolean(
    cached
      && stats
      && cached.size === stats.size
      && cached.mtimeFingerprint === staticAssetMtimeFingerprint(stats.mtimeMs),
  );
}
import { createConnectivityPolicyEngine } from '../lib/connectivity-policy-engine.mjs';

import { handlePublicRoutes } from './router-public-routes.mjs';
import { handleControlRoutes } from './router-control-routes.mjs';
import { handleLocalBridgeOwnerRoutes, handleLocalBridgePublicRoutes } from './router-local-bridge-routes.mjs';
import { handleDevicePairingOwnerRoutes, handleDevicePairingPublicRoutes } from './router-device-pairing-routes.mjs';
import { handleDeviceAuthPublicRoutes } from './router-device-auth-routes.mjs';
import { handleConnectionBootstrapRoutes } from './router-connection-bootstrap-routes.mjs';
import { handleConnectivityOwnerRoutes } from './router-connectivity-routes.mjs';
import { handleGoogleOwnerAuthRoutes } from './router-google-owner-routes.mjs';
import { handleWebConnectivityAcceptanceRoutes } from './web-connectivity-acceptance.mjs';
import { handleDeviceHandshakeRoutes } from './router-device-handshake-routes.mjs';
import { handleEntrySwitchRoutes } from './router-entry-switch-routes.mjs';
import { handleProviderSyncRoutes } from './router-provider-sync-routes.mjs';
import { handleTargetRuntimeGatewayRoutes } from './router-target-runtime-routes.mjs';
import { handleEntrySwitchJoin } from './router-entry-switch-join.mjs';
import {
  handleCalendarFeedRoute,
  handleConnectorApiRoutes,
  handleConnectorSurfaceRoutes,
} from './router-connector-routes.mjs';
import { handleCodexMcpRoutes } from './router-codex-mcp-routes.mjs';
import { handleClaudeMcpRoutes } from './router-claude-mcp-routes.mjs';
import { handleAgyRoutes } from './router-agy-routes.mjs';
import { handleHarnessRoutes } from './router-harness-routes.mjs';
import { handleSessionMainRoutes } from './router-session-main-routes.mjs';
import { handleApprovedActionInternalRoutes } from './router-approved-action-routes.mjs';
import { handleWindowsBrokerInternalRoutes } from './router-windows-broker-internal-routes.mjs';
import { handleBrowserInternalRoutes } from './router-browser-internal-routes.mjs';
import { handleRunAuthRecoveryInternalRoutes } from './router-run-auth-recovery-routes.mjs';
import { handleTemporaryControlRunCheck } from './router-temporary-control-run-check.mjs';
import { handleSessionControlInternalRoutes } from './router-session-control-routes.mjs';
import { handleCollaborationRoutes } from './router-collaboration-routes.mjs';
import { handleOrchestrationRoutes } from './router-orchestration-routes.mjs';
import { handleOrganizationRoutes } from './router-organization-routes.mjs';
import { handleConsultationRoutes } from './router-consultation-routes.mjs';
import { handleProjectWorkflowRoutes } from './router-project-workflow-routes.mjs';
import { getDefaultCollaborationOrchestrator } from './collaboration-orchestrator.mjs';
import { authenticateCollaborationCapability } from './collaboration-capability.mjs';
import {
  createSessionControlDetailedAuthenticator,
  createSessionControlRenewalAuthenticator,
} from './session-control-capability.mjs';
import { createRunAuthRecoveryAuthenticator } from './run-auth-recovery-capability.mjs';
import {
  MANAGED_SESSION_INPUT_BYPASS,
  assertManagedInputAllowed,
  parseManagedInputBypassRoute,
} from './managed-input.mjs';
import {
  authenticateTargetRuntimeRequest,
  createTargetRuntimeResponse,
} from '../lib/target-runtime-auth.mjs';
import {
  resolveAuthSessionAgentId,
  resolveAuthSessionPrincipalId,
  resolveSessionAgentId,
  resolveSessionPrincipalId,
} from './session-source-resolution.mjs';
import {
  buildFileAssetDirectUrl,
  createFileAssetUploadIntent,
  finalizeFileAssetUpload,
  getFileAsset,
  getFileAssetBootstrapConfig,
  getFileAssetForClient,
  publishLocalFileAssetFromPath,
} from './file-assets.mjs';

// Paths are resolved from the running project root on each request.
const __dirname = dirname(fileURLToPath(import.meta.url));
const chatTemplatePath = join(__dirname, '..', 'templates', 'chat.html');
const loginTemplatePath = join(__dirname, '..', 'templates', 'login.html');
const mobileInstallTemplatePath = join(__dirname, '..', 'templates', 'mobile-install.html');
const parentEnglishCoursewareTemplatePath = join(__dirname, '..', 'templates', 'parent-english-courseware.html');
const staticDir = join(__dirname, '..', 'static');
const packageJsonPath = join(__dirname, '..', 'package.json');
const packageBuildVersionPath = join(__dirname, '..', '.agentoc-package-version');
const serviceBuildRoots = [
  join(__dirname, '..', 'chat'),
  join(__dirname, '..', 'lib'),
  join(__dirname, '..', 'chat-server.mjs'),
  packageJsonPath,
];

const serviceBuildStatusPaths = ['chat', 'lib', 'chat-server.mjs', 'package.json'];
const ADMIN_PROXY_PREFIX = '/admin';
const ADMIN_UPSTREAM_HOST = process.env.CHAT_ADMIN_UPSTREAM_HOST || '127.0.0.1';
const ADMIN_UPSTREAM_PORT = Number.parseInt(process.env.CHAT_ADMIN_UPSTREAM_PORT || '7689', 10) || 7689;

const devicePolicyEngine = createConnectivityPolicyEngine();
const reauthorizeBrokerPending = createWindowsBrokerPendingReauthorizer({
  authenticateTrustedDeviceToken,
  getAuthSession,
  devicePolicyEngine,
});
const authenticateSessionControlDetailed = createSessionControlDetailedAuthenticator({ getSessionImpl: getSession });
const authenticateSessionControlRenewal = createSessionControlRenewalAuthenticator({
  getRunImpl: getRun,
  getRunManifestImpl: getRunManifest,
});
const authenticateRunAuthRecovery = createRunAuthRecoveryAuthenticator({
  getRunImpl: getRun,
  getRunManifestImpl: getRunManifest,
});

function isLoopbackRequest(req) {
  const remoteAddress = trimString(req?.socket?.remoteAddress || req?.connection?.remoteAddress);
  return !remoteAddress || remoteAddress === '127.0.0.1' || remoteAddress === '::1'
    || remoteAddress === '::ffff:127.0.0.1';
}

const execFileAsync = promisify(execFile);
const BUILD_INFO = await loadBuildInfo();
const pageBuildRoots = [
  join(__dirname, '..', 'templates'),
  staticDir,
];
let cachedPageBuildInfo = null;
const frontendBuildWatchers = [];
let frontendBuildInvalidationTimer = null;

async function listSessionsForClient(options = {}) {
  const sessions = await listSessions(options);
  return sessions.map(createClientSessionDetail);
}

async function listSessionListItemsForClient(options = {}) {
  const sessions = await listSessions(options);
  return sessions.map(createSessionListItem);
}

async function getSessionForClient(id, options = {}) {
  return createClientSessionDetail(await getSession(id, options));
}

async function getSessionListItemForClient(id, options = {}) {
  return createSessionListItem(await getSession(id, options));
}

function createClientSessionDetail(session) {
  return createSessionDetail(session);
}

const staticMimeTypesByExtension = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.map': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.ttf': 'font/ttf',
  '.webmanifest': 'application/manifest+json',
  '.webp': 'image/webp',
  '.webm': 'video/webm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const staticDirResolved = resolve(staticDir);
// Keep JSON messages deliberately small: readBody() materializes the request
// string and JSON.parse creates a second object graph.  Multipart uploads get
// a separate (still bounded) budget because binary attachments are handled by
// the asset pipeline and must not share the JSON budget.
const MESSAGE_JSON_MAX_BYTES = Math.max(
  256 * 1024,
  Number.parseInt(process.env.AGENTOC_MESSAGE_JSON_MAX_BYTES || String(4 * 1024 * 1024), 10)
    || 4 * 1024 * 1024,
);
const MESSAGE_MULTIPART_MAX_BYTES = Math.max(
  MESSAGE_JSON_MAX_BYTES,
  Number.parseInt(process.env.AGENTOC_MESSAGE_MULTIPART_MAX_BYTES || String(64 * 1024 * 1024), 10)
    || 64 * 1024 * 1024,
);
const uploadedMediaMimeTypes = {
  csv: 'text/csv; charset=utf-8',
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  json: 'application/json',
  m4a: 'audio/mp4',
  m4v: 'video/x-m4v',
  md: 'text/markdown; charset=utf-8',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  ogg: 'audio/ogg',
  ogv: 'video/ogg',
  pdf: 'application/pdf',
  png: 'image/png',
  txt: 'text/plain; charset=utf-8',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  wav: 'audio/wav',
  webm: 'video/webm',
  webp: 'image/webp',
  zip: 'application/zip',
};
const ATTACHMENT_PUBLISH_CONCURRENCY = 4;

async function mapWithAttachmentPublishConcurrency(items, mapper) {
  const list = Array.isArray(items) ? items : [];
  if (list.length <= 1) return Promise.all(list.map(mapper));
  const results = new Array(list.length);
  let cursor = 0;
  const workers = Array.from({
    length: Math.min(ATTACHMENT_PUBLISH_CONCURRENCY, list.length),
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

function bodyTooLargeError() {
  return Object.assign(new Error('Request body too large'), { code: 'BODY_TOO_LARGE' });
}

function getMultipartBodyLength(req) {
  const rawLength = Array.isArray(req.headers['content-length'])
    ? req.headers['content-length'][0]
    : req.headers['content-length'];
  const parsedLength = Number.parseInt(rawLength || '', 10);
  return Number.isFinite(parsedLength) && parsedLength >= 0 ? parsedLength : null;
}

function parseFormString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseFormJson(value, fallback) {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

async function readSessionMessagePayload(req, pathname) {
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (!contentType.startsWith('multipart/form-data')) {
    const body = await readBody(req, MESSAGE_JSON_MAX_BYTES);
    const payload = JSON.parse(body);
    const attachments = Array.isArray(payload?.attachments)
      ? payload.attachments.filter(Boolean)
      : (Array.isArray(payload?.images) ? payload.images.filter(Boolean) : []);
    return {
      sessionId: typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : '',
      requestId: typeof payload?.requestId === 'string' ? payload.requestId.trim() : '',
      runId: typeof payload?.runId === 'string' ? payload.runId.trim() : '',
      text: typeof payload?.text === 'string' ? payload.text : '',
      tool: typeof payload?.tool === 'string' ? payload.tool.trim() : '',
      providerProfile: typeof payload?.providerProfile === 'string' ? payload.providerProfile.trim() : '',
      model: typeof payload?.model === 'string' ? payload.model.trim() : '',
      effort: typeof payload?.effort === 'string' ? payload.effort.trim() : '',
      interactionMode: typeof payload?.interactionMode === 'string' ? payload.interactionMode.trim() : '',
      permissionMode: typeof payload?.permissionMode === 'string' ? payload.permissionMode.trim() : '',
      planAction: typeof payload?.planAction === 'string' ? payload.planAction.trim() : '',
      planId: typeof payload?.planId === 'string' ? payload.planId.trim() : '',
      harnessCapabilityIds: Array.isArray(payload?.harnessCapabilityIds) ? payload.harnessCapabilityIds : [],
      agentId: typeof payload?.agentId === 'string' ? payload.agentId.trim() : '',
      templateId: typeof payload?.templateId === 'string' ? payload.templateId.trim() : '',
      thinking: payload?.thinking === true,
      source: typeof payload?.source === 'string' ? payload.source.trim() : '',
      sourceContext: payload?.sourceContext && typeof payload.sourceContext === 'object' ? payload.sourceContext : null,
      uiLanguage: typeof payload?.uiLanguage === 'string' ? payload.uiLanguage.trim() : '',
      attachments,
    };
  }

  const contentLength = getMultipartBodyLength(req);
  if (contentLength !== null && contentLength > MESSAGE_MULTIPART_MAX_BYTES) {
    throw bodyTooLargeError();
  }

  const formRequest = new Request(`http://127.0.0.1${pathname}`, {
    method: req.method,
    headers: req.headers,
    body: req,
    duplex: 'half',
  });
  const formData = await formRequest.formData();
  const attachments = [];
  for (const fieldName of ['attachments', 'images']) {
    for (const entry of formData.getAll(fieldName)) {
      if (!entry || typeof entry.arrayBuffer !== 'function') continue;
      attachments.push({
        buffer: Buffer.from(await entry.arrayBuffer()),
        mimeType: typeof entry.type === 'string' ? entry.type : '',
        originalName: typeof entry.name === 'string' ? entry.name : '',
      });
    }
  }

  for (const fieldName of ['existingAttachments', 'existingImages']) {
    const existingAttachments = parseFormJson(parseFormString(formData.get(fieldName)), []);
    if (!Array.isArray(existingAttachments)) continue;
    for (const image of existingAttachments) {
      if (!image || typeof image !== 'object') continue;
      if (typeof image.filename !== 'string' || !image.filename.trim()) continue;
      attachments.push({
        filename: image.filename.trim(),
        originalName: parseFormString(image.originalName),
        mimeType: parseFormString(image.mimeType),
      });
    }
  }

  for (const fieldName of ['externalAttachments', 'externalAssets']) {
    const externalAssets = parseFormJson(parseFormString(formData.get(fieldName)), []);
    if (!Array.isArray(externalAssets)) continue;
    for (const asset of externalAssets) {
      if (!asset || typeof asset !== 'object') continue;
      if (typeof asset.assetId !== 'string' || !asset.assetId.trim()) continue;
      attachments.push({
        assetId: asset.assetId.trim(),
        originalName: parseFormString(asset.originalName),
        mimeType: parseFormString(asset.mimeType),
        ...(parseFormString(asset.renderAs) === 'file' ? { renderAs: 'file' } : {}),
      });
    }
  }

  return {
    sessionId: parseFormString(formData.get('sessionId')),
    requestId: parseFormString(formData.get('requestId')),
    runId: parseFormString(formData.get('runId')),
    text: parseFormString(formData.get('text')),
    tool: parseFormString(formData.get('tool')),
    providerProfile: parseFormString(formData.get('providerProfile')),
    model: parseFormString(formData.get('model')),
    effort: parseFormString(formData.get('effort')),
    interactionMode: parseFormString(formData.get('interactionMode')),
    permissionMode: parseFormString(formData.get('permissionMode')),
    planAction: parseFormString(formData.get('planAction')),
    planId: parseFormString(formData.get('planId')),
    harnessCapabilityIds: parseFormJson(parseFormString(formData.get('harnessCapabilityIds')), []),
    agentId: parseFormString(formData.get('agentId')),
    templateId: parseFormString(formData.get('templateId')),
    thinking: parseFormString(formData.get('thinking')) === 'true',
    source: parseFormString(formData.get('source')),
    sourceContext: parseFormJson(parseFormString(formData.get('sourceContext')), null),
    uiLanguage: parseFormString(formData.get('uiLanguage')),
    attachments,
  };
}

async function resolveRequestedSessionAttachments(authSession, requestedAttachments = [], options = {}) {
  const sessionId = typeof options?.sessionId === 'string' ? options.sessionId.trim() : '';
  const allowLocalPaths = options?.allowLocalPaths === true;
  const createdBy = typeof options?.createdBy === 'string' && options.createdBy.trim()
    ? options.createdBy.trim()
    : (authSession?.role === 'visitor' ? 'visitor' : 'owner');
  const uploadedAttachments = requestedAttachments.filter((attachment) => Buffer.isBuffer(attachment?.buffer) || typeof attachment?.data === 'string');
  const existingAttachments = requestedAttachments.filter((attachment) => typeof attachment?.filename === 'string' && attachment.filename.trim() && !attachment?.assetId);
  const localPathAttachments = requestedAttachments.filter((attachment) => typeof attachment?.localPath === 'string' && attachment.localPath.trim());
  const externalAssetAttachments = [];

  if (localPathAttachments.length > 0 && !allowLocalPaths) {
    const error = new Error('localPath attachments are not supported on this route');
    error.statusCode = 400;
    throw error;
  }

  for (const attachment of localPathAttachments) {
    if (!sessionId) {
      const error = new Error('sessionId is required for localPath attachments');
      error.statusCode = 400;
      throw error;
    }
    const originalName = typeof attachment?.originalName === 'string' && attachment.originalName.trim()
      ? attachment.originalName.trim()
      : basename(attachment.localPath);
    const mimeType = resolveAttachmentMimeType(
      typeof attachment?.mimeType === 'string' ? attachment.mimeType.trim() : '',
      originalName,
    );
    const published = await publishLocalFileAssetFromPath({
      sessionId,
      localPath: attachment.localPath,
      originalName,
      mimeType,
      createdBy,
    });
    externalAssetAttachments.push({
      assetId: published.id,
      originalName,
      mimeType,
      ...(Number.isInteger(published?.sizeBytes) && published.sizeBytes > 0 ? { sizeBytes: published.sizeBytes } : {}),
      ...(typeof attachment?.renderAs === 'string' && attachment.renderAs.trim() === 'file' ? { renderAs: 'file' } : {}),
    });
  }

  for (const attachment of requestedAttachments) {
    const assetId = typeof attachment?.assetId === 'string' ? attachment.assetId.trim() : '';
    if (!assetId) continue;
    const asset = await getFileAsset(assetId);
    if (!asset) {
      const error = new Error(`Unknown asset: ${assetId}`);
      error.statusCode = 400;
      throw error;
    }
    if (sessionId && asset.sessionId !== sessionId) {
      const error = new Error('File asset is bound to a different session');
      error.statusCode = 403;
      throw error;
    }
    if (!(authSession && (
      authSession.role === 'owner'
      || await canAccessSession(authSession, asset.sessionId)
    ))) {
      const error = new Error('Forbidden');
      error.statusCode = 403;
      throw error;
    }
    if (asset.status !== 'ready') {
      const error = new Error(`Asset is not ready: ${assetId}`);
      error.statusCode = 409;
      throw error;
    }
    externalAssetAttachments.push({
      assetId: asset.id,
      originalName: typeof attachment?.originalName === 'string' && attachment.originalName.trim()
        ? attachment.originalName.trim()
        : asset.originalName,
      mimeType: typeof attachment?.mimeType === 'string' && attachment.mimeType.trim()
        ? attachment.mimeType.trim()
        : asset.mimeType,
      ...(Number.isInteger(asset?.sizeBytes) && asset.sizeBytes > 0 ? { sizeBytes: asset.sizeBytes } : {}),
      ...(typeof attachment?.renderAs === 'string' && attachment.renderAs.trim() === 'file' ? { renderAs: 'file' } : {}),
    });
  }

  const savedUploadedAttachments = uploadedAttachments.length > 0
    ? await saveAttachments(uploadedAttachments)
    : [];
  const normalizedUploadedAttachments = options?.publishToFileAsset === false
    ? savedUploadedAttachments
    : await maybePublishSavedAttachmentsToFileAssets(savedUploadedAttachments, {
      sessionId,
      createdBy,
    });
  const savedExistingAttachments = await resolveSavedAttachments(existingAttachments);
  const normalizedExistingAttachments = options?.publishToFileAsset === false
    ? savedExistingAttachments
    : await maybePublishSavedAttachmentsToFileAssets(savedExistingAttachments, {
      sessionId,
      createdBy,
    });

  return [
    ...normalizedExistingAttachments,
    ...normalizedUploadedAttachments,
    ...externalAssetAttachments,
  ];
}

async function maybePublishSavedAttachmentsToFileAssets(savedAttachments = [], options = {}) {
  const sessionId = typeof options?.sessionId === 'string' ? options.sessionId.trim() : '';
  if (savedAttachments.length === 0) return [];
  if (!sessionId) {
    const error = new Error('sessionId is required to stage uploaded attachments');
    error.statusCode = 400;
    error.code = 'FILE_ASSET_SESSION_REQUIRED';
    throw error;
  }
  return mapWithAttachmentPublishConcurrency(savedAttachments, async (attachment) => {
    const published = await publishLocalFileAssetFromPath({
      sessionId,
      localPath: attachment.savedPath,
      originalName: attachment.originalName,
      mimeType: attachment.mimeType,
      createdBy: options?.createdBy,
    });
    return {
      assetId: published.id,
      originalName: published.originalName || attachment.originalName,
      mimeType: published.mimeType || attachment.mimeType,
      ...(Number.isInteger(published?.sizeBytes) && published.sizeBytes > 0 ? { sizeBytes: published.sizeBytes } : {}),
      ...(typeof attachment?.renderAs === 'string' && attachment.renderAs.trim() === 'file'
        ? { renderAs: 'file' }
        : {}),
    };
  });
}

function formatMtimeFingerprint(mtimeMs, fallbackSeed = Date.now()) {
  const numericValue = Number.isFinite(mtimeMs) && mtimeMs > 0 ? mtimeMs : fallbackSeed;
  return Math.round(numericValue).toString(36);
}

async function hasDirtyRepoPaths(paths) {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain', '--untracked-files=all', '--', ...paths], {
      cwd: join(__dirname, '..'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

async function loadBuildInfo() {
  let version = 'dev';
  try {
    const packagedVersion = (await readFile(packageBuildVersionPath, 'utf8')).trim();
    if (packagedVersion) version = packagedVersion;
  } catch {}
  try {
    const pkg = JSON.parse(await readFile(packageJsonPath, 'utf8'));
    if (version === 'dev' && pkg?.version) version = String(pkg.version);
  } catch {}

  let commit = '';
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: join(__dirname, '..'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    commit = stdout.trim();
  } catch {}

  const runtimeMode = 'source';
  const serviceDirty = await hasDirtyRepoPaths(serviceBuildStatusPaths);
  const buildRootTimes = await Promise.all(serviceBuildRoots.map((root) => getLatestMtimeMs(root)));
  const computedFingerprint = formatMtimeFingerprint(Math.max(...buildRootTimes, 0));
  const serviceFingerprint = serviceDirty ? computedFingerprint : '';
  const serviceRevisionBase = commit || '';
  const serviceRevisionLabel = serviceRevisionBase
    ? (serviceDirty ? `${serviceRevisionBase}*` : serviceRevisionBase)
    : (serviceDirty ? 'working*' : '');
  const serviceLabelParts = [`Ver ${version}`];
  if (serviceRevisionLabel) serviceLabelParts.push(serviceRevisionLabel);
  const serviceLabel = serviceLabelParts.join(' · ');
  const serviceAssetVersion = sanitizeAssetVersion([
    version,
    commit || 'working',
    serviceDirty && serviceFingerprint ? `dirty-${serviceFingerprint}` : 'clean',
  ].filter(Boolean).join('-'));
  const serviceTitleParts = [`Service v${version}`];
  if (serviceRevisionLabel) serviceTitleParts.push(serviceRevisionLabel);
  if (serviceFingerprint) serviceTitleParts.push(`srv:${serviceFingerprint}`);
  const serviceTitle = serviceTitleParts.join(' · ');
  return {
    version,
    commit,
    assetVersion: serviceAssetVersion,
    label: serviceLabel,
    title: serviceTitle,
    serviceVersion: version,
    serviceCommit: commit,
    serviceDirty,
    serviceFingerprint,
    serviceAssetVersion,
    serviceLabel,
    serviceTitle,
    runtimeMode,
    releaseId: null,
    releaseCreatedAt: null,
  };
}

function renderPageTemplate(template, nonce, replacements = {}) {
  const merged = {
    NONCE: nonce,
    ASSET_VERSION: BUILD_INFO.assetVersion,
    BUILD_LABEL: BUILD_INFO.label,
    BUILD_TITLE: BUILD_INFO.title,
    BUILD_JSON: serializeJsonForScript(BUILD_INFO),
    PAGE_TITLE: 'Ragent Chat',
    PAGE_HEAD_TAGS: '',
    PRODUCT_BASE_HREF: '/',
    BODY_CLASS: '',
    BOOTSTRAP_JSON: serializeJsonForScript({ auth: null }),
    EXTRA_BOOTSTRAP_SCRIPTS: '',
    ...replacements,
  };
  if (!Object.prototype.hasOwnProperty.call(replacements, 'BOOTSTRAP_SCRIPT_TAGS')) {
    merged.BOOTSTRAP_SCRIPT_TAGS = [
      `<script nonce="${merged.NONCE}">window.__AGENTOC_BUILD__ = ${merged.BUILD_JSON};</script>`,
      `<script nonce="${merged.NONCE}">window.__AGENTOC_BOOTSTRAP__ = ${merged.BOOTSTRAP_JSON};</script>`,
    ].join('\n');
  }
  return Object.entries(merged).reduce(
    (output, [key, value]) => output.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), () => String(value ?? '')),
    template,
  );
}

function normalizeForwardedPrefix(value) {
  const trimmed = trimString(value);
  if (!trimmed) return '';
  const normalized = `/${trimmed.replace(/^\/+|\/+$/g, '')}`;
  return normalized === '/' ? '' : normalized;
}

function ensureDirectoryPathname(pathname) {
  const normalized = trimString(pathname);
  if (!normalized || normalized === '/') return '/';
  return `${normalized.replace(/\/+$/, '')}/`;
}

function getRequestProductBasePath(req) {
  return normalizeForwardedPrefix(req?.headers?.['x-forwarded-prefix']);
}

function buildTemplateReplacements(buildInfo, productBasePath = '') {
  return {
    ASSET_VERSION: buildInfo.assetVersion,
    BUILD_LABEL: buildInfo.label,
    BUILD_TITLE: buildInfo.title,
    BUILD_JSON: serializeJsonForScript(buildInfo),
    PRODUCT_BASE_HREF: ensureDirectoryPathname(productBasePath),
    INPUT_PLACEHOLDER_I18N_KEY: 'input.placeholder.message',
    INPUT_PLACEHOLDER_TEXT: 'Message...',
  };
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function getAuthPrincipalId(authSession) {
  return resolveAuthSessionPrincipalId(authSession);
}

function getAuthPrincipalKind(authSession) {
  if (authSession?.role === 'owner') return 'owner';
  return trimString(authSession?.principalKind) || 'visitor';
}

function getAuthSurfaceMode(authSession) {
  if (authSession?.role === 'owner') return 'owner';
  return trimString(authSession?.surfaceMode) || 'visitor';
}

function getAuthScopeAgentId(authSession) {
  return resolveAuthSessionAgentId(authSession);
}

function isAgentScopedAuthSession(authSession) {
  return !!(
    authSession
    && authSession.role === 'visitor'
    && getAuthSurfaceMode(authSession) === 'agent_scoped'
    && getAuthScopeAgentId(authSession)
    && getAuthPrincipalId(authSession)
  );
}

function getAuthCapabilities(authSession) {
  if (!authSession || authSession.role === 'owner') {
    return {
      listSessions: true,
      createSession: true,
      renameSession: true,
      deleteSession: true,
      pinSession: true,
      forkSession: true,
      uploadAttachments: true,
      downloadArtifacts: true,
      switchAgents: true,
      manageAgents: true,
      changeRuntime: true,
      organizeSessionList: true,
      publishShareSnapshot: true,
    };
  }

  const stored = authSession?.capabilities && typeof authSession.capabilities === 'object'
    ? authSession.capabilities
    : {};
  if (!isAgentScopedAuthSession(authSession)) {
    return {
      listSessions: false,
      createSession: false,
      renameSession: false,
      deleteSession: false,
      pinSession: false,
      forkSession: false,
      uploadAttachments: stored.uploadAttachments !== false,
      downloadArtifacts: stored.downloadArtifacts !== false,
      switchAgents: false,
      manageAgents: false,
      changeRuntime: false,
      organizeSessionList: false,
      publishShareSnapshot: false,
    };
  }
  return {
    listSessions: stored.listSessions !== false,
    createSession: stored.createSession !== false,
    renameSession: stored.renameSession !== false,
    deleteSession: stored.deleteSession === true,
    pinSession: stored.pinSession !== false,
    forkSession: stored.forkSession === true,
    uploadAttachments: stored.uploadAttachments !== false,
    downloadArtifacts: stored.downloadArtifacts !== false,
    switchAgents: stored.switchAgents === true,
    manageAgents: stored.manageAgents === true,
    changeRuntime: stored.changeRuntime === true,
    organizeSessionList: stored.organizeSessionList === true,
    publishShareSnapshot: stored.publishShareSnapshot === true,
  };
}

function getSessionAgentId(session) {
  return resolveSessionAgentId(session);
}

function getSessionPrincipalId(session) {
  return resolveSessionPrincipalId(session);
}

function isSessionVisibleToAuthSession(authSession, session) {
  if (!authSession || !session) return false;
  if (authSession.principalKind === 'temporary_device' || authSession.role === 'temporary') {
    return authSession.temporaryControlAdapter === true;
  }
  if (authSession.role === 'owner') return true;
  if (isAgentScopedAuthSession(authSession)) {
    return getSessionAgentId(session) === getAuthScopeAgentId(authSession)
      && getSessionPrincipalId(session) === getAuthPrincipalId(authSession);
  }
  return trimString(authSession?.sessionId) === trimString(session?.id);
}

function buildAuthInfo(authSession) {
  if (!authSession) return null;
  if (authSession.principalKind === 'temporary_device' || authSession.role === 'temporary') {
    return { role: 'temporary', principalKind: 'temporary_device', capabilities: [], businessAccessReady: false };
  }
  if (authSession.principalKind === 'run_capability') {
    return {
      role: 'run_capability',
      principalKind: 'run_capability',
      surfaceMode: getAuthSurfaceMode(authSession),
      sessionId: trimString(authSession.rootSessionId || authSession.sessionId),
      runId: trimString(authSession.runId),
      capabilityOperation: trimString(authSession.capabilityOperation),
    };
  }
  const info = {
    role: authSession.role === 'visitor' ? 'visitor' : 'owner',
    principalKind: getAuthPrincipalKind(authSession),
    surfaceMode: getAuthSurfaceMode(authSession),
    capabilities: getAuthCapabilities(authSession),
  };
  if (typeof authSession.preferredLanguage === 'string' && authSession.preferredLanguage.trim()) {
    info.preferredLanguage = authSession.preferredLanguage.trim();
  }
  if (info.role === 'visitor') {
    const agentId = getAuthScopeAgentId(authSession);
    const principalId = getAuthPrincipalId(authSession);
    info.agentId = agentId;
    if (authSession.sessionId) {
      info.sessionId = authSession.sessionId;
    }
    if (authSession.visitorId) {
      info.visitorId = authSession.visitorId;
    }
    if (principalId) {
      info.principalId = principalId;
    }
    if (agentId) {
      info.currentAgent = {
        id: agentId,
        name: trimString(authSession.agentName),
        tool: trimString(authSession.agentTool),
      };
    }
  }
  return info;
}

async function buildChatPageBootstrap(authSession) {
  return {
    auth: buildAuthInfo(authSession),
    assetUploads: getFileAssetBootstrapConfig(),
    defaultSessionFolder: MANAGED_WORK_ROOT_DIR,
    // The combined snapshot endpoint is a progressive enhancement.  Keeping
    // the capability in bootstrap lets older/static clients retain their
    // existing detail + events flow while current clients collapse the two
    // reads into one request.
    features: {
      sessionSnapshot: true,
    },
  };
}

async function getLatestMtimeMs(path) {
  const stat = await statOrNull(path);
  if (!stat) return 0;

  const ownMtime = Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : 0;
  if (!stat.isDirectory()) return ownMtime;

  let entries = [];
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return ownMtime;
  }

  const nestedTimes = await Promise.all(
    entries
      .filter((entry) => !isTransientFrontendPathSegment(entry.name))
      .map((entry) => getLatestMtimeMs(join(path, entry.name))),
  );

  return Math.max(ownMtime, ...nestedTimes, 0);
}

// dpkg replaces packaged frontend files through names such as
// `bootstrap.js.dpkg-new`. Those files are root-owned during the short
// unpack window and are not part of the live asset tree. Ignoring them keeps
// the watcher from logging EACCES and from invalidating the page fingerprint
// for a file that will be renamed or removed by dpkg moments later.
function isTransientFrontendPathSegment(value) {
  const name = String(value || '');
  return name.startsWith('.') || /\.(?:dpkg-(?:new|old|dist|tmp)|ucf-(?:old|dist|new))$/.test(name);
}

function isTransientFrontendWatchError(error) {
  if (error?.code !== 'EACCES') return false;
  const match = String(error?.message || '').match(/watch ['"]([^'"]+)['"]$/);
  return !!match && isTransientFrontendPathSegment(basename(match[1]));
}

function sanitizeAssetVersion(value) {
  return String(value || 'dev').replace(/[^a-zA-Z0-9._-]+/g, '-');
}

export async function getPageBuildInfo() {
  const now = Date.now();
  if (cachedPageBuildInfo && now - cachedPageBuildInfo.cachedAt < 250) {
    return cachedPageBuildInfo.info;
  }

  let latestMtimeMs = 0;
  for (const root of pageBuildRoots) {
    latestMtimeMs = Math.max(latestMtimeMs, await getLatestMtimeMs(root));
  }

  const frontendFingerprint = latestMtimeMs > 0
    ? Math.round(latestMtimeMs).toString(36)
    : now.toString(36);
  const frontendLabel = `ui:${frontendFingerprint}`;
  const frontendTitle = `Frontend ${frontendLabel}`;
  const assetVersion = sanitizeAssetVersion([
    BUILD_INFO.serviceAssetVersion || BUILD_INFO.assetVersion || 'service',
    frontendFingerprint,
  ].filter(Boolean).join('-'));
  const info = {
    ...BUILD_INFO,
    assetVersion,
    frontendFingerprint,
    frontendLabel,
    frontendTitle,
    label: `${BUILD_INFO.serviceLabel} · ${frontendLabel}`,
    title: `${BUILD_INFO.serviceTitle} · ${frontendTitle}`,
  };

  cachedPageBuildInfo = {
    cachedAt: now,
    info,
  };
  return info;
}

function scheduleFrontendBuildInvalidation() {
  cachedPageBuildInfo = null;
  if (frontendBuildInvalidationTimer) return;
  frontendBuildInvalidationTimer = setTimeout(async () => {
    frontendBuildInvalidationTimer = null;
    try {
      const buildInfo = await getPageBuildInfo();
      broadcastAll({ type: 'build_info', buildInfo });
    } catch (error) {
      console.error(`[build] frontend update broadcast failed: ${error.message}`);
    }
  }, 120);
  if (typeof frontendBuildInvalidationTimer.unref === 'function') {
    frontendBuildInvalidationTimer.unref();
  }
}

function startFrontendBuildWatchers() {
  if (frontendBuildWatchers.length > 0) return;
  for (const root of pageBuildRoots) {
    try {
      const watcher = watch(root, { recursive: true }, (_eventType, filename) => {
        const changedPath = String(filename || '');
        if (changedPath) {
          const segments = changedPath.split(/[\\/]+/).filter(Boolean);
          if (segments.some((segment) => isTransientFrontendPathSegment(segment))) {
            return;
          }
        }
        scheduleFrontendBuildInvalidation();
      });
      watcher.on('error', (error) => {
        if (isTransientFrontendWatchError(error)) return;
        console.error(`[build] frontend watcher error for ${root}: ${error.message}`);
      });
      frontendBuildWatchers.push(watcher);
    } catch (error) {
      console.warn(`[build] frontend watcher disabled for ${root}: ${error.message}`);
    }
  }
}

startFrontendBuildWatchers();

export function stopFrontendBuildWatchers() {
  for (const watcher of frontendBuildWatchers) watcher.close();
  frontendBuildWatchers.length = 0;
  if (frontendBuildInvalidationTimer) clearTimeout(frontendBuildInvalidationTimer);
  frontendBuildInvalidationTimer = null;
}

function getSingleQueryValue(value) {
  if (Array.isArray(value)) return value[0] || '';
  return typeof value === 'string' ? value : '';
}

function hasVersionedAssetTag(query = {}) {
  return getSingleQueryValue(query?.v).trim().length > 0;
}

function isAbsoluteAssetUrl(value = '') {
  const trimmed = String(value || '').trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('//')) return true;
  return /^[a-z][a-z0-9+.-]*:/i.test(trimmed);
}

function appendVersionTagToAssetUrl(assetUrl, versionTag) {
  const normalizedUrl = String(assetUrl || '').trim();
  const normalizedTag = String(versionTag || '').trim();
  if (!normalizedUrl || !normalizedTag || isAbsoluteAssetUrl(normalizedUrl)) {
    return normalizedUrl;
  }

  const hashIndex = normalizedUrl.indexOf('#');
  const baseUrl = hashIndex >= 0 ? normalizedUrl.slice(0, hashIndex) : normalizedUrl;
  const hash = hashIndex >= 0 ? normalizedUrl.slice(hashIndex) : '';
  if (!baseUrl || /(?:^|[?&])v=/.test(baseUrl)) {
    return normalizedUrl;
  }

  const separator = baseUrl.includes('?') ? '&' : '?';
  return `${baseUrl}${separator}v=${encodeURIComponent(normalizedTag)}${hash}`;
}

function findQuotedImportUrl(line) {
  const singleQuoteIndex = line.indexOf("'");
  const doubleQuoteIndex = line.indexOf('"');
  if (singleQuoteIndex < 0 && doubleQuoteIndex < 0) return null;

  const useSingleQuote = singleQuoteIndex >= 0 && (doubleQuoteIndex < 0 || singleQuoteIndex < doubleQuoteIndex);
  const startIndex = useSingleQuote ? singleQuoteIndex : doubleQuoteIndex;
  const quote = useSingleQuote ? "'" : '"';
  const endIndex = line.indexOf(quote, startIndex + 1);
  if (endIndex < 0) return null;

  return {
    startIndex,
    endIndex,
    url: line.slice(startIndex + 1, endIndex),
  };
}

function rewriteCssImportUrls(content, versionTag) {
  const normalizedTag = String(versionTag || '').trim();
  if (!normalizedTag) return content;

  const source = Buffer.isBuffer(content)
    ? content.toString('utf8')
    : String(content || '');
  if (!source.includes('@import')) return content;

  let changed = false;
  const rewrittenSource = source
    .split('\n')
    .map((line) => {
      if (!line.includes('@import')) return line;
      const quotedImport = findQuotedImportUrl(line);
      if (!quotedImport?.url) return line;

      const versionedAssetUrl = appendVersionTagToAssetUrl(quotedImport.url, normalizedTag);
      if (!versionedAssetUrl || versionedAssetUrl === quotedImport.url) {
        return line;
      }

      changed = true;
      return `${line.slice(0, quotedImport.startIndex + 1)}${versionedAssetUrl}${line.slice(quotedImport.endIndex)}`;
    })
    .join('\n');

  return changed ? rewrittenSource : content;
}

async function resolveStaticAsset(pathname, query = {}) {
  if (!pathname.startsWith('/')) return null;

  const staticName = pathname.slice(1);
  if (!staticName || staticName.endsWith('/')) return null;

  const segments = staticName.split('/').filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => segment.startsWith('.'))) {
    return null;
  }

  const filepath = resolve(staticDirResolved, staticName);
  const relativePath = relative(staticDirResolved, filepath);
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    return null;
  }
  if (relativePath.split(sep).some((segment) => segment === '..' || segment.startsWith('.'))) {
    return null;
  }

  const stat = await statOrNull(filepath);
  if (!stat?.isFile()) return null;

  const filename = basename(filepath).toLowerCase();
  const extension = extname(filename);
  const contentType = filename === 'manifest.json'
    ? 'application/manifest+json'
    : staticMimeTypesByExtension[extension] || 'application/octet-stream';

  return {
    filepath,
    cacheControl: filename === 'sw.js'
      ? 'no-store, max-age=0, must-revalidate'
      : hasVersionedAssetTag(query)
        ? 'public, max-age=31536000, immutable'
        : 'public, no-cache, max-age=0, must-revalidate',
    contentType,
  };
}

function buildHeaders(headers = {}) {
  return {
    'X-AgentoC-Build': BUILD_INFO.title,
    ...headers,
  };
}

function streamResponse(res, filepath, headers = {}) {
  const stream = createReadStream(filepath);
  stream.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(500, buildHeaders({ 'Content-Type': 'application/json' }));
    }
    res.end(JSON.stringify({ error: 'Failed to read file' }));
  });
  res.writeHead(200, buildHeaders(headers));
  stream.pipe(res);
}

function writeJson(res, statusCode, payload) {
  res.writeHead(statusCode, buildHeaders({ 'Content-Type': 'application/json' }));
  res.end(JSON.stringify(payload));
}

function createJsonBody(value) {
  return JSON.stringify(value);
}

function createEtag(value) {
  return `"${createHash('sha1').update(value).digest('hex')}"`;
}

function normalizeEtag(value) {
  return String(value || '').trim().replace(/^W\//, '');
}

function requestHasFreshEtag(req, etag) {
  const header = req.headers['if-none-match'];
  if (!header) return false;
  const candidates = String(header)
    .split(',')
    .map((value) => normalizeEtag(value))
    .filter(Boolean);
  if (candidates.includes('*')) return true;
  return candidates.includes(normalizeEtag(etag));
}

function writeCachedResponse(req, res, {
  statusCode = 200,
  contentType,
  body,
  cacheControl,
  vary,
  headers: extraHeaders = {},
} = {}) {
  const etag = createEtag(body);
  const headers = {
    'Cache-Control': cacheControl,
    ETag: etag,
    'X-AgentoC-Build': BUILD_INFO.title,
    ...extraHeaders,
  };
  if (vary) headers.Vary = vary;

  if (requestHasFreshEtag(req, etag)) {
    res.writeHead(304, headers);
    res.end();
    return;
  }

  if (contentType) headers['Content-Type'] = contentType;
  res.writeHead(statusCode, headers);
  res.end(body);
}

function writeJsonCached(req, res, payload, {
  statusCode = 200,
  cacheControl = 'private, no-cache',
  vary = 'Cookie',
  headers,
} = {}) {
  writeCachedResponse(req, res, {
    statusCode,
    contentType: 'application/json',
    body: createJsonBody(payload),
    cacheControl,
    vary,
    headers,
  });
}

function createSessionSummaryPayload(session) {
  return { session: createSessionListItem(session) };
}

function createSessionSummaryEtag(session) {
  return createEtag(createJsonBody(createSessionSummaryPayload(session)));
}

function createSessionSummaryRef(session) {
  const projected = createSessionListItem(session);
  return {
    id: projected?.id,
    summaryEtag: createSessionSummaryEtag(projected),
  };
}

function writeFileCached(req, res, contentType, body, {
  cacheControl = 'public, no-cache',
  vary,
  headers,
} = {}) {
  writeCachedResponse(req, res, {
    statusCode: 200,
    contentType,
    body,
    cacheControl,
    vary,
    headers,
  });
}

const IMMUTABLE_PRIVATE_EVENT_CACHE_CONTROL = 'private, max-age=1296000, immutable';

async function canAccessSession(authSession, sessionId, { metadataOnly = false } = {}) {
  if (!authSession) return false;
  if (authSession.principalKind === 'run_capability') {
    const boundSessionId = authSession.surfaceMode === 'session_control'
      ? authSession.sessionId
      : (authSession.rootSessionId || authSession.sessionId);
    return trimString(sessionId) === trimString(boundSessionId);
  }
  if (authSession.principalKind === 'temporary_device' || authSession.role === 'temporary') {
    return authSession.temporaryControlAdapter === true;
  }
  if (authSession.role !== 'visitor') return true;
  const session = metadataOnly ? await findSessionMeta(sessionId) : await getSession(sessionId);
  return isSessionVisibleToAuthSession(authSession, session);
}

async function requireSessionAccess(res, authSession, sessionId, options) {
  if (await canAccessSession(authSession, sessionId, options)) return true;
  writeJson(res, 403, { error: 'Access denied' });
  return false;
}

async function isDirectoryPath(path) {
  return (await statOrNull(path))?.isDirectory() === true;
}

function serializeJsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function isOwnerOnlyRoute(pathname, method) {
  if (pathname.startsWith('/api/target-runtime/')) return true;
  if (pathname === '/api/runtime/summary' && method === 'GET') return true;
  if (pathname === '/api/target-runtime/context' && method === 'GET') return true;
  if (pathname === '/api/device-pairing/invitations' && method === 'POST') return true;
  if (pathname === '/api/device-pairing/devices' && method === 'GET') return true;
  if (/^\/api\/device-pairing\/devices\/[^/]+\/revoke$/.test(pathname) && method === 'POST') return true;
  if (pathname === '/api/native-providers' && ['GET', 'POST'].includes(method)) return true;
  if (/^\/api\/native-providers\/[^/]+\/quota$/.test(pathname) && method === 'GET') return true;
  if (/^\/api\/native-providers\/[^/]+\/quota\/refresh$/.test(pathname) && method === 'POST') return true;
  if (/^\/api\/native-providers\/[^/]+$/.test(pathname) && ['DELETE', 'PATCH'].includes(method)) return true;
  if (pathname === '/api/native-provider-oauth/jobs' && method === 'POST') return true;
  if (/^\/api\/native-provider-oauth\/jobs\/[^/]+\/input$/.test(pathname) && method === 'POST') return true;
  if (/^\/api\/native-provider-oauth\/jobs\/[^/]+$/.test(pathname) && ['GET', 'DELETE'].includes(method)) return true;
  if (pathname === '/api/triggers' && (method === 'GET' || method === 'POST')) return true;
  if (pathname.startsWith('/api/triggers/') && ['GET', 'PATCH', 'DELETE'].includes(method)) return true;
  if (pathname === '/api/managed-processes' && method === 'GET') return true;
  if (/^\/api\/managed-processes\/[^/]+$/.test(pathname) && ['GET', 'DELETE'].includes(method)) return true;
  if (/^\/api\/managed-processes\/[^/]+\/cancel$/.test(pathname) && method === 'POST') return true;
  if (/^\/api\/sessions\/[^/]+\/managed-processes$/.test(pathname) && method === 'POST') return true;
  if (pathname.startsWith('/api/sessions/')
      && (pathname.endsWith('/fork') || pathname.endsWith('/fork-at'))
      && method === 'POST') return true;
  if (pathname.startsWith('/api/sessions/') && pathname.endsWith('/delegate') && method === 'POST') return true;
  if (pathname === '/api/models' && method === 'GET') return true;
  if (pathname === '/api/tools' && (method === 'GET' || method === 'POST')) return true;
  if (pathname === '/api/harnesses' && method === 'GET') return true;
  if (/^\/api\/harnesses\/[^/]+\/install$/.test(pathname) && method === 'POST') return true;
  if (/^\/api\/harnesses\/[^/]+\/upgrade$/.test(pathname) && method === 'POST') return true;
  if (/^\/api\/harnesses\/[^/]+\/uninstall$/.test(pathname) && method === 'POST') return true;
  if (/^\/api\/harnesses\/[^/]+$/.test(pathname) && method === 'DELETE') return true;
  if (pathname === '/api/projects' && (method === 'GET' || method === 'POST')) return true;
  if (pathname.startsWith('/api/projects/') && ['GET', 'PATCH', 'DELETE'].includes(method)) return true;
  if (/^\/api\/projects\/[^/]+\/delete$/.test(pathname) && method === 'POST') return true;
  if (/^\/api\/projects\/[^/]+\/checkpoints$/.test(pathname) && ['GET', 'POST'].includes(method)) return true;
  if (/^\/api\/projects\/[^/]+\/handoffs$/.test(pathname) && method === 'POST') return true;
  if (/^\/api\/project-handoffs\/[^/]+\/accept$/.test(pathname) && method === 'POST') return true;
  if (pathname === '/api/autocomplete' && method === 'GET') return true;
  if ((pathname === '/api/workspace-files' || pathname === '/api/workspace-files/content') && method === 'GET') return true;
  if (pathname === '/api/browse' && method === 'GET') return true;
  if (pathname === '/api/browse/mkdir' && method === 'POST') return true;
  if (pathname === '/api/push/vapid-public-key' && method === 'GET') return true;
  if (pathname === '/api/push/subscribe' && method === 'POST') return true;
  if (pathname === '/api/agents' && (method === 'GET' || method === 'POST')) return true;
  if (pathname.startsWith('/api/agents/') && ['GET', 'PATCH', 'DELETE'].includes(method)) return true;
  if (pathname === '/api/account/password' && method === 'POST') return true;
  return false;
}

function parseTriggerRoute(pathname) {
  const match = /^\/api\/triggers\/(trg_[a-f0-9]{24})$/.exec(pathname || '');
  return match ? match[1] : null;
}

function parseFileAssetRoute(pathname) {
  const match = /^\/api\/assets\/(fasset_[a-f0-9]{24})(?:\/(download|finalize|upload|upload-checkpoint))?$/.exec(pathname || '');
  if (!match) return null;
  return {
    assetId: match[1],
    action: match[2] || null,
  };
}

function isAdminProxyPath(pathname) {
  return pathname === ADMIN_PROXY_PREFIX || pathname.startsWith(`${ADMIN_PROXY_PREFIX}/`);
}

function rewriteAdminLocationHeader(location) {
  const value = String(location || '').trim();
  if (!value) return value;
  if (value.startsWith(ADMIN_PROXY_PREFIX)) return value;
  if (value.startsWith('/')) return `${ADMIN_PROXY_PREFIX}${value}`;
  return value;
}

function rewriteAdminSetCookieHeader(headerValue) {
  const text = String(headerValue || '');
  const firstSemicolon = text.indexOf(';');
  const firstPart = firstSemicolon >= 0 ? text.slice(0, firstSemicolon) : text;
  const suffix = firstSemicolon >= 0 ? text.slice(firstSemicolon + 1) : '';
  const equalsIndex = firstPart.indexOf('=');
  if (equalsIndex < 0) return text;

  const originalName = firstPart.slice(0, equalsIndex).trim();
  const originalValue = firstPart.slice(equalsIndex + 1);
  const segments = suffix
    ? suffix.split(';').map((segment) => segment.trim()).filter(Boolean)
    : [];
  const filteredSegments = segments.filter((segment) => !/^path=/i.test(segment));
  filteredSegments.unshift(`Path=${ADMIN_PROXY_PREFIX}`);
  return `${originalName}=${originalValue}; ${filteredSegments.join('; ')}`;
}

async function proxyAdminRequest(req, res, parsedUrl) {
  const pathname = parsedUrl?.pathname || req.url || '/';
  const strippedPath = pathname.slice(ADMIN_PROXY_PREFIX.length) || '/';
  const upstreamPath = `${strippedPath}${parsedUrl?.search || ''}`;

  await new Promise((resolveProxy, rejectProxy) => {
    const upstreamReq = httpRequest({
      host: ADMIN_UPSTREAM_HOST,
      port: ADMIN_UPSTREAM_PORT,
      method: req.method,
      path: upstreamPath,
      headers: {
        ...req.headers,
        host: `${ADMIN_UPSTREAM_HOST}:${ADMIN_UPSTREAM_PORT}`,
        'accept-encoding': 'identity',
        'x-forwarded-prefix': ADMIN_PROXY_PREFIX,
      },
    }, (upstreamRes) => {
      const headers = { ...upstreamRes.headers };
      if (headers.location) {
        headers.location = rewriteAdminLocationHeader(headers.location);
      }
      if (headers['set-cookie']) {
        const values = Array.isArray(headers['set-cookie']) ? headers['set-cookie'] : [headers['set-cookie']];
        headers['set-cookie'] = values.map((value) => rewriteAdminSetCookieHeader(value));
      }
      res.writeHead(upstreamRes.statusCode || 502, headers);
      upstreamRes.pipe(res);
      upstreamRes.on('end', resolveProxy);
      upstreamRes.on('error', rejectProxy);
    });

    upstreamReq.on('error', rejectProxy);
    req.pipe(upstreamReq);
  }).catch((error) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`Admin upstream unavailable: ${error?.message || error}`);
    }
  });
}

export async function handleRequest(req, res) {
  if (rejectUnadaptedTemporaryRequest(req, res)) return;
  await authenticateAccountCookie(req);
  const parsedUrl = parseUrl(req.url, true);
  const pathname = parsedUrl.pathname;

  // Target-runtime requests use an Accounts-signed grant instead of an owner
  // cookie. Reject mixed credentials so the effective principal is explicit.
  let targetRuntimeAuth = null;
  if (req.headers?.['x-agentoc-target-grant']) {
    if (req.headers.cookie || req.headers.authorization) {
      writeJson(res, 400, {
        error: 'Target runtime grant cannot be combined with another credential',
        code: 'TARGET_RUNTIME_CREDENTIAL_MIXED',
      });
      return;
    }
    try {
      targetRuntimeAuth = await authenticateTargetRuntimeRequest(req);
    } catch (error) {
      writeJson(res, error?.statusCode || 401, {
        error: error?.message || 'Target runtime grant is invalid',
        code: error?.code || 'TARGET_GRANT_INVALID',
        ...(error?.details && typeof error.details === 'object' ? { details: error.details } : {}),
      });
      return;
    }
    if (targetRuntimeAuth?.replay) {
      for (const [name, value] of Object.entries(targetRuntimeAuth.replay.headers || {})) res.setHeader(name, value);
      res.writeHead(targetRuntimeAuth.replay.statusCode);
      res.end(targetRuntimeAuth.replay.body);
      return;
    }
    res = createTargetRuntimeResponse(res, targetRuntimeAuth);
  }

  if (isAdminProxyPath(pathname)) {
    if (!await requireAuth(req, res)) return;
    const authSession = getAuthSession(req);
    if (authSession?.role !== 'owner') {
      if (pathname === `${ADMIN_PROXY_PREFIX}/api` || pathname.startsWith(`${ADMIN_PROXY_PREFIX}/api/`)) {
        writeJson(res, 403, { error: 'Owner access required' });
        return;
      }
      res.writeHead(403, buildHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }));
      res.end('Owner access required');
      return;
    }
    await proxyAdminRequest(req, res, parsedUrl);
    return;
  }

  // Static assets. Previously read from disk (plus CSS URL rewrite) on every
  // request; now cached in memory keyed by file path + version tag, with an
  // mtime+size check per hit so the hot-reload contract is preserved (a
  // frontend build changes mtime → next request re-reads).
  const staticAsset = await resolveStaticAsset(pathname, parsedUrl.query);
  if (staticAsset) {
    try {
      const versionTag = getSingleQueryValue(parsedUrl.query?.v).trim();
      const cacheKey = `${staticAsset.filepath}:${versionTag}`;
      const stats = await statOrNull(staticAsset.filepath);
      const cached = staticAssetCache.get(cacheKey);
      if (isStaticAssetCacheVersionEqual(cached, stats)) {
        writeFileCached(req, res, staticAsset.contentType, cached.bytes, {
          cacheControl: staticAsset.cacheControl,
        });
        return;
      }
      const content = rewriteCssImportUrls(
        await readFile(staticAsset.filepath),
        staticAsset.contentType.startsWith('text/css') ? versionTag : '',
      );
      if (stats) {
        staticAssetCache.set(cacheKey, {
          bytes: content,
          mtimeFingerprint: staticAssetMtimeFingerprint(stats.mtimeMs),
          size: stats.size,
        });
      }
      writeFileCached(req, res, staticAsset.contentType, content, {
        cacheControl: staticAsset.cacheControl,
      });
    } catch {
      res.writeHead(404, buildHeaders({ 'Content-Type': 'text/plain' }));
      res.end('Not Found');
    }
    return;
  }

  const nonce = generateNonce();
  setSecurityHeaders(res, nonce);

  if (pathname === '/manifest.install.json' && req.method === 'GET') {
    try {
      const manifestTemplate = JSON.parse(await readFile(join(staticDir, 'manifest.json'), 'utf8'));
      const handoffToken = normalizeInstallHandoffToken(getSingleQueryValue(parsedUrl.query?.h));
      const manifest = {
        ...manifestTemplate,
        start_url: handoffToken
          ? `m/install?h=${encodeURIComponent(handoffToken)}`
          : 'm/install',
      };
      writeCachedResponse(req, res, {
        statusCode: 200,
        contentType: 'application/manifest+json',
        body: JSON.stringify(manifest, null, 2),
        cacheControl: 'private, no-store, max-age=0, must-revalidate',
        headers: {
          'Referrer-Policy': 'no-referrer',
          'X-Robots-Tag': 'noindex, nofollow, noarchive',
        },
      });
    } catch {
      res.writeHead(500, buildHeaders({ 'Content-Type': 'text/plain' }));
      res.end('Failed to load install manifest');
    }
    return;
  }

  if (await handleCalendarFeedRoute({ req, res, pathname })) {
    return;
  }

  if (await handleApprovedActionInternalRoutes({
    req,
    res,
    pathname,
    writeJson,
    proposeApprovedActions,
  })) {
    return;
  }

  if (await handleWindowsBrokerInternalRoutes({
    req, res, pathname, writeJson, getRun, getRunManifest, getSession,
    resolveSessionRiskMode: resolveSessionRiskModeForRun,
  })) return;

  if (await handleBrowserInternalRoutes({
    req,
    res,
    pathname,
    writeJson,
    getRun,
    getRunManifest,
    readRuntimeApprovalEvents,
    requestSessionConfirmation,
  })) {
    return;
  }

  // Detached providers use a short-lived Run-scoped capability to request
  // local credential recovery.  This route must be handled before the owner
  // auth gate, and its authenticator enforces a strict loopback address.
  if (await handleTemporaryControlRunCheck({ req, res, pathname, writeJson })) return;
  if (await handleRunAuthRecoveryInternalRoutes({
    req,
    res,
    pathname,
    writeJson,
    authenticate: authenticateRunAuthRecovery,
    recoverRunAuthFailure,
  })) {
    return;
  }

  // Detached providers renew their short-lived session-control capability
  // through a separate local-only endpoint. The renewal credential is never
  // accepted by the normal session-control route.
  if (await handleSessionControlInternalRoutes({
    req,
    res,
    pathname,
    writeJson,
    authenticate: authenticateSessionControlRenewal,
    renew: renewRunSessionControlCapability,
  })) {
    return;
  }

  // The Google Calendar OAuth callback arrives as a browser redirect from
  // accounts.google.com without an AgentoC session cookie, so it must be
  // handled before requireAuth below. Only the callback path is exposed here;
  // every other connector API route keeps its per-route auth checks.
  if (pathname === '/api/connectors/calendar/google/callback' && req.method === 'GET') {
    if (await handleConnectorApiRoutes({
      req,
      res,
      pathname,
      authSession: null,
      writeJson,
      nonce,
      buildHeaders,
      getPageBuildInfo,
      renderPageTemplate,
      buildTemplateReplacements,
      serializeJsonForScript,
    })) {
      return;
    }
  }

  // 设备入口切换（介绍人机制）B 端入口：?join= 一次性介绍消费（公开，介绍即登录）。
  // 必须早于 handlePublicRoutes——带 join 参数的 / 不走登录页渲染。
  if (await handleEntrySwitchJoin({
    req,
    res,
    parsedUrl,
  })) {
    return;
  }

  // Resolve a trusted-device bearer before any public/bootstrap handler. A
  // provisional bearer is intentionally allowed through only to the two
  // Google handoff routes; otherwise a public route could bypass the central
  // permission gate simply by being dispatched first.
  if (!getAuthSession(req) && req.headers?.authorization) {
    await authenticateBearerToken(req);
  }
  const earlyAuthSession = getAuthSession(req);
  if (earlyAuthSession?.principalKind === 'provisional_device'
      && !((pathname === '/api/auth/google/token' && req.method === 'POST')
        || (pathname === '/api/auth/google/status' && req.method === 'GET'))) {
    writeJson(res, 403, {
      error: 'Google identity is required before device access',
      code: 'google_required',
    });
    return;
  }

  if (await handlePublicRoutes({
    req,
    res,
    parsedUrl,
    pathname,
    nonce,
    loginTemplatePath,
    mobileInstallTemplatePath,
    parentEnglishCoursewareTemplatePath,
    getPageBuildInfo,
    buildHeaders,
    renderPageTemplate,
    buildTemplateReplacements,
    serializeJsonForScript,
    writeJsonCached,
  })) {
    return;
  }

  if (await handleLocalBridgePublicRoutes({
    req,
    res,
    pathname,
    parsedUrl,
    writeJson,
  })) {
    return;
  }

  if (await handleDeviceAuthPublicRoutes({
    req,
    res,
    pathname,
    writeJson,
  })) {
    return;
  }

  if (await handleDevicePairingPublicRoutes({
    req,
    res,
    pathname,
    writeJson,
  })) {
    return;
  }

  // Google owner 登录/绑定：login/status 公开（登录页用），bind 路由内部做 owner 检查
  if (await handleGoogleOwnerAuthRoutes({
    req,
    res,
    pathname,
    authSession: getAuthSession(req),
    writeJson,
  })) {
    return;
  }

  // TEST/ACCEPTANCE ONLY：Web Connectivity Phase 0 真人授权验收入口（owner 门内）。
  if (await handleWebConnectivityAcceptanceRoutes({
    req,
    res,
    pathname,
    authSession: getAuthSession(req),
    writeJson,
  })) {
    return;
  }

  // Trusted-device handshake for entry switching. Configuration sync is removed.
  if (await handleDeviceHandshakeRoutes({
    req,
    res,
    pathname,
    writeJson,
  })) {
    return;
  }

  // 设备入口切换（介绍人机制）：invite owner-only / introspect 走握手凭证（阶段三）
  if (await handleEntrySwitchRoutes({
    req,
    res,
    pathname,
    authSession: getAuthSession(req),
    writeJson,
  })) {
    return;
  }

  if (await handleProviderSyncRoutes({
    req,
    res,
    pathname,
    writeJson,
  })) {
    return;
  }

  // A detached worker cannot read owner auth.json or reach the owner CLI
  // socket. Authenticate signed Run capabilities here, before the ordinary
  // owner auth gate, and keep every resulting principal narrowly scoped.
  const sessionControlAuth = isLoopbackRequest(req)
    ? await authenticateSessionControlDetailed(req, { pathname, method: req.method })
    : null;
  if (sessionControlAuth?.errorCode) {
    writeJson(res, 401, {
      error: sessionControlAuth.error || 'Session-control capability is invalid',
      code: sessionControlAuth.errorCode,
    });
    return;
  }
  const runCapabilityAuth = pathname.startsWith('/api/collaborations')
    ? await authenticateCollaborationCapability(req, { pathname, method: req.method })
    : sessionControlAuth?.principal || null;

  // Auth required from here on. A valid Run capability is an explicit narrow
  // principal and must not be upgraded to an owner session.
  if (!targetRuntimeAuth && !runCapabilityAuth && !await requireAuth(req, res)) return;
  const authSession = targetRuntimeAuth?.principal || runCapabilityAuth || getAuthSession(req);

  // Apply the unified connectivity policy engine centrally for trusted_device
  // sessions (scope device-access). This keeps the HTTP control plane and P2P
  // data plane on the same blocked-prefix and enrollment policy.
  // Note: use principalKind directly, not getAuthPrincipalKind() — a
  // trusted-device session carries role 'owner' but principalKind
  // 'trusted_device', and the latter is what identifies a device principal.
  if (authSession?.principalKind === 'trusted_device') {
    const deviceDecision = devicePolicyEngine.decide({
      method: req.method,
      url: req.url,
      headers: { authorization: req.headers.authorization },
    });
    if (deviceDecision.kind === 'blocked') {
      writeJson(res, 403, { error: 'Device access not permitted for this route' });
      return;
    }
    if (deviceDecision.kind === 'unauthorized') {
      writeJson(res, 401, { error: 'Trusted-device bearer authentication is required' });
      return;
    }
  }

  // A provisional device may only complete the Google identity handoff and
  // query the deliberately narrow status surface handled above. It must not
  // inherit visitor access to ordinary sessions or any other API merely
  // because a bearer token passed the basic authentication gate.
  if (authSession?.principalKind === 'provisional_device') {
    writeJson(res, 403, {
      error: 'Google identity is required before device access',
      code: 'google_required',
    });
    return;
  }

  // A temporary control request arrives only through the encrypted carrier
  // adapter.  It has already been device-authenticated there, but it still
  // needs an exact capability check here before it can use compatibility
  // handlers that otherwise expect an Owner-shaped session.
  const temporaryControlRequest = authSession?.temporaryControlAdapter === true
    && (authSession?.principalKind === 'temporary_device' || authSession?.role === 'temporary');
  if ((authSession?.principalKind === 'temporary_device' || authSession?.role === 'temporary')
      && !temporaryControlRequest) {
    writeJson(res, 403, { error: 'Temporary access must use the control carrier', code: 'temporary_control_carrier_required' });
    return;
  }
  if (temporaryControlRequest) {
    try {
      authorizeTemporaryControl(authSession, req._temporaryControlOperation);
    } catch (error) {
      writeJson(res, error?.statusCode || 403, { error: 'Temporary control access denied',
        code: error?.code || 'temporary_control_denied' });
      return;
    }
  }

  if (authSession?.principalKind !== 'run_capability'
      && authSession?.role !== 'owner' && !temporaryControlRequest && isOwnerOnlyRoute(pathname, req.method)) {
    writeJson(res, 403, { error: 'Owner access required' });
    return;
  }

  // S10 Managed Input enforcement (HTTP layer): fork / fork-at / delegate are
  // the creation-type bypass routes. Their handlers live in
  // router-control-routes.mjs, so the MANAGED_SESSION_INPUT_BYPASS (409)
  // response is enforced here before dispatch. The CLI `session-spawn` command
  // posts to the delegate endpoint, so it is covered by the delegate route.
  // The message/continuation surface is gated inside
  // router-session-main-routes.mjs. No-op when the flag is off.
  if (req.method === 'POST') {
    const managedInputBypass = parseManagedInputBypassRoute(pathname);
    if (managedInputBypass) {
      const bypassTarget = await getSession(managedInputBypass.sessionId);
      try {
        assertManagedInputAllowed({ session: bypassTarget, operation: managedInputBypass.operation });
      } catch (error) {
        if (error?.code === MANAGED_SESSION_INPUT_BYPASS) {
          writeJson(res, 409, { error: error.message, code: error.code });
          return;
        }
        throw error;
      }
    }
  }

  // ---- API endpoints ----

  // The local context is served by handleControlRoutes below. The gateway's
  // catch-all would otherwise turn this existing local endpoint into a 404.
  if (!(pathname === '/api/target-runtime/context' && req.method === 'GET') && await handleTargetRuntimeGatewayRoutes({
    req,
    res,
    pathname,
    parsedUrl,
    authSession,
    writeJson,
  })) {
    return;
  }

  // 设备连接 bootstrap（ADR-0001 2026-08-17 修订）：trusted_device 会话获取
  // signed connection contract 并上报 TURN/P2P 迁移事件；放在设备策略门之后，
  // 两类传输载体复用同一鉴权与 RemoteApiGateway 策略。
  if (await handleConnectionBootstrapRoutes({
    req,
    res,
    pathname,
    authSession,
    writeJson,
  })) {
    return;
  }

  if (await handleConnectorSurfaceRoutes({
    req,
    res,
    pathname,
    authSession,
    writeJson,
    buildHeaders,
    nonce,
  })) {
    return;
  }

  if (await handleCodexMcpRoutes({
    req,
    res,
    pathname,
    authSession,
    writeJson,
  })) {
    return;
  }

  if (await handleClaudeMcpRoutes({
    req,
    res,
    pathname,
    authSession,
    writeJson,
  })) {
    return;
  }

  if (await handleAgyRoutes({
    req,
    res,
    pathname,
  })) {
    return;
  }

  if (await handleHarnessRoutes({
    req,
    res,
    pathname,
  })) {
    return;
  }

  if (await handleConnectorApiRoutes({
    req,
    res,
    pathname,
    authSession,
    writeJson,
    nonce,
    buildHeaders,
    getPageBuildInfo,
    renderPageTemplate,
    buildTemplateReplacements,
    serializeJsonForScript,
  })) {
    return;
  }

  if (await handleCollaborationRoutes({
    req,
    res,
    pathname,
    authSession,
    readBody,
    requireSessionAccess,
    writeJson,
    orchestrator: getDefaultCollaborationOrchestrator(),
  })) {
    return;
  }

  if (await handleOrchestrationRoutes({
    req,
    res,
    pathname,
    query: parsedUrl.query,
    authSession,
    writeJson,
  })) {
    return;
  }

  if (await handleOrganizationRoutes({
    req,
    res,
    pathname,
    authSession,
    writeJson,
  })) {
    return;
  }

  if (await handleConsultationRoutes({
    req,
    res,
    pathname,
    authSession,
    writeJson,
  })) {
    return;
  }

  if (await handleProjectWorkflowRoutes({
    req,
    res,
    pathname,
    query: parsedUrl.searchParams,
    authSession,
    readBody,
    writeJson,
  })) {
    return;
  }

  const sessionGetRoute = req.method === 'GET' ? parseSessionGetRoute(pathname) : null;
  const triggerId = parseTriggerRoute(pathname);
  const fileAssetRoute = parseFileAssetRoute(pathname);

  if (await handleSessionMainRoutes({
    req,
    res,
    parsedUrl,
    pathname,
    authSession,
    sessionGetRoute,
    createSessionSummaryRef,
    immutablePrivateEventCacheControl: IMMUTABLE_PRIVATE_EVENT_CACHE_CONTROL,
    isDirectoryPath,
    readSessionMessagePayload,
    requireSessionAccess,
    isSessionVisibleToAuthSession,
    getAuthPrincipalId,
    getAuthScopeAgentId,
    isAgentScopedAuthSession,
    resolveRequestedSessionAttachments,
    writeJson,
    writeJsonCached,
  })) {
    return;
  }

  if (await handleLocalBridgeOwnerRoutes({
    req,
    res,
    pathname,
    authSession,
    requireSessionAccess,
    writeJson,
  })) {
    return;
  }

  if (await handleConnectivityOwnerRoutes({
    req,
    res,
    pathname,
    authSession,
    writeJson,
  })) {
    return;
  }

  if (await handleDevicePairingOwnerRoutes({
    req,
    res,
    pathname,
    authSession,
    writeJson,
  })) {
    return;
  }

  if (await handleControlRoutes({
    req,
    res,
    parsedUrl,
    pathname,
    authSession,
    reauthorizeBrokerPending,
    triggerId,
    fileAssetRoute,
    buildHeaders,
    isDirectoryPath,
    readSessionMessagePayload,
    requireSessionAccess,
    resolveRequestedSessionAttachments,
    streamResponse,
    writeFileCached,
    writeJson,
    writeJsonCached,
  })) {
    return;
  }

  if (pathname === '/upload-fallback' && req.method === 'GET') {
    const sessionId = typeof parsedUrl?.query?.sessionId === 'string' ? parsedUrl.query.sessionId.trim() : '';
    const escapedSessionId = escapeHtml(sessionId);
    const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>应急上传</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", sans-serif; margin: 0; background: #f5f2ea; color: #1f2937; }
    .wrap { max-width: 560px; margin: 0 auto; padding: 24px 16px 40px; }
    .card { background: #fffdf8; border: 1px solid #d6d3c8; border-radius: 16px; padding: 18px; box-shadow: 0 8px 24px rgba(0,0,0,0.06); }
    h1 { margin: 0 0 10px; font-size: 24px; }
    p { line-height: 1.5; color: #4b5563; }
    label { display: block; margin: 14px 0 6px; font-weight: 600; }
    input[type="file"], textarea { width: 100%; box-sizing: border-box; }
    textarea { min-height: 88px; padding: 10px 12px; border: 1px solid #c9c5b8; border-radius: 10px; background: #fff; }
    input[type="file"] { padding: 10px 0; }
    button { margin-top: 16px; width: 100%; border: 0; border-radius: 999px; padding: 14px 18px; background: #1f2937; color: #fff; font-size: 16px; font-weight: 600; }
    .meta { font-size: 13px; color: #6b7280; word-break: break-all; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>应急上传</h1>
      <p>这个页面绕过聊天输入框的附件逻辑，直接把文件送进当前会话。</p>
      <p class="meta">sessionId: ${escapedSessionId || '未指定'}</p>
      <form method="post" enctype="multipart/form-data">
        <input type="hidden" name="sessionId" value="${escapedSessionId}">
        <label for="text">说明</label>
        <textarea id="text" name="text" placeholder="可选：给这个文件加一句说明"></textarea>
        <label for="attachments">文件</label>
        <input id="attachments" name="attachments" type="file" required>
        <button type="submit">上传到当前会话</button>
      </form>
    </div>
  </div>
</body>
</html>`;
    res.writeHead(200, buildHeaders({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
    }));
    res.end(html);
    return;
  }

  if (pathname === '/upload-fallback' && req.method === 'POST') {
    let body;
    try {
      body = await readSessionMessagePayload(req, pathname);
    } catch (error) {
      res.writeHead(400, buildHeaders({ 'Content-Type': 'text/html; charset=utf-8' }));
      res.end(`<p>上传失败：${escapeHtml(error?.message || 'Bad request')}</p>`);
      return;
    }
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : '';
    if (!sessionId) {
      res.writeHead(400, buildHeaders({ 'Content-Type': 'text/html; charset=utf-8' }));
      res.end('<p>上传失败：缺少 sessionId</p>');
      return;
    }
    if (!await requireSessionAccess(res, authSession, sessionId)) return;
    const targetSession = await getSessionForClient(sessionId);
    if (!targetSession) {
      res.writeHead(404, buildHeaders({ 'Content-Type': 'text/html; charset=utf-8' }));
      res.end('<p>上传失败：会话不存在</p>');
      return;
    }
    try {
      const attachments = await resolveRequestedSessionAttachments(authSession, body.attachments || [], { sessionId });
      await sendUserMessage(
        sessionId,
        typeof body?.text === 'string' ? body.text.trim() : '',
        attachments,
        { tool: 'codex', skipEmptyUserTextValidation: true },
      );
      res.writeHead(200, buildHeaders({
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
      }));
      res.end('<p>上传成功。现在回到聊天页面刷新一下，就能看到文件了。</p>');
    } catch (error) {
      res.writeHead(500, buildHeaders({ 'Content-Type': 'text/html; charset=utf-8' }));
      res.end(`<p>上传失败：${escapeHtml(error?.message || 'unknown error')}</p>`);
    }
    return;
  }

  // ---- Auth info endpoint ----
  if (pathname === '/api/auth/me' && req.method === 'GET') {
    if (!authSession) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not authenticated' }));
      return;
    }
    const info = buildAuthInfo(authSession);
    const refreshedCookie = await refreshAuthSession(req);
    writeJsonCached(req, res, info, {
      headers: refreshedCookie ? { 'Set-Cookie': refreshedCookie } : undefined,
    });
    return;
  }

  // Main page (chat UI) — read from disk each time for hot-reload
  if (pathname === '/') {
    try {
      const authSession = getAuthSession(req);
      const [pageBuildInfo, chatPage, refreshedCookie, pageBootstrap] = await Promise.all([
        getPageBuildInfo(),
        readFile(chatTemplatePath, 'utf8'),
        refreshAuthSession(req),
        buildChatPageBootstrap(authSession),
      ]);
      res.writeHead(200, buildHeaders({
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
        ...(refreshedCookie ? { 'Set-Cookie': refreshedCookie } : {}),
      }));
      res.end(renderPageTemplate(chatPage, nonce, {
        ...buildTemplateReplacements(pageBuildInfo, getRequestProductBasePath(req)),
        BODY_CLASS: parsedUrl.query?.desktop === 'manager' ? 'desktop-manager' : '',
        BOOTSTRAP_JSON: serializeJsonForScript(pageBootstrap),
      }));
    } catch {
      res.writeHead(500, buildHeaders({ 'Content-Type': 'text/plain' }));
      res.end('Failed to load chat page');
    }
    return;
  }

  res.writeHead(404, buildHeaders({ 'Content-Type': 'text/plain' }));
  res.end('Not Found');
}
