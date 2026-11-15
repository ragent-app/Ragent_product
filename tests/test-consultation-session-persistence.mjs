#!/usr/bin/env node
// P4-T1a: consultation managed-session persistence.
//
// Known gap fixed by this work card: applySessionContractFields only persisted
// the org-managed fields (organizationRootSessionId/organizationId/
// organizationNodeId/roleInstanceId/controllerSessionId/parentSessionId/
// organizationRevision/depth/inputPolicy) and dropped managedScope /
// consultationRoundId / expertAssignmentId, so a consultation managed session
// created via createSession lost those fields on reload and both
// assertManagedSessionLineage (C1 consultation branch) and the consultation
// channel judgment in assertManagedInputAllowed broke.
//
// This test creates a consultation WORKER through createSession, reloads it via
// getSession, and asserts the four consultation lineage fields survive. It also
// covers the org scope regression (a managed session without managedScope
// defaults to 'organization' and keeps the legacy org lineage validation) and
// smoke-tests the new createManagedSessionForConsultation factory.
import assert from 'assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const tempHome = mkdtempSync(join(tmpdir(), 'ragent-consult-session-persist-'));

// Isolate config + session storage before importing anything that reads it.
process.env.HOME = tempHome;
process.env.RAGENT_CONFIG_DIR = join(tempHome, 'config');
delete process.env.RAGENT_INSTANCE_ROOT;
delete process.env.RAGENT_WORK_ROOT_DIR;
delete process.env.RAGENT_MEMORY_DIR;
delete process.env.RAGENT_RUN_SPOOL_DIR;
delete process.env.RAGENT_ORG_SCHEMA_ENABLED;
delete process.env.RAGENT_ORG_SHADOW_PROJECTION;
delete process.env.RAGENT_MANAGED_INPUT_ENFORCEMENT;

const workspace = join(tempHome, 'workspace');
mkdirSync(workspace, { recursive: true });

const sessionManager = await import('../chat/session-manager.mjs');
const managedInput = await import('../chat/managed-input.mjs');
const factory = await import('../chat/organization-managed-session-factory.mjs');

const { createSession, getSession, killAll } = sessionManager;
const {
  assertManagedSessionLineage,
  normalizeManagedScope,
  CONSULTATION_LINEAGE_INCOMPLETE,
  MANAGED_SESSION_LINEAGE_INCOMPLETE,
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
  // normalizeManagedScope sanity (import surface)
  // -------------------------------------------------------------------------
  a.equal(normalizeManagedScope('consultation'), 'consultation', 'normalizeManagedScope consultation');
  a.equal(normalizeManagedScope(undefined), 'organization', 'normalizeManagedScope defaults to organization');
  a.equal(normalizeManagedScope('bogus'), 'organization', 'invalid scope falls back to organization');

  // -------------------------------------------------------------------------
  // Consultation WORKER session: managedScope + consultation lineage persist
  // -------------------------------------------------------------------------
  const root = await createSession(workspace, 'claude', 'consult-root', {});
  a.ok(root?.id, 'root session created');

  const consult = await createSession(workspace, 'claude', 'consult-worker', {
    sessionPlane: 'organization',
    sessionClass: 'WORKER',
    managedScope: 'consultation',
    rootSessionId: root.id,
    consultationRoundId: 'round-persist-1',
    expertAssignmentId: 'assign-persist-1',
    controllerSessionId: root.id,
  });
  a.ok(consult?.id, 'consultation WORKER session created');

  const reloaded = await getSession(consult.id);
  a.ok(reloaded, 'consultation session reloaded');
  a.equal(reloaded.sessionPlane, 'organization', 'consultation WORKER stays on the managed plane');
  a.equal(reloaded.sessionClass, 'WORKER', 'consultation WORKER class persists');
  a.equal(reloaded.managedScope, 'consultation', 'managedScope=consultation persists after reload');
  a.equal(reloaded.consultationRoundId, 'round-persist-1', 'consultationRoundId persists after reload');
  a.equal(reloaded.expertAssignmentId, 'assign-persist-1', 'expertAssignmentId persists after reload');
  a.equal(reloaded.controllerSessionId, root.id, 'controllerSessionId persists after reload');

  // assertManagedSessionLineage on the reloaded consultation session passes.
  a.equal(assertManagedSessionLineage(reloaded), 'WORKER', 'reloaded consultation lineage passes');

  // createSession rejects incomplete consultation lineage (missing expertAssignmentId).
  await a.rejects(
    () => createSession(workspace, 'claude', 'bad-consult-worker', {
      sessionPlane: 'organization',
      sessionClass: 'WORKER',
      managedScope: 'consultation',
      rootSessionId: root.id,
      consultationRoundId: 'round-persist-2',
      controllerSessionId: root.id,
    }),
    (error) => error?.code === CONSULTATION_LINEAGE_INCOMPLETE && error?.statusCode === 409,
    'createSession rejects missing expertAssignmentId',
  );
  throwsCode(
    () => assertManagedSessionLineage({ ...reloaded, expertAssignmentId: undefined }),
    CONSULTATION_LINEAGE_INCOMPLETE, 409,
    'assertManagedSessionLineage throws CONSULTATION_LINEAGE_INCOMPLETE when expertAssignmentId is missing',
  );

  // -------------------------------------------------------------------------
  // Org scope regression: managed session without managedScope defaults to
  // 'organization' and keeps the legacy org lineage validation.
  // -------------------------------------------------------------------------
  const orgWorker = await createSession(workspace, 'claude', 'org-worker', {
    sessionPlane: 'organization',
    sessionClass: 'WORKER',
    rootSessionId: root.id,
    organizationNodeId: 'node-persist-1',
    roleInstanceId: 'role-persist-1',
    organizationRevision: 1,
    controllerSessionId: root.id,
  });
  a.ok(orgWorker?.id, 'org WORKER session created');
  const orgReloaded = await getSession(orgWorker.id);
  a.equal(orgReloaded.managedScope, 'organization', 'missing managedScope defaults to organization and persists');
  a.equal(assertManagedSessionLineage(orgReloaded), 'WORKER', 'complete org lineage passes');
  throwsCode(
    () => assertManagedSessionLineage({ ...orgReloaded, organizationNodeId: undefined }),
    MANAGED_SESSION_LINEAGE_INCOMPLETE, 409,
    'org session missing node throws MANAGED_SESSION_LINEAGE_INCOMPLETE',
  );

  // -------------------------------------------------------------------------
  // createManagedSessionForConsultation factory smoke test
  // -------------------------------------------------------------------------
  const consultFactory = await factory.createManagedSessionForConsultation({
    rootSessionId: root.id,
    consultationRoundId: 'round-factory-1',
    expertAssignmentId: 'assign-factory-1',
    controllerSessionId: root.id,
    role: 'expert',
    agentId: 'chat',
    sessionClass: 'WORKER',
    name: 'Consultation Expert Factory',
  });
  a.ok(consultFactory?.sessionId, 'factory returns a sessionId');
  const factoryReloaded = await getSession(consultFactory.sessionId);
  a.equal(factoryReloaded.managedScope, 'consultation', 'factory session managedScope persists');
  a.equal(factoryReloaded.consultationRoundId, 'round-factory-1', 'factory session consultationRoundId persists');
  a.equal(factoryReloaded.expertAssignmentId, 'assign-factory-1', 'factory session expertAssignmentId persists');
  a.equal(factoryReloaded.controllerSessionId, root.id, 'factory session controllerSessionId persists');
  a.equal(assertManagedSessionLineage(factoryReloaded), 'WORKER', 'factory session consultation lineage passes');

  // Factory fail-closed: missing lineage field -> CONSULTATION_LINEAGE_INCOMPLETE (409).
  await a.rejects(
    () => factory.createManagedSessionForConsultation({
      rootSessionId: root.id,
      consultationRoundId: 'round-factory-2',
      controllerSessionId: root.id,
      agentId: 'chat',
    }),
    (error) => error?.code === CONSULTATION_LINEAGE_INCOMPLETE && error?.statusCode === 409,
    'factory rejects missing expertAssignmentId',
  );

  // Factory fail-closed: Agent without a provider tool (aligned with
  // createManagedSessionForNode).
  await a.rejects(
    () => factory.createManagedSessionForConsultation({
      rootSessionId: root.id,
      consultationRoundId: 'round-factory-3',
      expertAssignmentId: 'assign-factory-3',
      controllerSessionId: root.id,
      agentId: 'no-such-agent',
    }),
    (error) => error?.code === 'ORG_PROVISIONING_AGENT_TOOL_MISSING' && error?.statusCode === 503,
    'factory fails closed when the Agent has no provider tool',
  );

  console.log(`test-consultation-session-persistence: ok (${assertionCount} assertions)`);
} finally {
  killAll();
  rmSync(tempHome, { recursive: true, force: true });
}
