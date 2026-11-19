#!/usr/bin/env node
import assert from 'assert/strict';

import {
  DELEGATION_ACTIVE_STATES,
  DELEGATION_EVENT_KINDS,
  DELEGATION_SCHEMA_VERSION,
  DELEGATION_STATES,
  DELEGATION_TERMINAL_STATES,
  DelegationContractError,
  buildDelegationIdentity,
  buildDelegationSnapshot,
  buildRecoveryFacts,
  buildTerminalCandidate,
  computeActiveChildDelegations,
  createDelegationProjector,
  isDelegationActive,
  isDelegationStateTransitionValid,
  isDelegationTerminal,
  normalizeDelegationEvent,
  redactDelegationPayload,
  validateDelegationEvent,
} from '../chat/delegation-canonical.mjs';

function makeEvent(fields) {
  return normalizeDelegationEvent({
    provider: 'claude',
    providerDelegationId: 'sub_1',
    runId: 'run_1',
    parentSessionId: 'sess_parent',
    childSessionId: 'sess_child',
    ...fields,
  });
}

function identity(provider, providerDelegationId, runId) {
  return buildDelegationIdentity({ provider, providerDelegationId, runId });
}

// --- schemaVersion & identity -------------------------------------------------
assert.equal(DELEGATION_SCHEMA_VERSION, 1);
assert.deepEqual(
  DELEGATION_STATES,
  ['spawned', 'running', 'waiting', 'completed', 'failed', 'cancelled', 'interrupted', 'lost'],
);
assert.deepEqual(
  DELEGATION_EVENT_KINDS,
  ['spawned', 'running', 'waiting', 'completed', 'failed', 'cancelled', 'interrupted', 'lost', 'snapshot', 'recovered'],
);
assert.deepEqual(
  DELEGATION_TERMINAL_STATES,
  ['completed', 'failed', 'cancelled', 'interrupted', 'lost'],
);
assert.deepEqual(
  DELEGATION_ACTIVE_STATES,
  ['spawned', 'running', 'waiting'],
);

// The identity is namespaced by (provider, runId, providerDelegationId): the
// same provider-native id in a different run never collides.
assert.equal(
  identity('claude', 'sub_1', 'run_1').id,
  identity('claude', 'sub_1', 'run_1').id,
  'identity is deterministic for the same namespaced key',
);
assert.notEqual(
  identity('claude', 'sub_1', 'run_1').id,
  identity('claude', 'sub_1', 'run_2').id,
  'identity must separate the same provider delegation id across runs',
);
assert.notEqual(
  identity('claude', 'sub_1', 'run_1').id,
  identity('codex', 'sub_1', 'run_1').id,
  'identity must separate providers',
);
assert.equal(
  buildDelegationIdentity({ provider: 'claude', providerDelegationId: '', runId: 'run_1' }).id,
  '',
  'identity requires a provider delegation id',
);
assert.ok(identity('claude', 'sub_1', 'run_1').id.startsWith('delg_'));

// --- valid events --------------------------------------------------------------
const spawn = makeEvent({ kind: 'spawned', state: 'spawned', seq: 1, timestamp: 1 });
assert.equal(spawn.schemaVersion, 1);
assert.equal(spawn.kind, 'spawned');
assert.equal(spawn.state, 'spawned');
assert.equal(spawn.seq, 1);
assert.equal(spawn.timestamp, 1);
assert.equal(spawn.delegationId, identity('claude', 'sub_1', 'run_1').id);
  assert.equal(spawn.parentSessionId, 'sess_parent');
  assert.equal(spawn.childSessionId, 'sess_child');
assert.equal(Object.isFrozen(spawn), true);

// Missing provider timestamps/event ids must still replay deterministically.
const implicitA = normalizeDelegationEvent({
  provider: 'claude', providerDelegationId: 'sub_implicit', runId: 'run_implicit',
  parentSessionId: 'sess_parent', kind: 'spawned', state: 'spawned', seq: 7,
});
const implicitB = normalizeDelegationEvent({
  provider: 'claude', providerDelegationId: 'sub_implicit', runId: 'run_implicit',
  parentSessionId: 'sess_parent', kind: 'spawned', state: 'spawned', seq: 7,
});
assert.deepEqual(implicitA, implicitB, 'normalization must be deterministic when provider omits time/id');
assert.equal(implicitA.timestamp, 7, 'seq is the deterministic timestamp fallback');

assert.deepEqual(validateDelegationEvent(spawn), { ok: true, errors: [] });
assert.deepEqual(validateDelegationEvent(makeEvent({ kind: 'running', state: 'running', seq: 2, timestamp: 2 })), { ok: true, errors: [] });

// A snapshot event carries the current state and stays neutral.
const snapshot = makeEvent({ kind: 'snapshot', state: 'spawned', seq: 2, timestamp: 2, facts: { snapshot: { state: 'spawned', position: 1 } } });
assert.deepEqual(validateDelegationEvent(snapshot), { ok: true, errors: [] });

// Missing identity / malformed fields are rejected by the validator.
assert.equal(validateDelegationEvent({ ...spawn, provider: '' }).ok, false);
assert.equal(validateDelegationEvent({ ...spawn, seq: 0 }).ok, false);
assert.equal(validateDelegationEvent({ ...spawn, state: 'bogus' }).ok, false);
assert.equal(validateDelegationEvent({ ...spawn, kind: 'bogus' }).ok, false);
assert.equal(validateDelegationEvent({ ...spawn, schemaVersion: 99 }).ok, false);
assert.equal(validateDelegationEvent({ ...spawn, timestamp: 'not-a-number' }).ok, false);
assert.equal(validateDelegationEvent({ ...spawn, childSessionId: '' }).ok, false);
assert.equal(validateDelegationEvent({ ...spawn, delegationId: 'delg_wrong' }).ok, false);
assert.equal(validateDelegationEvent({ ...spawn, facts: { bogus: {} } }).ok, false);

// A kind must target its matching state.
assert.equal(validateDelegationEvent({ ...spawn, kind: 'running', state: 'spawned' }).ok, false);
assert.equal(validateDelegationEvent({ ...spawn, kind: 'recovered', state: 'spawned' }).ok, false);

// normalize throws a typed contract error on violation.
assert.throws(
  () => normalizeDelegationEvent({ provider: 'claude', providerDelegationId: 'sub_1', runId: 'run_1', parentSessionId: 'p', kind: 'running', state: 'spawned', seq: 1, timestamp: 1 }),
  (error) => error instanceof DelegationContractError && error.code === 'DELEGATION_CONTRACT',
);

// --- duplicate identity ----------------------------------------------------------
{
  const projector = createDelegationProjector();
  const first = projector.apply(makeEvent({ kind: 'spawned', state: 'spawned', seq: 1, timestamp: 1 }));
  assert.deepEqual(first, { ok: true, state: 'spawned', delegationId: identity('claude', 'sub_1', 'run_1').id });
  const duplicate = projector.apply(makeEvent({ kind: 'spawned', state: 'spawned', seq: 2, timestamp: 2 }));
  assert.equal(duplicate.ok, false);
  assert.ok(duplicate.errors.some((error) => error.includes('duplicate identity')), `unexpected errors: ${duplicate.errors.join('; ')}`);
}

// Nested delegation keeps its canonical parent identity and cannot outlive it.
{
  const projector = createDelegationProjector();
  const parent = makeEvent({ kind: 'spawned', state: 'spawned', seq: 1, timestamp: 1 });
  assert.equal(projector.apply(parent).ok, true);
  const nested = normalizeDelegationEvent({
    provider: 'codex', providerDelegationId: 'nested_1', runId: 'run_1',
    parentSessionId: 'sess_parent', parentDelegationId: parent.delegationId,
    childSessionId: 'nested_child', kind: 'spawned', state: 'spawned', seq: 1, timestamp: 2,
  });
  assert.equal(projector.apply(nested).ok, true);
  assert.equal(nested.parentDelegationId, parent.delegationId);
  const orphan = normalizeDelegationEvent({
    provider: 'codex', providerDelegationId: 'orphan_1', runId: 'run_1',
    parentSessionId: 'sess_parent', parentDelegationId: 'delg_00000000000000000000',
    kind: 'spawned', state: 'spawned', seq: 1, timestamp: 3,
  });
  assert.equal(projector.apply(orphan).ok, false);
}

// --- cross-run parent ------------------------------------------------------------
{
  // Validator: a delegationId that namespaces run_1 cannot be re-issued under run_2.
  const crossRunEvent = {
    schemaVersion: 1,
    kind: 'running',
    state: 'running',
    seq: 2,
    timestamp: 2,
    provider: 'claude',
    providerDelegationId: 'sub_1',
    runId: 'run_2',
    parentSessionId: 'sess_parent',
    delegationId: identity('claude', 'sub_1', 'run_1').id,
  };
  const result = validateDelegationEvent(crossRunEvent);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('inconsistent')), `unexpected errors: ${result.errors.join('; ')}`);
}

{
  // Projector: a child session bound by an active delegation in run_1 cannot be
  // claimed by another run while still active (cross-run child busy).
  const projector = createDelegationProjector();
  assert.equal(projector.apply(makeEvent({ kind: 'spawned', state: 'spawned', seq: 1, timestamp: 1 })).ok, true);
  assert.equal(projector.apply(makeEvent({ kind: 'running', state: 'running', seq: 2, timestamp: 2 })).ok, true);
  const busy = projector.apply(normalizeDelegationEvent({
    provider: 'codex',
    providerDelegationId: 'codex_sub',
    runId: 'run_2',
    parentSessionId: 'sess_other_parent',
    childSessionId: 'sess_child',
    kind: 'spawned',
    state: 'spawned',
    seq: 1,
    timestamp: 3,
  }));
  assert.equal(busy.ok, false);
  assert.ok(busy.errors.some((error) => error.includes('child session') && error.includes('busy')), `unexpected errors: ${busy.errors.join('; ')}`);

  const sameRunBusy = projector.apply(normalizeDelegationEvent({
    provider: 'claude', providerDelegationId: 'sub_other', runId: 'run_1',
    parentSessionId: 'sess_parent', childSessionId: 'sess_child', kind: 'spawned', state: 'spawned', seq: 1, timestamp: 4,
  }));
  assert.equal(sameRunBusy.ok, false, 'an active child cannot be rebound by another delegation in the same run');
}

// --- illegal state transitions ----------------------------------------------------
assert.equal(isDelegationStateTransitionValid('spawned', 'running'), true);
assert.equal(isDelegationStateTransitionValid('spawned', 'completed'), true);
assert.equal(isDelegationStateTransitionValid('running', 'waiting'), true);
assert.equal(isDelegationStateTransitionValid('waiting', 'running'), true);
assert.equal(isDelegationStateTransitionValid('running', 'running'), true);
assert.equal(isDelegationStateTransitionValid('waiting', 'waiting'), true);
assert.equal(isDelegationStateTransitionValid('completed', 'running'), false);
assert.equal(isDelegationStateTransitionValid('completed', 'cancelled'), false);
assert.equal(isDelegationStateTransitionValid('waiting', 'spawned'), false);
assert.equal(isDelegationStateTransitionValid('bogus', 'running'), false);

{
  const projector = createDelegationProjector();
  projector.apply(makeEvent({ kind: 'spawned', state: 'spawned', seq: 1, timestamp: 1 }));
  projector.apply(makeEvent({ kind: 'running', state: 'running', seq: 2, timestamp: 2 }));
  projector.apply(makeEvent({ kind: 'completed', state: 'completed', seq: 3, timestamp: 3 }));
  const resurrection = projector.apply(makeEvent({ kind: 'running', state: 'running', seq: 4, timestamp: 4 }));
  assert.equal(resurrection.ok, false);
  assert.ok(resurrection.errors.some((error) => error.includes('illegal state transition')), `unexpected errors: ${resurrection.errors.join('; ')}`);

  // First event must be spawned.
  const jumpStart = createDelegationProjector();
  const firstRunning = jumpStart.apply(normalizeDelegationEvent({
    provider: 'claude', providerDelegationId: 'sub_9', runId: 'run_9', parentSessionId: 'p',
    kind: 'running', state: 'running', seq: 1, timestamp: 1,
  }));
  assert.equal(firstRunning.ok, false);
  assert.ok(firstRunning.errors.some((error) => error.includes("must be 'spawned'")), `unexpected errors: ${firstRunning.errors.join('; ')}`);

  // Snapshot state must match the current state (it is neutral, not a transition).
  const wrongSnapshot = createDelegationProjector();
  wrongSnapshot.apply(makeEvent({ kind: 'spawned', state: 'spawned', seq: 1, timestamp: 1 }));
  const mismatch = wrongSnapshot.apply(makeEvent({ kind: 'snapshot', state: 'running', seq: 2, timestamp: 2 }));
  assert.equal(mismatch.ok, false);
  assert.ok(mismatch.errors.some((error) => error.includes('must match current state')), `unexpected errors: ${mismatch.errors.join('; ')}`);
}

// --- terminal / lost -------------------------------------------------------------
for (const state of DELEGATION_TERMINAL_STATES) assert.equal(isDelegationTerminal(state), true);
assert.equal(isDelegationTerminal('spawned'), false);
assert.equal(isDelegationTerminal('running'), false);
assert.equal(isDelegationTerminal('waiting'), false);
for (const state of DELEGATION_ACTIVE_STATES) assert.equal(isDelegationActive(state), true);
for (const state of DELEGATION_TERMINAL_STATES) assert.equal(isDelegationActive(state), false);

// lost -> recovered -> running is the one recovery arc.
assert.equal(isDelegationStateTransitionValid('lost', 'running'), true);
assert.equal(isDelegationStateTransitionValid('lost', 'failed'), true);
assert.equal(isDelegationStateTransitionValid('lost', 'completed'), false);
assert.equal(isDelegationStateTransitionValid('lost', 'cancelled'), false);

{
  const projector = createDelegationProjector();
  projector.apply(makeEvent({ kind: 'spawned', state: 'spawned', seq: 1, timestamp: 1 }));
  projector.apply(makeEvent({ kind: 'running', state: 'running', seq: 2, timestamp: 2 }));
  const lost = projector.apply(makeEvent({
    kind: 'lost', state: 'lost', seq: 3, timestamp: 3,
    facts: { recovery: { mode: 'resume', resumeRef: 'sess_resume_ref', reason: 'transport dropped' } },
  }));
  assert.deepEqual(lost, { ok: true, state: 'lost', delegationId: identity('claude', 'sub_1', 'run_1').id });
  assert.equal(projector.isTerminal(identity('claude', 'sub_1', 'run_1').id), true);

  const recovered = projector.apply(makeEvent({ kind: 'recovered', state: 'running', seq: 4, timestamp: 4 }));
  assert.deepEqual(recovered, { ok: true, state: 'running', delegationId: identity('claude', 'sub_1', 'run_1').id });
  assert.equal(projector.isTerminal(identity('claude', 'sub_1', 'run_1').id), false);
  assert.deepEqual(projector.getFacts(identity('claude', 'sub_1', 'run_1').id), {
    recovery: { mode: 'resume', resumeRef: 'sess_resume_ref', reason: 'transport dropped' },
  });

  // A lost delegation can be declared failed (recovery impossible) but not resurrected through a generic running event.
  const badRecovery = createDelegationProjector();
  badRecovery.apply(makeEvent({ kind: 'spawned', state: 'spawned', seq: 1, timestamp: 1 }));
  badRecovery.apply(makeEvent({ kind: 'lost', state: 'lost', seq: 2, timestamp: 2 }));
  const genericRunning = badRecovery.apply(makeEvent({ kind: 'running', state: 'running', seq: 3, timestamp: 3 }));
  assert.equal(genericRunning.ok, false);
  assert.ok(genericRunning.errors.some((error) => error.includes("is lost; only 'recovered'")), `unexpected errors: ${genericRunning.errors.join('; ')}`);
}

// Terminal candidate / snapshot / recovery facts are bounded and validated.
assert.deepEqual(buildTerminalCandidate({ outcome: 'completed', resultRef: 'rp_1', reasonKind: 'ok' }), {
  outcome: 'completed',
  resultRef: 'rp_1',
  reasonKind: 'ok',
});
assert.deepEqual(buildTerminalCandidate({ outcome: 'lost', reason: 'lease expired' }), {
  outcome: 'lost',
  reason: 'lease expired',
});
assert.equal(buildTerminalCandidate({ outcome: 'waiting' }), null, 'non-terminal outcome cannot be a candidate');
assert.equal(buildTerminalCandidate({ outcome: 'bogus' }), null);
assert.deepEqual(buildDelegationSnapshot({ state: 'running', position: 3, resultRef: 'rp_1' }), {
  state: 'running',
  resultRef: 'rp_1',
  position: 3,
});
assert.equal(buildDelegationSnapshot({ state: 'bogus' }), null);
assert.equal('position' in buildDelegationSnapshot({ state: 'running', position: -1 }), false, 'negative position is dropped, not stored');
assert.deepEqual(buildRecoveryFacts({ mode: 'restart' }), { mode: 'restart' });
assert.equal(buildRecoveryFacts({ mode: 'unknown' }), null);
assert.equal(buildTerminalCandidate({ outcome: 'completed', resultRef: 'sk-ant-secret-token' }).resultRef, undefined,
  'credential-like result handles must not enter facts');
assert.equal(buildRecoveryFacts({ mode: 'resume', resumeRef: 'provider/thread/with/slash' }).resumeRef, undefined,
  'unbounded resume handles must not enter facts');

// --- active-child determination --------------------------------------------------
{
  const projector = createDelegationProjector();
  assert.equal(projector.isChildSessionActive('sess_child'), false);
  projector.apply(makeEvent({ kind: 'spawned', state: 'spawned', seq: 1, timestamp: 1 }));
  assert.equal(projector.isChildSessionActive('sess_child'), true);
  assert.deepEqual([...projector.activeChildSessionIds()], ['sess_child']);

  projector.apply(makeEvent({ kind: 'running', state: 'running', seq: 2, timestamp: 2 }));
  assert.equal(projector.isChildSessionActive('sess_child'), true);

  projector.apply(makeEvent({ kind: 'completed', state: 'completed', seq: 3, timestamp: 3 }));
  assert.equal(projector.isChildSessionActive('sess_child'), false, 'terminal delegation releases the child');
  assert.deepEqual([...projector.activeChildSessionIds()], []);
}

{
  const events = [
    makeEvent({ kind: 'spawned', state: 'spawned', seq: 1, timestamp: 1 }),
    makeEvent({ kind: 'running', state: 'running', seq: 2, timestamp: 2 }),
  ];
  const projection = computeActiveChildDelegations(events);
  assert.equal(projection.ok, true);
  assert.deepEqual(projection.errors, []);
  assert.deepEqual([...projection.activeChildSessionIds], ['sess_child']);
  assert.equal(projection.isChildSessionActive('sess_child'), true);
}

{
  const invalidReplay = computeActiveChildDelegations([
    makeEvent({ kind: 'spawned', state: 'spawned', seq: 1, timestamp: 1 }),
    makeEvent({ kind: 'running', state: 'running', seq: 1, timestamp: 2 }),
  ]);
  assert.equal(invalidReplay.ok, false, 'invalid replay must be fail-closed');
  assert.ok(invalidReplay.errors.some((error) => error.includes('strictly increasing')));
}

// --- sensitive value redaction ---------------------------------------------------
{
  const raw = {
    provider: 'claude',
    providerDelegationId: 'sub_1',
    runId: 'run_1',
    parentSessionId: 'sess_parent',
    childSessionId: 'sess_child',
    kind: 'spawned',
    state: 'spawned',
    seq: 1,
    timestamp: 1,
    rawPayload: { command: 'echo hi', env: { API_KEY: 'sk-ant-abcdef1234567890' } },
    token: 'sk-ant-raw-secret-token-value',
    accessToken: 'provider-access-token',
    secret: 'do-not-leak',
    authorization: 'Bearer provider-bearer-token',
    hiddenContext: { hidden: true, note: 'internal prompt block' },
    _internal: 'underscore hidden field',
  };
  const canonical = normalizeDelegationEvent(raw);
  for (const forbidden of ['rawPayload', 'token', 'accessToken', 'secret', 'authorization', 'hiddenContext', '_internal']) {
    assert.equal(Object.hasOwn(canonical, forbidden), false, `forbidden field '${forbidden}' must be stripped`);
  }
  const serialized = JSON.stringify(canonical);
  for (const leak of [
    'sk-ant-raw-secret-token-value',
    'provider-access-token',
    'do-not-leak',
    'provider-bearer-token',
    'internal prompt block',
    'API_KEY',
  ]) {
    assert.equal(serialized.includes(leak), false, `serialized canonical event must not contain '${leak}'`);
  }
  assert.equal(canonical.delegationId, identity('claude', 'sub_1', 'run_1').id, 'identity survives redaction');

  // Value-level redaction inside otherwise-safe fields (e.g. a reason string).
  const redacted = normalizeDelegationEvent({
    ...raw,
    rawPayload: undefined,
    token: undefined,
    accessToken: undefined,
    secret: undefined,
    authorization: undefined,
    hiddenContext: undefined,
    _internal: undefined,
    kind: 'failed',
    state: 'failed',
    seq: 2,
    timestamp: 2,
    facts: { candidate: { outcome: 'failed', reason: 'auth rejected sk-ant-abcdef1234567890' } },
  });
  assert.equal(redacted.facts.candidate.reason.includes('sk-ant-a...redacted'), true);
  assert.equal(JSON.stringify(redacted).includes('sk-ant-abcdef1234567890'), false);

  // Standalone helper redacts recursively and keeps safe fields.
  const stripped = redactDelegationPayload({
    ok: 'kept',
    token: 'sk-xyz',
    nested: { hidden: 'x', safe: 'y' },
  });
  assert.deepEqual(stripped, { ok: 'kept', nested: { safe: 'y' } });

  // The validator fails closed when a raw event still carries a forbidden field.
  const rejected = validateDelegationEvent(raw);
  assert.equal(rejected.ok, false);
  assert.ok(rejected.errors.some((error) => error.includes('forbidden fields')), `unexpected errors: ${rejected.errors.join('; ')}`);
}

// --- root birthActor generalization (codex + agy top-level spawned only) ----
{
  const agyRootSpawn = normalizeDelegationEvent({
    provider: 'agy',
    providerDelegationId: 'agy_sub_1',
    runId: 'run_agy_1',
    parentSessionId: 'sess_parent',
    childSessionId: 'agy_child_1',
    kind: 'spawned',
    state: 'spawned',
    seq: 1,
    timestamp: 1,
    facts: { birthActor: 'root_session' },
  });
  assert.deepEqual(validateDelegationEvent(agyRootSpawn), { ok: true, errors: [] });
  assert.equal(agyRootSpawn.facts.birthActor, 'root_session');

  const codexRootSpawn = normalizeDelegationEvent({
    provider: 'codex',
    providerDelegationId: 'codex_sub_1',
    runId: 'run_codex_1',
    parentSessionId: 'sess_parent',
    kind: 'spawned',
    state: 'spawned',
    seq: 1,
    timestamp: 1,
    facts: { birthActor: 'root_session' },
  });
  assert.deepEqual(validateDelegationEvent(codexRootSpawn), { ok: true, errors: [] });

  assert.equal(
    validateDelegationEvent({ ...agyRootSpawn, provider: 'claude' }).ok,
    false,
    'non-root-birth providers must still reject root_session birthActor',
  );
  assert.equal(
    validateDelegationEvent({ ...agyRootSpawn, parentDelegationId: identity('agy', 'parent', 'run_agy_1').id }).ok,
    false,
    'nested child cannot claim root_session birthActor',
  );
  assert.equal(
    validateDelegationEvent({ ...agyRootSpawn, kind: 'running', state: 'running' }).ok,
    false,
    'non-spawned event cannot carry root_session birthActor',
  );
}

console.log('test-delegation-canonical: ok');
