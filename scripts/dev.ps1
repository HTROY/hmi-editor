# HMI Editor Dev Script
# =====================
# Starts the frontend (Vite dev server) and the backend (Rust I/O service)
# in two separate terminal windows.

param(
    [switch]$SkipFrontend,
    [switch]$SkipBackend
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir
$BackendDir = Join-Path $RepoRoot "io-backend"

Write-Host "=== HMI Editor Dev Environment ===" -ForegroundColor Cyan

if (-not $SkipFrontend) {
    if (-not (Test-Path (Join-Path $RepoRoot "node_modules"))) {
        Write-Host "WARNING: node_modules not found - run 'npm install' first" -ForegroundColor Yellow
    }
    Write-Host "Starting frontend (Vite dev server)..." -ForegroundColor Gray -NoNewline
    $cmd = "Set-Location -LiteralPath '$RepoRoot'; `$host.UI.RawUI.WindowTitle = 'HMI Editor - Frontend (Vite)'; npm run dev"
    Start-Process powershell -ArgumentList "-NoExit", "-Command", ('"' + $cmd + '"') -WorkingDirectory $RepoRoot
    Write-Host " OK" -ForegroundColor Green
}

if (-not $SkipBackend) {
    if (-not (Test-Path (Join-Path $BackendDir "plugins\modbus_tcp.wasm"))) {
        Write-Host "WARNING: WASM plugins missing - run '.\scripts\build.ps1 -PluginsOnly' first" -ForegroundColor Yellow
    }
    Write-Host "Starting backend (cargo run)..." -ForegroundColor Gray -NoNewline
    $cmd = "Set-Location -LiteralPath '$BackendDir'; `$host.UI.RawUI.WindowTitle = 'HMI Editor - Backend (Rust)'; cargo run -- config.yaml"
    Start-Process powershell -ArgumentList "-NoExit", "-Command", ('"' + $cmd + '"') -WorkingDirectory $BackendDir
    Write-Host " OK" -ForegroundColor Green
}

Write-Host ""
Write-Host "Frontend:  http://localhost:5173" -ForegroundColor Cyan
Write-Host "Backend:   WS ws://localhost:8080/iscs/data | Web UI/API http://localhost:8081" -ForegroundColor Cyan
Write-Host "Press Enter to close this window (dev processes keep running)." -ForegroundColor Gray
if (-not [Console]::IsInputRedirected) {
    Read-Host | Out-Null
}
