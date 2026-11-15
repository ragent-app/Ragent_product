# Existing persisted submission/receipt and callback reconciliation suites,
# isolated from installed instances. No SCM, live Provider, phone or online API.
[CmdletBinding()]
param(
 [string]$NodePath='G:\Ragent\ragent-v0.3.12-main\artifacts\showcase\T2-current-20261017\service-identities\bundle-c62e7d1319543507823ed7728b247518\node.exe',
 [string]$DependencyRoot=''
)
$ErrorActionPreference='Stop'
$qaSource=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$qaId=[guid]::NewGuid().ToString('N')
$qaRoot=Join-Path ([IO.Path]::GetTempPath()) ('ragent-offline-recovery-'+$qaId)
$qaEvidence=Join-Path $qaSource ('artifacts\offline-recovery\'+$qaId)
$null=New-Item -ItemType Directory -Path $qaRoot,$qaEvidence
[IO.File]::WriteAllText((Join-Path $qaRoot '.qa-owned'),$qaId)
$qaReport=[ordered]@{pass=$false;sourceCommit=((& git -C $qaSource rev-parse HEAD)|Out-String).Trim();actualScm=$false;actualProvider=$false;onlineServices=$false;installedProductChanged=$false;checks=@();cleanupConfirmed=$false}
$qaDependencyLink=Join-Path $qaSource 'node_modules';$qaDependencyLinkOwned=$false
try{
 if((Get-FileHash -LiteralPath $NodePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne '2ffe3acc0458fdde999f50d11809bbe7c9b7ef204dcf17094e325d26ace101d8'){throw 'QA_NODE_BYTES_REQUIRED'}
 if($DependencyRoot){
  $DependencyRoot=[IO.Path]::GetFullPath($DependencyRoot)
  $lock=(Get-FileHash -LiteralPath (Join-Path $qaSource 'package-lock.json') -Algorithm SHA256).Hash
  if($lock -cne (Get-FileHash -LiteralPath (Join-Path $DependencyRoot 'package-lock.json') -Algorithm SHA256).Hash){throw 'QA_DEPENDENCY_LOCK_MISMATCH'}
  if(Test-Path -LiteralPath $qaDependencyLink){throw 'QA_DEPENDENCY_PATH_OCCUPIED'}
  $null=New-Item -ItemType Junction -Path $qaDependencyLink -Target (Join-Path $DependencyRoot 'node_modules');$qaDependencyLinkOwned=$true
  $qaReport.dependencyLockSha256=$lock.ToLowerInvariant()
 }
 # This script runs in its own PowerShell process. Drop inherited authority and
 # instance routing before importing application modules in any child.
 Get-ChildItem Env: | Where-Object {$_.Name -like 'RAGENT_*'} | ForEach-Object {Remove-Item -LiteralPath ('Env:'+$_.Name)}
 foreach($name in @('OPENAI_API_KEY','ANTHROPIC_API_KEY','GOOGLE_API_KEY','GEMINI_API_KEY','DEEPSEEK_API_KEY','CODEX_HOME','CLAUDE_CONFIG_DIR')){Remove-Item -LiteralPath ('Env:'+$name) -ErrorAction SilentlyContinue}
 $env:RAGENT_INSTANCE_ROOT=$qaRoot
 $env:RAGENT_CONFIG_DIR=Join-Path $qaRoot 'config'
 $env:RAGENT_MEMORY_DIR=Join-Path $qaRoot 'memory'
 $env:RAGENT_HARNESS_ROOT=Join-Path $qaRoot 'harnesses'
 $env:RAGENT_SHARED_TOOLS_DIR=Join-Path $qaRoot 'shared-tools'
 $env:RAGENT_ASSET_DIRECT_UPLOAD_ENABLED='0'
 $env:RAGENT_RUNNER_LIFECYCLE_SOCKET='\\.\pipe\ragent-offline-missing-'+$qaId
 $env:RAGENT_RUNNER_LIFECYCLE_REQUIRED='1'
 $env:RAGENT_MESSAGE_COMMIT_TEST_ROOT=Join-Path $qaRoot 'message-commit'
 $qaFiles=@('tests/test-run-reconciler-idempotent-recovery.mjs','tests/test-run-reconciler-terminal-result-repair.mjs','tests/test-run-reconciler-stalled-run.mjs','tests/test-message-receipt-lookup.mjs','tests/test-message-commit.mjs')
 $qaReport.sourceFiles=@(($qaFiles+@('tests/test-offline-recovery-evidence.ps1','chat/run-reconciler.mjs','chat/message-commit-store.mjs','chat/message-preparation-store.mjs','chat/session-manager.mjs','chat/runs.mjs','chat/router-session-main-routes.mjs'))|ForEach-Object {@{path=$_;sha256=(Get-FileHash -LiteralPath (Join-Path $qaSource $_) -Algorithm SHA256).Hash.ToLowerInvariant()}})
 Push-Location $qaSource
 try{
  foreach($file in $qaFiles){
   $log=Join-Path $qaEvidence (([IO.Path]::GetFileNameWithoutExtension($file))+'.log')
   & $NodePath --test --test-timeout=60000 $file *> $log
   $code=$LASTEXITCODE
   $qaReport.checks+=@{file=$file;exitCode=$code;logSha256=(Get-FileHash -LiteralPath $log -Algorithm SHA256).Hash.ToLowerInvariant()}
   if($code -ne 0){throw ('QA_SUITE_FAILED: '+$file)}
  }
 }finally{Pop-Location}
 # Includes Node test-runner children with relative argv and forked URL argv.
 # Refuse cleanup on any matching fixture process rather than guessing ownership
 # or terminating a potentially concurrent test from another checkout.
 $qaProcesses=@(Get-CimInstance Win32_Process|Where-Object {$_.Name -ieq 'node.exe' -and $_.CommandLine -and $_.CommandLine.Contains('test-message-commit.mjs')})
 if($qaProcesses.Count){throw 'QA_CHILD_STILL_RUNNING'}
 $qaReport.pass=$true
}catch{$qaReport.error=$_.Exception.Message;throw}
finally{
 if($qaDependencyLinkOwned){
  $link=Get-Item -LiteralPath $qaDependencyLink -Force
  if($link.LinkType -cne 'Junction' -or [IO.Path]::GetFullPath($link.Target[0]) -ine (Join-Path $DependencyRoot 'node_modules')){throw 'QA_DEPENDENCY_LINK_CHANGED'}
  # Remove only this junction entry, never recurse into the shared dependency tree.
  [IO.Directory]::Delete($qaDependencyLink)
 }
 if($qaReport.pass){
  if([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($qaRoot)) -cne [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') -or [IO.File]::ReadAllText((Join-Path $qaRoot '.qa-owned')) -cne $qaId){throw 'QA_CLEANUP_ROOT_REFUSED'}
  $stack=[Collections.Generic.Stack[string]]::new();$stack.Push($qaRoot)
  while($stack.Count){$directory=$stack.Pop();foreach($item in Get-ChildItem -LiteralPath $directory -Force){if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'QA_CLEANUP_REPARSE_REFUSED'};if($item.PSIsContainer){$stack.Push($item.FullName)}}}
  Remove-Item -LiteralPath $qaRoot -Recurse -Force
  $qaReport.cleanupConfirmed=-not(Test-Path -LiteralPath $qaRoot)
 }else{$qaReport.retainedFailureRoot=$qaRoot}
 [IO.File]::WriteAllText((Join-Path $qaEvidence 'report.json'),($qaReport|ConvertTo-Json -Depth 7),[Text.UTF8Encoding]::new($false))
}
@{pass=$qaReport.pass;suites=$qaReport.checks.Count;cleanupConfirmed=$qaReport.cleanupConfirmed;report=(Join-Path $qaEvidence 'report.json')}|ConvertTo-Json -Compress
