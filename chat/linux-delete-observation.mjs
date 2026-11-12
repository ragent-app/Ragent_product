/**
 * Attach a verified native observation to a server-computed semantic ASK.
 * This is not an authorization endpoint: the decision and trusted public key
 * MUST come from the server's persisted policy pipeline and protected key
 * store, not from a model or client. No execution adapter is enabled here.
 */
import { computeSemanticManifestHash, SEMANTIC_POLICY_VERSION, SEMANTIC_RESOLVER_VERSION } from './semantic-operation.mjs';
import { evaluateSemanticOperation } from './semantic-policy.mjs';
import { verifyLinuxTargetAttestation } from './linux-target-attestation.mjs';

function fail(message) {
  const error = new Error(message);
  error.code = 'LINUX_DELETE_OBSERVATION_INVALID';
  throw error;
}

export function bindLinuxDeleteObservation({ decision, attestation, trustedPublicKey, now = Date.now() } = {}) {
  // Work on private copies so the returned manifest cannot be altered through
  // references held by the caller after its hash has been computed.
  let candidate, observation;
  try { candidate = JSON.parse(JSON.stringify(decision)); observation = JSON.parse(JSON.stringify(attestation)); }
  catch { fail('invalid policy decision or observation'); }
  const op = candidate?.operation;
  const snapshot = op?.target?.resourceSnapshot;
  const path = op?.target?.root;
  const request = op?.requestBinding;
  if (candidate?.decision !== 'ASK' || candidate.policyVersion !== SEMANTIC_POLICY_VERSION ||
      !Array.isArray(candidate.unknowns) || candidate.unknowns.length !== 0 ||
      !op || candidate.operationId !== op.operationId || candidate.operationManifestHash !== computeSemanticManifestHash(op) ||
      op.primaryAction !== 'fs.delete' || op.executionClass !== 'host' ||
      JSON.stringify(op.effects) !== JSON.stringify(['process.execute']) ||
      op.target?.platform !== 'linux' || op.target?.kind !== 'filesystem_file' ||
      !snapshot || snapshot.resolverVersion !== SEMANTIC_RESOLVER_VERSION ||
      !snapshot.identity || candidate.resolverSnapshotIdentity !== snapshot.identity ||
      Object.hasOwn(snapshot, 'linuxTargetAttestation') || !Array.isArray(snapshot.paths) || snapshot.paths.length !== 1 ||
      op.scope?.computed !== true || op.scope?.selfProtection?.computed !== true || op.scope?.selfProtection?.matched !== false ||
      op.impact?.estimatedItems !== 1 || op.impact?.containsSensitiveMaterial !== false || op.impact?.containsGitMetadata !== false) {
    fail('semantic operation is not a complete single-file host ASK');
  }
  // Reapply current semantic policy to the server-owned facts. In particular,
  // a DENY for a system, sensitive or self-protected target cannot be relabeled
  // as an approvable operation by this binding layer.
  const reevaluated = evaluateSemanticOperation(op, {
    scope: op.scope, impact: op.impact, resourceSnapshot: snapshot, unknowns: candidate.unknowns,
  });
  if (reevaluated.decision !== 'ASK' || !Array.isArray(reevaluated.unknowns) || reevaluated.unknowns.length !== 0 ||
      reevaluated.operationManifestHash !== candidate.operationManifestHash) {
    fail('semantic policy no longer permits owner review');
  }
  const context = { sessionId: request?.sessionId, runId: request?.runId, turnId: request?.turnId, requestId: request?.requestKey };
  const verified = verifyLinuxTargetAttestation(observation, { publicKey: trustedPublicKey, expectedContext: context, expectedPath: path, now });
  if (!verified.ok) fail('target observation is not valid for this request');
  const facts = verified.binding;
  const resolved = snapshot.paths[0];
  if (!resolved || resolved.requested !== path || resolved.canonical !== path ||
      resolved.identity !== `${facts.device}:${facts.inode}` ||
      resolved.expectedParentIdentity !== `${facts.parentDevice}:${facts.parentInode}` ||
      facts.device !== facts.parentDevice || resolved.mountId !== facts.device ||
      resolved.noFollow !== false || resolved.parentIsDirectory !== true ||
      !Array.isArray(resolved.symlinkChain) || resolved.symlinkChain.length !== 0 ||
      !Array.isArray(resolved.missingPathSegments) || resolved.missingPathSegments.length !== 0) {
    fail('native and semantic target identities do not match');
  }
  op.target.resourceSnapshot.linuxTargetAttestation = observation;
  candidate.operationManifestHash = computeSemanticManifestHash(op);
  return candidate;
}
