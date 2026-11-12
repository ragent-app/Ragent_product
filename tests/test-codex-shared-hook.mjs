import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\agentoc-hook-test-${process.pid}` : join(tmpdir(), `agentoc-hook-test-${process.pid}.sock`);
const event = { session_id: 'thread', turn_id: 'turn', tool_use_id: 'call', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'fixture' } };
let seen;
const server = createServer(socket => createInterface({ input: socket }).once('line', line => {
  seen = JSON.parse(line);
  socket.end(JSON.stringify({ result: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } } }) + '\n');
}));
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
async function invoke(path, input) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/agentoc-codex-shared-hook.mjs', '--socket', path], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
    child.on('error', reject); child.on('close', code => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr)));
    child.stdin.end(input);
  });
}
try {
  assert.equal((await invoke(socketPath, JSON.stringify(event))).hookSpecificOutput.permissionDecision, 'allow');
  assert.deepEqual(seen, { type: 'agentoc-codex-windows-hook', event });
  assert.equal((await invoke(socketPath, '{bad')).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal((await invoke(`${socketPath}-missing`, JSON.stringify(event))).hookSpecificOutput.permissionDecision, 'deny');
} finally { await new Promise(resolve => server.close(resolve)); }
console.log('test-codex-shared-hook: relay preserves events and denies unavailable checks');
