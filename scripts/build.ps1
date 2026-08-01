# HMI I/O Backend Build Script
# =============================
# Builds WASM plugins (wasip2 components) and the Rust backend service.

param(
    [switch]$Release,
    [switch]$PluginsOnly,
    [switch]$BackendOnly
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir
$BackendDir = Join-Path $RepoRoot "io-backend"
$PluginDir = Join-Path $BackendDir "plugins-src"
$OutputDir = Join-Path $BackendDir "plugins"
$WasmTarget = "wasm32-wasip2"

Write-Host "=== HMI I/O Backend Build ===" -ForegroundColor Cyan

# Check for wasm target.
# NOTE: do not merge stderr via 2>&1 on native commands here - under
# $ErrorActionPreference="Stop" PowerShell 5.1 converts redirected stderr
# lines into terminating NativeCommandError exceptions.
$targets = rustup target list --installed
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: 'rustup' failed - is the Rust toolchain installed?" -ForegroundColor Red
    exit 1
}
if (($targets -join "`n") -notmatch "wasm32-wasip2") {
    Write-Host "Installing wasm32-wasip2 target..." -ForegroundColor Yellow
    rustup target add wasm32-wasip2
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: could not install wasm32-wasip2 target" -ForegroundColor Red
        exit 1
    }
}

# Ensure plugins output directory exists
if (-not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
}

$pluginArgs = @("--target", $WasmTarget)
if ($Release) { $pluginArgs += "--release" }
$backendArgs = @()
if ($Release) { $backendArgs += "--release" }

# Build WASM plugins
if (-not $BackendOnly) {
    Write-Host "`n[1/2] Building WASM plugins (wasip2 components)..." -ForegroundColor Yellow

    $plugins = @("modbus-tcp", "opc-ua", "iec104")
    foreach ($plugin in $plugins) {
        $pluginPath = Join-Path $PluginDir $plugin
        Write-Host "  Building $plugin (target: $WasmTarget)..." -ForegroundColor Gray
        Push-Location $pluginPath
        try {
            cargo build @pluginArgs
            if ($LASTEXITCODE -ne 0) {
                Write-Host "    ERROR: Build failed for $plugin" -ForegroundColor Red
                continue
            }
            $profile = if ($Release) { "release" } else { "debug" }
            $crateName = $plugin.Replace("-", "_")
            $wasmSrc = Join-Path $pluginPath ("target\{0}\{1}\{2}_plugin.wasm" -f $WasmTarget, $profile, $crateName)
            $wasmDst = Join-Path $OutputDir "${crateName}.wasm"
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
    Write-Host "`n[2/2] Building Rust backend (wasmtime runtime)..." -ForegroundColor Yellow
    Push-Location $BackendDir
    try {
        cargo build @backendArgs
        if ($LASTEXITCODE -ne 0) {
            Write-Host "ERROR: Backend build failed" -ForegroundColor Red
            exit 1
        }
        Write-Host "  Backend built successfully!" -ForegroundColor Green
        $exePath = if ($Release) { "target\release\hmi-io-backend.exe" } else { "target\debug\hmi-io-backend.exe" }
        Write-Host "  Binary: $(Join-Path $BackendDir $exePath)" -ForegroundColor Gray
    }
    finally {
        Pop-Location
    }
}

Write-Host "`n=== Build Complete ===" -ForegroundColor Cyan
Write-Host "Run: cd io-backend && cargo run -- config.yaml" -ForegroundColor Gray
