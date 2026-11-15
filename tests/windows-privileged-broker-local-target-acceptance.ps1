[CmdletBinding()]
param(
	[Parameter(Mandatory=$true)][string]$TargetRoot,
	[string]$ReportPath
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

if ($env:OS -cne 'Windows_NT' -or $env:GITHUB_ACTIONS -ceq 'true') {
	throw 'APB_LOCAL_TARGET_TEST_ENVIRONMENT_REFUSED'
}
if (-not [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
	throw 'APB_ADMIN_LOCAL_TEST_REQUIRED'
}

$TargetRoot = [IO.Path]::GetFullPath($TargetRoot).TrimEnd('\')
if ($TargetRoot -cnotmatch '^[A-Za-z]:\\Program Files\\Ragent\\BrokerQA$') {
	throw 'APB_LOCAL_TARGET_PATH_REFUSED'
}
if (Test-Path -LiteralPath $TargetRoot) { throw 'APB_EXISTING_TARGET_ROOT_REFUSED' }
$targetParent = Split-Path -Parent $TargetRoot
$targetParentExisted = Test-Path -LiteralPath $targetParent
$serviceName = 'Ragent-Broker-QA-Target'
if (Get-CimInstance Win32_Service -Filter "Name='$serviceName'" -ErrorAction Stop) { throw 'APB_EXISTING_TARGET_SERVICE_REFUSED' }

if ([string]::IsNullOrWhiteSpace($ReportPath)) {
	$ReportPath = Join-Path $env:TEMP ('windows-broker-local-target-' + [Guid]::NewGuid().ToString('N') + '.json')
}
$ReportPath = [IO.Path]::GetFullPath($ReportPath)
if (Test-Path -LiteralPath $ReportPath) { throw 'APB_LOCAL_TARGET_REPORT_EXISTS' }

$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$module = Join-Path $repo 'native\windows-privileged-broker'
$testOutput = @()
$testExitCode = 1
$caughtError = $null
try {
	$env:RAGENT_BROKER_RUN_LOCAL_SCM_TARGET_TEST = '1'
	$env:RAGENT_BROKER_LOCAL_TARGET_ROOT = $TargetRoot
	Push-Location $module
	try {
		$testOutput = @(& go.exe test -count=1 -run '^TestBrokerSignedApprovalRestartsFixedLocalSCMService$' -v . 2>&1 | ForEach-Object { [string]$_ })
		$testExitCode = $LASTEXITCODE
	} finally { Pop-Location }
} catch {
	$caughtError = $_.Exception.GetBaseException().Message
} finally {
	Remove-Item Env:RAGENT_BROKER_RUN_LOCAL_SCM_TARGET_TEST -ErrorAction SilentlyContinue
	Remove-Item Env:RAGENT_BROKER_LOCAL_TARGET_ROOT -ErrorAction SilentlyContinue
}

$serviceRemains = [bool](Get-CimInstance Win32_Service -Filter "Name='$serviceName'" -ErrorAction Stop)
$targetRootRemains = Test-Path -LiteralPath $TargetRoot
$parentRemainsUnexpectedly = -not $targetParentExisted -and (Test-Path -LiteralPath $targetParent)
$report = [ordered]@{
	pass = ($testExitCode -eq 0 -and -not $caughtError -and -not $serviceRemains -and -not $targetRootRemains -and -not $parentRemainsUnexpectedly)
	test = 'signed Broker approval restarts one fixed local SCM target'
	targetRoot = $TargetRoot
	service = $serviceName
	testExitCode = $testExitCode
	cleanupConfirmed = (-not $serviceRemains -and -not $targetRootRemains -and -not $parentRemainsUnexpectedly)
	serviceRemains = $serviceRemains
	targetRootRemains = $targetRootRemains
	createdParentRemains = $parentRemainsUnexpectedly
	error = $caughtError
	output = $testOutput
	completedAt = [DateTime]::UtcNow.ToString('o')
}
[IO.File]::WriteAllText($ReportPath, ($report | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
$report | ConvertTo-Json -Depth 5 -Compress
if (-not $report.pass) { exit 1 }
