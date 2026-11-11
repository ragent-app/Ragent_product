#!/usr/bin/env node
import assert from 'node:assert/strict';

import { compileSemanticOperations } from '../chat/semantic-compiler.mjs';
import { SEMANTIC_POLICY_VERSION } from '../chat/semantic-operation.mjs';
import {
  bindServerResolution,
  evaluateSemanticOperation,
  projectSemanticPolicy,
} from '../chat/semantic-policy.mjs';

let passed = 0;
function check(label, value) {
  assert.ok(value, `failed: ${label}`);
  passed += 1;
}
function eq(label, actual, expected) {
  assert.deepEqual(actual, expected, `failed: ${label}`);
  passed += 1;
}

function operations(rawCommand) {
  const compiled = compileSemanticOperations({
    request: {
      rawCommand,
      sessionId: 'session_1',
      runId: 'run_1',
      turnId: 'turn_1',
      requestKey: 'request_1',
    },
    trustedContext: { cwd: '/project', projectRoot: '/project', home: '/home/owner', platform: 'linux' },
  });
  return compiled.operations;
}

function operation(rawCommand) {
  const compiled = operations(rawCommand);
  assert.equal(compiled.length, 1, `fixture must create one operation: ${rawCommand}`);
  return compiled[0];
}

function resolution({
  scope = { computed: true, kind: 'project', projectRoot: '/project', containment: 'inside' },
  impact = {},
  unknowns = [],
  snapshot = {},
} = {}) {
  const defaultSelfProtection = {
    computed: true,
    matched: false,
    workspaceRecommended: true,
    boundary: 'none',
  };
  return {
    scope: {
      ...scope,
      selfProtection: scope.selfProtection || defaultSelfProtection,
    },
    impact: {
      estimatedItems: 1,
      containsTrackedFiles: false,
      containsModifiedFiles: false,
      containsSensitiveMaterial: false,
      containsGitMetadata: false,
      reversible: false,
      ...impact,
    },
    unknowns,
    resourceSnapshot: {
      resolverVersion: 'semantic-resolver/v1',
      identity: 'snapshot_fixture_1',
      paths: [{
        requested: '/project/file',
        canonical: '/project/file',
        identity: 'dev:1',
        expectedParentIdentity: 'dev:0',
        mountId: 'dev',
        noFollow: false,
        symlinkChain: [],
        missingPathSegments: [],
        parentIsDirectory: true,
      }],
      provider: 'fixture',
      ...snapshot,
    },
  };
}

const read = operation('cat readme.md');
const write = operation('touch build/output.txt');
const del = operation('rm -rf build/cache');

// Resolver facts replace the compiler's unresolved scope; callers cannot claim
// an ALLOW by setting fields on the compiler operation itself.
{
  const forged = { ...read, scope: { computed: true, kind: 'project' } };
  const outcome = evaluateSemanticOperation(forged, null);
  eq('missing server resolution denies', outcome.decision, 'DENY');
  check('missing server resolution has no bound operation', outcome.operation === null);
}

{
  const bound = bindServerResolution(read, resolution());
  check('server resolution binds operation', Boolean(bound));
  eq('bound operation policy version remains pinned', bound.analysis.policyVersion, SEMANTIC_POLICY_VERSION);
  eq('bound resolver snapshot attached to target', bound.target.resourceSnapshot.identity, 'snapshot_fixture_1');
  eq('resolver scope replaces compiler scope', bound.scope.computed, true);
  check('bound source is unchanged', bound.source.rawRequestHash === read.source.rawRequestHash);
}

{
  const outcome = evaluateSemanticOperation(read, resolution());
  eq('ordinary resolved project read allows in shadow projection', outcome.decision, 'ALLOW');
  eq('policy output never becomes a capability', outcome.operation.executionClass, 'session');
  check('read gets resource-bound manifest hash', /^[0-9a-f]{64}$/.test(outcome.operationManifestHash));
  eq('read gets resolver snapshot identity', outcome.resolverSnapshotIdentity, 'snapshot_fixture_1');
}

{
  const outcome = evaluateSemanticOperation(write, resolution());
  eq('ordinary resolved project write allows in shadow projection', outcome.decision, 'ALLOW');
  const deleted = evaluateSemanticOperation(del, resolution());
  eq('ordinary resolved project delete remains ASK', deleted.decision, 'ASK');
}

{
  const protectedTarget = evaluateSemanticOperation(write, resolution({
    scope: {
      computed: true,
      kind: 'project',
      projectRoot: '/project',
      containment: 'inside',
      selfProtection: {
        computed: true,
        matched: true,
        workspaceRecommended: false,
        boundary: 'agentoc-service',
      },
    },
  }));
  eq('self-protection boundary denies ordinary write', protectedTarget.decision, 'DENY');

  const unavailableTarget = evaluateSemanticOperation(write, resolution({
    scope: {
      computed: true,
      kind: 'project',
      projectRoot: '/project',
      containment: 'inside',
      selfProtection: {
        computed: false,
        matched: false,
        workspaceRecommended: false,
        boundary: 'none',
      },
    },
  }));
  eq('missing self-protection facts deny ordinary write', unavailableTarget.decision, 'DENY');
}

{
  const pkg = operation('apt-get install nginx');
  const packageResolution = resolution({
    scope: { computed: true, kind: 'system', containment: 'inside' },
    snapshot: { identity: 'package-snapshot-1' },
  });
  eq('verified package descriptor remains ASK', evaluateSemanticOperation(pkg, packageResolution).decision, 'ASK');
  eq('system filesystem descriptor denies', evaluateSemanticOperation(read, resolution({
    scope: { computed: true, kind: 'system', containment: 'inside' },
  })).decision, 'DENY');
}

for (const [label, patch] of [
  ['uncomputed scope', { scope: { computed: false, kind: 'unresolvable' } }],
  ['outside project', { scope: { computed: true, kind: 'outside_project', containment: 'outside' } }],
  ['filesystem root', { scope: { computed: true, kind: 'filesystem_root', containment: 'inside' } }],
  ['symlink escape', { scope: { computed: true, kind: 'symlink_escape', symlinkEscape: true } }],
  ['mount boundary', { scope: { computed: true, kind: 'mount_boundary', mountBoundary: true } }],
  ['sensitive material', { impact: { containsSensitiveMaterial: true } }],
  ['git metadata', { impact: { containsGitMetadata: true } }],
  ['unreadable tree', { unknowns: ['scope:tree-unreadable'] }],
  ['dynamic target', { unknowns: ['target:dynamic-argv'] }],
  ['environment injection', { unknowns: ['env:ld_preload-override'] }],
  ['interpreter nesting', { unknowns: ['interpreter:nested'] }],
  ['composite shell', { unknowns: ['shell:composite-unverified'] }],
  ['snapshot changed', { unknowns: ['revalidation:snapshot-changed'] }],
]) {
  eq(`${label} denies`, evaluateSemanticOperation(read, resolution(patch)).decision, 'DENY');
}

{
  const badVersion = resolution({ snapshot: { resolverVersion: 'semantic-resolver/v0' } });
  eq('resolver version mismatch denies', evaluateSemanticOperation(read, badVersion).decision, 'DENY');
  const noPaths = resolution({ snapshot: { paths: null } });
  eq('incomplete snapshot denies', evaluateSemanticOperation(read, noPaths).decision, 'DENY');
}

{
  const hostile = operation('LD_PRELOAD=/tmp/evil.so rm -rf build/cache');
  const outcome = evaluateSemanticOperation(hostile, resolution());
  eq('compiler refusal remains denied after resolution', outcome.decision, 'DENY');
  check('environment reason survives refusal', outcome.reasons.some((entry) => entry.code === 'env_injection'));
}

{
  const nested = operations('echo x | python3 -c "import os; os.system(\'rm -rf build/cache\')"');
  check('nested composite creates all semantic effects', nested.length > 1);
  check('every nested composite effect denies', nested.every((entry) => (
    evaluateSemanticOperation(entry, resolution()).decision === 'DENY'
  )));
}

{
  const projection = projectSemanticPolicy([
    { operation: read, resolution: resolution() },
    { operation: write, resolution: resolution() },
  ]);
  eq('ALLOW plus ALLOW aggregates to ALLOW', projection.decision, 'ALLOW');
  eq('shadow projection never marks capability eligible', projection.capabilityEligible, false);
  eq('projection keeps both decisions', projection.decisions.length, 2);

  const denied = projectSemanticPolicy([
    { operation: read, resolution: resolution() },
    { operation: read, resolution: resolution({ unknowns: ['scope:tree-unreadable'] }) },
  ]);
  eq('DENY dominates aggregate', denied.decision, 'DENY');
}

{
  const empty = projectSemanticPolicy([]);
  eq('empty projection is non-authorizing allow identity', empty.decision, 'ALLOW');
  eq('empty projection has no capability', empty.capabilityEligible, false);
}

console.log(`semantic-policy: ${passed} checks passed`);
