#!/usr/bin/env node
import assert from 'assert/strict';

import {
  classifyProviderTerminalFrame,
  classifyHarnessFailure,
  classifyTerminalRunAuthFailure,
  providerRequiresTerminalEvidence,
} from '../chat/runner-sidecar.mjs';
import { isProviderSuccessfulTerminalPayload } from '../chat/run-terminal-signals.mjs';

assert.equal(classifyHarnessFailure('readline was closed'), 'HARNESS_STREAM_CLOSED');
assert.equal(classifyHarnessFailure('OpenHands event socket closed before terminal event'), 'HARNESS_TERMINAL_MISSING');
assert.equal(classifyHarnessFailure('Codex app-server exited without an accepted terminal turn event'), 'HARNESS_TERMINAL_MISSING');
assert.equal(classifyHarnessFailure('MCP readiness failed: MCP_READINESS_TIMEOUT'), 'MCP_READINESS_TIMEOUT');
assert.equal(classifyHarnessFailure('Codex fresh-thread recovery sidecar did not terminalize the Run before timeout'), 'CODEX_RECOVERY_TIMEOUT');

assert.equal(
  classifyTerminalRunAuthFailure({
    effectiveExitCode: 0,
    providerErrorPreview: 'failed to refresh available models: 401 Unauthorized',
  }),
  '',
  'an ancillary 401 must not trigger recovery after a successful provider outcome',
);
assert.equal(
  classifyTerminalRunAuthFailure({
    effectiveExitCode: 1,
    providerFailureReason: '401 Unauthorized',
  }),
  'auth-expired',
  'a failed provider outcome retains explicit authentication recovery',
);
assert.equal(
  isProviderSuccessfulTerminalPayload({
    method: 'turn/completed',
    params: { turn: { id: 'turn-ok', status: 'completed' } },
  }, 'codex-app-server-json', 'turn-ok'),
  true,
  'the control plane must recognize a successful raw app-server terminal before result persistence',
);
assert.equal(
  isProviderSuccessfulTerminalPayload({
    method: 'turn/completed',
    params: { turn: { id: 'turn-failed', status: 'failed' } },
  }, 'codex-app-server-json', 'turn-failed'),
  false,
);
assert.equal(
  isProviderSuccessfulTerminalPayload({
    method: 'turn/completed',
    params: { turn: { id: 'turn-other', status: 'completed' } },
  }, 'codex-app-server-json', 'turn-ok'),
  false,
  'a stale turn terminal cannot veto recovery for the active turn',
);
assert.equal(
  isProviderSuccessfulTerminalPayload({
    method: 'turn/completed',
    params: { turn: { id: 'turn-ok', status: 'completed', error: { message: 'failed' } } },
  }, 'codex-app-server-json', 'turn-ok'),
  false,
  'a terminal payload carrying an error is not successful evidence',
);

assert.deepEqual(
  classifyProviderTerminalFrame('codex-json', { type: 'turn.completed' }),
  { kind: 'completed', reason: 'turn.completed' },
);
assert.equal(
  classifyProviderTerminalFrame('codex-json', { type: 'turn.completed', status: 'failed' })?.kind,
  'failed',
  'a failed Codex turn must never be treated as a successful completion',
);
assert.equal(
  providerRequiresTerminalEvidence('codex-json'),
  true,
  'legacy Codex JSON runs must require an explicit turn terminal frame',
);
assert.equal(
  providerRequiresTerminalEvidence('copilot-json'),
  true,
  'Copilot JSON runs must require their explicit turn terminal frame',
);
assert.deepEqual(
  classifyProviderTerminalFrame('copilot-json', { type: 'turn.completed' }),
  { kind: 'completed', reason: 'turn.completed' },
);
assert.equal(
  classifyProviderTerminalFrame('codex-json', { type: 'item.completed', item: {} }),
  null,
  'an item completion is not a turn completion',
);
const failedCodex = classifyProviderTerminalFrame('codex-json', {
  type: 'turn.failed',
  error: { message: 'upstream failed', details: 'sk-proj-0123456789012345' },
});
assert.equal(failedCodex?.kind, 'failed');
assert.match(failedCodex?.reason || '', /upstream failed/);
assert.doesNotMatch(failedCodex?.reason || '', /sk-proj-0123456789012345/);

assert.deepEqual(
  classifyProviderTerminalFrame('claude-stream-json', {
    type: 'result',
    subtype: 'success',
    result: 'done',
  }),
  { kind: 'completed', reason: 'result' },
);
assert.equal(
  classifyProviderTerminalFrame('claude-stream-json', { type: 'result', subtype: 'success' })?.kind,
  'failed',
  'a malformed Claude result must remain an explicit failure',
);
assert.equal(
  classifyProviderTerminalFrame('agy-json', { event: 'result', result: { status: 'SUCCESS' } })?.kind,
  'completed',
);
assert.equal(
  classifyProviderTerminalFrame('pi-rpc-jsonl', { type: 'agent_end' })?.kind,
  'completed',
);
assert.equal(
  classifyProviderTerminalFrame('pi-rpc-jsonl', { type: 'agent_end', willRetry: true }),
  null,
  'Pi automatic retry must keep stdin/process alive',
);
assert.equal(
  classifyProviderTerminalFrame('pi-rpc-jsonl', { type: 'agent_end', willRetry: false,
    messages: [{ role: 'assistant', stopReason: 'error', errorMessage: 'quota exhausted' }] })?.kind,
  'failed',
);
assert.equal(
  classifyProviderTerminalFrame('cline-json', { type: 'done' })?.kind,
  'completed',
);
assert.equal(
  classifyProviderTerminalFrame('qwen-code-acp', { id: 'ragent-prompt', result: {} })?.kind,
  'completed',
);
assert.equal(
  classifyProviderTerminalFrame('deepseek-harness-acp', { id: 'ragent-prompt', result: {} }, { acp: true })?.kind,
  'completed',
  'DeepSeek ACP mode must share the ACP terminal contract',
);
assert.equal(
  providerRequiresTerminalEvidence('deepseek-harness-acp', { acp: true }),
  true,
  'DeepSeek ACP mode must require an explicit prompt response',
);
assert.equal(
  providerRequiresTerminalEvidence('goose-headless'),
  false,
  'plain-text harnesses have no portable terminal frame to validate',
);

console.log('test-runner-sidecar-terminal-evidence: ok');
