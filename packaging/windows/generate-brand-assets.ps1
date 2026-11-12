[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string]$SourceRoot,
    [Parameter(Mandatory = $true)] [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
$SourceRoot = [IO.Path]::GetFullPath($SourceRoot)
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
$tempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
if (-not $OutputDirectory.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase) -or
    [IO.Path]::GetFileName($OutputDirectory) -notmatch '^brand-[0-9a-f]{32}$') {
    throw 'Brand assets must be generated inside an owned brand-* MSI staging directory.'
}

$androidLogo = Join-Path $SourceRoot 'android\app\src\main\res\drawable-nodpi\adaptive_foreground_png.png'
$webLogo = Join-Path $SourceRoot 'static\desktop\agentoc-android-logo.png'
if (-not (Test-Path -LiteralPath $androidLogo -PathType Leaf) -or -not (Test-Path -LiteralPath $webLogo -PathType Leaf)) {
    throw 'The Android launcher foreground and its desktop web asset are required.'
}
$sourceHash = (Get-FileHash -LiteralPath $androidLogo -Algorithm SHA256).Hash
$webHash = (Get-FileHash -LiteralPath $webLogo -Algorithm SHA256).Hash
if ($sourceHash -ne $webHash) { throw 'Desktop logo differs from the Android launcher foreground asset.' }

Add-Type -AssemblyName System.Drawing
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$logo = [System.Drawing.Bitmap]::FromFile($androidLogo)
try {
    Copy-Item -LiteralPath $androidLogo -Destination (Join-Path $OutputDirectory 'agentoc-android-logo.png') -Force

    $sizes = @(16, 24, 32, 48, 64, 128, 256)
    $frames = [System.Collections.Generic.List[byte[]]]::new()
    foreach ($size in $sizes) {
        $bitmap = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $memory = [IO.MemoryStream]::new()
        try {
            $graphics.Clear([System.Drawing.Color]::Transparent)
            $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
            $graphics.DrawImage($logo, [System.Drawing.Rectangle]::new(0, 0, $size, $size))
            $bitmap.Save($memory, [System.Drawing.Imaging.ImageFormat]::Png)
            $frames.Add($memory.ToArray())
        } finally {
            $memory.Dispose()
            $graphics.Dispose()
            $bitmap.Dispose()
        }
    }

    $iconPath = Join-Path $OutputDirectory 'agentoc.ico'
    $stream = [IO.File]::Create($iconPath)
    $writer = [IO.BinaryWriter]::new($stream)
    try {
        $writer.Write([UInt16]0)
        $writer.Write([UInt16]1)
        $writer.Write([UInt16]$sizes.Count)
        $offset = 6 + (16 * $sizes.Count)
        for ($i = 0; $i -lt $sizes.Count; $i++) {
            $size = $sizes[$i]
            $frame = $frames[$i]
            $writer.Write([byte]$(if ($size -eq 256) { 0 } else { $size }))
            $writer.Write([byte]$(if ($size -eq 256) { 0 } else { $size }))
            $writer.Write([byte]0)
            $writer.Write([byte]0)
            $writer.Write([UInt16]1)
            $writer.Write([UInt16]32)
            $writer.Write([UInt32]$frame.Length)
            $writer.Write([UInt32]$offset)
            $offset += $frame.Length
        }
        foreach ($frame in $frames) { $writer.Write($frame) }
    } finally {
        $writer.Dispose()
        $stream.Dispose()
    }

    $banner = [System.Drawing.Bitmap]::new(493, 58, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $bannerGraphics = [System.Drawing.Graphics]::FromImage($banner)
    try {
        $bannerGraphics.Clear([System.Drawing.Color]::White)
        $bannerGraphics.DrawImage($logo, 8, 8, 42, 42)
        $brandFont = [System.Drawing.Font]::new('Segoe UI Semibold', 14, [System.Drawing.FontStyle]::Regular)
        $subtitleFont = [System.Drawing.Font]::new('Segoe UI', 9, [System.Drawing.FontStyle]::Regular)
        $bannerGraphics.DrawString('Ragent', $brandFont, [System.Drawing.Brushes]::Black, 62, 7)
        $bannerGraphics.DrawString('Desktop manager', $subtitleFont, [System.Drawing.Brushes]::DimGray, 63, 31)
        $banner.Save((Join-Path $OutputDirectory 'wix-banner.bmp'), [System.Drawing.Imaging.ImageFormat]::Bmp)
    } finally {
        $brandFont.Dispose()
        $subtitleFont.Dispose()
        $bannerGraphics.Dispose()
        $banner.Dispose()
    }

    $dialog = [System.Drawing.Bitmap]::new(493, 312, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $dialogGraphics = [System.Drawing.Graphics]::FromImage($dialog)
    try {
        $dialogGraphics.Clear([System.Drawing.Color]::White)
        $dialogGraphics.DrawImage($logo, 172, 34, 148, 148)
        $titleFont = [System.Drawing.Font]::new('Segoe UI Semibold', 25, [System.Drawing.FontStyle]::Regular)
        $copyFont = [System.Drawing.Font]::new('Segoe UI', 11, [System.Drawing.FontStyle]::Regular)
        $center = [System.Drawing.StringFormat]::new()
        $center.Alignment = [System.Drawing.StringAlignment]::Center
        $dialogGraphics.DrawString('Ragent', $titleFont, [System.Drawing.Brushes]::Black, [System.Drawing.RectangleF]::new(0, 196, 493, 40), $center)
        $dialogGraphics.DrawString('Manage your local AI workbench', $copyFont, [System.Drawing.Brushes]::DimGray, [System.Drawing.RectangleF]::new(0, 238, 493, 28), $center)
        $dialog.Save((Join-Path $OutputDirectory 'wix-dialog.bmp'), [System.Drawing.Imaging.ImageFormat]::Bmp)
    } finally {
        $center.Dispose()
        $titleFont.Dispose()
        $copyFont.Dispose()
        $dialogGraphics.Dispose()
        $dialog.Dispose()
    }
} finally {
    $logo.Dispose()
}
