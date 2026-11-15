#!/usr/bin/env node
import assert from 'assert/strict';
import { readFile } from 'fs/promises';
import { join } from 'path';
import {
  buildOrganizationRolePrompt,
  buildOrganizationRoleTurnContext,
  organizationRoleForSession,
} from '../chat/organization-role-prompts.mjs';
import { extractDelegationResult, normalizeDelegationResult } from '../chat/delegation-result.mjs';

assert.equal(organizationRoleForSession({ sessionClass: 'ROOT_LEADERSHIP' }), 'ROOT');
assert.equal(organizationRoleForSession({ sessionClass: 'MANAGER' }), 'MANAGER');
assert.equal(organizationRoleForSession({ sessionClass: 'WORKER' }), 'WORKER');
assert.equal(organizationRoleForSession({ sessionClass: 'REVIEWER' }), 'REVIEWER');

const rootPrompt = buildOrganizationRolePrompt({ role: 'ROOT' });
assert.match(rootPrompt, /final synthesis/);
assert.match(rootPrompt, /Frozen Revision/);
assert.match(rootPrompt, /ragent-result-packet/);

const managerPrompt = buildOrganizationRolePrompt({ role: 'MANAGER' });
assert.match(managerPrompt, /Runtime-granted subtree/);
assert.match(managerPrompt, /bounded child result packets/);

const workerPrompt = buildOrganizationRoleTurnContext({ sessionClass: 'WORKER' });
assert.match(workerPrompt, /assigned task/);
assert.match(workerPrompt, /Do not delegate further/);
assert.match(workerPrompt, /state.*completed \| failed \| blocked \| waiting/);

const reviewerPrompt = buildOrganizationRolePrompt({ role: 'REVIEWER' });
assert.match(reviewerPrompt, /independent certified read-only reviewer/);
assert.match(reviewerPrompt, /PASS, NEEDS_CHANGES, or BLOCKED/);
assert.match(reviewerPrompt, /Do not write/);

assert.equal(buildOrganizationRolePrompt({ role: 'unknown' }), '');

const fixture = JSON.parse(await readFile(join(process.cwd(), 'tests/fixtures/bounded-result-packet.json'), 'utf8'));
const packet = normalizeDelegationResult(fixture);
const marked = `<ragent-result-packet>${JSON.stringify(packet)}</ragent-result-packet>`;
assert.deepEqual(extractDelegationResult(marked), packet);

console.log('test-organization-role-prompts: ok');
