import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { codexBrokerAccountDigest } from '../../chat/codex-app-server-broker.mjs';

export function codexRunBindingPath(codexHomeDir, runId) {
  if (typeof codexHomeDir !== 'string' || !isAbsolute(codexHomeDir) || typeof runId !== 'string' || !runId.trim()) {
    throw new Error('Codex run binding requires an absolute home and run ID');
  }
  const key = createHash('sha256').update(runId).digest('hex');
  return join(codexHomeDir, '.agentoc-run-bindings', `${key}.json`);
}

export function createCodexRunBinding({ runId, providerId, accountId }) {
  const accountDigest = codexBrokerAccountDigest(accountId);
  if (typeof runId !== 'string' || !runId.trim() || typeof providerId !== 'string' || !providerId.trim() || !accountDigest) {
    throw new Error('Codex run binding requires a verified account and provider');
  }
  return { version: 1, runId, providerId: providerId.trim(), accountDigest };
}

export function verifyCodexRunBinding(binding, { runId, providerId, accountId }) {
  const expected = codexBrokerAccountDigest(accountId);
  return Boolean(expected && binding?.version === 1 && binding.runId === runId
    && binding.providerId === providerId && binding.accountDigest === expected);
}
