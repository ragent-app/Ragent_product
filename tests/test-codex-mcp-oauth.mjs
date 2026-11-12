import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { beginCodexMcpOAuth, readCodexMcpOAuth, cancelCodexMcpOAuth, forwardCodexMcpOAuthCallback } from '../chat/codex-mcp-oauth.mjs';

let acceptedAccount = true;
let loginRequests = 0;
let authorizationUrl = 'https://example.invalid/authorize';
let autoComplete = true;
function connectFixture() {
  const socket = new EventEmitter();
  socket.writable = true; socket.destroyed = false;
  socket.destroy = () => { socket.destroyed = true; socket.emit('close'); };
  const reply = (message) => queueMicrotask(() => { if (!socket.destroyed) socket.emit('data', Buffer.from(`${JSON.stringify(message)}\n`)); });
  socket.write = (raw) => {
    const message = JSON.parse(raw);
    if (message.type === 'agentoc-codex-broker-ping') reply({ type: 'agentoc-codex-broker-pong', ready: true, accountMatches: acceptedAccount });
    if (message.method === 'initialize') reply({ id: message.id, result: {} });
    if (message.method === 'mcpServer/oauth/login') {
      loginRequests += 1;
      reply({ id: message.id, result: { authorizationUrl, loginId: 'login-1' } });
      if (autoComplete) setTimeout(() => reply({ method: 'mcpServer/oauthLogin/completed', params: { name: message.params.name, loginId: 'login-1', success: true } }), 10);
    }
    return true;
  };
  queueMicrotask(() => socket.emit('connect'));
  return socket;
}

const args = { providerId: 'profile', accountId: 'account', accountBinding: 'binding',
  codexHomeDir: join(process.cwd(), 'oauth-test-home'), name: 'server', connectImpl: connectFixture };
const job = await beginCodexMcpOAuth(args);
assert.match(job.authorizationUrl, /^https:\/\/example\.invalid/);
await new Promise((resolve) => setTimeout(resolve, 30));
assert.equal((await readCodexMcpOAuth({ ...args, id: job.id })).state, 'completed_unverified');
assert.equal(await readCodexMcpOAuth({ ...args, accountBinding: 'other', id: job.id }), null);
const pendingJob = await beginCodexMcpOAuth({ ...args, name: 'cancel-server' });
assert.equal(cancelCodexMcpOAuth({ ...args, name: 'cancel-server', id: pendingJob.id, accountBinding: 'other' }), null);
assert.equal(cancelCodexMcpOAuth({ ...args, name: 'cancel-server', id: pendingJob.id }).state, 'abandoned');
assert.equal((await readCodexMcpOAuth({ ...args, name: 'cancel-server', id: pendingJob.id })).state, 'abandoned');
acceptedAccount = false;
await assert.rejects(beginCodexMcpOAuth({ ...args, name: 'other-server' }));
assert.equal(loginRequests, 2, 'a mismatched broker account must never receive an OAuth login request');
acceptedAccount = true;
autoComplete = false;
let requests = 0;
const server = createServer((req, res) => { requests += 1; res.writeHead(200); res.end('ok'); });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const callback = `http://127.0.0.1:${server.address().port}/callback/random-token`;
const auth = new URL('https://example.invalid/authorize');
auth.searchParams.set('redirect_uri', callback);
auth.searchParams.set('state', 'expected-state');
authorizationUrl = auth.toString();
const mobile = await beginCodexMcpOAuth({ ...args, name: 'mobile' });
assert.equal(mobile.mobileCallbackSupported, true);
const base = { ...args, id: mobile.id, name: 'mobile' };
assert.equal(await forwardCodexMcpOAuthCallback({ ...base, accountBinding: 'other', callbackUrl: `${callback}?code=x&state=expected-state` }), null);
await assert.rejects(forwardCodexMcpOAuthCallback({ ...base, callbackUrl: `${callback}?code=x&state=wrong` }));
await assert.rejects(forwardCodexMcpOAuthCallback({ ...base, callbackUrl: `${callback}/extra?code=x&state=expected-state` }));
await assert.rejects(forwardCodexMcpOAuthCallback({ ...base, callbackUrl: `${callback}?code=x&state=expected-state&state=wrong` }));
assert.equal(requests, 0);
assert.deepEqual(await forwardCodexMcpOAuthCallback({ ...base, callbackUrl: `${callback}?code=x&state=expected-state` }), { accepted: true });
await assert.rejects(forwardCodexMcpOAuthCallback({ ...base, callbackUrl: `${callback}?code=x&state=expected-state` }));
assert.equal(requests, 1);
cancelCodexMcpOAuth(base);
await new Promise((resolve) => server.close(resolve));
console.log('Codex MCP OAuth tests passed');
