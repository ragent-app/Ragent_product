#!/usr/bin/env node
import assert from 'assert/strict';

import {
  getPrivilegedApprovalState,
  openPrivilegedBatchApproval,
  resolvePrivilegedCategoryApproval,
  resolvePrivilegedInstallAutoApproval,
  surfacePrivilegedBatchRequest,
  buildPrivilegedShimPolicyDenialUpdate,
  buildPrivilegedShimCategoryUpdate,
} from '../chat/privileged-approval.mjs';
import { buildPrivilegedBatch } from '../chat/privileged-ops.mjs';
import { CATEGORY_DELETE, CATEGORY_INSTALL, CATEGORY_OTHER } from '../chat/privileged-classifier.mjs';

let passed = 0;
function check(label, condition) {
  assert.ok(condition, `failed: ${label}`);
  passed += 1;
}

// Legacy category responses must settle only the exact shim operation, and an
// approved operation without an execution result must remain unresolved.
{
  const op = { opId: 'pop_qa', manifestHash: 'manifest_qa', command: 'rm /tmp/qa' };
  const run = { privilegedShimPending: { batchId: 'pbatch_qa', requestId: 'pshim_qa', opId: op.opId } };
  const deny = buildPrivilegedShimCategoryUpdate(run, 'pbatch_qa', { approved: [], denied: [op] });
  check('category denial settles exact shim', deny(run).privilegedShimResult.results[0].state === 'denied');
  check('category denial clears pending', deny(run).privilegedShimPending === undefined);
  check('approved op without executor result stays pending', buildPrivilegedShimCategoryUpdate(run, 'pbatch_qa', { approved: [op], denied: [] }) === null);
  const failed = buildPrivilegedShimCategoryUpdate(run, 'pbatch_qa', { approved: [op], denied: [] }, [{ opId: op.opId, exitCode: null, error: 'executor unavailable' }]);
  check('executor failure is not reported as success', failed(run).privilegedShimResult.results[0].state === 'failed');
  const success = buildPrivilegedShimCategoryUpdate(run, 'pbatch_qa', { approved: [op], denied: [] }, [{ opId: op.opId, exitCode: 0 }]);
  check('successful execution settles shim', success(run).privilegedShimResult.results[0].state === 'completed');
  check('other batch does not settle shim', buildPrivilegedShimCategoryUpdate(run, 'other', { approved: [], denied: [op] }) === null);
  check('stale updater does not change another pending op', deny({ privilegedShimPending: { batchId: 'pbatch_qa', opId: 'other' } }).privilegedShimResult === undefined);
}

function createFakeStore() {
  const events = [];
  const store = {
    events,
    invalidateCalls: 0,
    async readEvents() { return events.slice(); },
    async appendEvent(event) {
      const stored = { ...event, seq: events.length + 1 };
      events.push(stored);
      return stored;
    },
    async invalidate() { store.invalidateCalls += 1; },
  };
  return store;
}

function sampleBatch() {
  return buildPrivilegedBatch({
    runId: 'run_1',
    turnId: 'turn_1',
    ops: [
      { command: 'apt-get install nginx', declaredCategory: 'install' },     // installAuto
      { command: 'dpkg -i ./local.deb', declaredCategory: 'install' },       // deferred -> other
      { command: 'systemctl restart nginx', declaredCategory: 'other' },     // other
      { command: 'rm -rf /var/log/x', declaredCategory: 'delete' },          // delete
      { command: 'apt purge redis', declaredCategory: 'delete' },            // delete
    ],
  });
}

// --- open is idempotent and seeds defaults ---
{
  const store = createFakeStore();
  const batch = sampleBatch();
  const opened = await openPrivilegedBatchApproval(batch, store);
  check('open not duplicate', opened.duplicate === false);
  check('open appended request event', store.events.some((e) => e.type === 'privileged_batch_request'));
  check('request carries other ops', opened.requestEvent.other.length === 2);
  check('request carries delete ops', opened.requestEvent.delete.length === 2);
  check('request carries installAuto', opened.requestEvent.installAuto.length === 1);
  // default selection: other = all, delete = none
  check('default other all selected', opened.requestEvent.defaultSelected[CATEGORY_OTHER].length === 2);
  check('default delete none selected', opened.requestEvent.defaultSelected[CATEGORY_DELETE].length === 0);
  check('open invalidated once', store.invalidateCalls === 1);

  const reopened = await openPrivilegedBatchApproval(batch, store);
  check('reopen duplicate', reopened.duplicate === true);
  check('no second event', store.events.filter((e) => e.type === 'privileged_batch_request').length === 1);
}

// --- resolve other with a subset ---
{
  const store = createFakeStore();
  const batch = sampleBatch();
  await openPrivilegedBatchApproval(batch, store);
  const otherIds = batch.other.map((o) => o.opId);
  const picked = [otherIds[0]]; // only the systemctl op
  const resolved = await resolvePrivilegedCategoryApproval(
    { batchId: batch.batchId, category: CATEGORY_OTHER, checkedOpIds: picked },
    store,
  );
  check('resolve not duplicate', resolved.duplicate === false);
  check('resolve approved count', resolved.approved.length === 1);
  check('resolve denied count', resolved.denied.length === 1);
  check('resolve decisions approved', resolved.decisions[otherIds[0]] === 'approved');
  check('resolve decisions denied', resolved.decisions[otherIds[1]] === 'denied');
  check('resolve manifest hex64', /^[0-9a-f]{64}$/.test(resolved.manifestHash));
  check('resolve appended response event', store.events.some((e) => e.type === 'privileged_batch_response' && e.category === CATEGORY_OTHER));

  // idempotent re-resolve
  const again = await resolvePrivilegedCategoryApproval(
    { batchId: batch.batchId, category: CATEGORY_OTHER, checkedOpIds: otherIds },
    store,
  );
  check('re-resolve duplicate', again.duplicate === true);
  check('re-resolve returns approved ops', again.approved.length === 1);
  check('re-resolve returns denied ops', again.denied.length === 1);
  check('re-resolve returns category ops', again.categoryOps.length === 2);
  check('no second other response', store.events.filter((e) => e.type === 'privileged_batch_response' && e.category === CATEGORY_OTHER).length === 1);
}

// The unattended policy can refuse an install before any executor call.
{
  const store = createFakeStore();
  const batch = sampleBatch();
  await openPrivilegedBatchApproval(batch, store);
  const denied = await resolvePrivilegedCategoryApproval({
    batchId: batch.batchId,
    category: CATEGORY_INSTALL,
    checkedOpIds: [],
  }, store, { source: 'agentoc_auto_policy' });
  check('unattended install has no approved operation', denied.approved.length === 0);
  check('unattended install is denied', denied.denied.length === batch.installAuto.length);
  const duplicate = await resolvePrivilegedCategoryApproval({
    batchId: batch.batchId,
    category: CATEGORY_INSTALL,
    checkedOpIds: batch.installAuto.map((op) => op.opId),
  }, store);
  check('denial is idempotent and cannot turn into approval', duplicate.duplicate && duplicate.approved.length === 0);

  const run = { privilegedShimPending: { batchId: batch.batchId, requestId: 'request-1' } };
  const updater = buildPrivilegedShimPolicyDenialUpdate(run, batch, 'policy denied');
  const result = updater(run);
  check('shim receives explicit policy denial', result.privilegedShimResult.status === 'declined'
    && result.privilegedShimResult.reason === 'policy denied');
}

// --- resolve install-auto automatically, idempotently ---
{
  const store = createFakeStore();
  const batch = sampleBatch();
  await openPrivilegedBatchApproval(batch, store);
  const resolved = await resolvePrivilegedInstallAutoApproval({ batchId: batch.batchId, batch }, store);
  check('install-auto not duplicate', resolved.duplicate === false);
  check('install-auto category', resolved.category === CATEGORY_INSTALL);
  check('install-auto approved count', resolved.approved.length === 1);
  check('install-auto no denied ops', resolved.denied.length === 0);
  check('install-auto decision approved', resolved.decisions[batch.installAuto[0].opId] === 'approved');
  check('install-auto manifest hex64', /^[0-9a-f]{64}$/.test(resolved.manifestHash));
  check('install-auto response event', store.events.some((e) => e.type === 'privileged_batch_response' && e.category === CATEGORY_INSTALL));

  const again = await resolvePrivilegedInstallAutoApproval({ batchId: batch.batchId, batch }, store);
  check('install-auto re-resolve duplicate', again.duplicate === true);
  check('install-auto no second response', store.events.filter((e) => e.type === 'privileged_batch_response' && e.category === CATEGORY_INSTALL).length === 1);
  check('install-auto duplicate returns approved ops', again.approved.length === 1);
}

// --- resolve delete with nothing checked (opt-in) ---
{
  const store = createFakeStore();
  const batch = sampleBatch();
  await openPrivilegedBatchApproval(batch, store);
  const resolved = await resolvePrivilegedCategoryApproval(
    { batchId: batch.batchId, category: CATEGORY_DELETE, checkedOpIds: [] },
    store,
  );
  check('delete none approved', resolved.approved.length === 0);
  check('delete all denied', resolved.denied.length === 2);
}

// --- resolve ignores opIds not in the category ---
{
  const store = createFakeStore();
  const batch = sampleBatch();
  await openPrivilegedBatchApproval(batch, store);
  const deleteId = batch.delete[0].opId;
  // pass a bogus id alongside a real delete id
  const resolved = await resolvePrivilegedCategoryApproval(
    { batchId: batch.batchId, category: CATEGORY_DELETE, checkedOpIds: [deleteId, 'pop_bogus'] },
    store,
  );
  check('only real delete approved', resolved.approved.length === 1);
  check('bogus ignored', resolved.decisions['pop_bogus'] === undefined);
}

// --- errors ---
{
  const store = createFakeStore();
  await assert.rejects(() => openPrivilegedBatchApproval({}, store), { code: 'BATCH_REQUIRED' });
  await assert.rejects(() => openPrivilegedBatchApproval({ batchId: 'x' }, {}), { code: 'STORE_REQUIRED' });
  await assert.rejects(
    () => resolvePrivilegedCategoryApproval({ batchId: 'missing', category: CATEGORY_OTHER }, store),
    { code: 'BATCH_NOT_FOUND' },
  );
  await assert.rejects(
    () => resolvePrivilegedCategoryApproval({ category: CATEGORY_OTHER }, store),
    { code: 'RESOLVE_TARGET_REQUIRED' },
  );
}

// --- approval state helper ---
{
  const store = createFakeStore();
  const batch = sampleBatch();
  check('state null before open', await getPrivilegedApprovalState(store, batch.batchId) === null);
  await openPrivilegedBatchApproval(batch, store);
  await resolvePrivilegedCategoryApproval(
    { batchId: batch.batchId, category: CATEGORY_OTHER, checkedOpIds: [] },
    store,
  );
  const state = await getPrivilegedApprovalState(store, batch.batchId);
  check('state has request', Boolean(state?.requestEvent));
  check('state resolvedCategories has other', state.resolvedCategories.includes(CATEGORY_OTHER));
  check('state pending has delete', state.pending.includes(CATEGORY_DELETE));
  check('state pending excludes other', !state.pending.includes(CATEGORY_OTHER));
}

// --- P1c-5: surfacePrivilegedBatchRequest (sync glue helper, design §13.7) ---
{
  // no batch -> noop
  const r0 = await surfacePrivilegedBatchRequest(null, true, createFakeStore());
  check('surface no batch clear false', r0.clear === false);
  check('surface no batch changed false', r0.changed === false);

  // privilegedMode off -> clear stale pending, no store write
  const storeOff = createFakeStore();
  const r1 = await surfacePrivilegedBatchRequest(sampleBatch(), false, storeOff);
  check('surface mode-off clear true', r1.clear === true);
  check('surface mode-off changed false', r1.changed === false);
  check('surface mode-off no event', storeOff.events.length === 0);

  // privilegedMode on, fresh -> append request, changed
  const storeOn = createFakeStore();
  const freshBatch = sampleBatch();
  const r2 = await surfacePrivilegedBatchRequest(freshBatch, true, storeOn);
  check('surface fresh clear true', r2.clear === true);
  check('surface fresh changed true', r2.changed === true);
  check('surface fresh one request', storeOn.events.filter((e) => e.type === 'privileged_batch_request').length === 1);

  // privilegedMode on, duplicate -> clear true, changed false, still one event
  const r3 = await surfacePrivilegedBatchRequest(freshBatch, true, storeOn);
  check('surface dup clear true', r3.clear === true);
  check('surface dup changed false', r3.changed === false);
  check('surface dup still one request', storeOn.events.filter((e) => e.type === 'privileged_batch_request').length === 1);

  // privilegedMode on, transient store error (plain Error) -> leave pending (clear false) for retry
  const storeTransient = createFakeStore();
  storeTransient.appendEvent = async () => { throw new Error('disk full'); };
  const r4 = await surfacePrivilegedBatchRequest(sampleBatch(), true, storeTransient);
  check('surface transient clear false', r4.clear === false);
  check('surface transient changed false', r4.changed === false);
  check('surface transient has error', Boolean(r4.error));

  // privilegedMode on, BATCH_INVALID-coded error -> drop the batch (clear true)
  const storeInvalid = createFakeStore();
  storeInvalid.appendEvent = async () => { const e = new Error('bad batch'); e.code = 'BATCH_INVALID'; throw e; };
  const r5 = await surfacePrivilegedBatchRequest(sampleBatch(), true, storeInvalid);
  check('surface invalid clear true', r5.clear === true);
  check('surface invalid changed false', r5.changed === false);

  // privilegedMode on, store missing -> throws STORE_REQUIRED
  await assert.rejects(() => surfacePrivilegedBatchRequest(sampleBatch(), true, {}), { code: 'STORE_REQUIRED' });
}

console.log(`privileged-approval: ${passed} checks passed`);
