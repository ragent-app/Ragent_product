import {
  approvalRequestEvent,
  approvalResponseEvent,
  fileChangeEvent,
  messageEvent,
  planEvent,
  reasoningEvent,
  statusEvent,
  textDeltaEvent,
  toolResultEvent,
  toolUseEvent,
  usageEvent,
} from '../normalizer.mjs';
import {
  readCodexAppServerApprovalRequest,
  readCodexAppServerGoalFields,
  readCodexAppServerGoalPayload,
  readCodexAppServerMcpStatusList,
} from '../codex-app-server-protocol.mjs';
import { explanationForApproval } from '../risk-explanation.mjs';
import { annotateProviderError, getProviderCapabilities } from '../provider-contract.mjs';
import { getHarnessAdapterCompatibility } from '../harness-compatibility.mjs';
import { MAC_CLEANUP_SPOOL_TYPE, MAC_CLEANUP_WARNING } from '../macos-codex-cancellation.mjs';
import { isAbsolute, win32 } from 'node:path';

export const CODEX_APP_SERVER_RUNTIME_FAMILY = 'codex-app-server-json';

export function isCodexAppServerRuntimeFamily(runtimeFamily) {
  return String(runtimeFamily || '').trim() === CODEX_APP_SERVER_RUNTIME_FAMILY;
}

export function buildCodexAppServerProjectTrustArgs(cwd) {
  const projectRoot = typeof cwd === 'string' ? cwd.trim() : '';
  if (!projectRoot || (!isAbsolute(projectRoot) && !win32.isAbsolute(projectRoot))) {
    throw new TypeError('Codex project trust requires an absolute Run working directory');
  }
  // JSON string literals are valid TOML basic strings and safely quote Windows
  // paths, including backslashes and quotes. Keep the override scoped to the
  // current App Server process; never write the user's config.toml.
  return ['-c', `projects={${JSON.stringify(projectRoot)}={trust_level="untrusted"}}`];
}

export function buildCodexAppServerArgs({ cwd, agentocApprovalGate = false } = {}) {
  const args = ['app-server', '--stdio'];
  if (agentocApprovalGate === true) args.push(...buildCodexAppServerProjectTrustArgs(cwd));
  return args;
}

export function createCodexAppServerAdapter() {
  const planTextByItemId = new Map();
  // An app-server agentMessage completion can carry only its item id. Keep
  // the live text by item so that completion still produces a durable reply.
  // Without this, text_delta is visible while streaming but vanishes as soon
  // as the client refreshes from history.
  const agentMessageTextByItemId = new Map();
  const reasoningTextByItemId = new Map();
  // App-server text deltas have no transport event id. Keep a monotonic
  // ordinal per provider item so reconnect/replay can identify an immutable
  // delta without collapsing legitimate repeated characters.
  const textDeltaOrdinalByItemId = new Map();
  // Approval ids that the runner sidecar already answered automatically.
  // The sidecar echoes its synthetic agentoc.approval_response
  // into the stream BEFORE the requestApproval it answers, so a request frame
  // for a known id is never a live user-facing approval. Suppressing it keeps
  // automatically allowed and denied tools out of the
  // approval cards, push notifications, and the replay gate entirely.
  const autoApprovedIds = new Set();

  return {
    adapterCompatibility: getHarnessAdapterCompatibility('codex'),
    capabilities: getProviderCapabilities(CODEX_APP_SERVER_RUNTIME_FAMILY),

    parseLine(line) {
      const trimmed = line.trim();
      if (!trimmed) return [];

      let obj;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        return [];
      }

      return parseAppServerMessage(obj, {
        planTextByItemId,
        agentMessageTextByItemId,
        reasoningTextByItemId,
        autoApprovedIds,
        textDeltaOrdinalByItemId,
      });
    },

    flush() {
      return [];
    },

    // Restore the bounded auto-approval suppression state after a chat-server
    // restart without replaying the entire Run spool through the adapter.
    seedAutoApprovedIds(ids = []) {
      for (const id of Array.isArray(ids) ? ids : []) {
        if (typeof id === 'string' && id.trim()) autoApprovedIds.add(id.trim());
      }
    },
  };
}

function parseAppServerMessage(message, state = {}) {
  if (!message || typeof message !== 'object') return [];
  // The sidecar persists provider-native delegated-thread frames for raw
  // diagnostics, but they are not lifecycle events for the parent AgentoC
  // Run. In particular, a child `turn/completed` must not synthesize parent
  // Run completion while the parent turn is still active.
  if (message.agentoc_intermediate === true) return [];
  if (message.type === MAC_CLEANUP_SPOOL_TYPE && message.status === 'unconfirmed') {
    return [statusEvent(MAC_CLEANUP_WARNING, { code: 'MAC_CANCELLATION_CLEANUP_UNCONFIRMED' })];
  }
  if (message.type === 'agentoc.approval_response') {
    if ((message.autoApproved === true || message.autoDenied === true)
      && typeof message.approvalId === 'string' && message.approvalId) {
      // Sidecar automatic decision: suppress the answered request frame so
      // unattended denials do not become owner approval cards or pushes.
      state.autoApprovedIds?.add(message.approvalId);
      return [];
    }
    return [approvalResponseEvent({
      approvalId: message.approvalId,
      decision: message.decision,
      status: message.status,
      source: 'codex-app-server',
      providerRequestId: message.providerRequestId,
      providerMethod: message.providerMethod,
    })].filter(Boolean);
  }
  const approvalRequest = readCodexAppServerApprovalRequest(message);
  if (approvalRequest) {
    if (approvalRequest.approvalId && state.autoApprovedIds?.has(approvalRequest.approvalId)) {
      return [];
    }
    return [parseApprovalRequest(approvalRequest)].filter(Boolean);
  }
  if (message.error) {
    return [statusEvent(
      `error: ${readErrorMessage(message.error)}`,
      annotateProviderError({ provider: 'codex', runtimeFamily: CODEX_APP_SERVER_RUNTIME_FAMILY }, message.error),
    )];
  }

  if (message.result && typeof message.result === 'object') {
    return parseAppServerResult(message.result);
  }

  switch (message.method) {
    case 'thread/started':
      return [statusEvent(`Thread started (${message.params?.thread?.id || 'unknown'})`, {
        provider: 'codex',
        runtimeFamily: CODEX_APP_SERVER_RUNTIME_FAMILY,
        providerThreadId: message.params?.thread?.id,
      })];

    case 'thread/status/changed':
      return parseThreadStatusChanged(message.params);

    case 'thread/settings/updated': {
      const mode = message.params?.threadSettings?.collaborationMode?.mode;
      return mode ? [statusEvent(`mode: ${mode}`)] : [];
    }

    case 'turn/started':
      return [statusEvent('thinking')];

    case 'turn/completed':
      return parseTurnCompleted(message.params);

    case 'turn/plan/updated':
      return [parseTurnPlanUpdated(message.params)];

    case 'item/plan/delta':
      return parsePlanDelta(message.params, state);

    case 'item/agentMessage/delta':
      return parseTextDelta(message.params, state);

    case 'item/reasoning/textDelta':
    case 'item/reasoning/summaryTextDelta':
      return parseReasoningDelta(message.params, state, message.method);

    case 'item/commandExecution/outputDelta':
    case 'command/exec/outputDelta':
    case 'process/outputDelta':
      return parseToolOutputDelta(message.params);

    case 'item/fileChange/patchUpdated':
      return parseFileChangePatch(message.params);

    case 'item/started':
      return message.params?.item ? parseThreadItem(message.params.item, 'started', message.params, state) : [];

    case 'item/completed':
      return message.params?.item ? parseThreadItem(message.params.item, 'completed', message.params, state) : [];

    case 'error':
      return [statusEvent(
        `error: ${readErrorMessage(message.params?.error || message.params)}`,
        {
          ...annotateProviderError(
            { provider: 'codex', runtimeFamily: CODEX_APP_SERVER_RUNTIME_FAMILY },
            message.params?.error || message.params,
          ),
          ...(typeof message.params?.willRetry === 'boolean'
            ? { providerErrorRetryable: message.params.willRetry }
            : {}),
        },
      )];

    case 'thread/tokenUsage/updated':
      return parseTokenUsage(message.params?.tokenUsage);

    case 'thread/goal/updated':
      return parseGoalUpdated(message.params);

    case 'thread/goal/cleared':
      return parseGoalCleared(message.params);

    case 'mcpServer/startupStatus/updated':
      return parseMcpStartupStatus(message.params);

    case 'mcpServer/oauthLogin/completed':
      return parseMcpOauthLogin(message.params);

    case 'item/mcpToolCall/progress':
      return parseMcpToolCallProgress(message.params);

    case 'mcpServer/elicitation/request':
      return parseMcpElicitation(message.params);

    case 'account/rateLimits/updated':
      return parseRateLimitsUpdated(message.params);

    default:
      return [];
  }
}

function formatCommandValue(value) {
  if (Array.isArray(value)) return value.map((part) => String(part || '')).filter(Boolean).join(' ');
  return typeof value === 'string' ? value.trim() : '';
}

function readAppServerStatusText(value) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (!(value && typeof value === 'object')) return '';
  const type = typeof value.type === 'string' ? value.type.trim() : '';
  const phase = typeof value.phase === 'string' ? value.phase.trim() : '';
  const state = typeof value.state === 'string' ? value.state.trim() : '';
  const activeFlags = Array.isArray(value.activeFlags)
    ? value.activeFlags
      .map((flag) => (typeof flag === 'string' ? flag.trim() : ''))
      .filter(Boolean)
    : [];
  const base = type || phase || state;
  if (!base) return '';
  if (activeFlags.length === 0) return base;
  return `${base} (${activeFlags.join(', ')})`;
}

function parseThreadStatusChanged(params = {}) {
  const statusText = readAppServerStatusText(params?.status);
  if (!statusText) return [];
  return [statusEvent(statusText, {
    provider: 'codex',
    runtimeFamily: CODEX_APP_SERVER_RUNTIME_FAMILY,
    providerThreadId: params?.threadId,
  })];
}

function readGoalText(goal) {
  if (typeof goal === 'string') return goal.trim();
  if (goal && typeof goal === 'object') {
    return String(goal.objective || goal.text || goal.description || goal.title || goal.content || '').trim();
  }
  return '';
}

function parseGoalUpdated(params = {}) {
  const fields = readCodexAppServerGoalFields(params?.goal);
  if (!fields) return [];
  const preview = readGoalText(params?.goal) || 'goal updated';
  return [statusEvent(`Goal: ${preview.slice(0, 200)}`, {
    provider: 'codex',
    runtimeFamily: CODEX_APP_SERVER_RUNTIME_FAMILY,
    providerThreadId: params?.threadId,
    codexGoal: fields.objective || preview,
    codexGoalEvent: 'updated',
    codexGoalObjective: fields.objective,
    codexGoalStatus: fields.status,
    codexGoalTokenBudget: fields.tokenBudget,
    codexGoalTokensUsed: fields.tokensUsed,
    codexGoalTimeUsedSeconds: fields.timeUsedSeconds,
    codexGoalUpdatedAt: fields.updatedAt,
  })];
}

function parseGoalCleared(params = {}) {
  return [statusEvent('Goal cleared', {
    provider: 'codex',
    runtimeFamily: CODEX_APP_SERVER_RUNTIME_FAMILY,
    providerThreadId: params?.threadId,
    codexGoalEvent: 'cleared',
  })];
}

function parseMcpStartupStatus(params = {}) {
  const serverName = String(params?.name || params?.serverName || params?.server_name || '').trim();
  const status = String(params?.status || '').trim();
  if (!serverName && !status) return [];
  const label = [serverName, status].filter(Boolean).join(' ');
  return [statusEvent(`MCP ${label}`, {
    provider: 'codex',
    runtimeFamily: CODEX_APP_SERVER_RUNTIME_FAMILY,
    providerThreadId: params?.threadId,
    codexMcpServer: serverName,
    codexMcpStatus: status,
    codexMcpStartupFailure: status.toLowerCase() === 'failed' ? true : undefined,
  })];
}

function parseMcpStatusList(result) {
  const inventory = readCodexAppServerMcpStatusList({ result });
  if (!inventory) return [];
  const serverSummaries = inventory.map((entry) => ({
    name: entry.name || null,
    toolNames: Array.isArray(entry.toolNames) ? entry.toolNames : [],
    toolSchemaAvailable: entry.schemaAvailable === true,
  }));
  const toolCount = serverSummaries.reduce((total, entry) => total + entry.toolNames.length, 0);
  return [statusEvent(
    `MCP inventory ${serverSummaries.length} server${serverSummaries.length === 1 ? '' : 's'} · ${toolCount} tool${toolCount === 1 ? '' : 's'}`,
    {
      provider: 'codex',
      runtimeFamily: CODEX_APP_SERVER_RUNTIME_FAMILY,
      codexMcpStatus: 'inventory',
      codexMcpServers: serverSummaries,
    },
  )];
}

function parseMcpOauthLogin(params = {}) {
  const serverName = String(params?.serverName || params?.server_name || '').trim();
  const success = params?.success === true;
  return [statusEvent(`MCP ${serverName || 'server'} login ${success ? 'completed' : 'failed'}`, {
    provider: 'codex',
    runtimeFamily: CODEX_APP_SERVER_RUNTIME_FAMILY,
    providerThreadId: params?.threadId,
    codexMcpServer: serverName,
    codexMcpLoginSuccess: success,
  })];
}

function parseMcpToolCallProgress(params = {}) {
  const item = params?.item || {};
  const server = String(item.serverName || item.server_name || params?.serverName || '').trim();
  const tool = String(item.toolName || item.tool || item.name || '').trim();
  const progress = String(item.progress || item.status || '').trim();
  const label = [server && `MCP ${server}`, tool].filter(Boolean).join(' · ');
  if (!label) return [];
  return [statusEvent(`${label}${progress ? `: ${progress}` : ''}`, {
    provider: 'codex',
    runtimeFamily: CODEX_APP_SERVER_RUNTIME_FAMILY,
    providerThreadId: params?.threadId,
    codexMcpServer: server,
    codexMcpTool: tool,
  })];
}

function parseMcpElicitation(params = {}) {
  const serverName = String(params?.serverName || params?.server_name || '').trim();
  const request = params?.request;
  const message = (request && typeof request === 'object'
    ? String(request.message || request.prompt || '')
    : String(request || '')).trim();
  return [statusEvent(`MCP ${serverName || 'server'} request${message ? `: ${message.slice(0, 160)}` : ''}`, {
    provider: 'codex',
    runtimeFamily: CODEX_APP_SERVER_RUNTIME_FAMILY,
    providerThreadId: params?.threadId,
    codexMcpServer: serverName,
    codexMcpElicitation: true,
  })];
}

function formatRateLimitWindow(window) {
  const used = typeof window?.usedPercent === 'number' ? window.usedPercent : null;
  const mins = Number.isInteger(window?.windowDurationMins) ? window.windowDurationMins : null;
  if (used === null) return '';
  const usedText = `${used}%`;
  if (!mins) return usedText;
  return `${usedText} / ${mins}m`;
}

function parseRateLimitsUpdated(params = {}) {
  const rateLimits = params?.rateLimits || {};
  const limitName = String(rateLimits.limitName || rateLimits.limitId || '').trim();
  const primary = formatRateLimitWindow(rateLimits.primary);
  const secondary = formatRateLimitWindow(rateLimits.secondary);
  const credits = rateLimits.credits && typeof rateLimits.credits === 'object'
    ? rateLimits.credits
    : null;
  const summary = [
    limitName && `Usage ${limitName}`,
    primary && `primary ${primary}`,
    secondary && `secondary ${secondary}`,
    credits && (credits.hasCredits === false ? 'no credits' : (credits.hasCredits === true ? 'credits ok' : '')),
  ].filter(Boolean).join(' · ');
  if (!summary) return [];
  return [statusEvent(summary, {
    provider: 'codex',
    runtimeFamily: CODEX_APP_SERVER_RUNTIME_FAMILY,
    providerThreadId: params?.threadId,
    codexRateLimits: {
      limitId: rateLimits.limitId || null,
      limitName: limitName || null,
      primary: rateLimits.primary || null,
      secondary: rateLimits.secondary || null,
      credits: credits || null,
    },
  })];
}

function collectFileChangePaths(params = {}) {
  if (params.fileChanges && typeof params.fileChanges === 'object' && !Array.isArray(params.fileChanges)) {
    return Object.keys(params.fileChanges).filter(Boolean);
  }
  if (Array.isArray(params.changes)) {
    return params.changes
      .map((change) => (typeof change?.path === 'string' ? change.path.trim() : ''))
      .filter(Boolean);
  }
  return [];
}

function parseApprovalRequest(approval) {
  const params = approval.params || {};
  const providerItemId = params.itemId || params.callId || '';
  const providerApprovalId = params.approvalId || '';
  const command = formatCommandValue(params.command);
  const filePaths = collectFileChangePaths(params);
  return approvalRequestEvent({
    approvalId: approval.approvalId,
    providerRequestId: approval.providerRequestIdString,
    providerMethod: approval.providerMethod,
    providerThreadId: params.threadId || params.conversationId || '',
    providerTurnId: params.turnId || '',
    providerItemId,
    providerApprovalId,
    kind: approval.kind,
    reason: params.reason
      || params.request?.message
      || params.request?.prompt
      || '',
    command,
    cwd: params.cwd || '',
    filePaths,
    grantRoot: params.grantRoot || '',
    permissions: params.permissions || null,
    status: 'pending',
    source: 'codex-app-server',
    explanation: explanationForApproval({ command, cwd: params.cwd || '', providerDescription: params.reason || params.request?.message || params.request?.prompt }),
  });
}

function parseAppServerResult(result) {
  if (Array.isArray(result?.data)) {
    return parseMcpStatusList(result);
  }
  const events = [];
  if (result.thread?.id) {
    events.push(statusEvent(`Thread ready (${result.thread.id})`, {
      provider: 'codex',
      runtimeFamily: CODEX_APP_SERVER_RUNTIME_FAMILY,
      providerThreadId: result.thread.id,
    }));
  }
  if (result.turn?.status) {
    events.push(statusEvent(String(result.turn.status)));
  }
  return events;
}

function readErrorMessage(error) {
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (typeof error?.message === 'string' && error.message.trim()) return error.message.trim();
  if (typeof error?.additionalDetails === 'string' && error.additionalDetails.trim()) {
    return error.additionalDetails.trim();
  }
  try {
    const serialized = JSON.stringify(error);
    return serialized && serialized !== '{}' ? serialized : 'unknown error';
  } catch {
    return 'unknown error';
  }
}

function parseTextDelta(params, state = {}) {
  const delta = typeof params?.delta === 'string' ? params.delta : '';
  if (!delta) return [];
  const providerItemId = readProviderItemId(params);
  const threadId = readPlanThreadId(params);
  const turnId = readPlanTurnId(params);
  const streamId = agentMessageStreamId(params, null, { providerItemId, threadId, turnId });
  const ordinalByItemId = state.textDeltaOrdinalByItemId;
  const ordinal = (ordinalByItemId?.get(streamId) || 0) + 1;
  ordinalByItemId?.set(streamId, ordinal);
  if (state.agentMessageTextByItemId instanceof Map) {
    state.agentMessageTextByItemId.set(
      streamId,
      `${state.agentMessageTextByItemId.get(streamId) || ''}${delta}`,
    );
  }
  return [textDeltaEvent(0, delta, {
    provider: 'codex',
    runtimeFamily: CODEX_APP_SERVER_RUNTIME_FAMILY,
    ...(providerItemId ? { providerItemId } : {}),
    ...(threadId ? { providerThreadId: threadId } : {}),
    ...(turnId ? { providerTurnId: turnId } : {}),
    providerEventId: `agent-message:${streamId}:${ordinal}`,
  })];
}

function agentMessageStreamId(params = {}, item = null, known = {}) {
  const providerItemId = known.providerItemId || readProviderItemId(params, item);
  if (providerItemId) return providerItemId;
  const threadId = known.threadId || readPlanThreadId(params);
  const turnId = known.turnId || readPlanTurnId(params);
  return `${threadId || 'thread'}:${turnId || 'turn'}:anonymous`;
}

function parseReasoningDelta(params, state = {}, method = '') {
  const delta = typeof params?.delta === 'string' ? params.delta : '';
  if (!delta) return [];
  const providerItemId = readProviderItemId(params);
  const providerThreadId = readPlanThreadId(params);
  const providerTurnId = readPlanTurnId(params);
  if (providerItemId && state.reasoningTextByItemId instanceof Map) {
    const current = state.reasoningTextByItemId.get(providerItemId) || { summary: new Map(), content: new Map() };
    const sections = method.includes('summaryTextDelta') ? current.summary : current.content;
    const index = Number.isInteger(params?.summaryIndex) ? params.summaryIndex
      : Number.isInteger(params?.contentIndex) ? params.contentIndex : 0;
    sections.set(index, `${sections.get(index) || ''}${delta}`.slice(0, 256 * 1024));
    state.reasoningTextByItemId.set(providerItemId, current);
  }
  return [reasoningEvent(delta, {
    provider: 'codex',
    runtimeFamily: CODEX_APP_SERVER_RUNTIME_FAMILY,
    ...(providerItemId ? { providerItemId, providerMessageId: providerItemId } : {}),
    ...(providerThreadId ? { providerThreadId } : {}),
    ...(providerTurnId ? { providerTurnId } : {}),
    providerBlockId: providerItemId || 'thinking:0',
    blockIndex: 0,
    providerLifecycle: 'delta',
    reasoningLifecycle: 'delta',
    operationLifecycle: 'delta',
    state: 'running',
  })];
}

function readProviderItemId(params = {}, item = null) {
  const candidates = [
    params.itemId,
    params.item_id,
    params.callId,
    params.call_id,
    item?.id,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return '';
}

function buildOperationFields(params = {}, item = null, operationLifecycle = '', extra = {}) {
  const providerItemId = readProviderItemId(params, item);
  const providerThreadId = readPlanThreadId(params);
  const providerTurnId = readPlanTurnId(params);
  return {
    provider: 'codex',
    runtimeFamily: CODEX_APP_SERVER_RUNTIME_FAMILY,
    ...(providerItemId ? { providerItemId } : {}),
    ...(providerThreadId ? { providerThreadId } : {}),
    ...(providerTurnId ? { providerTurnId } : {}),
    ...((typeof item?.executionPlatform === 'string' && item.executionPlatform.trim()) || (typeof params?.executionPlatform === 'string' && params.executionPlatform.trim())
      ? { executionPlatform: String(item?.executionPlatform || params?.executionPlatform).trim() } : {}),
    ...((typeof item?.shellKind === 'string' && item.shellKind.trim()) || (typeof params?.shellKind === 'string' && params.shellKind.trim())
      ? { shellKind: String(item?.shellKind || params?.shellKind).trim() } : {}),
    ...(operationLifecycle ? { operationLifecycle } : {}),
    ...extra,
  };
}

function parseToolOutputDelta(params) {
  const delta = typeof params?.delta === 'string'
    ? params.delta
    : (typeof params?.output === 'string' ? params.output : '');
  if (!delta) return [];
  const operationStream = typeof params?.stream === 'string' && params.stream.trim()
    ? params.stream.trim().toLowerCase()
    : 'combined';
  return [toolResultEvent('bash', delta, undefined, buildOperationFields(params, null, 'delta', {
    operationKind: 'command',
    operationStream,
  }))];
}

function normalizePlanStepStatus(value) {
  const status = String(value || '').trim();
  if (status === 'completed') return 'completed';
  if (status === 'inProgress') return 'in_progress';
  return 'pending';
}

function readPlanItemId(params = {}) {
  const candidates = [
    params.turnId,
    params.turn_id,
    params.item?.turnId,
    params.item?.turn_id,
    params.itemId,
    params.item_id,
    params.id,
    params.item?.id,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return '';
}

function readPlanTurnId(params = {}) {
  const candidates = [params.turnId, params.turn_id, params.item?.turnId, params.item?.turn_id];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return '';
}

function readPlanThreadId(params = {}) {
  const candidates = [params.threadId, params.thread_id, params.item?.threadId, params.item?.thread_id];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return '';
}

function parsePlanDelta(params, state = {}) {
  const delta = typeof params?.delta === 'string' ? params.delta : '';
  if (!delta) return [];
  const planId = readPlanItemId(params);
  const current = planId && state.planTextByItemId instanceof Map
    ? (state.planTextByItemId.get(planId) || '')
    : '';
  const bodyMarkdown = current + delta;
  if (planId && state.planTextByItemId instanceof Map) {
    state.planTextByItemId.set(planId, bodyMarkdown);
  }
  return [planEvent({
    planId,
    bodyMarkdown,
    state: 'drafting',
    source: 'codex-app-server',
    providerThreadId: readPlanThreadId(params),
    providerTurnId: readPlanTurnId(params),
  })];
}

function parseTurnPlanUpdated(params) {
  const items = Array.isArray(params?.plan)
    ? params.plan.map((item) => ({
      text: item?.step || '',
      status: normalizePlanStepStatus(item?.status),
    }))
    : [];
  const state = items.length > 0 ? 'awaiting_decision' : 'drafting';
  return planEvent({
    planId: params?.turnId,
    title: params?.explanation || undefined,
    items,
    state,
    source: 'codex-app-server',
    providerThreadId: params?.threadId,
    providerTurnId: params?.turnId,
  });
}

function parseThreadItem(item, lifecycle = 'completed', params = {}, state = {}) {
  const events = [];
  const providerItemId = readProviderItemId(params, item);
  const sharedOperationFields = {
    ...(providerItemId ? { providerToolUseId: providerItemId } : {}),
    ...(typeof item?.cwd === 'string' && item.cwd.trim() ? { cwd: item.cwd.trim() } : {}),
    ...(Number.isFinite(Number(item?.durationMs)) ? { durationMs: Number(item.durationMs) } : {}),
  };
  switch (item.type) {
    case 'agentMessage':
      {
        const streamId = agentMessageStreamId(params, item);
        const declaredText = typeof item.text === 'string' ? item.text : '';
        const streamedText = state.agentMessageTextByItemId instanceof Map
          ? (state.agentMessageTextByItemId.get(streamId) || '')
          : '';
        // A nonempty completed item is authoritative. An empty or omitted
        // item text is a protocol shape used by some app-server versions, so
        // recover the exact text that was already streamed for this item.
        const content = declaredText || streamedText;
        if (content) {
          events.push(messageEvent('assistant', content, undefined, {
          // Codex replays the completed agentMessage during recovery. Keep
          // its stable item id so provider-event dedup can enforce exactly
          // once history publication across a control-plane restart.
          ...(providerItemId ? { providerMessageId: providerItemId } : {}),
          ...(['commentary', 'final_answer'].includes(item.phase) ? { messagePhase: item.phase } : {}),
          }));
        }
        if (lifecycle === 'completed') state.agentMessageTextByItemId?.delete(streamId);
      }
      break;

    case 'plan': {
      const planId = readPlanItemId({ ...params, item }) || item.id;
      const bufferedText = planId && state.planTextByItemId instanceof Map
        ? (state.planTextByItemId.get(planId) || '')
        : '';
      const bodyMarkdown = String(item.text || bufferedText || '').trim();
      if (bodyMarkdown) {
        events.push(planEvent({
          planId,
          bodyMarkdown,
          state: lifecycle === 'completed' ? 'awaiting_decision' : 'drafting',
          source: 'codex-app-server',
          providerThreadId: readPlanThreadId(params),
          providerTurnId: readPlanTurnId(params),
        }));
      }
      if (planId && state.planTextByItemId instanceof Map && lifecycle === 'completed') {
        state.planTextByItemId.delete(planId);
      }
      break;
    }

    case 'reasoning': {
      const parts = [
        ...(Array.isArray(item.summary) ? item.summary : []),
        ...(Array.isArray(item.content) ? item.content : []),
      ].map((part) => typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '').filter(Boolean);
      const buffered = providerItemId ? state.reasoningTextByItemId?.get(providerItemId) : null;
      if (parts.length === 0 && lifecycle === 'completed' && buffered) {
        for (const sections of [buffered.summary, buffered.content]) {
          parts.push(...[...sections.entries()].sort(([left], [right]) => left - right).map(([, value]) => value));
        }
      }
      if (lifecycle === 'completed' && providerItemId) state.reasoningTextByItemId?.delete(providerItemId);
      if (parts.length > 0) events.push(reasoningEvent(parts.join('\n\n'), {
        ...(providerItemId ? { providerMessageId: providerItemId, providerBlockId: providerItemId } : {}),
        reasoningLifecycle: lifecycle === 'completed' ? 'completed' : 'delta',
        state: lifecycle === 'completed' ? 'completed' : 'running',
      }));
      break;
    }

    case 'commandExecution':
      if (lifecycle === 'started' || item.status === 'inProgress') {
        events.push(toolUseEvent('bash', formatCommandValue(item.command), buildOperationFields(
          params,
          item,
          'started',
          {
            ...sharedOperationFields,
            operationKind: 'command',
            command: formatCommandValue(item.command),
            ...(Array.isArray(item.commandActions) ? { providerActions: item.commandActions } : {}),
          },
        )));
      }
      if (['completed', 'failed', 'declined'].includes(item.status)) {
        events.push(toolUseEvent('bash', formatCommandValue(item.command), buildOperationFields(
          params,
          item,
          item.status,
          {
            ...sharedOperationFields,
            operationKind: 'command',
            command: formatCommandValue(item.command),
            ...(Array.isArray(item.commandActions) ? { providerActions: item.commandActions } : {}),
          },
        )));
        events.push(toolResultEvent(
          'bash',
          item.aggregatedOutput || '',
          item.exitCode ?? (item.status === 'completed' ? 0 : 1),
          buildOperationFields(params, item, item.status, {
            ...sharedOperationFields,
            operationKind: 'command',
            command: formatCommandValue(item.command),
            ...(Array.isArray(item.commandActions) ? { providerActions: item.commandActions } : {}),
          }),
        ));
      }
      break;

    case 'fileChange':
      if (lifecycle === 'started' || item.status === 'inProgress') {
        const filePaths = Array.isArray(item.changes)
          ? item.changes.map((change) => change?.path).filter(Boolean)
          : [];
        events.push(toolUseEvent('file_change', JSON.stringify({ filePaths }), buildOperationFields(
          params,
          item,
          'started',
          {
            ...sharedOperationFields,
            operationKind: 'file_edit',
            operationDetail: filePaths[0] || '',
          },
        )));
      }
      if ((lifecycle === 'completed' || item.status === 'completed') && Array.isArray(item.changes)) {
        for (const change of item.changes) {
          events.push(fileChangeEvent(change.path, change.kind, change, buildOperationFields(
            params,
            item,
            item.status === 'failed' ? 'failed' : 'completed',
            {
              ...sharedOperationFields,
              operationKind: 'file_edit',
            },
          )));
        }
      }
      break;

    case 'mcpToolCall': {
      const toolName = `${item.server}/${item.tool}`;
      const operationLifecycle = ['completed', 'failed'].includes(item.status)
        ? item.status
        : 'started';
      events.push(toolUseEvent(toolName, JSON.stringify(item.arguments || {}), buildOperationFields(
        params,
        item,
        operationLifecycle,
        {
          ...sharedOperationFields,
          operationKind: 'mcp',
        },
      )));
      if (['completed', 'failed'].includes(item.status)) {
        const output = item.error
          ? `Error: ${readErrorMessage(item.error)}`
          : item.result
            ? JSON.stringify(item.result)
            : '';
        events.push(toolResultEvent(toolName, output, item.error ? 1 : 0, buildOperationFields(
          params,
          item,
          item.error ? 'failed' : 'completed',
          {
            ...sharedOperationFields,
            operationKind: 'mcp',
          },
        )));
      }
      break;
    }

    case 'webSearch':
      events.push(toolUseEvent('web_search', item.query || '', buildOperationFields(
        params,
        item,
        lifecycle === 'completed' ? 'completed' : 'started',
        {
          ...sharedOperationFields,
          operationKind: 'web',
          operationDetail: item.query || '',
        },
      )));
      break;

    default:
      break;
  }
  return events;
}

function parseFileChangePatch(params) {
  const events = [];
  const changes = Array.isArray(params?.changes) ? params.changes : [];
  for (const change of changes) {
    events.push(fileChangeEvent(change.path, change.kind, change, buildOperationFields(
      params,
      null,
      'delta',
      {
        operationKind: 'file_edit',
        operationDetail: change.path || '',
      },
    )));
  }
  return events;
}

function parseTokenUsage(tokenUsage) {
  if (!tokenUsage || typeof tokenUsage !== 'object') return [];
  return [usageEvent({
    contextTokens: Number.isFinite(tokenUsage.totalTokens) ? tokenUsage.totalTokens : undefined,
    inputTokens: Number.isFinite(tokenUsage.inputTokens) ? tokenUsage.inputTokens : undefined,
    outputTokens: Number.isFinite(tokenUsage.outputTokens) ? tokenUsage.outputTokens : undefined,
    cachedInputTokens: Number.isFinite(tokenUsage.cachedInputTokens) ? tokenUsage.cachedInputTokens : undefined,
    reasoningTokens: Number.isFinite(tokenUsage.reasoningOutputTokens) ? tokenUsage.reasoningOutputTokens : undefined,
    contextWindowTokens: Number.isFinite(tokenUsage.contextWindow) ? tokenUsage.contextWindow : undefined,
    contextSource: 'codex-app-server',
  })];
}

function parseTurnCompleted(params) {
  const status = typeof params?.turn?.status === 'string' ? params.turn.status.trim() : '';
  const providerThreadId = typeof params?.threadId === 'string' ? params.threadId.trim() : '';
  const providerTurnId = typeof params?.turn?.id === 'string'
    ? params.turn.id.trim()
    : typeof params?.turnId === 'string'
      ? params.turnId.trim()
      : '';
  const providerFields = {
    provider: 'codex',
    runtimeFamily: CODEX_APP_SERVER_RUNTIME_FAMILY,
    ...(providerThreadId ? { providerThreadId } : {}),
    ...(providerTurnId ? { providerTurnId } : {}),
    providerLifecycle: status || 'unknown',
  };
  const content = status === 'failed'
    ? `error: ${readErrorMessage(params?.turn?.error)}`
    : status === 'interrupted'
      ? 'interrupted'
      : status === 'completed'
        ? 'completed'
        : `turn status: ${status || 'unknown'}`;
  const events = [statusEvent(
    content,
    status === 'failed'
      ? annotateProviderError(providerFields, params?.turn?.error)
      : providerFields,
  )];
  if (Array.isArray(params?.turn?.items)) {
    for (const item of params.turn.items) {
      events.push(...parseThreadItem(item, status === 'completed' ? 'completed' : 'started'));
    }
  }
  return events;
}
