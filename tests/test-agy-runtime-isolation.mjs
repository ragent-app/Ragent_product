#!/usr/bin/env node

import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
  buildAgyRuntimeEnv,
  buildAgyRuntimeLaunchSpec,
  prepareAgyRunHome,
  AGY_AUTH_RELATIVE_PATH,
  AGY_RUNTIME_LAUNCHER_PATH,
} = await import('../lib/agy-runtime.mjs');

const root = await mkdtemp(join(tmpdir(), 'ragent-agy-runtime-test-'));
const home = join(root, 'agy-home');
const output = join(root, 'observed.json');
const command = join(root, 'fake-agy');
await writeFile(command, `#!/bin/sh
printf 'home=%s\nmanaged=%s\ndbus=%s\nkeyring=%s\n' "$HOME" "$RAGENT_AGY_HOME_DIR" "${'${DBUS_SESSION_BUS_ADDRESS:-}'}" "${'${GNOME_KEYRING_CONTROL:-}'}" > "$AGY_RUNTIME_TEST_OUTPUT"
`, 'utf8');
await chmod(command, 0o755);

const hostBus = process.env.DBUS_SESSION_BUS_ADDRESS || 'unix:path=/host-session-bus';
const env = await buildAgyRuntimeEnv({
  ...process.env,
  HOME: '/host-home',
  DBUS_SESSION_BUS_ADDRESS: hostBus,
  GNOME_KEYRING_CONTROL: '/host-keyring',
  AGY_RUNTIME_TEST_OUTPUT: output,
}, { homeDir: home });
assert.equal(env.HOME, home);
assert.equal(env.RAGENT_AGY_HOME_DIR, home);
assert.equal(env.XDG_CONFIG_HOME, join(home, '.config'));
assert.equal(env.GNOME_KEYRING_CONTROL, undefined);

const windowsHome = join(root, 'windows-home');
const windowsEnv = await buildAgyRuntimeEnv({ HOME: '/host-home' }, {
  homeDir: windowsHome,
  platform: 'win32',
});
assert.equal(windowsEnv.USERPROFILE, windowsHome);
assert.equal(windowsEnv.APPDATA, join(windowsHome, 'AppData', 'Roaming'));
assert.equal(windowsEnv.LOCALAPPDATA, join(windowsHome, 'AppData', 'Local'));

const controlHome = join(root, 'control-home');
const runHomeA = join(root, 'run-a');
const runHomeB = join(root, 'run-b');
await mkdir(join(controlHome, '.gemini', 'antigravity-cli'), { recursive: true });
await writeFile(join(controlHome, AGY_AUTH_RELATIVE_PATH), 'new-account-token\n', 'utf8');
const preparedA = await prepareAgyRunHome({ homeDir: runHomeA, sourceHome: controlHome, runnerReadable: true });
const preparedB = await prepareAgyRunHome({ homeDir: runHomeB, sourceHome: controlHome, runnerReadable: true });
assert.equal(preparedA.ok, true);
assert.equal(preparedB.ok, true);
assert.notEqual(preparedA.homeDir, preparedB.homeDir);
assert.equal((await readFile(preparedA.authFile, 'utf8')).trim(), 'new-account-token');
assert.equal((await readFile(preparedB.authFile, 'utf8')).trim(), 'new-account-token');

const spec = buildAgyRuntimeLaunchSpec({ command, env });
assert.equal(spec.file, process.execPath);
assert.equal(spec.args[0], AGY_RUNTIME_LAUNCHER_PATH);

const exitCode = await new Promise((resolve, reject) => {
  const child = spawn(spec.file, spec.args, {
    cwd: root,
    env: spec.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.once('error', reject);
  child.once('close', (code) => {
    if (code !== 0) reject(new Error(`launcher failed (${code}): ${stderr}`));
    else resolve(code);
  });
});
assert.equal(exitCode, 0);
const observed = Object.fromEntries(
  (await readFile(output, 'utf8')).trim().split('\n').map((line) => line.split('=')),
);
assert.equal(observed.home, home);
assert.equal(observed.managed, home);
assert.notEqual(observed.dbus, hostBus, 'AgY must not inherit the desktop session bus');
assert.notEqual(observed.keyring, '/host-keyring', 'AgY must not inherit the desktop keyring');

await rm(root, { recursive: true, force: true });
console.log('test-agy-runtime-isolation: managed HOME and private keyring boundary OK');
