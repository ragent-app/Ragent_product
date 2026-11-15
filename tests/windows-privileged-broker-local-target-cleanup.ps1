[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$TargetRoot)

$ErrorActionPreference = 'Stop'
if ($env:OS -cne 'Windows_NT' -or $env:GITHUB_ACTIONS -ceq 'true') { throw 'APB_LOCAL_TARGET_CLEANUP_ENVIRONMENT_REFUSED' }
if (-not [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
	throw 'APB_ADMIN_LOCAL_TEST_REQUIRED'
}
$TargetRoot = [IO.Path]::GetFullPath($TargetRoot).TrimEnd('\')
if ($TargetRoot -cnotmatch '^[A-Za-z]:\\Program Files\\Ragent\\BrokerQA$') { throw 'APB_LOCAL_TARGET_PATH_REFUSED' }
$serviceName = 'Ragent-Broker-QA-Target'
if (Get-CimInstance Win32_Service -Filter "Name='$serviceName'" -ErrorAction Stop) { throw 'APB_TARGET_SERVICE_MUST_BE_REMOVED_FIRST' }
if (-not (Test-Path -LiteralPath $TargetRoot -PathType Container)) { throw 'APB_TARGET_ROOT_NOT_FOUND' }
$children = @(Get-ChildItem -LiteralPath $TargetRoot -Force)
if ($children.Count -ne 1 -or $children[0].Name -cne 'Ragent-Broker-QA-Target.exe' -or $children[0].PSIsContainer -or ($children[0].Attributes -band [IO.FileAttributes]::ReparsePoint)) {
	throw 'APB_TARGET_CLEANUP_CONTENTS_REFUSED'
}
$parent = Split-Path -Parent $TargetRoot
Remove-Item -LiteralPath $children[0].FullName -Force
Remove-Item -LiteralPath $TargetRoot -Force
$parentRemoved = $false
if ((Split-Path -Leaf $parent) -ceq 'Ragent' -and (Test-Path -LiteralPath $parent)) {
	if (@(Get-ChildItem -LiteralPath $parent -Force).Count -eq 0) {
		Remove-Item -LiteralPath $parent -Force
		$parentRemoved = $true
	}
}
$remainingService = Get-CimInstance Win32_Service -Filter "Name='$serviceName'" -ErrorAction Stop
$rootRemains = Test-Path -LiteralPath $TargetRoot
[ordered]@{cleanupConfirmed=(-not $remainingService -and -not $rootRemains);serviceRemains=[bool]$remainingService;targetRootRemains=$rootRemains;emptyParentRemoved=$parentRemoved} | ConvertTo-Json -Compress
if ($remainingService -or $rootRemains) { exit 1 }
