# Real SCM smoke test. Default mode requires a fresh, disposable GitHub-hosted Windows runner.
# -LocalHost is an explicit owner-authorized test mode; it preserves the existing
# Ragent install root and owns only the new Broker child plus Broker state root.
[CmdletBinding()]
param([switch]$LocalHost,[string]$LocalReportPath)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

if ($LocalHost) {
	if ($env:GITHUB_ACTIONS -ceq 'true' -or $env:OS -cne 'Windows_NT') { throw 'APB_LOCAL_MODE_ENVIRONMENT_REFUSED' }
} else {
	if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or
		$env:RUNNER_OS -cne 'Windows' -or $env:GITHUB_REPOSITORY -cne 'owner/private-qa-repository' -or
		$env:GITHUB_REF -cnotmatch '^refs/heads/qa/windows-broker-[a-z0-9-]+$') {
		throw 'APB_DISPOSABLE_RUNNER_REQUIRED'
	}
}
if (-not [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
	if ($LocalHost) { throw 'APB_ADMIN_LOCAL_TEST_REQUIRED' }
	throw 'APB_ADMIN_RUNNER_REQUIRED'
}

$name = 'Ragent-PrivilegedBroker'
$probeService = 'Ragent-ControlPlane'
$runnerProbeService = 'Ragent-RunnerSupervisor'
$product = 'C:\Program Files\Ragent'
$brokerRoot = Join-Path $product 'Broker'
$binary = Join-Path $brokerRoot 'Ragent.PrivilegedBroker.exe'
$probeBinary = Join-Path $brokerRoot 'Ragent.BrokerPipeProbe.exe'
$runnerProbeBinary = Join-Path $brokerRoot 'Ragent.RunnerPipeProbe.exe'
$stateRoot = Join-Path $env:ProgramData 'Ragent-PrivilegedBroker'
$statePath = Join-Path $stateRoot 'state.json'
$brokerSid = $null
$expectedStateDacl = $null
if ($LocalHost) {
	if ([string]::IsNullOrWhiteSpace($LocalReportPath)) { throw 'APB_LOCAL_REPORT_PATH_REQUIRED' }
	$reportPath = [IO.Path]::GetFullPath($LocalReportPath)
	if (Test-Path -LiteralPath $reportPath) { throw 'APB_LOCAL_REPORT_EXISTS' }
} else {
	if ([string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) { throw 'APB_REPORT_DIRECTORY_UNAVAILABLE' }
	$reportPath = Join-Path $env:RUNNER_TEMP 'windows-broker-bootstrap-report.json'
}
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$sourceCommit = $env:GITHUB_SHA
if ([string]::IsNullOrWhiteSpace($sourceCommit)) {
	$sourceCommit = (& git -C $repo rev-parse HEAD).Trim()
	if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($sourceCommit)) { throw 'APB_SOURCE_COMMIT_UNAVAILABLE' }
}
$report = [ordered]@{pass=$false;sourceCommit=$sourceCommit;service=$name;checks=@();cleanupConfirmed=$false;installedProductChanged=$false;localHost=[bool]$LocalHost}
if (Get-CimInstance Win32_Service -Filter "Name='$name'" -ErrorAction Stop) { throw 'APB_EXISTING_SERVICE_REFUSED' }
if (Get-CimInstance Win32_Service -Filter "Name='$probeService'" -ErrorAction Stop) { throw 'APB_EXISTING_PROBE_SERVICE_REFUSED' }
if (Get-CimInstance Win32_Service -Filter "Name='$runnerProbeService'" -ErrorAction Stop) { throw 'APB_EXISTING_RUNNER_PROBE_SERVICE_REFUSED' }
if ($LocalHost) {
	if (-not (Test-Path -LiteralPath $product -PathType Container)) { throw 'APB_LOCAL_PRODUCT_ROOT_REQUIRED' }
	if ((Get-Item -LiteralPath $product -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'APB_LOCAL_PRODUCT_ROOT_REPARSE_REFUSED' }
	if (Test-Path -LiteralPath $brokerRoot) { throw 'APB_EXISTING_BROKER_ROOT_REFUSED' }
} elseif (Test-Path -LiteralPath $product) { throw 'APB_EXISTING_PRODUCT_REFUSED' }
if (Test-Path -LiteralPath $stateRoot) { throw 'APB_EXISTING_STATE_ROOT_REFUSED' }
$ownedPath = if ($LocalHost) { $brokerRoot } else { $product }
$owned = $false
$stateOwned = $false
$registered = $false
$probeRegistered = $false
$runnerProbeRegistered = $false

function Assert-OwnerPath([string]$Path) {
	if ([IO.Path]::GetFullPath($Path).TrimEnd('\') -cne [IO.Path]::GetFullPath($ownedPath).TrimEnd('\')) { throw 'APB_QA_PATH_REFUSED' }
    $pending = [Collections.Generic.Stack[string]]::new()
    $pending.Push($Path)
    while ($pending.Count) {
        $entry = $pending.Pop()
        if ((Get-Item -LiteralPath $entry -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'APB_QA_REPARSE_REFUSED' }
        foreach ($child in @(Get-ChildItem -LiteralPath $entry -Force)) {
            if ($child.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'APB_QA_REPARSE_REFUSED' }
            if ($child.PSIsContainer) { $pending.Push($child.FullName) }
        }
    }
}

function Assert-NoBroadWrite([string]$Path) {
    $acl = Get-Acl -LiteralPath $Path
    $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($owner -notin @('S-1-5-18','S-1-5-32-544')) { throw 'APB_QA_OWNER_REFUSED' }
    $broad = @('S-1-1-0','S-1-5-11','S-1-5-32-545','S-1-5-4','S-1-15-2-1')
    $writeMask = [int64]0x000D0116 # add/write, append, EA, attributes, delete, WRITE_DAC, WRITE_OWNER
    foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
            $rule.IdentityReference.Value -in $broad -and
            ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0 -and
            (([int64]$rule.FileSystemRights -band $writeMask) -ne 0)) {
            throw 'APB_QA_BROAD_WRITE_REFUSED'
        }
    }
}

function Send-BrokerHealthMessage([hashtable]$Request) {
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
            $read = $pipe.Read($header, $offset, 4 - $offset)
            if ($read -le 0) { throw 'APB_QA_HEALTH_RESPONSE_TRUNCATED' }
            $offset += $read
        }
        $length = [BitConverter]::ToUInt32($header, 0)
        if ($length -eq 0 -or $length -gt 65536) { throw 'APB_QA_HEALTH_RESPONSE_SIZE_REFUSED' }
        $body = [byte[]]::new([int]$length)
        $offset = 0
        while ($offset -lt $body.Length) {
            $read = $pipe.Read($body, $offset, $body.Length - $offset)
            if ($read -le 0) { throw 'APB_QA_HEALTH_RESPONSE_TRUNCATED' }
            $offset += $read
        }
        return [Text.Encoding]::UTF8.GetString($body) | ConvertFrom-Json
    } finally {
        $pipe.Dispose()
    }
}

function Assert-AdminCannotOpenRequestPipe {
    $pipe = [IO.Pipes.NamedPipeClientStream]::new('.', 'Ragent.PrivilegedBroker.Request.v2', [IO.Pipes.PipeDirection]::InOut, [IO.Pipes.PipeOptions]::None, [Security.Principal.TokenImpersonationLevel]::Impersonation)
    try {
        try {
            $pipe.Connect(2000)
        } catch [UnauthorizedAccessException] {
            return
        } catch [IO.IOException] {
            if (($_.Exception.HResult -band 0xffff) -eq 5) { return }
            throw
        }
        throw 'APB_QA_ADMIN_OPENED_REQUEST_PIPE'
    } finally {
        $pipe.Dispose()
    }
}

try {
    New-Item -ItemType Directory -Path $brokerRoot -Force | Out-Null
    $owned = $true
    & (Join-Path $repo 'native\windows-privileged-broker\build.ps1') -OutputPath $binary | Out-Null
    $report.binarySha256 = (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant()
    foreach ($path in @($product,$brokerRoot,$binary)) { Assert-NoBroadWrite $path }
    $report.checks += 'administrator-owned-protected-binary-and-ancestors'

    New-Service -Name $name -BinaryPathName ('"' + $binary + '"') -StartupType Manual -DisplayName 'Ragent Privileged Broker QA' | Out-Null
    $registered = $true
    & sc.exe sidtype $name unrestricted | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'APB_QA_SIDTYPE_FAILED' }
    & sc.exe privs $name 'SeAssignPrimaryTokenPrivilege/SeChangeNotifyPrivilege/SeIncreaseQuotaPrivilege/SeTcbPrivilege' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'APB_QA_PRIVILEGES_FAILED' }
    $brokerSid = ([Security.Principal.NTAccount]::new('NT SERVICE', $name)).Translate([Security.Principal.SecurityIdentifier]).Value
    $expectedStateDacl = "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;$brokerSid)"

    & (Join-Path $repo 'native\windows-privileged-broker\build-test-pipe-client.ps1') -OutputPath $probeBinary -ServiceName $probeService | Out-Null
    & (Join-Path $repo 'native\windows-privileged-broker\build-test-pipe-client.ps1') -OutputPath $runnerProbeBinary -ServiceName $runnerProbeService | Out-Null
    foreach ($path in @($probeBinary,$runnerProbeBinary)) { Assert-NoBroadWrite $path }
    $probeBinaryArg = '"' + $probeBinary + '"'
    & sc.exe create $probeService 'binPath=' $probeBinaryArg 'obj=' "NT SERVICE\$probeService" 'start=' 'demand' 'DisplayName=' 'Ragent Broker pipe probe' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'APB_QA_PROBE_SERVICE_CREATE_FAILED' }
    $probeRegistered = $true
    & sc.exe sidtype $probeService unrestricted | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'APB_QA_PROBE_SIDTYPE_FAILED' }
    & sc.exe privs $probeService SeChangeNotifyPrivilege | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'APB_QA_PROBE_PRIVILEGES_FAILED' }
    $runnerProbeBinaryArg = '"' + $runnerProbeBinary + '"'
    & sc.exe create $runnerProbeService 'binPath=' $runnerProbeBinaryArg 'obj=' "NT SERVICE\$runnerProbeService" 'start=' 'demand' 'DisplayName=' 'Ragent Broker supervisor pipe probe' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'APB_QA_RUNNER_PROBE_SERVICE_CREATE_FAILED' }
    $runnerProbeRegistered = $true
    & sc.exe sidtype $runnerProbeService unrestricted | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'APB_QA_RUNNER_PROBE_SIDTYPE_FAILED' }
    & sc.exe privs $runnerProbeService SeChangeNotifyPrivilege | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'APB_QA_RUNNER_PROBE_PRIVILEGES_FAILED' }

    Start-Service -Name $name
    $until = [DateTime]::UtcNow.AddSeconds(20)
    do {
        $service = Get-CimInstance Win32_Service -Filter "Name='$name'"
        if ($service -and $service.State -eq 'Running' -and $service.ProcessId -gt 0) { break }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $until)
    if (-not $service -or $service.State -cne 'Running' -or $service.StartName -cne 'LocalSystem' -or $service.StartMode -cne 'Manual' -or $service.ProcessId -le 0) {
        throw 'APB_QA_SERVICE_NOT_RUNNING'
    }
    if (-not (Test-Path -LiteralPath $stateRoot -PathType Container)) { throw 'APB_QA_SERVICE_DID_NOT_CREATE_STATE_ROOT' }
    $stateOwned = $true
    $stateAclResult = Get-Acl -LiteralPath $stateRoot
    $report.stateRootDacl = $stateAclResult.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
    $report.stateRootDaclProtected = $stateAclResult.AreAccessRulesProtected
    $report.stateRootOwnerSid = $stateAclResult.GetOwner([Security.Principal.SecurityIdentifier]).Value
    $stateRules = @($stateAclResult.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
    $stateExpectedSids = @('S-1-5-18','S-1-5-32-544',$brokerSid)
    $stateRuleMismatch = -not $stateAclResult.AreAccessRulesProtected -or $stateRules.Count -ne 3 -or
        $report.stateRootOwnerSid -notin @('S-1-5-18','S-1-5-32-544')
    foreach ($rule in $stateRules) {
        $sid = $rule.IdentityReference.Value
        if ($sid -cnotin $stateExpectedSids -or ([int64]$rule.FileSystemRights -ne [int64]0x001F01FF) -or
            $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
            $rule.InheritanceFlags -ne ([Security.AccessControl.InheritanceFlags]::ObjectInherit -bor [Security.AccessControl.InheritanceFlags]::ContainerInherit) -or
            $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None -or $rule.IsInherited) {
            $stateRuleMismatch = $true
        }
    }
    if ($stateRuleMismatch -or @($stateRules | ForEach-Object { $_.IdentityReference.Value } | Sort-Object -Unique).Count -ne 3) {
        throw 'APB_QA_STATE_DACL_MISMATCH'
    }
    Assert-NoBroadWrite $stateRoot
    $report.checks += 'service-created-protected-programdata-state-root'
    $process = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $service.ProcessId)
    if (-not $process -or $process.ExecutablePath -cne $binary) { throw 'APB_QA_PROCESS_MISMATCH' }
    $report.checks += 'real-scm-start-under-system-and-dedicated-service-sid'
    $report.processId = $service.ProcessId

    $health = Send-BrokerHealthMessage @{version=2;type='health'}
    if ($health.type -cne 'health' -or $health.code -cne 'BROKER_DISABLED' -or $health.executionEnabled -ne $false -or -not $health.installationId) {
        throw 'APB_QA_HEALTH_PIPE_REFUSED'
    }
    $readOnly = Send-BrokerHealthMessage @{version=2;type='propose';requestId='qa-request';sessionId='qa-session';runId='qa-run';turnId='qa-turn';actionId='qa-action';operation='service.restart';targetId='Ragent-Broker-QA-Target'}
    if ($readOnly.code -cne 'HEALTH_PIPE_READ_ONLY') { throw 'APB_QA_HEALTH_PIPE_MUTATION_ALLOWED' }
    Assert-AdminCannotOpenRequestPipe
    & sc.exe start $runnerProbeService | Out-Null
    $runnerProbeStartCode = $LASTEXITCODE
    $report.runnerProbeStartReturnCode = [int]$runnerProbeStartCode
    $runnerProbeUntil = [DateTime]::UtcNow.AddSeconds(20)
    do {
        $runnerProbe = Get-CimInstance Win32_Service -Filter "Name='$runnerProbeService'"
        if ($runnerProbe -and $runnerProbe.State -eq 'Stopped') { break }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $runnerProbeUntil)
    if (-not $runnerProbe -or $runnerProbe.State -cne 'Stopped' -or $runnerProbe.ExitCode -ne 0) { throw 'APB_QA_RUNNER_PIPE_OR_BOUNDARY_REFUSAL_FAILED' }
    $runnerState = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    if ($runnerState.requests.'qa-request-1') { throw 'APB_QA_RUNNER_PROPOSAL_REACHED_BROKER' }
    $report.checks += 'runner-service-sid-denied-request-state-binary-and-service-config-access'
    & sc.exe start $probeService | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'APB_QA_PROBE_START_FAILED' }
    $probeUntil = [DateTime]::UtcNow.AddSeconds(20)
    do {
        $probe = Get-CimInstance Win32_Service -Filter "Name='$probeService'"
        if ($probe -and $probe.State -eq 'Stopped') { break }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $probeUntil)
    if (-not $probe -or $probe.State -cne 'Stopped' -or $probe.ExitCode -ne 0) { throw 'APB_QA_CONTROLPLANE_PIPE_PROBE_FAILED' }
    $probeProcessUntil = [DateTime]::UtcNow.AddSeconds(20)
    do {
        $probeProcess = if ($probe.ProcessId -gt 0) { Get-CimInstance Win32_Process -Filter ('ProcessId=' + $probe.ProcessId) -ErrorAction SilentlyContinue } else { $null }
        if (-not $probeProcess) { break }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $probeProcessUntil)
    if ($probeProcess) { throw 'APB_QA_PROBE_PROCESS_REMAINS' }
    $report.checks += 'controlplane-service-sid-proposal-denial-and-durable-state'

    $installationId = $health.installationId
    Stop-Service -Name $name
    $until = [DateTime]::UtcNow.AddSeconds(20)
    do {
        $service = Get-CimInstance Win32_Service -Filter "Name='$name'"
        if ($service -and $service.State -eq 'Stopped' -and $service.ProcessId -eq 0) { break }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $until)
    if (-not $service -or $service.State -cne 'Stopped' -or $service.ProcessId -ne 0) { throw 'APB_QA_RESTART_PRECONDITION_FAILED' }
    Start-Service -Name $name
    $until = [DateTime]::UtcNow.AddSeconds(20)
    do {
        $service = Get-CimInstance Win32_Service -Filter "Name='$name'"
        if ($service -and $service.State -eq 'Running' -and $service.ProcessId -gt 0) { break }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $until)
    if (-not $service -or $service.State -cne 'Running' -or $service.StartName -cne 'LocalSystem' -or $service.ProcessId -le 0) {
        throw 'APB_QA_RESTART_FAILED'
    }
    $healthAfterRestart = Send-BrokerHealthMessage @{version=2;type='health'}
    if ($healthAfterRestart.type -cne 'health' -or $healthAfterRestart.installationId -cne $installationId -or $healthAfterRestart.executionEnabled -ne $false) {
        throw 'APB_QA_PERSISTED_IDENTITY_REFUSED'
    }
    & sc.exe start $probeService | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'APB_QA_REPLAY_PROBE_START_FAILED' }
    $probeUntil = [DateTime]::UtcNow.AddSeconds(20)
    do {
        $probe = Get-CimInstance Win32_Service -Filter "Name='$probeService'"
        if ($probe -and $probe.State -eq 'Stopped') { break }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $probeUntil)
    if (-not $probe -or $probe.State -cne 'Stopped' -or $probe.ExitCode -ne 0) { throw 'APB_QA_PERSISTED_REQUEST_REFUSED' }
    $durableState = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    $durableRequest = $durableState.requests.'qa-request-1'
    if (-not $durableRequest -or $durableRequest.status -cne 'denied' -or $durableRequest.code -cne 'BROKER_TARGET_NOT_CONFIGURED' -or
        @($durableState.audit | Where-Object { $_.requestId -ceq 'qa-request-1' -and $_.event -ceq 'request.denied' }).Count -ne 1) {
        throw 'APB_QA_DURABLE_DENIAL_OR_AUDIT_REFUSED'
    }
    $report.checks += 'persisted-installation-id-idempotent-replay-and-denial-audit-after-service-restart'

    Stop-Service -Name $name
    $until = [DateTime]::UtcNow.AddSeconds(20)
    do {
        $service = Get-CimInstance Win32_Service -Filter "Name='$name'"
        if ($service -and $service.State -eq 'Stopped' -and $service.ProcessId -eq 0) { break }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $until)
    if (-not $service -or $service.State -cne 'Stopped' -or $service.ProcessId -ne 0) { throw 'APB_QA_STOP_FAILED' }
    if (Get-CimInstance Win32_Process -Filter ('ProcessId=' + $report.processId)) { throw 'APB_QA_PROCESS_REMAINS' }
    $report.checks += 'scm-stop-removes-process'
    $report.pass = $true
} catch {
    $report.error = $_.Exception.GetBaseException().Message
    $report.pass = $false
    if ($registered) {
        $failedService = Get-CimInstance Win32_Service -Filter "Name='$name'" -ErrorAction SilentlyContinue
        if ($failedService) {
            $report.serviceState = [string]$failedService.State
            $report.serviceWin32ExitCode = [uint32]$failedService.ExitCode
            $report.serviceSpecificExitCode = [uint32]$failedService.ServiceSpecificExitCode
            $report.serviceProcessId = [uint32]$failedService.ProcessId
            $report.startupFailureStage = switch ([uint32]$failedService.ServiceSpecificExitCode) {
                1001 { 'system-identity-check' }
                1002 { 'broker-service-sid-check' }
                1003 { 'protected-state-path-check' }
                1004 { 'state-file-type-check' }
                1005 { 'durable-state-store-open' }
                1006 { 'ipc-server-initialization' }
                1007 { 'ipc-server-runtime' }
                1008 { 'programdata-ancestor-acl-check' }
                1009 { 'broker-state-root-acl-check' }
                1010 { 'existing-state-file-acl-check' }
                default { 'unclassified' }
            }
        }
    }
    try {
        $programDataAcl = Get-Acl -LiteralPath $env:ProgramData
        $report.programDataOwnerSid = $programDataAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value
        $report.programDataDaclProtected = $programDataAcl.AreAccessRulesProtected
        $report.programDataDaclSddl = $programDataAcl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
        $report.programDataDacl = @($programDataAcl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | ForEach-Object {
            [ordered]@{sid=$_.IdentityReference.Value;type=$_.AccessControlType.ToString();rights=[int64]$_.FileSystemRights;
                inheritance=$_.InheritanceFlags.ToString();propagation=$_.PropagationFlags.ToString();inherited=$_.IsInherited}
        })
    } catch { $report.programDataAclError = 'unavailable' }
} finally {
    # The Broker now creates its protected state root itself as LocalSystem.
    # It was verified absent before this test registered or started the service,
    # so recover it even when startup fails after the directory is created.
    if ($registered -and (Test-Path -LiteralPath $stateRoot -PathType Container)) { $stateOwned = $true }
    try {
        if ($runnerProbeRegistered) {
            $runnerProbeCurrent = Get-CimInstance Win32_Service -Filter "Name='$runnerProbeService'" -ErrorAction Stop
            if ($runnerProbeCurrent -and $runnerProbeCurrent.State -ne 'Stopped') { Stop-Service -Name $runnerProbeService -ErrorAction Stop }
            & sc.exe delete $runnerProbeService | Out-Null
            if ($LASTEXITCODE -ne 0) { throw 'APB_QA_RUNNER_PROBE_DELETE_FAILED' }
            $runnerProbeUntil = [DateTime]::UtcNow.AddSeconds(20)
            do {
                if (-not (Get-CimInstance Win32_Service -Filter "Name='$runnerProbeService'" -ErrorAction Stop)) { break }
                Start-Sleep -Milliseconds 200
            } while ([DateTime]::UtcNow -lt $runnerProbeUntil)
            if (Get-CimInstance Win32_Service -Filter "Name='$runnerProbeService'") { throw 'APB_QA_RUNNER_PROBE_SERVICE_REMAINS' }
        }
        if ($probeRegistered) {
            $probeCurrent = Get-CimInstance Win32_Service -Filter "Name='$probeService'" -ErrorAction Stop
            if ($probeCurrent -and $probeCurrent.State -ne 'Stopped') { Stop-Service -Name $probeService -ErrorAction Stop }
            & sc.exe delete $probeService | Out-Null
            if ($LASTEXITCODE -ne 0) { throw 'APB_QA_PROBE_DELETE_FAILED' }
            $probeUntil = [DateTime]::UtcNow.AddSeconds(20)
            do {
                if (-not (Get-CimInstance Win32_Service -Filter "Name='$probeService'" -ErrorAction Stop)) { break }
                Start-Sleep -Milliseconds 200
            } while ([DateTime]::UtcNow -lt $probeUntil)
            if (Get-CimInstance Win32_Service -Filter "Name='$probeService'") { throw 'APB_QA_PROBE_SERVICE_REMAINS' }
        }
        if ($registered) {
            $current = Get-CimInstance Win32_Service -Filter "Name='$name'" -ErrorAction Stop
            if ($current -and $current.State -ne 'Stopped') { Stop-Service -Name $name -ErrorAction Stop }
            & sc.exe delete $name | Out-Null
            if ($LASTEXITCODE -ne 0) { throw 'APB_QA_DELETE_FAILED' }
            $until = [DateTime]::UtcNow.AddSeconds(20)
            do {
                if (-not (Get-CimInstance Win32_Service -Filter "Name='$name'" -ErrorAction Stop)) { break }
                Start-Sleep -Milliseconds 200
            } while ([DateTime]::UtcNow -lt $until)
            if (Get-CimInstance Win32_Service -Filter "Name='$name'") { throw 'APB_QA_SERVICE_REMAINS' }
        }
        if ($owned) {
            Assert-OwnerPath $ownedPath
            $servicePath = if ($LocalHost) { $brokerRoot } else { $product }
            if (@(Get-CimInstance Win32_Service | Where-Object { $_.PathName -and $_.PathName.Contains($servicePath) }).Count) { throw 'APB_QA_PRODUCT_IN_USE' }
            foreach ($probePath in @($probeBinary,$runnerProbeBinary)) { if (Test-Path -LiteralPath $probePath) { Remove-Item -LiteralPath $probePath -Force } }
            Remove-Item -LiteralPath $ownedPath -Recurse -Force
        }
        if ($stateOwned) {
            if ([IO.Path]::GetFullPath($stateRoot).TrimEnd('\') -cne [IO.Path]::GetFullPath((Join-Path $env:ProgramData 'Ragent-PrivilegedBroker')).TrimEnd('\')) { throw 'APB_QA_STATE_PATH_REFUSED' }
            $stateChildren = @(Get-ChildItem -LiteralPath $stateRoot -Force)
            if ($stateChildren.Count -gt 1 -or ($stateChildren | Where-Object { $_.Name -cne 'state.json' -or $_.PSIsContainer -or ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) }).Count) { throw 'APB_QA_STATE_CONTENTS_REFUSED' }
            if (Test-Path -LiteralPath $statePath) { Remove-Item -LiteralPath $statePath -Force }
            Remove-Item -LiteralPath $stateRoot -Force
        }
        $report.cleanupConfirmed = $true
    } catch {
        $report.cleanupError = $_.Exception.GetBaseException().Message
        $report.pass = $false
    }
    $report.completedAt = [DateTime]::UtcNow.ToString('o')
    [IO.File]::WriteAllText($reportPath, ($report | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
}
$report | ConvertTo-Json -Depth 5 -Compress
if (-not $report.pass -or -not $report.cleanupConfirmed) { exit 1 }
