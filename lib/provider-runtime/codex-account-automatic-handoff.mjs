import { connect } from 'node:net';
import { join } from 'node:path';
import { codexAppServerBrokerSocketPath, codexBrokerAccountDigest, isCodexAppServerBrokerReady } from '../../chat/codex-app-server-broker.mjs';
import { startCoordinatedCodexAccount } from './codex-account-coordinator.mjs';
import { isCodexAccountHomeBound, resolveCanonicalCodexAccountHome } from './codex-account-home-registry.mjs';
import { verifyCodexCandidateAccount, verifyCodexHandoffCredentials, verifySelectedCodexCredential } from './codex-account-credentials.mjs';

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
    const failed = (error) => finish(Object.assign(new Error('Canonical Codex broker is unavailable or cannot verify this account'), {
      code: 'CODEX_HANDOFF_UNAVAILABLE',
      // Only a refused or missing endpoint establishes that no broker accepted
      // this connection. Timeouts and bad attestations must remain failures.
      brokerAbsent: ['ENOENT', 'ECONNREFUSED'].includes(error?.code),
    }));
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
export async function coordinateCodexAccountRoute({ configDir, providerHomesRoot, candidateHomeRoot, accountId, selectedTokens,
  attest = attestRunningCodexBroker, handoff, reconcile = verifyCodexHandoffCredentials,
  waitMs = 15000, pollMs = 250 } = {}) {
  const args = { configDir, providerHomesRoot, candidateHomeRoot, accountId };
  if (typeof accountId !== 'string' || !accountId.trim()) {
    throw Object.assign(new Error('A verified Codex account identity is required'), { code: 'CODEX_ACCOUNT_UNVERIFIED' });
  }
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
  if (isCodexAccountHomeBound(record, candidateHomeRoot)) {
    if (selectedTokens && await isCodexAppServerBrokerReady(codexAppServerBrokerSocketPath(join(record.home, 'codex')), 250)) {
      await verifySelectedCodexCredential({ accountId, canonicalHomeRoot: record.home, selectedTokens });
    }
    return record.home;
  }
  if (!record) throw Object.assign(new Error('Codex account ownership is unavailable'), { code: 'CODEX_HANDOFF_UNAVAILABLE' });
  // Concurrent first Runs can reach this point while the elected owner is
  // still starting. Wait without holding the registry or old-home locks so
  // the elected Run is free to finish launching its broker.
  const deadline = Date.now() + Math.max(0, Number(waitMs) || 0);
  let offline = false;
  for (;;) {
    try { await attest({ canonicalHomeRoot: record.home, accountId }); break; }
    catch (error) {
      if (Date.now() >= deadline) {
        if (!error?.brokerAbsent) throw error;
        offline = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(1, Number(pollMs) || 1), deadline - Date.now())));
    }
  }
  const result = await startCoordinatedCodexAccount({ ...args, ...(handoff ? { handoff } : {}),
    reconcileCredentials: (context) => reconcile({ ...context, selectedTokens }),
    startCanonical: async ({ canonicalHomeRoot }) => {
      try { return await attest({ canonicalHomeRoot, accountId }); }
      catch (error) {
        if (!offline || !error?.brokerAbsent) throw error;
        // An idle owner can be restarted by normal preparation after the
        // legacy home is fenced. Never infer ownership from an absent socket:
        // check the persisted account and selected credential lineage again.
        await verifyCodexCandidateAccount({ accountId, candidateHomeRoot: canonicalHomeRoot });
        await verifySelectedCodexCredential({ accountId, canonicalHomeRoot, selectedTokens });
      }
    },
  });
  return result.canonicalHomeRoot;
}
