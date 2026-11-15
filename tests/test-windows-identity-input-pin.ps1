$ErrorActionPreference='Stop'
$fixtureRoot=Join-Path ([IO.Path]::GetTempPath()) ('agct-identity-pin-'+[Guid]::NewGuid().ToString('N'));$null=New-Item -ItemType Directory -Path $fixtureRoot
$exe=Join-Path $fixtureRoot 'InputPinProbe.exe';$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
& 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe' /nologo /target:exe /main:IdentityInputPinProbe /r:System.ServiceProcess.dll ('/out:'+$exe) (Join-Path $repo 'packaging\windows\Ragent.ServiceHost.cs') (Join-Path $repo 'tests\fixtures\windows-identity-input-pin.cs')
if($LASTEXITCODE -ne 0){throw 'QA_PIN_COMPILE_FAILED'}
$result=& $exe $fixtureRoot;if($LASTEXITCODE -ne 0){throw 'QA_PIN_CHECK_FAILED'};$result|Set-Content -LiteralPath (Join-Path $fixtureRoot 'report.json') -Encoding UTF8
$result;"Fixture: $fixtureRoot"
