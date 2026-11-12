import assert from 'node:assert/strict';
import { buildRunnerGroupDropCommand, isTrustedSetpriv, resolveAllowedRunnerGroupIds,
  resolveRestrictedRunnerGroupIds, verifyDroppedRunnerProcess, TRUSTED_SETPRIV_PATH } from '../lib/linux-runner-group-drop.mjs';

const built = buildRunnerGroupDropCommand({ uid: 1001, gid: 1002, supplementaryGids: [2002, 1002, 2002],
  command: '/opt/agentoc/runtime/node', args: ['/opt/agentoc/app/chat/runner-sidecar.mjs', 'run_fixture'] });
assert.equal(built.command, TRUSTED_SETPRIV_PATH);
assert.deepEqual(built.args, ['--inh-caps=-all', '--ambient-caps=-all', '--reuid', '1001', '--regid', '1002', '--groups', '1002,2002', '--',
  '/opt/agentoc/runtime/node', '/opt/agentoc/app/chat/runner-sidecar.mjs', 'run_fixture']);
assert.ok(buildRunnerGroupDropCommand({ uid: 1, gid: 1, command: '/bin/true' }).args.includes('--clear-groups'));
for (const change of [{uid:0}, {gid:0}, {supplementaryGids:[0]}, {uid:1.5}, {command:'relative'}, {args:['bad\0value']}]) {
  assert.throws(() => buildRunnerGroupDropCommand({uid:1001,gid:1002,command:'/bin/true',...change}),
    error => error.code === 'RUNNER_IDENTITY_INVALID');
}
const goodStat = path => ({ uid:0, mode:0o755, isSymbolicLink:()=>false,
  isDirectory:()=>path !== TRUSTED_SETPRIV_PATH, isFile:()=>path === TRUSTED_SETPRIV_PATH });
assert.equal(isTrustedSetpriv({stat:goodStat}), true);
assert.equal(isTrustedSetpriv({stat:path => ({...goodStat(path), mode:path === '/usr' ? 0o777 : 0o755})}), false);
assert.equal(isTrustedSetpriv({stat:path => ({...goodStat(path), isSymbolicLink:()=>path === TRUSTED_SETPRIV_PATH})}), false);
const lookup = async (command, args) => {
  assert.equal(command, '/usr/bin/getent');
  const groups = {root:0,sudo:27,developers:1100,workspace:1101,admin_alias:27};
  if (!Object.hasOwn(groups, args[1])) throw Object.assign(new Error('not found'), { code:2 });
  return {stdout:`${args[1]}:x:${groups[args[1]]}:\n`};
};
const restricted = await resolveRestrictedRunnerGroupIds({execFileImpl:lookup});
assert.deepEqual(await resolveAllowedRunnerGroupIds(['workspace','developers','workspace'], {restrictedIds:restricted,execFileImpl:lookup}), [1100,1101]);
for (const groups of [['admin_alias'], ['root'], ['unknown'], ['bad/name']]) {
  await assert.rejects(() => resolveAllowedRunnerGroupIds(groups, {restrictedIds:restricted,execFileImpl:lookup}),
    error => error.code === 'RUNNER_IDENTITY_INVALID');
}
await assert.rejects(() => resolveRestrictedRunnerGroupIds({execFileImpl:async () => { throw Object.assign(new Error('NSS failed'),{code:1}); }}),
  error => error.code === 'RUNNER_IDENTITY_INVALID');
const procStatus = 'Name:\tnode\nUid:\t1001\t1001\t1001\t1001\nGid:\t1002\t1002\t1002\t1002\nGroups:\t1002 1100\nCapInh:\t0000000000000000\nCapPrm:\t0000000000000000\nCapEff:\t0000000000000000\nCapAmb:\t0000000000000000\n';
await verifyDroppedRunnerProcess(4321, {uid:1001,gid:1002,restrictedIds:restricted,readFileImpl:async () => procStatus});
for (const status of [procStatus.replace('1001\t1001\t1001\t1001','0\t1001\t1001\t1001'),
  procStatus.replace('1002 1100','1002 27'), procStatus.replace('Gid:', 'Missing:'),
  procStatus.replace('CapEff:\t0000000000000000', 'CapEff:\t0000000000000001'),
  procStatus.replace('CapAmb:', 'Missing:')]) {
  await assert.rejects(() => verifyDroppedRunnerProcess(4321, {uid:1001,gid:1002,restrictedIds:restricted,readFileImpl:async () => status}),
    error => error.code === 'RUNNER_IDENTITY_INVALID');
}
console.log('Linux runner group-drop construction checks passed');
