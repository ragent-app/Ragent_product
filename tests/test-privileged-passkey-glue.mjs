#!/usr/bin/env node
// Phase 4 glue test: executePrivilegedPasskeyBatch — other/delete approved with
// a human WebAuthn proof runs through the privileged executor as root. Mirrors
// test-privileged-install-auto-glue.mjs. Covers: valid proof → execute once +
// response queue approved; invalid/absent proof → fails closed, nothing
// executes; duplicate submission reuses the stored result.
import assert from 'assert/strict';
import { createHash } from 'crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const home = mkdtempSync(join(tmpdir(), 'agentoc-privileged-passkey-'));
const previousEnv = {
  HOME: process.env.HOME,
  AGENTOC_INSTANCE_ROOT: process.env.AGENTOC_INSTANCE_ROOT,
  AGENTOC_CONFIG_DIR: process.env.AGENTOC_CONFIG_DIR,
  AGENTOC_WORK_ROOT_DIR: process.env.AGENTOC_WORK_ROOT_DIR,
};

process.env.HOME = home;
process.env.AGENTOC_INSTANCE_ROOT = home;
process.env.AGENTOC_CONFIG_DIR = join(home, '.config', 'agentoc');
process.env.AGENTOC_WORK_ROOT_DIR = join(home, 'workspace');
mkdirSync(process.env.AGENTOC_WORK_ROOT_DIR, { recursive: true });

const sha256Hex = (value) => createHash('sha256').update(String(value)).digest('hex');

function createFakeStore() {
  const events = [];
  return {
    events,
    async readEvents() {
      return events.slice();
    },
    async appendEvent(event) {
      const stored = { ...event, seq: events.length + 1 };
      events.push(stored);
      return stored;
    },
    async invalidate() {},
  };
}

function deleteBatch(buildPrivilegedBatch, runId, approvalId = 'gate-delete-1') {
  const command = 'rm -rf /var/cache/agentoc-stale';
  return buildPrivilegedBatch({
    runId,
    turnId: 'turn-passkey',
    ops: [{
      approvalId,
      command,
      cwd: '/tmp',
      declaredCategory: 'delete',
      description: 'Clean stale cache',
      wrapperCommand: `agentoc-privileged --description "Clean stale cache" --category delete -- ${command}`,
    }],
  });
}

function writeProof(token, { purpose, sessionId, requestId, manifestHash }) {
  const dir = join(process.env.AGENTOC_CONFIG_DIR, 'owner-webauthn-proofs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sha256Hex(token)}.json`), JSON.stringify({
    purpose,
    sessionId,
    requestId,
    manifestHash,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAt: new Date().toISOString(),
  }));
}

async function createTestRun(createRun, sessionId, requestId) {
  return createRun({
    status: {
      sessionId,
      requestId,
      state: 'running',
      tool: 'claude-bidi',
      runtimeFamily: 'claude-stream-json-bidi',
    },
    manifest: {
      sessionId,
      requestId,
      folder: process.env.AGENTOC_WORK_ROOT_DIR,
      tool: 'claude-bidi',
      runtimeFamily: 'claude-stream-json-bidi',
      prompt: 'clean stale cache',
      options: { runtimeFamily: 'claude-stream-json-bidi' },
    },
  });
}

let failed = false;
try {
  const sessionManager = await import('../chat/session-manager.mjs');
  const { executePrivilegedPasskeyBatch } = sessionManager;
  const {
    buildPrivilegedBatch,
    computeBatchManifestHash,
    privilegedBatchRequestEvent,
    privilegedExecResultEvent,
  } = await import('../chat/privileged-ops.mjs');
  const { CATEGORY_DELETE } = await import('../chat/privileged-classifier.mjs');
  const { createRun, getRun } = await import('../chat/runs.mjs');
  const { TEMPORARY_CONTROL_CAPABILITIES, TEMPORARY_CONTROL_SESSION_SCOPE,
    createTemporaryControlApprovalActor } = await import('../lib/temporary-control-policy.mjs');

  // The passkey checkpoint is opt-in (AGENTOC_OWNER_HOST_PASSKEY_REQUIRED=1).
  // Keep the original passkey-path coverage under that mode, then assert the
  // default owner-click mode below.
  process.env.AGENTOC_OWNER_HOST_PASSKEY_REQUIRED = '1';

  // --- valid proof → execute once, response queue approved ---
  const successRun = await createTestRun(createRun, 'session_passkey_success', 'req_passkey_success');
  const successBatch = deleteBatch(buildPrivilegedBatch, successRun.id);
  const successStore = createFakeStore();
  await successStore.appendEvent(privilegedBatchRequestEvent(successBatch));
  const successManifestHash = computeBatchManifestHash(successBatch.delete, CATEGORY_DELETE);
  writeProof('proof-token-success', {
    purpose: 'privileged-category-approval',
    sessionId: 'session_passkey_success',
    requestId: 'req_passkey_success',
    manifestHash: successManifestHash,
  });
  let successExecCalls = 0;
  const success = await executePrivilegedPasskeyBatch(
    'session_passkey_success',
    successRun,
    successBatch,
    CATEGORY_DELETE,
    successStore,
    {
      checkedOpIds: successBatch.delete.map((op) => op.opId),
      requestId: 'req_passkey_success',
      webauthnProof: { token: 'proof-token-success', credentialId: 'cred-1', signedManifestHash: successManifestHash },
    },
    {
      loadSigningKeys: async () => ({ current: { kid: 'kid-success' }, previous: null }),
      executeOpAsEvent: async (op, options) => {
        successExecCalls += 1;
        assert.equal(options.authMode, 'passkey', 'passkey batch must use passkey authMode');
        assert.equal(options.runId, successRun.id);
        assert.equal(options.turnId, 'turn-passkey');
        assert.equal(options.webauthnCredentialId, 'cred-1', 'credential id must reach the executor');
        assert.equal(options.signedManifestHash, successManifestHash, 'signed manifest hash must reach the executor');
        assert.equal(op.batchManifestHash, successManifestHash, 'batch subset hash must be bound into the op');
        assert.equal(op.cwd, '/tmp', 'server-persisted operation cwd must reach the executor');
        return privilegedExecResultEvent({
          opId: op.opId,
          category: op.category,
          exitCode: 0,
          auditId: 'audit-passkey',
        });
      },
    },
  );
  assert.equal(success.changed, true, 'fresh passkey execution should report changed');
  assert.equal(successExecCalls, 1, 'passkey op should execute exactly once');
  assert.equal(success.resolved.category, CATEGORY_DELETE);
  assert.equal(successStore.events.filter((event) => event.type === 'privileged_batch_response').length, 1);
  assert.equal(successStore.events.filter((event) => event.type === 'privileged_exec_result').length, 1);

  // --- browser assertion is verified into a one-shot proof before execution ---
  const assertionRun = await createTestRun(createRun, 'session_passkey_assertion', 'req_passkey_assertion');
  const assertionBatch = deleteBatch(buildPrivilegedBatch, assertionRun.id, 'gate-delete-assertion');
  const assertionStore = createFakeStore();
  await assertionStore.appendEvent(privilegedBatchRequestEvent(assertionBatch));
  const assertionManifestHash = computeBatchManifestHash(assertionBatch.delete, CATEGORY_DELETE);
  writeProof('proof-token-assertion', {
    purpose: 'privileged-category-approval',
    sessionId: 'session_passkey_assertion',
    requestId: 'req_passkey_assertion',
    manifestHash: assertionManifestHash,
  });
  let assertionExecCalls = 0;
  const assertionResult = await executePrivilegedPasskeyBatch(
    'session_passkey_assertion',
    assertionRun,
    assertionBatch,
    CATEGORY_DELETE,
    assertionStore,
    {
      checkedOpIds: assertionBatch.delete.map((op) => op.opId),
      requestId: 'req_passkey_assertion',
      webauthnProof: {
        id: 'cred-browser',
        response: { clientDataJSON: 'browser-assertion' },
      },
    },
    {
      verifyOwnerWebAuthnAssertion: async (assertion) => {
        assert.equal(assertion.id, 'cred-browser', 'browser assertion reaches the verifier');
        return {
          credentialId: 'cred-browser',
          proof: { token: 'proof-token-assertion' },
        };
      },
      loadSigningKeys: async () => ({ current: { kid: 'kid-assertion' }, previous: null }),
      executeOpAsEvent: async (op, options) => {
        assertionExecCalls += 1;
        assert.equal(options.webauthnCredentialId, 'cred-browser', 'verified credential reaches the executor');
        return privilegedExecResultEvent({
          opId: op.opId,
          category: op.category,
          exitCode: 0,
          auditId: 'audit-passkey-assertion',
        });
      },
    },
  );
  assert.equal(assertionResult.changed, true, 'verified browser assertion should resolve the batch');
  assert.equal(assertionExecCalls, 1, 'verified browser assertion should execute once');

  const successUpdatedRun = await getRun(successRun.id);
  assert.equal(successUpdatedRun.appServerApprovalResponseQueue.length, 1);
  assert.equal(successUpdatedRun.appServerApprovalResponseQueue[0].approvalId, 'gate-delete-1');
  assert.equal(successUpdatedRun.appServerApprovalResponseQueue[0].decision, 'deny');
  assert.equal(successUpdatedRun.appServerApprovalResponseQueue[0].privilegedDecision, 'approved');
  assert.equal(successUpdatedRun.appServerApprovalResponseQueue[0].privilegedExecutionState, 'completed');
  assert.equal(successUpdatedRun.appServerApprovalResponseQueue[0].privilegedCategory, CATEGORY_DELETE);

  // An owner approval remains recorded when the privileged executor
  // reports a command/runtime failure. The execution result is a separate
  // event, distinct from the provider gate response preventing a rerun.
  const executionFailureRun = await createTestRun(createRun, 'session_passkey_execution_failure', 'req_passkey_execution_failure');
  const executionFailureBatch = deleteBatch(buildPrivilegedBatch, executionFailureRun.id, 'gate-delete-execution-failure');
  const executionFailureStore = createFakeStore();
  await executionFailureStore.appendEvent(privilegedBatchRequestEvent(executionFailureBatch));
  const executionFailureManifestHash = computeBatchManifestHash(executionFailureBatch.delete, CATEGORY_DELETE);
  writeProof('proof-token-execution-failure', {
    purpose: 'privileged-category-approval',
    sessionId: 'session_passkey_execution_failure',
    requestId: 'req_passkey_execution_failure',
    manifestHash: executionFailureManifestHash,
  });
  const executionFailure = await executePrivilegedPasskeyBatch(
    'session_passkey_execution_failure',
    executionFailureRun,
    executionFailureBatch,
    CATEGORY_DELETE,
    executionFailureStore,
    {
      checkedOpIds: executionFailureBatch.delete.map((op) => op.opId),
      requestId: 'req_passkey_execution_failure',
      webauthnProof: {
        token: 'proof-token-execution-failure',
        credentialId: 'cred-failure',
        signedManifestHash: executionFailureManifestHash,
      },
    },
    {
      loadSigningKeys: async () => ({ current: { kid: 'kid-execution-failure' }, previous: null }),
      executeOpAsEvent: async (op) => privilegedExecResultEvent({
        opId: op.opId,
        category: op.category,
        exitCode: 1,
        error: 'privileged executor unavailable',
      }),
    },
  );
  assert.equal(executionFailure.execResults[0].error, 'privileged executor unavailable');
  const executionFailureUpdatedRun = await getRun(executionFailureRun.id);
  assert.equal(executionFailureUpdatedRun.appServerApprovalResponseQueue[0].decision, 'deny',
    'provider must not rerun the original command when managed execution fails');
  assert.equal(executionFailureUpdatedRun.appServerApprovalResponseQueue[0].privilegedDecision, 'approved');
  assert.equal(executionFailureUpdatedRun.appServerApprovalResponseQueue[0].privilegedExecutionState, 'failed');
  assert.equal(executionFailureUpdatedRun.appServerApprovalResponseQueue[0].updatedInput, undefined);

  // --- duplicate submission reuses the stored result (no re-execution) ---
  const successAgain = await executePrivilegedPasskeyBatch(
    'session_passkey_success',
    successUpdatedRun,
    successBatch,
    CATEGORY_DELETE,
    successStore,
    {
      checkedOpIds: successBatch.delete.map((op) => op.opId),
      requestId: 'req_passkey_success',
      webauthnProof: { token: 'proof-token-success', credentialId: 'cred-1', signedManifestHash: successManifestHash },
    },
    {
      loadSigningKeys: async () => { throw new Error('duplicate should reuse stored result'); },
      executeOpAsEvent: async () => { throw new Error('duplicate should not call executor'); },
    },
  );
  assert.equal(successAgain.resolved.duplicate, true, 'second submission should be a duplicate');
  assert.equal(successExecCalls, 1, 'no re-execution on duplicate submission');

  // --- invalid proof (manifestHash mismatch) → fails closed, nothing executes ---
  const badRun = await createTestRun(createRun, 'session_passkey_bad', 'req_passkey_bad');
  const badBatch = deleteBatch(buildPrivilegedBatch, badRun.id, 'gate-delete-2');
  const badStore = createFakeStore();
  await badStore.appendEvent(privilegedBatchRequestEvent(badBatch));
  writeProof('proof-token-bad', {
    purpose: 'privileged-category-approval',
    sessionId: 'session_passkey_bad',
    requestId: 'req_passkey_bad',
    manifestHash: 'totally-wrong-hash',
  });
  let badExecCalls = 0;
  let badError = null;
  try {
    await executePrivilegedPasskeyBatch(
      'session_passkey_bad',
      badRun,
      badBatch,
      CATEGORY_DELETE,
      badStore,
      {
        checkedOpIds: badBatch.delete.map((op) => op.opId),
        requestId: 'req_passkey_bad',
        webauthnProof: { token: 'proof-token-bad', credentialId: 'cred-1', signedManifestHash: 'totally-wrong-hash' },
      },
      {
        loadSigningKeys: async () => ({ current: { kid: 'kid-bad' }, previous: null }),
        executeOpAsEvent: async () => { badExecCalls += 1; },
      },
    );
  } catch (error) {
    badError = error;
  }
  assert.ok(badError, 'mismatched proof must throw');
  assert.equal(badError.code, 'PRIVILEGED_PASSKEY_REQUIRED');
  assert.equal(badExecCalls, 0, 'nothing executes on a bad proof');
  assert.equal(badStore.events.filter((event) => event.type === 'privileged_exec_result').length, 0);

  // --- no proof at all → fails closed ---
  let noProofError = null;
  try {
    await executePrivilegedPasskeyBatch(
      'session_passkey_bad',
      badRun,
      badBatch,
      CATEGORY_DELETE,
      badStore,
      {
        checkedOpIds: badBatch.delete.map((op) => op.opId),
        requestId: 'req_passkey_bad',
      },
      {
        loadSigningKeys: async () => ({ current: { kid: 'kid-bad' }, previous: null }),
        executeOpAsEvent: async () => { throw new Error('should not execute without proof'); },
      },
    );
  } catch (error) {
    noProofError = error;
  }
  assert.ok(noProofError, 'missing proof must throw');
  assert.equal(noProofError.code, 'PRIVILEGED_PASSKEY_REQUIRED');

  // --- a confirmed temporary-control delegation can resolve a privileged
  // batch during its ten-minute grant without faking a passkey assertion. The
  // exact server batch/selection hash and one-shot executor path remain.
  const temporaryRun = await createTestRun(createRun, 'session_passkey_temporary', 'req_passkey_temporary');
  const temporaryBatch = deleteBatch(buildPrivilegedBatch, temporaryRun.id, 'gate-delete-temporary');
  const temporaryStore = createFakeStore();
  await temporaryStore.appendEvent(privilegedBatchRequestEvent(temporaryBatch));
  const temporaryActor = createTemporaryControlApprovalActor({
    role: 'temporary', principalKind: 'temporary_device',
    sessionScope: TEMPORARY_CONTROL_SESSION_SCOPE,
    capabilities: [...TEMPORARY_CONTROL_CAPABILITIES],
    instanceId: 'inst_abcdefghijklmnopqrstuvwx',
    grantId: 'rtg_abcdefghijklmnopqrstuvwx',
    expiry: Date.now() + 60_000,
  }, 'approval.privileged.resolve');
  let temporaryExecCalls = 0;
  const temporaryResult = await executePrivilegedPasskeyBatch(
    'session_passkey_temporary', temporaryRun, temporaryBatch, CATEGORY_DELETE, temporaryStore,
    { checkedOpIds: temporaryBatch.delete.map((op) => op.opId), requestId: 'req_passkey_temporary',
      approvalActor: temporaryActor },
    { loadSigningKeys: async () => ({ current: { kid: 'kid-temporary' }, previous: null }),
      executeOpAsEvent: async (op, options) => {
        temporaryExecCalls += 1;
        assert.equal(options.authMode, 'owner-click');
        assert.equal(options.signedManifestHash,
          computeBatchManifestHash(temporaryBatch.delete, CATEGORY_DELETE));
        return privilegedExecResultEvent({ opId: op.opId, category: op.category, exitCode: 0, auditId: 'audit-temporary' });
      } },
  );
  assert.equal(temporaryResult.changed, true);
  assert.equal(temporaryExecCalls, 1);
  const temporaryResponse = temporaryStore.events.find((event) => event.type === 'privileged_batch_response');
  assert.equal(temporaryResponse.source, 'temporary_control');
  assert.equal(temporaryResponse.temporaryControlGrantId, 'rtg_abcdefghijklmnopqrstuvwx');

  // A carrier-validated actor may expire while a queued approval reads its
  // durable batch. No response, capability or executor call may follow.
  const expiringRun = await createTestRun(createRun, 'session_passkey_expiring', 'req_passkey_expiring');
  const expiringBatch = deleteBatch(buildPrivilegedBatch, expiringRun.id, 'gate-delete-expiring');
  const expiringStore = createFakeStore();
  await expiringStore.appendEvent(privilegedBatchRequestEvent(expiringBatch));
  const originalNow = Date.now;
  let clockNow = originalNow();
  const expiresAt = clockNow + 1000;
  Date.now = () => clockNow;
  let expiringExecCalls = 0;
  try {
    const actor = createTemporaryControlApprovalActor({
      role: 'temporary', principalKind: 'temporary_device',
      sessionScope: TEMPORARY_CONTROL_SESSION_SCOPE,
      capabilities: [...TEMPORARY_CONTROL_CAPABILITIES],
      instanceId: 'inst_abcdefghijklmnopqrstuvwx',
      grantId: 'rtg_abcdefghijklmnopqrstuvwx', expiry: expiresAt,
    }, 'approval.privileged.resolve');
    const readEvents = expiringStore.readEvents.bind(expiringStore);
    expiringStore.readEvents = async () => {
      const events = await readEvents();
      clockNow = expiresAt;
      return events;
    };
    await assert.rejects(executePrivilegedPasskeyBatch(
      'session_passkey_expiring', expiringRun, expiringBatch, CATEGORY_DELETE, expiringStore,
      { checkedOpIds: expiringBatch.delete.map((op) => op.opId), requestId: 'req_passkey_expiring', approvalActor: actor },
      { loadSigningKeys: async () => ({ current: { kid: 'kid-expiring' }, previous: null }),
        executeOpAsEvent: async () => { expiringExecCalls++; return null; } },
    ), { code: 'TEMPORARY_CONTROL_APPROVAL_DENIED' });
    assert.equal(expiringExecCalls, 0);
    assert.equal(expiringStore.events.some((event) => event.type === 'privileged_batch_response'), false);
  } finally {
    Date.now = originalNow;
  }

  // --- owner-click mode (default): the proof layer is skipped, the subset
  // binding and one-shot execution are preserved, and no credential is claimed.
  delete process.env.AGENTOC_OWNER_HOST_PASSKEY_REQUIRED;
  const clickRun = await createTestRun(createRun, 'session_passkey_click', 'req_passkey_click');
  const clickBatch = deleteBatch(buildPrivilegedBatch, clickRun.id, 'gate-delete-click');
  const clickStore = createFakeStore();
  const clickEvent = privilegedBatchRequestEvent(clickBatch);
  assert.equal(clickEvent.passkeyRequired, false, 'click-only batches must project passkeyRequired=false');
  await clickStore.appendEvent(clickEvent);
  const clickManifestHash = computeBatchManifestHash(clickBatch.delete, CATEGORY_DELETE);
  let clickExecCalls = 0;
  const clickResult = await executePrivilegedPasskeyBatch(
    'session_passkey_click',
    clickRun,
    clickBatch,
    CATEGORY_DELETE,
    clickStore,
    {
      checkedOpIds: clickBatch.delete.map((op) => op.opId),
      requestId: 'req_passkey_click',
      // No webauthnProof at all — the owner click is the authorization.
    },
    {
      loadSigningKeys: async () => ({ current: { kid: 'kid-click' }, previous: null }),
      executeOpAsEvent: async (op, options) => {
        clickExecCalls += 1;
        assert.equal(options.authMode, 'owner-click', 'click-only batch must use owner-click authMode');
        assert.equal(options.webauthnCredentialId, '', 'click-only op must not claim a passkey credential');
        assert.equal(options.signedManifestHash, clickManifestHash, 'click-only op stays bound to the checked subset');
        assert.equal(op.batchManifestHash, clickManifestHash, 'batch subset hash must stay bound into the op');
        return privilegedExecResultEvent({
          opId: op.opId,
          category: op.category,
          exitCode: 0,
          auditId: 'audit-owner-click',
        });
      },
    },
  );
  assert.equal(clickResult.changed, true, 'owner-click execution should report changed');
  assert.equal(clickExecCalls, 1, 'owner-click op should execute exactly once');
  assert.equal(clickStore.events.filter((event) => event.type === 'privileged_exec_result').length, 1);

  console.log('privileged-passkey-glue: ok');
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  await import('../chat/session-manager.mjs').then((m) => m.killAll?.()).catch(() => {});
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
}
if (failed) process.exit(1);
