import {
  fileChangeEvent,
  messageEvent,
  reasoningEvent,
  statusEvent,
  toolResultEvent,
  toolUseEvent,
} from '../normalizer.mjs';
import { getProviderCapabilities } from '../provider-contract.mjs';
import { getHarnessAdapterCompatibility } from '../harness-compatibility.mjs';
import { inferProviderFileChange, serializeProviderToolValue } from '../provider-tool-normalization.mjs';

export const KILO_RUNTIME_FAMILY = 'kilo-json';

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function providerFields(sessionId) {
  return {
    provider: 'kilo',
    runtimeFamily: KILO_RUNTIME_FAMILY,
    ...(sessionId ? { providerSessionId: sessionId } : {}),
  };
}

function stringifyInput(value) {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function readPartError(state) {
  if (typeof state?.error === 'string') return state.error;
  if (state?.error && typeof state.error === 'object') return clean(state.error.message || JSON.stringify(state.error));
  return '';
}

export function createKiloAdapter() {
  let sessionId = '';
  return {
    adapterCompatibility: getHarnessAdapterCompatibility('kilo'),
    capabilities: getProviderCapabilities(KILO_RUNTIME_FAMILY),

    parseLine(line) {
      let event;
      try { event = JSON.parse(String(line || '').trim()); } catch { return []; }
      if (!event || typeof event !== 'object') return [];
      sessionId = clean(event.sessionID || event.sessionId || sessionId);
      const fields = providerFields(sessionId);
      const part = event.part && typeof event.part === 'object' ? event.part : {};
      const events = [];

      switch (clean(event.type).toLowerCase()) {
        case 'text':
          if (typeof part.text === 'string' && part.text.trim()) {
            events.push(messageEvent('assistant', part.text, undefined, fields));
          }
          break;
        case 'reasoning':
          if (typeof part.text === 'string' && part.text.trim()) {
            events.push(reasoningEvent(part.text, {
              ...fields,
              providerBlockId: clean(part.id) || 'thinking:0',
              blockIndex: 0,
              providerLifecycle: 'delta',
              reasoningLifecycle: 'delta',
              operationLifecycle: 'delta',
              state: 'running',
            }));
          }
          break;
        case 'tool_use': {
          const state = part.state && typeof part.state === 'object' ? part.state : {};
          const toolName = clean(part.tool || part.name) || 'tool';
          const toolId = clean(part.callID || part.callId || part.id);
          const status = clean(state.status).toLowerCase();
          events.push(toolUseEvent(toolName, stringifyInput(state.input || part.input), {
            ...fields,
            ...(toolId ? { providerToolUseId: toolId } : {}),
            operationLifecycle: status === 'error' ? 'failed' : 'started',
          }));
          if (status === 'completed' || status === 'error' || status === 'failed') {
            events.push(toolResultEvent(
              toolName,
              serializeProviderToolValue(state.output ?? readPartError(state)),
              status === 'error' || status === 'failed' ? 1 : 0,
              {
                ...fields,
                ...(toolId ? { providerToolUseId: toolId } : {}),
                operationLifecycle: status === 'completed' ? 'completed' : 'failed',
              },
            ));
            if (status === 'completed') {
              const change = inferProviderFileChange({ toolName, toolInput: state.input || part.input });
              if (change) events.push(fileChangeEvent(change.filePath, change.changeType, {}, {
                ...fields,
                ...(toolId ? { providerToolUseId: toolId } : {}),
                operationLifecycle: 'completed',
              }));
            }
          }
          break;
        }
        case 'step_start':
          events.push(statusEvent('Step started', { ...fields, providerLifecycle: 'step_started' }));
          break;
        case 'step_finish':
          events.push(statusEvent('Step completed', { ...fields, providerLifecycle: 'step_completed' }));
          break;
        case 'error': {
          const error = clean(event.error?.message || event.error || event.message) || 'Kilo run failed';
          events.push(statusEvent(`error: ${error}`, { ...fields, providerLifecycle: 'error' }));
          break;
        }
        default:
          break;
      }
      return events.filter(Boolean);
    },

    flush() { return []; },
  };
}

export function buildKiloArgs(prompt, {
  model = '',
  resume = '',
  riskMode = '',
} = {}) {
  const task = typeof prompt === 'string' ? prompt.trim() : '';
  if (!task) throw new Error('Kilo requires a non-empty prompt');
  const args = ['run', '--format', 'json'];
  if (riskMode !== 'conservative-auto') args.push('--auto');
  if (clean(resume)) args.push('--session', clean(resume));
  const selectedModel = clean(model).split('@')[0];
  if (selectedModel) args.push('--model', `ragent/${selectedModel}`);
  args.push(task);
  return args;
}
