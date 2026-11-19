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
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, posix, relative, resolve, win32 } from 'node:path';
import { createClaudeAdapter } from './claude.mjs';
import { buildSessionDisplayEvents } from '../session-display-events.mjs';
import { messageEvent, toolUseEvent } from '../normalizer.mjs';
import { redactSensitiveText } from '../tool-call-schema.mjs';

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
const AGY_DELEGATION_TOOLS = new Set(['invoke_subagent', 'swarm', 'post_message', 'run_workflow']);
const AGY_READ_ONLY_CONTROL_CAPABILITIES = Object.freeze({
  readOnly: true,
  canControlMember: false,
  canMessageMember: false,
});
const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_AGY_TRANSCRIPT_BYTES = 2 * 1024 * 1024;
const MAX_AGY_BOARD_MESSAGES = 100;
const MAX_AGY_DISK_FILES = 128;

export function canonicalizeNativeDelegationProvider(value) {
  const normalized = lower(value);
  if (!normalized) return '';
  if (normalized === 'antigravity' || normalized === 'agy'
    || normalized.startsWith('agy-') || normalized.startsWith('agy_')) {
    return 'agy';
  }
  if (normalized.includes('claude')) return 'claude';
  if (normalized.includes('codex')) return 'codex';
  return '';
}

function redactAgyText(value, maxLen = 2000) {
  return redactSensitiveText(String(value || ''))
    .replace(/\b(?:sk-ant|sk|pk)-[A-Za-z0-9_-]{12,}\b/g, (match) => `${match.slice(0, 8)}...redacted`)
    .slice(0, maxLen);
}

function parseMaybeObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      } catch {}
    }
  }
  return {};
}

function normalizeBoardChannelName(value) {
  const candidate = lower(value).replace(/^#/, '').replace(/[^a-z0-9._-]/g, '-').slice(0, 64);
  return candidate || 'main';
}

function parseBoardMentions(content) {
  const matches = String(content || '').match(/@(?:#?[A-Za-z0-9][A-Za-z0-9._-]{0,63}|all)\b/g);
  if (!matches) return [];
  return [...new Set(matches)].slice(0, 32);
}

function parseBoardReplySeq(explicitSeq, content) {
  if (Number.isInteger(explicitSeq) && explicitSeq > 0) return explicitSeq;
  const match = /(?:^|\s)#(\d{1,7})\b/.exec(String(content || ''));
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeBoardMessage(entry = {}) {
  const seq = Number.isInteger(entry.seq) && entry.seq > 0 ? entry.seq : 1;
  const channel = normalizeBoardChannelName(entry.channel);
  const body = redactAgyText(text(entry.text), 2000);
  const sender = redactAgyText(text(entry.sender) || 'member', 80) || 'member';
  const kind = text(entry.kind) ? lower(entry.kind).slice(0, 32) : null;
  const replyToSeq = parseBoardReplySeq(entry.replyToSeq, body);
  return {
    seq,
    channel,
    sender,
    ...(text(entry.senderMemberId) ? { senderMemberId: text(entry.senderMemberId) } : { senderMemberId: null }),
    kind,
    text: body,
    mentions: Array.isArray(entry.mentions) ? entry.mentions.slice(0, 32) : parseBoardMentions(body),
    replyToSeq,
    createdAt: entry.createdAt ?? null,
  };
}

export function buildReadOnlyBoardProjection({
  title = null,
  messages = [],
  channels = [],
  source = 'provider_native',
  provider = 'agy',
  totalMessages = null,
  truncated = false,
  gap = false,
} = {}) {
  const channelMap = new Map();
  for (const ch of Array.isArray(channels) ? channels : []) {
    if (!ch) continue;
    const name = normalizeBoardChannelName(typeof ch === 'string' ? ch : ch.name);
    const prev = channelMap.get(name) || { name, topic: null, messageCount: 0, latestSeq: 0 };
    const topic = typeof ch === 'object' && text(ch.topic) ? redactAgyText(text(ch.topic), 200) : prev.topic;
    channelMap.set(name, { ...prev, ...(topic ? { topic } : {}) });
  }
  const normalizedMessages = [];
  for (const rawMsg of Array.isArray(messages) ? messages : []) {
    const msg = normalizeBoardMessage(rawMsg);
    normalizedMessages.push(msg);
    const ch = channelMap.get(msg.channel) || { name: msg.channel, topic: null, messageCount: 0, latestSeq: 0 };
    ch.messageCount += 1;
    if (msg.seq > ch.latestSeq) ch.latestSeq = msg.seq;
    channelMap.set(msg.channel, ch);
  }
  normalizedMessages.sort((a, b) => a.seq - b.seq);
  const cleanTitle = text(title) ? redactAgyText(text(title), 160) : null;
  if (!cleanTitle && normalizedMessages.length === 0 && channelMap.size === 0) return null;
  if (!channelMap.has('main') && (normalizedMessages.length > 0 || cleanTitle)) {
    channelMap.set('main', { name: 'main', topic: null, messageCount: 0, latestSeq: 0 });
  }
  const boundedMessages = normalizedMessages.slice(-MAX_AGY_BOARD_MESSAGES);
  const allCount = Number.isInteger(totalMessages) && totalMessages >= normalizedMessages.length
    ? totalMessages
    : normalizedMessages.length;
  return {
    schemaVersion: 1,
    source,
    provider,
    readOnly: true,
    title: cleanTitle,
    channels: [...channelMap.values()].sort((a, b) => (a.name === 'main' ? -1 : b.name === 'main' ? 1 : a.name.localeCompare(b.name))),
    messages: boundedMessages,
    totalMessages: allCount,
    truncated: Boolean(truncated || normalizedMessages.length > MAX_AGY_BOARD_MESSAGES),
    gap: Boolean(gap),
  };
}

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

function createAgyMapperState(parentThreadId = '') {
  return {
    parentConversationId: text(parentThreadId),
    toolCalls: new Map(),
    toolCallToDelegationId: new Map(),
    subagents: new Map(),
    workflows: new Map(),
    swarmMembers: new Map(),
    confirmedIds: new Set(),
    postedToolCalls: new Set(),
    channelOpsHandled: new Set(),
    modelOpsHandled: new Set(),
    boardChannels: new Map(),
    nextBoardSeq: 0,
    boardTitle: '',
  };
}

function extractAgyOutputText(value) {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    return value
      .map((item) => extractAgyOutputText(item?.content ?? item?.text ?? item))
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  if (value && typeof value === 'object') {
    if (typeof value.text === 'string') return value.text.trim();
    if (value.content !== undefined) return extractAgyOutputText(value.content);
  }
  return '';
}

function parseAgyToolFrame(raw, state) {
  const inputRaw = object(raw);
  if (inputRaw.ragent_intermediate === true) return null;

  if (lower(inputRaw.event) === 'init') {
    const convId = firstString(
      inputRaw.conversation_id,
      inputRaw.conversationId,
      inputRaw.init?.conversation_id,
      inputRaw.init?.conversationId,
    );
    if (convId && state && !state.parentConversationId) state.parentConversationId = convId;
    return null;
  }

  if (inputRaw.method === 'session/update' && inputRaw.params && typeof inputRaw.params === 'object') {
    const update = object(inputRaw.params.update);
    const sessionUpdate = lower(update.sessionUpdate);
    if (sessionUpdate !== 'tool_call' && sessionUpdate !== 'tool_call_update') return null;
    const rawName = lower(firstString(update.name, update.toolName, update.tool_name, update.tool?.name));
    let toolName = rawName;
    if (!toolName) {
      const titleMatch = /^run\s+(invoke_subagent|swarm|post_message|run_workflow)$/i.exec(text(update.title));
      if (titleMatch) toolName = lower(titleMatch[1]);
    }
    if (!AGY_DELEGATION_TOOLS.has(toolName)) return null;
    const toolCallId = firstString(update.toolCallId, update.tool_call_id, update.id);
    const status = lower(firstString(update.status, update.state));
    const terminalStatus = ['completed', 'done', 'success', 'failed', 'error', 'cancelled', 'canceled'].includes(status);
    const phase = sessionUpdate === 'tool_call' && !terminalStatus
      ? 'start'
      : terminalStatus
        ? 'end'
        : 'start';
    const failed = ['failed', 'error'].includes(status) || Boolean(update.error || update.is_error);
    const cancelled = ['cancelled', 'canceled'].includes(status);
    const input = firstObject(
      parseMaybeObject(update.rawInput),
      parseMaybeObject(update.args),
      parseMaybeObject(update.input),
      parseMaybeObject(update.parameters),
    );
    const rawOutputValue = update.rawOutput ?? update.output ?? update.result ?? update.content;
    const output = parseMaybeObject(
      typeof rawOutputValue === 'string' ? rawOutputValue : (rawOutputValue ?? extractAgyOutputText(update.content)),
    );
    const frameSessionId = firstString(
      inputRaw.params.sessionId,
      update.sessionId,
      update.conversation_id,
      update.conversationId,
    );
    return { toolName, toolCallId, phase, status, failed, cancelled, input, output, frameSessionId };
  }

  if (lower(inputRaw.event) === 'step_update' && inputRaw.step_update && typeof inputRaw.step_update === 'object') {
    const update = object(inputRaw.step_update);
    if (lower(update.step_type) !== 'tool') return null;
    const toolInfo = object(update.tool_info);
    const toolName = lower(firstString(update.tool_name, update.name, toolInfo.name, toolInfo.tool_name, toolInfo.toolName));
    if (!AGY_DELEGATION_TOOLS.has(toolName)) return null;
    const stepIndex = Number.isInteger(update.step_index) ? String(update.step_index) : '';
    const toolCallId = firstString(
      update.toolCallId,
      update.tool_call_id,
      toolInfo.toolCallId,
      toolInfo.id,
      stepIndex ? `step:${stepIndex}` : '',
    );
    const stepState = lower(update.state);
    const toolStatus = lower(toolInfo.status);
    const phase = ['done', 'completed', 'success', 'error', 'failed', 'cancelled', 'canceled'].includes(stepState)
      ? 'end'
      : 'start';
    const failed = ['error', 'failed'].includes(stepState)
      || ['error', 'failed'].includes(toolStatus)
      || Boolean(toolInfo.error ?? update.error);
    const cancelled = ['cancelled', 'canceled'].includes(stepState) || ['cancelled', 'canceled'].includes(toolStatus);
    const input = firstObject(
      parseMaybeObject(toolInfo.parameters),
      parseMaybeObject(toolInfo.arguments),
      parseMaybeObject(toolInfo.args),
      parseMaybeObject(toolInfo.input),
      parseMaybeObject(update.parameters),
      parseMaybeObject(update.args),
      parseMaybeObject(update.input),
    );
    const output = parseMaybeObject(toolInfo.output ?? toolInfo.result ?? update.output ?? update.result);
    const frameSessionId = firstString(
      update.conversation_id,
      update.conversationId,
      inputRaw.conversation_id,
      inputRaw.conversationId,
    );
    return { toolName, toolCallId, phase, status: stepState || toolStatus, failed, cancelled, input, output, frameSessionId };
  }

  return null;
}

function findKnownAgyMemberDelegationId(state, refValue, runId) {
  const ref = text(refValue);
  if (!ref || !state) return '';
  if (ref.startsWith('delg_')) return ref;
  const swarmEntry = state.swarmMembers.get(ref);
  if (swarmEntry) {
    return buildDelegationIdentity({ provider: 'agy', runId, providerDelegationId: swarmEntry.providerDelegationId }).id;
  }
  for (const [key, info] of state.subagents.entries()) {
    if (key === ref || info.childSessionId === ref) {
      return buildDelegationIdentity({ provider: 'agy', runId, providerDelegationId: key }).id;
    }
  }
  for (const [, info] of state.swarmMembers.entries()) {
    if (info.childSessionId && info.childSessionId === ref) {
      return buildDelegationIdentity({ provider: 'agy', runId, providerDelegationId: info.providerDelegationId }).id;
    }
  }
  return '';
}

function resolveAgyParentInfo(raw, frame, context, state) {
  const input = frame.input || {};
  const explicitParentRef = firstString(
    input.parentDelegationId,
    input.parent_delegation_id,
    input.parentMember,
    input.parent_member,
    input.parentConversationId,
    input.parent_conversation_id,
    raw?.parentDelegationId,
    raw?.parent_delegation_id,
  );
  if (explicitParentRef) {
    const knownMember = findKnownAgyMemberDelegationId(state, explicitParentRef, context.runId);
    if (knownMember) {
      return { parentKind: 'member', parentDelegationId: knownMember, isRoot: false };
    }
    if (state?.parentConversationId && explicitParentRef === state.parentConversationId) {
      return { parentKind: 'root_session', parentDelegationId: '', isRoot: true };
    }
    // Explicit parent supplied that does not match root or any verified child: stay unknown.
    return { parentKind: 'unknown', parentDelegationId: '', isRoot: false };
  }
  const frameSession = frame.frameSessionId;
  if (frameSession && state?.parentConversationId && frameSession !== state.parentConversationId) {
    const knownChild = findKnownAgyMemberDelegationId(state, frameSession, context.runId);
    if (knownChild) {
      return { parentKind: 'member', parentDelegationId: knownChild, isRoot: false };
    }
    return { parentKind: 'unknown', parentDelegationId: '', isRoot: false };
  }
  if (frameSession && state && !state.parentConversationId) {
    state.parentConversationId = frameSession;
  }
  return { parentKind: 'root_session', parentDelegationId: '', isRoot: true };
}

function buildAgyMemberEvent({
  raw,
  context,
  providerDelegationId,
  parentInfo,
  phase,
  state,
  seq,
  childSessionId = '',
  operationId = '',
  displayName = '',
  role = '',
  model = '',
  barrierParticipation = false,
  memberIds = new Map(),
}) {
  const runId = text(context.runId);
  const parentSessionId = text(context.parentSessionId);
  const timestamp = readTimestamp(raw, context) || seq;
  const identity = buildDelegationIdentity({ provider: 'agy', runId, providerDelegationId });
  const memberId = memberIds.get(identity.id) || `member_${createHash('sha256').update(JSON.stringify([
    parentSessionId, 'agy', runId, providerDelegationId,
  ])).digest('hex').slice(0, 24)}`;
  memberIds.set(identity.id, memberId);

  let parent = { kind: 'unknown' };
  let actor = null;
  if (parentInfo?.parentKind === 'member' && parentInfo.parentDelegationId) {
    const parentMemberId = memberIds.get(parentInfo.parentDelegationId);
    if (parentMemberId) {
      parent = { kind: 'member', id: parentMemberId };
      actor = parent;
    }
  } else if (parentInfo?.isRoot && parentSessionId) {
    parent = { kind: 'root_session', id: parentSessionId };
    actor = parent;
  }

  const eventId = `member_${createHash('sha256').update(JSON.stringify([
    runId, providerDelegationId, phase, state, seq,
  ])).digest('hex').slice(0, 24)}`;

  return {
    version: 1,
    id: eventId,
    memberId,
    rootSessionId: parentSessionId,
    runId,
    sourceTag: 'agy',
    executionHarnessId: 'agy',
    parent,
    ...(actor ? { actor } : {}),
    phase,
    state,
    ...(childSessionId ? { providerRef: { kind: 'external_thread', id: childSessionId } } : {}),
    ...(operationId ? { operationId } : {}),
    ...(displayName ? { displayName: redactAgyText(displayName, 120) } : {}),
    ...(role ? { role: redactAgyText(role, 64) } : {}),
    ...(model ? { model: redactAgyText(model, 80) } : {}),
    controlCapabilities: AGY_READ_ONLY_CONTROL_CAPABILITIES,
    seq,
    timestamp,
    barrierParticipation,
  };
}

function expandAgySwarmWorkerNames(input, toolCallId) {
  const baseName = text(input.name);
  if (Array.isArray(input.tasks) && input.tasks.length > 0) {
    const prefix = baseName || 'worker';
    return input.tasks.map((_, index) => `${prefix}-${index + 1}`);
  }
  const n = Number(input.n);
  if (Number.isInteger(n) && n > 1 && n <= 64) {
    const prefix = baseName || 'worker';
    return Array.from({ length: n }, (_, index) => `${prefix}-${index + 1}`);
  }
  if (baseName) return [baseName];
  return toolCallId ? [toolCallId] : [];
}

function resolveAgySwarmChildSessionId(output, workerName, index) {
  const direct = firstString(
    output.conversation_id,
    output.conversationId,
    output.childSessionId,
    output.child_session_id,
    output.sessionId,
  );
  if (direct && index === 0) return direct;
  const list = Array.isArray(output.members) ? output.members : Array.isArray(output.workers) ? output.workers : [];
  const matched = list.find((entry) => entry && text(entry.name) === workerName) || list[index];
  return firstString(matched?.conversation_id, matched?.conversationId, matched?.sessionId);
}

function mapAgy(raw, context = {}, agyState = null, memberIds = new Map()) {
  const state = agyState || createAgyMapperState(context.parentThreadId);
  const frame = parseAgyToolFrame(raw, state);
  if (!frame) {
    return { events: [], memberEvents: [], controls: [], boardEvents: [], recognized: false };
  }

  const cached = frame.toolCallId ? state.toolCalls.get(frame.toolCallId) : null;
  const mergedInput = { ...(cached?.input || {}), ...frame.input };
  const resolvedFrame = { ...frame, input: mergedInput };
  const parentInfo = cached?.parentInfo || resolveAgyParentInfo(raw, resolvedFrame, context, state);
  if (frame.phase === 'start' && frame.toolCallId) {
    state.toolCalls.set(frame.toolCallId, { toolName: frame.toolName, input: mergedInput, parentInfo });
  } else if (frame.phase === 'end' && frame.toolCallId) {
    state.toolCalls.delete(frame.toolCallId);
  }

  const events = [];
  const memberEvents = [];
  const controls = [];
  const boardEvents = [];
  const nextMemberSeq = (rec) => {
    rec.memberSeq = (rec.memberSeq || 0) + 1;
    return rec.memberSeq;
  };

  if (frame.toolName === 'invoke_subagent' || frame.toolName === 'run_workflow') {
    const isWorkflow = frame.toolName === 'run_workflow';
    const defaultId = isWorkflow
      ? `workflow:${frame.toolCallId || firstString(mergedInput.Description, mergedInput.description, 'workflow')}`
      : firstString(mergedInput.subagent_id, mergedInput.delegationId, frame.output.subagent_id, frame.toolCallId);
    const providerDelegationId = (frame.toolCallId && state.toolCallToDelegationId.get(frame.toolCallId)) || defaultId;
    if (!providerDelegationId) {
      return { events: [], memberEvents: [], controls: [], boardEvents: [], recognized: true };
    }
    if (frame.toolCallId) state.toolCallToDelegationId.set(frame.toolCallId, providerDelegationId);

    const store = isWorkflow ? state.workflows : state.subagents;
    const rawSubagentName = isWorkflow
      ? firstString(mergedInput.Description, mergedInput.description, 'Workflow')
      : firstString(
        mergedInput.SubagentName,
        mergedInput.subagentName,
        mergedInput.name,
        mergedInput.Name,
        mergedInput.role,
        mergedInput.Role,
        mergedInput.subagent_type,
        mergedInput.subagentType,
        mergedInput.SubagentType,
        'Subagent',
      );
    const rawSubagentRole = isWorkflow
      ? 'workflow'
      : firstString(
        mergedInput.role,
        mergedInput.Role,
        mergedInput.subagent_type,
        mergedInput.subagentType,
        mergedInput.SubagentType,
        mergedInput.SubagentName,
        mergedInput.subagentName,
        mergedInput.name,
        mergedInput.Name,
        'subagent',
      );
    const rec = store.get(providerDelegationId) || {
      spawned: false,
      terminal: false,
      childSessionId: '',
      parentInfo,
      memberSeq: 0,
      displayName: rawSubagentName,
      role: rawSubagentRole,
    };
    const observedChildId = firstString(
      frame.output.conversation_id,
      frame.output.conversationId,
      frame.output.ConversationId,
      frame.output.childSessionId,
      frame.output.subagent_id,
      frame.output.subagentId,
      frame.output.sessionId,
      mergedInput.conversation_id,
      mergedInput.conversationId,
      mergedInput.ConversationId,
    );
    if (observedChildId) rec.childSessionId = observedChildId;
    store.set(providerDelegationId, rec);

    if (!rec.spawned) {
      rec.spawned = true;
      const spawnObs = observation({
        provider: 'agy',
        raw,
        context,
        providerDelegationId,
        kind: 'spawned',
        state: 'spawned',
        childSessionId: rec.childSessionId,
        parentDelegationId: parentInfo.parentKind === 'member' ? parentInfo.parentDelegationId : '',
        facts: parentInfo.isRoot ? { birthActor: 'root_session' } : undefined,
      });
      if (spawnObs) events.push(spawnObs);
    }

    if (frame.phase === 'end' && !rec.terminal) {
      const outputStatus = lower(firstString(frame.output.status, frame.output.state));
      const asyncOngoing = !frame.failed && !frame.cancelled && (
        ['added', 'running', 'spawned', 'alive', 'in_progress', 'background', 'backgrounded', 'started'].includes(outputStatus)
        || frame.output.async === true
        || frame.output.background === true
        || frame.output.backgrounded === true
      );
      const targetState = frame.cancelled ? 'cancelled' : frame.failed ? 'failed' : asyncOngoing ? 'running' : 'completed';
      if (!asyncOngoing) rec.terminal = true;
      const reasonKind = frame.failed
        ? 'provider_error'
        : frame.cancelled
          ? 'provider_cancelled'
          : 'provider_result';
      const endObs = observation({
        provider: 'agy',
        raw,
        context,
        providerDelegationId,
        kind: targetState,
        state: targetState,
        childSessionId: rec.childSessionId,
        parentDelegationId: parentInfo.parentKind === 'member' ? parentInfo.parentDelegationId : '',
        facts: TERMINAL_STATES.has(targetState) ? { candidate: { outcome: targetState, reasonKind } } : undefined,
      });
      if (endObs) events.push(endObs);
      if (!state.confirmedIds.has(providerDelegationId)) {
        state.confirmedIds.add(providerDelegationId);
        memberEvents.push(buildAgyMemberEvent({
          raw,
          context,
          providerDelegationId,
          parentInfo: rec.parentInfo,
          phase: 'confirmed',
          state: targetState,
          seq: nextMemberSeq(rec),
          childSessionId: rec.childSessionId,
          operationId: frame.toolCallId || providerDelegationId,
          displayName: rec.displayName,
          role: rec.role,
          barrierParticipation: false,
          memberIds,
        }));
      }
    } else if (frame.phase === 'start' && rec.childSessionId) {
      state.confirmedIds.add(providerDelegationId);
    }
    rec.lastOperationId = frame.toolCallId || providerDelegationId;
    rec.requestedOnStart = !rec.childSessionId && frame.phase === 'start';

    return { events, memberEvents, controls, boardEvents, recognized: true };
  }

  if (frame.toolName === 'swarm') {
    const action = lower(firstString(mergedInput.action, frame.output.action));
    if (action === 'add') {
      const workerNames = expandAgySwarmWorkerNames(mergedInput, frame.toolCallId);
      const role = firstString(mergedInput.role, 'worker');
      const model = firstString(mergedInput.model, frame.output.model);
      controls.push({
        type: 'delegation_control',
        control: 'swarm_add',
        provider: 'agy',
        members: workerNames,
        runId: text(context.runId),
      });
      workerNames.forEach((workerName, index) => {
        const providerDelegationId = `swarm:${workerName}`;
        const rec = state.swarmMembers.get(workerName) || {
          providerDelegationId,
          childSessionId: '',
          parentInfo,
          requested: false,
          confirmed: false,
          terminal: false,
          state: 'unknown',
          role,
          model,
          memberSeq: 0,
        };
        const childSessionId = resolveAgySwarmChildSessionId(frame.output, workerName, index);
        if (childSessionId) rec.childSessionId = childSessionId;
        if (model) rec.model = model;
        state.swarmMembers.set(workerName, rec);

        if (frame.phase === 'start' && !rec.requested && !rec.confirmed) {
          rec.requested = true;
          memberEvents.push(buildAgyMemberEvent({
            raw,
            context,
            providerDelegationId,
            parentInfo: rec.parentInfo,
            phase: 'requested',
            state: 'unknown',
            seq: nextMemberSeq(rec),
            childSessionId: rec.childSessionId,
            operationId: frame.toolCallId || providerDelegationId,
            displayName: workerName,
            role: rec.role,
            model: rec.model,
            barrierParticipation: false,
            memberIds,
          }));
        } else if (frame.phase === 'end' && !rec.terminal) {
          if (frame.failed || frame.cancelled) {
            rec.terminal = true;
            rec.state = frame.cancelled ? 'cancelled' : 'failed';
            memberEvents.push(buildAgyMemberEvent({
              raw,
              context,
              providerDelegationId,
              parentInfo: rec.parentInfo,
              phase: 'terminal',
              state: rec.state,
              seq: nextMemberSeq(rec),
              childSessionId: rec.childSessionId,
              operationId: frame.toolCallId || providerDelegationId,
              displayName: workerName,
              role: rec.role,
              model: rec.model,
              barrierParticipation: false,
              memberIds,
            }));
          } else if (!rec.confirmed) {
            rec.confirmed = true;
            rec.state = 'running';
            state.confirmedIds.add(providerDelegationId);
            memberEvents.push(buildAgyMemberEvent({
              raw,
              context,
              providerDelegationId,
              parentInfo: rec.parentInfo,
              phase: 'confirmed',
              state: 'running',
              seq: nextMemberSeq(rec),
              childSessionId: rec.childSessionId,
              operationId: frame.toolCallId || providerDelegationId,
              displayName: workerName,
              role: rec.role,
              model: rec.model,
              barrierParticipation: false,
              memberIds,
            }));
          }
        }
      });
      return { events, memberEvents, controls, boardEvents, recognized: true };
    }

    const getOrCreateActiveSwarmRec = (workerName) => {
      const providerDelegationId = `swarm:${workerName}`;
      const rec = state.swarmMembers.get(workerName) || {
        providerDelegationId,
        childSessionId: '',
        parentInfo,
        requested: true,
        confirmed: true,
        terminal: false,
        state: 'running',
        role: 'worker',
        model: '',
        memberSeq: 0,
      };
      state.swarmMembers.set(workerName, rec);
      return rec;
    };

    if (action === 'kill') {
      const workerName = firstString(mergedInput.name, frame.output.name);
      controls.push({
        type: 'delegation_control',
        control: 'swarm_kill',
        provider: 'agy',
        ...(workerName ? { memberName: workerName } : {}),
        runId: text(context.runId),
      });
      if (workerName && !frame.failed && !frame.cancelled && (frame.phase === 'end' || !frame.toolCallId)) {
        const rec = getOrCreateActiveSwarmRec(workerName);
        if (!rec.terminal) {
          rec.terminal = true;
          rec.state = 'cancelled';
          if (!state.confirmedIds.has(rec.providerDelegationId)) {
            state.confirmedIds.add(rec.providerDelegationId);
            memberEvents.push(buildAgyMemberEvent({
              raw,
              context,
              providerDelegationId: rec.providerDelegationId,
              parentInfo: rec.parentInfo,
              phase: 'confirmed',
              state: 'running',
              seq: nextMemberSeq(rec),
              childSessionId: rec.childSessionId,
              operationId: frame.toolCallId || rec.providerDelegationId,
              displayName: workerName,
              role: rec.role,
              model: rec.model,
              barrierParticipation: false,
              memberIds,
            }));
          }
          memberEvents.push(buildAgyMemberEvent({
            raw,
            context,
            providerDelegationId: rec.providerDelegationId,
            parentInfo: rec.parentInfo,
            phase: 'terminal',
            state: 'cancelled',
            seq: nextMemberSeq(rec),
            childSessionId: rec.childSessionId,
            operationId: frame.toolCallId || rec.providerDelegationId,
            displayName: workerName,
            role: rec.role,
            model: rec.model,
            barrierParticipation: false,
            memberIds,
          }));
        }
      }
      return { events, memberEvents, controls, boardEvents, recognized: true };
    }

    if (action === 'model') {
      const workerName = firstString(mergedInput.name, frame.output.name);
      const model = firstString(mergedInput.model, frame.output.model);
      const opKey = frame.toolCallId ? `${frame.toolCallId}:model` : '';
      const alreadyHandled = opKey && state.modelOpsHandled.has(opKey);
      if (opKey && frame.phase === 'end') state.modelOpsHandled.add(opKey);
      controls.push({
        type: 'delegation_control',
        control: 'swarm_model',
        provider: 'agy',
        ...(workerName ? { memberName: workerName } : {}),
        ...(model ? { model } : {}),
        runId: text(context.runId),
      });
      if (!alreadyHandled && workerName && !frame.failed && !frame.cancelled && (frame.phase === 'end' || !frame.toolCallId)) {
        const rec = getOrCreateActiveSwarmRec(workerName);
        if (model) rec.model = model;
        const activeState = rec.state === 'unknown' ? 'running' : rec.state;
        if (!state.confirmedIds.has(rec.providerDelegationId)) {
          state.confirmedIds.add(rec.providerDelegationId);
          memberEvents.push(buildAgyMemberEvent({
            raw,
            context,
            providerDelegationId: rec.providerDelegationId,
            parentInfo: rec.parentInfo,
            phase: 'confirmed',
            state: activeState,
            seq: nextMemberSeq(rec),
            childSessionId: rec.childSessionId,
            operationId: frame.toolCallId || rec.providerDelegationId,
            displayName: workerName,
            role: rec.role,
            model: rec.model,
            barrierParticipation: false,
            memberIds,
          }));
        }
        memberEvents.push(buildAgyMemberEvent({
          raw,
          context,
          providerDelegationId: rec.providerDelegationId,
          parentInfo: rec.parentInfo,
          phase: 'updated',
          state: activeState,
          seq: nextMemberSeq(rec),
          childSessionId: rec.childSessionId,
          operationId: frame.toolCallId || rec.providerDelegationId,
          displayName: workerName,
          role: rec.role,
          model: rec.model,
          barrierParticipation: false,
          memberIds,
        }));
      }
      return { events, memberEvents, controls, boardEvents, recognized: true };
    }

    if (action === 'channel') {
      const channelName = normalizeBoardChannelName(firstString(mergedInput.channel, mergedInput.name, frame.output.channel));
      const topic = text(mergedInput.topic) ? redactAgyText(text(mergedInput.topic), 200) : null;
      const opKey = frame.toolCallId || `channel:${channelName}`;
      if (!state.channelOpsHandled.has(opKey) && !frame.failed && !frame.cancelled) {
        if (frame.phase === 'end' || !frame.toolCallId) {
          state.channelOpsHandled.add(opKey);
          const existing = state.boardChannels.get(channelName) || { name: channelName, topic: null, messageCount: 0, latestSeq: 0 };
          state.boardChannels.set(channelName, { ...existing, ...(topic ? { topic } : {}) });
          boardEvents.push({ kind: 'channel', channel: channelName, topic });
        }
      }
      controls.push({
        type: 'delegation_control',
        control: 'swarm_channel',
        provider: 'agy',
        channel: channelName,
        runId: text(context.runId),
      });
      return { events, memberEvents, controls, boardEvents, recognized: true };
    }

    if (action === 'title') {
      const title = text(firstString(mergedInput.title, frame.output.title));
      const cleanTitle = title ? redactAgyText(title, 160) : '';
      if (cleanTitle && !frame.failed && !frame.cancelled) {
        state.boardTitle = cleanTitle;
        boardEvents.push({ kind: 'title', title: cleanTitle });
      }
      controls.push({
        type: 'delegation_control',
        control: 'swarm_title',
        provider: 'agy',
        ...(cleanTitle ? { title: cleanTitle } : {}),
        runId: text(context.runId),
      });
      return { events, memberEvents, controls, boardEvents, recognized: true };
    }

    controls.push({
      type: 'delegation_control',
      control: action ? `swarm_${action}` : 'swarm_status',
      provider: 'agy',
      runId: text(context.runId),
    });
    return { events, memberEvents, controls, boardEvents, recognized: true };
  }

  if (frame.toolName === 'post_message') {
    const channelName = normalizeBoardChannelName(firstString(mergedInput.channel, frame.output.channel, 'main'));
    controls.push({
      type: 'delegation_control',
      control: 'post_message',
      provider: 'agy',
      channel: channelName,
      runId: text(context.runId),
    });
    if (frame.phase === 'end' && !frame.failed && !frame.cancelled) {
      const opKey = frame.toolCallId || `post:${state.nextBoardSeq + 1}`;
      if (!state.postedToolCalls.has(opKey)) {
        state.postedToolCalls.add(opKey);
        const body = firstString(mergedInput.text, mergedInput.message, mergedInput.body, frame.output.text);
        if (body) {
          const explicitSeq = Number(frame.output.seq);
          const seq = Number.isInteger(explicitSeq) && explicitSeq > 0
            ? explicitSeq
            : (state.nextBoardSeq += 1);
          if (seq > state.nextBoardSeq) state.nextBoardSeq = seq;
          const sender = firstString(
            mergedInput.sender,
            mergedInput.agent,
            mergedInput.from,
            frame.output.agent,
            parentInfo.isRoot ? 'coordinator' : 'member',
          );
          const msg = normalizeBoardMessage({
            seq,
            channel: channelName,
            sender,
            senderMemberId: parentInfo.parentKind === 'member' ? (memberIds.get(parentInfo.parentDelegationId) || null) : null,
            kind: firstString(mergedInput.kind, frame.output.kind) || 'post',
            text: body,
            replyToSeq: Number.isInteger(mergedInput.replyToSeq ?? mergedInput.reply_to_seq)
              ? (mergedInput.replyToSeq ?? mergedInput.reply_to_seq)
              : null,
            createdAt: readTimestamp(raw, context) || null,
          });
          boardEvents.push({ kind: 'message', message: msg });
        }
      }
    }
    return { events, memberEvents, controls, boardEvents, recognized: true };
  }

  return { events, memberEvents, controls, boardEvents, recognized: false };
}

export function mapAgyProviderDelegationEvent(raw, context = {}, agyState = null) {
  return mapAgy(object(raw), context, agyState);
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
  const normalizedProvider = canonicalizeNativeDelegationProvider(provider) || lower(provider);
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
  const agyState = createAgyMapperState(parentThreadId);

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
        : normalizedProvider === 'agy'
          ? mapAgy(object(raw), context, agyState, memberIds)
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
      if (normalizedProvider === 'claude' && Object.hasOwn(raw, 'parent_tool_use_id') && raw.parent_tool_use_id === null &&
          claudeRequestedIds.has(event.providerDelegationId) && !event.parentDelegationId) {
        claudeRootRequests.add(event.providerDelegationId);
      }
    }
    const mappedMembersFromEvents = events.map((event) => {
      const agyRecord = normalizedProvider === 'agy'
        ? (agyState.subagents.get(event.providerDelegationId) || agyState.workflows.get(event.providerDelegationId) || null)
        : null;
      const member = memberEventFromDelegation(event, {
        requested: normalizedProvider === 'agy'
          ? (agyRecord ? Boolean(agyRecord.requestedOnStart && event.kind === 'spawned') : null)
          : claudeRequestedIds.has(event.providerDelegationId),
        memberIds,
        operationId: normalizedProvider === 'claude'
          ? event.providerDelegationId
          : normalizedProvider === 'agy'
            ? (agyRecord?.lastOperationId || event.providerDelegationId)
            : text(readCodexItem(raw).id),
      });
      if (normalizedProvider === 'claude' && claudeRequestedIds.has(event.providerDelegationId) && claudeRootRequests.has(event.providerDelegationId)) {
        member.parent = member.actor = { kind: 'root_session', id: context.parentSessionId };
      }
      if (normalizedProvider === 'agy') {
        if (agyRecord?.displayName) member.displayName = redactAgyText(agyRecord.displayName, 120);
        if (agyRecord?.role) member.role = redactAgyText(agyRecord.role, 64);
        member.controlCapabilities = AGY_READ_ONLY_CONTROL_CAPABILITIES;
      }
      return member;
    });
    return {
      events,
      memberEvents: normalizedProvider === 'agy'
        ? [...(mapped.memberEvents || []), ...mappedMembersFromEvents]
        : [...mappedMembersFromEvents, ...(mapped.memberEvents || [])],
      controls: mapped.controls || [],
      boardEvents: mapped.boardEvents || [],
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
        memberEvents: mapped.flatMap((result) => result.memberEvents || []),
        controls: mapped.flatMap((result) => result.controls || []),
        boardEvents: mapped.flatMap((result) => result.boardEvents || []),
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

function isSafeSegment(segment) {
  return typeof segment === 'string' && SAFE_SEGMENT_PATTERN.test(segment) && segment !== '.' && segment !== '..';
}

function isWithinRoot(rootReal, targetReal) {
  const rel = relative(rootReal, targetReal);
  return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel);
}

const MAX_AGY_APPDATA_REL_SEGMENTS = 6;

function isAnyAbsolutePath(value) {
  return Boolean(value) && (
    isAbsolute(value)
    || posix.isAbsolute(value)
    || win32.isAbsolute(value)
    || /^[A-Za-z]:/.test(value)
    || value.startsWith('/')
    || value.startsWith('\\')
  );
}

function parseSafeRelativeAppDataSegments(rawPath) {
  const raw = text(rawPath);
  if (!raw || raw.includes('\0') || isAnyAbsolutePath(raw)) return null;
  const trimmed = raw.replace(/[\\/]+$/, '');
  if (!trimmed) return null;
  const segments = trimmed.split(/[\\/]+/);
  if (segments.length === 0 || segments.length > MAX_AGY_APPDATA_REL_SEGMENTS) return null;
  if (segments.some((seg) => !isSafeSegment(seg))) return null;
  return segments;
}

function resolveRelativeDirWithinBase(baseDir, segments) {
  try {
    if (!existsSync(baseDir)) return '';
    const baseSt = lstatSync(baseDir);
    if (baseSt.isSymbolicLink() || !baseSt.isDirectory()) return '';
    const baseReal = realpathSync(baseDir);
    let cur = baseReal;
    for (const seg of segments) {
      cur = join(cur, seg);
      if (!existsSync(cur)) return '';
      const st = lstatSync(cur);
      if (st.isSymbolicLink() || !st.isDirectory()) return '';
      const curReal = realpathSync(cur);
      if (!isWithinRoot(baseReal, curReal)) return '';
    }
    return cur;
  } catch {
    return '';
  }
}

function verifyBrainDir(appDataDir) {
  if (!appDataDir) return null;
  const brainDir = join(appDataDir, 'brain');
  try {
    if (!existsSync(brainDir)) return null;
    const st = lstatSync(brainDir);
    if (st.isSymbolicLink() || !st.isDirectory()) return null;
    return { brainReal: realpathSync(brainDir) };
  } catch {
    return null;
  }
}

function resolveVerifiedAgyBrainRoot(options = {}) {
  const sessionStorageDir = text(options.agySessionStorageDir);
  const explicitAppData = text(options.agyAppDataDir || options.appDataDir);
  const explicitRelAppData = text(options.agyAppDataRelDir || options.appDataRelDir);
  const geminiDir = text(options.agyGeminiDir || options.geminiDir);
  const hasExplicitAppDataName = Boolean(text(options.appDataDirName));
  const appDataName = text(options.appDataDirName) || 'antigravity-cli';
  const agyHomeDir = text(options.agyHomeDir);

  const baseGeminiDir = geminiDir
    ? (isAnyAbsolutePath(geminiDir) ? resolve(geminiDir) : '')
    : (agyHomeDir && isAnyAbsolutePath(agyHomeDir) ? resolve(agyHomeDir, '.gemini') : '');

  if (sessionStorageDir) {
    if (!isAnyAbsolutePath(sessionStorageDir)) return null;
    const verified = verifyBrainDir(resolve(sessionStorageDir));
    if (verified) return verified;
  }

  if (explicitAppData) {
    if (isAnyAbsolutePath(explicitAppData)) {
      const verified = verifyBrainDir(resolve(explicitAppData));
      if (verified) return verified;
    } else {
      const segments = parseSafeRelativeAppDataSegments(explicitAppData);
      if (!segments || !baseGeminiDir) return null;
      const verified = verifyBrainDir(resolveRelativeDirWithinBase(baseGeminiDir, segments));
      if (verified) return verified;
    }
  }

  if (explicitRelAppData) {
    const segments = parseSafeRelativeAppDataSegments(explicitRelAppData);
    if (!segments || !baseGeminiDir) return null;
    const verified = verifyBrainDir(resolveRelativeDirWithinBase(baseGeminiDir, segments));
    if (verified) return verified;
  }

  const defaultSegments = parseSafeRelativeAppDataSegments(appDataName);
  if (!defaultSegments) return null;
  if (hasExplicitAppDataName || (!sessionStorageDir && !explicitAppData && !explicitRelAppData)) {
    if (!baseGeminiDir) return null;
    const verified = verifyBrainDir(resolveRelativeDirWithinBase(baseGeminiDir, defaultSegments));
    if (verified) return verified;
  }

  return null;
}

const TRUSTED_LITERAL_SEGMENTS = new Set(['.system_generated', 'subagents', 'swarm', 'logs', 'members.json', 'swarm.json', 'board.jsonl', 'transcript.jsonl']);

function safePathWithinRoot(rootReal, segments, { expectDir = false } = {}) {
  if (!rootReal || !Array.isArray(segments) || segments.length === 0) return { ok: false, reason: 'invalid' };
  let cur = rootReal;
  for (let index = 0; index < segments.length; index += 1) {
    const seg = segments[index];
    if (!TRUSTED_LITERAL_SEGMENTS.has(seg) && !isSafeSegment(seg)) {
      return { ok: false, reason: 'unsafe_segment' };
    }
    cur = join(cur, seg);
    let lst;
    try {
      lst = lstatSync(cur);
    } catch (error) {
      return { ok: false, reason: error?.code === 'ENOENT' ? 'missing' : 'error' };
    }
    if (lst.isSymbolicLink()) return { ok: false, reason: 'symlink_escape' };
    const isLast = index === segments.length - 1;
    if ((!isLast || expectDir) && !lst.isDirectory()) return { ok: false, reason: 'not_dir' };
    if (isLast && !expectDir && !lst.isFile()) return { ok: false, reason: 'not_file' };
    try {
      const real = realpathSync(cur);
      if (!isWithinRoot(rootReal, real)) return { ok: false, reason: 'path_escape' };
    } catch {
      return { ok: false, reason: 'error' };
    }
  }
  try {
    const finalReal = realpathSync(cur);
    const st = lstatSync(finalReal);
    return { ok: true, realPath: finalReal, stat: st };
  } catch {
    return { ok: false, reason: 'error' };
  }
}

function readVerifiedJsonFile(brainReal, segments) {
  const checked = safePathWithinRoot(brainReal, segments);
  if (!checked.ok) return checked;
  if (checked.stat.size > MAX_AGY_TRANSCRIPT_BYTES) return { ok: false, reason: 'too_large' };
  try {
    const parsed = JSON.parse(readFileSync(checked.realPath, 'utf8'));
    return { ok: true, data: parsed };
  } catch {
    return { ok: false, reason: 'corrupt_json' };
  }
}

function mapAgySubagentDiskState(rawState) {
  const state = lower(rawState);
  if (state.includes('alive') || state.includes('running')) return 'running';
  if (state.includes('wait')) return 'waiting';
  if (state.includes('complet') || state.includes('done')) return 'completed';
  if (state.includes('cancel') || state.includes('kill')) return 'cancelled';
  if (state.includes('fail') || state.includes('err')) return 'failed';
  return 'unknown';
}

function mapAgySwarmPhase(rawPhase, killed = false) {
  if (killed) return 'cancelled';
  const phase = lower(rawPhase);
  if (phase === 'running' || phase === 'working') return 'running';
  if (phase === 'waiting' || phase === 'idle' || phase === 'stopped') return 'waiting';
  if (phase === 'completed' || phase === 'done') return 'completed';
  if (phase === 'killed' || phase === 'cancelled') return 'cancelled';
  if (phase === 'failed' || phase === 'error') return 'failed';
  return 'unknown';
}

function readAgyTranscriptFromDisk({ brainReal, childConvId, runId, limit = 500 }) {
  const checked = safePathWithinRoot(brainReal, [childConvId, '.system_generated', 'logs', 'transcript.jsonl']);
  if (!checked.ok) {
    return {
      status: checked.reason === 'missing' ? 'missing' : 'unsafe',
      entries: [],
      gap: checked.reason !== 'missing',
    };
  }
  if (checked.stat.size > MAX_AGY_TRANSCRIPT_BYTES) {
    return { status: 'unsafe', entries: [], gap: true };
  }
  let rawText = '';
  try {
    rawText = readFileSync(checked.realPath, 'utf8');
  } catch {
    return { status: 'error', entries: [], gap: true };
  }
  const lines = rawText.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const events = [];
  let partial = false;
  let parseErrors = 0;
  let seqBase = 0;
  const maxEvents = Math.max(1, Math.min(Number(limit) || 500, 2000));
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      parseErrors += 1;
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    if (Array.isArray(entry.truncated_fields) && entry.truncated_fields.length > 0) {
      partial = true;
    }
    const tsMs = Date.parse(entry.created_at || '');
    const timestamp = Number.isFinite(tsMs) ? entry.created_at : undefined;
    const stepIndex = Number.isInteger(entry.step_index) ? entry.step_index : seqBase;

    if (Array.isArray(entry.tool_calls)) {
      for (const tc of entry.tool_calls) {
        if (events.length >= maxEvents) { partial = true; break; }
        const toolName = redactAgyText(firstString(tc?.name, tc?.toolName, 'tool'), 80);
        const safeArgs = redactAgyText(
          typeof tc?.arguments === 'string' ? tc.arguments : JSON.stringify(tc?.arguments ?? {}),
          400,
        );
        seqBase += 1;
        events.push({
          ...toolUseEvent(toolName, safeArgs, { provider: 'agy', runtimeFamily: 'agy-acp' }),
          seq: (stepIndex + 1) * 100 + (seqBase % 100),
          runId,
          eventId: `agy_disk_${runId}_${seqBase}`,
          ...(timestamp ? { timestamp } : {}),
        });
      }
    }

    const content = typeof entry.content === 'string' ? entry.content.trim() : '';
    if (content && events.length < maxEvents) {
      const role = lower(entry.type) === 'user_input' || lower(entry.source) === 'user_explicit'
        ? 'user'
        : lower(entry.type) === 'planner_response' || lower(entry.source) === 'model'
          ? 'assistant'
          : '';
      if (role) {
        seqBase += 1;
        events.push({
          ...messageEvent(role, redactAgyText(content, 8000), undefined, { provider: 'agy' }),
          seq: (stepIndex + 1) * 100 + (seqBase % 100),
          runId,
          eventId: `agy_disk_${runId}_${seqBase}`,
          ...(timestamp ? { timestamp } : {}),
        });
      }
    } else if (content && events.length >= maxEvents) {
      partial = true;
    }
  }
  const hasGap = partial || parseErrors > 0;
  return {
    status: events.length === 0 ? (hasGap ? 'partial' : 'missing') : (hasGap ? 'partial' : 'parsed'),
    entries: events,
    gap: hasGap,
  };
}

function resolveAgyDiskMemberId({ parentSessionId, runId, providerDelegationId, existingMemberId = '', memberIds }) {
  const identity = buildDelegationIdentity({ provider: 'agy', runId, providerDelegationId });
  if (existingMemberId) memberIds.set(identity.id, existingMemberId);
  const memberId = memberIds.get(identity.id) || `member_${createHash('sha256').update(JSON.stringify([
    parentSessionId, 'agy', runId, providerDelegationId,
  ])).digest('hex').slice(0, 24)}`;
  memberIds.set(identity.id, memberId);
  return memberId;
}

const TERMINAL_PARENT_RUN_STATES = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

function readAgySessionDiskState({
  brainReal,
  agySessionId,
  parentSessionId,
  runId,
  memberIds,
  memberIdByChildConvId,
}) {
  const subagentEntries = [];
  const swarmCandidates = [];
  const boardMessages = [];
  let swarmTitle = '';
  let gap = false;
  if (!brainReal || !isSafeSegment(agySessionId)) {
    return { subagentEntries, swarmCandidates, boardMessages, swarmTitle, gap };
  }

  const subDirCheck = safePathWithinRoot(brainReal, [agySessionId, '.system_generated', 'subagents'], { expectDir: true });
  if (subDirCheck.ok) {
    try {
      const files = readdirSync(subDirCheck.realPath).filter((f) => f.endsWith('.json')).slice(0, MAX_AGY_DISK_FILES);
      for (const file of files) {
        const res = readVerifiedJsonFile(brainReal, [agySessionId, '.system_generated', 'subagents', file]);
        if (!res.ok) { gap = true; continue; }
        const data = object(res.data);
        const childConvId = firstString(data.conversationId, data.conversation_id);
        if (!childConvId || !isSafeSegment(childConvId)) continue;
        const descriptor = object(data.subagentDescriptor);
        const displayName = firstString(descriptor.role, descriptor.typeName, 'subagent');
        const state = mapAgySubagentDiskState(data.state);
        subagentEntries.push({
          source: 'subagent',
          childSessionId: childConvId,
          state,
          displayName,
          role: firstString(descriptor.typeName, displayName),
          model: '',
          spawnStepIndex: Number.isInteger(data.spawnStepIndex) ? data.spawnStepIndex : Number.MAX_SAFE_INTEGER,
          timestamp: Date.parse(data.updatedAt || data.createdAt || '') || undefined,
        });
      }
      subagentEntries.sort((a, b) => (
        (a.spawnStepIndex - b.spawnStepIndex)
        || ((a.timestamp || 0) - (b.timestamp || 0))
        || a.childSessionId.localeCompare(b.childSessionId)
      ));
    } catch {
      gap = true;
    }
  } else if (!['missing', 'not_dir'].includes(subDirCheck.reason)) {
    gap = true;
  }

  const membersRes = readVerifiedJsonFile(brainReal, [agySessionId, '.system_generated', 'swarm', 'members.json']);
  if (membersRes.ok) {
    const data = object(membersRes.data);
    swarmTitle = text(data.title);
    const membersObj = object(data.members);
    for (const [name, rawInfo] of Object.entries(membersObj)) {
      const info = object(rawInfo);
      const convId = firstString(info.conversation_id, info.conversationId);
      if (name === 'coordinator' && (!convId || convId === agySessionId || lower(info.role) === 'coordinator')) {
        continue;
      }
      const providerDelegationId = `swarm:${name}`;
      const existingMemberId = convId ? (memberIdByChildConvId.get(convId) || '') : '';
      const memberId = resolveAgyDiskMemberId({
        parentSessionId,
        runId,
        providerDelegationId,
        existingMemberId,
        memberIds,
      });
      if (convId) memberIdByChildConvId.set(convId, memberId);
      const state = mapAgySwarmPhase(info.phase, info.killed === true);
      swarmCandidates.push({
        source: 'swarm',
        memberId,
        providerDelegationId,
        childSessionId: convId,
        state,
        displayName: name,
        role: firstString(info.role, 'worker'),
        model: firstString(info.applied_model, info.model, info.desired_model),
        timestamp: Date.parse(info.updated_at || '') || undefined,
      });
    }
  } else if (membersRes.reason !== 'missing') {
    gap = true;
  }

  const boardCheck = safePathWithinRoot(brainReal, [agySessionId, '.system_generated', 'swarm', 'board.jsonl']);
  if (boardCheck.ok) {
    if (boardCheck.stat.size > MAX_AGY_TRANSCRIPT_BYTES) {
      gap = true;
    } else {
      try {
        const lines = readFileSync(boardCheck.realPath, 'utf8').split(/\r?\n/).filter((l) => l.trim().length > 0);
        if (lines.length > MAX_AGY_BOARD_MESSAGES) gap = true;
        for (const [lineIdx, line] of lines.slice(-MAX_AGY_BOARD_MESSAGES).entries()) {
          let entry;
          try { entry = JSON.parse(line); } catch { gap = true; continue; }
          if (!entry || typeof entry !== 'object') continue;
          const seq = Number.isInteger(entry.seq) && entry.seq > 0 ? entry.seq : lineIdx + 1;
          const sender = firstString(entry.agent, entry.sender, 'member');
          const senderSwarmIdentity = buildDelegationIdentity({ provider: 'agy', runId, providerDelegationId: `swarm:${sender}` });
          boardMessages.push(normalizeBoardMessage({
            seq,
            channel: firstString(entry.channel, 'main'),
            sender,
            senderMemberId: memberIds.get(senderSwarmIdentity.id) || null,
            kind: firstString(entry.kind, 'post'),
            text: firstString(entry.text, entry.message, entry.body),
            replyToSeq: entry.reply_to_seq ?? entry.replyToSeq ?? null,
            createdAt: entry.time ?? entry.created_at ?? entry.createdAt ?? null,
          }));
        }
      } catch {
        gap = true;
      }
    }
  } else if (boardCheck.reason !== 'missing') {
    gap = true;
  }

  return { subagentEntries, swarmCandidates, boardMessages, swarmTitle, gap };
}

// Stream a run's existing spool through the provider boundary. The caller
// supplies an already-authorized run and reader; raw provider frames never
// leave this adapter. Absence or truncation of the source must be reported by
// the caller rather than represented as a complete empty history.
export function createMemberReader(options = {}) {
  const normalizedProvider = canonicalizeNativeDelegationProvider(options.provider) || lower(options.provider);
  const mapper = createProviderNativeDelegationMapper({ ...options, provider: normalizedProvider || options.provider });
  const byId = new Map();
  const memberIds = new Map();
  const memberIdByChildConvId = new Map();
  const memberTrackById = new Map();
  const wireSubagentOrder = [];
  const childAdapters = new Map();
  const childEntries = new Map();
  const parentAgySessionIds = new Set(
    [options.parentThreadId, options.providerSessionId].map(text).filter((id) => isSafeSegment(id)),
  );
  const spoolBoardChannels = new Map();
  const spoolBoardMessages = [];
  let spoolBoardTitle = '';
  let diskBoardTitle = '';
  let diskBoardMessages = [];
  let diskSynced = false;
  let lastParentRunState = lower(options.parentRunState || options.runState);
  let recordSeq = 0;
  let totalChildEntries = 0;
  let gap = false;
  const limit = Math.max(1, Math.min(Number(options.limit) || 8192, 8192));
  const lastDiskCandidateByMember = new Map();
  const touchTrack = (memberId) => {
    let track = memberTrackById.get(memberId);
    if (!track) {
      track = {
        maxSeq: 0,
        wireSeqOffset: 0,
        confirmed: false,
        terminal: false,
        wireHasModel: false,
        state: 'unknown',
        displayName: '',
        role: '',
        model: '',
        childSessionId: '',
      };
      memberTrackById.set(memberId, track);
    }
    return track;
  };
  const recordTrack = (event, { fromDisk = false } = {}) => {
    if (!event?.memberId) return;
    const track = touchTrack(event.memberId);
    track.maxSeq = Math.max(track.maxSeq, Number(event.seq) || 0);
    if (event.phase === 'confirmed') track.confirmed = true;
    if (event.phase === 'terminal' || TERMINAL_STATES.has(event.state)) track.terminal = true;
    if (event.state && event.state !== 'unknown') track.state = event.state;
    if (event.displayName) track.displayName = event.displayName;
    if (event.role) track.role = event.role;
    if (event.model) {
      track.model = event.model;
      if (!fromDisk) track.wireHasModel = true;
    }
    if (event.providerRef?.id) track.childSessionId = event.providerRef.id;
    if (
      normalizedProvider === 'agy'
      && !fromDisk
      && event.barrierParticipation === true
      && event.barrier?.sourceMemberId
      && !event.barrier.sourceMemberId.startsWith('workflow:')
      && !wireSubagentOrder.includes(event.memberId)
    ) {
      wireSubagentOrder.push(event.memberId);
    }
  };
  const withMonotonicWireSeq = (event) => {
    if (normalizedProvider !== 'agy' || !event?.memberId || !event?.id) return event;
    if (byId.has(event.id)) return event;
    const track = memberTrackById.get(event.memberId);
    if (!track || track.wireSeqOffset <= 0) return event;
    const nextSeq = Math.max((Number(event.seq) || 0) + track.wireSeqOffset, track.maxSeq + 1);
    if (nextSeq === event.seq) return event;
    return {
      ...event,
      seq: nextSeq,
      id: `member_${createHash('sha256').update(JSON.stringify([
        options.runId, event.memberId, event.phase, event.state, nextSeq,
      ])).digest('hex').slice(0, 24)}`,
    };
  };
  const add = (event, addOpts = {}) => {
    if (!event?.id || event.rootSessionId !== options.parentSessionId || event.runId !== options.runId) return;
    if (event.providerRef?.id && event.memberId) {
      memberIdByChildConvId.set(event.providerRef.id, event.memberId);
    }
    const previous = byId.get(event.id);
    if (previous) {
      // A persisted normalized event may predate adapter evidence retained in
      // the raw frame. Enrich only the identical event, never infer a parent.
      const preferred = previous.phase === 'unknown' && event.phase !== 'unknown' ? event : previous;
      const other = preferred === previous ? event : previous;
      const enriched = !['member', 'root_session'].includes(preferred.parent?.kind) &&
        ['member', 'root_session'].includes(other.parent?.kind)
        ? { ...preferred, parent: other.parent, ...(other.actor ? { actor: other.actor } : {}) } : preferred;
      byId.set(event.id, enriched);
      recordTrack(enriched, addOpts);
      return;
    }
    if (!previous && byId.size >= limit) { gap = true; return; }
    byId.set(event.id, event);
    recordTrack(event, addOpts);
  };
  function syncAgyDiskIfConfigured({ parentRunState = lastParentRunState } = {}) {
    if (normalizedProvider !== 'agy') return;
    const verified = resolveVerifiedAgyBrainRoot(options);
    if (!verified || parentAgySessionIds.size === 0) return;
    diskSynced = true;
    const normalizedRunState = lower(parentRunState);
    const isParentRunTerminal = TERMINAL_PARENT_RUN_STATES.has(normalizedRunState);
    const nextDiskMessages = [];
    const parentInfo = { parentKind: 'root_session', parentDelegationId: '', isRoot: true };
    const claimedWireMemberIds = new Set();
    for (const id of memberIdByChildConvId.values()) {
      claimedWireMemberIds.add(id);
    }
    const pickCorrelatedWireSubagent = (sub) => {
      const unclaimed = wireSubagentOrder.filter((id) => {
        if (claimedWireMemberIds.has(id)) return false;
        const t = memberTrackById.get(id);
        return !t?.childSessionId;
      });
      if (unclaimed.length === 0) return '';
      const subName = lower(sub.displayName);
      const subRole = lower(sub.role);
      const exactMatch = unclaimed.find((id) => {
        const t = memberTrackById.get(id);
        const tName = lower(t?.displayName);
        const tRole = lower(t?.role);
        return (subName && subName !== 'subagent' && (tName === subName || tRole === subName))
          || (subRole && subRole !== 'subagent' && (tRole === subRole || tName === subRole));
      });
      if (exactMatch) return exactMatch;
      const genericWire = unclaimed.find((id) => {
        const t = memberTrackById.get(id);
        const tName = lower(t?.displayName);
        return !tName || tName === 'subagent';
      });
      return genericWire || unclaimed[0];
    };

    for (const agySessionId of parentAgySessionIds) {
      if (memberIdByChildConvId.has(agySessionId)) continue;
      const disk = readAgySessionDiskState({
        brainReal: verified.brainReal,
        agySessionId,
        parentSessionId: options.parentSessionId,
        runId: options.runId,
        memberIds,
        memberIdByChildConvId,
      });
      if (disk.gap) gap = true;
      if (disk.swarmTitle) diskBoardTitle = disk.swarmTitle;

      const resolvedCandidates = [];
      for (const sub of disk.subagentEntries) {
        let existingMemberId = memberIdByChildConvId.get(sub.childSessionId) || '';
        if (!existingMemberId) {
          existingMemberId = pickCorrelatedWireSubagent(sub);
          if (existingMemberId) claimedWireMemberIds.add(existingMemberId);
        }
        const providerDelegationId = existingMemberId ? `disk_subagent:${sub.childSessionId}` : sub.childSessionId;
        const memberId = resolveAgyDiskMemberId({
          parentSessionId: options.parentSessionId,
          runId: options.runId,
          providerDelegationId,
          existingMemberId,
          memberIds,
        });
        memberIdByChildConvId.set(sub.childSessionId, memberId);
        resolvedCandidates.push({
          ...sub,
          memberId,
          providerDelegationId,
        });
      }
      resolvedCandidates.push(...disk.swarmCandidates);

      for (const cand of resolvedCandidates) {
        const track = touchTrack(cand.memberId);
        const effectiveCandState = (
          cand.source === 'subagent'
          && cand.state === 'running'
          && isParentRunTerminal
        )
          ? (normalizedRunState === 'completed'
            ? 'completed'
            : normalizedRunState === 'cancelled'
              ? 'cancelled'
              : 'interrupted')
          : cand.state;
        const prevDisk = lastDiskCandidateByMember.get(cand.memberId) || null;
        const diskSnapshot = {
          state: effectiveCandState,
          childSessionId: cand.childSessionId,
          model: cand.model,
          displayName: cand.displayName,
          role: cand.role,
        };
        const diskChanged = !prevDisk
          || prevDisk.state !== diskSnapshot.state
          || prevDisk.childSessionId !== diskSnapshot.childSessionId
          || prevDisk.model !== diskSnapshot.model
          || prevDisk.displayName !== diskSnapshot.displayName
          || prevDisk.role !== diskSnapshot.role;
        lastDiskCandidateByMember.set(cand.memberId, diskSnapshot);

        if (track.terminal) {
          // Never regress a terminal member back to stale running/waiting,
          // but attach newly resolved childSessionId/metadata (preserving terminal state).
          const missingChild = Boolean(cand.childSessionId && !track.childSessionId);
          const upgradeName = Boolean(
            cand.displayName
            && cand.displayName !== 'Subagent'
            && (!track.displayName || track.displayName === 'Subagent'),
          );
          const upgradeRole = Boolean(
            cand.role
            && cand.role !== 'subagent'
            && (!track.role || track.role === 'subagent'),
          );
          if (!diskChanged || (!missingChild && !upgradeName && !upgradeRole)) {
            continue;
          }
          const nextSeq = track.maxSeq + 1;
          track.wireSeqOffset += 1;
          add(buildAgyMemberEvent({
            raw: { timestamp: cand.timestamp },
            context: { runId: options.runId, parentSessionId: options.parentSessionId, timestamp: 1 },
            providerDelegationId: cand.providerDelegationId,
            parentInfo,
            phase: 'terminal',
            state: track.state,
            seq: nextSeq,
            childSessionId: cand.childSessionId || track.childSessionId,
            displayName: upgradeName ? cand.displayName : (track.displayName || cand.displayName),
            role: upgradeRole ? cand.role : (track.role || cand.role),
            model: track.model || cand.model,
            barrierParticipation: false,
            memberIds,
          }), { fromDisk: true });
          continue;
        }
        if (track.confirmed && !diskChanged) continue;

        const isCandTerminal = TERMINAL_STATES.has(effectiveCandState);
        const stateAdvancedOnDisk = effectiveCandState !== 'unknown'
          && effectiveCandState !== track.state
          && (!prevDisk || effectiveCandState !== prevDisk.state);
        const childAdvancedOnDisk = Boolean(cand.childSessionId && cand.childSessionId !== track.childSessionId);
        const modelAdvancedOnDisk = Boolean(cand.model && cand.model !== track.model)
          && (!track.wireHasModel || Boolean(prevDisk && cand.model !== prevDisk.model));
        const hasNewData = !track.confirmed
          || stateAdvancedOnDisk
          || isCandTerminal
          || childAdvancedOnDisk
          || modelAdvancedOnDisk
          || (!track.displayName && Boolean(cand.displayName))
          || (!track.role && Boolean(cand.role));
        if (!hasNewData) continue;

        const emittedModel = modelAdvancedOnDisk ? cand.model : (track.model || cand.model);

        if (!track.confirmed && isCandTerminal) {
          const birthSeq = track.maxSeq + 1;
          track.wireSeqOffset += 1;
          add(buildAgyMemberEvent({
            raw: { timestamp: cand.timestamp },
            context: { runId: options.runId, parentSessionId: options.parentSessionId, timestamp: 1 },
            providerDelegationId: cand.providerDelegationId,
            parentInfo,
            phase: 'confirmed',
            state: 'running',
            seq: birthSeq,
            childSessionId: cand.childSessionId,
            displayName: cand.displayName,
            role: cand.role,
            model: emittedModel,
            barrierParticipation: false,
            memberIds,
          }), { fromDisk: true });
        }

        const nextPhase = !track.confirmed
          ? 'confirmed'
          : isCandTerminal
            ? 'terminal'
            : 'updated';
        const nextState = (stateAdvancedOnDisk || !track.confirmed || isCandTerminal) && effectiveCandState !== 'unknown'
          ? effectiveCandState
          : (track.state !== 'unknown' ? track.state : 'running');
        const nextSeq = track.maxSeq + 1;
        track.wireSeqOffset += 1;
        add(buildAgyMemberEvent({
          raw: { timestamp: cand.timestamp },
          context: { runId: options.runId, parentSessionId: options.parentSessionId, timestamp: 1 },
          providerDelegationId: cand.providerDelegationId,
          parentInfo,
          phase: nextPhase,
          state: nextState,
          seq: nextSeq,
          childSessionId: cand.childSessionId || track.childSessionId,
          displayName: (!track.displayName || track.displayName === 'Subagent')
            ? (cand.displayName || track.displayName)
            : track.displayName,
          role: (!track.role || track.role === 'subagent')
            ? (cand.role || track.role)
            : track.role,
          model: emittedModel,
          barrierParticipation: false,
          memberIds,
        }), { fromDisk: true });
      }
      nextDiskMessages.push(...disk.boardMessages);
    }
    if (nextDiskMessages.length > 0) diskBoardMessages = nextDiskMessages;
  }
  async function consume(records, { sourceVerified = false, parentRunState = '' } = {}) {
    if (parentRunState) lastParentRunState = lower(parentRunState);
    const before = new Set(byId.keys());
    if (!sourceVerified) gap = true;
    for await (const record of records || []) {
      recordSeq += 1;
      let payload = record?.json;
      if (!payload && typeof record?.line === 'string') {
        try { payload = JSON.parse(record.line); } catch { gap = true; continue; }
      }
      if (!payload || typeof payload !== 'object') continue;
      if (normalizedProvider === 'agy' && payload.ragent_intermediate !== true) {
        const candidateConvId = firstString(
          payload.conversation_id,
          payload.conversationId,
          payload.init?.conversation_id,
          payload.step_update?.conversation_id,
          payload.result?.conversation_id,
          payload.method === 'session/update' ? payload.params?.sessionId : '',
        );
        if (candidateConvId && isSafeSegment(candidateConvId) && !memberIdByChildConvId.has(candidateConvId)) {
          parentAgySessionIds.add(candidateConvId);
        }
      }
      const parentToolId = normalizedProvider === 'claude' ? text(payload.parent_tool_use_id) : '';
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
      if (payload.type === 'ragent.member_event') { add(withMonotonicWireSeq(payload.event)); continue; }
      if (payload.type === 'ragent.delegation_event') {
        const event = payload.event;
        if (event?.provider && event?.providerDelegationId && event?.delegationId)
          add(withMonotonicWireSeq(memberEventFromDelegation(event, { memberIds })));
        continue;
      }
      if (payload.ragent_intermediate === true) continue;
      const mapped = mapper.map(payload);
      for (const event of mapped.memberEvents) add(withMonotonicWireSeq(event));
      for (const boardEv of mapped.boardEvents || []) {
        if (boardEv.kind === 'title' && boardEv.title) spoolBoardTitle = boardEv.title;
        else if (boardEv.kind === 'channel' && boardEv.channel) {
          spoolBoardChannels.set(boardEv.channel, { name: boardEv.channel, topic: boardEv.topic || null });
        } else if (boardEv.kind === 'message' && boardEv.message) {
          spoolBoardMessages.push(boardEv.message);
        }
      }
      if (mapped.errors.length) gap = true;
    }
    syncAgyDiskIfConfigured();
    return { events: [...byId.values()].filter((event) => !before.has(event.id)), snapshot: [...byId.values()], gap };
  }
  function readBoard() {
    if (normalizedProvider !== 'agy') return null;
    if (!diskSynced) syncAgyDiskIfConfigured();
    const combinedMessages = diskBoardMessages.length > 0 ? diskBoardMessages : spoolBoardMessages;
    return buildReadOnlyBoardProjection({
      title: diskBoardTitle || spoolBoardTitle || null,
      channels: [...spoolBoardChannels.values()],
      messages: combinedMessages,
      source: 'provider_native',
      provider: 'agy',
      gap,
    });
  }
  function readCapturedMember(memberId) {
    if (normalizedProvider === 'agy') {
      const members = [...byId.values()].filter((event) => event.memberId === memberId);
      const latest = members.at(-1) || null;
      const childConvId = firstString(...members.map((m) => m.providerRef?.id));
      const verified = resolveVerifiedAgyBrainRoot(options);
      if (verified && childConvId) {
        const disk = readAgyTranscriptFromDisk({
          brainReal: verified.brainReal,
          childConvId,
          runId: options.runId,
          limit,
        });
        if (disk.status === 'parsed' || disk.status === 'partial') {
          return {
            entries: buildSessionDisplayEvents(disk.entries),
            scope: 'captured_only',
            coverage: 'partial',
            gap: gap || disk.gap,
            availability: (gap || disk.gap || disk.status === 'partial') ? 'partial' : 'available',
          };
        }
        if (disk.status === 'unsafe' || disk.status === 'error') {
          return {
            entries: [],
            scope: latest ? 'activity_only' : 'unavailable',
            coverage: latest ? 'activity_only' : 'unavailable',
            gap: true,
            availability: latest ? 'partial' : 'unavailable',
          };
        }
      }
      return {
        entries: [],
        scope: latest ? 'activity_only' : 'unavailable',
        coverage: latest ? 'activity_only' : 'unavailable',
        gap,
        availability: latest ? 'partial' : 'unavailable',
      };
    }
    return {
      entries: buildSessionDisplayEvents(childEntries.get(memberId) || []),
      scope: 'captured_only',
      gap,
      availability: childEntries.has(memberId) ? 'available' : 'unavailable',
    };
  }
  return {
    consume,
    snapshot: () => ({ events: [...byId.values()], gap }),
    readBoard,
    readCapturedMember,
  };
}

export async function readProviderMemberEvents(records, options = {}) {
  const reader = createMemberReader(options);
  const res = await reader.consume(records, { sourceVerified: options.sourceVerified === true });
  return { ...res, board: reader.readBoard() };
}
