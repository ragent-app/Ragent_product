#!/usr/bin/env node
// End-to-end proof for the notify-exec + NotifyAccess=main hardening, run
// against this machine's user systemd (2026-08-31 silent-stop root cause).
//
// 1. A Type=notify test unit starts the real lib through the real wrapper.
//    READY must be accepted from the main pid or the unit never activates.
// 2. A rogue child sends STOPPING=1 from inside the cgroup. With
//    NotifyAccess=main systemd must reject it: the unit keeps running past
//    the point where the 08-31 incident flipped ragent.service into
//    stop-sigterm (proven equivalent signature: no signal is ever delivered,
//    then "State 'stop-sigterm' timed out. Killing.").
// 3. WatchdogSec keepalives must keep flowing from the main pid or systemd
//    would kill the unit; surviving past the watchdog window proves them.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
// Service/CI shells often lack the user-session env; systemctl --user needs it.
process.env.XDG_RUNTIME_DIR ||= `/run/user/${process.getuid()}`;
const NODE = process.execPath;
const REPO = new URL('..', import.meta.url).pathname;
const WRAPPER = join(REPO, 'packaging/deb/notify-exec');
const LIB = join(REPO, 'lib/systemd-notify.mjs');
// /tmp is not visible inside user-manager units on some hosts (private tmp),
// so the scratch app must live somewhere the unit can execute from.
const dir = mkdtempSync(join(REPO, '.tmp-notify-direct-'));

function sh(cmd, args) {
  return execFileAsync(cmd, args, { encoding: 'utf8' }).then(
    (r) => r.stdout,
    (e) => {
      e.stdout = e.stdout || '';
      throw e;
    },
  );
}

async function userSystemdAvailable() {
  try {
    await execFileAsync('systemctl', ['--user', 'is-system-running'], { encoding: 'utf8' });
    return true;
  } catch (error) {
    // "degraded" exits non-zero but the manager works
    return String(error.stdout).trim() === 'degraded';
  }
}

const unit = `ragent-notify-direct-test-${process.pid}`;
const appPath = join(dir, 'notify-app.mjs');
const watchdogSec = 8;
const probeSeconds = 13; // > WatchdogSec, so surviving proves keepalives

// Minimal notify client: the real lib, driven by the real wrapper's env.
// The watchdog interval must stay referenced or the process exits immediately.
writeFileSync(
  appPath,
  `import { execFile } from 'node:child_process';
import { systemdNotify } from ${JSON.stringify(LIB)};
const log = (m) => console.log(m);
await systemdNotify({ ready: true, status: 'notify-direct test ready' });
log('READY-SENT');
setInterval(() => void systemdNotify({ watchdog: true, status: 'alive' }), 1000);
setTimeout(() => {
  // rogue cgroup member: exactly the incident vector
  execFile('/usr/bin/systemd-notify', ['STOPPING=1'], (err) => log('ROGUE-STOPPING-SENT err=' + (err ? err.message : 'none')));
}, 1500);
`,
);

try {
  if (!(await userSystemdAvailable())) {
    console.log('test-systemd-notify-direct: skipped (no user systemd manager)');
    process.exit(0);
  }

  await sh('systemd-run', [
    '--user',
    `--unit=${unit}`,
    '-p',
    'Type=notify',
    '-p',
    'NotifyAccess=main',
    '-p',
    `WatchdogSec=${watchdogSec}s`,
    '-p',
    'TimeoutStartSec=15s',
    '-p',
    'TimeoutStopSec=10s',
    '/usr/bin/python3',
    WRAPPER,
    NODE,
    appPath,
  ]);

  const state = async () => {
    const { stdout } = await execFileAsync(
      'systemctl',
      ['--user', 'show', unit, '-p', 'ActiveState', '-p', 'SubState', '--value'],
      { encoding: 'utf8' },
    );
    return stdout.trim().split('\n');
  };

  // READY accepted from the main pid (Type=notify would hang in "start"/"activating" otherwise)
  await new Promise((r) => setTimeout(r, 2000));
  let [active, sub] = await state();
  assert.equal(active, 'active', `unit did not activate via wrapper READY (state=${active}/${sub})`);
  assert.equal(sub, 'running');

  // rogue STOPPING=1 already fired at t+1.5s; the incident signature would put
  // the unit in deactivating/stop-sigterm within ~2s. It must stay running.
  await new Promise((r) => setTimeout(r, 3000));
  [active, sub] = await state();
  assert.equal(active, 'active', `forged STOPPING=1 deactivated the unit (state=${active}/${sub})`);
  assert.equal(sub, 'running');

  // survive the full watchdog window: keepalives from the main pid accepted
  await new Promise((r) => setTimeout(r, (probeSeconds - 5) * 1000));
  [active, sub] = await state();
  assert.equal(active, 'active', `watchdog killed the unit — keepalives not accepted (state=${active}/${sub})`);
  assert.equal(sub, 'running');

  console.log('test-systemd-notify-direct: ok');
} finally {
  try {
    await execFileAsync('systemctl', ['--user', 'stop', unit], { encoding: 'utf8' });
  } catch {}
  try {
    await execFileAsync('systemctl', ['--user', 'reset-failed', unit], { encoding: 'utf8' });
  } catch {}
  rmSync(dir, { recursive: true, force: true });
}
