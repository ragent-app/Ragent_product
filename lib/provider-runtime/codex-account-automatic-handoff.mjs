import { connect } from 'node:net';
import { join } from 'node:path';
import { codexAppServerBrokerSocketPath, codexBrokerAccountDigest } from '../../chat/codex-app-server-broker.mjs';
import { startCoordinatedCodexAccount } from './codex-account-coordinator.mjs';
import { isCodexAccountHomeBound, resolveCanonicalCodexAccountHome } from './codex-account-home-registry.mjs';
import { verifyCodexCandidateAccount, verifyCodexHandoffCredentials } from './codex-account-credentials.mjs';

// This never starts a process: the running canonical owner must prove its
// identity on the connection before a legacy broker can be retired.
export async function attestRunningCodexBroker({ canonicalHomeRoot, accountId, timeoutMs = 3000 }) {
  const socketPath = codexAppServerBrokerSocketPath(join(canonicalHomeRoot, 'codex'));
  const expectedAccountDigest = codexBrokerAccountDigest(accountId);
  if (!socketPath || !expectedAccountDigest) throw Object.assign(new Error('Verified Codex account is required'), { code: 'CODEX_HANDOFF_UNAVAILABLE' });
  await new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let settled = false;
    let buffer = '';
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve();
    };
    const failed = () => finish(Object.assign(new Error('Canonical Codex broker is unavailable or cannot verify this account'), { code: 'CODEX_HANDOFF_UNAVAILABLE' }));
    const timer = setTimeout(failed, timeoutMs);
    socket.once('error', failed);
    socket.once('end', failed);
    socket.once('connect', () => socket.write(`${JSON.stringify({ type: 'agentoc-codex-broker-ping', expectedAccountDigest })}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.length > 65536) return failed();
      const index = buffer.indexOf('\n');
      if (index < 0) return;
      try {
        const value = JSON.parse(buffer.slice(0, index));
        if (value?.type === 'agentoc-codex-broker-pong' && value.ready === true && value.accountMatches === true) return finish();
      } catch {}
      failed();
    });
  });
}

// Account record initialization is serialized by the registry. Existing
// aliases may route immediately; a new alias is published only after both old
// locks, credential verification, a durable fence and canonical attestation.
export async function coordinateCodexAccountRoute({ configDir, providerHomesRoot, candidateHomeRoot, accountId,
  attest = attestRunningCodexBroker, handoff, reconcile = verifyCodexHandoffCredentials,
  waitMs = 15000, pollMs = 250 } = {}) {
  const args = { configDir, providerHomesRoot, candidateHomeRoot, accountId };
  if (typeof accountId !== 'string' || !accountId.trim()) return candidateHomeRoot;
  let record = await resolveCanonicalCodexAccountHome({ ...args, includeSources: true });
  if (!record) {
    await verifyCodexCandidateAccount({ accountId, candidateHomeRoot });
    try {
      await resolveCanonicalCodexAccountHome({ ...args, initialize: true });
    } catch (error) {
      if (error?.code !== 'CODEX_ACCOUNT_HOME_MIGRATION_REQUIRED') throw error;
    }
    record = await resolveCanonicalCodexAccountHome({ ...args, includeSources: true });
  }
  if (isCodexAccountHomeBound(record, candidateHomeRoot)) return record.home;
  if (!record) throw Object.assign(new Error('Codex account ownership is unavailable'), { code: 'CODEX_HANDOFF_UNAVAILABLE' });
  // Concurrent first Runs can reach this point while the elected owner is
  // still starting. Wait without holding the registry or old-home locks so
  // the elected Run is free to finish launching its broker.
  const deadline = Date.now() + Math.max(0, Number(waitMs) || 0);
  for (;;) {
    try { await attest({ canonicalHomeRoot: record.home, accountId }); break; }
    catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(1, Number(pollMs) || 1), deadline - Date.now())));
    }
  }
  const result = await startCoordinatedCodexAccount({ ...args, ...(handoff ? { handoff } : {}),
    reconcileCredentials: reconcile,
    startCanonical: async ({ canonicalHomeRoot }) => attest({ canonicalHomeRoot, accountId }),
  });
  return result.canonicalHomeRoot;
}
