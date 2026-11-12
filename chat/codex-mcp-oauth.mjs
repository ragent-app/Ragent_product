import { connect } from 'node:net';
import { request as httpRequest } from 'node:http';
import { randomBytes } from 'node:crypto';
import { codexAppServerBrokerSocketPath, codexBrokerAccountDigest } from './codex-app-server-broker.mjs';
import { buildCodexAppServerInitializeMessage, buildCodexAppServerInitializedNotification } from './codex-app-server-protocol.mjs';
import { requestExistingCodexBroker } from './codex-app-server-client.mjs';

const jobs = new Map();
const MAX_JOBS = 64;
const JOB_TIMEOUT_MS = 10 * 60 * 1000;

// The connection stays open for the native callback. Only the originating
// broker client receives completion, and no OAuth token enters this service.
export async function beginCodexMcpOAuth({ providerId, accountId, accountBinding, codexHomeDir, name, connectImpl = connect }) {
  const digest = codexBrokerAccountDigest(accountId);
  if (!providerId || !digest || !accountBinding || !name || !codexHomeDir) throw new Error('Verified Codex account is required');
  if (jobs.size >= MAX_JOBS) throw new Error('Too many pending MCP authorizations');
  if ([...jobs.values()].some((job) => job.providerId === providerId && job.accountBinding === accountBinding && job.name === name && job.state === 'pending')) {
    throw new Error('MCP authorization is already in progress');
  }
  const socketPath = codexAppServerBrokerSocketPath(codexHomeDir);
  const job = { id: randomBytes(24).toString('hex'), providerId, accountBinding, name, state: 'pending', loginId: '', createdAt: Date.now() };
  jobs.set(job.id, job);
  return new Promise((resolve, reject) => {
    const socket = connectImpl(socketPath);
    let buffer = '';
    let phase = 'account';
    let resolved = false;
    const write = (message) => { if (!socket.destroyed && socket.writable) socket.write(`${JSON.stringify(message)}\n`); };
    const finish = (state) => {
      if (job.state !== 'pending') return;
      job.state = state;
      job.callback = null;
      socket.destroy();
      clearTimeout(timer);
      const cleanup = setTimeout(() => jobs.delete(job.id), 5 * 60 * 1000);
      cleanup.unref?.();
    };
    // The native protocol has no verified cancellation method. This detaches
    // Ragent's waiter; it cannot revoke a link already issued by Codex.
    job.cancel = () => finish('abandoned');
    const fail = () => {
      finish('failed');
      if (!resolved) { jobs.delete(job.id); reject(new Error('Codex MCP authorization could not start')); }
    };
    let timer = setTimeout(() => { finish('expired'); if (!resolved) { jobs.delete(job.id); reject(new Error('Codex MCP authorization timed out')); } }, 15_000);
    timer.unref?.();
    socket.on('error', fail);
    socket.on('end', fail);
    socket.on('close', () => { if (job.state === 'pending') fail(); });
    socket.once('connect', () => write({ type: 'agentoc-codex-broker-ping', expectedAccountDigest: digest }));
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (Buffer.byteLength(buffer, 'utf8') > 1024 * 1024) return fail();
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        let message;
        try { message = JSON.parse(buffer.slice(0, newline)); } catch { return fail(); }
        buffer = buffer.slice(newline + 1);
        if (phase === 'account') {
          if (message?.type !== 'agentoc-codex-broker-pong' || message.ready !== true || message.accountMatches !== true) return fail();
          phase = 'initialize'; write(buildCodexAppServerInitializeMessage()); continue;
        }
        if (phase === 'initialize' && message.id === 0) {
          if (message.error) return fail();
          phase = 'login'; write(buildCodexAppServerInitializedNotification());
          write({ id: 101, method: 'mcpServer/oauth/login', params: { name, timeoutSecs: Math.floor(JOB_TIMEOUT_MS / 1000) } });
          continue;
        }
        if (phase === 'login' && message.id === 101) {
          if (message.error || typeof message.result?.authorizationUrl !== 'string') return fail();
          let url;
          try { url = new URL(message.result.authorizationUrl); } catch { return fail(); }
          if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return fail();
          // Only the exact loopback callback issued by Codex is eligible for
          // forwarding from a remote phone. Other OAuth flows remain unchanged.
          try {
            const redirects = url.searchParams.getAll('redirect_uri');
            const redirect = new URL(redirects[0]);
            const states = url.searchParams.getAll('state');
            if (redirect.protocol === 'http:' && redirect.hostname === '127.0.0.1' && redirect.port &&
                /^\/callback\/[A-Za-z0-9_-]+$/.test(redirect.pathname) && !redirect.search && !redirect.hash &&
                !redirect.username && !redirect.password && redirects.length === 1 && states.length === 1 && states[0]) {
              job.callback = { origin: redirect.origin, path: redirect.pathname, state: states[0] };
            }
          } catch { /* This native flow cannot be forwarded from a phone. */ }
          job.loginId = typeof message.result.loginId === 'string' ? message.result.loginId : '';
          phase = 'waiting'; resolved = true;
          clearTimeout(timer);
          timer = setTimeout(() => finish('expired'), JOB_TIMEOUT_MS);
          timer.unref?.();
          resolve({ id: job.id, authorizationUrl: url.toString(), state: job.state, mobileCallbackSupported: Boolean(job.callback) });
          continue;
        }
        if (phase === 'waiting' && message.method === 'mcpServer/oauthLogin/completed' && message.params?.name === name) {
          const loginId = typeof message.params?.loginId === 'string' ? message.params.loginId : '';
          if (job.loginId && loginId && job.loginId !== loginId) continue;
          finish(message.params?.success === true ? 'completed_unverified' : 'failed');
        }
      }
    });
  });
}

// Forward only a callback for this exact, still-pending native login. Codex
// validates the response and exchanges the code; Ragent never stores tokens.
export async function forwardCodexMcpOAuthCallback({ id, providerId, accountBinding, name, callbackUrl }) {
  const job = jobs.get(id);
  if (!job || job.providerId !== providerId || job.accountBinding !== accountBinding || job.name !== name) return null;
  if (job.state !== 'pending' || !job.callback || job.callbackInFlight || job.callbackForwarded || typeof callbackUrl !== 'string' || callbackUrl.length > 8192) {
    throw new Error('Callback unavailable');
  }
  let callback;
  try { callback = new URL(callbackUrl); } catch { throw new Error('Invalid callback'); }
  const state = callback.searchParams.getAll('state');
  const codes = callback.searchParams.getAll('code');
  const errors = callback.searchParams.getAll('error');
  if (callback.origin !== job.callback.origin || callback.pathname !== job.callback.path || callback.username || callback.password || callback.hash ||
      state.length !== 1 || state[0] !== job.callback.state || codes.length + errors.length !== 1 ||
      !(codes[0] || errors[0])) throw new Error('Invalid callback');
  job.callbackInFlight = true;
  try {
    const status = await new Promise((resolve, reject) => {
      const request = httpRequest({ hostname: '127.0.0.1', port: callback.port, method: 'GET',
        path: `${callback.pathname}${callback.search}`, timeout: 5000 }, (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
        response.on('error', reject);
      });
      request.on('timeout', () => request.destroy(new Error('Callback timeout')));
      request.on('error', reject);
      request.end();
    });
    if (status !== 200) throw new Error('Callback rejected');
    job.callbackForwarded = true;
    return { accepted: true };
  } finally { job.callbackInFlight = false; }
}

export function cancelCodexMcpOAuth({ id, providerId, accountBinding, name }) {
  const job = jobs.get(id);
  if (!job || job.providerId !== providerId || job.accountBinding !== accountBinding || job.name !== name) return null;
  job.cancel?.();
  return { id: job.id, state: job.state, createdAt: job.createdAt };
}

export async function readCodexMcpOAuth({ id, providerId, accountBinding, accountId, codexHomeDir, name }) {
  const job = jobs.get(id);
  if (!job || job.providerId !== providerId || job.accountBinding !== accountBinding || job.name !== name) return null;
  let state = job.state;
  if (state === 'completed_unverified') {
    try {
      let cursor = '';
      const seen = new Set();
      const deadline = Date.now() + 8_000;
      for (let page = 0; page < 50; page += 1) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        const result = await requestExistingCodexBroker(codexAppServerBrokerSocketPath(codexHomeDir), 'mcpServerStatus/list',
          { limit: 100, detail: 'toolsAndAuthOnly', ...(cursor ? { cursor } : {}) }, { timeoutMs: Math.min(4_000, remaining), expectedAccountId: accountId });
        const server = (Array.isArray(result.data) ? result.data : []).find((entry) => entry?.name === job.name);
        if (server) { if (server.authStatus === 'oAuth') state = job.state = 'connected'; break; }
        cursor = typeof result.nextCursor === 'string' ? result.nextCursor : '';
        if (!cursor || seen.has(cursor)) break;
        seen.add(cursor);
      }
    } catch { /* Completion is not evidence of a usable connection. */ }
  }
  return { id: job.id, state, createdAt: job.createdAt };
}
