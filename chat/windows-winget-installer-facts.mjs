import path from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

// A selected-installer observation is advisory until its runtime, execution
// identity and source have been independently trusted by the caller. It must
// never by itself authorize or launch an elevated installation.
const packagePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const versionPattern = /^[A-Za-z0-9][A-Za-z0-9._+:-]{0,127}$/;
const scopeValues = new Set(['Unknown', 'User', 'System']);
const elevationValues = new Set(['Unknown', 'ElevationRequired', 'ElevationProhibited', 'ElevatesSelf']);
const installerTypes = new Set(['Unknown', 'Inno', 'Wix', 'Msi', 'Nullsoft', 'Zip', 'Msix', 'Exe', 'Burn', 'MSStore', 'Portable', 'Font']);
const architectures = new Set(['X86', 'Arm', 'X64', 'Neutral', 'Arm64', 'Unknown', 'X86OnArm64']);
const defaultExecFile = promisify(execFileCallback);

// This fixed program takes only data in environment variables. The caller must
// supply a runtime and module from the protected Ragent installation; this
// function cannot establish that trust or attest the identity of its process.
const SELECTED_INSTALLER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Import-Module -Name $env:RAGENT_FACTS_MODULE -ErrorAction Stop
$sources = @(Get-WinGetSource -Name 'winget' -ErrorAction Stop)
if ($sources.Count -ne 1) { throw 'Source unavailable' }
$source = $sources[0]
$uri = [Uri]$source.Argument
if ($source.Name -cne 'winget' -or $source.Type -cne 'Microsoft.PreIndexed.Package' -or
    [string]$source.TrustLevel -ine 'Trusted' -or $uri.Scheme -cne 'https' -or
    ($uri.Host -ine 'winget.microsoft.com' -and -not $uri.Host.EndsWith('.winget.microsoft.com', [StringComparison]::OrdinalIgnoreCase)) -or
    $uri.UserInfo -or (-not $uri.IsDefaultPort)) { throw 'Source unverified' }
$matches = @(Find-WinGetPackage -Id $env:RAGENT_FACTS_PACKAGE -Source 'winget' -MatchOption Equals -ErrorAction Stop)
if ($matches.Count -ne 1 -or $matches[0].Id -cne $env:RAGENT_FACTS_PACKAGE -or $matches[0].Source -ine 'winget') { throw 'Exact package unavailable' }
$property = $matches[0].GetType().GetProperty('CatalogPackageCOM', [Reflection.BindingFlags]'Instance,NonPublic')
if (-not $property) { throw 'Catalog metadata unavailable' }
$catalog = $property.GetValue($matches[0])
# Some WinGet projections do not expose a PowerShell-enumerable interface for
# this WinRT vector. Its indexed access works without that interface.
$versions = $catalog.AvailableVersions
if (-not $versions -or $versions.Count -gt 10000) { throw 'Package versions unavailable' }
$selected = $null
for ($index = 0; $index -lt $versions.Count; $index++) {
  $candidate = $versions[$index]
  if ($candidate.Version -ceq $env:RAGENT_FACTS_VERSION) {
    if ($selected) { throw 'Package version is ambiguous' }
    $selected = $candidate
  }
}
if (-not $selected) { throw 'Exact package version unavailable' }
$version = $catalog.GetPackageVersionInfo($selected)
if (-not $version -or $version.Id -cne $env:RAGENT_FACTS_PACKAGE -or $version.Version -cne $env:RAGENT_FACTS_VERSION) { throw 'Package version mismatch' }
$optionsType = $property.PropertyType.Assembly.GetType('Microsoft.Management.Deployment.InstallOptions', $true)
$options = [Activator]::CreateInstance($optionsType)
$installer = $version.GetApplicableInstaller($options)
if (-not $installer) { throw 'Applicable installer unavailable' }
@{ id = $version.Id; version = $version.Version; source = 'winget'; scope = [string]$installer.Scope; elevation = [string]$installer.ElevationRequirement; type = [string]$installer.InstallerType; nestedType = [string]$installer.NestedInstallerType; architecture = [string]$installer.Architecture; locale = [string]$installer.Locale } | ConvertTo-Json -Compress
`;

export async function queryWindowsSelectedInstallerFacts({ packageId, packageVersion }, { runtime, module, env = process.env, execFile = defaultExecFile, platform = process.platform } = {}) {
  if (platform !== 'win32' || !packagePattern.test(packageId || '') || !versionPattern.test(packageVersion || '')
      || !/^[A-Za-z]:[\\/]/.test(runtime || '') || !/^[A-Za-z]:[\\/]/.test(module || '') || typeof execFile !== 'function') return null;
  const childEnv = {};
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP', 'TMPDIR', 'ProgramFiles', 'ProgramW6432', 'ProgramData', 'SystemDrive', 'PROCESSOR_ARCHITECTURE', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']) {
    if (typeof env[key] === 'string') childEnv[key] = env[key];
  }
  Object.assign(childEnv, { RAGENT_FACTS_MODULE: path.win32.normalize(module), RAGENT_FACTS_PACKAGE: packageId, RAGENT_FACTS_VERSION: packageVersion,
    POWERSHELL_TELEMETRY_OPTOUT: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1' });
  try {
    const result = await execFile(path.win32.normalize(runtime), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(SELECTED_INSTALLER_SCRIPT, 'utf16le').toString('base64')],
      { env: childEnv, cwd: path.win32.dirname(runtime), windowsHide: true, timeout: 30000, maxBuffer: 128 * 1024, shell: false });
    const facts = JSON.parse(String(result?.stdout || '').replace(/^\uFEFF/, '').trim());
    return validateWindowsSelectedInstallerFacts(facts, { packageId, packageVersion });
  } catch { return null; }
}

export function validateWindowsSelectedInstallerFacts(facts, { packageId, packageVersion } = {}) {
  if (!packagePattern.test(packageId || '') || !versionPattern.test(packageVersion || '') || !facts || typeof facts !== 'object' || Array.isArray(facts)
      || facts.id !== packageId || facts.version !== packageVersion || facts.source !== 'winget'
      || !scopeValues.has(facts.scope) || !elevationValues.has(facts.elevation)
      || !installerTypes.has(facts.type) || !installerTypes.has(facts.nestedType) || !architectures.has(facts.architecture)
      || typeof facts.locale !== 'string' || !/^[A-Za-z0-9-]{0,85}$/.test(facts.locale)) return null;
  return Object.freeze({ id: facts.id, version: facts.version, source: facts.source,
    scope: facts.scope, elevation: facts.elevation, type: facts.type, nestedType: facts.nestedType, architecture: facts.architecture, locale: facts.locale });
}

// Avoid an implicit "machine" decision: scope and elevation are independent,
// and an installer may omit either field. A user-scoped installer that elevates
// cannot run as SYSTEM without changing the target user's installation.
export function classifyWindowsSelectedInstaller(facts) {
  if (!validateWindowsSelectedInstallerFacts(facts, { packageId: facts?.id, packageVersion: facts?.version })) return 'unresolved';
  if (facts.scope === 'System' && ['ElevationRequired', 'ElevatesSelf'].includes(facts.elevation)) return 'system-elevation';
  if (facts.scope === 'User' && ['ElevationRequired', 'ElevatesSelf'].includes(facts.elevation)) return 'user-elevation';
  if (facts.elevation === 'ElevationProhibited') return 'ordinary-user';
  return 'unresolved';
}

// Matching these visible fields is necessary but not sufficient to prove an
// installer binary is identical; callers still need trusted runtime, source,
// execution identity and an execution-time binding to the selected artifact.
export function sameWindowsSelectedInstaller(left, right, expected) {
  const first = validateWindowsSelectedInstallerFacts(left, expected);
  const second = validateWindowsSelectedInstallerFacts(right, expected);
  return Boolean(first && second && Object.keys(first).every((key) => first[key] === second[key]));
}
