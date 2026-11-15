import { fileChangeEvent, messageEvent, reasoningEvent, statusEvent, toolResultEvent, toolUseEvent, textDeltaEvent } from '../normalizer.mjs';
import { getProviderCapabilities } from '../provider-contract.mjs';
import { getHarnessAdapterCompatibility } from '../harness-compatibility.mjs';
import { inferProviderFileChange, serializeProviderToolValue } from '../provider-tool-normalization.mjs';

export const OPENCODE_RUNTIME_FAMILY = 'opencode-json';

function asText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function createOpenCodeAdapter() {
  const tools = new Map();
  return {
    adapterCompatibility: getHarnessAdapterCompatibility('opencode'),
    capabilities: getProviderCapabilities(OPENCODE_RUNTIME_FAMILY),
    parseLine(line) {
      let event;
      try { event = JSON.parse(String(line || '').trim()); } catch { return []; }
      const part = event?.part || {};
      const text = asText(part.text);
      const eventId = asText(event.id || event.event_id || event.messageId || event.message_id);
      const toolId = asText(
        part.id
        || part.toolCallId
        || part.tool_call_id
        || event.toolCallId
        || event.tool_call_id
        || eventId,
      );
      const identity = {
        provider: 'opencode',
        runtimeFamily: OPENCODE_RUNTIME_FAMILY,
        ...(eventId ? { providerMessageId: eventId } : {}),
        ...(toolId ? { providerToolUseId: toolId } : {}),
      };
      if (event.type === 'text' && text) return [textDeltaEvent(0, text, identity)];
      if (event.type === 'reasoning' && text) return [reasoningEvent(text, {
        ...identity,
        providerBlockId: eventId || 'thinking:0',
        blockIndex: 0,
        providerLifecycle: 'delta',
        reasoningLifecycle: 'delta',
        operationLifecycle: 'delta',
        state: 'running',
      })];
      if (event.type === 'step_start') return [statusEvent('Step started', identity)];
      if (event.type === 'step_finish') return [statusEvent('Step completed', identity)];
      if (event.type === 'tool_start' || (event.type === 'tool' && part.state?.status === 'running')) {
        const toolName = asText(part.tool || part.name) || 'tool';
        const toolInput = part.input || part.args || part.state?.input || '';
        if (toolId) tools.set(toolId, { toolName, toolInput });
        return [toolUseEvent(toolName, toolInput, { ...identity, operationLifecycle: 'started' })];
      }
      if (event.type === 'tool_end' || (event.type === 'tool' && ['completed', 'error'].includes(part.state?.status))) {
        const failed = part.state?.status === 'error';
        const known = toolId ? tools.get(toolId) : null;
        const toolName = asText(part.tool || part.name) || known?.toolName || 'tool';
        const events = [toolResultEvent(toolName, serializeProviderToolValue(part.state?.output ?? part.state?.error ?? part.output ?? ''), failed ? 1 : 0, {
          ...identity,
          operationLifecycle: failed ? 'failed' : 'completed',
        })];
        const change = !failed ? inferProviderFileChange({ toolName, toolInput: known?.toolInput || part.state?.input || part.input }) : null;
        if (change) events.push(fileChangeEvent(change.filePath, change.changeType, {}, {
          ...identity,
          operationLifecycle: 'completed',
        }));
        if (toolId) tools.delete(toolId);
        return events;
      }
      if (event.type === 'session.error') return [statusEvent(`error: ${asText(event.error || event.message) || 'OpenCode run failed'}`, { ...identity, runState: 'failed' })];
      return [];
    },
    flush() { tools.clear(); return []; },
  };
}

export function buildOpenCodeArgs(prompt, { model = '', riskMode = '' } = {}) {
  const task = typeof prompt === 'string' ? prompt.trim() : '';
  if (!task) throw new Error('OpenCode requires a non-empty prompt');
  const args = ['run', '--format', 'json'];
  if (riskMode === 'full-auto') args.push('--auto');
  const selectedModel = typeof model === 'string' ? model.trim().split('@')[0] : '';
  if (selectedModel) args.push('--model', `ragent/${selectedModel}`);
  args.push(task);
  return args;
}
