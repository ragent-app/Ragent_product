import {
  messageEvent, toolUseEvent, toolResultEvent,
  fileChangeEvent, reasoningEvent, statusEvent, usageEvent, textDeltaEvent, planEvent,
} from '../normalizer.mjs';
import { getProviderCapabilities } from '../provider-contract.mjs';
import { isTransientProviderReconnectErrorPayload } from '../provider-runtime-noise.mjs';
import { DEFAULT_CODEX_DEVELOPER_INSTRUCTIONS } from '../runtime-policy.mjs';

export { DEFAULT_CODEX_DEVELOPER_INSTRUCTIONS } from '../runtime-policy.mjs';

export function createCopilotAdapter() {
  return {
    capabilities: getProviderCapabilities('copilot-json'),

    parseLine(line) {
      const trimmed = line.trim();
      if (!trimmed) return [];

      let obj;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        return [];
      }

      const events = [];

      switch (obj.type) {
        case 'thread.started':
          events.push(statusEvent(`Thread started (${obj.thread_id || 'unknown'})`));
          break;

        case 'turn.started':
          events.push(statusEvent('thinking'));
          break;

        case 'turn.completed':
          events.push(statusEvent('completed'));
          break;

        case 'agentoc.context_metrics':
          events.push(usageEvent({
            contextTokens: obj.contextTokens,
            inputTokens: obj.inputTokens,
            outputTokens: obj.outputTokens,
            cachedInputTokens: obj.cachedInputTokens,
            reasoningTokens: obj.reasoningTokens,
            estimatedCostUsd: obj.estimatedCostUsd,
            estimatedCostModel: obj.estimatedCostModel,
            contextWindowTokens: obj.contextWindowTokens,
            contextSource: obj.contextSource,
            costSource: obj.costSource,
          }));
          break;

        case 'turn.failed':
          events.push(statusEvent(`error: ${obj.error?.message || 'unknown error'}`));
          break;

        case 'item.started':
        case 'item.updated':
          if (obj.item) {
            const item = obj.item;
            if (item.type === 'command_execution' && item.status === 'in_progress') {
              events.push(toolUseEvent('bash', item.command || '', itemIdentityFields(item, 'tool')));
            } else if (item.type === 'agent_message') {
              events.push(...parseAgentMessageDelta(obj));
            } else if (item.type === 'todo_list') {
              events.push(...parseItem(item, obj.type));
            }
          }
          break;

        case 'agent_message_content_delta':
        case 'message_content_delta':
        case 'response.output_text.delta':
        case 'output_text_delta':
          events.push(...parseAgentMessageDelta(obj));
          break;

        case 'item.completed':
          if (obj.item) {
            events.push(...parseItem(obj.item, obj.type));
          }
          break;

        case 'error':
          if (isTransientProviderReconnectErrorPayload(obj)) {
            break;
          }
          events.push(statusEvent(`error: ${obj.message || 'unknown error'}`));
          break;

        default:
          break;
      }

      return events;
    },

    flush() {
      return [];
    },
  };
}

function readDeltaText(source) {
  const candidates = [
    source?.delta,
    source?.text,
    source?.content,
    source?.item?.delta,
    source?.item?.contentDelta,
    source?.item?.content_delta,
    source?.event?.delta,
    source?.event?.text,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate) return candidate;
    if (typeof candidate?.text === 'string' && candidate.text) return candidate.text;
    if (typeof candidate?.content === 'string' && candidate.content) return candidate.content;
  }
  return '';
}

function readDeltaBlockIndex(source) {
  const candidates = [
    source?.content_index,
    source?.contentIndex,
    source?.blockIndex,
    source?.index,
    source?.item?.content_index,
    source?.item?.contentIndex,
    source?.event?.content_index,
    source?.event?.index,
  ];
  for (const candidate of candidates) {
    if (Number.isInteger(candidate) && candidate >= 0) return candidate;
  }
  return 0;
}

function parseAgentMessageDelta(source) {
  const text = readDeltaText(source);
  if (!text) return [];
  return [textDeltaEvent(readDeltaBlockIndex(source), text)];
}

function parseItem(item, lifecycle = 'item.completed') {
  const events = [];
  const messageFields = itemIdentityFields(item, 'message');
  const toolFields = itemIdentityFields(item, 'tool');

  switch (item.type) {
    case 'agent_message':
      events.push(messageEvent('assistant', item.text || '', undefined, messageFields));
      break;

    case 'reasoning':
      events.push(reasoningEvent(item.text || '', messageFields));
      break;

    case 'command_execution':
      events.push(toolUseEvent('bash', item.command || '', toolFields));
      if (item.status === 'completed' || item.status === 'failed') {
        events.push(toolResultEvent(
          'bash',
          item.aggregated_output || '',
          item.exit_code ?? (item.status === 'failed' ? 1 : 0),
          toolFields,
        ));
      }
      break;

    case 'file_change':
      if (Array.isArray(item.changes)) {
        for (const change of item.changes) {
        events.push(fileChangeEvent(change.path, change.kind, change, toolFields));
        }
      }
      break;

    case 'mcp_tool_call': {
      const toolName = `${item.server}/${item.tool}`;
      events.push(toolUseEvent(toolName, JSON.stringify(item.arguments || {}), toolFields));
      if (item.status === 'completed' || item.status === 'failed') {
        const output = item.error
          ? `Error: ${item.error.message}`
          : item.result
            ? JSON.stringify(item.result)
            : '';
        events.push(toolResultEvent(toolName, output, item.error ? 1 : 0, toolFields));
      }
      break;
    }

    case 'web_search':
      events.push(toolUseEvent('web_search', item.query || '', toolFields));
      break;

    case 'todo_list':
      if (Array.isArray(item.items)) {
        events.push(planEvent({
          planId: item.id,
          title: item.title,
          items: item.items,
          state: lifecycle === 'item.completed' || item.status === 'completed'
            ? 'completed'
            : 'running',
          source: 'copilot',
        }));
      }
      break;

    case 'error':
      events.push(statusEvent(`error: ${item.message || 'unknown'}`));
      break;

    default:
      break;
  }

  return events;
}

function itemIdentityFields(item, kind) {
  const providerItemId = typeof item?.id === 'string' && item.id.trim() ? item.id.trim() : '';
  if (!providerItemId) return {};
  return kind === 'message'
    ? { providerMessageId: providerItemId }
    : { providerToolUseId: providerItemId };
}

const COPILOT_SYSTEM_PREFIX = process.env.AGENTOC_COPILOT_SYSTEM_PREFIX || '';
const COPILOT_DEVELOPER_INSTRUCTIONS = process.env.AGENTOC_COPILOT_DEVELOPER_INSTRUCTIONS || '';
const HAS_COPILOT_DEVELOPER_INSTRUCTIONS_ENV = Object.prototype.hasOwnProperty.call(
  process.env,
  'AGENTOC_COPILOT_DEVELOPER_INSTRUCTIONS',
);

function resolveCopilotDeveloperInstructions(options = {}) {
  if (Object.prototype.hasOwnProperty.call(options, 'developerInstructions')) {
    return typeof options.developerInstructions === 'string'
      ? options.developerInstructions.trim()
      : '';
  }
  if (HAS_COPILOT_DEVELOPER_INSTRUCTIONS_ENV) {
    return COPILOT_DEVELOPER_INSTRUCTIONS.trim();
  }
  return DEFAULT_CODEX_DEVELOPER_INSTRUCTIONS;
}

export function buildCopilotArgs(prompt, options = {}) {
  const args = ['--output-format', 'json', '--allow-all-tools', '--no-ask-user'];
  const developerInstructions = resolveCopilotDeveloperInstructions(options);

  // Copilot's programmatic mode has no Codex-style `-c` developer-instruction
  // channel. Keep the server-owned instructions in the prompt instead of
  // passing unsupported flags that make the CLI exit before a Run starts.
  const effectivePrompt = [
    developerInstructions ? `Ragent developer instructions:\n${developerInstructions}` : '',
    (options.systemPrefix ?? COPILOT_SYSTEM_PREFIX),
    typeof prompt === 'string' ? prompt : '',
  ].filter(Boolean).join('\n\n');

  if (options.model) {
    args.push('--model', options.model);
  }
  if (options.reasoningEffort) {
    args.push('--reasoning-effort', options.reasoningEffort);
  }

  if (options.threadId && options.useResume === true) {
    args.push('--resume', options.threadId);
  }
  args.push('--prompt', effectivePrompt);

  return args;
}
