#!/usr/bin/env node
import { connect } from 'node:net';

const denied = code => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
  permissionDecisionReason: `The Ragent Windows operation check is unavailable. Retry after the session reconnects. (${code})` } });
const brokerCodes = new Set(['HOOK_OWNER_UNAVAILABLE', 'HOOK_CLAIM_UNMATCHED', 'HOOK_OWNER_TIMEOUT', 'HOOK_OWNER_DISCONNECTED', 'HOOK_EVALUATION_FAILED']);
async function main() {
  const index = process.argv.indexOf('--socket');
  const socketPath = index < 0 ? '' : process.argv[index + 1];
  if (!socketPath || /[\r\n\0]/.test(socketPath)) return denied('HOOK_SOCKET_CONFIG');
  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (Buffer.byteLength(raw, 'utf8') > 256 * 1024) return denied('HOOK_INPUT_TOO_LARGE');
  }
  let event;
  try { event = JSON.parse(raw); } catch { return denied('HOOK_INPUT_INVALID'); }
  return await new Promise(resolve => {
    const socket = connect(socketPath);
    let buffer = '', finished = false;
    const finish = value => { if (finished) return; finished = true; clearTimeout(timer); socket.destroy(); resolve(value); };
    const timer = setTimeout(() => finish(denied('HOOK_TIMEOUT')), 58_000);
    socket.on('connect', () => socket.write(`${JSON.stringify({ type: 'agentoc-codex-windows-hook', event })}\n`));
    socket.on('error', () => finish(denied('HOOK_SOCKET_ERROR')));
    socket.on('end', () => finish(denied('HOOK_PEER_CLOSED')));
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      if (Buffer.byteLength(buffer, 'utf8') > 256 * 1024) { finish(denied('HOOK_RESPONSE_INVALID')); return; }
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try {
        const message = JSON.parse(buffer.slice(0, newline));
        finish(message.result && typeof message.result === 'object' && !Array.isArray(message.result) ? message.result : denied(brokerCodes.has(message.code) ? message.code : 'HOOK_RESPONSE_INVALID'));
      } catch { finish(denied('HOOK_RESPONSE_INVALID')); }
    });
  });
}
main().then(result => process.stdout.write(JSON.stringify(result)), () => process.stdout.write(JSON.stringify(denied('HOOK_INTERNAL_ERROR'))));
