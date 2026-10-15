# Kura 蔵

绿联 NAS 的 Windows 桌面客户端（TS + Electron + React，界面用 Sakura UI）。

「蔵（くら）」是存放珍藏之物的仓库，也是 Sa**kura** 的后半。

启动即提供：服务端口映射（nas-mirror 能力的 TS 重写）、文件管理器 + 本机 WebDAV、NAS 终端（接 nas-console）；
进阶功能（如 rclone 挂载为磁盘）做成按需安装的模块。

## 状态

| 版本 | 内容 |
|-|-|
| v0.1 | 应用外壳、连接核心（nas-mirror 的 TS 移植）、引导 + DPAPI 凭据、服务映射页与概览 |
| v0.2 | 文件管理器（经映射层的 WebDAV）、**本机 WebDAV**（放行 / 排除 / 只读的暴露范围）、终端（xterm.js 多标签，接 nas-console） |
| v0.3 | 模块页：rclone 挂载为本机磁盘（固定版本下载 + SHA256 校验；WinFsp 需自行安装） |
| v0.4 | 容器管理（以 Arcane 为蓝本）：compose 项目启停 / 重建 / 编辑 / 新建 / 删除，容器详情与实时日志，镜像，审计。设计见 [`docs/容器管理 设计.md`](docs/容器管理%20设计.md) |

NAS 侧的 **kura-server**（`server/`，一个镜像两个入口 serve / shell）已部署到真机 8898 并逐项验收：
12 个服务、终端连真宿主 shell、两层 WebDAV、rclone 挂载、管理页，外网中继下 WebSocket 可用。
**暴露范围只有一份**，存在 NAS 的 `state/webdav.json`，客户端「文件」页与 NAS 管理页读写同一处。

**当前状态看 [`docs/交接.md`](docs/交接.md)**（验过什么、什么没做、已知坑；lan 模式那条链路未验）。
使用前先停掉 Go 版 nas-mirror：两者会抢同样的本机端口。

NAS 侧依赖：服务端清单里要有 `webdav`（文件、本机 WebDAV、挂载）与 `nas-console`（终端）两个服务；
容器页要 `docker`（kura-server 挂了 docker.sock、且项目目录按原路径挂进来）。

## 开发

需要 Node 24 + npm 11（Windows）。

```powershell
npm install
npm start          # 构建并启动
npm run check      # 类型检查 + 单测 + 真实 Electron 冒烟
npm run dist       # 打 Windows 安装包 → release/Kura-Setup-<版本>.exe（未签名）
npm run icon       # 改了图标图形后重新生成 assets/icon.ico、tray.png

# 对打包产物跑同一套冒烟
$env:KURA_SMOKE_EXE="release\win-unpacked\Kura.exe"; node scripts/smoke.mjs

# 公司网络要走代理：设环境变量即可（只影响外网中继那条 https 链路，局域网直连不走代理）
$env:HTTPS_PROXY="http://proxy.example:8080"; $env:NO_PROXY="localhost,127.0.0.1"

# 真下载 rclone 并用 WinFsp 挂一个临时盘符（联网，默认跳过）
$env:KURA_REAL_RCLONE=1; npx vitest run src/main/modules.real.test.ts
```

| 目录 | 内容 |
|-|-|
| `src/core/` | 连接核心（纯 Node，不依赖 Electron）：绿联登录、会话、链路、反代、监听、清单、探测 |
| `src/main/` | 主进程：窗口、托盘、IPC、凭据加密、连接服务 |
| `src/preload/` | 暴露给渲染层的 `window.kura` |
| `src/shared/` | 两侧共用的设置结构与 IPC 契约 |
| `src/renderer/` | React + Sakura UI 界面 |
| `vendor/sakura-ui/` | Sakura UI 交付包（tgz） |
| `server/` | NAS 侧 kura-server（网关 + WebDAV + 终端，一个镜像两个入口） |
| `docs/交接.md` | **状态快照**：验过什么、什么没做、已知坑 |
| `docs/kura-server 设计.md` | kura-server 的设计与决策 |
| `docs/参考/` | 前身项目资料（脱敏快照） |
| `docs/归档/` | 每一步做了什么、踩过的坑 |

数据目录：`%APPDATA%\Kura\`（与 Go 版 nas-mirror 的 `~/.nas-mirror` 互不干扰）：

| 文件 | 内容 |
|-|-|
| `credentials.json` | 连接配置（含密码），整份用 safeStorage / DPAPI 加密 |
| `settings.json` | 界面设置 |
| `mirror/services.json` | 各服务的开关、本机端口改动 |
| `mirror/discovered.json` | 上次拉到的服务端清单（拉不到时兜底） |
| `webdav.json` | 本机 WebDAV 的端口、启用开关（范围不在这里 —— 只有 NAS 那份说了算，见 `docs/交接.md`） |
| `modules/` | rclone（Kura 下载的副本）、挂载设置 `mount.json`、VFS 缓存 |
| `logs/kura.log` | 日志，10 MiB 轮转；`KURA_VERBOSE=1` 打开 debug |
