import assert from 'node:assert/strict';
const { resolveInstalledVersion } = await import('../scripts/storage-inventory-gc.mjs');
const calls = [];
const query = async (_command, args) => {
  const name = args.at(-1);
  calls.push(name);
  return { stdout: name === 'ragent' ? 'installed\t2.0.0+main.abc.20261112' : 'installed\t1.0.0' };
};
assert.equal(await resolveInstalledVersion({}, { query }), '2.0.0+main.abc.20261112');
assert.deepEqual(calls, ['ragent']);
const legacy = async (_command, args) => ({ stdout: args.at(-1) === 'ragent' ? 'config-files\t2.0.0' : 'installed\t1.0.0' });
assert.equal(await resolveInstalledVersion({}, { query: legacy }), '1.0.0');
assert.equal(await resolveInstalledVersion({ installedVersion: 'manual' }, { query: async () => { throw Error('unexpected'); } }), 'manual');
console.log('PASS storage cleanup protects the installed Ragent or legacy package version');
