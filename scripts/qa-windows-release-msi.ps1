# Actual MSI lifecycle, ONLY on a disposable GitHub-hosted Windows runner.
# Never use this entry on an operator's existing Windows installation.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$ArtifactDirectory,
      [Parameter(Mandatory=$true)][string]$EvidenceDirectory)
$ErrorActionPreference='Stop'
$qaServices=@('Ragent-ControlPlane','Ragent-RunnerSupervisor')
$qaProduct='C:\Program Files\Ragent'
$qaData='C:\ProgramData\Ragent'
$qaRoot=[IO.Path]::GetFullPath($EvidenceDirectory)
$qaArtifacts=[IO.Path]::GetFullPath($ArtifactDirectory)
$qaSpec=@{
    preview=@{name='Ragent-0.3.13.29-x64-unsigned.msi';hash='6ae728a6f397024742bea2e0590b9a8fa25650fbdb4c2de49f50249b1f9807a2'}
    previous=@{name='Ragent-0.3.13.28-x64.msi';hash='ad7384d40f2923d5deebc95f0c0923a41f8806d0820f93ad394b4305f85aeda0'}
}
function Assert-QaDisposable {
    if($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or
       $env:GITHUB_REPOSITORY -cne 'owner/private-qa-repository' -or $env:RUNNER_OS -cne 'Windows' -or
       $env:GITHUB_REF -cnotmatch '^refs/heads/qa/windows-msi-[a-z0-9-]+$'){throw 'MSIQ_DISPOSABLE_RUNNER_REQUIRED'}
    $identity=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
    if(-not $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'MSIQ_RUNNER_ADMIN_REQUIRED'}
    if(-not $env:RUNNER_TEMP){throw 'MSIQ_TEMP_REQUIRED'}
    $temp=[IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\')+'\'
    foreach($path in @($qaRoot,$qaArtifacts)){
        if(-not $path.StartsWith($temp,[StringComparison]::OrdinalIgnoreCase)){throw 'MSIQ_PATH_OUTSIDE_RUNNER_TEMP'}
        for($p=$path;$p;$p=[IO.Path]::GetDirectoryName($p)){
            if(Test-Path -LiteralPath $p){if((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'MSIQ_REPARSE_REFUSED'}}
        }
    }
    foreach($name in $qaServices){if(Get-Service -Name $name -ErrorAction SilentlyContinue){throw 'MSIQ_EXISTING_SERVICE_REFUSED'}}
    foreach($path in @($qaProduct,$qaData)){if(Test-Path -LiteralPath $path){throw 'MSIQ_EXISTING_INSTALLATION_REFUSED'}}
    if(Get-NetTCPConnection -LocalPort 7690 -State Listen -ErrorAction SilentlyContinue){throw 'MSIQ_PORT_OCCUPIED'}
    foreach($spec in $qaSpec.Values){
        $file=Join-Path $qaArtifacts $spec.name
        if((Get-Item -LiteralPath $file -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'MSIQ_ARTIFACT_REPARSE'}
        if((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -cne $spec.hash){throw 'MSIQ_ARTIFACT_DIGEST_MISMATCH'}
    }
}
Assert-QaDisposable
New-Item -ItemType Directory -Path $qaRoot|Out-Null
[IO.File]::WriteAllText((Join-Path $qaRoot 'qa-instance.json'),'{"testOnly":true,"purpose":"actual-disposable-msi"}')
$qaReport=[ordered]@{pass=$false;startedAt=(Get-Date).ToUniversalTime().ToString('o');actualMsi=$true;productionHostTouched=$false;runId=$env:GITHUB_RUN_ID;artifacts=$qaSpec;operations=@();probes=@();failures=@();cleanupConfirmed=$false}
$qaAttempted=$false
$qaCurrent=$null
function Invoke-QaMsi([string]$Stage,[string]$Operation,[string]$Kind,[switch]$AllowAbsent){
    $file=Join-Path $qaArtifacts $qaSpec[$Kind].name
    $log=Join-Path $qaRoot ($Stage+'.msi.log')
    $arguments=@($Operation,('"'+$file+'"'),'/qn','/norestart','/l*v',('"'+$log+'"'))
    $proc=Start-Process -FilePath 'C:\Windows\System32\msiexec.exe' -ArgumentList $arguments -PassThru -WindowStyle Hidden
    if(-not $proc.WaitForExit(180000)){Stop-Process -Id $proc.Id -Force;throw 'MSIQ_MSI_DEADLINE'}
    $exit=$proc.ExitCode
    $ok=$exit -eq 0 -or ($AllowAbsent -and $exit -eq 1605)
    $qaReport.operations+=@{stage=$Stage;operation=$Operation;artifact=$Kind;exitCode=$exit;pass=$ok;absentAllowed=$AllowAbsent.IsPresent}
    if(-not $ok){$qaReport.failures+=($Stage+':MSI_EXIT_'+$exit)}
    return $ok
}
function Save-QaLogs([string]$Stage){
    foreach($role in @('control','supervisor')){
        $path=Join-Path $qaData ('instances\owner\config\logs\service-'+$role+'.log')
        if(Test-Path -LiteralPath $path){
            # Only synthetic guest diagnostics; never archive config, DB or keys.
            $text=Get-Content -LiteralPath $path -Tail 250|Out-String
            $text=$text -replace '(?i)(session_token=)[^;\s]+','$1[redacted]'
            [IO.File]::WriteAllText((Join-Path $qaRoot ($Stage+'-'+$role+'.log')),$text)
        }
    }
}
function Read-QaHttp([string]$Path,[switch]$Html){
    $request=[Net.HttpWebRequest]::Create('http://127.0.0.1:7690'+$Path)
    $request.Proxy=$null;$request.Timeout=3000;$request.AllowAutoRedirect=$false
    if($Html){$request.Accept='text/html';$request.Headers.Add('Sec-Fetch-Site','none');$request.Headers.Add('Sec-Fetch-Mode','navigate')}
    $response=$null
    try{$response=$request.GetResponse()}catch [Net.WebException]{if($_.Exception.Response){$response=$_.Exception.Response}else{throw}}
    try{
        $reader=[IO.StreamReader]::new($response.GetResponseStream())
        try{$body=$reader.ReadToEnd()}finally{$reader.Dispose()}
        return @{status=[int]$response.StatusCode;body=$body;ownerCookie=([string]$response.Headers['Set-Cookie'] -match 'session_token=')}
    }finally{if($response){$response.Dispose()}}
}
function Probe-QaProduct([string]$Stage){
    $last=$null;$until=(Get-Date).AddSeconds(35)
    do{
        try{$last=Read-QaHttp '/healthz';if($last.status -eq 200){break}}catch{}
        Start-Sleep -Milliseconds 500
    }while((Get-Date) -lt $until)
    $services=@(Get-CimInstance Win32_Service -Filter "Name='Ragent-ControlPlane' OR Name='Ragent-RunnerSupervisor'"|Sort-Object Name|Select-Object Name,State,StartName,ProcessId)
    $page=$null;try{$page=Read-QaHttp '/' -Html}catch{}
    $pass=$null -ne $last -and $last.status -eq 200 -and $null -ne $page -and $page.status -eq 200 -and $page.ownerCookie -and
          $services.Count -eq 2 -and @($services|Where-Object {$_.State -ne 'Running'}).Count -eq 0
    $qaReport.probes+=@{stage=$Stage;pass=$pass;health=$last;htmlStatus=$page.status;automaticOwner=$page.ownerCookie;services=$services}
    if(-not $pass){$qaReport.failures+=($Stage+':PRODUCT_NOT_READY')}
    Save-QaLogs $Stage
}
function Assert-QaRemoved([string]$Stage){
    $remaining=@(Get-Service -Name $qaServices -ErrorAction SilentlyContinue)
    $processes=@(Get-CimInstance Win32_Process|Where-Object {$_.ExecutablePath -and $_.ExecutablePath.StartsWith($qaProduct+'\',[StringComparison]::OrdinalIgnoreCase)}|Select-Object ProcessId,Name)
    $binaryExists=Test-Path -LiteralPath (Join-Path $qaProduct 'Ragent.ServiceHost.exe')
    $pass=$remaining.Count -eq 0 -and $processes.Count -eq 0 -and -not $binaryExists
    $qaReport.probes+=@{stage=$Stage;pass=$pass;servicesRemaining=$remaining.Count;processesRemaining=$processes;serviceHostPresent=$binaryExists}
    if(-not $pass){$qaReport.failures+=($Stage+':REMOVE_INCOMPLETE')}
    return $pass
}
try{
    $qaAttempted=$true;$qaCurrent='preview'
    if(Invoke-QaMsi 'fresh-install' '/i' 'preview'){
        Probe-QaProduct 'fresh'
        foreach($name in $qaServices){Stop-Service -Name $name -ErrorAction Stop}
        foreach($name in @('Ragent-RunnerSupervisor','Ragent-ControlPlane')){Start-Service -Name $name -ErrorAction Stop}
        Probe-QaProduct 'restart'
        if(Invoke-QaMsi 'repair' '/fa' 'preview'){Probe-QaProduct 'repair'}
    }
    Save-QaLogs 'before-remove'
    if(Invoke-QaMsi 'fresh-uninstall' '/x' 'preview'){$null=Assert-QaRemoved 'fresh-removed'}
    if(@(Get-Service -Name $qaServices -ErrorAction SilentlyContinue).Count -eq 0){
        $qaCurrent='previous'
        if(Invoke-QaMsi 'previous-install' '/i' 'previous'){
            Probe-QaProduct 'previous'
            $sentinel=Join-Path $qaData 'instances\owner\config\qa-preserve.txt'
            [IO.File]::WriteAllText($sentinel,'SYNTHETIC-UPGRADE-PRESERVE')
            $secret=Join-Path $qaData 'instances\owner\config\auth-session-secret'
            $before=(Get-FileHash -LiteralPath $secret -Algorithm SHA256).Hash
            $qaCurrent='preview'
            if(Invoke-QaMsi 'upgrade' '/i' 'preview'){
                Probe-QaProduct 'upgraded'
                if([IO.File]::ReadAllText($sentinel) -cne 'SYNTHETIC-UPGRADE-PRESERVE' -or (Get-FileHash -LiteralPath $secret -Algorithm SHA256).Hash -cne $before){throw 'MSIQ_UPGRADE_STATE_CHANGED'}
                $qaReport.probes+=@{stage='upgrade-state';pass=$true;sentinelPreserved=$true;secretPreserved=$true}
            }
        }
    }
}catch{$qaReport.failures+=('EXCEPTION:'+($_.Exception.Message -replace '[a-fA-F0-9]{64}','[redacted]'))}
finally{
    if($qaAttempted){
        Save-QaLogs 'final'
        foreach($kind in @('preview','previous')){
            try{$null=Invoke-QaMsi ('cleanup-'+$kind) '/x' $kind -AllowAbsent}catch{$qaReport.failures+='CLEANUP_EXCEPTION'}
        }
        $qaReport.cleanupConfirmed=Assert-QaRemoved 'final-removed'
    }
    $qaReport.pass=$qaReport.failures.Count -eq 0 -and $qaReport.cleanupConfirmed
    $qaReport.completedAt=(Get-Date).ToUniversalTime().ToString('o')
    $qaReport|ConvertTo-Json -Depth 10|Set-Content -LiteralPath (Join-Path $qaRoot 'report.json') -Encoding UTF8
}
if(-not $qaReport.pass){throw 'MSIQ_LIFECYCLE_FAILED_SEE_RETAINED_REPORT'}
