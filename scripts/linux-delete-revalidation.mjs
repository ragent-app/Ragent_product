/**
 * Root-side revalidation prototype. The selected decision, selection hash,
 * request context, run environment, helper identity and keys must be supplied
 * by trusted server/executor state, never by an agent request. This function
 * does not verify an owner capability, consume a nonce or execute deletion.
 */
import { posix as path } from 'node:path';
import { buildSemanticCapabilitySelection } from '../chat/semantic-capability.mjs';
import { canonicalSemanticJson, computeSemanticManifestHash } from '../chat/semantic-operation.mjs';
import { resolveSemanticContext } from '../chat/semantic-resolver.mjs';
import { evaluateSemanticOperation } from '../chat/semantic-policy.mjs';
import { deriveAgentoCSelfProtectionRoots } from '../chat/self-protection.mjs';
import { bindLinuxDeleteObservation } from '../chat/linux-delete-observation.mjs';
import { canonicalLinuxTargetContext, verifyLinuxTargetAttestation } from '../chat/linux-target-attestation.mjs';
import { inspectAndAttestLinuxTarget } from './linux-target-inspection.mjs';

const FIXED_PROTECTED_ROOTS = Object.freeze([
  '/opt/agentoc', '/etc/agentoc', '/var/lib/agentoc', '/var/log/agentoc',
  '/run/agentoc', '/var/lib/agentoc-privileged-target', '/var/log/agentoc-privileged',
]);

function absolute(value) {
  return typeof value === 'string' && value.startsWith('/') && path.normalize(value) === value &&
    !/[\x00-\x1f\x7f]/.test(value);
}

function invalid() {
  return { ok: false, code: 'LINUX_DELETE_REVALIDATION_FAILED' };
}

export async function revalidateLinuxDeleteSelection({
  boundDecision, expectedSelectionHash, expectedContext, trustedContext,
  trustedProtectedRoots = [], rootPublicKey, rootPrivateKey, helperPath, expectedHelperSha256,
} = {}) {
  try {
    if (process.platform !== 'linux' || process.geteuid?.() !== 0 || !/^[a-f0-9]{64}$/.test(expectedSelectionHash || '') ||
        !expectedContext || !trustedContext || !Array.isArray(trustedProtectedRoots) || trustedProtectedRoots.length === 0 ||
        !absolute(trustedContext.cwd) || !absolute(trustedContext.projectRoot) || !absolute(trustedContext.home) ||
        trustedProtectedRoots.some((entry) => !entry || !absolute(entry.path) || entry.available === false)) return invalid();
    const context = canonicalLinuxTargetContext(expectedContext);
    const runtime = { cwd: trustedContext.cwd, projectRoot: trustedContext.projectRoot, home: trustedContext.home, platform: 'linux' };
    const additionalRoots = trustedProtectedRoots.map((entry) => ({ label: entry.label, path: entry.path, available: entry.available }));
    const saved = JSON.parse(JSON.stringify(boundDecision));
    if (buildSemanticCapabilitySelection([saved]).selectionManifestHash !== expectedSelectionHash ||
        saved?.operationManifestHash !== computeSemanticManifestHash(saved?.operation) ||
        saved?.operation?.scope?.projectRoot !== runtime.projectRoot) return invalid();
    const op = saved.operation;
    const request = op.requestBinding;
    if (request?.sessionId !== context.sessionId || request?.runId !== context.runId ||
        request?.turnId !== context.turnId || request?.requestKey !== context.requestId) return invalid();
    const observation = op.target?.resourceSnapshot?.linuxTargetAttestation;
    const first = verifyLinuxTargetAttestation(observation, {
      publicKey: rootPublicKey, expectedContext: context, expectedPath: op.target?.root,
    });
    if (!first.ok) return invalid();

    const unbound = JSON.parse(JSON.stringify(op));
    delete unbound.target.resourceSnapshot.linuxTargetAttestation;
    const observedAt = unbound.target.resourceSnapshot.observedAt;
    if (typeof observedAt !== 'string' || !Number.isFinite(Date.parse(observedAt)) ||
        new Date(observedAt).toISOString() !== observedAt) return invalid();
    const protectedRoots = [
      ...deriveAgentoCSelfProtectionRoots({ platform: 'linux' }),
      ...FIXED_PROTECTED_ROOTS.map((root) => ({ label: 'system', path: root })),
      ...additionalRoots,
    ];
    const resolution = await resolveSemanticContext({
      operation: unbound, caller: {},
      options: { trustedContext: runtime, selfProtectionRoots: protectedRoots, now: observedAt },
    });
    const freshDecision = evaluateSemanticOperation(unbound, resolution);
    const rebound = bindLinuxDeleteObservation({ decision: freshDecision, attestation: observation, trustedPublicKey: rootPublicKey });
    if (rebound.operationManifestHash !== saved.operationManifestHash ||
        buildSemanticCapabilitySelection([rebound]).selectionManifestHash !== expectedSelectionHash) return invalid();

    const current = await inspectAndAttestLinuxTarget({
      helperPath, expectedSha256: expectedHelperSha256, privateKey: rootPrivateKey,
      targetPath: op.target.root, context,
    });
    const second = verifyLinuxTargetAttestation(current, {
      publicKey: rootPublicKey, expectedContext: context, expectedPath: op.target.root,
    });
    if (!second.ok || !verifyLinuxTargetAttestation(observation, {
      publicKey: rootPublicKey, expectedContext: context, expectedPath: op.target.root,
    }).ok || canonicalSemanticJson(first.binding) !== canonicalSemanticJson(second.binding)) return invalid();
    return { ok: true, binding: second.binding, selectionManifestHash: expectedSelectionHash };
  } catch {
    return invalid();
  }
}
