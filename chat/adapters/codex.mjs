import { createHash } from 'node:crypto';
import {
  messageEvent, toolUseEvent, toolResultEvent,
  fileChangeEvent, reasoningEvent, statusEvent, usageEvent, textDeltaEvent, planEvent,
} from '../normalizer.mjs';
import {
  annotateProviderError,
  getProviderCapabilities,
  resolveProviderPermissionPolicy,
} from '../provider-contract.mjs';
import { isTransientProviderReconnectErrorPayload } from '../provider-runtime-noise.mjs';
import { DEFAULT_CODEX_DEVELOPER_INSTRUCTIONS } from '../runtime-policy.mjs';

export { DEFAULT_CODEX_DEVELOPER_INSTRUCTIONS } from '../runtime-policy.mjs';

/**
 * Codex CLI adapter.
 *
 * When run with `codex exec <prompt> --json`, stdout emits JSONL.
 * Each line is a JSON object with a `type` field.
 *
 * Event types:
 *   thread.started  — { type, thread_id }
 *   turn.started    — { type }
 *   turn.completed  — { type, usage: { input_tokens, cached_input_tokens, output_tokens } }
 *   turn.failed     — { type, error: { message } }
 *   item.started    — { type, item: ThreadItem }
 *   item.updated    — { type, item: ThreadItem }
 *   item.completed  — { type, item: ThreadItem }
 *   agent_message_content_delta — { type, item_id, content_index, delta }
 *   error           — { type, message }
 *   ragent.context_metrics — synthetic line injected by Ragent sidecar
 *                               after reading Codex's session JSONL token_count data
 *
 * ThreadItem types:
 *   agent_message      — { id, type, text }
 *   reasoning          — { id, type, text }
 *   command_execution  — { id, type, command, aggregated_output, exit_code, status }
 *   file_change        — { id, type, changes: [{ path, kind }], status }
 *   mcp_tool_call      — { id, type, server, tool, arguments, result, error, status }
 *   web_search         — { id, type, query }
 *   todo_list          — { id, type, items: [{ text, completed }] }
 *   error              — { id, type, message }
 */
export function createCodexAdapter() {
  let terminalCandidates = new Map();
  const adapter = {
    capabilities: getProviderCapabilities('codex-json'),

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
          events.push(statusEvent(`Thread started (${obj.thread_id || 'unknown'})`, {
            provider: 'codex',
            providerThreadId: typeof obj.thread_id === 'string' ? obj.thread_id : undefined,
          }));
          break;

        case 'turn.started':
          terminalCandidates = new Map();
          events.push(statusEvent('thinking'));
          break;

        case 'turn.completed':
          // Codex stdout usage is cumulative across the agent loop, so
          // Ragent injects a later ragent.context_metrics line instead.
          {
            const candidate = terminalCandidates.size === 1 ? [...terminalCandidates.entries()][0] : null;
            events.push(statusEvent('completed', candidate ? { provider: 'codex', providerLifecycle: 'completed', runState: 'completed', deliveryProviderMessageId: candidate[0], deliveryContentHash: createHash('sha256').update(candidate[1], 'utf8').digest('hex') } : {}));
            terminalCandidates.clear();
          }
          break;

        case 'ragent.context_metrics':
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
          events.push(statusEvent(
            `error: ${obj.error?.message || 'unknown error'}`,
            annotateProviderError({ provider: 'codex' }, obj.error || obj),
          ));
          break;

        case 'item.started':
        case 'item.updated':
          // For in-progress items, emit status updates
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
          if (obj.item?.type === 'agent_message' && obj.item.phase === 'final_answer' && typeof obj.item.id === 'string' && obj.item.id && typeof obj.item.text === 'string' && obj.item.text) terminalCandidates.set(obj.item.id, obj.item.text);
          if (obj.item) {
            events.push(...parseItem(obj.item, obj.type));
          }
          break;

        case 'error':
          if (isTransientProviderReconnectErrorPayload(obj)) {
            break;
          }
          events.push(statusEvent(
            `error: ${obj.message || 'unknown error'}`,
            annotateProviderError({ provider: 'codex' }, obj),
          ));
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
  return adapter;
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
      events.push(messageEvent('assistant', item.text || '', undefined, { ...messageFields, ...(['commentary', 'final_answer'].includes(item.phase) ? { messagePhase: item.phase } : {}) }));
      break;

    case 'reasoning':
      events.push(reasoningEvent(item.text || '', { ...messageFields,
        reasoningLifecycle: lifecycle === 'item.completed' ? 'completed' : 'delta',
        state: lifecycle === 'item.completed' ? 'completed' : 'running' }));
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
            ? 'awaiting_decision'
            : 'drafting',
          source: 'codex',
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

/**
 * Optional system instruction prepended to Codex prompts.
 *
 * Ragent now leaves this empty by default so local project memory and
 * session prompts remain the primary steering layer. Operators can still set
 * `RAGENT_CODEX_SYSTEM_PREFIX` if they want to force an extra prefix.
 */
const CODEX_SYSTEM_PREFIX = process.env.RAGENT_CODEX_SYSTEM_PREFIX || '';
/**
 * Optional developer instructions passed through Codex's own supported
 * `developer_instructions` config key. This is stronger than a prompt prefix
 * when the manager needs to shape the agent's default reply style.
 */
const CODEX_DEVELOPER_INSTRUCTIONS = process.env.RAGENT_CODEX_DEVELOPER_INSTRUCTIONS || '';
const HAS_CODEX_DEVELOPER_INSTRUCTIONS_ENV = Object.prototype.hasOwnProperty.call(
  process.env,
  'RAGENT_CODEX_DEVELOPER_INSTRUCTIONS',
);

function encodeTomlString(value) {
  return JSON.stringify(String(value || ''));
}

function resolveDeveloperInstructions(options = {}) {
  if (Object.prototype.hasOwnProperty.call(options, 'developerInstructions')) {
    return typeof options.developerInstructions === 'string'
      ? options.developerInstructions.trim()
      : '';
  }
  if (HAS_CODEX_DEVELOPER_INSTRUCTIONS_ENV) {
    return CODEX_DEVELOPER_INSTRUCTIONS.trim();
  }
  return DEFAULT_CODEX_DEVELOPER_INSTRUCTIONS;
}

/**
 * Build args for spawning Codex exec.
 */
export function buildCodexArgs(prompt, options = {}) {
  const permissionPolicy = resolveProviderPermissionPolicy('codex-json', {
    permissionMode: options.permissionMode,
    interactionMode: options.interactionMode,
  });
  const args = [];
  const developerInstructions = resolveDeveloperInstructions(options);

  if (permissionPolicy?.approvalPolicy && !permissionPolicy?.dangerouslyBypassApprovalsAndSandbox) {
    args.push('-a', permissionPolicy.approvalPolicy);
  }
  args.push('exec');
  args.push('--json');
  if (permissionPolicy?.dangerouslyBypassApprovalsAndSandbox === true) {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  } else if (permissionPolicy?.sandbox) {
    args.push('--sandbox', permissionPolicy.sandbox);
  }
  args.push('--skip-git-repo-check');
  args.push('--disable', 'unified_exec');

  // If frontend requested Plan interaction mode, set Codex CLI mode to 'plan'.
  if (options.interactionMode === 'plan') {
    args.push('-c', `mode=plan`);
  }

  if (developerInstructions) {
    args.push('-c', `developer_instructions=${encodeTomlString(developerInstructions)}`);
  }

  if (options.model) {
    args.push('-m', options.model);
  }
  if (options.reasoningEffort) {
    args.push('-c', `model_reasoning_effort=${options.reasoningEffort}`);
  }
  if (options.serviceTier === 'fast') {
    args.push('-c', 'service_tier="fast"');
  } else if (options.serviceTier === 'standard') {
    // Codex calls its normal request tier "default". Keep the UI/API
    // contract as "standard" while explicitly overriding a stale fast tier
    // in a shared legacy config.
    args.push('-c', 'service_tier="default"');
  }

  const effectivePrompt = (options.systemPrefix ?? CODEX_SYSTEM_PREFIX) + prompt;

  if (options.threadId && options.useResume === true) {
    args.push('resume', options.threadId, effectivePrompt);
  } else {
    args.push(effectivePrompt);
  }

  return args;
}
