#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createProjectBootstrap } from '../chat/project-bootstrap.mjs';

const root = await mkdtemp(join(tmpdir(), 'ragent-project-bootstrap-'));
try {
  const parentRoot = join(root, 'managed');
  const databasePath = join(root, 'bootstrap.sqlite');
  const projects = [];
  let createCount = 0;
  let indexRevision = 'index-1';
  let failAfterRegistration = false;
  const dependencies = {
    databasePath, parentRoot,
    getInstanceIdentity: async () => ({ instanceId: 'pc-1' }),
    projectIndex: { refresh: async () => ({
      targetInstanceId: 'pc-1', indexRevision, inventoryComplete: true, truncated: false,
    }) },
    listProjects: async () => projects,
    createProject: async (payload) => {
      createCount += 1;
      const project = { id: `prj_${createCount}`, ...payload };
      projects.push(project);
      if (failAfterRegistration) {
        failAfterRegistration = false;
        throw new Error('simulated reply loss after Project record');
      }
      return project;
    },
  };
  const bootstrap = createProjectBootstrap(dependencies);
  const plan = {
    operationId: 'intake-1', decisionId: 'decision-1', inputDigest: 'a'.repeat(64),
    targetInstanceId: 'pc-1', indexRevision,
    newProject: { name: '家庭账单', purpose: '整理每月账单', projectType: 'document' },
    userRequirement: '每月汇总并标出异常。', sourceRefs: ['shared-file:bill.pdf'],
  };
  const first = await bootstrap.ensureForIntake(plan);
  assert.equal(first.stage, 'completed');
  assert.equal(first.projectId, 'prj_1');
  assert.equal(createCount, 1);
  assert.match(await readFile(join(first.directory, 'INTAKE.md'), 'utf8'), /每月汇总并标出异常/);
  assert.equal((await bootstrap.ensureForIntake(plan)).projectId, first.projectId);
  assert.equal(createCount, 1, 'replay must return the same Project');
  await assert.rejects(() => bootstrap.ensureForIntake({ ...plan, newProject: { ...plan.newProject, purpose: 'a different goal' } }),
    (error) => error.code === 'PROJECT_OPERATION_CONFLICT');

  indexRevision = 'index-2';
  const stalePlan = { ...plan, operationId: 'intake-2' };
  await assert.rejects(() => bootstrap.ensureForIntake(stalePlan),
    (error) => error.code === 'PROJECT_INDEX_CHANGED', 'a competing creation invalidates old inventory');
  assert.equal((await readdir(parentRoot)).length, 1, 'stale creation has no directory effect');

  const crashPlan = { ...plan, operationId: 'intake-3', indexRevision };
  failAfterRegistration = true;
  await assert.rejects(() => bootstrap.ensureForIntake(crashPlan), /simulated reply loss/);
  const interrupted = await bootstrap.receipt(crashPlan.operationId);
  assert.equal(interrupted.stage, 'directory_ready');
  assert.equal(projects.length, 2, 'Project record was written before reply loss');
  await writeFile(join(interrupted.directory, 'INTAKE.md'), 'kept user edits');
  const reopened = createProjectBootstrap(dependencies);
  const recovered = await reopened.ensureForIntake(crashPlan);
  assert.equal(recovered.stage, 'completed');
  assert.equal(recovered.projectId, 'prj_2');
  assert.equal(createCount, 2, 'recovery must find the original creation operation');
  assert.equal(await readFile(join(recovered.directory, 'INTAKE.md'), 'utf8'), 'kept user edits');
  assert.equal((await readdir(parentRoot)).length, 2);
  await unlink(join(recovered.directory, '.ragent-intake.json'));
  await assert.rejects(() => reopened.ensureForIntake(crashPlan),
    (error) => error.code === 'PROJECT_PATH_CONFLICT', 'a completed receipt must recheck directory ownership');
  console.log('test-project-bootstrap: ok');
} finally {
  await rm(root, { recursive: true, force: true });
}
