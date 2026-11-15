import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { buildPlatformSpawnSpec, WINDOWS_POWERSHELL_EXECUTABLE } from '../lib/executable-resolution.mjs';
import { scanRuntimePayload } from '../scripts/verify-runtime-payload.mjs';

if (process.platform !== 'win32') {
  console.log('SKIP: Windows Node toolchain requires native Windows');
  process.exit(0);
}
const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'ragent-node-toolchain-'));
try {
const payload = join(root, 'payload with spaces');
await mkdir(payload);
await mkdir(join(payload, 'third_party_licenses/node'), { recursive: true });
await writeFile(join(payload, 'package.json'), '{"name":"toolchain-fixture","version":"1.0.0"}');
await writeFile(join(payload, 'package-lock.json'), JSON.stringify({
  name: 'toolchain-fixture', version: '1.0.0', lockfileVersion: 3,
  packages: { '': { name: 'toolchain-fixture', version: '1.0.0' } },
}));
const stage = () => exec(WINDOWS_POWERSHELL_EXECUTABLE, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
  '-File', resolve('packaging/windows/stage-node-toolchain.ps1'), '-NodePath', process.execPath, '-PayloadRoot', payload],
{ timeout: 60_000, windowsHide: true });
await assert.rejects(stage(), (error) => /Missing license and bundled notices/.test(error.stderr));
await copyFile(resolve(`third_party_licenses/node/${process.version}-LICENSE.txt`), join(payload, `third_party_licenses/node/${process.version}-LICENSE.txt`));
await stage();
// Reproduce the old build order using real npm ci, with no registry access.
await exec(process.execPath, [join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
  'ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: payload, timeout: 30_000, windowsHide: true });
await assert.rejects(access(join(payload, 'node_modules/npm/bin/npm-cli.js')), { code: 'ENOENT' });
await assert.rejects(access(join(payload, 'node_modules/corepack/dist/corepack.js')), { code: 'ENOENT' });
const oldSpec = buildPlatformSpawnSpec(join(payload, 'npm.cmd'), ['--version']);
await assert.rejects(exec(oldSpec.file, oldSpec.args, { ...oldSpec, timeout: 10_000 }),
  (error) => /MODULE_NOT_FOUND/.test(error.stderr), 'old order reproduces the reported broken npm shim');
// Exercise the same post-ci stager used by build-msi, then its actual .cmd shims.
await stage();
await assert.rejects(access(join(payload, 'node_modules/npm/man')), { code: 'ENOENT' });
await assert.rejects(access(join(payload, 'node_modules/npm/docs')), { code: 'ENOENT' });
assert.deepEqual((await scanRuntimePayload(payload)).findings, [], 'shipped toolchain passes the unchanged secret scanner');
const env = { ...process.env, PATH: 'C:\\Windows\\System32' };
delete env.Path;
for (const command of ['npm.cmd', 'corepack.cmd']) {
  const spec = buildPlatformSpawnSpec(join(payload, command), ['--version'], { env });
  const result = await exec(spec.file, spec.args, { ...spec, env, timeout: 10_000, windowsHide: true });
  assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+/);
}
// Verify an offline install through the bundled npm, not merely --version.
const packageRoot = join(root, 'local-package');
await mkdir(packageRoot);
await writeFile(join(packageRoot, 'package.json'), '{"name":"ragent-toolchain-smoke","version":"1.0.0"}');
const prefix = join(root, 'managed harness');
const spec = buildPlatformSpawnSpec(join(payload, 'npm.cmd'), [
  'install', '--prefix', prefix, '--offline', '--no-save', '--package-lock=false', '--ignore-scripts', '--no-audit', packageRoot,
], { env });
await exec(spec.file, spec.args, { ...spec, env, timeout: 30_000, windowsHide: true });
assert.equal(JSON.parse(await readFile(join(prefix, 'node_modules/ragent-toolchain-smoke/package.json'), 'utf8')).version, '1.0.0');
console.log(`PASS: reproduced ci pruning; bundled npm/corepack run without Node on PATH; offline install works. Fixture: ${root}`);
} finally {
  await rm(root, { recursive: true, force: true });
}
