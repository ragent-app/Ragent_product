#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createWindowsRuntimeFactsProvider,
  parseWindowsAclFacts,
  parseWindowsArtifactFacts,
  parseWindowsPathFacts,
  parseWindowsServiceFacts,
  revalidateWindowsAclFacts,
  revalidateWindowsPathFacts,
  revalidateWindowsResourceSnapshot,
  revalidateWindowsServiceFacts,
  WINDOWS_POWERSHELL_EXECUTABLE,
} from '../chat/windows-runtime-facts-provider.mjs';
import { resolveWindowsSemanticContext } from '../chat/semantic-resolver-windows.mjs';
import { compileSemanticOperations } from '../chat/semantic-compiler.mjs';
import { evaluateSemanticOperation } from '../chat/semantic-policy.mjs';

let passed = 0;
function check(label, value) {
  assert.ok(value, `failed: ${label}`);
  passed += 1;
}
function eq(label, actual, expected) {
  assert.deepEqual(actual, expected, `failed: ${label}`);
  passed += 1;
}
async function rejects(label, promise, code) {
  await assert.rejects(promise, (error) => {
    eq(`${label} code`, error.code, code);
    return true;
  });
}

const pathIdentity = '00000001:0000000000000001';
const inaccessibleProvider = createWindowsRuntimeFactsProvider({ platform: 'win32', execFile: async () => { throw Object.assign(new Error('access denied'), { code: 1 }); } });
await rejects('access failure is not reported as a missing path', inaccessibleProvider.stat('C:\\project\\file.txt'), 'WINDOWS_FACTS_UNAVAILABLE');
const missingSnapshot = { canonical: 'C:\\project\\new\\file.txt', identity: 'no-follow:parent-id:new\\file.txt', expectedParentIdentity: 'parent-id', mountId: 'volume', noFollow: true, parentIsDirectory: true, reparsePoint: false, missingPathSegments: ['new', 'file.txt'] };
const missingProvider = { async realpath(value) { return value; }, async stat(value) {
  if (value === 'C:\\project') return { type: 'dir', identity: 'parent-id', mountId: 'volume', canonicalPath: value, reparsePoint: false };
  throw Object.assign(new Error('missing'), { code: 'ENOENT' });
} };
check('missing path snapshot revalidates', (await revalidateWindowsPathFacts(missingSnapshot, { provider: missingProvider })).ok);
check('missing path revalidation rejects traversal segments', !(await revalidateWindowsPathFacts({ ...missingSnapshot, missingPathSegments: ['..', 'file.txt'] }, { provider: missingProvider })).ok);
check('missing path revalidation rejects inaccessible targets', !(await revalidateWindowsPathFacts(missingSnapshot, { provider: { ...missingProvider, async stat(value) {
  if (value === 'C:\\project') return missingProvider.stat(value);
  throw Object.assign(new Error('access denied'), { code: 'EACCES' });
} } })).ok);
const pathOutput = JSON.stringify({
  platform: 'win32',
  canonicalPath: 'C:\\project\\file.txt',
  type: 'file',
  size: 12,
  reparsePoint: false,
  volumeSerial: '00000001',
  fileId: '0000000000000001',
  identity: pathIdentity,
});
const serviceHash = 'a'.repeat(64);
const aclHash = 'b'.repeat(64);

eq('path parser keeps identity', parseWindowsPathFacts(pathOutput).identity, pathIdentity);
await rejects('path parser rejects malformed output', Promise.resolve().then(() => parseWindowsPathFacts('{"platform":"win32"}')), 'WINDOWS_FACTS_OUTPUT_INVALID');
await rejects('path parser rejects ambiguous output', Promise.resolve().then(() => parseWindowsPathFacts(`${pathOutput}\n${pathOutput}`)), 'WINDOWS_FACTS_OUTPUT_INVALID');
if (process.platform === 'win32') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ragent-runtime-missing-'));
  const missing = path.join(root, 'new-parent', 'new-file.txt');
  const live = createWindowsRuntimeFactsProvider();
  await rejects('native realpath identifies a missing path', live.realpath(missing), 'ENOENT');
  await rejects('native stat identifies a missing path', live.stat(missing), 'ENOENT');
  const resolved = await resolveWindowsSemanticContext({ target: { kind: 'filesystem_file', platform: 'win32', root: missing },
    options: { windowsFactsProvider: live, trustedContext: { cwd: root, projectRoot: root } } });
  check('native resolver resolves a new nested target', resolved.resourceSnapshot.paths?.[0]?.canonical?.toLowerCase() === missing.toLowerCase());
  eq('native resolver preserves missing components', resolved.resourceSnapshot.paths[0].missingPathSegments, ['new-parent', 'new-file.txt']);
  check('native revalidation accepts the unchanged missing path', (await revalidateWindowsPathFacts(resolved.resourceSnapshot.paths[0], { provider: live })).ok);
  await mkdir(path.join(root, 'new-parent'));
  check('native revalidation rejects a newly created parent component', !(await revalidateWindowsPathFacts(resolved.resourceSnapshot.paths[0], { provider: live })).ok);
  const workspace = path.join(root, 'workspace');
  const outside = path.join(root, 'outside');
  await mkdir(workspace); await mkdir(outside);
  const outsideFile = path.join(outside, 'ordinary.txt');
  await writeFile(outsideFile, 'fixture');
  const trustedContext = { cwd: workspace, projectRoot: workspace, platform: 'win32' };
  for (const [command, expected] of [
    [`Get-Content -LiteralPath '${outsideFile}'`, 'ALLOW'],
    [`Set-Content -LiteralPath '${outsideFile}' -Value 'fixture'`, 'ALLOW'],
    [`Remove-Item -LiteralPath '${outsideFile}'`, 'DENY'],
  ]) {
    const operation = compileSemanticOperations({ request: { sessionId: 'live', runId: 'live', turnId: 'live', requestKey: 'live',
      executionClass: 'host', rawCommand: command }, trustedContext }).operations[0];
    const resolution = await resolveWindowsSemanticContext({ operation, options: { windowsFactsProvider: live, trustedContext } });
    eq('live external path is resolved', resolution.scope.kind, 'outside_project');
    eq('live external path policy', evaluateSemanticOperation(operation, resolution).decision, expected);
  }
  await symlink(outside, path.join(workspace, 'junction'), 'junction');
  const redirected = await resolveWindowsSemanticContext({ target: { kind: 'filesystem_file', platform: 'win32', root: path.join(workspace, 'junction', 'new', 'file.txt') },
    options: { windowsFactsProvider: live, trustedContext: { cwd: workspace, projectRoot: workspace } } });
  eq('native resolver follows an existing junction for missing targets', redirected.resourceSnapshot.paths?.[0]?.canonical?.toLowerCase(), path.join(outside, 'new', 'file.txt').toLowerCase());
  check('native resolver flags the redirected target', redirected.unknowns.includes('target:reparse-point') && redirected.scope.kind === 'outside_project' && redirected.scope.computed === false);
}
await rejects('service parser rejects hash mutation', Promise.resolve().then(() => parseWindowsServiceFacts(JSON.stringify({
  platform: 'win32', manager: 'windows-service', serviceName: 'ragent', exists: true, definitionHash: 'changed',
}), 'ragent')), 'WINDOWS_FACTS_OUTPUT_INVALID');
await rejects('ACL parser rejects path mismatch', Promise.resolve().then(() => parseWindowsAclFacts(JSON.stringify({
  platform: 'win32', provider: 'windows-acl', canonicalPath: 'C:\\other', ownerSid: 'S-1-5-18', protected: true, descriptorHash: aclHash,
}), 'C:\\project\\file.txt')), 'WINDOWS_FACTS_OUTPUT_INVALID');

const calls = [];
const provider = createWindowsRuntimeFactsProvider({
  platform: 'win32',
  execFile: async (command, args, options) => {
    calls.push({ command, args, options });
    const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    if (script.includes('Get-FileHash')) {
      return { stdout: JSON.stringify({ exists: true, digest: 'a'.repeat(64) }), stderr: '' };
    }
    if (script.includes('Get-CimInstance')) {
      return { stdout: JSON.stringify({ platform: 'win32', manager: 'windows-service', serviceName: 'ragent', exists: true, definitionHash: serviceHash }), stderr: '' };
    }
    if (script.includes('Get-Acl')) {
      return { stdout: JSON.stringify({ platform: 'win32', provider: 'windows-acl', canonicalPath: 'C:\\project\\file.txt', ownerSid: 'S-1-5-18', protected: true, descriptorHash: aclHash }), stderr: '' };
    }
    if (script.includes('Get-ChildItem')) {
      return { stdout: JSON.stringify([{ name: 'file.txt', type: 'file', reparsePoint: false }]), stderr: '' };
    }
    if (script.includes('GetFinalPathNameByHandle') && !script.includes('Identity($item.FullName)')) {
      return { stdout: JSON.stringify({ platform: 'win32', canonicalPath: 'C:\\project\\file.txt' }), stderr: '' };
    }
    return { stdout: pathOutput, stderr: '' };
  },
});

const hostilePath = 'C:\\project\\safe.txt;Write-Output INJECTED';
eq('provider canonicalizes via fixed script', await provider.realpath(hostilePath), 'C:\\project\\file.txt');
eq('provider parses fixed stat facts', (await provider.stat(hostilePath)).identity, pathIdentity);
eq('provider supplies complete regular MSI artifact facts', await provider.artifactFacts('C:\\project\\file.txt'), {
  exists: true, identity: pathIdentity, digest: 'a'.repeat(64), size: 12,
});
const artifactResolution = await resolveWindowsSemanticContext({
  target: { kind: 'package_artifact', platform: 'win32', root: 'C:\\project\\file.txt', manager: 'msiexec', source: 'local_artifact', digest: 'a'.repeat(64) },
  options: { windowsFactsProvider: provider, trustedContext: { cwd: 'C:\\project' } },
});
check('production facts contract resolves a verified MSI artifact', artifactResolution.scope.computed && artifactResolution.unknowns.length === 0);
let artifactStatCount = 0;
const changedArtifactProvider = createWindowsRuntimeFactsProvider({
  platform: 'win32',
  execFile: async (_command, args) => {
    const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    if (script.includes('Get-FileHash')) return { stdout: JSON.stringify({ exists: true, digest: 'a'.repeat(64) }), stderr: '' };
    artifactStatCount += 1;
    const id = artifactStatCount === 1 ? '0000000000000001' : '0000000000000002';
    return { stdout: JSON.stringify({ ...JSON.parse(pathOutput), fileId: id, identity: `00000001:${id}` }), stderr: '' };
  },
});
await rejects('artifact replacement during hashing is rejected', changedArtifactProvider.artifactFacts('C:\\project\\file.txt'), 'WINDOWS_FACTS_UNAVAILABLE');
const wingetExe = 'D:\\WindowsApps\\Microsoft.DesktopAppInstaller_1.2.3.4_arm64__8wekyb3d8bbwe\\winget.exe';
const packageProvider = createWindowsRuntimeFactsProvider({ platform: 'win32', execFile: async (file, args) => {
  if (file.toLowerCase().endsWith('powershell.exe')) return { stdout: JSON.stringify({ executable: wingetExe, family: 'Microsoft.DesktopAppInstaller_8wekyb3d8bbwe', signature: 'Valid' }) };
  if (args[0] === 'source') return { stdout: JSON.stringify({ Name: 'winget', Type: 'Microsoft.PreIndexed.Package', Identifier: 'Microsoft.Winget.Source_8wekyb3d8bbwe', TrustLevel: ['Trusted'], Arg: 'https://cdn.winget.microsoft.com/cache' }) };
  return { stdout: 'Package [Vendor.App]\n版本\n---------\n1.2.3\n' };
} });
const wingetResolution = await resolveWindowsSemanticContext({
  target: { kind: 'package', platform: 'win32', manager: 'winget', packages: ['Vendor.App'], source: 'winget', exact: true },
  options: { windowsFactsProvider: packageProvider, trustedContext: { cwd: 'C:\\project' } },
});
check('production facts provider resolves an unpinned winget version', wingetResolution.scope.computed && wingetResolution.resourceSnapshot.packages[0].availableVersion === '1.2.3');
eq('provider parses directory facts', (await provider.readdir('C:\\project'))[0].name, 'file.txt');
eq('provider parses service facts', (await provider.serviceFacts({ serviceName: 'ragent' })).definitionHash, serviceHash);
eq('provider parses ACL facts', (await provider.aclFacts({ canonicalPath: 'C:\\project\\file.txt' })).descriptorHash, aclHash);
check('provider uses fixed absolute PowerShell', calls.every((call) => call.command === WINDOWS_POWERSHELL_EXECUTABLE));
check('provider disables shell execution', calls.every((call) => call.options.shell === false));
check('dynamic path is passed as an environment value', calls.some((call) => call.options.env.RAGENT_FACTS_PATH === hostilePath));
check('dynamic path never enters PowerShell source', calls.every((call) => !Buffer.from(call.args.at(-1), 'base64').toString('utf16le').includes(hostilePath)));
check('provider pins no-profile noninteractive mode', calls.every((call) => call.args.includes('-NoProfile') && call.args.includes('-NonInteractive')));
check('provider forces UTF-8 console output encoding before every script',
  calls.every((call) => {
    const decoded = Buffer.from(call.args.at(-1), 'base64').toString('utf16le');
    return decoded.startsWith('[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8;');
  }));

const malformedProvider = createWindowsRuntimeFactsProvider({
  platform: 'win32',
  execFile: async () => ({ stdout: `${pathOutput}\ntrailing`, stderr: '' }),
});
await rejects('provider rejects malformed command output', malformedProvider.stat('C:\\project\\file.txt'), 'WINDOWS_FACTS_OUTPUT_INVALID');

let pathState = { identity: pathIdentity, mountId: 'volume-1', reparsePoint: false };
const revalidationProvider = {
  async realpath(value) { return value; },
  async stat(value) {
    if (value === 'C:\\project') return { identity: 'parent-1', mountId: 'volume-1', reparsePoint: false };
    return { ...pathState };
  },
  async serviceFacts() { return { platform: 'win32', manager: 'windows-service', serviceName: 'ragent', exists: true, definitionHash: serviceHash }; },
  async aclFacts() { return { platform: 'win32', provider: 'windows-acl', canonicalPath: 'C:\\project\\file.txt', ownerSid: 'S-1-5-18', protected: true, descriptorHash: aclHash }; },
};
const pathSnapshot = {
  canonical: 'C:\\project\\file.txt', identity: pathIdentity, mountId: 'volume-1', reparsePoint: false, expectedParentIdentity: 'parent-1',
};
check('unchanged path passes execution revalidation', (await revalidateWindowsPathFacts(pathSnapshot, { provider: revalidationProvider })).ok);
pathState = { ...pathState, identity: 'changed-file-id' };
check('identity change fails execution revalidation', !(await revalidateWindowsPathFacts(pathSnapshot, { provider: revalidationProvider })).ok);
pathState = { identity: pathIdentity, mountId: 'volume-2', reparsePoint: false };
check('volume change fails execution revalidation', !(await revalidateWindowsPathFacts(pathSnapshot, { provider: revalidationProvider })).ok);
pathState = { identity: pathIdentity, mountId: 'volume-1', reparsePoint: true };
check('reparse change fails execution revalidation', !(await revalidateWindowsPathFacts(pathSnapshot, { provider: revalidationProvider })).ok);

pathState = { identity: pathIdentity, mountId: 'volume-1', reparsePoint: false };
check('unchanged service passes execution revalidation', (await revalidateWindowsServiceFacts({ serviceName: 'ragent', definitionHash: serviceHash }, { provider: revalidationProvider })).ok);
const changedServiceProvider = { ...revalidationProvider, async serviceFacts() { return { platform: 'win32', manager: 'windows-service', serviceName: 'ragent', exists: true, definitionHash: 'c'.repeat(64) }; } };
check('service definition hash change fails revalidation', !(await revalidateWindowsServiceFacts({ serviceName: 'ragent', definitionHash: serviceHash }, { provider: changedServiceProvider })).ok);
check('unchanged ACL passes execution revalidation', (await revalidateWindowsAclFacts({ canonicalPath: 'C:\\project\\file.txt', descriptorHash: aclHash, ownerSid: 'S-1-5-18' }, { provider: revalidationProvider })).ok);
const changedAclProvider = { ...revalidationProvider, async aclFacts() { return { platform: 'win32', provider: 'windows-acl', canonicalPath: 'C:\\project\\file.txt', ownerSid: 'S-1-5-18', protected: true, descriptorHash: 'c'.repeat(64) }; } };
check('ACL descriptor hash change fails revalidation', !(await revalidateWindowsAclFacts({ canonicalPath: 'C:\\project\\file.txt', descriptorHash: aclHash }, { provider: changedAclProvider })).ok);
check('resource snapshot revalidation fails closed without provider', !(await revalidateWindowsResourceSnapshot({ paths: [pathSnapshot] })).ok);

// Artifact facts (MSI revalidation): digest must be a sha256 hex, else fail closed.
check('artifact digest parses a sha256 hex', (await parseWindowsArtifactFacts(JSON.stringify({ exists: true, digest: 'a'.repeat(64) }))).digest === 'a'.repeat(64));
let artifactRejected = false;
try { parseWindowsArtifactFacts(JSON.stringify({ exists: false, error: 'missing' })); } catch { artifactRejected = true; }
check('artifact digest fails closed when unavailable', artifactRejected);
let artifactBadHash = false;
try { parseWindowsArtifactFacts(JSON.stringify({ exists: true, digest: 'not-a-hash' })); } catch { artifactBadHash = true; }
check('artifact digest fails closed on malformed hash', artifactBadHash);

console.log(`windows-runtime-facts-provider: ${passed} checks passed`);
