# Actual Windows Desktop Manager MSI acceptance. This lifecycle test is limited
# to a disposable GitHub-hosted Windows runner or an explicitly selected local
# Windows QA install root.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$MsiPath,
    [Parameter(Mandatory=$true)][string]$EvidenceDirectory,
    [switch]$ManagedOwnerMsi,
    [switch]$LocalWindowsHost
)
$ErrorActionPreference = 'Stop'
$qaProduct = if ($LocalWindowsHost) { 'G:\Program Files\AgentoC Owner Acceptance' } else { 'C:\Program Files\AgentoC Desktop Acceptance' }
$qaData = 'C:\ProgramData\AgentoC'
$env:AGENTOC_INSTALL_ROOT = $qaProduct
$qaServices = @('AgentoC-ControlPlane', 'AgentoC-RunnerSupervisor')
$expectedCandidateName = 'AgentoC-0.3.16.0-x64-unsigned.msi'
$expectedCandidateSha256 = '3257b4bd4b487112e8fa1151b6bffc3663f2d094d4dd093cdb9958d1fe688b2f'
if ([string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) { throw 'DESKTOP_MSI_TEMP_REQUIRED' }
$qaRoot = [IO.Path]::GetFullPath($EvidenceDirectory)
$candidatePath = [IO.Path]::GetFullPath($MsiPath)
$tempRoot = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\') + '\'

function Assert-DisposableRunner {
    $identity = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'DESKTOP_MSI_ADMIN_REQUIRED' }
    if ($LocalWindowsHost) {
        $os = Get-CimInstance Win32_OperatingSystem
        if ($os.ProductType -ne 1) { throw 'DESKTOP_MSI_LOCAL_WINDOWS_CLIENT_REQUIRED' }
        if ($env:GITHUB_ACTIONS -ceq 'true') { throw 'DESKTOP_MSI_LOCAL_MODE_ON_RUNNER_REFUSED' }
    } elseif ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or
        $env:GITHUB_REPOSITORY -cne 'owner/private-qa-repository' -or $env:RUNNER_OS -cne 'Windows' -or
        $env:GITHUB_REF -cnotmatch '^refs/heads/qa/windows-msi-[a-z0-9-]+$') {
        throw 'DESKTOP_MSI_DISPOSABLE_RUNNER_REQUIRED'
    }
    foreach ($path in @($qaRoot, (Split-Path -Parent $candidatePath))) {
        if (-not $path.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'DESKTOP_MSI_PATH_OUTSIDE_RUNNER_TEMP' }
        for ($cursor = $path; $cursor; $cursor = [IO.Path]::GetDirectoryName($cursor)) {
            if (Test-Path -LiteralPath $cursor) {
                if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'DESKTOP_MSI_REPARSE_REFUSED' }
            }
        }
    }
    $programFilesRoot = if ($LocalWindowsHost) { 'G:\Program Files' } else { $env:ProgramFiles }
    $programFilesRoot = [IO.Path]::GetFullPath($programFilesRoot).TrimEnd('\') + '\'
    if (-not ([IO.Path]::GetFullPath($qaProduct)).StartsWith($programFilesRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'DESKTOP_MSI_INSTALL_ROOT_OUTSIDE_PROGRAM_FILES' }
    for ($cursor = $qaProduct; $cursor; $cursor = [IO.Path]::GetDirectoryName($cursor)) {
        if (Test-Path -LiteralPath $cursor -PathType Container) {
            if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'DESKTOP_MSI_INSTALL_ROOT_REPARSE_REFUSED' }
        }
    }
}

function Assert-CleanRunner {
    if ((Split-Path -Leaf $candidatePath) -cne $expectedCandidateName) { throw 'DESKTOP_MSI_CANDIDATE_NAME_MISMATCH' }
    if (-not (Test-Path -LiteralPath $candidatePath -PathType Leaf)) { throw 'DESKTOP_MSI_ARTIFACT_MISSING' }
    if ((Get-Item -LiteralPath $candidatePath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'DESKTOP_MSI_ARTIFACT_REPARSE' }
    if ((Get-FileHash -LiteralPath $candidatePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $expectedCandidateSha256) { throw 'DESKTOP_MSI_CANDIDATE_HASH_MISMATCH' }
    foreach ($service in $qaServices) { if (Get-Service -Name $service -ErrorAction SilentlyContinue) { throw 'DESKTOP_MSI_EXISTING_SERVICE_REFUSED' } }
    foreach ($path in @($qaProduct, $qaData)) { if (Test-Path -LiteralPath $path) { throw 'DESKTOP_MSI_EXISTING_INSTALLATION_REFUSED' } }
    if (Get-NetTCPConnection -LocalPort 7690 -State Listen -ErrorAction SilentlyContinue) { throw 'DESKTOP_MSI_PORT_OCCUPIED' }
    if ($ManagedOwnerMsi -and -not $LocalWindowsHost -and $env:RUNNER_ENVIRONMENT -cne 'github-hosted') { throw 'DESKTOP_MSI_MANAGED_RUNNER_REQUIRED' }
    if ($LocalWindowsHost) {
        $installer = New-Object -ComObject WindowsInstaller.Installer
        $related = @($installer.RelatedProducts('{2D1D9C6B-5BA7-4C70-9A7A-7E7A55E3A001}'))
        if ($related.Count -gt 0) { throw 'DESKTOP_MSI_RELATED_PRODUCT_ALREADY_INSTALLED' }
        foreach ($path in @(
            (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\AgentoC'),
            (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\AgentoC')
        )) {
            if (Test-Path -LiteralPath $path) { throw 'DESKTOP_MSI_SHARED_START_MENU_ENTRY_EXISTS' }
        }
    }
}

function Invoke-Msi([string]$Stage, [string]$Operation, [string]$Package, [switch]$AllowAbsent, [string[]]$Properties=@()) {
    $log = Join-Path $qaRoot ($Stage + '.msi.log')
    $arguments = @($Operation, ('"' + $Package + '"')) + $Properties + @('/qn', '/norestart', '/l*v', ('"' + $log + '"'))
    $process = Start-Process -FilePath 'C:\Windows\System32\msiexec.exe' -ArgumentList $arguments -PassThru -WindowStyle Hidden
    if (-not $process.WaitForExit(300000)) { Stop-Process -Id $process.Id -Force; throw 'DESKTOP_MSI_OPERATION_TIMEOUT' }
    $ok = $process.ExitCode -eq 0 -or ($AllowAbsent -and $process.ExitCode -eq 1605)
    $script:report.operations += @{stage=$Stage; operation=$Operation; exitCode=$process.ExitCode; passed=$ok}
    if (-not $ok) { throw ('DESKTOP_MSI_OPERATION_FAILED:' + $Stage + ':' + $process.ExitCode) }
}

function Wait-ForProduct([string]$Stage) {
    $deadline = (Get-Date).AddSeconds(90)
    $managerRoute = $false
    $managerRouteStatus = $null
    $healthzStatus = $null
    $healthzState = $null
    $healthzOk = $false
    $cliTransport = $null
    do {
        $serviceStates = @($qaServices | ForEach-Object { Get-Service -Name $_ -ErrorAction SilentlyContinue })
        if ($serviceStates.Count -eq 2 -and @($serviceStates | Where-Object Status -ne 'Running').Count -eq 0) {
            try {
                $request = [Net.HttpWebRequest]::Create('http://127.0.0.1:7690/?desktop=manager')
                $request.Proxy = $null
                $request.Accept = 'text/html'
                $request.Timeout = 2500
                $response = $request.GetResponse()
                try {
                    $managerRouteStatus = [int]$response.StatusCode
                    $reader = [IO.StreamReader]::new($response.GetResponseStream())
                    try { $page = $reader.ReadToEnd() } finally { $reader.Dispose() }
                    $managerRoute = $managerRouteStatus -ge 200 -and $managerRouteStatus -lt 300 -and $page.Contains('id="desktopManagerNav"')
                } finally { $response.Dispose() }
                if ($managerRoute) {
                    if (-not $ManagedOwnerMsi) { break }
                    # A managed Owner install is ready only when the local UI
                    # and its CLI transport have both recovered. The HTTP
                    # listener can answer before the named pipe is bound after
                    # a service restart, so poll health instead of sampling it
                    # once on the first successful page response.
                    try {
                        $healthRequest = [Net.HttpWebRequest]::Create('http://127.0.0.1:7690/healthz')
                        $healthRequest.Proxy = $null
                        $healthRequest.Timeout = 2500
                        $healthResponse = $null
                        try { $healthResponse = $healthRequest.GetResponse() }
                        catch [Net.WebException] { if ($_.Exception.Response) { $healthResponse = $_.Exception.Response } }
                        if ($healthResponse) {
                            try {
                                $healthzStatus = [int]$healthResponse.StatusCode
                                $healthReader = [IO.StreamReader]::new($healthResponse.GetResponseStream())
                                try {
                                    $healthPayload = $healthReader.ReadToEnd() | ConvertFrom-Json
                                    $healthzState = $healthPayload.status
                                    $healthzOk = $healthPayload.ok -eq $true
                                    $cliTransport = $healthPayload.cliTransport
                                } finally { $healthReader.Dispose() }
                            } finally { $healthResponse.Dispose() }
                        }
                    } catch {}
                    if ($healthzStatus -eq 200 -and $healthzOk -and $cliTransport -ceq 'ready') { break }
                }
            } catch {}
        }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    $states = @($qaServices | ForEach-Object { $service = Get-Service -Name $_ -ErrorAction SilentlyContinue; if ($service) { @{name=$service.Name; status=[string]$service.Status} } })
    $managedHealthReady = -not $ManagedOwnerMsi -or ($healthzStatus -eq 200 -and $healthzOk -and $cliTransport -ceq 'ready')
    $passed = $managerRoute -and $states.Count -eq 2 -and $managedHealthReady
    $script:report.probes += @{stage=$Stage; services=$states; managerRouteStatus=$managerRouteStatus; managerRouteReady=$managerRoute; healthzStatus=$healthzStatus; healthzOk=$healthzOk; controlPlaneHealth=$healthzState; cliTransport=$cliTransport; managedHealthReady=$managedHealthReady; passed=$passed}
    if (-not $passed) { throw ('DESKTOP_MSI_MANAGER_ROUTE_NOT_READY:' + $Stage) }
}

function Assert-OwnerServices([string]$Stage) {
    if (-not $ManagedOwnerMsi) { return }
    . (Join-Path $env:GITHUB_WORKSPACE 'packaging\windows\prepare-owner-services.ps1') -LibraryOnly
    $plans = @(Get-OwnerServicePreparationPlan)
    $probe = Join-Path $qaRoot 'TokenProbe.exe'
    & 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe' /nologo /target:exe /r:System.Web.Extensions.dll ('/out:' + $probe) (Join-Path $env:GITHUB_WORKSPACE 'tests\fixtures\windows-service-host-token.cs')
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $probe -PathType Leaf)) { throw 'DESKTOP_MSI_TOKEN_PROBE_BUILD_FAILED' }
    $rows = @()
    foreach ($plan in $plans) {
        $service = Get-CimInstance Win32_Service -Filter ("Name='" + $plan.name + "'")
        if (-not $service -or $service.State -cne 'Running' -or $service.StartName -ine $plan.account -or $service.PathName -cne $plan.command) { throw ('DESKTOP_MSI_OWNER_SERVICE_CONFIGURATION_INVALID:' + $plan.name) }
        $children = @(Get-CimInstance Win32_Process -Filter ("ParentProcessId=" + $service.ProcessId) | Where-Object { $_.ExecutablePath -ieq (Join-Path $qaProduct 'payload\node.exe') })
        if ($children.Count -ne 1) { throw ('DESKTOP_MSI_OWNER_NODE_CHILD_INVALID:' + $plan.name) }
        $expectedSid = [Security.Principal.NTAccount]::new('NT SERVICE', $plan.name).Translate([Security.Principal.SecurityIdentifier]).Value
        $facts = @()
        foreach ($taskPid in @([int]$service.ProcessId, [int]$children[0].ProcessId)) {
            $raw = & $probe ([string]$taskPid)
            if ($LASTEXITCODE -ne 0) { throw 'DESKTOP_MSI_TOKEN_PROBE_FAILED' }
            $token = $raw | ConvertFrom-Json
            if ($token.sid -cne $expectedSid -or $token.integrityRid -ne 8192 -or $token.sessionId -ne 0 -or $token.elevated -or $token.enabledAdministrators -or @($token.privileges | Where-Object { $_ -cne 'SeChangeNotifyPrivilege' }).Count -gt 0) { throw ('DESKTOP_MSI_OWNER_TOKEN_INVALID:' + $plan.name) }
            $facts += $token
        }
        $rows += @{name=$plan.name; account=$service.StartName; command=$service.PathName; state=$service.State; hostPid=$service.ProcessId; nodePid=$children[0].ProcessId; tokenFacts=$facts}
    }
    if ($rows.Count -ne 2 -or $rows[0].tokenFacts[0].sid -ceq $rows[1].tokenFacts[0].sid) { throw 'DESKTOP_MSI_OWNER_SERVICE_SIDS_NOT_DISTINCT' }
    $script:report.probes += @{stage=$Stage; ownerServices=$rows; distinctVirtualServiceSids=$true; passed=$true}
}

function Read-OwnerHttp([string]$Path, [Net.CookieContainer]$Cookies) {
    $request = [Net.HttpWebRequest]::Create('http://127.0.0.1:7690' + $Path)
    $request.Proxy = $null
    $request.Timeout = 5000
    $request.AllowAutoRedirect = $false
    $request.CookieContainer = $Cookies
    if ($Path -eq '/') { $request.Accept = 'text/html'; $request.Headers.Add('Sec-Fetch-Site', 'none'); $request.Headers.Add('Sec-Fetch-Mode', 'navigate') }
    $response = $null
    try { $response = $request.GetResponse() }
    catch [Net.WebException] { if ($_.Exception.Response) { $response = $_.Exception.Response } else { throw } }
    try {
        $reader = [IO.StreamReader]::new($response.GetResponseStream())
        try { $body = $reader.ReadToEnd() } finally { $reader.Dispose() }
        return @{status=[int]$response.StatusCode; body=$body; ownerCookie=([string]$response.Headers['Set-Cookie'] -match 'session_token=')}
    } finally { if ($response) { $response.Dispose() } }
}

function Assert-OwnerSessionPersistence([string]$Stage, [Net.CookieContainer]$Cookies, [string]$IdentityHash, [string]$SecretHash) {
    $api = Read-OwnerHttp '/api/sessions' $Cookies
    if ($api.status -ne 200) { throw ('DESKTOP_MSI_OWNER_SESSION_COOKIE_REJECTED:' + $Stage) }
    $identity = Join-Path $qaData 'instances\owner\config\instance-identity.json'
    $secret = Join-Path $qaData 'instances\owner\config\auth-session-secret'
    if ((Get-FileHash -LiteralPath $identity -Algorithm SHA256).Hash -cne $IdentityHash -or (Get-FileHash -LiteralPath $secret -Algorithm SHA256).Hash -cne $SecretHash) { throw ('DESKTOP_MSI_OWNER_PRIVATE_STATE_CHANGED:' + $Stage) }
    # The service keeps SQLite open while it serves the session API. Verify
    # persistence through that API and inspect file metadata without competing
    # for a read handle the database owner intentionally holds.
    $sqliteInfo = Get-Item -LiteralPath (Join-Path $qaData 'instances\owner\config\auth-sessions.sqlite') -ErrorAction Stop
    if ($sqliteInfo.Length -lt 100) { throw 'DESKTOP_MSI_OWNER_SESSION_DB_INVALID' }
    $script:report.probes += @{stage=$Stage; sessionApiStatus=$api.status; existingOwnerCookieAccepted=$true; privateIdentityPreserved=$true; ownerSecretPreserved=$true; sqliteStorePresent=$true; sqliteBytes=[long]$sqliteInfo.Length; passed=$true}
}

function Invoke-ManagerSmoke([string]$Stage, [string]$Mode) {
    $exe = Join-Path $qaProduct 'payload\Desktop\Ragent.exe'
    if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'DESKTOP_MSI_APP_MISSING' }
    $reportPath = Join-Path $qaRoot ($Stage + '.json')
    $helper = Join-Path $env:GITHUB_WORKSPACE 'tests\windows-desktop-manager-live.mjs'
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $stdout = Join-Path $qaRoot ($Stage + '.stdout.log')
    $stderr = Join-Path $qaRoot ($Stage + '.stderr.log')
    $arguments = @(('"' + $helper + '"'), ('"' + $exe + '"'), ('"' + $reportPath + '"'), $Mode)
    $process = Start-Process -FilePath $node -ArgumentList $arguments -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    $smokeTimeoutMs = if ($Mode -eq 'keep-open') { 600000 } else { 210000 }
    if (-not $process.WaitForExit($smokeTimeoutMs)) {
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        throw ('DESKTOP_MANAGER_LIVE_TIMEOUT:' + $Stage)
    }
    if (Test-Path -LiteralPath $stdout -PathType Leaf) { Get-Content -LiteralPath $stdout | Out-Host }
    if (Test-Path -LiteralPath $stderr -PathType Leaf) { Get-Content -LiteralPath $stderr | Out-Host }
    $smokeExitCode = [int]$process.ExitCode
    $script:report.probes += @{stage=($Stage + '-smoke-process'); processId=$process.Id; exitCode=$smokeExitCode; passed=($smokeExitCode -eq 0)}
    if ($smokeExitCode -ne 0) { throw ('DESKTOP_MANAGER_LIVE_FAILED:' + $Stage + ':' + $smokeExitCode) }
    $liveReport = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
    if (-not $liveReport.passed) { throw ('DESKTOP_MANAGER_LIVE_REPORT_FAILED:' + $Stage) }
    $script:report.managerRuns += @{stage=$Stage; mode=$Mode; checks=@($liveReport.checks)}
    if ($Mode -eq 'keep-open') { return [int]($liveReport.checks | Where-Object name -eq 'manager left open for the uninstall lifecycle check' | Select-Object -ExpandProperty pid) }
}

function Invoke-WaitRetryManagerSmoke {
    $exe = Join-Path $qaProduct 'payload\Desktop\Ragent.exe'
    if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'DESKTOP_MSI_APP_MISSING' }
    $controlService = Get-Service -Name 'AgentoC-ControlPlane' -ErrorAction Stop
    if ($controlService.Status -ne 'Running') { throw 'DESKTOP_MSI_CONTROL_PLANE_NOT_RUNNING_BEFORE_WAIT_TEST' }
    Stop-Service -Name $controlService.Name -Force
    $portDeadline = (Get-Date).AddSeconds(20)
    do {
        $listeners = @(Get-NetTCPConnection -LocalPort 7690 -State Listen -ErrorAction SilentlyContinue)
        if ($listeners.Count -eq 0) { break }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $portDeadline)
    if ($listeners.Count -gt 0) { Start-Service -Name $controlService.Name; throw 'DESKTOP_MSI_CONTROL_PLANE_PORT_DID_NOT_CLOSE' }

    $reportPath = Join-Path $qaRoot 'manager-wait-retry.json'
    $checkpointPath = $reportPath + '.waiting'
    $helper = Join-Path $env:GITHUB_WORKSPACE 'tests\windows-desktop-manager-live.mjs'
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $process = $null
    try {
        $arguments = @(('"' + $helper + '"'), ('"' + $exe + '"'), ('"' + $reportPath + '"'), 'wait')
        $process = Start-Process -FilePath $node -ArgumentList $arguments -PassThru -WindowStyle Hidden
        $deadline = (Get-Date).AddSeconds(45)
        do {
            if (Test-Path -LiteralPath $checkpointPath -PathType Leaf) { break }
            if ($process.HasExited) { throw ('DESKTOP_MANAGER_WAIT_SCREEN_FAILED:' + $process.ExitCode) }
            Start-Sleep -Milliseconds 250
        } while ((Get-Date) -lt $deadline)
        if (-not (Test-Path -LiteralPath $checkpointPath -PathType Leaf)) { throw 'DESKTOP_MANAGER_WAIT_SCREEN_TIMEOUT' }

        Start-Service -Name $controlService.Name
        if (-not $process.WaitForExit(150000)) { Stop-Process -Id $process.Id -Force; throw 'DESKTOP_MANAGER_RECOVERY_CONNECT_TIMEOUT' }
        if ($process.ExitCode -ne 0) { throw ('DESKTOP_MANAGER_RECOVERY_CONNECT_FAILED:' + $process.ExitCode) }
        $liveReport = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
        if (-not $liveReport.passed) { throw 'DESKTOP_MANAGER_WAIT_RETRY_REPORT_FAILED' }
        $script:report.managerRuns += @{stage='wait-retry-recovery'; mode='wait'; checks=@($liveReport.checks)}
        $script:report.probes += @{stage='service-recovery'; serviceStartedAfterWaitScreen=$true; managerConnected=$true; passed=$true}
    } finally {
        $current = Get-Service -Name $controlService.Name -ErrorAction SilentlyContinue
        if ($current -and $current.Status -ne 'Running') { Start-Service -Name $controlService.Name }
        if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
    }
}

function Save-ServiceSnapshot([string]$Stage) {
    $states = @($qaServices | ForEach-Object { $service = Get-Service -Name $_ -ErrorAction SilentlyContinue; if ($service) { [string]$service.Status } else { 'Absent' } })
    $script:report.probes += @{stage=$Stage; serviceStates=$states}
    return ,$states
}

function Assert-Removed([string]$Stage) {
    $services = @($qaServices | ForEach-Object { Get-Service -Name $_ -ErrorAction SilentlyContinue })
    $processes = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($qaProduct + '\', [StringComparison]::OrdinalIgnoreCase) })
    $productExists = Test-Path -LiteralPath (Join-Path $qaProduct 'AgentoC.ServiceHost.exe')
    $pass = $services.Count -eq 0 -and $processes.Count -eq 0 -and -not $productExists
    $script:report.probes += @{stage=$Stage; servicesRemaining=$services.Count; productProcesses=@($processes | Select-Object ProcessId,Name); productExists=$productExists; passed=$pass}
    if (-not $pass) { throw ('DESKTOP_MSI_REMOVE_INCOMPLETE:' + $Stage) }
}

$report = [ordered]@{
    passed = $false
    actualMsi = $true
    disposableGitHubRunner = (-not $LocalWindowsHost)
    localWindowsHost = $LocalWindowsHost.IsPresent
    managedOwnerMsi = $ManagedOwnerMsi.IsPresent
    requestedInstallRoot = $qaProduct
    candidateMsi = $expectedCandidateName
    candidateSha256 = $null
    candidateInstallerBytes = $null
    startedAt = (Get-Date).ToUniversalTime().ToString('o')
    operations = @()
    probes = @()
    managerRuns = @()
    failures = @()
    cleanupConfirmed = $false
}
$attempted = $false
$openManagerPid = $null
$ownerCookies = [Net.CookieContainer]::new()
$identityPath = Join-Path $qaData 'instances\owner\config\instance-identity.json'
$secretPath = Join-Path $qaData 'instances\owner\config\auth-session-secret'
$identityHash = $null
$secretHash = $null

Assert-DisposableRunner
try {
    New-Item -ItemType Directory -Path $qaRoot -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $qaRoot 'qa-instance.json'), '{"testOnly":true,"purpose":"windows-desktop-manager-msi"}')
    Assert-CleanRunner
    if (-not $ManagedOwnerMsi) { throw 'DESKTOP_MSI_MANAGED_OWNER_REQUIRED' }
    $report.candidateInstallerBytes = (Get-Item -LiteralPath $candidatePath).Length
    $report.candidateSha256 = (Get-FileHash -LiteralPath $candidatePath -Algorithm SHA256).Hash.ToLowerInvariant()
    $attempted = $true
    Invoke-Msi 'managed-owner-fresh-install' '/i' $candidatePath -Properties @(('INSTALLFOLDER="' + $qaProduct + '"'))
    Wait-ForProduct 'managed-owner-fresh-install'
    Assert-OwnerServices 'managed-owner-fresh-install'

    $ownerHome = Read-OwnerHttp '/' $ownerCookies
    if ($ownerHome.status -ne 200 -or -not $ownerHome.ownerCookie) { throw 'DESKTOP_MSI_OWNER_LOCALWEB_COOKIE_NOT_ISSUED' }
    $identityHash = (Get-FileHash -LiteralPath $identityPath -Algorithm SHA256).Hash
    $secretHash = (Get-FileHash -LiteralPath $secretPath -Algorithm SHA256).Hash
    Assert-OwnerSessionPersistence 'fresh-install' $ownerCookies $identityHash $secretHash

    $shortcutRoots = @(
        (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\AgentoC'),
        (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\AgentoC')
    )
    $shortcut = Get-ChildItem -LiteralPath $shortcutRoots -Filter 'AgentoC.lnk' -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $shortcut) { throw 'DESKTOP_MSI_START_MENU_SHORTCUT_MISSING' }
    $shell = New-Object -ComObject WScript.Shell
    $target = $shell.CreateShortcut($shortcut.FullName).TargetPath
    if ([IO.Path]::GetFullPath($target) -cne [IO.Path]::GetFullPath((Join-Path $qaProduct 'payload\Desktop\Ragent.exe'))) { throw 'DESKTOP_MSI_START_MENU_SHORTCUT_TARGET_MISMATCH' }
    $report.probes += @{stage='shortcut'; path=$shortcut.FullName; target=$target; passed=$true}

    $beforeWindow = Save-ServiceSnapshot 'services-before-manager'
    Invoke-WaitRetryManagerSmoke
    $afterWindow = Save-ServiceSnapshot 'services-after-manager-close'
    if (($beforeWindow -join ',') -ne ($afterWindow -join ',') -or @($afterWindow | Where-Object { $_ -ne 'Running' }).Count -gt 0) { throw 'DESKTOP_WINDOW_CHANGED_BACKGROUND_SERVICE_STATE' }
    Wait-ForProduct 'after-manager-close'
    Assert-OwnerServices 'after-manager-close'
    Assert-OwnerSessionPersistence 'service-restart' $ownerCookies $identityHash $secretHash

    $openManagerPid = Invoke-ManagerSmoke 'manager-open-during-uninstall' 'keep-open'
    if (-not $openManagerPid -or -not (Get-Process -Id $openManagerPid -ErrorAction SilentlyContinue)) { throw 'DESKTOP_MANAGER_NOT_OPEN_BEFORE_UNINSTALL' }
    Invoke-Msi 'managed-owner-uninstall-while-manager-open' '/x' $candidatePath
    Start-Sleep -Seconds 3
    if (Get-Process -Id $openManagerPid -ErrorAction SilentlyContinue) { throw 'DESKTOP_MSI_UNINSTALL_LEFT_MANAGER_PROCESS_OPEN' }
    Assert-Removed 'uninstalled-while-manager-open'
    if (-not (Test-Path -LiteralPath $identityPath -PathType Leaf) -or -not (Test-Path -LiteralPath $secretPath -PathType Leaf) -or
        (Get-FileHash -LiteralPath $identityPath -Algorithm SHA256).Hash -cne $identityHash -or
        (Get-FileHash -LiteralPath $secretPath -Algorithm SHA256).Hash -cne $secretHash) { throw 'DESKTOP_MSI_UNINSTALL_DID_NOT_PRESERVE_OWNER_IDENTITY' }
    $report.probes += @{stage='active-uninstall-data-retention'; ownerIdentityRetained=$true; ownerSecretRetained=$true; dataDeleted=$false; passed=$true}
    $openManagerPid = $null
    $report.probes += @{stage='uninstall-with-window-open'; managerClosed=$true; filesRemoved=$true; passed=$true}
    $report.cleanupConfirmed = $true
    $report.passed = $true
} catch {
    $message = $_.Exception.Message -replace '[a-fA-F0-9]{64}', '[redacted]'
    $report.failures += $message
    if ($message -like 'DESKTOP_MSI_OPERATION_FAILED:managed-owner-fresh-install:*') {
        $ownerRoot = Join-Path $qaData 'instances\owner'
        $installStarted = [DateTime]::Parse($report.startedAt).ToLocalTime()
        $appEvents = @()
        $serviceEvents = @()
        try { $appEvents = @(Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName='AgentoC'; StartTime=$installStarted} -ErrorAction SilentlyContinue | Select-Object -First 20 TimeCreated,Id,LevelDisplayName,Message) } catch {}
        try { $serviceEvents = @(Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Service Control Manager'; StartTime=$installStarted} -ErrorAction SilentlyContinue | Where-Object { $_.Id -in @(7000,7009,7011,7023,7024,7031,7034) } | Select-Object -First 30 TimeCreated,Id,LevelDisplayName,Message) } catch {}
        $serviceRows = @()
        foreach ($name in $qaServices) {
            $service = Get-CimInstance Win32_Service -Filter ("Name='" + $name + "'") -ErrorAction SilentlyContinue
            if ($service) { $serviceRows += @{name=$name;state=$service.State;startName=$service.StartName;startMode=$service.StartMode;processId=$service.ProcessId;pathName=$service.PathName} }
        }
        $activationFailure = $null
        $activationFailurePath = Join-Path $ownerRoot 'runtime\owner-msi-activation-failure.json'
        try {
            if (Test-Path -LiteralPath $activationFailurePath -PathType Leaf) {
                $activationFailure = Get-Content -LiteralPath $activationFailurePath -Raw | ConvertFrom-Json
            }
        } catch { $activationFailure = @{readFailed=$true} }
        $state = @{
            identityPresent=(Test-Path -LiteralPath $identityPath -PathType Leaf)
            secretPresent=(Test-Path -LiteralPath $secretPath -PathType Leaf)
            policyPresent=(Test-Path -LiteralPath (Join-Path $ownerRoot 'security\owner-bootstrap-install.json') -PathType Leaf)
            ownerRootPresent=(Test-Path -LiteralPath $ownerRoot -PathType Container)
            activeReceiptPresent=(Test-Path -LiteralPath (Join-Path $qaProduct 'owner-msi.activated.json') -PathType Leaf)
            activationFailure=$activationFailure
            serviceRows=$serviceRows
            applicationEvents=$appEvents
            serviceControlEvents=$serviceEvents
        }
        $report.probes += @{stage='failed-owner-msi-install-diagnostics';state=$state}
        $state | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $qaRoot 'failed-owner-msi-state.json') -Encoding UTF8
    }
} finally {
    if ($openManagerPid) { Stop-Process -Id $openManagerPid -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 2 }
    if ($attempted) {
        foreach ($package in @($candidatePath)) {
            try { Invoke-Msi ('cleanup-' + [IO.Path]::GetFileNameWithoutExtension($package)) '/x' $package -AllowAbsent } catch { $report.failures += 'CLEANUP_MSI_FAILED' }
        }
        try { Assert-Removed 'final-removed'; $report.cleanupConfirmed = $report.cleanupConfirmed -or $true } catch { $report.cleanupConfirmed = $false; $report.failures += 'FINAL_REMOVAL_CHECK_FAILED' }
    }
    $report.passed = $report.passed -and $report.cleanupConfirmed -and $report.failures.Count -eq 0
    $report.completedAt = (Get-Date).ToUniversalTime().ToString('o')
    $report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $qaRoot 'report.json') -Encoding UTF8
}
if (-not $report.passed) { throw 'DESKTOP_MSI_ACCEPTANCE_FAILED; retain runner evidence report' }
