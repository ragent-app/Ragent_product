import assert from 'assert/strict';
import http from 'http';
import { PassThrough } from 'stream';

import WebSocket from 'ws';

import { createP2PSignaling } from '../p2p/signaling-server.mjs';
import { createP2PRoomId, signP2PSignal, verifyP2PSignal } from '../lib/p2p-signal-protocol.mjs';
import { runP2PSignalCommand } from '../lib/p2p-signal-command.mjs';
import { runP2PHostCommand } from '../lib/p2p-host-command.mjs';

const secret = 'rpi_test_room_secret';
const roomId = createP2PRoomId(secret);
assert.match(roomId, /^[a-f0-9]{40}$/);
const envelope = signP2PSignal({ roomId, secret, seq: 1, payload: { type: 'offer', sdp: 'test' } });
assert.equal(verifyP2PSignal(envelope, { roomId, secret }), true);
assert.equal(verifyP2PSignal({ ...envelope, payload: { type: 'offer', sdp: 'tampered' } }, { roomId, secret }), false);

const signalOutput = new PassThrough();
let signalHelp = '';
signalOutput.on('data', (chunk) => { signalHelp += chunk; });
assert.equal(await runP2PSignalCommand(['--help'], { stdout: signalOutput }), 0);
assert.match(signalHelp, /metadata-only WebRTC signaling/);

const hostOutput = new PassThrough();
let hostHelp = '';
hostOutput.on('data', (chunk) => { hostHelp += chunk; });
assert.equal(await runP2PHostCommand(['--help'], { stdout: hostOutput }), 0);
assert.match(hostHelp, /RAGENT_P2P_ROOM_SECRET/);

// 回归：对手方尚未加入（或已离开）时向房间转发 signal 不得抛异常/崩溃。
// 曾因 `target?.readyState === target.OPEN` 对 undefined 求值 target.OPEN 抛
// TypeError，把内嵌信令的整个 chat-server 打崩（线上 2026-08-05 实测崩两次）。
{
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  const signaling = createP2PSignaling();
  server.on('upgrade', (req, socket, head) => signaling.handleUpgrade(req, socket, head));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const signalingUrl = `ws://127.0.0.1:${server.address().port}/signal`;
  try {
    const host = new WebSocket(signalingUrl);
    await new Promise((resolve) => host.once('open', resolve));
    host.send(JSON.stringify({ type: 'join', roomId, role: 'host' }));
    await new Promise((resolve) => host.once('message', resolve)); // joined
    // mobile 尚未加入：中继目标 undefined，旧实现在此崩溃整个进程。
    host.send(JSON.stringify({ type: 'signal', roomId, envelope }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(host.readyState, WebSocket.OPEN, 'server must survive signal to absent peer');
    // 后续 join 仍可用，且正常中继可达。
    const mobile = new WebSocket(signalingUrl);
    await new Promise((resolve) => mobile.once('open', resolve));
    mobile.send(JSON.stringify({ type: 'join', roomId, role: 'mobile' }));
    const joined = JSON.parse((await new Promise((resolve) => mobile.once('message', resolve))).toString());
    assert.equal(joined.type, 'joined');
    mobile.send(JSON.stringify({ type: 'signal', roomId, envelope }));
    const relayed = JSON.parse((await new Promise((resolve) => host.once('message', resolve))).toString());
    assert.equal(relayed.type, 'signal');
    assert.equal(relayed.from, 'mobile');
    host.close();
    mobile.close();
  } finally {
    signaling.close();
    await new Promise((resolve) => server.close(resolve));
  }
  console.log('P2P signaling relay regression passed');
}

console.log('P2P signaling protocol and CLI tests passed');
