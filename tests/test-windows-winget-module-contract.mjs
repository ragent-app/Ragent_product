import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Read the packaged Microsoft module's metadata only: no source queries,
// package downloads, or installation. The caller supplies an existing staged
// module and PowerShell 7 executable so no runtime is downloaded by this test.
const modulePath = process.env.RAGENT_QA_WINGET_MODULE;
const powershell = process.env.RAGENT_QA_PWSH;
if (!modulePath || !powershell) {
  console.log('windows-winget-module-contract: skipped (staged module and PowerShell 7 not supplied)');
  process.exit(0);
}
const script = String.raw`
$ErrorActionPreference = 'Stop'
Import-Module -Name $env:RAGENT_QA_WINGET_MODULE -ErrorAction Stop
$install = Get-Command Install-WinGetPackage -ErrorAction Stop
$find = Get-Command Find-WinGetPackage -ErrorAction Stop
$source = Get-Command Get-WinGetSource -ErrorAction Stop
$result = $install.OutputType[0].Type
$package = $find.OutputType[0].Type
$sourceResult = $source.OutputType[0].Type
$catalogProperty = $package.GetProperty('CatalogPackageCOM', [Reflection.BindingFlags]'Instance,NonPublic')
if (-not $catalogProperty) { throw 'Catalog package metadata is unavailable' }
$deployment = $catalogProperty.PropertyType.Assembly
$versionInfo = $deployment.GetType('Microsoft.Management.Deployment.PackageVersionInfo', $true)
$installerInfo = $deployment.GetType('Microsoft.Management.Deployment.PackageInstallerInfo', $true)
$installOptions = $deployment.GetType('Microsoft.Management.Deployment.InstallOptions', $true)
$liveSource = $null
if ($env:RAGENT_QA_WINGET_READ_SOURCE -eq '1') {
  $candidates = @(Get-WinGetSource -Name winget -ErrorAction Stop)
  if ($candidates.Count -ne 1) { throw 'Expected one winget source' }
  $liveSource = @{ name = $candidates[0].Name; type = $candidates[0].Type; argument = $candidates[0].Argument; trust = $candidates[0].TrustLevel }
}
@{
 installParameters = @($install.Parameters.Keys)
 findParameters = @($find.Parameters.Keys)
 sourceParameters = @($source.Parameters.Keys)
 installResult = @($result.GetProperties() | ForEach-Object { $_.Name })
 packageProperties = @($package.GetProperties() | ForEach-Object { $_.Name })
 sourceProperties = @($sourceResult.GetProperties() | ForEach-Object { $_.Name })
 scopes = @([Enum]::GetNames($install.Parameters['Scope'].ParameterType))
 modes = @([Enum]::GetNames($install.Parameters['Mode'].ParameterType))
 matches = @([Enum]::GetNames($install.Parameters['MatchOption'].ParameterType))
 availableVersionsType = ($package.GetProperty('AvailableVersions').PropertyType.FullName)
 versionInfoMethods = @($versionInfo.GetMethods() | ForEach-Object { $_.Name })
 installerProperties = @($installerInfo.GetProperties() | ForEach-Object { $_.Name })
 installOptionsConstructors = @($installOptions.GetConstructors()).Count
 liveSource = $liveSource
} | ConvertTo-Json -Depth 4 -Compress
`;
const { stdout } = await promisify(execFile)(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
  { env: process.env, windowsHide: true, timeout: 30000, maxBuffer: 128 * 1024 });
const contract = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
for (const name of ['Id', 'Version', 'Source', 'MatchOption', 'Mode', 'Scope', 'Confirm']) assert.ok(contract.installParameters.includes(name), `missing install parameter ${name}`);
for (const name of ['Id', 'Source', 'MatchOption']) assert.ok(contract.findParameters.includes(name), `missing search parameter ${name}`);
assert.ok(contract.sourceParameters.includes('Name'));
for (const name of ['Id', 'Source', 'Status', 'InstallerErrorCode', 'RebootRequired']) assert.ok(contract.installResult.includes(name), `missing result property ${name}`);
for (const name of ['Id', 'Source', 'AvailableVersions']) assert.ok(contract.packageProperties.includes(name), `missing package property ${name}`);
for (const name of ['Name', 'Argument', 'Type', 'TrustLevel']) assert.ok(contract.sourceProperties.includes(name), `missing source property ${name}`);
assert.ok(contract.scopes.includes('System'));
assert.ok(contract.modes.includes('Silent'));
assert.ok(contract.matches.includes('Equals'));
assert.equal(contract.availableVersionsType, 'System.String[]');
assert.ok(contract.versionInfoMethods.includes('GetApplicableInstaller'));
for (const name of ['Scope', 'ElevationRequirement', 'InstallerType', 'Architecture']) assert.ok(contract.installerProperties.includes(name), `missing installer metadata ${name}`);
assert.ok(contract.installOptionsConstructors > 0);
if (process.env.RAGENT_QA_WINGET_READ_SOURCE === '1') {
  assert.equal(contract.liveSource.name, 'winget');
  assert.equal(contract.liveSource.type, 'Microsoft.PreIndexed.Package');
  assert.equal(contract.liveSource.trust.toLowerCase(), 'trusted');
  const endpoint = new URL(contract.liveSource.argument);
  assert.equal(endpoint.protocol, 'https:');
  assert.ok(endpoint.hostname === 'winget.microsoft.com' || endpoint.hostname.endsWith('.winget.microsoft.com'));
}
console.log('windows-winget-module-contract: packaged Microsoft module metadata checks passed');
