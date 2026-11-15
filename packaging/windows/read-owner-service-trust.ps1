# Fixed read-only service-side inspector. No metadata/path/identity parameters.
[CmdletBinding()]
param([switch]$ActivationListener,[int]$OwnerPeerPid=0,[string]$OwnerPeerCreatedTicks='',[int]$OwnerPeerSessionId=0)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'read-owner-bootstrap-discovery.ps1') -LibraryOnly
try{
  $pins=[Collections.Generic.List[IDisposable]]::new()
  try{
    Assert-OwnerPolicyInstallComplete
    if(-not $ActivationListener -and ($OwnerPeerPid -le 0 -or $OwnerPeerCreatedTicks -cnotmatch '^\d{10,20}$' -or $OwnerPeerSessionId -le 0 -or $OwnerPeerSessionId -gt 65535)){throw 'OSV_NATIVE_OWNER_REQUIRED'}
    $admin=@(Get-OwnerAdministrativeSids)
    $releasePath=Join-Path (Get-OwnerProductRoot) 'payload\owner-bootstrap-release.json'
    if(-not(Test-Path -LiteralPath $releasePath)){throw 'OBD_RELEASE_NOT_INSTALLED'}
    $release=Read-OwnerPinnedFile $releasePath $admin $pins
    $install=Read-OwnerPinnedFile (Join-Path (Get-OwnerInstanceRoot) 'security\owner-bootstrap-install.json') $admin $pins
    $utf8=[Text.UTF8Encoding]::new($false,$true)
    $releaseObject=$utf8.GetString($release)|ConvertFrom-Json
    $installation=$utf8.GetString($install)|ConvertFrom-Json
    if($installation.controlSid -cnotmatch '^S-1-5-80-(\d+-){4}\d+$' -or $installation.ownerSid -cnotmatch '^S-1-5-21-(\d+-){3}\d+$'){throw 'OSV_INSTALL_POLICY_INVALID'}
    if([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -cne $installation.controlSid -or (Get-Process -Id $PID).SessionId -ne 0){throw 'OSV_SERVICE_IDENTITY_DENIED'}
    # Publication directory must already exist with protected control/admin-only
    # write rights. Pin it and each ancestor, never create or repair ACLs here.
    $runtime=Join-Path (Get-OwnerInstanceRoot) 'runtime'
    for($path=$runtime;$path;$path=[IO.Path]::GetDirectoryName($path)){
      $pins.Add([RagentOwnerFilePin]::Directory($path))
      Assert-OwnerObjectAcl $path ($admin+@($installation.controlSid)) -Ancestor:($path -ne $runtime) -Pins $pins
    }
    $helperPath=Join-Path (Get-OwnerProductRoot) 'payload\Ragent.OwnerBootstrap.exe'
    $helper=Read-OwnerPinnedFile $helperPath $admin $pins 4194304
    try{if($releaseObject.protocolVersion -ne 2){throw 'protocol'};$trust=Get-OwnerReleaseTrust $releaseObject $helper $helperPath}catch{throw 'OSV_RELEASE_MISMATCH'}
    $info=[Diagnostics.ProcessStartInfo]::new()
    $info.FileName=$helperPath;$info.Arguments=if($ActivationListener){'facts'}else{'peer-facts'};$info.UseShellExecute=$false;$info.CreateNoWindow=$true
    $info.RedirectStandardInput=$true
    $info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true;$info.EnvironmentVariables.Clear()
    $windowsRoot=[Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)
    if(-not $windowsRoot -or -not [IO.Path]::IsPathRooted($windowsRoot)){throw 'OSV_WINDOWS_DIRECTORY_UNAVAILABLE'}
    $info.EnvironmentVariables['SystemRoot']=$windowsRoot;$info.EnvironmentVariables['WINDIR']=$windowsRoot;$info.EnvironmentVariables['SystemDrive']=[IO.Path]::GetPathRoot($windowsRoot).TrimEnd('\')
    $process=[Diagnostics.Process]::new();$process.StartInfo=$info
    try{
      [void]$process.Start()
      if(-not $ActivationListener){$peerFacts=@{pid=$OwnerPeerPid;createdTicks=$OwnerPeerCreatedTicks;ownerSid=$installation.ownerSid;ownerSessionId=$OwnerPeerSessionId;controlSid=$installation.controlSid}|ConvertTo-Json -Compress;$process.StandardInput.Write($peerFacts+[char]10)}
      $process.StandardInput.Close()
      if(-not $process.WaitForExit(5000)){try{$process.Kill()}catch{};throw 'OSV_HELPER_TIMEOUT'}
      $output=$process.StandardOutput.ReadToEnd();$null=$process.StandardError.ReadToEnd()
      if($process.ExitCode -ne 0 -or $output.Length -gt 8192){throw 'OSV_SERVICE_IDENTITY_DENIED'}
      $identity=$output|ConvertFrom-Json
      if($identity.kind -cne $(if($ActivationListener){'identity'}else{'peer-identity'})){throw 'OSV_SERVICE_IDENTITY_DENIED'}
    }finally{$process.Dispose()}
    if(-not ('RagentOwnerSessions' -as [type])){
      Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Security.Principal;
public static class RagentOwnerSessions {
 [StructLayout(LayoutKind.Sequential)] struct Session { public int id; public IntPtr name; public int state; }
 [DllImport("wtsapi32.dll",SetLastError=true)] static extern bool WTSEnumerateSessions(IntPtr server,int reserved,int version,out IntPtr sessions,out int count);
 [DllImport("wtsapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool WTSQuerySessionInformation(IntPtr server,int session,int kind,out IntPtr buffer,out int size);
 [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr memory);
 static string Query(int session,int kind) { IntPtr buffer;int size;
  if(!WTSQuerySessionInformation(IntPtr.Zero,session,kind,out buffer,out size))throw new InvalidOperationException("OSV_OWNER_SESSION_UNAVAILABLE");
  try{return Marshal.PtrToStringUni(buffer)??"";}finally{WTSFreeMemory(buffer);}
 }
 public static int Find(string ownerSid) { IntPtr memory;int count,found=0;
  if(!WTSEnumerateSessions(IntPtr.Zero,0,1,out memory,out count))throw new InvalidOperationException("OSV_OWNER_SESSION_UNAVAILABLE");
  try { if(count<0||count>256)throw new InvalidOperationException("OSV_OWNER_SESSION_UNAVAILABLE");
   int stride=Marshal.SizeOf(typeof(Session));
   for(int i=0;i<count;i++){var session=(Session)Marshal.PtrToStructure(IntPtr.Add(memory,i*stride),typeof(Session));
    if(session.id<=0||session.state!=0)continue;
    string name=Query(session.id,5),domain=Query(session.id,7);if(name.Length==0)continue;
    var sid=(SecurityIdentifier)new NTAccount(domain,name).Translate(typeof(SecurityIdentifier));
    if(sid.Value!=ownerSid)continue;
    if(found!=0)throw new InvalidOperationException("OSV_OWNER_SESSION_AMBIGUOUS");found=session.id;
   }
  }finally{WTSFreeMemory(memory);}
  if(found==0)throw new InvalidOperationException("OSV_OWNER_SESSION_UNAVAILABLE");return found;
 }
}
'@
    }
    # Authority is bound to the still-live native pipe Owner, re-queried by PID,
    # creation time/token/session with query-only rights. No cross-user WTS ACL.
    $observed=$trust+@{aclVerified=$true;
      releaseJson=$utf8.GetString($release);installationJson=$utf8.GetString($install);
      serviceFacts=$(if($ActivationListener){$identity.facts}else{$identity.serviceFacts});
      ownerSessionId=$(if($ActivationListener){0}else{$identity.facts.sessionId});observedAtUnixMs=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()}
    if(-not $ActivationListener){$observed.ownerPeer=$identity.facts}
    $observed|ConvertTo-Json -Compress -Depth 12
  }finally{for($index=$pins.Count-1;$index -ge 0;$index--){$pins[$index].Dispose()}}
}catch{
  $message=$_.Exception.GetBaseException().Message
  $code=if($message -cmatch '^(OBD|OSV)_[A-Z_]+$'){$message}else{'OSV_INSPECTION_FAILED'}
  @{ok=$false;code=$code}|ConvertTo-Json -Compress
}
