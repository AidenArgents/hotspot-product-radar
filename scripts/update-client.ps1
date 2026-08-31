# ============================================================
# Hotspot Product Radar 客户端自动更新（免 git）
# 1. 读取本地 version.txt 与 GitHub 最新 Release 版本对比
# 2. 有新版：下载 zip（走系统代理，失败自动尝试镜像加速）→
#    停止服务 → 覆盖合并（保留本地配置/数据）→ 重启
#    依赖（node_modules）和 Dashboard 构建产物已打进 zip，客户端无需安装
# 用法：由 更新.bat 调用，也可手动执行本脚本
# ============================================================
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()

$projectRoot = Split-Path -Parent $PSScriptRoot
$owner = "AidenArgents"
$repository = "hotspot-product-radar"
$apiBase = "https://api.github.com/repos/$owner/$repository"
$localVersionFile = Join-Path $projectRoot "version.txt"

# GitHub 下载镜像加速前缀（逐个尝试）
$mirrors = @(
    "https://gh-proxy.com/",
    "https://ghfast.top/",
    "https://mirror.ghproxy.com/"
)

function Write-Step {
    param([string]$Message)
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Read-LocalVersion {
    if (Test-Path -LiteralPath $localVersionFile) {
        return (Get-Content -LiteralPath $localVersionFile -Raw).Trim()
    }
    return "0"
}

function Get-LatestRelease {
    $headers = @{ "User-Agent" = "hotspot-product-radar-updater" }
    try {
        $release = Invoke-RestMethod -Uri "$apiBase/releases/latest" -Headers $headers -TimeoutSec 60
    }
    catch {
        $status = $null
        if ($_.Exception.Response) {
            try { $status = [int]$_.Exception.Response.StatusCode } catch { $status = $null }
        }
        if ($status -eq 404) {
            throw "GitHub 仓库还没有发布版本（发布方首次发布后即可自动更新）。"
        }
        throw "无法连接 GitHub 检查版本，请检查网络或系统代理后重试。"
    }
    if (-not $release -or [string]::IsNullOrWhiteSpace($release.tag_name)) {
        throw "无法获取最新版本信息。"
    }
    return $release
}

function Download-File {
    param([string]$Url, [string]$OutFile)
    $headers = @{ "User-Agent" = "hotspot-product-radar-updater" }
    Invoke-WebRequest -Uri $Url -Headers $headers -OutFile $OutFile -UseBasicParsing -TimeoutSec 600
}

Set-Location -LiteralPath $projectRoot

try {
    $localVersion = Read-LocalVersion
    Write-Step "检查更新中..."
    Write-Host "本地版本：$localVersion"

    $release = Get-LatestRelease
    $remoteVersion = $release.tag_name.Trim() -replace "^v", ""
    Write-Host "最新版本：$remoteVersion"

    if ($remoteVersion -le $localVersion) {
        Write-Host ""
        Write-Host "当前已是最新版本，无需更新。" -ForegroundColor Green
        exit 0
    }

    $asset = $release.assets | Where-Object { $_.name -like "hotspot-product-radar-*.zip" } | Select-Object -First 1
    if (-not $asset) {
        throw "最新版本中未找到 zip 安装包，请稍后再试或手动更新。"
    }

    $originalUrl = $asset.browser_download_url
    $zipPath = Join-Path $env:TEMP "hotspot-product-radar-update.zip"
    if (Test-Path -LiteralPath $zipPath) {
        Remove-Item -LiteralPath $zipPath -Force
    }

    Write-Step "下载新版本（$([math]::Round($asset.size / 1MB, 1)) MB）..."
    $downloadOk = $false
    $downloadUrls = @($originalUrl)
    foreach ($mirror in $mirrors) {
        $downloadUrls += "$mirror$originalUrl"
    }
    foreach ($url in $downloadUrls) {
        try {
            Write-Host "尝试下载：$url"
            Download-File -Url $url -OutFile $zipPath
            if ((Get-Item -LiteralPath $zipPath).Length -gt 1MB) {
                $downloadOk = $true
                break
            }
            throw "下载文件过小，可能未完整。"
        }
        catch {
            Write-Host "  - 失败：$($_.Exception.Message)" -ForegroundColor Yellow
        }
    }
    if (-not $downloadOk) {
        throw "所有下载源都失败。请检查网络/系统代理后重试（可在浏览器访问 GitHub 确认连通）。"
    }
    Write-Host "[OK] 下载完成。"

    Write-Step "停止本地服务..."
    & cmd /c "`"$(Join-Path $projectRoot '停止.bat')`" /quiet"

    Write-Step "解压并覆盖本地文件..."
    $staging = Join-Path $env:TEMP "hotspot-product-radar-update-extract"
    if (Test-Path -LiteralPath $staging) {
        Remove-Item -LiteralPath $staging -Recurse -Force
    }
    Expand-Archive -LiteralPath $zipPath -DestinationPath $staging -Force

    # 覆盖合并（安全策略）：zip 包内的文件覆盖项目里的同名文件；
    # 项目里 zip 包没有的文件（本地配置、数据库、.runtime、.env 等）全部保留。
    & robocopy $staging $projectRoot /E /IS /IT /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) {
        throw "复制新文件失败（robocopy 返回 $LASTEXITCODE）。"
    }
    Write-Host "[INFO] 更新采用覆盖合并：本地配置、数据库、日志和运行环境不会被删除。"

    Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $staging) {
        Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
    }

    Write-Step "启动新版本..."
    & cmd /c "`"$(Join-Path $projectRoot '启动.bat')`" /quiet"
    if ($LASTEXITCODE -ne 0) {
        throw "新版本启动失败，请查看 server.log。"
    }

    Write-Host ""
    Write-Host "===================================================" -ForegroundColor Green
    Write-Host "[OK] 更新完成：$localVersion -> $remoteVersion" -ForegroundColor Green
    Write-Host "浏览器请刷新本地页面（端口见 config\radar_config.local.json 的 server_port）" -ForegroundColor Green
    Write-Host "===================================================" -ForegroundColor Green
    exit 0
}
catch {
    Write-Host ""
    Write-Host "[错误] 更新失败：$($_.Exception.Message)" -ForegroundColor Red
    Write-Host "本地文件未被破坏，可继续使用当前版本；请检查网络后重试。" -ForegroundColor Yellow
    exit 1
}
