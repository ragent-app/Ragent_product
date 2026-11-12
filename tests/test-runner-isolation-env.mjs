#!/usr/bin/env node
// P0-D: accident-reproduction isolation contract (env level).
//
// Reproduces the worst-case "control-plane environment leaked into a Run"
// accident and proves none of it reaches the Run process. A hostile full
// production environment is fed through the REAL launchLifecycleRunner launch
// path (systemd-run argv captured via a fake execFileImpl) and we assert:
//   1. no RUNNER_ENV_DENYLIST key ever appears as a --setenv value;
//   2. secret-pattern variables (TOKEN/SECRET/PASSWORD/CREDENTIAL/AUTH/COOKIE)
//      never reach a Run;
//   3. HOME is overridden to the resolved runner home, not the control home;
//   4. the ONLY config-derived value a Run receives is the controlled
//      AGENTOC_RUN_SPOOL_DIR spool write-back channel.
//
// The real cross-Unix-user scenario (running the sidecar as agentoc-runner on
// a production tree) is environment-gated and skipped without root; this env
// contract is the part that is always provable.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

// CONFIG_DIR is read at config.mjs import time; point it at a throwaway dir so
// the spool channel resolves under the test tree, never the production config.
const testConfigDir = await mkdtemp(join(tmpdir(), 'agentoc-p0d-config-'));
process.env.AGENTOC_CONFIG_DIR = testConfigDir;

const { RUNNER_ENV_DENYLIST } = await import('../lib/runner-env.mjs');
const { CONFIG_DIR } = await import('../lib/config.mjs');
const { launchLifecycleRunner } = await import('../scripts/runner-lifecycle-broker.mjs');

const HOSTILE_PRODUCTION_ENV = {
  // Every denylisted production location, with plausible values.
  AGENTOC_CONFIG_DIR: '/var/lib/agentoc/config',
  AGENTOC_INSTANCE_ROOT: '/var/lib/agentoc',
  AGENTOC_MEMORY_DIR: '/var/lib/agentoc/memory',
  AGENTOC_CONTROL_SOCKET: '/run/agentoc-control.sock',
  AGENTOC_PRIVILEGED_EXECUTOR_SOCKET: '/run/agentoc-privileged-executor/sock',
  AGENTOC_PRIVILEGED_EXECUTOR_AUDIT_FILE: '/var/log/agentoc-privileged/audit.jsonl',
  AGENTOC_RUNNER_SUPERVISOR_SOCKET: '/var/lib/agentoc/config/runner-supervisor.sock',
  AGENTOC_RUNNER_LIFECYCLE_SOCKET: '/var/lib/agentoc/config/runner-lifecycle.sock',
  AGENTOC_LINUX_PEER_RESULT_SOCKET: '/run/agentoc-peer-result/result.sock',
  AGENTOC_LINUX_PEER_CREDENTIAL_HELPER: '/usr/lib/agentoc/privileged-peercred',
  AGENTOC_RUNNER_LIFECYCLE_REQUIRED: '1',
  AGENTOC_RUNNER_SUPERVISOR_REQUIRED: '1',
  AGENTOC_PUBLIC_BASE_URL: 'https://example.com',
  AGENTOC_NODE_RUNTIME: '/opt/agentoc/runtime/node',
  AGENTOC_SERVICE_USER: 'agentoc',
  AGENTOC_RUNNER_USER: 'agentoc-runner',
  // Secret-pattern variables the strip gate must drop even if not denylisted.
  AGENTOC_AUTH_SESSION_SECRET: 's3cret-cookie-hmac',
  AGENTOC_OAUTH_CLIENT_SECRET: 's3cret-client',
  PROVIDER_API_TOKEN: 's3cret-token',
  PROVIDER_PASSWORD: 's3cret-pass',
  // Allowlisted keys a hostile env could set to production-looking values.
  PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin',
  LANG: 'C.UTF-8',
  TERM: 'xterm',
  AGENTOC_PROJECT_ROOT: '/opt/agentoc/app',
  AGENTOC_CHAT_BASE_URL: 'http://127.0.0.1:7690',
  CHAT_PORT: '7690',
  // The control-plane home; the broker must override it, not pass it through.
  HOME: '/home/agentoc',
};

async function main() {
  const captures = [];
  const launched = await launchLifecycleRunner('run_abc12345', {
    serviceUser: 'agentoc-runner',
    serviceGroup: 'agentoc-runners',
    serviceHome: '/home/agentoc-runner',
    readUnitStateImpl: async () => ({ loadState: 'not-found', activeState: 'inactive' }),
    environment: HOSTILE_PRODUCTION_ENV,
    execFileImpl: async (bin, args) => {
      if (bin === 'systemctl') return { stdout: '4242\n' };
      captures.push({ bin, args });
      return { stdout: '' };
    },
  });
  assert.equal(captures.length, 1, 'one systemd-run invocation expected');
  const setenvValues = [];
  for (let index = 0; index < captures[0].args.length - 1; index += 1) {
    if (captures[0].args[index] === '--setenv') setenvValues.push(captures[0].args[index + 1]);
  }
  assert.ok(setenvValues.length > 0, 'runner env must be set explicitly');

  // 1) every denylisted key must be absent from the Run environment.
  for (const key of RUNNER_ENV_DENYLIST) {
    assert.ok(
      setenvValues.every((value) => !value.startsWith(`${key}=`)),
      `${key} must never be passed to a Run`,
    );
  }

  // 2) secret-pattern variables must never reach a Run.
  const secretPattern = /(?:TOKEN|SECRET|PASSWORD|PASSWD|COOKIE|API_KEY|APIKEY|CREDENTIAL|AUTH)/;
  for (const value of setenvValues) {
    const name = value.split('=', 1)[0];
    assert.ok(!secretPattern.test(name), `secret-pattern variable ${name} must not reach a Run`);
  }

  // 3) HOME is the runner home, never the control-plane home.
  assert.ok(setenvValues.includes('HOME=/home/agentoc-runner'), 'HOME must point at the runner home');
  assert.ok(!setenvValues.includes('HOME=/home/agentoc'), 'control-plane HOME must not pass through');

  // 4) the only config-derived value is the controlled spool write-back channel.
  const configPrefix = `${CONFIG_DIR}/`;
  const spoolValue = join(CONFIG_DIR, 'chat-runs');
  for (const value of setenvValues) {
    if (value.startsWith('AGENTOC_RUN_SPOOL_DIR=')) continue;
    assert.ok(
      !value.includes(configPrefix),
      `no production config path may reach a Run outside the spool channel: ${value}`,
    );
    assert.ok(
      !value.includes('/var/lib/agentoc/'),
      `no production /var/lib/agentoc path may reach a Run: ${value}`,
    );
  }
  assert.ok(
    setenvValues.includes(`AGENTOC_RUN_SPOOL_DIR=${spoolValue}`),
    'the controlled spool channel must still be passed to the runner',
  );

  // 5) the runner identity is set on the transient unit.
  assert.ok(captures[0].args.includes('User=agentoc-runner'), 'unit must run as agentoc-runner');
  assert.ok(captures[0].args.includes('Group=agentoc-runners'), 'unit must run as agentoc-runners');

  // 6) real launch result comes back with the transient unit name.
  assert.equal(launched.pid, 4242);
  assert.equal(launched.unitName, 'agentoc-runner-run_abc12345');

  console.log('test-runner-isolation-env: ok');
  console.log(`  runner env keys passed: ${setenvValues.length}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await rm(testConfigDir, { recursive: true, force: true });
  });
