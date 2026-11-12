import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { chmod, chown, copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { inspectAndAttestLinuxTarget } from '../scripts/linux-target-inspection.mjs';
import { loadOrCreateLinuxTargetKey } from '../chat/linux-target-key-store.mjs';
import { bindLinuxDeleteObservation } from '../chat/linux-delete-observation.mjs';
import { buildSemanticCapabilitySelection, createSemanticCapability, SEMANTIC_ADAPTER_LINUX_FILE_DELETE_V1, signSemanticCapability } from '../chat/semantic-capability.mjs';
import { authorizeSemanticApproval } from '../chat/semantic-approval.mjs';
import { computeSemanticManifestHash } from '../chat/semantic-operation.mjs';
import { revalidateLinuxDeleteSelection } from '../scripts/linux-delete-revalidation.mjs';
import { verifyLinuxDeleteCapability } from '../scripts/linux-delete-capability.mjs';
import { createLinuxDeleteExecutor } from '../scripts/linux-delete-execution.mjs';
import { claimLinuxDeleteNonce } from '../scripts/linux-delete-ledger.mjs';
import { handleSemanticRequest } from '../scripts/privileged-executor.mjs';
import { createRunPublication, bindRunPublication } from '../chat/run-publication-contract.mjs';
import { computeExecutionScopeDigest } from '../chat/execution-scope.mjs';
import { signLinuxRunScopeGrant } from '../chat/linux-run-scope-grant.mjs';
import { enrollLinuxServiceKeyPin } from '../scripts/linux-service-key-pin.mjs';
import { registerLinuxRunContext, revokeLinuxRunContext } from '../scripts/linux-run-context-store.mjs';
import { createLinuxRegisteredDeleteExecutor } from '../scripts/linux-registered-delete-executor.mjs';

if (process.platform !== 'linux' || process.geteuid?.() !== 0 || !process.argv[2]) throw new Error('requires Linux root and native helper');
const sourceStat = await lstat(process.argv[2]);
if (sourceStat.uid === 0) throw new Error('fixture helper must identify the unprivileged test user');
const root = await mkdtemp('/srv/ragent-delete-observation-');
await chmod(root, 0o755);
try {
  const helper = `${root}/helper`, target = `${root}/target`;
  const testHome = `${root}/test-home`;
  await mkdir(testHome, { mode: 0o700 });
  await chown(testHome, sourceStat.uid, sourceStat.gid);
  await copyFile(process.argv[2], helper);
  await chown(helper, 0, 0);
  await chmod(helper, 0o755);
  await writeFile(target, 'fixture', { mode: 0o600 });
  const digest = createHash('sha256').update(await readFile(helper)).digest('hex');
  const keys = await loadOrCreateLinuxTargetKey(`${root}/keys`, { initialize: true });
  const request = { rawCommand: `rm ${target}`, sessionId: 's1', runId: 'r1', turnId: 't1', requestKey: 'q1', executionClass: 'host' };
  // Resolve as the ordinary test user; it can stat the root-owned file but
  // cannot read or mutate it. The root inspection is a separate process.
  const moduleUrl = new URL('../chat/semantic-approval.mjs', import.meta.url).href;
  const script = `import {prepareSemanticApproval} from ${JSON.stringify(moduleUrl)};
const request = JSON.parse(process.argv[1]), root = process.argv[2];
const result = await prepareSemanticApproval({ request, trustedContext: { cwd: root, projectRoot: root, home: process.env.HOME, platform: 'linux' } });
process.stdout.write(JSON.stringify(result.projection));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(request), root],
    { uid: sourceStat.uid, gid: sourceStat.gid, encoding: 'utf8', maxBuffer: 1024 * 1024,
      env: { PATH: '/usr/bin:/bin', HOME: testHome, TMPDIR: testHome, AGENTOC_CONFIG_DIR: `${testHome}/config` } });
  assert.equal(child.status, 0, child.stderr);
  const projection = JSON.parse(child.stdout);
  assert.equal(projection.decision, 'ASK');
  assert.equal(projection.decisions.length, 1);
  const context = { sessionId: 's1', runId: 'r1', turnId: 't1', requestId: 'q1' };
  const attestation = await inspectAndAttestLinuxTarget({ helperPath: helper, expectedSha256: digest, privateKey: keys.privateKey, targetPath: target, context });
  const bound = bindLinuxDeleteObservation({ decision: projection.decisions[0], attestation, trustedPublicKey: keys.publicKey });
  assert.equal(bound.decision, 'ASK');
  assert.equal(bound.operation.target.resourceSnapshot.linuxTargetAttestation.binding.path, target);
  const selection = buildSemanticCapabilitySelection([bound]);
  assert.equal(selection.operations[0].adapterInput.linuxTargetAttestation.binding.path, target);
  assert.match(selection.selectionManifestHash, /^[a-f0-9]{64}$/);
  const revalidation = {
    boundDecision: bound, expectedSelectionHash: selection.selectionManifestHash, expectedContext: context,
    trustedContext: { cwd: root, projectRoot: root, home: testHome },
    trustedProtectedRoots: [{ label: 'service-config', path: `${testHome}/config` }],
    rootPublicKey: keys.publicKey, rootPrivateKey: keys.privateKey, helperPath: helper, expectedHelperSha256: digest,
  };
  assert.equal((await revalidateLinuxDeleteSelection(revalidation)).ok, true);
  assert.equal((await revalidateLinuxDeleteSelection({ ...revalidation, expectedSelectionHash: '0'.repeat(64) })).ok, false);
  assert.equal((await revalidateLinuxDeleteSelection({ ...revalidation, expectedContext: { ...context, runId: 'other' } })).ok, false);
  assert.equal((await revalidateLinuxDeleteSelection({ ...revalidation, trustedProtectedRoots: [] })).ok, false);
  assert.equal((await revalidateLinuxDeleteSelection({ ...revalidation, trustedContext: { ...revalidation.trustedContext, projectRoot: '/srv' } })).ok, false);
  assert.equal((await revalidateLinuxDeleteSelection({ ...revalidation, trustedProtectedRoots: [{ path: target }] })).ok, false);
  assert.equal((await revalidateLinuxDeleteSelection({ ...revalidation, expectedHelperSha256: '0'.repeat(64) })).ok, false);
  const serviceKeys = generateKeyPairSync('ed25519');
  let proofConsumed = false;
  const unsigned = await authorizeSemanticApproval({
    prepared: { binding: { sessionId: 's1', runId: 'r1', turnId: 't1', requestKey: 'q1' }, projection: { decisions: [bound] } },
    selectedOperationIds: [bound.operationId], proofToken: 'fixture-proof', credentialId: 'fixture-owner',
    kid: 'fixture-service', adapter: SEMANTIC_ADAPTER_LINUX_FILE_DELETE_V1,
    consumeOwnerProof: async (proof) => { assert.equal(proof.manifestHash, selection.selectionManifestHash); proofConsumed = true; return true; },
  });
  assert.equal(proofConsumed, true);
  const capability = signSemanticCapability(unsigned, serviceKeys.privateKey);
  const capabilityInput = { capability, servicePublicKey: serviceKeys.publicKey, rootPublicKey: keys.publicKey,
    rootPrivateKey: keys.privateKey, helperPath: helper, expectedHelperSha256: digest, expectedContext: context,
    trustedContext: revalidation.trustedContext, trustedProtectedRoots: revalidation.trustedProtectedRoots };
  assert.equal((await verifyLinuxDeleteCapability(capabilityInput)).ok, true);
  // Verification alone is not nonce consumption; the real executor must
  // durably consume before execution, and currently rejects this adapter.
  assert.equal((await verifyLinuxDeleteCapability(capabilityInput)).ok, true);
  assert.equal((await verifyLinuxDeleteCapability({ ...capabilityInput, servicePublicKey: generateKeyPairSync('ed25519').publicKey })).ok, false);
  assert.equal((await verifyLinuxDeleteCapability({ ...capabilityInput, rootPublicKey: generateKeyPairSync('ed25519').publicKey })).ok, false);
  assert.equal((await verifyLinuxDeleteCapability({ ...capabilityInput, expectedContext: { ...context, runId: 'other' } })).ok, false);
  assert.equal((await verifyLinuxDeleteCapability({ ...capabilityInput, trustedProtectedRoots: [{ path: target }] })).ok, false);
  const tampered = structuredClone(capability);
  tampered.operations[0].adapterInput.linuxDeleteOperation.target.root = `${root}/other`;
  assert.equal((await verifyLinuxDeleteCapability({ ...capabilityInput, capability: tampered })).ok, false);
  const forgedDecision = structuredClone(bound);
  forgedDecision.operation.target.resourceSnapshot.linuxTargetAttestation.signature = 'A'.repeat(86);
  forgedDecision.operationManifestHash = computeSemanticManifestHash(forgedDecision.operation);
  const forgedUnsigned = createSemanticCapability({ selectedDecisions: [forgedDecision], adapter: SEMANTIC_ADAPTER_LINUX_FILE_DELETE_V1,
    sessionId: 's1', runId: 'r1', turnId: 't1', credentialId: 'fixture-owner', kid: 'fixture-service' });
  const forgedCapability = signSemanticCapability(forgedUnsigned, serviceKeys.privateKey);
  assert.equal((await verifyLinuxDeleteCapability({ ...capabilityInput, capability: forgedCapability })).ok, false);
  assert.equal((await handleSemanticRequest({ id: 'fixture', capability })).code, 'SEMANTIC_CAPABILITY_ADAPTER_DENIED');
  assert.equal(await readFile(target, 'utf8'), 'fixture');
  const ledgerDirectory = `${root}/ledger`;
  await mkdir(ledgerDirectory, { mode: 0o700 });
  const trustedRun = { expectedContext: context, trustedContext: revalidation.trustedContext, trustedProtectedRoots: revalidation.trustedProtectedRoots };
  const executorConfig = { servicePublicKey: serviceKeys.publicKey, rootPublicKey: keys.publicKey, rootPrivateKey: keys.privateKey,
    helperPath: helper, expectedHelperSha256: digest, ledgerDirectory, resolveTrustedRun: async () => trustedRun };
  let livenessChecks = 0;
  const stoppingExecutor = createLinuxDeleteExecutor({ ...executorConfig, isRunActive: async () => ++livenessChecks < 3 });
  assert.deepEqual(await stoppingExecutor(capability), { state: 'rejected', code: 'EXECUTION_PRECONDITION_FAILED' });
  assert.equal(await readFile(target, 'utf8'), 'fixture');
  const unsignedAgain = await authorizeSemanticApproval({
    prepared: { binding: { sessionId: 's1', runId: 'r1', turnId: 't1', requestKey: 'q1' }, projection: { decisions: [bound] } },
    selectedOperationIds: [bound.operationId], proofToken: 'fixture-proof-2', credentialId: 'fixture-owner',
    kid: 'fixture-service', adapter: SEMANTIC_ADAPTER_LINUX_FILE_DELETE_V1,
    consumeOwnerProof: async (proof) => proof.manifestHash === selection.selectionManifestHash,
  });
  const secondCapability = signSemanticCapability(unsignedAgain, serviceKeys.privateKey);
  const activeExecutor = createLinuxDeleteExecutor({ ...executorConfig, isRunActive: async () => true });
  const concurrent = await Promise.all([activeExecutor(secondCapability), activeExecutor(secondCapability)]);
  assert.equal(concurrent.filter((result) => result.state === 'completed').length, 1);
  assert.equal(concurrent.filter((result) => result.code === 'LINUX_DELETE_NONCE_CONSUMED').length, 1);
  await assert.rejects(readFile(target), { code: 'ENOENT' });
  const nonceDigest = createHash('sha256').update(secondCapability.nonce).digest('hex');
  const outcome = JSON.parse(await readFile(`${ledgerDirectory}/${nonceDigest}.result.json`, 'utf8'));
  assert.equal(outcome.resultState, 'completed');
  await writeFile(target, 'changed', { mode: 0o600 });
  assert.equal((await revalidateLinuxDeleteSelection(revalidation)).ok, false);
  assert.equal((await verifyLinuxDeleteCapability(capabilityInput)).ok, false);
  assert.equal(await readFile(target, 'utf8'), 'changed');
  // Simulate a result-ledger failure after the helper starts. The operation
  // may have occurred, so the caller must see unknown and the nonce stays used.
  const nextChild = spawnSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(request), root],
    { uid: sourceStat.uid, gid: sourceStat.gid, encoding: 'utf8', maxBuffer: 1024 * 1024,
      env: { PATH: '/usr/bin:/bin', HOME: testHome, TMPDIR: testHome, AGENTOC_CONFIG_DIR: `${testHome}/config` } });
  assert.equal(nextChild.status, 0, nextChild.stderr);
  const nextProjection = JSON.parse(nextChild.stdout);
  const nextAttestation = await inspectAndAttestLinuxTarget({ helperPath: helper, expectedSha256: digest, privateKey: keys.privateKey, targetPath: target, context });
  const nextBound = bindLinuxDeleteObservation({ decision: nextProjection.decisions[0], attestation: nextAttestation, trustedPublicKey: keys.publicKey });
  const nextSelection = buildSemanticCapabilitySelection([nextBound]);
  const nextUnsigned = await authorizeSemanticApproval({
    prepared: { binding: { sessionId: 's1', runId: 'r1', turnId: 't1', requestKey: 'q1' }, projection: { decisions: [nextBound] } },
    selectedOperationIds: [nextBound.operationId], proofToken: 'fixture-proof-3', credentialId: 'fixture-owner',
    kid: 'fixture-service', adapter: SEMANTIC_ADAPTER_LINUX_FILE_DELETE_V1,
    consumeOwnerProof: async (proof) => proof.manifestHash === nextSelection.selectionManifestHash,
  });
  const auditFailureCapability = signSemanticCapability(nextUnsigned, serviceKeys.privateKey);
  let auditChecks = 0;
  const auditFailureExecutor = createLinuxDeleteExecutor({ ...executorConfig, isRunActive: async () => {
    if (++auditChecks === 3) await chmod(ledgerDirectory, 0o755);
    return true;
  } });
  const uncertain = await auditFailureExecutor(auditFailureCapability);
  await chmod(ledgerDirectory, 0o700);
  assert.deepEqual(uncertain, { state: 'unknown', code: 'LINUX_DELETE_RESULT_UNKNOWN' });
  await assert.rejects(readFile(target), { code: 'ENOENT' });
  assert.equal((await claimLinuxDeleteNonce({ directory: ledgerDirectory, nonce: auditFailureCapability.nonce,
    capabilityId: auditFailureCapability.capabilityId, runId: auditFailureCapability.runId,
    selectionHash: auditFailureCapability.selectionManifestHash })).state, 'consumed');
  if (process.env.AGENTOC_TEST_SYSTEMD_INVOCATION) {
    // End-to-end isolated fixture: root registration + live systemd unit +
    // signed v2 observation + owner-proof substitute + fixed native helper.
    await writeFile(target, 'registered-fixture', { mode: 0o600 });
    const runId = 'run_test12345678', attempt = 2;
    const run = { id: runId, sessionId: 's1', requestId: 't1', runPublication: createRunPublication() };
    const scope = { sessionId: run.sessionId, cwd: { realPath: root }, scopeRoot: { realPath: root },
      riskContext: { platform: 'linux', cwd: root, trustedWorkspaceRoot: root } };
    const manifest = bindRunPublication(run, { executionScope: scope, executionScopeDigest: computeExecutionScopeDigest(scope),
      options: { approvedActionChannel: { turnId: run.requestId } } });
    const pinDirectory = `${root}/pin`, contextDirectory = `${root}/run-state`;
    await mkdir(pinDirectory, { mode: 0o700 }); await mkdir(contextDirectory, { mode: 0o700 });
    const serviceKeyId = createHash('sha256').update(serviceKeys.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
    await enrollLinuxServiceKeyPin({ directory: pinDirectory, publicKey: serviceKeys.publicKey, expectedKeyId: serviceKeyId });
    const grant = signLinuxRunScopeGrant({ run, manifest, launchAttempt: attempt, privateKey: serviceKeys.privateKey });
    await registerLinuxRunContext({ directory: contextDirectory, pinDirectory, run, manifest, grant, launchAttempt: attempt });
    const actualRequest = { ...request, runId };
    const actualChild = spawnSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(actualRequest), root],
      { uid: sourceStat.uid, gid: sourceStat.gid, encoding: 'utf8', maxBuffer: 1024 * 1024,
        env: { PATH: '/usr/bin:/bin', HOME: testHome, TMPDIR: testHome, AGENTOC_CONFIG_DIR: `${testHome}/config` } });
    assert.equal(actualChild.status, 0, actualChild.stderr);
    const actualDecision = JSON.parse(actualChild.stdout).decisions[0];
    const actualContext = { ...context, runId, launchAttempt: attempt, invocationId: process.env.AGENTOC_TEST_SYSTEMD_INVOCATION };
    const observed = await inspectAndAttestLinuxTarget({ helperPath: helper, expectedSha256: digest,
      privateKey: keys.privateKey, targetPath: target, context: actualContext });
    const selectedDecision = bindLinuxDeleteObservation({ decision: actualDecision, attestation: observed, trustedPublicKey: keys.publicKey });
    const selected = buildSemanticCapabilitySelection([selectedDecision]);
    const selectedCapability = await authorizeSemanticApproval({
      prepared: { binding: { sessionId: 's1', runId, turnId: 't1', requestKey: 'q1' }, projection: { decisions: [selectedDecision] } },
      selectedOperationIds: [selectedDecision.operationId], proofToken: 'fixture-proof', credentialId: 'fixture-owner',
      kid: 'fixture-service', adapter: SEMANTIC_ADAPTER_LINUX_FILE_DELETE_V1,
      consumeOwnerProof: async (proof) => proof.manifestHash === selected.selectionManifestHash,
    });
    const authorized = signSemanticCapability(selectedCapability, serviceKeys.privateKey);
    const registeredConfig = { runId, launchAttempt: attempt, contextDirectory, pinDirectory,
      trustedHome: testHome, trustedProtectedRoots: revalidation.trustedProtectedRoots,
      rootPublicKey: keys.publicKey, rootPrivateKey: keys.privateKey, helperPath: helper, expectedHelperSha256: digest, ledgerDirectory };
    const wrongAttemptExecutor = createLinuxRegisteredDeleteExecutor({ ...registeredConfig, launchAttempt: attempt + 1 });
    assert.equal((await wrongAttemptExecutor(authorized)).state, 'rejected');
    assert.equal(await readFile(target, 'utf8'), 'registered-fixture');
    const registeredExecutor = createLinuxRegisteredDeleteExecutor(registeredConfig);
    assert.equal((await registeredExecutor(authorized)).state, 'completed');
    await assert.rejects(readFile(target), { code: 'ENOENT' });
    await revokeLinuxRunContext({ directory: contextDirectory, runId, launchAttempt: attempt });
    assert.equal((await registeredExecutor(authorized)).state, 'rejected');
  }
  console.log('linux delete observation: native, resolver and root revalidation checks passed');
} finally {
  await rm(root, { recursive: true });
}
