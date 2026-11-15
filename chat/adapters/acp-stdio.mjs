import { messageEvent, reasoningEvent, statusEvent, toolResultEvent, toolUseEvent, textDeltaEvent } from '../normalizer.mjs';
import {
  normalizeProviderToolLifecycle,
  readProviderToolCallId,
  serializeProviderToolValue,
} from '../provider-tool-normalization.mjs';

export function acpRequest(id, method, params = {}) {
  return `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
}

export function buildAcpStartInput({ clientName = 'Ragent', clientVersion = '1.0' } = {}) {
  return acpRequest('ragent-initialize', 'initialize', {
    protocolVersion: 1,
    clientInfo: { name: clientName, version: clientVersion },
    clientCapabilities: {},
  });
}

export function buildAcpSessionInput({ cwd, mcpServers = [], resumeSessionId = '' } = {}) {
  const servers = Array.isArray(mcpServers)
    ? mcpServers.filter((server) => server && typeof server === 'object' && server.command)
    : [];
  const normalizedResumeId = text(resumeSessionId);
  const startRequest = normalizedResumeId
    ? acpRequest('ragent-session-load', 'session/load', {
      sessionId: normalizedResumeId,
      cwd: cwd || '',
      mcpServers: servers,
    })
    : acpRequest('ragent-session-new', 'session/new', { cwd: cwd || '', mcpServers: servers });
  return startRequest;
}

export function isAcpInitializeAccepted(payload) {
  return payload?.jsonrpc === '2.0' && payload.id === 'ragent-initialize'
    && !payload.error && payload.result?.protocolVersion === 1;
}

export function buildAcpPromptInput(sessionId, prompt) {
  return acpRequest('ragent-prompt', 'session/prompt', {
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
  const modeOption = Array.isArray(payload?.result?.configOptions)
    ? payload.result.configOptions.find((option) => option?.id === 'mode')
    : null;
  return Array.isArray(modeOption?.options) ? modeOption.options : [];
}

export function isAcpModeSwitchAccepted(payload, requestId = 'ragent-set-mode') {
  return payload?.jsonrpc === '2.0' && payload.id === requestId
    && !payload.error && payload.result !== null
    && typeof payload.result === 'object' && !Array.isArray(payload.result);
}

// ACP v1 reverse-RPC requests must receive an explicit decision. For an
// unattended Run, only a one-time reject option is safe to select: an
// allow_* option would widen authority and reject_always would persist policy.
export function buildAcpUnattendedPermissionDenial(request, sessionId) {
  if (request?.jsonrpc !== '2.0' || request?.method !== 'session/request_permission') return null;
  const id = request.id;
  if (!(typeof id === 'string' && id.length > 0 && id.length <= 256)
      && !(typeof id === 'number' && Number.isSafeInteger(id))) return null;
  if (!sessionId || request.params?.sessionId !== sessionId) return null;
  const reject = Array.isArray(request.params?.options)
    ? request.params.options.find((option) => option?.kind === 'reject_once'
      && typeof option.optionId === 'string' && option.optionId.length > 0)
    : null;
  const outcome = reject
    ? { outcome: 'selected', optionId: reject.optionId }
    : { outcome: 'cancelled' };
  return {
    line: `${JSON.stringify({ jsonrpc: '2.0', id, result: { outcome } })}\n`,
    cancelled: !reject,
  };
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
function contentOf(update) {
  const content = update?.content || update?.message || update?.text;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'string' ? part : text(part?.text || part?.content))).join('');
  }
  return text(content?.text || content?.content);
}

export function parseAcpEvent(line, {
  provider = 'external-harness',
  runtimeFamily = 'acp',
  toolCalls = null,
} = {}) {
  let payload;
  try { payload = JSON.parse(String(line || '').trim()); } catch { return []; }
  const fields = { provider, runtimeFamily };
  if (payload.method === 'session/update') {
    const update = payload.params?.update || payload.params || {};
    const content = contentOf(update);
    const toolCallId = readProviderToolCallId(update) || text(update.id);
    const messageId = text(update.messageId || update.message_id || update.id);
    const identity = {
      ...fields,
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
    if (update.sessionUpdate === 'tool_call') {
      const toolName = text(update.title || update.name) || 'tool';
      if (toolCallId && toolCalls instanceof Map) toolCalls.set(toolCallId, { toolName, input: update.rawInput ?? update.input ?? '' });
      return [toolUseEvent(toolName, update.rawInput ?? update.input ?? '', {
        ...identity,
        operationLifecycle: 'started',
      })];
    }
    if (update.sessionUpdate === 'tool_call_update') {
      const known = toolCallId && toolCalls instanceof Map ? toolCalls.get(toolCallId) : null;
      const toolName = text(update.title || update.name) || known?.toolName || 'tool';
      const lifecycle = normalizeProviderToolLifecycle(update.status || update.state, { update: true });
      const failed = ['failed', 'cancelled'].includes(lifecycle);
      const output = update.rawOutput ?? update.output ?? update.content ?? update.status ?? '';
      if (toolCallId && toolCalls instanceof Map && lifecycle !== 'delta') toolCalls.delete(toolCallId);
      return [toolResultEvent(toolName, serializeProviderToolValue(output), failed ? 1 : (lifecycle === 'completed' ? 0 : undefined), {
        ...identity,
        operationLifecycle: lifecycle,
      })];
    }
    return [];
  }
  if (payload.error) return [statusEvent(`error: ${text(payload.error.message) || 'ACP request failed'}`, { ...fields, runState: 'failed' })];
  if ((payload.id === 'ragent-session-new' || payload.id === 'ragent-session-load') && !payload.error) {
    return [statusEvent(payload.id === 'ragent-session-load' ? 'ACP session resumed' : 'ACP session started', {
      ...fields,
      ...(payload.result?.sessionId ? { providerSessionId: payload.result.sessionId } : {}),
    })];
  }
  if (payload.id === 'ragent-prompt' && payload.result) return [statusEvent('completed', { ...fields, runState: 'completed' })];
  return [];
}

export function createAcpEventParser({ provider = 'external-harness', runtimeFamily = 'acp' } = {}) {
  const toolCalls = new Map();
  return {
    parseLine(line) {
      return parseAcpEvent(line, { provider, runtimeFamily, toolCalls });
    },
    reset() {
      toolCalls.clear();
    },
  };
}
