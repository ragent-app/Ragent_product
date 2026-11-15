[CmdletBinding()]
param(
    [ValidateSet('Start', 'Stop', 'Status')]
    [string]$Action = 'Start',
    [string]$Root = '',
    [string]$InstanceName = 'owner',
    [ValidateRange(1, 65535)]
    [int]$Port = 7690,
    [string]$InitialUsername = '',
    [string]$SupervisorPipe = '\\.\pipe\ragent-runner-supervisor-owner',
    [switch]$WaitForHealth
)

$ErrorActionPreference = 'Stop'

function Trim-Value([object]$Value) {
    if ($null -eq $Value) { return '' }
    return ([string]$Value).Trim()
}

function Resolve-SourceRoot {
    param([string]$Candidate)
    $value = Trim-Value $Candidate
    if (-not $value) { $value = Trim-Value $env:RAGENT_LIVE_ROOT }
    if (-not $value) { $value = Join-Path $PSScriptRoot '..' }
    $resolved = Resolve-Path -LiteralPath $value -ErrorAction Stop
    return $resolved.Path.TrimEnd('\').TrimEnd('/')
}

function Get-LocalAppDataRoot {
    $value = Trim-Value $env:LOCALAPPDATA
    if (-not $value) {
        $value = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
    }
    if (-not $value -or $value -notmatch '^[a-zA-Z]:\\') {
        throw 'A0 per-user runtime requires a local LOCALAPPDATA path.'
    }
    return ([IO.Path]::GetFullPath($value)).TrimEnd('\').TrimEnd('/')
}

function Normalize-InstanceName([string]$Value) {
    $name = (Trim-Value $Value)
    if (-not $name) { $name = 'owner' }
    $name = $name.Normalize([Text.NormalizationForm]::FormC)
    if ($name -in @('.', '..') -or $name -match '[<>:"/\\|?*\x00-\x1f\x7f]' -or $name.EndsWith('.') -or $name.EndsWith(' ')) {
        throw 'InstanceName must be one valid Windows directory name.'
    }
    $deviceBaseName = ($name.Split('.')[0]).TrimEnd([char[]]('. '))
    if ($deviceBaseName -match '^(?i:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])$') {
        throw 'InstanceName must not be a Windows reserved device name.'
    }
    return $name.ToLowerInvariant()
}

function Get-PerUserPaths {
    param([string]$NormalizedInstanceName)
    $localAppData = Get-LocalAppDataRoot
    $instanceRoot = Join-Path $localAppData ('Ragent\instances\' + $NormalizedInstanceName)
    return [pscustomobject]@{
        localAppData = $localAppData
        instanceRoot = $instanceRoot
        configDir = Join-Path $instanceRoot 'config'
        runtimeDir = Join-Path $instanceRoot 'runtime'
        spoolDir = Join-Path $instanceRoot 'data\chat-runs'
        harnessRoot = Join-Path $localAppData 'Ragent\harnesses'
        providerHomesDir = Join-Path $instanceRoot 'provider-homes'
        workspaceDir = Join-Path $instanceRoot 'workspace'
        stateFile = Join-Path $instanceRoot 'runtime\per-user-runtime.json'
        authSessionSecretFile = Join-Path $instanceRoot 'config\auth-session-secret'
        supervisorLog = Join-Path $instanceRoot 'runtime\logs\supervisor.log'
        supervisorErrorLog = Join-Path $instanceRoot 'runtime\logs\supervisor.err.log'
        controlLog = Join-Path $instanceRoot 'runtime\logs\control-plane.log'
        controlErrorLog = Join-Path $instanceRoot 'runtime\logs\control-plane.err.log'
    }
}

function Assert-NoServiceOverrides {
    foreach ($name in @(
        'RAGENT_WINDOWS_SERVICE_MODE',
        'RAGENT_WINDOWS_SERVICE_ROLE',
        'RAGENT_WINDOWS_SERVICE_STOP_FILE',
        'RAGENT_INSTANCE_ROOT',
        'RAGENT_CONFIG_DIR',
        'RAGENT_RUN_SPOOL_DIR',
        'RAGENT_PROVIDER_HOMES_DIR',
        'RAGENT_WORK_ROOT_DIR',
        'RAGENT_MEMORY_DIR',
        'RAGENT_PLATFORM_SKILLS_DIR'
    )) {
        if (Trim-Value ([Environment]::GetEnvironmentVariable($name, 'Process'))) {
            throw "A0 per-user launcher refuses inherited $name; remove service/runner overrides first."
        }
    }
}

function Ensure-AuthSessionSecret([string]$Path) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        $existing = [IO.File]::ReadAllText($Path).Trim()
        if ($existing -notmatch '^[0-9a-fA-F]{64}$') {
            throw "The per-user authentication session secret is invalid: $Path"
        }
        return $existing.ToLowerInvariant()
    }
    $bytes = New-Object byte[] 32
    $random = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $random.GetBytes($bytes) } finally { $random.Dispose() }
    $secret = ([BitConverter]::ToString($bytes).Replace('-', '')).ToLowerInvariant()
    $stream = $null
    try {
        $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $payload = [Text.UTF8Encoding]::new($false).GetBytes($secret)
        $stream.Write($payload, 0, $payload.Length)
        $stream.Flush()
        return $secret
    } catch [IO.IOException] {
        if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw }
        $existing = [IO.File]::ReadAllText($Path).Trim()
        if ($existing -notmatch '^[0-9a-fA-F]{64}$') {
            throw "The per-user authentication session secret is invalid: $Path"
        }
        return $existing.ToLowerInvariant()
    } finally {
        if ($stream) { $stream.Dispose() }
    }
}

function Read-State([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    try { return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json } catch { throw "Invalid per-user runtime state: $Path" }
}

function Get-ExpectedProcess([int]$ProcessId, [string]$ScriptName) {
    if ($ProcessId -le 0) { return $null }
    return Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue |
        Where-Object { (Trim-Value $_.CommandLine) -match [regex]::Escape($ScriptName) } |
        Select-Object -First 1
}

function Assert-NoActiveRuntime([object]$State) {
    if (-not $State) { return }
    $supervisor = Get-ExpectedProcess ([int]$State.supervisorPid) 'runner-supervisor-daemon.mjs'
    $control = Get-ExpectedProcess ([int]$State.controlPlanePid) 'chat-server.mjs'
    if ($supervisor -or $control) {
        throw "A per-user runtime is already active (control=$($State.controlPlanePid), supervisor=$($State.supervisorPid))."
    }
    Remove-Item -LiteralPath $State.stateFile -Force -ErrorAction SilentlyContinue
}

function Set-PerUserEnvironment([object]$Paths, [string]$NormalizedInstanceName, [string]$SourceRoot, [string]$Secret, [string]$Pipe) {
    foreach ($name in @(
        'RAGENT_WINDOWS_SERVICE_MODE',
        'RAGENT_WINDOWS_SERVICE_ROLE',
        'RAGENT_WINDOWS_SERVICE_STOP_FILE',
        'RAGENT_INSTANCE_ROOT',
        'RAGENT_CONFIG_DIR',
        'RAGENT_RUN_SPOOL_DIR',
        'RAGENT_PROVIDER_HOMES_DIR',
        'RAGENT_WORK_ROOT_DIR',
        'RAGENT_MEMORY_DIR',
        'RAGENT_PLATFORM_SKILLS_DIR'
    )) {
        [Environment]::SetEnvironmentVariable($name, $null, 'Process')
    }
    [Environment]::SetEnvironmentVariable('RAGENT_INSTANCE_NAME', $NormalizedInstanceName, 'Process')
    [Environment]::SetEnvironmentVariable('RAGENT_AUTH_SESSION_SECRET', $Secret, 'Process')
    # These are the two runner-owned write/credential roots.  They must be
    # derived from the validated per-user instance after inherited overrides
    # are cleared, so the Supervisor can validate every launch request.
    [Environment]::SetEnvironmentVariable('RAGENT_RUN_SPOOL_DIR', $Paths.spoolDir, 'Process')
    [Environment]::SetEnvironmentVariable('RAGENT_PROVIDER_HOMES_DIR', $Paths.providerHomesDir, 'Process')
    [Environment]::SetEnvironmentVariable('RAGENT_RUNNER_SUPERVISOR_SOCKET', $Pipe, 'Process')
    [Environment]::SetEnvironmentVariable('RAGENT_RUNNER_SUPERVISOR_REQUIRED', '1', 'Process')
    [Environment]::SetEnvironmentVariable('RAGENT_HARNESS_ROOT', $Paths.harnessRoot, 'Process')
    [Environment]::SetEnvironmentVariable('RAGENT_ALLOW_EMPTY_ACCESS_TOKEN_ON_NETWORK', '0', 'Process')
    [Environment]::SetEnvironmentVariable('RAGENT_DISABLE_SYSTEMD_DETACHED_RUNNER', '1', 'Process')
    [Environment]::SetEnvironmentVariable('CHAT_PORT', [string]$Port, 'Process')
    [Environment]::SetEnvironmentVariable('CHAT_BIND_HOST', '127.0.0.1', 'Process')
    if ($InitialUsername) {
        [Environment]::SetEnvironmentVariable('RAGENT_INITIAL_USERNAME', $InitialUsername.Trim(), 'Process')
    }
    if (-not (Trim-Value $env:PATH).ToLowerInvariant().StartsWith($SourceRoot.ToLowerInvariant())) {
        [Environment]::SetEnvironmentVariable('PATH', "$SourceRoot;$env:PATH", 'Process')
    }
}

function Stop-TrackedProcess([int]$ProcessId, [string]$ScriptName) {
    if ($ProcessId -le 0) { return }
    $process = Get-ExpectedProcess $ProcessId $ScriptName
    if (-not $process) { return }
    & taskkill.exe /PID $ProcessId /T /F | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Unable to stop $ScriptName (PID $ProcessId)." }
}

function Wait-ProcessGone([int]$ProcessId, [string]$ScriptName) {
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (-not (Get-ExpectedProcess $ProcessId $ScriptName)) { return }
        Start-Sleep -Milliseconds 250
    }
    throw "$ScriptName (PID $ProcessId) did not exit."
}

function Stop-PerUserRuntime([object]$Paths) {
    $state = Read-State $Paths.stateFile
    if (-not $state) {
        Write-Output ([pscustomobject]@{ ok = $true; state = 'stopped'; stateFile = $Paths.stateFile } | ConvertTo-Json -Compress)
        return
    }
    Stop-TrackedProcess ([int]$state.controlPlanePid) 'chat-server.mjs'
    Stop-TrackedProcess ([int]$state.supervisorPid) 'runner-supervisor-daemon.mjs'
    Wait-ProcessGone ([int]$state.controlPlanePid) 'chat-server.mjs'
    Wait-ProcessGone ([int]$state.supervisorPid) 'runner-supervisor-daemon.mjs'
    Remove-Item -LiteralPath $Paths.stateFile -Force -ErrorAction SilentlyContinue
    Write-Output ([pscustomobject]@{ ok = $true; state = 'stopped'; stateFile = $Paths.stateFile } | ConvertTo-Json -Compress)
}

function Get-PerUserRuntimeStatus([object]$Paths) {
    $state = Read-State $Paths.stateFile
    if (-not $state) {
        Write-Output ([pscustomobject]@{ ok = $true; state = 'stopped'; stateFile = $Paths.stateFile } | ConvertTo-Json -Compress)
        return
    }
    $control = Get-ExpectedProcess ([int]$state.controlPlanePid) 'chat-server.mjs'
    $supervisor = Get-ExpectedProcess ([int]$state.supervisorPid) 'runner-supervisor-daemon.mjs'
    Write-Output ([pscustomobject]@{
        ok = $true
        state = if ($control -and $supervisor) { 'running' } else { 'degraded' }
        instanceRoot = $state.instanceRoot
        configDir = $state.configDir
        port = [int]$state.port
        controlPlanePid = [int]$state.controlPlanePid
        supervisorPid = [int]$state.supervisorPid
        controlPlaneAlive = [bool]$control
        supervisorAlive = [bool]$supervisor
        stateFile = $Paths.stateFile
    } | ConvertTo-Json -Compress)
}

function Test-HealthResponse([string]$Url) {
    $curlPath = Join-Path ([Environment]::SystemDirectory) 'curl.exe'
    if (-not (Test-Path -LiteralPath $curlPath -PathType Leaf)) { return $false }
    & $curlPath '--silent' '--show-error' '--fail' '--max-time' '5' '--header' 'Connection: close' '--output' 'NUL' $Url | Out-Null
    return ($LASTEXITCODE -eq 0)
}

function Wait-ForHealth([int]$HealthPort) {
    $url = "http://127.0.0.1:$HealthPort/healthz"
    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (Test-HealthResponse $url) { return }
        Start-Sleep -Milliseconds 500
    }
    throw "Per-user Control Plane did not become healthy at $url."
}

if ($env:OS -notmatch 'Windows') { throw 'windows-per-user-runtime.ps1 requires native Windows.' }
$sourceRoot = Resolve-SourceRoot $Root
$normalizedInstanceName = Normalize-InstanceName $InstanceName
$paths = Get-PerUserPaths $normalizedInstanceName
$nodePath = Join-Path $sourceRoot 'node.exe'
if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) { throw "Native Windows node.exe is missing from $sourceRoot." }

if ($Action -eq 'Status') {
    Get-PerUserRuntimeStatus $paths
    exit 0
}
if ($Action -eq 'Stop') {
    Stop-PerUserRuntime $paths
    exit 0
}

Assert-NoServiceOverrides
$state = Read-State $paths.stateFile
Assert-NoActiveRuntime $state
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $paths.supervisorLog) | Out-Null
New-Item -ItemType Directory -Force -Path $paths.harnessRoot | Out-Null
$secret = Ensure-AuthSessionSecret $paths.authSessionSecretFile
if ($SupervisorPipe -notmatch '^\\\\\.\\pipe\\[^\\/]+$') { throw 'SupervisorPipe must be a native Windows named-pipe path.' }
Set-PerUserEnvironment $paths $normalizedInstanceName $sourceRoot $secret $SupervisorPipe

$supervisor = $null
$control = $null
try {
    $supervisor = Start-Process -FilePath $nodePath -ArgumentList @('chat/runner-supervisor-daemon.mjs') -WorkingDirectory $sourceRoot -RedirectStandardOutput $paths.supervisorLog -RedirectStandardError $paths.supervisorErrorLog -PassThru -WindowStyle Hidden
    Start-Sleep -Milliseconds 750
    if ($supervisor.HasExited) { throw "Runner Supervisor exited during startup (code $($supervisor.ExitCode))." }
    $control = Start-Process -FilePath $nodePath -ArgumentList @('chat-server.mjs') -WorkingDirectory $sourceRoot -RedirectStandardOutput $paths.controlLog -RedirectStandardError $paths.controlErrorLog -PassThru -WindowStyle Hidden
    Start-Sleep -Milliseconds 750
    if ($control.HasExited) { throw "Control Plane exited during startup (code $($control.ExitCode))." }
    $state = [pscustomobject]@{
        schemaVersion = 1
        state = 'running'
        instanceName = $normalizedInstanceName
        instanceRoot = $paths.instanceRoot
        configDir = $paths.configDir
        runtimeDir = $paths.runtimeDir
        harnessRoot = $paths.harnessRoot
        stateFile = $paths.stateFile
        port = $Port
        supervisorSocket = $SupervisorPipe
        controlPlanePid = $control.Id
        supervisorPid = $supervisor.Id
        startedAt = [DateTime]::UtcNow.ToString('o')
        launcher = 'scripts/windows-per-user-runtime.ps1'
    }
    [IO.File]::WriteAllText($paths.stateFile, ($state | ConvertTo-Json -Depth 4) + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    if ($WaitForHealth) { Wait-ForHealth $Port }
    Write-Output ($state | ConvertTo-Json -Compress)
} catch {
    if ($control) { Stop-TrackedProcess $control.Id 'chat-server.mjs' }
    if ($supervisor) { Stop-TrackedProcess $supervisor.Id 'runner-supervisor-daemon.mjs' }
    throw
}
