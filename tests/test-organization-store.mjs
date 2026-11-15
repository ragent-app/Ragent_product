#!/usr/bin/env node
import assert from 'assert/strict';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// Isolate config + session storage before importing anything that reads it
// (matches tests/test-collaboration-store.mjs style with a throwaway dir).
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tempHome = mkdtempSync(join(tmpdir(), 'ragent-org-store-'));
const probeHome = mkdtempSync(join(tmpdir(), 'ragent-org-probe-'));
const shadowChildHome = mkdtempSync(join(tmpdir(), 'ragent-org-shadow-child-'));
process.env.HOME = tempHome;
// Keep the feature flags deterministically off for the main process so the
// "flag off -> projection null" path is exercised without ambient env noise.
delete process.env.RAGENT_ORG_SCHEMA_ENABLED;
delete process.env.RAGENT_ORG_SHADOW_PROJECTION;
delete process.env.RAGENT_CONFIG_DIR;

const workspace = join(tempHome, 'workspace');
mkdirSync(workspace, { recursive: true });

const store = await import('../chat/organization-store.mjs');
const collabStore = await import('../chat/collaboration-store.mjs');
const sessionManager = await import('../chat/session-manager.mjs');
const { ORG_SCHEMA_ENABLED, ORG_SHADOW_PROJECTION } = await import('../lib/config.mjs');

const { createSession, getSession, killAll } = sessionManager;

const configModuleUrl = new URL('../lib/config.mjs', import.meta.url).href;
const orgStoreUrl = new URL('../chat/organization-store.mjs', import.meta.url).href;

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

function childEnv(home, overrides = {}) {
  const env = { ...process.env, HOME: home };
  for (const key of [
    'RAGENT_CONFIG_DIR',
    'RAGENT_INSTANCE_ROOT',
    'RAGENT_WORK_ROOT_DIR',
    'RAGENT_MEMORY_DIR',
    'RAGENT_RUN_SPOOL_DIR',
    'RAGENT_ORG_SCHEMA_ENABLED',
    'RAGENT_ORG_SHADOW_PROJECTION',
  ]) {
    delete env[key];
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined || value === null) delete env[key];
    else env[key] = value;
  }
  return env;
}

function probeFlags(overrides = {}) {
  const script = [
    `import { ORG_SCHEMA_ENABLED, ORG_SHADOW_PROJECTION } from ${JSON.stringify(configModuleUrl)};`,
    `console.log('FLAGS=' + JSON.stringify({ ORG_SCHEMA_ENABLED, ORG_SHADOW_PROJECTION }));`,
  ].join('\n');
  const out = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
    env: childEnv(probeHome, overrides),
    encoding: 'utf8',
  });
  const line = out.trim().split('\n').filter((l) => l.startsWith('FLAGS=')).pop();
  return JSON.parse(line.slice('FLAGS='.length));
}

// ---------------------------------------------------------------------------
// Schema + migration idempotency
// ---------------------------------------------------------------------------

async function testSchemaIdempotent() {
  const firstInit = await store.initializeOrganizationStore();
  const secondInit = await store.initializeOrganizationStore();
  a.equal(firstInit, secondInit, 'initializeOrganizationStore is idempotent');

  // The org tables live in the same Collaboration SQLite file: collaboration
  // records still work after org schema init and vice versa.
  await collabStore.initializeCollaborationStore();
  const collab = await collabStore.createCollaborationRecord({
    rootSessionId: 'root-coexist',
    title: 'coexist',
    policy: { role: 'manager' },
    plan: { version: 1, tasks: [] },
  });
  a.ok(collab?.id, 'collaboration store keeps working alongside org tables');

  const org = await store.createOrganization({ rootSessionId: 'root-schema', projectId: 'prj-schema' });
  a.ok(org?.id, 'organization store works alongside collaboration tables');

  // Re-running init after data exists is a no-op (idempotent additive).
  await store.initializeOrganizationStore();
  const still = await store.getOrganization(org.id);
  a.ok(still, 'store still usable after re-init');
  const collabAgain = await collabStore.getCollaboration(collab.id);
  a.equal(collabAgain.id, collab.id, 'collaboration record survives org re-init');
}

async function testOrganizationCrud() {
  const org = await store.createOrganization({
    rootSessionId: 'root-crud',
    projectId: 'prj-crud',
    state: 'active',
    policy: { role: 'manager' },
    budget: { nodes: 3 },
  });
  a.ok(org?.id, 'createOrganization returns an id');
  a.equal(org.rootSessionId, 'root-crud');
  a.equal(org.projectId, 'prj-crud');
  a.equal(org.state, 'active');
  a.equal(org.currentRevision, 0);
  a.equal(org.progressEpoch, 0);
  a.equal(org.version, 1);
  a.deepEqual(org.policy, { role: 'manager' });
  a.deepEqual(org.budget, { nodes: 3 });
  a.ok(org.createdAt, 'createdAt is set');
  a.ok(org.updatedAt, 'updatedAt is set');

  const got = await store.getOrganization(org.id);
  a.equal(got.id, org.id, 'getOrganization returns the record');

  // Same root session must not create a second organization.
  await a.rejects(
    () => store.createOrganization({ rootSessionId: 'root-crud' }),
    (err) => err?.code === 'ORGANIZATION_ROOT_SESSION_CONFLICT',
  );

  const updated = await store.updateOrganizationVersion(org.id, {
    state: 'frozen',
    currentRevision: 2,
    progressEpoch: 1,
    version: 3,
  });
  a.equal(updated.state, 'frozen');
  a.equal(updated.currentRevision, 2);
  a.equal(updated.progressEpoch, 1);
  a.equal(updated.version, 3);

  a.equal(await store.updateOrganizationVersion('org-missing', { version: 2 }), null, 'update on missing org returns null');

  const listed = await store.listOrganizations({ projectId: 'prj-crud' });
  a.ok(listed.some((o) => o.id === org.id), 'listOrganizations filters by project');
  const all = await store.listOrganizations();
  a.ok(all.some((o) => o.id === org.id), 'listOrganizations returns all orgs');
}

// ---------------------------------------------------------------------------
// Revisions
// ---------------------------------------------------------------------------

async function testRevisionLifecycle() {
  const org = await store.createOrganization({ rootSessionId: 'root-rev' });

  const r1 = await store.createRevision(org.id, { revision: 1, proposal: { title: 'v1' }, state: 'draft' });
  a.equal(r1.state, 'draft');
  a.deepEqual(r1.proposal, { title: 'v1' });
  a.equal(r1.organizationId, org.id);
  a.equal(r1.revision, 1);

  // Draft re-upload is allowed (compiler fills compiled/digest before freeze).
  const r1b = await store.createRevision(org.id, { revision: 1, proposal: { title: 'v1.1' }, digest: 'sha-abc' });
  a.deepEqual(r1b.proposal, { title: 'v1.1' });
  a.equal(r1b.digest, 'sha-abc');

  const frozen = await store.freezeRevision(org.id, 1);
  a.equal(frozen.state, 'frozen');

  // A frozen revision must reject any later modification.
  await a.rejects(
    () => store.createRevision(org.id, { revision: 1, proposal: { title: 'v2' } }),
    (err) => err?.code === 'REVISION_FROZEN',
  );

  // A higher revision is still allowed (constitution §2.13).
  const r2 = await store.createRevision(org.id, { revision: 2, proposal: { title: 'v2' }, digest: 'sha-def' });
  a.equal(r2.revision, 2);
  a.equal(r2.state, 'draft');

  const got = await store.getRevision(org.id, 1);
  a.equal(got.state, 'frozen');
  a.equal(await store.getRevision(org.id, 99), null, 'missing revision returns null');

  const all = await store.listRevisions(org.id);
  a.equal(all.length, 2, 'listRevisions returns both revisions');
  a.deepEqual(all.map((r) => r.revision), [1, 2], 'revisions ordered by revision number');

  // Freeze is idempotent; freezing a missing revision returns null.
  a.equal((await store.freezeRevision(org.id, 1)).state, 'frozen');
  a.equal(await store.freezeRevision(org.id, 99), null);

  // Unknown organization is rejected with the stable code.
  await a.rejects(
    () => store.createRevision('org-missing', { revision: 1, proposal: {} }),
    (err) => err?.code === 'ORGANIZATION_NOT_FOUND',
  );
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

async function testNodeLifecycle() {
  const org = await store.createOrganization({ rootSessionId: 'root-node' });

  const node = await store.createNode({
    organizationId: org.id,
    stableKey: 'manager-1',
    nodeRole: 'manager',
    createdRevision: 1,
    grant: { files: ['**'] },
  });
  a.ok(node?.id, 'createNode returns an id');
  a.equal(node.stableKey, 'manager-1');
  a.equal(node.nodeRole, 'manager');
  a.equal(node.createdRevision, 1);
  a.equal(node.lifecycleState, 'active');
  a.equal(node.version, 1);
  a.deepEqual(node.grant, { files: ['**'] });

  const got = await store.getNode(node.id);
  a.equal(got.stableKey, 'manager-1', 'getNode returns the node');

  // stable_key is unique per organization.
  await a.rejects(
    () => store.createNode({ organizationId: org.id, stableKey: 'manager-1', nodeRole: 'manager', createdRevision: 1 }),
    (err) => err?.code === 'ORGANIZATION_NODE_STABLE_KEY_CONFLICT',
  );

  const retired = await store.retireNode(node.id, { retiredRevision: 2 });
  a.equal(retired.lifecycleState, 'retired');
  a.equal(retired.retiredRevision, 2);
  a.equal(retired.version, 2, 'retire bumps the node version');

  const retiredAgain = await store.retireNode(node.id, { retiredRevision: 2 });
  a.equal(retiredAgain.lifecycleState, 'retired', 'retiring an already-retired node is idempotent');

  a.equal(await store.retireNode('node-missing'), null, 'retiring a missing node returns null');
  a.equal(await store.getNode('node-missing'), null, 'missing node returns null');

  await a.rejects(
    () => store.createNode({ organizationId: 'org-missing', stableKey: 'x', nodeRole: 'manager', createdRevision: 1 }),
    (err) => err?.code === 'ORGANIZATION_NOT_FOUND',
  );
}

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

async function testGrants() {
  const org = await store.createOrganization({ rootSessionId: 'root-grant' });
  const node = await store.createNode({ organizationId: org.id, stableKey: 'g-node', nodeRole: 'manager', createdRevision: 1 });
  const node2 = await store.createNode({ organizationId: org.id, stableKey: 'g-node-2', nodeRole: 'reviewer', createdRevision: 1 });

  const g1 = await store.createGrant({
    organizationId: org.id,
    nodeId: node.id,
    revision: 1,
    capability: 'read',
    allow: true,
    scope: { paths: ['/a'] },
  });
  a.ok(g1?.id, 'createGrant returns an id');
  a.equal(g1.allow, true);
  a.deepEqual(g1.scope, { paths: ['/a'] });
  a.equal(g1.revision, 1);

  await store.createGrant({ organizationId: org.id, nodeId: node.id, revision: 2, capability: 'write', allow: true });
  await store.createGrant({ organizationId: org.id, nodeId: node.id, revision: 3, capability: 'read', allow: false });

  // Grants accumulate by (node, revision): effective at revision R means every
  // grant recorded at revision <= R.
  a.deepEqual(
    (await store.effectiveGrantsForNode(node.id, 1)).map((g) => g.capability),
    ['read'],
    'grants effective at revision 1',
  );
  a.deepEqual(
    (await store.effectiveGrantsForNode(node.id, 2)).map((g) => g.capability),
    ['read', 'write'],
    'grants effective at revision 2 accumulate',
  );
  const atRev3 = await store.effectiveGrantsForNode(node.id, 3);
  a.equal(atRev3.length, 3, 'grants effective at revision 3');
  a.equal(atRev3.find((g) => g.capability === 'read' && g.revision === 3).allow, false, 'revoke row carries allow=false');

  a.deepEqual(await store.effectiveGrantsForNode(node2.id, 3), [], 'grants are node-scoped');

  await a.rejects(
    () => store.createGrant({ organizationId: org.id, nodeId: 'node-elsewhere', revision: 1, capability: 'read' }),
    (err) => err?.code === 'ORGANIZATION_NODE_NOT_FOUND',
  );
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

async function testGates() {
  const org = await store.createOrganization({ rootSessionId: 'root-gate' });

  const g1 = await store.advanceGateGeneration(org.id, 'phase-1', {
    fromGeneration: 0,
    state: 'decided',
    decision: { pass: true },
    decidedByNodeId: 'node-x',
    packetId: 'rsp_1',
  });
  a.equal(g1.generation, 1, 'first gate advances to generation 1');
  a.equal(g1.state, 'decided');
  a.deepEqual(g1.decision, { pass: true });
  a.equal(g1.decidedByNodeId, 'node-x');
  a.equal(g1.packetId, 'rsp_1');

  // CAS conflict: current generation is 1, expected 0.
  await a.rejects(
    () => store.advanceGateGeneration(org.id, 'phase-1', { fromGeneration: 0 }),
    (err) => err?.code === 'GATE_STALE_GENERATION',
  );

  const g2 = await store.advanceGateGeneration(org.id, 'phase-1', { fromGeneration: 1, decision: { pass: false }, packetId: 'rsp_2' });
  a.equal(g2.generation, 2, 'second gate advances to generation 2');

  const latest = await store.getGate(org.id, 'phase-1');
  a.equal(latest.generation, 2, 'getGate without generation returns the latest');
  a.equal((await store.getGate(org.id, 'phase-1', 1)).generation, 1, 'getGate with a generation returns that gate');
  a.equal(await store.getGate(org.id, 'phase-1', 99), null, 'missing gate generation returns null');

  // Direct createGate is also available for pre-seeded gates.
  const explicit = await store.createGate({ organizationId: org.id, phaseId: 'phase-2', generation: 1, state: 'open' });
  a.equal(explicit.generation, 1);
  a.equal(explicit.state, 'open');
}

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

async function testEnvelopes() {
  const org = await store.createOrganization({ rootSessionId: 'root-env' });

  const env = await store.createEnvelope({
    organizationId: org.id,
    nodeId: 'node-1',
    revision: 1,
    phaseId: 'phase-1',
    attemptId: 'attempt-1',
    packetId: 'rsp_env',
    agentReport: { summary: 'done', risks: [] },
  });
  a.ok(env?.id, 'createEnvelope returns an id');
  a.equal(env.revision, 1);
  a.equal(env.packetId, 'rsp_env');
  a.equal(env.attemptId, 'attempt-1');
  a.deepEqual(env.agentReport, { summary: 'done', risks: [] });

  const got = await store.getEnvelope(env.id);
  a.equal(got.id, env.id, 'getEnvelope returns the envelope');
  a.equal(await store.getEnvelope('env-missing'), null, 'missing envelope returns null');
}

// ---------------------------------------------------------------------------
// Session plane + organization root session id
// ---------------------------------------------------------------------------

async function testSessionPlane() {
  const folder = workspace;

  const s1 = await createSession(folder, 'codex', 'plane default');
  a.equal(s1.sessionPlane, 'user', 'default sessionPlane is user');
  a.equal(s1.organizationRootSessionId, undefined, 'no organizationRootSessionId by default');

  const rt1 = await getSession(s1.id);
  a.equal(rt1.sessionPlane, 'user', 'default sessionPlane round-trips');
  a.equal(rt1.organizationRootSessionId, undefined, 'no org root round-trips');

  const s2 = await createSession(folder, 'codex', 'plane org', { sessionPlane: 'organization', organizationRootSessionId: 'root-org-1' });
  a.equal(s2.sessionPlane, 'organization', 'explicit organization plane is set');
  a.equal(s2.organizationRootSessionId, 'root-org-1', 'organizationRootSessionId is set');

  const rt2 = await getSession(s2.id);
  a.equal(rt2.sessionPlane, 'organization', 'organization plane round-trips');
  a.equal(rt2.organizationRootSessionId, 'root-org-1', 'organizationRootSessionId round-trips');

  const s3 = await createSession(folder, 'codex', 'plane system', { sessionPlane: 'system' });
  a.equal(s3.sessionPlane, 'system', 'system plane is accepted');

  const s4 = await createSession(folder, 'codex', 'plane org upper', { sessionPlane: 'Organization' });
  a.equal(s4.sessionPlane, 'organization', 'sessionPlane is case-normalized');

  const s5 = await createSession(folder, 'codex', 'plane empty', { sessionPlane: '' });
  a.equal(s5.sessionPlane, 'user', 'empty sessionPlane falls back to user');

  // Empty org root is not persisted.
  const s6 = await createSession(folder, 'codex', 'no org root', { sessionPlane: 'organization', organizationRootSessionId: '' });
  a.equal(s6.organizationRootSessionId, undefined, 'empty organizationRootSessionId is not persisted');

  // Illegal planes are rejected.
  await a.rejects(
    () => createSession(folder, 'codex', 'plane illegal', { sessionPlane: 'admin' }),
    (err) => err?.code === 'INVALID_SESSION_PLANE',
  );
  await a.rejects(
    () => createSession(folder, 'codex', 'plane bad', { sessionPlane: 'root' }),
    (err) => err?.code === 'INVALID_SESSION_PLANE',
  );
  await a.rejects(
    () => createSession(folder, 'codex', 'plane numeric', { sessionPlane: 42 }),
    (err) => err?.code === 'INVALID_SESSION_PLANE',
  );
}

// ---------------------------------------------------------------------------
// Feature flags (envFlagEnabled semantics)
// ---------------------------------------------------------------------------

async function testFlagParsing() {
  // In the main process the flags default off.
  a.equal(ORG_SCHEMA_ENABLED, false, 'ORG_SCHEMA_ENABLED defaults to false in-process');
  a.equal(ORG_SHADOW_PROJECTION, false, 'ORG_SHADOW_PROJECTION defaults to false in-process');

  const unset = probeFlags({});
  a.equal(unset.ORG_SCHEMA_ENABLED, false, 'unset RAGENT_ORG_SCHEMA_ENABLED -> false');
  a.equal(unset.ORG_SHADOW_PROJECTION, false, 'unset RAGENT_ORG_SHADOW_PROJECTION -> false');

  a.equal(probeFlags({ RAGENT_ORG_SCHEMA_ENABLED: '1' }).ORG_SCHEMA_ENABLED, true, 'flag=1 enables');
  a.equal(probeFlags({ RAGENT_ORG_SCHEMA_ENABLED: '0' }).ORG_SCHEMA_ENABLED, false, 'flag=0 disables');
  a.equal(probeFlags({ RAGENT_ORG_SCHEMA_ENABLED: 'true' }).ORG_SCHEMA_ENABLED, true, 'flag=true enables');
  a.equal(probeFlags({ RAGENT_ORG_SCHEMA_ENABLED: 'false' }).ORG_SCHEMA_ENABLED, false, 'flag=false disables');
  a.equal(probeFlags({ RAGENT_ORG_SCHEMA_ENABLED: 'off' }).ORG_SCHEMA_ENABLED, false, 'flag=off disables');
  a.equal(probeFlags({ RAGENT_ORG_SCHEMA_ENABLED: 'no' }).ORG_SCHEMA_ENABLED, false, 'flag=no disables');
  a.equal(probeFlags({ RAGENT_ORG_SCHEMA_ENABLED: 'TRUE' }).ORG_SCHEMA_ENABLED, true, 'flag is case-insensitive');
  a.equal(probeFlags({ RAGENT_ORG_SCHEMA_ENABLED: 'yes' }).ORG_SCHEMA_ENABLED, true, 'flag=yes enables');
  a.equal(probeFlags({ RAGENT_ORG_SCHEMA_ENABLED: ' ' }).ORG_SCHEMA_ENABLED, false, 'blank flag falls back to default');

  a.equal(probeFlags({ RAGENT_ORG_SHADOW_PROJECTION: '1' }).ORG_SHADOW_PROJECTION, true, 'shadow flag=1 enables');
  a.equal(probeFlags({ RAGENT_ORG_SHADOW_PROJECTION: '0' }).ORG_SHADOW_PROJECTION, false, 'shadow flag=0 disables');
  a.equal(probeFlags({ RAGENT_ORG_SHADOW_PROJECTION: 'false' }).ORG_SHADOW_PROJECTION, false, 'shadow flag=false disables');
}

// ---------------------------------------------------------------------------
// Shadow projection (gated by ORG_SHADOW_PROJECTION)
// ---------------------------------------------------------------------------

async function testShadowProjection() {
  // Flag off (main process): projection must be null.
  const org = await store.createOrganization({ rootSessionId: 'root-shadow-off' });
  await store.createRevision(org.id, { revision: 1, proposal: { title: 'v1' }, digest: 'sha-1' });
  await store.freezeRevision(org.id, 1);
  await store.updateOrganizationVersion(org.id, { currentRevision: 1 });
  await store.createNode({ organizationId: org.id, stableKey: 'mgr-off', nodeRole: 'manager', createdRevision: 1 });
  a.equal(await store.projectOrganizationShadow(org.id), null, 'shadow projection is null when the flag is off');

  // Flag on (child process): projection is a read-only summary.
  const script = [
    `import { createOrganization, createRevision, createNode, freezeRevision, updateOrganizationVersion, projectOrganizationShadow } from ${JSON.stringify(orgStoreUrl)};`,
    `const org = await createOrganization({ rootSessionId: 'root-shadow-on', projectId: 'prj-shadow', state: 'active', policy: { role: 'manager' }, budget: { nodes: 5 } });`,
    `await createRevision(org.id, { revision: 1, proposal: { title: 'v1' }, digest: 'sha-1' });`,
    `await freezeRevision(org.id, 1);`,
    `await updateOrganizationVersion(org.id, { currentRevision: 1 });`,
    `await createNode({ organizationId: org.id, stableKey: 'mgr', nodeRole: 'manager', createdRevision: 1 });`,
    `await createNode({ organizationId: org.id, stableKey: 'rev', nodeRole: 'reviewer', createdRevision: 1 });`,
    `const shadow = await projectOrganizationShadow(org.id);`,
    `console.log('SHADOW=' + JSON.stringify(shadow));`,
  ].join('\n');
  const out = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
    env: childEnv(shadowChildHome, { RAGENT_ORG_SHADOW_PROJECTION: '1' }),
    encoding: 'utf8',
  });
  const line = out.trim().split('\n').filter((l) => l.startsWith('SHADOW=')).pop();
  a.ok(line, 'child produced a shadow projection line');
  const shadow = JSON.parse(line.slice('SHADOW='.length));
  a.ok(shadow, 'shadow projection is non-null when the flag is on');
  a.ok(shadow.organizationId && shadow.organizationId.startsWith('org_'), 'shadow carries the organization id');
  a.equal(shadow.projectId, 'prj-shadow');
  a.equal(shadow.rootSessionId, 'root-shadow-on');
  a.equal(shadow.state, 'active');
  a.equal(shadow.currentRevision, 1, 'shadow carries currentRevision');
  a.ok(shadow.revision, 'shadow carries the current revision');
  a.equal(shadow.revision.revision, 1);
  a.equal(shadow.revision.state, 'frozen');
  a.equal(shadow.revision.digest, 'sha-1');
  a.equal(shadow.nodes.length, 2, 'shadow carries the node roster');
  a.deepEqual(shadow.nodes.map((n) => n.nodeRole).sort(), ['manager', 'reviewer']);
}

try {
  await store.initializeOrganizationStore();
  await testSchemaIdempotent();
  await testOrganizationCrud();
  await testRevisionLifecycle();
  await testNodeLifecycle();
  await testGrants();
  await testGates();
  await testEnvelopes();
  await testSessionPlane();
  await testFlagParsing();
  await testShadowProjection();
  console.log(`test-organization-store: ok (${assertionCount} assertions)`);
} finally {
  killAll();
  rmSync(probeHome, { recursive: true, force: true });
  rmSync(shadowChildHome, { recursive: true, force: true });
  rmSync(tempHome, { recursive: true, force: true });
}
