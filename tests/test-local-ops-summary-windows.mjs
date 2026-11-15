#!/usr/bin/env node

import assert from 'node:assert/strict';

import {
  collectChatServerProcesses,
  collectHostMetrics,
  discoverChatServerServices,
  parseWindowsHostMetrics,
  parseWindowsProcessSnapshot,
} from '../lib/local-ops-summary.mjs';

const parsedHost = parseWindowsHostMetrics(JSON.stringify({
  systemDrive: 'D:',
  cpuLoadPercent: 25,
  totalMemoryBytes: 16 * 1024 ** 3,
  freeMemoryBytes: 4 * 1024 ** 3,
  diskTotalBytes: 500 * 1024 ** 3,
  diskFreeBytes: 125 * 1024 ** 3,
}), { cpuCount: 8 });
assert.deepEqual(parsedHost, {
  cpuLoadPercent: 25,
  totalMemoryBytes: 16 * 1024 ** 3,
  freeMemoryBytes: 4 * 1024 ** 3,
  diskPath: 'D:\\',
  diskTotalBytes: 500 * 1024 ** 3,
  diskUsedBytes: 375 * 1024 ** 3,
  diskAvailableBytes: 125 * 1024 ** 3,
  loadAvg: { one: 2, five: 2, fifteen: 2 },
});
assert.equal(parseWindowsHostMetrics('not-json'), null);

const nowMs = Date.parse('2026-09-04T08:00:00.000Z');
const parsedProcess = parseWindowsProcessSnapshot(JSON.stringify({
  processId: 4321,
  name: 'node',
  commandLine: 'node chat-server.mjs',
  workingSetBytes: 64 * 1024 ** 2,
  startTime: '2026-09-04T07:00:00.000Z',
}), 4321, { nowMs });
assert.equal(parsedProcess.pid, 4321);
assert.equal(parsedProcess.rssBytes, 64 * 1024 ** 2);
assert.equal(parsedProcess.command, 'node chat-server.mjs');
assert.equal(parsedProcess.elapsed, '01:00:00');

const calls = [];
const execFileImpl = async (command, args, options) => {
  calls.push({ command, args, options });
  const script = String(args.at(-1) || '');
  if (script.includes('Win32_OperatingSystem')) {
    return {
      stdout: JSON.stringify({
        systemDrive: 'C:',
        cpuLoadPercent: 10,
        totalMemoryBytes: 32 * 1024 ** 3,
        freeMemoryBytes: 24 * 1024 ** 3,
        diskTotalBytes: 1_000 * 1024 ** 3,
        diskFreeBytes: 800 * 1024 ** 3,
      }),
    };
  }
  if (script.includes('Get-NetTCPConnection')) return { stdout: '4321\r\n' };
  if (script.includes('Win32_Process')) {
    return {
      stdout: JSON.stringify({
        processId: 4321,
        name: 'node',
        commandLine: 'node chat-server.mjs',
        workingSetBytes: 128 * 1024 ** 2,
        startTime: '2026-09-04T07:00:00.000Z',
      }),
    };
  }
  throw new Error(`unexpected command: ${command}`);
};

const metrics = await collectHostMetrics({ platform: 'win32', execFileImpl });
assert.equal(metrics.platform, 'win32');
assert.equal(metrics.cpuUserPercent, 10);
assert.equal(metrics.cpuIdlePercent, 90);
assert.equal(metrics.totalMemoryBytes, 32 * 1024 ** 3);
assert.equal(metrics.diskPath, 'C:\\');
assert.equal(metrics.diskAvailableBytes, 800 * 1024 ** 3);
assert.match(String(calls[0].args.at(-1)), /@\{\n/);
assert.doesNotMatch(String(calls[0].args.at(-1)), /@\{;/);

const services = await discoverChatServerServices({ platform: 'win32', homeDir: 'C:\\Users\\Alice' });
assert.deepEqual(services.map(({ name, label, port, kind }) => ({ name, label, port, kind })), [{
  name: 'owner',
  label: 'Ragent-ControlPlane',
  port: 7690,
  kind: 'owner',
}]);

const processReport = await collectChatServerProcesses({
  platform: 'win32',
  execFileImpl,
  services: [{
    name: 'owner',
    label: 'Ragent-ControlPlane',
    kind: 'owner',
    port: 7690,
  }],
});
assert.equal(processReport.runningCount, 1);
assert.equal(processReport.chatServers[0].pid, 4321);
assert.equal(processReport.chatServers[0].rssBytes, 128 * 1024 ** 2);
assert.equal(processReport.chatServers[0].command, 'node chat-server.mjs');
assert.match(String(calls[2].args.at(-1)), /@\{\n/);
assert.doesNotMatch(String(calls[2].args.at(-1)), /@\{;/);
assert.ok(calls.every((call) => call.command === 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'));

console.log('test-local-ops-summary-windows: Windows host and service probes OK');
