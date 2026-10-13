---
name: nas-mirror
description: 构建、配置与运维 nas-mirror 客户端（本机端口镜像，让外网/公司电脑上的应用像访问本机一样访问 NAS）。用于客户端编译运行、链路模式（局域网/外网/自动）切换、状态排查、日志与开机自启、以及"客户端为什么连不上"这类问题。NAS 本身的运维用 nas-ops；网关问题用 sso-gateway。
---

# nas-mirror 客户端

工作区根目录是本 skill 的 `../..`；**下文所有命令都从工作区根目录执行**，文件链接相对本 skill 目录解析。

代码在 `../../nas-mirror/client/`，说明见 `../../nas-mirror/README.md`，设计取舍见 `../../docs/nas-mirror-设计方案.md`。

## 它是什么

把 NAS 上**已发布到宿主端口**的服务镜像到本机回环地址，端口号保持一致：

```
本机应用 → http://127.0.0.1:8890 → nas-mirror → 绿联中继（或局域网直连）→ NAS 的 nas-console
```

应用不需要知道绿联、SSO cookie、Authelia 的任何事——这些认证全部由客户端代持。

**服务列表默认不用手抄**（2026-09-23 起）：客户端会从服务端的 `GET /__services` 拉服务清单
（受 Authelia 保护，由 `nas-mirror/server/gen-services.sh` 推导），把本地配置里没有的服务自动镜射出来。
所以"NAS 上新加一个服务"只需要在网关注册它 + 跑生成脚本，客户端这边最多等 `discover_minutes`（默认 5 分钟）。
合并规则：**本地配置优先**（端口以你写的为准）、**只增不减**（清单里消失不会自动关掉本机镜像）、
**拉不到就用上次缓存**。`config.json` 里写 `"discover": false` 可以关掉这件事。

## 什么时候用它

| 场景 | 用它 |
|---|---|
| 外网/公司电脑上的应用要访问 NAS 服务，且不想让应用碰认证 | ✅ |
| 想在局域网里避开绿联中继绕公网（延迟 348–550ms → 15–21ms） | ✅ |
| 手机浏览器直接打开某个 NAS 应用 | ❌ 用 `app-<端口>` 独立入口（见 **nas-external-link**） |
| 运维 NAS 宿主机 / Docker | ❌ 用 **nas-ops** |

## 三条安全红线（写在代码里，改代码时不要破坏）

1. **只监听回环地址** —— `listen_addr` 填非回环值会被配置校验拒绝启动。
2. **只发起出站请求** —— 服务端无法反向连到本机（这是"公司电脑上敢装"的全部依据）。
3. **不跟随重定向** —— 中继用 `302 → UGOS 登录页` 把"未认证"伪装成 200；跟随了就永远发现不了失败。

## 构建与运行

```powershell
cd nas-mirror\client
go build -o nas-mirror.exe .
Copy-Item config.example.json config.json
.\nas-mirror.exe --check --config config.json     # 自检：登录 + 逐端口建会话，不监听
.\nas-mirror.exe --config config.json --verbose  # 正式运行
```
凭据只从环境变量取（**绝不写进配置文件**）：

| 变量 | 用途 | 必需 |
|---|---|---|
| `UGREEN_USERNAME` / `UGREEN_PASSWORD` | 绿联账号 | 必需 |
| `NAS_SSO_USERNAME` / `NAS_SSO_PASSWORD` | Authelia 凭据（仅当客户端走网关时） | 走网关时必需 |

本机这几个变量在 **Windows 用户级**（进程环境里没有），所以客户端读注册表 `HKCU\Environment`。

## 链路模式

| 模式 | 走法 | 实测延迟 |
|---|---|---|
| `lan` | 直连 `nas_lan_host:<端口>`，**完全跳过绿联**（不需要 SSO 会话） | 15–21 ms |
| `wan` | 经绿联中继 | 348–550 ms |
| `auto`（默认） | 每 `lan_probe_seconds`（默认 10s）TCP 探一次，自动切 | — |

热切换，不重启：

```powershell
.\nas-mirror.exe --mode lan    # 也可 wan / auto
```

> ⚠️ 局域网模式下**拨号地址是局域网 IP，但 Host 头仍发公网域名**。Authelia 会校验请求 URL 的域名
> 必须匹配它配置的 `session.cookies[].domain`（只登记了公网域名），用局域网 IP 当 Host 会直接 401。
> 而且**代理转发和 Authelia 登录请求是两处**，都要改——只改前者仍然 401（踩过）。

## 转发时附加请求头（可选）

客户端**不认识任何具体应用**——它是传输层。唯一与应用沾边的地方，是"可以按配置给某个服务的请求加上额外的头"，而这件事本身也是通用的：

```json
{ "port": 28006, "label": "webdav", "service": "webdav",
  "headers": { "Authorization": "Basic ${BASIC_AUTH}" } }
```

`${VAR}` 的变量来源：**派生变量 → 进程环境变量 → Windows 用户级环境变量**。
目前只有一个派生变量 `BASIC_AUTH` = `base64(UGREEN_USERNAME:UGREEN_PASSWORD)`（供 HTTP Basic 用）。

**调用方自己带了同名头时以调用方为准**；查不到的变量**原样保留**（不悄悄变空串）。

> 2026-09-23 起，上面这个 WebDAV 例子**已经不需要了**：服务端把后端那层认证去掉（容器只挂内网、
> 由网关鉴权），所以 `config.json` 里一条服务都不用留（本机当前就是空的）。这个"按配置加头"的能力保留着，
> 将来遇到要求固定头的后端照写即可。

> 但这是**配置的用法，不是客户端的知识**。客户端代码里没有任何一行知道 "WebDAV" 这个词。
> 加别的服务、加别的头，走的是同一条路——这才是它能同时服务 10 个应用的原因。

## 查看运行状态

```powershell
.\nas-mirror.exe --status --config config.json   # 表格：服务 / 本机地址 / 经由 / 实际上游 / 请求 / 失败
```

浏览器状态页（每 5 秒自刷新，**仅回环可访问**）：`http://127.0.0.1:8898/`，机器可读版 `/status.json`。

## 日志与自启

- 日志默认落盘 `%USERPROFILE%\.nas-mirror\nas-mirror.log`，10 MB 轮转保留一份 `.1`。
  路径支持 `%VAR%` 与 `${VAR}` 展开（跨机同步的配置**不要写死用户名**）。
- 开机自启：`.\nas-mirror\install-autostart.ps1 -Hidden`（注册 Windows 计划任务，登录启动、
  崩溃自动重启），加 `-Uninstall` 取消。脚本会自己校验 exe 与配置是否存在。

## 排查

| 现象 | 判断与下一步 |
|---|---|
| 状态页里某服务"失败"数在涨，最后一次错误是 `errorPage` | 中继拒绝了该请求；看服务是否在服务端 `nginx map` 里注册过（**sso-gateway**） |
| 最后一次错误是"绿联会话已失效…已作废，请重试" | 中继判定未认证。客户端会自动重建会话，重试一次即可；持续出现则查 `api_token` 是否过期 |
| 所有服务都 502，错误里有 `Authelia 登录失败` | `NAS_SSO_PASSWORD` 缺失或错误；或客户端走网关而网关/Authelia/PG 有故障 |
| 端口被占用，启动日志有"本机端口绑定失败，跳过该服务" | 设计如此：一个端口被占用不拖垮其他服务。改 `local_port` 或腾出端口 |
| `--status` 报"连不上正在运行的客户端" | 客户端没在跑，或配置里 `status_port` 设成了 0 |
| 延迟明显偏高（数百毫秒） | 当前在 `wan` 模式。`--mode lan` 或检查 `nas_lan_host` / 探测为何失败 |

## 回归验证

```powershell
# 10 个服务经本机客户端是否都可用（含 1 MiB WebDAV 二进制往返）
python nas-mirror\tools\check_local.py --roundtrip
```
