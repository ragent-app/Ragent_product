import { homedir } from 'os';
import { parseSessionCreationRequest } from './session-creation-contract.mjs';
import { handleSessionApiMutationRoutes } from './session-api-mutation-routes.mjs';
import { handleSessionApiScopeRoutes } from './session-api-scope-routes.mjs';
import { handleMessagePreparationRoutes } from './message-preparation-routes.mjs';
import { handleMessageCommitRoutes } from './message-commit-routes.mjs';
import { handleRunApiRoutes } from './run-api-routes.mjs';
import { cancelQueuedMessageRun } from './message-commit-store.mjs';
import { withSessionApiScope } from './session-meta-store.mjs';
import { readSessionApiScopeHeader, SESSION_API_SCOPE_HEADER } from './session-api-scope-contract.mjs';
import { projectMessageResult } from './message-result-contract.mjs';
import { createMessageResultExport, readMessageResultExportChunk, RESULT_EXPORT_CHUNK_BYTES,
  RESULT_EXPORT_FILE_BYTES, RESULT_EXPORT_BATCH_BYTES, RESULT_EXPORT_TTL_MS } from './message-result-exports.mjs';
import { loadInstanceIdentity } from '../lib/instance-identity.mjs';
import { createTemporaryControlApprovalActor } from '../lib/temporary-control-policy.mjs';
import { join, resolve } from 'path';

import { MANAGED_WORK_ROOT_DIR } from '../lib/config.mjs';
import { listHarnessCapabilities, resolveHarnessCapabilityInstructions, resolveCapabilitySessionProvider } from './harness-capability-catalog.mjs';
import { setCodexSkillPreference } from './codex-skill-management.mjs';
import { WORKBENCH_EXECUTION_POLICY, workbenchToolAllowed } from '../lib/workbench-execution-policy.mjs';
import { readBody } from '../lib/utils.mjs';
import { measureApiRequestPhase, setApiRequestCorrelation } from './api-request-log.mjs';
import { appendEvent, MAX_EVENT_RANGE_SPAN, readEventBody } from './history.mjs';
import { messageEvent } from './normalizer.mjs';
import { createSessionDetail, createSessionListItem, createCompactSessionListItem, compactMobileDurableEvents } from './session-api-shapes.mjs';
import { buildSessionDisplayEvents } from './session-display-events.mjs';
import { buildRunActivityProjection } from './run-activity-projection.mjs';
import { buildSessionBackgroundAiProjection } from './summarizer.mjs';
import { buildProjectionModel, ensureSessionAuditProjection } from './session-audit-projection.mjs';
import { resolveStarterPresetDefinition } from './starter-session-content.mjs';
import { waitForSessionEvents } from './session-event-waiter.mjs';
import { authenticatedOwnerDeviceDescriptor } from './windows-owner-device-authority.mjs';
import { sessionLiveFeed, sessionRealtimeLiveFeed } from './session-live-feed.mjs';
import {
  applyTemplateToSession,
  cancelActiveRun,
  createSessionWithOutcome,
  findCreatedSession,
  prepareSessionCreationInitialization,
  initializeCreatedSession,
  getRunState,
  getSessionReplyPublication,
  getSession,
  getSessionMeta,
  getMessageSubmissionReceipt,
  getRetainedRunReplyPublication,
  getSessionReadSnapshot,
  getSessionEventsPage,
  getSessionEventBlock,
  getSessionSourceContext,
  getSessionTimelineBundle,
  getSessionTimelinePage,
  listSessions,
  notifyCommittedSessionApiMutation,
  requestSessionConfirmation,
  sendMessage,
  steerQueuedFollowUp,
  createPrivilegedCategoryWebAuthnChallenge,
  submitPrivilegedCategoryApproval,
  createApprovedActionWebAuthnChallenge,
  submitApprovedActionApproval,
  submitSessionConfirmationDecision,
  submitPlanAction,
  submitRuntimeApproval,
  sendUserMessage,
  regenerateSessionReply,
  resendEditedMessage,
  updateSessionFollowUpQueue,
} from './session-manager.mjs';
import {
  getProject,
  normalizeProjectId,
} from './projects.mjs';
import {
  CREATE_AGENT_STARTER_PRESET,
  normalizeSessionStarterPreset,
} from './session-starter-preset.mjs';
import { listTriggers } from './triggers.mjs';
import { buildHomeProjection } from './home-projection.mjs';
import { getRun } from './runs.mjs';
import {
  MANAGED_SESSION_INPUT_BYPASS,
  assertManagedInputAllowed,
  SESSION_NOT_USER_ADDRESSABLE,
} from './managed-input.mjs';

const DEFAULT_ALL_EVENTS_PAGE_LIMIT = 200;
const MAX_ALL_EVENTS_PAGE_LIMIT = 500;
// Raw/diagnostic event pages are owner-facing compatibility surfaces. Keep a
// single response from turning a handful of very large message bodies into a
// multi-hundred-megabyte allocation; callers can continue from pagination and
// use the dedicated body endpoint for an intentionally requested full body.
const MAX_ALL_EVENTS_RESPONSE_BYTES = Math.max(
  4 * 1024 * 1024,
  Number.parseInt(process.env.AGENTOC_MAX_ALL_EVENTS_RESPONSE_BYTES || String(16 * 1024 * 1024), 10)
    || 16 * 1024 * 1024,
);
const MAX_ALL_EVENTS_BODY_BYTES = Math.max(
  256 * 1024,
  Number.parseInt(process.env.AGENTOC_MAX_ALL_EVENTS_BODY_BYTES || String(1024 * 1024), 10)
    || 1024 * 1024,
);

// Composer agent-picker selection carried as a per-run override: the run
// uses the requested agent template without rebinding the session.
function pickRequestedRunAgentTemplate(payload) {
  const agentId = typeof payload?.agentId === 'string' ? payload.agentId.trim() : '';
  const templateId = typeof payload?.templateId === 'string' ? payload.templateId.trim() : '';
  const raw = agentId || templateId;
  return raw ? { templateId: raw } : {};
}

function createClientSessionDetail(session) {
  return createSessionDetail(session);
}

// DS-04: background AI status projection attached to every session payload so
// the UI can distinguish 没启用 / 排队 / 成功 / 失败 / 暂时跳过 / 冷却中.
function attachBackgroundAiProjection(session) {
  if (!session || typeof session !== 'object') return session;
  try {
    const projection = buildSessionBackgroundAiProjection(session);
    if (projection && typeof projection === 'object') {
      return { ...session, backgroundAi: projection };
    }
  } catch (error) {
    console.error(`[background-ai] Projection failed for session ${session.id?.slice(0, 8)}: ${error.message}`);
  }
  return session;
}

async function listSessionListItemsForClient(options = {}) {
  const sessions = await listSessions({ ...options, listSummary: true });
  return sessions.map((session) => createSessionListItem(attachBackgroundAiProjection(session)));
}

async function getSessionForClient(id, options = {}) {
  return createClientSessionDetail(attachBackgroundAiProjection(await getSession(id, options)));
}

async function getSessionListItemForClient(id, options = {}) {
  return createSessionListItem(attachBackgroundAiProjection(await getSession(id, options)));
}

function getGrantedCapability(authSession, capability, fallback = false) {
  if (authSession?.role === 'owner') return true;
  if (!capability) return fallback;
  return authSession?.capabilities?.[capability] === true
    ? true
    : fallback;
}

export function resolveAuthenticatedTurnPrincipalKind(authSession) {
  const explicit = typeof authSession?.principalKind === 'string'
    ? authSession.principalKind.trim()
    : '';
  if (authSession?.role === 'owner' && (!explicit || explicit === 'owner')) return 'owner';
  return explicit || (typeof authSession?.role === 'string' ? authSession.role.trim() : '') || 'unknown';
}

function temporaryControlApprovalActor(authSession, operation) {
  if (authSession?.temporaryControlAdapter !== true || authSession?.principalKind !== 'temporary_device') return undefined;
  return createTemporaryControlApprovalActor(authSession, operation);
}

// This data is captured only from the in-process, DPoP-authenticated control
// carrier. Request JSON is never allowed to supply a run authority.
function temporaryControlRunAuthority(authSession) {
  if (authSession?.temporaryControlAdapter !== true || authSession?.principalKind !== 'temporary_device') return undefined;
  return { version: 1, grantId: authSession.grantId, instanceId: authSession.instanceId,
    deviceId: authSession.deviceId, deviceKeyFingerprint: authSession.deviceKeyFingerprint,
    expiresAt: authSession.expiry };
}

function authenticatedTurnOptions(authSession) {
  const authority = temporaryControlRunAuthority(authSession);
  const ownerDevice = process.platform === 'win32' ? authenticatedOwnerDeviceDescriptor(authSession) : null;
  return { authenticatedPrincipalKind: resolveAuthenticatedTurnPrincipalKind(authSession),
    ...(ownerDevice ? { authenticatedOwnerDevice: ownerDevice } : {}),
    ...(authority ? { temporaryControlAuthority: authority } : {}) };
}

function parseNonNegativeInt(value, fallback = 0) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function parsePositiveInt(value, fallback = 0, { max = 500 } = {}) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  const upperBound = Number.isInteger(max) && max > 0 ? max : parsed;
  return Math.min(parsed, upperBound);
}

function getEventStartSeq(event) {
  if (Number.isInteger(event?.startSeq) && event.startSeq > 0) {
    return event.startSeq;
  }
  if (Number.isInteger(event?.blockStartSeq) && event.blockStartSeq > 0) {
    return event.blockStartSeq;
  }
  if (Number.isInteger(event?.mergedStartSeq) && event.mergedStartSeq > 0) {
    return event.mergedStartSeq;
  }
  return Number.isInteger(event?.seq) ? event.seq : 0;
}

function getEventBoundarySeq(event) {
  if (Number.isInteger(event?.endSeq) && event.endSeq > 0) {
    return event.endSeq;
  }
  if (Number.isInteger(event?.blockEndSeq) && event.blockEndSeq > 0) {
    return event.blockEndSeq;
  }
  if (Number.isInteger(event?.mergedEndSeq) && event.mergedEndSeq > 0) {
    return event.mergedEndSeq;
  }
  return Number.isInteger(event?.seq) ? event.seq : 0;
}

function getLatestEventBoundarySeq(events = []) {
  let latestSeq = 0;
  for (const event of Array.isArray(events) ? events : []) {
    latestSeq = Math.max(latestSeq, getEventBoundarySeq(event));
  }
  return latestSeq;
}

function displayProjectionSupersedesRenderedEvent(events = [], afterSeq = 0) {
  if (!Number.isInteger(afterSeq) || afterSeq < 1) return false;
  return (Array.isArray(events) ? events : []).some((event) => {
    if (event?.mergedAssistantRunMessage !== true) return false;
    const startSeq = Number.isInteger(event?.mergedStartSeq) ? event.mergedStartSeq : 0;
    if (startSeq < 1 || startSeq > afterSeq) return false;
    return getEventBoundarySeq(event) > afterSeq;
  });
}

function paginateDisplayEvents(events = [], query = {}) {
  const sourceEvents = Array.isArray(events) ? events : [];
  const limit = parsePositiveInt(query.limit, 0);
  const beforeSeq = parseNonNegativeInt(query.beforeSeq, 0);
  const afterSeq = parseNonNegativeInt(query.afterSeq, 0);
  const direction = typeof query.direction === 'string'
    ? String(query.direction || '').trim().toLowerCase()
    : '';
  const paginationRequested = limit > 0 || beforeSeq > 0 || afterSeq > 0 || direction === 'latest';
  if (!paginationRequested) {
    return {
      events: sourceEvents,
      pagination: null,
    };
  }

  let candidates = sourceEvents;
  if (beforeSeq > 0) {
    candidates = candidates.filter((event) => getEventBoundarySeq(event) < beforeSeq);
  }
  if (afterSeq > 0) {
    candidates = candidates.filter((event) => getEventBoundarySeq(event) > afterSeq);
  }

  let pageEvents = candidates;
  let pageStartIndex = 0;
  if (limit > 0 && candidates.length > limit) {
    if (direction === 'latest' || beforeSeq > 0) {
      pageStartIndex = candidates.length - limit;
      pageEvents = candidates.slice(pageStartIndex);
    } else {
      pageEvents = candidates.slice(0, limit);
    }
  }

  const firstEvent = pageEvents[0] || null;
  const lastEvent = pageEvents[pageEvents.length - 1] || null;
  return {
    events: pageEvents,
    pagination: {
      limit: limit || null,
      direction: direction || (beforeSeq > 0 ? 'before' : (afterSeq > 0 ? 'after' : 'forward')),
      beforeSeq: beforeSeq || null,
      afterSeq: afterSeq || null,
      hasMoreBefore: beforeSeq > 0
        ? pageStartIndex > 0
        : sourceEvents.length > 0 && firstEvent !== sourceEvents[0],
      hasMoreAfter: sourceEvents.length > 0 && lastEvent !== sourceEvents[sourceEvents.length - 1],
      oldestSeq: firstEvent ? getEventStartSeq(firstEvent) : null,
      latestSeq: lastEvent ? getEventBoundarySeq(lastEvent) : null,
      totalEvents: sourceEvents.length,
    },
  };
}

function planRunId(plan) {
  return String(plan?.sourceRunId || plan?.runId || '').trim();
}

function planBoundary(plan) {
  return Number.isInteger(plan?.seq) ? plan.seq : 0;
}

function latestProgressPlanForSession(model, session) {
  const plans = Array.isArray(model?.progressPlans) ? model.progressPlans : [];
  if (plans.length === 0) return null;
  const currentRunId = String(session?.activity?.run?.id || session?.activity?.runId || '').trim();
  if (currentRunId) {
    const currentPlan = plans
      .filter((plan) => planRunId(plan) === currentRunId)
      .sort((a, b) => planBoundary(b) - planBoundary(a))[0] || null;
    if (currentPlan) return currentPlan;
  }
  return plans.slice().sort((a, b) => planBoundary(b) - planBoundary(a))[0] || null;
}

function buildRunSheetSessionView(session) {
  const run = session?.activity?.run || null;
  return {
    id: session?.id || '',
    title: session?.title || '',
    updatedAt: session?.updatedAt || null,
    workflowState: session?.workflowState || '',
    statusLabel: session?.statusLabel || '',
    activity: {
      label: session?.activity?.label || '',
      run: run ? {
        id: run.id || run.runId || '',
        runId: run.runId || run.id || '',
        state: run.state || '',
      } : null,
    },
  };
}

function buildDelegationProjection(run) {
  const runtime = run?.providerNativeDelegation;
  if (!runtime || runtime.schemaVersion !== 1) {
    return {
      delegationSummary: { total: 0, active: 0, completed: 0, failed: 0, cancelled: 0, interrupted: 0, lost: 0 },
      delegations: [],
    };
  }
  const summary = runtime.delegationSummary && typeof runtime.delegationSummary === 'object'
    ? runtime.delegationSummary
    : {};
  const delegations = (Array.isArray(runtime.delegations) ? runtime.delegations : [])
    .map((entry) => ({
      delegationId: entry.delegationId,
      parentDelegationId: entry.parentDelegationId || null,
      state: entry.state,
      currentAction: entry.currentAction || null,
      startedAt: entry.startedAt || null,
      updatedAt: entry.updatedAt || null,
      completedAt: entry.completedAt || null,
    }))
    .filter((entry) => typeof entry.delegationId === 'string' && entry.delegationId);
  return {
    delegationSummary: {
      total: Number(summary.total) || delegations.length,
      active: Number(summary.active) || 0,
      completed: Number(summary.completed) || 0,
      failed: Number(summary.failed) || 0,
      cancelled: Number(summary.cancelled) || 0,
      interrupted: Number(summary.interrupted) || 0,
      lost: Number(summary.lost) || 0,
    },
    delegations,
  };
}

function buildRunSheetProjectionView({ session, projection, model, run = null }) {
  return {
    session: buildRunSheetSessionView(session),
    progressPlan: latestProgressPlanForSession(model, session),
    artifactFiles: Array.isArray(model?.artifactFiles) ? model.artifactFiles : [],
    changedFiles: Array.isArray(model?.files) ? model.files : [],
    sourceLatestSeq: projection?.sourceLatestSeq || 0,
    projectionStale: projection?.projectionStale === true,
    ...buildDelegationProjection(run),
  };
}

export async function handleSessionMainRoutes({
  req,
  res,
  parsedUrl,
  pathname,
  authSession,
  sessionGetRoute,
  createSessionSummaryRef,
  immutablePrivateEventCacheControl,
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
}) {
  if (await handleSessionApiMutationRoutes({ req, res, parsedUrl, pathname, authSession,
    requireSessionAccess, writeJson, invalidate: notifyCommittedSessionApiMutation })) return true;
  const skillPreferenceRoute = req.method === 'POST'
    ? pathname.match(/^\/api\/sessions\/([^/]+)\/harness-capabilities\/skills$/) : null;
  if (skillPreferenceRoute) {
    let sessionId;
    try { sessionId = decodeURIComponent(skillPreferenceRoute[1]); }
    catch { writeJson(res, 400, { error: 'Invalid session id' }); return true; }
    if (authSession?.role !== 'owner' || WORKBENCH_EXECUTION_POLICY) {
      writeJson(res, 403, { error: 'Skill management is unavailable for this session' }); return true;
    }
    if (!await requireSessionAccess(res, authSession, sessionId, { metadataOnly: true })) return true;
    try {
      const payload = JSON.parse(await readBody(req, 4096));
      const session = await getSession(sessionId);
      if (!session) { writeJson(res, 404, { error: 'Session not found' }); return true; }
      const providerId = typeof payload?.providerProfileId === 'string' ? payload.providerProfileId.trim() : '';
      const savedProvider = await resolveCapabilitySessionProvider({ session });
      if (!['codex', 'codex-cli', 'agentoc-codex-app-server'].includes(session.tool) || !savedProvider || savedProvider !== providerId) {
        writeJson(res, 409, { error: 'The session account changed; refresh the list', code: 'CODEX_SKILL_ACCOUNT_CHANGED' }); return true;
      }
      const project = session.projectId ? await getProject(session.projectId) : null;
      const result = await setCodexSkillPreference({ providerId, cwd: project?.rootPath || process.cwd(), id: payload?.id, enabled: payload?.enabled,
        verifySelection: async () => {
          const current = await getSession(sessionId);
          return Boolean(current && ['codex', 'codex-cli', 'agentoc-codex-app-server'].includes(current.tool)
            && await resolveCapabilitySessionProvider({ session: current }) === providerId);
        } });
      writeJson(res, 200, result);
    } catch (error) {
      writeJson(res, error?.statusCode || 400, { error: error?.statusCode ? error.message : 'Skill preference could not be saved', code: error?.statusCode ? error.code : 'CODEX_SKILL_UPDATE_FAILED' });
    }
    return true;
  }
  const capabilitiesRoute = req.method === 'GET'
    ? pathname.match(/^\/api\/sessions\/([^/]+)\/harness-capabilities$/)
    : null;
  if (capabilitiesRoute) {
    let sessionId;
    try { sessionId = decodeURIComponent(capabilitiesRoute[1]); }
    catch { writeJson(res, 400, { error: 'Invalid session id' }); return true; }
    if (!sessionId.trim() || sessionId.length > 256) {
      writeJson(res, 400, { error: 'Invalid session id' });
      return true;
    }
    if (!await requireSessionAccess(res, authSession, sessionId, { metadataOnly: true })) return true;
    if (authSession?.role === 'visitor') {
      writeJson(res, 403, { error: 'Harness capabilities are not available to visitor sessions.', code: 'HARNESS_CAPABILITY_FORBIDDEN' });
      return true;
    }
    try {
      const session = await getSession(sessionId);
      if (!session) {
        writeJson(res, 404, { error: 'Session not found' });
        return true;
      }
      const requestUrl = new URL(req.url || pathname, `http://${req.headers?.host || 'localhost'}`);
      const requestedTool = requestUrl.searchParams.get('tool')?.trim() || session.tool;
      const requestedProviderProfile = requestUrl.searchParams.get('providerProfile')?.trim()
        || session.providerProfile || session.providerProfileId || '';
      if (!requestedTool || !/^[a-z0-9][a-z0-9-]{0,63}$/i.test(requestedTool)) {
        writeJson(res, 400, { error: 'Invalid harness id' });
        return true;
      }
      if (WORKBENCH_EXECUTION_POLICY && !workbenchToolAllowed(requestedTool)) {
        writeJson(res, 403, { error: 'Harness is locked by the workbench operator', code: 'WORKBENCH_EXECUTION_POLICY_DENIED' });
        return true;
      }
      const project = session.projectId ? await getProject(session.projectId) : null;
      const catalog = await listHarnessCapabilities({
        session: { ...session, tool: requestedTool },
        cwd: project?.rootPath || process.cwd(),
        providerProfileId: requestedProviderProfile,
        model: requestUrl.searchParams.get('model')?.trim() || session.model,
        refresh: requestUrl.searchParams.get('refresh') === 'true',
      });
      res.setHeader?.('Cache-Control', 'private, no-store');
      writeJson(res, 200, { sessionId, ...catalog });
    } catch (error) {
      res.setHeader?.('Cache-Control', 'private, no-store');
      writeJson(res, error?.statusCode || 500, {
        error: 'Harness capability catalog could not be loaded',
        code: error?.code || 'HARNESS_CAPABILITY_CATALOG_UNAVAILABLE',
      });
    }
    return true;
  }
  if (await handleSessionApiScopeRoutes({ req, res, parsedUrl, pathname, authSession, writeJson })) return true;
  if (await handleRunApiRoutes({ req, res, parsedUrl, pathname, authSession, requireSessionAccess, writeJson })) return true;
  if (await handleMessageCommitRoutes({ req, res, parsedUrl, pathname, authSession, requireSessionAccess, writeJson })) return true;
  if (await handleMessagePreparationRoutes({ req, res, parsedUrl, pathname, authSession, requireSessionAccess, writeJson })) return true;
  if (pathname === '/api/result-export-contract' && req.method === 'GET') {
    writeJson(res, 200, { version: 1, maxChunkBytes: RESULT_EXPORT_CHUNK_BYTES,
      maxTextBytes: RESULT_EXPORT_FILE_BYTES, maxFileBytes: RESULT_EXPORT_FILE_BYTES,
      maxBatchBytes: RESULT_EXPORT_BATCH_BYTES, maxResources: 17, snapshotTtlMs: RESULT_EXPORT_TTL_MS });
    return true;
  }
  if (pathname === '/api/session-creation-contract' && req.method === 'GET') {
    writeJson(res, 200, { version: 1, maxKeyLength: 200, initializationRecovery: true, messageReceiptLookupVersion: 1 });
    return true;
  }
  const messageReceiptRoute = req.method === 'GET'
    ? pathname.match(/^\/api\/sessions\/([^/]+)\/message-receipts\/([^/]+)$/) : null;
  if (messageReceiptRoute) {
    res.setHeader?.('Cache-Control', 'private, no-store');
    try {
      const sessionId = decodeURIComponent(messageReceiptRoute[1]);
      const requestId = decodeURIComponent(messageReceiptRoute[2]);
      if (!sessionId.trim() || sessionId.length > 256 || !requestId.trim() || requestId.length > 200) {
        writeJson(res, 400, { error: 'Invalid receipt identity' });
        return true;
      }
      if (!await requireSessionAccess(res, authSession, sessionId, { metadataOnly: true })) return true;
      // No Session projection, Run reconciliation, queue draining or dispatch on this GET.
      const receipt = await getMessageSubmissionReceipt(sessionId, requestId);
      res.setHeader?.('Cache-Control', 'private, no-store');
      writeJson(res, 200, receipt);
    } catch (error) {
      writeJson(res, error instanceof URIError ? 400 : (error.statusCode || 500),
        { error: error instanceof URIError ? 'Invalid receipt encoding' : 'Receipt lookup failed' });
    }
    return true;
  }
  const messageResultRoute = req.method === 'GET'
    ? pathname.match(/^\/api\/sessions\/([^/]+)\/message-results\/([^/]+)$/) : null;
  if (messageResultRoute) {
    res.setHeader?.('Cache-Control', 'private, no-store');
    try {
      const sessionId = decodeURIComponent(messageResultRoute[1]);
      const requestId = decodeURIComponent(messageResultRoute[2]);
      if (!sessionId.trim() || sessionId.length > 256 || !requestId.trim() || requestId.length > 200) {
        writeJson(res, 400, { error: 'Invalid result identity' });
        return true;
      }
      if (!await requireSessionAccess(res, authSession, sessionId, { metadataOnly: true })) return true;
      const receipt = await getMessageSubmissionReceipt(sessionId, requestId);
      const run = receipt.runId ? await getRun(receipt.runId) : null;
      // Unlike getRunState, these reads do not reconcile or launch a detached Run.
      const publication = run?.state === 'completed' && run.sessionId === sessionId && run.requestId === requestId
        ? await getRetainedRunReplyPublication(run) : null;
      res.setHeader?.('Cache-Control', 'private, no-store');
      writeJson(res, 200, projectMessageResult(receipt, run, publication));
    } catch (error) {
      writeJson(res, error instanceof URIError ? 400 : (error.statusCode || 500),
        { error: error instanceof URIError ? 'Invalid result encoding' : 'Result lookup failed' });
    }
    return true;
  }
  const exportRoute = req.method === 'GET'
    ? pathname.match(/^\/api\/sessions\/([^/]+)\/message-results\/([^/]+)\/exports(?:\/([^/]+))?$/) : null;
  if (exportRoute) {
    try {
      const sessionId = decodeURIComponent(exportRoute[1]);
      const requestId = decodeURIComponent(exportRoute[2]);
      const resourceId = exportRoute[3] ? decodeURIComponent(exportRoute[3]) : null;
      const parameters = new URL(req.url || pathname, 'http://localhost').searchParams;
      const query = parsedUrl?.query || Object.fromEntries(parameters);
      if (!/^[A-Za-z0-9_-]{1,160}$/.test(sessionId) || !requestId.trim() || requestId.length > 200 ||
          /[\u0000-\u001f\u007f]/.test(requestId) || (resourceId !== null && !/^[A-Za-z0-9_-]{1,160}$/.test(resourceId)) ||
          Object.keys(query).some(key => !resourceId || !['revision', 'offset', 'length'].includes(key)) ||
          [...parameters.keys()].some(key => parameters.getAll(key).length !== 1) ||
          Object.values(query).some(value => typeof value !== 'string')) {
        writeJson(res, 400, { error: 'Invalid export request', code: 'RESULT_EXPORT_INVALID' });
        return true;
      }
      // Every manifest AND chunk reuses the actual Session gate, without a Run
      // reconciliation. A cached revision never substitutes for authorization.
      if (!await requireSessionAccess(res, authSession, sessionId, { metadataOnly: true })) return true;
      if (!getGrantedCapability(authSession, 'downloadArtifacts')) {
        writeJson(res, 403, { error: 'Result download is not authorized', code: 'PERMISSION_DENIED' });
        return true;
      }
      const identity = await loadInstanceIdentity();
      if (!identity) {
        writeJson(res, 503, { error: 'Source computer identity is unavailable', code: 'RESULT_EXPORT_SOURCE_UNAVAILABLE' });
        return true;
      }
      const context = { instanceId: identity.instanceId, sessionId, requestId };
      const result = resourceId
        ? await readMessageResultExportChunk(context, resourceId, query) : await createMessageResultExport(context);
      if (!await requireSessionAccess(res, authSession, sessionId, { metadataOnly: true })) return true;
      if (!getGrantedCapability(authSession, 'downloadArtifacts')) {
        writeJson(res, 403, { error: 'Result download is not authorized', code: 'PERMISSION_DENIED' });
        return true;
      }
      res.setHeader?.('Cache-Control', 'private, no-store');
      writeJson(res, 200, result);
    } catch (error) {
      const status = error instanceof URIError ? 400 : (error.statusCode || 500);
      const code = /^RESULT_EXPORT_[A-Z_]+$/.test(error.code || '') ? error.code : 'RESULT_EXPORT_READ_FAILED';
      writeJson(res, status, { error: 'Result export could not be read', code });
    }
    return true;
  }
  if (pathname === '/api/home' && req.method === 'GET') {
    if (authSession?.role !== 'owner') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }
    const [sessions, triggers] = await Promise.all([
      listSessions({ includeVisitor: false, includeArchived: false, rootOnly: true, listSummary: true }),
      listTriggers(),
    ]);
    writeJsonCached(req, res, buildHomeProjection({ sessions, triggers }));
    return true;
  }

  if (sessionGetRoute?.kind === 'list' || sessionGetRoute?.kind === 'archived-list') {
    if (authSession?.role === 'visitor' && !getGrantedCapability(authSession, 'listSessions')) {
      writeJson(res, 403, { error: 'Access denied' });
      return true;
    }
    const includeVisitor = authSession?.role === 'owner'
      && ['1', 'true', 'yes'].includes(String(parsedUrl.query.includeVisitor || '').toLowerCase());
    const view = typeof parsedUrl.query.view === 'string'
      ? String(parsedUrl.query.view || '').trim().toLowerCase()
      : '';
    const sessionList = await listSessionListItemsForClient({
      includeVisitor: includeVisitor || isAgentScopedAuthSession(authSession),
      rootOnly: true,
      templateId: typeof parsedUrl.query.templateId === 'string' ? parsedUrl.query.templateId : '',
      sourceId: typeof parsedUrl.query.sourceId === 'string' ? parsedUrl.query.sourceId : '',
      projectId: typeof parsedUrl.query.projectId === 'string' ? parsedUrl.query.projectId : '',
    });
    const visibleSessions = authSession?.role === 'owner'
      ? sessionList
      : sessionList.filter((session) => isSessionVisibleToAuthSession(authSession, session));
    const folderFilter = parsedUrl.query.folder;
    const filtered = folderFilter
      ? visibleSessions.filter((session) => session.folder === folderFilter)
      : visibleSessions;
    if (view === 'refs') {
      const sessionRefs = filtered.map(createSessionSummaryRef).filter((ref) => ref?.id);
      writeJsonCached(req, res, { sessionRefs });
      return true;
    }
    if (view === 'summary') {
      writeJsonCached(req, res, { sessions: filtered.map(createCompactSessionListItem) });
      return true;
    }
    writeJsonCached(req, res, { sessions: filtered });
    return true;
  }

  if (sessionGetRoute?.kind === 'detail') {
    const { sessionId } = sessionGetRoute;
    if (!await requireSessionAccess(res, authSession, sessionId)) return true;
    const view = typeof parsedUrl.query.view === 'string'
      ? String(parsedUrl.query.view || '').trim().toLowerCase()
      : '';
    const session = view === 'summary' || view === 'sidebar'
      ? await getSessionListItemForClient(sessionId)
      : await getSessionForClient(sessionId, { includeQueuedMessages: true });
    if (!session) {
      writeJson(res, 404, { error: 'Session not found' });
      return true;
    }
    writeJsonCached(req, res, { session });
    return true;
  }

  if (sessionGetRoute?.kind === 'snapshot') {
    const { sessionId } = sessionGetRoute;
    if (!await requireSessionAccess(res, authSession, sessionId)) return true;
    const readSnapshot = await getSessionReadSnapshot(sessionId);
    if (!readSnapshot) {
      writeJson(res, 404, { error: 'Session not found' });
      return true;
    }
    const session = await getSessionForClient(sessionId, {
      includeQueuedMessages: true,
      // Reuse the request-scoped session metadata and require the same strict
      // history contract used by the snapshot page. This prevents the detail
      // projection from silently falling back to a permissive cached history
      // after the snapshot gate has already observed a concurrent mutation.
      sessionMeta: readSnapshot.sessionMeta,
      strictHistory: true,
    });
    if (!session) {
      writeJson(res, 404, { error: 'Session not found' });
      return true;
    }
    const afterSeq = parseNonNegativeInt(parsedUrl.query.afterSeq, 0);
    const limit = parsePositiveInt(parsedUrl.query.limit, 50, { max: 200 });
    const direction = afterSeq > 0 ? 'forward' : 'latest';
    const page = await getSessionTimelinePage(sessionId, {
      limit,
      afterSeq,
      direction,
      sessionMeta: readSnapshot.sessionMeta,
      historyMeta: readSnapshot.historyMeta,
      strict: true,
    });
    const latestSeq = Math.max(
      Number.isInteger(readSnapshot.historyMeta?.latestSeq) ? readSnapshot.historyMeta.latestSeq : 0,
      Number.isInteger(page?.latestSeq) ? page.latestSeq : 0,
      getLatestEventBoundarySeq(page?.events || []),
    );
    writeJsonCached(req, res, {
      schemaVersion: 2,
      sessionId,
      filter: 'visible',
      session,
      events: Array.isArray(page?.events) ? page.events : [],
      runActivity: page?.runActivity || null,
      latestSeq,
      consistency: {
        revision: Number.isInteger(readSnapshot.historyMeta?.historyRevision)
          ? readSnapshot.historyMeta.historyRevision
          : 0,
        stable: true,
      },
      ...(page?.pagination ? { pagination: page.pagination } : {}),
    });
    return true;
  }

  if (sessionGetRoute?.kind === 'events') {
    const { sessionId } = sessionGetRoute;
    if (!await requireSessionAccess(res, authSession, sessionId)) return true;
    const readSnapshot = await getSessionReadSnapshot(sessionId);
    const sessionMeta = readSnapshot?.sessionMeta;
    if (!readSnapshot) {
      writeJson(res, 404, { error: 'Session not found' });
      return true;
    }
    const filter = typeof parsedUrl.query.filter === 'string'
      ? String(parsedUrl.query.filter || '').trim().toLowerCase()
      : '';
    if (filter === 'all') {
      const limit = parsePositiveInt(parsedUrl.query.limit, DEFAULT_ALL_EVENTS_PAGE_LIMIT, {
        max: MAX_ALL_EVENTS_PAGE_LIMIT,
      });
      const beforeSeq = parseNonNegativeInt(parsedUrl.query.beforeSeq, 0);
      const afterSeq = parseNonNegativeInt(parsedUrl.query.afterSeq, 0);
      const direction = typeof parsedUrl.query.direction === 'string'
        ? String(parsedUrl.query.direction || '').trim().toLowerCase()
        : 'latest';
      const { events, pagination } = await getSessionEventsPage(sessionId, {
        includeBodies: false,
        includeMessageBodies: true,
        maxBodyBytes: MAX_ALL_EVENTS_BODY_BYTES,
        maxResponseBytes: MAX_ALL_EVENTS_RESPONSE_BYTES,
        limit,
        beforeSeq,
        afterSeq,
        direction,
        historyMeta: readSnapshot.historyMeta,
        strict: true,
      });
      // Mobile durable synchronization also uses the current activity to
      // recover pending requests after its event cursor has passed them.
      // A raw event page alone cannot describe that current state.
      const mobileActivity = parsedUrl.query.compact === '1'
        ? (await getSessionTimelineBundle(sessionId, { ...readSnapshot, strict: true })).runActivity || null
        : undefined;
      writeJsonCached(req, res, {
        schemaVersion: 2,
        sessionId,
        filter: 'all',
        events: parsedUrl.query.compact === '1' ? compactMobileDurableEvents(events) : events,
        ...(parsedUrl.query.compact === '1' ? { runActivity: mobileActivity } : {}),
        pagination,
        truncated: pagination?.hasMoreBefore === true || pagination?.hasMoreAfter === true,
        consistency: {
          revision: Number.isInteger(readSnapshot.historyMeta?.historyRevision)
            ? readSnapshot.historyMeta.historyRevision
            : 0,
          stable: true,
        },
      });
      return true;
    }
    const paginationRequested = ['limit', 'beforeSeq', 'afterSeq', 'direction']
      .some((key) => Object.prototype.hasOwnProperty.call(parsedUrl.query, key));
    if (!paginationRequested) {
      const { displayEvents, runActivity, pagination } = await getSessionTimelineBundle(sessionId, readSnapshot);
      writeJsonCached(req, res, {
        schemaVersion: 2,
        sessionId,
        filter: 'visible',
        events: displayEvents,
        runActivity,
        ...(pagination ? { pagination } : {}),
        latestSeq: Math.max(
          Number.isInteger(readSnapshot.historyMeta?.latestSeq) ? readSnapshot.historyMeta.latestSeq : 0,
          getLatestEventBoundarySeq(displayEvents),
        ),
        consistency: {
          revision: Number.isInteger(readSnapshot.historyMeta?.historyRevision)
            ? readSnapshot.historyMeta.historyRevision
            : 0,
          stable: true,
        },
      });
      return true;
    }
    const limit = parsePositiveInt(parsedUrl.query.limit, 50, { max: 200 });
    const beforeSeq = parseNonNegativeInt(parsedUrl.query.beforeSeq, 0);
    const afterSeq = parseNonNegativeInt(parsedUrl.query.afterSeq, 0);
    const direction = typeof parsedUrl.query.direction === 'string'
      ? String(parsedUrl.query.direction || '').trim().toLowerCase()
      : 'latest';
    const page = await getSessionTimelinePage(sessionId, {
      limit,
      beforeSeq,
      afterSeq,
      direction,
      sessionMeta: readSnapshot.sessionMeta,
      historyMeta: readSnapshot.historyMeta,
      strict: true,
    });
    const { events, pagination, runActivity } = page;
    writeJsonCached(req, res, {
      schemaVersion: 2,
      sessionId,
      filter: 'visible',
      events,
      runActivity,
      latestSeq: Math.max(
        Number.isInteger(readSnapshot.historyMeta?.latestSeq) ? readSnapshot.historyMeta.latestSeq : 0,
        page.latestSeq || 0,
      ),
      consistency: {
        revision: Number.isInteger(readSnapshot.historyMeta?.historyRevision)
          ? readSnapshot.historyMeta.historyRevision
          : 0,
        stable: true,
      },
      ...(pagination ? { pagination } : {}),
    });
    return true;
  }

  if (sessionGetRoute?.kind === 'event-wait') {
    const { sessionId } = sessionGetRoute;
    if (!await requireSessionAccess(res, authSession, sessionId)) return true;
    // Live text has its own cursor and must not wait behind strict history
    // hydration. The normal event lane remains authoritative for history.
    if (parsedUrl.query.includeLive === '1' && parsedUrl.query.liveOnly === '1') {
      if (!await getSessionMeta(sessionId)) {
        writeJson(res, 404, { error: 'Session not found' });
        return true;
      }
      const controller = new AbortController();
      const abort = () => controller.abort();
      res.once('close', abort);
      try {
        const waited = await waitForSessionEvents(sessionId, {
          timeoutMs: parsePositiveInt(parsedUrl.query.timeoutMs, 15_000, { max: 30_000 }),
          signal: controller.signal,
          readEvents: async () => ({ events: [], ...sessionRealtimeLiveFeed.read(sessionId, {
            afterCursor: Number(parsedUrl.query.liveAfterCursor || 0),
            requestedStreamId: String(parsedUrl.query.liveStreamId || '').slice(0, 64),
          }) }),
        });
        if (waited.aborted || res.destroyed) return true;
        if (!await requireSessionAccess(res, authSession, sessionId)) return true;
        res.setHeader('Cache-Control', 'private, no-store, max-age=0, must-revalidate');
        writeJson(res, 200, { schemaVersion: 2, sessionId, liveOnly: true,
          ...waited.result, timedOut: waited.timedOut === true });
      } finally {
        res.off('close', abort);
      }
      return true;
    }
    const readSnapshot = await getSessionReadSnapshot(sessionId);
    if (!readSnapshot) {
      writeJson(res, 404, { error: 'Session not found' });
      return true;
    }
    const afterSeq = parseNonNegativeInt(parsedUrl.query.afterSeq, 0);
    const limit = parsePositiveInt(parsedUrl.query.limit, DEFAULT_ALL_EVENTS_PAGE_LIMIT, {
      max: MAX_ALL_EVENTS_PAGE_LIMIT,
    });
    const timeoutMs = parsePositiveInt(parsedUrl.query.timeoutMs, 15_000, { max: 30_000 });
    const includeLive = parsedUrl.query.includeLive === '1';
    const liveAfterCursor = Number(parsedUrl.query.liveAfterCursor || 0);
    const liveStreamId = String(parsedUrl.query.liveStreamId || '').slice(0, 64);
    // A long-poll can be notified by an append that happens after the initial
    // snapshot. Never reuse that snapshot's historyMeta: doing so pins the
    // read boundary to the old latestSeq and makes the waiter wake up with an
    // empty page even though new durable events exist. Each read therefore
    // refreshes the strict snapshot and uses its current revision/sequence.
    const readEvents = async () => {
      const liveSnapshot = await getSessionReadSnapshot(sessionId);
      if (!liveSnapshot) return { events: [], pagination: null };
      const page = await getSessionEventsPage(sessionId, {
        includeBodies: false,
        includeMessageBodies: true,
        maxBodyBytes: MAX_ALL_EVENTS_BODY_BYTES,
        maxResponseBytes: MAX_ALL_EVENTS_RESPONSE_BYTES,
        limit,
        afterSeq,
        direction: 'forward',
        historyMeta: liveSnapshot.historyMeta,
        strict: true,
      });
      return includeLive ? { ...page, ...sessionLiveFeed.read(sessionId,
        { afterCursor: liveAfterCursor, requestedStreamId: liveStreamId }) } : page;
    };
    const abortController = new AbortController();
    const abort = () => abortController.abort();
    res.once('close', abort);
    try {
      const waited = await waitForSessionEvents(sessionId, {
        timeoutMs,
        readEvents,
        signal: abortController.signal,
      });
      if (waited.aborted || res.destroyed) return true;
      // Waiting never extends the requester's original session authority.
      if (!await requireSessionAccess(res, authSession, sessionId)) return true;
      const page = waited.result || await readEvents();
      // Re-read the strict snapshot after the wait so the response carries the
      // revision that actually produced the returned page.  A concurrent
      // writer therefore cannot make the client mistake a partial page for a
      // complete, stable transcript.
      const finalSnapshot = await getSessionReadSnapshot(sessionId);
      const mobileActivity = parsedUrl.query.compact === '1' && finalSnapshot
        ? (await getSessionTimelineBundle(sessionId, { ...finalSnapshot, strict: true })).runActivity || null
        : undefined;
      const latestSeq = Number.isInteger(page?.pagination?.totalLatestSeq)
        ? page.pagination.totalLatestSeq
        : getEventBoundarySeq(page?.events?.at(-1));
      res.setHeader('Cache-Control', 'private, no-store, max-age=0, must-revalidate');
      writeJson(res, 200, {
        schemaVersion: 2,
        sessionId,
        filter: 'all',
        events: parsedUrl.query.compact === '1' ? compactMobileDurableEvents(page?.events || []) : (page?.events || []),
        ...(parsedUrl.query.compact === '1' ? { runActivity: mobileActivity ?? null } : {}),
        pagination: page?.pagination || null,
        latestSeq,
        timedOut: waited.timedOut === true,
        notified: waited.notified === true,
        ...(includeLive ? {
          liveStreamId: page.liveStreamId, liveCursor: page.liveCursor,
          liveEvents: page.liveEvents || [], liveResetRequired: page.liveResetRequired === true,
        } : {}),
        consistency: {
          revision: Number.isInteger(finalSnapshot?.historyMeta?.historyRevision)
            ? finalSnapshot.historyMeta.historyRevision
            : 0,
          stable: true,
        },
      });
    } finally {
      res.removeListener('close', abort);
    }
    return true;
  }

  if (sessionGetRoute?.kind === 'projection') {
    const { sessionId } = sessionGetRoute;
    if (!await requireSessionAccess(res, authSession, sessionId)) return true;
    const view = typeof parsedUrl.query.view === 'string'
      ? String(parsedUrl.query.view || '').trim().toLowerCase()
      : String(sessionGetRoute.projectionView || '').trim().toLowerCase();
    const session = await getSessionListItemForClient(sessionId);
    if (!session) {
      writeJson(res, 404, { error: 'Session not found' });
      return true;
    }
    const latestSeq = Number.isInteger(session.latestSeq) ? session.latestSeq : 0;
    const projection = await ensureSessionAuditProjection(sessionId, { latestSeq });
    const model = buildProjectionModel(projection, { session });
    const activeRunId = session?.activity?.run?.id || session?.activity?.runId || '';
    const run = activeRunId ? await getRun(activeRunId) : null;
    const runSheet = buildRunSheetProjectionView({ session, projection, model, run });
    if (view === 'run-sheet') {
      writeJsonCached(req, res, {
        sessionId,
        view: 'run-sheet',
        runSheet,
      });
      return true;
    }
    writeJsonCached(req, res, {
      sessionId,
      view: view || 'audit',
      session,
      projection,
      model,
      runSheet,
    });
    return true;
  }

  if (sessionGetRoute?.kind === 'event-delta') {
    const { sessionId } = sessionGetRoute;
    if (!await requireSessionAccess(res, authSession, sessionId)) return true;
    const filter = typeof parsedUrl.query.filter === 'string'
      ? String(parsedUrl.query.filter || '').trim().toLowerCase()
      : '';
    const afterSeq = parseNonNegativeInt(parsedUrl.query.afterSeq, 0);
    const readSnapshot = await getSessionReadSnapshot(sessionId);
    if (!readSnapshot) {
      writeJson(res, 404, { error: 'Session not found' });
      return true;
    }
    const sessionMeta = readSnapshot.sessionMeta;
    if (filter === 'all') {
      const limit = parsePositiveInt(parsedUrl.query.limit, DEFAULT_ALL_EVENTS_PAGE_LIMIT, {
        max: MAX_ALL_EVENTS_PAGE_LIMIT,
      });
      const { events, pagination } = await getSessionEventsPage(sessionId, {
        includeBodies: false,
        includeMessageBodies: true,
        maxBodyBytes: MAX_ALL_EVENTS_BODY_BYTES,
        maxResponseBytes: MAX_ALL_EVENTS_RESPONSE_BYTES,
        limit,
        afterSeq,
        direction: 'after',
        historyMeta: readSnapshot.historyMeta,
        strict: true,
      });
      const latestSeq = Math.max(
        Number.isInteger(sessionMeta?.latestSeq) ? sessionMeta.latestSeq : 0,
        Number.isInteger(pagination?.totalLatestSeq) ? pagination.totalLatestSeq : getLatestEventBoundarySeq(events),
      );
      writeJsonCached(req, res, {
        schemaVersion: 2,
        sessionId,
        filter: 'all',
        events,
        latestSeq,
        pagination,
        resetRequired: false,
        consistency: {
          revision: Number.isInteger(readSnapshot.historyMeta?.historyRevision)
            ? readSnapshot.historyMeta.historyRevision
            : 0,
          stable: true,
        },
      });
      return true;
    }
    // A bounded projection page is authoritative for the next refresh.  We
    // deliberately ask the client to replace its visible window: reconstructing
    // an exact merged assistant turn from a raw delta alone would otherwise
    // require loading the entire transcript again.
    const page = await getSessionTimelinePage(sessionId, {
      limit: 50,
      afterSeq,
      direction: 'after',
      sessionMeta: readSnapshot.sessionMeta,
      historyMeta: readSnapshot.historyMeta,
      strict: true,
    });
    const latestSeq = Math.max(Number.isInteger(sessionMeta?.latestSeq) ? sessionMeta.latestSeq : 0, page.latestSeq || 0);
    const runActivity = page.runActivity;
    const resetRequired = true;
    const operationUpdates = [];
    const events = Array.isArray(page.events) ? page.events : [];
    writeJsonCached(req, res, {
      schemaVersion: 2,
      sessionId,
      filter: 'visible',
      events,
      operationUpdates,
      runActivity,
      latestSeq,
      pagination: page.pagination,
      resetRequired,
      ...(resetRequired ? { reason: 'bounded_projection_refresh' } : {}),
      consistency: {
        revision: Number.isInteger(readSnapshot.historyMeta?.historyRevision)
          ? readSnapshot.historyMeta.historyRevision
          : 0,
        stable: true,
      },
    });
    return true;
  }

  if (sessionGetRoute?.kind === 'source-context') {
    const { sessionId } = sessionGetRoute;
    if (!await requireSessionAccess(res, authSession, sessionId)) return true;
    const sourceContext = await getSessionSourceContext(sessionId, {
      requestId: typeof parsedUrl.query.requestId === 'string' ? parsedUrl.query.requestId : '',
    });
    if (!sourceContext) {
      writeJson(res, 404, { error: 'Session not found' });
      return true;
    }
    writeJson(res, 200, { sessionId, sourceContext });
    return true;
  }

  if (sessionGetRoute?.kind === 'response') {
    const { sessionId, responseId } = sessionGetRoute;
    if (!await requireSessionAccess(res, authSession, sessionId)) return true;
    const replyPublication = await getSessionReplyPublication(sessionId, responseId);
    if (!replyPublication) {
      writeJson(res, 404, { error: 'Reply publication not found' });
      return true;
    }
    writeJsonCached(req, res, { sessionId, responseId, replyPublication });
    return true;
  }

  if (sessionGetRoute?.kind === 'event-block') {
    const {
      sessionId,
      startSeq,
      endSeq,
    } = sessionGetRoute;
    if (!await requireSessionAccess(res, authSession, sessionId)) return true;
    const session = await getSessionForClient(sessionId);
    if (!session) {
      writeJson(res, 404, { error: 'Session not found' });
      return true;
    }
    let events;
    try {
      events = await getSessionEventBlock(sessionId, startSeq, endSeq, { strict: true });
    } catch (error) {
      if (error?.code === 'EVENT_RANGE_TOO_LARGE') {
        writeJson(res, 413, {
          error: `Event block exceeds the ${MAX_EVENT_RANGE_SPAN}-event limit`,
          code: error.code,
          maxSpan: MAX_EVENT_RANGE_SPAN,
        });
        return true;
      }
      throw error;
    }
    if (events.length === 0) {
      writeJson(res, 404, { error: 'Event block not found' });
      return true;
    }
    writeJsonCached(req, res, { sessionId, startSeq, endSeq, events }, {
      cacheControl: immutablePrivateEventCacheControl,
      vary: '',
    });
    return true;
  }

  if (sessionGetRoute?.kind === 'event-body') {
    const { sessionId, seq } = sessionGetRoute;
    if (!await requireSessionAccess(res, authSession, sessionId)) return true;
    const body = await readEventBody(sessionId, seq, {
      // The event body endpoint is a UI detail endpoint.  Large bodies are
      // represented by a bounded preview; callers should never need to pull
      // tens of megabytes just to expand one row.
      maxBytes: Number.parseInt(process.env.AGENTOC_MAX_EVENT_BODY_RESPONSE_BYTES || String(4 * 1024 * 1024), 10),
      strict: true,
    });
    if (!body) {
      writeJson(res, 404, { error: 'Event body not found' });
      return true;
    }
    writeJsonCached(req, res, { body }, {
      cacheControl: immutablePrivateEventCacheControl,
      vary: '',
    });
    return true;
  }

  const rootSessionMessageRoute = pathname.startsWith('/api/root-sessions/');
  const sessionMessageRoute = pathname.startsWith('/api/sessions/');
  if ((sessionMessageRoute || rootSessionMessageRoute) && req.method === 'POST') {
    const parts = pathname.split('/').filter(Boolean);
    const sessionId = parts[2];
    const action = parts[3] || null;

    if (parts.length === 6 && parts[0] === 'api' && parts[1] === 'sessions' && sessionId && action === 'plans' && parts[5] === 'actions') {
      const planId = parts[4] || '';
      if (!await requireSessionAccess(res, authSession, sessionId)) return true;
      if (authSession?.role === 'visitor') {
        writeJson(res, 403, { error: 'Access denied' });
        return true;
      }
      let payload = {};
      try {
        const body = await readBody(req, 64 * 1024);
        payload = body ? JSON.parse(body) : {};
      } catch (err) {
        writeJson(res, err.code === 'BODY_TOO_LARGE' ? 413 : 400, { error: err.code === 'BODY_TOO_LARGE' ? 'Request body too large' : 'Bad request' });
        return true;
      }
      try {
        const outcome = await submitPlanAction(sessionId, planId, {
          action: typeof payload?.action === 'string' ? payload.action : payload?.planAction,
          text: typeof payload?.text === 'string' ? payload.text : '',
          requestId: typeof payload?.requestId === 'string' ? payload.requestId : '',
          model: typeof payload?.model === 'string' ? payload.model : '',
          effort: typeof payload?.effort === 'string' ? payload.effort : '',
          serviceTier: typeof payload?.serviceTier === 'string' ? payload.serviceTier : '',
          permissionMode: typeof payload?.permissionMode === 'string' ? payload.permissionMode : '',
          thinking: payload?.thinking === true,
          ...authenticatedTurnOptions(authSession),
        });
        writeJson(res, outcome.duplicate ? 200 : 202, {
          requestId: outcome.requestId || outcome.run?.requestId || null,
          duplicate: outcome.duplicate,
          queued: outcome.queued,
          run: outcome.run,
          response: outcome.response || null,
          session: createClientSessionDetail(outcome.session),
        });
      } catch (error) {
        const statusCode =
          error?.code === 'RESTART_DRAINING'
            ? 503
            : error?.code === 'PLAN_NOT_FOUND'
              ? 404
              : error?.code === 'PRIVILEGED_GATE_UNSUPPORTED_RUNTIME'
                || error?.code === 'PERMISSION_PROFILE_UNSUPPORTED_RUNTIME'
                ? 409
              : 400;
        writeJson(res, statusCode, {
          error: error.message || 'Failed to submit plan action',
          ...(error?.code ? { code: error.code } : {}),
          ...(Number.isFinite(error?.retryAfterMs) ? { retryAfterMs: error.retryAfterMs } : {}),
        });
      }
      return true;
    }

    if (parts.length === 4
      && parts[0] === 'api'
      && (parts[1] === 'sessions' || parts[1] === 'root-sessions')
      && sessionId
      && action === 'messages') {
      // Scope support is effect-specific. This endpoint has not yet completed
      // guarded Run/queue publication; never silently ignore a caller's condition.
      if (Object.hasOwn(req.headers || {}, SESSION_API_SCOPE_HEADER)) {
        req.resume?.();
        res.setHeader?.('Cache-Control', 'private, no-store');
        writeJson(res, 409, { code: 'CAPABILITY_UNSUPPORTED', error: 'Scoped message commit is not yet supported' });
        return true;
      }
      if (!await requireSessionAccess(res, authSession, sessionId)) return true;
      setApiRequestCorrelation({ sessionId });
      const targetSession = await measureApiRequestPhase(
        'route.session_meta',
        () => getSessionMeta(sessionId),
      );
      if (!targetSession) {
        writeJson(res, 404, { error: 'Session not found' });
        return true;
      }
      // S10 Managed Input enforcement: the metadata lookup above retains the
      // internal session policy, while avoiding the full history/run projection
      // before a message can be acknowledged.
      const rawManagedSession = targetSession;
      if (!rootSessionMessageRoute) {
        try {
          assertManagedInputAllowed({ session: rawManagedSession, operation: 'message' });
        } catch (error) {
          if (error?.code === MANAGED_SESSION_INPUT_BYPASS) {
            writeJson(res, 409, { error: error.message, code: error.code });
            return true;
          }
          throw error;
        }
      }
      let body;
      try {
        body = await measureApiRequestPhase(
          'route.read_payload',
          () => readSessionMessagePayload(req, pathname),
        );
      } catch (err) {
        writeJson(res, err.code === 'BODY_TOO_LARGE' ? 413 : 400, { error: err.code === 'BODY_TOO_LARGE' ? 'Request body too large' : 'Bad request' });
        return true;
      }
      const payload = body;
      if (!payload || typeof payload !== 'object') {
        writeJson(res, 400, { error: 'Invalid request body' });
        return true;
      }
      if (!payload?.text || typeof payload.text !== 'string') {
        writeJson(res, 400, { error: 'text is required' });
        return true;
      }
      try {
        const requestId = typeof payload?.requestId === 'string' ? payload.requestId.trim() : '';
        setApiRequestCorrelation({ requestId, sessionId });
        const requestedAttachments = Array.isArray(payload?.attachments) ? payload.attachments.filter(Boolean) : [];
        const harnessCapabilityIds = payload?.harnessCapabilityIds ?? [];
        if (!Array.isArray(harnessCapabilityIds) || harnessCapabilityIds.length > 8
          || harnessCapabilityIds.some((id) => typeof id !== 'string' || id.length > 500)) {
          const error = new Error('Invalid harness capability selection.');
          error.code = 'HARNESS_CAPABILITY_INVALID';
          error.statusCode = 400;
          throw error;
        }
        if (authSession?.role === 'visitor' && harnessCapabilityIds.length > 0) {
          const error = new Error('Harness capabilities are not available to visitor sessions.');
          error.code = 'HARNESS_CAPABILITY_FORBIDDEN';
          error.statusCode = 403;
          throw error;
        }
        const requestedTool = authSession?.role === 'visitor'
          ? rawManagedSession.tool
          : (typeof payload?.tool === 'string' && payload.tool.trim() ? payload.tool.trim() : rawManagedSession.tool);
        const requestedProviderProfile = authSession?.role === 'visitor'
          ? (rawManagedSession.providerProfile || rawManagedSession.providerProfileId || '')
          : (typeof payload?.providerProfile === 'string' && payload.providerProfile.trim()
            ? payload.providerProfile.trim()
            : (rawManagedSession.providerProfile || rawManagedSession.providerProfileId || ''));
        if (harnessCapabilityIds.length > 0 && (!requestedTool || !/^[a-z0-9][a-z0-9-]{0,63}$/i.test(requestedTool))) {
          const error = new Error('The selected harness is not available for this session.');
          error.code = 'HARNESS_CAPABILITY_STALE';
          error.statusCode = 409;
          throw error;
        }
        let harnessInstructions = '';
        if (harnessCapabilityIds.length > 0) {
          const project = rawManagedSession.projectId ? await getProject(rawManagedSession.projectId) : null;
          harnessInstructions = await resolveHarnessCapabilityInstructions({
            ids: harnessCapabilityIds,
            session: { ...rawManagedSession, tool: requestedTool },
            cwd: project?.rootPath || process.cwd(),
            providerProfileId: requestedProviderProfile,
            model: authSession?.role === 'visitor' ? rawManagedSession.model : (payload?.model || rawManagedSession.model),
          });
        }
        const preSavedAttachments = await measureApiRequestPhase(
          'route.resolve_attachments',
          () => resolveRequestedSessionAttachments(authSession, requestedAttachments, { sessionId }),
        );
        const messageOptions = {
          ...(authSession?.role === 'visitor' ? {} : { tool: requestedTool }),
          ...(authSession?.role === 'visitor' || !requestedProviderProfile ? {} : { providerProfile: requestedProviderProfile }),
          ...(harnessInstructions ? { harnessInstructions } : {}),
          thinking: authSession?.role === 'visitor' ? false : !!payload.thinking,
          model: authSession?.role === 'visitor' ? undefined : payload.model || undefined,
          effort: authSession?.role === 'visitor' ? undefined : payload.effort || undefined,
          serviceTier: authSession?.role === 'visitor' ? undefined : payload.serviceTier || undefined,
          interactionMode: authSession?.role === 'visitor' ? undefined : payload.interactionMode || undefined,
          permissionMode: authSession?.role === 'visitor' ? undefined : payload.permissionMode || undefined,
          planAction: authSession?.role === 'visitor' ? undefined : payload.planAction || undefined,
          planId: authSession?.role === 'visitor' ? undefined : payload.planId || undefined,
          sourceContext: authSession?.role === 'visitor' ? undefined : payload.sourceContext,
          ...(authSession?.role === 'visitor' ? {} : pickRequestedRunAgentTemplate(payload)),
          ...(typeof payload.uiLanguage === 'string' && payload.uiLanguage.trim()
            ? { uiLanguage: payload.uiLanguage.trim() }
            : {}),
          // Browser MCP is an explicit owner-run capability. The browser
          // server is never injected merely because the provider supports it.
          ...(authSession?.role === 'owner' && payload.browserMcpEnabled === true
            ? { browserMcpEnabled: true }
            : {}),
          // Ordinary browser sends should acknowledge after the durable Run is
          // accepted. Callers that explicitly opt in to deferred prompt
          // building receive a fast acknowledgement with a preparing Run.
          ...(payload.deferPromptBuild === true ? { deferPromptBuild: true } : {}),
          deferRunnerLaunch: true,
          ...(preSavedAttachments.length > 0 ? { preSavedAttachments } : {}),
          // This fact comes only from the authenticated server session. It is
          // never accepted from the request body.
          ...authenticatedTurnOptions(authSession),
        };
        const outcome = await measureApiRequestPhase(
          'route.submit_message',
          () => sendUserMessage(sessionId, payload.text.trim(), [], {
            ...messageOptions,
            ...(requestId ? { requestId } : {}),
            ...(rootSessionMessageRoute ? { forceAddressability: true } : {}),
          }),
        );
        writeJson(res, outcome.duplicate ? 200 : 202, {
          requestId: requestId || outcome.requestId || outcome.run?.requestId || null,
          duplicate: outcome.duplicate,
          queued: outcome.queued,
          run: outcome.run,
          response: outcome.response || null,
          session: createClientSessionDetail(outcome.session),
        });
      } catch (error) {
        const statusCode = Number.isInteger(error?.statusCode)
          ? error.statusCode
          : error?.code === SESSION_NOT_USER_ADDRESSABLE
          ? 403
          : error?.code === 'RESTART_DRAINING'
          ? 503
          : error?.code === 'PRIVILEGED_GATE_UNSUPPORTED_RUNTIME'
            || error?.code === 'PERMISSION_PROFILE_UNSUPPORTED_RUNTIME'
            || error?.code === 'SESSION_INITIALIZING'
          ? 409
          : 400;
        writeJson(res, statusCode, {
          error: error.message || 'Failed to submit message',
          ...(error?.code ? { code: error.code } : {}),
          ...(Number.isFinite(error?.retryAfterMs) ? { retryAfterMs: error.retryAfterMs } : {}),
        });
      }
      return true;
    }

    // Explicit asset registration: tooling inside a run (or the model itself)
    // registers a file it just produced as a session attachment, bypassing
    // fragile text-path resolution in result-file publishing. The registered
    // file must already exist; it is published through the standard local
    // asset pipeline and appended as an assistant message the chat can render.
    if (parts.length === 4 && parts[0] === 'api' && parts[1] === 'sessions' && sessionId && action === 'assets') {
      if (!await requireSessionAccess(res, authSession, sessionId)) return true;
      if (authSession?.role === 'visitor') {
        writeJson(res, 403, { error: 'Access denied' });
        return true;
      }
      const targetSession = await getSessionForClient(sessionId);
      if (!targetSession) {
        writeJson(res, 404, { error: 'Session not found' });
        return true;
      }
      let payload = {};
      try {
        const body = await readBody(req, 256 * 1024);
        payload = body ? JSON.parse(body) : {};
      } catch (err) {
        writeJson(res, err.code === 'BODY_TOO_LARGE' ? 413 : 400, { error: err.code === 'BODY_TOO_LARGE' ? 'Request body too large' : 'Bad request' });
        return true;
      }
      const localPath = typeof payload?.localPath === 'string' ? payload.localPath.trim() : '';
      if (!localPath) {
        writeJson(res, 400, { error: 'localPath is required' });
        return true;
      }
      try {
        const resolvedAttachments = await resolveRequestedSessionAttachments(authSession, [{
          localPath,
          ...(typeof payload?.originalName === 'string' && payload.originalName.trim()
            ? { originalName: payload.originalName.trim() }
            : {}),
          ...(typeof payload?.mimeType === 'string' && payload.mimeType.trim()
            ? { mimeType: payload.mimeType.trim() }
            : {}),
          ...(payload?.renderAs === 'file' ? { renderAs: 'file' } : {}),
        }], {
          sessionId,
          allowLocalPaths: true,
          createdBy: 'assistant',
        });
        const text = typeof payload?.text === 'string' ? payload.text : '';
        await appendEvent(sessionId, messageEvent('assistant', text, resolvedAttachments, {
          source: 'session_asset_registration',
          ...(authSession?.principalKind === 'run_capability' && authSession.runId
            ? { runId: authSession.runId }
            : {}),
        }));
        const asset = resolvedAttachments[0] || {};
        writeJson(res, 201, {
          asset: {
            assetId: asset.assetId,
            originalName: asset.originalName,
            mimeType: asset.mimeType,
            ...(Number.isInteger(asset?.sizeBytes) && asset.sizeBytes > 0 ? { sizeBytes: asset.sizeBytes } : {}),
          },
        });
      } catch (error) {
        const statusCode =
          error?.statusCode === 403 ? 403
          : error?.statusCode === 409 ? 409
          : 400;
        writeJson(res, statusCode, {
          error: error.message || 'Failed to register asset',
          ...(error?.code ? { code: error.code } : {}),
        });
      }
      return true;
    }

    if (parts.length === 4 && parts[0] === 'api' && parts[1] === 'sessions' && sessionId && action === 'regenerate') {
      if (!await requireSessionAccess(res, authSession, sessionId)) return true;
      if (authSession?.role === 'visitor') {
        writeJson(res, 403, { error: 'Access denied' });
        return true;
      }
      let payload = {};
      try {
        const body = await readBody(req, 64 * 1024);
        payload = body ? JSON.parse(body) : {};
      } catch (err) {
        writeJson(res, err.code === 'BODY_TOO_LARGE' ? 413 : 400, { error: err.code === 'BODY_TOO_LARGE' ? 'Request body too large' : 'Bad request' });
        return true;
      }
      const parentRequestId = typeof payload?.requestId === 'string' ? payload.requestId.trim() : '';
      if (!parentRequestId) {
        writeJson(res, 400, { error: 'requestId is required' });
        return true;
      }
      try {
        const outcome = await regenerateSessionReply(sessionId, parentRequestId, {
          ...authenticatedTurnOptions(authSession),
          requestId: typeof payload?.newRequestId === 'string' ? payload.newRequestId.trim() : '',
          ...(typeof payload?.uiLanguage === 'string' && payload.uiLanguage.trim()
            ? { uiLanguage: payload.uiLanguage.trim() }
            : {}),
        });
        writeJson(res, outcome.duplicate ? 200 : 202, {
          requestId: outcome.requestId || outcome.run?.requestId || null,
          duplicate: outcome.duplicate,
          queued: outcome.queued,
          run: outcome.run,
          response: outcome.response || null,
          session: createClientSessionDetail(outcome.session),
        });
      } catch (error) {
        const statusCode =
          error?.code === 'RESTART_DRAINING'
            ? 503
            : error?.code === 'PRIVILEGED_GATE_UNSUPPORTED_RUNTIME'
              || error?.code === 'PERMISSION_PROFILE_UNSUPPORTED_RUNTIME'
            ? 409
            : 400;
        writeJson(res, statusCode, {
          error: error.message || 'Failed to regenerate reply',
          ...(error?.code ? { code: error.code } : {}),
          ...(Number.isFinite(error?.retryAfterMs) ? { retryAfterMs: error.retryAfterMs } : {}),
        });
      }
      return true;
    }

    // A1 edit-resend: replace the LAST user message's run with one built from
    // the edited prompt (version-rail fold, fresh provider thread). Same
    // shape as regenerate, plus prompt + optional replacement attachments.
    if (parts.length === 4 && parts[0] === 'api' && parts[1] === 'sessions' && sessionId && action === 'resend-edited') {
      if (!await requireSessionAccess(res, authSession, sessionId)) return true;
      if (authSession?.role === 'visitor') {
        writeJson(res, 403, { error: 'Access denied' });
        return true;
      }
      let payload = {};
      try {
        const body = await readBody(req, 256 * 1024);
        payload = body ? JSON.parse(body) : {};
      } catch (err) {
        writeJson(res, err.code === 'BODY_TOO_LARGE' ? 413 : 400, { error: err.code === 'BODY_TOO_LARGE' ? 'Request body too large' : 'Bad request' });
        return true;
      }
      const parentRequestId = typeof payload?.requestId === 'string' ? payload.requestId.trim() : '';
      const editedPrompt = typeof payload?.prompt === 'string' ? payload.prompt.trim() : '';
      if (!parentRequestId || !editedPrompt) {
        writeJson(res, 400, { error: 'requestId and prompt are required' });
        return true;
      }
      const requestedAttachments = Array.isArray(payload?.attachments) ? payload.attachments.filter(Boolean) : [];
      try {
        const preSavedAttachments = await resolveRequestedSessionAttachments(authSession, requestedAttachments, {
          sessionId,
        });
        const outcome = await resendEditedMessage(sessionId, parentRequestId, {
          ...authenticatedTurnOptions(authSession),
          prompt: editedPrompt,
          requestId: typeof payload?.newRequestId === 'string' ? payload.newRequestId.trim() : '',
          ...(preSavedAttachments.length > 0 ? { preSavedAttachments } : {}),
          // Cross-agent resend: the client may override the agent (tool),
          // model, and reasoning (effort levels or thinking toggle) for this
          // run. Overrides are per-run only — the session keeps its defaults.
          ...(authSession?.role === 'visitor' ? {} : {
            ...(typeof payload?.tool === 'string' && payload.tool.trim() ? { tool: payload.tool.trim() } : {}),
            ...(typeof payload?.model === 'string' && payload.model.trim() ? { model: payload.model.trim() } : {}),
            ...(typeof payload?.effort === 'string' && payload.effort.trim() ? { effort: payload.effort.trim() } : {}),
            ...(typeof payload?.serviceTier === 'string' && payload.serviceTier.trim() ? { serviceTier: payload.serviceTier.trim() } : {}),
            ...(typeof payload?.thinking === 'boolean' ? { thinking: payload.thinking } : {}),
          }),
          ...(typeof payload?.uiLanguage === 'string' && payload.uiLanguage.trim()
            ? { uiLanguage: payload.uiLanguage.trim() }
            : {}),
        });
        writeJson(res, outcome.duplicate ? 200 : 202, {
          requestId: outcome.requestId || outcome.run?.requestId || null,
          duplicate: outcome.duplicate,
          queued: outcome.queued,
          run: outcome.run,
          response: outcome.response || null,
          session: createClientSessionDetail(outcome.session),
        });
      } catch (error) {
        const statusCode =
          error?.code === 'RESTART_DRAINING'
            ? 503
            : error?.code === 'PRIVILEGED_GATE_UNSUPPORTED_RUNTIME'
              || error?.code === 'PERMISSION_PROFILE_UNSUPPORTED_RUNTIME'
            ? 409
            : 400;
        writeJson(res, statusCode, {
          error: error.message || 'Failed to resend edited message',
          ...(error?.code ? { code: error.code } : {}),
          ...(Number.isFinite(error?.retryAfterMs) ? { retryAfterMs: error.retryAfterMs } : {}),
        });
      }
      return true;
    }

    if (
      (parts.length === 4 || parts.length === 5)
      && parts[0] === 'api'
      && parts[1] === 'sessions'
      && sessionId
      && action === 'confirmations'
    ) {
      if (!await requireSessionAccess(res, authSession, sessionId)) return true;
      if (authSession?.role === 'visitor') {
        writeJson(res, 403, { error: 'Access denied' });
        return true;
      }
      let payload = {};
      try {
        const body = await readBody(req, 16 * 1024);
        payload = body ? JSON.parse(body) : {};
      } catch (err) {
        writeJson(res, err.code === 'BODY_TOO_LARGE' ? 413 : 400, { error: err.code === 'BODY_TOO_LARGE' ? 'Request body too large' : 'Bad request' });
        return true;
      }

      try {
        if (parts.length === 4) {
          const outcome = await requestSessionConfirmation(sessionId, {
            approvalId: typeof payload?.approvalId === 'string' ? payload.approvalId : '',
            title: typeof payload?.title === 'string' ? payload.title : '',
            reason: typeof payload?.reason === 'string' ? payload.reason : '',
            message: typeof payload?.message === 'string' ? payload.message : '',
            question: typeof payload?.question === 'string' ? payload.question : '',
            prompt: typeof payload?.prompt === 'string' ? payload.prompt : '',
            questions: Array.isArray(payload?.questions) ? payload.questions : [],
            options: Array.isArray(payload?.options) ? payload.options : [],
            choices: Array.isArray(payload?.choices) ? payload.choices : [],
            confirmLabel: typeof payload?.confirmLabel === 'string' ? payload.confirmLabel : '',
            denyLabel: typeof payload?.denyLabel === 'string' ? payload.denyLabel : '',
            approveMessage: typeof payload?.approveMessage === 'string' ? payload.approveMessage : '',
            denyMessage: typeof payload?.denyMessage === 'string' ? payload.denyMessage : '',
          });
          writeJson(res, outcome.duplicate ? 200 : 201, {
            duplicate: outcome.duplicate,
            confirmation: outcome.confirmation,
            session: createClientSessionDetail(outcome.session),
          });
          return true;
        }

        let confirmationId = parts[4] || '';
        try {
          confirmationId = decodeURIComponent(confirmationId);
        } catch {}
        const outcome = await submitSessionConfirmationDecision(sessionId, confirmationId, {
          ...authenticatedTurnOptions(authSession),
          decision: typeof payload?.decision === 'string' ? payload.decision : payload?.action,
          requestId: typeof payload?.requestId === 'string' ? payload.requestId : '',
        });
        writeJson(res, outcome.duplicate ? 200 : 202, {
          requestId: outcome.requestId || null,
          duplicate: outcome.duplicate,
          confirmation: outcome.confirmation || null,
          responseEvent: outcome.responseEvent || null,
          message: outcome.message || null,
          run: outcome.run || null,
          session: createClientSessionDetail(outcome.session),
        });
      } catch (error) {
        const statusCode =
          error?.code === 'SESSION_NOT_FOUND' || error?.code === 'CONFIRMATION_NOT_FOUND'
            ? 404
            : 400;
        writeJson(res, statusCode, { error: error.message || 'Failed to process confirmation' });
      }
      return true;
    }

    if (parts.length === 4 && parts[0] === 'api' && parts[1] === 'sessions' && sessionId && action === 'cancel') {
      if (!await requireSessionAccess(res, authSession, sessionId)) return true;
      const run = await cancelActiveRun(sessionId);
      if (!run) {
        const session = await getSessionForClient(sessionId);
        if (session && session.activity?.run?.state !== 'running') {
          writeJson(res, 200, { run: null, session });
          return true;
        }
        writeJson(res, 409, { error: 'No active run' });
        return true;
      }
      writeJson(res, 200, { run });
      return true;
    }

    if (parts.length === 4 && parts[0] === 'api' && parts[1] === 'sessions' && sessionId && action === 'queue') {
      if (!await requireSessionAccess(res, authSession, sessionId)) return true;
      let body = '';
      try {
        body = await readBody(req, 4096);
      } catch (err) {
        writeJson(res, err.code === 'BODY_TOO_LARGE' ? 413 : 400, { error: err.code === 'BODY_TOO_LARGE' ? 'Request body too large' : 'Bad request' });
        return true;
      }
      let payload = {};
      try {
        payload = body ? JSON.parse(body) : {};
      } catch {
        writeJson(res, 400, { error: 'Invalid request body' });
        return true;
      }
      const queueAction = typeof payload?.action === 'string' ? payload.action.trim().toLowerCase() : '';
      try {
        if (queueAction === 'steer') {
          const outcome = await steerQueuedFollowUp(sessionId, {
            requestId: typeof payload?.requestId === 'string' ? payload.requestId : '',
          });
          if (!outcome) {
            writeJson(res, 404, { error: 'Session not found' });
            return true;
          }
          writeJson(res, 202, {
            requestId: outcome.requestId || payload?.requestId || null,
            steered: outcome.steered === true,
            pendingCancel: outcome.pendingCancel === true,
            interruptedRunId: outcome.interruptedRunId || null,
            queued: outcome.queued === true,
            run: outcome.run || null,
            response: outcome.response || null,
            session: createClientSessionDetail(outcome.session),
          });
          return true;
        }
        const session = await updateSessionFollowUpQueue(sessionId, {
          requestId: typeof payload?.requestId === 'string' ? payload.requestId : '',
          clear: queueAction === 'clear' || payload?.clear === true,
          truncateFrom: queueAction === 'truncate_from' || payload?.truncateFrom === true,
        });
        if (!session) {
          writeJson(res, 404, { error: 'Session not found' });
          return true;
        }
        writeJson(res, 200, { session });
      } catch (error) {
        const statusCode =
          error?.code === 'NOT_FOUND'
            ? 404
            : 400;
        writeJson(res, statusCode, {
          error: error.message || 'Failed to update queued follow-ups',
          ...(error?.code ? { code: error.code } : {}),
        });
      }
      return true;
    }
  }

  if (pathname === '/api/sessions' && req.method === 'POST') {
    if (authSession?.role === 'visitor' && !getGrantedCapability(authSession, 'createSession')) {
      writeJson(res, 403, { error: 'Access denied' });
      return true;
    }
    let body;
    try {
      body = await readBody(req, 10240);
    } catch (err) {
      if (err.code === 'BODY_TOO_LARGE') {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Request body too large' }));
        return true;
      }
      throw err;
    }
    try {
      const payload = JSON.parse(body);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('Request body must be an object');
      }
      // Scope derives exclusively from authenticated state, never extras. An
      // owner retry survives cookie/credential rotation; scoped delegation
      // retains both principal and Agent boundaries.
      const creationScope = authSession?.role === 'owner'
        ? 'owner'
        : JSON.stringify([resolveAuthenticatedTurnPrincipalKind(authSession),
          getAuthPrincipalId(authSession), getAuthScopeAgentId(authSession)]);
      const creationRequest = parseSessionCreationRequest(payload, req.headers?.['idempotency-key'], creationScope);
      const replay = creationRequest ? await findCreatedSession(creationRequest) : null;
      if (replay) {
        const session = await initializeCreatedSession(replay.id);
        writeJson(res, 200, { session: createClientSessionDetail(session), duplicate: true, creationContractVersion: 1 });
        return true;
      }
      const {
        folder,
        projectId,
        tool,
        name,
        sourceId,
        sourceName,
        templateId,
        templateName,
        group,
        description,
        starterPreset,
        systemPrompt,
        welcomeMessage,
        internalRole,
        completionTargets,
        externalTriggerId,
        sourceContext,
      } = payload;
      const requestedInteractionMode = typeof payload.interactionMode === 'string'
        ? payload.interactionMode.trim().toLowerCase()
        : '';
      if (requestedInteractionMode && !['agent', 'plan'].includes(requestedInteractionMode)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'interactionMode must be "agent" or "plan"' }));
        return true;
      }
      const agentScoped = isAgentScopedAuthSession(authSession);
      const scopedAgentId = getAuthScopeAgentId(authSession);
      const scopedPrincipalId = getAuthPrincipalId(authSession);
      const requestedFolder = typeof folder === 'string' ? folder.trim() : '';
      const requestedProjectId = typeof projectId === 'string' ? normalizeProjectId(projectId) : '';
      let effectiveProject = null;
      if (!agentScoped && typeof projectId === 'string' && projectId.trim()) {
        if (!requestedProjectId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'projectId is invalid' }));
          return true;
        }
        effectiveProject = await getProject(requestedProjectId);
        if (!effectiveProject) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Project not found' }));
          return true;
        }
      }
      const effectiveFolder = agentScoped
        ? MANAGED_WORK_ROOT_DIR
        : effectiveProject
          ? effectiveProject.rootPath
        : (requestedFolder
          ? (requestedFolder.startsWith('~')
            ? join(homedir(), requestedFolder.slice(1))
            : resolve(requestedFolder))
          : MANAGED_WORK_ROOT_DIR);
      const effectiveTool = agentScoped
        ? (typeof authSession?.agentTool === 'string' && authSession.agentTool.trim()
          ? authSession.agentTool.trim()
          : tool)
        : tool;
      const requestedStarterPreset = normalizeSessionStarterPreset(starterPreset);
      if (requestedStarterPreset === CREATE_AGENT_STARTER_PRESET
        && resolveAuthenticatedTurnPrincipalKind(authSession) !== 'owner') {
        writeJson(res, 403, { error: 'Owner access required' });
        return true;
      }
      const starterDefinition = requestedStarterPreset
        ? resolveStarterPresetDefinition(requestedStarterPreset)
        : null;
      const explicitSystemPrompt = typeof systemPrompt === 'string' ? systemPrompt : '';
      const explicitWelcomeMessage = typeof welcomeMessage === 'string' ? welcomeMessage.trim() : '';
      if (!effectiveTool) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'tool is required' }));
        return true;
      }
      if (!await isDirectoryPath(effectiveFolder)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Folder does not exist' }));
        return true;
      }
      const createOptions = {
        sourceId: agentScoped ? 'share_link' : (typeof sourceId === 'string' ? sourceId : ''),
        sourceName: agentScoped ? 'Share Link' : (typeof sourceName === 'string' ? sourceName : ''),
        templateId: agentScoped ? scopedAgentId : (typeof templateId === 'string' ? templateId : ''),
        templateName: agentScoped
          ? (typeof authSession?.agentName === 'string' ? authSession.agentName : '')
          : (typeof templateName === 'string' ? templateName : ''),
        group: group || '',
        description: description || '',
        completionTargets: Array.isArray(completionTargets) ? completionTargets : [],
        externalTriggerId: typeof externalTriggerId === 'string' ? externalTriggerId : '',
        // Server-owned creation provenance. Product-operation policy consumes
        // this durable fact; request payload fields can never choose it.
        createdByPrincipalKind: typeof authSession?.principalKind === 'string' && authSession.principalKind.trim()
          ? authSession.principalKind.trim()
          : (typeof authSession?.role === 'string' ? authSession.role.trim() : ''),
      };
      if (effectiveProject) {
        createOptions.projectId = effectiveProject.id;
      }
      if (typeof payload.riskMode === 'string') {
        createOptions.riskMode = payload.riskMode;
      }
      // Persist interactionMode (defaults to 'agent' when omitted)
      createOptions.interactionMode = requestedInteractionMode || 'agent';
      if (typeof payload.uiLanguage === 'string' && payload.uiLanguage.trim()) {
        createOptions.uiLanguage = payload.uiLanguage.trim();
      }
      if (requestedStarterPreset) {
        createOptions.starterPreset = requestedStarterPreset;
      }
      if (agentScoped) {
        createOptions.createdByPrincipalId = scopedPrincipalId;
        createOptions.visitorName = 'Guest';
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'systemPrompt')) {
        createOptions.systemPrompt = explicitSystemPrompt;
      } else if (!createOptions.templateId && starterDefinition?.systemPrompt) {
        createOptions.systemPrompt = starterDefinition.systemPrompt;
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'internalRole')) {
        if (agentScoped) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Owner access required' }));
          return true;
        }
        if (internalRole !== null && typeof internalRole !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'internalRole must be a string when provided' }));
          return true;
        }
        createOptions.internalRole = typeof internalRole === 'string' ? internalRole.trim() : '';
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'sourceContext')) {
        createOptions.sourceContext = sourceContext;
      }
      if (typeof payload.providerProfile === 'string' && payload.providerProfile.trim()) {
        createOptions.providerProfile = payload.providerProfile.trim();
      }
      if (typeof payload.model === 'string' && payload.model.trim()) {
        createOptions.model = payload.model.trim();
      }
      const initialWelcomeMessage = createOptions.templateId
        ? ''
        : (Object.prototype.hasOwnProperty.call(payload, 'welcomeMessage')
          ? explicitWelcomeMessage
          : (starterDefinition?.welcomeMessage || ''));
      if (creationRequest) {
        createOptions.creationRequest = creationRequest;
        createOptions.creationInitialization = await prepareSessionCreationInitialization(
          createOptions.templateId, initialWelcomeMessage,
        );
      }
      const creationOutcome = await createSessionWithOutcome(effectiveFolder, effectiveTool, name || '', createOptions);
      let session = creationOutcome.session;
      if (creationRequest) {
        session = await initializeCreatedSession(session.id);
      } else if (createOptions.templateId) {
        session = await applyTemplateToSession(session.id, createOptions.templateId, {
          appendWelcome: true,
          allowVisitor: agentScoped,
        }) || session;
      } else if (initialWelcomeMessage) {
        await appendEvent(session.id, messageEvent('assistant', initialWelcomeMessage));
        session = await getSession(session.id) || session;
      }

      const duplicate = creationRequest && !creationOutcome.created;
      res.writeHead(duplicate ? 200 : 201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ session: createClientSessionDetail(session),
        ...(creationRequest ? { duplicate: !!duplicate, creationContractVersion: 1 } : {}) }));
    } catch (error) {
      const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 400;
      writeJson(res, statusCode, { error: error?.code ? error.message : 'Invalid request body',
        ...(error?.code ? { code: error.code } : {}) });
    }
    return true;
  }

  if (pathname.startsWith('/api/runs/') && req.method === 'GET') {
    const parts = pathname.split('/').filter(Boolean);
    const runId = parts[2];
    if (parts.length !== 3 || parts[0] !== 'api' || parts[1] !== 'runs' || !runId) {
      writeJson(res, 400, { error: 'Invalid run path' });
      return true;
    }
    const run = await getRunState(runId);
    if (!run) {
      writeJson(res, 404, { error: 'Run not found' });
      return true;
    }
    if (!await requireSessionAccess(res, authSession, run.sessionId)) return true;
    writeJsonCached(req, res, { run });
    return true;
  }

  if (pathname.startsWith('/api/runs/') && req.method === 'POST') {
    const parts = pathname.split('/').filter(Boolean);
    const runId = parts[2];
    const action = parts[3];
    if (parts.length === 6 && parts[0] === 'api' && parts[1] === 'runs'
      && action === 'approved-actions' && parts[5] === 'resolve' && runId) {
      let batchId = parts[4] || '';
      try { batchId = decodeURIComponent(batchId); } catch {}
      const run = await getRunState(runId);
      if (!run) {
        writeJson(res, 404, { error: 'Run not found' });
        return true;
      }
      if (!await requireSessionAccess(res, authSession, run.sessionId)) return true;
      if (authSession?.role === 'visitor') {
        writeJson(res, 403, { error: 'Access denied' });
        return true;
      }
      let payload = {};
      try {
        const body = await readBody(req, 32 * 1024);
        payload = body ? JSON.parse(body) : {};
      } catch (error) {
        writeJson(res, error.code === 'BODY_TOO_LARGE' ? 413 : 400, { error: 'Bad request' });
        return true;
      }
      try {
        const outcome = await submitApprovedActionApproval(runId, batchId, {
          decisions: payload?.decisions,
          approvalIntent: typeof payload?.approvalIntent === 'string' ? payload.approvalIntent : '',
          requestId: typeof payload?.requestId === 'string' ? payload.requestId : '',
          authenticatedPrincipalKind: resolveAuthenticatedTurnPrincipalKind(authSession),
          approvalActor: temporaryControlApprovalActor(authSession, 'approval.approved_action.resolve'),
          webauthnProof: payload?.webauthnProof && typeof payload.webauthnProof === 'object'
            ? payload.webauthnProof
            : undefined,
        });
        writeJson(res, outcome.duplicate ? 200 : 202, {
          duplicate: outcome.duplicate === true,
          batchId,
          actions: outcome.actions || [],
          run: outcome.run || null,
          session: createClientSessionDetail(outcome.session),
          continuation: outcome.continuation
            ? { requestId: outcome.continuation.requestId || null, queued: outcome.continuation.queued === true }
            : null,
        });
      } catch (error) {
        const notFound = new Set([
          'APPROVED_ACTION_RUN_NOT_FOUND',
          'APPROVED_ACTION_SESSION_NOT_FOUND',
          'APPROVED_ACTION_BATCH_NOT_FOUND',
        ]);
        const status = notFound.has(error?.code) ? 404
          : error?.code === 'AGENT_CREATE_OWNER_REQUIRED' ? 403
          : ['APPROVED_ACTION_PASSKEY_REQUIRED', 'APPROVED_ACTION_POLICY_DISABLED'].includes(error?.code) ? 409
            : 400;
        writeJson(res, status, { error: error?.message || 'Approved action decision failed', code: error?.code || 'APPROVED_ACTION_RESOLVE_FAILED' });
      }
      return true;
    }
    if (parts.length === 6 && parts[0] === 'api' && parts[1] === 'runs'
      && action === 'approved-actions' && parts[5] === 'webauthn-challenge' && runId) {
      let batchId = parts[4] || '';
      try { batchId = decodeURIComponent(batchId); } catch {}
      const run = await getRunState(runId);
      if (!run) {
        writeJson(res, 404, { error: 'Run not found' });
        return true;
      }
      if (!await requireSessionAccess(res, authSession, run.sessionId)) return true;
      if (authSession?.role === 'visitor') {
        writeJson(res, 403, { error: 'Access denied' });
        return true;
      }
      let payload = {};
      try {
        const body = await readBody(req, 16 * 1024);
        payload = body ? JSON.parse(body) : {};
      } catch (error) {
        writeJson(res, error.code === 'BODY_TOO_LARGE' ? 413 : 400, { error: 'Bad request' });
        return true;
      }
      try {
        const options = await createApprovedActionWebAuthnChallenge(runId, batchId, {
          selectedActionIds: Array.isArray(payload?.selectedActionIds) ? payload.selectedActionIds : [],
          requestId: typeof payload?.requestId === 'string' ? payload.requestId : '',
          request: req,
        });
        writeJson(res, 200, options);
      } catch (error) {
        const status = error?.code === 'APPROVED_ACTION_RUN_NOT_FOUND'
          || error?.code === 'APPROVED_ACTION_SESSION_NOT_FOUND'
          || error?.code === 'APPROVED_ACTION_BATCH_NOT_FOUND'
          ? 404
          : error?.code === 'WEBAUTHN_CREDENTIAL_REQUIRED' ? 409 : 400;
        writeJson(res, status, { error: error?.message || 'Failed to create approved action WebAuthn challenge', code: error?.code || 'APPROVED_ACTION_CHALLENGE_FAILED' });
      }
      return true;
    }
    if (parts.length === 7 && parts[0] === 'api' && parts[1] === 'runs' && action === 'privileged-batches' && parts[5] === 'categories' && runId) {
      let batchId = parts[4] || '';
      let category = parts[6] || '';
      try {
        batchId = decodeURIComponent(batchId);
        category = decodeURIComponent(category);
      } catch {}
      const run = await getRunState(runId);
      if (!run) {
        writeJson(res, 404, { error: 'Run not found' });
        return true;
      }
      if (!await requireSessionAccess(res, authSession, run.sessionId)) return true;
      if (authSession?.role === 'visitor') {
        writeJson(res, 403, { error: 'Access denied' });
        return true;
      }
      let payload = {};
      try {
        const body = await readBody(req, 16 * 1024);
        payload = body ? JSON.parse(body) : {};
      } catch (err) {
        writeJson(res, err.code === 'BODY_TOO_LARGE' ? 413 : 400, { error: err.code === 'BODY_TOO_LARGE' ? 'Request body too large' : 'Bad request' });
        return true;
      }
      try {
        const outcome = await submitPrivilegedCategoryApproval(runId, batchId, category, {
          checkedOpIds: Array.isArray(payload?.checkedOpIds) ? payload.checkedOpIds : [],
          requestId: typeof payload?.requestId === 'string' ? payload.requestId : '',
          webauthnProof: payload?.webauthnProof && typeof payload.webauthnProof === 'object'
            ? payload.webauthnProof
            : undefined,
          approvalActor: temporaryControlApprovalActor(authSession, 'approval.privileged.resolve'),
        });
        writeJson(res, outcome.duplicate ? 200 : 202, {
          requestId: outcome.requestId || null,
          duplicate: outcome.duplicate,
          batchId: outcome.batchId,
          category: outcome.category,
          approved: outcome.approved || [],
          denied: outcome.denied || [],
          responseEvent: outcome.responseEvent || null,
          queuedApprovals: outcome.queuedApprovals || [],
          run: outcome.run,
          session: createClientSessionDetail(outcome.session),
        });
      } catch (error) {
        const statusCode =
          error?.code === 'RUN_NOT_FOUND'
          || error?.code === 'SESSION_NOT_FOUND'
          || error?.code === 'PRIVILEGED_BATCH_NOT_FOUND'
            ? 404
            : error?.code === 'RUN_TERMINAL'
              ? 409
              : 400;
        writeJson(res, statusCode, {
          error: error.message || 'Failed to submit privileged approval decision',
          ...(error?.code ? { code: error.code } : {}),
        });
      }
      return true;
    }
    if (parts.length === 8 && parts[0] === 'api' && parts[1] === 'runs'
      && action === 'privileged-batches' && parts[5] === 'categories'
      && parts[7] === 'webauthn-challenge' && runId) {
      let batchId = parts[4] || '';
      let category = parts[6] || '';
      try {
        batchId = decodeURIComponent(batchId);
        category = decodeURIComponent(category);
      } catch {}
      const run = await getRunState(runId);
      if (!run) {
        writeJson(res, 404, { error: 'Run not found' });
        return true;
      }
      if (!await requireSessionAccess(res, authSession, run.sessionId)) return true;
      if (authSession?.role === 'visitor') {
        writeJson(res, 403, { error: 'Access denied' });
        return true;
      }
      let payload = {};
      try {
        const body = await readBody(req, 16 * 1024);
        payload = body ? JSON.parse(body) : {};
      } catch (err) {
        writeJson(res, err.code === 'BODY_TOO_LARGE' ? 413 : 400, { error: err.code === 'BODY_TOO_LARGE' ? 'Request body too large' : 'Bad request' });
        return true;
      }
      try {
        const options = await createPrivilegedCategoryWebAuthnChallenge(runId, batchId, category, {
          checkedOpIds: Array.isArray(payload?.checkedOpIds) ? payload.checkedOpIds : [],
          requestId: typeof payload?.requestId === 'string' ? payload.requestId : '',
          request: req,
        });
        writeJson(res, 200, options);
      } catch (error) {
        const statusCode =
          error?.code === 'RUN_NOT_FOUND'
          || error?.code === 'SESSION_NOT_FOUND'
          || error?.code === 'PRIVILEGED_BATCH_NOT_FOUND'
            ? 404
            : error?.code === 'WEBAUTHN_CREDENTIAL_REQUIRED'
              ? 409
              : 400;
        writeJson(res, statusCode, {
          error: error.message || 'Failed to create WebAuthn challenge',
          ...(error?.code ? { code: error.code } : {}),
        });
      }
      return true;
    }
    if (parts.length === 5 && parts[0] === 'api' && parts[1] === 'runs' && action === 'approvals' && runId) {
      let approvalId = parts[4] || '';
      try {
        approvalId = decodeURIComponent(approvalId);
      } catch {}
      const run = await getRunState(runId);
      if (!run) {
        writeJson(res, 404, { error: 'Run not found' });
        return true;
      }
      if (!await requireSessionAccess(res, authSession, run.sessionId)) return true;
      if (authSession?.role === 'visitor') {
        writeJson(res, 403, { error: 'Access denied' });
        return true;
      }
      let payload = {};
      try {
        const body = await readBody(req, 16 * 1024);
        payload = body ? JSON.parse(body) : {};
      } catch (err) {
        writeJson(res, err.code === 'BODY_TOO_LARGE' ? 413 : 400, { error: err.code === 'BODY_TOO_LARGE' ? 'Request body too large' : 'Bad request' });
        return true;
      }
      try {
        if (payload?.decision === 'approve_with_answers' && (!Array.isArray(payload.customAnswers) || payload.customAnswers.length === 0)) {
          writeJson(res, 400, { error: 'Per-question answers are required' });
          return true;
        }
        if (payload?.decision === 'approve_with_multi_choices' && (!Array.isArray(payload.multiChoices) || !Array.isArray(payload.customAnswers))) {
          writeJson(res, 400, { error: 'Per-question choices and answers are required' });
          return true;
        }
        const outcome = await submitRuntimeApproval(runId, approvalId, {
          // Older servers reject this decision instead of silently discarding
          // per-question answers. Only supported runtimes map it to approval.
          decision: ['approve_with_answers', 'approve_with_multi_choices'].includes(payload?.decision) ? 'approve'
            : (typeof payload?.decision === 'string' ? payload.decision : payload?.action),
          requestId: typeof payload?.requestId === 'string' ? payload.requestId : '',
          choices: Array.isArray(payload?.choices) ? payload.choices : [],
          customAnswer: typeof payload?.customAnswer === 'string' ? payload.customAnswer : '',
          customAnswers: Array.isArray(payload?.customAnswers) ? payload.customAnswers : [],
          ...(payload?.decision === 'approve_with_multi_choices' ? { multiChoices: payload.multiChoices } : {}),
          approvalActor: temporaryControlApprovalActor(authSession, 'approval.resolve'),
        });
        writeJson(res, outcome.duplicate ? 200 : 202, {
          requestId: outcome.requestId || null,
          duplicate: outcome.duplicate,
          approval: outcome.approval || null,
          run: outcome.run,
          session: createClientSessionDetail(outcome.session),
        });
      } catch (error) {
        const statusCode =
          error?.code === 'RUN_NOT_FOUND' || error?.code === 'APPROVAL_NOT_FOUND'
            ? 404
            : error?.code === 'RUN_TERMINAL'
              ? 409
              : 400;
        writeJson(res, statusCode, {
          error: error.message || 'Failed to submit approval decision',
          code: error?.code || '',
        });
      }
      return true;
    }
    if (parts.length === 4 && parts[0] === 'api' && parts[1] === 'runs' && action === 'cancel' && runId) {
      const scoped = Object.hasOwn(req.headers || {}, SESSION_API_SCOPE_HEADER);
      if (scoped) res.setHeader?.('Cache-Control', 'private, no-store');
      if (scoped && (authSession?.role !== 'owner' ||
          (authSession.principalKind && !['owner', 'trusted_device'].includes(authSession.principalKind)))) {
        writeJson(res, 403, { code: 'PERMISSION_DENIED', error: 'Owner conditional access is required' });
        return true;
      }
      // A conditional request must not run reconciliation before its scope is
      // checked. The initial lookup only identifies the exact Run's Session.
      const run = scoped ? await getRun(runId) : await getRunState(runId);
      if (!run) {
        writeJson(res, 404, { error: 'Run not found' });
        return true;
      }
      if (!await requireSessionAccess(res, authSession, run.sessionId, scoped ? { metadataOnly: true } : undefined)) return true;
      try {
        const scope = readSessionApiScopeHeader(req, run.sessionId);
        const cancel = async () => {
          if (scope && run.appApiMessageVersion === 1 && run.appApiMessageQueue) {
            const queued = await cancelQueuedMessageRun(runId);
            if (queued) return { status: 200, body: { run: queued } };
          }
          const updated = await cancelActiveRun(run.sessionId, { expectedRunId: runId, reconcile: !scope });
          if (updated) return { status: 200, body: { run: updated } };
          const refreshed = scope ? await getRun(runId) : await getRunState(runId);
          if (refreshed && refreshed.state !== 'running' && refreshed.state !== 'accepted' && refreshed.state !== 'queued')
            return { status: 200, body: { run: refreshed } };
          return { status: 409, body: { error: 'No active run', code: 'RUN_IDENTITY_CONFLICT' } };
        };
        const result = scope ? await withSessionApiScope(run.sessionId, scope, cancel) : await cancel();
        writeJson(res, result.status, result.body);
      } catch (error) {
        const known = ['INVALID_ARGUMENT', 'RESOURCE_NOT_FOUND', 'REVISION_CONFLICT', 'RUN_IDENTITY_CONFLICT',
          'SESSION_MUTATION_STORE_INVALID', 'SESSION_MUTATION_STORE_UNAVAILABLE'];
        const valid = known.includes(error?.code) && Number.isInteger(error.statusCode);
        writeJson(res, valid ? error.statusCode : 503, { code: valid ? error.code : 'RUN_CANCEL_UNAVAILABLE',
          error: valid ? error.message : 'Run cancellation is unavailable' });
      }
      return true;
    }
  }

  return false;
}
