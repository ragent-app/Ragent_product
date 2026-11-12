#!/usr/bin/env node

// Run-scoped stdio endpoint for the machine-local Codex app-server broker.
// It intentionally forwards JSONL frames without interpreting provider data;
// runner-sidecar remains the sole owner of Run lifecycle and approvals.

import { connect } from 'node:net';
import { createInterface } from 'node:readline';

function readSocketPath() {
  const index = process.argv.indexOf('--socket');
  return index >= 0 ? String(process.argv[index + 1] || '').trim() : '';
}

const socketPath = readSocketPath();
const accountIndex = process.argv.indexOf('--account-digest');
const expectedAccountDigest = accountIndex >= 0 ? String(process.argv[accountIndex + 1] || '') : '';
const policyIndex = process.argv.indexOf('--policy-digest');
const expectedPolicyDigest = policyIndex >= 0 ? String(process.argv[policyIndex + 1] || '') : '';
if (!socketPath) {
  console.error('Codex app-server proxy socket is required');
  process.exit(1);
}
if (accountIndex >= 0 && !/^[a-f0-9]{64}$/.test(expectedAccountDigest)) {
  console.error('Codex app-server proxy account binding is invalid');
  process.exit(1);
}
if (policyIndex >= 0 && !/^[a-f0-9]{64}$/.test(expectedPolicyDigest)) {
  console.error('Codex app-server proxy policy binding is invalid');
  process.exit(1);
}

const socket = connect(socketPath);
let buffer = '';
let connected = false;
let verified = !expectedAccountDigest && !expectedPolicyDigest;
let inputClosed = false;
let handshakeTimer;
// Do not forward even an initialize request until this same connection has
// confirmed the broker's in-memory account. Pausing preserves early stdin.
process.stdin.pause();

function failHandshake() {
  clearTimeout(handshakeTimer);
  console.error('Codex app-server broker account verification failed');
  process.exitCode = 1;
  socket.destroy();
  process.stdin.destroy();
}

socket.on('connect', () => {
  connected = true;
  if (!expectedAccountDigest && !expectedPolicyDigest) {
    process.stdin.resume();
    return;
  }
  handshakeTimer = setTimeout(failHandshake, 10_000);
  socket.write(`${JSON.stringify({ type: 'agentoc-codex-broker-ping', expectedAccountDigest })}\n`);
});
socket.on('error', (error) => {
  clearTimeout(handshakeTimer);
  if (!connected) console.error(`Codex app-server broker connection failed: ${error?.message || error}`);
  process.exitCode = 1;
});
socket.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!verified) {
      let reply;
      try { reply = JSON.parse(line); } catch { failHandshake(); return; }
      if (reply?.type !== 'agentoc-codex-broker-pong' || reply.ready !== true
          || (expectedAccountDigest && reply.accountMatches !== true)
          || (expectedPolicyDigest && reply.policyDigest !== expectedPolicyDigest)) {
        failHandshake();
        return;
      }
      clearTimeout(handshakeTimer);
      verified = true;
      if (inputClosed) socket.end();
      else process.stdin.resume();
      continue;
    }
    if (line) process.stdout.write(`${line}\n`);
  }
});
socket.on('end', () => {
  clearTimeout(handshakeTimer);
  if (!verified) {
    console.error('Codex app-server broker account verification failed');
    process.exitCode = 1;
  }
  process.exit(process.exitCode || 0);
});

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  if (!socket.destroyed && socket.writable) socket.write(`${line}\n`);
});
input.on('close', () => {
  // The sidecar normally terminates this process after turn completion. If it
  // closes stdin first, end only this client connection; the broker survives.
  inputClosed = true;
  if (verified && !socket.destroyed) socket.end();
});
// readline resumes its input when constructed, so pause it again until the
// connection has been verified (or connected for an unbound proxy).
process.stdin.pause();

