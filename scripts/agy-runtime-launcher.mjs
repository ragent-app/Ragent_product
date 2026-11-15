#!/usr/bin/env node

// Spawn one AgY command inside an account-scoped runtime boundary.  On Linux
// the Secret Service client follows DBUS_SESSION_BUS_ADDRESS, so a private
// D-Bus session is required in addition to a private HOME.

import { mkdtemp, mkdir, chmod, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawn } from 'child_process';

import {
  buildAgyRuntimeEnv,
  resolveAgyHome,
  resolveAgySupportCommand,
} from '../lib/agy-runtime.mjs';
import { buildPlatformSpawnSpec } from '../lib/executable-resolution.mjs';

const PRIVATE_BUS_ADDRESS = 'unix:path=/ragent-agy-private-bus';
const KEYRING_SCRIPT = String.raw`
set -u
control_dir="$RAGENT_AGY_KEYRING_CONTROL_DIR"
keyring_pid=""
cleanup() {
  if [ -n "$keyring_pid" ]; then
    kill "$keyring_pid" 2>/dev/null || true
    wait "$keyring_pid" 2>/dev/null || true
  fi
}
if [ -n "\${RAGENT_AGY_KEYRING_DAEMON:-}" ]; then
  mkdir -p "$control_dir"
  chmod 700 "$control_dir"
  "$RAGENT_AGY_KEYRING_DAEMON" --foreground --components=secrets --control-directory="$control_dir" >/dev/null 2>&1 &
  keyring_pid=$!
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    [ -S "$control_dir/control" ] && break
    sleep 0.05
  done
  export GNOME_KEYRING_CONTROL="$control_dir"
else
  unset GNOME_KEYRING_CONTROL GNOME_KEYRING_PID
fi
trap cleanup EXIT
"$@"
status=$?
exit "$status"
`;

function trim(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function exitCodeFromSignal(signal) {
  if (!signal) return 1;
  const signals = { SIGTERM: 143, SIGINT: 130, SIGHUP: 129 };
  return signals[signal] || 1;
}

function forwardSignal(child, signal) {
  try { child.kill(signal); } catch {}
}

function runDirect(command, args, env, cwd) {
  const spawnSpec = buildPlatformSpawnSpec(command, args, { cwd, env });
  return new Promise((resolve) => {
    const child = spawn(spawnSpec.file, spawnSpec.args, {
      env: spawnSpec.env,
      cwd: spawnSpec.cwd,
      stdio: 'inherit',
      shell: spawnSpec.shell,
      ...(spawnSpec.windowsVerbatimArguments === true
        ? { windowsVerbatimArguments: true }
        : {}),
    });
    const forward = (signal) => forwardSignal(child, signal);
    process.on('SIGTERM', forward);
    process.on('SIGINT', forward);
    process.on('SIGHUP', forward);
    child.once('error', () => resolve(1));
    child.once('close', (code, signal) => {
      process.off('SIGTERM', forward);
      process.off('SIGINT', forward);
      process.off('SIGHUP', forward);
      resolve(Number.isInteger(code) ? code : exitCodeFromSignal(signal));
    });
  });
}

async function main() {
  const rawArgs = process.argv.slice(2);
  if (rawArgs[0] === '--') rawArgs.shift();
  const command = trim(rawArgs.shift());
  if (!command) {
    console.error('agy-runtime-launcher: missing command');
    process.exitCode = 2;
    return;
  }

  const env = await buildAgyRuntimeEnv(process.env, {
    homeDir: resolveAgyHome({ environment: process.env }),
  });
  const cwd = process.cwd();
  if (process.platform !== 'linux' || env.RAGENT_AGY_PRIVATE_KEYRING !== '1') {
    process.exitCode = await runDirect(command, rawArgs, env, cwd);
    return;
  }

  const dbusRunSession = await resolveAgySupportCommand('dbus-run-session');
  if (!dbusRunSession) {
    // Do not inherit the desktop bus when the helper package is absent.  AgY
    // can still use its file token on minimal/headless Linux installations.
    const fallbackEnv = {
      ...env,
      DBUS_SESSION_BUS_ADDRESS: PRIVATE_BUS_ADDRESS,
    };
    delete fallbackEnv.GNOME_KEYRING_CONTROL;
    delete fallbackEnv.GNOME_KEYRING_PID;
    process.exitCode = await runDirect(command, rawArgs, fallbackEnv, cwd);
    return;
  }

  const daemon = await resolveAgySupportCommand('gnome-keyring-daemon');
  const keyringRoot = await mkdtemp(join(tmpdir(), 'ragent-agy-keyring-'));
  const controlDir = join(keyringRoot, 'control');
  await mkdir(controlDir, { recursive: true, mode: 0o700 });
  await chmod(controlDir, 0o700).catch(() => {});
  const sessionEnv = {
    ...env,
    RAGENT_AGY_KEYRING_CONTROL_DIR: controlDir,
    RAGENT_AGY_KEYRING_DAEMON: daemon || '',
  };
  const child = spawn(dbusRunSession, [
    '--',
    '/bin/sh',
    '-c',
    KEYRING_SCRIPT,
    'ragent-agy-runtime',
    command,
    ...rawArgs,
  ], { env: sessionEnv, cwd, stdio: 'inherit', shell: false });

  const forward = (signal) => forwardSignal(child, signal);
  process.on('SIGTERM', forward);
  process.on('SIGINT', forward);
  process.on('SIGHUP', forward);
  const result = await new Promise((resolve) => {
    child.once('error', () => resolve(1));
    child.once('close', (code, signal) => resolve(Number.isInteger(code) ? code : exitCodeFromSignal(signal)));
  });
  process.off('SIGTERM', forward);
  process.off('SIGINT', forward);
  process.off('SIGHUP', forward);
  await rm(keyringRoot, { recursive: true, force: true }).catch(() => {});
  process.exitCode = result;
}

await main();
