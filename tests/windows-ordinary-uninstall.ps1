# Called while the policy-removal QA owns a fresh prepared installation. No
# AlwaysInstallElevated/UAC changes, persisted password or local production use.
function Invoke-OrdinaryUninstallProbe([string]$Bridge,[string]$MsiPath,[string]$EvidenceRoot){
 if($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:GITHUB_REPOSITORY -cne 'owner/private-qa-repository'){throw 'OUQ_DISPOSABLE_REQUIRED'}
 $name='AgcQa'+[guid]::NewGuid().ToString('N').Substring(0,8);$parent='C:\Users\Public';$root=Join-Path $parent ('Ragent-uninstall-qa-'+[guid]::NewGuid().ToString('N'));$user=$null;$child=$null;$done=$false
 $password=[Convert]::ToBase64String([guid]::NewGuid().ToByteArray())+'aA!9';$secret=ConvertTo-SecureString $password -AsPlainText -Force
 try {
  $user=New-LocalUser -Name $name -Password $secret -AccountNeverExpires -PasswordNeverExpires
  $group=[Security.Principal.SecurityIdentifier]::new('S-1-5-32-545').Translate([Security.Principal.NTAccount]).Value.Split('\')[-1];Add-LocalGroupMember -Group $group -Member $name
  $acl=[Security.AccessControl.DirectorySecurity]::new();$acl.SetAccessRuleProtection($true,$false);$acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
  foreach($sid in @('S-1-5-18','S-1-5-32-544')){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))}
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($user.SID,'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow'));$null=[IO.Directory]::CreateDirectory($root,$acl)
  Copy-Item -LiteralPath $Bridge -Destination (Join-Path $root 'Ragent.ManagedOwnerMsiBridge.exe')
  $exe=Join-Path $root 'OrdinaryUninstallProbe.exe'; & 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe' /nologo /target:exe /r:System.Web.Extensions.dll ('/out:'+$exe) (Join-Path $repo 'tests\fixtures\windows-ordinary-uninstall.cs')|Out-Null;if($LASTEXITCODE -ne 0){throw 'OUQ_CLIENT_COMPILE'}
  $resultDir=Join-Path $root 'result';$resultAcl=[Security.AccessControl.DirectorySecurity]::new();$resultAcl.SetAccessRuleProtection($true,$false);$resultAcl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'));foreach($sid in @('S-1-5-18','S-1-5-32-544')){$resultAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))};$resultAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($user.SID,'Modify','ContainerInherit,ObjectInherit','None','Allow'));$null=[IO.Directory]::CreateDirectory($resultDir,$resultAcl)
  $installer=New-Object -ComObject WindowsInstaller.Installer;$db=$installer.OpenDatabase($MsiPath,0);$view=$db.OpenView('SELECT `Value` FROM `Property` WHERE `Property`=''ProductCode''');$null=$view.Execute();$row=$view.Fetch();$code=$row.StringData(1)
  $credential=[Management.Automation.PSCredential]::new(('.\'+$name),$secret);$child=Start-Process -FilePath $exe -ArgumentList $code -Credential $credential -WorkingDirectory $root -WindowStyle Hidden -PassThru
  $null=$child.Handle;if(-not $child.WaitForExit(180000)){throw 'OUQ_CLIENT_TIMEOUT'};$child.Refresh();if($child.ExitCode -ne 0){throw 'OUQ_CLIENT_REFUSED'};$done=$true
  $facts=[IO.File]::ReadAllText((Join-Path $resultDir 'ordinary-client.json'))|ConvertFrom-Json
  if($facts.sid -cne $user.SID.Value -or $facts.integrityRid -ne 8192 -or $facts.administrator -or $facts.elevated){throw 'OUQ_TOKEN_FACTS_INVALID'}
  Copy-Item -LiteralPath (Join-Path $resultDir 'ordinary-client.json') -Destination $EvidenceRoot;Copy-Item -LiteralPath (Join-Path $resultDir 'ordinary-msi.log') -Destination $EvidenceRoot
  # A headless, unauthorised /qn caller cannot consent to elevation. The right
  # result is OS1730 after our read-only guard, not silent privileged deletion.
  if($facts.admission.exitCode -ne 0 -or $facts.msi.exitCode -ne 1603 -or $facts.enableLUA -ne 1){throw 'OUQ_ORDINARY_AUTHORIZATION_BOUNDARY_CHANGED'}
  $log=[IO.File]::ReadAllText((Join-Path $resultDir 'ordinary-msi.log'))
  if($log -cnotmatch 'ManagedRemoveGuard\. Return value 1' -or $log -cnotmatch 'Elevation prompt disabled for silent installs' -or $log -cnotmatch 'Error 1730' -or $log -cnotmatch 'InstallInitialize\. Return value 3' -or $log.Contains('CustomActionSchedule(Action=ManagedRemove,') -or $log.Contains('Executing op: FileRemove(')){throw 'OUQ_UNAUTHORISED_MUTATION_OR_WRONG_FAILURE'}
  $admitted=$facts.admission.stdout|ConvertFrom-Json;if(-not $admitted.ok -or -not $admitted.readOnly -or -not $admitted.requiresDeferredValidation -or -not $admitted.policyPrepared -or $admitted.authorityIssued){throw 'OUQ_ADMISSION_CHANGED'}
  foreach($denied in @($facts.removeCheck,$facts.directRemove)){if($denied.exitCode -ne 1 -or $denied.stderr.Trim() -cne 'OMI_ADMIN_REQUIRED'){throw 'OUQ_DIRECT_PRIVILEGE_GATE_CHANGED'}}
  return $facts
 }finally{
  if($child){if(-not $child.HasExited){$child.Kill();$null=$child.WaitForExit(15000)};$child.Dispose()}
  if($user){Remove-LocalUser -SID $user.SID -ErrorAction Stop;if(Get-LocalUser -Name $name -ErrorAction SilentlyContinue){throw 'OUQ_USER_CLEANUP_FAILED'};if($facts){$facts|Add-Member -NotePropertyName testAccountRemoved -NotePropertyValue $true}}
  if(Test-Path -LiteralPath $root){if([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($root)) -cne $parent){throw 'OUQ_ROOT_REFUSED'};foreach($p in @(Get-ChildItem -LiteralPath $root -Recurse -Force)){if($p.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'OUQ_REPARSE_REFUSED'}};Remove-Item -LiteralPath $root -Recurse -Force}
  if($facts){$facts|Add-Member -NotePropertyName publicProbeRootRemoved -NotePropertyValue $true}
 }
}
