import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { ownerWindowsOsPaths } from '../lib/windows-owner-os-paths.mjs';

if (process.platform !== 'win32') { console.log('windows-runner-supervisor-pipe: skipped (Windows required)'); process.exit(0); }
const windows = ownerWindowsOsPaths()?.windows;
assert.ok(windows, 'Windows system directory must be OS-resolved');
const parent = await realpath(tmpdir());
const root = await mkdtemp(path.join(parent, 'ragent-supervisor-pipe-'));
const exec = promisify(execFile);
try {
  const binary = path.join(root, 'fixture.exe');
  const compiler = path.join(windows, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  await exec(compiler, ['/nologo', '/target:exe', '/main:RunnerSupervisorPipeFixture', '/r:System.ServiceProcess.dll',
    `/out:${binary}`, path.resolve('packaging/windows/Ragent.ServiceHost.cs'),
    path.resolve('tests/fixtures/windows-runner-supervisor-pipe.cs')], { windowsHide: true, timeout: 30000 });
  const result = await exec(binary, [], { windowsHide: true, timeout: 60000 });
  assert.match(result.stdout, /PASS: protected ACL, repeated forwarding, peer refusal and shutdown/);
  console.log(result.stdout.trim());
} finally {
  const resolved = await realpath(root);
  if (path.dirname(resolved).toLowerCase() !== parent.toLowerCase() || !path.basename(resolved).startsWith('ragent-supervisor-pipe-')) {
    throw new Error('Refusing to remove unexpected test directory');
  }
  await rm(resolved, { recursive: true, force: true });
}
