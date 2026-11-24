#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

import {
  p2pHostCount,
  registerP2PHost,
  restoreP2PHostsForDevices,
  retiringHostCount,
  startP2PHostForDevice,
  stopAllP2PHosts,
  stopP2PHost,
} from '../lib/p2p-host-registry.mjs';
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

const tempDir = mkdtempSync(join(tmpdir(), 'ragent-ondemand-host-test-'));
const resources = [];

try {
  // Compile a tiny pure-stdlib Go sidecar stub that supports offer/candidate echoing
  // and simulates datachannel_open / datachannel_close via stdin commands.
  const stubGo = join(tempDir, 'stub_ondemand.go');
  const stubExe = join(tempDir, process.platform === 'win32' ? 'stub-ondemand.exe' : 'stub-ondemand');
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
		switch msg["type"] {
		case "offer":
			fmt.Println(\`{"type":"answer","sdp":"stub-answer"}\`)
		case "open_dc":
			fmt.Println(\`{"type":"datachannel_open","label":"ragent-http","activeChannels":1}\`)
		case "close_dc":
			fmt.Println(\`{"type":"datachannel_close","label":"ragent-http","activeChannels":0}\`)
		}
		out, _ := json.Marshal(map[string]any{"type": "stdin_echo", "received": msg})
		fmt.Println(string(out))
	}
}
`,
    'utf8',
  );
  execFileSync('go', ['build', '-o', stubExe, stubGo], { stdio: 'inherit' });

  const signaling = createP2PSignalingServer({ host: '127.0.0.1', port: 0 });
  const sigAddr = await signaling.listen();
  resources.push(() => signaling.close());
  const signalingUrl = `http://127.0.0.1:${sigAddr.port}`;

  await stopAllP2PHosts();

  // 1. On-demand restore keeps lightweight /signal watcher with ZERO Go child spawn and ZERO bootstrap calls
  const deviceId = 'ondemand-dev-1';
  const secret = 'ondemand-host-secret-1';
  const roomId = createP2PRoomId(secret);
  let bootstrapCalls = 0;
  let nextExpiryMs = Date.now() + 120_000;

  const restored = await restoreP2PHostsForDevices(
    [{ id: deviceId, status: 'bound', enrollmentKind: 'account-join', accountId: 'acct-1', revokedAt: '' }],
    {
      onDemand: true,
      idleTimeoutMs: 120,
      binaryPath: stubExe,
      signalingUrl,
      getP2PAccess: async () => ({ roomId, secret }),
      getBootstrap: async () => {
        bootstrapCalls += 1;
        return {
          turn: {
            connectionId: `turn_conn_${bootstrapCalls}`,
            iceServers: [{ urls: 'turn:relay.example.test:3478?transport=udp', username: 'u', password: 'p' }],
            expiresAt: new Date(nextExpiryMs).toISOString(),
          },
        };
      },
    },
  );

  assert.equal(restored.attempted, 1);
  assert.equal(restored.started, 1);
  assert.equal(p2pHostCount(), 1, 'lightweight watcher is registered');
  assert.equal(bootstrapCalls, 0, 'on-demand restore must NOT reserve TURN credentials eagerly');
  const agent = restored.results[0].agent;
  await agent.joined;
  assert.equal(agent.hasActiveChild(), false, 'on-demand restore must NOT spawn Go child until offer arrives');
  assert.equal(agent.child, null);

  // 2. Mobile sends offer + immediate trickled candidate on /signal -> lazy spawn + buffered delivery + TURN reservation
  const mobileSignals = [];
  const connectMobile = async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${sigAddr.port}/signal`);
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString('utf8'));
      if (msg.type === 'signal') mobileSignals.push(msg.envelope?.payload);
    });
    ws.send(JSON.stringify({ type: 'join', roomId, role: 'mobile' }));
    await delay(40);
    return ws;
  };

  const mobile = await connectMobile();
  resources.push(async () => { try { mobile.close(); } catch {} });

  let seq = 1;
  mobile.send(JSON.stringify({
    type: 'signal',
    roomId,
    envelope: signP2PSignal({ roomId, secret, seq: seq++, payload: { type: 'offer', sdp: 'offer-1' } }),
  }));
  mobile.send(JSON.stringify({
    type: 'signal',
    roomId,
    envelope: signP2PSignal({ roomId, secret, seq: seq++, payload: { type: 'candidate', candidate: 'cand-1' } }),
  }));

  await until(() => agent.hasActiveChild(), 4_000, 'Go child lazy-spawned on offer');
  assert.equal(bootstrapCalls, 1, 'first offer reserves TURN credentials lazily');
  await until(
    () => mobileSignals.some((p) => p?.type === 'answer')
      && mobileSignals.some((p) => p?.type === 'stdin_echo' && p.received?.type === 'candidate' && p.received?.candidate === 'cand-1'),
    4_000,
    'buffered offer and candidate delivered in order to spawned child',
  );
  const echoOrder = mobileSignals.filter((p) => p?.type === 'stdin_echo').map((p) => p.received?.type);
  assert.deepEqual(echoOrder.slice(0, 2), ['offer', 'candidate']);

  // 3. Open DataChannel prevents idle teardown; closing DataChannel triggers idle teardown while watcher stays alive
  mobile.send(JSON.stringify({
    type: 'signal',
    roomId,
    envelope: signP2PSignal({ roomId, secret, seq: seq++, payload: { type: 'open_dc' } }),
  }));
  await until(() => mobileSignals.some((p) => p?.type === 'datachannel_open'), 2_000, 'datachannel_open observed');
  await delay(200); // > idleTimeoutMs (120ms)
  assert.equal(agent.hasActiveChild(), true, 'open DataChannel must keep Go child alive past idleTimeoutMs');

  mobile.send(JSON.stringify({
    type: 'signal',
    roomId,
    envelope: signP2PSignal({ roomId, secret, seq: seq++, payload: { type: 'close_dc' } }),
  }));
  await until(() => !agent.hasActiveChild(), 3_000, 'idle teardown stops Go child after DataChannel closes');
  assert.equal(agent.child, null);
  assert.equal(p2pHostCount(), 1, 'lightweight /signal watcher must remain registered after idle teardown');

  // 4. Second offer while TURN credentials are still fresh reuses cached credentials (no extra bootstrap call)
  mobileSignals.length = 0;
  mobile.send(JSON.stringify({
    type: 'signal',
    roomId,
    envelope: signP2PSignal({ roomId, secret, seq: seq++, payload: { type: 'offer', sdp: 'offer-2' } }),
  }));
  await until(() => agent.hasActiveChild(), 4_000, 'Go child respawns on second offer');
  assert.equal(bootstrapCalls, 1, 'fresh cached TURN credentials should be reused without re-reserving');
  await until(() => mobileSignals.some((p) => p?.type === 'answer'), 3_000, 'second offer gets answer');

  // Force idle teardown again, then test expired-credential re-reservation on next offer
  await until(() => !agent.hasActiveChild(), 3_000, 'idle teardown when no DataChannel opened');
  // Simulate cached credentials approaching/past expiry by letting a short-lived bootstrap expire
  stopP2PHost(deviceId);
  await agent.done;

  let expiringBootstrapCalls = 0;
  let currentBootExpiry = () => Date.now() + 1_200;
  const expiringDevice = 'ondemand-expiring-1';
  const expiringSecret = 'ondemand-expiring-secret';
  const expiringRoom = createP2PRoomId(expiringSecret);
  const restoredExpiring = await restoreP2PHostsForDevices(
    [{ id: expiringDevice, status: 'bound', enrollmentKind: 'account-join', accountId: 'acct-1', revokedAt: '' }],
    {
      onDemand: true,
      idleTimeoutMs: 80,
      binaryPath: stubExe,
      signalingUrl,
      getP2PAccess: async () => ({ roomId: expiringRoom, secret: expiringSecret }),
      getBootstrap: async () => {
        expiringBootstrapCalls += 1;
        return {
          turn: {
            connectionId: `turn_exp_${expiringBootstrapCalls}`,
            iceServers: [{ urls: 'turn:relay.example.test:3478?transport=udp', username: 'u', password: 'p' }],
            expiresAt: new Date(currentBootExpiry()).toISOString(),
          },
        };
      },
    },
  );
  assert.equal(restoredExpiring.started, 1);
  const expAgent = restoredExpiring.results[0].agent;
  await expAgent.joined;
  const expMobile = new WebSocket(`ws://127.0.0.1:${sigAddr.port}/signal`);
  await new Promise((resolve, reject) => { expMobile.once('open', resolve); expMobile.once('error', reject); });
  resources.push(async () => { try { expMobile.close(); } catch {} });
  expMobile.send(JSON.stringify({ type: 'join', roomId: expiringRoom, role: 'mobile' }));
  await delay(40);
  expMobile.send(JSON.stringify({
    type: 'signal',
    roomId: expiringRoom,
    envelope: signP2PSignal({ roomId: expiringRoom, secret: expiringSecret, seq: 1, payload: { type: 'offer', sdp: 'exp-1' } }),
  }));
  await until(() => expAgent.hasActiveChild(), 3_000, 'expiring agent first wake');
  assert.equal(expiringBootstrapCalls, 1);
  // Wait for idle teardown AND credential expiry
  await until(() => !expAgent.hasActiveChild(), 3_000, 'expiring agent idle teardown');
  await delay(1_300);
  currentBootExpiry = () => Date.now() + 120_000;
  expMobile.send(JSON.stringify({
    type: 'signal',
    roomId: expiringRoom,
    envelope: signP2PSignal({ roomId: expiringRoom, secret: expiringSecret, seq: 2, payload: { type: 'offer', sdp: 'exp-2' } }),
  }));
  await until(() => expAgent.hasActiveChild(), 3_000, 'expiring agent second wake after expiry');
  assert.equal(expiringBootstrapCalls, 2, 'expired cached TURN credentials must re-reserve before spawning Go child');
  stopP2PHost(expiringDevice);
  await expAgent.done;

  // Test rendezvous wake of an idle watcher
  const wakeDevice = 'ondemand-wake-1';
  const wakeSecret = 'ondemand-wake-secret';
  const wakeRoom = createP2PRoomId(wakeSecret);
  const restoredWake = await restoreP2PHostsForDevices(
    [{ id: wakeDevice, status: 'bound', enrollmentKind: 'account-join', accountId: 'acct-1', revokedAt: '' }],
    {
      onDemand: true,
      idleTimeoutMs: 5_000,
      binaryPath: stubExe,
      signalingUrl,
      getP2PAccess: async () => ({ roomId: wakeRoom, secret: wakeSecret }),
      getBootstrap: async () => ({
        turn: {
          connectionId: 'turn_wake_1',
          iceServers: [{ urls: 'turn:relay.example.test:3478?transport=udp', username: 'u', password: 'p' }],
          expiresAt: new Date(Date.now() + 120_000).toISOString(),
        },
      }),
    },
  );
  const wakeAgent = restoredWake.results[0].agent;
  await wakeAgent.joined;
  assert.equal(wakeAgent.hasActiveChild(), false);
  const rendezvousResult = await startP2PHostForDevice(wakeDevice, {
    p2pAccess: { roomId: wakeRoom, secret: wakeSecret },
    signalingUrl,
    onDemand: true,
    spawnOnInit: true,
    iceServers: [{ urls: 'turn:rendezvous.example.test:3478?transport=udp', username: 'u2', password: 'p2' }],
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
  });
  assert.equal(rendezvousResult.reused, true);
  assert.equal(wakeAgent.hasActiveChild(), true, 'rendezvous start wakes an idle watcher immediately');

  stopP2PHost(wakeDevice);
  await wakeAgent.done;
  assert.equal(p2pHostCount(), 0);

  // 5. Fast retiring cleanup: retiringHosts prunes old host as soon as its DataChannel closes (instead of waiting for oldExpiry)
  const retireSecret = 'retire-cleanup-secret';
  const retireRoom = createP2PRoomId(retireSecret);
  const oldHost = await runP2PHostAgent({
    signalingUrl,
    roomId: retireRoom,
    secret: retireSecret,
    binaryPath: stubExe,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  });
  resources.push(async () => { oldHost.stop(); await oldHost.done; });
  await oldHost.ready;
  await oldHost.joined;

  const retireSignals = [];
  const retireMobile = new WebSocket(`ws://127.0.0.1:${sigAddr.port}/signal`);
  await new Promise((resolve, reject) => {
    retireMobile.once('open', resolve);
    retireMobile.once('error', reject);
  });
  resources.push(async () => { try { retireMobile.close(); } catch {} });
  retireMobile.on('message', (raw) => {
    const msg = JSON.parse(raw.toString('utf8'));
    if (msg.type === 'signal') retireSignals.push(msg.envelope?.payload);
  });
  retireMobile.send(JSON.stringify({ type: 'join', roomId: retireRoom, role: 'mobile' }));
  await delay(40);
  retireMobile.send(JSON.stringify({
    type: 'signal',
    roomId: retireRoom,
    envelope: signP2PSignal({ roomId: retireRoom, secret: retireSecret, seq: 1, payload: { type: 'open_dc' } }),
  }));
  await until(() => retireSignals.some((p) => p?.type === 'datachannel_open'), 2_000, 'old host datachannel_open');

  let standbyDoneResolve;
  const standbyHost = {
    ready: Promise.resolve(),
    done: new Promise((resolve) => { standbyDoneResolve = resolve; }),
    stop() { standbyDoneResolve({ code: 0, signal: null }); },
  };
  registerP2PHost('retire-device', oldHost);
  registerP2PHost('retire-device', standbyHost, { preservePreviousUntil: Date.now() + 600_000 });
  assert.equal(retiringHostCount('retire-device'), 1, 'old host enters retiringHosts');
  assert.equal(oldHost.hasActiveChild(), true, 'old host stays alive while DataChannel is open');

  // Old host closes its DataChannel -> retiringHosts must prune immediately and stop oldHost
  retireMobile.send(JSON.stringify({
    type: 'signal',
    roomId: retireRoom,
    envelope: signP2PSignal({ roomId: retireRoom, secret: retireSecret, seq: 2, payload: { type: 'close_dc' } }),
  }));
  await until(() => retiringHostCount('retire-device') === 0, 3_000, 'retiringHosts pruned on datachannel_close');
  await oldHost.done;
  assert.equal(oldHost.hasActiveChild(), false, 'old host stopped immediately on DataChannel close');

  await stopAllP2PHosts();
  console.log('test-p2p-ondemand-host: lazy watcher, offer/candidate buffering, credential reuse, idle teardown, rendezvous wake, and fast retiring cleanup passed');
} finally {
  await stopAllP2PHosts();
  for (const cleanup of resources.reverse()) {
    try { await cleanup(); } catch {}
  }
  rmSync(tempDir, { recursive: true, force: true });
}
