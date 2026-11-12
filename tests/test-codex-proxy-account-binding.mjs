import { strict as assert } from 'node:assert';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { join } from 'node:path';
import { test } from 'node:test';

const proxy = join(process.cwd(), 'chat', 'codex-app-server-proxy.mjs');
const digest = 'a'.repeat(64);
let sequence = 0;

async function exercise(matches) {
  const socketPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\agentoc-proxy-binding-${process.pid}-${sequence++}`
    : join(process.env.TEMP || '/tmp', `agentoc-proxy-binding-${process.pid}-${sequence++}.sock`);
  const server = createServer();
  server.listen(socketPath);
  await once(server, 'listening');
  const child = spawn(process.execPath, [proxy, '--socket', socketPath, '--account-digest', digest], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (data) => { stdout += data; });
  child.stderr.on('data', (data) => { stderr += data; });
  const [socket] = await once(server, 'connection');
  const lines = createInterface({ input: socket });
  const received = [];
  lines.on('line', (line) => received.push(JSON.parse(line)));
  child.stdin.write('{"id":1,"method":"initialize"}\n');
  while (received.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(received, [{ type: 'agentoc-codex-broker-ping', expectedAccountDigest: digest }]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(received.length, 1, 'request must wait for account verification');
  socket.write(`${JSON.stringify({ type: 'agentoc-codex-broker-pong', ready: true, accountMatches: matches })}\n`);
  if (matches) {
    while (received.length < 2) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(received[1], { id: 1, method: 'initialize' });
    socket.write('{"id":1,"result":{}}\n');
    child.stdin.end();
  }
  const [code] = await once(child, 'exit');
  assert.equal(code, matches ? 0 : 1);
  assert.equal(received.length, matches ? 2 : 1);
  assert.equal(stdout, matches ? '{"id":1,"result":{}}\n' : '');
  if (!matches) assert.match(stderr, /account verification failed/);
  socket.destroy();
  await new Promise((resolve) => server.close(resolve));
}

test('proxy verifies the same broker connection before forwarding', { timeout: 15_000 }, async () => {
  await exercise(true);
  await exercise(false);
});
