#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function read(relativePath) {
  return readFileSync(join(root, relativePath), 'utf8');
}

const EXPECTED_ORG_ROLLOUT_FLAGS = [
  'RAGENT_ORG_SCHEMA_ENABLED',
  'RAGENT_ORG_SHADOW_PROJECTION',
  'RAGENT_ORG_SESSION_ADDRESSABILITY_ENABLED',
  'RAGENT_MANAGED_INPUT_ENFORCEMENT',
  'RAGENT_MANAGED_WRITER_ENABLED',
  'RAGENT_REVIEWER_ENABLED',
  'RAGENT_COLLABORATION_LEADER_ENABLED',
  'RAGENT_ORG_INTERNAL_ENVELOPE_ENABLED',
  'RAGENT_ORG_AUTONOMOUS_LEADER_ENABLED',
  'RAGENT_ORG_AUTONOMOUS_PROVISIONING_ENABLED',
  'RAGENT_ORG_AUTONOMOUS_AUTO_PROVISIONING_ENABLED',
  'RAGENT_ORG_HIERARCHICAL_DELEGATION_ENABLED',
  'RAGENT_ORG_DYNAMIC_REPLAN_ENABLED',
  'RAGENT_ORG_STALL_GOVERNOR_ENABLED',
  'RAGENT_ORG_PROJECTION_V1_ENABLED',
  'RAGENT_ORG_PROJECTION_V2_ENABLED',
  'RAGENT_ORG_RECOVERY_V1_ENABLED',
  'RAGENT_CONSULTATION_V1_ENABLED',
];

const debEnv = read('packaging/deb/ragent.env');
const rpmPostinst = read('packaging/rpm/postinst');
const serviceHost = read('packaging/windows/Ragent.ServiceHost.cs');
const ragentEnvSh = read('packaging/macos/ragent-env.sh');
const ragentApp = read('packaging/macos/Ragent');
const ragentService = read('packaging/macos/ragent-service');
const ragentCli = read('packaging/macos/ragent-cli');
const ragentLoginCjs = read('packaging/macos/ragent-login.cjs');

assert.equal(ragentEnvSh.includes('\r\n'), false, 'packaging/macos/ragent-env.sh must use LF line endings');
assert.equal(ragentApp.includes('\r\n'), false, 'packaging/macos/Ragent must use LF line endings');
assert.equal(ragentService.includes('\r\n'), false, 'packaging/macos/ragent-service must use LF line endings');
assert.equal(ragentCli.includes('\r\n'), false, 'packaging/macos/ragent-cli must use LF line endings');

const arrayMatch = ragentEnvSh.match(/RAGENT_PACKAGED_ORG_ROLLOUT_FLAGS=\(\s*([\s\S]*?)\s*\)/);
assert.ok(arrayMatch, 'packaging/macos/ragent-env.sh must define RAGENT_PACKAGED_ORG_ROLLOUT_FLAGS');
const macosFlags = arrayMatch[1]
  .split(/\r?\n/)
  .map((line) => line.replace(/#.*$/, '').trim())
  .filter(Boolean);

assert.deepEqual(
  macosFlags,
  EXPECTED_ORG_ROLLOUT_FLAGS,
  'macOS RAGENT_PACKAGED_ORG_ROLLOUT_FLAGS must list the exact 18 org rollout flags in canonical order',
);

for (const flag of EXPECTED_ORG_ROLLOUT_FLAGS) {
  assert.match(debEnv, new RegExp(`^${flag}=1$`, 'm'), `deb ragent.env missing ${flag}=1`);
  assert.match(rpmPostinst, new RegExp(`^\\s*${flag}\\b`, 'm'), `rpm postinst missing ${flag}`);
  assert.match(serviceHost, new RegExp(`"${flag}"`), `Windows ServiceHost.cs missing ${flag}`);
}

for (const [label, content] of [
  ['packaging/macos/ragent-env.sh', ragentEnvSh],
  ['packaging/macos/Ragent', ragentApp],
  ['packaging/macos/ragent-service', ragentService],
  ['packaging/macos/ragent-cli', ragentCli],
  ['packaging/macos/ragent-login.cjs', ragentLoginCjs],
]) {
  assert.doesNotMatch(
    content,
    /RAGENT_CODEX_PROVIDER_READONLY/,
    `${label} must NEVER set RAGENT_CODEX_PROVIDER_READONLY (macOS lacks bwrap)`,
  );
}

for (const [label, content] of [
  ['packaging/macos/Ragent', ragentApp],
  ['packaging/macos/ragent-service', ragentService],
  ['packaging/macos/ragent-cli', ragentCli],
]) {
  assert.match(content, /ragent-env\.sh/, `${label} must source ragent-env.sh`);
  assert.match(content, /ragent_source_instance_env/, `${label} must load instance.env + packaged org defaults`);
}

assert.match(
  ragentEnvSh,
  /ragent_source_instance_env\(\)[\s\S]*?ragent_apply_packaged_org_defaults/,
  'ragent_source_instance_env must apply packaged org rollout defaults after sourcing instance.env',
);

if (process.platform !== 'win32') {
  const tempRoot = mkdtempSync(join(tmpdir(), 'ragent-macos-org-flags-'));
  try {
    const configDir = join(tempRoot, 'config');
    mkdirSync(configDir, { recursive: true });
    const envPath = join(root, 'packaging', 'macos', 'ragent-env.sh');
    const cleanEnv = { PATH: process.env.PATH, HOME: tempRoot, RAGENT_CONFIG_DIR: configDir };

    // 1. Fresh install (no instance.env): all 18 flags default to "1"; READONLY stays unset.
    const fresh = spawnSync('/bin/bash', [
      '-euo', 'pipefail', '-c',
      `source "$1" && ragent_source_instance_env && "$2" -e 'console.log(JSON.stringify(process.env))'`,
      'bash',
      envPath,
      process.execPath,
    ], { env: cleanEnv, encoding: 'utf8' });
    assert.equal(fresh.status, 0, fresh.stderr);
    const freshEnv = JSON.parse(fresh.stdout);
    for (const flag of EXPECTED_ORG_ROLLOUT_FLAGS) {
      assert.equal(freshEnv[flag], '1', `fresh install must default ${flag} to "1"`);
    }
    assert.equal(Object.hasOwn(freshEnv, 'RAGENT_CODEX_PROVIDER_READONLY'), false);

    // 2. Existing instance.env with partial opt-outs & blank values: opt-outs win, omitted/blank default to "1".
    const instanceEnvFile = join(configDir, 'instance.env');
    writeFileSync(instanceEnvFile, [
      'RAGENT_ORG_SCHEMA_ENABLED=0',
      'RAGENT_MANAGED_WRITER_ENABLED=false',
      'RAGENT_REVIEWER_ENABLED=NO',
      'RAGENT_CONSULTATION_V1_ENABLED=off',
      'RAGENT_ORG_PROJECTION_V2_ENABLED="   "',
    ].join('\n') + '\n', 'utf8');
    const override = spawnSync('/bin/bash', [
      '-euo', 'pipefail', '-c',
      `source "$1" && ragent_source_instance_env && "$2" -e 'console.log(JSON.stringify(process.env))'`,
      'bash',
      envPath,
      process.execPath,
    ], { env: cleanEnv, encoding: 'utf8' });
    assert.equal(override.status, 0, override.stderr);
    const overrideEnv = JSON.parse(override.stdout);
    assert.equal(overrideEnv.RAGENT_ORG_SCHEMA_ENABLED, '0');
    assert.equal(overrideEnv.RAGENT_MANAGED_WRITER_ENABLED, '0');
    assert.equal(overrideEnv.RAGENT_REVIEWER_ENABLED, '0');
    assert.equal(overrideEnv.RAGENT_CONSULTATION_V1_ENABLED, '0');
    assert.equal(overrideEnv.RAGENT_ORG_PROJECTION_V2_ENABLED, '1');
    assert.equal(overrideEnv.RAGENT_ORG_PROJECTION_V1_ENABLED, '1');
    assert.equal(Object.hasOwn(overrideEnv, 'RAGENT_CODEX_PROVIDER_READONLY'), false);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

console.log('test-macos-org-flags: ok');
