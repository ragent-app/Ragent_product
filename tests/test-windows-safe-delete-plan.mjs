import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { planWindowsSafeDelete, planWindowsBashSafeDelete } from '../chat/windows-safe-delete-plan.mjs';

if (process.platform !== 'win32') { console.log('windows-safe-delete-plan: skipped off Windows'); process.exit(0); }
const root = await mkdtemp(path.join(os.tmpdir(), 'agentoc-safe-delete-plan-'));
await mkdir(path.join(root, 'build', 'nested'), { recursive: true });
await writeFile(path.join(root, 'build', 'nested', 'file.txt'), 'fixture');
await mkdir(path.join(root, 'danger', '.ssh'), { recursive: true });
await mkdir(path.join(root, 'alternate', 'build'), { recursive: true });
await writeFile(path.join(root, 'alternate', 'build', 'other.txt'), 'fixture');
const state = { cwd: root, riskMode: 'recommended', riskContextValid: true, riskContext: { trustedWorkspaceRoot: root } };
for (const riskMode of ['recommended', 'full-auto']) {
  assert.deepEqual(await planWindowsSafeDelete({ command: 'Remove-Item -LiteralPath build -Recurse -Force', state: { ...state, riskMode } }),
    { workspace: root, relative: 'build', contentsOnly: false, force: true });
  assert.deepEqual(await planWindowsSafeDelete({ command: 'Remove-Item -Path build\\* -Recurse', state: { ...state, riskMode } }),
    { workspace: root, relative: 'build', contentsOnly: true, force: false });
}
await mkdir(path.join(root, 'outside-protected', 'build', '.ssh'), { recursive: true });
const outsideProtected = { ...state, cwd: path.join(root, 'alternate'), riskContext: { trustedWorkspaceRoot: path.join(root, 'alternate') } };
assert.equal(await planWindowsBashSafeDelete({ command: 'rm -rf ../outside-protected/build', state: outsideProtected }), null);
assert.equal(await planWindowsBashSafeDelete({ command: 'rm -rf .', state: { ...state, cwd: path.join(root, 'build'), riskContext: { trustedWorkspaceRoot: path.join(root, 'build') } } }), null);
assert.deepEqual(await planWindowsSafeDelete({ command: 'Remove-Item -LiteralPath build -Recurse', state: { ...state, cwd: path.join(root, 'alternate') } }),
  { workspace: root, relative: 'alternate\\build', contentsOnly: false, force: false });
for (const riskMode of ['recommended', 'full-auto']) {
  const outsideState = { ...state, riskMode, cwd: path.join(root, 'alternate'), riskContext: { trustedWorkspaceRoot: path.join(root, 'alternate') } };
  assert.deepEqual(await planWindowsSafeDelete({ command: 'Remove-Item -LiteralPath ..\\build -Recurse', state: outsideState }),
    { workspace: root, relative: 'build', contentsOnly: false, force: false });
  assert.deepEqual(await planWindowsBashSafeDelete({ command: 'rm -rf ../build', state: outsideState }),
    { workspace: root, relative: 'build', contentsOnly: false, force: true });
}
for (const command of ['Remove-Item -Path . -Recurse -Force', 'Remove-Item -Path danger -Recurse', 'Remove-Item -Path ..\\other -Recurse',
  'Remove-Item -Path build\\*.txt -Recurse', 'Remove-Item -LiteralPath build\\* -Recurse', 'Remove-Item -Path $env:TEMP -Recurse',
  'Remove-Item -Path build -Recurse; Write-Output x', 'Remove-Item -Path build', 'Remove-Item -Path build -Recurse -WhatIf',
  "Remove-Item -Path build -Filter '*.txt' -Recurse", 'Remove-Item -Path build -Recurse:$false']) {
  assert.equal(await planWindowsSafeDelete({ command, state }), null, command);
}
assert.equal(await planWindowsSafeDelete({ command: 'Remove-Item build -Recurse', state: { ...state, riskMode: 'conservative-auto' } }), null);
assert.equal(await planWindowsSafeDelete({ command: 'Remove-Item build -Recurse', state: { ...state, riskContextValid: false } }), null);
const bashTarget = `/${root[0].toLowerCase()}${path.join(root, 'build').slice(2).replaceAll('\\', '/')}`;
for (const riskMode of ['recommended', 'full-auto']) {
  assert.deepEqual(await planWindowsBashSafeDelete({ command: `rm -rf '${bashTarget}'`, state: { ...state, riskMode } }),
    { workspace: root, relative: 'build', contentsOnly: false, force: true });
}
for (const command of ['rm -rf .', 'rm -rf ../outside', 'rm -rf "$HOME"', 'rm -rf build; echo unsafe', 'rm -rf build other', 'rm -i -r build']) {
  assert.equal(await planWindowsBashSafeDelete({ command, state }), null, command);
}
console.log('windows-safe-delete-plan: workspace binding and static command limits passed');
