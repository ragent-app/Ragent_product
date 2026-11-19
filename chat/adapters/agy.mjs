import {
  fileChangeEvent,
  messageEvent,
  statusEvent,
  toolResultEvent,
  toolUseEvent,
  textDeltaEvent,
  usageEvent,
} from '../normalizer.mjs';
import { annotateProviderError, getProviderCapabilities } from '../provider-contract.mjs';
import { inferProviderFileChange } from '../provider-tool-normalization.mjs';

export { buildAgyStreamInput } from '../../lib/agy-runtime.mjs';

export const AGY_CANONICAL_PROVIDER = 'agy';
export const AGY_RUNTIME_FAMILY = 'agy-json';
export const AGY_STREAM_RUNTIME_FAMILY = 'agy-stream-json';
// AgY's own print-mode default is 5 minutes.  A Run is durable and already
// has a separate finite idle watchdog, so give the provider enough wall-clock
// time for genuinely long tasks without making the process unbounded.
export const DEFAULT_AGY_PRINT_TIMEOUT = '24h';

function providerFields(providerSessionId, runtimeFamily, extra = {}) {
  return {
    provider: AGY_CANONICAL_PROVIDER,
    runtimeFamily,
    ...(providerSessionId ? { providerSessionId } : {}),
    ...extra,
  };
}

function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function usageFields(usage = {}) {
  return {
    ...(toFiniteNumber(usage.input_tokens) !== undefined ? { inputTokens: toFiniteNumber(usage.input_tokens) } : {}),
    ...(toFiniteNumber(usage.output_tokens) !== undefined ? { outputTokens: toFiniteNumber(usage.output_tokens) } : {}),
    ...(toFiniteNumber(usage.thinking_tokens) !== undefined ? { reasoningTokens: toFiniteNumber(usage.thinking_tokens) } : {}),
    ...(toFiniteNumber(usage.cache_read_tokens) !== undefined ? { cachedInputTokens: toFiniteNumber(usage.cache_read_tokens) } : {}),
    ...(toFiniteNumber(usage.total_tokens) !== undefined ? { contextTokens: toFiniteNumber(usage.total_tokens) } : {}),
    contextSource: 'provider_turn_usage',
  };
}

function readErrorText(source) {
  if (typeof source === 'string' && source.trim()) return source.trim();
  if (source && typeof source === 'object') {
    for (const value of [source.message, source.error, source.result, source.status]) {
      if (typeof value === 'string' && value.trim()) return value.trim();
      if (value && typeof value.message === 'string' && value.message.trim()) return value.message.trim();
    }
  }
  return 'Antigravity CLI returned an unsuccessful result';
}

function stringifyToolValue(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function readFirstValue(sources, keys) {
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const key of keys) {
      if (source[key] !== undefined && source[key] !== null) return source[key];
    }
  }
  return undefined;
}

function readToolName(update, fallback = '') {
  const toolInfo = update?.tool_info && typeof update.tool_info === 'object'
    ? update.tool_info
    : {};
  const tool = update?.tool && typeof update.tool === 'object' ? update.tool : {};
  const value = readFirstValue(
    [update, toolInfo, tool],
    ['tool_name', 'name', 'toolName'],
  );
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function readToolInput(update) {
  const toolInfo = update?.tool_info && typeof update.tool_info === 'object'
    ? update.tool_info
    : {};
  const tool = update?.tool && typeof update.tool === 'object' ? update.tool : {};
  const value = readFirstValue(
    [toolInfo, update, tool],
    ['parameters', 'arguments', 'args', 'input', 'tool_input', 'toolInput'],
  );
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const command = readFirstValue([value], [
    'command', 'cmd', 'script', 'CommandLine', 'command_line', 'shellCommand', 'shell_command',
  ]);
  const path = readFirstValue([value], ['path', 'filePath', 'file_path', 'FilePath', 'filename', 'file_name']);
  const query = readFirstValue([value], ['query', 'Query', 'pattern', 'Pattern', 'needle', 'searchTerm', 'search_term']);
  const toolName = readFirstValue([value], ['toolName', 'tool_name', 'mcpTool', 'mcp_tool']);
  return {
    ...value,
    ...(command !== undefined && command !== null ? { command: command } : {}),
    ...(path !== undefined && path !== null ? { path } : {}),
    ...(query !== undefined && query !== null ? { query } : {}),
    ...(toolName !== undefined && toolName !== null ? { toolName } : {}),
  };
}

function readToolOutput(update) {
  const toolInfo = update?.tool_info && typeof update.tool_info === 'object'
    ? update.tool_info
    : {};
  const error = readFirstValue([toolInfo, update], ['error', 'tool_error', 'toolError']);
  if (error !== undefined && error !== null && error !== '') {
    const message = readErrorText(error);
    return message ? `Error: ${message}` : stringifyToolValue(error);
  }
  return readFirstValue(
    [toolInfo, update],
    ['output', 'result', 'tool_output', 'toolOutput', 'response'],
  );
}

function readToolExitCode(update, failed) {
  const toolInfo = update?.tool_info && typeof update.tool_info === 'object'
    ? update.tool_info
    : {};
  const value = readFirstValue(
    [toolInfo, update],
    ['exit_code', 'exitCode', 'status_code', 'statusCode'],
  );
  const number = Number(value);
  return Number.isFinite(number) ? number : (failed ? 1 : 0);
}

function readConversationId(payload, update, result) {
  const value = readFirstValue(
    [payload, update, result],
    ['conversation_id', 'conversationId'],
  );
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function isFailedToolUpdate(update) {
  const state = String(update?.state || '').trim().toUpperCase();
  const toolInfo = update?.tool_info && typeof update.tool_info === 'object'
    ? update.tool_info
    : {};
  const error = readFirstValue([toolInfo, update], ['error', 'tool_error', 'toolError']);
  const toolStatus = String(toolInfo.status || '').trim().toUpperCase();
  return ['ERROR', 'FAILED', 'CANCELLED', 'CANCELED'].includes(state)
    || ['ERROR', 'FAILED', 'CANCELLED', 'CANCELED'].includes(toolStatus)
    || (error !== undefined && error !== null && error !== '');
}

export function createAgyAdapter({
  runtimeFamily = AGY_RUNTIME_FAMILY,
  emitToolEvents = false,
} = {}) {
  let providerSessionId = '';
  let textDeltaOrdinal = 0;
  const toolNamesByStep = new Map();
  const toolInputsByStep = new Map();
  const startedToolSteps = new Set();
  const completedToolSteps = new Set();
  const normalizedRuntimeFamily = String(runtimeFamily || AGY_RUNTIME_FAMILY).trim() || AGY_RUNTIME_FAMILY;

  return {
    capabilities: getProviderCapabilities(normalizedRuntimeFamily),

    parseLine(line) {
      const trimmed = String(line || '').trim();
      if (!trimmed) return [];

      let payload;
      try {
        payload = JSON.parse(trimmed);
      } catch {
        // stream-json is JSONL; diagnostics on stdout are not user content.
        return [];
      }

      const events = [];
      if (payload.event === 'init') {
        providerSessionId = readConversationId(payload, payload.init, null) || providerSessionId;
        events.push(statusEvent(
          `Session started (${providerSessionId || 'unknown'})`,
          providerFields(providerSessionId, normalizedRuntimeFamily, { providerLifecycle: 'session_started' }),
        ));
        return events;
      }

      if (payload.event === 'step_update') {
        const update = payload.step_update && typeof payload.step_update === 'object'
          ? payload.step_update
          : {};
        providerSessionId = readConversationId(payload, update, null) || providerSessionId;
        const stepType = String(update.step_type || '').trim();
        const stepId = Number.isInteger(update.step_index) ? String(update.step_index) : 'unknown';

        if (emitToolEvents && stepType === 'tool') {
          const knownToolName = toolNamesByStep.get(stepId) || '';
          const toolName = readToolName(update, knownToolName) || 'unknown_tool';
          const toolId = `step:${stepId}`;
          const state = String(update.state || '').trim().toUpperCase();
          if (state === 'ACTIVE' && !startedToolSteps.has(stepId)) {
            const toolInput = readToolInput(update);
            toolNamesByStep.set(stepId, toolName);
            toolInputsByStep.set(stepId, toolInput);
            startedToolSteps.add(stepId);
            events.push(toolUseEvent(
              toolName,
              stringifyToolValue(toolInput),
              providerFields(providerSessionId, normalizedRuntimeFamily, {
                providerToolUseId: toolId,
                providerEventId: `${toolId}:started`,
                providerLifecycle: 'tool_started',
                operationLifecycle: 'started',
              }),
            ));
          } else if (
            ['DONE', 'ERROR', 'FAILED', 'CANCELLED', 'CANCELED'].includes(state)
            && !completedToolSteps.has(stepId)
          ) {
            const failed = isFailedToolUpdate(update);
            completedToolSteps.add(stepId);
            events.push(toolResultEvent(
              toolName,
              stringifyToolValue(readToolOutput(update)),
              readToolExitCode(update, failed),
              providerFields(providerSessionId, normalizedRuntimeFamily, {
                providerToolUseId: toolId,
                providerEventId: `${toolId}:${failed ? 'failed' : 'completed'}`,
                providerLifecycle: failed ? 'tool_failed' : 'tool_completed',
                operationLifecycle: failed ? 'failed' : 'completed',
              }),
            ));
            if (!failed) {
              const change = inferProviderFileChange({
                toolName,
                toolInput: toolInputsByStep.get(stepId) || readToolInput(update),
              });
              if (change) events.push(fileChangeEvent(
                change.filePath,
                change.changeType,
                {},
                providerFields(providerSessionId, normalizedRuntimeFamily, {
                  providerToolUseId: toolId,
                  providerEventId: `${toolId}:file-change`,
                  operationLifecycle: 'completed',
                }),
              ));
            }
            toolInputsByStep.delete(stepId);
          }
        }
        if (stepType === 'agent_response' && typeof update.text_delta === 'string' && update.text_delta) {
          textDeltaOrdinal += 1;
          events.push(textDeltaEvent(0, update.text_delta, providerFields(
            providerSessionId,
            normalizedRuntimeFamily,
            {
              providerEventId: `step:${stepId}:delta:${textDeltaOrdinal}`,
              providerLifecycle: 'text_delta',
            },
          )));
        }
        if (update.usage && typeof update.usage === 'object') {
          events.push(usageEvent({
            ...usageFields(update.usage),
            ...providerFields(providerSessionId, normalizedRuntimeFamily),
          }));
        }
        if (update.state === 'ACTIVE' && stepType === 'agent_response' && !update.text_delta) {
          events.push(statusEvent('thinking', providerFields(providerSessionId, normalizedRuntimeFamily, {
            providerLifecycle: 'thinking',
          })));
        }
        return events;
      }

      if (payload.event === 'result') {
        const result = payload.result && typeof payload.result === 'object' ? payload.result : {};
        providerSessionId = readConversationId(payload, null, result) || providerSessionId;
        const response = typeof result.response === 'string' ? result.response : '';
        if (response.trim()) {
          events.push(messageEvent('assistant', response, undefined, providerFields(providerSessionId, normalizedRuntimeFamily, {
            providerLifecycle: 'final_response',
          })));
        }
        if (result.usage && typeof result.usage === 'object') {
          events.push(usageEvent({
            ...usageFields(result.usage),
            ...providerFields(providerSessionId, normalizedRuntimeFamily),
          }));
        }
        const success = String(result.status || '').trim().toUpperCase() === 'SUCCESS';
        if (success) {
          events.push(statusEvent('completed', providerFields(providerSessionId, normalizedRuntimeFamily, {
            providerLifecycle: 'completed',
          })));
        } else {
          const errorText = readErrorText(result);
          events.push(statusEvent(
            `error: ${errorText}`,
            annotateProviderError(providerFields(providerSessionId, normalizedRuntimeFamily), errorText),
          ));
        }
        return events;
      }

      if (payload.error || payload.event === 'error') {
        const errorText = readErrorText(payload);
        events.push(statusEvent(
          `error: ${errorText}`,
          annotateProviderError(providerFields(providerSessionId, normalizedRuntimeFamily), errorText),
        ));
      }
      return events;
    },

    flush() {
      return [];
    },
  };
}

export function createAgyStreamAdapter() {
  return createAgyAdapter({
    runtimeFamily: AGY_STREAM_RUNTIME_FAMILY,
    emitToolEvents: true,
  });
}

function agyModelAcceptsEffortFlag(model) {
  const normalized = String(model || '').trim().toLowerCase();
  if (!normalized) return false;
  // Antigravity's Claude models reject --effort outright. A model id that
  // already carries a fixed level (including `-thinking`) must be passed as
  // is instead of receiving a second, incompatible effort flag.
  if (normalized.startsWith('claude-')) return false;
  if (/(?:[-_](?:low|medium|high|thinking))$/.test(normalized)) return false;
  return true;
}

export function buildAgyArgs(_prompt, options = {}) {
  const args = [
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    // AgY 1.1.19 requires --print to have an attached value. An explicit
    // empty value selects print mode while prompts arrive through stdin.
    '--print=',
    '--print-timeout',
    String(options.printTimeout || DEFAULT_AGY_PRINT_TIMEOUT),
    '--disable-slash-commands',
    '--dangerously-skip-permissions',
  ];
  // Session continuity: resume an existing agy conversation by id (preferred)
  // or fall back to --continue (most recent conversation) when no id is known
  // yet. This avoids re-injecting the full context on every round.
  const conversationId = typeof options.conversationId === 'string'
    ? options.conversationId.trim()
    : '';
  if (conversationId) {
    args.push('--conversation', conversationId);
  } else if (options.useResume === true) {
    args.push('--continue');
  }
  if (options.model) args.push('--model', String(options.model));
  if (options.effort && agyModelAcceptsEffortFlag(options.model)) {
    args.push('--effort', String(options.effort));
  }
  if (options.mode) args.push('--mode', String(options.mode));
  return args;
}
