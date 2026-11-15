#!/usr/bin/env node
import assert from 'node:assert/strict';

import {
  buildFallbackPathEntries,
  buildShellEnvDumpCommand,
  defaultShellForPlatform,
  finalizeShellSnapshot,
  parseEnvDump,
  pickShellExecutable,
} from '../lib/user-shell-env.mjs';

const winEnv = {
  USERPROFILE: 'C:\\Users\\Alice',
  LOCALAPPDATA: 'C:\\Users\\Alice\\AppData\\Local',
  SystemRoot: 'D:\\Windows',
  PATH: 'C:\\custom',
};

assert.equal(
  defaultShellForPlatform('win32', { env: winEnv }),
  'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
);
assert.equal(defaultShellForPlatform('win32', { env: {} }), 'powershell.exe');
assert.equal(defaultShellForPlatform('linux'), '/bin/bash');

const fallback = buildFallbackPathEntries(winEnv, { platform: 'win32' });
assert.ok(fallback.includes('C:\\Users\\Alice\\AppData\\Roaming\\npm'));
assert.ok(fallback.includes('C:\\Users\\Alice\\AppData\\Local\\Microsoft\\WindowsApps'));
assert.ok(fallback.includes('D:\\Windows\\System32\\WindowsPowerShell\\v1.0'));
assert.ok(!fallback.some((entry) => entry.startsWith('/usr/')));
assert.ok(!buildFallbackPathEntries({ USERPROFILE: 'E:\\Users\\Alice' }, { platform: 'win32' }).some((entry) => /^C:\\Windows/i.test(entry) || entry === 'System32'));

const powershellCommand = buildShellEnvDumpCommand({ platform: 'win32' });
assert.match(powershellCommand, /Get-ChildItem Env:/);
assert.match(powershellCommand, /\[char\]0/);
assert.doesNotMatch(powershellCommand, /env -0/);

const start = '__RAGENT_SHELL_ENV_START__';
const end = '__RAGENT_SHELL_ENV_END__';
const parsed = parseEnvDump(
  `${start}\0Path=C:\\profile-bin\0RAGENT_TEST_FLAG=from-powershell\0${end}\0`,
  { platform: 'win32' },
);
assert.deepEqual(parsed, {
  PATH: 'C:\\profile-bin',
  RAGENT_TEST_FLAG: 'from-powershell',
});

const snapshot = finalizeShellSnapshot(
  { shell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', env: parsed },
  defaultShellForPlatform('win32'),
  { platform: 'win32' },
);
assert.equal(snapshot.env.PATH, 'C:\\profile-bin');
assert.ok(snapshot.fullPath.split(';').includes('C:\\profile-bin'));

const selected = await pickShellExecutable({
  platform: 'win32',
  env: { RAGENT_USER_SHELL: 'C:\\missing\\shell.exe', SHELL: '/bin/bash', SystemRoot: 'D:\\Windows' },
  pathExistsImpl: async (candidate) => candidate === 'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
});
assert.equal(selected, defaultShellForPlatform('win32', { env: winEnv }));

console.log('test-windows-shell-env: Windows PowerShell shell discovery and PATH contract OK');
