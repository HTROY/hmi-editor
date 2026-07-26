# HMI I/O Backend Build Script
# =============================
# Builds WASM plugins and the Rust backend service.

param(
    [switch]$Release,
    [switch]$PluginsOnly,
    [switch]$BackendOnly
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PluginDir = Join-Path $ScriptDir "plugins-src"
$OutputDir = Join-Path $ScriptDir "plugins"
$Wasmtarget = "wasm32-unknown-unknown"

Write-Host "=== HMI I/O Backend Build ===" -ForegroundColor Cyan

# Ensure plugins output directory exists
if (-not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
}

$buildFlag = if ($Release) { "--release" } else { "" }

# Build WASM plugins
if (-not $BackendOnly) {
    Write-Host "`n[1/2] Building WASM plugins..." -ForegroundColor Yellow
    
    $plugins = @("modbus-tcp", "opc-ua", "iec104")
    foreach ($plugin in $plugins) {
        $pluginPath = Join-Path $PluginDir $plugin
        Write-Host "  Building $plugin..." -ForegroundColor Gray
        Push-Location $pluginPath
        try {
            cargo build --target $Wasmtarget $buildFlag 2>&1
            $profile = if ($Release) { "release" } else { "debug" }
            $wasmSrc = Join-Path $pluginPath "target" $Wasmtarget $profile "$plugin-plugin.wasm"
            $wasmDst = Join-Path $OutputDir "$plugin.wasm"
            if (Test-Path $wasmSrc) {
                Copy-Item $wasmSrc $wasmDst -Force
                Write-Host "    -> $wasmDst" -ForegroundColor Green
            }
        }
        finally {
            Pop-Location
        }
    }
}

# Build Rust backend
if (-not $PluginsOnly) {
    Write-Host "`n[2/2] Building Rust backend..." -ForegroundColor Yellow
    Push-Location $ScriptDir
    try {
        cargo build $buildFlag 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-Host "  Backend built successfully!" -ForegroundColor Green
            $exePath = if ($Release) { "target\release\hmi-io-backend.exe" } else { "target\debug\hmi-io-backend.exe" }
            Write-Host "  Binary: $(Join-Path $ScriptDir $exePath)" -ForegroundColor Gray
        }
    }
    finally {
        Pop-Location
    }
}

Write-Host "`n=== Build Complete ===" -ForegroundColor Cyan
Write-Host "Run: cd io-backend && cargo run" -ForegroundColor Gray
