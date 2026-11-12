import assert from 'assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import http from 'http';
import { tmpdir } from 'os';
import { join } from 'path';

const tempRoot = mkdtempSync(join(tmpdir(), 'agentoc-api-command-'));
const homeDir = join(tempRoot, 'home');
mkdirSync(join(homeDir, '.config', 'agentoc'), { recursive: true });
writeFileSync(join(homeDir, '.config', 'agentoc', 'auth.json'), `${JSON.stringify({ token: 'owner-token' })}\n`, 'utf8');
process.env.HOME = homeDir;
process.env.AGENTOC_INSTANCE_ROOT = tempRoot;
process.env.AGENTOC_CONFIG_DIR = join(homeDir, '.config', 'agentoc');

let runPolls = 0;
const sockets = new Set();
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/' && url.searchParams.get('token') === 'owner-token') {
    res.writeHead(302, {
      'Set-Cookie': 'agentoc_session=owner; Path=/',
      Location: '/app',
    });
    res.end();
    return;
  }

  if (url.pathname === '/login' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const params = new URLSearchParams(body);
    if (params.get('username') === 'owner' && params.get('password') === 'pw-secret') {
      res.writeHead(302, {
        'Set-Cookie': 'agentoc_session=owner; Path=/',
        Location: '/',
      });
    } else {
      res.writeHead(302, { Location: '/login?error=1&mode=pw' });
    }
    res.end();
    return;
  }

  const authorization = req.headers.authorization || '';
  if (req.method === 'GET' && url.pathname === '/api/collaborations') {
    assert.equal(authorization, 'Bearer collaboration-read-token');
    assert.ok(req.headers['x-agentoc-capability-use-nonce']);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ collaborations: [] }));
    return;
  }

  const cookie = req.headers.cookie || '';
  if (!cookie.includes('agentoc_session=owner')) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'forbidden' }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/tools') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ tools: [{ id: 'codex' }, { id: 'micro-agent' }] }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/sessions/sess-1/messages') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body || '{}');
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      session: { id: 'sess-1' },
      run: { id: 'run-1' },
      acceptedText: parsed.text,
    }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/runs/run-1') {
    runPolls += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      run: {
        id: 'run-1',
        state: runPolls >= 2 ? 'completed' : 'running',
      },
    }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/sessions/sess-1/events') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      events: [
        {
          seq: 1,
          type: 'message',
          role: 'assistant',
          runId: 'run-1',
          content: 'api-ok',
        },
      ],
    }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});
server.on('connection', (socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert(address && typeof address === 'object');
const baseUrl = `http://127.0.0.1:${address.port}`;

const { runAgentoCApiCommand } = await import('../lib/agentoc-api-command.mjs');

async function runCli(args) {
  let stdout = '';
  await runAgentoCApiCommand(args, {
    stdout: {
      write(chunk) {
        stdout += String(chunk);
      },
    },
  });
  return stdout;
}

const toolsJson = JSON.parse(await runCli(['GET', '/api/tools', '--base-url', baseUrl]));
assert.deepEqual(toolsJson.tools.map((tool) => tool.id), ['codex', 'micro-agent']);

process.env.AGENTOC_COLLABORATION_CAPABILITIES = Buffer.from(JSON.stringify([
  { operation: 'collaboration.read', token: 'collaboration-read-token' },
]), 'utf8').toString('base64url');
const collaborationsJson = JSON.parse(await runCli(['GET', '/api/collaborations', '--base-url', baseUrl]));
assert.deepEqual(collaborationsJson.collaborations, [], 'generic API command should select the Run collaboration capability');
delete process.env.AGENTOC_COLLABORATION_CAPABILITIES;

const messageJson = JSON.parse(await runCli([
  'POST',
  '/api/sessions/sess-1/messages',
  '--base-url', baseUrl,
  '--body', '{"text":"hello from cli"}',
  '--wait-run',
  '--timeout-ms', '5000',
]));
assert.equal(messageJson.acceptedText, 'hello from cli');
assert.equal(messageJson.awaitedRun?.state, 'completed');
assert.equal(messageJson.reply, 'api-ok');
assert.equal(messageJson.sessionUrl, '/?session=sess-1&tab=sessions');

// Password-only login path (token retired by the 2026-08-05 hardening):
// auth.json carries username only, the password comes from the environment.
const authFile = join(homeDir, '.config', 'agentoc', 'auth.json');
writeFileSync(authFile, `${JSON.stringify({ username: 'owner' })}\n`, 'utf8');
process.env.AGENTOC_LOGIN_PASSWORD = 'pw-secret';

const passwordToolsJson = JSON.parse(await runCli(['GET', '/api/tools', '--base-url', baseUrl]));
assert.deepEqual(passwordToolsJson.tools.map((tool) => tool.id), ['codex', 'micro-agent'], 'password login should authenticate API calls');

process.env.AGENTOC_LOGIN_PASSWORD = 'wrong-password';
let passwordRejected = false;
try {
  await runCli(['GET', '/api/tools', '--base-url', baseUrl]);
} catch (error) {
  passwordRejected = /Failed to log in/i.test(error.message);
}
assert.ok(passwordRejected, 'a wrong password should surface a login failure');
delete process.env.AGENTOC_LOGIN_PASSWORD;

for (const socket of sockets) {
  socket.destroy();
}
server.closeAllConnections?.();
await new Promise((resolve) => server.close(resolve));

console.log('test-agentoc-api-command: ok');
