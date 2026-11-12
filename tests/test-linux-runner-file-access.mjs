import assert from 'node:assert/strict';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { grantRunnerFileAccess, isTrustedSetfacl, resolveRunFilePeerUid } from '../lib/linux-runner-file-access.mjs';
import { writeJsonAtomic, writeTextAtomic } from '../chat/fs-utils.mjs';

if (process.platform !== 'linux') { console.log('Linux ACL check skipped on non-Linux'); process.exit(0); }
const root = await mkdtemp(join(tmpdir(), 'agentoc-run-acl-'));
const path = join(root, 'input');
try {
  const directory = { uid:1001, isDirectory:()=>true, isSymbolicLink:()=>false };
  assert.equal(await resolveRunFilePeerUid(root, { environment:{ AGENTOC_RUNNER_DISTINCT_IDENTITY:'1' },
    currentUid:1002, statImpl:async()=>directory }), 1001);
  await assert.rejects(() => resolveRunFilePeerUid(root, { environment:{ AGENTOC_RUNNER_DISTINCT_IDENTITY:'1' },
    currentUid:1001, statImpl:async()=>directory }), { code:'RUNNER_FILE_ACCESS_INVALID' });
  assert.equal(await resolveRunFilePeerUid(root, { environment:{ AGENTOC_RUNNER_SAME_USER:'0', AGENTOC_RUNNER_USER:'runner' },
    currentUid:1001, execFileImpl:async()=>({stdout:'runner:x:1002:1002::/tmp:/bin/false\n'}) }), 1002);
  await assert.rejects(() => resolveRunFilePeerUid(root, { environment:{ AGENTOC_RUNNER_SAME_USER:'0', AGENTOC_RUNNER_USER:'root' },
    currentUid:1001, execFileImpl:async()=>({stdout:'root:x:0:0::/root:/bin/bash\n'}) }), { code:'RUNNER_FILE_ACCESS_INVALID' });
  await assert.rejects(() => resolveRunFilePeerUid(root, { environment:{ AGENTOC_RUNNER_SAME_USER:'0', AGENTOC_RUNNER_USER:'alias' },
    currentUid:1001, execFileImpl:async()=>({stdout:'alias:x:1001:1001::/tmp:/bin/false\n'}) }), { code:'RUNNER_FILE_ACCESS_INVALID' });
  const rootOwned = (entry) => ({ uid: 0, mode: 0o755, isSymbolicLink: () => false,
    isDirectory: () => entry !== '/etc/agentoc/runner-user', isFile: () => entry === '/etc/agentoc/runner-user' });
  assert.equal(await resolveRunFilePeerUid(root, { environment:{ AGENTOC_RUNNER_SAME_USER:'0' }, currentUid:1001,
    statImpl:async entry => rootOwned(entry), readFileImpl:async () => 'control\n',
    execFileImpl:async (_command, args) => ({stdout: `${args[1]}:x:${args[1] === 'control' ? 1001 : 1002}:1002::/tmp:/bin/false\n`}) }), 1002);
  const handle = await open(path, 'wx+', 0o600);
  try {
    await handle.writeFile('fixture');
    assert.equal(isTrustedSetfacl(), true);
    await grantRunnerFileAccess(handle, 424242);
    const acl = execFileSync('/usr/bin/getfacl', ['-cpn', path], { encoding: 'utf8' });
    assert.match(acl, /^user:424242:r--$/m);
    assert.match(acl, /^group::---$/m);
    assert.match(acl, /^other::---$/m);
    await grantRunnerFileAccess(handle, 424243, { writable: true });
    const replaced = execFileSync('/usr/bin/getfacl', ['-cpn', path], { encoding: 'utf8' });
    assert.doesNotMatch(replaced, /^user:424242:/m);
    assert.match(replaced, /^user:424243:rw-$/m);
    assert.equal(await readFile(path, 'utf8'), 'fixture');
    for (const uid of [0, -1, 1.5, 0xffffffff]) {
      await assert.rejects(() => grantRunnerFileAccess(handle, uid), { code:'RUNNER_FILE_ACCESS_INVALID' });
    }
    await assert.rejects(() => grantRunnerFileAccess(handle, 424242, { trusted: () => false }), { code:'RUNNER_FILE_ACCESS_INVALID' });
  } finally { await handle.close(); }
  const jsonPath = join(root, 'status.json');
  await writeJsonAtomic(jsonPath, { state:'initial' }, { durable:true });
  const aclOptions = { durable:true, prepareHandle: file => grantRunnerFileAccess(file, 424242, { writable:true }) };
  await writeJsonAtomic(jsonPath, { state:'updated' }, aclOptions);
  assert.equal(JSON.parse(await readFile(jsonPath, 'utf8')).state, 'updated');
  assert.match(execFileSync('/usr/bin/getfacl', ['-cpn', jsonPath], { encoding:'utf8' }), /^user:424242:rw-$/m);
  await assert.rejects(() => writeJsonAtomic(jsonPath, { state:'unsafe' }, {
    ...aclOptions, prepareHandle: async () => { throw new Error('ACL setup failed'); },
  }), /ACL setup failed/);
  assert.equal(JSON.parse(await readFile(jsonPath, 'utf8')).state, 'updated');
  const textPath = join(root, 'capability');
  await writeTextAtomic(textPath, 'secret', { mode:0o600, ...aclOptions });
  assert.equal(await readFile(textPath, 'utf8'), 'secret');
  assert.match(execFileSync('/usr/bin/getfacl', ['-cpn', textPath], { encoding:'utf8' }), /^user:424242:rw-$/m);
} finally { await rm(root, { recursive:true, force:true }); }
console.log('Linux scoped runner ACL checks passed');
