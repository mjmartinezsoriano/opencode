#!/usr/bin/env pwsh
# activate-new-binary.ps1 — Post-session-close binary swap
# Ejecutar DESPUES de cerrar la sesion CLI de opencode.
# Backup creado en opencode.exe.bak si quieres rollback.
#
# MEDIDO 2026-11-13: en v2 el artefacto se llama `cli-windows-x64` (no
# `opencode-windows-x64`): `const name = target.replace(binary, "cli")` en
# packages/cli/script/build.ts. El binario de dentro sigue siendo `opencode.exe`.

$ErrorActionPreference = "Stop"

$binDir = "$PSScriptRoot\..\packages\cli\dist\cli-windows-x64\bin"
Set-Location $binDir

Write-Host "=== Pre-check ==="
Write-Host "Working dir: $((Get-Location).Path)"
Get-ChildItem -Filter "*.exe" | Select-Object Name, Length, LastWriteTime | Format-Table -AutoSize

$new = Join-Path $binDir "opencode.new.exe"
$target = Join-Path $binDir "opencode.exe"
$bak = Join-Path $binDir "opencode.exe.bak"

if (-not (Test-Path $new)) {
  Write-Host "ERROR: opencode.new.exe no encontrado. Esperar build."
  exit 1
}

# Backup si no existe
if (-not (Test-Path $bak)) {
  Write-Host "Creando backup opencode.exe.bak..."
  Copy-Item $target $bak -Force
}

# Try remove + rename
try {
  Write-Host "Eliminando opencode.exe (locked = false; si falla, cerrar CLI primero)..."
  Remove-Item $target -Force -ErrorAction Stop
  Write-Host "Renombrando opencode.new.exe -> opencode.exe..."
  Rename-Item $new $target -Force
  Write-Host "=== SUCCESS ==="
  Write-Host "Nuevo binario activo. Verificar con:"
  Write-Host "  & '$target' --version"
} catch {
  Write-Host "ERROR: $($_.Exception.Message)"
  Write-Host ""
  Write-Host "Si el proceso opencode.exe esta corriendo, cierralo primero:"
  Write-Host "  Get-Process opencode | Stop-Process -Force"
  Write-Host "Y vuelve a ejecutar este script."
  exit 1
}

Write-Host ""
Write-Host "=== Verificacion post-rename ==="
Get-ChildItem -Filter "*.exe" | Select-Object Name, Length, LastWriteTime | Format-Table -AutoSize
