#!/usr/bin/env node
import assert from 'assert/strict';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const capabilitiesUrl = new URL('../chat/organization-runtime-capabilities.mjs', import.meta.url).href;
const plannerUrl = new URL('../chat/organization-planner.mjs', import.meta.url).href;
const allFlags = [
  'RAGENT_ORG_SCHEMA_ENABLED',
  'RAGENT_COLLABORATION_LEADER_ENABLED',
  'RAGENT_ORG_AUTONOMOUS_LEADER_ENABLED',
  'RAGENT_ORG_AUTONOMOUS_PROVISIONING_ENABLED',
  'RAGENT_ORG_AUTONOMOUS_AUTO_PROVISIONING_ENABLED',
  'RAGENT_ORG_INTERNAL_ENVELOPE_ENABLED',
  'RAGENT_ORG_HIERARCHICAL_DELEGATION_ENABLED',
  'RAGENT_ORG_DYNAMIC_REPLAN_ENABLED',
  'RAGENT_ORG_STALL_GOVERNOR_ENABLED',
  'RAGENT_ORG_PROJECTION_V1_ENABLED',
  'RAGENT_ORG_PROJECTION_V2_ENABLED',
  'RAGENT_ORG_RECOVERY_V1_ENABLED',
  'RAGENT_MANAGED_INPUT_ENFORCEMENT',
  'RAGENT_MANAGED_WRITER_ENABLED',
  'RAGENT_REVIEWER_ENABLED',
  'RAGENT_ORG_SESSION_ADDRESSABILITY_ENABLED',
];

function probe(overrides, source) {
  const env = { ...process.env, ...overrides };
  for (const key of allFlags) {
    if (!(key in overrides)) delete env[key];
  }
  return execFileSync(process.execPath, ['--input-type=module', '--eval', source], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  }).trim().split('\n').at(-1);
}

const snapshotSource = `
  import { getOrganizationRuntimeCapabilities } from ${JSON.stringify(capabilitiesUrl)};
  console.log(JSON.stringify(getOrganizationRuntimeCapabilities({ publicOnly: true })));
`;
const allOff = JSON.parse(probe(Object.fromEntries(allFlags.map((key) => [key, '0'])), snapshotSource));
for (const [key, value] of Object.entries(allOff)) {
  if (typeof value === 'boolean') assert.equal(value, false, `${key} is false when its flag is disabled`);
}
assert.deepEqual(allOff.supportedModes, [], 'disabled runtime exposes no orchestration modes');

const allOn = JSON.parse(probe(Object.fromEntries(allFlags.map((key) => [key, '1'])), snapshotSource));
assert.equal(allOn.organizationProposal, true);
assert.equal(allOn.durableCollaboration, true);
assert.equal(allOn.automaticProvisioning, true);
assert.deepEqual(allOn.supportedModes, ['organization', 'collaboration']);
assert.equal(allOn.limits.maxNodes, 64);

const proposalSource = `
  import { compileOrganizationProposal } from ${JSON.stringify(plannerUrl)};
  const proposal = ${JSON.stringify({
    schemaVersion: 1,
    proposalId: 'capability-gate',
    idempotencyKey: 'capability-gate',
    objective: 'capability gate',
    nodes: [
      { stableKey: 'lead', role: 'manager', agentId: 'lead', capabilities: ['read'], phaseId: 'work', acceptance: [{ criterion: 'lead' }] },
      { stableKey: 'worker', role: 'specialist', agentId: 'worker', capabilities: ['read'], phaseId: 'work', parentKey: 'lead', acceptance: [{ criterion: 'worker' }] },
    ],
    phases: [{ phaseId: 'work', objective: 'work', acceptance: [{ criterion: 'done' }], reviewRequired: false }],
    manages: [{ parentKey: 'lead', childKey: 'worker' }],
    reviewPolicy: { required: false, minReviewers: 0, independent: false },
    acceptance: [{ criterion: 'done' }],
  })};
  try { await compileOrganizationProposal(proposal, { profiles: [
    { agentId: 'lead', role: 'manager', canDelegate: true, capabilities: ['read', 'manage'] },
    { agentId: 'worker', role: 'specialist', canDelegate: false, capabilities: ['read'] },
  ] }); console.log('OK'); }
  catch (error) { console.log(JSON.stringify({ code: error.code, reason: error.reason, capability: error.capability })); }
`;
const hierarchyOff = JSON.parse(probe({
  RAGENT_ORG_SCHEMA_ENABLED: '1',
  RAGENT_ORG_HIERARCHICAL_DELEGATION_ENABLED: '0',
}, proposalSource));
assert.equal(hierarchyOff.code, 'ORG_PLAN_CAPABILITY_DISABLED');
assert.equal(hierarchyOff.capability, 'hierarchicalDelegation');

console.log('test-organization-runtime-capabilities: ok');
