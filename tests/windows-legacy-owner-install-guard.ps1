[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$EvidenceRoot)
$ErrorActionPreference='Stop'
$guardRoot=[IO.Path]::GetFullPath($EvidenceRoot)
if(-not(Test-Path -LiteralPath (Join-Path $guardRoot 'qa-instance.json'))){throw 'Marked isolated evidence root required'}
$guardFixture=Join-Path $guardRoot 'fixture'
New-Item -ItemType Directory -Path $guardFixture | Out-Null
$guardTarget=Join-Path $guardFixture 'real'
New-Item -ItemType Directory -Path $guardTarget | Out-Null
New-Item -ItemType Junction -Path (Join-Path $guardFixture 'junction') -Target $guardTarget | Out-Null
$guardMissing=Join-Path $guardFixture 'removed-target'
New-Item -ItemType Directory -Path $guardMissing | Out-Null
New-Item -ItemType Junction -Path (Join-Path $guardFixture 'dangling') -Target $guardMissing | Out-Null
Remove-Item -LiteralPath $guardMissing
$guardSource=Join-Path $PSScriptRoot '..\packaging\windows\legacy-owner-install-guard.cs'
$guardTests=Join-Path $PSScriptRoot 'fixtures\windows-legacy-owner-install-guard.cs'
$guardCompiler='C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$guardTestExe=Join-Path $guardRoot 'LegacyOwnerGuardTests.exe'
& $guardCompiler /nologo /target:exe /platform:x64 /reference:System.Management.dll /reference:System.Web.Extensions.dll /main:LegacyOwnerGuardTests /out:$guardTestExe $guardSource $guardTests
if($LASTEXITCODE -ne 0){throw 'Native guard test compilation failed'}
$guardNative=& $guardTestExe $guardFixture
if($LASTEXITCODE -ne 0){throw 'Native guard test failed'}
$guardNative|Set-Content -LiteralPath (Join-Path $guardRoot 'native.json') -Encoding UTF8
$guardReport=$guardNative|ConvertFrom-Json
if(-not $guardReport.pass -or $guardReport.checks.Count -ne 56){throw 'Native guard case count mismatch'}
& (Join-Path $PSScriptRoot '..\packaging\windows\build-legacy-owner-install-guard.ps1') -OutputPath (Join-Path $guardRoot 'Ragent.LegacyOwnerInstallGuard.exe')
if(-not(Test-Path -LiteralPath (Join-Path $guardRoot 'Ragent.LegacyOwnerInstallGuard.exe'))){throw 'Native product guard missing'}
@{pass=$true;nativeChecks=$guardReport.checks.Count;productionMutation=$false;fixturesRetained=$true}|ConvertTo-Json -Compress
