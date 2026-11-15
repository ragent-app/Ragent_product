import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

if (process.platform !== 'win32') {
  console.log('SKIP: Windows fake installer fixture');
  process.exit(0);
}
const root = await mkdtemp(join(tmpdir(), 'ragent-first-install-probe-'));
process.env.RAGENT_CONFIG_DIR = join(root, 'config');
process.env.RAGENT_HARNESS_ROOT = join(root, 'harnesses');
process.env.RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
process.env.RAGENT_HARNESS_POLICY_URL = 'http://invalid.test';
delete process.env.RAGENT_INSTANCE_ROOT;
const installer = join(root, 'fixture-installer.cmd');
process.env.RAGENT_NPM_COMMAND = installer;
const bin = join(root, 'harnesses', 'claude', 'node_modules', '.bin');
const ready = join(root, 'ready');
const release = join(root, 'release');
await mkdir(bin, { recursive: true });
await writeFile(join(root, 'install.mjs'), `
import {writeFile,access} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
await writeFile(${JSON.stringify(join(bin, 'claude.cmd'))}, '@echo off\\r\\nexit /b 1\\r\\n');
await writeFile(${JSON.stringify(ready)}, 'ready');
while (!await access(${JSON.stringify(release)}).then(()=>true,()=>false)) await delay(10);
await writeFile(${JSON.stringify(join(bin, 'claude.cmd'))}, '@echo off\\r\\necho 2.1.310 (Claude Code)\\r\\n');
`);
await writeFile(installer, `@echo off\r\n"${process.execPath}" "${join(root, 'install.mjs')}"\r\n`);
let installation;
try {
  const { installHarness, getHarnessDefinition } = await import('../lib/harness-registry.mjs');
  installation = installHarness('claude');
  // Observe rejection immediately so a fixture setup failure cannot be unhandled.
  installation.catch(() => {});
  const deadline = Date.now() + 10_000;
  while (!await access(ready).then(() => true, () => false)) {
    assert.ok(Date.now() < deadline, 'fixture installer did not publish partial runtime');
    await delay(10);
  }
  const partial = await getHarnessDefinition('claude');
  assert.equal(partial.detectedVersion, null);
  assert.ok(partial.versionCheckError, 'background probe must actually fail during extraction');
  await writeFile(release, 'complete');
  const result = await installation;
  assert.equal(result.detectedVersion, '2.1.310');
  assert.equal(result.available, true);
  console.log('PASS: first managed install ignores cached partial-extraction probe failure');
} finally {
  await writeFile(release, 'complete');
  if (installation) await installation.catch(() => {});
  await rm(root, { recursive: true, force: true });
}
