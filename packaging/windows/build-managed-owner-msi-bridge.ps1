[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$OutputPath)
$ErrorActionPreference='Stop'
$root=$PSScriptRoot;$null=New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($OutputPath)))
$resources=@('read-owner-bootstrap-discovery.ps1','prepare-owner-services.ps1','prepare-owner-service-data.ps1','managed-owner-msi.ps1','initialize-owner-service-identity.ps1','prepare-owner-install-policy.ps1','prepare-owner-msi-policy.ps1','prepare-owner-msi-upgrade.ps1','remove-owner-msi-policy.ps1','rollback-owner-msi-uninstall.ps1','prevalidate-owner-msi.ps1','check-owner-msi-upgrade.ps1','check-owner-msi-activation.ps1','owner-activation-service-read.cs','owner-service-activation-trial.cs','owner-service-activation-transaction.cs','AgentoC.ServiceHost.cs')|ForEach-Object {('/resource:'+(Join-Path $root $_)+','+$_)}
# MSI launches this helper directly. A console-subsystem executable can flash
# a terminal window during interactive installation or removal; a GUI
# subsystem still supports explicitly redirected stdout/stderr for diagnostics.
$windowsRoot=[Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)
if(-not $windowsRoot -or -not [IO.Path]::IsPathRooted($windowsRoot)){throw 'OMI_WINDOWS_DIRECTORY_UNAVAILABLE'}
$compiler=Join-Path $windowsRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
& $compiler /nologo /target:winexe /main:ManagedOwnerMsiBridge /r:System.Management.dll /r:System.ServiceProcess.dll /r:System.Security.dll /r:System.Web.Extensions.dll ('/out:'+$OutputPath) @resources (Join-Path $root 'managed-owner-msi-bridge.cs') (Join-Path $root 'owner-msi-relocation-journal.cs') (Join-Path $root 'legacy-voice-retirement.cs') (Join-Path $root 'AgentoC.ServiceHost.cs') (Join-Path $root 'owner-service-activation-trial.cs')
if($LASTEXITCODE -ne 0){throw 'OMI_BRIDGE_COMPILE_FAILED'}
