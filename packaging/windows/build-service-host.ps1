[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string]$OutputPath,
    [string]$SourcePath = '',
    [string]$RuntimePayloadRoot = '',
    [switch]$DevelopmentOnly
)

$ErrorActionPreference = 'Stop'
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
if($DevelopmentOnly -and $RuntimePayloadRoot){throw 'SHB_BUILD_MODE_CONFLICT'}
if(-not $RuntimePayloadRoot -and -not $DevelopmentOnly){throw 'SHB_RUNTIME_PAYLOAD_REQUIRED'}
if (-not $SourcePath) { $SourcePath = if($RuntimePayloadRoot){Join-Path $RuntimePayloadRoot 'packaging\windows\Ragent.ServiceHost.cs'}else{Join-Path $scriptRoot 'Ragent.ServiceHost.cs'} }
$cscCandidates = @(
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\2022\BuildTools\MSBuild\Current\Bin\Roslyn\csc.exe')
)
$csc = $cscCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $csc) { throw 'A .NET Framework C# compiler (csc.exe) is required to build Ragent.ServiceHost.exe.' }
$pins=[Collections.Generic.List[IDisposable]]::new();$metadataPath=$null;$metadataOwned=$false
try {
 $arguments=@('/nologo','/target:exe',('/out:'+[IO.Path]::GetFullPath($OutputPath)),'/reference:System.ServiceProcess.dll','/reference:System.dll','/reference:System.Core.dll','/reference:System.Security.dll')
 $expectedInfo=$null
 if($RuntimePayloadRoot){
  if(-not ('RagentServiceBuildPin' -as [type])){Add-Type -TypeDefinition @'
using System;using System.IO;using System.Text;using System.Runtime.InteropServices;using Microsoft.Win32.SafeHandles;
public static class RagentServiceBuildPin {
 [StructLayout(LayoutKind.Sequential)]struct Info{public uint attributes;public System.Runtime.InteropServices.ComTypes.FILETIME created,accessed,written;public uint volume,sizeHigh,sizeLow,links,indexHigh,indexLow;}
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern SafeFileHandle CreateFile(string p,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool GetFileInformationByHandle(SafeFileHandle h,out Info i);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern uint GetFinalPathNameByHandle(SafeFileHandle h,StringBuilder p,uint size,uint flags);
 public static void Verify(SafeFileHandle h,string path,bool directory){Info i;var p=new StringBuilder(32768);uint n=GetFinalPathNameByHandle(h,p,(uint)p.Capacity,0);if(h.IsInvalid||!GetFileInformationByHandle(h,out i)||(i.attributes&0x400)!=0||((i.attributes&16)!=0)!=directory||(!directory&&i.links!=1)||n==0||n>=p.Capacity||!String.Equals(p.ToString(),@"\\?\"+Path.GetFullPath(path),StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("SHB_INPUT_IDENTITY_REFUSED");}
 public static SafeFileHandle Directory(string path){var h=CreateFile(path,0x81,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero);try{Verify(h,path,true);return h;}catch{h.Dispose();throw;}}
}
'@}
  function Read-BuildInput([string]$Path,[int]$Maximum=4194304){
   for($parent=[IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Path));$parent;$parent=[IO.Path]::GetDirectoryName($parent)){$pins.Add([RagentServiceBuildPin]::Directory($parent))}
   $file=[IO.FileStream]::new($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);$pins.Add($file);[RagentServiceBuildPin]::Verify($file.SafeFileHandle,$Path,$false)
   if($file.Length -lt 1 -or $file.Length -gt $Maximum){throw 'SHB_INPUT_SIZE_REFUSED'}
   $bytes=[byte[]]::new([int]$file.Length);$offset=0;while($offset -lt $bytes.Length){$n=$file.Read($bytes,$offset,$bytes.Length-$offset);if($n -le 0){throw 'SHB_INPUT_TRUNCATED'};$offset+=$n}
   $hash=[Security.Cryptography.SHA256]::Create();try{$digest=([BitConverter]::ToString($hash.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()}finally{$hash.Dispose()}
   return @{bytes=$bytes;sha256=$digest}
  }
  $root=[IO.Path]::GetFullPath($RuntimePayloadRoot).TrimEnd('\')
  $SourcePath=[IO.Path]::GetFullPath($SourcePath)
  if(-not [string]::Equals($SourcePath,(Join-Path $root 'packaging\windows\Ragent.ServiceHost.cs'),[StringComparison]::OrdinalIgnoreCase)){throw 'SHB_SOURCE_PATH_MISMATCH'}
  $manifestInput=Read-BuildInput (Join-Path $root 'runtime-payload-manifest.json') 16777216
  try{$manifest=[Text.UTF8Encoding]::new($false,$true).GetString($manifestInput.bytes)|ConvertFrom-Json}catch{throw 'SHB_RUNTIME_METADATA_INVALID'}
  $stampInput=Read-BuildInput (Join-Path $root '.ragent-source-commit') 256
  $stamp=[Text.UTF8Encoding]::new($false,$true).GetString($stampInput.bytes).Trim()
  $allowlistInput=Read-BuildInput (Join-Path $root 'packaging\runtime-payload.json')
  # Windows PowerShell 5.1 parses JSON integers as Int32; PowerShell 7 parses
  # them as Int64. Accept either integer representation, never strings/floats.
  if(($manifest.schemaVersion -isnot [int] -and $manifest.schemaVersion -isnot [long]) -or $manifest.schemaVersion -ne 1 -or $manifest.profile -cne 'desktop' -or $manifest.sourceRevision -isnot [string] -or $manifest.sourceRevision -cnotmatch '\A(?:[a-f0-9]{40}|[a-f0-9]{64})\z' -or $manifest.sourceRevision -cne $stamp -or $manifest.allowlistSha256 -cne $allowlistInput.sha256){throw 'SHB_RUNTIME_METADATA_INVALID'}
  $inputs=@{}
  foreach($relative in @('packaging/windows/Ragent.ServiceHost.cs','lib/instance-runtime.mjs','lib/instance-ownership.mjs')){
   $rows=@($manifest.files|Where-Object {$_.path -ieq $relative});if($rows.Count -ne 1 -or $rows[0].path -cne $relative){throw 'SHB_RUNTIME_ENTRY_REQUIRED'}
   $sourceInput=Read-BuildInput (Join-Path $root $relative)
   if($rows[0].sha256 -cne $sourceInput.sha256 -or ($rows[0].bytes -isnot [int] -and $rows[0].bytes -isnot [long]) -or $rows[0].bytes -ne $sourceInput.bytes.Length){throw 'SHB_RUNTIME_ENTRY_MISMATCH'}
   $inputs[$relative]=$sourceInput
  }
  $js=[Text.UTF8Encoding]::new($false,$true).GetString($inputs['lib/instance-runtime.mjs'].bytes)
  if([regex]::Matches($js,'(?m)^export const WINDOWS_SERVICE_OWNERSHIP_PROTOCOL_VERSION = 1;\r?$').Count -ne 1){throw 'SHB_OWNERSHIP_PROTOCOL_UNSUPPORTED'}
  $metadata=[ordered]@{schemaVersion=1;purpose='windows-service-host-build';sourceCommit=$stamp;ownershipProtocolVersion=1;sourceManifestSha256=$manifestInput.sha256;allowlistSha256=$allowlistInput.sha256;serviceHostSourceSha256=$inputs['packaging/windows/Ragent.ServiceHost.cs'].sha256;instanceRuntimeSha256=$inputs['lib/instance-runtime.mjs'].sha256;instanceOwnershipSha256=$inputs['lib/instance-ownership.mjs'].sha256}
  $expectedInfo=$metadata|ConvertTo-Json -Compress
  Write-Verbose 'SHB runtime source inputs validated'
 }
 $outputDirectory=[IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($OutputPath));$null=New-Item -ItemType Directory -Force -Path $outputDirectory
 if($RuntimePayloadRoot){
  for($parent=$outputDirectory;$parent;$parent=[IO.Path]::GetDirectoryName($parent)){$pins.Add([RagentServiceBuildPin]::Directory($parent))}
  $metadataPath=Join-Path $outputDirectory ('service-host-build-'+[guid]::NewGuid().ToString('N')+'.json')
  $bytes=[Text.UTF8Encoding]::new($false).GetBytes($expectedInfo)
  $writer=[IO.FileStream]::new($metadataPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read);$metadataOwned=$true
  try{$writer.Write($bytes,0,$bytes.Length);$writer.Flush($true)}finally{$writer.Dispose()}
  $resourceInput=Read-BuildInput $metadataPath 8192
  if([Text.UTF8Encoding]::new($false,$true).GetString($resourceInput.bytes) -cne $expectedInfo){throw 'SHB_RESOURCE_CHANGED'}
  $arguments+=('/resource:'+$metadataPath+',Ragent.ServiceHost.Build.json')
 }
 $arguments+=$SourcePath
 Write-Verbose 'SHB compiler starting'
 & $csc @arguments
 if($LASTEXITCODE -ne 0){throw 'SHB_COMPILE_FAILED'}
 if($RuntimePayloadRoot){
  Write-Verbose 'SHB compiled resource query starting'
  $actual=(& ([IO.Path]::GetFullPath($OutputPath)) --build-info|Out-String).Trim()
  if($LASTEXITCODE -ne 0 -or $actual -cne $expectedInfo){throw 'SHB_BUILD_INFO_MISMATCH'}
 }
}finally{
 for($i=$pins.Count-1;$i -ge 0;$i--){$pins[$i].Dispose()}
 if($metadataOwned -and $metadataPath){[IO.File]::Delete($metadataPath)}
}
