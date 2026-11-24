// Small target-local projection shared by the gateway health check and the
// Android/Web target directory. It intentionally excludes message bodies,
// file contents, provider credentials, and other private runtime payloads.
import { loadOrCreateInstanceIdentity } from '../lib/instance-identity.mjs';
import {
  getTargetRuntimeRevision,
  recordTargetRuntimeSnapshotDetailed,
} from '../lib/target-runtime-state.mjs';
import { listProjects } from './projects.mjs';
import { listSessions } from './session-manager.mjs';
import { getRun } from './runs.mjs';
import { broadcastOwners } from './ws-clients.mjs';

function text(value, max = 256) {
  return (typeof value === 'string' ? value.trim() : '').slice(0, max);
}

function sessionActivity(session, revision) {
  return {
    entityType: 'session',
    entityId: text(session?.id, 160),
    title: text(session?.name || session?.title, 160),
    status: text(session?.workflowState || session?.status, 64) || 'idle',
    updatedAt: text(session?.updatedAt || session?.lastAssistantMessageAt, 64),
    revision,
  };
}

function projectActivity(project, sessions) {
  const id = text(project?.id, 160);
  const name = text(project?.name, 160);
  if (!id || !name) return null;
  const latestSessionUpdate = sessions
    .filter((session) => text(session?.projectId, 160) === id)
    .map((session) => text(session?.updatedAt || session?.lastAssistantMessageAt, 64))
    .sort((left, right) => right.localeCompare(left))[0] || '';
  return {
    id,
    name,
    updatedAt: latestSessionUpdate || text(project?.updatedAt || project?.createdAt, 64),
  };
}

export async function createTargetRuntimeSummary({
  identity = null,
  revision = null,
  listSessionsImpl = listSessions,
  listProjectsImpl = listProjects,
  getRunImpl = getRun,
  recordSnapshotImpl = recordTargetRuntimeSnapshotDetailed,
} = {}) {
  const effectiveIdentity = identity || await loadOrCreateInstanceIdentity();
  const effectiveRevision = revision === null || revision === undefined
    ? await getTargetRuntimeRevision()
    : revision;
  const sessions = await listSessionsImpl({
    includeVisitor: false,
    includeArchived: false,
    rootOnly: false,
    listSummary: true,
  });
  const projects = await listProjectsImpl({ includeSessionCounts: false });
  const activeSessions = sessions.filter((session) => text(session?.activeRunId));
  const runs = await Promise.all(activeSessions.map((session) => getRunImpl(session.activeRunId).catch(() => null)));
  const activeRuns = runs.filter((run) => run && !['completed', 'failed', 'cancelled', 'canceled'].includes(text(run.state).toLowerCase()));
  const pendingApprovals = activeRuns.filter((run) => ['awaiting_approval', 'waiting_approval'].includes(text(run.state).toLowerCase())).length
    + sessions.filter((session) => text(session?.waitingAction).toLowerCase() === 'approval').length;
  const recentActivity = sessions
    .map((session) => sessionActivity(session, effectiveRevision))
    .filter((entry) => entry.entityId)
    .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
    .slice(0, 20);
  // This Home-safe projection intentionally contains no root paths, session
  // titles, message bodies, or runtime configuration.
  const recentProjects = projects
    .map((project) => projectActivity(project, sessions))
    .filter(Boolean)
    .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
    .slice(0, 20);
  const snapshot = {
    targetId: effectiveIdentity.instanceId,
    instanceId: effectiveIdentity.instanceId,
    sessions: { total: sessions.length, active: activeSessions.length },
    runs: { active: activeRuns.length },
    approvals: { pending: pendingApprovals },
    recentActivity,
    recentProjects,
  };
  const recorded = await recordSnapshotImpl(snapshot, {
    targetId: effectiveIdentity.instanceId,
    instanceId: effectiveIdentity.instanceId,
  });
  const result = {
    schemaVersion: 1,
    targetId: effectiveIdentity.instanceId,
    instanceId: effectiveIdentity.instanceId,
    revision: recorded.revision,
    eventCursor: String(recorded.cursor || 0),
    generatedAt: new Date().toISOString(),
    ...snapshot,
  };
  if (recorded.changed) {
    broadcastOwners({
      type: 'target_runtime_summary_invalidated',
      targetId: result.targetId,
      revision: result.revision,
      cursor: result.eventCursor,
    });
  }
  return result;
}
