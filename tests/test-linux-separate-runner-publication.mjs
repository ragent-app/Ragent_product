// Integration test for durable publication across two real Linux identities.
// Run as root on an isolated QA host with ubuntu and agentoc-runner accounts.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, chown, mkdtemp, mkdir, readFile, rm, symlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { grantExistingRunnerFiles } from '../lib/linux-runner-file-access.mjs';

const role = process.argv[2];
if (role) {
  const runs = await import('../chat/runs.mjs');
  const runId = 'run_scopedaclfixture';
  if (role === 'create') {
    await runs.createRun({ status:{ id:runId, sessionId:'acl-session', requestId:'acl-request', state:'accepted' },
      manifest:{ sessionId:'acl-session', requestId:'acl-request', options:{ sessionControlChannel:{
        token:'fixture-token', renewalToken:'fixture-renewal', runId, sessionId:'acl-session', turnId:'acl-request', version:1,
      } }, preparation:{ version:1, text:'fixture', options:{} } } });
  } else if (role === 'runner') {
    assert.equal((await runs.getRunAcceptanceEvidence(runId)).id, runId);
    assert.equal(await runs.readRunSessionControlToken(runId), 'fixture-token');
    await runs.updateRun(runId, { state:'running' });
  } else if (role === 'control') {
    assert.equal((await runs.getRunAcceptanceEvidence(runId)).state, 'running');
    await runs.updateRun(runId, { state:'completed' });
    assert.equal((await runs.getRunAcceptanceEvidence(runId)).state, 'completed');
  } else throw new Error('Unknown test role');
  process.exit(0);
}
if (process.platform !== 'linux' || process.getuid?.() !== 0) {
  console.log('Separate Linux identity integration requires root; skipped'); process.exit(0);
}
const getent = name => {
  const fields = execFileSync('/usr/bin/getent', ['passwd', name], {encoding:'utf8'}).trim().split(':');
  return {uid:Number(fields[2]),gid:Number(fields[3])};
};
const owner = getent('ubuntu');
const runner = getent('agentoc-runner');
const base = await mkdtemp('/tmp/agentoc-scoped-acl-');
const spool = join(base, 'spool');
try {
  await chown(base, owner.uid, owner.gid);
  await chmod(base, 0o711);
  await mkdir(spool, {mode:0o770});
  await chown(spool, owner.uid, owner.gid);
  execFileSync('/usr/bin/setfacl', ['-m', `u:${runner.uid}:rwx,d:u:${runner.uid}:rwx`, spool]);
  const common = { ...process.env, AGENTOC_INSTANCE_ROOT:base, AGENTOC_CONFIG_DIR:join(base,'config'),
    AGENTOC_RUN_SPOOL_DIR:spool, AGENTOC_MEMORY_DIR:join(base,'memory'),
    AGENTOC_AUTH_SESSION_SECRET:'qa-fixture-only-secret', PATH:'/opt/agentoc/runtime:/usr/bin:/bin' };
  delete common.AGENTOC_RUNNER_SAME_USER;
  delete common.AGENTOC_RUNNER_USER;
  delete common.AGENTOC_RUNNER_DISTINCT_IDENTITY;
  const runAs = (identity, phase, environment) => execFileSync('/usr/bin/setpriv', [
    '--reuid', String(identity.uid), '--regid', String(identity.gid), '--clear-groups', '--',
    process.execPath, new URL(import.meta.url).pathname, phase,
  ], { env:{...common,...environment}, encoding:'utf8', stdio:['ignore','pipe','pipe'] });
  runAs(owner, 'create', { AGENTOC_RUNNER_SAME_USER:'0', AGENTOC_RUNNER_USER:'agentoc-runner' });
  const dir = join(spool, 'run_scopedaclfixture');
  const acl = execFileSync('/usr/bin/getfacl', ['-cpn', join(dir,'status.json')], {encoding:'utf8'});
  assert.match(acl, new RegExp(`^user:${runner.uid}:rw-$`, 'm'));
  assert.match(acl, /^group::---$/m);
  assert.match(acl, /^other::---$/m);
  const tokenAcl = execFileSync('/usr/bin/getfacl', ['-cpn', join(dir,'session-control.cap')], {encoding:'utf8'});
  assert.match(tokenAcl, new RegExp(`^user:${runner.uid}:r--$`, 'm'));
  const testAs = (identity, flag, path) => spawnSync('/usr/bin/setpriv', [
    '--reuid', String(identity.uid), '--regid', String(identity.gid), '--clear-groups', '--', '/usr/bin/test', flag, path,
  ]).status;
  assert.equal(testAs(runner, '-r', join(dir,'session-control.cap')), 0);
  assert.notEqual(testAs(runner, '-w', join(dir,'session-control.cap')), 0);
  await symlink('/etc/passwd', join(dir,'browser.cap'));
  await assert.rejects(() => grantExistingRunnerFiles(dir, {controlUid:owner.uid, runnerUid:runner.uid}),
    {code:'RUNNER_FILE_ACCESS_INVALID'});
  await unlink(join(dir,'browser.cap'));
  // Simulate inputs retained across an upgrade from the owner-only format.
  for (const name of ['status.json', 'manifest.json', 'session-control.cap', 'session-control-renewal.cap']) {
    execFileSync('/usr/bin/setfacl', ['-b', join(dir,name)]);
    await chmod(join(dir,name), 0o600);
  }
  assert.notEqual(testAs(runner, '-r', join(dir,'status.json')), 0);
  await grantExistingRunnerFiles(dir, {controlUid:owner.uid, runnerUid:runner.uid});
  assert.equal(testAs(runner, '-r', join(dir,'status.json')), 0);
  assert.equal(testAs(runner, '-r', join(dir,'session-control.cap')), 0);
  assert.notEqual(testAs(runner, '-w', join(dir,'session-control.cap')), 0);
  runAs(runner, 'runner', { AGENTOC_RUNNER_DISTINCT_IDENTITY:'1' });
  runAs(owner, 'control', { AGENTOC_RUNNER_SAME_USER:'0', AGENTOC_RUNNER_USER:'agentoc-runner' });
  assert.equal(JSON.parse(await readFile(join(dir,'status.json'), 'utf8')).state, 'completed');
  // Even if another account can traverse the fixture directories, the files
  // must not grant it access through an inherited group or the other class.
  await chmod(spool, 0o751);
  await chmod(dir, 0o751);
  assert.notEqual(testAs(getent('nobody'), '-r', join(dir,'status.json')), 0);
  console.log('Separate Linux runner publication integration passed');
} finally { await rm(base, {recursive:true,force:true}); }
