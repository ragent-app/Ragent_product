// S24 owner-only organization API. Android/Web consume the projection; the
// explicit provisioning command is the only Runtime-owned mutation exposed.
import { createHash } from 'crypto';
import { formalMemberDescriptor, makeMemberRef, parseMemberRef } from './organization-member-reference.mjs';
import { barrierEventFromMember } from './adapters/provider-native-delegation.mjs';
import { capturedMember, listMemberEvents, resolveFormalNodeStagingConversationSession } from './organization-member-aggregation.mjs';
import { access } from 'fs/promises';
import { constants as fsConstants } from 'fs';
import {
  ORG_AUTONOMOUS_PROVISIONING_ENABLED,
  ORG_PROJECTION_V1_ENABLED,
  ORG_PROJECTION_V2_ENABLED,
} from '../lib/config.mjs';
import { readBody as readRequestBody } from '../lib/utils.mjs';
import { buildOrganizationProjection, projectionDigest } from './organization-projection.mjs';
import { attachOrganizationNodeActivities, nativeDelegationActivity } from './organization-node-activity.mjs';
import { createManagedSessionForNode } from './organization-managed-session-factory.mjs';
import { provisionRootLeadershipRevision } from './organization-provisioning.mjs';
import { getOrganization, getOrganizationByRootSession, getNode, listOrganizationNodes, withOrganizationDatabase } from './organization-store.mjs';
import {
  archiveBoardChannel,
  buildAuthoritativeBoardProjection,
  createBoardChannel,
  ensureOrganizationBoardSchema,
  normalizeBoardChannelName,
  postBoardMessage,
} from './organization-board-store.mjs';
import {
  SWARM_WORKSPACE_UNMERGED_CHANGES,
  deliverPendingSwarmWakeups,
  getSwarmStatus,
  killSwarmMember,
  switchSwarmMemberModel,
} from './organization-swarm.mjs';
import {
  completeWorkItemSwarm,
  promoteSwarmWorkspaceToCandidate,
  startWorkItemSwarm,
} from './organization-swarm-factory-bridge.mjs';
import { publishOrganizationInvalidation } from './organization-invalidation.mjs';
import { listOrganizationEvents, getInternalEnvelope } from './organization-messaging.mjs';
import { organizationHasCreatedSubordinate } from './organization-created-subordinate.mjs';
import { verifiedBirthActor } from './organization-birth-evidence.mjs';
import { getCollaboration } from './collaboration-store.mjs';
import { recoverOrganizationDispatchEvents } from './organization-dispatch-event-recovery.mjs';
import { getRun, isTerminalRunState, listDurableSessionRunIndexEntries, readRunSpoolDelta, requestRunCancel, runSpoolPath, runSpoolGzPath, runSpoolZstPath } from './runs.mjs';
import { cancelOrganizationDescendants } from './organization-hierarchy.mjs';
import { readSessionCollaborationSettings, writeSessionCollaborationSettings, readSessionRuntimeConstraints, writeSessionRuntimeConstraints } from './session-collaboration-settings.mjs';

function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function writeError(res, writeJson, error) {
  const code = text(error?.code);
  const status = code === 'ORGANIZATION_NOT_FOUND' ? 404 : error?.statusCode || 400;
  const extra = code === SWARM_WORKSPACE_UNMERGED_CHANGES
    ? {
      workspaceMode: error.workspaceMode || 'inherit',
      workspacePath: error.workspacePath || '',
      workspaceBranch: error.workspaceBranch || '',
      dirtyFiles: Array.isArray(error.dirtyFiles) ? error.dirtyFiles : [],
      unmergedCommits: Number(error.unmergedCommits || 0),
    }
    : {};
  writeJson(res, status, { error: error?.message || 'Organization request failed', ...(code ? { code } : {}), ...extra });
}

function requireOwnerOnlyAccess(authSession, res, writeJson) {
  if (authSession?.role !== 'owner' || authSession?.principalKind === 'run_capability') {
    writeJson(res, 403, { error: 'Owner access required' });
    return false;
  }
  return true;
}

async function resolveSessionMeta(sessionMetaLookup, sessionId) {
  if (typeof sessionMetaLookup === 'function') return sessionMetaLookup(sessionId);
  const { getSessionMeta } = await import('./session-manager.mjs');
  return getSessionMeta(sessionId);
}

async function parseJsonRequestBody(req, readBody, res, writeJson, maxBytes = 32 * 1024) {
  try {
    const rawBody = await readBody(req, maxBytes);
    const parsed = rawBody ? JSON.parse(rawBody) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      writeJson(res, 400, { error: 'JSON object body required', code: 'BAD_REQUEST' });
      return null;
    }
    return parsed;
  } catch (error) {
    writeJson(res, error?.code === 'BODY_TOO_LARGE' ? 413 : 400, { error: 'Invalid JSON body' });
    return null;
  }
}

async function defaultSwarmRuntimeDeps() {
  const { sendMessage, getSessionMeta, createSession } = await import('./session-manager.mjs');
  return {
    createSession,
    deliverSessionMessage: sendMessage,
    sendMessage,
    getSession: getSessionMeta,
    getRunState: async (memberSessionId) => {
      const meta = await getSessionMeta(memberSessionId).catch(() => null);
      const activeRunId = text(meta?.activeRunId);
      if (!activeRunId) return { running: false, activeRunId: '' };
      const run = await getRun(activeRunId).catch(() => null);
      const running = Boolean(run && !isTerminalRunState(run.state));
      return { running, runId: activeRunId, activeRunId, state: text(run?.state) };
    },
    requestRunCancel: (runId) => requestRunCancel(runId),
  };
}

async function hasAuthoritativeSwarmBoard(org) {
  if (!org?.id) return false;
  if (org.policy?.swarmEnabled === true || org.policy?.mode === 'ragent_swarm') return true;
  return withOrganizationDatabase((conn) => {
    ensureOrganizationBoardSchema(conn);
    const hasChannel = conn.prepare('SELECT 1 FROM organization_board_channels WHERE organization_id = ? LIMIT 1').get(org.id);
    if (hasChannel) return true;
    const hasMsg = conn.prepare('SELECT 1 FROM organization_board_messages WHERE organization_id = ? LIMIT 1').get(org.id);
    return Boolean(hasMsg);
  });
}

function normalizeNativeBoardFallback(rawNativeBoard, { channel = '', sinceSeq = 0, limit = 0 } = {}) {
  if (!rawNativeBoard || typeof rawNativeBoard !== 'object') return null;
  let messages = Array.isArray(rawNativeBoard.messages) ? [...rawNativeBoard.messages] : [];
  const normalizedChannel = normalizeBoardChannelName(channel, { allowEmpty: true });
  if (normalizedChannel) {
    messages = messages.filter((msg) => normalizeBoardChannelName(msg?.channel || 'main') === normalizedChannel);
  }
  if (sinceSeq > 0) {
    messages = messages.filter((msg) => Number(msg?.seq || 0) > sinceSeq);
  }
  if (limit > 0 && messages.length > limit) {
    messages = sinceSeq > 0 ? messages.slice(0, limit) : messages.slice(-limit);
  }
  return {
    ...rawNativeBoard,
    mode: 'provider_native',
    source: text(rawNativeBoard.source) || 'provider_native',
    readOnly: true,
    messages,
  };
}


const TERMINAL_MEMBER_STATES = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'lost']);

function memberActivityState(state) {
  return ['spawned', 'running'].includes(state) ? 'working' : state === 'waiting' ? 'waiting' :
    state === 'failed' ? 'failed' : ['completed', 'cancelled', 'interrupted'].includes(state) ? 'idle' : 'unknown';
}

async function projectHarnessMembers(rootSessionId, rootMember = null, listMembers = listMemberEvents) {
  const memberEvents = await listMembers(rootSessionId);
  const rootCanonicalId = rootMember || `root:${rootSessionId}`;
  const latestByMember = new Map();
  const births = new Map();
  const aliasesByMember = new Map();
  for (const event of memberEvents.events) {
    const old = latestByMember.get(event.memberId);
    const aliases = aliasesByMember.get(event.memberId) || new Map();
    for (const alias of event.aliases || []) {
      if (alias.kind === 'legacy_delegation' && alias.runId && alias.id) aliases.set(`${alias.runId}\0${alias.id}`, alias);
    }
    aliasesByMember.set(event.memberId, aliases);
    if (event.phase === 'confirmed' && !births.has(event.memberId)) births.set(event.memberId, event);
    if (!old && event.phase === 'confirmed') latestByMember.set(event.memberId, event);
    else if (old && (event.runId !== old.runId || (event.seq || 0) >= (old.seq || 0))) {
      if (event.runId === old.runId && TERMINAL_MEMBER_STATES.has(old.state) && !TERMINAL_MEMBER_STATES.has(event.state)) {
        continue;
      }
      latestByMember.set(event.memberId, event.parent?.kind === 'unknown' ? { ...event, parent: old.parent } : event);
    }
  }
  const members = [...latestByMember.values()].map((event) => {
    const parent = event.parent?.kind === 'member' ? event.parent.id : event.parent?.kind === 'root_session' && event.parent.id === rootSessionId ? rootCanonicalId : null;
    const birth = births.get(event.memberId);
    const actor = birth?.actor?.kind === 'member' ? birth.actor.id :
      birth?.actor?.kind === 'root_session' && birth.actor.id === rootSessionId ? rootCanonicalId : null;
    const state = memberActivityState(event.state);
    return {
      canonicalId: event.memberId,
      sourceTag: event.sourceTag || null,
      executionHarnessId: event.executionHarnessId || null,
      ...(event.displayName ? { displayName: event.displayName } : {}),
      ...(event.role ? { role: event.role } : {}),
      ...(event.model ? { model: event.model } : {}),
      controlCapabilities: event.controlCapabilities || { readOnly: true, canControlMember: false, canMessageMember: false },
      parentCanonicalId: parent || null,
      relationKnown: Boolean(parent),
      aliases: [...(aliasesByMember.get(event.memberId)?.values() || [])],
      birth: birth && actor ? { id: birth.id, actorCanonicalId: actor, operationId: birth.operationId || null, timestamp: birth.timestamp || null } : null,
      activity: { state, kind: null, actionRequired: false, runId: event.runId, sourceSeq: event.seq ?? null },
      conversation: {
        ref: makeMemberRef({ kind: 'member', root: rootSessionId, id: event.memberId, runId: event.runId, generation: event._generation }),
        generation: event._generation,
        scope: 'activity_only',
      },
    };
  });
  return {
    rootCanonicalId,
    members,
    membersComplete: false,
    sourceCoverage: { harness: memberEvents.availability, gap: memberEvents.gap },
    ...(memberEvents.board ? { board: memberEvents.board, channels: memberEvents.channels || memberEvents.board.channels || [] } : {}),
  };
}

export async function handleOrganizationRoutes({
  req,
  res,
  pathname,
  authSession,
  writeJson,
  readBody = readRequestBody,
  cancelDescendants = cancelOrganizationDescendants,
  provisionRevision = provisionRootLeadershipRevision,
  managedSessionFactory = createManagedSessionForNode,
  dispatchPhase = null,
  listMembers = listMemberEvents,
  readCapturedMember = capturedMember,
  sessionMetaLookup = null,
  swarmDeps = null,
}) {
  const organizationMatch = /^\/api\/organizations\/([^/]+)(?:\/(projection|cancel|provision))?$/.exec(String(pathname || ''));
  const conversationMatch = /^\/api\/organizations\/([^/]+)\/nodes\/([^/]+)\/conversation$/.exec(String(pathname || ''));
  const phaseDispatchMatch = /^\/api\/organizations\/([^/]+)\/phases\/([^/]+)\/dispatch$/.exec(String(pathname || ''));
  const rootSessionMatch = /^\/api\/sessions\/([^/]+)\/organization\/projection$/.exec(String(pathname || ''));
  const collaborationSettingsMatch = /^\/api\/sessions\/([^/]+)\/collaboration-policy$/.exec(String(pathname || ''));
  const runtimeConstraintsMatch = /^\/api\/sessions\/([^/]+)\/organization\/runtime-constraints$/.exec(String(pathname || ''));
  const actionsMatch = /^\/api\/sessions\/([^/]+)\/organization\/actions$/.exec(String(pathname || ''));
  const membersMatch = /^\/api\/sessions\/([^/]+)\/organization\/members$/.exec(String(pathname || ''));
  const boardMatch = /^\/api\/sessions\/([^/]+)\/organization\/board$/.exec(String(pathname || ''));
  const boardMessagesMatch = /^\/api\/sessions\/([^/]+)\/organization\/board\/messages$/.exec(String(pathname || ''));
  const swarmStatusMatch = /^\/api\/sessions\/([^/]+)\/organization\/swarm\/status$/.exec(String(pathname || ''));
  const swarmChannelsMatch = /^\/api\/sessions\/([^/]+)\/organization\/swarm\/channels$/.exec(String(pathname || ''));
  const swarmKillMatch = /^\/api\/sessions\/([^/]+)\/organization\/swarm\/kill$/.exec(String(pathname || ''));
  const swarmModelMatch = /^\/api\/sessions\/([^/]+)\/organization\/swarm\/model$/.exec(String(pathname || ''));
  const swarmPromoteMatch = /^\/api\/sessions\/([^/]+)\/organization\/swarm\/promote-candidate$/.exec(String(pathname || ''));
  const swarmWorkItemStartMatch = /^\/api\/sessions\/([^/]+)\/organization\/swarm\/work-items\/([^/]+)\/start$/.exec(String(pathname || ''));
  const swarmWorkItemCompleteMatch = /^\/api\/sessions\/([^/]+)\/organization\/swarm\/work-items\/([^/]+)\/complete$/.exec(String(pathname || ''));
  const memberConversationMatch = /^\/api\/sessions\/([^/]+)\/organization\/members\/([^/]+)\/conversation$/.exec(String(pathname || ''));
  const nativeMatch = /^\/api\/sessions\/([^/]+)\/delegation-runs(?:\/([^/]+)\/events)?$/.exec(String(pathname || ''));
  if (!organizationMatch && !phaseDispatchMatch && !rootSessionMatch && !conversationMatch && !actionsMatch && !nativeMatch && !memberConversationMatch && !membersMatch && !boardMatch && !boardMessagesMatch && !swarmStatusMatch && !swarmChannelsMatch && !swarmKillMatch && !swarmModelMatch && !swarmPromoteMatch && !swarmWorkItemStartMatch && !swarmWorkItemCompleteMatch && !collaborationSettingsMatch && !runtimeConstraintsMatch) return false;
  if (runtimeConstraintsMatch) {
    if (authSession?.role !== 'owner' || authSession?.principalKind === 'run_capability') { writeJson(res, 403, { error: 'Owner access required' }); return true; }
    if (!['GET', 'PUT'].includes(req.method)) { writeJson(res, 405, { error: 'Method not allowed' }); return true; }
    try {
      const sessionId = decodeURIComponent(runtimeConstraintsMatch[1]);
      const result = req.method === 'GET' ? await readSessionRuntimeConstraints(sessionId)
        : await writeSessionRuntimeConstraints(sessionId, JSON.parse((await readBody(req, 16 * 1024)) || '{}'));
      res.setHeader?.('Cache-Control', 'private, no-store');
      writeJson(res, 200, result);
    } catch (error) { writeError(res, writeJson, error); }
    return true;
  }
  if (collaborationSettingsMatch) {
    if (authSession?.role !== 'owner') { writeJson(res, 403, { error: 'Owner access required' }); return true; }
    if (!['GET', 'PUT', 'DELETE'].includes(req.method)) { writeJson(res, 405, { error: 'Method not allowed' }); return true; }
    try {
      const sessionId = decodeURIComponent(collaborationSettingsMatch[1]);
      let result;
      if (req.method === 'GET') result = await readSessionCollaborationSettings(sessionId);
      else if (req.method === 'PUT') {
        const body = JSON.parse((await readBody(req, 16 * 1024)) || '{}');
        result = await writeSessionCollaborationSettings(sessionId, body);
      } else {
        const url = new URL(req.url, `http://${req.headers?.host || 'localhost'}`);
        const raw = url.searchParams.get('expectedRevision');
        result = await writeSessionCollaborationSettings(sessionId, {
          expectedRevision: raw !== null && /^\d+$/.test(raw) ? Number(raw) : NaN, override: null,
        });
      }
      res.setHeader?.('Cache-Control', 'private, no-store');
      writeJson(res, 200, result);
    } catch (error) { writeError(res, writeJson, error); }
    return true;
  }
  if (membersMatch) {
    if (authSession?.role !== 'owner') { writeJson(res, 403, { error: 'Owner access required' }); return true; }
    if (req.method !== 'GET') { writeJson(res, 405, { error: 'Method not allowed' }); return true; }
    try {
      const root = decodeURIComponent(membersMatch[1]);
      const { getSessionMeta } = await import('./session-manager.mjs');
      if (!await getSessionMeta(root)) { writeJson(res, 404, { error: 'Session not found' }); return true; }
      const org = await getOrganizationByRootSession(root);
      let rootMember = null;
      if (org) {
        const nodes = await listOrganizationNodes(org.id);
        const candidates = nodes.filter((node) => node.currentSessionId === root);
        if (candidates.length === 1) rootMember = `formal:${candidates[0].id}`;
      }
      res.setHeader?.('Cache-Control', 'private, no-store');
      writeJson(res, 200, { rootSessionId: root, ...(await projectHarnessMembers(root, rootMember, listMembers)) });
    } catch (error) { writeError(res, writeJson, error); }
    return true;
  }
  if (boardMatch) {
    if (!requireOwnerOnlyAccess(authSession, res, writeJson)) return true;
    if (req.method !== 'GET') { writeJson(res, 405, { error: 'Method not allowed' }); return true; }
    try {
      const root = decodeURIComponent(boardMatch[1]);
      if (!await resolveSessionMeta(sessionMetaLookup, root)) { writeJson(res, 404, { error: 'Session not found' }); return true; }
      const url = new URL(req.url || pathname, `http://${req.headers?.host || 'localhost'}`);
      const channel = text(url.searchParams.get('channel'));
      const rawSince = url.searchParams.get('sinceSeq');
      const rawLimit = url.searchParams.get('limit');
      const sinceSeq = rawSince !== null && rawSince !== '' ? Number(rawSince) : 0;
      const limit = rawLimit !== null && rawLimit !== '' ? Number(rawLimit) : 100;
      const hasLimitQuery = rawLimit !== null && rawLimit !== '';
      if (!Number.isSafeInteger(sinceSeq) || sinceSeq < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200) {
        writeJson(res, 400, { error: 'Invalid board query cursor or limit', code: 'BAD_REQUEST' });
        return true;
      }
      const includeArchived = url.searchParams.get('includeArchived') === '1' || url.searchParams.get('includeArchived') === 'true';
      const org = await getOrganizationByRootSession(root);
      const authoritativeExists = await hasAuthoritativeSwarmBoard(org);
      const memberEvents = authoritativeExists
        ? await listMembers(root).catch(() => ({ availability: 'unknown', gap: false, board: null, channels: [] }))
        : await listMembers(root);
      const nativeBoard = normalizeNativeBoardFallback(memberEvents?.board || null, {
        channel,
        sinceSeq,
        limit: hasLimitQuery ? limit : 0,
      });
      res.setHeader?.('Cache-Control', 'private, no-store');
      if (authoritativeExists) {
        const authoritativeBoard = await buildAuthoritativeBoardProjection({
          organizationId: org.id,
          channel,
          sinceSeq,
          limit,
          includeArchived,
        });
        writeJson(res, 200, {
          rootSessionId: root,
          organizationId: org.id,
          mode: 'ragent_swarm',
          readOnly: false,
          board: authoritativeBoard,
          channels: authoritativeBoard.channels,
          nativeBoard,
          sourceCoverage: { harness: memberEvents?.availability || 'unknown', gap: Boolean(memberEvents?.gap) },
        });
        return true;
      }
      if (nativeBoard) {
        const nativeChannels = memberEvents?.channels || nativeBoard.channels || [];
        writeJson(res, 200, {
          rootSessionId: root,
          organizationId: org?.id || null,
          mode: 'provider_native',
          readOnly: true,
          board: nativeBoard,
          channels: nativeChannels,
          nativeBoard,
          sourceCoverage: { harness: memberEvents?.availability || 'unknown', gap: Boolean(memberEvents?.gap) },
        });
        return true;
      }
      writeJson(res, 200, {
        rootSessionId: root,
        organizationId: org?.id || null,
        mode: null,
        readOnly: true,
        board: null,
        channels: [],
        nativeBoard: null,
        sourceCoverage: { harness: memberEvents?.availability || 'unknown', gap: Boolean(memberEvents?.gap) },
      });
    } catch (error) { writeError(res, writeJson, error); }
    return true;
  }
  if (boardMessagesMatch) {
    if (!requireOwnerOnlyAccess(authSession, res, writeJson)) return true;
    if (req.method !== 'POST') { writeJson(res, 405, { error: 'Method not allowed' }); return true; }
    try {
      const root = decodeURIComponent(boardMessagesMatch[1]);
      if (!await resolveSessionMeta(sessionMetaLookup, root)) { writeJson(res, 404, { error: 'Session not found' }); return true; }
      const body = await parseJsonRequestBody(req, readBody, res, writeJson, 32 * 1024);
      if (!body) return true;
      const org = await getOrganizationByRootSession(root);
      if (!org) { writeJson(res, 404, { error: 'Organization not found', code: 'ORGANIZATION_NOT_FOUND' }); return true; }
      if (org.state === 'archived') { writeJson(res, 409, { error: `Organization ${org.id} is archived`, code: 'ORG_ARCHIVED' }); return true; }
      const postResult = await postBoardMessage({
        organizationId: org.id,
        channel: body.channel ?? body.channelName ?? 'main',
        senderKind: 'owner',
        senderNodeId: '',
        senderName: text(body.senderName) || text(authSession?.displayName) || text(authSession?.user) || 'owner',
        bodyMarkdown: body.bodyMarkdown ?? body.text ?? body.body,
        replyToSeq: Number.isInteger(body.replyToSeq) ? body.replyToSeq : null,
        artifactRefs: Array.isArray(body.artifactRefs) ? body.artifactRefs : [],
        kind: text(body.kind) || 'message',
        mentions: Array.isArray(body.mentions) ? body.mentions : [],
        idempotencyKey: text(body.idempotencyKey),
        autoCreateChannel: body.autoCreateChannel === true,
      });
      let wakeupsDelivery = null;
      if (Array.isArray(postResult.wakeups) && postResult.wakeups.length > 0) {
        const deps = swarmDeps !== null ? swarmDeps : await defaultSwarmRuntimeDeps();
        if (typeof deps?.deliverSessionMessage === 'function' || typeof deps?.sendMessage === 'function') {
          wakeupsDelivery = await deliverPendingSwarmWakeups(deps, { organizationId: org.id });
        }
      }
      publishOrganizationInvalidation({ organizationId: org.id });
      res.setHeader?.('Cache-Control', 'private, no-store');
      writeJson(res, postResult.replay ? 200 : 201, {
        rootSessionId: root,
        organizationId: org.id,
        ...postResult,
        ...(wakeupsDelivery ? { wakeupsDelivery } : {}),
      });
    } catch (error) { writeError(res, writeJson, error); }
    return true;
  }
  if (swarmStatusMatch) {
    if (!requireOwnerOnlyAccess(authSession, res, writeJson)) return true;
    if (req.method !== 'GET') { writeJson(res, 405, { error: 'Method not allowed' }); return true; }
    try {
      const root = decodeURIComponent(swarmStatusMatch[1]);
      if (!await resolveSessionMeta(sessionMetaLookup, root)) { writeJson(res, 404, { error: 'Session not found' }); return true; }
      const org = await getOrganizationByRootSession(root);
      if (!org) { writeJson(res, 404, { error: 'Organization not found', code: 'ORGANIZATION_NOT_FOUND' }); return true; }
      const url = new URL(req.url || pathname, `http://${req.headers?.host || 'localhost'}`);
      const includeKilled = url.searchParams.get('includeKilled') === '1' || url.searchParams.get('includeKilled') === 'true';
      const status = await getSwarmStatus({ organizationId: org.id, includeKilled });
      res.setHeader?.('Cache-Control', 'private, no-store');
      writeJson(res, 200, {
        rootSessionId: root,
        mode: (org.policy?.swarmEnabled === true || org.policy?.mode === 'ragent_swarm') ? 'ragent_swarm' : 'formal_org',
        ...status,
      });
    } catch (error) { writeError(res, writeJson, error); }
    return true;
  }
  if (swarmChannelsMatch) {
    if (!requireOwnerOnlyAccess(authSession, res, writeJson)) return true;
    if (req.method !== 'POST') { writeJson(res, 405, { error: 'Method not allowed' }); return true; }
    try {
      const root = decodeURIComponent(swarmChannelsMatch[1]);
      if (!await resolveSessionMeta(sessionMetaLookup, root)) { writeJson(res, 404, { error: 'Session not found' }); return true; }
      const body = await parseJsonRequestBody(req, readBody, res, writeJson, 16 * 1024);
      if (!body) return true;
      const org = await getOrganizationByRootSession(root);
      if (!org) { writeJson(res, 404, { error: 'Organization not found', code: 'ORGANIZATION_NOT_FOUND' }); return true; }
      if (org.state === 'archived') { writeJson(res, 409, { error: `Organization ${org.id} is archived`, code: 'ORG_ARCHIVED' }); return true; }
      const action = text(body.action || (body.archived === true ? 'archive' : 'create')).toLowerCase();
      res.setHeader?.('Cache-Control', 'private, no-store');
      if (action === 'create') {
        const channel = await createBoardChannel({
          organizationId: org.id,
          name: body.name ?? body.channel ?? body.channelName,
          topic: body.topic,
          visibility: body.visibility,
        });
        publishOrganizationInvalidation({ organizationId: org.id });
        writeJson(res, 201, { rootSessionId: root, organizationId: org.id, action: 'create', channel });
        return true;
      }
      if (action === 'archive') {
        const channel = await archiveBoardChannel({
          organizationId: org.id,
          name: body.name ?? body.channel ?? body.channelName,
        });
        publishOrganizationInvalidation({ organizationId: org.id });
        writeJson(res, 200, { rootSessionId: root, organizationId: org.id, action: 'archive', channel });
        return true;
      }
      writeJson(res, 400, { error: 'Channel action must be create or archive', code: 'BAD_REQUEST' });
    } catch (error) { writeError(res, writeJson, error); }
    return true;
  }
  if (swarmKillMatch) {
    if (!requireOwnerOnlyAccess(authSession, res, writeJson)) return true;
    if (req.method !== 'POST') { writeJson(res, 405, { error: 'Method not allowed' }); return true; }
    try {
      const root = decodeURIComponent(swarmKillMatch[1]);
      if (!await resolveSessionMeta(sessionMetaLookup, root)) { writeJson(res, 404, { error: 'Session not found' }); return true; }
      const body = await parseJsonRequestBody(req, readBody, res, writeJson, 16 * 1024);
      if (!body) return true;
      const org = await getOrganizationByRootSession(root);
      if (!org) { writeJson(res, 404, { error: 'Organization not found', code: 'ORGANIZATION_NOT_FOUND' }); return true; }
      const targetNameOrNodeId = text(body.targetNameOrNodeId || body.targetNodeId || body.nodeId || body.name);
      if (!targetNameOrNodeId) { writeJson(res, 400, { error: 'targetNameOrNodeId is required', code: 'BAD_REQUEST' }); return true; }
      const deps = swarmDeps !== null ? swarmDeps : await defaultSwarmRuntimeDeps();
      const result = await killSwarmMember(deps, {
        organizationId: org.id,
        targetNameOrNodeId,
        forceDiscard: body.forceDiscard === true,
        projectRoot: text(body.projectRoot),
      });
      publishOrganizationInvalidation({ organizationId: org.id });
      res.setHeader?.('Cache-Control', 'private, no-store');
      writeJson(res, 200, { rootSessionId: root, organizationId: org.id, ...result });
    } catch (error) { writeError(res, writeJson, error); }
    return true;
  }
  if (swarmModelMatch) {
    if (!requireOwnerOnlyAccess(authSession, res, writeJson)) return true;
    if (req.method !== 'POST') { writeJson(res, 405, { error: 'Method not allowed' }); return true; }
    try {
      const root = decodeURIComponent(swarmModelMatch[1]);
      const rootMeta = await resolveSessionMeta(sessionMetaLookup, root);
      if (!rootMeta) { writeJson(res, 404, { error: 'Session not found' }); return true; }
      const body = await parseJsonRequestBody(req, readBody, res, writeJson, 16 * 1024);
      if (!body) return true;
      const org = await getOrganizationByRootSession(root);
      if (!org) { writeJson(res, 404, { error: 'Organization not found', code: 'ORGANIZATION_NOT_FOUND' }); return true; }
      const targetNameOrNodeId = text(body.targetNameOrNodeId || body.targetNodeId || body.nodeId || body.name);
      if (!targetNameOrNodeId) { writeJson(res, 400, { error: 'targetNameOrNodeId is required', code: 'BAD_REQUEST' }); return true; }
      const authoritativeRoot = text(org.policy?.projectRoot || org.policy?.workspaceScope || rootMeta?.folder);
      const deps = swarmDeps !== null ? swarmDeps : await defaultSwarmRuntimeDeps();
      const result = await switchSwarmMemberModel(deps, {
        organizationId: org.id,
        targetNameOrNodeId,
        harness: text(body.harness ?? body.tool),
        provider: text(body.provider ?? body.providerProfile),
        model: text(body.model),
        effort: text(body.effort),
        reason: text(body.reason),
        handoffNotes: text(body.handoffNotes),
        expectedBindingGeneration: body.expectedBindingGeneration !== undefined ? Number(body.expectedBindingGeneration) : null,
        workItemId: text(body.workItemId),
        projectRoot: authoritativeRoot,
        postToBoard: body.postToBoard === true,
        wakeNow: body.wakeNow === true,
        idempotencyKey: text(body.idempotencyKey) || text(req.headers?.['idempotency-key']),
      });
      publishOrganizationInvalidation({ organizationId: org.id });
      res.setHeader?.('Cache-Control', 'private, no-store');
      writeJson(res, 200, { rootSessionId: root, ...result });
    } catch (error) { writeError(res, writeJson, error); }
    return true;
  }
  if (swarmPromoteMatch) {
    if (!requireOwnerOnlyAccess(authSession, res, writeJson)) return true;
    if (req.method !== 'POST') { writeJson(res, 405, { error: 'Method not allowed' }); return true; }
    try {
      const root = decodeURIComponent(swarmPromoteMatch[1]);
      const rootMeta = await resolveSessionMeta(sessionMetaLookup, root);
      if (!rootMeta) { writeJson(res, 404, { error: 'Session not found' }); return true; }
      const body = await parseJsonRequestBody(req, readBody, res, writeJson, 32 * 1024);
      if (!body) return true;
      const org = await getOrganizationByRootSession(root);
      if (!org) { writeJson(res, 404, { error: 'Organization not found', code: 'ORGANIZATION_NOT_FOUND' }); return true; }
      const targetNameOrNodeId = text(body.targetNameOrNodeId || body.targetNodeId || body.nodeId || body.name);
      if (!targetNameOrNodeId) { writeJson(res, 400, { error: 'targetNameOrNodeId is required', code: 'BAD_REQUEST' }); return true; }
      const authoritativeRoot = text(org.policy?.projectRoot || org.policy?.workspaceScope || rootMeta?.folder);
      const deps = swarmDeps !== null ? swarmDeps : await defaultSwarmRuntimeDeps();
      const result = await promoteSwarmWorkspaceToCandidate(deps, {
        organizationId: org.id,
        targetNameOrNodeId,
        goalId: text(body.goalId),
        workItemId: text(body.workItemId),
        title: text(body.title),
        objective: text(body.objective),
        criterionId: text(body.criterionId) || 'manual_review',
        criterionTitle: text(body.criterionTitle) || 'Verified isolated Swarm workspace deliverable',
        writablePaths: Array.isArray(body.writablePaths) ? body.writablePaths : null,
        targetBranch: text(body.targetBranch),
        runId: text(body.runId),
        summary: text(body.summary),
        projectRoot: authoritativeRoot,
        postToBoard: body.postToBoard !== false,
        idempotencyKey: text(body.idempotencyKey) || text(req.headers?.['idempotency-key']),
        actor: { kind: 'user', role: 'owner', principalId: text(authSession?.user || authSession?.principalId || 'owner') },
      });
      publishOrganizationInvalidation({ organizationId: org.id });
      res.setHeader?.('Cache-Control', 'private, no-store');
      writeJson(res, 200, { rootSessionId: root, ...result });
    } catch (error) { writeError(res, writeJson, error); }
    return true;
  }
  if (swarmWorkItemStartMatch) {
    if (!requireOwnerOnlyAccess(authSession, res, writeJson)) return true;
    if (req.method !== 'POST') { writeJson(res, 405, { error: 'Method not allowed' }); return true; }
    try {
      const root = decodeURIComponent(swarmWorkItemStartMatch[1]);
      const workItemId = decodeURIComponent(swarmWorkItemStartMatch[2]);
      const rootMeta = await resolveSessionMeta(sessionMetaLookup, root);
      if (!rootMeta) { writeJson(res, 404, { error: 'Session not found' }); return true; }
      const body = await parseJsonRequestBody(req, readBody, res, writeJson, 32 * 1024);
      if (!body) return true;
      const org = await getOrganizationByRootSession(root);
      if (!org) { writeJson(res, 404, { error: 'Organization not found', code: 'ORGANIZATION_NOT_FOUND' }); return true; }
      const authoritativeRoot = text(org.policy?.projectRoot || org.policy?.workspaceScope || rootMeta?.folder);
      const deps = swarmDeps !== null ? swarmDeps : await defaultSwarmRuntimeDeps();
      const result = await startWorkItemSwarm(deps, {
        organizationId: org.id,
        workItemId,
        actorNodeId: text(body.actorNodeId),
        actorSessionId: text(body.actorSessionId) || root,
        members: Array.isArray(body.members) ? body.members : [],
        brief: text(body.brief),
        channels: Array.isArray(body.channels) ? body.channels : [],
        projectRoot: authoritativeRoot,
        deferDelivery: body.deferDelivery === true,
        idempotencyKey: text(body.idempotencyKey) || text(req.headers?.['idempotency-key']),
        actor: { kind: 'user', role: 'owner', principalId: text(authSession?.user || authSession?.principalId || 'owner') },
      });
      publishOrganizationInvalidation({ organizationId: org.id });
      res.setHeader?.('Cache-Control', 'private, no-store');
      writeJson(res, 200, { rootSessionId: root, ...result });
    } catch (error) { writeError(res, writeJson, error); }
    return true;
  }
  if (swarmWorkItemCompleteMatch) {
    if (!requireOwnerOnlyAccess(authSession, res, writeJson)) return true;
    if (req.method !== 'POST') { writeJson(res, 405, { error: 'Method not allowed' }); return true; }
    try {
      const root = decodeURIComponent(swarmWorkItemCompleteMatch[1]);
      const workItemId = decodeURIComponent(swarmWorkItemCompleteMatch[2]);
      const rootMeta = await resolveSessionMeta(sessionMetaLookup, root);
      if (!rootMeta) { writeJson(res, 404, { error: 'Session not found' }); return true; }
      const body = await parseJsonRequestBody(req, readBody, res, writeJson, 32 * 1024);
      if (!body) return true;
      const org = await getOrganizationByRootSession(root);
      if (!org) { writeJson(res, 404, { error: 'Organization not found', code: 'ORGANIZATION_NOT_FOUND' }); return true; }
      const authoritativeRoot = text(org.policy?.projectRoot || org.policy?.workspaceScope || rootMeta?.folder);
      const deps = swarmDeps !== null ? swarmDeps : await defaultSwarmRuntimeDeps();
      const result = await completeWorkItemSwarm(deps, {
        organizationId: org.id,
        workItemId,
        actorNodeId: text(body.actorNodeId),
        summary: text(body.summary),
        runId: text(body.runId),
        boardSeqFrom: Number.isInteger(body.boardSeqFrom) ? body.boardSeqFrom : 0,
        boardSeqTo: Number.isInteger(body.boardSeqTo) ? body.boardSeqTo : null,
        evidenceRefs: Array.isArray(body.evidenceRefs) ? body.evidenceRefs : [],
        tests: Array.isArray(body.tests) ? body.tests : [],
        projectRoot: authoritativeRoot,
        forceDiscard: body.forceDiscard === true,
        markDone: body.markDone === true,
        actor: { kind: 'user', role: 'owner', principalId: text(authSession?.user || authSession?.principalId || 'owner') },
      });
      publishOrganizationInvalidation({ organizationId: org.id });
      res.setHeader?.('Cache-Control', 'private, no-store');
      writeJson(res, 200, { rootSessionId: root, ...result });
    } catch (error) { writeError(res, writeJson, error); }
    return true;
  }
  if (memberConversationMatch) {
    if (authSession?.role !== 'owner') { writeJson(res, 403, { error: 'Owner access required' }); return true; }
    if (req.method !== 'GET') { writeJson(res, 405, { error: 'Method not allowed' }); return true; }
    try {
      const root = decodeURIComponent(memberConversationMatch[1]);
      const ref = parseMemberRef(memberConversationMatch[2]);
      if (!ref || ref.root !== root) { writeJson(res, 404, { error: 'Member not found' }); return true; }
      const url = new URL(req.url, `http://${req.headers?.host || 'localhost'}`);
      const beforeSeq = Number(url.searchParams.get('beforeSeq') || 0);
      const afterSeq = Number(url.searchParams.get('afterSeq') || 0);
      const limit = Number(url.searchParams.get('limit') || 50);
      if (![beforeSeq, afterSeq].every((n) => Number.isSafeInteger(n) && n >= 0) || (beforeSeq && afterSeq) ||
          !Number.isInteger(limit) || limit < 1 || limit > 200) { writeJson(res, 400, { error: 'Invalid cursor' }); return true; }
      res.setHeader?.('Cache-Control', 'private, no-store');
      if (ref.kind === 'formal') {
        const org = await getOrganizationByRootSession(root);
        const node = await getNode(ref.id);
        if (!org || !node || node.organizationId !== org.id || node.retiredRevision !== null ||
            ['retired', 'deleted'].includes(String(node.lifecycleState || '').toLowerCase())) {
          writeJson(res, 404, { error: 'Member not found' }); return true;
        }
        if (node.bindingGeneration !== ref.generation) {
          writeJson(res, 409, { code: 'ORGANIZATION_BINDING_CHANGED', reset: true }); return true;
        }
        if (!node.currentSessionId) {
          writeJson(res, 200, { scope: 'unavailable', generation: ref.generation, revision: null, entries: [],
            nextBeforeSeq: null, nextAfterSeq: null, hasMoreBefore: false, hasMoreAfter: false }); return true;
        }
        const { getSessionTimelinePage, getSessionReadSnapshot } = await import('./session-manager.mjs');
        const first = await getSessionReadSnapshot(node.currentSessionId);
        let targetSessionId = node.currentSessionId;
        let targetFirst = first;
        if (!first || Number(first.historyMeta?.latestSeq || 0) === 0) {
          const stagingConversation = await resolveFormalNodeStagingConversationSession({
            organizationId: org.id,
            rootSessionId: org.rootSessionId,
            node,
            getSessionReadSnapshotFn: getSessionReadSnapshot,
          });
          if (stagingConversation?.sessionId && (stagingConversation.hasEntries || !first)) {
            targetSessionId = stagingConversation.sessionId;
            targetFirst = stagingConversation.snapshot;
          }
        }
        if (!targetFirst) { writeJson(res, 200, { scope: 'unavailable', generation: ref.generation, revision: null, entries: [], nextBeforeSeq: null, nextAfterSeq: null, hasMoreBefore: false, hasMoreAfter: false }); return true; }
        const page = await getSessionTimelinePage(targetSessionId, { beforeSeq, afterSeq, limit, strict: true,
          historyMeta: targetFirst.historyMeta, sessionMeta: targetFirst.sessionMeta, run: targetFirst.run });
        const [current, last] = await Promise.all([getNode(ref.id), getSessionReadSnapshot(targetSessionId)]);
        if (!current || current.organizationId !== org.id || current.bindingGeneration !== ref.generation || current.currentSessionId !== node.currentSessionId) {
          writeJson(res, 409, { code: 'ORGANIZATION_BINDING_CHANGED', reset: true }); return true;
        }
        const revision = targetFirst.historyMeta?.historyRevision ?? null;
        if (!last || (last.historyMeta?.latestSeq ?? 0) < (targetFirst.historyMeta?.latestSeq ?? 0)) {
          writeJson(res, 409, { code: 'MEMBER_HISTORY_CHANGED', reset: true }); return true;
        }
        const pagination = page.pagination || {};
        writeJson(res, 200, { scope: 'full', generation: ref.generation, revision, reset: false, gap: null,
          oldestSeq: pagination.oldestSeq ?? null, latestSeq: pagination.totalLatestSeq ?? null, entries: page.events || [],
          nextBeforeSeq: pagination.nextBeforeSeq || null, nextAfterSeq: pagination.latestSeq || afterSeq || null,
          hasMoreBefore: pagination.hasMoreBefore === true, hasMoreAfter: pagination.hasMoreAfter === true });
        return true;
      }
      const memberEvents = await listMembers(root);
      const observed = memberEvents.events.filter((event) => event.memberId === ref.id && event.runId === ref.runId);
      const confirmed = observed.some((event) => event.phase === 'confirmed');
      if (!confirmed) { writeJson(res, 404, { error: 'Member not found' }); return true; }
      const latest = observed.at(-1);
      // External provider references are not authorized Ragent sessions. Only
      // child frames explicitly captured and normalized by the adapter are read.
      const captured = readCapturedMember(root, ref.runId, ref.id);
      if (captured.generation !== ref.generation) { writeJson(res, 409, { code: 'MEMBER_SOURCE_CHANGED', reset: true }); return true; }
      const all = captured.entries || [];
      const matching = all.filter((event) => (!beforeSeq || event.seq < beforeSeq) && (!afterSeq || event.seq > afterSeq));
      const page = afterSeq ? matching.slice(0, limit) : matching.slice(-limit);
      const oldestSeq = all[0]?.seq ?? null;
      const latestSeq = all.at(-1)?.seq ?? null;
      const responseScope = all.length > 0
        ? (captured.scope && captured.scope !== 'unavailable' ? captured.scope : 'captured_only')
        : (captured.scope === 'unavailable' ? 'unavailable' : 'activity_only');
      const responseCoverage = captured.coverage
        || (all.length > 0 ? 'partial' : (responseScope === 'unavailable' ? 'unavailable' : 'activity_only'));
      writeJson(res, 200, { scope: responseScope, coverage: responseCoverage,
        availability: captured.availability, generation: captured.generation, revision: null, reset: false,
        gap: memberEvents.gap || captured.gap, oldestSeq, latestSeq,
        activity: { state: memberActivityState(latest?.state), kind: null, actionRequired: false }, entries: page,
        nextBeforeSeq: page[0]?.seq ?? null, nextAfterSeq: (page.at(-1)?.seq ?? afterSeq) || null,
        hasMoreBefore: !!page.length && page[0].seq > oldestSeq,
        hasMoreAfter: !!page.length && page.at(-1).seq < latestSeq });
    } catch (error) { writeError(res, writeJson, error); }
    return true;
  }
  if (nativeMatch) {
    if (authSession?.role !== 'owner') { writeJson(res, 403, { error: 'Owner access required' }); return true; }
    if (req.method !== 'GET') { writeJson(res, 405, { error: 'Method not allowed' }); return true; }
    try {
      const sessionId = decodeURIComponent(nativeMatch[1]);
      const runs = await listDurableSessionRunIndexEntries(sessionId);
      res.setHeader?.('Cache-Control', 'private, no-store');
      if (!nativeMatch[2]) {
        writeJson(res, 200, { sessionId, runs: runs.map((run) => ({ id: run.id, state: run.state, updatedAt: run.updatedAt || null })) });
        return true;
      }
      const runId = decodeURIComponent(nativeMatch[2]);
      if (!runs.some((run) => run.id === runId && run.sessionId === sessionId)) {
        writeJson(res, 404, { error: 'Run not found' }); return true;
      }
      const url = new URL(req.url, `http://${req.headers?.host || 'localhost'}`);
      const afterLines = Number(url.searchParams.get('afterLines') || 0);
      if (!Number.isSafeInteger(afterLines) || afterLines < 0) { writeJson(res, 400, { error: 'Invalid cursor' }); return true; }
      const readable = (await Promise.all([runSpoolPath(runId), runSpoolGzPath(runId), runSpoolZstPath(runId)]
        .map((path) => access(path, fsConstants.R_OK).then(() => true, () => false)))).some(Boolean);
      const delta = await readRunSpoolDelta(runId, { skipLines: afterLines, maxRecords: 200, strictStatus: true });
      const run = await getRun(runId);
      const delegations = run?.sessionId === sessionId && Array.isArray(run?.providerNativeDelegation?.delegations)
        ? run.providerNativeDelegation.delegations.filter((entry) => entry.parentSessionId === sessionId && entry.parentRunId === runId && entry.delegationId)
          .map((entry) => ({ delegationId: entry.delegationId, parentDelegationId: entry.parentDelegationId || null,
            parentSessionId: sessionId, childSessionId: entry.childSessionId || entry.providerRefs?.childSessionId || null,
            provider: entry.provider || null, runId, state: entry.state, currentAction: entry.currentAction || null,
            startedAt: entry.startedAt || null, updatedAt: entry.updatedAt || null, completedAt: entry.completedAt || null,
            activity: nativeDelegationActivity(entry, run, readable && delta.readStatus === 'verified') })) : [];
      const nextAfterLines = delta.nextOffset === 0
        ? Math.max(afterLines, delta.processedLineCount || 0)
        : (delta.skippedLineCount || 0) + (delta.processedLineCount || 0);
      const seenEventIds = new Set();
      const events = [];
      for (const record of delta.records) {
        const value = record?.json;
        let event = null;
        if (value?.type === 'ragent.delegation_event') {
          event = value.event;
        } else if (value?.type === 'ragent.member_event' && value.event?.barrierParticipation === true) {
          event = barrierEventFromMember(value.event);
        }
        if (!event || event.parentSessionId !== sessionId || event.runId !== runId || !event.id || seenEventIds.has(event.id)) {
          continue;
        }
        seenEventIds.add(event.id);
        events.push({
          id: event.id,
          runId: event.runId,
          parentSessionId: event.parentSessionId,
          delegationId: event.delegationId,
          parentDelegationId: event.parentDelegationId || null,
          childSessionId: event.childSessionId || null,
          kind: event.kind,
          state: event.state,
          seq: event.seq,
          timestamp: event.timestamp,
          birthActor: event.kind === 'spawned' && ['codex', 'agy'].includes(event.provider) && !event.parentDelegationId && event.facts?.birthActor === 'root_session' ? 'root_session' : null,
          details: event.facts?.candidate?.reason || event.facts?.recovery?.reason || null,
        });
      }
      writeJson(res, 200, { sessionId, runId, events, delegations, nextAfterLines, hasMore: delta.truncated === true,
        sourceAvailability: readable ? delta.readStatus : 'missing',
        gap: !readable || delta.readStatus !== 'verified', recoverability: readable ? 'unknown' : 'unavailable' });
    } catch (error) { writeError(res, writeJson, error); }
    return true;
  }
  if (actionsMatch) {
    if (!ORG_PROJECTION_V1_ENABLED && !ORG_PROJECTION_V2_ENABLED) return false;
    if (authSession?.role !== 'owner') { writeJson(res, 403, { error: 'Owner access required' }); return true; }
    if (req.method !== 'GET') { writeJson(res, 405, { error: 'Method not allowed' }); return true; }
    try {
      const rootSessionId = decodeURIComponent(actionsMatch[1]);
      const org = await getOrganizationByRootSession(rootSessionId);
      if (!org) { writeJson(res, 404, { error: 'Organization not found', code: 'ORGANIZATION_NOT_FOUND' }); return true; }
      const url = new URL(req.url, `http://${req.headers?.host || 'localhost'}`);
      const afterId = Number(url.searchParams.get('afterId') || 0);
      const limit = Number(url.searchParams.get('limit') || 100);
      if (!Number.isSafeInteger(afterId) || afterId < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200) {
        writeJson(res, 400, { error: 'Invalid action cursor or limit' }); return true;
      }
      const nodes = await listOrganizationNodes(org.id);
      await recoverOrganizationDispatchEvents(org);
      const rows = await listOrganizationEvents(org.id, { afterId, limit: limit + 1 });
      const page = rows.slice(0, limit);
      const nodeById = new Map(nodes.map((node) => [node.id, node]));
      const actions = await Promise.all(page.filter((event) => ['node.created', 'task.delegated', 'task.dispatch_requested', 'result.available', 'organization.cancel_requested', 'node.session_replaced'].includes(event.type)).map(async (event) => {
        const envelope = event.envelopeId ? await getInternalEnvelope(event.envelopeId) : null;
        const collaboration = event.type === 'task.delegated' && event.payload?.collaborationId ? await getCollaboration(event.payload.collaborationId) : null;
        const task = collaboration?.rootSessionId === rootSessionId ? collaboration.tasks?.find((item) => item.id === event.taskId) : null;
        return { id: event.id, type: event.type, nodeId: event.nodeId || null, actorNodeId: verifiedBirthActor(event, nodes), taskId: event.taskId || null, attemptId: event.attemptId || null, createdAt: event.type === 'task.dispatch_requested' ? (event.payload?.requestedAt || event.createdAt) : event.createdAt,
          displayName: nodeById.get(event.nodeId)?.stableKey || null,
          summary: task?.objective || (event.type === 'task.dispatch_requested' ? event.payload?.objective : null) || (envelope?.organizationId === org.id ? envelope.subject : null),
          details: event.type === 'organization.cancel_requested' && typeof event.payload?.reason === 'string' ? event.payload.reason : null,
          operationId: null, status: ['organization.cancel_requested', 'task.dispatch_requested'].includes(event.type) ? 'requested' : null };
      }));
      res.setHeader?.('Cache-Control', 'private, no-store');
      writeJson(res, 200, {
        rootSessionId, organizationId: org.id,
        hasCreatedSubordinate: await organizationHasCreatedSubordinate(org, nodes),
        actions,
        nextAfterId: page.at(-1)?.id || afterId,
        hasMore: rows.length > limit,
      });
    } catch (error) { writeError(res, writeJson, error); }
    return true;
  }
  if (conversationMatch) {
    if (!ORG_PROJECTION_V1_ENABLED && !ORG_PROJECTION_V2_ENABLED) return false;
    if (authSession?.role !== 'owner') { writeJson(res, 403, { error: 'Owner access required' }); return true; }
    if (req.method !== 'GET') { writeJson(res, 405, { error: 'Method not allowed' }); return true; }
    try {
      const organizationId = decodeURIComponent(conversationMatch[1]);
      const nodeId = decodeURIComponent(conversationMatch[2]);
      const org = await getOrganization(organizationId);
      const node = await getNode(nodeId);
      const available = (value) => value && value.organizationId === organizationId && value.retiredRevision === null
        && !['retired', 'deleted'].includes(String(value.lifecycleState || '').toLowerCase());
      if (!org || !available(node)) { writeJson(res, 404, { error: 'Node not found' }); return true; }
      const sessionId = node.currentSessionId || null;
      const generation = node.bindingGeneration;
      let runtimeState = 'unknown';
      if (ORG_PROJECTION_V2_ENABLED && sessionId) {
        const projection = await buildOrganizationProjection(organizationId, { version: 2 });
        const projected = projection?.nodes?.find((value) => value.id === nodeId);
        if (projected?.currentBinding?.sessionId === sessionId && projected.currentBinding.generation === generation) {
          runtimeState = projected.bindingRuntimeState || 'unknown';
        }
      }
      let effectiveSessionId = sessionId;
      if (sessionId) {
        const { getSessionReadSnapshot } = await import('./session-manager.mjs');
        const targetSnap = await getSessionReadSnapshot(sessionId);
        if (!targetSnap || Number(targetSnap.historyMeta?.latestSeq || 0) === 0) {
          const stagingConversation = await resolveFormalNodeStagingConversationSession({
            organizationId,
            rootSessionId: org.rootSessionId,
            node,
            getSessionReadSnapshotFn: getSessionReadSnapshot,
          });
          if (stagingConversation?.sessionId && (stagingConversation.hasEntries || !targetSnap)) {
            effectiveSessionId = stagingConversation.sessionId;
          }
        }
      }
      // This fences observed node binding changes during the projection read, not later history reads.
      const current = await getNode(nodeId);
      if (!available(current)) { writeJson(res, 404, { error: 'Node not found' }); return true; }
      if ((current.currentSessionId || null) !== sessionId || current.bindingGeneration !== generation) {
        writeJson(res, 409, { error: 'Node binding changed; refresh and retry', code: 'ORGANIZATION_BINDING_CHANGED' }); return true;
      }
      res.setHeader?.('Cache-Control', 'private, no-store');
      writeJson(res, 200, { organizationId, nodeId, currentBinding: { sessionId: effectiveSessionId, generation }, runtimeState, observedAt: new Date().toISOString() });
    } catch (error) { writeError(res, writeJson, error); }
    return true;
  }
  if (phaseDispatchMatch) {
    if (authSession?.role !== 'owner') { writeJson(res, 403, { error: 'Owner access required' }); return true; }
    if (req.method !== 'POST') { writeJson(res, 405, { error: 'Method not allowed' }); return true; }
    let payload = {};
    try {
      const rawBody = await readBody(req, 32 * 1024);
      payload = rawBody ? JSON.parse(rawBody) : {};
    } catch (error) {
      writeJson(res, error?.code === 'BODY_TOO_LARGE' ? 413 : 400, { error: 'Invalid JSON body' });
      return true;
    }
    const organizationId = decodeURIComponent(phaseDispatchMatch[1]);
    const phaseId = decodeURIComponent(phaseDispatchMatch[2]);
    const revision = typeof payload.revision === 'string' && payload.revision.trim() ? Number(payload.revision) : payload.revision;
    const idempotencyKey = text(payload.idempotencyKey) || text(req.headers?.['idempotency-key']);
    try {
      const dispatcher = dispatchPhase || (await import('./organization-phase-dispatch.mjs')).dispatchOrganizationPhase;
      const result = await dispatcher({ organizationId, phaseId, revision, idempotencyKey });
      writeJson(res, 200, { dispatch: result });
    } catch (error) { writeError(res, writeJson, error); }
    return true;
  }
  const action = organizationMatch ? (organizationMatch[2] || '') : 'projection';
  const projectionEnabled = ORG_PROJECTION_V1_ENABLED || ORG_PROJECTION_V2_ENABLED;
  if (action === 'provision' ? !ORG_AUTONOMOUS_PROVISIONING_ENABLED : !projectionEnabled) return false;
  if (authSession?.role !== 'owner') { writeJson(res, 403, { error: 'Owner access required' }); return true; }
  const requestedId = decodeURIComponent(organizationMatch ? organizationMatch[1] : rootSessionMatch[1]);
  try {
    const org = organizationMatch
      ? await getOrganization(requestedId)
      : await getOrganizationByRootSession(requestedId);
    if (!org) { writeJson(res, 404, { error: 'Organization not found', code: 'ORGANIZATION_NOT_FOUND' }); return true; }
    if (req.method === 'GET' && (action === '' || action === 'projection')) {
      const requestUrl = req.url ? new URL(req.url, `http://${req.headers?.host || 'localhost'}`) : null;
      const sinceEventId = requestUrl ? Number(requestUrl.searchParams.get('sinceEventId') || 0) : 0;
      const cachedProjection = await buildOrganizationProjection(org.id, {
        version: ORG_PROJECTION_V2_ENABLED ? 2 : 1,
        sinceEventId: Number.isInteger(sinceEventId) && sinceEventId >= 0 ? sinceEventId : 0,
      });
      const projection = await attachOrganizationNodeActivities(cachedProjection, org.id);
      projection.nodes = projection.nodes.map((node) => ({ ...node, member: formalMemberDescriptor(org.rootSessionId, node) }));
      const rootCandidates = projection.nodes.filter((node) => node.currentBinding?.sessionId === org.rootSessionId);
      const rootMember = rootCandidates.length === 1 ? rootCandidates[0].member?.canonicalId : null;
      Object.assign(projection, await projectHarnessMembers(org.rootSessionId, rootMember, listMembers));
      projection.digest = projectionDigest(projection);
      if (projection.asOf) projection.asOf = { ...projection.asOf, projectionDigest: projection.digest };
      const etag = `"${createHash('sha256').update(JSON.stringify(projection)).digest('hex')}"`;
      if (req.headers?.['if-none-match'] === etag) { res.writeHead(304, { ETag: etag }); res.end(); return true; }
      res.setHeader?.('ETag', etag);
      res.setHeader?.('X-Organization-Projection-Schema', String(projection.schemaVersion));
      writeJson(res, 200, { projection });
      return true;
    }
    if (req.method === 'POST' && action === 'cancel') {
      const rootNodeId = text(req.headers?.['x-organization-root-node-id']);
      if (!rootNodeId) { writeJson(res, 400, { error: 'root node id is required', code: 'ORG_PROJECTION_INVALID' }); return true; }
      const result = await cancelDescendants({ organizationId: org.id, rootNodeId, reason: 'cancelled by owner' });
      writeJson(res, 200, { cancelled: result.cancelled?.length || 0 });
      return true;
    }
    if (req.method === 'POST' && action === 'provision') {
      let payload = {};
      try {
        const rawBody = await readBody(req, 32 * 1024);
        payload = rawBody ? JSON.parse(rawBody) : {};
      } catch (error) {
        writeJson(res, error?.code === 'BODY_TOO_LARGE' ? 413 : 400, { error: 'Invalid JSON body' });
        return true;
      }
      const revision = typeof payload.revision === 'string' && payload.revision.trim()
        ? Number(payload.revision)
        : payload.revision;
      if (!Number.isInteger(revision) || revision < 1) {
        writeJson(res, 400, { error: 'revision must be a positive integer', code: 'ORG_PROVISIONING_REVISION_INVALID' });
        return true;
      }
      const idempotencyKey = text(payload.idempotencyKey) || text(req.headers?.['idempotency-key']);
      if (!idempotencyKey) {
        writeJson(res, 400, { error: 'idempotencyKey is required', code: 'ORG_PROVISIONING_IDEMPOTENCY_REQUIRED' });
        return true;
      }
      const result = await provisionRevision({
        organizationId: org.id,
        revision,
        idempotencyKey,
        createManagedSession: managedSessionFactory,
      });
      writeJson(res, result?.attempted === false ? 503 : 200, { provisioning: result });
      return true;
    }
    writeJson(res, 405, { error: 'Method not allowed' });
  } catch (error) { writeError(res, writeJson, error); }
  return true;
}
