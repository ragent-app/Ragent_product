# Disposable major-upgrade transaction probe. Uses unique product and service
# identifiers and confines payloads and logs to the task's G: TEMP directory.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$EvidencePath)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
if(-not [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'MJU_ADMIN_REQUIRED'}
if(-not (Get-Command wix.exe -ErrorAction SilentlyContinue)){throw 'MJU_WIX_REQUIRED'}
$parent=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
if(-not $parent.StartsWith('G:\Ragent\',[StringComparison]::OrdinalIgnoreCase)){throw 'MJU_TEMP_OUTSIDE_G'}
$id=[Guid]::NewGuid().ToString('N');$root=Join-Path $parent ('ragent-major-qa-'+$id)
$install=Join-Path $root 'installed';$service='Ragent-MajorQa-'+$id.Substring(0,12)
$oldProduct=[Guid]::NewGuid().ToString('B').ToUpperInvariant();$newProduct=[Guid]::NewGuid().ToString('B').ToUpperInvariant()
$upgrade=[Guid]::NewGuid().ToString('B').ToUpperInvariant();$component=[Guid]::NewGuid().ToString('B').ToUpperInvariant();$contentComponent=[Guid]::NewGuid().ToString('B').ToUpperInvariant()
$report=[ordered]@{pass=$false;test='major upgrade, service SID restoration and rollback of isolated service';service=$service;oldProduct=$oldProduct;newProduct=$newProduct;failedUpgradeExit=$null;oldRestored=$false;serviceSidRestored=$false;successfulUpgradeExit=$null;newInstalled=$false;cleanupConfirmed=$false}
if(Test-Path -LiteralPath $root){throw 'MJU_ROOT_EXISTS'}
New-Item -ItemType Directory -Path $root | Out-Null
& icacls.exe $root /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if($LASTEXITCODE -ne 0){throw 'MJU_WORKSPACE_ACL_FAILED'}
try{
 $serviceSource=Join-Path $root 'QaService.cs';$serviceExe=Join-Path $root 'QaService.exe';$failSource=Join-Path $root 'QaFail.cs';$failExe=Join-Path $root 'QaFail.exe';$guardSource=Join-Path $root 'QaGuard.cs';$guardExe=Join-Path $root 'QaGuard.exe';$restoreSource=Join-Path $root 'QaRestore.cs';$restoreExe=Join-Path $root 'QaRestore.exe';$restoredMarker=Join-Path $root 'restored.txt'
 @"
using System.ServiceProcess;
public sealed class QaService:ServiceBase {public QaService(){ServiceName="$service";} protected override void OnStart(string[] args){} protected override void OnStop(){} public static void Main(){ServiceBase.Run(new QaService());}}
"@ | Set-Content -LiteralPath $serviceSource -Encoding UTF8
 [IO.File]::WriteAllText($failSource,'public static class QaFail { public static int Main(){return 93;} }')
 [IO.File]::WriteAllText($guardSource,'using System.ServiceProcess; public static class QaGuard { public static int Main(){try{using(var s=new ServiceController("'+$service+'")){return s.Status==ServiceControllerStatus.Running?0:92;}}catch{return 92;}} }')
 $restoreCode=@"
using System;using System.Diagnostics;using System.IO;using System.ServiceProcess;
public static class QaRestore {public static int Main(){try{
 var p=Process.Start(new ProcessStartInfo{FileName=@"C:\Windows\System32\sc.exe",Arguments="sidtype $service unrestricted",UseShellExecute=false,CreateNoWindow=true});p.WaitForExit();if(p.ExitCode!=0)return 91;
 using(var s=new ServiceController("$service")){s.Refresh();if(s.Status!=ServiceControllerStatus.Running){if(s.Status!=ServiceControllerStatus.Stopped)s.WaitForStatus(ServiceControllerStatus.Stopped,TimeSpan.FromSeconds(30));s.Start();s.WaitForStatus(ServiceControllerStatus.Running,TimeSpan.FromSeconds(30));}}
 File.WriteAllText(@"$restoredMarker","restored");return 0;
}catch{return 92;}}}
"@
 [IO.File]::WriteAllText($restoreSource,$restoreCode)
 $csc=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
 & $csc /nologo /target:exe /r:System.ServiceProcess.dll ('/out:'+$serviceExe) $serviceSource
 if($LASTEXITCODE -ne 0){throw 'MJU_SERVICE_COMPILE_FAILED'}
 & $csc /nologo /target:exe ('/out:'+$failExe) $failSource
 if($LASTEXITCODE -ne 0){throw 'MJU_FAIL_COMPILE_FAILED'}
 & $csc /nologo /target:exe /r:System.ServiceProcess.dll ('/out:'+$guardExe) $guardSource
 if($LASTEXITCODE -ne 0){throw 'MJU_GUARD_COMPILE_FAILED'}
 & $csc /nologo /target:exe /r:System.ServiceProcess.dll ('/out:'+$restoreExe) $restoreSource
 if($LASTEXITCODE -ne 0){throw 'MJU_RESTORE_COMPILE_FAILED'}
 function Build-Qa([string]$version,[string]$label,[string]$product,[bool]$isUpgrade){
  $content=Join-Path $root ($label+'.txt');[IO.File]::WriteAllText($content,$label)
  $wxs=Join-Path $root ($label+'.wxs');$msi=Join-Path $root ($label+'.msi')
  $major=if($isUpgrade){'<MajorUpgrade DowngradeErrorMessage="Newer version installed." Schedule="afterInstallExecute" />'}else{''}
  $fault=if($isUpgrade){'<Binary Id="Failure" SourceFile="'+$failExe+'" /><Binary Id="Guard" SourceFile="'+$guardExe+'" /><Binary Id="Restore" SourceFile="'+$restoreExe+'" /><CustomAction Id="QaGuard" BinaryRef="Guard" ExeCommand="" Execute="deferred" Impersonate="no" Return="check" /><CustomAction Id="QaRestore" BinaryRef="Restore" ExeCommand="" Execute="rollback" Impersonate="no" Return="ignore" /><CustomAction Id="QaInjectedFailure" BinaryRef="Failure" ExeCommand="" Execute="deferred" Impersonate="no" Return="check" /><InstallExecuteSequence><Custom Action="QaGuard" After="InstallInitialize" Condition="WIX_UPGRADE_DETECTED" /><Custom Action="QaRestore" After="QaGuard" Condition="WIX_UPGRADE_DETECTED" /><InstallExecute After="QaRestore" Condition="WIX_UPGRADE_DETECTED" /><Custom Action="QaInjectedFailure" After="StartServices" Condition="QA_FAIL_UPDATE = 1" /></InstallExecuteSequence>'}else{''}
  $xml=@"
<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs">
 <Package Name="Ragent Major Upgrade QA $id" Manufacturer="Ragent QA" Version="$version" ProductCode="$product" UpgradeCode="$upgrade" Scope="perMachine">
  $major<MediaTemplate EmbedCab="yes" />
  <StandardDirectory Id="ProgramFiles64Folder"><Directory Id="INSTALLFOLDER" Name="Ragent-MajorQa-$id">
   <Component Id="QaService" Guid="$component"><File Id="QaServiceFile" Source="$serviceExe" KeyPath="yes" /><ServiceInstall Id="QaServiceInstall" Name="$service" DisplayName="$service" Type="ownProcess" Start="demand" Account="LocalSystem" ErrorControl="normal" /><ServiceControl Id="QaServiceControl" Name="$service" Start="install" Stop="both" Remove="uninstall" Wait="yes" /></Component>
   <Component Id="QaContent" Guid="$contentComponent"><File Id="QaContentFile" Name="payload.txt" Source="$content" KeyPath="yes" /></Component>
  </Directory></StandardDirectory>
  $fault<Feature Id="Main" Title="QA" Level="1"><ComponentRef Id="QaService" /><ComponentRef Id="QaContent" /></Feature>
 </Package>
</Wix>
"@
  [IO.File]::WriteAllText($wxs,$xml,[Text.UTF8Encoding]::new($false))
  $build=@(& wix.exe --acceptEula wix7 build -arch x64 $wxs -o $msi 2>&1)
  if($LASTEXITCODE -ne 0){$report.buildDiagnostics=@($build|ForEach-Object {$_.ToString()});throw 'MJU_BUILD_FAILED'}
  return $msi
 }
 function Invoke-Qa([string[]]$arguments){$p=Start-Process -FilePath (Join-Path $env:windir 'System32\msiexec.exe') -ArgumentList $arguments -PassThru -WindowStyle Hidden;try{if(-not $p.WaitForExit(180000)){throw 'MJU_MSI_TIMEOUT'};$p.Refresh();return [int]$p.ExitCode}finally{$p.Dispose()}}
 $old=Build-Qa '0.0.1' 'v1' $oldProduct $false;$new=Build-Qa '0.0.3' 'v2' $newProduct $true
 $code=Invoke-Qa @('/i',('"'+$old+'"'),('INSTALLFOLDER="'+$install+'"'),'/qn','/norestart')
 if($code -ne 0){throw ('MJU_OLD_INSTALL_FAILED_'+$code)}
 if((Get-Service -Name $service).Status -ne 'Running'){throw 'MJU_OLD_SERVICE_NOT_RUNNING'}
 & sc.exe sidtype $service unrestricted | Out-Null
 if($LASTEXITCODE -ne 0){throw 'MJU_INITIAL_SID_FAILED'}
 $failedLog=Join-Path $root 'failed.log'
 $report.failedUpgradeExit=Invoke-Qa @('/i',('"'+$new+'"'),('INSTALLFOLDER="'+$install+'"'),'QA_FAIL_UPDATE=1','/qn','/norestart','/l*v',('"'+$failedLog+'"'))
 $wi=New-Object -ComObject WindowsInstaller.Installer
 try{$oldVersion=$wi.ProductInfo($oldProduct,'VersionString')}catch{$oldVersion=''}
 $oldService=Get-Service -Name $service -ErrorAction SilentlyContinue
 $sidType=(Get-ItemProperty -LiteralPath ('HKLM:\SYSTEM\CurrentControlSet\Services\'+$service) -Name ServiceSidType -ErrorAction SilentlyContinue).ServiceSidType
 $report.serviceSidRestored=($sidType -eq 1 -and (Test-Path -LiteralPath $restoredMarker -PathType Leaf))
 $report.oldRestored=($report.failedUpgradeExit -ne 0 -and $oldVersion -match '^0\.0\.1' -and $oldService -and $oldService.Status -eq 'Running' -and $report.serviceSidRestored -and [IO.File]::ReadAllText((Join-Path $install 'payload.txt')) -ceq 'v1' -and (Select-String -LiteralPath $failedLog -Pattern 'QaInjectedFailure' -Quiet))
 if(-not $report.oldRestored){throw 'MJU_ROLLBACK_MISMATCH'}
 $report.successfulUpgradeExit=Invoke-Qa @('/i',('"'+$new+'"'),('INSTALLFOLDER="'+$install+'"'),'/qn','/norestart','/l*v',('"'+(Join-Path $root 'success.log')+'"'))
 try{$newVersion=$wi.ProductInfo($newProduct,'VersionString')}catch{$newVersion=''}
 $newService=Get-Service -Name $service -ErrorAction SilentlyContinue
 $report.newInstalled=($report.successfulUpgradeExit -eq 0 -and $newVersion -match '^0\.0\.3' -and $newService -and $newService.Status -eq 'Running' -and [IO.File]::ReadAllText((Join-Path $install 'payload.txt')) -ceq 'v2')
 if(-not $report.newInstalled){throw 'MJU_NEW_STATE_MISMATCH'}
 $report.pass=$true
}catch{$report.error=$_.Exception.GetBaseException().Message}
finally{
 try{
  foreach($product in @($newProduct,$oldProduct)){$result=Invoke-Qa @('/x',$product,'/qn','/norestart');if($result -notin @(0,1605)){throw ('MJU_CLEANUP_FAILED_'+$result)}}
  if(Get-Service -Name $service -ErrorAction SilentlyContinue){throw 'MJU_SERVICE_REMAINS'}
  if(Test-Path -LiteralPath $install){throw 'MJU_INSTALL_REMAINS'}
  $report.cleanupConfirmed=$true
 }catch{$report.cleanupError=$_.Exception.GetBaseException().Message;$report.pass=$false}
 [IO.File]::WriteAllText([IO.Path]::GetFullPath($EvidencePath),($report|ConvertTo-Json -Depth 6),[Text.UTF8Encoding]::new($false))
}
$report|ConvertTo-Json -Depth 6 -Compress
if(-not $report.pass){exit 1}
