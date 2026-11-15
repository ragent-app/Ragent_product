#!/usr/bin/env node
// P0-A runner environment allowlist contract.
//
// buildDetachedRunnerEnvironment must inherit ONLY the shared allowlist keys
// from process.env and must strip production config/socket/credential keys even
// when the control-plane environment carries them.  The same policy must keep
// the injected shell snapshot clean of production paths.
import assert from 'assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
const fixture = mkdtempSync(join(tmpdir(), 'ragent-runner-env-'));
const fixtureHome = join(fixture, 'home');
const fixtureControl = join(fixture, 'control');
const fixtureConfig = join(fixtureControl, 'config');
const fixtureProviderHomes = join(fixtureControl, 'provider-homes');

import {
  RUNNER_ENV_ALLOWLIST,
  RUNNER_ENV_DENYLIST,
} from '../lib/runner-env.mjs';

const previousEnv = {};
const touchedKeys = [
  'PATH', 'LANG', 'LC_ALL', 'TERM', 'USER', 'HOME', 'DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR',
  'RAGENT_PROJECT_ROOT', 'RAGENT_HARNESS_ROOT', 'RAGENT_PACKAGED_HARNESS_ROOT', 'RAGENT_CHAT_BASE_URL', 'CHAT_PORT', 'IS_SANDBOX',
  'RAGENT_CONFIG_DIR', 'RAGENT_INSTANCE_ROOT', 'RAGENT_MEMORY_DIR',
  'RAGENT_WORK_ROOT_DIR', 'RAGENT_RUNNER_LIFECYCLE_SOCKET',
  'RAGENT_CONTROL_SOCKET', 'RAGENT_PUBLIC_BASE_URL', 'RAGENT_NODE_RUNTIME',
  'RAGENT_RUNNER_USER', 'MY_SERVICE_TOKEN', 'SOME_API_KEY', 'COOKIE_SESSION',
  'RAGENT_USER_SHELL_ENV_B64', 'RAGENT_RUN_SPOOL_DIR', 'RAGENT_PROVIDER_HOMES_DIR',
  'RAGENT_RUN_SANDBOX', 'RAGENT_RUN_IDLE_TIMEOUT_MS', 'RAGENT_RUN_IDLE_CHECK_INTERVAL_MS',
  'RAGENT_CODEX_TOOL_IDLE_TIMEOUT_MS', 'RAGENT_CODEX_TURN_IDLE_TIMEOUT_MS', 'RAGENT_CODEX_IDLE_INTERRUPT_GRACE_MS', 'RAGENT_CODEX_APP_SERVER_STARTUP_TIMEOUT_MS',
  'RAGENT_RUN_STDOUT_QUEUE_MAX_LINES', 'RAGENT_RUN_STDOUT_QUEUE_MAX_BYTES', 'RAGENT_RUN_STDOUT_LINE_MAX_BYTES',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'RAGENT_TEST_MARKER', 'RAGENT_TEST_TOKEN', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'ProgramFiles', 'ProgramW6432', 'ProgramFiles(x86)', 'ProgramData', 'RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES',
];
for (const key of touchedKeys) previousEnv[key] = process.env[key];

try {
  process.env.PATH = '/usr/local/bin:/usr/bin:/bin';
  process.env.LANG = 'C.UTF-8';
  process.env.LC_ALL = 'C.UTF-8';
  process.env.TERM = 'xterm-256color';
  process.env.USER = 'svc';
  process.env.HOME = fixtureHome;
  process.env.USERPROFILE = fixtureHome;
  process.env.LOCALAPPDATA = join(fixtureHome, 'AppData', 'Local');
  process.env.APPDATA = join(fixtureHome, 'AppData', 'Roaming');
  process.env.ProgramFiles = 'F:\\Programs';
  process.env.ProgramW6432 = 'F:\\Native Programs';
  process.env['ProgramFiles(x86)'] = 'F:\\Programs x86';
  process.env.ProgramData = 'F:\\SharedData';
  process.env.RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
  process.env.RAGENT_PROJECT_ROOT = '/opt/ragent/app';
  process.env.RAGENT_HARNESS_ROOT = '/opt/ragent/harnesses';
  process.env.RAGENT_PACKAGED_HARNESS_ROOT = '/Applications/Ragent App.app/Contents/Resources/runtime';
  process.env.RAGENT_CHAT_BASE_URL = 'http://127.0.0.1:7690';
  process.env.CHAT_PORT = '7690';
  process.env.IS_SANDBOX = '';
  process.env.HTTP_PROXY = 'http://127.0.0.1:7890';
  process.env.HTTPS_PROXY = 'http://127.0.0.1:7890';
  process.env.ALL_PROXY = 'http://127.0.0.1:7890';
  process.env.NO_PROXY = '127.0.0.1,localhost';
  process.env.http_proxy = process.env.HTTP_PROXY;
  process.env.https_proxy = process.env.HTTPS_PROXY;
  process.env.all_proxy = process.env.ALL_PROXY;
  process.env.no_proxy = process.env.NO_PROXY;
  process.env.DISPLAY = ':1';
  process.env.XAUTHORITY = join(fixture, 'gui', 'Xauthority');
  process.env.XDG_RUNTIME_DIR = join(fixture, 'gui');
  // Production paths / credentials the Run must never see.
  process.env.RAGENT_CONFIG_DIR = fixtureConfig;
  process.env.RAGENT_INSTANCE_ROOT = fixtureControl;
  process.env.RAGENT_MEMORY_DIR = join(fixtureControl, 'memory');
  process.env.RAGENT_WORK_ROOT_DIR = join(fixtureControl, 'workspace');
  process.env.RAGENT_RUNNER_LIFECYCLE_SOCKET = join(fixtureConfig, 'runner-lifecycle.sock');
  process.env.RAGENT_CONTROL_SOCKET = '/run/ragent-control.sock';
  process.env.RAGENT_PUBLIC_BASE_URL = 'https://agentoc.example.com';
  process.env.RAGENT_NODE_RUNTIME = '/opt/ragent/runtime/node';
  process.env.RAGENT_RUNNER_USER = 'ragent-runner';
  process.env.MY_SERVICE_TOKEN = 's3cret';
  process.env.SOME_API_KEY = 'k3y';
  process.env.COOKIE_SESSION = 'abc123';
  // The bounded test-injection channel: RAGENT_TEST_* keys may reach a Run
  // (integration tests toggle synthetic sidecar behavior), but a credential-
  // shaped one must still be stripped.
  process.env.RAGENT_TEST_MARKER = 'forward-me';
  process.env.RAGENT_TEST_TOKEN = 'should-be-stripped';
  // The launcher derives the spool channel itself, while the provider-home
  // channel is supplied by the service environment and must survive the
  // shared allowlist.
  delete process.env.RAGENT_RUN_SPOOL_DIR;
  process.env.RAGENT_PROVIDER_HOMES_DIR = fixtureProviderHomes;
  process.env.RAGENT_RUN_SANDBOX = '1';
  process.env.RAGENT_RUN_IDLE_TIMEOUT_MS = '120000';
  process.env.RAGENT_RUN_IDLE_CHECK_INTERVAL_MS = '30000';
  process.env.RAGENT_CODEX_TOOL_IDLE_TIMEOUT_MS = '600000';
  process.env.RAGENT_CODEX_TURN_IDLE_TIMEOUT_MS = '900000';
  process.env.RAGENT_CODEX_IDLE_INTERRUPT_GRACE_MS = '5000';
  process.env.RAGENT_CODEX_APP_SERVER_STARTUP_TIMEOUT_MS = '45000';
  process.env.RAGENT_RUN_STDOUT_QUEUE_MAX_LINES = '2048';
  process.env.RAGENT_RUN_STDOUT_QUEUE_MAX_BYTES = '16777216';
  process.env.RAGENT_RUN_STDOUT_LINE_MAX_BYTES = '8388608';
  // Inject a shell snapshot that carries production paths so we can prove the
  // snapshot serializer strips them before handing the env to a Run.
  process.env.RAGENT_USER_SHELL_ENV_B64 = Buffer.from(JSON.stringify({
    shell: '/bin/bash',
    mode: 'test',
    env: {
      PATH: '/bin',
      HOME: '/home/svc',
      RAGENT_CONFIG_DIR: fixtureConfig,
      RAGENT_MY_SECRET: 'leak',
    },
  })).toString('base64');

  const { buildDetachedRunnerEnvironment } = await import('../chat/run-launcher.mjs');
  const env = buildDetachedRunnerEnvironment({ launchMode: 'test-allowlist-mode' });

  // Required keys survive.
  const expectedPath = process.platform === 'win32'
    ? [join('/opt/ragent/harnesses', 'codex', 'node_modules', '.bin'), join('/opt/ragent/harnesses', 'claude', 'node_modules', '.bin'), '/usr/local/bin:/usr/bin:/bin'].join(delimiter)
    : '/usr/local/bin:/usr/bin:/bin';
  assert.equal(env.PATH, expectedPath, 'PATH must preserve the OS-specific owned-Harness prefix');
  assert.equal(env.LANG, 'C.UTF-8', 'LANG should be inherited');
  assert.equal(env.USERPROFILE, fixtureHome, 'user profile should reach the runner');
  assert.equal(env.LOCALAPPDATA, join(fixtureHome, 'AppData', 'Local'), 'local app data should match the runner user');
  assert.equal(env.ProgramFiles, 'F:\\Programs', 'program files location should reach the sidecar');
  assert.equal(env.ProgramW6432, 'F:\\Native Programs', 'native program files location should reach the sidecar');
  assert.equal(env['ProgramFiles(x86)'], 'F:\\Programs x86', '32-bit program files location should reach the sidecar');
  assert.equal(env.ProgramData, 'F:\\SharedData', 'shared program data location should reach the sidecar');
  const { systemPathRootsForPlatform } = await import('../chat/risk-policy.mjs');
  assert.ok(systemPathRootsForPlatform('win32', env).includes('F:\\SharedData'), 'sidecar protects the actual shared program data directory');
  assert.ok(systemPathRootsForPlatform('win32', env).includes('F:\\Programs x86'), 'sidecar protects the actual 32-bit program files directory');
  const { readWindowsPowerShellInvocation } = await import('../chat/windows-approval-gate.mjs');
  const nativePwsh = 'F:\\Native Programs\\PowerShell\\7\\pwsh.exe';
  assert.equal(readWindowsPowerShellInvocation({ params: { command: [nativePwsh, '-NoProfile', '-Command', 'Get-Date'] } },
    { systemRoot: 'F:\\Windows', programFiles: env.ProgramW6432 || env.ProgramFiles })?.executable, nativePwsh,
  'the detached sidecar should recognize native PowerShell 7 using inherited OS paths');
  assert.equal(env.TEMP, process.env.TEMP, 'the configured task temp should reach the runner');
  assert.equal(env.RAGENT_PROJECT_ROOT, '/opt/ragent/app', 'RAGENT_PROJECT_ROOT should be inherited');
  assert.equal(env.RAGENT_HARNESS_ROOT, '/opt/ragent/harnesses', 'RAGENT_HARNESS_ROOT should reach the sidecar');
  assert.equal(env.RAGENT_PACKAGED_HARNESS_ROOT, '/Applications/Ragent App.app/Contents/Resources/runtime', 'the bundle root should reach the sidecar');
  assert.equal(env.RAGENT_CHAT_BASE_URL, 'http://127.0.0.1:7690', 'RAGENT_CHAT_BASE_URL should be inherited');
  assert.equal(env.CHAT_PORT, '7690', 'CHAT_PORT should be inherited');
  assert.equal(env.DISPLAY, ':1', 'DISPLAY should be inherited through the GUI allowlist');
  assert.equal(env.XAUTHORITY, join(fixture, 'gui', 'Xauthority'), 'XAUTHORITY should be inherited through the GUI allowlist');
  assert.equal(env.XDG_RUNTIME_DIR, join(fixture, 'gui'), 'XDG_RUNTIME_DIR should be inherited through the GUI allowlist');
  assert.equal(env.RAGENT_RUNNER_LAUNCH_MODE, 'test-allowlist-mode', 'launch mode override should win');
  assert.equal(env.IS_SANDBOX, '1', 'IS_SANDBOX should default to 1 outside a sandbox');
  // The controlled spool channel must be set by the launcher (to the control
  // plane CHAT_RUNS_DIR), overriding any stale process.env value.
  assert.equal(
    env.RAGENT_RUN_SPOOL_DIR,
    process.platform === 'win32' ? join(fixtureControl, 'data', 'chat-runs') : join(fixtureConfig, 'chat-runs'),
    'RAGENT_RUN_SPOOL_DIR should be the control-plane CHAT_RUNS_DIR',
  );
  assert.equal(
    env.RAGENT_PROVIDER_HOMES_DIR,
    fixtureProviderHomes,
    'RAGENT_PROVIDER_HOMES_DIR should reach the sidecar from the service environment',
  );
  assert.equal(env.RAGENT_RUN_IDLE_TIMEOUT_MS, '120000', 'run idle timeout should reach the sidecar');
  assert.equal(env.RAGENT_RUN_IDLE_CHECK_INTERVAL_MS, '30000', 'run idle check interval should reach the sidecar');
  assert.equal(env.RAGENT_CODEX_TOOL_IDLE_TIMEOUT_MS, '600000', 'Codex tool timeout should reach the sidecar');
  assert.equal(env.RAGENT_CODEX_TURN_IDLE_TIMEOUT_MS, '900000', 'Codex turn timeout should reach the sidecar');
  assert.equal(env.RAGENT_CODEX_IDLE_INTERRUPT_GRACE_MS, '5000', 'Codex interrupt grace should reach the sidecar');
  assert.equal(env.RAGENT_CODEX_APP_SERVER_STARTUP_TIMEOUT_MS, '45000', 'Codex app-server startup timeout should reach the sidecar');
  assert.equal(env.RAGENT_RUN_STDOUT_QUEUE_MAX_LINES, '2048', 'stdout queue line cap should reach the sidecar');
  assert.equal(env.RAGENT_RUN_STDOUT_QUEUE_MAX_BYTES, '16777216', 'stdout queue byte cap should reach the sidecar');
  assert.equal(env.RAGENT_RUN_STDOUT_LINE_MAX_BYTES, '8388608', 'stdout line cap should reach the sidecar');

  // Explicit deny-list keys are gone even though process.env carries them.
  for (const key of RUNNER_ENV_DENYLIST) {
    assert.equal(env[key], undefined, `${key} must not be inherited`);
  }

  // Secret-pattern variables are gone.
  assert.equal(env.MY_SERVICE_TOKEN, undefined, 'MY_SERVICE_TOKEN must not be inherited');
  assert.equal(env.SOME_API_KEY, undefined, 'SOME_API_KEY must not be inherited');
  assert.equal(env.COOKIE_SESSION, undefined, 'COOKIE_SESSION must not be inherited');

  // Anything not on the allowlist is gone, including production workspace root
  // (P0-C will introduce per-run dirs; for now it must not be passed).  HOME is
  // on the allowlist but is always overridden to the home of the OS user the
  // sidecar will run as (the broker sets the runner home; buildDetachedRunner-
  // Environment uses os.homedir()), so it never leaks a hostile value.
  assert.equal(env.HOME, fixtureHome, 'HOME must be the current process home (matches the user running the sidecar)');
  assert.equal(env.RAGENT_WORK_ROOT_DIR, undefined, 'production RAGENT_WORK_ROOT_DIR must not be inherited');
  assert.equal(env.RAGENT_RUN_SANDBOX, '1', 'operator sandbox requirement must reach the sidecar');
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:7890', 'safe proxy environment must reach the Run');
  assert.ok(
    Object.keys(env).every((key) => RUNNER_ENV_ALLOWLIST.includes(key) || key.startsWith('RAGENT_TEST_')),
    'every runner env key must come from the allowlist or the bounded RAGENT_TEST_* channel',
  );
  // The bounded test-injection channel survives the strip gate; credential-
  // shaped RAGENT_TEST_* keys do not.
  assert.equal(env.RAGENT_TEST_MARKER, 'forward-me', 'RAGENT_TEST_* test override should be forwarded');
  assert.equal(env.RAGENT_TEST_TOKEN, undefined, 'RAGENT_TEST_* secret-pattern keys must be stripped');

  // The injected shell snapshot is re-encoded without production paths.
  const decoded = JSON.parse(Buffer.from(env.RAGENT_USER_SHELL_ENV_B64, 'base64').toString('utf8'));
  assert.equal(decoded.env.PATH, '/bin', 'snapshot PATH should be preserved');
  assert.equal(decoded.env.RAGENT_CONFIG_DIR, undefined, 'snapshot must not carry RAGENT_CONFIG_DIR');
  assert.equal(decoded.env.RAGENT_MY_SECRET, undefined, 'snapshot must not carry secret-pattern vars');

  console.log('test-runner-env-allowlist: ok');
} finally {
  rmSync(fixture, { recursive: true, force: true });
  for (const key of touchedKeys) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
}
