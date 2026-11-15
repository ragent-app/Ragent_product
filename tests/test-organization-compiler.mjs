#!/usr/bin/env node
import assert from 'assert/strict';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// Isolate config + session storage before importing anything that reads it
// (matches tests/test-organization-store.mjs style with a throwaway dir). The
// command layer is gated on ORG_SCHEMA_ENABLED, so the main process turns the
// flag on for the command tests; the "flag off -> unavailable" path is probed
// in a child process.
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tempHome = mkdtempSync(join(tmpdir(), 'ragent-org-compiler-'));
const probeHome = mkdtempSync(join(tmpdir(), 'ragent-org-probe-'));
process.env.HOME = tempHome;
process.env.RAGENT_ORG_SCHEMA_ENABLED = '1';
delete process.env.RAGENT_ORG_SHADOW_PROJECTION;
delete process.env.RAGENT_CONFIG_DIR;
delete process.env.RAGENT_INSTANCE_ROOT;
delete process.env.RAGENT_WORK_ROOT_DIR;
delete process.env.RAGENT_MEMORY_DIR;
delete process.env.RAGENT_RUN_SPOOL_DIR;

const workspace = join(tempHome, 'workspace');
mkdirSync(workspace, { recursive: true });

const runtime = await import('../chat/organization-runtime.mjs');
const store = await import('../chat/organization-store.mjs');
const { ORG_SCHEMA_ENABLED } = await import('../lib/config.mjs');

const runtimeUrl = new URL('../chat/organization-runtime.mjs', import.meta.url).href;

// compileRevision is synchronous; wrap it so assert.rejects sees a real
// rejection (this Node's assert.rejects does not swallow sync throws).
const rejectCompile = (fn) => Promise.resolve().then(fn);

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

const baseProposal = {
  nodes: [
    { stableKey: 'manager-1', role: 'manager', capabilities: ['manage', 'read'], dependsOn: [] },
    { stableKey: 'writer-1', role: 'writer', capabilities: ['read', 'write'], dependsOn: ['manager-1'] },
    { stableKey: 'reviewer-1', role: 'reviewer', capabilities: ['read'], dependsOn: ['manager-1'] },
  ],
  phaseContracts: [{ phaseId: 'build', gates: ['review'] }],
};

// ---------------------------------------------------------------------------
// Revision Compiler
// ---------------------------------------------------------------------------

async function testCompileValidAndStableDigest() {
  const first = runtime.compileRevision(baseProposal);
  a.ok(first.compiled, 'compile produces a compiled constitution');
  a.ok(first.digest, 'compile produces a digest');
  a.ok(first.digest.startsWith('sha256:'), 'digest uses the sha256 content-hash prefix');

  const second = runtime.compileRevision(baseProposal);
  a.equal(second.digest, first.digest, 'digest is stable for identical input');
  a.deepEqual(second.compiled, first.compiled, 'compiled output is deterministic');

  // The compiled constitution is a canonical function of the dependency graph:
  // shuffling the input node array must not change the digest.
  const shuffled = {
    nodes: [...baseProposal.nodes].reverse(),
    phaseContracts: baseProposal.phaseContracts,
  };
  a.equal(runtime.compileRevision(shuffled).digest, first.digest, 'digest is independent of input node order');

  const compiled = first.compiled;
  a.equal(compiled.schemaVersion, 1, 'compiled carries the schema version');
  a.equal(compiled.nodes.length, 3, 'compiled node table has every node');
  a.deepEqual(compiled.dependencyOrder, ['manager-1', 'reviewer-1', 'writer-1'], 'dependency order is deterministic and topological');
  a.deepEqual(compiled.stats, { nodeCount: 3, maxDepth: 2 }, 'compiled carries node/depth stats');

  const manager = compiled.nodes.find((node) => node.stableKey === 'manager-1');
  a.equal(manager.role, 'manager');
  a.deepEqual(manager.capabilities, ['manage', 'read'], 'capabilities are sorted');
  a.equal(manager.effectiveGrants.manage.allow, true, 'effective grants projection carries allow=true');
  a.deepEqual(manager.effectiveGrants.manage.scope, {}, 'default grant scope is empty');
  a.equal(manager.effectiveGrants.read.allow, true);

  const writer = compiled.nodes.find((node) => node.stableKey === 'writer-1');
  a.equal(writer.effectiveGrants.write.allow, true, 'writer grants write');

  a.equal(compiled.phaseContracts.length, 1, 'phase contracts are preserved');
  a.equal(compiled.phaseContracts[0].phaseId, 'build');
  a.equal(compiled.budget.maxNodes, runtime.DEFAULT_ORG_BUDGET.maxNodes, 'default budget is applied when none given');
}

async function testCompileCycle() {
  await a.rejects(
    () => rejectCompile(() => runtime.compileRevision({ nodes: [
      { stableKey: 'a', role: 'manager', capabilities: ['read'], dependsOn: ['b'] },
      { stableKey: 'b', role: 'manager', capabilities: ['read'], dependsOn: ['a'] },
    ] })),
    (err) => err?.code === 'REVISION_CYCLE_DETECTED'
      && err?.statusCode === 422
      && err?.cause?.reason === 'cycle'
      && err?.cause?.cycle === 'a -> b -> a',
  );
}

async function testCompileMissingDependency() {
  await a.rejects(
    () => rejectCompile(() => runtime.compileRevision({ nodes: [
      { stableKey: 'a', role: 'manager', capabilities: ['read'], dependsOn: ['ghost'] },
    ] })),
    (err) => err?.code === 'REVISION_COMPILE_FAILED'
      && err?.statusCode === 422
      && err?.cause?.reason === 'missing_dependency'
      && err?.cause?.dependency === 'ghost',
  );
}

async function testCompileBudget() {
  // Node count
  await a.rejects(
    () => rejectCompile(() => runtime.compileRevision({
      nodes: [
        { stableKey: 'a', role: 'manager', capabilities: ['read'] },
        { stableKey: 'b', role: 'manager', capabilities: ['read'] },
      ],
    }, { maxNodes: 1 })),
    (err) => err?.code === 'REVISION_BUDGET_EXCEEDED' && err?.statusCode === 422 && err?.cause?.reason === 'max_nodes',
  );
  // Dependency depth
  await a.rejects(
    () => rejectCompile(() => runtime.compileRevision({
      nodes: [
        { stableKey: 'a', role: 'manager', capabilities: ['read'] },
        { stableKey: 'b', role: 'manager', capabilities: ['read'], dependsOn: ['a'] },
        { stableKey: 'c', role: 'manager', capabilities: ['read'], dependsOn: ['b'] },
      ],
    }, { maxDepth: 2 })),
    (err) => err?.code === 'REVISION_BUDGET_EXCEEDED' && err?.cause?.reason === 'max_depth',
  );
  // Capabilities per role
  await a.rejects(
    () => rejectCompile(() => runtime.compileRevision({
      nodes: [{ stableKey: 'a', role: 'manager', capabilities: ['read', 'write'] }],
    }, { maxCapabilitiesPerRole: 1 })),
    (err) => err?.code === 'REVISION_BUDGET_EXCEEDED' && err?.cause?.reason === 'max_capabilities_per_role',
  );
  // Budget is also overridable from the proposal itself
  await a.rejects(
    () => rejectCompile(() => runtime.compileRevision({
      nodes: [
        { stableKey: 'a', role: 'manager', capabilities: ['read'] },
        { stableKey: 'b', role: 'manager', capabilities: ['read'] },
      ],
      budget: { maxNodes: 1 },
    })),
    (err) => err?.code === 'REVISION_BUDGET_EXCEEDED' && err?.cause?.reason === 'max_nodes',
  );
  // The explicit org budget wins over proposal budget.
  const ok = runtime.compileRevision({
    nodes: [
      { stableKey: 'a', role: 'manager', capabilities: ['read'] },
      { stableKey: 'b', role: 'manager', capabilities: ['read'] },
    ],
    budget: { maxNodes: 1 },
  }, { maxNodes: 5 });
  a.equal(ok.compiled.nodes.length, 2, 'explicit budget overrides the proposal budget');
  a.equal(ok.compiled.budget.maxNodes, 5);
}

async function testCompileRoleCapabilityValidation() {
  await a.rejects(
    () => rejectCompile(() => runtime.compileRevision({ nodes: [{ stableKey: 'a', role: 'supreme-leader', capabilities: ['read'] }] })),
    (err) => err?.code === 'REVISION_COMPILE_FAILED' && err?.cause?.reason === 'invalid_role',
  );
  await a.rejects(
    () => rejectCompile(() => runtime.compileRevision({ nodes: [{ stableKey: 'a', role: 'manager', capabilities: ['delete-everything'] }] })),
    (err) => err?.code === 'REVISION_COMPILE_FAILED' && err?.cause?.reason === 'invalid_capability',
  );
  await a.rejects(
    () => rejectCompile(() => runtime.compileRevision({ nodes: [] })),
    (err) => err?.code === 'REVISION_COMPILE_FAILED' && err?.cause?.reason === 'empty_nodes',
  );
  await a.rejects(
    () => rejectCompile(() => runtime.compileRevision({ nodes: [{ stableKey: '', role: 'manager', capabilities: ['read'] }] })),
    (err) => err?.code === 'REVISION_COMPILE_FAILED' && err?.cause?.reason === 'missing_stable_key',
  );
  await a.rejects(
    () => rejectCompile(() => runtime.compileRevision({ nodes: [
      { stableKey: 'dup', role: 'manager', capabilities: ['read'] },
      { stableKey: 'dup', role: 'reviewer', capabilities: ['read'] },
    ] })),
    (err) => err?.code === 'REVISION_COMPILE_FAILED' && err?.cause?.reason === 'duplicate_stable_key',
  );
}

// ---------------------------------------------------------------------------
// Commands: lifecycle, idempotency, CAS, freeze
// ---------------------------------------------------------------------------

async function testReviseFlowAndReads() {
  const org = await runtime.createOrganization({ rootSessionId: 'root-flow', projectId: 'prj-flow', budget: { maxNodes: 5 } });
  a.ok(org?.id?.startsWith('org_'), 'createOrganization returns an org id');
  a.equal(org.rootSessionId, 'root-flow');
  a.equal(org.projectId, 'prj-flow');
  a.equal(org.currentRevision, 0, 'new organization starts at revision 0');

  const rev1 = await runtime.reviseOrganization({ organizationId: org.id, proposal: baseProposal });
  a.equal(rev1.organizationId, org.id);
  a.equal(rev1.revision, 1, 'first revise is revision 1');
  a.equal(rev1.state, 'draft', 'new revision is a draft until frozen');
  a.ok(rev1.compiled, 'compiled constitution is stored on the revision');
  a.ok(rev1.digest, 'digest is stored on the revision');
  a.deepEqual(rev1.proposal.nodes, baseProposal.nodes, 'original proposal is preserved');
  a.equal(rev1.idempotencyKey, '', 'no idempotency key recorded when none given');

  const fetched = await runtime.getOrganizationRevision(org.id, 1);
  a.equal(fetched.revision, 1);
  a.equal(fetched.digest, rev1.digest);

  const compiled = await runtime.getCompiledRevision(org.id, 1);
  a.ok(compiled, 'getCompiledRevision returns the compiled constitution');
  a.equal(compiled.nodes.length, baseProposal.nodes.length);

  // Head variant resolves the current revision without an explicit number.
  const headCompiled = await runtime.getCompiledRevision(org.id);
  a.equal(headCompiled.nodes.length, compiled.nodes.length, 'head variant resolves current revision');

  // Missing reads return null.
  a.equal(await runtime.getOrganizationRevision(org.id, 99), null, 'missing revision read returns null');
  a.equal(await runtime.getCompiledRevision(org.id, 99), null, 'missing compiled read returns null');
  a.equal(await runtime.getCompiledRevision('org-missing'), null, 'missing org head read returns null');

  const frozen = await runtime.freezeRevision(org.id, 1);
  a.equal(frozen.state, 'frozen', 'freeze flips the revision state');
  a.equal((await runtime.getOrganizationRevision(org.id, 1)).state, 'frozen');
  a.equal((await runtime.freezeRevision(org.id, 1)).state, 'frozen', 'freezing an already-frozen revision is idempotent');

  const rev2 = await runtime.reviseOrganization({ organizationId: org.id, proposal: baseProposal });
  a.equal(rev2.revision, 2, 'a new constitution is a higher revision (constitution §2.13)');

  const listed = await runtime.listOrganizationRevisions(org.id);
  a.deepEqual(listed.map((item) => item.revision), [1, 2], 'listOrganizationRevisions is ordered by revision');
  a.deepEqual(listed.map((item) => item.state), ['frozen', 'draft']);
}

async function testCreateOrganizationIdempotent() {
  const first = await runtime.createOrganization({ rootSessionId: 'root-create-idem', idempotencyKey: 'create-key-1' });
  const replay = await runtime.createOrganization({ rootSessionId: 'root-create-idem', idempotencyKey: 'create-key-1' });
  a.ok(first.id, 'createOrganization returns an organization');
  a.equal(replay.id, first.id, 'same idempotency key replays the same organization');
  a.equal(replay.rootSessionId, first.rootSessionId);

  // A different key against the same root session is a root-session conflict.
  await a.rejects(
    () => runtime.createOrganization({ rootSessionId: 'root-create-idem', idempotencyKey: 'create-key-2' }),
    (err) => err?.code === 'ORGANIZATION_ROOT_SESSION_CONFLICT' && err?.statusCode === 409,
  );

  // Without a key a fresh root session creates a fresh organization.
  const fresh = await runtime.createOrganization({ rootSessionId: 'root-create-nokey' });
  a.ok(fresh.id && fresh.id !== first.id, 'no key creates a fresh organization');
}

async function testReviseIdempotentReplay() {
  const org = await runtime.createOrganization({ rootSessionId: 'root-rev-idem' });
  const first = await runtime.reviseOrganization({ organizationId: org.id, proposal: baseProposal, idempotencyKey: 'rev-key-1' });
  a.equal(first.revision, 1);

  // Replay with the same key returns the original revision, even with a
  // different proposal body: same key, same result, no second object.
  const replay = await runtime.reviseOrganization({
    organizationId: org.id,
    proposal: { nodes: [{ stableKey: 'other', role: 'manager', capabilities: ['read'] }] },
    idempotencyKey: 'rev-key-1',
  });
  a.equal(replay.revision, first.revision, 'replay returns the original revision');
  a.equal(replay.digest, first.digest, 'replay returns the original digest');
  a.deepEqual(replay.proposal.nodes, baseProposal.nodes, 'replay does not re-run the new proposal');

  const all = await runtime.listOrganizationRevisions(org.id);
  a.equal(all.length, 1, 'replay does not create a second revision');

  // A different key advances normally.
  const second = await runtime.reviseOrganization({ organizationId: org.id, proposal: baseProposal, idempotencyKey: 'rev-key-2' });
  a.equal(second.revision, 2, 'a different key advances to a new revision');
}

async function testReviseCasConflict() {
  const org = await runtime.createOrganization({ rootSessionId: 'root-cas-direct' });
  await runtime.reviseOrganization({ organizationId: org.id, proposal: baseProposal, expectedCurrentRevision: 0 });
  await a.rejects(
    () => runtime.reviseOrganization({ organizationId: org.id, proposal: baseProposal, expectedCurrentRevision: 0 }),
    (err) => err?.code === 'REVISION_CONFLICT' && err?.statusCode === 409,
  );

  // Concurrent revises with the same expected base: exactly one wins, the
  // other observes a REVISION_CONFLICT CAS miss.
  const concurrentOrg = await runtime.createOrganization({ rootSessionId: 'root-cas-concurrent' });
  const results = await Promise.allSettled([
    runtime.reviseOrganization({ organizationId: concurrentOrg.id, proposal: baseProposal, expectedCurrentRevision: 0 }),
    runtime.reviseOrganization({ organizationId: concurrentOrg.id, proposal: baseProposal, expectedCurrentRevision: 0 }),
  ]);
  const succeeded = results.filter((result) => result.status === 'fulfilled');
  const conflicted = results.filter((result) => result.status === 'rejected');
  a.equal(succeeded.length, 1, 'exactly one concurrent revise wins the CAS');
  a.equal(conflicted.length, 1, 'exactly one concurrent revise hits a CAS conflict');
  a.equal(conflicted[0].reason?.code, 'REVISION_CONFLICT', 'CAS conflict uses the stable code');
  a.equal(conflicted[0].reason?.statusCode, 409);
  a.equal(succeeded[0].value.revision, 1);
  a.equal((await runtime.listOrganizationRevisions(concurrentOrg.id)).length, 1, 'CAS leaves a single revision behind');
}

async function testFreezeImmutable() {
  const org = await runtime.createOrganization({ rootSessionId: 'root-freeze' });
  await runtime.reviseOrganization({ organizationId: org.id, proposal: baseProposal });
  const frozen = await runtime.freezeRevision(org.id, 1);
  a.equal(frozen.state, 'frozen');

  // Modifying a frozen revision is refused with the stable code.
  await a.rejects(
    () => store.createRevision(org.id, { revision: 1, proposal: { title: 'changed' } }),
    (err) => err?.code === 'REVISION_FROZEN',
  );

  // A frozen head still accepts a higher revision.
  const rev2 = await runtime.reviseOrganization({ organizationId: org.id, proposal: baseProposal });
  a.equal(rev2.revision, 2);
}

// ---------------------------------------------------------------------------
// Feature flag: ORG_SCHEMA_ENABLED=false -> commands unavailable
// ---------------------------------------------------------------------------

async function testCommandsUnavailableWhenFlagOff() {
  a.equal(ORG_SCHEMA_ENABLED, true, 'main test process runs with the flag on');

  const script = [
    `import * as rt from ${JSON.stringify(runtimeUrl)};`,
    `const calls = [`,
    `  () => rt.createOrganization({ rootSessionId: 'x' }),`,
    `  () => rt.reviseOrganization({ organizationId: 'org_x', proposal: { nodes: [] } }),`,
    `  () => rt.freezeRevision('org_x', 1),`,
    `  () => rt.getOrganizationRevision('org_x', 1),`,
    `  () => rt.getCompiledRevision('org_x', 1),`,
    `  () => rt.listOrganizationRevisions('org_x'),`,
    `];`,
    `const results = [];`,
    `for (const call of calls) {`,
    `  try { await call(); results.push({ ok: true }); }`,
    `  catch (error) { results.push({ ok: false, code: error?.code, statusCode: error?.statusCode }); }`,
    `}`,
    `console.log('DISABLED=' + JSON.stringify(results));`,
  ].join('\n');
  const out = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
    env: childEnv(probeHome, {}),
    encoding: 'utf8',
  });
  const line = out.trim().split('\n').filter((entry) => entry.startsWith('DISABLED=')).pop();
  a.ok(line, 'child produced a DISABLED= line');
  const results = JSON.parse(line.slice('DISABLED='.length));
  a.equal(results.length, 6, 'all six commands were probed');
  for (const result of results) {
    a.equal(result.ok, false, 'command is unavailable when the flag is off');
    a.equal(result.code, 'ORGANIZATION_SCHEMA_DISABLED', 'unavailable error uses the stable code');
    a.equal(result.statusCode, 503, 'unavailable error carries 503');
  }
}

try {
  await store.initializeOrganizationStore();
  await testCompileValidAndStableDigest();
  await testCompileCycle();
  await testCompileMissingDependency();
  await testCompileBudget();
  await testCompileRoleCapabilityValidation();
  await testCreateOrganizationIdempotent();
  await testReviseFlowAndReads();
  await testReviseIdempotentReplay();
  await testReviseCasConflict();
  await testFreezeImmutable();
  await testCommandsUnavailableWhenFlagOff();
  console.log(`test-organization-compiler: ok (${assertionCount} assertions)`);
} finally {
  rmSync(probeHome, { recursive: true, force: true });
  rmSync(tempHome, { recursive: true, force: true });
}
