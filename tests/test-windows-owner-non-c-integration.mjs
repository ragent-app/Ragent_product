import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { promisify } from 'node:util';

// Exercise real consumer modules with only OS discovery and native inspector
// execution substituted. This does not claim a real non-C installation.
const platform = process.platform;
if (platform !== 'win32') Object.defineProperty(process, 'platform', { value: 'win32' });
delete process.env.RAGENT_INSTALL_ROOT;
const names = ['windows-owner-discovery.mjs', 'windows-owner-activation-trust.mjs', 'windows-owner-service-trust.mjs'];
const parents = names.map(name => new URL(`../lib/${name}`, import.meta.url).href);
const calls = [];
const osPaths = { windows: 'D:\\Windows', programData: 'E:\\Shared Data', programFiles: 'F:\\Apps',
  powershell: 'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' };
function execFile() {}
execFile[promisify.custom] = async (executable, args, options) => {
  calls.push({ executable, args, options });
  return { stdout: JSON.stringify({ ok: false, code: 'OBD_RELEASE_NOT_INSTALLED' }), stderr: '' };
};
globalThis.__ragentOwnerPathFixture = { osPaths, execFile };
registerHooks({
  resolve(specifier, context, next) {
    if (parents.includes(context.parentURL) && specifier === 'node:child_process') return { url: 'qa:owner-inspector-child', shortCircuit: true };
    if (parents.includes(context.parentURL) && specifier === './windows-owner-os-paths.mjs') return { url: 'qa:owner-os-paths', shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'qa:owner-inspector-child') return { format: 'module', source: 'export const execFile=globalThis.__ragentOwnerPathFixture.execFile;', shortCircuit: true };
    if (url === 'qa:owner-os-paths') return { format: 'module', source: 'export const ownerWindowsOsPaths=()=>globalThis.__ragentOwnerPathFixture.osPaths;', shortCircuit: true };
    return next(url, context);
  },
});
const discovery = await import(parents[0]);
const activation = await import(parents[1]);
const service = await import(parents[2]);
assert.equal(discovery.OWNER_INSTANCE_ROOT, 'E:/Shared Data/Ragent/instances/owner');
assert.equal(discovery.OWNER_BOOTSTRAP_INSTALLED_ROOT, 'F:/Apps/Ragent');
assert.equal(discovery.OWNER_BOOTSTRAP_INSTALLED_PATHS.installation, 'E:/Shared Data/Ragent/instances/owner/security/owner-bootstrap-install.json');
assert.equal(service.OWNER_SERVICE_ROOT, discovery.OWNER_INSTANCE_ROOT);
const context = { instanceRoot: 'E:\\Shared Data\\Ragent\\instances\\owner', instanceId: `inst_${'a'.repeat(32)}`, host: '127.0.0.1', port: 7690 };
service.validateOwnerServiceContext(context);
for (const call of [() => discovery.inspectInstalledOwnerBootstrap(), () => activation.inspectInstalledOwnerActivation(), () => service.inspectInstalledOwnerActivationService(context)]) {
  await assert.rejects(call(), { code: 'OBD_RELEASE_NOT_INSTALLED' });
}
assert.equal(calls.length, 3);
for (const call of calls) {
  assert.equal(call.executable, osPaths.powershell);
  assert.ok(call.args.includes('-ExecutionPolicy') && call.args.includes('Bypass'));
  assert.deepEqual(call.options.env, { SystemRoot: osPaths.windows, WINDIR: osPaths.windows, SystemDrive: 'D:', RAGENT_INSTALL_ROOT: 'F:\\Apps\\Ragent' });
}
console.log('windows-owner-non-c-integration: consumer paths and inspector invocations passed (simulated OS facts)');
