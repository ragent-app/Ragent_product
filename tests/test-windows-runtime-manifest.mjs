import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWindowsRuntimeManifest } from '../scripts/create-windows-runtime-manifest.mjs';

const root = await mkdtemp(join(tmpdir(), 'ragent-runtime-manifest-'));
const vendor = join(root, 'vendor');
const powershell = join(vendor, 'PowerShell');
const winget = join(vendor, 'Microsoft.WinGet.Client');
const exe = join(powershell, 'pwsh.exe');
const module = join(winget, 'Microsoft.WinGet.Client.psd1');
const manifest = join(vendor, 'runtime-integrity.json');
try {
  await mkdir(powershell, { recursive: true });
  await mkdir(winget);
  await writeFile(exe, 'test executable');
  await writeFile(module, 'test module');
  const result = await createWindowsRuntimeManifest(root);
  const bytes = await readFile(manifest);
  assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'));
  const parsed = JSON.parse(bytes);
  assert.equal(parsed.schemaVersion, 1);
  assert.deepEqual(parsed.files.map((file) => file.path), ['Microsoft.WinGet.Client/Microsoft.WinGet.Client.psd1', 'PowerShell/pwsh.exe']);
  assert.equal(parsed.files[1].sha256, createHash('sha256').update('test executable').digest('hex'));
  await assert.rejects(createWindowsRuntimeManifest(root), { code: 'EEXIST' });
} finally {
  for (const path of [manifest, exe, module]) await unlink(path).catch(() => {});
  for (const path of [powershell, winget, vendor, root]) await rmdir(path).catch(() => {});
}
console.log('windows-runtime-manifest: component hashing and immutable output passed');
