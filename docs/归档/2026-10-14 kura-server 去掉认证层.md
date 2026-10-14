# 2026-10-14 · kura-server 去掉认证层

S1 时在 kura-server 里复刻了一套 Authelia 协议（单用户、argon2id、会话 cookie、防爆破），
好处是客户端一行不改就能连。**这天整层删掉**：客户端只剩绿联一组凭据，网关那一层只填端口。

起因是 UI 验收时的一个疑问：「外面已经有绿联账号密码扛住了，里面这层是不是重复设置？」

## 做了什么

| 位置 | 改动 |
|-|-|
| 服务端 | 删 `server/src/auth.ts`、`password.ts`；`server.ts` 去掉 `auth` 参数与 `unauthorized()` 分支 |
| 服务端 | `/api/firstfactor`、`/api/logout` 留成**兼容壳**：一律回 `200 {"status":"OK"}`，不种 cookie |
| 服务端 | `main.ts` 不再要求 `KURA_USER` / `KURA_PASSWORD_HASH`；`hash` 子命令删掉（`hash.ts` 留着做 rclone 文件校验） |
| 服务端 | 管理页删登录页与「退出登录」；`saveError` 之类不再带 `用户:` |
| 服务端 | `console.ts` 删掉 `ConsoleSessions` 整类；`/api/me` 恒 200，`/api/exec`、WS 不再 401 |
| 客户端 | 删 `src/core/authelia.ts`；`AuthRejectedError` 去掉 `bannedUntil`；`AuthState` 去掉 `credential` 标志 |
| 客户端 | `ConnectionConfig` 去掉 `gatewayUser` / `gatewayPassword`；设置页只剩「网关端口」 |
| 客户端 | 退避只剩一档：失败就是台阶退避（5s → 10s → … → 120s），不再有「凭据错 → 停手冷却 10 分钟」 |
| 文档 | 设计文档 §二、§三重写；`.env.example` 清空凭据；compose 头注释改掉 |

**保留**：kura-shell 的内部令牌。那不是这一层认证 —— 它是 kura-server 与特权容器之间的边界，
删了等于宿主 root 对着内网裸奔。

## 踩过的坑（写下来别再犯）

### 1. 我以为是「凭据字段没生效」，实测是「里面真的另有一套认证」

诊断脚本（`scripts/svc.mjs`）报 `login status 400` / `svc status 401`。第一反应是读错了配置字段，
去翻 `~/.config/kura/creds.json` —— 里面只有 `ugreenUser` / `ugreenPassword`，**根本没有网关那两个字段**。
脚本是照旧的客户端数据结构写的，而那段代码早就没了。顺着查下去才确认：401 不是脚本写错，
是 kura-server 自己在拦。

教训：报错先怀疑自己的假设，别先怀疑数据。字段缺失本身就是线索。

### 2. 「Host 头用公网域名」不是为认证服务的，删认证时差点连坐

一上来想删的是一整坨「网关会话」概念，其中包括 `lanBase` + `lanHostHeader`
（局域网拨 IP、Host 仍发公网域名）。**这条不能删**：新服务确实不校验域名了，
但它同时承担「让容器应用在两种链路下看到的 Host 一致」—— 应用侧按 Host 做跳转/鉴权的场景还在。

所以只删了 `establishOnce` 的 LAN 分支（现在直接返回空串），保留 Host 头这条链路。
删之前先把「这个字段到底在为谁服务」问清楚，比删快了重要。

### 3. 兼容壳不是多余：不回 200，旧客户端启动就报错

`/api/firstfactor` 明明已经没用了，为什么还留着？因为旧客户端启动时**先登录一次**才做别的，
拿到非 200 直接判连接失败、进退避。留着回 200 的成本是一行，不留的成本是「老版本用户全部连不上」。

### 4. 删掉假 auth 之后，测试服务器没了管理页

`server/test/s1.test.ts` 原来用假 `auth` 兜着，删掉后 `/_kura/` 回 404（测试断言要 200）。
补了个假 `admin`（`handle: async (_req, res) => …`）。顺带踩到 TS 报错：
`handle` 得声明成 `Promise<void>`，写 `void` 会 TSC2322。

### 5. 接受了的代价：8898 局域网完全开放

`8898` 发布在 `0.0.0.0`，同网段设备可以直连它 —— 读写整个 NAS 文件、拿到 root 终端。
公网侧靠绿联中继挡着（已实测：不带令牌访问 `app-8898-<设备>.<域名>/__services` → 302 到 UGOS 登录），
**局域网侧现在没有任何防护**。

这是**主动取舍**，不是遗漏：用户明确说「不用担心安全问题，后面我会引入其他机制来保护这个的 现在可以直接开放」。
后续谁看到这条，别当成 bug 去补认证 —— 先去问外层的防护机制做到哪了。

## 验证

- `npx tsc --noEmit` 干净
- `npx vitest run` → 20 files passed / 1 skipped；**192 passed | 4 skipped (196)**
- `npm run smoke` → **SMOKE 29/29 => PASS**，**SMOKE(重启) 5/5 => PASS**
- 清扫过一遍 `src/`、`server/`、`docs/`（除 `docs/参考/`、`docs/归档/`），无残留凭据字段引用

## 未做

- **NAS 上还没换镜像**。线上跑的还是带认证的那版，客户端连过去也还能用（兼容壳就是为这个留的）。
  换镜像是下一步，碰 NAS 的每条命令要用户确认。
