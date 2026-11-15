import { createHash, createPublicKey, randomBytes, sign } from 'node:crypto';
import { sameWindowsSelectedInstaller, validateWindowsSelectedInstallerFacts } from './windows-winget-installer-facts.mjs';
import { authorizeWindowsAutomaticInstall, authorizeWindowsUserInstall } from './semantic-approval.mjs';
import { SEMANTIC_CAPABILITY_AUTH_MODE_POLICY_AUTO, signSemanticCapability, verifySemanticCapability } from './semantic-capability.mjs';
import { buildWindowsDispatchPermissionFacts } from './windows-executor-dispatch.mjs';
import {
  CAPABILITY_AUTHORIZATION_CLASSES, CAPABILITY_WORKLOAD_SCOPES, PERMISSION_MODES, createCapabilityGrant,
} from './permission-policy.mjs';
import { createCapabilityGrantProof, createPermissionFactsProof } from './permission-proof-verifier.mjs';

// Called only by the control plane with the admitted run profile and its
// instance key. The ordinary-user executor independently checks this signature,
// run binding, scope, identity and fresh package facts before claiming work.
export function createWindowsUserInstallAuthorization({ prepared, riskMode, kid, privateKey, expectedExecutionSid, now = Date.now() } = {}) {
  if (!privateKey || typeof kid !== 'string' || !kid.trim()) throw new Error('trusted signing key is required');
  if (!/^S-1-\d+(?:-\d+)+$/i.test(expectedExecutionSid || '')) throw new Error('trusted execution SID is required');
  const unsigned = authorizeWindowsUserInstall({ prepared, riskMode, kid, now });
  return signSemanticCapability({ ...unsigned, windowsExecutionSid: expectedExecutionSid }, privateKey);
}

/**
 * Produce the two signed, exact-operation envelopes required by the Windows
 * dispatch gate. This must run only in the control plane after the profile and
 * projection have been read from the admitted run. The executor independently
 * verifies both proofs, revalidates the package and consumes the nonce.
 */
export function createWindowsAutoInstallAuthorization({ prepared, riskMode, kid, privateKey, now = Date.now() } = {}) {
  if (!privateKey || typeof kid !== 'string' || !kid.trim()) throw new Error('trusted signing key is required');
  const unsigned = authorizeWindowsAutomaticInstall({ prepared, riskMode, kid, now });
  const capability = signSemanticCapability(unsigned, privateKey);
  const operation = prepared.projection.decisions[0].operation;
  const facts = buildWindowsDispatchPermissionFacts(operation, capability);
  const signedFacts = createPermissionFactsProof({ operation, facts, privateKey, kid, now, ttlMs: 60_000 });
  const grant = createCapabilityGrant({
    mode: PERMISSION_MODES.STANDARD,
    issuedAtTurn: operation.requestBinding.turnId,
    issuedAt: new Date(now), ttlMs: 60_000, usageMax: 1,
    authorizationClass: CAPABILITY_AUTHORIZATION_CLASSES.POLICY_AUTO,
    workload: { scope: CAPABILITY_WORKLOAD_SCOPES.ONE_OPERATION,
      sessionId: operation.requestBinding.sessionId, runId: operation.requestBinding.runId,
      turnId: operation.requestBinding.turnId, operationId: operation.operationId, turnBinding: 'provenance' },
    constraints: {
      action: operation.primaryAction, scope: facts.scope, resourceSnapshotIdentity: facts.resourceSnapshotIdentity,
      executionClass: facts.executionClass,
      impact: { reversible: facts.impact.reversible, containsSensitiveMaterial: facts.impact.containsSensitiveMaterial, containsGitMetadata: facts.impact.containsGitMetadata },
      target: operation.target, targetFlags: { recursive: false, force: false, exact: facts.selection.exact === true },
      resource: facts.resource, selection: facts.selection, effects: { subset: operation.effects },
    },
  });
  return {
    capability, operation, facts: signedFacts,
    grant: createCapabilityGrantProof({ grant, privateKey, kid, now, ttlMs: 60_000 }),
    useNonce: randomBytes(24).toString('base64url'),
  };
}

// Native broker wire format. Property order is part of this v1 signature and
// matches the Go struct in native/windows-privileged-broker/auto_install.go.
export function createWindowsBrokerAutoInstallGrant({ authorization, requestId, actionId, kid, privateKey, brokerInstallationId, policyGeneration, observedSelectedInstaller, now = Date.now() } = {}) {
  const cap = authorization?.capability;
  if (!privateKey || !verifySemanticCapability(cap, { publicKey: createPublicKey(privateKey), now }).ok
      || cap.authMode !== SEMANTIC_CAPABILITY_AUTH_MODE_POLICY_AUTO || cap.kid !== kid || !/^[A-Za-z0-9._:-]{1,128}$/.test(kid || '')
      || !/^[A-Za-z0-9._:-]{1,128}$/.test(brokerInstallationId || '') || !Number.isSafeInteger(policyGeneration) || policyGeneration < 1
      || !/^[A-Za-z0-9._:-]{1,128}$/.test(requestId || '') || !/^[A-Za-z0-9._:-]{1,128}$/.test(actionId || '')) {
    throw new Error('invalid automatic installation authorization or binding');
  }
  const operation = cap.operations[0];
  const input = operation?.adapterInput || {};
  if (input.selectedInstaller && observedSelectedInstaller && !sameWindowsSelectedInstaller(input.selectedInstaller, observedSelectedInstaller, {
    packageId: input.packages?.[0], packageVersion: input.resolvedVersions?.[0],
  })) throw new Error('selected installer changed before broker authorization');
  const selectedInput = input.selectedInstaller || observedSelectedInstaller;
  const selectedInstaller = selectedInput == null ? null : validateWindowsSelectedInstallerFacts(selectedInput, {
    packageId: input.packages?.[0], packageVersion: input.resolvedVersions?.[0],
  });
  if (selectedInput && (!selectedInstaller || selectedInstaller.scope !== 'System' || selectedInstaller.elevation === 'ElevationProhibited')) {
    throw new Error('selected installer cannot run in the system installation context');
  }
  if (input.packages?.length !== 1 || input.resolvedVersions?.length !== 1 || input.source !== 'winget' || input.requestedInstallScope !== 'machine'
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(input.packages[0] || '')
      || !/^[A-Za-z0-9][A-Za-z0-9._+:-]{0,127}$/.test(input.resolvedVersions[0] || '')
      || [cap.sessionId, cap.runId, cap.turnId].some((value) => !/^[A-Za-z0-9._:-]{1,128}$/.test(value || ''))) {
    throw new Error('automatic installation requires one exact package and version');
  }
  const expires = Math.min(Date.parse(cap.expiresAt), now + 60_000);
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(expires) || expires <= now) throw new Error('automatic installation authorization expired');
  const grant = {
    version: 1, keyId: kid, brokerInstallationId, policyGeneration, requestId, sessionId: cap.sessionId, runId: cap.runId, turnId: cap.turnId, actionId,
    nonce: randomBytes(24).toString('base64url'), packageId: input.packages[0], packageVersion: input.resolvedVersions[0],
    source: 'winget', installScope: 'machine', ...(selectedInstaller ? { selectedInstaller } : {}), issuedMs: now, expiresMs: expires,
  };
  const payload = Buffer.concat([Buffer.from('Ragent Windows auto install v1\0', 'utf8'), Buffer.from(JSON.stringify(grant), 'utf8')]);
  return { grant, signature: sign(null, payload, privateKey).toString('base64url') };
}

// Submit exactly once. A transport failure after submission is ambiguous: the
// caller must poll this request ID, never manufacture a fresh grant and retry.
export async function submitWindowsBrokerAutoInstall({ client, prepared, riskMode, requestId, actionId, kid, privateKey, assertActive, now = Date.now() } = {}) {
  if (!client || typeof client.health !== 'function' || typeof client.executeAutoInstall !== 'function') {
    throw Object.assign(new Error('Windows installation broker is unavailable'), { code: 'AUTO_INSTALL_BROKER_UNAVAILABLE' });
  }
  const authorization = createWindowsAutoInstallAuthorization({ prepared, riskMode, kid, privateKey, now });
  const health = await client.health();
  if (health?.type !== 'health' || health.autoInstallReady !== true || health.autoInstallKeyId !== kid) {
    throw Object.assign(new Error('Windows installation broker is not configured for this signing key'), { code: 'AUTO_INSTALL_BROKER_NOT_READY' });
  }
  const input = authorization.capability.operations[0].adapterInput;
  let observedSelectedInstaller = null;
  if (typeof client.inspectAutoInstall === 'function') {
    try { observedSelectedInstaller = await client.inspectAutoInstall({ packageId: input.packages[0], packageVersion: input.resolvedVersions[0] }); }
    catch (error) {
      if (error?.code === 'BROKER_RESPONSE_INVALID') throw Object.assign(new Error('Installer inspection returned inconsistent facts'), { code: 'AUTO_INSTALL_INSPECTION_INVALID' });
      // A legacy or temporarily unavailable inspection preserves the existing machine-install path.
    }
  }
  if (input.selectedInstaller && !observedSelectedInstaller) throw Object.assign(new Error('Selected installer inspection is unavailable'), { code: 'AUTO_INSTALL_INSPECTION_UNAVAILABLE' });
  if (observedSelectedInstaller?.elevation === 'ElevationProhibited') throw Object.assign(new Error('The selected installer prohibits elevated execution'), { code: 'AUTO_INSTALL_ELEVATION_PROHIBITED' });
  const { grant, signature } = createWindowsBrokerAutoInstallGrant({
    authorization, requestId, actionId, kid, privateKey,
    brokerInstallationId: health.installationId, policyGeneration: health.policyGeneration, observedSelectedInstaller, now,
  });
  // Health and package inspection can take tens of seconds. A cancelled run or
  // changed permission profile must not start a new installation afterward.
  if (typeof assertActive === 'function') await assertActive();
  let result;
  try {
    result = await client.executeAutoInstall({ grant, signature });
  } catch (cause) {
    throw Object.assign(new Error('Windows installation outcome is unknown; query the original request'), {
      code: 'AUTO_INSTALL_OUTCOME_UNKNOWN', requestId, cause,
    });
  }
  if (result?.type === 'error') {
    throw Object.assign(new Error('Windows installation broker rejected the request'), { code: result.code || 'AUTO_INSTALL_REJECTED', requestId });
  }
  if (result?.type !== 'result' || result.requestId !== requestId || !['executing', 'succeeded', 'failed', 'unknown'].includes(result.status)) {
    throw Object.assign(new Error('Windows installation outcome is unknown; query the original request'), { code: 'AUTO_INSTALL_OUTCOME_UNKNOWN', requestId });
  }
  return result;
}

// Poll only the original request. An unavailable broker, unrecognized reply,
// cancellation or elapsed deadline cannot establish whether a process ran.
export async function waitWindowsBrokerAutoInstall({ client, requestId, signal, timeoutMs = 10 * 60_000, intervalMs = 1000,
  monotonicNow = () => performance.now(), delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  if (!client || typeof client.status !== 'function' || !/^[A-Za-z0-9._:-]{1,128}$/.test(requestId || '') ||
      !Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw Object.assign(new Error('Invalid installation status request'), { code: 'AUTO_INSTALL_STATUS_INVALID' });
  }
  const deadline = monotonicNow() + timeoutMs;
  const unknown = () => ({ type: 'result', requestId, status: 'unknown', code: 'AUTO_INSTALL_OUTCOME_UNKNOWN' });
  while (!signal?.aborted && monotonicNow() < deadline) {
    let response;
    try { response = await client.status(requestId); } catch { return unknown(); }
    if (response?.type !== 'result' || response.requestId !== requestId) return unknown();
    if (['succeeded', 'failed', 'unknown'].includes(response.status)) return response;
    if (response.status !== 'executing') return unknown();
    const remaining = deadline - monotonicNow();
    if (remaining <= 0 || signal?.aborted) break;
    await delay(Math.min(intervalMs, remaining));
  }
  return unknown();
}

// A caller retry uses the same broker request ID and consults durable service
// state first. It must never retry an ambiguous submission under a new ID.
export function windowsBrokerInstallRequestIds(binding = {}) {
  if (['sessionId', 'runId', 'turnId', 'requestKey'].some((key) => typeof binding[key] !== 'string' || !binding[key].trim())) {
    throw Object.assign(new Error('Automatic installation requires a stable request binding'), { code: 'AUTO_INSTALL_BINDING_INVALID' });
  }
  const digest = createHash('sha256').update(JSON.stringify([binding.sessionId, binding.runId, binding.turnId, binding.requestKey])).digest('hex');
  return { requestId: `auto_${digest}`, actionId: `action_${digest}` };
}

// Status lookup is intentionally independent of current package metadata: a
// catalog update must not turn a query into a new operation or conceal the
// outcome of an already admitted version.
export async function queryWindowsBrokerAutoInstall({ client, binding } = {}) {
  const { requestId, actionId } = windowsBrokerInstallRequestIds(binding);
  if (!client || typeof client.status !== 'function') throw Object.assign(new Error('Windows installation broker is unavailable'), { code: 'AUTO_INSTALL_BROKER_UNAVAILABLE' });
  const result = await client.status(requestId);
  if (result?.type === 'result' && result.requestId === requestId && result.code === 'REQUEST_NOT_FOUND' && !result.status) {
    return { status: 'unknown', code: 'AUTO_INSTALL_REQUEST_NOT_FOUND', requestId };
  }
  if (result?.type === 'result' && result.requestId === requestId && /^[a-f0-9]{64}$/.test(result.msiDigest || '') &&
      /^[a-f0-9]{64}$/.test(result.msiBinding || '') && ['executing','succeeded','failed','unknown'].includes(result.status)) {
    return { status: result.status, code: result.code || '', requestId, duplicate: true };
  }
  const grant = result?.autoInstall || result?.ownerInstall;
  if (result?.type !== 'result' || result.requestId !== requestId || !['executing', 'succeeded', 'failed', 'unknown'].includes(result.status) ||
      !grant || !['machine', 'user', 'default'].includes(grant.installScope) || grant.requestId !== requestId || grant.actionId !== actionId || grant.sessionId !== binding.sessionId ||
      grant.runId !== binding.runId || grant.turnId !== binding.turnId || grant.source !== 'winget') {
    throw Object.assign(new Error('Existing installation request does not match this run'), { code: 'AUTO_INSTALL_BINDING_CONFLICT', requestId });
  }
  return { status: result.status, code: result.code || '', requestId, duplicate: true };
}

export async function submitOrResumeWindowsBrokerAutoInstall(options = {}) {
  const { client, prepared, riskMode, kid, privateKey, assertActive, now = Date.now() } = options;
  const binding = prepared?.binding || {};
  if (!client || typeof client.status !== 'function' || typeof binding.requestKey !== 'string' || !binding.requestKey.trim()) {
    throw Object.assign(new Error('Automatic installation requires a stable request binding'), { code: 'AUTO_INSTALL_BINDING_INVALID' });
  }
  const authorization = createWindowsAutoInstallAuthorization({ prepared, riskMode, kid, privateKey, now });
  const input = authorization.capability.operations[0].adapterInput;
  const { requestId, actionId } = windowsBrokerInstallRequestIds(binding);
  let prior = await client.status(requestId);
  if (prior?.type === 'result' && prior.requestId === requestId && prior.code === 'REQUEST_NOT_FOUND' && !prior.status) {
    try {
      return await submitWindowsBrokerAutoInstall({ client, prepared, riskMode, requestId, actionId, kid, privateKey, assertActive, now });
    } catch (error) {
      if (error?.code !== 'REQUEST_ID_CONFLICT') throw error;
      // Another submission may have claimed the same request after our
      // initial status lookup. Never issue a second grant: read and verify
      // the durable request, including package and version, below.
      try { prior = await client.status(requestId); }
      catch (cause) {
        throw Object.assign(new Error('Windows installation outcome is unknown; query the original request'), {
          code: 'AUTO_INSTALL_OUTCOME_UNKNOWN', requestId, cause,
        });
      }
    }
  }
  const grant = prior?.autoInstall;
  if (prior?.type !== 'result' || prior.requestId !== requestId || !['executing', 'succeeded', 'failed', 'unknown'].includes(prior.status) ||
      !grant || grant.installScope !== 'machine' || grant.requestId !== requestId || grant.actionId !== actionId || grant.sessionId !== binding.sessionId ||
      grant.runId !== binding.runId || grant.turnId !== binding.turnId || grant.packageId !== input.packages?.[0] ||
      grant.packageVersion !== input.resolvedVersions?.[0] || grant.source !== 'winget' ||
      (grant.selectedInstaller && (!validateWindowsSelectedInstallerFacts(grant.selectedInstaller,
        { packageId: input.packages?.[0], packageVersion: input.resolvedVersions?.[0] }) || grant.selectedInstaller.scope !== 'System' || grant.selectedInstaller.elevation === 'ElevationProhibited')) ||
      (input.selectedInstaller && !grant.selectedInstaller) ||
      (input.selectedInstaller && !sameWindowsSelectedInstaller(grant.selectedInstaller, input.selectedInstaller,
        { packageId: input.packages?.[0], packageVersion: input.resolvedVersions?.[0] }))) {
    throw Object.assign(new Error('Existing installation request does not match this operation'), { code: 'AUTO_INSTALL_BINDING_CONFLICT', requestId });
  }
  return { ...prior, duplicate: true };
}
