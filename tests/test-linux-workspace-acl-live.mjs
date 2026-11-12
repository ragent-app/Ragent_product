import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { createRunnerWorkspaceCleanupSweep, grantRunnerWorkspaceAccess, revokeRunnerWorkspaceAccess,
  runnerAccessGroupForRun } from '../scripts/runner-workspace-access.mjs';

const exec = promisify(execFile);
test('real ACL cleanup retains its group on failure and retries safely',
  { skip: process.platform !== 'linux' || process.geteuid?.() !== 0 }, async () => {
    const root = await mkdtemp('/srv/agentoc-acl-cleanup-test-');
    const workspace = `${root}/workspace`, accessRoot = `${root}/state`;
    const runId = `run_aclqa_${randomBytes(8).toString('hex')}`, group = runnerAccessGroupForRun(runId);
    let granted = false, cleaned = false;
    try {
      await assert.rejects(exec('/usr/bin/getent', ['group', group]));
      await mkdir(workspace, { mode: 0o700 });
      await writeFile(`${workspace}/file.txt`, 'fixture');
      const grant = await grantRunnerWorkspaceAccess({ runId, cwd: workspace, workspaceRoot: workspace, accessRoot });
      granted = true;
      assert.equal(grant.group, group);
      assert.match((await exec('/usr/bin/getfacl', ['-cp', workspace])).stdout, new RegExp(`group:${group}:`));
      const failRemoval = async (command, args, options) => {
        if (command === '/usr/bin/find' && args.includes('-x')) throw new Error('simulated cleanup failure');
        return exec(command, args, options);
      };
      await assert.rejects(revokeRunnerWorkspaceAccess({ runId, accessRoot, execImpl: failRemoval }), /simulated cleanup failure/);
      await access(`${accessRoot}/${runId}.json`);
      await exec('/usr/bin/getent', ['group', group]);
      assert.match((await exec('/usr/bin/getfacl', ['-cp', workspace])).stdout, new RegExp(`group:${group}:`));
      assert.deepEqual(await createRunnerWorkspaceCleanupSweep({ accessRoot })(), { attempted: 1, failed: 0 });
      await assert.rejects(exec('/usr/bin/getent', ['group', group]));
      await assert.rejects(access(`${accessRoot}/${runId}.json`), { code: 'ENOENT' });
      assert.doesNotMatch((await exec('/usr/bin/getfacl', ['-cp', workspace])).stdout, new RegExp(`group:${group}:`));
      cleaned = true;
    } finally {
      if (granted && !cleaned) {
        try { await revokeRunnerWorkspaceAccess({ runId, accessRoot }); cleaned = true; }
        catch (error) { console.error(`Retaining ${root} and group ${group} for cleanup: ${error.message}`); }
      }
      if (!granted || cleaned) await rm(root, { recursive: true, force: true });
    }
  });

test('legacy records migrate safely and a prior boot is recovered',
  { skip: process.platform !== 'linux' || process.geteuid?.() !== 0 }, async () => {
    const root = await mkdtemp('/srv/agentoc-acl-migration-test-');
    const workspace = `${root}/workspace`, legacyRoot = `${root}/legacy`, accessRoot = `${root}/persistent`;
    const runId = `run_aclboot_${randomBytes(8).toString('hex')}`, group = runnerAccessGroupForRun(runId);
    const oldBoot = '11111111-1111-4111-8111-111111111111';
    const newBoot = '22222222-2222-4222-8222-222222222222';
    let granted = false, cleaned = false;
    try {
      await mkdir(workspace, { mode: 0o700 });
      await grantRunnerWorkspaceAccess({ runId, cwd: workspace, workspaceRoot: workspace,
        accessRoot: legacyRoot, bootIdImpl: async () => oldBoot });
      granted = true;
      const sameBoot = createRunnerWorkspaceCleanupSweep({ accessRoot, legacyRoot, bootIdImpl: async () => oldBoot });
      assert.deepEqual(await sameBoot(), { attempted: 0, failed: 0 });
      await assert.rejects(access(`${legacyRoot}/${runId}.json`), { code: 'ENOENT' });
      const saved = JSON.parse(await readFile(`${accessRoot}/${runId}.json`, 'utf8'));
      assert.equal(saved.bootId, oldBoot);
      await exec('/usr/bin/getent', ['group', group]);
      // Conflicting copies are never guessed or silently overwritten.
      await writeFile(`${legacyRoot}/${runId}.json`, JSON.stringify({ ...saved, bootId: newBoot }), { mode: 0o600 });
      await assert.rejects(sameBoot(), /Conflicting workspace access migration state/);
      await exec('/usr/bin/getent', ['group', group]);
      await rm(`${legacyRoot}/${runId}.json`);
      const moduleUrl = new URL('../scripts/runner-workspace-access.mjs', import.meta.url).href;
      const source = `import { createRunnerWorkspaceCleanupSweep } from ${JSON.stringify(moduleUrl)};
        const [accessRoot, legacyRoot, boot] = process.argv.slice(1);
        console.log(JSON.stringify(await createRunnerWorkspaceCleanupSweep({ accessRoot, legacyRoot, bootIdImpl: async () => boot })()));`;
      const child = await exec(process.execPath, ['--input-type=module', '-e', source, accessRoot, legacyRoot, newBoot]);
      assert.deepEqual(JSON.parse(child.stdout), { attempted: 1, failed: 0 });
      await assert.rejects(exec('/usr/bin/getent', ['group', group]));
      await assert.rejects(access(`${accessRoot}/${runId}.json`), { code: 'ENOENT' });
      cleaned = true;
    } finally {
      if (granted && !cleaned) {
        try {
          // The fixture may fail before migration. Only discard the injected
          // legacy conflict if a durable copy has already been published.
          try {
            await access(`${accessRoot}/${runId}.json`);
            await rm(`${legacyRoot}/${runId}.json`, { force: true });
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
          await revokeRunnerWorkspaceAccess({ runId, accessRoot, legacyRoot });
          await assert.rejects(exec('/usr/bin/getent', ['group', group]));
          cleaned = true;
        } catch (error) { console.error(`Retaining ${root} and group ${group} for cleanup: ${error.message}`); }
      }
      if (!granted || cleaned) await rm(root, { recursive: true, force: true });
    }
  });
