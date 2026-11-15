import assert from 'node:assert/strict';
import { classifyWindowsSelectedInstaller, queryWindowsSelectedInstallerFacts, sameWindowsSelectedInstaller, validateWindowsSelectedInstallerFacts } from '../chat/windows-winget-installer-facts.mjs';

const expected = { packageId: 'Vendor.App', packageVersion: '1.2.3' };
const base = { id: expected.packageId, version: expected.packageVersion, source: 'winget', scope: 'User', elevation: 'ElevatesSelf', type: 'Inno', nestedType: 'Unknown', architecture: 'X64', locale: 'en-US' };
const user = validateWindowsSelectedInstallerFacts(base, expected);
assert.ok(Object.isFrozen(user));
assert.equal(classifyWindowsSelectedInstaller(user), 'user-elevation');
assert.equal(classifyWindowsSelectedInstaller({ ...base, scope: 'System', elevation: 'ElevationRequired' }), 'system-elevation');
assert.equal(classifyWindowsSelectedInstaller({ ...base, elevation: 'ElevationProhibited' }), 'ordinary-user');
for (const mutation of [{ id: 'Other.App' }, { version: '1.2.4' }, { source: 'other' }, { scope: 'machine' },
  { elevation: 'yes' }, { type: 'unrecognized' }, { nestedType: 'unrecognized' }, { architecture: 'unrecognized' }, { locale: 'bad/locale' }]) {
  assert.equal(validateWindowsSelectedInstallerFacts({ ...base, ...mutation }, expected), null);
}
assert.equal(classifyWindowsSelectedInstaller({ ...base, source: 'other' }), 'unresolved');
assert.equal(sameWindowsSelectedInstaller(base, { ...base }, expected), true);
for (const mutation of [{ scope: 'System' }, { elevation: 'ElevationRequired' }, { locale: 'fr-FR' }, { architecture: 'Arm64' }, { nestedType: 'Msi' }]) {
  assert.equal(sameWindowsSelectedInstaller(base, { ...base, ...mutation }, expected), false);
}
let calls = 0;
const queryOptions = { platform: 'win32', runtime: 'D:\\runtime\\pwsh.exe', module: 'D:\\runtime\\module.psd1', env: { SystemRoot: 'D:\\Windows', DOTNET_STARTUP_HOOKS: 'attacker' },
  execFile: async (_runtime, args, options) => {
    calls++;
    assert.ok(Buffer.from(args.at(-1), 'base64').toString('utf16le').includes('GetApplicableInstaller'));
    assert.equal(options.env.RAGENT_FACTS_PACKAGE, expected.packageId);
    assert.equal(options.env.RAGENT_FACTS_VERSION, expected.packageVersion);
    assert.equal(options.env.DOTNET_STARTUP_HOOKS, undefined);
    return { stdout: JSON.stringify(base) };
  } };
assert.deepEqual(await queryWindowsSelectedInstallerFacts(expected, queryOptions), user);
assert.equal(await queryWindowsSelectedInstallerFacts({ ...expected, packageId: 'bad;command' }, queryOptions), null);
assert.equal(calls, 1);
assert.equal(await queryWindowsSelectedInstallerFacts(expected, { ...queryOptions, execFile: async () => ({ stdout: JSON.stringify({ ...base, version: 'other' }) }) }), null);
for (const mutation of [{ scope: 'Unknown' }, { elevation: 'Unknown' }, { scope: 'System', elevation: 'Unknown' }]) {
  assert.equal(classifyWindowsSelectedInstaller({ ...base, ...mutation }), 'unresolved');
}
console.log('windows-winget-installer-facts: exact metadata and elevation classification passed');
