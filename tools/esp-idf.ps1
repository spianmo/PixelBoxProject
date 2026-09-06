# Dot-source from PowerShell: . ./tools/esp-idf.ps1
param([string]$IdfPath = $env:IDF_PATH)

$ErrorActionPreference = 'Stop'
if (-not $IdfPath) { $IdfPath = [Environment]::GetEnvironmentVariable('IDF_PATH', 'User') }
if (-not $IdfPath) { throw 'Set IDF_PATH to the installed ESP-IDF directory.' }
$IdfPath = (Resolve-Path -LiteralPath $IdfPath).Path
if (-not (Test-Path -LiteralPath (Join-Path $IdfPath 'export.ps1'))) { throw 'ESP-IDF export.ps1 is missing.' }
if (-not $env:IDF_TOOLS_PATH) {
    $env:IDF_TOOLS_PATH = [Environment]::GetEnvironmentVariable('IDF_TOOLS_PATH', 'User')
}
if (-not $env:IDF_TOOLS_PATH) { $env:IDF_TOOLS_PATH = Join-Path $env:USERPROFILE '.espressif' }
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
if (-not $env:NO_PROXY) { $env:NO_PROXY = [Environment]::GetEnvironmentVariable('NO_PROXY', 'User') }
if (-not $env:IDF_COMPONENT_STORAGE_URL) { $env:IDF_COMPONENT_STORAGE_URL = 'https://components-file.espressif.cn' }
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
. (Join-Path $IdfPath 'export.ps1')
