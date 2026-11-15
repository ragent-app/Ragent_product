# Private QA coordinator deliberately held at one of two explicit API boundaries.
# It never starts services or invokes public admission with a substitute signer.
param([Parameter(Mandatory=$true)][ValidateSet('prepared','committed')][string]$Phase)
$ErrorActionPreference='Stop'
if($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:GITHUB_REPOSITORY -cne 'owner/private-qa-repository' -or $env:RUNNER_OS -cne 'Windows' -or $env:GITHUB_REF -cnotmatch '^refs/heads/qa/windows-msi-[a-z0-9-]+$'){throw 'AIQ_DISPOSABLE_REQUIRED'}
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'));$pack=Join-Path $repo 'packaging\windows';$product='C:\Program Files\Ragent'
Add-Type -Path @((Join-Path $pack 'Ragent.ServiceHost.cs'),(Join-Path $pack 'owner-service-activation-trial.cs'),(Join-Path $pack 'owner-service-activation-transaction.cs')) -ReferencedAssemblies @('System.ServiceProcess.dll','System.Web.Extensions.dll')
$sup=[OwnerServiceActivationTrial]::new('Ragent-RunnerSupervisor','"C:\Program Files\Ragent\ActivationTrialProbe.exe" supervisor')
$control=[OwnerServiceActivationTrial]::new('Ragent-ControlPlane','"C:\Program Files\Ragent\ActivationTrialProbe.exe" control')
$tx=[OwnerServiceActivationTransaction]::new(('inst_'+('d'*32)),[IO.File]::ReadAllBytes((Join-Path $product 'owner-msi.prepared.json')),[IO.File]::ReadAllBytes((Join-Path $product 'owner-msi.policy.json')),$sup,$control)
$tx.Begin();$tx.Prepare();if($Phase -ceq 'committed'){$tx.CommitConfiguration()}
[Console]::Out.WriteLine((@{phase=$Phase;pid=$PID;begun=$tx.Begun;configurationCommitted=$tx.ConfigurationCommitted;servicesStarted=$false}|ConvertTo-Json -Compress));[Console]::Out.Flush()
# The parent terminates the retained process handle. No catch/finally rollback,
# graceful shutdown, process exit simulation or product crash hook is involved.
while($true){[Threading.Thread]::Sleep(250)}
