# 热点选品雷达 v8（Windows 原生版）

这是从 `热点选品雷达v7 东南亚+拉美地区.json` 等价迁移出的轻量应用。运行时只有一个 Node.js 进程和一个 SQLite 文件，不依赖 Docker、n8n、Windmill 或独立数据库服务。

## 已保留的原流程设计

| 设计 | 原样保留方式 |
|---|---|
| 假日、媒体、网页三条线路 | 独立采集、独立结果、独立钉钉消息 |
| Tavily 每个媒体站单独请求 | 目标 8 国共 30 个站点，仍然逐站查询 |
| Gemini 每个国家单独分析 | 假日和媒体线路仍是一国一次，避免字符超限和国家混淆 |
| 体育搜索 | 7 条独立搜索全部保留，并在运行详情中单列 |
| 网页采集 | 3 个 RSS 源和原有标题去重逻辑保留 |
| Google Sheets | 新事件仍追加到原表，历史 ID 继续参与去重 |
| 钉钉 | 假日 API、Tavily 媒体、网页抓取仍分别发送给两个机器人 |
| 定时 | 每天 09:10，默认运行“媒体+网页” |

速度提升来自安全并发：三条线路并行、多个国家并行、同一国家的站点并行，但每个站点的请求内容和每个国家的 Gemini 边界没有合并。

## 启动和访问

- 第一次使用：双击 `setup.bat`。
- 平时启动：双击 `start.bat`。
- 本机访问：`http://localhost:3210`
- 当前局域网访问：`http://192.168.1.22:3210`
- 关闭后台：双击 `stop.bat`。

需要登录 Windows 后自动运行时，双击 `install-startup.bat`；取消时双击 `uninstall-startup.bat`。电脑需要保持开机和联网，团队才能访问。

如果同一局域网的其他电脑打不开，而本机可以打开，通常是 Windows 防火墙没有允许 3210 端口。可在管理员 PowerShell 中按需执行：

```powershell
New-NetFirewallRule -DisplayName "Hotspot Product Radar" -Direction Inbound -Protocol TCP -LocalPort 3210 -Action Allow
```

不要把 3210 端口直接暴露到公网；异地访问应再加有身份验证的安全隧道或反向代理。

## 唯一配置文件

所有可修改项都集中在：

`config/radar_config.local.json`

当前电脑上的这个文件已经从原 n8n 文件导入真实值，并被 `.gitignore` 排除，不会进入版本库。公开仓库提供 `config/radar_config.example.json`；新用户运行 `setup.bat` 时会自动复制成自己的本地配置，并提示填写。主要分组：

- AI/搜索：`gemini_api_key`、`tavily_api_key`、`gemini_model`
- Google Sheets：`spreadsheet_id`、服务账号邮箱、私钥、工作表名称
- 钉钉：两个机器人的 token 和 secret
- 本地服务：`database_file`、`server_host`、`server_port`、`dashboard_url`
- 网络回退：`https_proxy`（当前指向本机 Clash Verge，仅在 Gemini 主请求失败时使用）
- 定时：`schedule_enabled`、`schedule_hour`、`schedule_minute`
- 并发/超时：`country_concurrency`、`site_concurrency` 和两个 timeout
- Gemini 限流：`gemini_min_interval_ms`，保留逐国请求但避免触发免费层每分钟额度
- 默认扫描：区域、时间范围、手动线路、定时线路

修改配置后双击 `restart.bat`，使新配置生效。

虽然按要求复用了原密钥，仍建议在迁移稳定后逐项轮换曾经泄露的密钥。

公开仓库中的配置样本默认关闭定时任务、留空代理和所有密钥。新用户填完配置后，如需每天自动采集，再把 `schedule_enabled` 改为 `true`。

## 数据与备份

- 业务数据库：`data/radar.sqlite`
- 运行日志：`data/server.log`、`data/server.error.log`
- SQLite 使用 WAL 模式，团队可同时查询；写入由单个扫描任务串行控制。
- 备份时先停止雷达，再复制 `data/radar.sqlite` 即可。

数据库文件不随代码发布，因为其中会包含历史扫描结果、请求记录和运行状态。服务第一次启动时会自动创建空的 `data/radar.sqlite` 和完整表结构，因此从 GitHub 下载后不会缺数据库文件。

## 一键管理文件

| 文件 | 用途 |
|---|---|
| `setup.bat` | 首次准备环境、安装依赖、构建页面并启动 |
| `install.bat` | 安装或修复 Node.js 运行环境、依赖和前端构建，不修改配置与数据 |
| `start.bat` | 后台启动并打开页面；重复运行不会启动第二份 |
| `restart.bat` | 安全关闭本项目进程后重新启动 |
| `stop.bat` | 只关闭经过路径和 PID 校验的本项目进程 |
| `status.bat` | 查看服务、端口及 PID 状态 |
| `install-startup.bat` | 安装当前用户的开机登录自启动快捷方式 |
| `uninstall-startup.bat` | 移除开机登录自启动，不关闭当前服务 |

如果电脑没有合适版本的 Node.js，`setup.bat` / `install.bat` 会把 Node.js LTS 便携版下载到项目自己的 `.runtime` 目录，不安装 Docker，也不改 Windows 的全局 Node.js。

## 命令行方式

```powershell
npm install
npm run import:n8n
npm run build:dashboard
npm start
```

手动在命令行跑完整扫描：

```powershell
npm run scan -- --region=全部 --time=未来3个月 --lines=全部
```

验证：

```powershell
npm run typecheck
npm test
npm run test:secrets
npm run test:external
```

`test:external` 默认只跑越南假日线路，不发钉钉、不写 Google Sheets，用于检查真实 Nager + Gemini 链路。运行 `npm run test:external -- media` 会改为检查新加坡逐站 Tavily + Gemini 媒体链路。
