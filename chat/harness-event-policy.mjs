// Runtime-family independent persistence policy.
//
// Adapters translate wire protocols into normalized AgentoC events. This
// module is the single place that decides which provider progress is ephemeral
// and how much payload is safe to retain in hot session history. Raw provider
// lines remain available in the bounded run spool for diagnostics/replay.

export const HARNESS_EVENT_POLICY_VERSION = '1';
export const DEFAULT_HARNESS_EVENT_POLICY = Object.freeze({
  maxPersistedMessageBytes: 256 * 1024,
  maxPersistedToolInputBytes: 64 * 1024,
  maxPersistedToolOutputBytes: 32 * 1024,
  maxPersistedStatusBytes: 4 * 1024,
  maxPersistedEventsPerTick: 512,
});

const RUNTIME_FAMILY_POLICIES = Object.freeze({
  'claude-stream-json': DEFAULT_HARNESS_EVENT_POLICY,
  'claude-stream-json-bidi': DEFAULT_HARNESS_EVENT_POLICY,
  'codex-json': DEFAULT_HARNESS_EVENT_POLICY,
  'codex-app-server-json': DEFAULT_HARNESS_EVENT_POLICY,
  'copilot-json': DEFAULT_HARNESS_EVENT_POLICY,
  'hermes-acp': DEFAULT_HARNESS_EVENT_POLICY,
  'agy-json': DEFAULT_HARNESS_EVENT_POLICY,
  'agy-stream-json': DEFAULT_HARNESS_EVENT_POLICY,
  'pi-rpc-jsonl': DEFAULT_HARNESS_EVENT_POLICY,
  'deepseek-harness-acp': DEFAULT_HARNESS_EVENT_POLICY,
  'qwen-code-acp': DEFAULT_HARNESS_EVENT_POLICY,
  'opencode-json': DEFAULT_HARNESS_EVENT_POLICY,
  'kimi-code-acp': DEFAULT_HARNESS_EVENT_POLICY,
  'goose-headless': DEFAULT_HARNESS_EVENT_POLICY,
  'openhands-headless': DEFAULT_HARNESS_EVENT_POLICY,
  'openhands-agent-server': DEFAULT_HARNESS_EVENT_POLICY,
  'cline-json': DEFAULT_HARNESS_EVENT_POLICY,
  'kilo-json': DEFAULT_HARNESS_EVENT_POLICY,
});

const PROVIDER_TRANSIENT_TYPES = new Set(['text_delta']);
const RUNTIME_PROGRESS_TYPES = new Set(['status', 'usage']);
const IMPORTANT_HARNESS_EVENT_TYPES = new Set([
  'message', 'tool_result', 'approval_request', 'approval_response',
  'privileged_batch_request', 'privileged_batch_response', 'privileged_exec_result',
  'file_change', 'plan', 'reasoning',
]);

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function clipMiddle(value, maxBytes) {
  const input = typeof value === 'string' ? value : '';
  if (!input || !Number.isInteger(maxBytes) || maxBytes <= 0) return input;
  if (Buffer.byteLength(input, 'utf8') <= maxBytes) return input;
  const marker = '\n… [Ragent payload clipped; raw event remains in run spool] …\n';
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  if (markerBytes >= maxBytes) return Buffer.from(input, 'utf8').subarray(0, maxBytes).toString('utf8');
  const available = maxBytes - markerBytes;
  const headBytes = Math.ceil(available * 0.6);
  const tailBytes = available - headBytes;
  const head = Buffer.from(input, 'utf8').subarray(0, headBytes).toString('utf8');
  const tail = Buffer.from(input, 'utf8').subarray(-tailBytes).toString('utf8');
  return `${head}${marker}${tail}`;
}

export function getHarnessEventPolicy(runtimeFamily = '') {
  const key = trimString(runtimeFamily);
  const profile = RUNTIME_FAMILY_POLICIES[key] || DEFAULT_HARNESS_EVENT_POLICY;
  return {
    version: HARNESS_EVENT_POLICY_VERSION,
    runtimeFamily: key || 'unknown',
    ...profile,
  };
}

export function isProviderTransientEvent(event) {
  if (PROVIDER_TRANSIENT_TYPES.has(event?.type)) return true;
  if (event?.type === 'reasoning') return event.reasoningLifecycle !== 'completed' && event.state !== 'completed';
  // Codex app-server streams tool output as a sequence of operation deltas.
  // Those deltas are live UI updates, not durable tool results.  Persisting
  // every fragment turns a single command into thousands of history files.
  return event?.type === 'tool_result'
    && trimString(event?.operationLifecycle).toLowerCase() === 'delta';
}

export function isRuntimeProgressEvent(event) {
  return RUNTIME_PROGRESS_TYPES.has(event?.type);
}

export function isHarnessEphemeralEvent(event) {
  return isProviderTransientEvent(event) || Boolean(
    trimString(event?.runId)
    && trimString(event?.runtimeFamily)
    && isRuntimeProgressEvent(event)
    && !(event?.type === 'status' && ['completed', 'failed', 'cancelled'].includes(trimString(event?.runState).toLowerCase()))
  );
}

export function prepareHarnessEventForPersistence(event, policy = null) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return event;
  const resolved = policy || getHarnessEventPolicy(event.runtimeFamily);
  const next = { ...event };
  let changed = false;
  if (typeof next.content === 'string' && (next.type === 'message' || next.type === 'reasoning')) {
    const clipped = clipMiddle(next.content, resolved.maxPersistedMessageBytes);
    if (clipped !== next.content) {
      next.content = clipped;
      next.contentTruncated = true;
      next.contentBytes = Buffer.byteLength(event.content, 'utf8');
      changed = true;
    }
  }
  if (typeof next.content === 'string' && next.type === 'status') {
    const clipped = clipMiddle(next.content, resolved.maxPersistedStatusBytes);
    if (clipped !== next.content) {
      next.content = clipped;
      next.contentTruncated = true;
      changed = true;
    }
  }
  if (typeof next.toolInput === 'string') {
    const clipped = clipMiddle(next.toolInput, resolved.maxPersistedToolInputBytes);
    if (clipped !== next.toolInput) {
      next.toolInput = clipped;
      next.toolInputTruncated = true;
      next.toolInputBytes = Buffer.byteLength(event.toolInput, 'utf8');
      changed = true;
    }
  }
  if (typeof next.output === 'string') {
    const clipped = clipMiddle(next.output, resolved.maxPersistedToolOutputBytes);
    if (clipped !== next.output) {
      next.output = clipped;
      next.outputTruncated = true;
      next.outputBytes = Buffer.byteLength(event.output, 'utf8');
      changed = true;
    }
  }
  return changed ? next : event;
}

export function limitHarnessDurableEvents(events = [], policy = null) {
  const source = Array.isArray(events) ? events : [];
  if (source.length === 0) return [];
  const resolved = policy || getHarnessEventPolicy(source.find((event) => event?.runtimeFamily)?.runtimeFamily);
  const limit = Number.isInteger(resolved.maxPersistedEventsPerTick) && resolved.maxPersistedEventsPerTick > 0
    ? resolved.maxPersistedEventsPerTick
    : DEFAULT_HARNESS_EVENT_POLICY.maxPersistedEventsPerTick;
  // Do not drop control/terminal/message events. The cap applies only to
  // repeated tool progress in one observer tick; excess progress stays in the
  // run spool and the terminal projection gets one final opportunity to emit
  // its completion event.
  if (source.length <= limit) return source.map((event) => prepareHarnessEventForPersistence(event, resolved));
  const important = [];
  const progress = [];
  for (const event of source) {
    (IMPORTANT_HARNESS_EVENT_TYPES.has(event?.type) ? important : progress).push(event);
  }
  const room = Math.max(0, limit - important.length);
  const selected = [...progress.slice(-room), ...important];
  return selected.map((event) => prepareHarnessEventForPersistence(event, resolved));
}
