# Builds everything into dist\: ClawdPet-Setup.exe and ClawdPet-portable.zip
#   powershell -ExecutionPolicy Bypass -File build.ps1
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
Set-Location $root
$env:PYTHONIOENCODING = 'utf-8'

function Step($name, [scriptblock]$body) {
    Write-Host "== $name" -ForegroundColor DarkGray
    & $body
    if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw "$name failed ($LASTEXITCODE)" }
}

Step 'npm install' { if (-not (Test-Path node_modules\electron)) { npm install | Out-Host } }
Step 'icons' { python tools\make_icon.py | Out-Host }
Step 'hook' { Push-Location hook; cargo build --release | Out-Host; Pop-Location }
Step 'app' { node tools\pack.mjs | Out-Host }
Step 'installer ui' { Copy-Item src\renderer\clawd.js installer\ui\clawd.js -Force }
Step 'installer' { Push-Location installer\src-tauri; cargo build --release | Out-Host; Pop-Location }
Step 'package' { python tools\package.py | Out-Host }
Write-Host "done: $root\dist" -ForegroundColor Green
