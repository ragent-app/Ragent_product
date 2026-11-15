#!/usr/bin/env node

import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildShellArgs,
  defaultShellForPlatform,
  runProcess,
} from '../scripts/doubao-fast-agent.mjs';

assert.equal(
  defaultShellForPlatform('win32'),
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
);
assert.equal(defaultShellForPlatform('darwin'), '/bin/zsh');
assert.equal(defaultShellForPlatform('linux'), '/bin/bash');

assert.deepEqual(
  buildShellArgs(
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    'Write-Output "hello"',
    'win32',
  ),
  ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'Write-Output "hello"'],
);
assert.deepEqual(
  buildShellArgs('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', 'Get-Date', 'win32'),
  ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'Get-Date'],
);
assert.deepEqual(
  buildShellArgs('C:\\Windows\\System32\\cmd.exe', 'echo hello', 'win32'),
  ['/d', '/s', '/c', 'echo hello'],
);
assert.deepEqual(
  buildShellArgs('C:\\Program Files\\Git\\bin\\bash.exe', 'printf hello', 'win32'),
  ['-lc', 'printf hello'],
);
assert.deepEqual(buildShellArgs('/bin/bash', 'printf hello', 'linux'), ['-lc', 'printf hello']);

const fixtureDir = mkdtempSync(join(tmpdir(), 'ragent-doubao-platform-'));
try {
  const fakeExecutable = join(fixtureDir, 'fake-agent');
  writeFileSync(
    fakeExecutable,
    '#!/bin/sh\nprintf \'argv=%s|%s\\n\' "$1" "$2"\nprintf \'cwd=%s\\n\' "$PWD"\n',
    'utf8',
  );
  chmodSync(fakeExecutable, 0o755);

  const result = await runProcess(fakeExecutable, ['hello world', 'second'], {
    cwd: fixtureDir,
    timeoutMs: 2_000,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);
  assert.equal(result.error, null);
  assert.match(result.stdout, /argv=hello world\|second/);
  assert.match(result.stdout, new RegExp(`cwd=${fixtureDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));

  const stdinExecutable = join(fixtureDir, 'fake-stdin');
  writeFileSync(stdinExecutable, '#!/bin/sh\ncat\n', 'utf8');
  chmodSync(stdinExecutable, 0o755);
  const stdinResult = await runProcess(stdinExecutable, [], {
    cwd: fixtureDir,
    stdin: 'doubao-stdin-check\n',
    timeoutMs: 2_000,
  });
  assert.equal(stdinResult.exitCode, 0);
  assert.equal(stdinResult.stdout, 'doubao-stdin-check\n');
} finally {
  rmSync(fixtureDir, { recursive: true, force: true });
}

console.log('test-doubao-fast-agent-platform: platform shell and runProcess contract OK');
