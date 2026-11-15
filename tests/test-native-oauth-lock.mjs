#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  acquireNativeOAuthLock,
  adoptNativeOAuthLock,
  nativeOAuthLockPath,
} from '../lib/provider-runtime/oauth-lock.mjs';

function waitForLine(stream, expected) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk.toString();
      if (!buffer.includes(expected)) return;
      cleanup();
      resolve();
    };
    const onEnd = () => {
      cleanup();
      reject(new Error(`Child exited before writing ${expected}`));
    };
    const cleanup = () => {
      stream.off('data', onData);
      stream.off('end', onEnd);
    };
    stream.on('data', onData);
    stream.once('end', onEnd);
  });
}

function waitForExit(child) {
  return new Promise((resolve) => {
    const onExit = (code, signal) => {
      child.off('exit', onExit);
      resolve({ code, signal });
    };
    child.once('exit', onExit);
    if (child.exitCode !== null || child.signalCode !== null) {
      child.off('exit', onExit);
      resolve({ code: child.exitCode, signal: child.signalCode });
    }
  });
}

async function pathExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

const root = await mkdtemp(join(tmpdir(), 'ragent-native-oauth-lock-'));
const providerHome = join(root, 'provider-home');
const lockPath = nativeOAuthLockPath(providerHome);
const moduleUrl = pathToFileURL(join(process.cwd(), 'lib/provider-runtime/oauth-lock.mjs')).href;
let holder = null;

try {
  const holderScript = [
    `import { acquireNativeOAuthLock } from ${JSON.stringify(moduleUrl)};`,
    `const handle = await acquireNativeOAuthLock(${JSON.stringify(lockPath)}, { token: 'holder-token' });`,
    `process.stdout.write('locked\\n');`,
    'setTimeout(() => {}, 60_000);',
  ].join('\n');
  holder = spawn(process.execPath, ['--input-type=module', '-e', holderScript], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForLine(holder.stdout, 'locked');
  const owner = JSON.parse(await readFile(lockPath, 'utf8'));
  assert.equal(owner.pid, holder.pid, 'cross-process lock owner should be the holder process');

  const waitingStartedAt = Date.now();
  const waiting = acquireNativeOAuthLock(lockPath, {
    token: 'waiting-token',
    waitMs: 2_000,
    pollMs: 10,
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  holder.kill('SIGKILL');
  const holderExit = await waitForExit(holder);
  assert.equal(holderExit.signal, 'SIGKILL');
  holder = null;
  const waitingHandle = await waiting;
  assert.ok(Date.now() - waitingStartedAt < 2_000, 'dead holder should be reclaimed before timeout');
  await waitingHandle.release();
  assert.equal(await pathExists(lockPath), false, 'reclaimed lock should be released by the new owner');

  const handoff = await acquireNativeOAuthLock(lockPath, { token: 'handoff-token' });
  const adopted = await adoptNativeOAuthLock(handoff.path, handoff.token, { pid: process.pid });
  const adoptedOwner = JSON.parse(await readFile(lockPath, 'utf8'));
  assert.equal(adoptedOwner.pid, process.pid, 'sidecar adoption should transfer the owner PID');
  await adopted.release();
  await handoff.release();
  assert.equal(await pathExists(lockPath), false, 'adopted lock should be released exactly once');

  await writeFile(lockPath, JSON.stringify({
    version: 1,
    token: 'stale-token',
    pid: 2_147_483_647,
  }) + '\n');
  const staleHandle = await acquireNativeOAuthLock(lockPath, {
    token: 'fresh-token',
    waitMs: 500,
    pollMs: 10,
  });
  await staleHandle.release();
  assert.equal(await pathExists(lockPath), false, 'dead PID lock should be reclaimed');
} finally {
  if (holder) {
    holder.kill('SIGKILL');
    await waitForExit(holder);
  }
  await rm(root, { recursive: true, force: true });
}

console.log('test-native-oauth-lock: cross-process wait, handoff, and crash recovery OK');
