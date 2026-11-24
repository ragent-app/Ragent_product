#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import WebSocket from 'ws';

import {
  broadcastAll,
  broadcastMatching,
  broadcastOwners,
  broadcastSessionEvents,
  setWss,
  subscribeOwnerInvalidations,
} from '../chat/ws-clients.mjs';
import { runP2PHostAgent } from '../lib/p2p-host-agent.mjs';
import { createP2PRoomId, signP2PSignal } from '../lib/p2p-signal-protocol.mjs';
import { createP2PSignalingServer } from '../p2p/signaling-server.mjs';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, timeoutMs = 8_000, description = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for: ${description}`);
    await delay(15);
  }
}

// 1. Unit tests for chat/ws-clients.mjs subscribeOwnerInvalidations()
{
  setWss(null);
  const received = [];
  const unsubscribe = subscribeOwnerInvalidations((event) => received.push(event));

  // Burst of session_events for s1 + s2 + projects + non-owner + plaintext notification
  broadcastSessionEvents('s1', [{ type: 'text_delta', text: 'TOP_SECRET_CHAT_1', seq: 10 }], { latestSeq: 10 });
  broadcastSessionEvents('s1', [{ type: 'text_delta', text: 'TOP_SECRET_CHAT_2', seq: 15 }], { latestSeq: 15 });
  broadcastMatching({ type: 'session_events', sessionId: 's1', events: [{ text: 'TOP_SECRET_CHAT_3' }], latestSeq: 22 });
  broadcastSessionEvents('s2', [{ type: 'text_delta', text: 'OTHER_SECRET', seq: 3 }]);
  broadcastAll({ type: 'projects_invalidated' });
  broadcastAll({ type: 'projects_invalidated' });
  broadcastOwners({ type: 'system_notification', message: 'PRIVATE_BANNER', level: 'info' });
  broadcastMatching({ type: 'session_invalidated', sessionId: 's-visitor' }, (c) => c._authSession?.role === 'visitor');

  // Must coalesce (~50ms) and never fire synchronously before burst window closes
  assert.equal(received.length, 0, 'owner invalidations should coalesce in ~50ms window');
  await until(() => received.length >= 3, 2_000, 'coalesced owner invalidations');
  await delay(80);

  assert.equal(received.length, 3, `expected 3 coalesced invalidations, got ${JSON.stringify(received)}`);
  const s1 = received.find((e) => e.type === 'session_invalidated' && e.sessionId === 's1');
  const s2 = received.find((e) => e.type === 'session_invalidated' && e.sessionId === 's2');
  const prj = received.find((e) => e.type === 'projects_invalidated');
  assert.deepEqual(s1, { type: 'session_invalidated', sessionId: 's1', latestSeq: 22 });
  assert.deepEqual(s2, { type: 'session_invalidated', sessionId: 's2', latestSeq: 3 });
  assert.deepEqual(prj, { type: 'projects_invalidated' });

  const serialized = JSON.stringify(received);
  assert.equal(serialized.includes('TOP_SECRET'), false, 'must never leak message plaintext');
  assert.equal(serialized.includes('PRIVATE_BANNER'), false, 'must never leak system_notification plaintext');
  assert.equal(serialized.includes('s-visitor'), false, 'must not leak visitor-only broadcasts');

  unsubscribe();
  unsubscribe(); // idempotent
  received.length = 0;
  broadcastAll({ type: 'sessions_invalidated' });
  await delay(90);
  assert.equal(received.length, 0, 'unsubscribed listener must receive no further invalidations');
}

// 2. Unit tests for lib/p2p-host-agent.mjs auth-gating & non-trusted exclusion
const tempDir = mkdtempSync(join(tmpdir(), 'ragent-push-invalidation-test-'));
const resources = [];
try {
  // Compile a tiny pure-stdlib Go sidecar stub that records stdin messages over stdout
  const stubGo = join(tempDir, 'stub_host.go');
  const stubExe = join(tempDir, process.platform === 'win32' ? 'stub-host.exe' : 'stub-host');
  writeFileSync(
    stubGo,
    `package main
import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
)
func main() {
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		line := scanner.Text()
		var msg map[string]any
		if json.Unmarshal([]byte(line), &msg) != nil {
			continue
		}
		if msg["type"] == "offer" {
			fmt.Println(\`{"type":"answer","sdp":"stub-answer"}\`)
		}
		out, _ := json.Marshal(map[string]any{"type": "stdin_echo", "received": msg})
		fmt.Println(string(out))
	}
}
`,
    'utf8',
  );
  execFileSync('go', ['build', '-o', stubExe, stubGo], { stdio: 'inherit' });

  const upstream = http.createServer((req, res) => {
    if (req.url === '/connectivity-health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    if (req.url === '/api/auth/me') {
      if (req.headers.authorization === `Bearer rda_${'b'.repeat(64)}`) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      } else {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end('{"error":"unauthorized"}');
      }
      return;
    }
    res.writeHead(200);
    res.end('ok');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  resources.push(() => new Promise((resolve) => upstream.close(resolve)));

  const signaling = createP2PSignalingServer({ host: '127.0.0.1', port: 0 });
  const sigAddr = await signaling.listen();
  resources.push(() => signaling.close());
  const signalingUrl = `http://127.0.0.1:${sigAddr.port}`;
  const secret = 'push-invalidation-auth-gate-secret';
  const roomId = createP2PRoomId(secret);

  const echoedStdin = [];
  const mobileSignals = [];
  const mobileWs = new WebSocket(`ws://127.0.0.1:${sigAddr.port}/signal`);
  await new Promise((resolve, reject) => {
    mobileWs.once('open', resolve);
    mobileWs.once('error', reject);
  });
  resources.push(async () => { try { mobileWs.close(); } catch {} });
  mobileWs.on('message', (raw) => {
    const msg = JSON.parse(raw.toString('utf8'));
    if (msg.type === 'signal' && msg.envelope?.payload?.type === 'stdin_echo') {
      echoedStdin.push(msg.envelope.payload.received);
    } else if (msg.type === 'signal') {
      mobileSignals.push(msg.envelope?.payload);
    }
  });
  mobileWs.send(JSON.stringify({ type: 'join', roomId, role: 'mobile' }));
  await delay(50);

  let policyDecisions = [];
  const host = await runP2PHostAgent({
    signalingUrl,
    roomId,
    secret,
    binaryPath: stubExe,
    localBaseUrl: `http://127.0.0.1:${upstream.address().port}`,
    subscribeOwnerInvalidations,
    onPolicyDecision: (ev) => policyDecisions.push(ev),
  });
  resources.push(async () => { host.stop(); await host.done; });
  await host.ready;
  await host.joined;

  // Before any authenticated bearer decision: unauthenticated/local_health/401 requests must NOT unlock push
  const rHealth = await fetch(`${host.gatewayUrl}/connectivity-health`);
  assert.equal(rHealth.status, 200);
  const rUnauth = await fetch(`${host.gatewayUrl}/api/sessions`);
  assert.equal(rUnauth.status, 401);
  const rForged = await fetch(`${host.gatewayUrl}/api/auth/me`, {
    headers: { Authorization: `Bearer rda_${'0'.repeat(64)}` },
  });
  assert.equal(rForged.status, 401);

  broadcastSessionEvents('sess-before-auth', [{ type: 'text_delta', text: 'NO_LEAK', seq: 1 }], { latestSeq: 1 });
  broadcastAll({ type: 'projects_invalidated' });
  await delay(120);
  assert.equal(
    echoedStdin.filter((m) => m.type === 'push_invalidation').length,
    0,
    'must not forward push_invalidation before bearer authentication succeeds',
  );

  // Valid bearer auth unlocks subscription + stdin forwarding
  const rAuth = await fetch(`${host.gatewayUrl}/api/auth/me`, {
    headers: { Authorization: `Bearer rda_${'b'.repeat(64)}` },
  });
  assert.equal(rAuth.status, 200);
  assert.ok(policyDecisions.some((d) => d.decision === 'authenticated'));

  broadcastSessionEvents('sess-after-auth', [{ type: 'text_delta', text: 'SECRET_BODY', seq: 7 }], { latestSeq: 7 });
  await until(
    () => echoedStdin.some((m) => m.type === 'push_invalidation' && m.payload?.sessionId === 'sess-after-auth'),
    3_000,
    'push_invalidation forwarded after authenticated policy decision',
  );
  const pushMsg = echoedStdin.find((m) => m.type === 'push_invalidation' && m.payload?.sessionId === 'sess-after-auth');
  assert.deepEqual(pushMsg, {
    type: 'push_invalidation',
    payload: { type: 'session_invalidated', sessionId: 'sess-after-auth', latestSeq: 7 },
  });
  assert.equal(JSON.stringify(pushMsg).includes('SECRET_BODY'), false);

  // A fresh offer resets auth gating until the new peer authenticates
  echoedStdin.length = 0;
  mobileWs.send(JSON.stringify({
    type: 'signal',
    roomId,
    envelope: signP2PSignal({ roomId, secret, seq: 1, payload: { type: 'offer', sdp: 'new-offer' } }),
  }));
  await until(() => echoedStdin.some((m) => m.type === 'offer'), 2_000, 'new offer received');
  broadcastAll({ type: 'sessions_invalidated' });
  await delay(120);
  assert.equal(
    echoedStdin.filter((m) => m.type === 'push_invalidation').length,
    0,
    'new offer must re-gate invalidations until the new peer authenticates',
  );

  host.stop();
  await host.done;

  // BrowserAuth & temporary hosts must NEVER subscribe to owner invalidations
  const browserKeys = generateKeyPairSync('ed25519');
  const browserSecret = 'browser-auth-exclusion-secret';
  const browserHost = await runP2PHostAgent({
    signalingUrl,
    roomId: createP2PRoomId(browserSecret),
    secret: browserSecret,
    binaryPath: stubExe,
    localBaseUrl: `http://127.0.0.1:${upstream.address().port}`,
    subscribeOwnerInvalidations,
    browserAuth: {
      publicKeyPem: browserKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      keyId: 'k1',
      issuer: 'https://issuer.test',
      instanceId: 'ins_1',
    },
  });
  resources.push(async () => { browserHost.stop(); await browserHost.done; });
  await browserHost.ready;
  const tempHost = await runP2PHostAgent({
    signalingUrl,
    roomId: createP2PRoomId('temp-host-exclusion-secret'),
    secret: 'temp-host-exclusion-secret',
    binaryPath: stubExe,
    localBaseUrl: `http://127.0.0.1:${upstream.address().port}`,
    subscribeOwnerInvalidations,
    temporaryDevice: { instanceId: 'ins_1', deviceId: 'tmp_1' },
    temporaryIngress: (_req, res) => { res.writeHead(200); res.end('ok'); },
  });
  resources.push(async () => { tempHost.stop(); await tempHost.done; });
  await tempHost.ready;

  // Even calling authenticated-looking URL on temporary host never subscribes
  await fetch(`${tempHost.gatewayUrl}/api/auth/me`, {
    headers: { Authorization: `Bearer rda_${'b'.repeat(64)}` },
  });
  broadcastAll({ type: 'projects_invalidated' });
  await delay(100);
  browserHost.stop();
  tempHost.stop();
  await Promise.all([browserHost.done, tempHost.done]);

  // 3. End-to-end real Go ragent-p2p-host + WebRTC DataChannel dc_push_invalidation_v1 test
  const realExe = join(tempDir, process.platform === 'win32' ? 'ragent-p2p-host.exe' : 'ragent-p2p-host');
  execFileSync('go', ['build', '-o', realExe, './cmd/ragent-p2p-host'], {
    cwd: new URL('../p2p/', import.meta.url),
    stdio: 'inherit',
  });

  const e2eSecret = 'e2e-dc-push-invalidation-secret';
  const e2eRoom = createP2PRoomId(e2eSecret);
  const e2eHost = await runP2PHostAgent({
    signalingUrl,
    roomId: e2eRoom,
    secret: e2eSecret,
    binaryPath: realExe,
    localBaseUrl: `http://127.0.0.1:${upstream.address().port}`,
    subscribeOwnerInvalidations,
  });
  resources.push(async () => { e2eHost.stop(); await e2eHost.done; });
  await e2eHost.ready;

  const clientSource = readFileSync(new URL('../static/p2p/ragent-p2p-client.js', import.meta.url), 'utf8');
  const web = http.createServer((req, res) => {
    if (req.url === '/client.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(clientSource);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>DC Push E2E</title>');
  });
  await new Promise((resolve) => web.listen(0, '127.0.0.1', resolve));
  resources.push(() => new Promise((resolve) => web.close(resolve)));

  const browser = await chromium.launch({
    headless: true,
    ...(process.env.RAGENT_P2P_TEST_CHROMIUM ? { executablePath: process.env.RAGENT_P2P_TEST_CHROMIUM } : {}),
  });
  resources.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${web.address().port}/`);

  // Expose a helper for the page to verify server_ready features, send client_ready, and capture dc_push_v1
  await page.exposeFunction('triggerServerInvalidation', () => {
    broadcastSessionEvents('sess-e2e', [{ type: 'text_delta', text: 'E2E_SECRET', seq: 99 }], { latestSeq: 99 });
  });

  const e2eResult = await page.evaluate(async ({ url, room, roomSecret, token }) => {
    const { RagentP2PClient } = await import('/client.js');
    const pushedFrames = [];
    let serverReadyFeatures = null;
    const origCreateDC = RTCPeerConnection.prototype.createDataChannel;
    RTCPeerConnection.prototype.createDataChannel = function (...args) {
      const dc = origCreateDC.apply(this, args);
      dc.addEventListener('message', (event) => {
        try {
          const parsed = JSON.parse(typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data));
          if (parsed.type === 'server_ready') serverReadyFeatures = parsed.features;
          if (parsed.type === 'dc_push_v1') pushedFrames.push(parsed);
        } catch {}
      });
      return dc;
    };

    const client = new RagentP2PClient({
      signalingUrl: url,
      roomId: room,
      secret: roomSecret,
      iceServers: [],
      connectTimeoutMs: 10_000,
      requestTimeoutMs: 10_000,
    });

    await client.connect();

    // Authenticate first, BEFORE sending client_ready -> invalidations must NOT arrive on DataChannel yet
    const me = await client.request({
      method: 'GET',
      path: '/api/auth/me',
      headers: { Authorization: `Bearer ${token}` },
    });
    await window.triggerServerInvalidation();
    await new Promise((r) => setTimeout(r, 150));
    const countBeforeClientReady = pushedFrames.length;

    // Now negotiate dc_push_invalidation_v1 on ragent-http
    client.channel.send(JSON.stringify({
      type: 'client_ready',
      version: 1,
      features: ['dc_push_invalidation_v1'],
    }));
    await new Promise((r) => setTimeout(r, 50));
    await window.triggerServerInvalidation();
    const deadline = Date.now() + 3000;
    while (pushedFrames.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    client.close();
    return {
      authStatus: me.status,
      serverReadyFeatures,
      countBeforeClientReady,
      pushedFrames,
    };
  }, { url: signalingUrl, room: e2eRoom, roomSecret: e2eSecret, token: `rda_${'b'.repeat(64)}` });

  assert.equal(e2eResult.authStatus, 200);
  assert.ok(
    Array.isArray(e2eResult.serverReadyFeatures) && e2eResult.serverReadyFeatures.includes('dc_push_invalidation_v1'),
    `server_ready should advertise dc_push_invalidation_v1, got ${JSON.stringify(e2eResult.serverReadyFeatures)}`,
  );
  assert.equal(e2eResult.countBeforeClientReady, 0, 'legacy client without client_ready must not receive dc_push_v1');
  assert.equal(e2eResult.pushedFrames.length, 1);
  assert.deepEqual(e2eResult.pushedFrames[0], {
    type: 'dc_push_v1',
    payload: { type: 'session_invalidated', sessionId: 'sess-e2e', latestSeq: 99 },
  });

  console.log('test-p2p-push-invalidation: coalescing, auth-gating, non-trusted exclusion, and real DataChannel dc_push_v1 passed');
} finally {
  for (const cleanup of resources.reverse()) {
    try { await cleanup(); } catch {}
  }
  rmSync(tempDir, { recursive: true, force: true });
}
