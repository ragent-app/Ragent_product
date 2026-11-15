#!/usr/bin/env node
import assert from 'node:assert/strict';
import { closeSync, openSync, readFileSync } from 'node:fs';
import {
  buildNotifyMessage,
  buildSystemdNotifyArgs,
  isSystemdNotifyAvailable,
  resolveNotifyFd,
  resolveWatchdogIntervalMs,
  sendNotifyViaFd,
  systemdNotify,
  startSystemdWatchdog,
} from '../lib/systemd-notify.mjs';

function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

assert.equal(isSystemdNotifyAvailable({}), false);
assert.equal(isSystemdNotifyAvailable({ NOTIFY_SOCKET: '/run/systemd/notify' }), true);
assert.equal(resolveWatchdogIntervalMs({ WATCHDOG_USEC: '45000000' }), 22_500);
assert.deepEqual(buildSystemdNotifyArgs({ ready: true, status: 'ready', watchdog: true }), [
  '--ready',
  '--status=ready',
  'WATCHDOG=1',
]);

assert.equal(
  buildNotifyMessage({ ready: true, status: 'ready', watchdog: true }),
  'READY=1\nWATCHDOG=1\nSTATUS=ready\n',
);
assert.equal(buildNotifyMessage({ status: 'two\nlines' }), 'STATUS=two lines\n');
assert.equal(buildNotifyMessage({}), '');

assert.equal(resolveNotifyFd({}), null);
assert.equal(resolveNotifyFd({ RAGENT_NOTIFY_FD: 'not-a-number' }), null);
assert.equal(resolveNotifyFd({ RAGENT_NOTIFY_FD: '2' }), null);
assert.equal(resolveNotifyFd({ RAGENT_NOTIFY_FD: '7' }), 7);

// fd plumbing: a writable /dev/null descriptor round-trips through the direct
// path; dgram semantics are covered end-to-end by test-systemd-notify-direct.
{
  const fd = openSync('/dev/null', 'w');
  try {
    const sent = sendNotifyViaFd(fd, 'WATCHDOG=1\n');
    assert.equal(sent.skipped, false);
    assert.equal(sent.via, 'fd');
    assert.equal(sent.error, undefined);
  } finally {
    closeSync(fd);
  }
}

const skipped = await systemdNotify({ watchdog: true }, { env: {} });
assert.equal(skipped.skipped, true);

// A broken notify descriptor must be reported, never swallowed: a silent
// write failure starves the watchdog and systemd SIGABRTs the unit ~45s later
// with no other symptom. First failure logs; repeats stay inside the throttle.
{
  const fd = openSync('/dev/null', 'w');
  closeSync(fd); // deliberately stale: writes must fail with EBADF
  const logged = [];
  const originalConsoleError = console.error;
  console.error = (...parts) => logged.push(parts.join(' '));
  try {
    const brokenEnv = () => ({
      NOTIFY_SOCKET: '/run/systemd/notify',
      RAGENT_NOTIFY_FD: String(fd),
    });
    const broken = await systemdNotify({ watchdog: true }, { env: brokenEnv() });
    assert.ok(broken.error);
    assert.match(logged.join('\n'), /notify fd write failed/);
    await systemdNotify({ watchdog: true }, { env: brokenEnv() });
    assert.equal(logged.length, 1); // throttled within the window
  } finally {
    console.error = originalConsoleError;
  }
}

// env without the wrapper fd must keep using the CLI child fallback
const cliFallback = await systemdNotify(
  { watchdog: true },
  { env: { NOTIFY_SOCKET: '/run/systemd/notify' }, command: '/bin/true' },
);
assert.equal(cliFallback.skipped, false);

const inactive = startSystemdWatchdog({ env: {} });
assert.equal(inactive.active, false);
inactive.stop();

const chatServer = read('chat-server.mjs');
const unit = read('packaging/deb/ragent.service');
assert.match(chatServer, /import\('\.\/lib\/systemd-notify\.mjs'\)/);
assert.match(chatServer, /systemdNotify\.systemdNotify\(\{ ready: true/);
assert.match(chatServer, /startSystemdWatchdog/);
assert.match(unit, /^WatchdogSec=45s$/m);
// NotifyAccess=main is the point of the notify-exec wrapper: only the main
// pid may speak for the unit, so cgroup children cannot forge STOPPING=1.
assert.match(unit, /^NotifyAccess=main$/m);
assert.match(unit, /^ExecStart=\/usr\/lib\/ragent\/notify-exec \/opt\/ragent\/runtime\/node \/opt\/ragent\/app\/chat-server\.mjs$/m);
assert.match(unit, /^Restart=always$/m);

console.log('test-systemd-notify-watchdog: ok');
