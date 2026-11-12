import { connect } from 'node:net';

// Control-plane only. A failed notification does not undo a persisted cancel;
// callers must not treat this best-effort signal as a complete cancellation
// boundary until the executor and lifecycle service synchronize operations.
async function sendScopeRequest(run, type, scopeGrant, {
  enabled = process.platform === 'linux' && process.env.AGENTOC_LINUX_RUN_SCOPE_GRANTS === '1',
  socketPath = process.env.AGENTOC_RUNNER_LIFECYCLE_SOCKET,
  connectImpl = connect, timeoutMs = 2000,
} = {}) {
  if (!enabled) return { state: 'disabled' };
  const runId = run?.id, launchAttempt = run?.runnerLaunchAttempt ?? 0;
  if (typeof socketPath !== 'string' || !socketPath || typeof runId !== 'string' || !/^run_[A-Za-z0-9_-]{8,128}$/.test(runId) ||
      !Number.isSafeInteger(launchAttempt) || launchAttempt < 0 || launchAttempt > 10000) return { state: 'unavailable' };
  return new Promise((resolve) => {
    let finished = false, buffer = '';
    let socket;
    try { socket = connectImpl(socketPath); } catch { resolve({ state: 'unavailable' }); return; }
    const finish = (state) => {
      if (finished) return;
      finished = true; clearTimeout(timer); socket.destroy(); resolve({ state });
    };
    const timer = setTimeout(() => finish('unavailable'), timeoutMs);
    timer.unref?.();
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(`${JSON.stringify({ type, runId, launchAttempt, ...(scopeGrant ? { scopeGrant } : {}) })}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > 16384) return finish('unavailable');
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try { finish(JSON.parse(buffer.slice(0, newline))?.ok === true ? (type === 'revoke-scope' ? 'revoked' : 'renewed') : 'unavailable'); }
      catch { finish('unavailable'); }
    });
    socket.once('error', () => finish('unavailable'));
    socket.once('end', () => finish('unavailable'));
  });
}

export async function revokeLinuxRunScope(run, options = {}) {
  return sendScopeRequest(run, 'revoke-scope', null, options);
}

// The broker verifies the new signed grant against the existing, live root
// record. A failed renewal never creates or revives a Run context.
export async function renewLinuxRunScope(run, grant, options = {}) {
  if (!grant || typeof grant !== 'object' || Array.isArray(grant)) return { state: 'unavailable' };
  return sendScopeRequest(run, 'renew-scope', grant, options);
}
