// Native macOS integration test. Run with a private copy of Node whose sibling
// is the freshly built ragent-macos-run-cleanup helper.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { connect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { codexAppServerBrokerSocketPath, ensureCodexAppServerBroker } from '../chat/codex-app-server-broker.mjs';

test('macOS broker interrupts only the tagged child with a captured service identity',
  { skip: process.platform !== 'darwin', timeout: 30000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'ragent-mac-broker-cleanup-'));
    const home = join(root, 'codex');
    const upstream = join(root, 'fake-upstream.mjs');
    const socketPath = codexAppServerBrokerSocketPath(home);
    let broker;
    const clients = [];
    await writeFile(upstream, `
      import { spawn } from 'node:child_process';
      import { createInterface } from 'node:readline';
      const children = [];
      process.on('SIGTERM', () => { for (const child of children) child.kill('SIGKILL'); process.exit(0); });
      createInterface({ input: process.stdin }).on('line', line => {
        const request = JSON.parse(line);
        if (request.method === 'initialize') {
          process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + '\\n');
        } else if (request.method === 'thread/start') {
          const tag = request.params.config.shell_environment_policy.set.AGENTOC_RUN_ID;
          const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
            { env: { ...process.env, AGENTOC_RUN_ID: tag }, stdio: 'ignore' });
          children.push(child);
          process.stdout.write(JSON.stringify({ id: request.id, result: { thread: { id: tag }, pid: child.pid } }) + '\\n');
        } else if (request.method === 'turn/interrupt') {
          process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + '\\n');
        }
      });
    `);
    const openClient = async () => {
      const socket = connect(socketPath);
      await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
      const queue = [], waiters = [];
      createInterface({ input: socket }).on('line', line => {
        const item = JSON.parse(line), waiter = waiters.shift();
        if (waiter) waiter(item); else queue.push(item);
      });
      clients.push(socket);
      return {
        send: (value) => socket.write(`${JSON.stringify(value)}\n`),
        next: async () => queue.length ? queue.shift() : new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('broker response timeout')), 5000);
          timer.unref();
          waiters.push((value) => { clearTimeout(timer); resolve(value); });
        }),
      };
    };
    const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
    try {
      broker = await ensureCodexAppServerBroker({ socketPath, upstreamFile: process.execPath, upstreamArgs: [upstream],
        cwd: root, env: { ...process.env, CODEX_HOME: home } });
      assert.ok(broker.pid, 'test must own its broker');
      const left = await openClient(), right = await openClient();
      for (const [client, tag] of [[left, 'run-mac-cancel-a'], [right, 'run-mac-cancel-b']]) {
        client.send({ id: 1, method: 'thread/start', params: { config: { shell_environment_policy: { set: { AGENTOC_RUN_ID: tag } } } } });
      }
      const [first, second] = await Promise.all([left.next(), right.next()]);
      const a = first.result.pid, b = second.result.pid;
      assert.ok(a > 1 && b > 1 && a !== b);
      assert.ok(alive(a) && alive(b));
      left.send({ id: 2, method: 'turn/interrupt', params: { threadId: 'run-mac-cancel-a' } });
      const notification = await left.next();
      assert.equal(notification.method, 'agentoc/macosRunCleanup');
      assert.deepEqual(notification.params, { threadId: 'run-mac-cancel-a', runId: 'run-mac-cancel-a', status: 'attempted' });
      assert.equal((await left.next()).id, 2);
      for (let i = 0; i < 30 && alive(a); i++) await delay(100);
      assert.equal(alive(a), false, 'cancelled child must exit');
      assert.equal(alive(b), true, 'other run must remain alive');
    } finally {
      for (const client of clients) client.destroy();
      if (broker?.pid) { try { process.kill(broker.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
      await delay(300);
      await rm(root, { recursive: true, force: true });
    }
  });
