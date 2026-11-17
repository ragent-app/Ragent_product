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
  isDelegationStateTransitionValid,
  normalizeDelegationEvent,
} from '../delegation-canonical.mjs';
import { createHash } from 'crypto';
import { createClaudeAdapter } from './claude.mjs';
import { buildSessionDisplayEvents } from '../session-display-events.mjs';

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
  ['waitagent', 'wait'],
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

export function memberEventFromDelegation(event, { requested = null, memberIds = new Map(), operationId = '' } = {}) {
  // Modern Codex supplies the actual child thread as its delegation id.
  // Other shapes can identify only a call within this run; do not merge them
  // across runs without proof that the provider id denotes the same member.
  const stableThread = event.provider === 'codex' && event.childSessionId
    && event.childSessionId === event.providerDelegationId;
  const memberId = memberIds.get(event.delegationId) || `member_${createHash('sha256').update(JSON.stringify([
    event.parentSessionId, event.provider, stableThread ? '' : event.runId, event.providerDelegationId,
  ])).digest('hex').slice(0, 24)}`;
  memberIds.set(event.delegationId, memberId);
  const parentId = event.parentDelegationId && memberIds.get(event.parentDelegationId);
  const parent = parentId ? { kind: 'member', id: parentId }
    : event.facts?.birthActor === 'root_session' ? { kind: 'root_session', id: event.parentSessionId }
      : { kind: 'unknown' };
  return {
    version: 1, id: event.id, memberId,
    aliases: [{ kind: 'legacy_delegation', runId: event.runId, id: event.delegationId }],
    rootSessionId: event.parentSessionId, runId: event.runId,
    sourceTag: event.provider, executionHarnessId: event.provider,
    parent,
    ...(event.facts?.birthActor === 'root_session' ? { actor: parent } : {}),
    phase: event.kind === 'spawned' ? (requested === null ? 'unknown' : requested ? 'requested' : 'confirmed')
      : TERMINAL_STATES.has(event.state) ? 'terminal' : 'updated',
    state: event.kind === 'spawned' && requested !== false ? 'unknown' : event.state,
    ...(event.childSessionId ? { providerRef: { kind: 'external_thread', id: event.childSessionId } } : {}),
    ...(operationId ? { operationId } : {}),
    seq: event.seq, timestamp: event.timestamp, barrierParticipation: true,
    barrier: { sourceMemberId: event.providerDelegationId, kind: event.kind, state: event.state,
      ...(event.parentDelegationId ? { parentDelegationId: event.parentDelegationId } : {}),
      ...(event.facts ? { facts: event.facts } : {}) },
  };
}

export function barrierEventFromMember(member) {
  if (member?.barrierParticipation !== true || !member.barrier?.sourceMemberId) return null;
  try {
    return normalizeDelegationEvent({ id: member.id, provider: member.sourceTag,
      providerDelegationId: member.barrier.sourceMemberId, runId: member.runId,
      parentSessionId: member.rootSessionId, parentDelegationId: member.barrier.parentDelegationId,
      childSessionId: member.providerRef?.id, kind: member.barrier.kind, state: member.barrier.state,
      seq: member.seq, timestamp: member.timestamp, facts: member.barrier.facts });
  } catch { return null; }
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
  const memberIds = new Map();
  const nestedChildren = new Map();
  const nestedSeq = new Map();
  const nestedStates = new Map();
  const claudeConfirmed = new Set();
  const claudeRootRequests = new Set();

  function mapModernCodex(raw) {
    const item = readCodexItem(raw);
    if (lower(item.type) !== 'collabagenttoolcall' || !Array.isArray(item.receiverThreadIds)) return null;
    const operation = codexOperation(item, raw);
    const control = { type: 'delegation_control', control: operation || 'unknown', provider: 'codex', runId: context.runId };
    const receivers = [...new Set(item.receiverThreadIds.map(text).filter(Boolean))];
    const bound = text(parentThreadId) && text(item.senderThreadId) === text(parentThreadId);
    const events = [];
    const errors = [];
    const successfulSpawn = operation === 'spawn' && lower(raw?.method) === 'item/completed' && lower(item.status) === 'completed';
    const parentChild = text(item.senderThreadId);
    const nestedParent = !bound && codexChildren.has(parentChild) ? parentChild : '';
    const memberEvents = [];
    if (nestedParent && successfulSpawn) {
      for (const child of receivers) {
        if (codexChildren.has(child)) continue;
        const parentIdentity = buildDelegationIdentity({ provider: 'codex', runId: context.runId, providerDelegationId: nestedParent });
        const candidate = observation({ provider: 'codex', raw, context, providerDelegationId: child,
          parentDelegationId: parentIdentity.id, childSessionId: child, kind: 'spawned', state: 'spawned' });
        const event = normalizeDelegationEvent(candidate, { seq: 1, timestamp: candidate.timestamp });
        codexChildren.add(child);
        nestedChildren.set(child, parentIdentity.id);
        nestedSeq.set(child, 1);
        nestedStates.set(child, 'spawned');
        const member = memberEventFromDelegation(event, { requested: false, memberIds, operationId: text(item.id) });
        if (member.parent.kind === 'member') member.actor = member.parent;
        member.barrierParticipation = false;
        delete member.aliases;
        memberEvents.push(member);
      }
    }
    if (successfulSpawn && receivers.length) {
      if (!bound && !nestedParent) errors.push('delegation_parent_thread_unresolved');
      else if (bound) for (const child of receivers) {
        if (codexChildren.has(child)) continue;
        codexChildren.add(child);
        events.push(observation({ provider: 'codex', raw, context, providerDelegationId: child,
          childSessionId: child, kind: 'spawned', state: 'spawned', facts: { birthActor: 'root_session' } }));
      }
    }
    if (bound && (successfulSpawn || ['wait', 'close'].includes(operation))) {
      const states = object(item.agentsStates);
      for (const child of receivers) {
        if (!codexChildren.has(child) || nestedChildren.has(child)) continue;
        const status = lower(object(states[child]).status);
        const state = ({ running: 'running', completed: 'completed', errored: 'failed', interrupted: 'interrupted' })[status];
        if (!state) continue;
        const identity = buildDelegationIdentity({ provider: 'codex', runId: context.runId, providerDelegationId: child });
        if (projector.getState(identity.id) === state) continue;
        events.push(observation({ provider: 'codex', raw, context, providerDelegationId: child,
          childSessionId: child, kind: state, state }));
      }
    }
    if ((bound || nestedParent) && (successfulSpawn || ['wait', 'close'].includes(operation))) {
      const states = object(item.agentsStates);
      for (const child of receivers) {
        if (!nestedChildren.has(child)) continue;
        const status = lower(object(states[child]).status);
        const state = ({ running: 'running', completed: 'completed', errored: 'failed', interrupted: 'interrupted' })[status];
        if (!state) continue;
        const previous = nestedStates.get(child);
        if (state === previous || TERMINAL_STATES.has(previous) || !isDelegationStateTransitionValid(previous, state)) continue;
        const seq = (nestedSeq.get(child) || 1) + 1;
        nestedSeq.set(child, seq);
        nestedStates.set(child, state);
        const candidate = observation({ provider: 'codex', raw, context, providerDelegationId: child,
          parentDelegationId: nestedChildren.get(child), childSessionId: child, kind: state, state });
        const event = normalizeDelegationEvent(candidate, { seq, timestamp: candidate.timestamp });
        const member = memberEventFromDelegation(event, { requested: false, memberIds, operationId: text(item.id) });
        member.barrierParticipation = false;
        delete member.aliases;
        memberEvents.push(member);
      }
    }
    return { events, memberEvents, controls: [control], recognized: true, errors };
  }

  function map(raw) {
    const claudeRequestedIds = new Set(normalizedProvider === 'claude'
      ? readContentBlocks(raw).filter((block) => lower(block?.type) === 'tool_use' && CLAUDE_TASK_NAMES.has(lower(block.name)))
        .map((block) => readProviderDelegationId({ ...block, ...object(block.input) })).filter(Boolean)
      : []);
    const claudeParent = normalizedProvider === 'claude' ? text(raw?.parent_tool_use_id) : '';
    const nestedClaudeEvents = [];
    if (claudeParent && memberIds.has(buildDelegationIdentity({ provider: 'claude', runId: context.runId, providerDelegationId: claudeParent }).id)) {
      const parentId = buildDelegationIdentity({ provider: 'claude', runId: context.runId, providerDelegationId: claudeParent }).id;
      if (!claudeConfirmed.has(claudeParent)) {
        const candidate = observation({ provider: 'claude', raw, context, providerDelegationId: claudeParent,
          parentDelegationId: nestedChildren.get(claudeParent) || '', kind: 'running', state: 'running' });
        const event = normalizeDelegationEvent(candidate, { seq: 2, timestamp: candidate.timestamp });
        const member = memberEventFromDelegation(event, { requested: false, memberIds, operationId: claudeParent });
        if (claudeRootRequests.has(claudeParent)) member.parent = member.actor = { kind: 'root_session', id: context.parentSessionId };
        member.id = `member_confirm_${createHash('sha256').update(JSON.stringify([context.runId, claudeParent])).digest('hex').slice(0, 24)}`;
        member.phase = 'confirmed';
        member.barrierParticipation = false;
        delete member.barrier;
        if (nestedChildren.has(claudeParent)) delete member.aliases;
        claudeConfirmed.add(claudeParent);
        nestedClaudeEvents.push(member);
      }
      for (const block of readContentBlocks(raw)) {
        const resultId = lower(block?.type) === 'tool_result' ? text(block.tool_use_id) : '';
        if (resultId && nestedChildren.get(resultId) === parentId && !TERMINAL_STATES.has(nestedStates.get(resultId))) {
          const failed = block.is_error === true || ['failed', 'error'].includes(lower(block.status));
          const state = failed ? 'failed' : 'completed';
          const candidate = observation({ provider: 'claude', raw, context, providerDelegationId: resultId,
            parentDelegationId: parentId, kind: state, state });
          const event = normalizeDelegationEvent(candidate, { seq: 2, timestamp: candidate.timestamp });
          nestedStates.set(resultId, state);
          const member = memberEventFromDelegation(event, { requested: false, memberIds, operationId: resultId });
          member.barrierParticipation = false;
          delete member.aliases;
          nestedClaudeEvents.push(member);
          continue;
        }
        const id = lower(block?.type) === 'tool_use' && CLAUDE_TASK_NAMES.has(lower(block?.name)) ? text(block.id) : '';
        if (!id || nestedChildren.has(id)) continue;
        const candidate = observation({ provider: 'claude', raw, context, providerDelegationId: id,
          parentDelegationId: parentId, kind: 'spawned', state: 'spawned' });
        const event = normalizeDelegationEvent(candidate, { seq: 1, timestamp: candidate.timestamp });
        nestedChildren.set(id, parentId);
        const member = memberEventFromDelegation(event, { requested: true, memberIds, operationId: id });
        if (member.parent.kind === 'member') member.actor = member.parent;
        member.barrierParticipation = false;
        delete member.aliases;
        nestedClaudeEvents.push(member);
      }
    }
    const mapped = normalizedProvider === 'claude'
      ? (claudeParent ? { events: [], controls: [], recognized: nestedClaudeEvents.length > 0, memberEvents: nestedClaudeEvents }
        : mapClaudeProviderDelegationEvent(raw, context, taskToolUseIds))
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
      if (normalizedProvider === 'claude' && claudeRequestedIds.has(event.providerDelegationId) && !event.parentDelegationId) {
        claudeRootRequests.add(event.providerDelegationId);
      }
    }
    return {
      events,
      memberEvents: [...events.map((event) => {
        const member = memberEventFromDelegation(event, {
        requested: claudeRequestedIds.has(event.providerDelegationId),
        memberIds,
        operationId: normalizedProvider === 'claude' ? event.providerDelegationId : text(readCodexItem(raw).id),
        });
        if (normalizedProvider === 'claude' && claudeRequestedIds.has(event.providerDelegationId) && claudeRootRequests.has(event.providerDelegationId)) {
          member.parent = member.actor = { kind: 'root_session', id: context.parentSessionId };
        }
        return member;
      }), ...(mapped.memberEvents || [])],
      controls: mapped.controls,
      recognized: mapped.recognized,
      ok: errors.length === 0 && projector.isValid(),
      errors: [...errors, ...projector.getErrors()],
    };
  }

  return {
    map,
    memberIdForProviderId(id) {
      return memberIds.get(buildDelegationIdentity({ provider: normalizedProvider, runId: context.runId, providerDelegationId: text(id) }).id) || '';
    },
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

// Stream a run's existing spool through the provider boundary. The caller
// supplies an already-authorized run and reader; raw provider frames never
// leave this adapter. Absence or truncation of the source must be reported by
// the caller rather than represented as a complete empty history.
export function createMemberReader(options = {}) {
  const mapper = createProviderNativeDelegationMapper(options);
  const byId = new Map();
  const memberIds = new Map();
  const childAdapters = new Map();
  const childEntries = new Map();
  let recordSeq = 0;
  let totalChildEntries = 0;
  let gap = false;
  const limit = Math.max(1, Math.min(Number(options.limit) || 8192, 8192));
  const add = (event) => {
    if (!event?.id || event.rootSessionId !== options.parentSessionId || event.runId !== options.runId) return;
    const previous = byId.get(event.id);
    if (previous && previous.phase !== 'unknown') {
      // A persisted normalized event may predate adapter evidence retained in
      // the raw frame. Enrich only the identical event, never infer a parent.
      if (previous.parent?.kind === 'unknown' && ['member', 'root_session'].includes(event.parent?.kind)) {
        byId.set(event.id, { ...previous, parent: event.parent, ...(event.actor ? { actor: event.actor } : {}) });
      }
      return;
    }
    if (!previous && byId.size >= limit) { gap = true; return; }
    byId.set(event.id, event);
  };
  async function consume(records, { sourceVerified = false } = {}) {
    const before = new Set(byId.keys());
    if (!sourceVerified) gap = true;
    for await (const record of records || []) {
    recordSeq += 1;
    let payload = record?.json;
    if (!payload && typeof record?.line === 'string') {
      try { payload = JSON.parse(record.line); } catch { gap = true; continue; }
    }
    if (!payload || typeof payload !== 'object') continue;
    const parentToolId = options.provider === 'claude' ? text(payload.parent_tool_use_id) : '';
    const childMemberId = parentToolId && mapper.memberIdForProviderId(parentToolId);
    if (childMemberId) {
      let adapter = childAdapters.get(childMemberId);
      if (!adapter) { adapter = createClaudeAdapter(); childAdapters.set(childMemberId, adapter); }
      const childPayload = { ...payload };
      delete childPayload.parent_tool_use_id;
      delete childPayload.ragent_intermediate;
      const entries = childEntries.get(childMemberId) || [];
      for (const [index, event] of adapter.parseLine(JSON.stringify(childPayload)).entries()) {
        if (totalChildEntries >= limit) { gap = true; break; }
        const seq = recordSeq * 1000 + index;
        entries.push({ ...event, seq, runId: options.runId, eventId: `captured_${options.runId}_${seq}`,
          ...(record.ts ? { timestamp: record.ts } : {}) });
        totalChildEntries += 1;
      }
      childEntries.set(childMemberId, entries);
    }
    if (payload.type === 'ragent.member_event') { add(payload.event); continue; }
    if (payload.type === 'ragent.delegation_event') {
      const event = payload.event;
      if (event?.provider && event?.providerDelegationId && event?.delegationId)
        add(memberEventFromDelegation(event, { memberIds }));
      continue;
    }
    const mapped = mapper.map(payload);
    for (const event of mapped.memberEvents) add(event);
    if (mapped.errors.length) gap = true;
    }
    return { events: [...byId.values()].filter((event) => !before.has(event.id)), snapshot: [...byId.values()], gap };
  }
  return { consume, snapshot: () => ({ events: [...byId.values()], gap }),
    readCapturedMember: (memberId) => ({ entries: buildSessionDisplayEvents(childEntries.get(memberId) || []),
      scope: 'captured_only', gap, availability: childEntries.has(memberId) ? 'available' : 'unavailable' }) };
}

export async function readProviderMemberEvents(records, options = {}) {
  const reader = createMemberReader(options);
  return reader.consume(records, { sourceVerified: options.sourceVerified === true });
}
