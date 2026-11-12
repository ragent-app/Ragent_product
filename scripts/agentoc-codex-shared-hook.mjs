#!/usr/bin/env node
import { connect } from 'node:net';

const denied = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
  permissionDecisionReason: 'The Ragent Windows operation check is unavailable. Retry after the session reconnects.' } };
async function main() {
  const index = process.argv.indexOf('--socket');
  const socketPath = index < 0 ? '' : process.argv[index + 1];
  if (!socketPath || /[\r\n\0]/.test(socketPath)) return denied;
  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (Buffer.byteLength(raw, 'utf8') > 256 * 1024) return denied;
  }
  let event;
  try { event = JSON.parse(raw); } catch { return denied; }
  return await new Promise(resolve => {
    const socket = connect(socketPath);
    let buffer = '', finished = false;
    const finish = value => { if (finished) return; finished = true; clearTimeout(timer); socket.destroy(); resolve(value); };
    const timer = setTimeout(() => finish(denied), 58_000);
    socket.on('connect', () => socket.write(`${JSON.stringify({ type: 'agentoc-codex-windows-hook', event })}\n`));
    socket.on('error', () => finish(denied));
    socket.on('end', () => finish(denied));
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      if (Buffer.byteLength(buffer, 'utf8') > 256 * 1024) { finish(denied); return; }
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try {
        const message = JSON.parse(buffer.slice(0, newline));
        finish(message.result && typeof message.result === 'object' && !Array.isArray(message.result) ? message.result : denied);
      } catch { finish(denied); }
    });
  });
}
main().then(result => process.stdout.write(JSON.stringify(result)), () => process.stdout.write(JSON.stringify(denied)));
