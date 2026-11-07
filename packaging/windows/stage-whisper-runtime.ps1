[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string]$OutputDirectory,
    [Parameter(Mandatory = $true)] [string]$CacheDirectory
)

$ErrorActionPreference = 'Stop'
$whisperArchiveUrl = 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip'
$whisperArchiveSha256 = '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb'
$modelUrl = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/f281eb45af861ab5e5297d23694b7d46e090c02c/ggml-base-q5_1.bin?download=true'
$modelSha256 = '422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898'

function Get-Sha256([string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-VerifiedDownload([string]$Url, [string]$Path, [string]$ExpectedHash) {
    if ((Test-Path -LiteralPath $Path -PathType Leaf) -and (Get-Sha256 $Path) -ceq $ExpectedHash) { return }
    Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Path -Headers @{ 'User-Agent' = 'Ragent-Windows-Setup' }
    if ((Get-Sha256 $Path) -cne $ExpectedHash) {
        Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
        throw 'WHISPER_DEPENDENCY_CHECKSUM_MISMATCH'
    }
}

New-Item -ItemType Directory -Force -Path $OutputDirectory, $CacheDirectory | Out-Null
$outputPath = [IO.Path]::GetFullPath($OutputDirectory).TrimEnd('\')
$cachePath = [IO.Path]::GetFullPath($CacheDirectory).TrimEnd('\')
if ($outputPath -eq $cachePath -or $outputPath.StartsWith($cachePath + '\', [StringComparison]::OrdinalIgnoreCase) -or
    $cachePath.StartsWith($outputPath + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'WHISPER_STAGING_PATHS_MUST_BE_SEPARATE'
}

$archivePath = Join-Path $CacheDirectory 'whisper-bin-x64-b5454.zip'
$modelPath = Join-Path $CacheDirectory 'ggml-base-q5_1-f281eb45.bin'
Get-VerifiedDownload $whisperArchiveUrl $archivePath $whisperArchiveSha256
Get-VerifiedDownload $modelUrl $modelPath $modelSha256

Get-ChildItem -LiteralPath $OutputDirectory -Force | Remove-Item -Recurse -Force
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($archivePath)
try {
    $required = @('whisper-server.exe', 'ggml.dll', 'ggml-base.dll', 'whisper.dll')
    $selected = @($archive.Entries | Where-Object {
        $_.FullName -match '^Release/(?:whisper-server\.exe|whisper\.dll|ggml\.dll|ggml-base\.dll|ggml-cpu-[A-Za-z0-9-]+\.dll)$'
    })
    foreach ($name in $required) {
        if (-not ($selected | Where-Object { $_.FullName -ceq "Release/$name" })) {
            throw "WHISPER_RUNTIME_FILE_MISSING: $name"
        }
    }
    foreach ($entry in $selected) {
        if ($entry.Length -le 0 -or $entry.Length -gt 512MB) { throw 'WHISPER_RUNTIME_FILE_SIZE_REFUSED' }
        $leaf = [IO.Path]::GetFileName($entry.FullName)
        $destination = Join-Path $OutputDirectory $leaf
        $stream = $entry.Open()
        try {
            $output = [IO.File]::Create($destination)
            try { $stream.CopyTo($output) } finally { $output.Dispose() }
        } finally { $stream.Dispose() }
    }
} finally { $archive.Dispose() }

Copy-Item -LiteralPath $modelPath -Destination (Join-Path $OutputDirectory 'ggml-base-q5_1.bin')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'licenses\whisper.cpp-MIT.txt') -Destination (Join-Path $OutputDirectory 'whisper.cpp-MIT.txt')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'licenses\OpenAI-Whisper-MIT.txt') -Destination (Join-Path $OutputDirectory 'OpenAI-Whisper-MIT.txt')
$runtimeFiles = @(Get-ChildItem -LiteralPath $OutputDirectory -File -Force | Sort-Object Name | ForEach-Object {
    [ordered]@{ name = $_.Name; size = $_.Length; sha256 = (Get-Sha256 $_.FullName) }
})
$manifest = [ordered]@{
    schemaVersion = 1
    whisperCppRelease = 'b5454 (v1.9.5)'
    modelRepository = 'ggerganov/whisper.cpp'
    modelRevision = 'f281eb45af861ab5e5297d23694b7d46e090c02c'
    files = $runtimeFiles
} | ConvertTo-Json -Depth 5
[IO.File]::WriteAllText((Join-Path $OutputDirectory 'runtime-manifest.json'), "$manifest`n", [Text.UTF8Encoding]::new($false))
