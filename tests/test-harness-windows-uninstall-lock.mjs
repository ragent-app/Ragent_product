import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';

if (process.platform !== 'win32') { console.log('SKIP: native Windows executable lock'); process.exit(0); }
const root = await mkdtemp(join(tmpdir(), 'ragent-harness-uninstall-lock-'));
process.env.RAGENT_CONFIG_DIR = join(root, 'config');
process.env.RAGENT_INSTANCE_ROOT = root;
process.env.RAGENT_HARNESS_ROOT = join(root, 'harnesses');
process.env.RAGENT_PACKAGED_HARNESS_ROOT = join(root, 'no-bundle');
process.env.RAGENT_HARNESS_POLICY_URL = 'http://invalid.test';
process.env.RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
const live = join(root, 'harnesses', 'codex');
const bin = join(live, 'node_modules', '.bin');
await mkdir(bin, { recursive: true });
await mkdir(join(root, 'config'), { recursive: true });
const statePath = join(root, 'config', 'harness-installations.json');
await writeFile(statePath, JSON.stringify({ codex: { installed: true } }));
const shim = join(bin, 'codex.cmd');
await writeFile(shim, '@echo off\r\necho codex-cli 0.153.4\r\n');
const image = join(live, 'locked.exe');
await copyFile(process.execPath, image);
const sentinel = join(live, 'must-survive.txt');
await writeFile(sentinel, 'complete installation');
const registry = await import(process.env.RAGENT_TEST_HARNESS_MODULE
  ? pathToFileURL(process.env.RAGENT_TEST_HARNESS_MODULE).href
  : '../lib/harness-registry.mjs');
const child = spawn(image, ['-e', "console.log('READY');setInterval(()=>{},1000)"], { stdio: ['ignore','pipe','pipe'], windowsHide: true });
const exited = once(child, 'exit');
try {
  await once(child.stdout, 'data');
  await assert.rejects(registry.uninstallHarness('codex'), error => error.code === 'HARNESS_IN_USE' && error.statusCode === 409,
    'a running internal executable must block uninstall before any file is removed');
  assert.equal(await readFile(sentinel, 'utf8'), 'complete installation');
  assert.match(await readFile(shim, 'utf8'), /0.153.4/);
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).codex.installed, true);
  assert.equal(child.exitCode, null, 'management must not kill the running Harness');
  if (!process.env.RAGENT_TEST_HARNESS_MODULE) {
    const { handleHarnessRoutes } = await import('../chat/router-harness-routes.mjs');
    const req = Readable.from(['{}']); req.method = 'POST';
    let status; let payload;
    await handleHarnessRoutes({ req, pathname: '/api/harnesses/codex/uninstall', res: {
      writeHead(value) { status = value; }, end(value) { payload = JSON.parse(value); },
    } });
    assert.equal(status, 409);
    assert.equal(payload.code, 'HARNESS_IN_USE');
  }
  console.log('PASS: live Windows image lock returns 409; complete runtime/state and process preserved');
} finally {
  child.kill();
  await exited;
}
const result = await registry.uninstallHarness('codex');
assert.equal(result.uninstalled, true);
assert.equal(result.filesRemoved, true);
assert.equal(result.cleanupPending, false);
assert.equal(result.installed, false);
await assert.rejects(stat(live), { code: 'ENOENT' });
assert.equal(JSON.parse(await readFile(statePath, 'utf8')).codex.installed, false);
console.log('PASS: retry after owned process exit removes runtime and records uninstalled');

const { retireHarnessDirectory, removeRetiredHarnessDirectory } = await import('../lib/harness-filesystem.mjs');
await mkdir(live, { recursive: true });
await writeFile(sentinel, 'deferred cleanup');
let attempts = 0;
const { rename } = await import('node:fs/promises');
const retired = await retireHarnessDirectory(join(root, 'harnesses'), 'codex', 'Codex', {
  renameImpl: async (...args) => {
    if (attempts++ === 0) throw Object.assign(new Error('transient scanner lock'), { code: 'EPERM' });
    return rename(...args);
  },
});
assert.equal(attempts, 2);
const deferred = await removeRetiredHarnessDirectory(retired, {
  rmImpl: async () => { throw Object.assign(new Error('scanner still holds retired file'), { code: 'EPERM' }); },
});
assert.equal(deferred.cleanupPending, true);
assert.equal(deferred.filesRemoved, false);
await assert.rejects(stat(live), { code: 'ENOENT' });
assert.equal(await readFile(join(retired, 'must-survive.txt'), 'utf8'), 'deferred cleanup');
assert.equal((await removeRetiredHarnessDirectory(retired)).filesRemoved, true);
const outside = join(root, 'unrelated-user-files');
await mkdir(outside); await writeFile(join(outside, 'keep.txt'), 'preserve');
assert.equal((await removeRetiredHarnessDirectory(outside)).cleanupPending, true);
assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'preserve');
console.log('PASS: transient rename lock retries; persistent cleanup lock stays outside live paths and is retryable');
