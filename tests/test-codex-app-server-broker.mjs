#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import {
  codexAppServerBrokerSocketPath,
  buildCodexAppServerBrokerSocketPath,
  codexAppServerBrokerLockPath,
  ensureCodexAppServerBroker,
  spawnCodexAppServerProcess,
} from '../chat/codex-app-server-broker.mjs';
import { listCodexAppServerModels } from '../chat/codex-app-server-client.mjs';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let capturedSpawn = null;
const fakeProcess = { pid: 1234 };
const captured = await spawnCodexAppServerProcess({
  file: 'C:\\tools\\codex.cmd',
  args: ['app-server', '--stdio'],
  cwd: 'C:\\work',
  env: { PATH: 'C:\\bin' },
  windowsVerbatimArguments: true,
  spawnManagedImpl: async (spec, options) => {
    capturedSpawn = { spec, options };
    return fakeProcess;
  },
});
assert.equal(captured, fakeProcess);
assert.deepEqual(capturedSpawn, {
  spec: {
    file: 'C:\\tools\\codex.cmd',
    args: ['app-server', '--stdio'],
    cwd: 'C:\\work',
    env: { PATH: 'C:\\bin' },
    shell: false,
    windowsVerbatimArguments: true,
  },
  options: { stdio: ['pipe', 'pipe', 'ignore'] },
});
assert.match(buildCodexAppServerBrokerSocketPath('C:\\Users\\asus\\codex', { platform: 'win32' }), /^\\\\\.\\pipe\\agentoc-codex-[a-f0-9]{32}$/);
const longPosixSocketPath = buildCodexAppServerBrokerSocketPath(`/tmp/${'nested/'.repeat(20)}codex`, { platform: 'linux' });
assert.equal(Buffer.byteLength(longPosixSocketPath, 'utf8') <= 100, true);
assert.match(longPosixSocketPath, /agentoc-codex-[^-]+-[a-f0-9]{32}\.sock$/);
assert.match(
  codexAppServerBrokerLockPath('C:\\Users\\asus\\codex'),
  /C:\\Users\\asus\\codex[\\/]\.agentoc-codex-app-server\.lock$/,
);

const root = await mkdtemp(join(tmpdir(), 'agentoc-codex-broker-'));
const home = join(root, 'codex');
const fakeUpstreamPath = join(root, 'fake-upstream.mjs');
const socketPath = codexAppServerBrokerSocketPath(home);
const fakeUpstream = `
  let nextThread = 0;
  const approvals = new Map();
  let buffer = '';
  process.stdin.on('data', (chunk) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf('\\n')) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      let message; try { message = JSON.parse(line); } catch { continue; }
      if (!message.method && approvals.has(message.id)) {
        const threadId = approvals.get(message.id); approvals.delete(message.id);
        process.stdout.write(JSON.stringify({ method: 'approval/result', params: { threadId, decision: message.result.decision } }) + '\\n');
        continue;
      }
      if (message.method === 'initialize') {
        process.stdout.write(JSON.stringify({ id: message.id, result: { ok: true } }) + '\\n');
      } else if (message.method === 'model/list') {
        const cursor = message.params && message.params.cursor;
        const result = cursor === 'page-2'
          ? {
              data: [
                { id: 'gpt-5.6-sol', model: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol' },
                { id: 'hidden-model', model: 'hidden-model', displayName: 'Hidden', hidden: true },
              ],
              nextCursor: null,
            }
          : {
              data: [{
                id: 'gpt-6-astra',
                model: 'gpt-6-astra',
                displayName: 'GPT-6 Astra',
                defaultReasoningEffort: 'high',
                supportedReasoningEfforts: [
                  { reasoningEffort: 'low', description: 'Fast' },
                  { reasoningEffort: 'high', description: 'Deep' },
                ],
                inputModalities: ['text', 'image'],
                supportsPersonality: true,
                isDefault: true,
              }],
              nextCursor: 'page-2',
            };
        process.stdout.write(JSON.stringify({ id: message.id, result }) + '\\n');
      } else if (message.method === 'thread/start') {
        if (message.params.cwd === 'reject-thread') {
          setTimeout(() => process.stdout.write(JSON.stringify({ id: message.id, error: { code: -32001, message: 'fixture rejection' } }) + '\\n'), 50);
          continue;
        }
        const id = 'broker-thread-' + (++nextThread);
        // Without broker serialization the second request completes first,
        // exposing incorrect FIFO attribution of thread/started notifications.
        setTimeout(() => {
          process.stdout.write(JSON.stringify({ method: 'thread/started', params: { thread: { id } } }) + '\\n');
          process.stdout.write(JSON.stringify({ id: message.id, result: { thread: { id } } }) + '\\n');
        }, nextThread % 2 ? 150 : 5);
      } else if (message.method === 'turn/start') {
        if (message.params.input[0].text === 'approval') {
          // Server request ids may collide with pending client request ids.
          const approvalId = message.id;
          approvals.set(approvalId, message.params.threadId);
          process.stdout.write(JSON.stringify({ id: approvalId, method: 'item/commandExecution/requestApproval', params: { threadId: message.params.threadId } }) + '\\n');
          process.stdout.write(JSON.stringify({ id: message.id, result: { ok: true } }) + '\\n');
          continue;
        }
        process.stdout.write(JSON.stringify({ method: 'turn/started', params: { threadId: message.params.threadId } }) + '\\n');
        process.stdout.write(JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: message.params.threadId, delta: message.params.input[0].text } }) + '\\n');
        process.stdout.write(JSON.stringify({ method: 'turn/completed', params: { threadId: message.params.threadId, turn: { status: 'completed' } } }) + '\\n');
        process.stdout.write(JSON.stringify({ id: message.id, result: { ok: true } }) + '\\n');
      }
    }
  });
`;

async function removeEventually(path, attempts = 40) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

await writeFile(fakeUpstreamPath, fakeUpstream, 'utf8');

const broker = await ensureCodexAppServerBroker({
  socketPath,
  upstreamFile: process.execPath,
  upstreamArgs: [fakeUpstreamPath],
  cwd: projectRoot,
  env: { ...process.env, CODEX_HOME: home },
  lockPath: join(home, '.agentoc-codex-app-server.lock'),
});
assert.equal(broker.ok, true);

const catalog = await listCodexAppServerModels({
  codexHomeDir: home,
  upstreamFile: process.execPath,
  upstreamArgs: [fakeUpstreamPath],
  environment: { ...process.env, CODEX_HOME: home },
  pageSize: 1,
});
assert.deepEqual(catalog, [
  {
    id: 'gpt-6-astra',
    label: 'GPT-6 Astra',
    effortLevels: ['low', 'high'],
    defaultEffort: 'high',
    inputModalities: ['text', 'image'],
    supportsPersonality: true,
    isDefault: true,
  },
  {
    id: 'gpt-5.6-sol',
    label: 'GPT-5.6-Sol',
    effortLevels: [],
  },
]);

function startProxy() {
  const child = spawn(process.execPath, [
    join(projectRoot, 'chat', 'codex-app-server-proxy.mjs'),
    '--socket',
    socketPath,
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
  const reader = createInterface({ input: child.stdout });
  const queue = [];
  const waiters = [];
  reader.on('line', (line) => {
    const message = JSON.parse(line);
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else queue.push(message);
  });
  child.stderr.on('data', (chunk) => console.error(`[codex-proxy] ${String(chunk).trim()}`));
  child.on('error', (error) => console.error(`[codex-proxy-error] ${error.message}`));
  return {
    child,
    send(message) { child.stdin.write(`${JSON.stringify(message)}\n`); },
    next(timeoutMs = 10_000) {
      if (queue.length > 0) return Promise.resolve(queue.shift());
      return new Promise((resolve, reject) => {
        const waiter = (message) => {
          clearTimeout(timer);
          resolve(message);
        };
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`Codex proxy response timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref?.();
        waiters.push(waiter);
      });
    },
  };
}

async function runProxy(text) {
  const proxy = startProxy();
  proxy.send({ method: 'initialize', id: 0, params: {} });
  assert.equal((await proxy.next()).id, 0);
  proxy.send({ method: 'initialized' });
  proxy.send({ method: 'thread/start', id: 1, params: { cwd: root } });
  const first = await proxy.next();
  const second = await proxy.next();
  const threadId = first.method === 'thread/started'
    ? first.params.thread.id
    : second.result.thread.id;
  assert.equal(first.method === 'thread/started' ? second.result.thread.id : second.params.thread.id, threadId);
  assert.equal(threadId.startsWith('broker-thread-'), true);
  proxy.send({
    method: 'turn/start',
    id: 2,
    params: { threadId, input: [{ type: 'text', text }] },
  });
  const seen = [];
  while (seen.length < 3) seen.push(await proxy.next());
  assert.equal(seen.some((message) => message.method === 'item/agentMessage/delta'), true);
  assert.equal(seen.some((message) => message.method === 'turn/completed'), true);
  proxy.child.kill('SIGTERM');
}

await Promise.all([runProxy('one'), runProxy('two')]);

const rejected = startProxy();
const afterRejection = startProxy();
for (const proxy of [rejected, afterRejection]) proxy.send({ method: 'initialize', id: 0, params: {} });
await Promise.all([rejected.next(), afterRejection.next()]);
rejected.send({ method: 'thread/start', id: 1, params: { cwd: 'reject-thread' } });
afterRejection.send({ method: 'thread/start', id: 1, params: { cwd: root } });
assert.equal((await rejected.next()).error.message, 'fixture rejection');
const recoveredStart = [await afterRejection.next(), await afterRejection.next()];
assert.equal(recoveredStart.find((message) => message.method === 'thread/started').params.thread.id,
  recoveredStart.find((message) => message.result?.thread).result.thread.id);
rejected.child.kill('SIGTERM');
afterRejection.child.kill('SIGTERM');

async function startApprovalProxy() {
  const proxy = startProxy();
  proxy.send({ method: 'initialize', id: 0, params: {} });
  await proxy.next();
  proxy.send({ method: 'thread/start', id: 1, params: { cwd: root } });
  const messages = [await proxy.next(), await proxy.next()];
  const threadId = messages.find((message) => message.method === 'thread/started').params.thread.id;
  assert.equal(messages.find((message) => message.result?.thread)?.result.thread.id, threadId);
  return { proxy, threadId };
}

const [left, right] = await Promise.all([startApprovalProxy(), startApprovalProxy()]);
right.proxy.send({ method: 'turn/start', id: 99, params: { threadId: left.threadId, input: [{ type: 'text', text: 'approval' }] } });
assert.equal((await right.proxy.next()).error.code, -32004);
for (const item of [left, right]) item.proxy.send({ method: 'turn/start', id: 2, params: { threadId: item.threadId, input: [{ type: 'text', text: 'approval' }] } });
const [leftMessages, rightMessages] = await Promise.all([
  Promise.all([left.proxy.next(), left.proxy.next()]),
  Promise.all([right.proxy.next(), right.proxy.next()]),
]);
const leftRequest = leftMessages.find((message) => message.method === 'item/commandExecution/requestApproval');
const rightRequest = rightMessages.find((message) => message.method === 'item/commandExecution/requestApproval');
assert.equal(leftRequest.params.threadId, left.threadId);
assert.equal(rightRequest.params.threadId, right.threadId);
// A response from another client must not answer this thread's request.
right.proxy.send({ id: leftRequest.id, result: { decision: 'wrong-client' } });
left.proxy.send({ id: leftRequest.id, result: { decision: 'left' } });
right.proxy.send({ id: rightRequest.id, result: { decision: 'right' } });
const [leftResult, rightResult] = await Promise.all([left.proxy.next(), right.proxy.next()]);
assert.equal(leftResult.params.decision, 'left');
assert.equal(rightResult.params.decision, 'right');
left.proxy.child.kill('SIGTERM');
right.proxy.child.kill('SIGTERM');

// The broker is intentionally persistent across Runs; this test owns it and
// removes it explicitly so the detached child cannot outlive the test.
process.kill(broker.pid, 'SIGTERM');
await removeEventually(root);
console.log('test-codex-app-server-broker: same-provider concurrent threads share one upstream process');
