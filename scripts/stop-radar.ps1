$ErrorActionPreference = "Stop"
$controlScript = Join-Path $PSScriptRoot "server-control.ps1"
& $controlScript stop
exit $LASTEXITCODE
