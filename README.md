# Kura 蔵

绿联 NAS 的 Windows 桌面客户端（TS + Electron + React，界面用 Sakura UI）。

「蔵（くら）」是存放珍藏之物的仓库，也是 Sa**kura** 的后半。

启动即提供：服务端口映射（nas-mirror 能力的 TS 重写）、文件管理器 + 本机 WebDAV、NAS 终端（接 nas-console）；
进阶功能（如 rclone 挂载为磁盘）做成按需安装的模块。

## 状态

v0.1 的四步都已完成，可以替代 Go 版 nas-mirror 客户端：

1. 应用外壳：托盘常驻、标题栏、侧栏导航、设置
2. 连接核心：nas-mirror 映射能力的 TS 移植（`src/core/`），Go 版测试逐条翻译
3. 首次启动引导 + 凭据加密保存（Windows DPAPI）
4. 服务映射页与概览页

**尚未在真实 NAS 上验收**（冒烟用的是本地假 NAS）。下一步：真机验收，然后 v0.2（文件管理器、终端）。
使用前先停掉 Go 版 nas-mirror：两者会抢同样的本机端口。

## 开发

需要 Node 24 + npm 11（Windows）。

```powershell
npm install
npm start          # 构建并启动
npm run check      # 类型检查 + 单测 + 真实 Electron 冒烟
```

| 目录 | 内容 |
|-|-|
| `src/core/` | 连接核心（纯 Node，不依赖 Electron）：绿联登录、会话、链路、反代、监听、清单、探测 |
| `src/main/` | 主进程：窗口、托盘、IPC、凭据加密、连接服务 |
| `src/preload/` | 暴露给渲染层的 `window.kura` |
| `src/shared/` | 两侧共用的设置结构与 IPC 契约 |
| `src/renderer/` | React + Sakura UI 界面 |
| `vendor/sakura-ui/` | Sakura UI 交付包（tgz） |
| `docs/参考/` | 前身项目资料（脱敏快照） |
| `docs/归档/` | 每一步做了什么、踩过的坑 |

数据目录：`%APPDATA%\Kura\`（与 Go 版 nas-mirror 的 `~/.nas-mirror` 互不干扰）：

| 文件 | 内容 |
|-|-|
| `credentials.json` | 连接配置（含密码），整份用 safeStorage / DPAPI 加密 |
| `settings.json` | 界面设置 |
| `mirror/services.json` | 各服务的开关、本机端口改动 |
| `mirror/discovered.json` | 上次拉到的服务端清单（拉不到时兜底） |
| `logs/kura.log` | 日志，10 MiB 轮转；`KURA_VERBOSE=1` 打开 debug |
