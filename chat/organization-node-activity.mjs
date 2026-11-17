// Bounded, owner-only activity supplement for the organization projection.
// Never return tool arguments, results, labels, or inferred roles.
import { listOrganizationNodes } from './organization-store.mjs';
import { readIncrementalActivity } from './organization-run-activity.mjs';

const TOOL_KINDS = new Set(['read', 'list', 'search', 'inspect', 'edit', 'delete', 'move', 'execute', 'mcp', 'subagent',
  'task_create', 'task_update', 'task_read', 'task_list', 'task_stop', 'message', 'wait', 'question', 'web', 'fetch',
  'click', 'input', 'scroll', 'capture', 'generate', 'switch_mode', 'other', 'responding']);
const IDLE = new Set(['idle', 'completed', 'cancelled', 'replaced', 'unbound']);

function base(state, extra = {}) { return { state, kind: null, actionRequired: false, ...extra }; }
function nodeState(node) {
  const value = node.bindingRuntimeState;
  if (value !== 'unknown' && node.currentTask?.state === 'failed') return base('failed');
  if (value === 'failed') return base('failed');
  if (value === 'blocked') return base('blocked');
  if (value === 'waiting_children') return base('waiting', { kind: 'wait_subordinates' });
  if (['waiting_review', 'waiting_approval'].includes(value)) return base('waiting');
  if (IDLE.has(value)) return base('idle');
  return base('unknown');
}

export function nativeDelegationActivity(entry, run, sourceVerified) {
  if (!sourceVerified || !entry || !run || entry.parentSessionId !== run.sessionId || entry.parentRunId !== run.id) return base('unknown');
  const state = String(entry.state || '');
  const extra = { runId: run.id, sourceSeq: Number.isSafeInteger(entry.stateVersion) ? entry.stateVersion : null };
  if (state === 'failed') return base('failed', extra);
  if (['completed', 'cancelled', 'interrupted'].includes(state)) return base('idle', extra);
  if (state === 'lost' || ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.state)) return base('unknown', extra);
  if (state === 'waiting') return base('waiting', extra);
  if (['spawned', 'running'].includes(state)) return base('working', extra);
  return base('unknown', extra);
}

async function mapBounded(items, fn) {
  let cursor = 0;
  const result = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      result[index] = await fn(items[index]);
    }
  }));
  return result;
}

async function readCurrentActivity(node) {
  const binding = node.currentBinding;
  const runId = node.attempt?.runId;
  if (!binding?.sessionId || !runId) return base('unknown');
  try {
    const { getSessionReadSnapshot, getSessionEventsPage } = await import('./session-manager.mjs');
    const first = await getSessionReadSnapshot(binding.sessionId);
    if (!first || first.activeRunId !== runId || first.run?.id !== runId || first.run?.sessionId !== binding.sessionId) return base('unknown');
    const activity = await readIncrementalActivity(binding.sessionId, runId, first, getSessionEventsPage);
    const last = await getSessionReadSnapshot(binding.sessionId);
    if (!last || last.activeRunId !== runId || last.run?.id !== runId || last.run?.sessionId !== binding.sessionId ||
      (last.historyMeta?.latestSeq || 0) < (first.historyMeta?.latestSeq || 0)) return base('unknown');
    const running = first.run.state === 'running';
    const waitingUser = first.run.actionPause?.state === 'waiting_user' || ['awaiting_approval', 'waiting_approval'].includes(first.run.state);
    const state = waitingUser ? 'waiting' : running ? 'working' : 'unknown';
    const kind = !waitingUser && TOOL_KINDS.has(activity.kind) ? activity.kind : null;
    return base(state, { kind, actionRequired: waitingUser, runId, sourceSeq: activity.sourceSeq,
      _runUpdatedAt: first.run.updatedAt || '', _executionHarnessId: first.run.provider || null });
  } catch {
    return base('unknown');
  }
}

export async function attachOrganizationNodeActivities(projection, organizationId) {
  const nodes = Array.isArray(projection?.nodes) ? projection.nodes : [];
  const active = nodes.filter((node) => node.attempt?.runId && ['running', 'waiting_review', 'waiting_approval'].includes(node.bindingRuntimeState));
  const unique = [...new Map(active.filter((node) => node.currentBinding?.sessionId).map((node) => [node.currentBinding.sessionId, node])).values()];
  const results = await mapBounded(unique, async (node) => [node.id, await readCurrentActivity(node)]);
  const byNode = new Map(results);
  const actualNodes = new Map((await listOrganizationNodes(organizationId)).map((node) => [node.id, node]));
  const { getSessionMeta } = await import('./session-manager.mjs');
  const { getRun } = await import('./runs.mjs');
  const boundSessions = [...new Set(nodes.map((node) => {
    const actual = actualNodes.get(node.id);
    return actual?.organizationId === organizationId && actual.currentSessionId === node.currentBinding?.sessionId &&
      actual.bindingGeneration === node.currentBinding?.generation ? actual.currentSessionId : null;
  }).filter(Boolean))];
  const metadata = new Map(await mapBounded(boundSessions, async (id) => [id, await getSessionMeta(id).catch(() => null)]));
  const checked = await mapBounded(unique, async (node) => {
    const activity = byNode.get(node.id);
    if (!activity?.runId) return [node.id, base('unknown')];
    try {
      const session = metadata.get(node.currentBinding.sessionId);
      const run = await getRun(activity.runId);
      if (session?.activeRunId !== activity.runId || run?.sessionId !== node.currentBinding.sessionId || !['running', 'awaiting_approval', 'waiting_approval'].includes(run.state)) return [node.id, base('unknown')];
      const { _runUpdatedAt, _executionHarnessId, ...safe } = activity;
      return [node.id, { ...safe, _executionHarnessId }];
    } catch { return [node.id, base('unknown')]; }
  });
  const checkedByNode = new Map(checked);
  return { ...projection, nodes: nodes.map((node) => {
    const actual = actualNodes.get(node.id);
    const bound = actual && actual.organizationId === organizationId && actual.currentSessionId &&
      actual.currentSessionId === node.currentBinding?.sessionId && actual.bindingGeneration === node.currentBinding?.generation;
    const checkedActivity = !bound ? base('unknown') : checkedByNode.get(node.id) || nodeState(node);
    const { _executionHarnessId, ...activity } = checkedActivity;
    const session = bound ? metadata.get(actual.currentSessionId) : null;
    const configured = session?.provider || session?.tool || null;
    return { ...node, activity, executionHarnessId: _executionHarnessId || configured };
  }) };
}
