import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';

const received = [];
const server = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  received.push({ method: req.method, path: req.url, token: req.headers['x-agentoc-windows-broker-token'], body });
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'result', status: req.method === 'POST' ? 'awaiting_device' : 'succeeded', requestId: 'run-qa' }));
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const child = spawn(process.execPath, ['scripts/agentoc-windows-broker-mcp.mjs'], {
  cwd: new URL('..', import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, ''),
  env: { ...process.env,
    AGENTOC_WINDOWS_BROKER_ENDPOINT: `http://127.0.0.1:${server.address().port}/api/internal/windows-broker/service-restart`,
    AGENTOC_WINDOWS_BROKER_TOKEN: 'test-token',
    AGENTOC_WINDOWS_BROKER_SESSION_ID: 'session-1',
    AGENTOC_WINDOWS_BROKER_RUN_ID: 'run-1',
    AGENTOC_WINDOWS_BROKER_TURN_ID: 'turn-1',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let lines = [];
let pending = new Map();
let buffer = '';
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  while (buffer.includes('\n')) {
    const index = buffer.indexOf('\n');
    const response = JSON.parse(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
    pending.get(response.id)?.(response);
    pending.delete(response.id);
    lines.push(response);
  }
});
let nextId = 0;
function rpc(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}
try {
  const listed = await rpc('tools/list');
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), [
    'ragent_restart_qa_service', 'ragent_restart_qa_service_status',
  ]);
  const bad = await rpc('tools/call', { name: 'ragent_restart_qa_service', arguments: { requestKey: 'same', command: 'whoami' } });
  assert.equal(bad.result.isError, true);
  assert.equal(received.length, 0);
  const oldBad = await rpc('tools/call', { name: 'agentoc_restart_qa_service', arguments: { requestKey: 'same', command: 'whoami' } });
  assert.equal(oldBad.result.isError, true);
  assert.equal(received.length, 0);
  const proposal = await rpc('tools/call', { name: 'ragent_restart_qa_service', arguments: { requestKey: 'same' } });
  assert.equal(JSON.parse(proposal.result.content[0].text).status, 'awaiting_device');
  const status = await rpc('tools/call', { name: 'ragent_restart_qa_service_status', arguments: { requestKey: 'same' } });
  assert.equal(JSON.parse(status.result.content[0].text).status, 'succeeded');
  assert.deepEqual(received.map((item) => item.method), ['POST', 'GET']);
  assert.equal(received[0].token, 'test-token');
  assert.deepEqual(JSON.parse(received[0].body), { sessionId: 'session-1', runId: 'run-1', turnId: 'turn-1', requestKey: 'same' });
} finally {
  child.kill();
  server.close();
}
console.log('Windows Broker MCP tests passed');
