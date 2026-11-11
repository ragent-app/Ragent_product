[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$TestRoot)
$ErrorActionPreference='Stop'
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
if(-not [Security.Principal.WindowsPrincipal]::new($identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'An administrator token is required for the protected fixture.'}
$testRoot=[IO.Path]::GetFullPath($TestRoot)
if(Test-Path -LiteralPath $testRoot){throw 'The test root must be a new, empty path.'}
New-Item -ItemType Directory -Path $testRoot | Out-Null
$serviceSid=([Security.Principal.NTAccount]::new('NT SERVICE','AgentoC-ControlPlane')).Translate([Security.Principal.SecurityIdentifier]).Value
$acl=[Security.AccessControl.DirectorySecurity]::new()
$acl.SetSecurityDescriptorSddlForm("O:SYG:SYD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;$serviceSid)")
Set-Acl -LiteralPath $testRoot -AclObject $acl
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$compiler=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$output=Join-Path $testRoot 'retirement-test.exe'
& $compiler /nologo /target:exe /main:LegacyVoiceRetirementTest /define:VOICE_RETIRE_TEST /r:System.Management.dll /r:System.ServiceProcess.dll /r:System.Security.dll /r:System.Web.Extensions.dll ('/out:'+$output) (Join-Path $repo 'packaging\windows\legacy-voice-retirement.cs') (Join-Path $repo 'packaging\windows\AgentoC.ServiceHost.cs') (Join-Path $repo 'packaging\windows\owner-service-activation-trial.cs') (Join-Path $repo 'tests\windows-voice-retirement.cs')
if($LASTEXITCODE -ne 0){throw 'VOICE_RETIRE_TEST_COMPILE_FAILED'}
$fixture=Join-Path $testRoot 'fixture'
New-Item -ItemType Directory -Path $fixture | Out-Null
& $output $fixture
if($LASTEXITCODE -ne 0){throw 'VOICE_RETIRE_TEST_FAILED'}
