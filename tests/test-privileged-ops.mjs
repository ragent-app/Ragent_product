#!/usr/bin/env node
import assert from 'assert/strict';

import {
  PRIVILEGED_BATCH_STATUS,
  buildPrivilegedBatch,
  buildPrivilegedOp,
  checkInstallQuota,
  computeBatchManifestHash,
  computeOpManifestHash,
  defaultSelectedOpIds,
  privilegedBatchRequestEvent,
  privilegedBatchResponseEvent,
  privilegedExecResultEvent,
  resolvePrivilegedBatch,
} from '../chat/privileged-ops.mjs';
import { CATEGORY_DELETE, CATEGORY_INSTALL, CATEGORY_OTHER } from '../chat/privileged-classifier.mjs';

let passed = 0;
function check(label, condition) {
  assert.ok(condition, `failed: ${label}`);
  passed += 1;
}
function eq(label, actual, expected) {
  assert.deepEqual(actual, expected, `failed: ${label}`);
  passed += 1;
}

// --- buildPrivilegedOp ---
const op = buildPrivilegedOp({ command: 'apt-get install nginx', declaredCategory: 'install' });
check('op id prefix', op.opId.startsWith('pop_'));
check('op category install', op.category === CATEGORY_INSTALL);
check('op manifest hash hex64', /^[0-9a-f]{64}$/.test(op.manifestHash));
const opWithGate = buildPrivilegedOp({
  command: 'systemctl restart nginx',
  declaredCategory: 'other',
  approvalId: 'claude:req-1',
  wrapperCommand: 'agentoc-privileged -- systemctl restart nginx',
});
eq('op approvalId preserved', opWithGate.approvalId, 'claude:req-1');
eq('op wrapperCommand preserved', opWithGate.wrapperCommand, 'agentoc-privileged -- systemctl restart nginx');
check('description defaults to command', buildPrivilegedOp({ command: 'systemctl restart nginx' }).description === 'systemctl restart nginx');
assert.throws(() => buildPrivilegedOp({}), { code: 'COMMAND_REQUIRED' });

// determinism: same command+category+cwd -> same manifest hash
const h1 = computeOpManifestHash({ command: 'rm -rf /x', category: CATEGORY_DELETE, cwd: '' });
const h2 = computeOpManifestHash({ command: 'rm -rf /x', category: CATEGORY_DELETE, cwd: '' });
check('manifest hash deterministic', h1 === h2);
check('manifest hash differs by category', h1 !== computeOpManifestHash({ command: 'rm -rf /x', category: CATEGORY_OTHER, cwd: '' }));

// --- buildPrivilegedBatch splits correctly ---
const batch = buildPrivilegedBatch({
  runId: 'run_1',
  turnId: 'turn_1',
  ops: [
    { command: 'apt-get install nginx', declaredCategory: 'install' },            // installAuto
    { command: 'dpkg -i ./local.deb', declaredCategory: 'install' },              // deferred -> other
    {
      command: 'systemctl restart nginx',
      declaredCategory: 'other',
      approvalId: 'claude:req-systemctl',
      wrapperCommand: 'agentoc-privileged -- systemctl restart nginx',
    },                                                                           // other
    { command: 'rm -rf /var/log/x', declaredCategory: 'delete' },                 // delete
  ],
});
check('batch id prefix', batch.batchId.startsWith('pbatch_'));
check('installAuto has 1', batch.installAuto.length === 1);
check('other has 2 (incl deferred)', batch.other.length === 2);
check('deferred flagged', batch.other.some((o) => o.deferredFromInstall));
check('delete has 1', batch.delete.length === 1);
check('batch pending', batch.status === PRIVILEGED_BATCH_STATUS.PENDING);

// --- default selection (other opt-out / delete opt-in) ---
eq('other default all selected', defaultSelectedOpIds(CATEGORY_OTHER, batch.other), batch.other.map((o) => o.opId));
eq('delete default none selected', defaultSelectedOpIds(CATEGORY_DELETE, batch.delete), []);
const opaqueDefaults = [
  { opId: 'wrapped', command: "/bin/bash -c 'rm /var/lib/qa/fixture'" },
  { opId: 'composite', command: 'systemctl status one; rm /tmp/example' },
  { opId: 'interpreter', command: 'python3 -c dangerous' },
  { opId: 'normal', command: 'systemctl restart example' },
];
eq('opaque and composite operations require explicit review', defaultSelectedOpIds(CATEGORY_OTHER, opaqueDefaults), ['normal']);

// --- resolvePrivilegedBatch ---
// Approve the systemctl op from other; approve nothing from delete.
const otherApprovedId = batch.other.find((o) => o.command === 'systemctl restart nginx').opId;
const resolved = resolvePrivilegedBatch(batch, { otherSelectedOpIds: [otherApprovedId], deleteSelectedOpIds: [] });
check('other approved count 1', resolved.other.approved.length === 1);
check('delete approved count 0', resolved.delete.approved.length === 0);
check('decision approved', resolved.decisions[otherApprovedId] === 'approved');
check('deferred op denied when not selected', resolved.decisions[batch.other.find((o) => o.deferredFromInstall).opId] === 'denied');
check('delete op denied', resolved.decisions[batch.delete[0].opId] === 'denied');
check('other manifest hash hex64', /^[0-9a-f]{64}$/.test(resolved.other.manifestHash));
check('delete manifest hex64', /^[0-9a-f]{64}$/.test(resolved.delete.manifestHash));

// select all of both
const resolvedAll = resolvePrivilegedBatch(batch, {
  otherSelectedOpIds: batch.other.map((o) => o.opId),
  deleteSelectedOpIds: batch.delete.map((o) => o.opId),
});
check('other all approved', resolvedAll.other.approved.length === 2);
check('delete all approved', resolvedAll.delete.approved.length === 1);
// batch manifest hash is stable across calls for the same selection
check('other manifest stable', computeBatchManifestHash(resolvedAll.other.approved, CATEGORY_OTHER) === resolvedAll.other.manifestHash);

// empty batch still resolves
const emptyBatch = buildPrivilegedBatch({ ops: [] });
const emptyResolved = resolvePrivilegedBatch(emptyBatch);
check('empty other approved 0', emptyResolved.other.approved.length === 0);

// --- event builders ---
const reqEvent = privilegedBatchRequestEvent(batch);
check('macOS approval event declares unavailable executor', privilegedBatchRequestEvent(batch, { platform: 'darwin' }).executorUnavailableReasonCode === 'macos_administrator_unavailable');
check('Linux approval event does not claim macOS limitation', privilegedBatchRequestEvent(batch, { platform: 'linux' }).executorUnavailableReasonCode === undefined);
check('request event type', reqEvent.type === 'privileged_batch_request');
check('request event role system', reqEvent.role === 'system');
check('request summarizes other', reqEvent.other.length === 2);
check('request summarizes delete', reqEvent.delete.length === 1);
check('request preserves approvalId', reqEvent.other.some((entry) => entry.approvalId === 'claude:req-systemctl'));
check('request preserves wrapperCommand', reqEvent.other.some((entry) => entry.wrapperCommand === 'agentoc-privileged -- systemctl restart nginx'));
check('request event null on no batch', privilegedBatchRequestEvent({}) === null);

// --- Phase 5: risk threaded from the gate onto the batch event top level ---
const riskBatch = buildPrivilegedBatch({
  runId: 'run_1',
  turnId: 'turn_1',
  ops: [
    {
      command: 'rm -rf /etc/evil',
      declaredCategory: 'delete',
      risk: { tier: 'danger', signals: { reasons: ['delete on system path'] } },
    },
    {
      command: 'apt-get install nginx',
      declaredCategory: 'install',
      risk: { tier: 'safe', signals: {} },
    },
  ],
});
const riskEvt = privilegedBatchRequestEvent(riskBatch);
check('batch event top-level risk worst tier', riskEvt.risk === 'danger');
check('batch op risk preserved', riskEvt.delete[0].risk.tier === 'danger');
check('batch event no risk when ops lack risk', !('risk' in reqEvent));

const respEvent = privilegedBatchResponseEvent({ batchId: batch.batchId, category: CATEGORY_DELETE, decisions: {} });
check('response event type', respEvent.type === 'privileged_batch_response');
check('response event category', respEvent.category === CATEGORY_DELETE);
check('response null without category', privilegedBatchResponseEvent({ batchId: batch.batchId }) === null);

const execEvent = privilegedExecResultEvent({ opId: 'pop_1', category: CATEGORY_INSTALL, exitCode: 0, auditId: 'aud_1' });
check('exec event type', execEvent.type === 'privileged_exec_result');
check('exec event null without opId', privilegedExecResultEvent({}) === null);

// --- quota ---
eq('quota allowed under cap', checkInstallQuota({ count: 2, max: 5 }).allowed, true);
eq('quota blocked at cap', checkInstallQuota({ count: 5, max: 5 }).allowed, false);
eq('quota remaining', checkInstallQuota({ count: 4, max: 5 }).remaining, 1);

console.log(`privileged-ops: ${passed} checks passed`);
