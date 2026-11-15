# Local disposable proof that a same-ProductCode MSI minor upgrade runs the
# replacement package without uninstalling the registered product first.
[CmdletBinding()]
param([string]$EvidencePath='')
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
if(-not [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'SMM_ADMIN_REQUIRED'}
if(-not (Get-Command wix.exe -ErrorAction SilentlyContinue)){throw 'SMM_WIX_REQUIRED'}
$id=[Guid]::NewGuid().ToString('N');$service='Ragent-MsiMinorQa-'+$id.Substring(0,12)
$root=Join-Path ([IO.Path]::GetTempPath()) ('ragent-msi-minor-upgrade-'+$id)
$tempRoot=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
if(-not $tempRoot.StartsWith('G:\Ragent\',[StringComparison]::OrdinalIgnoreCase)){throw 'SMM_TEMP_OUTSIDE_G'}
$install=Join-Path $root 'installed'
$productCode=[Guid]::NewGuid().ToString('B').ToUpperInvariant();$upgradeCode=[Guid]::NewGuid().ToString('B').ToUpperInvariant()
$serviceComponent=[Guid]::NewGuid().ToString('B').ToUpperInvariant();$contentComponent=[Guid]::NewGuid().ToString('B').ToUpperInvariant()
$report=[ordered]@{pass=$false;test='same-ProductCode in-place MSI minor upgrade with running-service rollback';serviceName=$service;productCode=$productCode;upgradeCode=$upgradeCode;serviceComponent=$serviceComponent;contentComponent=$contentComponent;v1ExitCode=$null;injectedFailureExitCode=$null;v2ExitCode=$null;rollbackRestoredRunningService=$false;uninstallActionDidNotRun=$false;productVersionAfterUpgrade=$null;serviceStartModeAfterUpgrade=$null;serviceStateAfterUpgrade=$null;contentAfterUpgrade=$null;cleanupConfirmed=$false;productionRagentServicesTouched=$false}
if(Test-Path -LiteralPath $install){throw 'SMM_INSTALL_ROOT_EXISTS'}
if(Get-CimInstance Win32_Service -Filter ("Name='"+$service+"'")){throw 'SMM_SERVICE_EXISTS'}
$null=New-Item -ItemType Directory -Path $root
& icacls.exe $root /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if($LASTEXITCODE -ne 0){throw 'SMM_WORKSPACE_ACL_FAILED'}
$serviceSource=Join-Path $root 'QaService.cs';$serviceBinary=Join-Path $root 'QaService.exe'
@"
using System.ServiceProcess;
public sealed class QaService : ServiceBase {
 public QaService(){ServiceName="$service";}
 protected override void OnStart(string[] args){}
 protected override void OnStop(){}
 public static void Main(){ServiceBase.Run(new QaService());}
}
"@ | Set-Content -LiteralPath $serviceSource -Encoding UTF8
& (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe') /nologo /target:exe /r:System.ServiceProcess.dll ('/out:'+$serviceBinary) $serviceSource
if($LASTEXITCODE -ne 0 -or -not(Test-Path -LiteralPath $serviceBinary -PathType Leaf)){throw 'SMM_SERVICE_BUILD_FAILED'}
function New-QaMsi([string]$Version,[string]$Label,[string]$Start,[string]$Output){
 $content=Join-Path $root 'payload.txt';[IO.File]::WriteAllText($content,$Label,[Text.UTF8Encoding]::new($false))
 $wxs=Join-Path $root ($Label+'.wxs')
 $xml=@"
<?xml version="1.0" encoding="UTF-8"?>
<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs">
  <Package Name="Ragent MSI minor upgrade QA" Manufacturer="Ragent QA" Version="$Version" ProductCode="$productCode" UpgradeCode="$upgradeCode" Scope="perMachine">
    <MediaTemplate EmbedCab="yes" />
    <StandardDirectory Id="ProgramFiles64Folder">
      <Directory Id="INSTALLFOLDER" Name="Ragent-MsiMinorQa-$id">
        <Component Id="QaService" Guid="$serviceComponent">
          <File Id="QaServiceBinary" Source="!(bindpath.Qa)\QaService.exe" KeyPath="yes" />
          <ServiceInstall Id="QaServiceInstall" Name="$service" DisplayName="$service" Type="ownProcess" Start="$Start" Account="LocalSystem" ErrorControl="normal" />
          $(if($Label -eq 'v2'){'<ServiceControl Id="QaServiceControl" Name="'+$service+'" Stop="install" Remove="uninstall" />'})
        </Component>
        <Component Id="QaContent" Guid="$contentComponent">
          <File Id="QaContentFile" Source="$content" KeyPath="yes" />
        </Component>
      </Directory>
    </StandardDirectory>
    <CustomAction Id="QaRejectRemoval" Error="SMM_UNINSTALL_ACTION_RAN" />
    <CustomAction Id="QaInjectedFailure" Error="SMM_INJECTED_FAILURE" />
    <InstallExecuteSequence>
      <Custom Action="QaRejectRemoval" Before="RemoveFiles" Condition="Installed AND REMOVE = &quot;ALL&quot; AND NOT QA_ALLOW_REMOVE" />
      <Custom Action="QaInjectedFailure" After="InstallServices" Condition="QA_FAIL_UPDATE = 1" />
    </InstallExecuteSequence>
    <Feature Id="Main" Title="QA" Level="1"><ComponentRef Id="QaService" /><ComponentRef Id="QaContent" /></Feature>
  </Package>
</Wix>
"@
 [IO.File]::WriteAllText($wxs,$xml,[Text.UTF8Encoding]::new($false))
 $buildOutput=@(& wix.exe --acceptEula wix7 build -arch x64 $wxs -bindpath ('Qa='+$root) -o $Output 2>&1)
 if($LASTEXITCODE -ne 0 -or -not(Test-Path -LiteralPath $Output -PathType Leaf)){$report.buildDiagnostics=@($buildOutput|ForEach-Object {$_.ToString()});throw 'SMM_MSI_BUILD_FAILED'}
}
function Invoke-Msi([string[]]$Arguments){
 $process=Start-Process -FilePath (Join-Path $env:windir 'System32\msiexec.exe') -ArgumentList $Arguments -PassThru -WindowStyle Hidden
 try{if(-not $process.WaitForExit(120000)){throw 'SMM_MSI_TIMEOUT'};$process.Refresh();return [int]$process.ExitCode}finally{$process.Dispose()}
}
try{
 $v1=Join-Path $root 'v1.msi';$v2=Join-Path $root 'v2.msi';$failedUpdateLog=Join-Path $root 'failed-update.log'
 New-QaMsi '0.0.1.0' 'v1' 'demand' $v1;New-QaMsi '0.0.2.0' 'v2' 'disabled' $v2
 & sc.exe create $service 'binPath=' $serviceBinary 'start=' 'demand' 'obj=' 'LocalSystem' | Out-Null
 if($LASTEXITCODE -ne 0){throw 'SMM_SERVICE_CREATE_FAILED'}
 $report.v1ExitCode=Invoke-Msi @('/i',('"'+$v1+'"'),('INSTALLFOLDER="'+$install+'"'),'/qn','/norestart')
 if($report.v1ExitCode -ne 0){throw 'SMM_V1_INSTALL_FAILED'}
 & sc.exe start $service | Out-Null
 for($i=0;$i -lt 100;$i++){$running=Get-CimInstance Win32_Service -Filter ("Name='"+$service+"'");if($running -and $running.State -ceq 'Running'){break};Start-Sleep -Milliseconds 100}
 if(-not $running -or $running.State -cne 'Running'){throw 'SMM_SERVICE_START_FAILED'}
 $wi=New-Object -ComObject WindowsInstaller.Installer
 $report.injectedFailureExitCode=Invoke-Msi @('/i',('"'+$v2+'"'),('INSTALLFOLDER="'+$install+'"'),'REINSTALL=ALL','REINSTALLMODE=vomus','QA_FAIL_UPDATE=1','/qn','/norestart','/l*v',('"'+$failedUpdateLog+'"'))
 $versionAfterRollback=$wi.ProductInfo($productCode,'VersionString');$serviceAfterRollback=Get-CimInstance Win32_Service -Filter ("Name='"+$service+"'");$contentAfterRollback=[IO.File]::ReadAllText((Join-Path $install 'payload.txt'))
 $report.rollbackRestoredRunningService=($versionAfterRollback -match '^0\.0\.1(?:\.0)?$' -and $serviceAfterRollback -and $serviceAfterRollback.State -ceq 'Running' -and $serviceAfterRollback.StartMode -ceq 'Manual' -and $contentAfterRollback -ceq 'v1' -and (Test-Path -LiteralPath $failedUpdateLog) -and (Select-String -LiteralPath $failedUpdateLog -Pattern 'QaInjectedFailure' -Quiet))
 if($report.injectedFailureExitCode -eq 0 -or -not $report.rollbackRestoredRunningService){throw 'SMM_ROLLBACK_STATE_MISMATCH'}
 $report.v2ExitCode=Invoke-Msi @('/i',('"'+$v2+'"'),('INSTALLFOLDER="'+$install+'"'),'REINSTALL=ALL','REINSTALLMODE=vomus','QA_FAIL_UPDATE=0','/qn','/norestart')
 if($report.v2ExitCode -ne 0){throw 'SMM_V2_UPDATE_FAILED'}
 $report.productVersionAfterUpgrade=$wi.ProductInfo($productCode,'VersionString')
 $serviceAfter=Get-CimInstance Win32_Service -Filter ("Name='"+$service+"'")
 $report.serviceStartModeAfterUpgrade=if($serviceAfter){$serviceAfter.StartMode}else{$null}
 $report.serviceStateAfterUpgrade=if($serviceAfter){$serviceAfter.State}else{$null}
 $report.contentAfterUpgrade=[IO.File]::ReadAllText((Join-Path $install 'payload.txt'))
 if($report.productVersionAfterUpgrade -notmatch '^0\.0\.2(?:\.0)?$' -or -not $serviceAfter -or $serviceAfter.StartMode -cne 'Disabled' -or $serviceAfter.State -cne 'Stopped' -or $report.contentAfterUpgrade -cne 'v2'){throw 'SMM_UPDATE_STATE_MISMATCH'}
 $report.uninstallActionDidNotRun=$true;$report.pass=$true
}catch{$report.error=$_.Exception.GetBaseException().Message}
finally{
 try{
  $uninstall=Invoke-Msi @('/x',$productCode,'QA_ALLOW_REMOVE=1','/qn','/norestart')
  if($uninstall -notin @(0,1605)){throw 'SMM_UNINSTALL_FAILED'}
  $serviceLeft=Get-CimInstance Win32_Service -Filter ("Name='"+$service+"'") -ErrorAction SilentlyContinue
  if($serviceLeft){& sc.exe delete $service | Out-Null;if($LASTEXITCODE -ne 0){throw 'SMM_SERVICE_CLEANUP_FAILED'};for($i=0;$i -lt 50 -and (Get-CimInstance Win32_Service -Filter ("Name='"+$service+"'") -ErrorAction SilentlyContinue);$i++){Start-Sleep -Milliseconds 100}}
  if(Get-CimInstance Win32_Service -Filter ("Name='"+$service+"'") -ErrorAction SilentlyContinue){throw 'SMM_SERVICE_REMAINS'}
  if(Test-Path -LiteralPath $install){throw 'SMM_INSTALL_FILES_REMAIN'}
  $report.cleanupConfirmed=$true
 }catch{$report.cleanupError=$_.Exception.GetBaseException().Message;$report.pass=$false}
 if($EvidencePath){[IO.File]::WriteAllText([IO.Path]::GetFullPath($EvidencePath),($report|ConvertTo-Json -Depth 6),[Text.UTF8Encoding]::new($false))}
 if(Test-Path -LiteralPath $root){$full=[IO.Path]::GetFullPath($root);$parent=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\');if([IO.Path]::GetDirectoryName($full) -cne $parent -or [IO.Path]::GetFileName($full) -cne ('ragent-msi-minor-upgrade-'+$id) -or ((Get-Item -LiteralPath $full -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'SMM_QA_CLEANUP_ROOT_REFUSED'};foreach($item in @(Get-ChildItem -LiteralPath $full -Force -Recurse)){if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'SMM_QA_CLEANUP_REPARSE_REFUSED'}};Remove-Item -LiteralPath $full -Recurse -Force}
}
$report|ConvertTo-Json -Depth 6 -Compress
if(-not $report.pass){exit 1}
