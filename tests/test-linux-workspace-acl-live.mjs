import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
