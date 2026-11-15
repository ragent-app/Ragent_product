import { randomBytes, sign } from 'node:crypto';
import { authorizeWindowsUserInstall } from './semantic-approval.mjs';
import { windowsBrokerInstallRequestIds } from './windows-auto-install-authorization.mjs';

// Only a server-derived policy projection and identity returned by the
// verified broker may produce this envelope. Its key order matches Go's
// ownerInstallGrant JSON struct and is part of the signature.
export function createWindowsOwnerBrokerGrant({ prepared, riskMode, kid, privateKey, health, identity, now = Date.now() } = {}) {
  const fail = () => { throw Object.assign(new Error('Owner installation authorization is unavailable'), { code: 'OWNER_INSTALL_AUTHORIZATION_INVALID' }); };
  if (!privateKey || health?.type !== 'health' || health.autoInstallReady !== true || health.autoInstallKeyId !== kid ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(health.installationId || '') || !Number.isSafeInteger(health.policyGeneration) || health.policyGeneration < 1 ||
      !/^inst_[a-f0-9]{32}$/.test(identity?.instanceId || '') || identity.instanceId !== kid || !/^S-1-5-21-(?:\d+-){3}\d+$/.test(identity.ownerSid || '') ||
      !Number.isSafeInteger(now) || now <= 0) fail();
  const capability = authorizeWindowsUserInstall({ prepared, riskMode, kid, now });
  const input = capability.operations?.[0]?.adapterInput;
  if (!['', 'user'].includes(input?.requestedInstallScope) || input?.source !== 'winget' || input?.packages?.length !== 1 || input?.resolvedVersions?.length !== 1 ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(input.packages[0] || '') || !/^[A-Za-z0-9][A-Za-z0-9._+:-]{0,127}$/.test(input.resolvedVersions[0] || '')) fail();
  const binding = prepared.binding;
  const { requestId, actionId } = windowsBrokerInstallRequestIds(binding);
  if ([binding.sessionId, binding.runId, binding.turnId].some((id) => !/^[A-Za-z0-9._:-]{1,128}$/.test(id || ''))) fail();
  const expiresMs = Math.min(Date.parse(capability.expiresAt), now + 60000);
  if (!Number.isSafeInteger(expiresMs) || expiresMs <= now) fail();
  const grant = { version: 1, keyId: kid, brokerInstallationId: health.installationId, policyGeneration: health.policyGeneration,
    instanceId: identity.instanceId, ownerSid: identity.ownerSid, requestId, sessionId: binding.sessionId, runId: binding.runId,
    turnId: binding.turnId, actionId, nonce: randomBytes(24).toString('base64url'), packageId: input.packages[0],
    packageVersion: input.resolvedVersions[0], source: 'winget', installScope: input.requestedInstallScope || 'default', issuedMs: now, expiresMs };
  const bytes = Buffer.concat([Buffer.from('Ragent Windows owner auto install v1\0'), Buffer.from(JSON.stringify(grant))]);
  return { grant, signature: sign(null, bytes, privateKey).toString('base64url') };
}

export async function submitOrResumeWindowsOwnerBrokerInstall({ client, prepared, riskMode, kid, privateKey, assertActive } = {}) {
  if (!client || typeof client.status !== 'function' || typeof client.ownerInstallIdentity !== 'function' || typeof client.executeOwnerInstall !== 'function' || typeof assertActive !== 'function') {
    throw Object.assign(new Error('Owner installation broker unavailable'), { code: 'OWNER_INSTALL_UNAVAILABLE' });
  }
  const capability = authorizeWindowsUserInstall({ prepared, riskMode, kid });
  const input = capability.operations?.[0]?.adapterInput;
  if (!['', 'user'].includes(input?.requestedInstallScope)) throw Object.assign(new Error('Unsupported installation scope'), { code: 'OWNER_INSTALL_AUTHORIZATION_INVALID' });
  const binding = prepared.binding;
  const { requestId, actionId } = windowsBrokerInstallRequestIds(binding);
  const validateExisting = (result) => {
    const grant = result?.ownerInstall;
    if (result?.type !== 'result' || result.requestId !== requestId || !['executing', 'succeeded', 'failed', 'unknown'].includes(result.status) ||
        !grant || grant.requestId !== requestId || grant.actionId !== actionId || grant.sessionId !== binding.sessionId || grant.runId !== binding.runId ||
        grant.turnId !== binding.turnId || grant.packageId !== input.packages?.[0] || grant.packageVersion !== input.resolvedVersions?.[0] ||
        grant.installScope !== (input.requestedInstallScope || 'default') || grant.source !== 'winget' || grant.keyId !== kid) {
      throw Object.assign(new Error('Existing installation does not match the run'), { code: 'AUTO_INSTALL_BINDING_CONFLICT', requestId });
    }
    return { ...result, duplicate: true };
  };
  let existing = await client.status(requestId);
  if (!(existing?.type === 'result' && existing.requestId === requestId && existing.code === 'REQUEST_NOT_FOUND' && !existing.status)) return validateExisting(existing);
  const [health, identity] = await Promise.all([client.health(), client.ownerInstallIdentity()]);
  const { grant, signature } = createWindowsOwnerBrokerGrant({ prepared, riskMode, kid, privateKey, health, identity });
  await assertActive();
  let result;
  try { result = await client.executeOwnerInstall({ grant, signature }); }
  catch (cause) { throw Object.assign(new Error('Owner installation outcome is unknown'), { code: 'AUTO_INSTALL_OUTCOME_UNKNOWN', requestId, cause }); }
  if (result?.type === 'error' && result.code === 'REQUEST_ID_CONFLICT') {
    try { existing = await client.status(requestId); } catch (cause) { throw Object.assign(new Error('Owner installation outcome is unknown'), { code: 'AUTO_INSTALL_OUTCOME_UNKNOWN', requestId, cause }); }
    return validateExisting(existing);
  }
  if (result?.type === 'error') throw Object.assign(new Error('Owner installation rejected'), { code: result.code || 'OWNER_INSTALL_REJECTED', requestId });
  if (result?.type !== 'result' || result.requestId !== requestId || !['executing', 'succeeded', 'failed', 'unknown'].includes(result.status)) {
    throw Object.assign(new Error('Owner installation outcome is unknown'), { code: 'AUTO_INSTALL_OUTCOME_UNKNOWN', requestId });
  }
  return result;
}
