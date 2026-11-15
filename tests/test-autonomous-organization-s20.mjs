#!/usr/bin/env node
import assert from 'assert/strict';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tempHome = mkdtempSync(join(tmpdir(), 'ragent-autonomous-org-s20-'));
process.env.HOME = tempHome;
process.env.RAGENT_INSTANCE_ROOT = tempHome;
process.env.RAGENT_CONFIG_DIR = join(tempHome, 'config');
mkdirSync(join(tempHome, 'workspace'), { recursive: true });

const projector = await import('../chat/context-projector.mjs');
let assertions = 0;
function equal(actual, expected, message) { assertions += 1; assert.equal(actual, expected, message); }
function ok(value, message) { assertions += 1; assert.ok(value, message); }
async function rejectsCode(fn, code, message) { assertions += 1; await assert.rejects(fn, (e) => e?.code === code, message); }

const base = {
  organizationId: 'org-s20', sourceRevision: 4, objective: 'Automate the weekly report',
  frozenRevision: { revision: 4, digest: 'sha256:revision', state: 'frozen', proposal: 'hidden' },
  phases: [
    { phaseId: 'prepare', objective: 'Prepare inputs', state: 'completed', acceptance: [{ criterion: 'inputs', status: 'passed', evidenceRefs: [{ id: 'ev-1' }] }], packetRefs: [{ id: 'packet-1' }], reviewRefs: [{ id: 'review-1' }] },
    { phaseId: 'publish', objective: 'Publish report', state: 'running', acceptance: [{ criterion: 'report', status: 'pending' }], packetRefs: [{ id: 'packet-2' }] },
  ],
  progress: { completed: 1, total: 2 }, budgetProgress: { runs: 2, runsMax: 5 },
  nodes: [
    { id: 'manager-1', parentId: '', role: 'manager', status: 'running', currentActivity: 'delegating' },
    { id: 'worker-1', parentId: 'manager-1', role: 'worker', status: 'running', taskId: 'task-1', currentActivity: 'reading' },
    { id: 'worker-2', parentId: 'manager-1', role: 'worker', status: 'queued', taskId: 'task-2' },
    { id: 'sibling-1', parentId: 'manager-2', role: 'worker', status: 'running', taskId: 'private-task' },
  ],
  subtreeNodeIds: ['manager-1', 'worker-1', 'worker-2'],
  targetNode: { id: 'manager-1', role: 'manager', status: 'running' },
  directChildPacketRefs: [{ id: 'packet-1' }, { id: 'packet-2' }],
  reviewRefs: [{ id: 'review-1' }], projectRefs: [{ id: 'project-1' }],
};

const executive = projector.buildContextProjection({ targetRole: 'EXECUTIVE', organizationId: 'org-s20', revision: 4, facts: base });
equal(executive.schemaVersion, 1, 'projection schema is explicit');
equal(executive.targetRole, 'EXECUTIVE', 'executive target is normalized');
equal(executive.organizationId, 'org-s20', 'organization identity is included');
equal(executive.phases.length, 2, 'executive receives phase summaries');
equal(executive.phases[0].packetRefs[0].id, 'packet-1', 'executive receives packet refs');
equal(executive.frozenRevision.digest, 'sha256:revision', 'executive receives frozen revision digest');
ok(!JSON.stringify(executive).includes('hidden'), 'executive does not receive arbitrary revision fields');
ok(!JSON.stringify(executive).includes('private-task'), 'executive projection is bounded to explicit refs');
equal(executive.digest, projector.projectionDigest(executive), 'projection digest verifies');

const manager = projector.buildContextProjection({ targetRole: 'MANAGER', organizationId: 'org-s20', nodeId: 'manager-1', revision: 4, facts: base });
equal(manager.subtree.length, 3, 'manager receives only its subtree');
ok(!JSON.stringify(manager).includes('sibling-1'), 'manager cannot see sibling node');
equal(manager.childPacketRefs.length, 2, 'manager receives direct child packet refs');
equal(manager.projectRefs[0].id, 'project-1', 'manager receives project refs');
ok(!JSON.stringify(manager).includes('systemPrompt'), 'manager projection has no prompt');

const workerFacts = {
  organizationId: 'org-s20', sourceRevision: 4, targetNode: { id: 'worker-1', role: 'worker' },
  task: { id: 'task-1', objective: 'Read the input files', acceptance: [{ criterion: 'files', status: 'pending' }] },
  executionScopeSnapshot: { workspaceId: 'workspace-1', projectId: 'project-1', accessMode: 'read_only' },
  parentHandoff: { id: 'handoff-1', digest: 'sha256:handoff' }, projectRefs: [{ id: 'project-1' }],
  nodes: base.nodes, subtreeNodeIds: ['worker-1'],
};
const worker = projector.buildContextProjection({ targetRole: 'WORKER', organizationId: 'org-s20', nodeId: 'worker-1', revision: 4, facts: workerFacts });
equal(worker.task.taskId, 'task-1', 'worker receives task contract');
equal(worker.executionScope.accessMode, 'read_only', 'worker receives scope snapshot');
equal(worker.parentHandoff.id, 'handoff-1', 'worker receives parent handoff ref');
ok(!JSON.stringify(worker).includes('manager-1'), 'worker cannot see organization hierarchy');
ok(!JSON.stringify(worker).includes('worker-2'), 'worker cannot see sibling node');

const reviewerFacts = {
  organizationId: 'org-s20', sourceRevision: 4, targetNode: { id: 'reviewer-1', role: 'reviewer' },
  reviewPolicy: { criteria: ['tests', 'evidence'], decision: 'PASS|NEEDS_CHANGES|BLOCKED' },
  acceptance: [{ criterion: 'tests', status: 'passed' }], targetPacketRefs: [{ id: 'packet-1' }],
  diffRefs: [{ id: 'diff-1' }], testRefs: [{ id: 'test-1' }], artifactRefs: [{ id: 'artifact-1' }], evidenceRefs: [{ id: 'ev-1' }],
};
const reviewer = projector.buildContextProjection({ targetRole: 'REVIEWER', organizationId: 'org-s20', nodeId: 'reviewer-1', revision: 4, facts: reviewerFacts });
equal(reviewer.readOnly, true, 'reviewer is read only');
equal(reviewer.targetPacketRefs[0].id, 'packet-1', 'reviewer receives target packet ref');
equal(reviewer.evidenceRefs[0].id, 'ev-1', 'reviewer receives evidence refs');
ok(!JSON.stringify(reviewer).includes('write'), 'reviewer has no write tool projection');

await rejectsCode(() => Promise.resolve().then(() => projector.buildContextProjection({ targetRole: 'UNKNOWN', organizationId: 'org-s20', facts: base })), projector.CONTEXT_PROJECTION_INVALID, 'unknown target role is rejected');
await rejectsCode(() => Promise.resolve().then(() => projector.buildContextProjection({ targetRole: 'MANAGER', organizationId: 'org-other', nodeId: 'manager-1', facts: base })), projector.CONTEXT_PROJECTION_INVALID, 'cross organization facts are rejected');
await rejectsCode(() => Promise.resolve().then(() => projector.buildContextProjection({ targetRole: 'MANAGER', organizationId: 'org-s20', nodeId: 'worker-1', facts: base })), projector.CONTEXT_PROJECTION_INVALID, 'target node mismatch is rejected');
await rejectsCode(() => Promise.resolve().then(() => projector.buildContextProjection({ targetRole: 'REVIEWER', organizationId: 'org-s20', nodeId: 'reviewer-1', facts: { ...reviewerFacts, canWrite: true } })), projector.CONTEXT_PROJECTION_FORBIDDEN, 'reviewer write capability is rejected');
await rejectsCode(() => Promise.resolve().then(() => projector.buildContextProjection({ targetRole: 'EXECUTIVE', organizationId: 'org-s20', facts: { ...base, systemPrompt: 'do not leak' } })), projector.CONTEXT_PROJECTION_FORBIDDEN, 'system prompt corpus is rejected');
await rejectsCode(() => Promise.resolve().then(() => projector.buildContextProjection({ targetRole: 'EXECUTIVE', organizationId: 'org-s20', facts: { ...base, rawHistory: ['private chat'] } })), projector.CONTEXT_PROJECTION_FORBIDDEN, 'raw history corpus is rejected');
await rejectsCode(() => Promise.resolve().then(() => projector.buildContextProjection({ targetRole: 'EXECUTIVE', organizationId: 'org-s20', facts: { ...base, grantToken: 'secret-token' } })), projector.CONTEXT_PROJECTION_FORBIDDEN, 'grant token corpus is rejected');

const orderedA = projector.buildContextProjection({ targetRole: 'EXECUTIVE', organizationId: 'org-s20', revision: 4, facts: { ...base, packetRefs: [{ id: 'z' }, { id: 'a' }, { id: 'a' }] } });
const orderedB = projector.buildContextProjection({ targetRole: 'EXECUTIVE', organizationId: 'org-s20', revision: 4, facts: { ...base, packetRefs: [{ id: 'a' }, { id: 'z' }] } });
equal(orderedA.packetRefs.length, 2, 'packet refs are deduplicated');
equal(orderedA.digest, orderedB.digest, 'digest is stable across ref input order');
const limited = projector.buildContextProjection({ targetRole: 'EXECUTIVE', organizationId: 'org-s20', revision: 4, maxBytes: 1024, facts: { ...base, packetRefs: Array.from({ length: 128 }, (_, i) => ({ id: `packet-${i}` })) } });
ok(Buffer.byteLength(JSON.stringify(limited), 'utf8') <= 1024, 'projection observes size bound');
ok(limited.sizeBound === 1024, 'size bound is exposed');

const fresh = execFileSync(process.execPath, ['--input-type=module', '--eval', `
  import { projectionDigest } from ${JSON.stringify(new URL('../chat/context-projector.mjs', import.meta.url).href)};
  const p = ${JSON.stringify(executive)};
  console.log(projectionDigest(p));
`], { env: process.env, encoding: 'utf8' }).trim();
equal(fresh, executive.digest, 'fresh process computes the same projection digest');

console.log(`test-autonomous-organization-s20: ok (${assertions} assertions)`);
