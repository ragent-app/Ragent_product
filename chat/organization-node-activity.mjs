// Bounded, owner-only activity supplement for the organization projection.
// Never return tool arguments, results, labels, or inferred roles.
import { listOrganizationNodes } from './organization-store.mjs';
import { buildSessionDisplayEvents } from './session-display-events.mjs';
import { buildRunActivityProjection } from './run-activity-projection.mjs';

const TOOL_KINDS = new Set(['read', 'list', 'search', 'inspect', 'edit', 'delete', 'move', 'execute', 'mcp', 'subagent',
  'task_create', 'task_update', 'task_read', 'task_list', 'task_stop', 'message', 'wait', 'question', 'web', 'fetch',
  'click', 'input', 'scroll', 'capture', 'generate', 'switch_mode', 'other']);
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
    const page = await getSessionEventsPage(binding.sessionId, { limit: 32, direction: 'latest', strict: true, historyMeta: first.historyMeta });
    const last = await getSessionReadSnapshot(binding.sessionId);
    if (!last || last.activeRunId !== runId || last.run?.id !== runId || last.run?.sessionId !== binding.sessionId ||
      last.historyMeta?.historyRevision !== first.historyMeta?.historyRevision || last.historyMeta?.latestSeq !== first.historyMeta?.latestSeq ||
      last.run?.state !== first.run?.state || last.run?.updatedAt !== first.run?.updatedAt) return base('unknown');
    const running = first.run.state === 'running';
    const waitingUser = first.run.actionPause?.state === 'waiting_user' || ['awaiting_approval', 'waiting_approval'].includes(first.run.state);
    const rawEvents = page.events || [];
    // Missing run identity on a lifecycle-closing event can make an isolated
    // start look active. In that case retain only the verified run state.
    const ambiguous = rawEvents.some((event) => !event?.runId && ['tool_result', 'approval_response', 'privileged_batch_response', 'approved_action_state'].includes(event?.type));
    const display = buildSessionDisplayEvents(rawEvents.filter((event) => event?.runId === runId));
    const activity = buildRunActivityProjection(display, { sessionRunning: running || waitingUser, run: first.run });
    const latest = [...display].reverse().find((event) => event?.type === 'operation' && event.runId === runId && ['running', 'waiting_approval'].includes(event.state));
    const actionRequired = waitingUser || (!ambiguous && activity.actionRequired === true);
    const state = actionRequired ? 'waiting' : running ? 'working' : 'unknown';
    // Only an active operation supplies a tool kind. A completed trailing tool
    // or an incomplete 32-event window cannot create a misleading tool icon.
    const semantic = latest?.presentation?.labelKind;
    const rawKind = TOOL_KINDS.has(semantic) ? semantic : latest?.toolCall?.kind;
    const kind = !ambiguous && !actionRequired && TOOL_KINDS.has(rawKind) ? rawKind : null;
    return base(state, { kind, actionRequired, runId, sourceSeq: Number.isSafeInteger(activity.sourceSeq) ? activity.sourceSeq : null,
      _runUpdatedAt: first.run.updatedAt || '' });
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
  const checked = await mapBounded(unique, async (node) => {
    const activity = byNode.get(node.id);
    if (!activity?.runId) return [node.id, base('unknown')];
    try {
      const [session, run] = await Promise.all([getSessionMeta(node.currentBinding.sessionId), getRun(activity.runId)]);
      if (session?.activeRunId !== activity.runId || run?.sessionId !== node.currentBinding.sessionId || (run.updatedAt || '') !== activity._runUpdatedAt) return [node.id, base('unknown')];
      const { _runUpdatedAt, ...safe } = activity;
      return [node.id, safe];
    } catch { return [node.id, base('unknown')]; }
  });
  const checkedByNode = new Map(checked);
  return { ...projection, nodes: nodes.map((node) => {
    const actual = actualNodes.get(node.id);
    const bound = actual && actual.organizationId === organizationId && actual.currentSessionId &&
      actual.currentSessionId === node.currentBinding?.sessionId && actual.bindingGeneration === node.currentBinding?.generation;
    const activity = !bound ? base('unknown') : checkedByNode.get(node.id) || nodeState(node);
    return { ...node, activity };
  }) };
}
