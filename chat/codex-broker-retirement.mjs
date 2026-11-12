import { connect } from 'node:net';
import { isAbsolute, join } from 'node:path';
import { codexAppServerBrokerSocketPath, codexBrokerAccountDigest } from './codex-app-server-broker.mjs';
import { acquireNativeOAuthLock, nativeOAuthLockPath } from '../lib/provider-runtime/oauth-lock.mjs';

/**
 * The caller must hold this home's broker creation lock before invoking this
 * function and until it has completed the handoff. The returned OAuth lock
 * must also remain held until the caller has fenced the old home. An absent
 * socket is not proof of inactivity: the OAuth lock is acquired in that case.
 */
export async function retireCodexBrokerAndAcquireHome({ homeRoot, accountId, timeoutMs = 5000, connectImpl = connect } = {}) {
  if (typeof homeRoot !== 'string' || !isAbsolute(homeRoot) || typeof accountId !== 'string' || !accountId.trim()) {
    throw Object.assign(new Error('Verified account and absolute Codex home are required'), { code: 'CODEX_RETIRE_INVALID' });
  }
  const socketPath = codexAppServerBrokerSocketPath(join(homeRoot, 'codex'));
  const digest = codexBrokerAccountDigest(accountId.trim());
  await new Promise((resolve, reject) => {
    let socket;
    let connected = false;
    let finished = false;
    let buffer = '';
    const timer = setTimeout(() => finish(Object.assign(new Error('Codex broker retirement timed out'), { code: 'CODEX_RETIRE_TIMEOUT' })), timeoutMs);
    function finish(error) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket?.destroy();
      if (error) reject(error); else resolve();
    }
    try { socket = connectImpl(socketPath); }
    catch (error) { finish(error); return; }
    socket.once('connect', () => {
      connected = true;
      socket.write(`${JSON.stringify({ type: 'agentoc-codex-broker-retire', expectedAccountDigest: digest })}\n`);
    });
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.length > 64 * 1024) return finish(Object.assign(new Error('Invalid broker response'), { code: 'CODEX_RETIRE_PROTOCOL' }));
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      let reply;
      try { reply = JSON.parse(buffer.slice(0, end)); } catch { return finish(Object.assign(new Error('Invalid broker response'), { code: 'CODEX_RETIRE_PROTOCOL' })); }
      if (reply?.type !== 'agentoc-codex-broker-retire-result') return finish(Object.assign(new Error('Unsupported broker retirement protocol'), { code: 'CODEX_RETIRE_PROTOCOL' }));
      if (reply.accepted !== true) return finish(Object.assign(new Error('Codex broker is busy or account could not be verified'), { code: 'CODEX_RETIRE_BUSY' }));
      finish();
    });
    socket.once('error', (error) => {
      if (!connected && (error.code === 'ENOENT' || error.code === 'ECONNREFUSED')) return finish();
      finish(error);
    });
    socket.once('end', () => finish(Object.assign(new Error('Codex broker closed before retirement was confirmed'), { code: 'CODEX_RETIRE_PROTOCOL' })));
  });
  return acquireNativeOAuthLock(nativeOAuthLockPath(homeRoot), { waitMs: timeoutMs });
}
