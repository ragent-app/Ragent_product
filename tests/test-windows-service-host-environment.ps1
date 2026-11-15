# Actual compiled shipped-host launch preparation; no SCM/UAC/installed writes.
[CmdletBinding()]
param([string]$NodePath='C:\Program Files\Ragent\payload\node.exe')
$ErrorActionPreference='Stop'
$qaSource=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$qaId=[Guid]::NewGuid().ToString('N')
$qaRoot=Join-Path ([IO.Path]::GetTempPath()) ('ragent-service-env-'+$qaId)
$qaEvidence=Join-Path $qaSource ('artifacts\showcase\T2-current-20261017\identity-migration\environment-'+$qaId)
$qaNode=$NodePath
$qaExe=Join-Path $qaRoot 'ServiceHostEnvironmentProbe.exe'
$qaProbe=Join-Path $qaRoot 'probe.mjs'
New-Item -ItemType Directory -Path $qaRoot|Out-Null
New-Item -ItemType Directory -Path $qaEvidence -Force|Out-Null
$qaSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& 'C:\Windows\System32\icacls.exe' $qaRoot '/inheritance:r' '/grant:r' "*${qaSid}:(OI)(CI)F"|Out-Null
if($LASTEXITCODE -ne 0){throw 'QA private root ACL failed'}
[IO.File]::WriteAllText((Join-Path $qaRoot '.ragent-service-env'),$qaId)
$qaJs=@'
import assert from 'node:assert/strict';
const forbidden=/API_KEY|SECRET|TOKEN|CREDENTIAL|FIREBASE|^NODE_OPTIONS$|^NODE_PATH$|^CODEX_HOME$|^CLAUDE_CONFIG_DIR$|PROXY|NATIVE_REGISTRY/;
assert.equal(Object.keys(process.env).some(name=>forbidden.test(name.toUpperCase())),false);
assert.equal(process.env.RAGENT_WINDOWS_SERVICE_ROLE,'supervisor');
assert.equal(process.env.RAGENT_WINDOWS_SERVICE_MODE,'1');
assert.ok(process.env.SystemRoot && process.env.PATH && process.env.RAGENT_RUN_SPOOL_DIR);
assert.ok(!process.env.RAGENT_RUN_SPOOL_DIR.includes('SYNTHETIC'));
console.log(JSON.stringify({pass:true}));
'@
[IO.File]::WriteAllText($qaProbe,$qaJs,[Text.UTF8Encoding]::new($false))
$qaControlProbe=Join-Path $qaRoot 'control-probe.mjs'
$qaControlJs=@'
import assert from 'node:assert/strict';
const forbidden=/API_KEY|SECRET|TOKEN|CREDENTIAL|FIREBASE|^NODE_OPTIONS$|^NODE_PATH$|^CODEX_HOME$|^CLAUDE_CONFIG_DIR$|PROXY|NATIVE_REGISTRY/;
assert.equal(Object.keys(process.env).some(name=>name !== 'RAGENT_AUTH_SESSION_SECRET' && forbidden.test(name.toUpperCase())),false);
assert.equal(process.env.RAGENT_WINDOWS_SERVICE_ROLE,'control');
assert.equal(process.env.RAGENT_TEMPORARY_PAIRING_ENABLED,'1');
assert.equal(process.env.RAGENT_WINDOWS_SERVICE_MODE,'1');
assert.match(process.env.RAGENT_AUTH_SESSION_SECRET,/^[a-f0-9]{64}$/);
assert.ok(!process.env.RAGENT_AUTH_SESSION_SECRET.includes('SYNTHETIC'));
console.log(JSON.stringify({pass:true}));
'@
[IO.File]::WriteAllText($qaControlProbe,$qaControlJs,[Text.UTF8Encoding]::new($false))
$qaReport=$null
try{
  & 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe' /nologo /target:exe /main:ServiceHostEnvironmentProbe /r:System.ServiceProcess.dll /r:System.Web.Extensions.dll /r:System.Security.dll "/out:$qaExe" (Join-Path $qaSource 'packaging\windows\Ragent.ServiceHost.cs') (Join-Path $qaSource 'tests\fixtures\windows-service-host-environment.cs') *> (Join-Path $qaEvidence 'build.log')
  if($LASTEXITCODE -ne 0){throw 'Compiled shipped-host fixture failed'}
  $qaRaw=& $qaExe $qaRoot $qaNode $qaProbe (Join-Path $qaSource 'chat\runner-supervisor-daemon.mjs') $qaControlProbe
  $qaExit=$LASTEXITCODE
  $qaReport=$qaRaw|ConvertFrom-Json
  $qaReport|Add-Member -NotePropertyName caseId -NotePropertyValue $qaId
  $qaReport|Add-Member -NotePropertyName executedAt -NotePropertyValue (Get-Date).ToString('o')
  $qaReport|Add-Member -NotePropertyName sourceFiles -NotePropertyValue @(@('packaging/windows/Ragent.ServiceHost.cs','tests/fixtures/windows-service-host-environment.cs','tests/test-windows-service-host-environment.ps1')|ForEach-Object {@{path=$_;sha256=(Get-FileHash -LiteralPath (Join-Path $qaSource $_) -Algorithm SHA256).Hash.ToLowerInvariant()}})
  $qaReport|Add-Member -NotePropertyName compiledSha256 -NotePropertyValue (Get-FileHash -LiteralPath $qaExe -Algorithm SHA256).Hash.ToLowerInvariant()
  if($qaExit -ne 0 -or -not $qaReport.pass){throw 'Shipped-host environment regression failed'}
}finally{
  if($qaReport){$qaReport|ConvertTo-Json -Depth 6|Set-Content -LiteralPath (Join-Path $qaEvidence 'report.json') -Encoding utf8}
  $qaActual=[IO.Path]::GetFullPath($qaRoot)
  if([IO.Path]::GetDirectoryName($qaActual) -cne [IO.Path]::GetTempPath().TrimEnd('\') -or [IO.Path]::GetFileName($qaActual) -cne ('ragent-service-env-'+$qaId)){throw 'QA cleanup root mismatch'}
  if([IO.File]::ReadAllText((Join-Path $qaActual '.ragent-service-env')) -cne $qaId){throw 'QA cleanup marker mismatch'}
  if((Get-Item -LiteralPath $qaActual -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'QA cleanup root reparse'}
  # Fresh, absolute, marked private root; never enumerate into another shell.
  Remove-Item -LiteralPath $qaActual -Recurse -Force
}
@{pass=$qaReport.pass;caseId=$qaId;report=(Join-Path $qaEvidence 'report.json')}|ConvertTo-Json -Compress
