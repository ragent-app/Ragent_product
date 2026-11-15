import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolveWindowsSystemPaths } from '../chat/windows-system-paths.mjs';
import { buildWindowsExecutorServerInvocation } from '../chat/windows-executor-server.mjs';
import { buildWindowsPipePeerInvocation } from '../chat/windows-named-pipe-peer-facts.mjs';

const paths = resolveWindowsSystemPaths({ SystemRoot: 'D:\\Operating Systems\\Windows' });
assert.equal(paths.system32, 'D:\\Operating Systems\\Windows\\System32');
assert.equal(paths.powershell, `${paths.system32}\\WindowsPowerShell\\v1.0\\powershell.exe`);
assert.equal(paths.env.PATH, `${paths.system32};${paths.root}`);
assert.equal(resolveWindowsSystemPaths({ WINDIR: 'E:\\Win' }).root, 'E:\\Win');
for (const value of ['', 'Windows', 'C:Windows', '\\\\server\\Windows']) {
  assert.equal(resolveWindowsSystemPaths({ SystemRoot: value }), null);
}
const executor = buildWindowsExecutorServerInvocation({ pipeName: 'test', powershellExecutable: paths.powershell, cwd: paths.system32, env: paths.env });
const peer = buildWindowsPipePeerInvocation({ powershellExecutable: paths.powershell, cwd: paths.system32, env: paths.env });
for (const invocation of [executor, peer]) {
  assert.equal(invocation.file, paths.powershell);
  assert.equal(invocation.cwd, paths.system32);
  assert.equal(invocation.env.SystemRoot, paths.root);
}
if (process.platform === 'win32') {
  const cleanEnv = { ...process.env };
  for (const key of Object.keys(cleanEnv)) if (['systemroot', 'windir', 'ragent_winget_executable', 'ragent_msiexec_executable'].includes(key.toLowerCase())) delete cleanEnv[key];
  const moduleUrl = new URL('../chat/semantic-windows-adapter.mjs', import.meta.url).href;
  const script = `delete process.env.SystemRoot; delete process.env.WINDIR; if (process.env.RAGENT_TEST_WINDOWS_ROOT) process.env.WINDIR = process.env.RAGENT_TEST_WINDOWS_ROOT; const m = await import(${JSON.stringify(moduleUrl)}); console.log(JSON.stringify([m.WINGET_EXECUTABLE, m.MSIEXEC_EXECUTABLE]));`;
  const missing = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: cleanEnv, encoding: 'utf8' }));
  assert.deepEqual(missing, ['', '']);
  const custom = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...cleanEnv, RAGENT_TEST_WINDOWS_ROOT: 'D:\\Operating Systems\\Windows' }, encoding: 'utf8' }));
  assert.deepEqual(custom, ['D:\\Operating Systems\\Windows\\System32\\winget.exe', 'D:\\Operating Systems\\Windows\\System32\\msiexec.exe']);
}
console.log('windows-system-paths: actual system root and non-C paths passed');
