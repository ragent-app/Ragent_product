#!/usr/bin/env node
/**
 * Phase 2B-5: Phase 2A permission policy gate on the Windows dispatch chain
 * (chat/windows-executor-dispatch.mjs).
 *
 * The signed semantic-capability chain (signature -> nonce -> revalidation ->
 * fixed-argv exec) is preserved, and an additional authoritative Phase 2A
 * policy gate runs after the signature verifies and immediately before target
 * revalidation/exec. The gate is fail-closed:
 *
 *   - a host-capable Windows operation with no server-computed facts envelope,
 *     or with facts but no trusted resolver proof, is DENIED;
 *   - a valid signed facts proof WITHOUT an exact matching Phase 2A capability
 *     is ASK at most (the executor never proceeds);
 *   - an exact matching Phase 2A capability ALLOWs and the dispatch proceeds;
 *   - platform/executionClass smuggling is DENIED;
 *   - the existing signature/nonce/revalidation chain still runs in order when
 *     the gate passes.
 */

import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { createWindowsAutoInstallAuthorization, createWindowsBrokerAutoInstallGrant, queryWindowsBrokerAutoInstall, submitWindowsBrokerAutoInstall, submitOrResumeWindowsBrokerAutoInstall, waitWindowsBrokerAutoInstall } from '../chat/windows-auto-install-authorization.mjs';
import { getWindowsManagedAutoInstallStatus, prepareWindowsManagedUserInstall, tryWindowsManagedAutoInstall, verifyWindowsManagedUserInstallAuthorization } from '../chat/windows-managed-auto-install.mjs';
import { createWindowsPrivilegedBrokerClient } from '../chat/windows-privileged-broker.mjs';

import { compileSemanticOperations } from '../chat/semantic-compiler.mjs';
import { evaluateSemanticOperation } from '../chat/semantic-policy.mjs';
import { resolveSemanticContext } from '../chat/semantic-resolver.mjs';
import {
  SEMANTIC_ADAPTER_WINGET_INSTALL_V1,
  createSemanticCapability,
  signSemanticCapability,
  verifySemanticCapability,
} from '../chat/semantic-capability.mjs';
import {
  buildWindowsDispatchPermissionFacts,
  createWindowsDispatchPolicyGate,
  createWindowsNonceTracker,
  defaultWindowsDispatchPolicyGate,
  dispatchWindowsSemanticExec,
} from '../chat/windows-executor-dispatch.mjs';
import {
  CAPABILITY_WORKLOAD_SCOPES,
  PERMISSION_MODES,
  PERMISSION_REASON_CODES,
  createCapabilityGrant,
} from '../chat/permission-policy.mjs';
import {
  createCapabilityGrantProof,
  createPermissionFactsProof,
  createPermissionProofVerifier,
} from '../chat/permission-proof-verifier.mjs';

let passed = 0;
function check(label, condition) {
  assert.ok(condition, `failed: ${label}`);
  passed += 1;
}
function eq(label, actual, expected) {
  assert.equal(actual, expected, `failed: ${label}`);
  passed += 1;
}

// ── server fixture: a real signed win32 winget semantic capability ─────────────

const NOW = Date.parse('2026-08-12T00:00:00.000Z');
const keys = generateKeyPairSync('ed25519');
const kid = 'kid_win_policy';
const binding = { sessionId: 's_win_policy', runId: 'r_win_policy', turnId: 't_win_policy', requestKey: 'req_win_policy', executionClass: 'host' };
const trustedContext = { cwd: 'C:\\project', projectRoot: 'C:\\project', home: 'C:\\Users\\owner', platform: 'win32' };
const compile = (rawCommand) => compileSemanticOperations({ request: { ...binding, rawCommand }, trustedContext });
const packageOperation = compile('winget install --id Git.Git --exact --source winget --scope machine').operations[0];
// A server resolver marks complete effect enumeration before minting a
// Phase 2A capability; buildPermissionFacts requires it.
packageOperation.analysis.effectsComplete = true;
const packageResolution = await resolveSemanticContext({
  operation: packageOperation,
  options: {
    trustedContext,
    windowsFactsProvider: {
      name: 'winget-fixture',
      async packageFacts(query) {
        return {
          manager: 'winget',
          source: 'winget',
          sourceTrust: 'configured',
          repositories: [{ id: 'winget', trust: 'configured' }],
          packages: query.packages.map((name) => ({ name, requestedVersion: '', availableVersion: '2.0' })),
        };
      },
    },
  },
});
const packageDecision = evaluateSemanticOperation(packageOperation, packageResolution);
const resolvedOperation = packageDecision.operation;
eq('server decision for winget install is ASK', packageDecision.decision, 'ASK');

const unsigned = createSemanticCapability({
  selectedDecisions: [packageDecision],
  adapter: SEMANTIC_ADAPTER_WINGET_INSTALL_V1,
  sessionId: 's_win_policy', runId: 'r_win_policy', turnId: 't_win_policy', credentialId: 'cred_win_policy', kid, now: NOW,
});
const signedCapability = signSemanticCapability(unsigned, keys.privateKey);
const publicKeyByKid = async (inputKid) => (inputKid === kid ? keys.publicKey : null);
const okRevalidate = async () => ({
  ok: true,
  code: '',
  invocation: { executable: 'C:\\Windows\\System32\\where.exe', argv: ['notepad'], cwd: 'C:\\' },
});
const okExec = async () => ({ ok: true, code: '', result: { exitCode: 0, stdout: 'C:\\Windows\\System32\\notepad.exe', stderr: '' } });

// Server-computed facts derived ONLY from the capability's bound operation /
// resolver snapshot / Windows facts (never requester-declared).
const serverFacts = buildWindowsDispatchPermissionFacts(resolvedOperation, signedCapability);
check('server facts derive the win32 resource from the capability', serverFacts.resource.manager === 'winget');
check('server facts carry the resolver snapshot identity', typeof serverFacts.resourceSnapshotIdentity === 'string' && serverFacts.resourceSnapshotIdentity.length > 0);

// Trusted proof verifier (Phase 2B-2) + server-signed facts proof + grant proof.
const proofKeys = generateKeyPairSync('ed25519');
const factsKid = 'kid_facts_win';
const verifier = createPermissionProofVerifier({ publicKeyByKid: { [factsKid]: proofKeys.publicKey }, now: NOW });
const signedFacts = createPermissionFactsProof({
  operation: resolvedOperation,
  facts: serverFacts,
  privateKey: proofKeys.privateKey,
  kid: factsKid,
  now: NOW,
  ttlMs: 15 * 60 * 1000,
});
check('signed facts proof verifies under the trusted verifier', verifier.verifyFactsProof(resolvedOperation, signedFacts) === true);

const grant = createCapabilityGrant({
  mode: PERMISSION_MODES.STANDARD,
  issuedAtTurn: 'turn-approval-win',
  issuedAt: new Date(NOW),
  ttlMs: 15 * 60 * 1000,
  usageMax: 1,
  workload: {
    scope: CAPABILITY_WORKLOAD_SCOPES.RUN,
    sessionId: resolvedOperation.requestBinding.sessionId,
    runId: resolvedOperation.requestBinding.runId,
    turnBinding: 'provenance',
  },
  constraints: {
    action: resolvedOperation.primaryAction,
    scope: serverFacts.scope,
    resourceSnapshotIdentity: serverFacts.resourceSnapshotIdentity,
    executionClass: serverFacts.executionClass,
    impact: {
      reversible: serverFacts.impact.reversible,
      containsSensitiveMaterial: serverFacts.impact.containsSensitiveMaterial,
      containsGitMetadata: serverFacts.impact.containsGitMetadata,
    },
    target: resolvedOperation.target,
    targetFlags: { recursive: false, force: false, exact: serverFacts.selection.exact === true },
    resource: serverFacts.resource,
    selection: serverFacts.selection,
    effects: { subset: resolvedOperation.effects },
  },
  grantProof: 'owner-proof-win',
});
const signedGrant = createCapabilityGrantProof({ grant, privateKey: proofKeys.privateKey, kid: factsKid, now: NOW, ttlMs: 15 * 60 * 1000 });
check('signed grant proof verifies under the trusted verifier', verifier.verifyGrantProof(signedGrant) === true);

// ── 1. host-capable Windows capability with no facts/proof → DENY (fail closed) ──

// 1a: facts present but no trusted resolver proof.
{
  const dispatchResult = await dispatchWindowsSemanticExec({
    request: { capability: signedCapability },
    publicKeyByKid,
    revalidate: okRevalidate,
    execInvocation: okExec,
    nonceState: createWindowsNonceTracker(),
    now: NOW,
    policyContext: { operation: resolvedOperation, facts: serverFacts, mode: PERMISSION_MODES.STANDARD },
  });
  eq('host-capable with facts but no trusted proof DENYs', dispatchResult.ok, false);
  eq('...reason is FACTS_PROOF_REQUIRED', dispatchResult.code, PERMISSION_REASON_CODES.FACTS_PROOF_REQUIRED);
}

// 1b: no server-computed facts envelope at all (explicit fail-closed gate).
{
  let revalidateRan = false;
  const dispatchResult = await dispatchWindowsSemanticExec({
    request: { capability: signedCapability },
    publicKeyByKid,
    revalidate: async () => { revalidateRan = true; return okRevalidate(); },
    execInvocation: okExec,
    nonceState: createWindowsNonceTracker(),
    now: NOW,
    policyGate: createWindowsDispatchPolicyGate(),
  });
  eq('host-capable with no facts envelope DENYs', dispatchResult.ok, false);
  eq('...reason is FACTS_REQUIRED', dispatchResult.code, PERMISSION_REASON_CODES.FACTS_REQUIRED);
  check('a denied gate never reaches target revalidation', revalidateRan === false);
}

// A custom gate is not an authorization bypass: it still needs the same
// server-computed operation binding before it can return ALLOW.
{
  let revalidateRan = false;
  const dispatchResult = await dispatchWindowsSemanticExec({
    request: { capability: signedCapability },
    publicKeyByKid,
    revalidate: async () => { revalidateRan = true; return okRevalidate(); },
    execInvocation: okExec,
    nonceState: createWindowsNonceTracker(),
    now: NOW,
    policyGate: async () => ({ ok: true, decision: 'ALLOW' }),
  });
  eq('custom gate without server operation context DENYs', dispatchResult.ok, false);
  eq('...custom gate bypass is FACTS_REQUIRED', dispatchResult.code, PERMISSION_REASON_CODES.FACTS_REQUIRED);
  check('custom gate without context never reaches target revalidation', revalidateRan === false);
}

// 1c: a denied gate must not consume the one-shot nonce.
{
  const tracker = createWindowsNonceTracker();
  await dispatchWindowsSemanticExec({
    request: { capability: signedCapability },
    publicKeyByKid,
    revalidate: okRevalidate,
    execInvocation: okExec,
    nonceState: tracker,
    now: NOW,
    policyContext: { operation: resolvedOperation },
    policyGate: createWindowsDispatchPolicyGate(),
  });
  check('denied gate does not consume the one-shot nonce', tracker.isUsed(signedCapability.nonce) === false);
}

// 1d: the default gate is fail-closed on its own (STANDARD, no verifier/proof).
{
  const gateResult = await defaultWindowsDispatchPolicyGate({ operation: resolvedOperation, facts: serverFacts, now: NOW });
  eq('default gate without a verifier fails closed', gateResult.ok, false);
  eq('...reason is FACTS_PROOF_REQUIRED', gateResult.code, PERMISSION_REASON_CODES.FACTS_PROOF_REQUIRED);
}

// 1e: non-revalidatable host effect fails closed.
{
  const nonRevalidatableFacts = JSON.parse(JSON.stringify(serverFacts));
  nonRevalidatableFacts.hostEffects = { dynamic: false, revalidatable: false };
  const gateResult = await defaultWindowsDispatchPolicyGate({ operation: resolvedOperation, facts: nonRevalidatableFacts, now: NOW });
  eq('non-revalidatable host effect DENYs', gateResult.ok, false);
  eq('...reason is NON_REVALIDATABLE_HOST_EFFECT', gateResult.code, PERMISSION_REASON_CODES.NON_REVALIDATABLE_HOST_EFFECT);
}

// ── 2. valid signed facts proof + no matching Phase 2A capability → ASK at most ──

{
  let execRan = false;
  const tracker = createWindowsNonceTracker();
  const dispatchResult = await dispatchWindowsSemanticExec({
    request: { capability: signedCapability },
    publicKeyByKid,
    revalidate: okRevalidate,
    execInvocation: async () => { execRan = true; return okExec(); },
    nonceState: tracker,
    now: NOW,
    policyContext: {
      operation: resolvedOperation,
      facts: signedFacts,
      mode: PERMISSION_MODES.STANDARD,
      verifyFactsProof: verifier.verifyFactsProof,
      verifyGrantProof: verifier.verifyGrantProof,
    },
  });
  eq('valid proof without an exact capability is ASK at most', dispatchResult.ok, false);
  eq('...reason is ASK_DEFAULT', dispatchResult.code, PERMISSION_REASON_CODES.ASK_DEFAULT);
  check('ASK never reaches exec', execRan === false);
  check('ASK does not consume the one-shot nonce', tracker.isUsed(signedCapability.nonce) === false);
}

// ── 3. exact matching Phase 2A capability → proceeds through the chain ─────────

{
  let execRan = false;
  const tracker = createWindowsNonceTracker();
  const dispatchResult = await dispatchWindowsSemanticExec({
    request: { capability: signedCapability },
    publicKeyByKid,
    revalidate: okRevalidate,
    execInvocation: async () => { execRan = true; return okExec(); },
    nonceState: tracker,
    now: NOW,
    policyContext: {
      operation: resolvedOperation,
      facts: signedFacts,
      mode: PERMISSION_MODES.STANDARD,
      capability: signedGrant,
      verifyFactsProof: verifier.verifyFactsProof,
      verifyGrantProof: verifier.verifyGrantProof,
      useNonce: 'use-win-1',
    },
  });
  check('exact matching Phase 2A capability proceeds through the gate', dispatchResult.ok === true);
  check('exec runs only when the gate ALLOWs', execRan === true);
  check('the capability nonce is consumed after a granted dispatch', tracker.isUsed(signedCapability.nonce) === true);
}

// ── 4. platform / executionClass smuggling → DENY ──────────────────────────────

// Policy authorization still goes through the real signed-facts/grant gate;
// no owner credential is invented and replay is rejected by the dispatcher.
for (const riskMode of ['recommended', 'full-auto']) {
  const auto = createWindowsAutoInstallAuthorization({ prepared: { binding, projection: { decisions: [packageDecision] } }, riskMode, kid, privateKey: keys.privateKey, now: NOW });
  const nativeGrant = createWindowsBrokerAutoInstallGrant({ authorization: auto, requestId: 'native-1', actionId: 'action-1', kid, privateKey: keys.privateKey, brokerInstallationId: 'broker-1', policyGeneration: 1, now: NOW });
  assert.equal(nativeGrant.grant.installScope, 'machine');
  const wire = Buffer.concat([Buffer.from('Ragent Windows auto install v1\0'), Buffer.from(JSON.stringify(nativeGrant.grant))]);
  check(`${riskMode} native grant signature covers the exact package`, verify(null, wire, keys.publicKey, Buffer.from(nativeGrant.signature, 'base64url')));
  assert.equal(nativeGrant.grant.packageId, 'Git.Git');
  assert.equal(nativeGrant.grant.packageVersion, '2.0');
  let submissions = 0;
  const client = {
    async health() { return { type: 'health', autoInstallReady: true, autoInstallKeyId: kid, installationId: 'broker-1', policyGeneration: 1 }; },
    async executeAutoInstall({ grant, signature }) {
      submissions++;
      const payload = Buffer.concat([Buffer.from('Ragent Windows auto install v1\0'), Buffer.from(JSON.stringify(grant))]);
      assert(verify(null, payload, keys.publicKey, Buffer.from(signature, 'base64url')));
      return { type: 'result', requestId: grant.requestId, status: 'executing' };
    },
  };
  const submitOptions = { client, prepared: { binding, projection: { decisions: [packageDecision] } }, riskMode, requestId: 'native-1', actionId: 'action-1', kid, privateKey: keys.privateKey, now: NOW };
  assert.equal((await submitWindowsBrokerAutoInstall(submitOptions)).status, 'executing');
  assert.equal(submissions, 1);
  let framedSubmissions = 0;
  const framedClient = createWindowsPrivilegedBrokerClient({ platform: 'win32', pipeExchange: async ({ pipe, request }) => {
    if (pipe === 'health') return client.health();
    assert.equal(request.type, 'auto_install.execute');
    assert.equal(request.autoInstall.installScope, 'machine');
    if (request.type === 'auto_install.inspect') return { type: 'error', code: 'REQUEST_INVALID' };
    framedSubmissions++;
    return client.executeAutoInstall({ grant: request.autoInstall, signature: request.signature });
  } });
  assert.equal((await submitWindowsBrokerAutoInstall({ ...submitOptions, client: framedClient })).status, 'executing');
  assert.equal(framedSubmissions, 1, 'signed grant passes the actual broker client wire validation');
  const selected = { id: 'Git.Git', version: '2.0', source: 'winget', scope: 'System', elevation: 'ElevationRequired', type: 'Msi', nestedType: 'Unknown', architecture: 'X64', locale: 'en-US' };
  let selectedGrant;
  const selectedClient = { ...client, async inspectAutoInstall(query) { assert.deepEqual(query, { packageId: 'Git.Git', packageVersion: '2.0' }); return selected; },
    async executeAutoInstall({ grant, signature }) { selectedGrant = grant; return client.executeAutoInstall({ grant, signature }); } };
  assert.equal((await submitWindowsBrokerAutoInstall({ ...submitOptions, client: selectedClient })).status, 'executing');
  assert.deepEqual(selectedGrant.selectedInstaller, selected, 'trusted inspector selection is signed into the broker grant');
  let prohibitedSubmitted = false;
  await assert.rejects(submitWindowsBrokerAutoInstall({ ...submitOptions, client: { ...client,
    async inspectAutoInstall() { return { ...selected, elevation: 'ElevationProhibited' }; },
    async executeAutoInstall() { prohibitedSubmitted = true; throw new Error('must not submit'); },
  } }), { code: 'AUTO_INSTALL_ELEVATION_PROHIBITED' });
  assert.equal(prohibitedSubmitted, false, 'an installer that prohibits elevation cannot reach the system executor');
  let activeAfterInspection = true;
  let submittedAfterCancellation = false;
  const cancelledClient = { ...client, async inspectAutoInstall() { activeAfterInspection = false; return selected; },
    async executeAutoInstall() { submittedAfterCancellation = true; throw new Error('must not submit'); } };
  await assert.rejects(submitWindowsBrokerAutoInstall({ ...submitOptions, client: cancelledClient, assertActive: async () => {
    if (!activeAfterInspection) throw Object.assign(new Error('run changed'), { code: 'AUTO_INSTALL_RUN_CHANGED' });
  } }), { code: 'AUTO_INSTALL_RUN_CHANGED' });
  assert.equal(submittedAfterCancellation, false, 'a run cancelled during inspection cannot start installation');
  await assert.rejects(submitWindowsBrokerAutoInstall({ ...submitOptions, client: { ...client, async inspectAutoInstall() { throw Object.assign(new Error('bad response'), { code: 'BROKER_RESPONSE_INVALID' }); } } }), { code: 'AUTO_INSTALL_INSPECTION_INVALID' });
  await assert.rejects(submitWindowsBrokerAutoInstall({ ...submitOptions, client: { ...client, async health() { return { type: 'health', autoInstallReady: true, autoInstallKeyId: 'other' }; } } }), { code: 'AUTO_INSTALL_BROKER_NOT_READY' });
  await assert.rejects(submitWindowsBrokerAutoInstall({ ...submitOptions, client: { ...client, async executeAutoInstall() { throw new Error('pipe closed'); } } }), { code: 'AUTO_INSTALL_OUTCOME_UNKNOWN', requestId: 'native-1' });
  let recordedGrant = null;
  let autoCalls = 0;
  const durableClient = {
    health: client.health,
    inspectAutoInstall: selectedClient.inspectAutoInstall,
    async status(requestId) { return recordedGrant ? { type: 'result', requestId, status: 'succeeded', autoInstall: recordedGrant } : { type: 'result', requestId, code: 'REQUEST_NOT_FOUND' }; },
    async executeAutoInstall({ grant }) { autoCalls++; recordedGrant = grant; return { type: 'result', requestId: grant.requestId, status: 'executing' }; },
  };
  const durableOptions = { ...submitOptions, client: durableClient };
  assert.equal((await submitOrResumeWindowsBrokerAutoInstall(durableOptions)).status, 'executing');
  assert.deepEqual(recordedGrant.selectedInstaller, selected);
  assert.equal((await submitOrResumeWindowsBrokerAutoInstall(durableOptions)).duplicate, true);
  assert.equal(autoCalls, 1);
  assert.equal((await queryWindowsBrokerAutoInstall({ client: durableClient, binding })).status, 'succeeded');
  assert.equal((await getWindowsManagedAutoInstallStatus({ platform: 'win32', binding: { ...binding, authenticatedPrincipalKind: 'owner' } }, { client: durableClient, userStore: { status: async () => null } })).status, 'succeeded');
  const userStatus = await getWindowsManagedAutoInstallStatus({ platform: 'win32', binding: { ...binding, authenticatedPrincipalKind: 'owner' } }, {
    client: { status: async () => { throw new Error('broker must not be queried'); } },
    userStore: { status: async () => ({ status: 'unknown', code: '', duplicate: true }) },
  });
  assert.equal(userStatus.status, 'unknown');
  assert.equal(userStatus.requestKey, binding.requestKey);
  await assert.rejects(getWindowsManagedAutoInstallStatus({ platform: 'win32', binding: { ...binding, authenticatedPrincipalKind: 'guest' } }, { client: durableClient }), { code: 'AUTO_INSTALL_STATUS_UNAVAILABLE' });
  assert.equal(autoCalls, 1, 'status lookup must never submit an installation');
  let raceGrant;
  let racingLookups = 0;
  let racingSubmissions = 0;
  const racingClient = {
    health: client.health,
    async status(requestId) {
      racingLookups++;
      if (racingLookups <= 2) return { type: 'result', requestId, code: 'REQUEST_NOT_FOUND' };
      return { type: 'result', requestId, status: 'executing', autoInstall: raceGrant };
    },
    async executeAutoInstall({ grant }) {
      racingSubmissions++;
      if (!raceGrant) { raceGrant = grant; return { type: 'result', requestId: grant.requestId, status: 'executing' }; }
      return { type: 'error', code: 'REQUEST_ID_CONFLICT' };
    },
  };
  const racingResults = await Promise.all([
    submitOrResumeWindowsBrokerAutoInstall({ ...durableOptions, client: racingClient }),
    submitOrResumeWindowsBrokerAutoInstall({ ...durableOptions, client: racingClient }),
  ]);
  assert.equal(racingSubmissions, 2, 'the service receives a competing claim but only one is admitted');
  assert.ok(racingResults.every((result) => result.status === 'executing'));
  assert.equal(racingResults.filter((result) => result.duplicate).length, 1);
  const conflictClient = { ...racingClient, status: async (id) => ({ type: 'result', requestId: id, status: 'executing', autoInstall: { ...raceGrant, packageId: 'Different.Package' } }) };
  await assert.rejects(submitOrResumeWindowsBrokerAutoInstall({ ...durableOptions, client: conflictClient }), { code: 'AUTO_INSTALL_BINDING_CONFLICT' });
  assert.equal((await queryWindowsBrokerAutoInstall({ client: { status: async (requestId) => ({ type: 'result', requestId, code: 'REQUEST_NOT_FOUND' }) }, binding })).status, 'unknown');
  await assert.rejects(queryWindowsBrokerAutoInstall({ client: durableClient, binding: { ...binding, runId: 'another-run' } }), { code: 'AUTO_INSTALL_BINDING_CONFLICT' });
  recordedGrant = { ...recordedGrant, packageId: 'Different.Package' };
  await assert.rejects(submitOrResumeWindowsBrokerAutoInstall(durableOptions), { code: 'AUTO_INSTALL_BINDING_CONFLICT' });
  let checkedActive = false;
  const managedOptions = { platform: 'win32', actions: [{ command: 'winget install Git.Git --scope machine' }], riskMode,
    binding: { ...binding, authenticatedPrincipalKind: 'owner' }, trustedContext: { cwd: 'D:\\work' } };
  const managedDeps = { prepare: async () => ({ binding, projection: { decisions: [packageDecision] } }),
    assertActive: async () => { checkedActive = true; }, loadKeys: async () => {}, getKey: () => ({ kid, privateKey: keys.privateKey }),
    client: {}, submit: async () => ({ status: 'executing', requestId: 'request-1' }) };
  assert.equal((await tryWindowsManagedAutoInstall(managedOptions, managedDeps)).status, 'executing');
  assert.equal((await tryWindowsManagedAutoInstall({ ...managedOptions, actions: [{ command: 'winget add Git.Git --scope machine' }] }, managedDeps)).status, 'executing');
  const userOperation = compile('winget install Git.Git --scope user').operations[0];
  const userDecision = evaluateSemanticOperation(userOperation, packageResolution);
  const userOptions = { ...managedOptions, actions: [{ command: 'winget install Git.Git --scope user' }], runExecutionSid: 'S-1-5-21-1-2-3-4' };
  const userDeps = { ...managedDeps, prepare: async () => ({ binding, projection: { decisions: [userDecision] } }) };
  const userAuthorization = await prepareWindowsManagedUserInstall(userOptions, userDeps);
  assert.ok(await prepareWindowsManagedUserInstall({ ...userOptions, actions: [{ command: 'winget add Git.Git --scope user' }] }, userDeps));
  assert.equal(userAuthorization.expectedExecutionSid, userOptions.runExecutionSid);
  assert.equal(userAuthorization.capability.windowsExecutionSid, userOptions.runExecutionSid);
  assert.equal(verifySemanticCapability(userAuthorization.capability, { publicKey: keys.publicKey }).ok, true);
  const verifiedUser = { authorization: userAuthorization, pinnedIdentity: { kid, publicKey: keys.publicKey }, binding, runExecutionSid: userOptions.runExecutionSid };
  assert.equal(verifyWindowsManagedUserInstallAuthorization(verifiedUser), true);
  assert.equal(verifyWindowsManagedUserInstallAuthorization({ ...verifiedUser, runExecutionSid: 'S-1-5-21-1-2-3-5' }), false);
  assert.equal(verifyWindowsManagedUserInstallAuthorization({ ...verifiedUser, binding: { ...binding, requestKey: 'another' } }), false);
  assert.equal(verifyWindowsManagedUserInstallAuthorization({ ...verifiedUser, pinnedIdentity: { kid: 'other', publicKey: keys.publicKey } }), false);
  assert.equal(await prepareWindowsManagedUserInstall({ ...userOptions, runExecutionSid: '' }, userDeps), null);
  assert.equal(await prepareWindowsManagedUserInstall({ ...userOptions, binding: { ...userOptions.binding, authenticatedPrincipalKind: 'guest' } }, userDeps), null);
  assert.equal(await prepareWindowsManagedUserInstall(userOptions, { ...userDeps, prepare: async () => ({ binding, projection: { decisions: [packageDecision] } }) }), null);
  assert.equal(checkedActive, true);
  let previewSubmitted = false;
  const previewDeps = { ...managedDeps, client: { health: async () => ({ type: 'health', autoInstallReady: true, autoInstallKeyId: kid }) },
    submit: async () => { previewSubmitted = true; throw new Error('preflight must not submit'); } };
  assert.deepEqual(await tryWindowsManagedAutoInstall({ ...managedOptions, preflight: true }, previewDeps), { ready: true });
  assert.equal(previewSubmitted, false);
  assert.deepEqual(await tryWindowsManagedAutoInstall({ ...managedOptions, preflight: true }, { ...previewDeps,
    client: { health: async () => ({ type: 'health', autoInstallReady: true, autoInstallKeyId: 'other' }) } }), { ready: false });
  assert.equal(await tryWindowsManagedAutoInstall({ ...managedOptions, binding: { ...managedOptions.binding, authenticatedPrincipalKind: 'guest' } }, managedDeps), null);
  assert.equal(await tryWindowsManagedAutoInstall({ ...managedOptions, riskMode: 'conservative-auto' }, managedDeps), null);
  const proofVerifier = createPermissionProofVerifier({ publicKeyByKid: { [kid]: keys.publicKey }, now: NOW });
  const tracker = createWindowsNonceTracker();
  const options = { request: { capability: auto.capability }, publicKeyByKid, revalidate: okRevalidate, execInvocation: okExec, nonceState: tracker, now: NOW,
    policyContext: { operation: auto.operation, facts: auto.facts, mode: PERMISSION_MODES.STANDARD, capability: auto.grant,
      verifyFactsProof: proofVerifier.verifyFactsProof, verifyGrantProof: proofVerifier.verifyGrantProof, useNonce: auto.useNonce } };
  const result = await dispatchWindowsSemanticExec(options);
  check(`${riskMode} auto install reaches the real permission gate`, result.ok === true);
  const replay = await dispatchWindowsSemanticExec(options);
  check(`${riskMode} auto install cannot replay`, replay.ok === false);
  const mixed = await dispatchWindowsSemanticExec({ ...options, nonceState: createWindowsNonceTracker(), policyContext: { ...options.policyContext, capability: signedGrant } });
  eq(`${riskMode} auto authorization cannot use an owner grant`, mixed.code, 'SEMANTIC_AUTHORIZATION_MISMATCH');
  const mixedOwner = await dispatchWindowsSemanticExec({ ...options, request: { capability: signedCapability }, nonceState: createWindowsNonceTracker() });
  eq(`${riskMode} owner authorization cannot use an automatic grant`, mixedOwner.code, 'SEMANTIC_AUTHORIZATION_MISMATCH');
}
assert.throws(() => createWindowsAutoInstallAuthorization({ prepared: { binding, projection: { decisions: [packageDecision] } }, riskMode: 'conservative-auto', kid, privateKey: keys.privateKey, now: NOW }));
passed += 1;

{
  let checks = 0;
  let clock = 0;
  const options = { requestId: 'native-1', intervalMs: 10, timeoutMs: 100, monotonicNow: () => clock, delay: async (ms) => { clock += ms; } };
  const client = { async status(requestId) { checks++; return { type: 'result', requestId, status: checks === 2 ? 'succeeded' : 'executing' }; } };
  assert.equal((await waitWindowsBrokerAutoInstall({ ...options, client })).status, 'succeeded');
  assert.equal(checks, 2);
  assert.equal((await waitWindowsBrokerAutoInstall({ ...options, client: { async status() { throw new Error('disconnected'); } } })).status, 'unknown');
  assert.equal((await waitWindowsBrokerAutoInstall({ ...options, client: { async status() { return { type: 'result', requestId: 'different', status: 'succeeded' }; } } })).status, 'unknown');
  assert.equal((await waitWindowsBrokerAutoInstall({ ...options, client: { async status(requestId) { return { type: 'result', requestId, status: 'executing' }; } } })).status, 'unknown');
}

// 4a: re-resolved operation claims a non-win32 platform on a win32 capability.
{
  const smuggledOperation = JSON.parse(JSON.stringify(resolvedOperation));
  smuggledOperation.target.platform = 'linux';
  const dispatchResult = await dispatchWindowsSemanticExec({
    request: { capability: signedCapability },
    publicKeyByKid,
    revalidate: okRevalidate,
    execInvocation: okExec,
    nonceState: createWindowsNonceTracker(),
    now: NOW,
    policyContext: { operation: smuggledOperation, mode: PERMISSION_MODES.STANDARD },
  });
  eq('platform smuggling (linux target on a win32 capability) DENYs', dispatchResult.ok, false);
  eq('...fails closed with capability revalidation failure', dispatchResult.code, 'SEMANTIC_CAPABILITY_REVALIDATION_FAILED');
}

// 4b: re-resolved operation claims a non-host executionClass.
{
  const smuggledOperation = JSON.parse(JSON.stringify(resolvedOperation));
  smuggledOperation.executionClass = 'session';
  const dispatchResult = await dispatchWindowsSemanticExec({
    request: { capability: signedCapability },
    publicKeyByKid,
    revalidate: okRevalidate,
    execInvocation: okExec,
    nonceState: createWindowsNonceTracker(),
    now: NOW,
    policyContext: { operation: smuggledOperation, mode: PERMISSION_MODES.STANDARD },
  });
  eq('executionClass smuggling (session on a host capability) DENYs', dispatchResult.ok, false);
  eq('...fails closed with capability revalidation failure', dispatchResult.code, 'SEMANTIC_CAPABILITY_REVALIDATION_FAILED');
}

// ── 5. existing chain (signature/nonce/revalidation/exec) still runs in order ──

{
  const order = [];
  const tracker = createWindowsNonceTracker();
  const dispatchResult = await dispatchWindowsSemanticExec({
    request: { capability: signedCapability },
    publicKeyByKid,
    revalidate: async () => { order.push('revalidate'); return okRevalidate(); },
    execInvocation: async () => { order.push('exec'); return okExec(); },
    nonceState: {
      isUsed: (nonce) => { order.push('nonce:isUsed'); return tracker.isUsed(nonce); },
      consume: (nonce) => { order.push('nonce:consume'); return tracker.consume(nonce); },
      snapshot: () => tracker.snapshot(),
    },
    now: NOW,
    policyContext: {
      operation: resolvedOperation,
      facts: signedFacts,
      mode: PERMISSION_MODES.STANDARD,
      capability: signedGrant,
      verifyFactsProof: verifier.verifyFactsProof,
      verifyGrantProof: verifier.verifyGrantProof,
      useNonce: 'use-win-2',
    },
  });
  check('gate passes for an exact matching capability', dispatchResult.ok === true);
  check('existing nonce/revalidation/exec order is preserved with the gate',
    order.join(',') === 'nonce:isUsed,revalidate,nonce:consume,exec');
}

// 5b: nonce state is mandatory, and consumption is atomic across concurrent
// dispatches even though policy and target revalidation are asynchronous.
{
  let execCount = 0;
  const missingState = await dispatchWindowsSemanticExec({
    request: { capability: signedCapability },
    publicKeyByKid,
    revalidate: okRevalidate,
    execInvocation: async () => { execCount += 1; return okExec(); },
    now: NOW,
    policyContext: { operation: resolvedOperation },
    policyGate: async () => ({ ok: true, decision: 'ALLOW' }),
  });
  eq('missing nonce store DENYs', missingState.ok, false);
  eq('missing nonce store reports required state', missingState.code, 'SEMANTIC_CAPABILITY_NONCE_STATE_REQUIRED');
  eq('missing nonce store never executes', execCount, 0);

  const tracker = createWindowsNonceTracker();
  const dispatchOptions = {
    request: { capability: signedCapability },
    publicKeyByKid,
    revalidate: async () => {
      await new Promise((resolve) => setImmediate(resolve));
      return okRevalidate();
    },
    execInvocation: async () => { execCount += 1; return okExec(); },
    nonceState: tracker,
    now: NOW,
    policyContext: { operation: resolvedOperation },
    policyGate: async () => {
      await new Promise((resolve) => setImmediate(resolve));
      return { ok: true, decision: 'ALLOW' };
    },
  };
  const concurrent = await Promise.all([
    dispatchWindowsSemanticExec(dispatchOptions),
    dispatchWindowsSemanticExec(dispatchOptions),
  ]);
  eq('concurrent nonce dispatch has one winner', concurrent.filter((result) => result.ok).length, 1);
  eq('concurrent nonce dispatch has one replay denial',
    concurrent.filter((result) => result.code === 'SEMANTIC_CAPABILITY_CONSUMED').length, 1);
  eq('concurrent nonce dispatch executes once', execCount, 1);
}

// ── 6. permission-set (entries) envelope can reach ALLOW via per-entry match ──
// evaluatePermissionSet returns { decision, results } with no top-level
// capabilityMatched; the gate must derive it so a multi-operation envelope of
// exact Phase 2A matches ALLOWs, and any non-matching member blocks ALLOW.

// 6a: every entry is an exact capability match → ALLOW.
{
  const gate = createWindowsDispatchPolicyGate();
  const gateResult = await gate({
    entries: [
      { operation: resolvedOperation, facts: signedFacts },
      { operation: resolvedOperation, facts: signedFacts },
    ],
    mode: PERMISSION_MODES.STANDARD,
    capability: signedGrant,
    verifyFactsProof: verifier.verifyFactsProof,
    verifyGrantProof: verifier.verifyGrantProof,
    useNonce: 'use-win-entries-1',
    usageConsumed: 0,
    consumedUseNonces: [],
    now: NOW,
  });
  check('permission-set of exact matches ALLOWs', gateResult.ok === true);
  eq('...reason is CAPABILITY_MATCHED', gateResult.code, PERMISSION_REASON_CODES.CAPABILITY_MATCHED);
}

// 6b: one entry has valid proof but no matching capability → ASK, not ALLOW.
{
  const gate = createWindowsDispatchPolicyGate();
  const gateResult = await gate({
    entries: [
      { operation: resolvedOperation, facts: signedFacts },
      { operation: resolvedOperation, facts: signedFacts },
    ],
    mode: PERMISSION_MODES.STANDARD,
    // No capability: each member is ASK, so the set cannot be all-matched.
    verifyFactsProof: verifier.verifyFactsProof,
    verifyGrantProof: verifier.verifyGrantProof,
    useNonce: 'use-win-entries-2',
    usageConsumed: 0,
    consumedUseNonces: [],
    now: NOW,
  });
  eq('permission-set with a non-matching member does not ALLOW', gateResult.ok, false);
  eq('...aggregated decision is ASK', gateResult.decision, 'ASK');
  eq('...reason is ASK_DEFAULT', gateResult.code, PERMISSION_REASON_CODES.ASK_DEFAULT);
}

// ── 7. host-capable dispatch with no gate/context is fail-closed ───────────────

{
  let revalidateRan = false;
  let execRan = false;
  const tracker = createWindowsNonceTracker();
  const dispatchResult = await dispatchWindowsSemanticExec({
    request: { capability: signedCapability },
    publicKeyByKid,
    revalidate: async () => { revalidateRan = true; return okRevalidate(); },
    execInvocation: async () => { execRan = true; return okExec(); },
    nonceState: tracker,
    now: NOW,
    // No policyGate and no policyContext: host-capable dispatch must fail closed.
  });
  eq('host-capable dispatch with no gate DENYs', dispatchResult.ok, false);
  eq('...reason is POLICY_GATE_REQUIRED', dispatchResult.code, PERMISSION_REASON_CODES.POLICY_GATE_REQUIRED);
  check('no-gate dispatch never reaches revalidation', revalidateRan === false);
  check('no-gate dispatch never reaches exec', execRan === false);
  check('no-gate dispatch does not consume the one-shot nonce', tracker.isUsed(signedCapability.nonce) === false);
}

// ── 8. uncertainty cannot bypass the Windows policy gate ──────────────────────

{
  const lowConfidenceOperation = JSON.parse(JSON.stringify(resolvedOperation));
  lowConfidenceOperation.analysis.confidence = 'low';
  const lowFacts = buildWindowsDispatchPermissionFacts(lowConfidenceOperation, signedCapability);
  const lowSignedFacts = createPermissionFactsProof({
    operation: lowConfidenceOperation,
    facts: lowFacts,
    privateKey: proofKeys.privateKey,
    kid: factsKid,
    now: NOW,
    ttlMs: 15 * 60 * 1000,
  });
  const gateResult = await defaultWindowsDispatchPolicyGate({
    operation: lowConfidenceOperation,
    facts: lowSignedFacts,
    mode: PERMISSION_MODES.STANDARD,
    capability: signedGrant,
    verifyFactsProof: verifier.verifyFactsProof,
    verifyGrantProof: verifier.verifyGrantProof,
    useNonce: 'use-win-low-confidence',
    now: NOW,
  });
  eq('Windows gate rejects low confidence despite signed facts and capability', gateResult.ok, false);
  eq('Windows low confidence hits the security ceiling', gateResult.code, PERMISSION_REASON_CODES.SECURITY_CEILING);
}

{
  const unknownOperation = JSON.parse(JSON.stringify(resolvedOperation));
  unknownOperation.analysis.unknowns = ['host:unclassified-effect'];
  const dispatchResult = await dispatchWindowsSemanticExec({
    request: { capability: signedCapability },
    publicKeyByKid,
    revalidate: okRevalidate,
    execInvocation: okExec,
    nonceState: createWindowsNonceTracker(),
    now: NOW,
    policyContext: { operation: unknownOperation, mode: PERMISSION_MODES.STANDARD },
  });
  eq('Windows dispatch rejects analysis unknowns before execution', dispatchResult.ok, false);
  eq('Windows analysis unknowns cannot be rebound to a signed capability', dispatchResult.code, 'SEMANTIC_CAPABILITY_REVALIDATION_FAILED');
}

console.log(`windows-executor-policy-gate: ${passed} checks passed`);
