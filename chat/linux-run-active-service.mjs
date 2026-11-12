import { assertRunLaunchBoundary } from './run-execution-boundary.mjs';
import { getActivePrivilegedSigningKey } from './privileged-signing-keys.mjs';
import { signLinuxRunActiveProof } from './linux-run-active-proof.mjs';
import { hasLinuxRunCancelIntent } from './linux-run-cancel-intent.mjs';
import { matchesLinuxRunControlBinding } from './linux-run-control-binding.mjs';
export { LINUX_RUN_ACTIVE_CHECK_PATH } from './linux-run-active-proof.mjs';

export async function issueLinuxRunActiveProof(context, { enabled = process.env.AGENTOC_LINUX_RUN_SCOPE_GRANTS === '1',
  platform = process.platform, readBoundary = assertRunLaunchBoundary, getKey = getActivePrivilegedSigningKey,
  isCancelled = hasLinuxRunCancelIntent, matchesBinding = matchesLinuxRunControlBinding } = {}) {
  if (!enabled || platform !== 'linux') throw new Error('Linux Run active check unavailable');
  const { run, manifest } = await readBoundary(context?.runId);
  if (!run || run.id !== context?.runId || run.sessionId !== context?.sessionId || run.requestId !== context?.turnId ||
      run.cancelRequested === true || ['completed', 'failed', 'cancelled'].includes(run.state) ||
      run.runnerLaunchMode !== 'runner-lifecycle' || run.runnerLaunchAttempt !== context?.launchAttempt ||
      manifest?.options?.approvedActionChannel?.turnId !== context?.turnId) throw new Error('Run is not active');
  if (await isCancelled(context.runId, context.launchAttempt)) throw new Error('Run cancellation intent exists');
  if (!await matchesBinding({ run, manifest, launchAttempt: context.launchAttempt })) throw new Error('Run control binding is unavailable');
  const privateKey = getKey()?.privateKey;
  if (!privateKey) throw new Error('Linux Run active signing key unavailable');
  return signLinuxRunActiveProof({ context, privateKey });
}
