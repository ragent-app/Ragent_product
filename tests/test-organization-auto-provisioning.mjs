#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdirSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tempHome = mkdtempSync(join(tmpdir(), 'ragent-org-auto-provision-'));
process.env.HOME = tempHome;
process.env.RAGENT_INSTANCE_ROOT = tempHome;
process.env.RAGENT_CONFIG_DIR = join(tempHome, 'config');
process.env.RAGENT_ORG_SCHEMA_ENABLED = '1';
process.env.RAGENT_ORG_AUTONOMOUS_LEADER_ENABLED = '1';
process.env.RAGENT_ORG_AUTONOMOUS_PROVISIONING_ENABLED = '1';
process.env.RAGENT_ORG_AUTONOMOUS_AUTO_PROVISIONING_ENABLED = '1';
mkdirSync(join(tempHome, 'workspace'), { recursive: true });

const { createSession, killAll } = await import('../chat/session-manager.mjs');
const store = await import('../chat/organization-store.mjs');
const leader = await import('../chat/organization-leader-ingress.mjs');

const profiles = [
  { agentId: 'lead', role: 'manager', canDelegate: true, capabilities: ['read', 'manage'], maxDepth: 3, maxChildren: 4, maxConcurrent: 2 },
  { agentId: 'worker', role: 'specialist', canDelegate: false, capabilities: ['read'], maxDepth: 2, maxChildren: 0, maxConcurrent: 1 },
];
const proposal = {
  schemaVersion: 1,
  proposalId: 'auto-provision-1',
  idempotencyKey: 'auto-provision-key',
  objective: 'run one bounded worker',
  nodes: [
    { stableKey: 'lead', role: 'manager', agentId: 'lead', capabilities: ['read', 'manage'], phaseId: 'work', acceptance: [{ criterion: 'worker exists' }] },
    { stableKey: 'worker', role: 'specialist', agentId: 'worker', capabilities: ['read'], phaseId: 'work', parentKey: 'lead', dependsOn: ['lead'] },
  ],
  phases: [{ phaseId: 'work', objective: 'do work', acceptance: [{ criterion: 'work complete' }], reviewerRoles: ['manager'] }],
  manages: [{ parentKey: 'lead', childKey: 'worker' }],
  reviewPolicy: { required: false, minReviewers: 0, independent: false },
  acceptance: [{ criterion: 'result returned' }],
};
const marked = `${leader.ORGANIZATION_PROPOSAL_START}${JSON.stringify(proposal)}${leader.ORGANIZATION_PROPOSAL_END}`;
const root = await createSession(join(tempHome, 'workspace'), 'missing-tool', 'Auto provisioning root');

const calls = [];
const provisionRevision = async (input) => {
  calls.push(input);
  return {
    attempted: true,
    state: 'provisioned',
    organizationId: input.organizationId,
    revision: input.revision,
    createdManagedSessions: 2,
    sessions: [{ sessionId: 'managed-1' }, { sessionId: 'managed-2' }],
  };
};
const first = await leader.processRootLeadershipProposal({
  session: root,
  assistantText: marked,
  profiles,
  provisionRevision,
  createManagedSession: async () => ({ sessionId: 'unused' }),
});
assert.equal(first.state, 'frozen');
assert.equal(first.provisioning.state, 'provisioned');
assert.equal(first.createdManagedSessions, 2);
assert.equal(calls.length, 1);
assert.equal(calls[0].revision, 1);
assert.match(calls[0].idempotencyKey, /^leader:/);

const replay = await leader.processRootLeadershipProposal({
  session: root,
  assistantText: marked,
  profiles,
  provisionRevision,
});
assert.equal(replay.revision, 1);
assert.equal(replay.provisioning.state, 'provisioned');
assert.equal((await store.listRevisions(first.organizationId)).length, 1, 'replay keeps one frozen revision');

const failingRoot = await createSession(join(tempHome, 'workspace'), 'missing-tool', 'Auto provisioning failure root');
const failing = await leader.processRootLeadershipProposal({
  session: failingRoot,
  assistantText: marked.replaceAll('auto-provision-1', 'auto-provision-failure').replaceAll('auto-provision-key', 'auto-provision-failure-key'),
  profiles,
  provisionRevision: async () => {
    const error = new Error('factory unavailable');
    error.code = 'ORG_PROVISIONING_FACTORY_REQUIRED';
    throw error;
  },
});
assert.equal(failing.state, 'frozen', 'provisioning failure preserves the frozen revision');
assert.equal(failing.provisioning.state, 'failed');
assert.equal(failing.provisioning.code, 'ORG_PROVISIONING_FACTORY_REQUIRED');
assert.equal(failing.createdManagedSessions, undefined, 'failure does not claim a session count');
const failingOrg = await store.getOrganizationByRootSession(failingRoot.id);
assert.equal((await store.getRevision(failingOrg.id, failing.revision)).state, 'frozen');

await killAll();
console.log('test-organization-auto-provisioning: ok');
