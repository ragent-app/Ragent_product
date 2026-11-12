#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const home = mkdtempSync(join(tmpdir(), 'agentoc-privileged-install-auto-'));
const previousEnv = {
  HOME: process.env.HOME,
  AGENTOC_CONFIG_DIR: process.env.AGENTOC_CONFIG_DIR,
  AGENTOC_WORK_ROOT_DIR: process.env.AGENTOC_WORK_ROOT_DIR,
};

process.env.HOME = home;
process.env.AGENTOC_CONFIG_DIR = join(home, '.config', 'agentoc');
process.env.AGENTOC_WORK_ROOT_DIR = join(home, 'workspace');
mkdirSync(process.env.AGENTOC_WORK_ROOT_DIR, { recursive: true });

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

function installBatch(buildPrivilegedBatch, runId, approvalId = 'gate-install-1') {
  const command = 'apt-get install -y nginx';
  return buildPrivilegedBatch({
    runId,
    turnId: 'turn-install-auto',
    ops: [{
      approvalId,
      command,
      declaredCategory: 'install',
      description: 'Install nginx',
      wrapperCommand: `agentoc-privileged --description "Install nginx" --category install -- ${command}`,
    }],
  });
}

async function createTestRun(createRun, sessionId, requestId, runtimeFamily = 'claude-stream-json-bidi') {
  const tool = runtimeFamily === 'codex-app-server-json' ? 'codex' : 'claude-bidi';
  return createRun({
    status: {
      sessionId,
      requestId,
      state: 'running',
      tool,
      runtimeFamily,
    },
    manifest: {
      sessionId,
      requestId,
      folder: process.env.AGENTOC_WORK_ROOT_DIR,
      tool,
      runtimeFamily,
      prompt: 'install nginx',
      options: { runtimeFamily },
    },
  });
}

let killAll = async () => {};
try {
  const sessionManager = await import('../chat/session-manager.mjs');
  killAll = sessionManager.killAll;
  const { executePrivilegedInstallAutoBatch } = sessionManager;
  const { buildPrivilegedBatch, privilegedExecResultEvent } = await import('../chat/privileged-ops.mjs');
  const { CATEGORY_INSTALL } = await import('../chat/privileged-classifier.mjs');
  const { createRun, getRun } = await import('../chat/runs.mjs');

  const successRun = await createTestRun(createRun, 'session_install_auto_success', 'req_install_auto_success');
  const successBatch = installBatch(buildPrivilegedBatch, successRun.id);
  const successStore = createFakeStore();
  let successExecCalls = 0;
  const success = await executePrivilegedInstallAutoBatch(
    'session_install_auto_success',
    successRun,
    successBatch,
    successStore,
    {
      loadSigningKeys: async () => ({ current: { kid: 'kid-success' }, previous: null }),
      executeOpAsEvent: async (op, options) => {
        successExecCalls += 1;
        assert.equal(options.authMode, 'install-auto');
        assert.equal(options.runId, successRun.id);
        assert.equal(options.turnId, 'turn-install-auto');
        return privilegedExecResultEvent({
          opId: op.opId,
          category: op.category,
          exitCode: 0,
          auditId: 'audit-success',
        });
      },
    },
  );
  assert.equal(success.changed, true, 'fresh install-auto execution should report changed');
  assert.equal(successExecCalls, 1, 'install-auto op should execute exactly once');
  assert.equal(success.resolved.category, CATEGORY_INSTALL);
  assert.equal(successStore.events.filter((event) => event.type === 'privileged_batch_response').length, 1);
  assert.equal(successStore.events.filter((event) => event.type === 'privileged_exec_result').length, 1);

  const successUpdatedRun = await getRun(successRun.id);
  assert.equal(successUpdatedRun.appServerApprovalResponseQueue.length, 1);
  assert.equal(successUpdatedRun.appServerApprovalResponseQueue[0].approvalId, 'gate-install-1');
  assert.equal(successUpdatedRun.appServerApprovalResponseQueue[0].decision, 'deny');
  assert.equal(successUpdatedRun.appServerApprovalResponseQueue[0].privilegedExecutionState, 'completed');
  assert.equal(successUpdatedRun.appServerApprovalResponseQueue[0].updatedInput, undefined);
  assert.equal(successUpdatedRun.appServerApprovalResponseQueue[0].privilegedCategory, CATEGORY_INSTALL);

  const successAgain = await executePrivilegedInstallAutoBatch(
    'session_install_auto_success',
    successUpdatedRun,
    successBatch,
    successStore,
    {
      loadSigningKeys: async () => {
        throw new Error('duplicate execution should reuse the stored result');
      },
      executeOpAsEvent: async () => {
        throw new Error('duplicate execution should not call executor');
      },
    },
  );
  assert.equal(successAgain.changed, false, 'duplicate install-auto sync should be a no-op');
  assert.equal(successExecCalls, 1, 'duplicate sync should not re-execute the op');
  assert.equal(successStore.events.filter((event) => event.type === 'privileged_batch_response').length, 1);
  assert.equal(successStore.events.filter((event) => event.type === 'privileged_exec_result').length, 1);

  const failedRun = await createTestRun(createRun, 'session_install_auto_failed', 'req_install_auto_failed');
  const failedBatch = installBatch(buildPrivilegedBatch, failedRun.id, 'gate-install-failed');
  const failedStore = createFakeStore();
  const failed = await executePrivilegedInstallAutoBatch(
    'session_install_auto_failed',
    failedRun,
    failedBatch,
    failedStore,
    {
      loadSigningKeys: async () => ({ current: { kid: 'kid-failed' }, previous: null }),
      executeOpAsEvent: async () => {
        throw new Error('executor refused install');
      },
    },
  );
  assert.equal(failed.changed, true);
  assert.equal(failed.execResults[0].error, 'executor refused install');
  const failedUpdatedRun = await getRun(failedRun.id);
  assert.equal(failedUpdatedRun.appServerApprovalResponseQueue.length, 1);
  assert.equal(failedUpdatedRun.appServerApprovalResponseQueue[0].approvalId, 'gate-install-failed');
  assert.equal(failedUpdatedRun.appServerApprovalResponseQueue[0].decision, 'deny',
    'executor failure must not approve the provider gate');
  assert.equal(failedUpdatedRun.appServerApprovalResponseQueue[0].updatedInput, undefined,
    'denied install-auto gates must not rewrite to the real command');

  const unsupportedRun = await createTestRun(
    createRun,
    'session_install_auto_unsupported',
    'req_install_auto_unsupported',
    'codex-app-server-json',
  );
  const unsupportedBatch = installBatch(buildPrivilegedBatch, unsupportedRun.id, 'gate-install-unsupported');
  const unsupportedStore = createFakeStore();
  let unsupportedExecutorCalled = false;
  const unsupported = await executePrivilegedInstallAutoBatch(
    'session_install_auto_unsupported',
    unsupportedRun,
    unsupportedBatch,
    unsupportedStore,
    {
      loadSigningKeys: async () => {
        throw new Error('unsupported runtime should not load signing keys');
      },
      executeOpAsEvent: async () => {
        unsupportedExecutorCalled = true;
      },
    },
  );
  assert.equal(unsupported.changed, true);
  assert.equal(unsupportedExecutorCalled, false, 'unsupported runtime must not call the privileged executor');
  assert.match(
    unsupported.execResults[0].error,
    /not supported for runtime codex-app-server-json/,
    'unsupported runtime should produce a visible exec result error',
  );
  const unsupportedUpdatedRun = await getRun(unsupportedRun.id);
  assert.equal(unsupportedUpdatedRun.appServerApprovalResponseQueue[0].approvalId, 'gate-install-unsupported');
  assert.equal(unsupportedUpdatedRun.appServerApprovalResponseQueue[0].decision, 'deny',
    'unsupported runtime must deny rather than leave the provider gate open');

  console.log('test-privileged-install-auto-glue: ok');
} finally {
  await killAll();
  if (previousEnv.HOME === undefined) delete process.env.HOME;
  else process.env.HOME = previousEnv.HOME;
  if (previousEnv.AGENTOC_CONFIG_DIR === undefined) delete process.env.AGENTOC_CONFIG_DIR;
  else process.env.AGENTOC_CONFIG_DIR = previousEnv.AGENTOC_CONFIG_DIR;
  if (previousEnv.AGENTOC_WORK_ROOT_DIR === undefined) delete process.env.AGENTOC_WORK_ROOT_DIR;
  else process.env.AGENTOC_WORK_ROOT_DIR = previousEnv.AGENTOC_WORK_ROOT_DIR;
  rmSync(home, { recursive: true, force: true });
}
