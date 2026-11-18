import {
  messageEvent, toolUseEvent, toolResultEvent,
  fileChangeEvent, reasoningEvent, statusEvent, usageEvent,
  textDeltaEvent,
} from '../normalizer.mjs';
import { annotateProviderError, getProviderCapabilities } from '../provider-contract.mjs';
import { getHarnessAdapterCompatibility } from '../harness-compatibility.mjs';
import { lookupModelContextWindowTokens } from '../model-context-windows.mjs';
import { createClaudeFinalizedAssistantReplayFingerprint } from '../provider-event-dedup.mjs';

const CLAUDE_FILE_EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const MAX_FILE_DIFF_CELLS = 1_000_000;
const MAX_FILE_DIFF_PREVIEW_LINES = 80;
const CLAUDE_ERROR_TERMINAL_REASONS = new Set([
  'api_error',
  'error',
  'failed',
  'aborted',
  'abort',
  'cancelled',
  'canceled',
  'interrupted',
  'timeout',
]);

function splitTextLines(value) {
  const text = typeof value === 'string' ? value : '';
  if (!text) return [];
  const normalized = text.endsWith('\n') ? text.slice(0, -1) : text;
  return normalized ? normalized.split('\n') : [];
}

function computeTextEditDetails(oldText, newText) {
  const oldLines = splitTextLines(oldText);
  const newLines = splitTextLines(newText);
  if (oldLines.length * newLines.length > MAX_FILE_DIFF_CELLS) {
    return {
      added: newLines.length,
      removed: oldLines.length,
    };
  }
  const table = Array.from({ length: oldLines.length + 1 }, () => new Array(newLines.length + 1).fill(0));
  for (let oldIndex = 1; oldIndex <= oldLines.length; oldIndex += 1) {
    for (let newIndex = 1; newIndex <= newLines.length; newIndex += 1) {
      table[oldIndex][newIndex] = oldLines[oldIndex - 1] === newLines[newIndex - 1]
        ? table[oldIndex - 1][newIndex - 1] + 1
        : Math.max(table[oldIndex - 1][newIndex], table[oldIndex][newIndex - 1]);
    }
  }
  const preview = [];
  let oldIndex = oldLines.length;
  let newIndex = newLines.length;
  let added = 0;
  let removed = 0;
  while (oldIndex > 0 || newIndex > 0) {
    if (oldIndex > 0 && newIndex > 0 && oldLines[oldIndex - 1] === newLines[newIndex - 1]) {
      oldIndex -= 1;
      newIndex -= 1;
    } else if (newIndex > 0 && (oldIndex === 0 || table[oldIndex][newIndex - 1] >= table[oldIndex - 1][newIndex])) {
      added += 1;
      if (preview.length < MAX_FILE_DIFF_PREVIEW_LINES) {
        preview.unshift({ type: 'add', text: newLines[newIndex - 1], newLine: newIndex });
      }
      newIndex -= 1;
    } else {
      removed += 1;
      if (preview.length < MAX_FILE_DIFF_PREVIEW_LINES) {
        preview.unshift({ type: 'remove', text: oldLines[oldIndex - 1], oldLine: oldIndex });
      }
      oldIndex -= 1;
    }
  }
  return {
    added,
    removed,
    ...(preview.length > 0 ? { preview } : {}),
  };
}

function normalizeClaudeFileChange(toolName, input) {
  if (!CLAUDE_FILE_EDIT_TOOLS.has(toolName) || !(input && typeof input === 'object')) return null;
  const filePath = typeof (input.file_path || input.path || input.notebook_path) === 'string'
    ? (input.file_path || input.path || input.notebook_path).trim()
    : '';
  if (!filePath) return null;

  if (toolName === 'Write') {
    return {
      filePath,
      changeType: 'add',
      ...computeTextEditDetails('', input.content || ''),
    };
  }
  if (toolName === 'Edit') {
    return {
      filePath,
      changeType: 'edit',
      ...computeTextEditDetails(input.old_string || '', input.new_string || ''),
    };
  }
  if (toolName === 'MultiEdit') {
    const details = { added: 0, removed: 0, preview: [] };
    for (const edit of Array.isArray(input.edits) ? input.edits : []) {
      const current = computeTextEditDetails(edit?.old_string || '', edit?.new_string || '');
      details.added += current.added || 0;
      details.removed += current.removed || 0;
      if (Array.isArray(current.preview) && details.preview.length < MAX_FILE_DIFF_PREVIEW_LINES) {
        details.preview.push(...current.preview.slice(0, MAX_FILE_DIFF_PREVIEW_LINES - details.preview.length));
      }
    }
    return { filePath, changeType: 'edit', ...details };
  }

  const editMode = typeof input.edit_mode === 'string' ? input.edit_mode.toLowerCase() : '';
  const newSource = input.new_source || input.source || '';
  if (editMode === 'insert') {
    return {
      filePath,
      changeType: 'edit',
      ...computeTextEditDetails('', newSource),
    };
  }
  return { filePath, changeType: editMode === 'delete' ? 'delete' : 'edit' };
}

function classifyClaudeResultFrame(obj, hasFinalizedTurnContent) {
  const terminalReason = typeof obj?.terminal_reason === 'string'
    ? obj.terminal_reason.trim().toLowerCase()
    : '';
  const hasResultField = Object.prototype.hasOwnProperty.call(obj || {}, 'result');
  const resultText = typeof obj?.result === 'string' ? obj.result.trim() : '';
  const diagnostic = readClaudeDiagnosticText(obj);
  const invalidBody = obj?.subtype === 'success'
    && (
      (!hasResultField && !hasFinalizedTurnContent)
      || (hasResultField && typeof obj.result !== 'string')
      || (hasResultField && !resultText && !hasFinalizedTurnContent)
      || /empty\s+or\s+malformed\s+response/i.test(resultText)
    );
  const explicitError = obj?.is_error === true
    || obj?.subtype === 'error'
    || Boolean(obj?.error)
    || CLAUDE_ERROR_TERMINAL_REASONS.has(terminalReason)
    || /^api\s+error\b/i.test(resultText);
  return {
    terminalReason,
    diagnostic,
    invalidBody,
    isError: invalidBody || explicitError,
  };
}

function readClaudeDiagnosticText(obj) {
  const candidates = [obj?.error, obj?.message, obj?.status, obj?.result];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    if (typeof candidate?.message === 'string' && candidate.message.trim()) {
      return candidate.message.trim();
    }
  }
  return '';
}

// Claude Code may issue an automatic title request after it has already
// emitted the terminal result for the user turn.  Some Anthropic-compatible
// relays reject that auxiliary request and write a second `result` error
// frame.  The primary turn is already complete at that point, so promoting
// this narrowly-identifiable diagnostic to a failed Run would overwrite a
// successful outcome in the UI.  Keep the raw frame in the runner spool, but
// do not project it into user-visible history.  Do not broaden this to
// generic SDK errors: a title-query marker is required.
function isLateAutomaticTitleDiagnostic(diagnostic) {
  return /["']?query_source["']?\s*[:=]\s*["']?generate_session_title\b/i.test(
    typeof diagnostic === 'string' ? diagnostic : '',
  );
}

/**
 * Claude Code adapter.
 *
 * When run with `claude -p --output-format stream-json --verbose
 * --include-partial-messages`, stdout emits JSONL with finalized assistant
 * content blocks alongside streaming text/thinking deltas.
 *
 * Streaming text and thinking deltas are ephemeral UI events. Finalized
 * assistant blocks remain the authoritative snapshots, while the deltas keep
 * a long reasoning-only phase visibly alive. Each wire line projects
 * independently so normalized event counts stay deterministic across observer
 * polls and terminal full-spool replay.
 */
export function createClaudeAdapter() {
  let providerSessionId = '';
  let hasFinalizedTurnContent = false;
  let completedTurn = false;
  let streamingMessageId = '';
  let streamingDeltaOrdinal = 0;
  let streamingTextBlockIndexes = [];
  let streamingThinkingBlocks = new Map();
  let streamingStopReason = '';
  // Upstream-reported model for the current turn (assistant/message_start
  // frames carry it).  Gateways remap tier aliases — the requested model and
  // the served model can differ (observed: glm-5.2 requested, glm-4.7
  // served), so window/cost lookups must key on the served id.
  let upstreamModel = '';

  function providerFields(extra = {}) {
    return {
      provider: 'claude',
      runtimeFamily: 'claude-stream-json',
      ...(providerSessionId ? { providerSessionId } : {}),
      ...extra,
    };
  }

  const readDiagnosticText = readClaudeDiagnosticText;

  return {
    adapterCompatibility: getHarnessAdapterCompatibility('claude'),
    capabilities: getProviderCapabilities('claude-stream-json'),

    parseLine(line) {
      const trimmed = line.trim();
      if (!trimmed) return [];

      let obj;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        return [];
      }

      // Provider-native child frames are retained as raw spool evidence and
      // consumed by the delegation runtime, but must never become parent
      // assistant/tool history.
      if (obj.ragent_intermediate === true || (typeof obj.parent_tool_use_id === 'string' && obj.parent_tool_use_id.trim())) return [];

      if (typeof obj.session_id === 'string' && obj.session_id.trim()) {
        providerSessionId = obj.session_id.trim();
      }

      const events = [];
      const frameProviderEventId = typeof obj.uuid === 'string' && obj.uuid.trim()
        ? obj.uuid.trim()
        : '';
      const frameProviderFields = (extra = {}) => providerFields({
        ...(frameProviderEventId ? { providerEventId: frameProviderEventId } : {}),
        ...extra,
      });

      switch (obj.type) {
        case 'system':
          if (obj.subtype === 'init') {
            events.push(statusEvent(
              `Session started (${obj.session_id || 'unknown'})`,
              frameProviderFields({ providerLifecycle: 'session_started' }),
            ));
          } else if (obj.subtype === 'thinking_tokens') {
            break;
          } else if (obj.subtype === 'status') {
            const status = typeof obj.status === 'string' ? obj.status.trim() : '';
            if (status && !['requesting', 'thinking', 'responding'].includes(status.toLowerCase())) {
              events.push(statusEvent(status, frameProviderFields({ providerLifecycle: 'status' })));
            }
          } else if (obj.subtype === 'api_retry') {
            const diagnostic = readDiagnosticText(obj);
            if (diagnostic) {
              events.push(statusEvent(
                `retrying: ${diagnostic}`,
                frameProviderFields({ providerLifecycle: 'api_retry' }),
              ));
            }
          } else {
            const diagnostic = readDiagnosticText(obj);
            if (diagnostic) {
              events.push(statusEvent(
                diagnostic,
                frameProviderFields({ providerLifecycle: obj.subtype || 'system' }),
              ));
            }
          }
          break;

        case 'assistant': {
          const msg = obj.message;
          const providerMessageId = typeof msg?.id === 'string' && msg.id.trim()
            ? msg.id.trim()
            : '';
          if (typeof msg?.model === 'string' && msg.model.trim()) {
            upstreamModel = msg.model.trim();
          }
          const content = msg?.content;
          const stopReason = msg?.stop_reason || (providerMessageId && providerMessageId === streamingMessageId ? streamingStopReason : '');
          if (Array.isArray(content)) {
            // A subsequent assistant payload belongs to a new provider turn;
            // an error after it must never inherit the prior terminal guard.
            completedTurn = false;
            if (content.some((block) => block && typeof block === 'object')) {
              hasFinalizedTurnContent = true;
            }
            let textParts = [];
            let textBlockOrdinal = 0;
            let textOrdinal = 0;
            const flushTextParts = () => {
              if (textParts.length === 0) return;
              const text = textParts.join('');
              textParts = [];
              if (!text) return;
              // Some Claude-compatible relays omit thinking blocks from the
              // final snapshot while retaining their indexes in the stream.
              // Bind each text snapshot to the corresponding streamed block.
              const contentBlockIndex = providerMessageId && providerMessageId === streamingMessageId
                ? (streamingTextBlockIndexes[textOrdinal] ?? textBlockOrdinal)
                : textBlockOrdinal;
              textOrdinal += 1;
              textBlockOrdinal += 1;
              events.push(messageEvent('assistant', text, undefined, frameProviderFields({
                ...(providerMessageId ? { providerMessageId } : {}),
                ...(upstreamModel ? { reportedModel: upstreamModel } : {}),
                ...(stopReason === 'end_turn' ? { messagePhase: 'final_answer' }
                  : stopReason === 'tool_use' ? { messagePhase: 'commentary' } : {}),
                providerSnapshotKind: 'finalized-assistant',
                // Explicit snapshot semantics for downstream layers: the body
                // is an accumulating revision of one provider message, and a
                // relay may even re-emit it under a fresh frame/message id.
                providerSnapshot: true,
                providerSnapshotComplete: true,
                providerContentBlockIndex: contentBlockIndex,
                // A message id or frame uuid is sufficient on its own. This
                // content-scoped fallback exists only for legacy relays that
                // omit both while still reporting a provider session.
                ...(!providerMessageId && !frameProviderEventId
                  ? {
                      providerReplayFingerprint: createClaudeFinalizedAssistantReplayFingerprint(
                        providerSessionId,
                        text,
                      ),
                    }
                  : {}),
              })));
            };
            for (const [contentIndex, block] of content.entries()) {
              if (block.type === 'text') {
                flushTextParts();
                textBlockOrdinal = contentIndex;
                textParts.push(block.text || '');
                flushTextParts();
              } else if (block.type === 'thinking') {
                flushTextParts();
                if (block.thinking) {
                  events.push(reasoningEvent(block.thinking, frameProviderFields({
                    ...(providerMessageId ? { providerMessageId } : {}),
                    providerBlockId: `thinking:${contentIndex}`,
                    blockIndex: contentIndex,
                    providerLifecycle: 'completed',
                    reasoningLifecycle: 'completed',
                    state: 'completed',
                  })));
                }
              } else if (block.type === 'tool_use') {
                flushTextParts();
                const toolInput = typeof block.input === 'string'
                  ? block.input
                  : JSON.stringify(block.input, null, 2);
                events.push(toolUseEvent(
                  block.name,
                  toolInput,
                  frameProviderFields({
                    ...(block.id ? { providerToolUseId: block.id } : {}),
                    operationLifecycle: 'started',
                  }),
                ));
                const fileChange = normalizeClaudeFileChange(block.name, block.input);
                if (fileChange) {
                  events.push(fileChangeEvent(
                    fileChange.filePath,
                    fileChange.changeType,
                    fileChange,
                    frameProviderFields({
                      sourceToolName: block.name,
                      ...(block.id ? { providerToolUseId: block.id } : {}),
                      operationLifecycle: 'started',
                      operationKind: 'file_edit',
                    }),
                  ));
                }
              } else if (block.type === 'tool_result') {
                flushTextParts();
                const output = typeof block.content === 'string'
                  ? block.content
                  : Array.isArray(block.content)
                    ? block.content.map(c => c.text || '').join('\n')
                    : JSON.stringify(block.content);
                events.push(toolResultEvent(block.tool_use_id || '', output, block.is_error ? 1 : 0, frameProviderFields({
                  ...(block.tool_use_id ? { providerToolUseId: block.tool_use_id } : {}),
                  operationLifecycle: block.is_error ? 'failed' : 'completed',
                })));
              }
            }
            flushTextParts();
          }
          break;
        }

        case 'user': {
          const content = obj.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'tool_result') {
                const output = typeof block.content === 'string'
                  ? block.content
                  : Array.isArray(block.content)
                    ? block.content.map(c => c.text || '').join('\n')
                    : JSON.stringify(block.content);
                events.push(toolResultEvent(
                  block.tool_use_id || '',
                  output,
                  block.is_error ? 1 : 0,
                  frameProviderFields({
                    ...(block.tool_use_id ? { providerToolUseId: block.tool_use_id } : {}),
                    operationLifecycle: block.is_error ? 'failed' : 'completed',
                  }),
                ));
              }
            }
          }
          break;
        }

        case 'result':
          if (
            obj.total_cost_usd !== undefined
            || obj.cost_usd !== undefined
            || obj.estimated_cost_usd !== undefined
            || obj.usage
          ) {
            const u = obj.usage || {};
            const totalIn = Number.isFinite(u.context_tokens)
              ? u.context_tokens
              : (['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'].some((field) => Number.isFinite(u[field])) ? (
              (u.input_tokens || 0) +
              (u.cache_creation_input_tokens || 0) +
              (u.cache_read_input_tokens || 0)
            ) : undefined);
            const providerCostUsd = Number.isFinite(obj.total_cost_usd)
              ? obj.total_cost_usd
              : (Number.isFinite(obj.cost_usd) ? obj.cost_usd : undefined);
            // Result frames carry no model id on every CLI build; prefer the
            // frame's own field and fall back to the turn's tracked model.
            const resultModel = typeof obj.model === 'string' && obj.model.trim()
              ? obj.model.trim()
              : upstreamModel;
            const contextWindowTokens = lookupModelContextWindowTokens(resultModel);
            events.push(usageEvent({
              contextTokens: totalIn,
              ...(Number.isFinite(u.input_tokens) ? { inputTokens: u.input_tokens } : {}),
              ...(Number.isFinite(u.output_tokens) ? { outputTokens: u.output_tokens } : {}),
              ...(resultModel ? { reportedModel: resultModel } : {}),
              ...(Number.isFinite(u.cached_input_tokens) ? { cachedInputTokens: u.cached_input_tokens } : {}),
              ...(Number.isFinite(u.reasoning_output_tokens) ? { reasoningTokens: u.reasoning_output_tokens } : {}),
              ...(Number.isFinite(providerCostUsd) ? { costUsd: providerCostUsd } : {}),
              ...(Number.isFinite(obj.estimated_cost_usd) ? { estimatedCostUsd: obj.estimated_cost_usd } : {}),
              ...(typeof obj.estimated_cost_model === 'string' && obj.estimated_cost_model
                ? { estimatedCostModel: obj.estimated_cost_model }
                : {}),
              ...(Number.isInteger(contextWindowTokens) ? { contextWindowTokens } : {}),
              contextSource: 'provider_turn_usage',
              ...(Number.isFinite(obj.total_cost_usd)
                  && ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']
                    .every((field) => Number.isInteger(u[field]) && u[field] >= 0)
                ? { usageScope: 'provider_turn_total', usageAccountingTokens: u.input_tokens + u.output_tokens
                    + u.cache_creation_input_tokens + u.cache_read_input_tokens } : {}),
              ...(providerSessionId ? { providerSessionId } : {}),
              ...(providerCostUsd !== undefined
                ? { costSource: 'provider_reported' }
                : (typeof obj.cost_source === 'string' && obj.cost_source
                    ? { costSource: obj.cost_source }
                    : {})),
            }));
          }
          const resultClassification = classifyClaudeResultFrame(obj, hasFinalizedTurnContent);
          if (resultClassification.isError) {
            if (completedTurn && isLateAutomaticTitleDiagnostic(resultClassification.diagnostic)) {
              hasFinalizedTurnContent = false;
              break;
            }
            const detail = resultClassification.invalidBody
              ? 'PROVIDER_RESPONSE_INVALID'
              : (resultClassification.diagnostic || 'unknown error');
            const providerErrorFields = resultClassification.invalidBody
              ? {
                  providerErrorType: 'provider_response_invalid',
                  providerErrorCode: 'PROVIDER_RESPONSE_INVALID',
                  providerErrorRetryable: false,
                }
              : {};
            events.push(statusEvent(
              `error: ${detail}`,
              {
                ...annotateProviderError(
                  frameProviderFields({
                    runState: 'failed',
                    ...(resultClassification.terminalReason
                      ? { providerTerminalReason: resultClassification.terminalReason }
                      : {}),
                  }),
                  resultClassification.invalidBody ? 'PROVIDER_RESPONSE_INVALID' : (resultClassification.diagnostic || obj),
                ),
                ...providerErrorFields,
              },
            ));
          } else {
            events.push(statusEvent('completed', frameProviderFields({
              providerLifecycle: 'completed',
              runState: 'completed',
              ...(resultClassification.terminalReason
                ? { providerTerminalReason: resultClassification.terminalReason }
                : {}),
            })));
            completedTurn = true;
          }
          hasFinalizedTurnContent = false;
          break;

        case 'stream_event': {
          const evt = obj.event;
          if (!evt) break;
          if (evt.type === 'message_start') {
            streamingMessageId = typeof evt.message?.id === 'string' ? evt.message.id : '';
            streamingDeltaOrdinal = 0;
            streamingTextBlockIndexes = [];
            streamingThinkingBlocks = new Map();
            streamingStopReason = '';
          }
          if (evt.type === 'message_start' && typeof evt.message?.model === 'string' && evt.message.model.trim()) {
            upstreamModel = evt.message.model.trim();
          }
          if (evt.type === 'message_delta' && typeof evt.delta?.stop_reason === 'string') {
            streamingStopReason = evt.delta.stop_reason;
          }
          if (evt.type === 'content_block_delta') {
            if (evt.delta?.type === 'text_delta') {
              const blockIndex = Number.isInteger(evt.index) ? evt.index : 0;
              if (!streamingTextBlockIndexes.includes(blockIndex)) streamingTextBlockIndexes.push(blockIndex);
              streamingDeltaOrdinal += 1;
              events.push(textDeltaEvent(blockIndex, evt.delta.text || '', frameProviderFields({
                ...(streamingMessageId ? { providerMessageId: streamingMessageId } : {}),
                messageBlockIndex: blockIndex,
                providerEventId: `${streamingMessageId || frameProviderEventId}:text:${blockIndex}:${streamingDeltaOrdinal}`,
              })));
            } else if (evt.delta?.type === 'thinking_delta') {
              const blockIndex = Number.isInteger(evt.index) ? evt.index : 0;
              const thinking = typeof evt.delta.thinking === 'string' ? evt.delta.thinking : '';
              if (thinking) {
                streamingThinkingBlocks.set(blockIndex, (streamingThinkingBlocks.get(blockIndex) || '') + thinking);
                events.push(reasoningEvent(thinking, frameProviderFields({
                  ...(streamingMessageId ? { providerMessageId: streamingMessageId } : {}),
                  providerBlockId: `thinking:${blockIndex}`,
                  blockIndex,
                  providerLifecycle: 'delta',
                  reasoningLifecycle: 'delta',
                  operationLifecycle: 'delta',
                  state: 'running',
                })));
              }
            }
          }
          if (evt.type === 'content_block_stop' && streamingThinkingBlocks.has(evt.index)) {
            const blockIndex = evt.index;
            const thinking = streamingThinkingBlocks.get(blockIndex);
            streamingThinkingBlocks.delete(blockIndex);
            events.push(reasoningEvent(thinking, frameProviderFields({
              ...(streamingMessageId ? { providerMessageId: streamingMessageId } : {}),
              providerBlockId: `thinking:${blockIndex}`,
              blockIndex,
              providerLifecycle: 'completed',
              reasoningLifecycle: 'completed',
              operationLifecycle: 'completed',
              state: 'completed',
            })));
          }
          break;
        }

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

/**
 * Build the command-line arguments for spawning Claude Code.
 */
export function buildClaudeArgs(prompt, options = {}) {
  // `-p` accepts its prompt from stdin when no value follows it.  Keeping the
  // prompt out of argv avoids ARG_MAX/per-argument failures for large
  // continuity prompts (notably on remote Linux hosts).
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];

  if (options.maxTurns) {
    args.push('--max-turns', String(options.maxTurns));
  }
  if (options.resume) {
    args.push('--resume', options.resume);
  }
  if (options.continue) {
    args.push('--continue');
  }
  if (options.allowedTools) {
    args.push('--allowedTools', ...options.allowedTools);
  }
  if (typeof options.mcpConfigPath === 'string' && options.mcpConfigPath.trim()) {
    args.push('--mcp-config', options.mcpConfigPath.trim());
  }
  const permissionMode = typeof options.permissionMode === 'string'
    ? options.permissionMode.trim()
    : '';
  if (permissionMode) {
    // `default` is the Claude Code 2.1.247+ gated mode. It must pass through
    // unchanged; only the legacy bypass alias maps to bypassPermissions.
    args.push('--permission-mode', permissionMode === 'skip-permissions' ? 'bypassPermissions' : permissionMode);
  } else if (options.dangerouslySkipPermissions) {
    args.push('--dangerously-skip-permissions');
  }

  if (options.model) {
    args.push('--model', options.model);
  }
  const effort = typeof options.effort === 'string' ? options.effort.trim() : '';
  if (effort && effort !== 'none') {
    args.push('--effort', effort);
  } else if (!effort && options.thinking) {
    args.push('--effort', 'high');
  }
  // effort === 'none' → no --effort flag → thinking disabled

  return args;
}
