#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdirSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tempHome = mkdtempSync(join(tmpdir(), 'ragent-org-leader-'));
process.env.HOME = tempHome;
process.env.RAGENT_INSTANCE_ROOT = tempHome;
process.env.RAGENT_CONFIG_DIR = join(tempHome, 'config');
process.env.RAGENT_ORG_SCHEMA_ENABLED = '1';
process.env.RAGENT_ORG_AUTONOMOUS_LEADER_ENABLED = '1';
mkdirSync(join(tempHome, 'workspace'), { recursive: true });

const { createSession, getSession, killAll } = await import('../chat/session-manager.mjs');
const store = await import('../chat/organization-store.mjs');
const leader = await import('../chat/organization-leader-ingress.mjs');

const profiles = [
  { agentId: 'lead', role: 'manager', canDelegate: true, capabilities: ['read', 'manage', 'review'], maxDepth: 3, maxChildren: 4, maxConcurrent: 2 },
  { agentId: 'worker', role: 'worker', canDelegate: false, capabilities: ['read'], maxDepth: 2, maxChildren: 0, maxConcurrent: 1 },
  { agentId: 'reviewer', role: 'reviewer', canDelegate: false, capabilities: ['read', 'review'], maxDepth: 2, maxChildren: 0, maxConcurrent: 1 },
];

const proposal = {
  schemaVersion: 1,
  proposalId: 'proposal-ingress-1',
  idempotencyKey: 'proposal-ingress-key-1',
  objective: 'produce a bounded report',
  nodes: [
    { stableKey: 'lead', role: 'manager', agentId: 'lead', capabilities: ['read', 'manage', 'review'], phaseId: 'build', acceptance: [{ criterion: 'report exists' }] },
    { stableKey: 'worker', role: 'worker', agentId: 'worker', capabilities: ['read'], phaseId: 'build', parentKey: 'lead', dependsOn: ['lead'] },
    { stableKey: 'reviewer', role: 'reviewer', agentId: 'reviewer', capabilities: ['review'], phaseId: 'review', parentKey: 'lead', dependsOn: ['worker'] },
  ],
  phases: [
    { phaseId: 'build', objective: 'build the report', acceptance: [{ criterion: 'report exists' }], reviewerRoles: ['reviewer'] },
    { phaseId: 'review', objective: 'review the report', dependsOn: ['build'], acceptance: [{ criterion: 'review recorded' }], reviewerRoles: ['reviewer'] },
  ],
  manages: [
    { parentKey: 'lead', childKey: 'worker' },
    { parentKey: 'lead', childKey: 'reviewer' },
  ],
  reviewPolicy: { required: true, minReviewers: 1, independent: true },
  acceptance: [{ criterion: 'report delivered' }],
};

const root = await createSession(join(tempHome, 'workspace'), 'missing-tool', 'Root Leader ingress');
assert.equal(root.sessionClass, 'ROOT_LEADERSHIP');
assert.equal(leader.extractOrganizationProposal('plain reply'), null, 'ordinary replies do not trigger planning');

const marked = [
  leader.ORGANIZATION_PROPOSAL_START,
  '```json',
  JSON.stringify(proposal),
  '```',
  leader.ORGANIZATION_PROPOSAL_END,
].join('\n');
assert.deepEqual(leader.extractOrganizationProposal(marked), proposal, 'marked JSON proposal is extracted without surrounding prose');

const first = await leader.processRootLeadershipProposal({ session: root, assistantText: marked, profiles });
assert.equal(first.state, 'frozen');
assert.equal(first.revision, 1);
assert.equal(first.createdManagedSessions, undefined, 'proposal ingress does not claim managed Sessions without auto provisioning');
assert.equal(first.provisioning.skipped, 'auto_provisioning_disabled');
assert.ok(first.digest.startsWith('sha256:'));

const organization = await store.getOrganizationByRootSession(root.id);
assert.ok(organization?.id, 'organization is linked to the Root Session');
const frozen = await store.getRevision(organization.id, 1);
assert.equal(frozen.state, 'frozen');
assert.equal(frozen.digest, first.digest);
assert.equal(frozen.compiled.compilerVersion, 's21-v2');

const replay = await leader.processRootLeadershipProposal({ session: await getSession(root.id), assistantText: marked, profiles });
assert.equal(replay.state, 'frozen');
assert.equal(replay.revision, 1, 'same proposal key replays the frozen revision');
assert.equal((await store.listRevisions(organization.id)).length, 1, 'replay does not append a second revision');

const invalidRoot = await createSession(join(tempHome, 'workspace'), 'missing-tool', 'Invalid Root');
const invalid = await leader.processRootLeadershipProposal({
  session: invalidRoot,
  assistantText: `${leader.ORGANIZATION_PROPOSAL_START}{"objective":"bad"}${leader.ORGANIZATION_PROPOSAL_END}`,
  profiles,
});
assert.equal(invalid.state, 'rejected');
assert.equal(await store.getOrganizationByRootSession(invalidRoot.id), null, 'rejected proposal creates no organization');

const legacyApps = [{ id: 'legacy-visible-agent', name: 'Legacy visible Agent', tool: '' }];
const legacyProfiles = await leader.buildOrganizationAgentProfiles({
  apps: legacyApps,
  getTool: async () => null,
});
assert.ok(legacyProfiles.some((profile) => profile.agentId === 'legacy-visible-agent' && profile.role === 'specialist'), 'legacy Agent is visible as a specialist');
assert.equal(legacyProfiles.filter((profile) => profile.agentId === 'legacy-visible-agent').length, 1, 'legacy Agent is listed once without role aliases');
assert.equal(legacyProfiles[0].selectable, true, 'legacy Agent remains selectable as an Agent fact');
const rootContext = await leader.buildRootLeadershipTurnContext(root, {
  apps: legacyApps,
  getTool: async () => null,
});
assert.match(rootContext, /legacy-visible-agent/, 'Root prompt includes a legacy Agent without a policy');
assert.match(rootContext, /"roleSource": "default"/, 'Root prompt identifies the compatibility role projection');
assert.equal([...rootContext.matchAll(/legacy-visible-agent/g)].length, 1, 'Root prompt lists each Agent once and exposes role aliases as metadata');

const emptyRoot = await createSession(join(tempHome, 'workspace'), 'missing-tool', 'Empty Root');
const emptyProposal = await leader.processRootLeadershipProposal({
  session: emptyRoot,
  assistantText: marked,
  profiles: [],
});
assert.equal(emptyProposal.code, 'ORG_AGENT_CATALOG_EMPTY', 'empty Agent Catalog rejects Organization planning');
assert.equal(await store.getOrganizationByRootSession(emptyRoot.id), null, 'empty Catalog creates no Organization');
const emptyContext = await leader.buildRootLeadershipTurnContext(emptyRoot, {
  catalog: { schemaVersion: 1, state: 'empty', revision: 'sha256:empty', agents: [], errors: [] },
});
assert.match(emptyContext, /No selectable Agent is currently available/, 'empty Catalog tells Root to continue current Session');

await killAll();
console.log('test-organization-leader-ingress: ok');
