import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexAppServerBrokerSocketPath, codexAppServerBrokerLockPath, codexBrokerAccountDigest } from '../chat/codex-app-server-broker.mjs';
import { retireCodexBrokerAndAcquireHome } from '../chat/codex-broker-retirement.mjs';
import { acquireNativeOAuthLock, nativeOAuthLockPath } from '../lib/provider-runtime/oauth-lock.mjs';

const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function openSocket(path) {
  const socket = connect(path);
  await new Promise((done, reject) => { socket.once('connect', done); socket.once('error', reject); });
  let buffer = '';
  const queue = [];
  const waiting = [];
  socket.on('data', (chunk) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
      const waiter = waiting.shift(); if (waiter) waiter(message); else queue.push(message);
    }
  });
  return { socket, send: (value) => socket.write(`${JSON.stringify(value)}\n`), next: () => queue.length ? Promise.resolve(queue.shift()) : new Promise((done) => waiting.push(done)) };
}

test('broker retires only after an orphaned turn completes', { timeout: 20000 }, async (t) => {
  const parent = resolve(tmpdir());
  const root = await mkdtemp(join(parent, 'ragent-broker-retire-'));
  const home = join(root, 'codex');
  await mkdir(home);
  await writeFile(join(home, 'auth.json'), JSON.stringify({ tokens: { account_id: 'fixture-account' } }));
  const fixture = join(root, 'upstream.mjs');
  await writeFile(fixture, `import { createInterface } from 'node:readline';
const out = (x) => process.stdout.write(JSON.stringify(x) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') out({ id: m.id, result: {} });
  if (m.method === 'turn/start') {
    out({ id: m.id, result: {} });
    out({ method: 'turn/started', params: { threadId: m.params.threadId } });
    setTimeout(() => out({ method: 'turn/completed', params: { threadId: m.params.threadId } }), 800);
  }
});`);
  const socketPath = codexAppServerBrokerSocketPath(home);
  const brokerEntry = process.env.RAGENT_TEST_BROKER_ENTRY || fileURLToPath(new URL('../chat/codex-app-server-broker.mjs', import.meta.url));
  const broker = spawn(process.execPath, [brokerEntry, '--broker'], {
    env: { ...process.env, CODEX_HOME: home, AGENTOC_CODEX_BROKER_SOCKET: socketPath,
      AGENTOC_CODEX_BROKER_UPSTREAM_FILE: process.execPath, AGENTOC_CODEX_BROKER_UPSTREAM_ARGS: JSON.stringify([fixture]) },
    stdio: 'ignore',
  });
  t.after(async () => {
    if (broker.exitCode === null && broker.signalCode === null) { broker.kill(); await Promise.race([new Promise((done) => broker.once('exit', done)), delay(5000)]); }
    const suffix = relative(parent, root);
    if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) throw new Error('Unsafe test cleanup');
    await rm(root, { recursive: true, force: true });
  });
  let client;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { client = await openSocket(socketPath); break; } catch { await delay(30); }
  }
  assert.ok(client, 'broker socket available');
  for (let attempt = 0; attempt < 100; attempt++) {
    client.send({ type: 'agentoc-codex-broker-ping' });
    if ((await client.next()).ready) break;
    await delay(30);
  }
  client.send({ id: 1, method: 'turn/start', params: { threadId: 'fixture-thread' } });
  assert.equal((await client.next()).id, 1);
  client.socket.end();
  await delay(100);
  const control = await openSocket(socketPath);
  const retire = (digest) => control.send({ type: 'agentoc-codex-broker-retire', expectedAccountDigest: digest });
  retire(codexBrokerAccountDigest('other-account'));
  assert.equal((await control.next()).accepted, false);
  retire(codexBrokerAccountDigest('fixture-account'));
  assert.equal((await control.next()).accepted, false);
  control.socket.end();
  await delay(1000);
  const creationLock = await acquireNativeOAuthLock(codexAppServerBrokerLockPath(home), { waitMs: 5000 });
  let oauthLock;
  try {
    oauthLock = await retireCodexBrokerAndAcquireHome({ homeRoot: root, accountId: 'fixture-account' });
    await assert.rejects(acquireNativeOAuthLock(nativeOAuthLockPath(root), { waitMs: 50, pollMs: 10 }), { code: 'NATIVE_OAUTH_LOCK_TIMEOUT' });
  } finally {
    await oauthLock?.release();
    await creationLock.release();
  }
  if (broker.exitCode === null && broker.signalCode === null) {
    await Promise.race([new Promise((done) => broker.once('exit', done)), delay(5000)]);
  }
  assert.notEqual(broker.exitCode === null && broker.signalCode === null, true, 'broker exits after retirement');
});
