import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { listCodexAppServerCapabilities } from '../chat/codex-app-server-client.mjs';

const requests = [];
let accountMatches = true;
function connectFixture() {
  const socket = new EventEmitter();
  socket.writable = true;
  socket.destroyed = false;
  socket.destroy = () => { socket.destroyed = true; };
  socket.write = (line) => {
    const request = JSON.parse(line);
    if (request.type === 'agentoc-codex-broker-ping') {
      queueMicrotask(() => { if (!socket.destroyed) socket.emit('data', Buffer.from(`${JSON.stringify({ type: 'agentoc-codex-broker-pong', ready: true, accountMatches })}\n`)); });
      return true;
    }
    if (!Object.hasOwn(request, 'id')) return true;
    requests.push(request);
    let result = {};
    if (request.method === 'skills/list') result = { data: [] };
    if (request.method === 'mcpServerStatus/list') result = request.params.cursor
      ? { data: [{ name: 'second' }], nextCursor: null }
      : { data: [{ name: 'first' }], nextCursor: 'next' };
    if (request.method === 'app/list') result = { data: [{ id: 'app' }], nextCursor: null };
    if (request.method === 'app/installed') result = { apps: [{ id: 'app', callable: true }] };
    queueMicrotask(() => { if (!socket.destroyed) socket.emit('data', Buffer.from(`${JSON.stringify({ id: request.id, result })}\n`)); });
    return true;
  };
  queueMicrotask(() => socket.emit('connect'));
  return socket;
}

const result = await listCodexAppServerCapabilities({
  codexHomeDir: join(process.cwd(), 'fake-codex-home'),
  cwd: process.cwd(), upstreamFile: process.execPath,
  ensureBrokerImpl: async () => ({ ok: true }), connectImpl: connectFixture, refresh: true,
});
assert.deepEqual(result.mcp.data.data.map((entry) => entry.name), ['first', 'second']);
assert.equal(result.apps.data.data[0].id, 'app');
assert.equal(result.installedApps.data.apps[0].callable, true);
assert.equal(result.plugins.unsupported, true);
assert.equal(requests.some((request) => request.method === 'plugin/list'), false);
assert.equal(requests.find((request) => request.method === 'skills/list').params.forceReload, true);
assert.equal(requests.find((request) => request.method === 'app/list').params.forceRefetch, true);
accountMatches = false;
const before = requests.length;
const wrongAccount = await listCodexAppServerCapabilities({
  codexHomeDir: join(process.cwd(), 'fake-codex-home'), cwd: process.cwd(),
  expectedAccountId: 'different-account', existingBrokerOnly: true,
  ensureBrokerImpl: async () => { throw new Error('must not start a broker'); }, connectImpl: connectFixture,
});
assert.equal(wrongAccount.apps.ok, false);
assert.equal(wrongAccount.skills.ok, false);
assert.equal(requests.length, before, 'no capability request may reach a broker for a different account');
console.log('Codex capability discovery tests passed');
