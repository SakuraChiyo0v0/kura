# 参考资料

Kura 前身各项目的资料**快照**，2026-10-13 从原位置复制过来，供开发时查阅。

- 这里是**只读快照**，不在此处修改；原项目后续更新不会同步过来，需要时重新取。
- 内容和当前实测冲突时，**以实测为准**（见 `AGENTS.md`）。
- 文中的相对链接指向原项目，在这里可能打不开，按下表找原文。
- **已脱敏**：设备域名、局域网 / 容器 IP、用户名、口令片段与指纹、NAS 部署路径、个人数据目录名
  都换成了 `<设备>`、`<NAS局域网IP>`、`<网关用户>`、`<部署根>`、`<媒体目录>` 这类占位符。
  真实值只在原项目和本机配置里；**新增资料进本目录前同样先脱敏**。

| 目录 | 内容 | 原位置 |
|-|-|-|
| `nas-mirror/设计方案.md` | 安全模型、链路选择、绿联 SSO 会话管理、M0–M2 实测、网关收敛与回滚 | `NAS-PROJECTS/docs/nas-mirror-设计方案.md` |
| `nas-mirror/客户端README.md` | Go 客户端的行为、配置、链路模式、凭据、watchdog —— **TS 重写的行为基线** | `NAS-PROJECTS/nas-mirror/README.md` |
| `nas-mirror/服务端README.md` | sso-gateway（nginx + Authelia）、`/__services` 服务清单 | `NAS-PROJECTS/nas-mirror/server/README.md` |
| `nas-mirror/files-admin-README.md` | WebDAV 暴露目录的勾选与 rclone filters | `NAS-PROJECTS/nas-mirror/server/files-admin/README.md` |
| `nas-mirror/skill-*.md` | 客户端与网关的操作手册 | `NAS-PROJECTS/nas-mirror/skills/` |
| `nas-console/` | NAS 终端：`WS /api/tty`、`POST /api/exec`、认证与审计 | GitHub `SakuraChiyo0v0/nas-console` |
| `ugreen-sdk/README.md` | UGOS 登录链、cookie 缓存、WebDAV 上传 SDK | `NAS-PROJECTS/ts-dev-kits/packages/ugreen/` |
| `归档摘录/` | nas-mirror、WebDAV、files-admin 相关的历史归档（踩坑记录） | `NAS-PROJECTS/docs/归档/` |

代码本身没有复制：Go 客户端源码与测试在 `NAS-PROJECTS/nas-mirror/client/`，重写时直接对照原文件。
