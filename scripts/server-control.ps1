param(
  [Parameter(Position = 0)]
  [ValidateSet("start", "stop", "restart", "status")]
  [string]$Action = "status"
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$configFile = Join-Path $projectRoot "config\radar_config.local.json"
$dataDir = Join-Path $projectRoot "data"
$pidFile = Join-Path $dataDir "server.pid"
$stdoutLog = Join-Path $dataDir "server.log"
$stderrLog = Join-Path $dataDir "server.error.log"
$portableNodeDirectory = Join-Path $projectRoot ".runtime\node"

if (Test-Path -LiteralPath (Join-Path $portableNodeDirectory "node.exe")) {
  $env:PATH = "$portableNodeDirectory;$env:PATH"
}

if (-not (Test-Path -LiteralPath $configFile -PathType Leaf)) {
  throw "Configuration is missing: config\radar_config.local.json. Run setup.bat first."
}

try {
  $runtimeConfig = Get-Content -LiteralPath $configFile -Raw -Encoding utf8 | ConvertFrom-Json
  $port = [int]$runtimeConfig.server_port
}
catch {
  throw "Cannot read server_port from config\radar_config.local.json: $($_.Exception.Message)"
}
if ($port -lt 1 -or $port -gt 65535) {
  throw "server_port must be between 1 and 65535."
}
$localUrl = "http://127.0.0.1:$port"

function Remove-StalePidFile {
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
}

function Test-IsRadarProcess {
  param($Process)

  if (-not $Process -or [string]::IsNullOrWhiteSpace([string]$Process.CommandLine)) {
    return $false
  }
  $commandLine = [string]$Process.CommandLine
  return (
    $commandLine.IndexOf($projectRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
    $commandLine.IndexOf("server.ts", [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
    $Process.Name -ieq "node.exe"
  )
}

function Get-ProcessById {
  param([int]$ProcessId)
  return Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
}

function Get-ProjectTreeRoot {
  param($Process)

  $current = $Process
  while ($current -and $current.ParentProcessId) {
    $parent = Get-ProcessById -ProcessId ([int]$current.ParentProcessId)
    if (-not (Test-IsRadarProcess $parent)) { break }
    $current = $parent
  }
  return $current
}

function Get-ManagedProcess {
  if (-not (Test-Path -LiteralPath $pidFile -PathType Leaf)) { return $null }
  $rawPid = (Get-Content -LiteralPath $pidFile -Raw).Trim()
  $managedPid = 0
  if (-not [int]::TryParse($rawPid, [ref]$managedPid)) {
    Write-Warning "Invalid radar PID file; removing it."
    Remove-StalePidFile
    return $null
  }
  $process = Get-ProcessById -ProcessId $managedPid
  if (-not $process) {
    Remove-StalePidFile
    return $null
  }
  if (-not (Test-IsRadarProcess $process)) {
    Write-Warning "PID $managedPid belongs to another program; it will not be stopped."
    Remove-StalePidFile
    return $null
  }
  return $process
}

function Get-PortOwner {
  return Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue |
    Select-Object -First 1
}

function Test-RadarHealth {
  try {
    $health = Invoke-RestMethod -Uri "$localUrl/api/health" -TimeoutSec 2
    return [bool]$health.ok
  }
  catch {
    return $false
  }
}

function Find-RunningRadar {
  $managed = Get-ManagedProcess
  if ($managed) { return (Get-ProjectTreeRoot $managed) }

  $owner = Get-PortOwner
  if (-not $owner) { return $null }
  $ownerProcess = Get-ProcessById -ProcessId ([int]$owner.OwningProcess)
  if (Test-IsRadarProcess $ownerProcess) {
    $rootProcess = Get-ProjectTreeRoot $ownerProcess
    Set-Content -LiteralPath $pidFile -Value $rootProcess.ProcessId -Encoding ascii
    return $rootProcess
  }
  return $null
}

function Stop-ProcessTree {
  param([int]$ProcessId)

  & taskkill.exe /PID $ProcessId /T /F *> $null
  if ($LASTEXITCODE -ne 0 -and (Get-ProcessById -ProcessId $ProcessId)) {
    throw "Windows could not stop radar process tree PID $ProcessId."
  }
}

function Start-Radar {
  New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
  $running = Find-RunningRadar
  if ($running) {
    if (Test-RadarHealth) {
      Write-Host "[OK] Hotspot Product Radar is already running at $localUrl (PID $($running.ProcessId))."
      return
    }
    Write-Host "[INFO] Removing an unhealthy managed radar process..."
    Stop-ProcessTree -ProcessId ([int]$running.ProcessId)
    Remove-StalePidFile
  }

  $owner = Get-PortOwner
  if ($owner) {
    throw "Port $port is occupied by unrelated PID $($owner.OwningProcess). It was not stopped."
  }

  $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $nodeCommand) {
    throw "Node.js is unavailable. Run install.bat first."
  }
  $tsx = Join-Path $projectRoot "node_modules\tsx\dist\cli.mjs"
  $server = Join-Path $projectRoot "server.ts"
  if (-not (Test-Path -LiteralPath $tsx -PathType Leaf)) {
    throw "Project dependencies are missing. Run install.bat first."
  }

  $startParameters = @{
    FilePath = $nodeCommand.Source
    ArgumentList = @($tsx, $server)
    WorkingDirectory = $projectRoot
    WindowStyle = "Hidden"
    RedirectStandardOutput = $stdoutLog
    RedirectStandardError = $stderrLog
    PassThru = $true
  }
  $process = Start-Process @startParameters
  Set-Content -LiteralPath $pidFile -Value $process.Id -Encoding ascii

  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 500
    if (Test-RadarHealth) {
      Write-Host "[OK] Hotspot Product Radar is running at $localUrl (PID $($process.Id))."
      return
    }
    if ($process.HasExited) {
      Remove-StalePidFile
      throw "The server exited during startup. Check data\server.error.log."
    }
  }

  Stop-ProcessTree -ProcessId $process.Id
  Remove-StalePidFile
  throw "The server did not become healthy within 15 seconds. Check data\server.error.log."
}

function Stop-Radar {
  $running = Find-RunningRadar
  if (-not $running) {
    $owner = Get-PortOwner
    if ($owner) {
      throw "Port $port is occupied by unrelated PID $($owner.OwningProcess). It was not stopped."
    }
    Remove-StalePidFile
    Write-Host "[OK] Hotspot Product Radar is already stopped."
    return
  }

  Stop-ProcessTree -ProcessId ([int]$running.ProcessId)
  Remove-StalePidFile
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    if (-not (Get-PortOwner)) {
      Write-Host "[OK] Hotspot Product Radar has been stopped."
      return
    }
    Start-Sleep -Milliseconds 250
  }
  throw "The managed process stopped, but port $port is still occupied."
}

function Show-RadarStatus {
  $running = Find-RunningRadar
  $owner = Get-PortOwner
  if ($running -and $owner -and (Test-RadarHealth)) {
    Write-Host "[RUNNING] $localUrl | manager PID $($running.ProcessId) | port PID $($owner.OwningProcess)"
    return
  }
  if ($owner) {
    Write-Host "[UNMANAGED] Port $port is occupied by PID $($owner.OwningProcess)."
    return
  }
  Write-Host "[STOPPED] Hotspot Product Radar is not running."
}

try {
  switch ($Action) {
    "start" { Start-Radar }
    "stop" { Stop-Radar }
    "restart" {
      Stop-Radar
      Start-Sleep -Milliseconds 500
      Start-Radar
    }
    "status" { Show-RadarStatus }
  }
}
catch {
  Write-Host "[ERROR] $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
