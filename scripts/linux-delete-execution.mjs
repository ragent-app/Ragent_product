/**
 * Isolated execution prototype; not wired to the production socket. All
 * configuration, key objects, run lookup and liveness checks must be supplied
 * by trusted root-owned executor state, never by a request or model.
 */
import { canonicalSemanticJson } from '../chat/semantic-operation.mjs';
import { SEMANTIC_ADAPTER_LINUX_FILE_DELETE_V1, verifySemanticCapability } from '../chat/semantic-capability.mjs';
import { verifyLinuxTargetAttestation } from '../chat/linux-target-attestation.mjs';
import { claimLinuxDeleteNonce, recordLinuxDeletePhase } from './linux-delete-ledger.mjs';
import { verifyLinuxDeleteCapability } from './linux-delete-capability.mjs';
import { removeVerifiedLinuxTarget } from './linux-target-inspection.mjs';

const reject = (code) => ({ state: 'rejected', code });
const unknown = () => ({ state: 'unknown', code: 'LINUX_DELETE_RESULT_UNKNOWN' });

export function createLinuxDeleteExecutor({
  servicePublicKey, rootPublicKey, rootPrivateKey, helperPath, expectedHelperSha256,
  ledgerDirectory, resolveTrustedRun, isRunActive,
} = {}) {
  return async function executeLinuxDelete(capability) {
    let nativeInvocationStarted = false;
    try {
      const saved = JSON.parse(JSON.stringify(capability));
      if (process.platform !== 'linux' || process.geteuid?.() !== 0 ||
          typeof resolveTrustedRun !== 'function' || typeof isRunActive !== 'function' ||
          saved?.adapter !== SEMANTIC_ADAPTER_LINUX_FILE_DELETE_V1 ||
          !verifySemanticCapability(saved, { publicKey: servicePublicKey }).ok) return reject('LINUX_DELETE_CAPABILITY_REJECTED');
      const readRun = async () => JSON.parse(JSON.stringify(await resolveTrustedRun(saved.runId)));
      const verifyForRun = async (run) => verifyLinuxDeleteCapability({
        capability: saved, servicePublicKey, rootPublicKey, rootPrivateKey, helperPath, expectedHelperSha256,
        expectedContext: run?.expectedContext, trustedContext: run?.trustedContext, trustedProtectedRoots: run?.trustedProtectedRoots,
      });
      if (await isRunActive(saved.runId) !== true) return reject('LINUX_DELETE_RUN_INACTIVE');
      const firstRun = await readRun();
      if (!(await verifyForRun(firstRun)).ok) return reject('LINUX_DELETE_CAPABILITY_REJECTED');
      const record = { directory: ledgerDirectory, nonce: saved.nonce, capabilityId: saved.capabilityId,
        runId: saved.runId, selectionHash: saved.selectionManifestHash };
      const claim = await claimLinuxDeleteNonce(record);
      if (claim.state !== 'claimed') return reject(claim.code || 'LINUX_DELETE_LEDGER_UNAVAILABLE');

      // A consumed nonce is never restored, even if the run ends or the
      // operation fails before reaching the native helper.
      if (await isRunActive(saved.runId) !== true) return reject('LINUX_DELETE_RUN_INACTIVE');
      const currentRun = await readRun();
      const current = await verifyForRun(currentRun);
      if (!current.ok) return reject('LINUX_DELETE_REVALIDATION_FAILED');
      if ((await recordLinuxDeletePhase({ ...record, phase: 'started' })).state !== 'recorded') {
        return reject('LINUX_DELETE_LEDGER_UNAVAILABLE');
      }
      nativeInvocationStarted = true;
      const result = await removeVerifiedLinuxTarget({
        helperPath, expectedSha256: expectedHelperSha256, binding: current.binding,
        beforeExecute: async () => {
          const latestRun = await readRun();
          if (canonicalSemanticJson(latestRun) !== canonicalSemanticJson(currentRun) ||
              await isRunActive(saved.runId) !== true ||
              Date.parse(saved.issuedAt) > Date.now() ||
              !verifySemanticCapability(saved, { publicKey: servicePublicKey }).ok) return false;
          const attestation = saved.operations[0].adapterInput.linuxTargetAttestation;
          return verifyLinuxTargetAttestation(attestation, {
            publicKey: rootPublicKey, expectedContext: latestRun.expectedContext, expectedPath: current.binding.path,
          }).ok;
        },
      });
      const audit = await recordLinuxDeletePhase({ ...record, phase: 'result', resultState: result.state, code: result.code || '' });
      if (audit.state !== 'recorded') return unknown();
      return result;
    } catch {
      return nativeInvocationStarted ? unknown() : reject('LINUX_DELETE_EXECUTION_UNAVAILABLE');
    }
  };
}
