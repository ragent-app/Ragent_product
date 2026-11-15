import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.platform !== 'win32') {
  console.log('SKIP: bundled Windows installer guard');
  process.exit(0);
}
const root = await mkdtemp(join(tmpdir(), 'ragent-broken-installer-'));
const payload = join(root, 'broken payload');
await mkdir(payload);
await writeFile(join(payload, 'node.exe'), 'fixture: must never execute');
await writeFile(join(payload, 'npm.cmd'), '@echo off\r\nexit /b 99\r\n');
process.env.RAGENT_CONFIG_DIR = join(root, 'config');
process.env.RAGENT_HARNESS_ROOT = join(root, 'harnesses');
process.env.RAGENT_NPM_COMMAND = join(payload, 'npm.cmd');
process.env.RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
process.env.RAGENT_HARNESS_POLICY_URL = 'http://invalid.test';
delete process.env.RAGENT_INSTANCE_ROOT;
const { upgradeHarness } = await import('../lib/harness-registry.mjs');
await assert.rejects(upgradeHarness('codex', '0.153.4'),
  /HARNESS_INSTALLER_RUNTIME_INCOMPLETE:.*npm-cli\.js.*Repair or update/s);
console.log('PASS: incomplete bundled npm is rejected before invoking installer; actionable repair message');
