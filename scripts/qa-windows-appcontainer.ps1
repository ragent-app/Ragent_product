[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$sourceProbe = Split-Path -Parent $PSScriptRoot
$evidenceProbe = Join-Path $sourceProbe 'artifacts\showcase\T2-current-20261017\appcontainer'
New-Item -ItemType Directory -Force -Path $evidenceProbe | Out-Null
$identityProbe = [Security.Principal.WindowsIdentity]::GetCurrent()
$principalProbe = [Security.Principal.WindowsPrincipal]::new($identityProbe)
if ($identityProbe.IsSystem -or $principalProbe.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run the feasibility probe as the ordinary signed-in user, without elevation.'
}
$caseProbe = [Guid]::NewGuid().ToString('N')
$rootProbe = Join-Path $env:LOCALAPPDATA "Ragent\isolation-probes\$caseProbe"
$profileProbe = "ragent.t2probe.$caseProbe"
$reportProbe = [ordered]@{schemaVersion=1;case=$caseProbe;startedAtUtc=[DateTime]::UtcNow.ToString('o');pass=$false;root=$rootProbe;profile=$profileProbe;productionChanged=$false;phoneTouched=$false;networkCapabilities=@();credentialsUsed=$false}
$pipeProbe = $null
$tcpProbe = $null
Add-Type @'
using System;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
public sealed class RagentProbePipePeer {
 public uint pid; public bool isAppContainer; public int error; public int bytesRead=-1;
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetNamedPipeClientProcessId(IntPtr pipe,out uint pid);
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int kind,out int value,int size,out int returned);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 public static async Task<RagentProbePipePeer> Watch(NamedPipeServerStream server) {
  await server.WaitForConnectionAsync().ConfigureAwait(false);
  var peer=new RagentProbePipePeer();
  if(!GetNamedPipeClientProcessId(server.SafePipeHandle.DangerousGetHandle(),out peer.pid)) {peer.error=Marshal.GetLastWin32Error();return peer;}
  IntPtr process=OpenProcess(0x1000,false,peer.pid),token=IntPtr.Zero;
  if(process==IntPtr.Zero){peer.error=Marshal.GetLastWin32Error();return peer;}
  try { if(!OpenProcessToken(process,8,out token)){peer.error=Marshal.GetLastWin32Error();return peer;}
   int app,size;if(!GetTokenInformation(token,29,out app,4,out size)){peer.error=Marshal.GetLastWin32Error();return peer;}
   peer.isAppContainer=app!=0;
  } finally {if(token!=IntPtr.Zero)CloseHandle(token);CloseHandle(process);}
  using(var deadline=new CancellationTokenSource(1500)) {
   try {peer.bytesRead=await server.ReadAsync(new byte[64],0,64,deadline.Token).ConfigureAwait(false);}
   catch(OperationCanceledException){peer.error=258;}
   catch(System.IO.IOException){peer.error=109;}
  }
  return peer;
 }
}
'@
try {
  New-Item -ItemType Directory -Path $rootProbe | Out-Null
  $sidProbe = '*' + $identityProbe.User.Value
  & "$env:SystemRoot\System32\icacls.exe" $rootProbe '/inheritance:r' '/grant:r' "${sidProbe}:(OI)(CI)F" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Cannot protect probe root' }
  [IO.File]::WriteAllText((Join-Path $rootProbe '.ragent-isolation-probe'),$profileProbe,[Text.UTF8Encoding]::new($false))
  foreach ($partProbe in @('runtime','workspace','control','other-grant','evidence')) {
    New-Item -ItemType Directory -Path (Join-Path $rootProbe $partProbe) | Out-Null
  }
  & "$env:SystemRoot\System32\icacls.exe" (Join-Path $rootProbe 'workspace') '/setintegritylevel' '(OI)(CI)L' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Cannot set the owned test workspace low label' }
  [IO.File]::WriteAllText((Join-Path $rootProbe 'control\secret.txt'),'SYNTHETIC-CONTROL-'+$caseProbe)
  [IO.File]::WriteAllText((Join-Path $rootProbe 'other-grant\secret.txt'),'SYNTHETIC-OTHER-GRANT-'+$caseProbe)
  New-Item -ItemType Junction -Path (Join-Path $rootProbe 'workspace\escape-junction') -Target (Join-Path $rootProbe 'other-grant') | Out-Null
  $nodeProbe = 'C:\Program Files\Ragent\payload\node.exe'
  $codexProbe = 'C:\ProgramData\Ragent\harnesses\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe'
  $reportProbe.sourceCommit = (& git -C $sourceProbe rev-parse HEAD).Trim()
  $reportProbe.sourceFiles = @('native/windows-appcontainer-probe.cs','scripts/qa-windows-appcontainer.ps1') | ForEach-Object { @{file=$_;sha256=(Get-FileHash -LiteralPath (Join-Path $sourceProbe $_)).Hash.ToLowerInvariant()} }
  $reportProbe.inputs = @()
  foreach ($binaryProbe in @(@{source=$nodeProbe;name='node.exe'},@{source=$codexProbe;name='codex.exe'})) {
    $hashProbe = (Get-FileHash -LiteralPath $binaryProbe.source -Algorithm SHA256).Hash.ToLowerInvariant()
    $destProbe = Join-Path $rootProbe ('runtime\'+$binaryProbe.name)
    Copy-Item -LiteralPath $binaryProbe.source -Destination $destProbe
    if ((Get-FileHash -LiteralPath $destProbe).Hash.ToLowerInvariant() -ne $hashProbe) { throw 'Binary copy mismatch' }
    $reportProbe.inputs += @{name=$binaryProbe.name;source=$binaryProbe.source;sha256=$hashProbe}
  }
  $helperProbe = Join-Path $rootProbe 'runtime\AppContainerProbe.exe'
  & "$env:SystemRoot\Microsoft.NET\Framework64\v4.0.30319\csc.exe" '/nologo' '/target:exe' '/platform:x64' '/r:System.Web.Extensions.dll' "/out:$helperProbe" (Join-Path $sourceProbe 'native\windows-appcontainer-probe.cs') *> (Join-Path $rootProbe 'evidence\build.log')
  if ($LASTEXITCODE -ne 0) { throw 'Probe helper build failed; see owned evidence/build.log' }
  $reportProbe.helperSha256 = (Get-FileHash -LiteralPath $helperProbe).Hash.ToLowerInvariant()
  $outsideAclProbe = (Get-Acl -LiteralPath $sourceProbe).Sddl
  $outsideOutputProbe = & $helperProbe $sourceProbe $profileProbe
  $outsideExitProbe = $LASTEXITCODE
  $outsideReportProbe = $outsideOutputProbe | ConvertFrom-Json
  $reportProbe.outsideRootRefused = $outsideExitProbe -eq 1 -and $outsideReportProbe.error -eq 'Not an owned probe root/profile' -and -not $outsideReportProbe.profileDeleted -and (Get-Acl -LiteralPath $sourceProbe).Sddl -eq $outsideAclProbe
  if (-not $reportProbe.outsideRootRefused) { throw 'Outside-root guard regression' }
  $pipeNameProbe = 'ragent-t2-owner-probe-' + $caseProbe
  $pipeOptionsProbe = [IO.Pipes.PipeOptions]::Asynchronous
  $pipeSecurityProbe = [IO.Pipes.PipeSecurity]::new()
  $pipeSecurityProbe.SetAccessRuleProtection($true,$false)
  $packageSidProbe = (& $helperProbe derive $profileProbe).Trim()
  if ($LASTEXITCODE -ne 0 -or $packageSidProbe -notmatch '^S-1-15-2-\d+(?:-\d+)+$') { throw 'Cannot derive exact probe package SID' }
  $pipeSecurityProbe.AddAccessRule([IO.Pipes.PipeAccessRule]::new([Security.Principal.SecurityIdentifier]::new($packageSidProbe),[IO.Pipes.PipeAccessRights]::FullControl,[Security.AccessControl.AccessControlType]::Deny))
  $pipeSecurityProbe.AddAccessRule([IO.Pipes.PipeAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-15-2-1'),[IO.Pipes.PipeAccessRights]::FullControl,[Security.AccessControl.AccessControlType]::Deny))
  $pipeSecurityProbe.AddAccessRule([IO.Pipes.PipeAccessRule]::new($identityProbe.User,[IO.Pipes.PipeAccessRights]::FullControl,[Security.AccessControl.AccessControlType]::Allow))
  $pipeProbe = [IO.Pipes.NamedPipeServerStreamAcl]::Create(($pipeNameProbe+'-positive'),[IO.Pipes.PipeDirection]::InOut,1,[IO.Pipes.PipeTransmissionMode]::Byte,$pipeOptionsProbe,4096,4096,$pipeSecurityProbe)
  $normalPipeClientProbe = [IO.Pipes.NamedPipeClientStream]::new('.',($pipeNameProbe+'-positive'),[IO.Pipes.PipeDirection]::InOut)
  try {
    $normalPipeClientProbe.Connect(1000)
    $pipeProbe.WaitForConnection()
    $reportProbe.ownerPipeOrdinaryUserPositive = $pipeProbe.IsConnected
  } finally { $normalPipeClientProbe.Dispose() }
  $pipeProbe.Dispose()
  $pipeProbe = [IO.Pipes.NamedPipeServerStreamAcl]::Create($pipeNameProbe,[IO.Pipes.PipeDirection]::InOut,1,[IO.Pipes.PipeTransmissionMode]::Byte,$pipeOptionsProbe,4096,4096,$pipeSecurityProbe)
  $pendingPipeProbe = [RagentProbePipePeer]::Watch($pipeProbe)
  $reportProbe.pipeBeforeLaunch = @{connected=$pipeProbe.IsConnected;taskStatus=[string]$pendingPipeProbe.Status}
  $tcpProbe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
  $tcpProbe.Start()
  $portProbe = $tcpProbe.LocalEndpoint.Port
  if ($portProbe -in @(7690,7699)) { throw 'Production port refused' }
  $tcpClientProbe = [Net.Sockets.TcpClient]::new()
  try {
    $tcpClientProbe.Connect([Net.IPAddress]::Loopback,$portProbe)
    $acceptedProbe = $tcpProbe.AcceptTcpClient()
    $reportProbe.loopbackOrdinaryUserPositive = $acceptedProbe.Connected
    $acceptedProbe.Dispose()
  } finally { $tcpClientProbe.Dispose() }
  $pendingTcpProbe = $tcpProbe.AcceptTcpClientAsync()
  $rootLiteralProbe = ConvertTo-Json -InputObject $rootProbe -Compress
  $pipeLiteralProbe = ConvertTo-Json -InputObject ('\\.\pipe\'+$pipeNameProbe) -Compress
  $workerProbe = @'
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {spawn,spawnSync} from 'node:child_process';
const root=__ROOT__,work=path.join(root,'workspace'),runtime=path.join(root,'runtime');
const results={},denialCodes={};
function progress(name){fs.appendFileSync(path.join(work,'progress.ndjson'),JSON.stringify({name})+'\n')}
function denied(name,fn){try{fn();results[name]=false}catch(error){denialCodes[name]=error.code;results[name]=['EACCES','EPERM','ENOENT'].includes(error.code)}progress(name)}
fs.writeFileSync(path.join(work,'result.txt'),'scoped workspace write');
results.workspaceReadWrite=fs.readFileSync(path.join(work,'result.txt'),'utf8')==='scoped workspace write';
progress('workspaceReadWrite');
denied('controlReadDenied',()=>fs.readFileSync(path.join(root,'control','secret.txt')));
denied('otherGrantReadDenied',()=>fs.readFileSync(path.join(root,'other-grant','secret.txt')));
denied('outsideWriteDenied',()=>fs.writeFileSync(path.join(root,'control','new.txt'),'blocked'));
denied('runtimeWriteDenied',()=>fs.writeFileSync(path.join(runtime,'new.txt'),'blocked'));
denied('junctionEscapeDenied',()=>fs.readFileSync(path.join(work,'escape-junction','secret.txt')));
const handleOutput=path.join(work,'handle-check.json'),handleError=path.join(work,'handle-check.stderr');
const handleOutFd=fs.openSync(handleOutput,'w'),handleErrFd=fs.openSync(handleError,'w');
let handleResult;
try {handleResult=spawnSync(path.join(runtime,'AppContainerProbe.exe'),['inspect-handle',process.env.RAGENT_PROBE_HANDLE,process.env.RAGENT_PROBE_HANDLE_ID],{stdio:[0,handleOutFd,handleErrFd],timeout:5000,windowsHide:true})}
finally {fs.closeSync(handleOutFd);fs.closeSync(handleErrFd)}
const handleFacts=JSON.parse(fs.readFileSync(handleOutput,'utf8'));
results.inheritedControlHandleDenied=handleResult.status===0 && handleFacts.denied && !handleFacts.leaked;
progress('inheritedControlHandleDenied');
const pipe=__PIPE__;
await new Promise(resolve=>{
 const socket=net.createConnection(pipe);const timer=setTimeout(()=>{results.ownerPipeDenied=false;socket.destroy();resolve()},2500);
 socket.once('connect',()=>{clearTimeout(timer);results.ownerPipeDenied=false;socket.destroy();resolve()});
 socket.once('error',error=>{clearTimeout(timer);denialCodes.ownerPipeDenied=error.code;results.ownerPipeDenied=['EACCES','EPERM','ENOENT'].includes(error.code);resolve()});
});
progress('ownerPipeDenied');
await new Promise(resolve=>{
 const socket=net.createConnection({host:'127.0.0.1',port:__PORT__});
 const timer=setTimeout(()=>{denialCodes.loopbackDenied='TIMEOUT_NO_CONNECTION';results.loopbackDenied=true;socket.destroy();resolve()},2000);
 socket.once('connect',()=>{clearTimeout(timer);results.loopbackDenied=false;socket.destroy();resolve()});
 socket.once('error',error=>{clearTimeout(timer);denialCodes.loopbackDenied=error.code;results.loopbackDenied=['EACCES','EPERM','ETIMEDOUT'].includes(error.code);resolve()});
});
progress('loopbackDenied');
// A deliberately living descendant proves Job close cleanup independently of
// the successful main process exit. No breakaway flag is requested.
const descendant=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit',windowsHide:true,detached:true});
await new Promise((resolve,reject)=>{descendant.once('spawn',resolve);descendant.once('error',reject)});
descendant.unref();
const report={results,denialCodes,deliberateDescendantPid:descendant.pid,pass:Object.values(results).every(Boolean)};
console.log(JSON.stringify(report));
process.exitCode=report.pass?0:1;
'@
  $workerProbe = $workerProbe.Replace('__ROOT__',$rootLiteralProbe).Replace('__PIPE__',$pipeLiteralProbe).Replace('__PORT__',[string]$portProbe)
  [IO.File]::WriteAllText((Join-Path $rootProbe 'runtime\probe.mjs'),$workerProbe,[Text.UTF8Encoding]::new($false))
  & $helperProbe $rootProbe $profileProbe *> (Join-Path $rootProbe 'evidence\launcher.log')
  $reportProbe.nativeExitCode = $LASTEXITCODE
  $nativeReportProbe = Get-Content -LiteralPath (Join-Path $rootProbe 'evidence\native-report.json') -Raw | ConvertFrom-Json
  $reportProbe.native = $nativeReportProbe
  if (Test-Path -LiteralPath (Join-Path $rootProbe 'evidence\node.stdout')) {
    $rawProbe = [IO.File]::ReadAllText((Join-Path $rootProbe 'evidence\node.stdout')).Trim()
    if ($rawProbe) { try { $reportProbe.node = $rawProbe | ConvertFrom-Json } catch { $reportProbe.nodeOutputNotJson = $true } }
  }
  if (Test-Path -LiteralPath (Join-Path $rootProbe 'evidence\codex.stdout')) {
    $reportProbe.codexVersion = [IO.File]::ReadAllText((Join-Path $rootProbe 'evidence\codex.stdout')).Trim()
  }
  $reportProbe.ownerPipeConnectionObserved = $pendingPipeProbe.IsCompletedSuccessfully
  $reportProbe.pipeAfterLaunch = @{connected=$pipeProbe.IsConnected;taskStatus=[string]$pendingPipeProbe.Status}
  if ($pendingPipeProbe.IsCompletedSuccessfully) { $reportProbe.pipePeer = $pendingPipeProbe.Result }
  $reportProbe.ownerPipeNoRequest = -not $pipeProbe.IsConnected -or ($pendingPipeProbe.IsCompletedSuccessfully -and $pendingPipeProbe.Result.error -eq 0 -and $pendingPipeProbe.Result.bytesRead -eq 0)
  $nodeCaseProbe = $nativeReportProbe.cases | Where-Object label -eq node
  $reportProbe.deliberateDescendantVerified = @($nodeCaseProbe.descendantTokens | Where-Object pid -eq $reportProbe.node.deliberateDescendantPid).Count -eq 1
  $reportProbe.loopbackUnexpectedConnection = $pendingTcpProbe.IsCompletedSuccessfully
  $reportProbe.pass = $reportProbe.nativeExitCode -eq 0 -and $nativeReportProbe.pass -and $reportProbe.node.pass -and $reportProbe.ownerPipeNoRequest -and $reportProbe.deliberateDescendantVerified -and -not $reportProbe.loopbackUnexpectedConnection -and $reportProbe.outsideRootRefused
} catch {
  $reportProbe.error = $_.Exception.Message
} finally {
  if ($pipeProbe) { $pipeProbe.Dispose() }
  if ($tcpProbe) { $tcpProbe.Stop() }
  # Remove only known copied binaries, after exact marked-root/owner checks.
  # Keep source, synthetic fixtures, stdout/stderr and all failure reports.
  $removedProbe = @()
  try {
    $expectedParentProbe = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Ragent\isolation-probes')).TrimEnd('\')+'\'
    $actualRootProbe = [IO.Path]::GetFullPath($rootProbe)
    if (-not $actualRootProbe.StartsWith($expectedParentProbe,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($actualRootProbe) -notmatch '^[a-f0-9]{32}$') { throw 'Cleanup root mismatch' }
    if ([IO.File]::ReadAllText((Join-Path $actualRootProbe '.ragent-isolation-probe')).Trim() -ne $profileProbe) { throw 'Cleanup marker mismatch' }
    if ((Get-Acl -LiteralPath $actualRootProbe).GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $identityProbe.User.Value) { throw 'Cleanup owner mismatch' }
    foreach ($binaryNameProbe in @('node.exe','codex.exe','AppContainerProbe.exe')) {
      $runtimePathProbe = Join-Path $actualRootProbe 'runtime'
      if ((Get-Item -LiteralPath $runtimePathProbe).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Cleanup runtime is a reparse point' }
      $binaryPathProbe = Join-Path $runtimePathProbe $binaryNameProbe
      if (Test-Path -LiteralPath $binaryPathProbe) { Remove-Item -LiteralPath $binaryPathProbe; $removedProbe += $binaryNameProbe }
    }
    $reportProbe.copiedBinariesRemoved = $removedProbe
  } catch { $reportProbe.binaryCleanupError=$_.Exception.Message; $reportProbe.pass=$false }
  $reportProbe.finishedAtUtc = [DateTime]::UtcNow.ToString('o')
  $reportPathProbe = Join-Path $evidenceProbe ("case-$caseProbe.json")
  $reportProbe | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $reportPathProbe -Encoding utf8
  [pscustomobject]@{pass=$reportProbe.pass;report=$reportPathProbe;root=$rootProbe;error=$reportProbe.error} | ConvertTo-Json -Compress
}
if (-not $reportProbe.pass) { exit 1 }
