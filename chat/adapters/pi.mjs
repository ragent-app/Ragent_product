import { bridgeHarnessEvent } from '../harness-event-bridge.mjs';
import { getHarnessAdapterCompatibility } from '../harness-compatibility.mjs';
import { inferProviderFileChange } from '../provider-tool-normalization.mjs';
import { getProviderCapabilities } from '../provider-contract.mjs';

export const PI_RUNTIME_FAMILY = 'pi-rpc-jsonl';

const PI_CAPABILITIES = Object.freeze(getProviderCapabilities(PI_RUNTIME_FAMILY));

function text(value) {
  return typeof value === 'string' ? value : '';
}

function bridge(event) {
  return bridgeHarnessEvent(event, {
    provider: 'pi',
    runtimeFamily: PI_RUNTIME_FAMILY,
  });
}

// Pi 1.4 can emit agent_end before its own automatic retry. It is not a Run
// completion until willRetry is false/absent. The final assistant stop reason
// also distinguishes a provider failure from a successful empty answer.
export function readPiTerminalOutcome(event) {
  if (event?.type !== 'agent_end' || event.willRetry === true) return null;
  const lastAssistant = [...(Array.isArray(event.messages) ? event.messages : [])]
    .reverse().find((message) => message?.role === 'assistant');
  if (['error', 'aborted'].includes(lastAssistant?.stopReason)) {
    return { kind: 'failed', reason: text(lastAssistant.errorMessage) || `Pi ${lastAssistant.stopReason}` };
  }
  return { kind: 'completed', reason: 'agent_end' };
}

function parsePiEvent(event, toolCalls) {
  if (!event || typeof event !== 'object') return [];
  if (event.type === 'response') {
    return event.success === false
      ? [bridge({ type: 'run.failed', id: event.id, data: { message: event.error || 'Pi RPC request failed' } })].filter(Boolean)
      : [];
  }

  switch (event.type) {
    case 'agent_start': return [bridge({ type: 'run.started' })].filter(Boolean);
    case 'turn_start': return [bridge({ type: 'turn.started' })].filter(Boolean);
    case 'turn_end': return [];
    case 'agent_end': {
      const outcome = readPiTerminalOutcome(event);
      return outcome ? [bridge({ type: outcome.kind === 'completed' ? 'run.completed' : 'run.failed',
        data: { message: outcome.kind === 'completed' ? 'completed' : outcome.reason } })].filter(Boolean) : [];
    }
    case 'auto_retry_start':
      return [bridge({ type: 'run.waiting', data: { message: `Pi retry ${event.attempt || ''}`.trim() } })].filter(Boolean);
    case 'message_update': {
      const delta = event.assistantMessageEvent || {};
      if (delta.type === 'text_delta') {
        return [bridge({
          type: 'assistant.delta',
          id: event.id,
          data: { delta: text(delta.delta), blockIndex: delta.contentIndex },
        })].filter(Boolean);
      }
      if (delta.type === 'thinking_delta') {
        return [bridge({ type: 'reasoning.delta', id: event.id, data: { delta: text(delta.delta) } })].filter(Boolean);
      }
      return [];
    }
    case 'message_end': {
      const message = event.message;
      if (message?.role !== 'assistant') return [];
      const content = typeof message?.content === 'string'
        ? message.content
        : (Array.isArray(message?.content)
          ? message.content.filter((part) => part?.type === 'text').map((part) => part.text || '').join('')
          : '');
      return content ? [bridge({ type: 'assistant.message', id: event.id, data: { content } })].filter(Boolean) : [];
    }
    case 'tool_execution_start': {
      if (event.toolCallId) toolCalls.set(event.toolCallId, { toolName: event.toolName, input: event.args || event.input || '' });
      return [bridge({ type: 'tool.started', id: event.id, toolCallId: event.toolCallId, data: {
        name: event.toolName, input: event.args || event.input || '',
      } })].filter(Boolean);
    }
    case 'tool_execution_update':
      return [bridge({ type: 'tool.progress', id: event.id, toolCallId: event.toolCallId, data: {
        name: event.toolName, output: event.partialResult,
      } })].filter(Boolean);
    case 'tool_execution_end': {
      const known = event.toolCallId ? toolCalls.get(event.toolCallId) : null;
      const events = [bridge({ type: 'tool.completed', id: event.id, toolCallId: event.toolCallId, data: {
        name: event.toolName, output: event.result, error: event.isError ? 'tool failed' : '',
        exitCode: event.isError ? 1 : 0,
      } })].filter(Boolean);
      const change = !event.isError ? inferProviderFileChange({
        toolName: event.toolName || known?.toolName,
        toolInput: known?.input,
      }) : null;
      if (change) events.push(bridge({
        type: 'file.changed',
        id: event.id ? `${event.id}:file-change` : '',
        toolCallId: event.toolCallId,
        data: { filePath: change.filePath, changeType: change.changeType },
      }));
      if (event.toolCallId) toolCalls.delete(event.toolCallId);
      return events.filter(Boolean);
    }
    default:
      return [];
  }
}

export function createPiAdapter() {
  const toolCalls = new Map();
  return {
    adapterCompatibility: getHarnessAdapterCompatibility('pi'),
    capabilities: PI_CAPABILITIES,
    parseLine(line) {
      try { return parsePiEvent(JSON.parse(String(line || '').trim()), toolCalls); } catch { return []; }
    },
    flush() { toolCalls.clear(); return []; },
  };
}

export function buildPiArgs({ provider = '', model = '', sessionDir = '', noSession = false } = {}) {
  const args = ['--mode', 'rpc'];
  if (provider) args.push('--provider', provider);
  if (model) args.push('--model', model);
  if (sessionDir) args.push('--session-dir', sessionDir);
  if (noSession) args.push('--no-session');
  return args;
}

export function buildPiInput(prompt) {
  return `${JSON.stringify({ type: 'prompt', id: 'ragent-initial-prompt', message: text(prompt) })}\n`;
}
