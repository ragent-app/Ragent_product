#!/usr/bin/env node
import assert from 'node:assert/strict';
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildGrantPlan,
  createRunnerWorkspaceCleanupSweep,
  grantRunnerWorkspaceAccess,
  listRunnerWorkspaceAccess,
  normalizeRunId,
  revokeRunnerWorkspaceAccess,
  runnerAccessGroupForRun,
  validateWorkspaceScope,
} from '../scripts/runner-workspace-access.mjs';

const root = await mkdtemp(join(tmpdir(), 'agentoc-runner-access-'));
const workspace = join(root, 'workspace');
const sub = join(workspace, 'sub');
await mkdir(sub, { recursive: true });
await writeFile(join(sub, 'file.txt'), 'x');
await writeFile(join(sub, 'script.sh'), '#!/bin/sh\n');
await chmod(join(sub, 'script.sh'), 0o755);
const accessRoot = join(root, 'state');

// A mock execFile that records every ACL/group/find invocation.  The helper is
// a pure orchestrator: the real commands need root + the `acl` package, so
// asserting the exact argv we would hand them is the meaningful unit boundary.
const calls = [];
const execImpl = async (command, args, options) => {
  calls.push({ command, args, options });
  return { stdout: '', stderr: '' };
};

try {
  // ── normalizeRunId / runnerAccessGroupForRun ──────────────────────────────
  assert.equal(normalizeRunId('run_abc12345'), 'run_abc12345');
  assert.equal(normalizeRunId(' run_abc12345 '), 'run_abc12345');
  assert.equal(normalizeRunId('not-a-run'), '');
  assert.equal(normalizeRunId('run_short'), '');
  const group = runnerAccessGroupForRun('run_abc12345');
  assert.match(group, /^aor-[a-f0-9]{16}$/);
  assert.equal(group, runnerAccessGroupForRun('run_abc12345'));
  assert.notEqual(group, runnerAccessGroupForRun('run_abc12346'));
  assert.throws(() => runnerAccessGroupForRun('nope'), /Invalid Run id/);

  // A broker crash can leave the directory lock behind. A dead owner marker
  // is recoverable; a live owner is still waited on by withLock.
  const staleLockRoot = join(root, 'stale-lock');
  await mkdir(join(staleLockRoot, '.lock'), { recursive: true });
  await writeFile(join(staleLockRoot, '.lock', 'owner.json'), '{"pid":99999999}\n');
  await grantRunnerWorkspaceAccess({
    runId: 'run_stale1234',
    cwd: sub,
    workspaceRoot: workspace,
    accessRoot: staleLockRoot,
    execImpl,
  });

  // ── buildGrantPlan ────────────────────────────────────────────────────────
  const plan = buildGrantPlan({ runId: 'run_abc12345', cwd: sub, workspaceRoot: workspace, group });
  assert.equal(plan.grantRoot, sub);
  assert.ok(plan.ancestors.includes(workspace), 'the parent workspace is a traverse ancestor');
  assert.ok(!plan.ancestors.includes('/'), 'the root is never granted an ACL');
  assert.throws(
    () => buildGrantPlan({ runId: 'run_abc12345', cwd: '/tmp/outside', workspaceRoot: workspace, group }),
    /escapes its recorded workspace root/,
  );

  // ── validateWorkspaceScope guards ─────────────────────────────────────────
  // Protected control-plane subtrees must never receive a temporary group ACL.
  const fakeStats = async () => ({ isDirectory: () => true });
  for (const protectedPath of [
    '/var/lib/agentoc/config',
    '/var/lib/agentoc/memory',
    '/var/lib/agentoc/retired',
    '/opt/agentoc/app',
    '/etc/agentoc',
    '/var/log/agentoc',
  ]) {
    await assert.rejects(
      () => validateWorkspaceScope({
        cwd: join(protectedPath, 'x'),
        workspaceRoot: join(protectedPath, 'x'),
        realpathImpl: async (p) => p,
        statImpl: fakeStats,
      }),
      /Refusing temporary runner access for protected workspace/,
      `must refuse ${protectedPath}`,
    );
  }
  for (const sensitivePath of [
    '/home/example/.codex',
    '/home/example/.ssh/project',
    '/home/example/.gnupg',
    '/home/example/.aws',
    '/home/example/.config/agentoc',
    '/home/example/.config/claude',
  ]) {
    await assert.rejects(
      () => validateWorkspaceScope({
        cwd: sensitivePath,
        workspaceRoot: sensitivePath,
        realpathImpl: async (p) => p,
        statImpl: fakeStats,
      }),
      /Refusing temporary runner access for protected workspace/,
      `must refuse ${sensitivePath}`,
    );
  }
  await assert.rejects(
    () => validateWorkspaceScope({
      cwd: '/tmp/file-not-a-dir',
      workspaceRoot: '/tmp',
      realpathImpl: async (p) => p,
      statImpl: async () => ({ isDirectory: () => false }),
    }),
    /not a directory/,
  );
  await assert.rejects(
    () => validateWorkspaceScope({
      cwd: '/tmp/escapes',
      workspaceRoot: '/var/lib/agentoc/workspace',
      realpathImpl: async (p) => p,
      statImpl: fakeStats,
    }),
    /escapes its recorded workspace root/,
  );

  // ── grant → revoke round trip ─────────────────────────────────────────────
  const granted = await grantRunnerWorkspaceAccess({
    runId: 'run_abc12345',
    cwd: sub,
    workspaceRoot: workspace,
    accessRoot,
    execImpl,
  });
  assert.equal(granted.group, group);

  const groupAddCall = calls.find((call) => call.args.includes('--system') && call.args.includes(group));
  assert.ok(groupAddCall, 'a temporary system group is created');
  assert.equal(groupAddCall.command, '/usr/sbin/groupadd');
  assert.deepEqual(groupAddCall.args.slice(0, 3), ['--system', '--force', group]);

  const traverseAcl = calls.find(
    (call) => call.args[0] === '-m' && call.args[1] === `g:${group}:--x`,
  );
  assert.ok(traverseAcl, 'ancestor directories get a traverse-only ACL');
  assert.ok(traverseAcl.args.slice(2).includes(workspace), 'the workspace parent is in the traverse ACL');

  const dirAcl = calls.find((call) => call.args.includes(`g:${group}:rwx,d:g:${group}:rwx`));
  assert.ok(dirAcl, 'directories under the cwd get rwx + default ACLs');
  assert.equal(dirAcl.args[0], sub, 'the find is rooted at the immutable execution cwd');

  const executableAcl = calls.find(
    (call) => call.command === '/usr/bin/find'
      && call.args.includes('-perm')
      && call.args.includes('/111')
      && call.args.includes(`g:${group}:rwx`),
  );
  assert.ok(executableAcl, 'existing executable files get read-write-execute ACLs');
  assert.ok(executableAcl.args.includes('-type') && executableAcl.args.includes('f'));
  assert.ok(
    !executableAcl.args.includes(`g:${group}:rw-`),
    'executable classification must not use the non-executable profile',
  );
  const findCalls = calls.filter((call) => call.command === '/usr/bin/find');
  assert.ok(findCalls.length >= 3, 'workspace grant should issue the ACL find passes');
  assert.ok(
    findCalls.every((call) => call.options?.timeout <= 30_000),
    'optional workspace ACL scans must stay below the lifecycle launch budget',
  );

  const fileAcl = calls.find(
    (call) => call.command === '/usr/bin/find'
      && call.args.includes('!')
      && call.args.includes('/111')
      && call.args.includes(`g:${group}:rw-`),
  );
  assert.ok(fileAcl, 'non-executable files under the cwd get rw ACLs');

  // State is durable so ExecStopPost (a separate process) can revoke later.
  await access(join(accessRoot, 'run_abc12345.json'));
  assert.deepEqual(await listRunnerWorkspaceAccess({ accessRoot }), ['run_abc12345']);

  const revoked = await revokeRunnerWorkspaceAccess({ runId: 'run_abc12345', accessRoot, execImpl });
  assert.equal(revoked.revoked, true);
  assert.equal(revoked.group, group);

  const removeDirAcl = calls.find(
    (call) => call.args.includes(`d:g:${group}`) && call.args.includes('-x'),
  );
  assert.ok(removeDirAcl, 'default (d:g:) ACL entries are removed');
  const groupDelCall = calls.find((call) => call.command === '/usr/sbin/groupdel');
  assert.equal(groupDelCall?.args[0], group, 'the one-Run group is deleted on revoke');
  await assert.rejects(
    () => access(join(accessRoot, 'run_abc12345.json')),
    /ENOENT/,
    'state is removed after revoke',
  );
  assert.deepEqual(await listRunnerWorkspaceAccess({ accessRoot }), []);

  // Revoking twice is idempotent (ExecStopPost may race with a manual sweep).
  const again = await revokeRunnerWorkspaceAccess({ runId: 'run_abc12345', accessRoot, execImpl });
  assert.deepEqual(again, { runId: 'run_abc12345', revoked: false });

  // Two launch generations in the same workspace share the ACL group but own
  // independent state references. Rolling back the newer attempt must retain
  // the group and ACLs until the predecessor's ExecStopPost also releases it.
  const groupDeleteCountBeforeReferences = calls.filter((call) => call.command === '/usr/sbin/groupdel').length;
  const generationOne = await grantRunnerWorkspaceAccess({
    runId: 'run_generation_a1',
    cwd: sub,
    workspaceRoot: workspace,
    accessRoot,
    execImpl,
  });
  const generationTwo = await grantRunnerWorkspaceAccess({
    runId: 'run_generation_a2',
    cwd: sub,
    workspaceRoot: workspace,
    accessRoot,
    execImpl,
  });
  assert.equal(generationTwo.group, generationOne.group);
  await revokeRunnerWorkspaceAccess({ runId: 'run_generation_a2', accessRoot, execImpl });
  assert.equal(
    calls.filter((call) => call.command === '/usr/sbin/groupdel').length,
    groupDeleteCountBeforeReferences,
    'releasing one launch generation must not delete a group retained by another generation',
  );
  assert.deepEqual((await listRunnerWorkspaceAccess({ accessRoot })).sort(), ['run_generation_a1', 'run_generation_a2']);
  await revokeRunnerWorkspaceAccess({ runId: 'run_generation_a1', accessRoot, execImpl });
  assert.equal(
    calls.filter((call) => call.command === '/usr/sbin/groupdel').length,
    groupDeleteCountBeforeReferences + 1,
    'the final generation release removes the shared group',
  );
  const sibling = join(workspace, 'sibling');
  await mkdir(sibling);
  const siblingA = await grantRunnerWorkspaceAccess({ runId: 'run_siblingone1', cwd: sub, workspaceRoot: workspace, accessRoot, execImpl });
  const siblingB = await grantRunnerWorkspaceAccess({ runId: 'run_siblingtwo2', cwd: sibling, workspaceRoot: workspace, accessRoot, execImpl });
  assert.notEqual(siblingA.group, siblingB.group, 'different grant roots require separate ACL groups');
  await revokeRunnerWorkspaceAccess({ runId: 'run_siblingone1', accessRoot, execImpl });
  await revokeRunnerWorkspaceAccess({ runId: 'run_siblingtwo2', accessRoot, execImpl });
  // Older versions could share one group across different grant roots. Keep
  // every released reference until the final release can clean both roots.
  const oldA = await grantRunnerWorkspaceAccess({ runId: 'run_legacyroot1', cwd: sub, workspaceRoot: workspace, accessRoot, execImpl });
  await grantRunnerWorkspaceAccess({ runId: 'run_legacyroot2', cwd: sibling, workspaceRoot: workspace, accessRoot, execImpl });
  const oldBPath = join(accessRoot, 'run_legacyroot2.json');
  const oldB = JSON.parse(await readFile(oldBPath, 'utf8'));
  await writeFile(oldBPath, JSON.stringify({ ...oldB, group: oldA.group }));
  await revokeRunnerWorkspaceAccess({ runId: 'run_legacyroot1', accessRoot, execImpl });
  const legacyStart = calls.length;
  await revokeRunnerWorkspaceAccess({ runId: 'run_legacyroot2', accessRoot, execImpl });
  const legacyFindRoots = calls.slice(legacyStart).filter(call => call.command === '/usr/bin/find').map(call => call.args[0]);
  assert.ok(legacyFindRoots.includes(sub) && legacyFindRoots.includes(sibling));

  const corruptRun = 'run_corruptref1';
  await grantRunnerWorkspaceAccess({ runId: corruptRun, cwd: sub, workspaceRoot: workspace, accessRoot, execImpl });
  const malformed = join(accessRoot, 'run_corruptref2.json');
  await writeFile(malformed, '{');
  const beforeCorrupt = calls.filter(call => call.command === '/usr/sbin/groupdel').length;
  await assert.rejects(revokeRunnerWorkspaceAccess({ runId: corruptRun, accessRoot, execImpl }));
  assert.equal(calls.filter(call => call.command === '/usr/sbin/groupdel').length, beforeCorrupt);
  await rm(malformed);
  await revokeRunnerWorkspaceAccess({ runId: corruptRun, accessRoot, execImpl });

  // A failed cleanup must retain both the group and retryable state: deleting
  // the group could allow its numeric GID to be reused while ACLs remain.
  // Only the ACL/find steps fail — groupadd succeeds, so the rollback has a
  // real group and a written state record to unwind.
  const failCalls = [];
  const failingExec = async (command, args) => {
    failCalls.push({ command, args });
    if (command === '/usr/sbin/setfacl' || command === '/usr/bin/find') {
      const error = new Error(`${command}: Operation not supported`);
      error.code = 'EOPNOTSUPP';
      throw error;
    }
    return { stdout: '', stderr: '' };
  };
  await assert.rejects(
    () => grantRunnerWorkspaceAccess({
      runId: 'run_def67890',
      cwd: sub,
      workspaceRoot: workspace,
      accessRoot: join(root, 'state2'),
      execImpl: failingExec,
    }),
    /Failed to grant runner workspace access/,
  );
  assert.ok(
    failCalls.some((call) => call.args.includes('--system')),
    'the group was created before the failing ACL step',
  );
  assert.equal(failCalls.some((call) => call.command === '/usr/sbin/groupdel'), false);
  await access(join(root, 'state2', 'run_def67890.json'));
  await revokeRunnerWorkspaceAccess({ runId: 'run_def67890', accessRoot: join(root, 'state2'), execImpl });
  await assert.rejects(access(join(root, 'state2', 'run_def67890.json')), { code: 'ENOENT' });

  const failureRun = 'run_cleanupretry';
  await grantRunnerWorkspaceAccess({ runId: failureRun, cwd: sub, workspaceRoot: workspace, accessRoot, execImpl });
  const beforeFailure = calls.filter((call) => call.command === '/usr/sbin/groupdel').length;
  await assert.rejects(revokeRunnerWorkspaceAccess({ runId: failureRun, accessRoot, execImpl: failingExec }));
  assert.equal(calls.filter((call) => call.command === '/usr/sbin/groupdel').length, beforeFailure);
  await access(join(accessRoot, `${failureRun}.json`));
  await assert.rejects(grantRunnerWorkspaceAccess({ runId: failureRun, cwd: sub, workspaceRoot: workspace, accessRoot, execImpl }), /cleanup is pending/);
  await revokeRunnerWorkspaceAccess({ runId: failureRun, accessRoot, execImpl });
  await assert.rejects(access(join(accessRoot, `${failureRun}.json`)), { code: 'ENOENT' });

  const groupFailureRun = 'run_groupdelretry';
  await grantRunnerWorkspaceAccess({ runId: groupFailureRun, cwd: sub, workspaceRoot: workspace, accessRoot, execImpl });
  const failGroupDelete = async (command, args, options) => {
    if (command === '/usr/sbin/groupdel') throw new Error('group database unavailable');
    return execImpl(command, args, options);
  };
  await assert.rejects(revokeRunnerWorkspaceAccess({ runId: groupFailureRun, accessRoot, execImpl: failGroupDelete }));
  const afterCleanup = JSON.parse(await readFile(join(accessRoot, `${groupFailureRun}.json`), 'utf8'));
  assert.equal(afterCleanup.cleanupComplete, true);
  const priorFinds = calls.filter((call) => call.command === '/usr/bin/find').length;
  const sweep = createRunnerWorkspaceCleanupSweep({ accessRoot, execImpl });
  assert.deepEqual(await sweep(), { attempted: 1, failed: 0 });
  await assert.rejects(access(join(accessRoot, `${groupFailureRun}.json`)), { code: 'ENOENT' });
  assert.equal(calls.filter((call) => call.command === '/usr/bin/find').length, priorFinds);

  console.log('test-runner-workspace-access: PASS');
} finally {
  await rm(root, { recursive: true, force: true });
}
