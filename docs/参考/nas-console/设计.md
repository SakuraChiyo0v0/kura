# nas-console 设计（v0.1 MVP）

> 日期：2026-09-02
> 状态：已与用户确认方案（独立项目 + Node/TS + 特权容器宿主 shell + 自带账号/API Token）
> 关联经验：docs/ugos-nas-ops.md

## 1. 定位

运行在 NAS（绿联 UGOS）上的 Docker 容器，提供两类入口：

- 网页终端：给人用（浏览器），类似 SSH 到宿主机。
- HTTP API：给 AI / 程序用（单命令式 exec）。

两者共享同一套宿主 shell 执行通道与认证体系。

## 2. 为什么需要"登录入口"与高安全标准

用户选择支持宿主机完整 shell（方案 B），因此本工具的安全等级等同"持有 NAS root"。认证与审计是核心功能，不是可选增强。

## 3. 核心执行机制

特权容器（privileged + pid=host），挂载宿主机根目录 `/:/host` 与 docker.sock，
通过 `nsenter` 进入宿主 PID 1 的命名空间获得真·宿主 root shell。

```
特权容器
 ├─ /:/host                宿主根文件系统（宿主视角路径）
 ├─ /var/run/docker.sock   容器内可操作 docker（若宿主无 docker CLI 则容器内预装）
 └─ nsenter -t 1 -m -u -i -n -p -- bash -c "<cmd>"   真宿主 shell
```

关键技术风险：UGOS 宿主是否允许上述挂载与命名空间进入、宿主是否存在可用 sh/docker CLI。
因此里程碑 0 必须先做 PoC，验证不通过则暂停后续开发。

## 4. 认证与安全边界

| 入口 | 认证 | 说明 |
|---|---|---|
| 网页终端 | 账号 + 强密码 -> 会话 cookie | 独立账号，不碰 UGOS 系统账号 |
| HTTP API | Authorization: Bearer <token> | 独立长期 token，可单独吊销 |
| 对外访问 | 只走 ugdocker HTTPS 域名 | 不直接暴露公网端口 |

决策记录：
- API Token 明文存储、列表脱敏展示（`nsc_abc…`）、可再次查看完整值、请求用完整明文。
  这是有意取舍（区别于 kiro-gateway 的一次性明文设计），已在安全文档标注风险：数据库泄露 = token 泄露。
- 审计日志默认开启：账号/token 名、命令、退出码、耗时、时间。
- 登录失败限速 + 防爆破；会话有时效可登出。
- v0.1 不做：IP 白名单、命令级黑白名单、二次确认。

## 5. 技术栈

- 后端：Node 22 + TypeScript + Hono + ws
- 执行：spawn + nsenter，流式输出；支持 timeout / cwd / 单命令
- 前端：React + Vite + xterm.js（网页终端）+ 登录页 + token/设置页
- 存储：SQLite（账号、token、审计），容器卷持久化
- 配置：环境变量 / .env

## 6. API 面（v0.1）

```
POST /api/exec          { cmd, cwd?, timeout? } -> { exitCode, stdout, stderr, duration }
WS   /api/tty           网页终端会话（xterm 双向流）
GET  /api/health        免认证探活
POST /api/tokens        生成 token（返回完整值一次 + 可再查）
GET  /api/tokens        列表（脱敏）
GET  /api/tokens/:id    查看完整 token
DELETE /api/tokens/:id  吊销
GET  /api/audit         审计查询
```

## 7. 项目落点

```
NAS-PROJECTS/nas-console/
├── server/            Hono 后端 + 执行器 + 认证 + 审计
├── web/               React 前端
├── Dockerfile / docker-compose.nas.yml / .github/workflows/
└── README.md
```

- 独立 GitHub 仓库、独立发布，复用 nas-hello 的 Dockerfile + workflow + watchtower 模板（push -> ghcr -> 自动更新）。
- 第一个实战使用自动更新链路的应用。

## 8. 里程碑顺序

1. PoC：在 NAS 上验证 nsenter 拿宿主 shell（本设计最前置风险）。
2. 后端：exec API + token/账号认证 + SQLite + 审计。
3. 前端：登录页 + xterm 终端 + token 管理。
4. 安全收尾 + 容器化 + 部署 NAS + watchtower 链路。
5. README 复刻文档。

## 9. 明确不做（v0.1 非目标）

- 会话式终端 API（先单命令式，执行器预留会话化扩展）
- 命令级黑白名单 / IP 白名单 / 二次确认
- 对接 UGOS 系统账号 / SSH
- 多用户角色权限体系