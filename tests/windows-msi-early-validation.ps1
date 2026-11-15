$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$env:TEMP='G:\Ragent\tmp';$env:TMP=$env:TEMP;$env:TMPDIR=$env:TEMP
$id=[Guid]::NewGuid().ToString('N');$service='Ragent-EarlyValidateQa-'+$id.Substring(0,10)
$root=Join-Path 'G:\Ragent\_qa\msi-relocation-20261102' ('early-validation-'+$id)
if(Test-Path -LiteralPath $root){throw 'ROOT_EXISTS'}
New-Item -ItemType Directory -Path $root|Out-Null
$source=Join-Path $root 'service.cs';$exe=Join-Path $root 'service.exe';$actionSource=Join-Path $root 'action.cs';$action=Join-Path $root 'action.exe';$msi=Join-Path $root 'probe.msi'
@"
using System.ServiceProcess;
public sealed class ProbeService:ServiceBase { public ProbeService(){ServiceName="$service";} public static void Main(){Run(new ProbeService());} }
"@ | Set-Content -LiteralPath $source -Encoding UTF8
@"
using System;using System.ServiceProcess;
public static class Action {public static int Main(string[] args){try{if(args.Length!=1)return 2;if(args[0]=="fail")return 9;using(var s=new ServiceController("$service")){if(args[0]=="stop"){if(s.Status!=ServiceControllerStatus.Stopped){s.Stop();s.WaitForStatus(ServiceControllerStatus.Stopped,TimeSpan.FromSeconds(30));}return 0;}if(args[0]=="start"){if(s.Status!=ServiceControllerStatus.Running){s.Start();s.WaitForStatus(ServiceControllerStatus.Running,TimeSpan.FromSeconds(30));}return 0;}}return 3;}catch{return 1;}}}
"@ | Set-Content -LiteralPath $actionSource -Encoding UTF8
$csc='C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
& $csc /nologo /target:exe /r:System.ServiceProcess.dll ('/out:'+$exe) $source;if($LASTEXITCODE -ne 0){throw 'SERVICE_COMPILE_FAILED'}
& $csc /nologo /target:winexe /r:System.ServiceProcess.dll ('/out:'+$action) $actionSource;if($LASTEXITCODE -ne 0){throw 'ACTION_COMPILE_FAILED'}
$wxs=Join-Path $root 'probe.wxs';$upgrade=[Guid]::NewGuid().ToString('B').ToUpperInvariant()
@"
<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs">
 <Package Name="Ragent early validation isolated QA $id" Manufacturer="Ragent QA" Version="0.0.1" UpgradeCode="$upgrade" Scope="perMachine" UpgradeStrategy="none">
  <MediaTemplate EmbedCab="yes" />
  <Property Id="INJECTFAIL" Secure="yes" />
  <StandardDirectory Id="ProgramFiles64Folder"><Directory Id="INSTALLFOLDER" Name="Ragent-EarlyValidateQa-$id">
   <Component Id="ProbeService" Guid="*"><File Id="ProbeExe" Source="$exe" KeyPath="yes" />
    <ServiceInstall Id="InstallProbe" Name="$service" DisplayName="$service" Type="ownProcess" Start="auto" Account="LocalSystem" ErrorControl="normal" />
    <ServiceControl Id="ControlProbe" Name="$service" Start="install" Stop="both" Remove="uninstall" Wait="yes" />
   </Component>
  </Directory></StandardDirectory>
  <Feature Id="Main"><ComponentRef Id="ProbeService" /></Feature>
  <Binary Id="Action" SourceFile="$action" />
  <CustomAction Id="ProbeRollback" BinaryRef="Action" ExeCommand="start" Execute="rollback" Impersonate="no" Return="check" />
  <CustomAction Id="ProbeQuiesce" BinaryRef="Action" ExeCommand="stop" Execute="deferred" Impersonate="no" Return="check" />
  <CustomAction Id="ProbeFailure" BinaryRef="Action" ExeCommand="fail" Execute="deferred" Impersonate="no" Return="check" />
  <InstallExecuteSequence>
   <Custom Action="ProbeRollback" Before="ProbeQuiesce" Condition="Installed AND REMOVE = &quot;ALL&quot;" />
   <Custom Action="ProbeQuiesce" Before="InstallExecute" Condition="Installed AND REMOVE = &quot;ALL&quot;" />
   <InstallExecute Before="InstallValidate" Condition="Installed AND REMOVE = &quot;ALL&quot;" />
   <Custom Action="ProbeFailure" After="InstallValidate" Condition="Installed AND REMOVE = &quot;ALL&quot; AND INJECTFAIL = &quot;1&quot;" />
  </InstallExecuteSequence>
 </Package>
</Wix>
"@ | Set-Content -LiteralPath $wxs -Encoding UTF8
& wix.exe --acceptEula wix7 build $wxs -arch x64 -o $msi;if($LASTEXITCODE -ne 0){throw 'WIX_BUILD_FAILED'}
# WiX 7 fixes standard-action sequence numbers. This is an isolated proof,
# not a production package: move initialization before the deferred probe and
# verify actual execution and rollback rather than trusting table order alone.
$installer=New-Object -ComObject WindowsInstaller.Installer
$database=$installer.OpenDatabase($msi,1)
$view=$database.OpenView("UPDATE ``InstallExecuteSequence`` SET ``Sequence``=1300 WHERE ``Action``='InstallInitialize'")
$view.Execute();$view.Close();$database.Commit()
[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($view)
[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($database)
[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($installer)
function Invoke-Probe([string]$operation,[string]$label,[bool]$inject){
 $args=@($operation,('"'+$msi+'"'),'/qn','/norestart','/l*v',('"'+(Join-Path $root ($label+'.log'))+'"'),('INSTALLFOLDER="'+$root+'\installed\\"'))
 if($inject){$args+='INJECTFAIL=1'}
 $p=Start-Process "$env:SystemRoot\System32\msiexec.exe" -ArgumentList $args -PassThru -Wait -WindowStyle Hidden;return $p.ExitCode
}
$installed=$false
try{
 if((Invoke-Probe '/i' 'install' $false) -ne 0){throw 'INSTALL_FAILED'};$installed=$true
 (Get-Service $service -ErrorAction Stop).WaitForStatus('Running',[TimeSpan]::FromSeconds(30))
 $failure=Invoke-Probe '/x' 'injected-uninstall' $true
 if($failure -ne 1603){throw ('EXPECTED_FAILURE_NOT_OBSERVED_'+$failure)}
 (Get-Service $service -ErrorAction Stop).WaitForStatus('Running',[TimeSpan]::FromSeconds(30))
 $log=Get-Content -Raw (Join-Path $root 'injected-uninstall.log')
 if($log -notmatch 'CustomActionSchedule\(Action=ProbeQuiesce' -or $log -notmatch 'CustomActionSchedule\(Action=ProbeRollback'){throw 'ACTIONS_NOT_OBSERVED'}
 $executed=$log.IndexOf('CustomActionSchedule(Action=ProbeQuiesce',[StringComparison]::Ordinal)
 $validated=$log.IndexOf('Doing action: InstallValidate',[StringComparison]::Ordinal)
 if($executed -lt 0 -or $validated -le $executed){throw 'QUIESCE_NOT_EXECUTED_BEFORE_VALIDATION'}
 if((Invoke-Probe '/x' 'uninstall' $false) -ne 0){throw 'UNINSTALL_FAILED'};$installed=$false
 if(Get-Service $service -ErrorAction SilentlyContinue){throw 'SERVICE_NOT_REMOVED'}
 'PASS: isolated service quiesced before InstallValidate; injected failure restored it; final removal succeeded.'
}finally{
 if($installed){$result=Invoke-Probe '/x' 'cleanup-uninstall' $false;Write-Output ('CLEANUP_EXIT='+$result)}
 Write-Output ('EVIDENCE_ROOT='+$root)
}
