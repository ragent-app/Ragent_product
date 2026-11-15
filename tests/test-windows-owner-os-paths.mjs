import assert from 'node:assert/strict';
import { resolveOwnerWindowsOsPaths } from '../lib/windows-owner-os-paths.mjs';
import { ownerLayoutForOs, ownerInstallRootFromModule } from '../lib/windows-owner-discovery.mjs';

const windows = 'D:\\Operating Systems\\Windows';
const programData = 'E:\\Shared Data';
const programFiles = 'F:\\Applications';
const programFilesX86 = 'H:\\Applications 32';
let invocation;
const output = (...values) => values.map(value => Buffer.from(value).toString('base64')).join('\r\n') + '\r\n';
const resolve = overrides => resolveOwnerWindowsOsPaths({ platform: 'win32',
  realpath: name => { assert.equal(name, String.raw`\\?\GLOBALROOT\SystemRoot`); return windows; },
  run: (executable, args, options) => { invocation = { executable, args, options }; return { status: 0, stdout: output(windows, programData, programFiles, programFilesX86) }; },
  ...overrides });
const paths = resolve();
assert.deepEqual(paths, { windows, programData, programFiles, programFilesX86, powershell: `${windows}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` });
assert.deepEqual(ownerLayoutForOs(paths), { instanceRoot: 'E:/Shared Data/Ragent/instances/owner', root: 'F:/Applications/Ragent' });
assert.deepEqual(ownerLayoutForOs(paths, 'G:\\Installed App'), { instanceRoot: 'E:/Shared Data/Ragent/instances/owner', root: 'G:/Installed App' });
assert.deepEqual(ownerLayoutForOs(null), { instanceRoot: '', root: '' });
assert.equal(ownerInstallRootFromModule('G:\\Installed App\\payload\\lib\\windows-owner-discovery.mjs'), 'G:\\Installed App');
for (const invalid of ['G:\\source\\lib\\windows-owner-discovery.mjs', 'G:\\payload\\lib\\windows-owner-discovery.mjs', String.raw`\\server\app\payload\lib\windows-owner-discovery.mjs`, 'relative\\payload\\lib\\windows-owner-discovery.mjs']) {
  assert.equal(ownerInstallRootFromModule(invalid), '', invalid);
}
assert.equal(invocation.executable, paths.powershell);
assert.deepEqual(invocation.options.env, { SystemRoot: windows, WINDIR: windows, SystemDrive: 'D:' });
assert.ok(invocation.args.includes('-NoProfile') && invocation.args.includes('-EncodedCommand'));
const script = Buffer.from(invocation.args.at(-1), 'base64').toString('utf16le');
assert.match(script, /GetFolderPath/);
assert.doesNotMatch(script, /ConvertTo-Json|Import-Module|Get-Command/);
for (const raw of ['D:relative', String.raw`\\server\windows`, 'D:\\', 'D:\\Win:stream']) {
  assert.equal(resolve({ realpath: () => raw }), null, raw);
}
assert.equal(resolve({ realpath: () => { throw new Error('unavailable'); } }), null);
for (const result of [
  { status: 1, stdout: '' }, { status: 0, stdout: '{}' },
  { status: 0, stdout: output('C:\\Windows', programData, programFiles, programFilesX86) },
  { status: 0, stdout: output(windows, String.raw`\\server\share`, programFiles, programFilesX86) },
  { status: 0, stdout: output(windows, programData, programFiles, programFilesX86, 'extra') },
  { status: 0, stdout: output(windows, 'E:\\folder\\..\\other', programFiles, programFilesX86) },
  { status: 0, stdout: output(windows, programData, programFiles, String.raw`\\server\share`) },
  { status: 0, stdout: 'x'.repeat(8193) },
]) assert.equal(resolve({ run: () => result }), null);
assert.equal(resolve({ run: () => ({ error: new Error('timeout'), status: null, stdout: '' }) }), null);
assert.equal(resolve({ run: () => ({ status: 0, stdout: output(windows, 'E:\\共享 数据', programFiles, programFilesX86) }) }).programData, 'E:\\共享 数据');
assert.equal(resolve({ run: () => ({ status: 0, stdout: output(windows, programData, programFiles) + '-\r\n' }) }).programFilesX86, '');
assert.equal(resolve({ run: () => ({ status: 0, stdout: output(windows, programData, programFiles, programFiles) }) }).programFilesX86, programFiles);

if (process.platform === 'win32') {
  const actual = resolveOwnerWindowsOsPaths();
  assert.ok(actual, 'real Windows system and known-folder query must succeed');
  const previous = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, ProgramData: process.env.ProgramData, ProgramFiles: process.env.ProgramFiles };
  try {
    Object.assign(process.env, { SystemRoot: 'Z:\\untrusted', WINDIR: 'Z:\\untrusted', ProgramData: 'Z:\\untrusted', ProgramFiles: 'Z:\\untrusted' });
    assert.deepEqual(resolveOwnerWindowsOsPaths(), actual, 'caller environment cannot select trusted OS paths');
  } finally {
    for (const [name, value] of Object.entries(previous)) value === undefined ? delete process.env[name] : process.env[name] = value;
  }
}
console.log('windows-owner-os-paths: OS roots, non-C fixtures and environment isolation passed');
