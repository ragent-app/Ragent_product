import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const powershell = 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const root = await mkdtemp(join(tmpdir(), 'ragent-fresh-directory-'));
try {
  const bridge = join(root, 'bridge.exe');
  await exec(powershell, ['-NoProfile', '-NonInteractive', '-File',
    resolve('packaging/windows/build-managed-owner-msi-bridge.ps1'), '-OutputPath', bridge],
  { windowsHide: true, timeout: 30000 });
  const empty = join(root, 'empty target');
  const populated = join(root, 'populated target');
  const data = join(root, 'retained data');
  await Promise.all([mkdir(empty), mkdir(populated), mkdir(data)]);
  await writeFile(join(populated, 'user-data.txt'), 'must not be overwritten');
  const escape = (s) => s.replaceAll("'", "''");
  const script = `$a=[Reflection.Assembly]::LoadFile('${escape(bridge)}')
    $type=$a.GetType('ManagedOwnerMsiBridge')
    $method=$type.GetMethod('EmptyFreshTarget',[Reflection.BindingFlags]'NonPublic,Static')
    $missing='${escape(join(root, 'not-created'))}'
    $absentData='${escape(join(root, 'no-data'))}'
    @(
      $method.Invoke($null,@($missing,$absentData)),
      $method.Invoke($null,@('${escape(empty)}',$absentData)),
      $method.Invoke($null,@('${escape(populated)}',$absentData)),
      $method.Invoke($null,@('${escape(empty)}','${escape(data)}'))
    ) | ConvertTo-Json -Compress`;
  const { stdout } = await exec(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 30000 });
  assert.deepEqual(JSON.parse(stdout), [true, true, false, false]);
  console.log('PASS: fresh installer accepts an empty selected directory and refuses existing data or nonempty targets');
} finally {
  await rm(root, { recursive: true, force: true });
}
