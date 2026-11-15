[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$qaPath=Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts\qa-windows-service-identities.ps1'
$qaTokens=$null;$qaErrors=$null
$qaAst=[Management.Automation.Language.Parser]::ParseFile($qaPath,[ref]$qaTokens,[ref]$qaErrors)
if($qaErrors.Count){throw 'Bootstrap syntax failed'}
$qaFunctions=@($qaAst.FindAll({param($qaNode) $qaNode -is [Management.Automation.Language.FunctionDefinitionAst] -and $qaNode.Name -eq 'Get-QaServiceNames'},$true))
if($qaFunctions.Count -ne 1){throw 'One service-name builder is required'}
# Execute only the pure name builder, never the elevated bootstrap.
. ([scriptblock]::Create($qaFunctions[0].Extent.Text))
foreach($qaId in @('0123456789abcdef0123456789abcdef','fedcba9876543210fedcba9876543210')){
  $qaNames=@(Get-QaServiceNames -CaseId $qaId)
  if($qaNames.Count -ne 2){throw 'Two distinct SCM arguments required'}
  if($qaNames[0] -cne "Ragent-IdentityQA-Control-$qaId" -or $qaNames[1] -cne "Ragent-IdentityQA-Executor-$qaId"){throw 'Unexpected service-name expression'}
  if(@($qaNames|Where-Object {$_ -match '\s|[/\\]'}).Count){throw 'Unsafe service name'}
}
foreach($qaBad in @('x',('a'*31),('a'*33),'../outside')){
  $qaRefused=$false;try{Get-QaServiceNames -CaseId $qaBad|Out-Null}catch{$qaRefused=$true}
  if(-not $qaRefused){throw 'Invalid case admitted'}
}
Write-Output 'PASS: actual PowerShell name builder produces exactly two separate SCM names and rejects invalid cases; no elevation or SCM writes'
