#!/usr/bin/env node
import assert from 'node:assert/strict';

import { collectWindowsRuntimeDiagnostics } from '../lib/windows-runtime-diagnostics.mjs';

const instanceRoot = 'C:\\Users\\Alice\\AppData\\Local\\Ragent\\instances\\owner';
const paths = {
  productRoot: 'C:\\Users\\Alice\\AppData\\Local\\Ragent',
  instanceRoot,
  configDir: `${instanceRoot}\\config`,
  dataDir: `${instanceRoot}\\data`,
  runtimeDir: `${instanceRoot}\\runtime`,
  spoolDir: `${instanceRoot}\\data\\chat-runs`,
  providerHomesDir: `${instanceRoot}\\provider-homes`,
  workspaceDir: `${instanceRoot}\\workspace`,
  instanceIdentityFile: `${instanceRoot}\\config\\instance-identity.json`,
  ownershipFile: `${instanceRoot}\\runtime\\instance-ownership.json`,
};
const secretDirectory = `${paths.configDir}\\native-provider-runtime\\secrets`;
const metadata = new Map([
  [paths.configDir + '\\auth.json', { type: 'file' }],
  [paths.instanceIdentityFile, { type: 'file' }],
  [paths.ownershipFile, { type: 'file' }],
  [secretDirectory, { type: 'directory' }],
]);
const calls = [];
const fakeInfo = (type) => ({
  isFile: () => type === 'file',
  isDirectory: () => type === 'directory',
  isSymbolicLink: () => type === 'symlink',
});

const report = await collectWindowsRuntimeDiagnostics({
  platform: 'win32',
  paths,
  identityLoader: async ({ filePath }) => {
    calls.push(`identity:${filePath}`);
    return { instanceId: 'inst_diagnostic', keyFingerprint: 'fingerprint-only' };
  },
  lstatImpl: async (filePath) => {
    calls.push(`lstat:${filePath}`);
    const entry = metadata.get(filePath);
    if (!entry) {
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    }
    return fakeInfo(entry.type);
  },
  readdirImpl: async (directory, options) => {
    calls.push(`readdir:${directory}:${options.withFileTypes}`);
    return [
      { name: 'secret-api.json', isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false },
      { name: 'unexpected-link.json', isFile: () => false, isDirectory: () => false, isSymbolicLink: () => true },
    ];
  },
  execFileImpl: async (file, args) => {
    calls.push(`exec:${file}:${args.join('|')}`);
    if (file === 'where.exe') {
      return { stdout: `C:\\Missing\\${args[0]}\r\nC:\\Tools\\${args[0]}\r\n`, stderr: '' };
    }
    if (file.startsWith('C:\\Missing')) throw Object.assign(new Error('not executable'), { code: 'ENOENT' });
    if (file === 'powershell.exe' && String(args.at(-1) || '').includes('Get-Service')) {
      return {
        stdout: JSON.stringify({
          installed: true,
          missing: [],
          states: {
            'Ragent-RunnerSupervisor': 'Running',
            'Ragent-ControlPlane': 'Running',
          },
        }),
        stderr: '',
      };
    }
    if (file === 'powershell.exe') return { stdout: '5.1.22621.4391\r\n', stderr: '' };
    if (file === process.execPath) return { stdout: 'v24.12.0\n', stderr: '' };
    return { stdout: 'tool-version\n', stderr: '' };
  },
});

assert.equal(report.status, 'ready');
assert.equal(report.identity.status, 'loaded');
assert.equal(report.identity.instanceId, 'inst_diagnostic');
assert.equal(report.endpoint.status, 'derived');
assert.equal(report.endpoint.transport, 'named-pipe');
assert.match(report.endpoint.name, /^\\\\\.\\pipe\\ragent-[0-9a-f-]+$/);
assert.deepEqual(report.files.auth, { path: `${paths.configDir}\\auth.json`, exists: true, type: 'file' });
assert.deepEqual(report.files.secretEntries, [
  { name: 'secret-api.json', type: 'file' },
  { name: 'unexpected-link.json', type: 'symlink' },
]);
assert.ok(calls.some((call) => call.startsWith('lstat:')));
assert.ok(calls.some((call) => call.startsWith('readdir:')));
assert.ok(calls.some((call) => call.startsWith('exec:')));
assert.equal(calls.some((call) => call.startsWith('read:')), false);
assert.equal(report.tools.node.status, 'ready');
assert.equal(report.tools.powershell.version, '5.1.22621.4391');
assert.equal(report.tools.providers.claude.status, 'ready');
assert.equal(report.tools.providers.codex.path, 'C:\\Tools\\codex');

const missing = await collectWindowsRuntimeDiagnostics({
  platform: 'win32',
  paths,
  identityLoader: async () => null,
  lstatImpl: async () => {
    const error = new Error('missing');
    error.code = 'ENOENT';
    throw error;
  },
  execFileImpl: async () => ({ stdout: '', stderr: '' }),
});
assert.equal(missing.status, 'degraded');
assert.equal(missing.identity.status, 'missing');
assert.deepEqual(missing.endpoint, { status: 'unavailable', reason: 'instance-identity-missing' });

const offWindows = await collectWindowsRuntimeDiagnostics({ platform: 'linux' });
assert.equal(offWindows.supported, false);
assert.equal(offWindows.status, 'unsupported');

const serviceReport = await collectWindowsRuntimeDiagnostics({
  platform: 'win32',
  scope: 'service',
  env: {
    ProgramData: 'C:\\ProgramData',
    LOCALAPPDATA: 'C:\\Users\\Alice\\AppData\\Local',
    RAGENT_INSTANCE_ROOT: 'C:\\Users\\Alice\\wrong-instance',
    RAGENT_RUN_SPOOL_DIR: 'C:\\Users\\Alice\\wrong-instance\\data\\chat-runs',
  },
  identityLoader: async ({ filePath }) => {
    assert.equal(filePath, 'C:\\ProgramData\\Ragent\\instances\\owner\\config\\instance-identity.json');
    return { instanceId: 'inst_service_diagnostic' };
  },
  lstatImpl: async () => {
    const error = new Error('missing');
    error.code = 'ENOENT';
    throw error;
  },
  execFileImpl: async (file, args) => {
    if (file === 'powershell.exe' && String(args.at(-1) || '').includes('Get-Service')) {
      return {
        stdout: JSON.stringify({
          installed: true,
          missing: [],
          states: {
            'Ragent-RunnerSupervisor': 'Running',
            'Ragent-ControlPlane': 'Running',
          },
        }),
        stderr: '',
      };
    }
    return { stdout: 'tool-version\n', stderr: '' };
  },
});
assert.equal(serviceReport.scope, 'service');
assert.equal(serviceReport.status, 'ready');
assert.equal(serviceReport.services.status, 'ready');
assert.equal(serviceReport.services.states['Ragent-ControlPlane'], 'Running');
assert.equal(serviceReport.paths.productRoot, 'C:\\ProgramData\\Ragent');
assert.equal(serviceReport.paths.instanceRoot, 'C:\\ProgramData\\Ragent\\instances\\owner');
assert.match(serviceReport.endpoint.name, /^\\\\\.\\pipe\\ragent-/);

const stoppedServiceReport = await collectWindowsRuntimeDiagnostics({
  platform: 'win32',
  scope: 'service',
  paths: serviceReport.paths,
  identityLoader: async () => ({ instanceId: 'inst_service_diagnostic' }),
  lstatImpl: async () => {
    const error = new Error('missing');
    error.code = 'ENOENT';
    throw error;
  },
  execFileImpl: async (file, args) => {
    if (file === 'powershell.exe' && String(args.at(-1) || '').includes('Get-Service')) {
      return {
        stdout: JSON.stringify({
          installed: true,
          missing: [],
          states: {
            'Ragent-RunnerSupervisor': 'Running',
            'Ragent-ControlPlane': 'Stopped',
          },
        }),
        stderr: '',
      };
    }
    return { stdout: 'tool-version\n', stderr: '' };
  },
});
assert.equal(stoppedServiceReport.status, 'degraded');
assert.equal(stoppedServiceReport.services.status, 'degraded');

const missingServiceReport = await collectWindowsRuntimeDiagnostics({
  platform: 'win32',
  scope: 'service',
  paths: serviceReport.paths,
  identityLoader: async () => ({ instanceId: 'inst_service_diagnostic' }),
  lstatImpl: async () => {
    const error = new Error('missing');
    error.code = 'ENOENT';
    throw error;
  },
  execFileImpl: async (file, args) => {
    if (file === 'powershell.exe' && String(args.at(-1) || '').includes('Get-Service')) {
      return {
        stdout: JSON.stringify({
          installed: false,
          missing: ['Ragent-RunnerSupervisor', 'Ragent-ControlPlane'],
          states: {},
        }),
        stderr: '',
      };
    }
    return { stdout: 'tool-version\n', stderr: '' };
  },
});
assert.equal(missingServiceReport.status, 'degraded');
assert.equal(missingServiceReport.services.status, 'missing');
assert.deepEqual(missingServiceReport.services.missing, [
  'Ragent-RunnerSupervisor',
  'Ragent-ControlPlane',
]);

const invalidScope = await collectWindowsRuntimeDiagnostics({ platform: 'win32', scope: 'machine' });
assert.equal(invalidScope.status, 'invalid');
assert.equal(invalidScope.error.code, 'WINDOWS_DIAGNOSTICS_SCOPE_INVALID');

console.log('test-windows-runtime-diagnostics: ok');
