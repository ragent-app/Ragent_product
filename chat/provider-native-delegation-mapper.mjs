/**
 * Provider-native delegation adapter boundary.
 *
 * This module recognizes only provider-shaped delegation frames. Ordinary
 * assistant messages and ordinary tool calls are ignored, and provider raw
 * payloads never leave this boundary. The returned canonical events are
 * validated and replayed through delegation-canonical.mjs before publication.
 */

import {
  buildDelegationIdentity,
  computeActiveChildDelegations,
  createDelegationProjector,
  normalizeDelegationEvent,
} from './delegation-canonical.mjs';

const CLAUDE_TASK_NAMES = new Set(['task', 'agent', 'subagent', 'sub_agent']);
const CLAUDE_LIFECYCLE_TYPES = new Map([
  ['subagent_started', ['spawned', 'spawned']],
  ['delegation_started', ['spawned', 'spawned']],
  ['subagent_running', ['running', 'running']],
  ['delegation_waiting', ['waiting', 'waiting']],
  ['subagent_completed', ['completed', 'completed']],
  ['delegation_completed', ['completed', 'completed']],
  ['subagent_failed', ['failed', 'failed']],
  ['subagent_cancelled', ['cancelled', 'cancelled']],
  ['subagent_interrupted', ['interrupted', 'interrupted']],
  ['subagent_lost', ['lost', 'lost']],
]);

const CODEX_CONTROL_NAMES = new Map([
  ['spawn', 'spawn'],
  ['spawnagent', 'spawn'],
  ['send', 'send'],
  ['sendinput', 'send'],
  ['wait', 'wait'],
  ['resume', 'resume'],
  ['resumeagent', 'resume'],
  ['close', 'close'],
  ['closeagent', 'close'],
  ['lost', 'lost'],
  ['marklost', 'lost'],
  ['cancel', 'cancelled'],
  ['cancelled', 'cancelled'],
  ['interrupt', 'interrupted'],
  ['interrupted', 'interrupted'],
]);

const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'lost']);

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function lower(value) {
  return text(value).toLowerCase();
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function firstString(...values) {
  for (const value of values) {
    const candidate = text(value);
    if (candidate) return candidate;
  }
  return '';
}

function firstObject(...values) {
  for (const value of values) {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  }
  return {};
}

function readTimestamp(raw, context) {
  const value = raw?.timestamp ?? raw?.createdAt ?? raw?.created_at ?? context.timestamp;
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function readChildSession(value) {
  const input = object(value);
  return firstString(
    input.childSessionId,
    input.child_session_id,
    input.childThreadId,
    input.child_thread_id,
    input.sessionId,
    input.session_id,
    input.threadId,
    input.thread_id,
  );
}

function readParentDelegation(value) {
  const input = object(value);
  return firstString(input.parentDelegationId, input.parent_delegation_id, input.parentAgentId, input.parent_agent_id);
}

function readProviderDelegationId(value) {
  const input = object(value);
  return firstString(
    input.providerDelegationId,
    input.provider_delegation_id,
    input.delegationId,
    input.delegation_id,
    input.agentId,
    input.agent_id,
    input.childAgentId,
    input.child_agent_id,
    input.id,
    input.toolUseId,
    input.tool_use_id,
  );
}

function readContentBlocks(raw) {
  const message = object(raw?.message);
  const content = raw?.content ?? message.content ?? raw?.params?.content;
  if (Array.isArray(content)) return content;
  return content && typeof content === 'object' ? [content] : [];
}

function resolveParentDelegationId(rawParentId, { provider, runId } = {}) {
  const value = text(rawParentId);
  if (!value) return '';
  if (value.startsWith('delg_')) return value;
  return buildDelegationIdentity({ provider, runId, providerDelegationId: value }).id;
}

function observation({ provider, raw, context, providerDelegationId, kind, state, childSessionId = '', parentDelegationId = '', facts }) {
  const id = text(providerDelegationId);
  if (!id || !kind || !state) return null;
  return {
    provider,
    providerDelegationId: id,
    runId: text(context.runId),
    parentSessionId: text(context.parentSessionId),
    childSessionId: text(childSessionId),
    parentDelegationId: resolveParentDelegationId(parentDelegationId, { provider, runId: context.runId }),
    kind,
    state,
    timestamp: readTimestamp(raw, context),
    ...(facts ? { facts } : {}),
  };
}

function mapClaude(raw, context, taskToolUseIds = null) {
  const events = [];
  const controls = [];
  for (const block of readContentBlocks(raw)) {
    const type = lower(block?.type);
    if (type === 'tool_use' && CLAUDE_TASK_NAMES.has(lower(block.name))) {
      const input = object(block.input);
      const id = readProviderDelegationId({ ...block, ...input });
      if (taskToolUseIds && id) taskToolUseIds.add(id);
      const event = observation({
        provider: 'claude', raw, context, providerDelegationId: id,
        kind: 'spawned', state: 'spawned', childSessionId: readChildSession(input),
        parentDelegationId: readParentDelegation(input),
      });
      if (event) events.push(event);
      continue;
    }
    if (type === 'tool_result' && text(block.tool_use_id)) {
      // Only a tool_result answering a Task/Agent tool_use closes a native
      // delegation.  Ordinary tool roundtrips (Bash/Read/...) carry the same
      // tool_result shape but no delegation was ever spawned for them; mapping
      // them produces an orphan terminal event the canonical projector must
      // reject, failing healthy runs with delegation_replay_invalid.
      if (taskToolUseIds && !taskToolUseIds.has(text(block.tool_use_id))) continue;
      const failed = block.is_error === true || lower(block.status) === 'failed' || lower(block.status) === 'error';
      const event = observation({
        provider: 'claude', raw, context, providerDelegationId: block.tool_use_id,
        kind: failed ? 'failed' : 'completed', state: failed ? 'failed' : 'completed',
        facts: { candidate: { outcome: failed ? 'failed' : 'completed', reasonKind: failed ? 'provider_error' : 'provider_result' } },
      });
      if (event) events.push(event);
    }
  }

  const explicitType = lower(raw?.type ?? raw?.event ?? raw?.method);
  const lifecycle = CLAUDE_LIFECYCLE_TYPES.get(explicitType);
  if (lifecycle) {
    const payload = firstObject(raw, raw?.params, raw?.data);
    const event = observation({
      provider: 'claude', raw, context, providerDelegationId: readProviderDelegationId(payload),
      kind: lifecycle[0], state: lifecycle[1], childSessionId: readChildSession(payload),
      parentDelegationId: readParentDelegation(payload),
      facts: TERMINAL_STATES.has(lifecycle[1]) ? { candidate: { outcome: lifecycle[1] } } : undefined,
    });
    if (event) events.push(event);
  }
  return { events, controls, recognized: events.length > 0 };
}

function readCodexItem(raw) {
  return firstObject(
    raw?.params?.item,
    raw?.item,
    raw?.params?.collabAgentToolCall,
    raw?.collabAgentToolCall,
    raw?.params,
  );
}

function codexOperation(item, raw) {
  const value = firstString(item.tool, item.toolName, item.tool_name, item.action, item.operation, item.command, raw?.params?.action);
  return CODEX_CONTROL_NAMES.get(lower(value).replace(/[_-]/g, '')) || '';
}

function codexStatus(item) {
  const value = lower(firstString(item.status, item.state, item.outcome));
  if (value === 'error' || value === 'failure') return 'failed';
  if (value === 'success' || value === 'done') return 'completed';
  if (['spawned', 'running', 'waiting', 'completed', 'failed', 'cancelled', 'interrupted', 'lost'].includes(value)) return value;
  return '';
}

function mapCodex(raw, context) {
  const item = readCodexItem(raw);
  const type = lower(firstString(item.type, raw?.method));
  if (!type.includes('collabagent') && !type.includes('subagent') && !type.includes('agenttool')) {
    return { events: [], controls: [], recognized: false };
  }
  const operation = codexOperation(item, raw);
  const id = readProviderDelegationId(item);
  if (!id || !operation) return { events: [], controls: [], recognized: Boolean(type) };
  // In the current Codex protocol item.id identifies this tool call, not a
  // child agent. A wait is an observation/control operation and its completion
  // does not establish that any child has completed. Keep existing canonical
  // children unchanged; do not invent a spawn from the call identifier.
  if (type === 'collabagenttoolcall' && operation === 'wait' && Array.isArray(item.receiverThreadIds)) {
    return { events: [], controls: [{ type: 'delegation_control', control: 'wait', provider: 'codex', runId: text(context.runId) }], recognized: true };
  }
  const childSessionId = readChildSession(item);
  const parentDelegationId = readParentDelegation(item);
  if (operation === 'send') {
    const identity = buildDelegationIdentity({ provider: 'codex', runId: context.runId, providerDelegationId: id });
    return {
      events: [],
      controls: [{ type: 'delegation_control', control: 'send', provider: 'codex', delegationId: identity.id, providerDelegationId: id, runId: text(context.runId) }],
      recognized: true,
    };
  }

  let kind = operation;
  let state = operation;
  if (operation === 'spawn') {
    kind = 'spawned';
    state = 'spawned';
  } else if (operation === 'wait') {
    kind = 'waiting';
    state = 'waiting';
  } else if (operation === 'resume') {
    kind = 'recovered';
    state = 'running';
  } else if (operation === 'close') {
    state = codexStatus(item) || 'completed';
    kind = state;
  } else if (['lost', 'cancelled', 'interrupted'].includes(operation)) {
    kind = operation;
    state = operation;
  }
  const event = observation({
    provider: 'codex', raw, context, providerDelegationId: id, kind, state,
    childSessionId, parentDelegationId,
    facts: TERMINAL_STATES.has(state) ? { candidate: { outcome: state } } : undefined,
  });
  return { events: event ? [event] : [], controls: [], recognized: true };
}

export function mapClaudeProviderDelegationEvent(raw, context = {}, taskToolUseIds = null) {
  return mapClaude(object(raw), context, taskToolUseIds);
}

export function mapCodexProviderDelegationEvent(raw, context = {}) {
  return mapCodex(object(raw), context);
}

export function createProviderNativeDelegationMapper({ provider, runId, parentSessionId, parentThreadId, timestamp } = {}) {
  const normalizedProvider = lower(provider);
  const context = { runId: text(runId), parentSessionId: text(parentSessionId), timestamp };
  const projector = createDelegationProjector();
  const sequenceByDelegation = new Map();
  // Stream-scoped registry of Task/Agent tool_use ids seen in this spool so
  // their matching tool_result frames can be linked back to a delegation.
  const taskToolUseIds = new Set();
  const codexChildren = new Set();

  function mapModernCodex(raw) {
    const item = readCodexItem(raw);
    if (lower(item.type) !== 'collabagenttoolcall' || !Array.isArray(item.receiverThreadIds)) return null;
    const operation = codexOperation(item, raw);
    const control = { type: 'delegation_control', control: operation || 'unknown', provider: 'codex', runId: context.runId };
    const receivers = [...new Set(item.receiverThreadIds.map(text).filter(Boolean))];
    const bound = text(parentThreadId) && text(item.senderThreadId) === text(parentThreadId);
    const events = [];
    const errors = [];
    if (operation === 'spawn' && lower(raw?.method) === 'item/completed' && lower(item.status) === 'completed' && receivers.length) {
      if (!bound) errors.push('delegation_parent_thread_unresolved');
      else for (const child of receivers) {
        if (codexChildren.has(child)) continue;
        codexChildren.add(child);
        events.push(observation({ provider: 'codex', raw, context, providerDelegationId: child,
          childSessionId: child, kind: 'spawned', state: 'spawned' }));
      }
    }
    if (bound && ['wait', 'close'].includes(operation)) {
      const states = object(item.agentsStates);
      for (const child of receivers) {
        if (!codexChildren.has(child)) continue;
        const status = lower(object(states[child]).status);
        const state = ({ running: 'running', completed: 'completed', errored: 'failed', interrupted: 'interrupted' })[status];
        if (!state) continue;
        const identity = buildDelegationIdentity({ provider: 'codex', runId: context.runId, providerDelegationId: child });
        if (projector.getState(identity.id) === state) continue;
        events.push(observation({ provider: 'codex', raw, context, providerDelegationId: child,
          childSessionId: child, kind: state, state }));
      }
    }
    return { events, controls: [control], recognized: true, errors };
  }

  function map(raw) {
    const mapped = normalizedProvider === 'claude'
      ? mapClaudeProviderDelegationEvent(raw, context, taskToolUseIds)
      : normalizedProvider === 'codex'
        ? (mapModernCodex(raw) || mapCodexProviderDelegationEvent(raw, context))
        : { events: [], controls: [], recognized: false };
    const events = [];
    const errors = [...(mapped.errors || [])];
    for (const candidate of mapped.events) {
      const identity = buildDelegationIdentity(candidate);
      const nextSeq = (sequenceByDelegation.get(identity.id) || 0) + 1;
      sequenceByDelegation.set(identity.id, nextSeq);
      let event;
      try {
        event = normalizeDelegationEvent(candidate, { seq: nextSeq, timestamp: candidate.timestamp });
      } catch (error) {
        errors.push(error.code === 'DELEGATION_CONTRACT' ? error.message : String(error));
        continue;
      }
      const result = projector.apply(event);
      if (!result.ok) {
        errors.push(...result.errors);
        continue;
      }
      events.push(event);
    }
    return {
      events,
      controls: mapped.controls,
      recognized: mapped.recognized,
      ok: errors.length === 0 && projector.isValid(),
      errors: [...errors, ...projector.getErrors()],
    };
  }

  return {
    map,
    projector,
    replay(events = []) {
      const mapped = events.map((event) => map(event));
      return {
        results: mapped,
        events: mapped.flatMap((result) => result.events),
        controls: mapped.flatMap((result) => result.controls),
        ok: mapped.every((result) => result.ok),
        errors: mapped.flatMap((result) => result.errors),
        activeChildSessionIds: projector.activeChildSessionIds(),
      };
    },
  };
}

export function replayProviderNativeDelegations(events = [], options = {}) {
  const mapper = createProviderNativeDelegationMapper(options);
  const replay = mapper.replay(events);
  return {
    ...replay,
    projection: computeActiveChildDelegations(replay.events),
  };
}
