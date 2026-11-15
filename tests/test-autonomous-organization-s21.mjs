#!/usr/bin/env node
import assert from 'assert/strict';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tempHome = mkdtempSync(join(tmpdir(), 'ragent-autonomous-org-s21-'));
process.env.HOME = tempHome;
process.env.RAGENT_INSTANCE_ROOT = tempHome;
process.env.RAGENT_CONFIG_DIR = join(tempHome, 'config');
mkdirSync(join(tempHome, 'workspace'), { recursive: true });

const planner = await import('../chat/organization-planner.mjs');
const runtime = await import('../chat/organization-runtime.mjs');

let assertions = 0;
function equal(actual, expected, message) { assertions += 1; assert.equal(actual, expected, message); }
function ok(value, message) { assertions += 1; assert.ok(value, message); }
function deepEqual(actual, expected, message) { assertions += 1; assert.deepEqual(actual, expected, message); }
function rejectsCode(fn, code, message) { assertions += 1; return assert.rejects(fn, (error) => error?.code === code, message); }

const profiles = [
  { agentId: 'lead', role: 'manager', canDelegate: true, capabilities: ['read', 'manage', 'review'], maxDepth: 3, maxChildren: 4, maxConcurrent: 2 },
  { agentId: 'worker', role: 'worker', canDelegate: false, capabilities: ['read'], maxDepth: 2, maxChildren: 0, maxConcurrent: 1 },
  { agentId: 'reviewer', role: 'reviewer', canDelegate: false, capabilities: ['read', 'review'], maxDepth: 2, maxChildren: 0, maxConcurrent: 1 },
];
const proposal = {
  schemaVersion: 1,
  proposalId: 'proposal-s21',
  idempotencyKey: 'proposal-s21-key',
  objective: 'ship the bounded organization planner',
  nodes: [
    { stableKey: 'lead', role: 'manager', agentId: 'lead', capabilities: ['read', 'manage', 'review'], phaseId: 'build', acceptance: [{ criterion: 'tests' }] },
    { stableKey: 'worker', role: 'worker', agentId: 'worker', capabilities: ['read'], phaseId: 'build', parentKey: 'lead', dependsOn: ['lead'] },
    { stableKey: 'reviewer', role: 'reviewer', agentId: 'reviewer', capabilities: ['review'], phaseId: 'review', parentKey: 'lead', dependsOn: ['worker'], reviewRequired: true },
  ],
  phases: [
    { phaseId: 'build', objective: 'implement', acceptance: [{ criterion: 'tests', evidenceRequired: true }], reviewerRoles: ['reviewer'] },
    { phaseId: 'review', objective: 'review', dependsOn: ['build'], acceptance: [{ criterion: 'review', evidenceRequired: true }], reviewerRoles: ['reviewer'] },
  ],
  reviewPolicy: { required: true, minReviewers: 1, independent: true },
  acceptance: [{ criterion: 'objective evidence', evidenceRequired: true }],
  budget: { maxNodes: 4, maxDepth: 2 },
  manages: [{ parentKey: 'lead', childKey: 'worker' }, { parentKey: 'lead', childKey: 'reviewer' }],
};

const parsed = planner.parseOrganizationProposal(proposal);
equal(parsed.schemaVersion, 1, 'proposal parser freezes schema version');
deepEqual(parsed.order.phases, ['build', 'review'], 'phase order is deterministic');
deepEqual(parsed.order.nodes, ['lead', 'worker', 'reviewer'], 'node order follows dependency DAG');
equal(parsed.nodes[0].stableKey, 'lead', 'nodes are canonically sorted');
equal(parsed.phases[0].acceptance[0].criterion, 'tests', 'acceptance is normalized');

const compiled = await planner.compileOrganizationProposal(proposal, { profiles });
equal(compiled.compiled.compilerVersion, 's21-v2', 'compiler version is explicit');
ok(compiled.digest.startsWith('sha256:'), 'compiled plan has canonical digest');
equal(compiled.sideEffects.writes, 0, 'compiler performs no storage writes');
equal(compiled.sideEffects.mode, 'shadow', 'compile defaults to shadow mode');
equal(compiled.compiled.resolver.length, 3, 'resolver dry-run covers every node');
ok(compiled.compiled.nodes.every((node) => node.resolver.selectedAgentId), 'every node has a selected Agent');

const shadow = await planner.shadowOrganizationPlan(JSON.stringify(proposal), { profiles });
equal(shadow.digest, compiled.digest, 'JSON and object parser paths have the same digest');
deepEqual(shadow.sideEffects.created, [], 'shadow plan creates no facts');

const fresh = execFileSync(process.execPath, ['--input-type=module', '--eval', `
  import { proposalDigest } from ${JSON.stringify(new URL('../chat/organization-planner.mjs', import.meta.url).href)};
  console.log(proposalDigest(${JSON.stringify(proposal)}));
`], { env: process.env, encoding: 'utf8' }).trim().split('\n').at(-1);
equal(fresh, planner.proposalDigest(proposal), 'fresh process digest is stable');

await rejectsCode(() => Promise.resolve().then(() => planner.parseOrganizationProposal({ ...proposal, nodes: proposal.nodes.map((node) => ({ ...node, phaseId: 'missing' })) })), planner.PLANNER_ERROR, 'unknown phase is rejected');
await rejectsCode(() => Promise.resolve().then(() => planner.parseOrganizationProposal({ ...proposal, phases: [{ ...proposal.phases[0], dependsOn: ['review'] }, proposal.phases[1]] })), planner.PLANNER_CYCLE, 'phase cycle is rejected');
await rejectsCode(() => Promise.resolve().then(() => planner.parseOrganizationProposal({ ...proposal, nodes: proposal.nodes.map((node) => ({ ...node, parentKey: node.stableKey })) })), planner.PLANNER_CYCLE, 'management self-cycle is rejected');
await rejectsCode(() => Promise.resolve().then(() => planner.parseOrganizationProposal({ ...proposal, nodes: proposal.nodes.filter((node) => node.role !== 'reviewer'), manages: [{ parentKey: 'lead', childKey: 'worker' }] })), planner.PLANNER_REVIEW_REQUIRED, 'missing independent reviewer is rejected');
await rejectsCode(() => Promise.resolve().then(() => planner.parseOrganizationProposal({ ...proposal, phases: proposal.phases.map((phase) => ({ ...phase, acceptance: [] })) })), planner.PLANNER_ACCEPTANCE_REQUIRED, 'empty phase acceptance is rejected');
await rejectsCode(() => planner.compileOrganizationProposal({ ...proposal, budget: { maxNodes: 2 } }, { profiles }), planner.PLANNER_BUDGET, 'over-budget proposal is rejected before resolver effects');
await rejectsCode(() => planner.compileOrganizationProposal({ ...proposal, nodes: proposal.nodes.map((node) => node.stableKey === 'worker' ? { ...node, agentId: 'unknown' } : node) }, { profiles }), planner.PLANNER_RESOLVER_REJECTED, 'unknown Agent is rejected');
const specialistProfile = { agentId: 'specialist-profile', role: 'specialist', canDelegate: false, capabilities: ['read', 'manage', 'review'], maxDepth: 1, maxChildren: 0, maxConcurrent: 1 };
const roleIndependent = await planner.compileOrganizationProposal({
  ...proposal,
  proposalId: 'proposal-role-independent',
  idempotencyKey: 'proposal-role-independent',
  nodes: proposal.nodes.map((node) => node.stableKey === 'lead' ? { ...node, agentId: 'specialist-profile' } : node),
}, { profiles: [...profiles, specialistProfile] });
const roleIndependentLead = roleIndependent.compiled.nodes.find((node) => node.stableKey === 'lead');
equal(roleIndependentLead.grant.canDelegate, true, 'Organization manager grant is independent of Agent profile role/canDelegate');
const managerProfile = { agentId: 'manager-profile', role: 'manager', canDelegate: true, capabilities: ['read'], maxDepth: 3, maxChildren: 4, maxConcurrent: 2 };
const workerRole = await planner.compileOrganizationProposal({
  ...proposal,
  proposalId: 'proposal-worker-role',
  idempotencyKey: 'proposal-worker-role',
  nodes: proposal.nodes.map((node) => node.stableKey === 'worker' ? { ...node, agentId: 'manager-profile' } : node),
}, { profiles: [...profiles, managerProfile] });
const workerRoleNode = workerRole.compiled.nodes.find((node) => node.stableKey === 'worker');
equal(workerRoleNode.grant.canDelegate, false, 'Organization worker grant cannot delegate even when profile canDelegate is true');
const reviewerNode = compiled.compiled.nodes.find((node) => node.stableKey === 'reviewer');
equal(reviewerNode.grant.accessMode, 'read_only', 'Reviewer grant is read-only');
equal(reviewerNode.grant.canWrite, false, 'Reviewer grant cannot write');
const amendment = planner.parsePlanAmendment({ baseRevision: 1, reason: 'replace stalled worker', idempotencyKey: 'amend-1', operations: [{ operation: 'replace', stableKey: 'worker', replacementKey: 'worker-2' }] });
equal(amendment.operations[0].operation, 'replace', 'amendment parser should support replacement');

console.log(`test-autonomous-organization-s21: ok (${assertions} assertions)`);
