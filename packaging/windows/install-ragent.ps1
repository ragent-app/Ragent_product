[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [ValidateSet('Install', 'Upgrade', 'Repair', 'Uninstall')]
    [string]$Action = 'Install',
    [Parameter(Mandatory = $true)] [string]$PackageRoot,
    [string]$Version = '',
    [switch]$PurgeData
)

$ErrorActionPreference = 'Stop'
# No service stop/delete, ACL repair, backup or payload change before this gate.
& (Join-Path $PSScriptRoot 'assert-legacy-owner-install.ps1') -PackageRoot $PackageRoot
$ProductRoot = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)) 'Ragent'
$DataRoot = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)) 'Ragent'
$InstanceRoot = Join-Path $DataRoot 'instances\owner'
$ConfigRoot = Join-Path $InstanceRoot 'config'
$RunSpoolRoot = Join-Path $InstanceRoot 'data\chat-runs'
$ProviderHomesRoot = Join-Path $InstanceRoot 'provider-homes'
$AuthSecretFile = Join-Path $ConfigRoot 'auth-session-secret'
$HarnessRoot = Join-Path $DataRoot 'harnesses'
$CurrentRoot = Join-Path $ProductRoot 'current'
$VersionsRoot = Join-Path $ProductRoot 'versions'
$ServiceHost = Join-Path $ProductRoot 'Ragent.ServiceHost.exe'
$NodePath = Join-Path $CurrentRoot 'node.exe'
$ControlScript = Join-Path $CurrentRoot 'chat-server.mjs'
$SupervisorScript = Join-Path $CurrentRoot 'chat\runner-supervisor-daemon.mjs'
$Services = @('Ragent-ControlPlane', 'Ragent-RunnerSupervisor')

function Require-Windows {
    $os = Get-CimInstance Win32_OperatingSystem
    if ([Environment]::Is64BitOperatingSystem -ne $true -or [int]$os.BuildNumber -lt 17763) {
        throw 'Ragent Windows package requires 64-bit Windows 10 1809 or newer.'
    }
}

function Register-EventSource {
    $key = 'HKLM:\SYSTEM\CurrentControlSet\Services\EventLog\Application\Ragent'
    New-Item -Path $key -Force | Out-Null
    New-ItemProperty -Path $key -Name EventMessageFile -Value '%SystemRoot%\System32\EventCreate.exe' -PropertyType ExpandString -Force | Out-Null
    New-ItemProperty -Path $key -Name TypesSupported -Value 7 -PropertyType DWord -Force | Out-Null
}

function Set-DataAcl {
    New-Item -ItemType Directory -Force -Path $ConfigRoot | Out-Null
    New-Item -ItemType Directory -Force -Path $RunSpoolRoot | Out-Null
    New-Item -ItemType Directory -Force -Path $ProviderHomesRoot | Out-Null
    New-Item -ItemType Directory -Force -Path $HarnessRoot | Out-Null
    # icacls accepts the well-known names here on all supported Windows
    # editions.  Passing the SID form with a leading '*' is intended for
    # localized icacls output, but is parsed as a separate invalid argument
    # by the Windows 11 inbox implementation.
    & icacls.exe $DataRoot /inheritance:r /grant:r 'SYSTEM:(OI)(CI)(F)' 'Administrators:(OI)(CI)(F)' "${env:USERNAME}:(OI)(CI)(F)" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Unable to apply Ragent ProgramData ACL.' }
}

function New-AuthSessionSecret {
    $bytes = New-Object byte[] 32
    $random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $random.GetBytes($bytes) } finally { $random.Dispose() }
    return ([BitConverter]::ToString($bytes).Replace('-', '')).ToLowerInvariant()
}

function Ensure-AuthSessionSecret {
    if (Test-Path -LiteralPath $AuthSecretFile -PathType Leaf) {
        $existing = [System.IO.File]::ReadAllText($AuthSecretFile).Trim()
        if ($existing -notmatch '^[0-9a-fA-F]{64}$') {
            throw "The Ragent authentication session secret is invalid: $AuthSecretFile"
        }
        return
    }
    $secret = New-AuthSessionSecret
    $stream = $null
    try {
        $stream = [System.IO.File]::Open(
            $AuthSecretFile,
            [System.IO.FileMode]::CreateNew,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::None
        )
        $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($secret)
        $stream.Write($bytes, 0, $bytes.Length)
    } catch [System.IO.IOException] {
        # A service host or another installer may have won the first-create
        # race. Reuse its valid secret instead of rotating persisted cookies.
        if (-not (Test-Path -LiteralPath $AuthSecretFile -PathType Leaf)) { throw }
        $existing = [System.IO.File]::ReadAllText($AuthSecretFile).Trim()
        if ($existing -notmatch '^[0-9a-fA-F]{64}$') {
            throw "The Ragent authentication session secret is invalid: $AuthSecretFile"
        }
    } finally {
        if ($stream) { $stream.Dispose() }
    }
}

function Stop-RagentServices {
    foreach ($name in $Services) {
        $service = Get-Service -Name $name -ErrorAction SilentlyContinue
        if ($service -and $service.Status -ne 'Stopped') { Stop-Service -Name $name -Force -ErrorAction Stop }
    }
}

function Install-Service($name, $role, $script) {
    $bin = '"{0}" --role {1} --node "{2}" --script "{3}" --working-directory "{4}" --config-dir "{5}"' -f $ServiceHost, $role, $NodePath, $script, $CurrentRoot, $ConfigRoot
    if (-not (Get-Service -Name $name -ErrorAction SilentlyContinue)) {
        New-Service -Name $name -BinaryPathName $bin -StartupType Automatic -DisplayName $name | Out-Null
        if (-not (Get-Service -Name $name -ErrorAction SilentlyContinue)) { throw "Unable to create Windows service: $name." }
    } else {
        & sc.exe config $name binPath= $bin start= auto | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Unable to configure Windows service: $name (sc.exe exit $LASTEXITCODE)." }
    }
    & sc.exe failure $name reset= 86400 actions= restart/5000/restart/15000/restart/60000 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Unable to configure service recovery: $name (sc.exe exit $LASTEXITCODE)." }
    & sc.exe description $name "Ragent $role service" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Unable to configure service description: $name (sc.exe exit $LASTEXITCODE)." }
}

function Activate-Version {
    param([string]$SourceRoot, [string]$TargetVersion)
    if (-not (Test-Path (Join-Path $SourceRoot 'chat-server.mjs'))) { throw 'PackageRoot does not contain chat-server.mjs.' }
    $target = Join-Path $VersionsRoot $TargetVersion
    New-Item -ItemType Directory -Force -Path $VersionsRoot | Out-Null
    if (Test-Path $target) { Remove-Item -Recurse -Force $target }
    Copy-Item -Recurse -Force $SourceRoot $target
    $stagingCurrent = Join-Path $ProductRoot ('current.' + [guid]::NewGuid().ToString('N'))
    cmd.exe /c "mklink /J `"$stagingCurrent`" `"$target`"" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Unable to create current version junction.' }
    if (Test-Path $CurrentRoot) { Rename-Item $CurrentRoot ($CurrentRoot + '.previous.' + [guid]::NewGuid().ToString('N')) }
    Rename-Item $stagingCurrent 'current'
}

function Backup-Configuration {
    if (-not (Test-Path $ConfigRoot)) { return $null }
    $backup = Join-Path $DataRoot ('backups\' + (Get-Date).ToUniversalTime().ToString('yyyyMMdd.HHmmss'))
    New-Item -ItemType Directory -Force (Split-Path -Parent $backup) | Out-Null
    Copy-Item -Recurse -Force $ConfigRoot $backup
    return $backup
}

function Restore-Previous-Version {
    $previous = Get-ChildItem -Path $ProductRoot -Directory -Filter 'current.previous.*' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $previous) { return $false }
    if (Test-Path $CurrentRoot) { Remove-Item -Force $CurrentRoot }
    Rename-Item $previous.FullName 'current'
    return $true
}

Require-Windows
if (-not (Test-Path $PackageRoot)) { throw "PackageRoot not found: $PackageRoot" }
if (-not $Version) { $Version = (Get-Date).ToUniversalTime().ToString('yyyyMMdd.HHmmss') }

switch ($Action) {
    'Install' { Activate-Version $PackageRoot $Version; New-Item -ItemType Directory -Force -Path $ProductRoot | Out-Null; Copy-Item (Join-Path $PackageRoot 'Ragent.ServiceHost.exe') $ServiceHost -Force }
    'Upgrade' {
        $null = Backup-Configuration
        Stop-RagentServices
        try { Activate-Version $PackageRoot $Version; Copy-Item (Join-Path $PackageRoot 'Ragent.ServiceHost.exe') $ServiceHost -Force }
        catch { [void](Restore-Previous-Version); throw }
    }
    'Repair' { if (-not (Test-Path $CurrentRoot)) { throw 'Cannot repair without an installed current version.' }; Set-DataAcl }
    'Uninstall' { Stop-RagentServices; foreach ($name in $Services) { & sc.exe delete $name | Out-Null }; if ($PurgeData) { Remove-Item -Recurse -Force $DataRoot } }
}

if ($Action -ne 'Uninstall') {
    Register-EventSource
    Set-DataAcl
    Ensure-AuthSessionSecret
    Install-Service 'Ragent-ControlPlane' 'control' $ControlScript
    Install-Service 'Ragent-RunnerSupervisor' 'supervisor' $SupervisorScript
    try {
        Start-Service 'Ragent-RunnerSupervisor'
        Start-Service 'Ragent-ControlPlane'
    } catch {
        if ($Action -eq 'Upgrade' -and (Restore-Previous-Version)) {
            Start-Service 'Ragent-RunnerSupervisor' -ErrorAction SilentlyContinue
            Start-Service 'Ragent-ControlPlane' -ErrorAction SilentlyContinue
        }
        throw
    }
}
