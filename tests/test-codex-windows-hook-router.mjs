import assert from 'node:assert/strict';
import { createCodexWindowsHookRouter } from '../chat/codex-windows-hook-router.mjs';

const sourcePath = 'G:\\fixture\\hooks.json';
const prefix = `pre-tool-use:1:${sourcePath}:`;
const owners = new Map([['thread-a', { id: 'a' }], ['thread-b', { id: 'b' }]]);
let clock = 100;
const router = createCodexWindowsHookRouter({ sourcePath, runIdPrefix: prefix, getOwner: id => owners.get(id), now: () => clock, ttlMs: 50 });
const started = (threadId, turnId, callId) => ({ method: 'hook/started', params: { threadId, turnId, run: {
  id: `${prefix}${callId}`, sourcePath, eventName: 'preToolUse', handlerType: 'command', executionMode: 'sync', status: 'running',
} } });
const event = (threadId, turnId, callId) => ({ session_id: threadId, turn_id: turnId, tool_use_id: callId,
  tool_name: 'Bash', hook_event_name: 'PreToolUse', tool_input: { command: 'Write-Output hello' } });
assert.equal(router.claim(event('thread-a', 'turn-a', 'call-a')), null);
router.observe(started('thread-a', 'turn-a', 'call-a'));
router.observe(started('thread-b', 'turn-b', 'call-b'));
assert.equal(router.claim(event('thread-a', 'turn-b', 'call-a')), null);
assert.equal(router.claim(event('thread-a', 'turn-a', 'call-b')), null);
assert.equal(router.claim(event('thread-b', 'turn-b', 'call-b')), owners.get('thread-b'));
assert.equal(router.claim(event('thread-a', 'turn-a', 'call-a')), owners.get('thread-a'));
assert.equal(router.claim(event('thread-a', 'turn-a', 'call-a')), null);
const wrongSource = started('thread-a', 'turn-a', 'call-a'); wrongSource.params.run.sourcePath = 'G:\\fixture\\other.json';
router.observe(wrongSource);
assert.equal(router.claim(event('thread-a', 'turn-a', 'call-a')), null);
router.observe(started('thread-a', 'turn-a', 'call-a')); router.observe({ ...started('thread-a', 'turn-a', 'call-a'), method: 'hook/completed' });
assert.equal(router.claim(event('thread-a', 'turn-a', 'call-a')), null);
router.observe(started('thread-a', 'turn-a', 'call-a')); clock += 51;
assert.equal(router.claim(event('thread-a', 'turn-a', 'call-a')), null);
router.observe(started('thread-a', 'turn-a', 'call-a')); owners.set('thread-a', { id: 'replacement' });
assert.equal(router.claim(event('thread-a', 'turn-a', 'call-a')), null);
console.log('test-codex-windows-hook-router: only live matching hook calls reach their owner');
