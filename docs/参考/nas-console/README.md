# nas-console

NAS 网页控制台：给人用的网页终端（xterm.js 交互式 PTY）+ 给 AI/程序用的 HTTP exec API。

核心能力：在 NAS（绿联 UGOS）上以 Docker 容器运行，通过 `privileged + pid:host + nsenter` 拿到宿主机 root shell 执行命令（原理与 PoC 见 `docs/ugos-nas-ops.md` 第 10 节）。

## 安全模型

| 入口 | 认证 |
|---|---|
| 网页终端 | 账号 + 密码 → httpOnly session cookie |
| HTTP API | `Authorization: Bearer nsc_xxx` |

- API Token 明文存储、列表脱敏展示、可再次查看完整值、可吊销（有意取舍，见设计文档）
- 所有命令执行写入审计日志（actor/命令/退出码/耗时/IP）
- 登录限速防爆破

## API（v0.1）

```
GET  /api/health          免认证探活
POST /api/login           登录（账号密码）
POST /api/logout          登出
GET  /api/me              当前身份
POST /api/exec            执行命令 {cmd, cwd?, timeout?} → {exitCode, stdout, stderr, ...}
WS   /api/tty              交互式终端（WebSocket，PTY 会话，需登录 cookie 或 ?token=）
POST /api/tokens          生成 API Token（返回完整值一次，可再查）
GET  /api/tokens          列表（脱敏）
GET  /api/tokens/:id      查看完整 token（登录态）
DELETE /api/tokens/:id    吊销
GET  /api/audit           审计日志（登录态）
```

## 本地开发

```bash
npm install
NAS_CONSOLE_USERNAME=admin NAS_CONSOLE_PASSWORD=devpass npm run dev   # 本地直跑（非 nsenter）
npm test                                                              # 集成测试（node:test）
```

容器内部署走 nsenter（`NAS_CONSOLE_NSENTER=1`），见 `docker-compose.nas.yml`。

## 配置（.env / 环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| PORT | 8890 | 监听端口 |
| NAS_CONSOLE_DB | ./data/nas-console.db | SQLite 路径 |
| NAS_CONSOLE_USERNAME | admin | 初始管理员（首次启动 seed） |
| NAS_CONSOLE_PASSWORD | change-me | 初始管理员密码 |
| NAS_CONSOLE_NSENTER | 0 | 1=容器内走 nsenter 进宿主 shell |
| EXEC_DEFAULT_TIMEOUT_MS | 30000 | 单条命令默认超时 |
| EXEC_MAX_TIMEOUT_MS | 300000 | 单条命令最大超时 |