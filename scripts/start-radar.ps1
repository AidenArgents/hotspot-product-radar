param(
  [switch]$NoBrowser,
  [switch]$Restart
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$configFile = Join-Path $projectRoot "config\radar_config.local.json"
$controlScript = Join-Path $PSScriptRoot "server-control.ps1"
$portableNodeDirectory = Join-Path $projectRoot ".runtime\node"

if (Test-Path -LiteralPath (Join-Path $portableNodeDirectory "node.exe")) {
  $env:PATH = "$portableNodeDirectory;$env:PATH"
}

$action = if ($Restart) { "restart" } else { "start" }
& $controlScript $action
if (-not $?) { exit 1 }

if (-not $NoBrowser) {
  $config = Get-Content -LiteralPath $configFile -Raw -Encoding utf8 | ConvertFrom-Json
  $dashboardUrl = "http://localhost:$([int]$config.server_port)"
  $browserLauncher = Start-Process `
    -FilePath $env:ComSpec `
    -ArgumentList @("/d", "/c", "start", '""', "`"$dashboardUrl`"") `
    -WindowStyle Hidden `
    -Wait `
    -PassThru
  if ($browserLauncher.ExitCode -ne 0) {
    throw "Could not open the dashboard in the default browser: $dashboardUrl"
  }
  Write-Host "[OK] Browser opened at $dashboardUrl."
}
