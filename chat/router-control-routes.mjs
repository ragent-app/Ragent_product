import { WORKBENCH_EXECUTION_POLICY, workbenchToolAllowed, filterWorkbenchModels } from '../lib/workbench-execution-policy.mjs';
import { mkdir, readFile, readdir, realpath, stat } from 'fs/promises';
import { homedir } from 'os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'path';

import { CHAT_IMAGES_DIR, CONFIG_DIR, FILE_ASSET_STORAGE_PROVIDER } from '../lib/config.mjs';
import { listAgents, getAgent, createAgent, updateAgent, deleteAgent } from './apps.mjs';
import { loadUiRuntimeSelection, saveUiRuntimeSelection } from '../lib/runtime-selection.mjs';
import { getPublicAvailableToolsAsync, saveSimpleToolAsync } from '../lib/tools.mjs';
import { readBody } from '../lib/utils.mjs';
import { handleWindowsPrivilegedBrokerRoutes } from './windows-privileged-broker.mjs';
import { getRun, getRunManifest, isTerminalRunState } from './runs.mjs';
import {
  createOwnerWebAuthnAssertionOptions,
  createOwnerWebAuthnRegistrationOptions,
  getOwnerWebAuthnState,
  verifyOwnerWebAuthnAssertion,
  verifyOwnerWebAuthnRegistration,
} from '../lib/owner-webauthn.mjs';
import { setOwnerPasswordAsync } from '../lib/auth.mjs';
import { getOwnerAccountBinding, reserveOwnerAccountFileUpload,
  completeOwnerAccountFileUpload, releaseOwnerAccountFileUpload } from '../lib/owner-account-auth.mjs';
import { getModelsForTool, getToolModelCatalog, getToolModelCatalogs } from './models.mjs';
import { getGloballyInstalledHarnessIdsForProviders } from '../lib/harness-installation-sync.mjs';
import { getHarnessProviderProtocols } from '../lib/provider-runtime/harness-bridge.mjs';
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  migrateProjectsToTargets,
  normalizeProjectId,
  updateProject,
} from './projects.mjs';
import { defaultProjectIndex } from './project-index.mjs';
import { defaultIntakeResolver, digestIntakeInput } from './intake-resolver.mjs';
import { defaultIntakeDecisionStore } from './intake-decision-store.mjs';
import { defaultProjectBootstrap } from './project-bootstrap.mjs';
import {
  exportSelectedProjectSessions,
  importSessionMigrationBundle,
} from './session-migration.mjs';
import { getPublicKey, addSubscription } from './push.mjs';
import { loadAccountPolicy, saveAccountPolicy } from '../lib/account-policy.mjs';
import { registerFcmToken, unregisterFcmToken } from './fcm.mjs';
import { backfillOwnerBootstrapSessions } from './bootstrap-sessions.mjs';
import {
  cancelNativeOAuthLogin,
  cleanupNativeOAuthLoginJobs,
  createNativeApiProvider,
  deleteNativeProvider,
  getNativeOAuthLoginJob,
  listNativeProviderProfiles,
  recordAgentProfileSyncMutation,
  recordRuntimePolicySyncMutation,
  sendNativeOAuthLoginInput,
  startNativeOAuthLogin,
  updateNativeProvider,
} from './native-provider-management.mjs';
import { migrateLegacyAgyProvider } from '../lib/provider-runtime/run-provider-prepare.mjs';
import { createSessionDetail } from './session-api-shapes.mjs';
import { normalizeSessionEntryMode } from './session-entry-mode.mjs';
import {
  normalizeSessionWorkflowPriority,
  normalizeSessionWorkflowState,
} from './session-workflow-state.mjs';
import {
  createTrigger,
  deleteTrigger,
  getTrigger,
  listTriggers,
  updateTrigger,
} from './triggers.mjs';
import {
  cancelManagedProcess,
  createManagedProcess,
  listManagedProcesses,
  readManagedProcess,
} from './managed-processes.mjs';
import {
  buildAttachmentContentDisposition,
  buildFileAssetDirectUrl,
  createFileAssetUploadIntent,
  finalizeFileAssetUpload,
  findFileAssetUploadReceipt,
  getFileAsset,
  getFileAssetForClient,
  ingestFileAssetUpload,
  readFileAssetUploadCheckpoint,
  appendFileAssetUploadChunk,
  cancelFileAssetUploadCheckpoint,
  localizeFileAsset,
} from './file-assets.mjs';
import { RESUMABLE_UPLOAD_CONTRACT, UPLOAD_CHUNK_REQUEST_TIMEOUT_MS,
  uploadChunkHeaders, MAX_STABLE_UPLOAD_BYTES } from './file-asset-upload-checkpoints.mjs';
import { pathExists } from './fs-utils.mjs';
import { queryUsageLedger } from './usage-ledger.mjs';
import { broadcastAll } from './ws-clients.mjs';
import { loadOrCreateInstanceIdentity } from '../lib/instance-identity.mjs';
import {
  createLocalTargetRuntimeContext,
} from '../lib/target-runtime-contract.mjs';
import {
  getTargetRuntimeRevision,
  getTargetRuntimeSummaryEvents,
} from '../lib/target-runtime-state.mjs';
import { createTargetRuntimeSummary } from './target-runtime-summary.mjs';
import { mutateSessionMeta } from './session-meta-store.mjs';
import { readSessionApiScopeHeader, SESSION_API_SCOPE_HEADER } from './session-api-scope-contract.mjs';
import {
  normalizeSessionGoal,
  buildGoalContinuationPrompt,
  GOAL_CONTINUE_INTERNAL_OPERATION,
} from './session-goal.mjs';
import {
  assertManagedInputAllowed,
  MANAGED_SESSION_INPUT_BYPASS,
} from './managed-input.mjs';
import {
  applyTemplateToSession,
  appendAssistantMessage,
  compactSession,
  delegateSession,
  dropToolUse,
  forkSession,
  forkSessionAt,
  getHistory,
  getSession,
  resolveSessionRiskModeForRun,
  prepareSessionForFork,
  deleteSession,
  renameSession,
  saveSessionAsTemplate,
  setSessionPinned,
  updateSessionAgreements,
  updateSessionEntryMode,
  updateSessionGoal,
  sendMessage,
  updateSessionGrouping,
  updateSessionLastReviewedAt,
  updateSessionRuntimePreferences,
  updateSessionWorkflowClassification,
} from './session-manager.mjs';

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

const workspaceReadableFileTypes = {
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.mdown': 'text/markdown; charset=utf-8',
  '.mkdn': 'text/markdown; charset=utf-8',
  '.pdf': 'application/pdf',
};
const workspaceReadableSkipDirs = new Set([
  '.git',
  '.hg',
  '.svn',
  '.next',
  '.turbo',
  '.venv',
  'coverage',
  'dist',
  'node_modules',
]);
const WORKSPACE_READABLE_MAX_FILES = 1000;
const WORKSPACE_READABLE_MAX_DIRS = 2000;
const WORKSPACE_READABLE_MAX_DEPTH = 10;
const WORKSPACE_MARKDOWN_MAX_BYTES = 8 * 1024 * 1024;
const HARNESS_PROVIDER_TYPES = new Set([
  'codex', 'claude', 'agy',
  'pi', 'deepseek-harness', 'qwen-code', 'opencode', 'kimi-code', 'goose', 'openhands', 'copilot', 'hermes', 'cline', 'kilo',
]);

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeWorkspaceSessionId(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function getNativeProviderManagementContext() {
  return import('../lib/provider-runtime/index.mjs').then(({
    createNativeProviderRegistry,
    createProviderQuotaStore,
    createProviderSyncLedger,
    createCredentialMutationLedger,
    createSecretStore,
    createAgyRotationStore,
    refreshProviderQuota,
    syncAccountSyncFromAccountPeers,
  }) => Promise.resolve(loadOrCreateInstanceIdentity()).then((identity) => {
    const registry = createNativeProviderRegistry({ configDir: CONFIG_DIR });
    const secretStore = createSecretStore({ configDir: CONFIG_DIR });
    const ledger = createProviderSyncLedger({ configDir: CONFIG_DIR });
    const credentialLedger = createCredentialMutationLedger({ configDir: CONFIG_DIR });
    return {
      configDir: CONFIG_DIR,
      registry,
      secretStore,
      quotaStore: createProviderQuotaStore({ configDir: CONFIG_DIR }),
      rotationStore: createAgyRotationStore({ configDir: CONFIG_DIR }),
      ledger,
      credentialLedger,
      sourceInstanceId: identity.instanceId,
      refreshProviderQuota,
      syncProviderSnapshotToAccountPeers: () => syncAccountSyncFromAccountPeers({
        registry,
        secretStore,
        ledger,
        credentialLedger,
      }),
    };
  }));
}

function scheduleProviderSync(context) {
  // Peer/account sync is background synchronization. It must never turn a
  // successful provider read or mutation into a failed control-plane request.
  void Promise.resolve()
    .then(() => context?.syncProviderSnapshotToAccountPeers?.())
    .catch(() => {});
}

function normalizeWorkspaceRoot(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  if (raw === '~') return homedir();
  if (raw.startsWith('~/')) return join(homedir(), raw.slice(2));
  return resolve(raw);
}

function isWorkspaceReadableExtension(extension) {
  return Object.prototype.hasOwnProperty.call(workspaceReadableFileTypes, String(extension || '').toLowerCase());
}

function isWorkspaceReadableFile(filepath) {
  return isWorkspaceReadableExtension(extname(filepath));
}

async function readJsonRequestBody(req, limitBytes = 64 * 1024) {
  const body = await readBody(req, limitBytes);
  return body ? JSON.parse(body) : {};
}

function isPathInsideRoot(rootPath, filepath) {
  const rootResolved = resolve(rootPath);
  const fileResolved = resolve(filepath);
  const rel = relative(rootResolved, fileResolved);
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}

function normalizeWorkspaceRelativePath(value) {
  return typeof value === 'string'
    ? value.replace(/\\/g, '/').replace(/^\/+/, '').trim()
    : '';
}

function buildWorkspaceFilePayload(rootPath, filepath, fileStats) {
  const relativePath = normalizeWorkspaceRelativePath(relative(rootPath, filepath));
  const extension = extname(filepath).toLowerCase();
  return {
    name: basename(filepath),
    path: relativePath,
    relativePath,
    dir: normalizeWorkspaceRelativePath(dirname(relativePath)),
    extension,
    kind: extension === '.pdf' ? 'pdf' : 'markdown',
    mimeType: workspaceReadableFileTypes[extension] || 'application/octet-stream',
    sizeBytes: Number.isFinite(fileStats?.size) ? fileStats.size : 0,
    modifiedAt: fileStats?.mtime ? fileStats.mtime.toISOString() : null,
  };
}

function buildWorkspaceDirectoryPayload(rootPath, dirPath, dirStats) {
  const relativePath = normalizeWorkspaceRelativePath(relative(rootPath, dirPath));
  if (!relativePath) return null;
  return {
    name: basename(dirPath),
    path: relativePath,
    relativePath,
    dir: normalizeWorkspaceRelativePath(dirname(relativePath)),
    kind: 'directory',
    modifiedAt: dirStats?.mtime ? dirStats.mtime.toISOString() : null,
  };
}

async function collectWorkspaceReadableEntries(rootPath, dirPath = rootPath, options = {}) {
  const depth = Number.isInteger(options.depth) ? options.depth : 0;
  const files = Array.isArray(options.files) ? options.files : [];
  const directories = Array.isArray(options.directories) ? options.directories : [];
  if (
    depth > WORKSPACE_READABLE_MAX_DEPTH
    || (files.length >= WORKSPACE_READABLE_MAX_FILES && directories.length >= WORKSPACE_READABLE_MAX_DIRS)
  ) {
    return { files, directories };
  }

  let entries = [];
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return { files, directories };
  }

  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  for (const entry of entries) {
    if (files.length >= WORKSPACE_READABLE_MAX_FILES) break;
    if (!entry?.name || entry.name.startsWith('.')) continue;
    const fullPath = join(dirPath, entry.name);
    if (!isPathInsideRoot(rootPath, fullPath)) continue;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (workspaceReadableSkipDirs.has(entry.name)) continue;
      if (directories.length < WORKSPACE_READABLE_MAX_DIRS) {
        try {
          const payload = buildWorkspaceDirectoryPayload(rootPath, fullPath, await stat(fullPath));
          if (payload) directories.push(payload);
        } catch {}
      }
      if (options.recursive !== false) {
        await collectWorkspaceReadableEntries(rootPath, fullPath, { depth: depth + 1, files, directories });
      }
      continue;
    }
    if (files.length >= WORKSPACE_READABLE_MAX_FILES) continue;
    if (!entry.isFile() || !isWorkspaceReadableFile(fullPath)) continue;
    try {
      files.push(buildWorkspaceFilePayload(rootPath, fullPath, await stat(fullPath)));
    } catch {}
  }

  return { files, directories };
}

async function resolveWorkspaceReadableRequest({
  parsedUrl,
  authSession,
  requireSessionAccess,
  writeJson,
  res,
}) {
  const projectId = normalizeProjectId(parsedUrl.query?.projectId);
  if (projectId) {
    const project = await getProject(projectId);
    if (!project) {
      writeJson(res, 404, { error: 'Project not found' });
      return null;
    }
    const rootPath = resolve(project.rootPath);
    try {
      const rootStats = await stat(rootPath);
      if (!rootStats.isDirectory()) {
        writeJson(res, 400, { error: 'Project folder is not a directory' });
        return null;
      }
    } catch {
      writeJson(res, 404, { error: 'Project folder not found' });
      return null;
    }
    return { session: null, project, rootPath, workspace: rootPath };
  }

  const workspace = normalizeWorkspaceRoot(parsedUrl.query?.workspace);
  if (workspace) {
    try {
      const rootStats = await stat(workspace);
      if (!rootStats.isDirectory()) {
        writeJson(res, 400, { error: 'Workspace is not a directory' });
        return null;
      }
    } catch {
      writeJson(res, 404, { error: 'Workspace not found' });
      return null;
    }
    return { session: null, rootPath: workspace, workspace };
  }

  const sessionId = normalizeWorkspaceSessionId(parsedUrl.query?.sessionId);
  if (!sessionId) {
    writeJson(res, 400, { error: 'workspace or sessionId is required' });
    return null;
  }
  if (!await requireSessionAccess(res, authSession, sessionId)) return null;
  const session = await getSession(sessionId);
  if (!session) {
    writeJson(res, 404, { error: 'Session not found' });
    return null;
  }
  const rootPath = resolve(typeof session.folder === 'string' && session.folder.trim()
    ? session.folder.trim()
    : homedir());
  try {
    const rootStats = await stat(rootPath);
    if (!rootStats.isDirectory()) {
      writeJson(res, 400, { error: 'Session folder is not a directory' });
      return null;
    }
  } catch {
    writeJson(res, 404, { error: 'Session folder not found' });
    return null;
  }
  return { session, rootPath, workspace: rootPath };
}

function createClientSessionDetail(session) {
  return createSessionDetail(session);
}

async function getSessionForClient(id, options = {}) {
  return createClientSessionDetail(await getSession(id, options));
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function getGrantedCapability(authSession, capability, fallback = false) {
  if (authSession?.role === 'owner') return true;
  if (!capability) return fallback;
  return authSession?.capabilities?.[capability] === true
    ? true
    : fallback;
}

function isRunCapability(authSession) {
  return authSession?.principalKind === 'run_capability';
}

function allowsRunOperation(authSession, operation) {
  return authSession?.role === 'owner' || (isRunCapability(authSession) && authSession.capabilityOperation === operation);
}

function capabilitySessionId(authSession) {
  return trimString(authSession?.sessionId || authSession?.rootSessionId);
}

function rejectCapability(res, writeJson, message = 'Run capability is not authorized for this operation') {
  writeJson(res, 403, { error: message });
  return true;
}

function writeUploadFailure(res, error, writeJson, conditional, fallback) {
  if (!conditional) {
    writeJson(res, error?.statusCode || 400, { error: error?.message || fallback, code: error?.code });
    return;
  }
  const known = /^FILE_ASSET_[A-Z_]+$/.test(error?.code || '') || /^account_file_upload_[a-z_]+$/.test(error?.code || '') ||
    ['INVALID_ARGUMENT', 'REVISION_CONFLICT', 'RESOURCE_NOT_FOUND',
      'SESSION_MUTATION_STORE_INVALID', 'SESSION_MUTATION_STORE_UNAVAILABLE'].includes(error?.code);
  const valid = known && Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode <= 599;
  writeJson(res, valid ? error.statusCode : 503, { code: valid ? error.code : 'FILE_ASSET_UPLOAD_UNAVAILABLE',
    error: valid ? error.message : 'Conditional attachment upload is unavailable' });
}

export async function handleControlRoutes({
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
}) {
  if (WORKBENCH_EXECUTION_POLICY && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)
      && (pathname === '/api/account-policy' || pathname === '/api/tools' || pathname.startsWith('/api/tools/') || pathname.startsWith('/api/harnesses/'))) {
    writeJson(res, 403, { error: 'Harness management is locked by the workbench operator', code: 'WORKBENCH_EXECUTION_POLICY_DENIED' });
    return true;
  }
  const conditionalUpload = Object.hasOwn(req.headers || {}, SESSION_API_SCOPE_HEADER) &&
    (pathname === '/api/assets/upload-intents' || ['upload', 'finalize', 'upload-checkpoint'].includes(fileAssetRoute?.action));
  if (conditionalUpload) {
    res.setHeader?.('Cache-Control', 'private, no-store');
    if (authSession?.role !== 'owner' ||
        (authSession.principalKind && !['owner', 'trusted_device'].includes(authSession.principalKind))) {
      req.resume?.();
      writeJson(res, 403, { code: 'PERMISSION_DENIED', error: 'Owner conditional upload access is required' });
      return true;
    }
  }
  if (await handleWindowsPrivilegedBrokerRoutes({
    req,
    res,
    pathname,
    authSession,
    reauthorizePending: reauthorizeBrokerPending,
    requireSessionAccess,
    getSession,
    resolveSessionRiskMode: resolveSessionRiskModeForRun,
    authorizeServiceApproval: async (grant) => {
      const run = await getRun(grant.runId);
      if (!run || run.sessionId !== grant.sessionId || isTerminalRunState(run.state) ||
          run.cancelRequested === true || run.stalledAt) return false;
      const manifest = await getRunManifest(grant.runId);
      return manifest?.sessionId === grant.sessionId &&
        manifest?.options?.approvedActionChannel?.turnId === grant.turnId &&
        Boolean(manifest?.options?.approvedActionChannel?.tokenHash);
    },
    writeJson,
  })) return true;

  if (pathname === '/api/target-runtime/context' && req.method === 'GET') {
    if (authSession?.role !== 'owner' || authSession?.principalKind === 'run_capability') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }
    try {
      const identity = await loadOrCreateInstanceIdentity();
      const snapshotVersion = await getTargetRuntimeRevision();
      writeJson(res, 200, createLocalTargetRuntimeContext(identity, { snapshotVersion }));
    } catch {
      writeJson(res, 500, {
        error: 'Target runtime context is unavailable',
        code: 'TARGET_CONTEXT_UNAVAILABLE',
      });
    }
    return true;
  }

  if (pathname === '/api/runtime/summary' && req.method === 'GET') {
    if (authSession?.role !== 'owner' || authSession?.principalKind === 'run_capability') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }
    try {
      writeJson(res, 200, await createTargetRuntimeSummary());
    } catch (error) {
      writeJson(res, error?.statusCode || 500, {
        error: error?.message || 'Target runtime summary is unavailable',
        code: error?.code || 'TARGET_SUMMARY_FAILED',
      });
    }
    return true;
  }

  if (pathname === '/api/runtime/summary/events' && req.method === 'GET') {
    if (authSession?.role !== 'owner' || authSession?.principalKind === 'run_capability') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }
    try {
      writeJson(res, 200, await getTargetRuntimeSummaryEvents({
        afterCursor: parsedUrl?.query?.afterCursor ?? parsedUrl?.query?.cursor ?? '0',
        limit: parsedUrl?.query?.limit ?? '100',
      }));
    } catch (error) {
      writeJson(res, error?.statusCode || 400, {
        error: error?.message || 'Target runtime summary events are unavailable',
        code: error?.code || 'TARGET_SUMMARY_EVENTS_FAILED',
      });
    }
    return true;
  }

  if (pathname === '/api/intake/capabilities' && req.method === 'GET') {
    if (authSession?.role !== 'owner' || authSession?.principalKind === 'run_capability') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }
    res.setHeader?.('Cache-Control', 'private, no-store');
    writeJson(res, 200, { protocolVersion: 1, projectRouting: true, projectCreation: true });
    return true;
  }

  if (pathname === '/api/intake/prepare' && req.method === 'POST') {
    if (authSession?.role !== 'owner' || authSession?.principalKind === 'run_capability') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }
    try {
      const body = await readBody(req, 1024 * 1024);
      const payload = JSON.parse(body || '{}');
      const result = await defaultIntakeResolver.prepare(payload.input || payload, {
        runtime: payload.runtime || null,
      });
      await defaultIntakeDecisionStore.record(result);
      writeJson(res, 200, result);
    } catch (error) {
      writeJson(res, 400, { error: error?.message || 'Invalid intake preparation' });
    }
    return true;
  }

  if (pathname === '/api/intake/ensure-project' && req.method === 'POST') {
    if (authSession?.role !== 'owner' || authSession?.principalKind === 'run_capability') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }
    try {
      const body = await readBody(req, 1024 * 1024);
      const payload = JSON.parse(body || '{}');
      const operationId = typeof payload.operationId === 'string' ? payload.operationId.trim() : '';
      const decisionId = typeof payload.decisionId === 'string' ? payload.decisionId.trim() : '';
      const input = payload.input || {};
      const inputDigest = digestIntakeInput(input);
      const existing = await defaultProjectBootstrap.receipt(operationId);
      if (existing) {
        if (existing.decisionId !== decisionId || existing.inputDigest !== inputDigest) {
          writeJson(res, 409, { code: 'PROJECT_OPERATION_CONFLICT', error: 'Creation operation has different frozen input' });
          return true;
        }
        writeJson(res, 200, await defaultProjectBootstrap.resume(operationId));
        return true;
      }
      const decision = await defaultIntakeDecisionStore.get(input.intakeId, decisionId);
      if (!decision || decision.decision !== 'create_new' || decision.inputDigest !== inputDigest) {
        writeJson(res, 409, { code: 'INTAKE_DECISION_STALE', error: 'Intake decision changed; prepare again' });
        return true;
      }
      const sourceRefs = [
        ...(Array.isArray(input.sourceUrls) ? input.sourceUrls : []),
        ...(Array.isArray(input.files) ? input.files.map((file) => `file:${file?.name || ''}`) : []),
      ];
      const result = await defaultProjectBootstrap.ensureForIntake({
        operationId, decisionId, inputDigest,
        targetInstanceId: decision.targetInstanceId,
        indexRevision: decision.indexRevision,
        newProject: decision.newProject,
        userRequirement: input.userRequirement,
        sourceRefs,
      });
      writeJson(res, 200, result);
    } catch (error) {
      writeJson(res, error?.statusCode || 400, {
        code: error?.code || 'PROJECT_BOOTSTRAP_FAILED',
        error: error?.message || 'Project bootstrap failed',
      });
    }
    return true;
  }

  if (pathname === '/api/intake/operation' && req.method === 'GET') {
    if (authSession?.role !== 'owner' || authSession?.principalKind === 'run_capability') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }
    const operationId = typeof parsedUrl?.query?.operationId === 'string' ? parsedUrl.query.operationId : '';
    writeJson(res, 200, { operation: await defaultProjectBootstrap.receipt(operationId) });
    return true;
  }

  if (pathname === '/api/projects/routing-context' && req.method === 'GET') {
    if (authSession?.role !== 'owner' || authSession?.principalKind === 'run_capability') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }
    try {
      const query = typeof parsedUrl?.query?.q === 'string' ? parsedUrl.query.q : '';
      writeJson(res, 200, query
        ? await defaultProjectIndex.search({ query })
        : await defaultProjectIndex.refresh());
    } catch (error) {
      writeJson(res, 503, { error: error?.message || 'Project routing context is unavailable' });
    }
    return true;
  }

  if (pathname === '/api/projects' && req.method === 'GET') {
    if (authSession?.role !== 'owner') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }
    try {
      writeJsonCached(req, res, { projects: await listProjects() });
    } catch (error) {
      writeJson(res, 500, { error: error.message || 'Failed to load projects' });
    }
    return true;
  }

  if (pathname === '/api/projects' && req.method === 'POST') {
    if (authSession?.role !== 'owner') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }
    let payload = {};
    try {
      const body = await readBody(req, 32768);
      payload = body ? JSON.parse(body) : {};
    } catch {
      writeJson(res, 400, { error: 'Invalid request body' });
      return true;
    }
    try {
      const project = await createProject({
        name: typeof payload?.name === 'string' ? payload.name : '',
        rootPath: typeof payload?.rootPath === 'string' ? payload.rootPath : '',
      }, { validateRoot: true });
      writeJson(res, 201, { project: await getProject(project.id, { client: true }) });
    } catch (error) {
      const status = Number.isInteger(error?.statusCode) ? error.statusCode : 400;
      writeJson(res, status, {
        error: error.message || 'Failed to create project',
        ...(error?.code ? { code: error.code } : {}),
        ...(error?.rootStatus ? { rootStatus: error.rootStatus } : {}),
        ...(error?.existingProject ? { existingProject: error.existingProject } : {}),
      });
    }
    return true;
  }

  // 选择项目内的部分会话导出到可在另一台设备导入的迁移包。
  const sessionMigrationExportRoute = /^\/api\/projects\/([^/]+)\/session-migration\/export$/.exec(pathname || '');
  if (sessionMigrationExportRoute && req.method === 'POST') {
    if (authSession?.role !== 'owner') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }
    const projectId = normalizeProjectId(decodeURIComponent(sessionMigrationExportRoute[1]));
    if (!projectId) {
      writeJson(res, 404, { error: 'Project not found' });
      return true;
    }
    let payload = {};
    try {
      payload = await readJsonRequestBody(req, 128 * 1024);
    } catch {
      writeJson(res, 400, { error: 'Invalid request body' });
      return true;
    }
    try {
      const result = await exportSelectedProjectSessions({
        projectId,
        sessionIds: payload.sessionIds,
        targetPath: payload.targetPath,
      });
      writeJson(res, 201, result);
    } catch (error) {
      const status = Number.isInteger(error?.statusCode) ? error.statusCode : 400;
      writeJson(res, status, {
        error: error.message || 'Failed to export selected sessions',
        ...(error?.code ? { code: error.code } : {}),
        ...(Array.isArray(error?.activeSessionIds) ? { activeSessionIds: error.activeSessionIds } : {}),
        ...(Array.isArray(error?.sessionIds) ? { sessionIds: error.sessionIds } : {}),
      });
    }
    return true;
  }

  // 目标设备导入会话迁移包；默认拒绝覆盖已有同 ID 会话。
  if (pathname === '/api/session-migrations/import' && req.method === 'POST') {
    if (authSession?.role !== 'owner') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }
    let payload = {};
    try {
      payload = await readJsonRequestBody(req, 128 * 1024);
    } catch {
      writeJson(res, 400, { error: 'Invalid request body' });
      return true;
    }
    try {
      const result = await importSessionMigrationBundle({
        bundlePath: payload.bundlePath,
        projectRootPath: payload.projectRootPath,
      });
      writeJson(res, 200, result);
      broadcastAll({ type: 'projects_invalidated' });
      broadcastAll({ type: 'sessions_invalidated' });
    } catch (error) {
      const status = Number.isInteger(error?.statusCode) ? error.statusCode : 400;
      writeJson(res, status, {
        error: error.message || 'Failed to import selected sessions',
        ...(error?.code ? { code: error.code } : {}),
        ...(Array.isArray(error?.sessionIds) ? { sessionIds: error.sessionIds } : {}),
      });
    }
    return true;
  }

  // 项目复制迁移（批量）：对配置了 migrateTargetPath 的项目复制到各自目标路径，
  // 任一失败（权限不足等）不中断其余，全部执行完后在 failed 中汇总
  if (pathname === '/api/projects/migrate' && req.method === 'POST') {
    if (authSession?.role !== 'owner') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }
    try {
      const result = await migrateProjectsToTargets();
      writeJson(res, 200, result);
      broadcastAll({ type: 'projects_invalidated' });
    } catch (error) {
      writeJson(res, 500, { error: error.message || 'Failed to migrate projects' });
    }
    return true;
  }

  const projectRoute = /^\/api\/projects\/([^/]+)$/.exec(pathname || '');
  const projectDeleteRoute = /^\/api\/projects\/([^/]+)\/delete$/.exec(pathname || '');
  const isProjectDeleteCompat = !!projectDeleteRoute && req.method === 'POST';
  if ((projectRoute && ['GET', 'PATCH', 'DELETE'].includes(req.method)) || isProjectDeleteCompat) {
    if (authSession?.role !== 'owner') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }
    const projectPathMatch = projectRoute || projectDeleteRoute;
    const projectId = normalizeProjectId(decodeURIComponent(projectPathMatch[1]));
    if (!projectId) {
      writeJson(res, 404, { error: 'Project not found' });
      return true;
    }
    if (req.method === 'GET') {
      const project = await getProject(projectId, { client: true });
      if (!project) {
        writeJson(res, 404, { error: 'Project not found' });
        return true;
      }
      writeJsonCached(req, res, { project });
      return true;
    }
    let payload = {};
    try {
      const body = await readBody(req, 32768);
      payload = body ? JSON.parse(body) : {};
    } catch {
      writeJson(res, 400, { error: 'Invalid request body' });
      return true;
    }
    if (req.method === 'DELETE' || isProjectDeleteCompat) {
      try {
        const result = await deleteProject(projectId, { deleteSessions: payload.deleteSessions === true });
        if (!result) {
          writeJson(res, 404, { error: 'Project not found' });
          return true;
        }
        writeJson(res, 200, result);
        broadcastAll({ type: 'projects_invalidated' });
        broadcastAll({ type: 'sessions_invalidated' });
      } catch (error) {
        const status = Number.isInteger(error?.statusCode) ? error.statusCode : 400;
        writeJson(res, status, {
          error: error.message || 'Failed to delete project',
          ...(error?.code ? { code: error.code } : {}),
          ...(Array.isArray(error?.activeSessionIds) ? { activeSessionIds: error.activeSessionIds } : {}),
          ...(Number.isInteger(error?.dependencyCount) ? { dependencyCount: error.dependencyCount } : {}),
          ...(Array.isArray(error?.dependencySessionIds) ? { dependencySessionIds: error.dependencySessionIds } : {}),
        });
      }
      return true;
    }
    try {
      const project = await updateProject(projectId, {
        ...(Object.prototype.hasOwnProperty.call(payload, 'name') ? { name: payload.name } : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'archived') ? { archived: payload.archived === true } : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'pinned') ? { pinned: payload.pinned === true } : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'migrateTargetPath')
          ? { migrateTargetPath: typeof payload.migrateTargetPath === 'string' ? payload.migrateTargetPath : '' }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'migrateRenames')
          ? { migrateRenames: payload.migrateRenames }
          : {}),
      });
      if (!project) {
        writeJson(res, 404, { error: 'Project not found' });
        return true;
      }
      writeJson(res, 200, { project: await getProject(project.id, { client: true }) });
      broadcastAll({ type: 'projects_invalidated' });
    } catch (error) {
      writeJson(res, 400, { error: error.message || 'Failed to update project' });
    }
    return true;
  }

  if (pathname === '/api/native-providers' && (req.method === 'GET' || req.method === 'POST')) {
    if (authSession?.role !== 'owner') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }
    res.setHeader('Cache-Control', 'no-store');
    try {
      const context = await getNativeProviderManagementContext();
      if (req.method === 'GET') {
        scheduleProviderSync(context);
        const globallyInstalledHarnesses = await getGloballyInstalledHarnessIdsForProviders();
        const providers = await listNativeProviderProfiles({ ...context, includeAgy: true });
        const requestedTool = String(parsedUrl.query?.tool || '').trim();
        const normalizedTool = requestedTool === 'claude-bidi' ? 'claude'
          : requestedTool === 'codex-cli' ? 'codex'
            : requestedTool;
        const supportedProtocols = new Set(getHarnessProviderProtocols(normalizedTool));
        writeJson(res, 200, {
          nativeRuntime: true,
          // Management must show every saved profile, including profiles for
          // an uninstalled Harness, so users can edit or remove them. Filter
          // by installed Harness only for runtime-specific provider pickers.
          providers: providers
            .filter((provider) => !WORKBENCH_EXECUTION_POLICY || (provider.agentType === 'codex' && provider.authType === 'oauth'
              && (!WORKBENCH_EXECUTION_POLICY.providerProfileId || provider.id === WORKBENCH_EXECUTION_POLICY.providerProfileId)))
            .filter((provider) => !normalizedTool || !HARNESS_PROVIDER_TYPES.has(provider.agentType)
              || globallyInstalledHarnesses.has(provider.agentType))
            .filter((provider) => {
              if (!normalizedTool) return true;
              if (['codex', 'claude', 'agy'].includes(normalizedTool)) {
                return provider.agentType === normalizedTool;
              }
              if (!supportedProtocols.has(String(provider.protocol || '').trim().toLowerCase())) return false;
              return normalizedTool !== 'copilot'
                || String(provider.protocol || '').trim().toLowerCase() !== 'github-copilot'
                || provider.agentType === 'copilot';
            }),
        });
        return true;
      }
      const payload = await readJsonRequestBody(req, 32 * 1024);
      const result = await createNativeApiProvider({ ...context, payload });
      writeJson(res, 201, {
        nativeRuntime: true,
        provider: result.provider,
      });
      scheduleProviderSync(context);
    } catch (error) {
      writeJson(res, Number.isInteger(error?.statusCode) ? error.statusCode : 400, {
        error: error?.message || 'Failed to save provider configuration',
        ...(error?.code ? { code: error.code } : {}),
      });
    }
    return true;
  }

  if (pathname === '/api/native-providers/agy/rotation'
      && (req.method === 'GET' || req.method === 'PATCH')) {
    if (authSession?.role !== 'owner') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }
    res.setHeader('Cache-Control', 'no-store');
    try {
      const context = await getNativeProviderManagementContext();
      const profiles = await context.registry.listProviderProfiles();
      if (req.method === 'GET') {
        writeJson(res, 200, { nativeRuntime: true, rotation: await context.rotationStore.get() });
      } else {
        const payload = await readJsonRequestBody(req, 16 * 1024);
        const rotation = await context.rotationStore.update({
          enabled: payload?.enabled,
          providerIds: payload?.providerIds,
        }, profiles);
        writeJson(res, 200, { nativeRuntime: true, rotation });
      }
    } catch (error) {
      writeJson(res, Number.isInteger(error?.statusCode) ? error.statusCode : 400, {
        error: error?.message || 'Failed to read or update AgY rotation',
        ...(error?.code ? { code: error.code } : {}),
      });
    }
    return true;
  }

  const nativeProviderQuotaRefreshMatch = pathname.match(/^\/api\/native-providers\/([^/]+)\/quota\/refresh$/);
  const nativeProviderQuotaMatch = pathname.match(/^\/api\/native-providers\/([^/]+)\/quota$/);
  if ((nativeProviderQuotaRefreshMatch && req.method === 'POST')
      || (nativeProviderQuotaMatch && req.method === 'GET')) {
    if (authSession?.role !== 'owner') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }
    res.setHeader('Cache-Control', 'no-store');
    try {
      const context = await getNativeProviderManagementContext();
      const providerId = decodeURIComponent((nativeProviderQuotaRefreshMatch || nativeProviderQuotaMatch)[1]);
      // The old agy-control token is a migration source only.  Ensure a legacy
      // install is imported before resolving the requested profile, then use
      // the registry/SecretStore path just like every other provider.
      await migrateLegacyAgyProvider({
        registry: context.registry,
        secretStore: context.secretStore,
      }).catch(() => null);
      let provider = await context.registry.getProviderProfile(providerId);
      if (!provider) {
        writeJson(res, 404, { error: 'Provider not found' });
        return true;
      }
      const authProfile = await context.registry.getAuthProfile(provider.authProfileId);
      if (!authProfile) {
        writeJson(res, 404, { error: 'Provider credential profile not found' });
        return true;
      }
      const quota = req.method === 'POST'
        ? await context.refreshProviderQuota({
          provider,
          authProfile,
          secretStore: context.secretStore,
          quotaStore: context.quotaStore,
        })
        : await context.quotaStore.get(providerId);
      writeJson(res, 200, {
        nativeRuntime: true,
        providerId,
        quota: quota || null,
      });
    } catch (error) {
      writeJson(res, 502, { error: error?.message || 'Failed to query provider quota' });
    }
    return true;
  }

  const nativeProviderMatch = pathname.match(/^\/api\/native-providers\/([^/]+)$/);
  if (nativeProviderMatch && (req.method === 'DELETE' || req.method === 'PATCH')) {
    if (authSession?.role !== 'owner') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }
    try {
      const context = await getNativeProviderManagementContext();
      const providerId = decodeURIComponent(nativeProviderMatch[1]);
      if (req.method === 'PATCH') {
        const payload = await readJsonRequestBody(req, 32 * 1024);
        const result = await updateNativeProvider({ ...context, providerId, payload });
        writeJson(res, 200, { nativeRuntime: true, provider: result.provider });
        scheduleProviderSync(context);
      } else {
        const result = await deleteNativeProvider({ ...context, providerId });
        if (!result?.ok && result?.reason === 'not-found') {
          writeJson(res, 404, { error: 'Provider not found' });
        } else if (!result?.ok) {
          const status = result.reason === 'credential-conflict'
            ? 409
            : result.reason === 'credential-tombstoned' ? 410 : 400;
          writeJson(res, status, { error: result?.reason || 'Failed to delete provider' });
        } else {
          writeJson(res, 200, { ok: true });
          scheduleProviderSync(context);
        }
      }
    } catch (error) {
      writeJson(res, Number.isInteger(error?.statusCode) ? error.statusCode : 400, {
        error: error?.message || (req.method === 'PATCH' ? 'Failed to update provider' : 'Failed to delete provider'),
        ...(error?.code ? { code: error.code } : {}),
      });
    }
    return true;
  }

  if (pathname === '/api/native-provider-oauth/jobs' && req.method === 'POST') {
    if (authSession?.role !== 'owner') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }
    try {
      const payload = await readJsonRequestBody(req, 8 * 1024);
      const context = await getNativeProviderManagementContext();
      const job = await startNativeOAuthLogin({
        ...context,
        onProviderChanged: context.syncProviderSnapshotToAccountPeers,
        agentType: payload?.agentType,
        displayName: payload?.displayName,
        providerId: payload?.providerId,
        replaceExisting: payload?.replaceExisting === true,
      });
      void cleanupNativeOAuthLoginJobs().catch(() => {});
      writeJson(res, 202, { job });
    } catch (error) {
      writeJson(res, Number.isInteger(error?.statusCode) ? error.statusCode : 400, {
        error: error?.message || 'Unable to start official account login',
        ...(error?.code ? { code: error.code } : {}),
      });
    }
    return true;
  }

  const nativeOAuthInputMatch = pathname.match(/^\/api\/native-provider-oauth\/jobs\/([^/]+)\/input$/);
  if (nativeOAuthInputMatch && req.method === 'POST') {
    if (authSession?.role !== 'owner') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }
    try {
      const payload = await readJsonRequestBody(req, 72 * 1024);
      const job = await sendNativeOAuthLoginInput(nativeOAuthInputMatch[1], payload?.credential);
      if (!job) writeJson(res, 404, { error: 'Login job not found' });
      else writeJson(res, 200, { job });
    } catch (error) {
      writeJson(res, 400, { error: error?.message || 'Unable to send login credential' });
    }
    return true;
  }

  const nativeOAuthJobMatch = pathname.match(/^\/api\/native-provider-oauth\/jobs\/([^/]+)$/);
  if (nativeOAuthJobMatch && (req.method === 'GET' || req.method === 'DELETE')) {
    if (authSession?.role !== 'owner') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }
    const job = req.method === 'DELETE'
      ? await cancelNativeOAuthLogin(nativeOAuthJobMatch[1])
      : getNativeOAuthLoginJob(nativeOAuthJobMatch[1]);
    if (!job) writeJson(res, 404, { error: 'Login job not found' });
    else writeJson(res, 200, { job });
    return true;
  }

  if (pathname === '/api/bootstrap/owner-sessions/restore' && req.method === 'POST') {
    if (authSession?.role !== 'owner') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }
    try {
      const result = await backfillOwnerBootstrapSessions();
      writeJson(res, 200, {
        ok: true,
        created: result.created,
        updated: result.updated,
        welcomeSessionId: result.welcomeSession?.id || '',
        welcomeSession: result.welcomeSession ? createClientSessionDetail(result.welcomeSession) : null,
      });
    } catch (error) {
      writeJson(res, 500, { error: error.message || 'Failed to restore starter sessions' });
    }
    return true;
  }

  if (pathname === '/api/triggers' && req.method === 'GET') {
    if (!allowsRunOperation(authSession, 'session.trigger.read')) return rejectCapability(res, writeJson);
    const requestedSessionId = typeof parsedUrl?.query?.sessionId === 'string' ? trimString(parsedUrl.query.sessionId) : '';
    const sessionId = requestedSessionId || capabilitySessionId(authSession);
    if (isRunCapability(authSession) && sessionId !== capabilitySessionId(authSession)) return rejectCapability(res, writeJson, 'Run capability is bound to another session');
    if (isRunCapability(authSession) && !await requireSessionAccess(res, authSession, sessionId)) return true;
    const triggers = await listTriggers({ sessionId: authSession?.role === 'owner' ? requestedSessionId : sessionId });
    writeJson(res, 200, { triggers });
    return true;
  }

  if (pathname === '/api/triggers' && req.method === 'POST') {
    if (!allowsRunOperation(authSession, 'session.trigger.create')) return rejectCapability(res, writeJson);
    let payload = {};
    try {
      const body = await readBody(req, 32768);
      payload = body ? JSON.parse(body) : {};
    } catch {
      writeJson(res, 400, { error: 'Invalid request body' });
      return true;
    }
    try {
      if (Object.prototype.hasOwnProperty.call(payload, 'thinking') && typeof payload.thinking !== 'boolean') throw new Error('thinking must be a boolean');
      if (Object.prototype.hasOwnProperty.call(payload, 'enabled') && typeof payload.enabled !== 'boolean') throw new Error('enabled must be a boolean');
      const sessionId = trimString(payload.sessionId) || capabilitySessionId(authSession);
      if (!sessionId) throw new Error('sessionId is required');
      if (isRunCapability(authSession) && sessionId !== capabilitySessionId(authSession)) return rejectCapability(res, writeJson, 'Run capability is bound to another session');
      if (isRunCapability(authSession) && !await requireSessionAccess(res, authSession, sessionId)) return true;
      const trigger = await createTrigger({ ...payload, sessionId });
      writeJson(res, 201, { trigger });
    } catch (error) {
      writeJson(res, Number.isInteger(error?.statusCode) ? error.statusCode : 400, { error: error.message || 'Failed to create trigger' });
    }
    return true;
  }

  if (triggerId && req.method === 'GET') {
    if (!allowsRunOperation(authSession, 'session.trigger.read')) return rejectCapability(res, writeJson);
    const trigger = await getTrigger(triggerId);
    if (!trigger) {
      writeJson(res, 404, { error: 'Trigger not found' });
      return true;
    }
    if (isRunCapability(authSession) && trigger.sessionId !== capabilitySessionId(authSession)) return rejectCapability(res, writeJson, 'Run capability is bound to another session');
    writeJson(res, 200, { trigger });
    return true;
  }

  if (triggerId && req.method === 'PATCH') {
    if (!allowsRunOperation(authSession, 'session.trigger.update')) return rejectCapability(res, writeJson);
    let payload = {};
    try {
      const body = await readBody(req, 32768);
      payload = body ? JSON.parse(body) : {};
    } catch {
      writeJson(res, 400, { error: 'Invalid request body' });
      return true;
    }
    try {
      if (Object.prototype.hasOwnProperty.call(payload, 'thinking') && typeof payload.thinking !== 'boolean') throw new Error('thinking must be a boolean');
      if (Object.prototype.hasOwnProperty.call(payload, 'enabled') && typeof payload.enabled !== 'boolean') throw new Error('enabled must be a boolean');
      const existing = await getTrigger(triggerId);
      if (!existing) {
        writeJson(res, 404, { error: 'Trigger not found' });
        return true;
      }
      if (isRunCapability(authSession) && existing.sessionId !== capabilitySessionId(authSession)) return rejectCapability(res, writeJson, 'Run capability is bound to another session');
      if (isRunCapability(authSession) && payload.sessionId && trimString(payload.sessionId) !== capabilitySessionId(authSession)) return rejectCapability(res, writeJson, 'Run capability cannot move a trigger to another session');
      const trigger = await updateTrigger(triggerId, payload || {});
      writeJson(res, 200, { trigger });
    } catch (error) {
      writeJson(res, 400, { error: error.message || 'Failed to update trigger' });
    }
    return true;
  }

  if (triggerId && req.method === 'DELETE') {
    if (!allowsRunOperation(authSession, 'session.trigger.delete')) return rejectCapability(res, writeJson);
    const existing = await getTrigger(triggerId);
    if (!existing) {
      writeJson(res, 404, { error: 'Trigger not found' });
      return true;
    }
    if (isRunCapability(authSession) && existing.sessionId !== capabilitySessionId(authSession)) return rejectCapability(res, writeJson, 'Run capability is bound to another session');
    const trigger = await deleteTrigger(triggerId);
    writeJson(res, 200, { ok: true, trigger });
    return true;
  }

  const managedProcessSessionRoute = /^\/api\/sessions\/([^/]+)\/managed-processes$/.exec(pathname || '');
  if (managedProcessSessionRoute && req.method === 'POST') {
    if (!allowsRunOperation(authSession, 'session.process.create')) return rejectCapability(res, writeJson);
    let payload = {};
    try { payload = await readJsonRequestBody(req, 64 * 1024); } catch { writeJson(res, 400, { error: 'Invalid request body' }); return true; }
    let sessionId = '';
    try { sessionId = decodeURIComponent(managedProcessSessionRoute[1]); } catch { sessionId = managedProcessSessionRoute[1]; }
    if (isRunCapability(authSession) && sessionId !== capabilitySessionId(authSession)) return rejectCapability(res, writeJson, 'Run capability is bound to another session');
    if (isRunCapability(authSession) && !await requireSessionAccess(res, authSession, sessionId)) return true;
    if (isRunCapability(authSession) && payload?.wake?.sessionId && !await requireSessionAccess(res, authSession, trimString(payload.wake.sessionId))) return true;
    try {
      const process = await createManagedProcess({ ...payload, sessionId, createdByRunId: authSession?.runId || '' });
      writeJson(res, 201, { process });
    } catch (error) {
      writeJson(res, Number.isInteger(error?.statusCode) ? error.statusCode : 400, { error: error.message || 'Failed to create managed process', ...(error?.code ? { code: error.code } : {}) });
    }
    return true;
  }

  if (pathname === '/api/managed-processes' && req.method === 'GET') {
    if (!allowsRunOperation(authSession, 'session.process.read')) return rejectCapability(res, writeJson);
    const requestedSessionId = trimString(parsedUrl?.query?.sessionId);
    const sessionId = requestedSessionId || capabilitySessionId(authSession);
    if (isRunCapability(authSession) && sessionId !== capabilitySessionId(authSession)) return rejectCapability(res, writeJson, 'Run capability is bound to another session');
    writeJson(res, 200, { processes: await listManagedProcesses({ sessionId: authSession?.role === 'owner' ? requestedSessionId : sessionId }) });
    return true;
  }

  const managedProcessRoute = /^\/api\/managed-processes\/([^/]+)(?:\/(cancel))?$/.exec(pathname || '');
  if (managedProcessRoute && (
    (req.method === 'GET' && !managedProcessRoute[2])
    || (req.method === 'POST' && managedProcessRoute[2] === 'cancel')
    || (req.method === 'DELETE' && !managedProcessRoute[2])
  )) {
    const processId = decodeURIComponent(managedProcessRoute[1]);
    const process = await readManagedProcess(processId, { includeOutput: true });
    if (!process) { writeJson(res, 404, { error: 'Managed process not found' }); return true; }
    if (isRunCapability(authSession) && process.sessionId !== capabilitySessionId(authSession)) return rejectCapability(res, writeJson, 'Run capability is bound to another session');
    if (req.method === 'GET') {
      if (!allowsRunOperation(authSession, 'session.process.read')) return rejectCapability(res, writeJson);
      writeJson(res, 200, { process });
      return true;
    }
    if (!allowsRunOperation(authSession, 'session.process.cancel')) return rejectCapability(res, writeJson);
    const cancelled = await cancelManagedProcess(processId, 'cancelled by session control');
    writeJson(res, 200, { process: cancelled });
    return true;
  }

  if (pathname === '/api/asset-upload-contract' && req.method === 'GET') {
    if (authSession?.role !== 'owner' || isRunCapability(authSession)) {
      writeJson(res, 403, { error: 'Owner upload access required', code: 'PERMISSION_DENIED' });
      return true;
    }
    writeJson(res, 200, { version: 1, maximumBytes: MAX_STABLE_UPLOAD_BYTES, requestIdMaximumLength: 200,
      sha256Required: true, readonlyReceiptLookup: true,
      resumableUpload: RESUMABLE_UPLOAD_CONTRACT,
      scopeConditionVersion: 1, scopeContractPath: '/api/session-scope-contract' });
    return true;
  }

  if (pathname === '/api/assets/upload-intents' && req.method === 'GET') {
    // Stable recovery is currently an owner-phone contract. Delegated callers
    // require their own authenticated principal mapping before this expands.
    if (authSession?.role !== 'owner' || isRunCapability(authSession)) {
      writeJson(res, 403, { error: 'Owner upload recovery access required', code: 'PERMISSION_DENIED' });
      return true;
    }
    const sessionId = typeof parsedUrl?.query?.sessionId === 'string' ? parsedUrl.query.sessionId.trim() : '';
    if (!sessionId || !await requireSessionAccess(res, authSession, sessionId, conditionalUpload ? { metadataOnly: true } : undefined)) {
      if (!sessionId) writeJson(res, 400, { error: 'sessionId is required', code: 'INVALID_ARGUMENT' });
      return true;
    }
    try {
      const receipt = await findFileAssetUploadReceipt({ sessionId, requestId: parsedUrl?.query?.requestId,
        scopeCondition: readSessionApiScopeHeader(req, sessionId) });
      if (receipt?.asset?.status === 'ready') {
        const binding = await getOwnerAccountBinding();
        if (binding?.accountId && (!authSession?.accountId || authSession.accountId === binding.accountId)) {
          await completeOwnerAccountFileUpload({ requestId: parsedUrl?.query?.requestId,
            quotaBatchId: receipt.quotaBatchId || parsedUrl?.query?.requestId,
            sizeBytes: receipt.asset.sizeBytes, sha256: receipt.asset.sha256 });
        }
      }
      writeJson(res, receipt ? 200 : 404, receipt || { error: 'Upload request not found', code: 'FILE_ASSET_NOT_FOUND' });
    } catch (error) {
      writeUploadFailure(res, error, writeJson, conditionalUpload, 'Upload receipt is unavailable');
    }
    return true;
  }

  if (pathname === '/api/assets/upload-intents' && req.method === 'POST') {
    let payload = {};
    try {
      const body = await readBody(req, 32768);
      payload = body ? JSON.parse(body) : {};
    } catch {
      writeJson(res, 400, { error: 'Invalid request body' });
      return true;
    }

    const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : '';
    if (!sessionId) {
      writeJson(res, 400, { error: 'sessionId is required' });
      return true;
    }
    if (!await requireSessionAccess(res, authSession, sessionId, conditionalUpload ? { metadataOnly: true } : undefined)) return true;
    if (!getGrantedCapability(authSession, 'uploadAttachments', true)) {
      writeJson(res, 403, { error: 'Access denied' });
      return true;
    }

    try {
      if (Object.hasOwn(payload, 'requestId') && (authSession?.role !== 'owner' || isRunCapability(authSession))) {
        writeJson(res, 403, { error: 'Owner stable upload access required', code: 'PERMISSION_DENIED' });
        return true;
      }
      const accountBinding = await getOwnerAccountBinding();
      let quotaReservation = null;
      if (accountBinding?.accountId) {
        if (authSession?.accountId && authSession.accountId !== accountBinding.accountId) {
          writeJson(res, 403, { error: 'The signed-in account does not match this computer.', code: 'PERMISSION_DENIED' });
          return true;
        }
        if (typeof payload?.requestId !== 'string' || typeof payload?.sha256 !== 'string') {
          writeJson(res, 400, { error: 'This account requires resumable attachment uploads.', code: 'FILE_ASSET_STABLE_UPLOAD_REQUIRED' });
          return true;
        }
        if (typeof payload?.quotaBatchId !== 'string' || !payload.quotaBatchId.trim()) {
          writeJson(res, 400, { error: 'This account requires a message attachment batch identity.', code: 'FILE_ASSET_QUOTA_BATCH_REQUIRED' });
          return true;
        }
        quotaReservation = await reserveOwnerAccountFileUpload({ requestId: payload.requestId,
          quotaBatchId: payload.quotaBatchId, sizeBytes: payload.sizeBytes, sha256: payload.sha256 });
      }
      let intent;
      try {
        intent = await createFileAssetUploadIntent({
          sessionId,
          originalName: typeof payload?.originalName === 'string' ? payload.originalName : '',
          mimeType: typeof payload?.mimeType === 'string' ? payload.mimeType : '',
          sizeBytes: payload?.sizeBytes,
          createdBy: authSession?.role === 'visitor' ? 'visitor' : 'owner',
          scopeCondition: readSessionApiScopeHeader(req, sessionId),
          ...(Object.hasOwn(payload, 'requestId') ? { requestId: payload.requestId, quotaBatchId: payload.quotaBatchId, sha256: payload.sha256 } : {}),
        });
      } catch (error) {
        if (quotaReservation && !quotaReservation.duplicate) {
          await releaseOwnerAccountFileUpload({ requestId: payload.requestId,
            quotaBatchId: payload.quotaBatchId, sizeBytes: payload.sizeBytes, sha256: payload.sha256 }).catch(() => {});
        }
        throw error;
      }
      if (intent?.asset?.status === 'ready' && accountBinding?.accountId) {
        await completeOwnerAccountFileUpload({ requestId: payload.requestId,
          quotaBatchId: payload.quotaBatchId, sizeBytes: payload.sizeBytes, sha256: payload.sha256 });
      }
      writeJson(res, 200, intent);
    } catch (error) {
      writeUploadFailure(res, error, writeJson, conditionalUpload, 'Failed to create upload intent');
    }
    return true;
  }

  if (fileAssetRoute && req.method === 'GET' && !fileAssetRoute.action) {
    const asset = await getFileAsset(fileAssetRoute.assetId);
    if (!asset) {
      writeJson(res, 404, { error: 'Asset not found' });
      return true;
    }
    if (!await requireSessionAccess(res, authSession, asset.sessionId)) return true;
    if (!getGrantedCapability(authSession, 'downloadArtifacts', true)) {
      writeJson(res, 403, { error: 'Access denied' });
      return true;
    }
    const clientAsset = await getFileAssetForClient(asset.id, {
      includeDirectUrl: asset.status === 'ready',
    });
    writeJson(res, 200, { asset: clientAsset });
    return true;
  }

  if ((fileAssetRoute?.action === 'upload' && req.method === 'PATCH') ||
      (fileAssetRoute?.action === 'upload-checkpoint' && ['GET', 'DELETE'].includes(req.method))) {
    res.setHeader?.('Cache-Control', 'private, no-store');
    if (authSession?.role !== 'owner' || isRunCapability(authSession) ||
        (authSession.principalKind && !['owner', 'trusted_device'].includes(authSession.principalKind)
          && authSession.temporaryControlAdapter !== true)) {
      req.resume?.();
      writeJson(res, 403, { code: 'PERMISSION_DENIED', error: 'Owner upload access required' });
      return true;
    }
    const asset = await getFileAsset(fileAssetRoute.assetId);
    if (!asset) { req.resume?.(); writeJson(res, 404, { code: 'FILE_ASSET_NOT_FOUND' }); return true; }
    if (!await requireSessionAccess(res, authSession, asset.sessionId, { metadataOnly: true })) {
      req.resume?.(); return true;
    }
    if (asset.uploadRequest?.principalScope !== 'owner' ||
        !getGrantedCapability(authSession, 'uploadAttachments', true)) {
      req.resume?.(); writeJson(res, 403, { code: 'PERMISSION_DENIED' }); return true;
    }
    try {
      const options = { scopeCondition: readSessionApiScopeHeader(req, asset.sessionId) };
      const value = req.method === 'PATCH'
        ? await appendFileAssetUploadChunk(asset.id, req, { ...options, ...uploadChunkHeaders(req.headers),
          signal: AbortSignal.timeout(UPLOAD_CHUNK_REQUEST_TIMEOUT_MS) })
        : await (req.method === 'DELETE' ? cancelFileAssetUploadCheckpoint : readFileAssetUploadCheckpoint)(asset.id, options);
      req.resume?.();
      writeJson(res, 200, value);
    } catch (error) {
      req.resume?.();
      writeUploadFailure(res, error, writeJson, true, 'Attachment checkpoint is unavailable');
    }
    return true;
  }

  if (fileAssetRoute?.action === 'upload' && (req.method === 'PUT' || req.method === 'POST')) {
    const asset = await getFileAsset(fileAssetRoute.assetId);
    if (!asset) {
      writeJson(res, 404, { error: 'Asset not found' });
      return true;
    }
    if (!await requireSessionAccess(res, authSession, asset.sessionId, conditionalUpload ? { metadataOnly: true } : undefined)) return true;
    if (!getGrantedCapability(authSession, 'uploadAttachments', true)) {
      writeJson(res, 403, { error: 'Access denied' });
      return true;
    }

    try {
      await ingestFileAssetUpload(asset.id, req, { scopeCondition: readSessionApiScopeHeader(req, asset.sessionId) });
      res.writeHead(200, buildHeaders({
        ETag: `"${asset.id}"`,
        'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
      }));
      res.end();
    } catch (error) {
      req.resume?.();
      writeUploadFailure(res, error, writeJson, conditionalUpload, 'Failed to upload asset body');
    }
    return true;
  }

  if (fileAssetRoute?.action === 'finalize' && req.method === 'POST') {
    const asset = await getFileAsset(fileAssetRoute.assetId);
    if (!asset) {
      writeJson(res, 404, { error: 'Asset not found' });
      return true;
    }
    if (!await requireSessionAccess(res, authSession, asset.sessionId, conditionalUpload ? { metadataOnly: true } : undefined)) return true;
    if (!getGrantedCapability(authSession, 'uploadAttachments', true)) {
      writeJson(res, 403, { error: 'Access denied' });
      return true;
    }

    let payload = {};
    try {
      const body = await readBody(req, 32768);
      payload = body ? JSON.parse(body) : {};
    } catch {
      writeJson(res, 400, { error: 'Invalid request body' });
      return true;
    }

    try {
      const next = await finalizeFileAssetUpload(asset.id, {
        sizeBytes: payload?.sizeBytes,
        etag: typeof payload?.etag === 'string' ? payload.etag : '',
        scopeCondition: readSessionApiScopeHeader(req, asset.sessionId),
      });
      if (next?.status === 'ready' && asset.uploadRequest?.key) {
        const binding = await getOwnerAccountBinding();
        if (binding?.accountId && (!authSession?.accountId || authSession.accountId === binding.accountId)) {
          await completeOwnerAccountFileUpload({ requestId: asset.uploadRequest.key,
            quotaBatchId: asset.uploadRequest.quotaBatchId || asset.uploadRequest.key,
            sizeBytes: asset.sizeBytes, sha256: asset.sha256 });
        }
      }
      writeJson(res, 200, { asset: next });
    } catch (error) {
      writeUploadFailure(res, error, writeJson, conditionalUpload, 'Failed to finalize asset upload');
    }
    return true;
  }

  if (fileAssetRoute?.action === 'download' && req.method === 'GET') {
    const asset = await getFileAsset(fileAssetRoute.assetId);
    if (!asset) {
      writeJson(res, 404, { error: 'Asset not found' });
      return true;
    }
    if (!await requireSessionAccess(res, authSession, asset.sessionId)) return true;
    if (!getGrantedCapability(authSession, 'downloadArtifacts', true)) {
      writeJson(res, 403, { error: 'Access denied' });
      return true;
    }
    const downloadRequested = String(parsedUrl?.query?.download || '') === '1';

    try {
      if (asset.storage?.provider === 'local') {
        const localPath = await localizeFileAsset(asset);
        streamResponse(res, localPath, {
          'Content-Type': asset.mimeType || 'application/octet-stream',
          'Content-Disposition': buildAttachmentContentDisposition(asset.originalName, { attachment: downloadRequested }),
          'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
        });
        return true;
      }
      const direct = await buildFileAssetDirectUrl(asset, { attachment: downloadRequested });
      res.writeHead(302, buildHeaders({
        Location: direct.url,
        'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
      }));
      res.end();
    } catch (error) {
      writeJson(res, error?.statusCode || 400, { error: error.message || 'Failed to build asset download link' });
    }
    return true;
  }

  if (pathname === '/api/usage/summary' && req.method === 'GET') {
    if (authSession?.role !== 'owner') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }

    const principalType = typeof parsedUrl?.query?.principalType === 'string'
      ? parsedUrl.query.principalType.trim()
      : '';
    const principalId = typeof parsedUrl?.query?.principalId === 'string'
      ? parsedUrl.query.principalId.trim()
      : '';
    const sessionId = typeof parsedUrl?.query?.sessionId === 'string'
      ? parsedUrl.query.sessionId.trim()
      : '';
    const tool = typeof parsedUrl?.query?.tool === 'string'
      ? parsedUrl.query.tool.trim()
      : '';
    const model = typeof parsedUrl?.query?.model === 'string'
      ? parsedUrl.query.model.trim()
      : '';
    const summary = await queryUsageLedger({
      days: parsePositiveInteger(parsedUrl?.query?.days, 7),
      top: parsePositiveInteger(parsedUrl?.query?.top, 10),
      principalType,
      principalId,
      sessionId,
      tool,
      model,
    });
    writeJsonCached(req, res, summary);
    return true;
  }

  if (pathname.startsWith('/api/sessions/') && req.method === 'DELETE') {
    const parts = pathname.split('/').filter(Boolean);
    const sessionId = parts[2];
    if (parts.length !== 3 || parts[0] !== 'api' || parts[1] !== 'sessions' || !sessionId) {
      writeJson(res, 400, { error: 'Invalid session path' });
      return true;
    }
    if (!await requireSessionAccess(res, authSession, sessionId)) return true;
    if (!getGrantedCapability(authSession, 'deleteSession')) {
      writeJson(res, 403, { error: 'Access denied' });
      return true;
    }
    try {
      const deleted = await deleteSession(sessionId);
      if (!deleted) {
        writeJson(res, 404, { error: 'Session not found' });
        return true;
      }
      writeJson(res, 200, { deleted: true, sessionId: deleted.id });
    } catch (error) {
      writeJson(res, Number.isInteger(error?.statusCode) ? error.statusCode : 400, {
        error: error?.message || 'Failed to delete session',
        ...(error?.code ? { code: error.code } : {}),
        ...(Number.isInteger(error?.dependencyCount) ? { dependencyCount: error.dependencyCount } : {}),
        ...(Array.isArray(error?.dependencySessionIds) ? { dependencySessionIds: error.dependencySessionIds } : {}),
      });
    }
    return true;
  }

  if (pathname.startsWith('/api/sessions/') && req.method === 'PATCH') {
    const parts = pathname.split('/').filter(Boolean);
    const sessionId = parts[2];
    if (parts.length !== 3 || parts[0] !== 'api' || parts[1] !== 'sessions' || !sessionId) {
      writeJson(res, 400, { error: 'Invalid session path' });
      return true;
    }
    if (!await requireSessionAccess(res, authSession, sessionId)) return true;
    let body;
    try { body = await readBody(req, 10240); } catch {
      writeJson(res, 400, { error: 'Bad request' });
      return true;
    }
    let patch;
    try { patch = JSON.parse(body); } catch {
      writeJson(res, 400, { error: 'Invalid request body' });
      return true;
    }
    const hasPinnedPatch = Object.prototype.hasOwnProperty.call(patch || {}, 'pinned');
    const hasToolPatch = Object.prototype.hasOwnProperty.call(patch || {}, 'tool');
    const hasProviderProfilePatch = Object.prototype.hasOwnProperty.call(patch || {}, 'providerProfile');
    const hasModelPatch = Object.prototype.hasOwnProperty.call(patch || {}, 'model');
    const hasEffortPatch = Object.prototype.hasOwnProperty.call(patch || {}, 'effort');
    const hasServiceTierPatch = Object.prototype.hasOwnProperty.call(patch || {}, 'serviceTier');
    const hasThinkingPatch = Object.prototype.hasOwnProperty.call(patch || {}, 'thinking');
    const hasPermissionModePatch = Object.prototype.hasOwnProperty.call(patch || {}, 'permissionMode');
    const hasInteractionModePatch = Object.prototype.hasOwnProperty.call(patch || {}, 'interactionMode');
    const hasPrivilegedModePatch = Object.prototype.hasOwnProperty.call(patch || {}, 'privilegedMode');
    const hasRiskModePatch = Object.prototype.hasOwnProperty.call(patch || {}, 'riskMode');
    const hasGroupPatch = Object.prototype.hasOwnProperty.call(patch || {}, 'group');
    const hasDescriptionPatch = Object.prototype.hasOwnProperty.call(patch || {}, 'description');
    const hasSidebarOrderPatch = Object.prototype.hasOwnProperty.call(patch || {}, 'sidebarOrder');
    const hasActiveAgreementsPatch = Object.prototype.hasOwnProperty.call(patch || {}, 'activeAgreements');
    const hasWorkflowStatePatch = Object.prototype.hasOwnProperty.call(patch || {}, 'workflowState');
    const hasWorkflowPriorityPatch = Object.prototype.hasOwnProperty.call(patch || {}, 'workflowPriority');
    const hasLastReviewedAtPatch = Object.prototype.hasOwnProperty.call(patch || {}, 'lastReviewedAt');
    const hasEntryModePatch = Object.prototype.hasOwnProperty.call(patch || {}, 'entryMode');
    const hasGoalPatch = Object.prototype.hasOwnProperty.call(patch || {}, 'goal');
    if (hasPinnedPatch && typeof patch.pinned !== 'boolean') {
      writeJson(res, 400, { error: 'pinned must be a boolean' });
      return true;
    }
    if (hasToolPatch && typeof patch.tool !== 'string') {
      writeJson(res, 400, { error: 'tool must be a string' });
      return true;
    }
    if (hasProviderProfilePatch && patch.providerProfile !== null && typeof patch.providerProfile !== 'string') {
      writeJson(res, 400, { error: 'providerProfile must be a string or null' });
      return true;
    }
    if (hasModelPatch && typeof patch.model !== 'string') {
      writeJson(res, 400, { error: 'model must be a string' });
      return true;
    }
    if (hasEffortPatch && typeof patch.effort !== 'string') {
      writeJson(res, 400, { error: 'effort must be a string' });
      return true;
    }
    if (hasServiceTierPatch && typeof patch.serviceTier !== 'string') {
      writeJson(res, 400, { error: 'serviceTier must be a string' });
      return true;
    }
    if (hasThinkingPatch && typeof patch.thinking !== 'boolean') {
      writeJson(res, 400, { error: 'thinking must be a boolean' });
      return true;
    }
    if (hasPermissionModePatch && typeof patch.permissionMode !== 'string') {
      writeJson(res, 400, { error: 'permissionMode must be a string' });
      return true;
    }
    if (hasPrivilegedModePatch && typeof patch.privilegedMode !== 'boolean') {
      writeJson(res, 400, { error: 'privilegedMode must be a boolean' });
      return true;
    }
    if (hasInteractionModePatch && !['agent', 'plan'].includes(String(patch.interactionMode || '').trim().toLowerCase())) {
      writeJson(res, 400, { error: 'interactionMode must be "agent" or "plan"' });
      return true;
    }
    if (hasGroupPatch && patch.group !== null && typeof patch.group !== 'string') {
      writeJson(res, 400, { error: 'group must be a string or null' });
      return true;
    }
    if (hasDescriptionPatch && patch.description !== null && typeof patch.description !== 'string') {
      writeJson(res, 400, { error: 'description must be a string or null' });
      return true;
    }
    if (hasSidebarOrderPatch && patch.sidebarOrder !== null && (!Number.isInteger(patch.sidebarOrder) || patch.sidebarOrder < 1)) {
      writeJson(res, 400, { error: 'sidebarOrder must be a positive integer or null' });
      return true;
    }
    if (hasActiveAgreementsPatch && patch.activeAgreements !== null && !Array.isArray(patch.activeAgreements)) {
      writeJson(res, 400, { error: 'activeAgreements must be an array of strings or null' });
      return true;
    }
    if (hasActiveAgreementsPatch && Array.isArray(patch.activeAgreements)) {
      const invalidAgreement = patch.activeAgreements.find((entry) => typeof entry !== 'string');
      if (invalidAgreement !== undefined) {
        writeJson(res, 400, { error: 'activeAgreements must contain only strings' });
        return true;
      }
    }
    if (hasWorkflowStatePatch && patch.workflowState !== null && typeof patch.workflowState !== 'string') {
      writeJson(res, 400, { error: 'workflowState must be a string or null' });
      return true;
    }
    if (hasWorkflowPriorityPatch && patch.workflowPriority !== null && typeof patch.workflowPriority !== 'string') {
      writeJson(res, 400, { error: 'workflowPriority must be a string or null' });
      return true;
    }
    if (hasLastReviewedAtPatch && patch.lastReviewedAt !== null && typeof patch.lastReviewedAt !== 'string') {
      writeJson(res, 400, { error: 'lastReviewedAt must be a string or null' });
      return true;
    }
    if (hasEntryModePatch && patch.entryMode !== null && typeof patch.entryMode !== 'string') {
      writeJson(res, 400, { error: 'entryMode must be a string or null' });
      return true;
    }
    if (hasEntryModePatch && authSession?.role !== 'owner') {
      writeJson(res, 403, { error: 'Owner access required to update entryMode' });
      return true;
    }
    if (hasGoalPatch && authSession?.role !== 'owner') {
      writeJson(res, 403, { error: 'Owner access required to update goal' });
      return true;
    }
    if (typeof patch.name === 'string' && patch.name.trim() && !getGrantedCapability(authSession, 'renameSession')) {
      writeJson(res, 403, { error: 'Access denied' });
      return true;
    }
    if (hasPinnedPatch && !getGrantedCapability(authSession, 'pinSession')) {
      writeJson(res, 403, { error: 'Access denied' });
      return true;
    }
    if ((hasToolPatch || hasProviderProfilePatch || hasModelPatch || hasEffortPatch || hasThinkingPatch || hasPermissionModePatch || hasPrivilegedModePatch || hasRiskModePatch) && !getGrantedCapability(authSession, 'changeRuntime')) {
      writeJson(res, 403, { error: 'Access denied' });
      return true;
    }
    if (hasRiskModePatch && patch.riskMode !== null && !['safe', 'recommended', 'full-auto', 'conservative-auto'].includes(patch.riskMode)) {
      writeJson(res, 400, { error: 'riskMode must be "safe", "recommended", "full-auto", "conservative-auto" or null' });
      return true;
    }
    if (
      hasWorkflowStatePatch
      && patch.workflowState !== null
      && String(patch.workflowState).trim()
      && !normalizeSessionWorkflowState(String(patch.workflowState))
    ) {
      writeJson(res, 400, { error: 'workflowState must be parked, waiting_user, or done' });
      return true;
    }
    if (
      hasWorkflowPriorityPatch
      && patch.workflowPriority !== null
      && String(patch.workflowPriority).trim()
      && !normalizeSessionWorkflowPriority(String(patch.workflowPriority))
    ) {
      writeJson(res, 400, { error: 'workflowPriority must be high, medium, or low' });
      return true;
    }
    if (
      hasLastReviewedAtPatch
      && patch.lastReviewedAt !== null
      && String(patch.lastReviewedAt).trim()
      && !Number.isFinite(Date.parse(String(patch.lastReviewedAt).trim()))
    ) {
      writeJson(res, 400, { error: 'lastReviewedAt must be a valid timestamp or null' });
      return true;
    }
    if (
      hasEntryModePatch
      && patch.entryMode !== null
      && String(patch.entryMode).trim()
      && !normalizeSessionEntryMode(String(patch.entryMode), { allowDefault: true })
    ) {
      writeJson(res, 400, { error: 'entryMode must be read, resume, or null' });
      return true;
    }
    if (hasGoalPatch && patch.goal !== null) {
      // goal objective/tokenBudget/enabled are user-writable; the status
      // snapshot is codex-mirrored and set only at turn finalize. Keep the
      // 480-char cap in sync with chat/session-goal.mjs.
      if (!patch.goal || typeof patch.goal !== 'object' || Array.isArray(patch.goal)) {
        writeJson(res, 400, { error: 'goal must be an object or null' });
        return true;
      }
      if (patch.goal.objective != null && typeof patch.goal.objective !== 'string') {
        writeJson(res, 400, { error: 'goal.objective must be a string' });
        return true;
      }
      if (typeof patch.goal.objective === 'string' && patch.goal.objective.trim().length > 480) {
        writeJson(res, 400, { error: 'goal.objective is too long (max 480 chars)' });
        return true;
      }
      if (patch.goal.tokenBudget != null
        && !(Number.isFinite(patch.goal.tokenBudget) && patch.goal.tokenBudget > 0)) {
        writeJson(res, 400, { error: 'goal.tokenBudget must be a positive number or null' });
        return true;
      }
      if (patch.goal.enabled != null && typeof patch.goal.enabled !== 'boolean') {
        writeJson(res, 400, { error: 'goal.enabled must be a boolean' });
        return true;
      }
    }
    let session = null;
    try {
    if (typeof patch.name === 'string' && patch.name.trim()) {
      session = await renameSession(sessionId, patch.name.trim());
    }
    if (hasPinnedPatch) {
      session = await setSessionPinned(sessionId, patch.pinned) || session;
    }
    if (hasGroupPatch || hasDescriptionPatch || hasSidebarOrderPatch) {
      session = await updateSessionGrouping(sessionId, {
        ...(hasGroupPatch ? { group: patch.group ?? '' } : {}),
        ...(hasDescriptionPatch ? { description: patch.description ?? '' } : {}),
        ...(hasSidebarOrderPatch ? { sidebarOrder: patch.sidebarOrder ?? null } : {}),
      }) || session;
    }
    if (hasActiveAgreementsPatch) {
      session = await updateSessionAgreements(sessionId, {
        activeAgreements: patch.activeAgreements ?? [],
      }) || session;
    }
    if (hasWorkflowStatePatch || hasWorkflowPriorityPatch) {
      session = await updateSessionWorkflowClassification(sessionId, {
        ...(hasWorkflowStatePatch ? { workflowState: patch.workflowState || '' } : {}),
        ...(hasWorkflowPriorityPatch ? { workflowPriority: patch.workflowPriority || '' } : {}),
      }) || session;
    }
    if (hasToolPatch || hasProviderProfilePatch || hasModelPatch || hasEffortPatch || hasServiceTierPatch || hasThinkingPatch || hasPermissionModePatch || hasInteractionModePatch || hasPrivilegedModePatch || hasRiskModePatch) {
      session = await updateSessionRuntimePreferences(sessionId, {
        ...(hasToolPatch ? { tool: patch.tool } : {}),
        ...(hasProviderProfilePatch ? { providerProfile: patch.providerProfile ?? '' } : {}),
        ...(hasModelPatch ? { model: patch.model } : {}),
        ...(hasEffortPatch ? { effort: patch.effort } : {}),
        ...(hasServiceTierPatch ? { serviceTier: patch.serviceTier } : {}),
        ...(hasThinkingPatch ? { thinking: patch.thinking } : {}),
        ...(hasPermissionModePatch ? { permissionMode: patch.permissionMode } : {}),
        ...(hasInteractionModePatch ? { interactionMode: patch.interactionMode } : {}),
        ...(hasPrivilegedModePatch ? { privilegedMode: patch.privilegedMode } : {}),
        ...(hasRiskModePatch ? { riskMode: patch.riskMode } : {}),
      }) || session;
    }
    if (hasLastReviewedAtPatch) {
      session = await updateSessionLastReviewedAt(sessionId, patch.lastReviewedAt || '') || session;
    }
    if (hasEntryModePatch) {
      session = await updateSessionEntryMode(sessionId, patch.entryMode || '') || session;
    }
    if (hasGoalPatch) {
      session = await updateSessionGoal(sessionId, patch.goal) || session;
    }
    if (!session) {
      session = await getSessionForClient(sessionId);
    }
    if (!session) {
      writeJson(res, 404, { error: 'Session not found' });
      return true;
    }
    writeJson(res, 200, { session: createClientSessionDetail(session) });
    } catch (error) {
      writeJson(res, Number.isInteger(error?.statusCode) ? error.statusCode : 500, {
        error: error?.message || 'Failed to update session',
        ...(error?.code ? { code: error.code } : {}),
      });
    }
    return true;
  }

  if (pathname.startsWith('/api/sessions/') && req.method === 'POST') {
    const parts = pathname.split('/').filter(Boolean);
    const sessionId = parts[2];
    const action = parts[3] || null;

    if (parts.length === 4 && parts[0] === 'api' && parts[1] === 'sessions' && sessionId && action === 'assistant-messages') {
      if (!await requireSessionAccess(res, authSession, sessionId)) return true;
      if (authSession?.role !== 'owner' && authSession?.principalKind !== 'run_capability') {
        writeJson(res, 403, { error: 'Owner access required' });
        return true;
      }
      const targetSession = await getSessionForClient(sessionId);
      if (!targetSession) {
        writeJson(res, 404, { error: 'Session not found' });
        return true;
      }
      let body;
      try {
        body = await readSessionMessagePayload(req, pathname);
      } catch (err) {
        writeJson(res, err.code === 'BODY_TOO_LARGE' ? 413 : 400, { error: err.code === 'BODY_TOO_LARGE' ? 'Request body too large' : 'Bad request' });
        return true;
      }
      const payload = body;
      if (!payload || typeof payload !== 'object') {
        writeJson(res, 400, { error: 'Invalid request body' });
        return true;
      }
      const source = payload.source || 'assistant_message_api';
      try {
        const requestedAttachments = Array.isArray(payload?.attachments) ? payload.attachments.filter(Boolean) : [];
        const preSavedAttachments = await resolveRequestedSessionAttachments(authSession, requestedAttachments, {
          sessionId,
          allowLocalPaths: true,
          createdBy: 'assistant',
        });
        const outcome = await appendAssistantMessage(sessionId, payload.text || '', [], {
          requestId: typeof payload?.requestId === 'string' ? payload.requestId.trim() : '',
          runId: typeof payload?.runId === 'string' ? payload.runId.trim() : '',
          source,
          ...(preSavedAttachments.length > 0 ? { preSavedAttachments } : {}),
        });
        writeJson(res, 201, {
          event: outcome.event,
          session: createClientSessionDetail(outcome.session),
        });
      } catch (error) {
        const statusCode = Number.isInteger(error?.statusCode)
          ? error.statusCode
          : (error?.code === 'MESSAGE_EMPTY' ? 400 : 400);
        writeJson(res, statusCode, { error: error.message || 'Failed to append assistant message' });
      }
      return true;
    }

    if (parts.length === 4 && parts[0] === 'api' && parts[1] === 'sessions' && sessionId && action === 'voice-transcriptions' && req.method === 'POST') {
      if (!await requireSessionAccess(res, authSession, sessionId)) return true;
      writeJson(res, 410, { error: 'Voice transcript cleanup has been removed. Send messages directly.' });
      return true;
    }

    if (parts.length === 4 && parts[0] === 'api' && parts[1] === 'sessions' && sessionId && action === 'compact') {
      if (authSession?.role === 'visitor') {
        writeJson(res, 403, { error: 'Owner access required' });
        return true;
      }
      if (!await compactSession(sessionId)) {
        writeJson(res, 409, { error: 'Unable to compact session' });
        return true;
      }
      writeJson(res, 200, { ok: true, session: await getSessionForClient(sessionId) });
      return true;
    }

    if (parts.length === 4 && parts[0] === 'api' && parts[1] === 'sessions' && sessionId && action === 'drop-tools') {
      if (authSession?.role === 'visitor') {
        writeJson(res, 403, { error: 'Owner access required' });
        return true;
      }
      if (!await dropToolUse(sessionId)) {
        writeJson(res, 409, { error: 'Unable to drop tool results' });
        return true;
      }
      writeJson(res, 200, { ok: true, session: await getSessionForClient(sessionId) });
      return true;
    }

    if (parts.length === 5 && parts[0] === 'api' && parts[1] === 'sessions' && sessionId && parts[3] === 'goal' && parts[4] === 'control') {
      if (!await requireSessionAccess(res, authSession, sessionId)) return true;
      if (authSession?.role !== 'owner') {
        writeJson(res, 403, { error: 'Owner access required to control goal chasing' });
        return true;
      }
      let payload;
      try {
        payload = await readJsonRequestBody(req, 4096);
      } catch {
        writeJson(res, 400, { error: 'Invalid request body' });
        return true;
      }
      const controlAction = typeof payload?.action === 'string' ? payload.action.trim().toLowerCase() : '';
      if (controlAction !== 'pause' && controlAction !== 'resume') {
        writeJson(res, 400, { error: "action must be 'pause' or 'resume'" });
        return true;
      }
      const existing = await getSessionForClient(sessionId);
      if (!existing) {
        writeJson(res, 404, { error: 'Session not found' });
        return true;
      }
      const existingGoal = normalizeSessionGoal(existing.goal);
      if (!existingGoal) {
        writeJson(res, 409, { error: 'No goal set for this session' });
        return true;
      }
      if (existingGoal.enabled === false) {
        writeJson(res, 409, { error: 'Goal is disabled' });
        return true;
      }

      if (controlAction === 'pause') {
        await mutateSessionMeta(sessionId, (draft) => {
          const goal = normalizeSessionGoal(draft.goal);
          if (!goal || goal.chasing !== true) return false;
          goal.chasing = false;
          draft.goal = goal;
          draft.updatedAt = new Date().toISOString();
          return true;
        });
        writeJson(res, 200, { session: await getSessionForClient(sessionId) });
        return true;
      }

      // S13 permission attribute completeness: the goal-resume continuation is a
      // message-input bypass surface beyond S10's fork/fork-at/delegate/messages
      // coverage. A managed session (sessionPlane=organization) must never
      // receive an uncontrolled continuation, so it is intercepted here even
      // though the internal sendMessage carries a goal_continue marker that the
      // S10 gate would otherwise exempt. No-op when the flag is off.
      const rawGoalSession = await getSession(sessionId);
      try {
        assertManagedInputAllowed({ session: rawGoalSession, operation: 'continuation' });
      } catch (error) {
        if (error?.code === MANAGED_SESSION_INPUT_BYPASS) {
          writeJson(res, 409, { error: error.message, code: error.code });
          return true;
        }
        throw error;
      }

      // resume: re-arm chasing, reset the chase accounting, and kick a
      // continuation turn immediately if the session is idle. If work is already
      // running or queued the chase resumes naturally when that work finalizes.
      const resumed = await mutateSessionMeta(sessionId, (draft) => {
        const goal = normalizeSessionGoal(draft.goal);
        if (!goal) return false;
        goal.chasing = true;
        goal.continuationCount = 0;
        goal.continuationLastAt = '';
        goal.continuationLastTokensUsed = null;
        goal.continuationNoProgress = 0;
        draft.goal = goal;
        draft.updatedAt = new Date().toISOString();
        return true;
      });
      const queueLen = Array.isArray(resumed.meta?.followUpQueue) ? resumed.meta.followUpQueue.length : 0;
      if (resumed.meta && !resumed.meta.activeRunId && queueLen === 0) {
        try {
          await sendMessage(sessionId, buildGoalContinuationPrompt(resumed.meta.goal), [], {
            tool: resumed.meta.tool,
            recordUserMessage: false,
            queueIfBusy: false,
            internalOperation: GOAL_CONTINUE_INTERNAL_OPERATION,
          });
        } catch (error) {
          writeJson(res, 500, { error: `Could not start goal continuation: ${error?.message || 'unknown error'}` });
          return true;
        }
      }
      writeJson(res, 200, { session: await getSessionForClient(sessionId) });
      return true;
    }

    if (parts.length === 4 && parts[0] === 'api' && parts[1] === 'sessions' && sessionId && action === 'apply-template') {
      if (authSession?.role === 'visitor') {
        writeJson(res, 403, { error: 'Owner access required' });
        return true;
      }
      if (!await requireSessionAccess(res, authSession, sessionId)) return true;
      let body;
      try { body = await readBody(req, 10240); } catch {
        writeJson(res, 400, { error: 'Bad request' });
        return true;
      }
      let payload;
      try { payload = JSON.parse(body); } catch {
        writeJson(res, 400, { error: 'Invalid request body' });
        return true;
      }
      const templateId = typeof payload?.templateId === 'string' ? payload.templateId.trim() : '';
      if (!templateId) {
        writeJson(res, 400, { error: 'templateId is required' });
        return true;
      }
      const session = await getSessionForClient(sessionId);
      if (!session) {
        writeJson(res, 404, { error: 'Session not found' });
        return true;
      }
      if (session.activity?.run?.state === 'running') {
        writeJson(res, 409, { error: 'Session is running' });
        return true;
      }
      if ((session.messageCount || 0) > 0) {
        writeJson(res, 409, { error: 'Templates can only be applied before the first message' });
        return true;
      }
      const updated = await applyTemplateToSession(sessionId, templateId, {
        appendWelcome: true,
      });
      if (!updated) {
        writeJson(res, 409, { error: 'Unable to apply template' });
        return true;
      }
      writeJson(res, 200, { session: createClientSessionDetail(updated) });
      return true;
    }

    if (parts.length === 4 && parts[0] === 'api' && parts[1] === 'sessions' && sessionId && action === 'save-template') {
      if (authSession?.role === 'visitor') {
        writeJson(res, 403, { error: 'Owner access required' });
        return true;
      }
      if (!await requireSessionAccess(res, authSession, sessionId)) return true;
      let body = '';
      try { body = await readBody(req, 10240); } catch {
        writeJson(res, 400, { error: 'Bad request' });
        return true;
      }
      let payload = {};
      if (body) {
        try { payload = JSON.parse(body); } catch {
          writeJson(res, 400, { error: 'Invalid request body' });
          return true;
        }
      }
      const session = await getSessionForClient(sessionId);
      if (!session) {
        writeJson(res, 404, { error: 'Session not found' });
        return true;
      }
      const template = await saveSessionAsTemplate(sessionId, typeof payload?.name === 'string' ? payload.name.trim() : '');
      if (!template) {
        writeJson(res, 409, { error: 'Unable to save template' });
        return true;
      }
      writeJson(res, 201, { template });
      return true;
    }

    if (parts.length === 4 && parts[0] === 'api' && parts[1] === 'sessions' && sessionId && action === 'fork') {
      if (!await requireSessionAccess(res, authSession, sessionId)) return true;
      if (!getGrantedCapability(authSession, 'forkSession')) {
        writeJson(res, 403, { error: 'Access denied' });
        return true;
      }
      const preparation = await prepareSessionForFork(sessionId);
      const source = await getSessionForClient(sessionId);
      if (!source) {
        writeJson(res, 404, { error: 'Session not found' });
        return true;
      }
      if (source.visitorId) {
        writeJson(res, 409, { error: 'Visitor sessions cannot be forked' });
        return true;
      }
      if (preparation?.running || source.activity?.run?.state === 'running') {
        writeJson(res, 409, { error: 'Session is running' });
        return true;
      }
      const session = await forkSession(sessionId);
      if (!session) {
        writeJson(res, 409, { error: 'Unable to fork session' });
        return true;
      }
      writeJson(res, 201, { session: createClientSessionDetail(session) });
      return true;
    }

    if (parts.length === 4 && parts[0] === 'api' && parts[1] === 'sessions' && sessionId && action === 'fork-at') {
      if (!await requireSessionAccess(res, authSession, sessionId)) return true;
      if (!getGrantedCapability(authSession, 'forkSession')) {
        writeJson(res, 403, { error: 'Access denied' });
        return true;
      }
      let body = '';
      try {
        body = await readBody(req, 16 * 1024);
      } catch {
        writeJson(res, 400, { error: 'Bad request' });
        return true;
      }
      let payload = {};
      try {
        payload = body ? JSON.parse(body) : {};
      } catch {
        writeJson(res, 400, { error: 'Invalid request body' });
        return true;
      }
      try {
        const session = await forkSessionAt(sessionId, {
          anchorSeq: payload?.anchorSeq,
          mode: payload?.mode,
          idempotencyKey: payload?.idempotencyKey,
        });
        writeJson(res, 201, { session: createClientSessionDetail(session) });
      } catch (error) {
        const status = error?.code === 'FORK_FORBIDDEN' ? 403
          : ['SESSION_NOT_FOUND'].includes(error?.code) ? 404
            : ['SESSION_RUNNING', 'FORK_ANCHOR_INVALID', 'FORK_TOO_LARGE', 'FORK_HISTORY_INCOMPLETE', 'HISTORY_BASE_INVALID', 'HISTORY_BASE_UNAVAILABLE', 'HISTORY_BASE_CYCLE', 'HISTORY_BASE_DEPTH', 'HISTORY_BASE_IMMUTABLE'].includes(error?.code) ? 409
              : 400;
        writeJson(res, status, {
          error: error?.message || 'Unable to fork session',
          ...(error?.code ? { code: error.code } : {}),
        });
      }
      return true;
    }

    if (parts.length === 4 && parts[0] === 'api' && parts[1] === 'sessions' && sessionId && action === 'delegate') {
      if (!await requireSessionAccess(res, authSession, sessionId)) return true;
      const source = await getSessionForClient(sessionId);
      if (!source) {
        writeJson(res, 404, { error: 'Session not found' });
        return true;
      }
      if (source.visitorId) {
        writeJson(res, 409, { error: 'Visitor sessions cannot be delegated' });
        return true;
      }
      let payload = {};
      try {
        const body = await readBody(req, 32768);
        payload = body ? JSON.parse(body) : {};
      } catch {
        writeJson(res, 400, { error: 'Invalid request body' });
        return true;
      }

      const task = typeof payload?.task === 'string' ? payload.task.trim() : '';
      if (!task) {
        writeJson(res, 400, { error: 'task is required' });
        return true;
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'tool') && payload.tool !== null && typeof payload.tool !== 'string') {
        writeJson(res, 400, { error: 'tool must be a string when provided' });
        return true;
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'internal') && typeof payload.internal !== 'boolean') {
        writeJson(res, 400, { error: 'internal must be a boolean when provided' });
        return true;
      }

      try {
        const outcome = await delegateSession(sessionId, {
          task,
          name: typeof payload?.name === 'string' ? payload.name.trim() : '',
          tool: typeof payload?.tool === 'string' ? payload.tool.trim() : '',
          internal: payload?.internal === true,
        });
        if (!outcome?.session) {
          writeJson(res, 409, { error: 'Unable to delegate session' });
          return true;
        }
        writeJson(res, 201, {
          session: createClientSessionDetail(outcome.session),
          run: outcome.run || null,
        });
      } catch (error) {
        writeJson(res, 400, { error: error.message || 'Failed to delegate session' });
      }
      return true;
    }
  }

  if (pathname === '/api/account-policy' && (req.method === 'GET' || req.method === 'PATCH')) {
    // Account-level permission policy (账号级权限模式): one owner-controlled
    // default ('full-auto' | 'approval' | 'conservative-auto' | '' = built-in default) shared by
    // every instance of the account through the runtime-policy sync scope.
    if (authSession?.role !== 'owner') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (req.method === 'GET') {
        writeJson(res, 200, { policy: await loadAccountPolicy() });
        return true;
      }
      const payload = await readJsonRequestBody(req, 4096);
      if (payload && typeof payload !== 'object') {
        writeJson(res, 400, { error: 'Invalid request body' });
        return true;
      }
      const requested = typeof payload.permissionPolicy === 'string' ? payload.permissionPolicy.trim().toLowerCase() : '';
      if (requested && !['full-auto', 'approval', 'conservative-auto'].includes(requested)) {
        writeJson(res, 400, { error: 'permissionPolicy must be "full-auto", "approval", "conservative-auto" or ""' });
        return true;
      }
      const previous = await loadAccountPolicy();
      const policy = await saveAccountPolicy({ permissionPolicy: requested });
      if (previous.permissionPolicy !== policy.permissionPolicy) {
        const context = await getNativeProviderManagementContext();
        await recordRuntimePolicySyncMutation({ ledger: context.ledger, sourceInstanceId: context.sourceInstanceId });
        scheduleProviderSync(context);
      }
      writeJson(res, 200, { policy });
    } catch (error) {
      writeJson(res, Number.isInteger(error?.statusCode) ? error.statusCode : 400, {
        error: error?.message || 'Failed to save account policy',
      });
    }
    return true;
  }

  if (pathname === '/api/runtime-selection' && req.method === 'POST') {
    if (authSession?.role === 'visitor') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }
    let body;
    try { body = await readBody(req, 4096); } catch (err) {
      writeJson(res, err.code === 'BODY_TOO_LARGE' ? 413 : 400, { error: err.code === 'BODY_TOO_LARGE' ? 'Request body too large' : 'Bad request' });
      return true;
    }
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      writeJson(res, 400, { error: 'Invalid request body' });
      return true;
    }
    try {
      const selection = await saveUiRuntimeSelection(payload || {});
      writeJson(res, 200, { selection });
    } catch (error) {
      writeJson(res, 400, { error: error.message || 'Failed to save runtime selection' });
    }
    return true;
  }

  if (pathname === '/api/runtime-selection' && req.method === 'GET') {
    if (authSession?.role === 'visitor') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }
    writeJson(res, 200, { selection: await loadUiRuntimeSelection() });
    return true;
  }

  if (pathname === '/api/models' && req.method === 'GET') {
    const toolId = parsedUrl.query ? parsedUrl.query.tool || '' : '';
    const providerProfileId = parsedUrl.query ? String(parsedUrl.query.provider || '').trim() : '';
    const refreshRequested = ['1', 'true', 'yes'].includes(
      String(parsedUrl.query?.refresh || '').trim().toLowerCase(),
    );
    // Model-picker reads must stay responsive even when an upstream
    // /models endpoint is slow or offline. The fast path serves configured or
    // previously cached rows and lets models.mjs refresh upstream catalogs in
    // the background; the client adds refresh=1 after a Provider selection
    // when it needs the authoritative upstream catalog for that profile.
    const result = await getModelsForTool(toolId, {
      providerProfile: providerProfileId,
      fast: !refreshRequested,
    });
    // Provider-scoped catalog metadata (cross-device model catalog contract):
    // per-provider entries carry providerProfileId, source, catalogVersion,
    // and status. Legacy fields (models/effortLevels/defaultModel/reasoning)
    // stay byte-compatible for existing consumers.
    try {
      const catalog = await getToolModelCatalog(toolId, providerProfileId, { fast: !refreshRequested });
      const catalogs = await getToolModelCatalogs(toolId, providerProfileId, { fast: !refreshRequested });
      const serializeCatalog = (value) => ({
        providerProfileId: value.providerProfileId,
        catalogVersion: value.catalogVersion,
        fetchedAt: value.fetchedAt || null,
        expiresAt: value.expiresAt || null,
        source: value.source,
        status: value.status,
        defaultModel: filterWorkbenchModels(value, toolId).defaultModel || null,
        ...(value.defaultModelError ? { defaultModelError: value.defaultModelError } : {}),
        ...(value.error ? { error: value.error } : {}),
        models: filterWorkbenchModels(value, toolId).models.map((entry) => ({
          id: entry.id,
          model: entry.model,
          providerProfileId: entry.providerProfileId,
          label: entry.label,
          source: entry.source,
          capabilities: entry.capabilities,
          ...(Number.isFinite(entry.contextWindow) ? { contextWindow: entry.contextWindow } : {}),
        })),
      });
      const response = {
        ...result,
        ...(catalog ? { catalog: serializeCatalog(catalog) } : {}),
        ...(catalogs.length > 0 ? { catalogs: catalogs.map(serializeCatalog) } : {}),
      };
      if (catalog || catalogs.length > 0) {
        writeJsonCached(req, res, response);
        return true;
      }
    } catch (error) {
      console.error(`[api] model catalog metadata failed: ${error?.message || String(error)}`);
    }
    writeJsonCached(req, res, result);
    return true;
  }

  if (pathname === '/api/owner/webauthn/status' && req.method === 'GET') {
    if (authSession?.role !== 'owner') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }
    writeJson(res, 200, { webauthn: await getOwnerWebAuthnState() });
    return true;
  }

  if (pathname === '/api/owner/webauthn/registration-options' && req.method === 'POST') {
    if (authSession?.role !== 'owner') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }
    try {
      const payload = await readJsonRequestBody(req);
      writeJson(res, 200, await createOwnerWebAuthnRegistrationOptions(req, {
        authenticatorAttachment: payload?.authenticatorAttachment || payload?.attachment || '',
        hints: payload?.hints,
      }));
    } catch (error) {
      writeJson(res, Number.isInteger(error?.statusCode) ? error.statusCode : 400, {
        error: error?.message || 'WebAuthn registration setup failed',
        ...(error?.code ? { code: error.code } : {}),
      });
    }
    return true;
  }

  if (pathname === '/api/owner/webauthn/registration-verify' && req.method === 'POST') {
    if (authSession?.role !== 'owner') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }
    try {
      const payload = await readJsonRequestBody(req);
      writeJson(res, 200, { webauthn: await verifyOwnerWebAuthnRegistration(payload) });
    } catch (error) {
      writeJson(res, Number.isInteger(error?.statusCode) ? error.statusCode : 400, {
        error: error?.message || 'WebAuthn registration failed',
        ...(error?.code ? { code: error.code } : {}),
      });
    }
    return true;
  }

  if (pathname === '/api/owner/webauthn/assertion-options' && req.method === 'POST') {
    if (authSession?.role !== 'owner') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }
    try {
      const payload = await readJsonRequestBody(req);
      writeJson(res, 200, await createOwnerWebAuthnAssertionOptions(req, {
        purpose: payload?.purpose || '',
        sessionId: payload?.sessionId || '',
        requestId: payload?.requestId || '',
        manifestHash: payload?.manifestHash || '',
      }));
    } catch (error) {
      writeJson(res, Number.isInteger(error?.statusCode) ? error.statusCode : 400, {
        error: error?.message || 'WebAuthn assertion setup failed',
        ...(error?.code ? { code: error.code } : {}),
      });
    }
    return true;
  }

  if (pathname === '/api/owner/webauthn/assertion-verify' && req.method === 'POST') {
    if (authSession?.role !== 'owner') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }
    try {
      const payload = await readJsonRequestBody(req);
      writeJson(res, 200, { webauthn: await verifyOwnerWebAuthnAssertion(payload) });
    } catch (error) {
      writeJson(res, Number.isInteger(error?.statusCode) ? error.statusCode : 400, {
        error: error?.message || 'WebAuthn assertion failed',
        ...(error?.code ? { code: error.code } : {}),
      });
    }
    return true;
  }

  if (pathname === '/api/tools' && req.method === 'GET') {
    const tools = await getPublicAvailableToolsAsync();
    writeJsonCached(req, res, { tools: tools.filter((tool) => workbenchToolAllowed(tool.id)) });
    return true;
  }

  if (pathname === '/api/tools' && req.method === 'POST') {
    if (authSession?.role !== 'owner') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Owner access required' }));
      return true;
    }

    let body;
    try { body = await readBody(req, 65536); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Bad request' }));
      return true;
    }

    try {
      const { name, command, runtimeFamily, models, reasoning } = JSON.parse(body);
      const tool = await saveSimpleToolAsync({ name, command, runtimeFamily, models, reasoning });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tool }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || 'Invalid request body' }));
    }
    return true;
  }

  if (pathname === '/api/autocomplete' && req.method === 'GET') {
    const query = parsedUrl.query.q || '';
    const suggestions = [];
    try {
      const resolvedQuery = query.startsWith('~') ? join(homedir(), query.slice(1)) : query;
      const parentDir = dirname(resolvedQuery);
      const prefix = basename(resolvedQuery);
      if (await isDirectoryPath(parentDir)) {
        for (const entry of await readdir(parentDir)) {
          if (!prefix.startsWith('.') && entry.startsWith('.')) continue;
          const fullPath = join(parentDir, entry);
          if (await isDirectoryPath(fullPath)) {
            if (entry.toLowerCase().startsWith(prefix.toLowerCase())) {
              suggestions.push(fullPath);
            }
          }
        }
      }
    } catch {}
    writeJsonCached(req, res, { suggestions: suggestions.slice(0, 20) });
    return true;
  }

  // Web 自助改密（静态 access token 下线后密码为唯一登录方式）
  if (pathname === '/api/account/password' && req.method === 'POST') {
    if (authSession?.role !== 'owner') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }
    let body;
    try {
      body = JSON.parse(await readBody(req, 4096));
    } catch {
      writeJson(res, 400, { error: 'Invalid request body' });
      return true;
    }
    const result = await setOwnerPasswordAsync({
      currentPassword: body.currentPassword,
      newPassword: body.newPassword,
    });
    if (!result.ok) {
      writeJson(res, 400, { error: result.error });
      return true;
    }
    writeJson(res, 200, { ok: true });
    return true;
  }

  if (pathname === '/api/workspace-files' && req.method === 'GET') {
    if (authSession?.role !== 'owner') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }
    const resolved = await resolveWorkspaceReadableRequest({
      parsedUrl,
      authSession,
      requireSessionAccess,
      writeJson,
      res,
    });
    if (!resolved) return true;
    try {
      const relativeDirectory = normalizeWorkspaceRelativePath(parsedUrl.query?.path);
      const directoryPath = relativeDirectory ? resolve(resolved.rootPath, relativeDirectory) : resolved.rootPath;
      if (!isPathInsideRoot(resolved.rootPath, directoryPath)) {
        writeJson(res, 400, { error: 'Workspace directory is outside this workspace' });
        return true;
      }
      let directoryStats;
      try {
        directoryStats = await stat(directoryPath);
      } catch (error) {
        writeJson(res, error?.code === 'ENOENT' ? 404 : 400, { error: 'Workspace directory was not found' });
        return true;
      }
      if (!directoryStats.isDirectory()) {
        writeJson(res, 400, { error: 'Workspace path is not a directory' });
        return true;
      }
      const { files, directories } = await collectWorkspaceReadableEntries(
        resolved.rootPath,
        directoryPath,
        relativeDirectory ? { recursive: false } : {},
      );
      writeJsonCached(req, res, {
        root: resolved.rootPath,
        workspace: resolved.workspace || resolved.rootPath,
        ...(resolved.session?.id ? { sessionId: resolved.session.id } : {}),
        files,
        directories,
        truncated: files.length >= WORKSPACE_READABLE_MAX_FILES || directories.length >= WORKSPACE_READABLE_MAX_DIRS,
      });
    } catch (error) {
      writeJson(res, 500, { error: error.message || 'Failed to list workspace files' });
    }
    return true;
  }

  if (pathname === '/api/workspace-files/content' && req.method === 'GET') {
    if (authSession?.role !== 'owner') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }
    const resolved = await resolveWorkspaceReadableRequest({
      parsedUrl,
      authSession,
      requireSessionAccess,
      writeJson,
      res,
    });
    if (!resolved) return true;

    const requestedPath = typeof parsedUrl.query?.path === 'string' ? parsedUrl.query.path.trim() : '';
    if (!requestedPath) {
      writeJson(res, 400, { error: 'path is required' });
      return true;
    }
    // Runtime tools often report absolute paths. Only accept them when they
    // remain inside the authenticated workspace/session root.
    const filepath = isAbsolute(requestedPath)
      ? resolve(requestedPath)
      : resolve(resolved.rootPath, normalizeWorkspaceRelativePath(requestedPath));
    if (!isPathInsideRoot(resolved.rootPath, filepath) || !isWorkspaceReadableFile(filepath)) {
      writeJson(res, 400, { error: 'File is not readable from this workspace' });
      return true;
    }

    try {
      const [realRoot, realFile] = await Promise.all([realpath(resolved.rootPath), realpath(filepath)]);
      if (!isPathInsideRoot(realRoot, realFile)) {
        writeJson(res, 403, { error: 'File is outside this workspace' });
        return true;
      }
      const fileStats = await stat(realFile);
      if (!fileStats.isFile()) {
        writeJson(res, 404, { error: 'File not found' });
        return true;
      }
      const extension = extname(filepath).toLowerCase();
      if (extension !== '.pdf' && fileStats.size > WORKSPACE_MARKDOWN_MAX_BYTES) {
        writeJson(res, 413, { error: 'Markdown file is too large to preview' });
        return true;
      }
      const downloadRequested = String(parsedUrl?.query?.download || '') === '1';
      streamResponse(res, realFile, {
        'Content-Type': workspaceReadableFileTypes[extension] || 'application/octet-stream',
        'Content-Disposition': buildAttachmentContentDisposition(basename(filepath), { attachment: downloadRequested }),
        'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
      });
    } catch (error) {
      writeJson(res, error?.code === 'ENOENT' ? 404 : 500, { error: error.message || 'Failed to read workspace file' });
    }
    return true;
  }

  if (pathname === '/api/browse' && req.method === 'GET') {
    // A mobile picker cannot infer a Windows machine's mounted volumes from
    // its home directory. Keep the root enumeration on the machine that owns
    // the files, then let every client browse the same directory contract.
    if (String(parsedUrl.query.roots || '') === '1') {
      try {
        const rootCandidates = process.platform === 'win32'
          ? Array.from({ length: 26 }, (_, index) => `${String.fromCharCode(65 + index)}:\\`)
          : [resolve('/')];
        const roots = (await Promise.all(rootCandidates.map(async (candidate) => {
          try {
            return (await stat(candidate)).isDirectory()
              ? { name: candidate, path: candidate }
              : null;
          } catch {
            return null;
          }
        }))).filter(Boolean);
        // Containers commonly expose a read-only filesystem root while HOME
        // is on a writable volume. Offer HOME directly as a useful starting
        // location without hiding the rest of the filesystem.
        if (process.platform !== 'win32') {
          const home = homedir();
          if (home !== resolve('/') && await isDirectoryPath(home)) {
            roots.unshift({ name: 'Home', path: home });
          }
        }
        // Mounted volumes can change while the service is running. Do not
        // retain a cached root list; the caller already loads this only when
        // the location picker is opened.
        writeJson(res, 200, { roots });
      } catch {
        writeJson(res, 500, { error: 'Failed to list available locations' });
      }
      return true;
    }
    const pathQuery = parsedUrl.query.path || '~';
    try {
      const resolvedPath = pathQuery === '~' || pathQuery === ''
        ? homedir()
        : pathQuery.startsWith('~')
          ? join(homedir(), pathQuery.slice(1))
          : resolve(pathQuery);
      const children = [];
      let parent = null;
      if (await isDirectoryPath(resolvedPath)) {
        const parentPath = dirname(resolvedPath);
        parent = parentPath !== resolvedPath ? parentPath : null;
        let entries;
        try {
          entries = await readdir(resolvedPath);
        } catch (error) {
          if (error?.code === 'EACCES' || error?.code === 'EPERM') {
            writeJson(res, 403, {
              error: 'Directory is not accessible',
              code: error.code,
              path: resolvedPath,
              parent,
              children,
            });
            return true;
          }
          throw error;
        }
        for (const entry of entries) {
          if (entry.startsWith('.')) continue;
          const fullPath = join(resolvedPath, entry);
          try {
            if (await isDirectoryPath(fullPath)) children.push({ name: entry, path: fullPath });
          } catch {}
        }
        children.sort((a, b) => a.name.localeCompare(b.name));
      }
      writeJsonCached(req, res, { path: resolvedPath, parent, children });
    } catch {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to browse directory' }));
    }
    return true;
  }

  if (pathname === '/api/browse/mkdir' && req.method === 'POST') {
    if (authSession?.role !== 'owner') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }
    let payload = {};
    try {
      payload = JSON.parse(await readBody(req, 4096));
    } catch {
      writeJson(res, 400, { error: 'Invalid request body' });
      return true;
    }
    const parentQuery = typeof payload?.path === 'string' ? payload.path.trim() : '';
    const name = typeof payload?.name === 'string' ? payload.name.trim() : '';
    if (!name || name === '.' || name === '..' || /[\\/]/.test(name)) {
      writeJson(res, 400, { error: 'Folder name must be a single directory name', code: 'FOLDER_NAME_INVALID' });
      return true;
    }
    try {
      const parentPath = parentQuery === '~' || parentQuery === ''
        ? homedir()
        : parentQuery.startsWith('~')
          ? join(homedir(), parentQuery.slice(1))
          : resolve(parentQuery);
      if (!await isDirectoryPath(parentPath)) {
        writeJson(res, 404, { error: 'Parent directory not found', code: 'FOLDER_PARENT_NOT_FOUND' });
        return true;
      }
      const folderPath = join(parentPath, name);
      await mkdir(folderPath);
      writeJson(res, 201, { path: folderPath, name });
    } catch (error) {
      const status = error?.code === 'EEXIST' ? 409 : ['EACCES', 'EPERM', 'EROFS'].includes(error?.code) ? 403 : 500;
      writeJson(res, status, {
        error: error?.code === 'EEXIST' ? 'A folder with this name already exists'
          : error?.code === 'EROFS' ? 'This location is read-only. Choose a writable folder, such as your home or workspace folder.'
          : ['EACCES', 'EPERM'].includes(error?.code) ? 'You cannot create a folder in this location. Choose a writable folder, such as your home or workspace folder.'
          : error?.message || 'Failed to create folder',
        code: error?.code || 'FOLDER_CREATE_FAILED',
      });
    }
    return true;
  }

  if ((pathname.startsWith('/api/images/') || pathname.startsWith('/api/media/')) && req.method === 'GET') {
    const prefix = pathname.startsWith('/api/media/') ? '/api/media/' : '/api/images/';
    const filename = pathname.slice(prefix.length);
    if (!/^[a-zA-Z0-9_-]+\.[a-z0-9]+$/.test(filename)) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Invalid filename');
      return true;
    }
    const filepath = join(CHAT_IMAGES_DIR, filename);
    if (!await pathExists(filepath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return true;
    }
    const ext = filename.split('.').pop()?.toLowerCase();
    writeFileCached(req, res, uploadedMediaMimeTypes[ext] || 'application/octet-stream', await readFile(filepath), {
      cacheControl: 'public, max-age=31536000, immutable',
    });
    return true;
  }

  if (pathname === '/api/push/vapid-public-key' && req.method === 'GET') {
    writeJsonCached(req, res, { publicKey: await getPublicKey() });
    return true;
  }

  if (pathname === '/api/push/subscribe' && req.method === 'POST') {
    let body;
    try { body = await readBody(req, 4096); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Bad request' }));
      return true;
    }
    try {
      const sub = JSON.parse(body);
      if (!sub.endpoint) throw new Error('Missing endpoint');
      await addSubscription(sub);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid subscription' }));
    }
    return true;
  }

  if (pathname === '/api/push/fcm/register' && req.method === 'POST') {
    if (authSession?.role !== 'owner') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }
    try {
      const payload = await readJsonRequestBody(req, 12 * 1024);
      await registerFcmToken({ ...payload, platform: 'android' });
      writeJson(res, 200, { ok: true, transport: 'fcm' });
    } catch (error) {
      writeJson(res, 400, { error: error?.message || 'Invalid FCM token' });
    }
    return true;
  }

  if (pathname === '/api/push/fcm/unregister' && req.method === 'POST') {
    if (authSession?.role !== 'owner') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }
    try {
      const payload = await readJsonRequestBody(req, 8 * 1024);
      await unregisterFcmToken(payload?.token);
      writeJson(res, 200, { ok: true });
    } catch (error) {
      writeJson(res, 400, { error: error?.message || 'Invalid FCM token' });
    }
    return true;
  }

  // POST /api/notifications — broadcast a system notification to connected clients
  if (pathname === '/api/notifications' && req.method === 'POST') {
    if (authSession?.role === 'visitor') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }
    let body;
    try { body = await readBody(req, 10240); } catch {
      writeJson(res, 400, { error: 'Bad request' });
      return true;
    }
    let payload;
    try { payload = JSON.parse(body); } catch {
      writeJson(res, 400, { error: 'Invalid request body' });
      return true;
    }
    const message = typeof payload.message === 'string' ? payload.message.trim() : '';
    const level = ['info', 'warn', 'error'].includes(payload.level) ? payload.level : 'info';
    if (!message) {
      writeJson(res, 400, { error: 'Missing message' });
      return true;
    }
    const { broadcastOwners } = await import('./ws-clients.mjs');
    broadcastOwners({ type: 'system_notification', message, level });
    writeJson(res, 200, { ok: true });
    return true;
  }

  // GET /api/mailbox/status — recent mailbox failures & stats
  if (pathname === '/api/mailbox/status' && req.method === 'GET') {
    if (authSession?.role === 'visitor') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }
    try {
      const mailboxRoot = join(CONFIG_DIR, 'agent-mailbox');
      const approvedDir = join(mailboxRoot, 'approved');
      let files = [];
      try { files = await readdir(approvedDir); } catch {}
      const failures = [];
      for (const file of files.slice(-50)) {
        if (!file.endsWith('.json')) continue;
        try {
          const raw = await readFile(join(approvedDir, file), 'utf8');
          const item = JSON.parse(raw);
          const status = typeof item?.status === 'string' ? item.status : '';
          if (status.includes('failed')) {
            failures.push({
              id: item.id,
              status,
              subject: item?.message?.subject || '',
              from: item?.message?.fromAddress || '',
              lastError: typeof item?.automation?.lastError === 'string'
                ? item.automation.lastError.slice(0, 500)
                : '',
              updatedAt: item?.automation?.updatedAt || item?.createdAt || '',
            });
          }
        } catch {}
      }
      writeJson(res, 200, { ok: true, failures, total: files.length });
    } catch (error) {
      writeJson(res, 500, { error: error.message || 'Failed to read mailbox status' });
    }
    return true;
  }

  // ---- Agents CRUD ----

  if (pathname === '/api/agents' && req.method === 'GET') {
    try {
      void getNativeProviderManagementContext()
        .then((context) => context.syncProviderSnapshotToAccountPeers?.())
        .catch(() => {});
      const agents = await listAgents();
      writeJson(res, 200, { agents });
    } catch (error) {
      writeJson(res, 500, { error: error.message || 'Failed to list agents' });
    }
    return true;
  }

  if (pathname === '/api/agents' && req.method === 'POST') {
    let payload = {};
    try {
      const body = await readBody(req, 65536);
      payload = body ? JSON.parse(body) : {};
    } catch {
      writeJson(res, 400, { error: 'Invalid request body' });
      return true;
    }
    try {
      const agent = await createAgent(payload);
      const context = await getNativeProviderManagementContext();
      await recordAgentProfileSyncMutation({ ledger: context.ledger, sourceInstanceId: context.sourceInstanceId, agent });
      writeJson(res, 201, agent);
      scheduleProviderSync(context);
    } catch (error) {
      writeJson(res, 400, { error: error.message || 'Failed to create agent' });
    }
    return true;
  }

  const agentIdMatch = pathname.match(/^\/api\/agents\/([a-z0-9_]+)$/);
  if (agentIdMatch && req.method === 'PATCH') {
    let payload = {};
    try {
      const body = await readBody(req, 65536);
      payload = body ? JSON.parse(body) : {};
    } catch {
      writeJson(res, 400, { error: 'Invalid request body' });
      return true;
    }
    try {
      const updated = await updateAgent(agentIdMatch[1], payload);
      if (!updated) {
        writeJson(res, 404, { error: 'Agent not found' });
        return true;
      }
      const context = await getNativeProviderManagementContext();
      await recordAgentProfileSyncMutation({ ledger: context.ledger, sourceInstanceId: context.sourceInstanceId, agent: updated });
      writeJson(res, 200, updated);
      scheduleProviderSync(context);
    } catch (error) {
      writeJson(res, 400, { error: error.message || 'Failed to update agent' });
    }
    return true;
  }

  if (agentIdMatch && req.method === 'DELETE') {
    try {
      const context = await getNativeProviderManagementContext();
      const existing = await getAgent(agentIdMatch[1]);
      const deleted = await deleteAgent(agentIdMatch[1]);
      if (!deleted) {
        writeJson(res, 404, { error: 'Agent not found' });
        return true;
      }
      await recordAgentProfileSyncMutation({ ledger: context.ledger, sourceInstanceId: context.sourceInstanceId, agent: existing || { id: agentIdMatch[1] }, deleted: true });
      writeJson(res, 200, { ok: true });
      scheduleProviderSync(context);
    } catch (error) {
      writeJson(res, 500, { error: error.message || 'Failed to delete agent' });
    }
    return true;
  }

  if (agentIdMatch && req.method === 'GET') {
    try {
      const agent = await getAgent(agentIdMatch[1]);
      if (!agent) {
        writeJson(res, 404, { error: 'Agent not found' });
        return true;
      }
      writeJson(res, 200, agent);
    } catch (error) {
      writeJson(res, 500, { error: error.message || 'Failed to get agent' });
    }
    return true;
  }

  return false;
}
