#!/usr/bin/env node
import assert from 'assert/strict';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tempHome = mkdtempSync(join(tmpdir(), 'ragent-autonomous-org-s17-'));
process.env.HOME = tempHome;
process.env.RAGENT_INSTANCE_ROOT = tempHome;
process.env.RAGENT_CONFIG_DIR = join(tempHome, 'config');
mkdirSync(join(tempHome, 'workspace'), { recursive: true });

const journal = await import('../chat/organization-operations.mjs');
const dispatcher = await import('../chat/organization-command-dispatcher.mjs');

let assertions = 0;
function equal(actual, expected, message) { assertions += 1; assert.equal(actual, expected, message); }
function deepEqual(actual, expected, message) { assertions += 1; assert.deepEqual(actual, expected, message); }
function ok(value, message) { assertions += 1; assert.ok(value, message); }
function throwsCode(fn, code, message) { assertions += 1; assert.throws(fn, (e) => e?.code === code, message); }
async function rejectsCode(fn, code, message) { assertions += 1; await assert.rejects(fn, (e) => e?.code === code, message); }

await journal.initializeOrganizationOperations();
const base = {
  organizationId: 'org-s17-a', commandKind: 'delegateTask', idempotencyKey: 'idem-a',
  actorNodeId: 'manager-a', actorSessionId: 'root-a', revision: 1,
  payload: { objective: 'bounded task' },
};
const operation = await journal.createOperation(base);
equal(operation.state, 'requested', 'new operation starts requested');
equal(operation.currentStep, 'requested', 'new operation records requested step');
equal(operation.revision, 1, 'revision is persisted');
ok(operation.operationId.startsWith('op_'), 'operation id is generated');
deepEqual(operation.payload, base.payload, 'payload round trips');

const replay = await journal.createOperation({ ...base, operationId: 'op_different' });
equal(replay.operationId, operation.operationId, 'same organization/idempotency key replays');
equal((await journal.listOperations('org-s17-a')).length, 1, 'replay creates no second operation');
await rejectsCode(() => journal.createOperation({ ...base, payload: { objective: 'changed' } }), journal.ORG_OPERATION_CONFLICT, 'same key with changed payload conflicts');
await rejectsCode(() => journal.getOperation('op_missing'), journal.ORG_OPERATION_NOT_FOUND, 'missing operation has stable error');

let current = operation;
for (const nextState of ['validated', 'facts_created', 'external_effect_created', 'bound', 'completed']) {
  current = await journal.transitionOperation(current.operationId, {
    expectedState: current.state, expectedVersion: current.version,
    expectedGeneration: current.generation, nextState,
    currentStep: nextState, result: { step: nextState },
  });
  equal(current.state, nextState, `transition reaches ${nextState}`);
}
equal(current.attempts, 5, 'each CAS transition increments attempts');
ok(current.completedAt, 'completed operation records completion time');
await rejectsCode(() => journal.transitionOperation(current.operationId, { expectedState: 'bound', expectedVersion: current.version, nextState: 'completed' }), journal.ORG_OPERATION_CONFLICT, 'terminal operation cannot be replay-transitioned');
await rejectsCode(() => journal.transitionOperation(operation.operationId, { expectedState: 'requested', expectedVersion: 1, nextState: 'validated' }), journal.ORG_OPERATION_CONFLICT, 'stale state/version is rejected');

const retry = await journal.createOperation({ ...base, organizationId: 'org-s17-b', idempotencyKey: 'idem-retry', operationId: 'op_retry' });
const failed = await journal.transitionOperation(retry.operationId, { expectedState: 'requested', expectedVersion: retry.version, nextState: 'failed_retryable', operationError: { code: 'ETIMEDOUT' } });
equal(failed.state, 'failed_retryable', 'retryable failure is durable');
const reconciled = await journal.reconcileOperation(retry.operationId, { stepHandlers: { reconciled: () => ({ nextState: 'validated', result: { recovered: true } }) } });
equal(reconciled.state, 'validated', 'reconcile resumes a retryable operation');
equal(reconciled.result.recovered, true, 'reconcile result is persisted');
const terminal = await journal.transitionOperation(retry.operationId, { expectedState: 'validated', expectedVersion: reconciled.version, nextState: 'failed_terminal', operationError: { code: 'DENIED' } });
equal(terminal.state, 'failed_terminal', 'terminal failure is durable');

const otherOrg = await journal.createOperation({ ...base, organizationId: 'org-s17-c', idempotencyKey: 'idem-a' });
ok(otherOrg.operationId !== operation.operationId, 'same idempotency key is isolated by organization');
equal((await journal.listOperations('org-s17-b', { states: ['failed_terminal'] })).length, 1, 'state filtering is organization scoped');

const command = { ...base, organizationId: 'org-s17-c', idempotencyKey: 'dispatch-a', commandKind: 'proposeOrganization' };
const dispatched = await dispatcher.dispatchOrganizationCommand(command);
equal(dispatched.commandKind, 'proposeOrganization', 'dispatcher creates structured operation');
const dispatchedReplay = await dispatcher.dispatchOrganizationCommand({ ...command, operationId: 'ignored-replay-id' });
equal(dispatchedReplay.operationId, dispatched.operationId, 'dispatcher replay is idempotent');
throwsCode(() => dispatcher.validateOrganizationCommand({ ...command, internal: true }), dispatcher.ORG_COMMAND_INVALID, 'forged internal flag is rejected');
throwsCode(() => dispatcher.validateOrganizationCommand({ ...command, commandKind: 'forkSession' }), dispatcher.ORG_COMMAND_INVALID, 'direct fork is rejected');
throwsCode(() => dispatcher.validateOrganizationCommand({ ...command, commandKind: 'unknownCommand' }), dispatcher.ORG_COMMAND_INVALID, 'unknown command is rejected');
throwsCode(() => dispatcher.validateOrganizationCommand({ ...command, sessionId: 'session-forge' }), dispatcher.ORG_COMMAND_INVALID, 'session id bypass field is rejected');
throwsCode(() => dispatcher.validateOrganizationCommand({ ...command, payload: { sql: 'DELETE FROM organization_operations' } }), dispatcher.ORG_COMMAND_INVALID, 'nested SQL is rejected');
await rejectsCode(() => dispatcher.dispatchOrganizationCommand({ ...command, commandKind: 'delegateTask', idempotencyKey: 'dispatch-no-auth' }), dispatcher.ORG_COMMAND_INVALID, 'manager mutation requires server authorization callback');
await rejectsCode(() => dispatcher.dispatchOrganizationCommand({ ...command, commandKind: 'delegateTask', idempotencyKey: 'dispatch-denied' }, { authorizeCommand: () => false }), dispatcher.ORG_COMMAND_INVALID, 'worker or reviewer denial is fail closed');
const authorized = await dispatcher.dispatchOrganizationCommand({ ...command, commandKind: 'delegateTask', idempotencyKey: 'dispatch-ok' }, { authorizeCommand: (value) => value.actorNodeId === 'manager-a' });
equal(authorized.state, 'requested', 'authorized manager command is durable but not auto-run');

const auto = await dispatcher.dispatchOrganizationCommand({ ...command, commandKind: 'proposeOrganization', idempotencyKey: 'dispatch-auto' }, {
  autoAdvance: true,
  stepHandlers: {
    requested: () => ({ nextState: 'validated' }),
    validated: () => ({ nextState: 'facts_created' }),
    facts_created: () => ({ nextState: 'external_effect_created' }),
    external_effect_created: () => ({ nextState: 'bound' }),
    bound: () => ({ nextState: 'completed', result: { done: true } }),
  },
});
equal(auto.state, 'completed', 'dispatcher can run injected durable steps');
equal(auto.result.done, true, 'auto-run result is recorded');

const probe = execFileSync(process.execPath, ['--input-type=module', '--eval', `
  import { getOperation } from ${JSON.stringify(new URL('../chat/organization-operations.mjs', import.meta.url).href)};
  const op = await getOperation(${JSON.stringify(operation.operationId)});
  console.log(op.state + ':' + op.operationId);
`], { env: process.env, encoding: 'utf8' }).trim();
equal(probe, `completed:${operation.operationId}`, 'a fresh process can reconcile/read the journal');

console.log(`test-autonomous-organization-s17: ok (${assertions} assertions)`);
