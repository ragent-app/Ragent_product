# Read-only first gate, shared C# implementation with the embedded MSI guard.
[CmdletBinding()]
param([string]$PackageRoot='')
$ErrorActionPreference='Stop'
if(-not ('RagentLegacyOwnerInstallGuard' -as [type])) {
    Add-Type -Path (Join-Path $PSScriptRoot 'legacy-owner-install-guard.cs') -ReferencedAssemblies System.Management,System.Core
}
[RagentLegacyOwnerInstallGuard]::AssertCompatible($PackageRoot)
