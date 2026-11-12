import { verifyLinuxRunControlBinding } from './linux-run-control-binding.mjs';
import { persistLinuxRunCancelIntent } from './linux-run-cancel-intent.mjs';
export { LINUX_RUN_SCOPE_FINISH_PATH } from './linux-run-scope-finish-path.mjs';

// A runner can only invalidate its own bound scope. It cannot create or
// extend authority, choose a signing key, or replace the Run context.
export async function finishLinuxRunScope(input, { enabled = process.env.AGENTOC_LINUX_RUN_SCOPE_GRANTS === '1',
  platform = process.platform } = {}) {
  const keys = ['runId', 'sessionId', 'turnId', 'launchAttempt', 'token'];
  if (!enabled || platform !== 'linux' || !input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).length !== keys.length || !keys.every((key) => Object.hasOwn(input, key)) ||
      !await verifyLinuxRunControlBinding(input)) throw new Error('Run scope finish unavailable');
  await persistLinuxRunCancelIntent(input.runId, input.launchAttempt);
}
