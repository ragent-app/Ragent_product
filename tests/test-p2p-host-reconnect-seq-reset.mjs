#!/usr/bin/env node
// 回归测试：host agent 在同一邀请内重连后，必须接受 mobile 从低序号重发的
// offer。修复前 incomingSeq 在 agent 生命周期内单调递增，mobile 断线重连后
// 重发的 offer（seq <= 已消费值）被永久丢弃，mobile 只能干等到邀请过期。
// 本测试用两层独立 mobile WS 连接模拟 App 断线重连，验证第二次连接从
// seq=1 重发 offer 仍能收到 answer。
import assert from 'assert/strict';
import http from 'http';
import { arch } from 'process';

import WebSocket from 'ws';

import { runP2PHostAgent } from '../lib/p2p-host-agent.mjs';
import { resolveP2PHostBinary } from '../lib/p2p-host-binary.mjs';
import { createP2PRoomId, signP2PSignal } from '../lib/p2p-signal-protocol.mjs';
import { createP2PSignaling } from '../p2p/signaling-server.mjs';

if (!['arm64', 'x64'].includes(arch)) {
  console.log(`P2P host reconnect-seq test skipped on ${arch}; no supported sidecar`);
  process.exit(0);
}

const binaryPath = process.env.RAGENT_TEST_P2P_BINARY || resolveP2PHostBinary();
const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address()));
});
const close = (server) => new Promise((resolve) => server.close(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const OFFER = [
  'v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 't=0 0',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0',
  'a=ice-ufrag:p', 'a=ice-pwd:pppppppppppppppppppp',
  'a=fingerprint:sha-256 00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00',
  'a=setup:actpass', 'a=mid:0', 'a=sctp-port:5000', 'a=max-message-size:262144', '',
].join('\r\n');

const resources = [];
try {
  // 本地 signaling（模拟 chat-server 内嵌 /signal）。
  const chatLike = http.createServer((request, response) => { response.writeHead(404); response.end(); });
  const p2pSignaling = createP2PSignaling();
  chatLike.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/signal') { p2pSignaling.handleUpgrade(req, socket, head); return; }
    socket.destroy();
  });
  resources.push(async () => { p2pSignaling.close(); await close(chatLike); });
  const chatAddress = await listen(chatLike);
  const signalingUrl = `http://127.0.0.1:${chatAddress.port}`;

  const secret = 'rpi_reconnect_seq_test';
  const roomId = createP2PRoomId(secret);
  const host = await runP2PHostAgent({
    signalingUrl,
    roomId,
    secret,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    binaryPath,
    localBaseUrl: `http://127.0.0.1:${chatAddress.port}`,
  });
  resources.push(async () => { host.stop(); await host.done; });
  await host.ready;

  // 单次 mobile 会话：join → 发 offer（从 startSeq 起计）→ 等 answer 或超时。
  async function mobileAttempt(startSeq, timeoutMs = 8000) {
    return new Promise((resolve) => {
      let seq = startSeq;
      const sign = (payload) => signP2PSignal({ roomId, secret, seq: seq++, payload });
      const ws = new WebSocket(`ws://127.0.0.1:${chatAddress.port}/signal`);
      const timer = setTimeout(() => { try { ws.close(); } catch {} resolve('TIMEOUT'); }, timeoutMs);
      ws.on('open', () => ws.send(JSON.stringify({ type: 'join', roomId, role: 'mobile' })));
      ws.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === 'joined') ws.send(JSON.stringify({ type: 'signal', roomId, envelope: sign({ type: 'offer', sdp: OFFER }) }));
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

  // 连接1：首次握手（消费 host 的 incomingSeq=1）。
  const first = await mobileAttempt(1);
  assert.equal(first, 'ANSWER', `first attempt should get answer, got ${first}`);
  await sleep(500);

  // 连接2：模拟 App 断线重连，从 seq=1 重新开始发 offer。
  const retry = await mobileAttempt(1);
  assert.equal(retry, 'ANSWER', `retry after reconnect must get answer (host seq reset), got ${retry}`);

  console.log('P2P host reconnect-seq-reset test passed (retry offer accepted after reconnect)');
} finally {
  for (const cleanup of resources.reverse()) {
    try { await cleanup(); } catch {}
  }
}
