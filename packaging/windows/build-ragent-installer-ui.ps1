[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string]$OutputDirectory,
    [Parameter(Mandatory = $true)] [string]$BrandAssetDirectory
)

$ErrorActionPreference = 'Stop'
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
$BrandAssetDirectory = [IO.Path]::GetFullPath($BrandAssetDirectory)
$tempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
if (-not $OutputDirectory.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase) -or
    [IO.Path]::GetFileName($OutputDirectory) -notmatch '^installer-ui-[0-9a-f]{32}$') {
    throw 'Installer UI build outputs must use a unique installer-ui-* directory under the owned MSI staging path.'
}

$source = Join-Path $PSScriptRoot 'ragent-installer-embedded-ui.cpp'
$logo = Join-Path $BrandAssetDirectory 'ragent-android-logo.png'
$icon = Join-Path $BrandAssetDirectory 'ragent.ico'
if (-not (Test-Path -LiteralPath $source -PathType Leaf) -or -not (Test-Path -LiteralPath $logo -PathType Leaf) -or -not (Test-Path -LiteralPath $icon -PathType Leaf)) {
    throw 'The custom installer UI source and Android-matched Ragent logo are required.'
}
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$output = Join-Path $OutputDirectory 'Ragent.MsiEmbeddedUI.dll'
$minGW = @(
    (Get-Command g++.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1),
    'C:\mingw64-ucrt\bin\g++.exe',
    'C:\msys64\ucrt64\bin\g++.exe'
) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -First 1

if ($minGW) {
    $arguments = @(
        '-std=c++17', '-O2', '-shared', '-static-libgcc', '-static-libstdc++',
        $source, '-o', $output,
        '-Wl,-Bstatic', '-lwinpthread', '-Wl,-Bdynamic',
        '-lgdiplus', '-lole32', '-lshell32', '-lcomctl32', '-ldwmapi', '-lmsi', '-lshlwapi', '-luuid', '-luser32', '-lgdi32'
    )
    & $minGW @arguments
    if ($LASTEXITCODE -ne 0) { throw 'RAGENT_INSTALLER_UI_COMPILE_FAILED' }
    $threadRuntime = Join-Path (Split-Path -Parent $minGW) 'libwinpthread-1.dll'
    if (-not (Test-Path -LiteralPath $threadRuntime -PathType Leaf)) { throw 'RAGENT_INSTALLER_UI_RUNTIME_MISSING' }
    Copy-Item -LiteralPath $threadRuntime -Destination (Join-Path $OutputDirectory 'libwinpthread-1.dll') -Force
    $includeMingwRuntime = '1'
} else {
    $vsWhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    $vsInstall = if (Test-Path -LiteralPath $vsWhere -PathType Leaf) {
        & $vsWhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    } else { '' }
    $devCmd = if ($vsInstall) { Join-Path $vsInstall 'VC\Auxiliary\Build\vcvars64.bat' } else { '' }
    if (-not $devCmd -or -not (Test-Path -LiteralPath $devCmd -PathType Leaf)) {
        throw 'A x64 C++ compiler is required to build the embedded MSI interface.'
    }
    $quotedSource = '"' + $source + '"'
    $quotedOutput = '"' + $output + '"'
    $quotedObjectFile = '"' + (Join-Path $OutputDirectory 'Ragent.MsiEmbeddedUI.obj') + '"'
    $quotedImplib = '"' + (Join-Path $OutputDirectory 'Ragent.MsiEmbeddedUI.lib') + '"'
    $command = 'call "' + $devCmd + '" -no_logo >nul && cl.exe /nologo /std:c++17 /O2 /EHsc /MT /LD /Fo:' + $quotedObjectFile + ' ' +
        $quotedSource + ' /link /SUBSYSTEM:WINDOWS /OUT:' + $quotedOutput + ' /IMPLIB:' + $quotedImplib + ' gdiplus.lib ole32.lib shell32.lib comctl32.lib dwmapi.lib msi.lib shlwapi.lib user32.lib gdi32.lib'
    & $env:ComSpec /d /s /c $command
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $output -PathType Leaf)) { throw 'RAGENT_INSTALLER_UI_COMPILE_FAILED' }
    $includeMingwRuntime = '0'
}

Copy-Item -LiteralPath $logo -Destination (Join-Path $OutputDirectory 'ragent-android-logo.png') -Force
Copy-Item -LiteralPath $icon -Destination (Join-Path $OutputDirectory 'ragent.ico') -Force
@{
    includeMingwRuntime = $includeMingwRuntime -eq '1'
    uiBinary = $output
    resourceDirectory = $OutputDirectory
} | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'installer-ui-build.json') -Encoding UTF8
