# Build-only staging. Normal packages use administrative-install manifest v2.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$SourceRoot,
      [Parameter(Mandatory=$true)][string]$PayloadRoot,
      [string]$SignedHelperPath='', [string]$PublisherSha256='', [switch]$DevelopmentOnly)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'read-owner-bootstrap-discovery.ps1') -LibraryOnly
$qaPayload=[IO.Path]::GetFullPath($PayloadRoot)
if(-not(Test-Path -LiteralPath $qaPayload -PathType Container)){throw 'Owner helper payload directory required'}
$qaTarget=Join-Path $qaPayload 'Ragent.OwnerBootstrap.exe'
$qaRelease=Join-Path $qaPayload 'owner-bootstrap-release.json'
if((Test-Path -LiteralPath $qaTarget) -or (Test-Path -LiteralPath $qaRelease)){throw 'Owner helper staging collision; refusing adoption'}
if(($SignedHelperPath -eq '') -ne ($PublisherSha256 -eq '') -or ($PublisherSha256 -and $PublisherSha256 -cnotmatch '^[a-f0-9]{64}$')){throw 'Pinned publisher and signed helper must be provided together'}
$qaSucceeded=$false
try{
  if($SignedHelperPath){
    $qaInput=[IO.FileStream]::new([IO.Path]::GetFullPath($SignedHelperPath),[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try{[RagentOwnerFilePin]::Verify($qaInput.SafeFileHandle,[IO.Path]::GetFullPath($SignedHelperPath),$false);Copy-Item -LiteralPath $SignedHelperPath -Destination $qaTarget}finally{$qaInput.Dispose()}
  }else{
    $qaSource=Join-Path $SourceRoot 'native\windows-owner-bootstrap.cs'
    if($qaTarget.IndexOfAny([char[]]@('"',"`r","`n")) -ge 0 -or $qaSource.IndexOfAny([char[]]@('"',"`r","`n")) -ge 0){throw 'Invalid compiler path'}
    $qaCompilerInfo=[Diagnostics.ProcessStartInfo]::new()
    $qaWindowsRoot=[Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)
    if(-not $qaWindowsRoot -or -not [IO.Path]::IsPathRooted($qaWindowsRoot)){throw 'Owner helper Windows directory unavailable'}
    $qaCompilerInfo.FileName=Join-Path $qaWindowsRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    $qaCompilerInfo.Arguments='/nologo /utf8output /target:exe /platform:x64 /r:System.Web.Extensions.dll /out:"'+$qaTarget+'" "'+$qaSource+'"'
    $qaCompilerInfo.UseShellExecute=$false;$qaCompilerInfo.CreateNoWindow=$true
    $qaCompilerInfo.RedirectStandardOutput=$true;$qaCompilerInfo.RedirectStandardError=$true
    $qaCompiler=[Diagnostics.Process]::Start($qaCompilerInfo)
    try{
      $qaOut=$qaCompiler.StandardOutput.ReadToEndAsync();$qaErr=$qaCompiler.StandardError.ReadToEndAsync()
      if(-not $qaCompiler.WaitForExit(30000)){try{$qaCompiler.Kill()}catch{};throw 'Owner helper compilation timeout'}
      if($qaCompiler.ExitCode -ne 0){throw ('Owner helper compilation failed (exit '+$qaCompiler.ExitCode+'): '+$qaOut.Result+$qaErr.Result)}
    }finally{$qaCompiler.Dispose()}
  }
  $qaDigest=(Get-FileHash -LiteralPath $qaTarget -Algorithm SHA256).Hash.ToLowerInvariant()
  if($SignedHelperPath){
    $qaSigner=Get-OwnerSigner $qaTarget
    if($qaSigner.status -cne 'Valid' -or $qaSigner.publisherSha256 -cne $PublisherSha256){throw 'Owner helper Authenticode/publisher verification failed'}
    $qaMetadata=[ordered]@{version=1;protocolVersion=2;helperFile='Ragent.OwnerBootstrap.exe';helperSha256=$qaDigest;publisherSha256=$PublisherSha256}
    [IO.File]::WriteAllText($qaRelease,($qaMetadata|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
  }elseif(-not $DevelopmentOnly){
    $qaMetadata=[ordered]@{version=2;protocolVersion=2;helperFile='Ragent.OwnerBootstrap.exe';helperSha256=$qaDigest;trustMode='admin-installed-sha256'}
    [IO.File]::WriteAllText($qaRelease,($qaMetadata|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
  }
  $qaSucceeded=$true
  [pscustomobject]@{pass=$true;helperSha256=$qaDigest;signed=($SignedHelperPath -ne '');trustManifestWritten=(Test-Path -LiteralPath $qaRelease)}|ConvertTo-Json -Compress
}finally{if(-not $qaSucceeded){foreach($qaFile in @($qaTarget,$qaRelease)){if(Test-Path -LiteralPath $qaFile){Remove-Item -LiteralPath $qaFile -Force}}}}
