#!/usr/bin/env node
import assert from 'node:assert/strict';

import { formatDoctorText, runDoctorCommand } from '../lib/doctor-command.mjs';

const report = {
  version: 'windows-runtime-diagnostics/v1',
  platform: 'win32',
  supported: true,
  status: 'ready',
  identity: { status: 'loaded', instanceId: 'inst_doctor' },
  endpoint: { status: 'derived', name: '\\\\.\\pipe\\agentoc-doctor' },
  services: {
    status: 'ready',
    states: {
      'AgentoC-RunnerSupervisor': 'Running',
      'AgentoC-ControlPlane': 'Running',
    },
  },
  tools: {
    node: { status: 'ready', version: 'v24.12.0' },
    powershell: { status: 'ready', version: '5.1.22621.4391' },
    git: { status: 'missing' },
    providers: {
      claude: { status: 'ready', version: '2.1.233' },
      codex: { status: 'unavailable' },
    },
  },
};

const text = formatDoctorText(report);
assert.match(text, /Ragent doctor: ready \(win32\)/);
assert.match(text, /endpoint: derived/);
assert.match(text, /services: ready/);
assert.match(text, /service\.AgentoC-ControlPlane: Running/);
assert.match(text, /node: ready v24\.12\.0/);
assert.match(text, /provider\.claude: ready 2\.1\.233/);

let output = '';
const exitCode = await runDoctorCommand(['--json'], {
  platform: 'win32',
  env: {},
  diagnosticsImpl: async () => report,
  writer: (value) => { output += value; },
});
assert.equal(exitCode, 0);
assert.deepEqual(JSON.parse(output), report);

output = '';
const unsupportedCode = await runDoctorCommand([], {
  platform: 'linux',
  diagnosticsImpl: async () => ({ platform: 'linux', supported: false, status: 'unsupported' }),
  writer: (value) => { output += value; },
});
assert.equal(unsupportedCode, 0);
assert.match(output, /not applicable/);

output = '';
const failedCode = await runDoctorCommand(['--json'], {
  platform: 'win32',
  diagnosticsImpl: async () => { throw Object.assign(new Error('fixture failure'), { code: 'FIXTURE_FAILURE' }); },
  writer: (value) => { output += value; },
});
assert.equal(failedCode, 2);
assert.equal(JSON.parse(output).error.code, 'FIXTURE_FAILURE');

output = '';
let capturedScope = null;
const serviceCode = await runDoctorCommand(['--service', '--json'], {
  platform: 'win32',
  env: { ProgramData: 'C:\\ProgramData' },
  diagnosticsImpl: async (options) => {
    capturedScope = options.scope;
    return { platform: 'win32', supported: true, status: 'degraded', scope: options.scope };
  },
  writer: (value) => { output += value; },
});
assert.equal(serviceCode, 0);
assert.equal(capturedScope, 'service');
assert.equal(JSON.parse(output).scope, 'service');

output = '';
const helpCode = await runDoctorCommand(['--help'], { writer: (value) => { output += value; } });
assert.equal(helpCode, 0);
assert.match(output, /doctor --service/);

console.log('test-doctor-command: ok');
