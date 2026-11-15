import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { queryWindowsSelectedInstallerFacts, validateWindowsSelectedInstallerFacts } from '../chat/windows-winget-installer-facts.mjs';

// Opt-in read-only contract probe: this queries metadata but does not install.
// The module and runtime are supplied by the caller from an isolated payload.
const modulePath = process.env.RAGENT_QA_WINGET_MODULE;
const powershell = process.env.RAGENT_QA_PWSH;
const id = process.env.RAGENT_QA_PACKAGE_ID;
if (!modulePath || !powershell || !id) {
  console.log('windows-winget-selected-installer: skipped (runtime, module and package ID required)');
  process.exit(0);
}
assert.match(id, /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const script = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Import-Module $env:RAGENT_QA_WINGET_MODULE -ErrorAction Stop
$matches = @(Find-WinGetPackage -Id $env:RAGENT_QA_PACKAGE_ID -Source winget -MatchOption Equals -ErrorAction Stop)
if ($matches.Count -ne 1 -or $matches[0].Id -cne $env:RAGENT_QA_PACKAGE_ID -or $matches[0].Source -ine 'winget') { throw 'Exact package unavailable' }
$property = $matches[0].GetType().GetProperty('CatalogPackageCOM', [Reflection.BindingFlags]'Instance,NonPublic')
if (-not $property) { throw 'Catalog metadata unavailable' }
$catalog = $property.GetValue($matches[0])
$version = $catalog.DefaultInstallVersion
if (-not $version -or $version.Id -cne $env:RAGENT_QA_PACKAGE_ID) { throw 'Package version unavailable' }
$optionsType = $property.PropertyType.Assembly.GetType('Microsoft.Management.Deployment.InstallOptions', $true)
$options = [Activator]::CreateInstance($optionsType)
$installer = $version.GetApplicableInstaller($options)
if (-not $installer) { throw 'Applicable installer unavailable' }
@{ id = $version.Id; version = $version.Version; source = $matches[0].Source; scope = [string]$installer.Scope; elevation = [string]$installer.ElevationRequirement; type = [string]$installer.InstallerType; nestedType = [string]$installer.NestedInstallerType; architecture = [string]$installer.Architecture; locale = [string]$installer.Locale; otherVersion = @($matches[0].AvailableVersions | Where-Object { $_ -cne $version.Version } | Select-Object -First 1)[0] } | ConvertTo-Json -Compress
`;
const { stdout } = await promisify(execFile)(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
  { env: process.env, windowsHide: true, timeout: 60000, maxBuffer: 128 * 1024 });
const facts = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
assert.equal(facts.id, id);
assert.ok(facts.version);
assert.ok(['Unknown', 'User', 'System'].includes(facts.scope));
assert.ok(['Unknown', 'ElevationRequired', 'ElevationProhibited', 'ElevatesSelf'].includes(facts.elevation));
assert.ok(facts.type && facts.architecture);
assert.ok(validateWindowsSelectedInstallerFacts(facts, { packageId: id, packageVersion: facts.version }), 'selected metadata must pass the production fact validator');
const exact = await queryWindowsSelectedInstallerFacts({ packageId: id, packageVersion: facts.version }, { runtime: powershell, module: modulePath,
  execFile: async (...args) => { try { return await promisify(execFile)(...args); } catch (error) { process.stderr.write(String(error.stderr || error.message)); throw error; } } });
assert.deepEqual(exact, validateWindowsSelectedInstallerFacts(facts, { packageId: id, packageVersion: facts.version }), 'fixed-version runtime query must match the independently observed installer');
if (facts.otherVersion) {
  const other = await queryWindowsSelectedInstallerFacts({ packageId: id, packageVersion: facts.otherVersion }, { runtime: powershell, module: modulePath });
  assert.ok(other && other.version === facts.otherVersion, 'non-default versions must be resolved independently');
}
assert.equal(await queryWindowsSelectedInstallerFacts({ packageId: id, packageVersion: `0.0.0-ragent-unmatched-${Date.now()}` }, { runtime: powershell, module: modulePath }), null, 'an unknown version must not reuse another installer metadata');
console.log(`windows-winget-selected-installer: metadata read for ${facts.id} (${facts.scope}, ${facts.elevation})`);
