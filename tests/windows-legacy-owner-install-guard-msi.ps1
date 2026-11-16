# Compile/query a QA MSI only. Never invoke msiexec or mutate SCM.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$EvidenceRoot)
$ErrorActionPreference='Stop'
$msiRoot=[IO.Path]::GetFullPath($EvidenceRoot)
if(-not(Test-Path -LiteralPath (Join-Path $msiRoot 'qa-instance.json'))){throw 'Marked QA root required'}
$msiGuard=Join-Path $msiRoot 'Ragent.LegacyOwnerInstallGuard.exe'
if(-not(Test-Path -LiteralPath $msiGuard)){throw 'Previously compiled QA guard required'}
$msiDirectory=Join-Path $msiRoot ('msi-schema-only-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $msiDirectory | Out-Null
Copy-Item -LiteralPath $msiGuard -Destination (Join-Path $msiDirectory 'Ragent.ServiceHost.exe')
$msiPayload=Join-Path $msiDirectory 'payload.wxs'
[IO.File]::WriteAllText($msiPayload,'<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs"><Fragment><ComponentGroup Id="PayloadGroup" Directory="RagentMachineRoot" Subdirectory="payload"><Component Id="QaPayload" Guid="*"><File Source="!(bindpath.OwnerInstallGuard)\qa-instance.json" /></Component></ComponentGroup></Fragment></Wix>',[Text.UTF8Encoding]::new($false))
$msiSource=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\packaging\windows\Ragent.wxs'))
$msiScripts=[IO.Path]::GetDirectoryName($msiSource)
$msiOutput=Join-Path $msiDirectory 'NOT-FOR-INSTALL-guard-schema.msi'
$msiTool=(Get-Command wix.exe -ErrorAction Stop).Source
$msiBuild=& $msiTool --acceptEula wix7 build -arch x64 $msiSource $msiPayload -d ProductVersion=0.0.0.1 -bindpath "ServiceHost=$msiDirectory" -bindpath "InstallScript=$msiScripts" -bindpath "OwnerInstallGuard=$msiRoot" -o $msiOutput 2>&1
$msiBuild|Set-Content -LiteralPath (Join-Path $msiDirectory 'build.log') -Encoding UTF8
if($LASTEXITCODE -ne 0){throw 'QA MSI compilation failed; retained msi-build.log'}
$msiEngine=New-Object -ComObject WindowsInstaller.Installer
$msiDatabase=$msiEngine.OpenDatabase($msiOutput,0)
function Read-MsiRow([string]$Query){
    $view=$msiDatabase.OpenView($Query)
    try{[void]$view.Execute();return ,$view.Fetch()}finally{[void]$view.Close()}
}
function Get-MsiField($Record,[string]$Name,[int]$Index){return $Record.GetType().InvokeMember($Name,[Reflection.BindingFlags]::GetProperty,$null,$Record,@($Index))}
$msiAction=Read-MsiRow 'SELECT `Type`,`Source`,`Target` FROM `CustomAction` WHERE `Action`=''CheckLegacyOwnerInstallation'''
if(-not $msiAction -or (Get-MsiField $msiAction 'IntegerData' 1) -ne 2 -or (Get-MsiField $msiAction 'StringData' 2) -cne 'LegacyOwnerInstallGuard' -or (Get-MsiField $msiAction 'StringData' 3) -ne ''){throw 'Embedded immediate checked EXE action required'}
$msiGuardRow=Read-MsiRow 'SELECT `Condition`,`Sequence` FROM `InstallExecuteSequence` WHERE `Action`=''CheckLegacyOwnerInstallation'''
if(-not $msiGuardRow -or (Get-MsiField $msiGuardRow 'StringData' 1) -ne ''){throw 'Guard must be unconditional in execute sequence'}
$msiOrder=@{}
foreach($action in @('CheckLegacyOwnerInstallation','InstallValidate','RemoveExistingProducts','StopServices','DeleteServices','RemoveFiles','InstallFiles','StartServices')){
    $row=Read-MsiRow ('SELECT `Sequence` FROM `InstallExecuteSequence` WHERE `Action`='''+$action+'''')
    if(-not $row){throw ('Missing QA MSI action '+$action)}
    $msiOrder[$action]=(Get-MsiField $row 'IntegerData' 1)
    if($action -ne 'CheckLegacyOwnerInstallation' -and (Get-MsiField $row 'IntegerData' 1) -le $msiOrder.CheckLegacyOwnerInstallation){throw ('Mutation precedes guard: '+$action)}
}
$msiBinary=Read-MsiRow 'SELECT `Data` FROM `Binary` WHERE `Name`=''LegacyOwnerInstallGuard'''
if(-not $msiBinary -or (Get-MsiField $msiBinary 'DataSize' 1) -ne (Get-Item -LiteralPath $msiGuard).Length){throw 'Embedded guard stream missing or size differs'}
$msiCompanions=@{}
foreach($id in @('LegacyOwnerGuardScript','LegacyOwnerGuardSource')){
    $row=Read-MsiRow ('SELECT `Component_` FROM `File` WHERE `File`='''+$id+'''')
    if(-not $row -or (Get-MsiField $row 'StringData' 1) -cne ($id+'Component')){throw ('Installed script companion missing: '+$id)}
    $msiCompanions[$id]=$true
}
$msiHash=[Security.Cryptography.SHA256]::Create()
try{$msiDigest=([BitConverter]::ToString($msiHash.ComputeHash([IO.File]::ReadAllBytes($msiOutput)))).Replace('-','').ToLowerInvariant()}finally{$msiHash.Dispose()}
@{pass=$true;schemaBuilt=$true;actualMsiInstallation=$false;servicesModified=$false;file=$msiOutput;sha256=$msiDigest;sequence=$msiOrder;companions=$msiCompanions}|ConvertTo-Json -Depth 4 -Compress
