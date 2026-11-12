// Control-plane helper for the optional root Run registration handshake.
// This does not authorize an operation, enroll a root public-key pin, or make
// the privileged executor available.
import { assertRunLaunchBoundary } from './run-execution-boundary.mjs';
import { getActivePrivilegedSigningKey, loadOrCreatePrivilegedSigningKeys } from './privileged-signing-keys.mjs';
import { resolveApprovedActionRunDirectories } from './approved-action-run-directories.mjs';
import { signLinuxRunScopeGrant } from './linux-run-scope-grant.mjs';

export async function issueLinuxRunScopeGrant(runId, launchAttempt, {
  enabled = process.env.AGENTOC_LINUX_RUN_SCOPE_GRANTS === '1', platform = process.platform,
  readBoundary = assertRunLaunchBoundary, loadKeys = loadOrCreatePrivilegedSigningKeys,
  getKey = getActivePrivilegedSigningKey,
} = {}) {
  if (!enabled || platform !== 'linux') return null;
  const { run, manifest } = await readBoundary(runId);
  // Legacy/unscoped Runs and Runs without the approved-action channel retain
  // ordinary execution; they cannot use the registered privileged adapter.
  if (!manifest?.executionScope || !manifest?.options?.approvedActionChannel?.turnId) return null;
  if (run?.id !== runId || run.cancelRequested === true || ['completed', 'failed', 'cancelled'].includes(run.state)) {
    throw Object.assign(new Error('Run is no longer eligible for scope registration'), { code: 'LINUX_RUN_SCOPE_INACTIVE' });
  }
  resolveApprovedActionRunDirectories({ run, manifest, session: {}, platform: 'linux' });
  await loadKeys();
  const key = getKey();
  if (!key?.privateKey) throw Object.assign(new Error('Linux Run scope signing key is unavailable'), { code: 'LINUX_RUN_SCOPE_KEY_UNAVAILABLE' });
  return signLinuxRunScopeGrant({ run, manifest, launchAttempt, privateKey: key.privateKey });
}
