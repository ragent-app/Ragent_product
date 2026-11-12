import assert from 'node:assert/strict';
import { chmod, chown, link, lstat, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { migrateManagedHomeOwnership } from '../lib/linux-managed-home-migration.mjs';

if (process.platform !== 'linux' || process.getuid?.() !== 0) {
  console.log('Linux managed-home migration requires root; skipped'); process.exit(0);
}
const account = name => {
  const fields = execFileSync('/usr/bin/getent', ['passwd',name], {encoding:'utf8'}).trim().split(':');
  return {uid:Number(fields[2]),gid:Number(fields[3])};
};
const oldUser = account('ubuntu');
const runner = account('agentoc-runner');
const base = await mkdtemp('/tmp/agentoc-provider-migrate-');
const home = join(base,'codex');
try {
  await mkdir(join(home,'thread-writer-locks'), {recursive:true, mode:0o770});
  await writeFile(join(home,'state_5.sqlite'),'database', {mode:0o600});
  await writeFile(join(home,'thread-writer-locks','.coordination.lock'),'lock', {mode:0o600});
  await chown(home, oldUser.uid, oldUser.gid);
  await chown(join(home,'thread-writer-locks'), oldUser.uid, oldUser.gid);
  await chown(join(home,'state_5.sqlite'), oldUser.uid, oldUser.gid);
  await chown(join(home,'thread-writer-locks','.coordination.lock'), oldUser.uid, oldUser.gid);
  await chmod(home, 0o2770);
  await symlink('/etc/passwd', join(home,'outside-link'));
  const alias = join(base,'home-link');
  await symlink(home,alias);
  await assert.rejects(() => migrateManagedHomeOwnership(alias, {targetUid:runner.uid,targetGid:runner.gid}),
    {code:'RUNNER_HOME_MIGRATION_INVALID'});
  const outside = await lstat('/etc/passwd');
  const result = await migrateManagedHomeOwnership(home, {targetUid:runner.uid,targetGid:runner.gid});
  assert.equal(result.changed,4);
  for (const path of [home,join(home,'thread-writer-locks'),join(home,'state_5.sqlite'),join(home,'thread-writer-locks','.coordination.lock')]) {
    const info = await lstat(path);
    assert.equal(info.uid,runner.uid);
    assert.equal(info.gid,runner.gid);
  }
  assert.equal((await lstat('/etc/passwd')).uid,outside.uid);
  assert.equal(await readFile(join(home,'state_5.sqlite'),'utf8'),'database');
  assert.equal((await lstat(home)).mode & 0o7777,0o2770);
  // Recovery from an earlier partial migration finds files still owned by the
  // original control user, even after the home directory changed owner.
  await chown(join(home,'state_5.sqlite'),oldUser.uid,oldUser.gid);
  await migrateManagedHomeOwnership(home, {targetUid:runner.uid,targetGid:runner.gid,additionalSourceUid:oldUser.uid});
  assert.equal((await lstat(join(home,'state_5.sqlite'))).uid,runner.uid);
  const external = join(base,'external');
  await writeFile(external,'outside', {mode:0o600});
  await chown(external,oldUser.uid,oldUser.gid);
  await link(external,join(home,'hardlink'));
  await assert.rejects(() => migrateManagedHomeOwnership(home, {targetUid:runner.uid,targetGid:runner.gid,additionalSourceUid:oldUser.uid}),
    {code:'RUNNER_HOME_MIGRATION_INVALID'});
  assert.equal((await lstat(external)).uid,oldUser.uid);
  await unlink(join(home,'hardlink'));
  console.log('Linux managed-home ownership migration checks passed');
} finally { await rm(base,{recursive:true,force:true}); }
