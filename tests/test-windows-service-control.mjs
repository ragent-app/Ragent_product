#!/usr/bin/env node
import assert from 'node:assert/strict';

import {
  buildWindowsServicePowerShell,
  resolveWindowsServiceNames,
  runWindowsServiceLifecycle,
} from '../lib/windows-service-control.mjs';

assert.deepEqual(resolveWindowsServiceNames('all'), [
  'Ragent-RunnerSupervisor',
  'Ragent-ControlPlane',
]);
assert.deepEqual(resolveWindowsServiceNames('chat'), [
  'Ragent-RunnerSupervisor',
  'Ragent-ControlPlane',
]);
assert.deepEqual(resolveWindowsServiceNames('control'), ['Ragent-ControlPlane']);
assert.deepEqual(resolveWindowsServiceNames('runner-supervisor'), ['Ragent-RunnerSupervisor']);
assert.throws(
  () => resolveWindowsServiceNames('tunnel'),
  (error) => error.code === 'WINDOWS_SERVICE_NOT_AVAILABLE',
);
assert.throws(
  () => resolveWindowsServiceNames('Ragent-ControlPlane; Remove-Item C:\\'),
  (error) => error.code === 'WINDOWS_SERVICE_UNKNOWN',
);

const start = buildWindowsServicePowerShell('start', 'all');
assert.match(start, /Start-Service -Name \$name/);
assert.match(start, /Ragent-RunnerSupervisor.*Ragent-ControlPlane/);
assert.match(start, /\$deadline = \(Get-Date\)\.ToUniversalTime\(\)\.AddSeconds\(30\)/);
assert.match(start, /\$service\.Refresh\(\)/);
assert.doesNotMatch(start, /bash|systemctl|cmd\.exe/);

const restartControl = buildWindowsServicePowerShell('restart', 'control');
assert.match(restartControl, /Stop-Service/);
assert.match(restartControl, /Start-Service/);
assert.match(restartControl, /Ragent-ControlPlane/);
assert.doesNotMatch(restartControl, /Ragent-RunnerSupervisor/);

let captured = null;
await runWindowsServiceLifecycle({
  action: 'stop',
  service: 'supervisor',
  platform: 'win32',
  powershellPath: 'powershell-fixture.exe',
  spawnFileImpl: async (command, args) => { captured = { command, args }; },
});
assert.equal(captured.command, 'powershell-fixture.exe');
assert.deepEqual(captured.args.slice(0, 6), [
  '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
]);
assert.match(captured.args[6], /Ragent-RunnerSupervisor/);

await assert.rejects(
  runWindowsServiceLifecycle({ action: 'start', platform: 'linux', spawnFileImpl: async () => {} }),
  (error) => error.code === 'WINDOWS_SERVICE_PLATFORM_REQUIRED',
);

console.log('test-windows-service-control: ok');
