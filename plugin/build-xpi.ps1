# =============================================================================
#  Zotero Archiver —— build-xpi.ps1
#  把 addon/ 目录里的 manifest.json、bootstrap.js、zotero-archiver.js
#  打包为 zotero-archiver.xpi（文件位于 zip 根目录）。
# =============================================================================
$ErrorActionPreference = 'Stop'
$addonDir = Join-Path $PSScriptRoot 'addon'
$xpiPath  = Join-Path $PSScriptRoot 'zotero-archiver.xpi'

if (Test-Path $xpiPath) { Remove-Item -LiteralPath $xpiPath -Force }

Push-Location $addonDir
try {
    Compress-Archive -Path 'manifest.json', 'bootstrap.js', 'zotero-archiver.js', 'icon.svg', 'prefs.js', 'preferences.xhtml' `
        -DestinationPath $xpiPath -CompressionLevel Optimal -Force
} finally {
    Pop-Location
}

Write-Host "已生成：$xpiPath" -ForegroundColor Green
