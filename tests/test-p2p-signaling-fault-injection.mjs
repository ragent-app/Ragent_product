#!/usr/bin/env node
// P6 deterministic fault-injection for the P2P signaling path.
//
// Inserts a controllable WebSocket fault proxy between the host agent's
// signaling connection and the signaling server, and verifies the host agent's
// resilience to:
//   - signaling connection reset (mid-session teardown) -> host auto-reconnects, room recovers
//   - signaling unavailable (upgrade refused / server down) -> host retries with backoff, recovers after restore
//   - signaling latency (delayed relay) -> handshake still completes (delayed, not dropped)
//   - host sidecar survives all faults -> subsequent requests still work
// The proxy is deterministic (no Toxiproxy dependency). A real WebRTC offer
// is used so the full offer/answer path (host agent -> Pion sidecar -> answer)
// is exercised, matching test-p2p-host-reconnect-seq-reset.mjs.
import assert from 'assert/strict';
import http from 'http';
import { arch } from 'process';
import { WebSocket, WebSocketServer } from 'ws';

import { runP2PHostAgent } from '../lib/p2p-host-agent.mjs';
import { resolveP2PHostBinary } from '../lib/p2p-host-binary.mjs';
import { createP2PRoomId, signP2PSignal } from '../lib/p2p-signal-protocol.mjs';
import { createP2PSignaling } from '../p2p/signaling-server.mjs';

if (!['arm64', 'x64'].includes(arch)) {
  console.log(`P2P signaling fault-injection test skipped on ${arch}; no supported sidecar`);
  process.exit(0);
}

const binaryPath = process.env.RAGENT_TEST_P2P_HOST_BINARY || resolveP2PHostBinary();
const secret = 'rpi_signal_fault_injection';
const roomId = createP2PRoomId(secret);

const OFFER = [
  'v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 't=0 0',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0',
  'a=ice-ufrag:p', 'a=ice-pwd:pppppppppppppppppppp',
  'a=fingerprint:sha-256 00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00',
  'a=setup:actpass', 'a=mid:0', 'a=sctp-port:5000', 'a=max-message-size:262144', '',
].join('\r\n');

const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address()));
});
const close = (server) => new Promise((resolve) => server.close(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, description, timeoutMs = 15000) {
  const started = Date.now();
  let lastValue = undefined;
  while (Date.now() - started < timeoutMs) {
    lastValue = await predicate();
    if (lastValue) return lastValue;
    await sleep(100);
  }
  throw new Error(`Timed out: ${description} (last=${String(lastValue)})`);
}

/**
 * A deterministic WebSocket fault proxy in front of the signaling server.
 *   - state.mode = 'refuse' -> respond 502 on upgrade (signaling unavailable)
 *   - state.delayMs > 0     -> delay server->client messages by this many ms
 *   - resetConnections()    -> destroy all proxied sockets immediately (one-shot reset)
 * `clients.size` is the number of currently proxied host connections (observable
 * signal for "the host agent is (re)connected").
 */
function createWsFaultProxy(targetPort) {
  const state = { mode: 'forward', delayMs: 0 };
  const clients = new Set();
  const upstreams = new Map(); // clientWs -> upstreamWs
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    if (state.mode === 'refuse') {
      socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (clientWs) => {
      clients.add(clientWs);
      const upstream = new WebSocket(`ws://127.0.0.1:${targetPort}${req.url || '/signal'}`);
      upstreams.set(clientWs, upstream);
      let upstreamReady = false;
      const pending = [];
      const flush = () => {
        if (!upstreamReady) return;
        for (const data of pending.splice(0)) {
          if (upstream.readyState === WebSocket.OPEN) upstream.send(data);
        }
      };
      upstream.on('open', () => { upstreamReady = true; flush(); });
      // client -> upstream (no delay: join/offer must arrive promptly so a
      // delayed relay cannot drop the offer while the peer is absent).
      clientWs.on('message', (data) => {
        if (upstreamReady && upstream.readyState === WebSocket.OPEN) upstream.send(data);
        else pending.push(data);
      });
      // upstream -> client (delay applied here: delayed relay must still deliver).
      upstream.on('message', (data) => {
        const send = () => { if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data); };
        if (state.delayMs > 0) setTimeout(send, state.delayMs);
        else send();
      });
      const cleanup = () => {
        if (!clients.has(clientWs)) return;
        clients.delete(clientWs);
        upstreams.delete(clientWs);
        try { upstream.close(); } catch {}
      };
      clientWs.on('close', cleanup);
      clientWs.on('error', () => {});
      upstream.on('close', () => { try { clientWs.close(); } catch {} });
      upstream.on('error', () => { try { clientWs.close(); } catch {} });
    });
  });

  function resetConnections() {
    for (const clientWs of [...clients]) {
      // terminate() tears the TCP socket down immediately (RST), which is the
      // "connection reset" the host agent must survive and reconnect from.
      try { clientWs.terminate(); } catch {}
      try { upstreams.get(clientWs)?.terminate(); } catch {}
      clients.delete(clientWs);
      upstreams.delete(clientWs);
    }
  }

  return {
    state,
    clients,
    resetConnections,
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(server.address().port); });
    }),
    close: () => new Promise((resolve) => {
      resetConnections();
      wss.close();
      server.close(() => resolve());
    }),
  };
}

// A single mobile WebRTC session: join -> send a signed offer -> wait for the
// host's answer (or timeout / ws error). The offer uses seq=1, so after the host
// resets its incoming seq on reconnect (joinId change) the offer is accepted.
function mobileHandshake(signalingAddress, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    let seq = 1;
    const ws = new WebSocket(`ws://127.0.0.1:${signalingAddress.port}/signal`);
    const timer = setTimeout(() => { try { ws.close(); } catch {} resolve('TIMEOUT'); }, timeoutMs);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'join', roomId, role: 'mobile' })));
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.type === 'joined') {
        ws.send(JSON.stringify({ type: 'signal', roomId, envelope: signP2PSignal({ roomId, secret, seq: seq++, payload: { type: 'offer', sdp: OFFER } }) }));
      }
      if (m.type === 'signal' && m.envelope?.payload?.type === 'answer') {
        clearTimeout(timer);
        try { ws.close(); } catch {}
        resolve('ANSWER');
      }
    });
    ws.on('close', () => clearTimeout(timer));
    ws.on('error', () => { clearTimeout(timer); resolve('WS_ERROR'); });
  });
}

const resources = [];
let passed = 0;
let failed = 0;
function check(label, cond, extra = '') {
  if (cond) { passed += 1; console.log(`  PASS: ${label}${extra ? ` :: ${extra}` : ''}`); }
  else { failed += 1; console.log(`  FAIL: ${label}${extra ? ` :: ${extra}` : ''}`); }
}

try {
  const signaling = createP2PSignaling();
  const signalingHttp = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  signalingHttp.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    if (url.pathname === '/signal') { signaling.handleUpgrade(req, socket, head); return; }
    socket.destroy();
  });
  resources.push(async () => { signaling.close(); await close(signalingHttp); });
  const signalingAddress = await listen(signalingHttp);

  const proxy = createWsFaultProxy(signalingAddress.port);
  const proxyPort = await proxy.listen();
  resources.push(async () => proxy.close());

  const host = await runP2PHostAgent({
    signalingUrl: `http://127.0.0.1:${proxyPort}`,
    roomId,
    secret,
    binaryPath,
    localBaseUrl: `http://127.0.0.1:${signalingAddress.port}`,
  });
  resources.push(async () => { host.stop(); await host.done; });
  await host.ready;

  // 0. Baseline: full offer/answer through the fault proxy (forward mode).
  check('baseline handshake', (await mobileHandshake(signalingAddress)) === 'ANSWER');

  // 1. Signaling connection reset mid-session -> host auto-reconnects, room recovers.
  proxy.resetConnections();
  await waitFor(() => proxy.clients.size === 0, 'host ws torn down after reset');
  await waitFor(() => proxy.clients.size === 1, 'host ws reconnected after reset');
  check('recovery after connection reset', (await mobileHandshake(signalingAddress)) === 'ANSWER');

  // 2. Signaling unavailable (refuse + teardown) -> host retries; after restore, room recovers.
  proxy.state.mode = 'refuse';
  proxy.resetConnections();
  await waitFor(() => proxy.clients.size === 0, 'host ws down during signaling outage');
  const duringOutage = await mobileHandshake(signalingAddress, { timeoutMs: 2500 });
  check('handshake fails during signaling outage', duringOutage === 'TIMEOUT', duringOutage);
  proxy.state.mode = 'forward';
  await waitFor(() => proxy.clients.size === 1, 'host ws reconnected after signaling restore', 20000);
  check('recovery after signaling outage', (await mobileHandshake(signalingAddress)) === 'ANSWER');

  // 3. Signaling latency (delayed relay) -> handshake completes but is delayed.
  proxy.state.delayMs = 1500;
  const slowStart = Date.now();
  const slowHandshake = await mobileHandshake(signalingAddress, { timeoutMs: 12000 });
  const slowElapsed = Date.now() - slowStart;
  proxy.state.delayMs = 0;
  check('handshake completes under signaling latency', slowHandshake === 'ANSWER', slowHandshake);
  check('signaling latency actually delayed delivery', slowElapsed >= 1200, `${slowElapsed}ms`);

  // 4. Host sidecar survives all faults; final handshake still works.
  check('host sidecar alive after all faults', host.child.exitCode === null, `exitCode=${host.child.exitCode}`);
  check('final handshake after fault sequence', (await mobileHandshake(signalingAddress)) === 'ANSWER');
} finally {
  for (const cleanup of resources.reverse()) {
    try { await cleanup(); } catch {}
  }
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
