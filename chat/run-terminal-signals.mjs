const CLAUDE_BIDI_RUNTIME_FAMILY = 'claude-stream-json-bidi';
const CODEX_APP_SERVER_RUNTIME_FAMILY = 'codex-app-server-json';

// These runtimes expose an explicit end-of-turn frame. A normalized
// `status: completed` event from one of them is only a candidate; the sidecar
// must still persist the provider result before the control plane can claim
// success. Keeping this contract in one dependency-free module prevents the
// observer and sidecar from disagreeing about whether a process that
// disappears mid-turn may be synthesized as successful.
const TERMINAL_EVIDENCE_RUNTIME_FAMILIES = new Set([
  'claude-stream-json',
  CLAUDE_BIDI_RUNTIME_FAMILY,
  'codex-json',
  CODEX_APP_SERVER_RUNTIME_FAMILY,
  'copilot-json',
  'agy-json',
  'agy-stream-json',
  'pi-rpc-jsonl',
  'cline-json',
  'qwen-code-acp',
  'kimi-code-acp',
  'hermes-acp',
]);

export function providerRequiresTerminalEvidence(runtimeFamily, { acp = false } = {}) {
  const family = typeof runtimeFamily === 'string' ? runtimeFamily.trim() : '';
  return acp || TERMINAL_EVIDENCE_RUNTIME_FAMILIES.has(family);
}

export function isProviderRunCompletionEvent(event, runtimeFamily = '', expectedProviderTurnId = '') {
  if (
    event?.type !== 'status'
    || typeof event.content !== 'string'
    || event.content.trim() !== 'completed'
  ) {
    return false;
  }
  if (runtimeFamily === CLAUDE_BIDI_RUNTIME_FAMILY) {
    return event.providerLifecycle === 'completed';
  }
  if (runtimeFamily === CODEX_APP_SERVER_RUNTIME_FAMILY) {
    if (event.providerLifecycle !== 'completed') return false;
    const expected = typeof expectedProviderTurnId === 'string' ? expectedProviderTurnId.trim() : '';
    return !expected || event.providerTurnId === expected;
  }
  return true;
}

// Raw-spool success evidence is used by the auth-recovery gate before the
// normal projection/finalization pass has necessarily persisted result.json.
// Keep this deliberately stricter than the display adapters: only an explicit
// provider success edge can veto a replay. Diagnostic stderr, partial text and
// generic "done" wording are never sufficient.
export function isProviderSuccessfulTerminalPayload(payload, runtimeFamily = '', expectedProviderTurnId = '') {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const family = typeof runtimeFamily === 'string' ? runtimeFamily.trim() : '';
  if (family === CODEX_APP_SERVER_RUNTIME_FAMILY) {
    if (payload.method !== 'turn/completed') return false;
    const turn = payload.params?.turn;
    const expected = typeof expectedProviderTurnId === 'string' ? expectedProviderTurnId.trim() : '';
    const actual = typeof turn?.id === 'string' ? turn.id.trim() : '';
    if (expected && actual !== expected) return false;
    return !payload.error
      && !turn?.error
      && String(turn?.status || '').trim().toLowerCase() === 'completed';
  }
  if (family === 'codex-json' || family === 'copilot-json') {
    if (payload.type !== 'turn.completed') return false;
    const status = String(payload.status || payload.turn?.status || '').trim().toLowerCase();
    return !['failed', 'error', 'interrupted', 'cancelled', 'canceled'].includes(status);
  }
  if (family === 'claude-stream-json' || family === CLAUDE_BIDI_RUNTIME_FAMILY) {
    if (payload.type !== 'result') return false;
    const reason = String(payload.terminal_reason || '').trim().toLowerCase();
    const hasResultField = Object.prototype.hasOwnProperty.call(payload, 'result');
    const invalidSuccessBody = payload.subtype === 'success'
      && (!hasResultField || typeof payload.result !== 'string');
    const resultText = typeof payload.result === 'string' ? payload.result.trim() : '';
    return payload.is_error !== true
      && payload.subtype !== 'error'
      && !payload.error
      && !invalidSuccessBody
      && !/^api\s+error\b/i.test(resultText)
      && !['api_error', 'error', 'failed', 'aborted', 'abort', 'cancelled', 'canceled', 'interrupted', 'timeout'].includes(reason);
  }
  if (family === 'agy-json' || family === 'agy-stream-json') {
    return payload.event === 'result'
      && String(payload.result?.status || '').trim().toUpperCase() === 'SUCCESS';
  }
  if (family === 'pi-rpc-jsonl') return payload.type === 'agent_end';
  if (family === 'cline-json') {
    return ['done', 'completed'].includes(String(payload.type || '').trim().toLowerCase());
  }
  if (family === 'qwen-code-acp' || family === 'kimi-code-acp' || family === 'hermes-acp') {
    return payload.id === 'ragent-prompt' && !payload.error && Boolean(payload.result);
  }
  return false;
}
