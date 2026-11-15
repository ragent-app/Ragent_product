//go:build windows

package main

// This fixed script receives only server-validated package data and the pinned
// module path. It is never an arbitrary command supplied by the provider. The
// caller must pin the module and obtain a signed, run-bound authorization.
// Package selection is evaluated in the same user scope used for execution.
const ownerInstallScript = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$id = $env:RAGENT_INSTALL_PACKAGE_ID
$version = $env:RAGENT_INSTALL_PACKAGE_VERSION
try { Import-Module -Name $env:RAGENT_INSTALL_MODULE -Force -ErrorAction Stop } catch { exit 20 }
try {
  $sources = @(Get-WinGetSource -Name 'winget' -ErrorAction Stop)
  if ($sources.Count -ne 1) { exit 21 }
  $source = $sources[0]
  $uri = [Uri]$source.Argument
  if ($source.Name -cne 'winget' -or $source.Type -cne 'Microsoft.PreIndexed.Package' -or
      [string]$source.TrustLevel -ine 'Trusted' -or $uri.Scheme -cne 'https' -or
      ($uri.Host -ine 'winget.microsoft.com' -and -not $uri.Host.EndsWith('.winget.microsoft.com', [StringComparison]::OrdinalIgnoreCase)) -or
      $uri.UserInfo -or (-not $uri.IsDefaultPort)) { exit 21 }
  $matches = @(Find-WinGetPackage -Id $id -Source 'winget' -MatchOption Equals -ErrorAction Stop)
  if ($matches.Count -ne 1 -or $matches[0].Id -cne $id -or $matches[0].Source -ine 'winget' -or
      @($matches[0].AvailableVersions) -cnotcontains $version) { exit 22 }
  if ($env:RAGENT_INSTALL_INSPECT -ceq '1' -or $env:RAGENT_INSTALL_SELECTED) {
    try {
      $property = $matches[0].GetType().GetProperty('CatalogPackageCOM', [Reflection.BindingFlags]'Instance,NonPublic')
      if (-not $property) { exit 25 }
      $catalog = $property.GetValue($matches[0])
      $versions = $catalog.AvailableVersions
      if (-not $versions -or $versions.Count -gt 10000) { exit 25 }
      $key = $null
      for ($index = 0; $index -lt $versions.Count; $index++) {
        $candidate = $versions[$index]
        if ($candidate.Version -ceq $version) { if ($key) { exit 25 }; $key = $candidate }
      }
      if (-not $key) { exit 25 }
      $packageVersion = $catalog.GetPackageVersionInfo($key)
      if (-not $packageVersion -or $packageVersion.Id -cne $id -or $packageVersion.Version -cne $version) { exit 25 }
      $optionsType = $property.PropertyType.Assembly.GetType('Microsoft.Management.Deployment.InstallOptions', $true)
      $options = [Activator]::CreateInstance($optionsType)
      $options.PackageInstallMode = 'Silent'
      if ($env:RAGENT_INSTALL_SCOPE -ceq 'user') { $options.PackageInstallScope = 'User' }
      elseif ($env:RAGENT_INSTALL_SCOPE -cne 'default') { exit 23 }
      $installer = $packageVersion.GetApplicableInstaller($options)
      if (-not $installer) { exit 25 }
      if ($env:RAGENT_INSTALL_INSPECT -ceq '1') {
        @{ id = $id; version = $version; source = 'winget'; scope = [string]$installer.Scope;
           elevation = [string]$installer.ElevationRequirement; type = [string]$installer.InstallerType; nestedType = [string]$installer.NestedInstallerType;
           architecture = [string]$installer.Architecture; locale = [string]$installer.Locale } | ConvertTo-Json -Compress
        exit 0
      }
      $expected = $env:RAGENT_INSTALL_SELECTED | ConvertFrom-Json -ErrorAction Stop
      if ($expected.id -cne $id -or $expected.version -cne $version -or $expected.source -cne 'winget' -or
          [string]$installer.Scope -cne $expected.scope -or [string]$installer.ElevationRequirement -cne $expected.elevation -or
          [string]$installer.InstallerType -cne $expected.type -or [string]$installer.NestedInstallerType -cne $expected.nestedType -or
          [string]$installer.Architecture -cne $expected.architecture -or [string]$installer.Locale -cne $expected.locale) { exit 25 }
    } catch { exit 25 }
  }
  $arguments = @{ Id=$id; Version=$version; Source='winget'; MatchOption='Equals'; Mode='Silent'; Confirm=$false; ErrorAction='Stop' }
  if ($env:RAGENT_INSTALL_SCOPE -ceq 'user') { $arguments.Scope = 'User' }
  elseif ($env:RAGENT_INSTALL_SCOPE -cne 'default') { exit 23 }
  $result = @(Install-WinGetPackage @arguments)
  if ($result.Count -ne 1 -or $result[0].Id -cne $id -or $result[0].Source -ine 'winget' -or
      $result[0].Status -cne 'Ok' -or $result[0].InstallerErrorCode -ne 0) { exit 23 }
  if ($result[0].RebootRequired) { exit 24 }
  exit 0
} catch { exit 23 }
`
