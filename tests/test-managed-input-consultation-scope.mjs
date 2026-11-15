#!/usr/bin/env node
// P3-T1: C1 Managed Scope 二态线谱 — consultation scope 受管会话。
//
// Consultation experts are still WORKER managed sessions (sessionPlane ===
// 'organization') but carry managedScope === 'consultation'. Their lineage is
// rootSessionId + consultationRoundId + expertAssignmentId + controllerSessionId
// (no Organization node/role/revision required), and their user-input bypass
// surfaces are still rejected while consultation-channel internalOperation
// injections are allowed.
//
// The main process runs with RAGENT_MANAGED_INPUT_ENFORCEMENT=1 so the gate
// rejection matrix is exercised in-process.
import assert from 'assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const tempHome = mkdtempSync(join(tmpdir(), 'ragent-managed-input-consult-'));

// Isolate config + session storage before importing anything that reads it.
process.env.HOME = tempHome;
delete process.env.RAGENT_CONFIG_DIR;
delete process.env.RAGENT_INSTANCE_ROOT;
delete process.env.RAGENT_WORK_ROOT_DIR;
delete process.env.RAGENT_MEMORY_DIR;
delete process.env.RAGENT_RUN_SPOOL_DIR;
delete process.env.RAGENT_ORG_SCHEMA_ENABLED;
delete process.env.RAGENT_ORG_SHADOW_PROJECTION;
// Main process: flag ON for the rejection matrix.
process.env.RAGENT_MANAGED_INPUT_ENFORCEMENT = '1';

const workspace = join(tempHome, 'workspace');
mkdirSync(workspace, { recursive: true });

const managedInput = await import('../chat/managed-input.mjs');
const sessionManager = await import('../chat/session-manager.mjs');
const { MANAGED_INPUT_ENFORCEMENT } = await import('../lib/config.mjs');

const { createSession, killAll } = sessionManager;

const {
  MANAGED_SCOPES,
  CONSULTATION_LINEAGE_INCOMPLETE,
  MANAGED_SESSION_LINEAGE_INCOMPLETE,
  MANAGED_SESSION_INPUT_BYPASS,
  normalizeManagedScope,
  resolveSessionClass,
  assertManagedSessionLineage,
  assertManagedInputAllowed,
  isManagedSession,
} = managedInput;

let assertionCount = 0;
const a = new Proxy(assert, {
  get(target, prop) {
    const value = target[prop];
    if (typeof value === 'function') {
      return (...args) => {
        assertionCount += 1;
        return value.apply(target, args);
      };
    }
    return value;
  },
});

function throwsCode(fn, code, statusCode, message) {
  assertionCount += 1;
  assert.throws(
    fn,
    (error) => error?.code === code && (statusCode === undefined || error?.statusCode === statusCode),
    message,
  );
}

try {
  // -------------------------------------------------------------------------
  // Exports: CONSULTATION_LINEAGE_INCOMPLETE + MANAGED_SCOPES
  // -------------------------------------------------------------------------
  a.equal(MANAGED_INPUT_ENFORCEMENT, true, 'main process runs with flag ON');
  a.equal(MANAGED_SCOPES.includes('organization'), true, 'MANAGED_SCOPES enumerates organization');
  a.equal(MANAGED_SCOPES.includes('consultation'), true, 'MANAGED_SCOPES enumerates consultation');
  a.equal(Object.isFrozen(MANAGED_SCOPES), true, 'MANAGED_SCOPES is frozen');
  a.equal(MANAGED_SCOPES.length, 2, 'MANAGED_SCOPES is exactly two-state');
  a.equal(CONSULTATION_LINEAGE_INCOMPLETE, 'CONSULTATION_LINEAGE_INCOMPLETE', 'CONSULTATION_LINEAGE_INCOMPLETE export');

  // -------------------------------------------------------------------------
  // normalizeManagedScope: two-state with organization fallback
  // -------------------------------------------------------------------------
  a.equal(normalizeManagedScope('consultation'), 'consultation', 'normalizeManagedScope consultation');
  a.equal(normalizeManagedScope('organization'), 'organization', 'normalizeManagedScope organization');
  a.equal(normalizeManagedScope('Consultation'), 'consultation', 'normalizeManagedScope case-normalizes');
  a.equal(normalizeManagedScope('  organization  '), 'organization', 'normalizeManagedScope trims');
  a.equal(normalizeManagedScope('bogus'), 'organization', 'invalid scope falls back to organization');
  a.equal(normalizeManagedScope(undefined), 'organization', 'missing scope falls back to organization');
  a.equal(normalizeManagedScope(null), 'organization', 'null scope falls back to organization');
  a.equal(normalizeManagedScope(''), 'organization', 'empty scope falls back to organization');

  // -------------------------------------------------------------------------
  // consultation WORKER: class + complete lineage
  // -------------------------------------------------------------------------
  const consultWorker = {
    id: 'consult-worker-1',
    sessionPlane: 'organization',
    sessionClass: 'WORKER',
    managedScope: 'consultation',
    rootSessionId: 'root-consult-1',
    consultationRoundId: 'round-1',
    expertAssignmentId: 'assign-1',
    controllerSessionId: 'controller-1',
  };
  a.equal(isManagedSession(consultWorker), true, 'consultation expert is a managed session (organization plane)');
  a.equal(resolveSessionClass(consultWorker), 'WORKER', 'consultation WORKER resolves to WORKER');
  a.equal(assertManagedSessionLineage(consultWorker), 'WORKER', 'complete consultation lineage passes');

  // organizationRootSessionId alias satisfies the root requirement.
  a.equal(
    assertManagedSessionLineage({ ...consultWorker, rootSessionId: undefined, organizationRootSessionId: 'root-consult-1' }),
    'WORKER',
    'consultation lineage accepts organizationRootSessionId alias',
  );

  // -------------------------------------------------------------------------
  // consultation WORKER: incomplete lineage -> CONSULTATION_LINEAGE_INCOMPLETE (409)
  // -------------------------------------------------------------------------
  throwsCode(
    () => assertManagedSessionLineage({ ...consultWorker, expertAssignmentId: undefined }),
    CONSULTATION_LINEAGE_INCOMPLETE, 409,
    'missing expertAssignmentId throws CONSULTATION_LINEAGE_INCOMPLETE',
  );
  throwsCode(
    () => assertManagedSessionLineage({ ...consultWorker, consultationRoundId: undefined }),
    CONSULTATION_LINEAGE_INCOMPLETE, 409,
    'missing consultationRoundId throws CONSULTATION_LINEAGE_INCOMPLETE',
  );
  throwsCode(
    () => assertManagedSessionLineage({ ...consultWorker, controllerSessionId: undefined }),
    CONSULTATION_LINEAGE_INCOMPLETE, 409,
    'missing controllerSessionId throws CONSULTATION_LINEAGE_INCOMPLETE',
  );
  throwsCode(
    () => assertManagedSessionLineage({ ...consultWorker, rootSessionId: undefined, organizationRootSessionId: undefined }),
    CONSULTATION_LINEAGE_INCOMPLETE, 409,
    'missing rootSessionId throws CONSULTATION_LINEAGE_INCOMPLETE',
  );
  throwsCode(
    () => assertManagedSessionLineage({ ...consultWorker, consultationRoundId: '   ' }),
    CONSULTATION_LINEAGE_INCOMPLETE, 409,
    'blank consultationRoundId throws CONSULTATION_LINEAGE_INCOMPLETE',
  );

  // Consultation lineage does NOT depend on Organization node/role/revision:
  // a consultation WORKER that has org lineage but lacks consultation lineage
  // still fails with the consultation error code.
  throwsCode(
    () => assertManagedSessionLineage({
      ...consultWorker,
      organizationNodeId: 'node-1',
      roleInstanceId: 'role-1',
      organizationRevision: 1,
      expertAssignmentId: undefined,
    }),
    CONSULTATION_LINEAGE_INCOMPLETE, 409,
    'org node/role/revision does not satisfy consultation lineage',
  );

  // -------------------------------------------------------------------------
  // organization scope WORKER regression: legacy lineage contract unchanged
  // -------------------------------------------------------------------------
  const orgWorker = {
    id: 'org-worker-1',
    sessionPlane: 'organization',
    sessionClass: 'WORKER',
    managedScope: 'organization',
    rootSessionId: 'root-org-1',
    organizationNodeId: 'node-1',
    roleInstanceId: 'role-1',
    organizationRevision: 1,
    controllerSessionId: 'controller-1',
  };
  a.equal(assertManagedSessionLineage(orgWorker), 'WORKER', 'organization WORKER lineage passes');
  throwsCode(
    () => assertManagedSessionLineage({ ...orgWorker, organizationNodeId: undefined }),
    MANAGED_SESSION_LINEAGE_INCOMPLETE, 409,
    'organization WORKER missing node still throws MANAGED_SESSION_LINEAGE_INCOMPLETE',
  );
  throwsCode(
    () => assertManagedSessionLineage({ ...orgWorker, roleInstanceId: undefined }),
    MANAGED_SESSION_LINEAGE_INCOMPLETE, 409,
    'organization WORKER missing role still throws MANAGED_SESSION_LINEAGE_INCOMPLETE',
  );
  throwsCode(
    () => assertManagedSessionLineage({ ...orgWorker, organizationRevision: undefined }),
    MANAGED_SESSION_LINEAGE_INCOMPLETE, 409,
    'organization WORKER missing revision still throws MANAGED_SESSION_LINEAGE_INCOMPLETE',
  );

  // Backward compatibility: a managed session with NO managedScope field
  // defaults to organization scope, so legacy org lineage validation is intact.
  a.equal(
    assertManagedSessionLineage({ ...orgWorker, managedScope: undefined }),
    'WORKER',
    'missing managedScope defaults to organization scope',
  );
  throwsCode(
    () => assertManagedSessionLineage({ ...orgWorker, managedScope: undefined, organizationNodeId: undefined }),
    MANAGED_SESSION_LINEAGE_INCOMPLETE, 409,
    'missing managedScope keeps legacy org lineage validation',
  );

  // -------------------------------------------------------------------------
  // User direct input to a consultation session is rejected (gate covers it)
  // -------------------------------------------------------------------------
  for (const op of ['fork', 'fork-at', 'delegate', 'session-spawn', 'message', 'continuation']) {
    throwsCode(
      () => assertManagedInputAllowed({ session: consultWorker, operation: op }),
      MANAGED_SESSION_INPUT_BYPASS, 409,
      `user ${op} to consultation session rejected with MANAGED_SESSION_INPUT_BYPASS`,
    );
  }

  // An owner-scoped request context is NOT a consultation channel: still rejected.
  throwsCode(
    () => assertManagedInputAllowed({ session: consultWorker, operation: 'message', requestContext: { role: 'owner' } }),
    MANAGED_SESSION_INPUT_BYPASS, 409,
    'owner-scoped context does not bypass the consultation gate',
  );

  // A collaboration marker is NOT a consultation channel marker: rejected for
  // consultation-scope sessions (strict controlled channel).
  throwsCode(
    () => assertManagedInputAllowed({ session: consultWorker, operation: 'message', requestContext: { internalOperation: 'collaboration_task' } }),
    MANAGED_SESSION_INPUT_BYPASS, 409,
    'collaboration_task is rejected for consultation-scope session',
  );

  // -------------------------------------------------------------------------
  // Consultation controlled-channel internalOperation is the one exemption
  // -------------------------------------------------------------------------
  a.doesNotThrow(
    () => assertManagedInputAllowed({ session: consultWorker, operation: 'message', requestContext: { internalOperation: 'consultation_task' } }),
    'consultation_task message injection passes',
  );
  a.doesNotThrow(
    () => assertManagedInputAllowed({ session: consultWorker, operation: 'continuation', requestContext: { internalOperation: 'consultation_resume' } }),
    'consultation_resume continuation injection passes',
  );

  // Organization scope keeps the legacy collaboration exemption (no regression).
  a.doesNotThrow(
    () => assertManagedInputAllowed({ session: orgWorker, operation: 'message', requestContext: { internalOperation: 'collaboration_task' } }),
    'organization scope still accepts collaboration_task',
  );
  a.doesNotThrow(
    () => assertManagedInputAllowed({ session: orgWorker, operation: 'continuation', requestContext: { internalOperation: 'collaboration_resume' } }),
    'organization scope still accepts collaboration_resume',
  );

  // -------------------------------------------------------------------------
  // Function-level: session-manager createSession enforces consultation lineage
  // -------------------------------------------------------------------------
  const root = await createSession(workspace, 'claude', 'consult-root', {});
  a.ok(root?.id, 'root session created');

  const consultManaged = await createSession(workspace, 'claude', 'consult-worker', {
    sessionPlane: 'organization',
    sessionClass: 'WORKER',
    managedScope: 'consultation',
    rootSessionId: root.id,
    consultationRoundId: 'round-1',
    expertAssignmentId: 'assign-1',
    controllerSessionId: root.id,
  });
  a.ok(consultManaged?.id, 'consultation WORKER session created');
  a.equal(consultManaged.sessionPlane, 'organization', 'consultation WORKER stays on the managed plane');
  a.equal(consultManaged.sessionClass, 'WORKER', 'consultation WORKER class persists');

  await a.rejects(
    () => createSession(workspace, 'claude', 'bad-consult-worker', {
      sessionPlane: 'organization',
      sessionClass: 'WORKER',
      managedScope: 'consultation',
      rootSessionId: root.id,
      consultationRoundId: 'round-2',
      controllerSessionId: root.id,
    }),
    (error) => error?.code === CONSULTATION_LINEAGE_INCOMPLETE && error?.statusCode === 409,
    'createSession rejects incomplete consultation lineage',
  );

  console.log(`test-managed-input-consultation-scope: ok (${assertionCount} assertions)`);
} finally {
  killAll();
  rmSync(tempHome, { recursive: true, force: true });
}
