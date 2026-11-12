import assert from 'node:assert/strict';
import { evaluateRunBoundCodexWindowsHook } from '../chat/codex-run-bound-windows-hook.mjs';

const event = { session_id: 'thread-a', turn_id: 'turn-a', hook_event_name: 'PreToolUse', tool_name: 'Bash',
  tool_use_id: 'call-a', tool_input: { command: 'runas /user:admin cmd.exe' } };
const env = { AGENTOC_APPROVED_ACTIONS_ENDPOINT: 'http://127.0.0.1:9', AGENTOC_APPROVED_ACTIONS_TOKEN: 'token-a',
  AGENTOC_APPROVED_ACTIONS_SESSION_ID: 'session-a', AGENTOC_APPROVED_ACTIONS_RUN_ID: 'run-a', AGENTOC_APPROVED_ACTIONS_TURN_ID: 'request-a' };
const binding = { active: true, threadId: 'thread-a', turnId: 'turn-a', env };
const other = { ...binding, threadId: 'thread-b', turnId: 'turn-b', env: {} };
const [first, second] = await Promise.all([
  evaluateRunBoundCodexWindowsHook(event, binding),
  evaluateRunBoundCodexWindowsHook({ ...event, session_id: 'thread-b', turn_id: 'turn-b' }, other),
]);
assert.match(first.hookSpecificOutput.permissionDecisionReason, /agentoc_request_actions/);
assert.match(second.hookSpecificOutput.permissionDecisionReason, /unavailable/);
assert.deepEqual(await evaluateRunBoundCodexWindowsHook(event, { ...binding, enabled: false }), {});
assert.equal((await evaluateRunBoundCodexWindowsHook(event, { ...binding, enabled: false, active: false })).hookSpecificOutput.permissionDecision, 'deny');
for (const invalid of [{ ...binding, threadId: 'thread-b' }, { ...binding, turnId: 'turn-b' }, { ...binding, active: false }]) {
  const result = await evaluateRunBoundCodexWindowsHook(event, invalid);
  assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /bound to its active run/);
}
console.log('test-codex-run-bound-windows-hook: concurrent contexts remain bound to their turns');
