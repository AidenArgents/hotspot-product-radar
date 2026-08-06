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
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if (-not $NoBrowser) {
  $config = Get-Content -LiteralPath $configFile -Raw -Encoding utf8 | ConvertFrom-Json
  Start-Process "http://localhost:$([int]$config.server_port)"
}
