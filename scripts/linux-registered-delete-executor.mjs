// Adapter for root-owned Run records. Not connected to the product socket:
// lifecycle registration/revocation, owner proof and cancellation ordering
// must be wired and validated before enabling it.
import { posix as path } from 'node:path';
import { SEMANTIC_ADAPTER_LINUX_FILE_DELETE_V1, verifySemanticCapability } from '../chat/semantic-capability.mjs';
import { createLinuxDeleteExecutor } from './linux-delete-execution.mjs';
import { loadLinuxServiceKeyPin } from './linux-service-key-pin.mjs';
import { readLinuxRunContext } from './linux-run-context-store.mjs';

function absolute(value) {
  return typeof value === 'string' && value.startsWith('/') && path.normalize(value) === value && !/[\x00-\x1f\x7f]/.test(value);
}
const rejected = () => ({ state: 'rejected', code: 'LINUX_DELETE_CAPABILITY_REJECTED' });

// Every option is root-controlled configuration, not an operation request.
// In particular launchAttempt must come from trusted lifecycle state.
export function createLinuxRegisteredDeleteExecutor({ runId, launchAttempt, contextDirectory, pinDirectory,
  trustedHome, trustedProtectedRoots, rootPublicKey, rootPrivateKey, helperPath, expectedHelperSha256, ledgerDirectory } = {}) {
  return async (capability) => {
    try {
      if (process.platform !== 'linux' || process.geteuid?.() !== 0 || !absolute(trustedHome) ||
          !Array.isArray(trustedProtectedRoots) || !trustedProtectedRoots.length ||
          trustedProtectedRoots.some((root) => !root || !absolute(root.path) || root.available === false)) return rejected();
      const protectedRoots = JSON.parse(JSON.stringify(trustedProtectedRoots));
      const saved = JSON.parse(JSON.stringify(capability));
      const { publicKey: servicePublicKey } = await loadLinuxServiceKeyPin(pinDirectory);
      if (saved?.runId !== runId || saved?.adapter !== SEMANTIC_ADAPTER_LINUX_FILE_DELETE_V1 ||
          !verifySemanticCapability(saved, { publicKey: servicePublicKey }).ok || saved.operations?.length !== 1) return rejected();
      const operation = saved.operations[0]?.adapterInput?.linuxDeleteOperation;
      const request = operation?.requestBinding;
      const attestation = saved.operations[0]?.adapterInput?.linuxTargetAttestation;
      // A v1 proof is not bound to an actual systemd invocation.
      if (attestation?.version !== 2 || !request?.requestKey || request.runId !== runId ||
          request.sessionId !== saved.sessionId || request.turnId !== saved.turnId) return rejected();
      const getRun = async () => {
        const state = await readLinuxRunContext({ directory: contextDirectory, pinDirectory, runId, launchAttempt });
        if (!state || state.sessionId !== saved.sessionId || state.turnId !== saved.turnId) throw new Error('Run unavailable');
        return { expectedContext: { sessionId: state.sessionId, runId, turnId: state.turnId,
          requestId: request.requestKey, launchAttempt: state.launchAttempt, invocationId: state.invocationId },
        trustedContext: { cwd: state.cwd, projectRoot: state.projectRoot, home: trustedHome },
        trustedProtectedRoots: protectedRoots };
      };
      const execute = createLinuxDeleteExecutor({ servicePublicKey, rootPublicKey, rootPrivateKey, helperPath,
        expectedHelperSha256, ledgerDirectory, resolveTrustedRun: getRun,
        isRunActive: async () => Boolean(await readLinuxRunContext({ directory: contextDirectory, pinDirectory, runId, launchAttempt })) });
      return await execute(saved);
    } catch { return rejected(); }
  };
}
