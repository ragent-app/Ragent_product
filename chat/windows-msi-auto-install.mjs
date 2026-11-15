import { createHash, createPublicKey, randomBytes, sign } from 'node:crypto';
import { authorizeWindowsMSIAutomaticInstall } from './semantic-approval.mjs';
import { signSemanticCapability, verifySemanticCapability } from './semantic-capability.mjs';
import { windowsBrokerInstallRequestIds } from './windows-auto-install-authorization.mjs';

// Go's encoding/json escapes HTML characters and the JS line separators.
function goJSON(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
export function msiGrantBytes(grant) {
  return Buffer.concat([Buffer.from('Ragent Windows MSI install v1\0'), Buffer.from(goJSON(grant))]);
}

export async function submitOrResumeWindowsMSIInstall({ client, prepared, riskMode, kid, privateKey, assertActive, preflight = false } = {}) {
  if (!privateKey || !kid || !client || typeof client.health !== 'function' || typeof client.status !== 'function' ||
      typeof client.inspectMSIInstall !== 'function' || typeof client.executeMSIInstall !== 'function') throw Object.assign(new Error('MSI installation broker unavailable'), { code: 'MSI_INSTALL_UNAVAILABLE' });
  const unsigned = authorizeWindowsMSIAutomaticInstall({ prepared, riskMode, kid });
  const capability = signSemanticCapability(unsigned, privateKey);
  if (!verifySemanticCapability(capability, { publicKey: createPublicKey(privateKey) }).ok) throw new Error('MSI authorization signature invalid');
  const input = capability.operations[0].adapterInput;
  const binding = prepared.binding;
  const { requestId, actionId } = windowsBrokerInstallRequestIds(binding);
  const expectedBinding = createHash('sha256').update(goJSON([requestId, binding.sessionId, binding.runId, binding.turnId, actionId, input.artifactPath, input.artifactDigest])).digest('hex');
  const health = await client.health();
  if (health?.type !== 'health' || health.msiInstallReady !== true || health.autoInstallKeyId !== kid) throw Object.assign(new Error('MSI broker is not configured'), { code: 'MSI_INSTALL_NOT_READY' });
  const prior = await client.status(requestId);
  if (prior?.type === 'result' && prior.requestId === requestId && prior.code === 'REQUEST_NOT_FOUND' && !prior.status) {
    const facts = await client.inspectMSIInstall({ artifactPath: input.artifactPath, artifactSha256: input.artifactDigest });
    if (typeof assertActive !== 'function') throw new Error('active run verification is required');
    await assertActive();
    if (preflight) return { ready: true };
    const issuedMs = Date.now();
    const expiresMs = Math.min(Date.parse(capability.expiresAt), issuedMs + 60_000);
    if (!Number.isSafeInteger(expiresMs) || expiresMs <= issuedMs) throw Object.assign(new Error('MSI authorization expired'), { code: 'MSI_INSTALL_AUTHORIZATION_EXPIRED' });
    const grant = { version: 1, keyId: kid, brokerInstallationId: health.installationId, policyGeneration: health.policyGeneration,
      requestId, sessionId: binding.sessionId, runId: binding.runId, turnId: binding.turnId, actionId,
      nonce: randomBytes(24).toString('base64url'), artifactPath: input.artifactPath, artifactSha256: input.artifactDigest,
      publisherSha256: facts.publisherSha256, issuedMs, expiresMs };
    const bytes = msiGrantBytes(grant);
    const expectedDigest = createHash('sha256').update(bytes).digest('hex');
    let result;
    try { result = await client.executeMSIInstall({ grant, signature: sign(null, bytes, privateKey).toString('base64url') }); }
    catch (cause) { throw Object.assign(new Error('MSI installation outcome is unknown; query the original request'), { code: 'MSI_INSTALL_OUTCOME_UNKNOWN', requestId, cause }); }
    if (result?.type !== 'result' || result.requestId !== requestId || result.msiDigest !== expectedDigest || result.msiBinding !== expectedBinding || !['executing','succeeded','failed','unknown'].includes(result.status)) {
      throw Object.assign(new Error('MSI installation response was not bound to the request'), { code: result?.code || 'MSI_INSTALL_OUTCOME_UNKNOWN', requestId });
    }
    return result;
  }
  if (prior?.type !== 'result' || prior.requestId !== requestId || !/^[a-f0-9]{64}$/.test(prior.msiDigest || '') || prior.msiBinding !== expectedBinding || !['executing','succeeded','failed','unknown'].includes(prior.status)) {
    throw Object.assign(new Error('Existing installation request does not match this operation'), { code: 'MSI_INSTALL_BINDING_CONFLICT', requestId });
  }
  return preflight ? { ready: true } : { ...prior, duplicate: true };
}
