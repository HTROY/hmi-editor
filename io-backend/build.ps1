# HMI I/O Backend Build Script
# =============================
# Builds WASM plugins (Extism PDK) and the Rust backend service.

param(
    [switch]$Release,
    [switch]$PluginsOnly,
    [switch]$BackendOnly,
    [switch]$InstallExtismCli
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PluginDir = Join-Path $ScriptDir "plugins-src"
$OutputDir = Join-Path $ScriptDir "plugins"
$WasmTarget = "wasm32-wasip1"

Write-Host "=== HMI I/O Backend Build ===" -ForegroundColor Cyan

# Check for wasm target
$targets = rustup target list --installed 2>&1
if ($targets -notmatch "wasm32-wasip1") {
    Write-Host "Installing wasm32-wasip1 target..." -ForegroundColor Yellow
    rustup target add wasm32-wasip1
}

# Optional: install extism-cli for convenience
if ($InstallExtismCli) {
    Write-Host "Installing extism-cli..." -ForegroundColor Yellow
    cargo install extism-cli 2>&1
}

# Ensure plugins output directory exists
if (-not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
}

$buildFlag = if ($Release) { "--release" } else { "" }

# Build WASM plugins
if (-not $BackendOnly) {
    Write-Host "`n[1/2] Building WASM plugins (Extism PDK)..." -ForegroundColor Yellow

    $plugins = @("modbus-tcp", "opc-ua", "iec104")
    foreach ($plugin in $plugins) {
        $pluginPath = Join-Path $PluginDir $plugin
        Write-Host "  Building $plugin (target: $WasmTarget)..." -ForegroundColor Gray
        Push-Location $pluginPath
        try {
            # Build with cargo directly (extism-pdk uses standard wasm build)
            cargo build --target $WasmTarget $buildFlag 2>&1
            if ($LASTEXITCODE -ne 0) {
                Write-Host "    ERROR: Build failed for $plugin" -ForegroundColor Red
                continue
            }
            $profile = if ($Release) { "release" } else { "debug" }
            $wasmSrc = Join-Path $pluginPath "target" $WasmTarget $profile "$plugin-plugin.wasm"
            $wasmDst = Join-Path $OutputDir "$plugin.wasm"
            if (Test-Path $wasmSrc) {
                Copy-Item $wasmSrc $wasmDst -Force
                $size = (Get-Item $wasmDst).Length
                Write-Host "    -> $wasmDst ($([math]::Round($size/1KB, 1)) KB)" -ForegroundColor Green
            } else {
                Write-Host "    WARNING: $wasmSrc not found" -ForegroundColor Yellow
            }
        }
        finally {
            Pop-Location
        }
    }
}

# Build Rust backend
if (-not $PluginsOnly) {
    Write-Host "`n[2/2] Building Rust backend (Extism runtime)..." -ForegroundColor Yellow
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
