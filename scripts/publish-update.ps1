param(
  [switch]$CheckOnly
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$owner = "AidenArgents"
$repository = "hotspot-product-radar"
$remoteUrl = "https://github.com/$owner/$repository.git"
$repositoryUrl = "https://github.com/$owner/$repository"

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "===================================================" -ForegroundColor DarkCyan
  Write-Host $Message -ForegroundColor Cyan
  Write-Host "===================================================" -ForegroundColor DarkCyan
}

function Invoke-Git {
  param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Arguments
  )

  & git @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Git 命令执行失败：git $($Arguments -join ' ')"
  }
}

function Test-RemoteRepository {
  $previousErrorAction = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    & git ls-remote $remoteUrl *> $null
    $remoteExitCode = $LASTEXITCODE
  }
  finally {
    $ErrorActionPreference = $previousErrorAction
  }
  return $remoteExitCode -eq 0
}

function Ensure-GitIdentity {
  $currentName = (& git config --get user.name 2>$null)
  $currentEmail = (& git config --get user.email 2>$null)

  $nameNeedsUpdate = [string]::IsNullOrWhiteSpace($currentName) -or $currentName.Trim() -eq "User"
  $emailNeedsUpdate = [string]::IsNullOrWhiteSpace($currentEmail) -or $currentEmail.Trim() -eq "user@example.com"

  if ($CheckOnly) {
    if ($nameNeedsUpdate -or $emailNeedsUpdate) {
      Write-Host "[提示] 首次正式发布时会要求填写 Git 提交姓名和邮箱。"
    }
    return
  }

  if ($nameNeedsUpdate) {
    $newName = Read-Host "请输入 Git 提交姓名（直接回车使用 AidenArgents）"
    if ([string]::IsNullOrWhiteSpace($newName)) { $newName = $owner }
    Invoke-Git -Arguments @("config", "user.name", $newName.Trim())
  }

  if ($emailNeedsUpdate) {
    $newEmail = Read-Host "请输入 GitHub 账号使用的邮箱"
    if ([string]::IsNullOrWhiteSpace($newEmail)) {
      throw "邮箱不能为空。未进行发布。"
    }
    Invoke-Git -Arguments @("config", "user.email", $newEmail.Trim())
  }
}

function Ensure-OriginRemote {
  $remotes = @(& git remote)
  if ($remotes -notcontains "origin") {
    if ($CheckOnly) {
      Write-Host "[提示] 首次正式发布时会添加远程仓库：$remoteUrl"
      return
    }
    Invoke-Git -Arguments @("remote", "add", "origin", $remoteUrl)
    Write-Host "[OK] 已连接远程仓库：$remoteUrl"
    return
  }

  $originUrl = (& git remote get-url origin).Trim()
  if ($originUrl -eq $remoteUrl) {
    Write-Host "[OK] 远程仓库地址正确。"
    return
  }

  if ($CheckOnly) {
    Write-Host "[警告] 当前 origin 不是预期地址：$originUrl" -ForegroundColor Yellow
    return
  }

  Write-Host "当前 origin：$originUrl" -ForegroundColor Yellow
  Write-Host "目标 origin：$remoteUrl" -ForegroundColor Yellow
  $replace = Read-Host "输入 REPLACE 才会替换远程地址"
  if ($replace -cne "REPLACE") {
    throw "远程地址未修改，发布已取消。"
  }
  Invoke-Git -Arguments @("remote", "set-url", "origin", $remoteUrl)
}

function Ensure-RemoteRepositoryExists {
  if (Test-RemoteRepository) {
    Write-Host "[OK] GitHub 仓库可以访问：$repositoryUrl"
    return
  }

  if ($CheckOnly) {
    Write-Host "[提示] GitHub 仓库尚未创建或尚未登录；正式运行时会打开创建页面。"
    return
  }

  Write-Host ""
  Write-Host "GitHub 仓库尚未创建，或者当前电脑尚未获得访问权限。" -ForegroundColor Yellow
  Write-Host "浏览器将打开 GitHub 新建仓库页面。请按下面填写："
  Write-Host ""
  Write-Host "Owner：$owner"
  Write-Host "Repository name：$repository"
  Write-Host "Visibility：Public"
  Write-Host "不要添加 README、.gitignore 或 License"
  Write-Host ""

  Start-Process "https://github.com/new"
  [void](Read-Host "在网页创建空仓库后，回到这里按回车继续")
  if (-not (Test-RemoteRepository)) {
    throw "仍然无法访问 $repositoryUrl。请确认仓库名称、登录账号和访问权限。"
  }
  Write-Host "[OK] GitHub 仓库已经可以访问。"
}

function Test-RemoteIsNotAhead {
  $remoteMain = (& git ls-remote --heads origin refs/heads/main 2>$null)
  if ([string]::IsNullOrWhiteSpace($remoteMain)) { return }

  Invoke-Git -Arguments @("fetch", "origin", "main")
  $behindText = (& git rev-list --count HEAD..origin/main).Trim()
  $behind = 0
  [void][int]::TryParse($behindText, [ref]$behind)
  if ($behind -gt 0) {
    throw "GitHub 上有 $behind 个本地没有的提交。为避免覆盖远程修改，本次发布已停止。"
  }
}

function Invoke-ProjectChecks {
  & npm.cmd run typecheck
  if ($LASTEXITCODE -ne 0) { throw "TypeScript 类型检查失败，未进行发布。" }

  & npm.cmd test
  if ($LASTEXITCODE -ne 0) { throw "自动测试失败，未进行发布。" }

  & npm.cmd run build:dashboard
  if ($LASTEXITCODE -ne 0) { throw "看板构建失败，未进行发布。" }

  & npm.cmd run test:secrets
  if ($LASTEXITCODE -ne 0) { throw "密钥检查失败，未进行发布。" }

  & git diff --check
  if ($LASTEXITCODE -ne 0) { throw "Git 差异格式检查失败，未进行发布。" }
}

Set-Location -LiteralPath $projectRoot

try {
  Write-Step "热点选品雷达 发布更新工具"
  Write-Host "GitHub 用户：$owner"
  Write-Host "目标仓库：$repositoryUrl"
  Write-Host "主项目：$projectRoot"

  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw "没有检测到 Git。请先运行 install.bat。"
  }
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "没有检测到 Node.js。请先运行 install.bat。"
  }
  if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
    throw "没有检测到 npm。请先运行 install.bat。"
  }

  & git rev-parse --is-inside-work-tree *> $null
  if ($LASTEXITCODE -ne 0) {
    throw "当前目录不是 Git 项目：$projectRoot"
  }

  Ensure-GitIdentity
  Ensure-OriginRemote

  if ($CheckOnly) {
    Write-Host ""
    Write-Host "[OK] 发布脚本语法和本地环境检查完成；没有提交或上传。" -ForegroundColor Green
    exit 0
  }

  Ensure-RemoteRepositoryExists
  Test-RemoteIsNotAhead

  Write-Step "1/4 构建并检查项目"
  Invoke-ProjectChecks

  Write-Step "2/4 确认准备发布的文件"
  & git -c core.quotePath=false status --short
  if ($LASTEXITCODE -ne 0) { throw "无法读取 Git 状态。" }

  Write-Host ""
  Write-Host "上面列出的改动将被提交到公开 GitHub 仓库。" -ForegroundColor Yellow
  $confirmation = Read-Host "确认无误请直接按回车发布；输入其他内容取消"
  if (-not [string]::IsNullOrWhiteSpace($confirmation)) {
    Write-Host "已取消，没有提交或上传任何内容。"
    exit 0
  }

  Write-Step "3/4 创建本次版本"
  Invoke-Git -Arguments @("branch", "-M", "main")
  Invoke-Git -Arguments @("add", "-A")

  & git diff --cached --quiet
  $hasStagedChanges = $LASTEXITCODE -ne 0
  if ($hasStagedChanges) {
    $defaultMessage = "更新热点选品雷达 $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
    $commitMessage = Read-Host "请输入本次更新说明（直接回车使用：$defaultMessage）"
    if ([string]::IsNullOrWhiteSpace($commitMessage)) { $commitMessage = $defaultMessage }
    Invoke-Git -Arguments @("commit", "-m", $commitMessage)
  }
  else {
    Write-Host "[INFO] 没有新的文件改动，将只检查并推送当前版本。"
  }

  Write-Step "4/4 上传到 GitHub"
  $upstreamRemote = (& git config --get branch.main.remote)
  if ([string]::IsNullOrWhiteSpace($upstreamRemote)) {
    Invoke-Git -Arguments @("push", "-u", "origin", "main")
  }
  else {
    Invoke-Git -Arguments @("push", "origin", "main")
  }

  Write-Host ""
  Write-Host "[完成] 新版本已经发布：" -ForegroundColor Green
  Write-Host $repositoryUrl -ForegroundColor Green
  Write-Host "其他用户现在可以双击 update.bat 更新。"
}
catch {
  Write-Host ""
  Write-Host "[错误] $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
