import assert from 'node:assert/strict';
import { discoverWindowsWinget } from '../chat/windows-winget-discovery.mjs';

const expected = 'C:\\Program Files\\WindowsApps\\Microsoft.DesktopAppInstaller_1.29.250.0_x64__8wekyb3d8bbwe\\winget.exe';
const family = 'Microsoft.DesktopAppInstaller_8wekyb3d8bbwe';
let call;
const fixture = (data) => async (file, args, options) => {
  call = { file, args, options };
  return { stdout: JSON.stringify(data), stderr: '' };
};
const windows = { platform: 'win32', systemRoot: 'C:\\Windows', programFiles: 'C:\\Program Files' };
assert.equal(await discoverWindowsWinget({ ...windows, execFile: fixture({ executable: expected, family, signature: 'Valid' }) }), expected);
assert.equal(call.file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
assert.equal(call.options.shell, false);
assert.ok(call.args.includes('-NoProfile'));
// The sidecar's environment does not contain ProgramFiles. Discovery must
// use the OS known folder returned by the fixed PowerShell probe instead.
assert.equal(await discoverWindowsWinget({ ...windows, programFiles: '', execFile: fixture({ executable: expected, family, signature: 'Valid', programFiles: 'C:\\Program Files' }) }), expected);
assert.equal(await discoverWindowsWinget({ ...windows, programFiles: '', execFile: fixture({ executable: expected, family, signature: 'Valid', programFiles: 'C:\\Program Files (x86)', nativeProgramFiles: 'C:\\Program Files' }) }), expected);
await assert.rejects(discoverWindowsWinget({ ...windows, programFiles: '', execFile: fixture({ executable: expected, family, signature: 'Valid', programFiles: 'C:\\unrelated' }) }));
for (const unsafe of [
  { executable: 'C:\\evil\\winget.exe', family, signature: 'Valid' },
  { executable: expected, family: 'attacker', signature: 'Valid' },
  { executable: expected, family, signature: 'Invalid' },
]) await assert.rejects(discoverWindowsWinget({ ...windows, execFile: fixture(unsafe) }));
const otherDrive = 'D:\\WindowsApps\\Microsoft.DesktopAppInstaller_2.3.4.5_arm64__8wekyb3d8bbwe\\winget.exe';
assert.equal(await discoverWindowsWinget({ platform: 'win32', systemRoot: 'E:\\WinNT', programFiles: 'E:\\Programs', execFile: fixture({ executable: otherDrive, family, signature: 'Valid' }) }), otherDrive);
assert.equal(call.file, 'E:\\WinNT\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
assert.equal(call.options.cwd, 'E:\\WinNT\\System32');
{
  const prior = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, ProgramW6432: process.env.ProgramW6432, ProgramFiles: process.env.ProgramFiles };
  try {
    delete process.env.SystemRoot;
    process.env.WINDIR = 'E:\\WinNT';
    process.env.ProgramW6432 = 'F:\\Native Programs';
    process.env.ProgramFiles = 'F:\\Programs (x86)';
    const nativePath = 'F:\\Native Programs\\WindowsApps\\Microsoft.DesktopAppInstaller_1.2.3.4_x64__8wekyb3d8bbwe\\winget.exe';
    assert.equal(await discoverWindowsWinget({ platform: 'win32', execFile: fixture({ executable: nativePath, family, signature: 'Valid' }) }), nativePath);
    assert.equal(call.file, 'E:\\WinNT\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  } finally {
    for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}
await assert.rejects(discoverWindowsWinget({ platform: 'linux', execFile: fixture({ executable: expected, family, signature: 'Valid' }) }));
if (process.platform === 'win32' && process.env.RAGENT_TEST_INSTALLED_WINGET === '1') {
  assert.match(await discoverWindowsWinget({ programFiles: '' }), /\\winget\.exe$/i);
}
console.log('windows-winget-discovery: verified package identity checks passed');
