#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  describeSignalForensics,
  detectOwnSystemdUnit,
  isStoppingSubState,
  sanitizeSystemctlEnv,
  startSelfStopDetector,
} from '../lib/self-stop-detector.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

assert.equal(isStoppingSubState('running'), false);
assert.equal(isStoppingSubState(''), false);
assert.equal(isStoppingSubState(undefined), false);
assert.equal(isStoppingSubState('stop-sigterm'), true);
assert.equal(isStoppingSubState(' stop-sigkill '), true);
assert.equal(isStoppingSubState('deactivating'), true);
assert.equal(isStoppingSubState('final-sigkill'), true);

assert.equal(
  detectOwnSystemdUnit('12:pids:/foo\n0::/system.slice/ragent.service\n'),
  'ragent.service',
);
assert.equal(detectOwnSystemdUnit('0::/user.slice/user-1000.slice/session-3.scope\n'), '');
assert.equal(detectOwnSystemdUnit('0::/ragent-runners.slice/ragent-runner-run_x.service\n'), '');
assert.equal(detectOwnSystemdUnit(''), '');
assert.equal(detectOwnSystemdUnit('0::/system.slice/not-a-unit.slice\n'), '');

assert.match(
  describeSignalForensics(
    'SigPnd:\t0000000000004000\nSigIgn:\t0000000001001000\nSigCgt:\t0000000100004602\n',
    7,
  ),
  /pid=7 SigPnd=0000000000004000 SigIgn=0000000001001000 SigCgt=0000000100004602/,
);
assert.match(describeSignalForensics('', 3), /pid=3 SigPnd=\?/);

// The systemctl probe must not carry the unit's notify channel: inherited
// NOTIFY_SOCKET makes every systemctl child emit an EXIT_STATUS datagram to
// the notify socket on exit (a forgery channel under NotifyAccess=all, and
// pure journal spam under NotifyAccess=main).
{
  const clean = sanitizeSystemctlEnv({
    NOTIFY_SOCKET: '/run/systemd/notify',
    RAGENT_NOTIFY_FD: '100',
    WATCHDOG_PID: '123',
    WATCHDOG_USEC: '45000000',
    PATH: '/usr/bin',
    KEEP_ME: 'yes',
  });
  assert.equal(clean.NOTIFY_SOCKET, undefined);
  assert.equal(clean.RAGENT_NOTIFY_FD, undefined);
  assert.equal(clean.WATCHDOG_PID, undefined);
  assert.equal(clean.WATCHDOG_USEC, undefined);
  assert.equal(clean.PATH, '/usr/bin');
  assert.equal(clean.KEEP_ME, 'yes');
}
// The production probe wires the sanitizer into the execFile options.
assert.match(
  readFileSync(new URL('../lib/self-stop-detector.mjs', import.meta.url), 'utf8'),
  /env: sanitizeSystemctlEnv\(process\.env\)/,
);

// Env kill switch.
const off = startSelfStopDetector({
  env: { RAGENT_SELF_STOP_DETECTOR: 'off' },
  showFn: async () => 'stop-sigterm',
  startDelayMs: 0,
  intervalMs: 5,
});
assert.equal(off.active, false);
off.stop();

// Fires after two consecutive stopping samples, exactly once.
const script = ['running', 'stop-sigterm', 'stop-sigterm', 'stop-sigterm'];
let call = 0;
let seen = [];
const detector = startSelfStopDetector({
  unit: 'ragent.service',
  startDelayMs: 0,
  intervalMs: 5,
  consecutiveHits: 2,
  showFn: async () => script[Math.min(call++, script.length - 1)],
  onDetected: (info) => seen.push(info),
});
assert.equal(detector.active, true);
await sleep(90);
detector.stop();
assert.equal(seen.length, 1);
assert.equal(seen[0].unit, 'ragent.service');
assert.equal(seen[0].subState, 'stop-sigterm');

// A failing systemctl probe must never fire the detector.
let failures = 0;
const failing = startSelfStopDetector({
  unit: 'ragent.service',
  startDelayMs: 0,
  intervalMs: 5,
  consecutiveHits: 1,
  showFn: async () => {
    failures += 1;
    throw new Error('boom');
  },
  onDetected: () => seen.push('bad'),
});
await sleep(50);
failing.stop();
assert.ok(failures > 0);
assert.ok(!seen.includes('bad'));

// A running sample between stopping samples resets the hit counter.
const script2 = ['stop-sigterm', 'running', 'stop-sigterm', 'stop-sigterm'];
call = 0;
seen = [];
const resetting = startSelfStopDetector({
  unit: 'ragent.service',
  startDelayMs: 0,
  intervalMs: 5,
  consecutiveHits: 2,
  showFn: async () => script2[Math.min(call++, script2.length - 1)],
  onDetected: (info) => seen.push(info),
});
await sleep(90);
resetting.stop();
assert.equal(seen.length, 1);
assert.equal(seen[0].subState, 'stop-sigterm');

// Without a resolvable own unit (dev runs, runner units, non-Linux), the
// detector deactivates instead of probing systemctl forever.
const unresolvable = startSelfStopDetector({
  startDelayMs: 0,
  intervalMs: 5,
  showFn: async () => 'stop-sigterm',
  onDetected: () => seen.push('bad2'),
});
await sleep(30);
assert.equal(unresolvable.active, false);
unresolvable.stop();
assert.ok(!seen.includes('bad2'));

const chatServer = readFileSync(new URL('../chat-server.mjs', import.meta.url), 'utf8');
assert.match(chatServer, /import\('\.\/lib\/self-stop-detector\.mjs'\)/);
assert.match(chatServer, /\{ startSelfStopDetector \},/);
assert.match(chatServer, /startSelfStopDetector\(\{\s*onDetected:/);
assert.match(chatServer, /shutdown\(`systemd-stop:\$\{subState\}`\)/);
assert.match(chatServer, /if \(selfStopDetector\) selfStopDetector\.stop\(\);/);

console.log('test-self-stop-detector: ok');
