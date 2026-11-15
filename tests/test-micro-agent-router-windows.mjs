#!/usr/bin/env node

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { spawnChild } from '../scripts/micro-agent-router.mjs';

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  return child;
}

const calls = [];
const child = fakeChild();
const output = [];
const resultPromise = spawnChild(process.execPath, ['-e', 'process.exit(0)'], {
  platform: 'win32',
  onStdoutLine: (line) => output.push(line),
  spawnManagedImpl: async (spec, options) => {
    calls.push({ spec, options });
    child.__ragentWindowsManaged = true;
    child.__ragentWindowsJobObjectCreation = 'suspended-create-assign-resume';
    setTimeout(() => {
      child.stdout.emit('data', Buffer.from('managed-router-ok\n'));
      child.exitCode = 0;
      child.emit('close', 0, null);
    }, 0);
    return child;
  },
});

const result = await resultPromise;
assert.equal(result.code, 0);
assert.equal(result.timedOut, false);
assert.deepEqual(output, ['managed-router-ok']);
assert.equal(calls.length, 1);
assert.equal(calls[0].spec.file, process.execPath);
assert.deepEqual(calls[0].spec.args, ['-e', 'process.exit(0)']);
assert.equal(calls[0].spec.shell, false);
assert.deepEqual(calls[0].options, {
  stdio: ['ignore', 'pipe', 'pipe'],
  preserveOnControllerExit: false,
});
assert.equal(result.windowsJobObjectManaged, true);
assert.equal(result.windowsJobObjectCreation, 'suspended-create-assign-resume');

const posixCalls = [];
const posixChild = fakeChild();
const posixPromise = spawnChild(process.execPath, ['-e', 'process.exit(0)'], {
  platform: 'linux',
  spawnManagedImpl: async (spec, options) => {
    posixCalls.push({ spec, options });
    setTimeout(() => {
      posixChild.exitCode = 0;
      posixChild.emit('close', 0, null);
    }, 0);
    return posixChild;
  },
});
await posixPromise;
assert.equal(posixCalls[0].options.detached, true, 'POSIX micro-agent groups retain detached semantics');

console.log('test-micro-agent-router-windows: managed Windows and POSIX spawn contracts passed');
