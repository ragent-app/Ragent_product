# Disposable local Windows Installer probe for an existing, independently
# registered service. It never targets an Ragent service or user data.
[CmdletBinding()]
param([string]$EvidencePath='')
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
if(-not [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'SMT_ADMIN_REQUIRED'}
if(-not (Get-Command wix.exe -ErrorAction SilentlyContinue)){throw 'SMT_WIX_REQUIRED'}
$id=[Guid]::NewGuid().ToString('N');$service='Ragent-MsiTakeoverQa-'+$id.Substring(0,12)
$installRoot=Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)) ('Ragent-MsiTakeoverQa-'+$id)
$qaRoot=Join-Path ([IO.Path]::GetTempPath()) ('ragent-msi-service-takeover-'+$id)
$msi=Join-Path $qaRoot 'service-takeover.msi';$wxs=Join-Path $qaRoot 'service-takeover.wxs';$log=Join-Path $qaRoot 'install.log'
if(Test-Path -LiteralPath $installRoot){throw 'SMT_INSTALL_ROOT_EXISTS'}
if(Get-CimInstance Win32_Service -Filter ("Name='"+$service+"'")){throw 'SMT_SERVICE_EXISTS'}
$null=New-Item -ItemType Directory -Path $qaRoot
$component=[Guid]::NewGuid().ToString('B').ToUpperInvariant();$upgrade=[Guid]::NewGuid().ToString('B').ToUpperInvariant();$productCode=[Guid]::NewGuid().ToString('B').ToUpperInvariant()
$xml=@"
<?xml version="1.0" encoding="UTF-8"?>
<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs">
  <Package Name="Ragent MSI service takeover QA" Manufacturer="Ragent QA" Version="0.0.0.1" ProductCode="$productCode" UpgradeCode="$upgrade" Scope="perMachine">
    <MediaTemplate EmbedCab="yes" />
    <StandardDirectory Id="ProgramFiles64Folder">
      <Directory Id="INSTALLFOLDER" Name="Ragent-MsiTakeoverQa-$id">
        <Component Id="QaService" Guid="$component">
          <File Id="QaServiceBinary" Source="!(bindpath.System)\cmd.exe" KeyPath="yes" />
          <ServiceInstall Id="QaServiceInstall" Name="$service" DisplayName="$service" Type="ownProcess" Start="demand" Account="LocalSystem" ErrorControl="normal" />
        </Component>
      </Directory>
    </StandardDirectory>
    <Feature Id="Main" Title="QA" Level="1"><ComponentRef Id="QaService" /></Feature>
  </Package>
</Wix>
"@
[IO.File]::WriteAllText($wxs,$xml,[Text.UTF8Encoding]::new($false))
$report=[ordered]@{pass=$false;test='ServiceInstall against an independently registered same-name SCM service';serviceName=$service;installRoot=$installRoot;msiExitCode=$null;before=$null;after=$null;cleanupConfirmed=$false;productionRagentServicesTouched=$false}
try{
  & wix.exe --acceptEula wix7 build -arch x64 $wxs -bindpath ('System='+[Environment]::GetFolderPath([Environment+SpecialFolder]::System)) -o $msi | Out-Null
  if($LASTEXITCODE -ne 0){throw 'SMT_MSI_BUILD_FAILED'}
  & sc.exe create $service 'binPath=' "$env:windir\System32\cmd.exe /c exit" 'start=' 'demand' 'obj=' 'LocalSystem' | Out-Null
  if($LASTEXITCODE -ne 0){throw 'SMT_SERVICE_CREATE_FAILED'}
  $before=Get-CimInstance Win32_Service -Filter ("Name='"+$service+"'")
  if(-not $before -or $before.StartName -ine 'LocalSystem' -or $before.State -cne 'Stopped'){throw 'SMT_SERVICE_PRECONDITION_FAILED'}
  $report.before=@{account=$before.StartName;state=$before.State;mode=$before.StartMode;binaryPathSha256=(Get-FileHash -LiteralPath $env:ComSpec -Algorithm SHA256).Hash.ToLowerInvariant()}
  $process=Start-Process -FilePath (Join-Path $env:windir 'System32\msiexec.exe') -ArgumentList @('/i',('"'+$msi+'"'),'/qn','/norestart','/l*v',('"'+$log+'"')) -PassThru -WindowStyle Hidden
  try{if(-not $process.WaitForExit(120000)){throw 'SMT_MSI_TIMEOUT'};$process.Refresh();$report.msiExitCode=$process.ExitCode}finally{$process.Dispose()}
  $after=Get-CimInstance Win32_Service -Filter ("Name='"+$service+"'")
  if($after){$report.after=@{account=$after.StartName;state=$after.State;mode=$after.StartMode;path=$after.PathName}}
  $report.pass=$true
}catch{$report.error=$_.Exception.GetBaseException().Message}
finally{
  try{
    $uninstall=Start-Process -FilePath (Join-Path $env:windir 'System32\msiexec.exe') -ArgumentList @('/x',$productCode,'/qn','/norestart') -PassThru -WindowStyle Hidden
    try{if(-not $uninstall.WaitForExit(120000)){throw 'SMT_MSI_UNINSTALL_TIMEOUT'};$uninstall.Refresh();if($uninstall.ExitCode -notin @(0,1605)){throw 'SMT_MSI_UNINSTALL_FAILED'}}finally{$uninstall.Dispose()}
    $left=Get-CimInstance Win32_Service -Filter ("Name='"+$service+"'")
    if($left -and $left.State -ne 'Stopped'){& sc.exe stop $service | Out-Null;Start-Sleep -Milliseconds 300}
    $left=Get-CimInstance Win32_Service -Filter ("Name='"+$service+"'")
    if($left){& sc.exe delete $service | Out-Null;if($LASTEXITCODE -ne 0){throw 'SMT_SERVICE_CLEANUP_FAILED'};for($i=0;$i -lt 50 -and (Get-CimInstance Win32_Service -Filter ("Name='"+$service+"'") -ErrorAction SilentlyContinue);$i++){Start-Sleep -Milliseconds 100}}
    if(Get-CimInstance Win32_Service -Filter ("Name='"+$service+"'") -ErrorAction SilentlyContinue){throw 'SMT_SERVICE_REMAINS'}
    if(Test-Path -LiteralPath $installRoot){throw 'SMT_INSTALL_FILES_REMAIN'}
    $report.cleanupConfirmed=$true
  }catch{$report.cleanupError=$_.Exception.GetBaseException().Message;$report.pass=$false}
  if($EvidencePath){[IO.File]::WriteAllText([IO.Path]::GetFullPath($EvidencePath),($report|ConvertTo-Json -Depth 6),[Text.UTF8Encoding]::new($false))}
  if(Test-Path -LiteralPath $qaRoot){$full=[IO.Path]::GetFullPath($qaRoot);$parent=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\');if([IO.Path]::GetDirectoryName($full) -cne $parent -or [IO.Path]::GetFileName($full) -cne ('ragent-msi-service-takeover-'+$id) -or ((Get-Item -LiteralPath $full -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'SMT_QA_CLEANUP_ROOT_REFUSED'};foreach($item in @(Get-ChildItem -LiteralPath $full -Force -Recurse)){if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'SMT_QA_CLEANUP_REPARSE_REFUSED'}};Remove-Item -LiteralPath $full -Recurse -Force}
}
$report|ConvertTo-Json -Depth 6 -Compress
if(-not $report.pass){exit 1}
