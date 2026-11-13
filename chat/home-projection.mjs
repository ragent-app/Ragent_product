import {
  normalizeSessionWorkflowPriority,
  normalizeSessionWorkflowState,
} from './session-workflow-state.mjs';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}
function timestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(trimString(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function sessionTitle(session) {
  return trimString(session?.name)
    || trimString(session?.title)
    || trimString(session?.templateName)
    || trimString(session?.tool)
    || 'Untitled agent work';
}

function sessionSummary(session) {
  return trimString(session?.description)
    || trimString(session?.taskCard?.summary)
    || trimString(session?.taskCard?.description)
    || trimString(session?.workState?.taskCard?.summary)
    || trimString(session?.statusLabel)
    || 'Continue this agent session';
}

function sessionWorkflow(session) {
  return {
    state: normalizeSessionWorkflowState(
      session?.workflowState || session?.workState?.workflow?.state || '',
    ),
    priority: normalizeSessionWorkflowPriority(
      session?.workflowPriority || session?.workState?.workflow?.priority || '',
    ),
    lastReviewedAt: trimString(
      session?.lastReviewedAt || session?.workState?.workflow?.lastReviewedAt,
    ),
  };
}
function sessionUpdatedAt(session) {
  if (Object.prototype.hasOwnProperty.call(session || {}, 'lastActivityAt')) {
    return session?.lastActivityAt ?? (trimString(session?.updatedAt) || trimString(session?.created));
  }
  return trimString(session?.lastEventAt)
    || trimString(session?.updatedAt)
    || trimString(session?.created);
}

function isUnreviewed(session) {
  const updatedAt = timestampMs(sessionUpdatedAt(session));
  const reviewedAt = timestampMs(sessionWorkflow(session).lastReviewedAt);
  return updatedAt > 0 && reviewedAt < updatedAt;
}

function buildSessionItem(session, {
  kind = 'session',
  severity = 'normal',
  action = 'open',
  reason = '',
  summary = sessionSummary(session),
} = {}) {
  const workflow = sessionWorkflow(session);
  const run = session?.activity?.run;
  return {
    id: `${kind}:${session?.id || ''}`,
    kind,
    source: 'session',
    sessionId: trimString(session?.id),
    runId: trimString(run?.runId || run?.id),
    title: sessionTitle(session),
    summary,
    reason: reason || summary,
    severity,
    action,
    updatedAt: sessionUpdatedAt(session) || null,
    workflowState: workflow.state || null,
    workflowPriority: workflow.priority || null,
    running: run?.state === 'running',
    queuedCount: Number.isInteger(session?.activity?.queue?.count)
      ? session.activity.queue.count
      : 0,
  };
}

function triggerTitle(trigger, session) {
  return trimString(trigger?.title) || `Scheduled work for ${sessionTitle(session)}`;
}

function buildTriggerItem(trigger, session, nowMs) {
  const scheduledAt = timestampMs(trigger?.scheduledAt);
  const results = Array.isArray(trigger?.deliveryResults) ? trigger.deliveryResults : [];
  const latest = results[results.length - 1];
  const failed = trigger?.status === 'failed' || latest?.deliveryState === 'failed';
  const overdue = scheduledAt > 0 && scheduledAt <= nowMs
    && ['pending', 'delivering'].includes(trigger?.status);
  return {
    id: `trigger:${trigger?.id || ''}`,
    kind: 'trigger',
    source: 'trigger',
    triggerId: trimString(trigger?.id),
    sessionId: trimString(trigger?.sessionId),
    title: triggerTitle(trigger, session),
    summary: trimString(trigger?.text) || 'Scheduled agent follow-up',
    reason: failed
      ? (trimString(latest?.lastError) || trimString(trigger?.lastError) || 'Scheduled work failed')
      : (overdue ? 'Scheduled work is overdue' : 'Scheduled work is coming up'),
    severity: failed || overdue ? 'urgent' : 'normal',
    action: failed || overdue ? 'open' : 'schedule',
    updatedAt: trimString(trigger?.updatedAt || trigger?.scheduledAt) || null,
    scheduledAt: trimString(trigger?.scheduledAt) || null,
    status: trimString(trigger?.status) || null,
    deliveryState: trimString(latest?.deliveryState) || 'unknown',
    executionState: trimString(latest?.executionState) || 'unknown',
    runId: trimString(latest?.runId || trigger?.runId) || null,
    overdue,
  };
}

function sortByAttention(left, right) {
  const severityRank = { urgent: 3, high: 2, normal: 1 };
  const priorityRank = { high: 3, medium: 2, low: 1 };
  const leftScore = (severityRank[left.severity] || 0) * 100
    + (priorityRank[left.workflowPriority] || 0) * 10;
  const rightScore = (severityRank[right.severity] || 0) * 100
    + (priorityRank[right.workflowPriority] || 0) * 10;
  if (leftScore !== rightScore) return rightScore - leftScore;
  return timestampMs(right.updatedAt) - timestampMs(left.updatedAt);
}

export function buildHomeProjection({ sessions = [], triggers = [], now = Date.now() } = {}) {
  const nowMs = Number.isFinite(now) ? now : Date.now();
  const visibleSessions = (Array.isArray(sessions) ? sessions : [])
    .filter((session) => session && session.archived !== true && session.isInternalSession !== true);
  const sessionById = new Map(visibleSessions.map((session) => [session.id, session]));
  const focusItems = [];
  const inProgress = [];
  const recentResults = [];

  for (const session of visibleSessions) {
    const workflow = sessionWorkflow(session);
    const run = session?.activity?.run;
    const running = run?.state === 'running';
    const fresh = isUnreviewed(session);

    if (running) {
      inProgress.push(buildSessionItem(session, {
        kind: 'run',
        summary: trimString(session?.activity?.label) || 'Agent is working remotely',
        reason: trimString(session?.activity?.label) || 'Agent is working remotely',
      }));
    }

    if (fresh && workflow.state === 'waiting_user') {
      focusItems.push(buildSessionItem(session, {
        severity: 'urgent',
        reason: 'Waiting for your decision',
        summary: sessionSummary(session),
      }));
    } else if (fresh && workflow.priority === 'high' && workflow.state !== 'done') {
      focusItems.push(buildSessionItem(session, {
        severity: 'high',
        reason: 'High-priority agent work needs attention',
      }));
    }

    if (workflow.state === 'done' || (fresh && !running && session?.lastAssistantMessageAt)) {
      const updatedAt = timestampMs(sessionUpdatedAt(session));
      if (updatedAt >= nowMs - 2 * DAY_MS) {
        recentResults.push(buildSessionItem(session, {
          kind: 'result',
          action: 'open',
          reason: workflow.state === 'done' ? 'Agent marked this work complete' : 'New result is ready to review',
        }));
      }
    }
  }

  const upcomingAutomation = [];
  for (const trigger of Array.isArray(triggers) ? triggers : []) {
    if (!trigger) continue;
    const results = Array.isArray(trigger.deliveryResults) ? trigger.deliveryResults : [];
    const latest = results[results.length - 1];
    const recentFailure = (trigger.status === 'failed' || latest?.deliveryState === 'failed')
      && timestampMs(latest?.terminalAt || trigger.updatedAt) >= nowMs - 2 * DAY_MS;
    if (trigger.enabled !== true && !recentFailure) continue;
    const session = sessionById.get(trigger.sessionId);
    if (!session) continue;
    const status = trimString(trigger.status);
    if (recentFailure || status === 'failed' || status === 'delivering' || status === 'pending') {
      const item = buildTriggerItem(trigger, session, nowMs);
      if (item.overdue || status === 'failed' || latest?.deliveryState === 'failed') focusItems.push(item);
      else if (timestampMs(item.scheduledAt) <= nowMs + 7 * DAY_MS) upcomingAutomation.push(item);
    }
  }

  focusItems.sort(sortByAttention);
  inProgress.sort((left, right) => timestampMs(right.updatedAt) - timestampMs(left.updatedAt));
  recentResults.sort((left, right) => timestampMs(right.updatedAt) - timestampMs(left.updatedAt));
  upcomingAutomation.sort((left, right) => timestampMs(left.scheduledAt) - timestampMs(right.scheduledAt));

  return {
    generatedAt: new Date(nowMs).toISOString(),
    focusItems: focusItems.slice(0, 12),
    inProgress: inProgress.slice(0, 12),
    upcomingAutomation: upcomingAutomation.slice(0, 12),
    recentResults: recentResults.slice(0, 12),
    counts: {
      focus: focusItems.length,
      running: inProgress.length,
      upcoming: upcomingAutomation.length,
      recent: recentResults.length,
    },
  };
}
