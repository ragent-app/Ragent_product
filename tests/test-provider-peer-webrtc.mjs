// Native transport integration. Supply the freshly built sidecar through
// RAGENT_PROVIDER_SYNC_TEST_BINARY. No remote service or public URL is used.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';

const binary = process.env.RAGENT_PROVIDER_SYNC_TEST_BINARY;
if (!binary) throw new Error('RAGENT_PROVIDER_SYNC_TEST_BINARY is required');
const children = [];
let resolveFinished, rejectFinished, openCount = 0;
const finished = new Promise((resolve, reject) => { resolveFinished = resolve; rejectFinished = reject; });
const payload = randomBytes(60_000);
const peers = {};
try {
  for (const role of ['host', 'mobile']) {
    const child = spawn(binary, [], { env: { ...process.env, RAGENT_P2P_PROVIDER_SYNC: '1', RAGENT_P2P_PROVIDER_ROLE: role,
      AGENTOC_P2P_ICE_SERVERS_JSON: JSON.stringify([{ urls: ['stun:127.0.0.1:9'] }]) }, stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(child); peers[role] = child;
    child.stderr.resume();
    child.on('error', rejectFinished);
    child.on('exit', code => { if (code !== null && code !== 0) rejectFinished(new Error(`${role} sidecar exited ${code}`)); });
  }
  for (const role of ['host', 'mobile']) {
    const opposite = role === 'host' ? 'mobile' : 'host';
    createInterface({ input: peers[role].stdout }).on('line', line => {
      try {
        const message = JSON.parse(line);
        if (['offer', 'answer', 'candidate'].includes(message.type)) peers[opposite].stdin.write(`${line}\n`);
        else if (message.type === 'open') {
          if (++openCount === 2) peers.mobile.stdin.write(`${JSON.stringify({ type: 'data', data: payload.toString('base64') })}\n`);
        } else if (message.type === 'data' && role === 'host') {
          assert.deepEqual(Buffer.from(message.data, 'base64'), payload);
          resolveFinished();
        }
      } catch (error) { rejectFinished(error); }
    });
  }
  const timeout = setTimeout(() => rejectFinished(new Error('WebRTC provider transport timed out')), 30_000);
  try { await finished; } finally { clearTimeout(timeout); }
  console.log('provider peer WebRTC data channel: ok');
} finally {
  for (const child of children) { child.stdin.end(); child.kill(); }
}
