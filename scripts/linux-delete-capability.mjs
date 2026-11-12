/**
 * Root-side capability verification prototype. The caller must supply the
 * service verification key, root observation key, run context, protected
 * roots and helper identity from trusted local state. This does not consume a
 * nonce or execute the operation; it is not wired into the executor.
 */
import { SEMANTIC_ADAPTER_LINUX_FILE_DELETE_V1, verifySemanticCapability } from '../chat/semantic-capability.mjs';
import { SEMANTIC_POLICY_VERSION } from '../chat/semantic-operation.mjs';
import { revalidateLinuxDeleteSelection } from './linux-delete-revalidation.mjs';

export async function verifyLinuxDeleteCapability({
  capability, servicePublicKey, rootPublicKey, rootPrivateKey,
  trustedContext, expectedContext, trustedProtectedRoots, helperPath, expectedHelperSha256,
} = {}) {
  const rejected = { ok: false, code: 'LINUX_DELETE_CAPABILITY_REJECTED' };
  try {
    const saved = JSON.parse(JSON.stringify(capability));
    if (process.platform !== 'linux' || process.geteuid?.() !== 0 ||
        saved?.adapter !== SEMANTIC_ADAPTER_LINUX_FILE_DELETE_V1 ||
        Date.parse(saved.issuedAt) > Date.now() ||
        !verifySemanticCapability(saved, { publicKey: servicePublicKey }).ok ||
        !Array.isArray(saved.operations) || saved.operations.length !== 1) return rejected;
    const entry = saved.operations[0];
    const operation = entry?.adapterInput?.linuxDeleteOperation;
    const boundDecision = {
      decision: 'ASK', policyVersion: SEMANTIC_POLICY_VERSION, unknowns: [],
      operation, operationId: entry.operationId, operationManifestHash: entry.operationManifestHash,
      resolverSnapshotIdentity: entry.resourceSnapshotIdentity,
    };
    const revalidated = await revalidateLinuxDeleteSelection({
      boundDecision, expectedSelectionHash: saved.selectionManifestHash, expectedContext,
      trustedContext, trustedProtectedRoots, rootPublicKey, rootPrivateKey, helperPath, expectedHelperSha256,
    });
    if (!revalidated.ok || Date.parse(saved.issuedAt) > Date.now() || !verifySemanticCapability(saved, { publicKey: servicePublicKey }).ok) return rejected;
    // This return value is not an execution grant. In particular, the caller
    // must durably consume capability.nonce before acting and must check run
    // liveness again immediately before execution.
    return { ok: true, binding: revalidated.binding, capabilityId: saved.capabilityId, nonce: saved.nonce };
  } catch { return rejected; }
}
