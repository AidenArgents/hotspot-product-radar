param(
  [Parameter(Mandatory = $true)]
  [string]$InstallParent,
  [switch]$Quiet
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol =
  [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$repositoryUrl = "https://github.com/AidenArgents/hotspot-product-radar.git"
$rawBaseUrl = "https://raw.githubusercontent.com/AidenArgents/hotspot-product-radar/main"
$InstallParent = [IO.Path]::GetFullPath($InstallParent)
New-Item -ItemType Directory -Path $InstallParent -Force | Out-Null

$runningInsideProject = Test-Path -LiteralPath (Join-Path $InstallParent "package.json") -PathType Leaf
$projectRoot = if ($runningInsideProject) {
  $InstallParent
}
else {
  Join-Path $InstallParent "hotspot-product-radar"
}

$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) "hotspot-product-radar-setup-$PID"
$temporaryRuntime = Join-Path $temporaryRoot "runtime"
$downloadedRuntimeHelper = Join-Path $temporaryRoot "ensure-runtime.ps1"

function Invoke-GitCommand {
  param(
    [string]$GitExecutable,
    [string[]]$Arguments
  )

  & $GitExecutable @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Git command failed: git $($Arguments -join ' ')"
  }
}

try {
  Write-Host ""
  Write-Host "==================================================="
  Write-Host "Hotspot Product Radar - One-click setup"
  Write-Host "==================================================="
  Write-Host "Install location: $projectRoot"
  Write-Host ""

  New-Item -ItemType Directory -Path $temporaryRoot -Force | Out-Null
  $localRuntimeHelper = Join-Path $projectRoot "scripts\ensure-runtime.ps1"
  if (Test-Path -LiteralPath $localRuntimeHelper -PathType Leaf) {
    $runtimeHelper = $localRuntimeHelper
    $runtimeRoot = Join-Path $projectRoot ".runtime"
  }
  else {
    Invoke-WebRequest `
      -Uri "$rawBaseUrl/scripts/ensure-runtime.ps1" `
      -OutFile $downloadedRuntimeHelper `
      -UseBasicParsing
    $runtimeHelper = $downloadedRuntimeHelper
    $runtimeRoot = $temporaryRuntime
  }

  & $runtimeHelper -EnsureGit -RuntimeRoot $runtimeRoot

  $systemGit = Get-Command git.exe -ErrorAction SilentlyContinue
  if ($systemGit) {
    $gitExecutable = $systemGit.Source
  }
  else {
    $gitExecutable = Join-Path $runtimeRoot "git\cmd\git.exe"
  }
  if (-not (Test-Path -LiteralPath $gitExecutable -PathType Leaf)) {
    throw "Git is not available after runtime setup."
  }

  if (-not (Test-Path -LiteralPath $projectRoot)) {
    Write-Host "[INFO] Downloading Hotspot Product Radar..."
    Invoke-GitCommand -GitExecutable $gitExecutable -Arguments @("clone", $repositoryUrl, $projectRoot)
  }
  elseif (-not (Test-Path -LiteralPath (Join-Path $projectRoot "package.json") -PathType Leaf)) {
    throw "The target folder already exists and is not a Hotspot Product Radar project: $projectRoot"
  }

  if ((Test-Path -LiteralPath (Join-Path $temporaryRuntime "git")) -and
      (-not (Test-Path -LiteralPath (Join-Path $projectRoot ".runtime\git")))) {
    New-Item -ItemType Directory -Path (Join-Path $projectRoot ".runtime") -Force | Out-Null
    Move-Item `
      -LiteralPath (Join-Path $temporaryRuntime "git") `
      -Destination (Join-Path $projectRoot ".runtime\git")
    $gitExecutable = Join-Path $projectRoot ".runtime\git\cmd\git.exe"
  }

  if (-not (Test-Path -LiteralPath (Join-Path $projectRoot ".git"))) {
    Write-Host "[INFO] Converting the downloaded ZIP folder into an updateable Git installation..."
    Invoke-GitCommand -GitExecutable $gitExecutable -Arguments @("-C", $projectRoot, "init", "-b", "main")
    Invoke-GitCommand -GitExecutable $gitExecutable -Arguments @("-C", $projectRoot, "remote", "add", "origin", $repositoryUrl)
    Invoke-GitCommand -GitExecutable $gitExecutable -Arguments @("-C", $projectRoot, "fetch", "origin", "main")
    Invoke-GitCommand -GitExecutable $gitExecutable -Arguments @("-C", $projectRoot, "reset", "--mixed", "origin/main")
    Invoke-GitCommand -GitExecutable $gitExecutable -Arguments @("-C", $projectRoot, "branch", "--set-upstream-to=origin/main", "main")
  }

  $configFile = Join-Path $projectRoot "config\radar_config.local.json"
  $exampleConfig = Join-Path $projectRoot "config\radar_config.example.json"
  $createdConfig = $false
  if (-not (Test-Path -LiteralPath $configFile -PathType Leaf)) {
    if (-not (Test-Path -LiteralPath $exampleConfig -PathType Leaf)) {
      throw "Configuration template is missing: config\radar_config.example.json"
    }
    Copy-Item -LiteralPath $exampleConfig -Destination $configFile
    $createdConfig = $true
    Write-Host "[ACTION REQUIRED] Created config\radar_config.local.json. Fill in your API keys and service settings."
  }
  else {
    Write-Host "[OK] Existing local configuration was preserved."
  }

  $installBat = Join-Path $projectRoot "install.bat"
  $startBat = Join-Path $projectRoot "start.bat"

  Write-Host "[INFO] Installing project dependencies..."
  & $env:ComSpec /d /c "call `"$installBat`" /quiet"
  if ($LASTEXITCODE -ne 0) {
    throw "install.bat failed."
  }

  Write-Host "[INFO] Starting Hotspot Product Radar..."
  $startArguments = if ($Quiet) { "/quiet /nobrowser" } else { "/quiet" }
  & $env:ComSpec /d /c "call `"$startBat`" $startArguments"
  if ($LASTEXITCODE -ne 0) {
    throw "start.bat failed."
  }

  if ($createdConfig -and -not $Quiet) {
    Start-Process -FilePath "notepad.exe" -ArgumentList @("`"$configFile`"")
    Write-Host "[INFO] The local configuration was opened in Notepad. Restart the radar after saving changes."
  }

  Write-Host ""
  Write-Host "[OK] Hotspot Product Radar is ready."
}
finally {
  if (Test-Path -LiteralPath $temporaryRoot) {
    Remove-Item -LiteralPath $temporaryRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
