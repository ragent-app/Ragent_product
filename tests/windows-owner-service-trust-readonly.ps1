[CmdletBinding()]
param([switch]$LiveOwnerSession)
$ErrorActionPreference='Stop'
$source=Join-Path $PSScriptRoot '..\packaging\windows\read-owner-service-trust.ps1'
$tokens=$null;$errors=$null
$null=[Management.Automation.Language.Parser]::ParseFile($source,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Service trust inspector has PowerShell syntax errors'}
$text=[IO.File]::ReadAllText($source)
$match=[regex]::Match($text,"(?s)Add-Type -TypeDefinition @'\r?\n(.*?)\r?\n'@")
if(-not $match.Success){throw 'Missing actual WTS query source'}
Add-Type -TypeDefinition $match.Groups[1].Value
$result=[ordered]@{pass=$true;actualPowerShellParse=$true;actualWtsCompile=$true;actualOwnerSessionQuery=$false;actualServiceToken=$false;actualSignedHelper=$false}
if($LiveOwnerSession){
  $session=[RagentOwnerSessions]::Find([Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
  if($session -le 0 -or $session -gt 65535){throw 'Invalid live Owner session'}
  $result.actualOwnerSessionQuery=$true;$result.ownerSessionId=$session
}
$result|ConvertTo-Json -Compress
