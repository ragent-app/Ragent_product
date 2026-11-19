import {
  approvalRequestEvent,
  approvalResponseEvent,
  messageEvent,
  reasoningEvent,
  statusEvent,
  toolResultEvent,
  toolUseEvent,
  textDeltaEvent,
  usageEvent,
} from '../normalizer.mjs';
import { explanationForApproval } from '../risk-explanation.mjs';
import {
  normalizeProviderToolLifecycle,
  readProviderToolCallId,
  serializeProviderToolValue,
} from '../provider-tool-normalization.mjs';

export function acpRequest(id, method, params = {}) {
  return `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
}

export function buildAcpStartInput({
  clientName = 'Ragent',
  clientVersion = '1.0',
  protocolVersion = 1,
  clientCapabilities = {},
} = {}) {
  const capabilities = clientCapabilities && typeof clientCapabilities === 'object' && !Array.isArray(clientCapabilities)
    ? clientCapabilities
    : {};
  return acpRequest('ragent-initialize', 'initialize', {
    protocolVersion,
    clientInfo: { name: clientName, version: clientVersion },
    clientCapabilities: capabilities,
  });
}

export function buildAcpSessionInput({
  cwd,
  mcpServers = [],
  resumeSessionId = '',
  additionalDirectories = [],
} = {}) {
  const servers = Array.isArray(mcpServers)
    ? mcpServers.filter((server) => server && typeof server === 'object' && (server.command || server.url))
    : [];
  const extraDirs = Array.isArray(additionalDirectories)
    ? [...new Set(additionalDirectories.map((dir) => text(dir)).filter(Boolean))]
    : [];
  const normalizedResumeId = text(resumeSessionId);
  const commonParams = {
    cwd: cwd || '',
    mcpServers: servers,
    ...(extraDirs.length > 0 ? { additionalDirectories: extraDirs } : {}),
  };
  return normalizedResumeId
    ? acpRequest('ragent-session-load', 'session/load', {
      sessionId: normalizedResumeId,
      ...commonParams,
    })
    : acpRequest('ragent-session-new', 'session/new', commonParams);
}

export function isAcpInitializeAccepted(payload) {
  return payload?.jsonrpc === '2.0' && payload.id === 'ragent-initialize'
    && !payload.error && payload.result?.protocolVersion === 1;
}

export function buildAcpPromptInput(sessionId, prompt, requestId = 'ragent-prompt') {
  return acpRequest(requestId, 'session/prompt', {
    sessionId, prompt: [{ type: 'text', text: typeof prompt === 'string' ? prompt : '' }],
  });
}

export function buildAcpModeSwitchInput(sessionId, modeId, availableModes, requestId = 'ragent-set-mode') {
  if (!text(sessionId) || !text(modeId) || !Array.isArray(availableModes)
      || !availableModes.some((mode) => mode?.id === modeId || mode?.value === modeId)) return null;
  return acpRequest(requestId, 'session/set_mode', { sessionId, modeId });
}

export function acpAvailableModesFromResponse(payload) {
  const modes = payload?.result?.modes?.availableModes;
  if (Array.isArray(modes)) return modes;
  const modeOption = acpConfigOptionsFromResponse(payload).find((option) => option?.id === 'mode') || null;
  return Array.isArray(modeOption?.options) ? modeOption.options : [];
}

export function isAcpModeSwitchAccepted(payload, requestId = 'ragent-set-mode') {
  return isAcpObjectResponseAccepted(payload, requestId);
}

export function acpConfigOptionsFromResponse(payload) {
  return Array.isArray(payload?.result?.configOptions) ? payload.result.configOptions : [];
}

export function acpConfigOptionValue(payload, configId) {
  const target = text(configId);
  if (!target) return '';
  const match = acpConfigOptionsFromResponse(payload).find((option) => option?.id === target);
  return text(match?.currentValue);
}

export function acpAvailableModelsFromResponse(payload) {
  const models = payload?.result?.models?.availableModels;
  if (Array.isArray(models)) return models;
  const modelOption = acpConfigOptionsFromResponse(payload).find((option) => option?.id === 'model') || null;
  return Array.isArray(modelOption?.options) ? modelOption.options : [];
}

export function buildAcpSetConfigOptionInput(sessionId, configId, value, requestId = 'ragent-set-config-option') {
  const normalizedSessionId = text(sessionId);
  const normalizedConfigId = text(configId);
  const normalizedValue = typeof value === 'string' ? value.trim() : '';
  if (!normalizedSessionId || !normalizedConfigId || !normalizedValue) return null;
  return acpRequest(requestId, 'session/set_config_option', {
    sessionId: normalizedSessionId,
    configId: normalizedConfigId,
    value: normalizedValue,
  });
}

export function isAcpConfigOptionAccepted(payload, requestId = 'ragent-set-config-option') {
  return isAcpObjectResponseAccepted(payload, requestId);
}

export function buildAcpCancelNotification(sessionId) {
  const normalizedSessionId = text(sessionId);
  if (!normalizedSessionId) return null;
  return `${JSON.stringify({
    jsonrpc: '2.0',
    method: 'session/cancel',
    params: { sessionId: normalizedSessionId },
  })}\n`;
}

export function buildAcpCloseSessionInput(sessionId, requestId = 'ragent-session-close') {
  const normalizedSessionId = text(sessionId);
  if (!normalizedSessionId) return null;
  return acpRequest(requestId, 'session/close', { sessionId: normalizedSessionId });
}

export function isAcpSessionClosed(payload, requestId = 'ragent-session-close') {
  return isAcpObjectResponseAccepted(payload, requestId);
}

function isAcpObjectResponseAccepted(payload, requestId) {
  return payload?.jsonrpc === '2.0' && payload.id === requestId
    && !payload.error && payload.result !== null
    && typeof payload.result === 'object' && !Array.isArray(payload.result);
}

function isValidAcpRequestId(id) {
  return (typeof id === 'string' && id.length > 0 && id.length <= 256)
    || (typeof id === 'number' && Number.isSafeInteger(id));
}

export function parseAcpPermissionRequest(request, expectedSessionId = '') {
  if (request?.jsonrpc !== '2.0' || request?.method !== 'session/request_permission') return null;
  if (!isValidAcpRequestId(request.id)) return null;
  const sessionId = text(request.params?.sessionId || request.params?.session_id);
  const requiredSession = text(expectedSessionId);
  if (!sessionId || (requiredSession && sessionId !== requiredSession)) return null;
  const rawToolCall = request.params?.toolCall && typeof request.params.toolCall === 'object'
    ? request.params.toolCall
    : {};
  const explicitName = text(rawToolCall.name || rawToolCall.toolName || rawToolCall.tool_name);
  const explicitTitle = text(rawToolCall.title);
  const options = Array.isArray(request.params?.options)
    ? request.params.options
      .filter((option) => option && typeof option === 'object' && text(option.optionId))
      .map((option) => ({
        optionId: text(option.optionId),
        name: text(option.name),
        kind: text(option.kind),
      }))
    : [];
  return {
    id: request.id,
    sessionId,
    toolCall: {
      toolCallId: readProviderToolCallId(rawToolCall) || text(rawToolCall.id),
      name: explicitName || explicitTitle,
      title: explicitTitle,
      kind: text(rawToolCall.kind),
      status: text(rawToolCall.status),
      input: rawToolCall.rawInput ?? rawToolCall.input ?? rawToolCall.args ?? null,
    },
    options,
  };
}

export function buildAcpPermissionResponse(request, decisionOrOptions = {}, expectedSessionId = '') {
  const spec = typeof decisionOrOptions === 'string'
    ? { kind: decisionOrOptions }
    : (decisionOrOptions && typeof decisionOrOptions === 'object' ? decisionOrOptions : {});
  const parsed = parseAcpPermissionRequest(request, spec.sessionId || expectedSessionId);
  if (!parsed) return null;

  const requestedKind = text(spec.kind || spec.decision);
  const requestedOptionId = text(spec.optionId);
  let outcome = null;

  if (requestedKind === 'cancelled') {
    outcome = { outcome: 'cancelled' };
  } else if (requestedOptionId) {
    const exactOption = parsed.options.find((option) => option.optionId === requestedOptionId);
    if (!exactOption) return null;
    outcome = { outcome: 'selected', optionId: exactOption.optionId };
  } else if (requestedKind) {
    let matched = parsed.options.find((option) => option.kind === requestedKind) || null;
    if (!matched && requestedKind === 'allow_always' && spec.allowFallbackToOnce === true) {
      matched = parsed.options.find((option) => option.kind === 'allow_once') || null;
    }
    if (matched) {
      outcome = { outcome: 'selected', optionId: matched.optionId };
    } else if (requestedKind === 'reject_once') {
      outcome = { outcome: 'cancelled' };
    } else {
      return null;
    }
  } else {
    return null;
  }

  return {
    line: `${JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { outcome } })}\n`,
    outcome,
    optionId: outcome.optionId || '',
    cancelled: outcome.outcome === 'cancelled',
  };
}

export function buildAcpApprovalId(provider, requestId) {
  const normalizedProvider = text(provider) || 'acp';
  if (requestId === undefined || requestId === null || requestId === '') return '';
  return `${normalizedProvider}:${String(requestId).trim()}`;
}

export function describeAcpPermissionToolCall(toolCall = {}) {
  const tc = toolCall && typeof toolCall === 'object' ? toolCall : {};
  const input = tc.input && typeof tc.input === 'object' && !Array.isArray(tc.input) ? tc.input : {};
  const name = text(tc.name);
  const kind = text(tc.kind).toLowerCase();
  const approvalKind = name === 'AskUserQuestion'
    ? 'question'
    : name === 'ExitPlanMode'
      ? 'plan'
      : (kind === 'execute' || ['run_command', 'bash', 'Bash', 'PowerShell', 'powershell', 'command_status', 'send_command_input'].includes(name))
        ? 'command'
        : (['edit', 'write', 'delete', 'move'].includes(kind)
            || ['write_to_file', 'replace_file_content', 'multi_replace_file_content', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(name))
          ? 'file_change'
          : 'permissions';

  let command = '';
  if (approvalKind === 'command') {
    const rawCommand = input.CommandLine ?? input.commandLine ?? input.command ?? input.cmd ?? input.script;
    if (typeof rawCommand === 'string') {
      command = rawCommand.trim();
    } else if (Array.isArray(rawCommand)) {
      command = rawCommand.map((part) => text(String(part ?? ''))).filter(Boolean).join(' ');
    }
  }

  const filePaths = [];
  for (const key of ['TargetFile', 'target_file', 'file_path', 'filePath', 'path', 'AbsolutePath', 'absolute_path', 'DirectoryPath', 'SearchDirectory']) {
    const candidate = text(input[key]);
    if (candidate && !filePaths.includes(candidate)) filePaths.push(candidate);
  }
  const cwd = text(input.cwd || input.Cwd || input.workingDirectory);
  const title = text(tc.title) || name || 'Tool permission';
  const reason = text(input.toolSummary || input.summary || input.description)
    || (command ? '' : (text(tc.title) && text(tc.title) !== name ? text(tc.title) : name));

  return {
    name,
    kind,
    approvalKind,
    command,
    cwd,
    filePaths,
    title,
    reason,
    input,
  };
}

// ACP v1 reverse-RPC requests must receive an explicit decision. For an
// unattended Run, only a one-time reject option is safe to select: an
// allow_* option would widen authority and reject_always would persist policy.
export function buildAcpUnattendedPermissionDenial(request, sessionId) {
  if (!text(sessionId)) return null;
  const response = buildAcpPermissionResponse(request, 'reject_once', sessionId);
  return response ? { line: response.line, cancelled: response.cancelled } : null;
}

export function isAcpResponse(payload, id) {
  return payload && payload.id === id && (Object.hasOwn(payload, 'result') || payload.error);
}

export function acpSessionIdFromResponse(payload) {
  return text(payload?.result?.sessionId || payload?.result?.session_id);
}

export function acpResponseError(payload) {
  return text(payload?.error?.message || payload?.error?.data?.message);
}

function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function finiteNonNegativeNumber(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}
function contentOf(update) {
  const content = update?.content || update?.message || update?.text;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'string' ? part : text(part?.text || part?.thinking || part?.content))).join('');
  }
  return text(content?.text || content?.thinking || content?.content);
}
function normalizeAcpUsageFields(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const inputTokens = finiteNonNegativeNumber(usage.inputTokens ?? usage.input_tokens);
  const outputTokens = finiteNonNegativeNumber(usage.outputTokens ?? usage.output_tokens);
  const cachedInputTokens = finiteNonNegativeNumber(
    usage.cachedReadTokens ?? usage.cache_read_tokens ?? usage.cachedInputTokens ?? usage.cached_input_tokens,
  );
  const reasoningTokens = finiteNonNegativeNumber(
    usage.thoughtTokens ?? usage.thinking_tokens ?? usage.reasoningTokens ?? usage.reasoning_tokens,
  );
  const contextTokens = finiteNonNegativeNumber(usage.totalTokens ?? usage.total_tokens ?? usage.contextTokens);
  const contextWindowTokens = finiteNonNegativeNumber(usage.contextWindowTokens ?? usage.size);
  const fields = {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(contextTokens !== undefined ? { contextTokens } : {}),
    ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
  };
  return Object.keys(fields).length > 0 ? fields : null;
}

export function parseAcpEvent(line, {
  provider = 'external-harness',
  runtimeFamily = 'acp',
  toolCalls = null,
  autoApprovedIds = null,
} = {}) {
  let payload;
  try { payload = JSON.parse(String(line || '').trim()); } catch { return []; }
  const fields = { provider, runtimeFamily };
  if (payload?.type === 'ragent.approval_response') {
    const approvalId = text(payload.approvalId);
    if ((payload.autoApproved === true || payload.autoDenied === true) && approvalId) {
      autoApprovedIds?.add?.(approvalId);
      return [];
    }
    const responseEvent = approvalResponseEvent({
      approvalId,
      decision: payload.decision,
      status: payload.status,
      source: text(payload.provider) || runtimeFamily || provider,
      providerRequestId: payload.providerRequestId,
      providerMethod: payload.providerMethod,
    });
    return responseEvent ? [{ ...responseEvent, ...fields }] : [];
  }
  if (payload?.method === 'session/request_permission') {
    const permissionReq = parseAcpPermissionRequest(payload);
    if (!permissionReq) return [];
    const approvalId = buildAcpApprovalId(provider, permissionReq.id);
    if (approvalId && autoApprovedIds?.has?.(approvalId)) return [];
    const details = describeAcpPermissionToolCall(permissionReq.toolCall);
    const requestEvent = approvalRequestEvent({
      approvalId,
      providerRequestId: String(permissionReq.id),
      providerMethod: 'session/request_permission',
      providerItemId: permissionReq.toolCall.toolCallId,
      providerToolUseId: permissionReq.toolCall.toolCallId,
      operation: details.name,
      kind: details.approvalKind,
      title: details.title,
      reason: details.reason,
      command: details.command,
      cwd: details.cwd,
      filePaths: details.filePaths,
      permissions: { options: permissionReq.options },
      status: 'pending',
      source: runtimeFamily,
      ...(details.command
        ? { explanation: explanationForApproval({ command: details.command, cwd: details.cwd, providerDescription: details.reason }) }
        : {}),
    });
    return requestEvent
      ? [{ ...requestEvent, ...fields, ...(permissionReq.sessionId ? { providerSessionId: permissionReq.sessionId } : {}) }]
      : [];
  }
  const paramsSessionId = text(payload.params?.sessionId || payload.params?.session_id);
  if (payload.method === 'session/update') {
    const update = payload.params?.update || payload.params || {};
    const content = contentOf(update);
    const toolCallId = readProviderToolCallId(update) || text(update.id);
    const messageId = text(update.messageId || update.message_id || update.id);
    const identity = {
      ...fields,
      ...(paramsSessionId ? { providerSessionId: paramsSessionId } : {}),
      ...(toolCallId ? { providerToolUseId: toolCallId } : {}),
      ...(messageId ? { providerMessageId: messageId } : {}),
    };
    if (update.sessionUpdate === 'agent_message_chunk' && content) return [textDeltaEvent(0, content, identity)];
    if (update.sessionUpdate === 'agent_thought_chunk' && content) return [reasoningEvent(content, {
      ...identity,
      providerBlockId: messageId || 'thinking:0',
      blockIndex: 0,
      providerLifecycle: 'delta',
      reasoningLifecycle: 'delta',
      operationLifecycle: 'delta',
      state: 'running',
    })];
    if (update.sessionUpdate === 'usage_update') {
      const used = finiteNonNegativeNumber(update.used);
      const size = finiteNonNegativeNumber(update.size);
      if (used === undefined && size === undefined) return [];
      return [usageEvent({
        ...(used !== undefined ? { contextTokens: used } : {}),
        ...(size !== undefined ? { contextWindowTokens: size } : {}),
        contextSource: 'provider_context_window',
        ...fields,
        ...(paramsSessionId ? { providerSessionId: paramsSessionId } : {}),
      })];
    }
    if (update.sessionUpdate === 'tool_call') {
      const explicitName = text(update.name || update.toolName || update.tool_name);
      const explicitTitle = text(update.title);
      const toolName = explicitName || explicitTitle || 'tool';
      const input = update.rawInput ?? update.input ?? update.args ?? '';
      const kind = text(update.kind);
      if (toolCallId && toolCalls instanceof Map) {
        toolCalls.set(toolCallId, { toolName, title: explicitTitle, kind, input });
      }
      return [toolUseEvent(toolName, input, {
        ...identity,
        ...(explicitTitle ? { providerTitle: explicitTitle, operationTitle: explicitTitle } : {}),
        ...(kind ? { providerToolKind: kind } : {}),
        operationLifecycle: 'started',
      })];
    }
    if (update.sessionUpdate === 'tool_call_update') {
      const known = toolCallId && toolCalls instanceof Map ? toolCalls.get(toolCallId) : null;
      const explicitName = text(update.name || update.toolName || update.tool_name);
      const explicitTitle = text(update.title);
      const toolName = explicitName || known?.toolName || explicitTitle || 'tool';
      const title = explicitTitle || known?.title || '';
      const kind = text(update.kind) || known?.kind || '';
      const lifecycle = normalizeProviderToolLifecycle(update.status || update.state, { update: true });
      const failed = ['failed', 'cancelled'].includes(lifecycle);
      const output = update.rawOutput ?? update.output ?? update.content ?? update.status ?? '';
      if (toolCallId && toolCalls instanceof Map && lifecycle !== 'delta') toolCalls.delete(toolCallId);
      return [toolResultEvent(toolName, serializeProviderToolValue(output), failed ? 1 : (lifecycle === 'completed' ? 0 : undefined), {
        ...identity,
        ...(title ? { providerTitle: title, operationTitle: title } : {}),
        ...(kind ? { providerToolKind: kind } : {}),
        operationLifecycle: lifecycle,
      })];
    }
    return [];
  }
  if (payload.error) return [statusEvent(`error: ${text(payload.error.message) || 'ACP request failed'}`, { ...fields, runState: 'failed' })];
  if ((payload.id === 'ragent-session-new' || payload.id === 'ragent-session-load') && !payload.error) {
    const responseSessionId = acpSessionIdFromResponse(payload);
    return [statusEvent(payload.id === 'ragent-session-load' ? 'ACP session resumed' : 'ACP session started', {
      ...fields,
      ...(responseSessionId ? { providerSessionId: responseSessionId } : {}),
    })];
  }
  const promptId = typeof payload.id === 'string' && (payload.id === 'ragent-prompt' || payload.id.startsWith('ragent-prompt-'));
  if (promptId && payload.result) {
    const events = [];
    const usage = normalizeAcpUsageFields(payload.result.usage);
    if (usage) {
      events.push(usageEvent({
        ...usage,
        contextSource: 'provider_turn_usage',
        ...fields,
        ...(paramsSessionId ? { providerSessionId: paramsSessionId } : {}),
      }));
    }
    const stopReason = text(payload.result.stopReason || payload.result.stop_reason);
    const cancelled = stopReason === 'cancelled' || stopReason === 'canceled';
    events.push(statusEvent(cancelled ? 'cancelled' : 'completed', {
      ...fields,
      ...(paramsSessionId ? { providerSessionId: paramsSessionId } : {}),
      runState: cancelled ? 'cancelled' : 'completed',
      ...(stopReason ? { stopReason } : {}),
    }));
    return events;
  }
  return [];
}

export function createAcpEventParser({ provider = 'external-harness', runtimeFamily = 'acp' } = {}) {
  const toolCalls = new Map();
  const autoApprovedIds = new Set();
  return {
    parseLine(line) {
      return parseAcpEvent(line, { provider, runtimeFamily, toolCalls, autoApprovedIds });
    },
    seedAutoApprovedIds(ids = []) {
      for (const id of Array.isArray(ids) ? ids : []) {
        const trimmed = text(id);
        if (trimmed) autoApprovedIds.add(trimmed);
      }
    },
    reset() {
      toolCalls.clear();
    },
  };
}
