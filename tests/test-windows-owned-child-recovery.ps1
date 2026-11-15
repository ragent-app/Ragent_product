# Real temporary Node processes + compiled shipped coordinator/metadata lease.
# No SCM/UAC/installed roots, Provider or network; coordinator layout is a fixture.
[CmdletBinding()]
param([string]$NodePath='G:\Ragent\ragent-v0.3.12-main\artifacts\showcase\T2-current-20261017\service-identities\bundle-c62e7d1319543507823ed7728b247518\node.exe')
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$qaSource=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$qaBase=Join-Path $qaSource 'artifacts\owned-child-recovery';$null=New-Item -ItemType Directory -Path $qaBase -Force
$qaId=[Guid]::NewGuid().ToString('N');$qaRoot=Join-Path $qaBase ('fixture-'+$qaId)
$qaAcl=[Security.AccessControl.DirectorySecurity]::new();$qaAcl.SetAccessRuleProtection($true,$false)
$qaSid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$qaAcl.SetOwner($qaSid)
foreach($sid in @($qaSid.Value,'S-1-5-18','S-1-5-32-544')){$qaAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))}
$null=[IO.Directory]::CreateDirectory($qaRoot,$qaAcl)
[IO.File]::WriteAllText((Join-Path $qaRoot '.qa-owned'),$qaId)
$qaProbe=Join-Path $qaRoot 'OwnedChildRecoveryProbe.exe';$qaScript=Join-Path $qaSource 'tests\fixtures\windows-owned-child-marker.mjs'
$qaReportFile=Join-Path $qaBase ('report-'+$qaId+'.json');$qaReport=$null
try{
 if((Get-FileHash -LiteralPath $NodePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne '2ffe3acc0458fdde999f50d11809bbe7c9b7ef204dcf17094e325d26ace101d8'){throw 'QA_NODE_BYTES_REQUIRED'}
 & 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe' /nologo /target:exe /main:OwnedChildRecoveryProbe /r:System.ServiceProcess.dll /r:System.Web.Extensions.dll /r:System.Security.dll ('/out:'+$qaProbe) (Join-Path $qaSource 'packaging\windows\Ragent.ServiceHost.cs') (Join-Path $qaSource 'tests\fixtures\windows-owned-child-recovery.cs')
 if($LASTEXITCODE -ne 0){throw 'QA_COMPILE_FAILED'}
 $qaProbeHash=(Get-FileHash -LiteralPath $qaProbe -Algorithm SHA256).Hash.ToLowerInvariant()
 & $qaProbe $qaRoot $NodePath $qaScript $qaReportFile
 $qaExit=$LASTEXITCODE;$qaReport=[IO.File]::ReadAllText($qaReportFile)|ConvertFrom-Json
 $qaReport|Add-Member -NotePropertyName sourceCommit -NotePropertyValue ((& git -C $qaSource rev-parse HEAD)|Out-String).Trim()
 $qaReport|Add-Member -NotePropertyName executedAt -NotePropertyValue (Get-Date).ToUniversalTime().ToString('o')
 $qaReport|Add-Member -NotePropertyName probeSha256 -NotePropertyValue $qaProbeHash
 $qaReport|Add-Member -NotePropertyName nodeSha256 -NotePropertyValue (Get-FileHash -LiteralPath $NodePath -Algorithm SHA256).Hash.ToLowerInvariant()
 $qaReport|Add-Member -NotePropertyName sourceFiles -NotePropertyValue @(@('packaging/windows/Ragent.ServiceHost.cs','lib/instance-runtime.mjs','lib/instance-ownership.mjs','tests/fixtures/windows-owned-child-recovery.cs','tests/fixtures/windows-owned-child-marker.mjs','tests/fixtures/windows-owned-child-before-marker.mjs','tests/test-windows-owned-child-recovery.ps1')|ForEach-Object {@{path=$_;sha256=(Get-FileHash -LiteralPath (Join-Path $qaSource $_) -Algorithm SHA256).Hash.ToLowerInvariant()}})
 if($qaExit -ne 0 -or -not $qaReport.pass){throw 'QA_RECOVERY_FAILED'}
}finally{
 # Only this marked canonical private fixture, with no reparse/remaining child.
 if([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($qaRoot)) -cne [IO.Path]::GetFullPath($qaBase) -or [IO.File]::ReadAllText((Join-Path $qaRoot '.qa-owned')) -cne $qaId){throw 'QA_CLEANUP_ROOT_REFUSED'}
 if(Get-CimInstance Win32_Process|Where-Object {$_.CommandLine -and $_.CommandLine.Contains($qaScript)}){throw 'QA_CHILD_STILL_RUNNING'}
 $qaStack=[Collections.Generic.Stack[string]]::new();$qaStack.Push($qaRoot)
 while($qaStack.Count){$qaDirectory=$qaStack.Pop();if((Get-Item -LiteralPath $qaDirectory -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'QA_CLEANUP_REPARSE_REFUSED'};foreach($qaItem in Get-ChildItem -LiteralPath $qaDirectory -Force){if($qaItem.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'QA_CLEANUP_REPARSE_REFUSED'};if($qaItem.PSIsContainer){$qaStack.Push($qaItem.FullName)}}}
 Remove-Item -LiteralPath $qaRoot -Recurse -Force
 if($qaReport){$qaReport|Add-Member -NotePropertyName cleanupConfirmed -NotePropertyValue (-not(Test-Path -LiteralPath $qaRoot));[IO.File]::WriteAllText($qaReportFile,($qaReport|ConvertTo-Json -Depth 7),[Text.UTF8Encoding]::new($false))}
}
@{pass=$qaReport.pass;checks=$qaReport.checks.Count;actualScm=$false;cleanupConfirmed=$qaReport.cleanupConfirmed;report=$qaReportFile}|ConvertTo-Json -Compress
