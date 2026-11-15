[CmdletBinding()]
param(
	[Parameter(Mandatory=$true)][string]$LocalReportPath,
	[string]$ExpectedBinarySha256 = '2759b7dd4b1b7b3b54a8b7bf491838cae19ca51663aefca6cb621d06dfa6f997'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ($env:OS -cne 'Windows_NT' -or $env:GITHUB_ACTIONS -ceq 'true') { throw 'APB_LOCAL_PIPE_TEST_ENVIRONMENT_REFUSED' }
if (-not [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
	throw 'APB_LOCAL_PIPE_TEST_ADMIN_REQUIRED'
}

$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$brokerService = 'Ragent-PrivilegedBroker'
$controlPlaneService = 'Ragent-ControlPlane'
$runnerService = 'Ragent-RunnerSupervisor'
$product = 'C:\Program Files\Ragent'
$brokerRoot = Join-Path $product 'Broker'
$brokerBinary = Join-Path $brokerRoot 'Ragent.PrivilegedBroker.exe'
$stateRoot = Join-Path $env:ProgramData 'Ragent-PrivilegedBroker'
$statePath = Join-Path $stateRoot 'state.json'
$probeBinary = Join-Path $brokerRoot 'Ragent.BrokerPipeProbe.exe'
$runnerProbeBinary = Join-Path $brokerRoot 'Ragent.RunnerPipeProbe.exe'
$requestId = 'qa-request-1'
$reportPath = [IO.Path]::GetFullPath($LocalReportPath)
if (Test-Path -LiteralPath $reportPath) { throw 'APB_LOCAL_PIPE_REPORT_EXISTS' }
if ((Get-FileHash -LiteralPath $brokerBinary -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ExpectedBinarySha256.ToLowerInvariant()) {
	throw 'APB_LIVE_BROKER_BINARY_HASH_MISMATCH'
}
if ((Get-Item -LiteralPath $brokerRoot -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'APB_LIVE_BROKER_ROOT_REPARSE_REFUSED' }
foreach ($name in @($controlPlaneService, $runnerService)) {
	if (Get-CimInstance Win32_Service -Filter "Name='$name'" -ErrorAction SilentlyContinue) { throw 'APB_LIVE_PIPE_PROBE_SERVICE_EXISTS' }
}
foreach ($path in @($probeBinary, $runnerProbeBinary)) {
	if (Test-Path -LiteralPath $path) { throw 'APB_LIVE_PIPE_PROBE_BINARY_EXISTS' }
}

$report = [ordered]@{
	pass = $false
	cleanupConfirmed = $false
	service = $brokerService
	requestId = $requestId
	checks = @()
	ownerDataTouched = $false
}
$probeRegistered = $false
$runnerRegistered = $false
$probeCreated = $false
$runnerProbeCreated = $false

function Assert-NoBroadWrite([string]$Path) {
	$acl = Get-Acl -LiteralPath $Path
	$owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
	if ($owner -notin @('S-1-5-18', 'S-1-5-32-544')) { throw 'APB_LIVE_PIPE_PATH_OWNER_REFUSED' }
	$broad = @('S-1-1-0', 'S-1-5-11', 'S-1-5-32-545', 'S-1-5-4', 'S-1-15-2-1')
	$writeMask = [int64]0x000D0116
	foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
		if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
			$rule.IdentityReference.Value -in $broad -and
			($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0 -and
			(([int64]$rule.FileSystemRights -band $writeMask) -ne 0)) { throw 'APB_LIVE_PIPE_BROAD_WRITE_REFUSED' }
	}
}

function Send-BrokerHealth([hashtable]$Request) {
	$pipe = [IO.Pipes.NamedPipeClientStream]::new('.', 'Ragent.PrivilegedBroker.Health.v2', [IO.Pipes.PipeDirection]::InOut, [IO.Pipes.PipeOptions]::None, [Security.Principal.TokenImpersonationLevel]::Impersonation)
	try {
		$pipe.Connect(5000)
		$payload = [Text.Encoding]::UTF8.GetBytes(($Request | ConvertTo-Json -Compress -Depth 4))
		$pipe.Write([BitConverter]::GetBytes([uint32]$payload.Length), 0, 4)
		$pipe.Write($payload, 0, $payload.Length)
		$pipe.Flush()
		$header = [byte[]]::new(4)
		$offset = 0
		while ($offset -lt 4) {
			$count = $pipe.Read($header, $offset, 4 - $offset)
			if ($count -le 0) { throw 'APB_LIVE_PIPE_HEALTH_HEADER_TRUNCATED' }
			$offset += $count
		}
		$length = [BitConverter]::ToUInt32($header, 0)
		if ($length -eq 0 -or $length -gt 65536) { throw 'APB_LIVE_PIPE_HEALTH_FRAME_INVALID' }
		$body = [byte[]]::new([int]$length)
		$offset = 0
		while ($offset -lt $body.Length) {
			$count = $pipe.Read($body, $offset, $body.Length - $offset)
			if ($count -le 0) { throw 'APB_LIVE_PIPE_HEALTH_BODY_TRUNCATED' }
			$offset += $count
		}
		return [Text.Encoding]::UTF8.GetString($body) | ConvertFrom-Json
	} finally { $pipe.Dispose() }
}

function Wait-ProbeStopped([string]$Name, [string]$ExpectedStartName) {
	$until = [DateTime]::UtcNow.AddSeconds(20)
	do {
		$service = Get-CimInstance Win32_Service -Filter "Name='$Name'"
		if ($service -and $service.State -eq 'Stopped' -and $service.ProcessId -eq 0) { break }
		Start-Sleep -Milliseconds 100
	} while ([DateTime]::UtcNow -lt $until)
	if (-not $service -or $service.State -cne 'Stopped' -or $service.ProcessId -ne 0 -or $service.ExitCode -ne 0) { throw 'APB_LIVE_PIPE_PROBE_FAILED' }
	if ($ExpectedStartName -and $service.StartName -cne $ExpectedStartName) { throw 'APB_LIVE_PIPE_PROBE_IDENTITY_MISMATCH' }
	return $service
}

try {
	$broker = Get-CimInstance Win32_Service -Filter "Name='$brokerService'"
	if (-not $broker -or $broker.State -cne 'Running' -or $broker.StartName -cne 'LocalSystem' -or $broker.StartMode -cne 'Auto' -or $broker.PathName.Trim('"') -cne $brokerBinary) {
		throw 'APB_LIVE_BROKER_SERVICE_IDENTITY_MISMATCH'
	}
	$report.sourceCommit = (& git -C $repo rev-parse HEAD).Trim()
	$report.binarySha256 = $ExpectedBinarySha256.ToLowerInvariant()
	$report.brokerProcessId = $broker.ProcessId
	$health = Send-BrokerHealth @{version=2;type='health'}
	if ($health.type -cne 'health' -or $health.code -cne 'BROKER_DISABLED' -or $health.executionEnabled -ne $false) { throw 'APB_LIVE_BROKER_NOT_DISABLED' }
	$report.installationId = $health.installationId
	$report.checks += 'persistent-real-scm-broker-health-pipe-disabled'

	$state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
	$existing = $state.requests.PSObject.Properties[$requestId]
	if ($existing -and ($existing.Value.status -cne 'denied' -or $existing.Value.code -cne 'BROKER_TARGET_NOT_CONFIGURED')) { throw 'APB_LIVE_PIPE_REQUEST_ID_CONFLICT' }
	$report.requestAlreadyPersisted = [bool]$existing

	$adminRequestPipe = [IO.Pipes.NamedPipeClientStream]::new('.', 'Ragent.PrivilegedBroker.Request.v2', [IO.Pipes.PipeDirection]::InOut, [IO.Pipes.PipeOptions]::None, [Security.Principal.TokenImpersonationLevel]::Impersonation)
	try {
		try { $adminRequestPipe.Connect(1500); throw 'APB_LIVE_PIPE_ADMIN_CONNECTED' }
		catch [UnauthorizedAccessException] { }
		catch [IO.IOException] { if (($_.Exception.HResult -band 0xffff) -ne 5) { throw } }
	} finally { $adminRequestPipe.Dispose() }
	$report.checks += 'administrator-denied-request-pipe'

	& (Join-Path $repo 'native\windows-privileged-broker\build-test-pipe-client.ps1') -OutputPath $probeBinary -ServiceName $controlPlaneService | Out-Null
	$probeCreated = $true
	& (Join-Path $repo 'native\windows-privileged-broker\build-test-pipe-client.ps1') -OutputPath $runnerProbeBinary -ServiceName $runnerService | Out-Null
	$runnerProbeCreated = $true
	foreach ($path in @($probeBinary, $runnerProbeBinary)) { Assert-NoBroadWrite $path }

	$probeArg = '"' + $probeBinary + '"'
	& sc.exe create $controlPlaneService 'binPath=' $probeArg 'obj=' "NT SERVICE\$controlPlaneService" 'start=' 'demand' 'DisplayName=' 'Ragent Broker live pipe QA' | Out-Null
	if ($LASTEXITCODE -ne 0) { throw 'APB_LIVE_PIPE_CONTROLPLANE_CREATE_FAILED' }
	$probeRegistered = $true
	& sc.exe sidtype $controlPlaneService unrestricted | Out-Null
	if ($LASTEXITCODE -ne 0) { throw 'APB_LIVE_PIPE_CONTROLPLANE_SID_FAILED' }
	& sc.exe privs $controlPlaneService SeChangeNotifyPrivilege | Out-Null
	if ($LASTEXITCODE -ne 0) { throw 'APB_LIVE_PIPE_CONTROLPLANE_PRIVILEGES_FAILED' }
	& sc.exe start $controlPlaneService | Out-Null
	if ($LASTEXITCODE -ne 0) { throw 'APB_LIVE_PIPE_CONTROLPLANE_START_FAILED' }
	$controlPlaneResult = Wait-ProbeStopped $controlPlaneService "NT SERVICE\$controlPlaneService"
	$state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
	$record = $state.requests.PSObject.Properties[$requestId].Value
	if (-not $record -or $record.status -cne 'denied' -or $record.code -cne 'BROKER_TARGET_NOT_CONFIGURED') { throw 'APB_LIVE_PIPE_CONTROLPLANE_DENIAL_NOT_PERSISTED' }
	$auditCount = @($state.audit | Where-Object { $_.requestId -ceq $requestId -and $_.event -ceq 'request.denied' }).Count
	if ($auditCount -ne 1) { throw 'APB_LIVE_PIPE_DENIAL_AUDIT_INVALID' }
	$report.controlPlaneProbeExitCode = $controlPlaneResult.ExitCode
	$report.denialCode = $record.code
	$report.denialAuditCount = $auditCount
	$report.checks += 'real-controlplane-service-sid-proposal-denied-and-audited-by-broker-scm'

	$runnerArg = '"' + $runnerProbeBinary + '"'
	& sc.exe create $runnerService 'binPath=' $runnerArg 'obj=' "NT SERVICE\$runnerService" 'start=' 'demand' 'DisplayName=' 'Ragent Runner live pipe QA' | Out-Null
	if ($LASTEXITCODE -ne 0) { throw 'APB_LIVE_PIPE_RUNNER_CREATE_FAILED' }
	$runnerRegistered = $true
	& sc.exe sidtype $runnerService unrestricted | Out-Null
	if ($LASTEXITCODE -ne 0) { throw 'APB_LIVE_PIPE_RUNNER_SID_FAILED' }
	& sc.exe privs $runnerService SeChangeNotifyPrivilege | Out-Null
	if ($LASTEXITCODE -ne 0) { throw 'APB_LIVE_PIPE_RUNNER_PRIVILEGES_FAILED' }
	& sc.exe start $runnerService | Out-Null
	if ($LASTEXITCODE -ne 0) { throw 'APB_LIVE_PIPE_RUNNER_START_FAILED' }
	$runnerResult = Wait-ProbeStopped $runnerService "NT SERVICE\$runnerService"
	$state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
	if (-not $state.requests.PSObject.Properties[$requestId] -or $state.requests.PSObject.Properties[$requestId].Value.status -cne 'denied') {
		throw 'APB_LIVE_PIPE_RUNNER_CHANGED_BROKER_STATE'
	}
	$report.runnerProbeExitCode = $runnerResult.ExitCode
	$report.checks += 'runner-service-sid-denied-request-state-binary-and-service-config-access'
	$report.pass = $true
} catch {
	$report.error = $_.Exception.GetBaseException().Message
	$report.pass = $false
} finally {
	try {
		foreach ($entry in @(@{Name=$runnerService;Registered=$runnerRegistered}, @{Name=$controlPlaneService;Registered=$probeRegistered})) {
			if (-not $entry.Registered) { continue }
			$service = Get-CimInstance Win32_Service -Filter "Name='$($entry.Name)'" -ErrorAction SilentlyContinue
			if ($service -and $service.State -ne 'Stopped') { Stop-Service -Name $entry.Name -ErrorAction Stop }
			& sc.exe delete $entry.Name | Out-Null
			if ($LASTEXITCODE -ne 0) { throw 'APB_LIVE_PIPE_PROBE_DELETE_FAILED' }
			$until = [DateTime]::UtcNow.AddSeconds(20)
			do { if (-not (Get-CimInstance Win32_Service -Filter "Name='$($entry.Name)'" -ErrorAction SilentlyContinue)) { break }; Start-Sleep -Milliseconds 100 } while ([DateTime]::UtcNow -lt $until)
			if (Get-CimInstance Win32_Service -Filter "Name='$($entry.Name)'" -ErrorAction SilentlyContinue) { throw 'APB_LIVE_PIPE_PROBE_SERVICE_REMAINS' }
		}
		if ($probeCreated) { if (Test-Path -LiteralPath $probeBinary) { Remove-Item -LiteralPath $probeBinary -Force } }
		if ($runnerProbeCreated) { if (Test-Path -LiteralPath $runnerProbeBinary) { Remove-Item -LiteralPath $runnerProbeBinary -Force } }
		$report.cleanupConfirmed = -not (Get-CimInstance Win32_Service -Filter "Name='$controlPlaneService'" -ErrorAction SilentlyContinue) -and
			-not (Get-CimInstance Win32_Service -Filter "Name='$runnerService'" -ErrorAction SilentlyContinue) -and
			-not (Test-Path -LiteralPath $probeBinary) -and -not (Test-Path -LiteralPath $runnerProbeBinary)
	} catch {
		$report.cleanupConfirmed = $false
		$report.cleanupError = $_.Exception.GetBaseException().Message
		$report.pass = $false
	}
	$report.completedAt = [DateTime]::UtcNow.ToString('o')
	[IO.File]::WriteAllText($reportPath, ($report | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
}

$report | ConvertTo-Json -Depth 6 -Compress
if (-not $report.pass -or -not $report.cleanupConfirmed) { exit 1 }
