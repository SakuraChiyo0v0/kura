# nas-mirror

外网 / 公司电脑**无感访问 NAS** 的工具集。

设计文档：[`../docs/nas-mirror-设计方案.md`](../docs/nas-mirror-设计方案.md)（含安全模型与实测记录）。

> **服务端（`server/`）的唯一维护位置就是本仓库** —— 原来的 `sso-gateway` 私有仓库已于
> 2026-09-14 归档（只作历史）。
>
> 服务端文件已于 **2026-09-16 与 NAS 对齐**：`server/nginx/conf.d/default.conf`、
> `server/nginx/conf.d/protected-prefix.inc`、`server/docker-compose.nas.yml` 三份都是
> **从线上取回、逐字节校验过**的（各自文件头记着字节数与 sha256 前 12 位）。
>
> `server/deploy/deploy.mjs` 与 `server/authelia/*.tpl` 是 M1 局域网 POC 时期的产物，
> **已于 2026-09-16 删除**（它们会把线上 nginx 配置换成只认 nas-hello 的旧版，并用 nip.io + 自签证书
> 重渲染 Authelia 配置；需要时从 git 历史里找回）。Authelia 那份配置的**真身在 NAS 上**
> （`<部署根>/sso-gateway/authelia/configuration.yml`，含密钥所以不入库）。
> 线上以 NAS 的 `<部署根>/sso-gateway/` 为准，改法见 `server/README.md` 与
> `skills/sso-gateway/SKILL.md`。

| 目录 | 内容 |
|-|-|
| `client/` | Go 客户端（本机端口镜像），产品代码 |
| `server/` | **服务端**：sso-gateway（nginx + Authelia 统一网关）+ 部署脚本 |
| `tools/` | 实测与验证脚本（Python），只服务于事实核查与回归，不是产品代码 |
| `skills/` | 操作手册：nas-mirror（本客户端）、sso-gateway（NAS 侧统一网关） |
| `docs/` | 设计文档（安全模型、链路选择、实测记录） |

---

## 客户端做什么

把 NAS 上**已发布到宿主端口**的服务镜像到本机回环地址，端口号保持一致：

```
本机应用 → http://127.0.0.1:8890 → nas-mirror → 绿联中继 → NAS 的 nas-console
```

应用不需要知道绿联、SSO cookie、认证流程的任何事；绿联链路的登录与会话续期全部由客户端负责。

## 三条安全红线（写在代码里，不靠自觉）

1. **只发起出站请求** —— 服务端与中继侧不存在任何能反向连到本机的通道。
2. **只监听回环地址** —— `listen_addr` 填非回环值会直接拒绝启动（`Config.validate`）。
3. **不跟随重定向** —— 中继会用 `302 → UGOS 登录页` 把"未认证"伪装起来；跟随了就永远发现不了失败。

这三条是"公司电脑上可以安全运行"的全部依据，改动前请先读设计文档 §2。

## 快速开始

```powershell
cd client

# 凭据：本机只存在于用户级环境变量（进程环境里没有），已设置过可跳过
[Environment]::SetEnvironmentVariable('UGREEN_USERNAME','<绿联账号>','User')
[Environment]::SetEnvironmentVariable('UGREEN_PASSWORD','<密码>','User')

Copy-Item config.example.json config.json

# 自检：登录 + 为每个端口建立会话，不启动监听
go run . --check --config config.json

# 构建并运行
go build -o nas-mirror.exe .
.\nas-mirror.exe --config config.json --verbose
```

跑起来之后，本机应用直接用 `127.0.0.1:<原端口>`：

```powershell
curl http://127.0.0.1:8890/                                  # nas-console
curl http://127.0.0.1:5244/                                  # openlist
curl -X PROPFIND http://127.0.0.1:18005/                     # WebDAV 列目录（服务端已不要求额外的凭据）
```

回归验证（需要客户端在跑）：

```powershell
python ..\tools\check_local.py --roundtrip
```

## 链路模式：局域网直连 / 外网中继 / 自动

即使你和 NAS 同处一个局域网，走绿联中继的流量也是 **NAS → 公网 → 中继 → NAS**。
所以客户端有两种链路，并可在运行时热切换：

| 模式 | 走法 | 实测延迟 | 适用 |
|-|-|-|-|
| `lan` | 直连 `nas_lan_host:<端口>`，不经过绿联 | **15–21 ms** | 在家 / 同局域网 |
| `wan` | 经绿联中继，需要绿联 SSO 会话 | **348–550 ms** | 在外面 |
| `auto`（默认） | 每 `lan_probe_seconds` 探一次局域网可达性，自动切 | — | 笔记本两地跑 |

**切换方式（立即生效，不用重启）**：

```powershell
.\nas-mirror.exe --mode lan    # 局域网直连
.\nas-mirror.exe --mode wan    # 外网中继
.\nas-mirror.exe --mode auto   # 交回自动探测
```

状态页上也点一下就能切。当前模式显示在状态页顶部与 `--status` 的第一行。

局域网模式不只是"换个地址"：它**完全跳过绿联那一层**（不需要绿联账号、不需要 SSO 会话），
只在走网关时还需要一次 Authelia 登录。所以切到 `lan` 之后会话数会变成 0，这是正常的。

> ⚠️ 一个踩过的坑，改这段代码前务必知道：局域网模式下**拨号地址是局域网 IP，
> 但发出去的 Host 头仍然是公网域名**。因为 Authelia 会校验请求 URL 的域名必须匹配它
> 配置的 `session.cookies[].domain`（只登记了公网域名），用局域网 IP 当 Host 会直接吃 401，
> Authelia 日志原话是 `no configured session cookie domain matches the url '...'`。
> 让后端看到的 Host 与外网模式完全一致，也顺带避免容器应用因 Host 变化而行为不同。

## 转发时附加请求头（可选）

客户端**不认识任何具体应用**——它是传输层。唯一与应用沾边的地方，是"可以按配置给某个服务的请求加上额外的头"，而这件事本身也是通用的：

```json
{ "port": 28006, "label": "webdav", "service": "webdav",
  "headers": { "Authorization": "Basic ${BASIC_AUTH}" } }
```

> 上面这个例子曾经是**必需**的（WebDAV 后端自己要求 Basic，客户端得代填）。**2026-09-23 起不再需要** ——
> 服务端把那层认证去掉了（容器只挂内网、由网关鉴权），客户端配置里连一条服务都不用留。
> 但"按配置加头"这个**能力**保留着：将来遇到"要求某个固定头的后端"，照上面写就行。

值里的 `${VAR}` 会展开。变量来源：**派生变量 → 进程环境变量 → Windows 用户级环境变量**。
目前只有一个派生变量：

| 变量 | 值 |
|-|-|
| `BASIC_AUTH` | `base64(UGREEN_USERNAME:UGREEN_PASSWORD)`，供 HTTP Basic 用 |

**调用方自己带了同名头时以调用方为准**，所以想用别的账号仍然可以。

典型用法就是上面这个：WebDAV 客户端（rclone / 映射网络驱动器）只要填 URL，不用配账号密码，也不用在 rclone 里跑 `obscure` 转码。

> **但这是配置的用法，不是客户端的知识。** 换成任何别的服务、加任何别的头，走的都是同一条路。
> 客户端里没有任何一行代码知道"WebDAV"这三个字——`Basic` 是 RFC 7617 的 HTTP 层方案，不是应用概念。

实测（2026-09-11）：不带凭据 `PROPFIND` → 207，`PUT`/`GET`/`DELETE` 往返字节一致；
带上一个**错误**的凭据 → 401（证明"调用方优先"确实生效）。

**1. 状态页（浏览器打开，推荐）**

```
http://127.0.0.1:8898/
```

页面分成三块：**顶部总览**（已运行 / 请求与失败 / 上下行流量 / 在监听几个）＋ 链路模式切换按钮、
**工具条**（搜索 · 全部/在用/已关闭 · 排序 · 暂停刷新），以及**服务卡片网格**
（宽屏 2–3 列、窄屏单列，每张卡一个服务）。筛选/搜索/排序/暂停会记在浏览器本地，整页刷新不会丢。

每张卡上有：

- **状态点 + 开关滑块**：绿=监听中、灰=已关闭、红=监听失败；拖一下**立即生效、不用重启**；
- **本机地址**（大一号蓝色，可点）+「复制」按钮；下面小一号灰色是**绿联外链**
  （`https://app-<宿主端口>-<设备>.cn30.ugdocker.link`，手机绿联 App 里"外部链接"那条），点开直达、不经网关。
  > ⚠️ 该外链能否用取决于那个宿主端口在 NAS 上**有没有发布**，客户端无法替你验证：绿联中继在检查端口之前就要求登录，
  > **任何端口（包括没发布的）都返回同一个 302**（拿故意关掉的 18005、随机没发布的 19999 做过对照）。
  > 所以它只是"绿联登录后可达"，不是"已验证可达"。
- **端口输入框**：改本机端口（关着的服务也能先改）；改动存在 `%USERPROFILE%\.nas-mirror\services.json`
  （**不动 `config.json`**），重启后依旧有效，想回默认值就删掉那个文件；
- **累计请求 / 失败 / ↑上行 / ↓下行**（1024 进制）；
  > ⚠️ 两个边界：**WebSocket** 升级之后字节由被接管的原始连接直接搬运、**不计入**；
  > 计的是代理实际收发的字节，若中继或应用做了压缩，下行不等于文件本身的大小。
- **最近 30 分钟趋势柱状图**：每分钟一柱、按窗口内峰值归一、失败叠红段，悬停给那一刻的具体数字
  （服务端算好几何、纯 SVG 渲染，**页面不引任何前端库**）；
- 错误与备注**只在有内容时显示**（旧版那列错误大多数是空的却一直占位）。

另外：顶部有**「立即同步」**（不等 5 分钟，立刻拉一次服务端清单）、**「暂停刷新」**与手动刷新。
每 5 秒自动刷新，但**正在输入、搜索框非空、或勾了暂停时不刷**（否则会把你打了一半的词冲掉、滚动位置也跳）。
页面跟随系统深浅色、只监听回环地址。

机器可读版本在 `/status.json`：含 group / note / enabled / running / listen_error、每服务的
`bytes_up` / `bytes_down`、趋势数组 `trend_requests` / `trend_errors`（长度 = `trend_buckets`，
每格 `trend_bucket_seconds` 秒，末尾是当前这一格），以及 `discovery` 段与 `refresh_ports`（排障用）。

**2. 命令行**

```powershell
.\nas-mirror.exe --status --config config.json
```

它向正在运行的实例要一份状态打印成表格（含每个服务的「监听中 / 已关闭 / 监听失败」与一列迷你趋势图
`▁▁▁▁█`）；如果客户端没在跑，会直接告诉你连不上。
状态页端口可用 `status_port` 改，写 `0` 关闭。

**错误计数只算真正的失败**：调用方自己断开（关标签页、取消下载、探测脚本超时）不计入，
也不打 WARN —— 这类请求在反代里同样以 `context canceled` 收场，早先会把它记成错误，
实测 306 条"代理失败"里有 302 条是这一类，状态页因此长期一片红。

## 凭据与「重建 vs 重启」（2026-10-13 事故补充）

**凭据只有一个来源**：NAS 侧 `<部署根>/sso-gateway/.env`（compose 的 `env_file` → 容器环境变量），本机侧用户级环境变量 `NAS_SSO_PASSWORD`。

**容器环境是创建时快照**：改完 `.env` 只 `docker restart` 不生效，必须 `docker compose up -d --force-recreate authelia`（entrypoint 启动日志里也会固定提醒这一行）。

**两端怎么确认是同一份凭据**：不看明文，看指纹。

- 客户端启动日志：`已启用统一网关 端口=8897 Authelia用户=<用户> 凭据="长度=<N> sha256前8=<xxxxxxxx>"`
- 容器启动日志：`sso-gateway: 凭据来源=ADMIN_PASSWORD 用户=<用户> 指纹=<xxxxxxxx> (口令指纹)`

> Kura 副本：原文里的真实用户名、口令长度与指纹已脱敏。

两个 `sha256前8` 不一致就是凭据发错了。明文不手打、不截图转述、不进对话。

**重建/重启 authelia 之后必须重启 nas-mirror**：旧会话作废后网关会返回 500（nginx 的 `auth_request` 子请求失败）或 200 + 门户页；客户端只在 401/302 时才作废重建，500 不会触发自愈。

**认证失败的两种处置**（客户端已实现，不需要人工判断）：

- 凭据类（401 / `status=KO`）：**停止自动重试**，冷却 10 分钟并打一条 ERROR；修好凭据后重启客户端即可恢复。
- 链路类（超时 / 5xx）：5s → 10s → … → 2min 台阶退避，退避窗口内一个请求都不发。

同一服务的「无法建立会话」日志按 1 分钟限频，避免刷屏把真正的告警淹掉。

状态页 `http://127.0.0.1:8898/status.json` 的 `auth` 字段会给出退避状态（`blocked/credential/reason/retry_at/fails`）；一切正常时该字段不出现。
## 当前形态与缺口（别期待它是一个装好的"应用"）

| 项 | 现状 |
|-|-|
| 程序形态 | 单个 `nas-mirror.exe` + `config.json` + 三个环境变量 |
| 界面 | 状态页（`http://127.0.0.1:8898/`）+ `--status`；**没有托盘图标、没有配置界面** |
| 开机自启 | **提供了脚本但没替你执行**：`install-autostart.ps1`（默认 -Hidden 不弹窗） |
| 日志 | 落盘到 `%USERPROFILE%\.nas-mirror\nas-mirror.log`，10 MB 轮转 |
| 安装 | **没有安装包**，拷贝 exe 与配置即可 |

开机自启（会注册一个 Windows 计划任务，登录时启动、崩溃自动重启）：

```powershell
cd nas-mirror
.\install-autostart.ps1 -Hidden      # 注册
.\install-autostart.ps1 -Uninstall   # 取消
```

剩下的缺口按价值排序：托盘图标 > 安装包。

## 服务清单：客户端不用抄一份服务列表（2026-09-23）

服务端在网关上暴露了一个受 Authelia 保护的 `GET /__services`（由 `server/gen-services.sh`
从 nginx 的 `map $svc_name` + `docker ps` 推导），客户端**默认会去拉它**：

- 启动时先按**上次拉到的缓存**挂载（服务端不可达也能用），随后每 `discover_minutes`（默认 5 分钟）同步一次；
- **新增的服务自动镜射到本机**：状态页/`--status` 的"来源"列标成 `服务端`（分组"服务端发现"）；
- **本地配置优先**：`config.json` 里显式写过的服务，端口以你写的为准（清单里推出来的值不覆盖它）；
- **只增不减**：清单里消失的服务**不会**被自动关掉 —— 生成脚本没重跑、或临时读不到，都不该让
  本机正在用的镜像停掉；要停就在页面上关掉它（关掉之后同步也不会再替你打开）；
- 拉取失败只记错误（状态页顶行写"服务端清单同步失败"，`/status.json` 里有 `discovery` 段），
  **不动任何正在跑的服务**；
- 想只按本地配置来：`config.json` 里写 `"discover": false`。

于是新机器的 `config.json` 只需要"怎么连上服务端"，服务列表交给服务端：

```json
{ "base": "https://<设备>.cn30.ug.link", "gateway_port": 8897,
  "nas_lan_host": "<NAS局域网IP>", "services": [] }
```

> **什么必须留在客户端**：需要"本地知识"的服务 —— 要加请求头的、要换本机端口的、想自己写显示名/分组/备注的。
> **本机现在是空的（`services: []`）**：12 个服务全部由服务端清单补齐 —— 2026-09-23 起连 WebDAV 也不需要
> 客户端代填凭据了（服务端把后端那层认证去掉了，见 `server/nas-webdav/docker-compose.yaml` 头部）。

> 本机端口：清单给"已发布到宿主的端口"；没发布的（只能走网关那种）退而用容器端口。
> 端口被占用时该服务会被跳过，并在状态页/`--status` 里写明原因，不会去抢别的服务的端口。

## watchdog：没有流量也能发现服务死了（2026-10-13 事故后加）

状态页上的请求数/错误数都是**按流量**统计的 —— 一个服务彻底死掉时恰恰没有任何请求，页面反而全绿（索引器静默停了 1 小时、视觉编码器被杀掉，都是这样没人发现）。所以客户端现在会**主动探测**：

- 默认每 60 秒，从**本机监听地址**探一遍所有已挂载服务（`GET /`），走完整链路：本机 → 客户端 → 会话 → 网关 → NAS。只有整条链路活着才算成功。
- HTTP < 500 都算活着（302/401/404 说明服务在应答），只有 5xx / 超时 / 连接失败才算不可用 —— 网关 `auth_request` 挂掉时正是 500。
- 连续失败 3 次 WARN、10 次 ERROR；恢复时 INFO，并给出中断时长。
- 状态页每个服务多了 `probe` 字段：`{ok, age_seconds, fail_streak, err, last_ok}`；刚启动还没探到时该字段不出现（比显示“未知”更诚实）。
- 配置：`probe_seconds`（不写默认 60 秒，显式写 0 关闭）。
## 配置

见 `config.example.json`：以 `_` 开头的键会被忽略，可直接当注释用。

| 键 | 说明 |
|-|-|
| `base` | NAS 设备域，形如 `https://<设备名>.cn30.ug.link` |
| `username` | 留空则取环境变量 `UGREEN_USERNAME`；**密码只从 `UGREEN_PASSWORD` 取，绝不写进配置文件** |
| `listen_addr` | 只允许回环地址 |
| `mode` | 链路模式：`lan` / `wan` / `auto`（默认） |
| `nas_lan_host` | NAS 的局域网地址；`lan` 与 `auto` 都要用它，不填则只能走外网 |
| `lan_probe_seconds` | `auto` 重新探测的间隔，默认 10 |
| `status_port` | 状态页端口，默认 8898；写 `0` 关闭 |
| `session_ttl_minutes` | 会话保守有效期，默认 15（中继侧约 20 分钟） |
| `refresh_minutes` | 后台主动续期间隔，默认 8 |
| `gateway_port` / `gateway_user` | 统一网关端口与 Authelia 用户名（密码取 `NAS_SSO_PASSWORD`） |
| `services[]` | **只留需要客户端本地知识的服务**（要加请求头、要换本机端口、或想自己写显示名/分组/备注）；其余交给服务端清单自动补齐。字段：`port`（NAS 宿主端口，同时是本机监听端口）、`label`、`service`（走网关时的注册名）、`group` / `note`（仅状态页展示）、`headers`（转发时附加的请求头，值支持 `${VAR}`）、可选 `local_port`、可选 `enabled`（默认 true）。**当前本机为空** —— 连 WebDAV 都不需要了 |
| `discover` | 是否启用"从服务端拉服务清单"（默认 true）。关掉就只按本文件的 `services[]` 来 |
| `discover_minutes` | 拉取间隔（分钟），默认 5 |

`port` **必须是已发布到 NAS 宿主的端口**：绿联按宿主端口生成外网入口，只在容器网络内部暴露的端口没有外网地址。

## 实测结论（M0，2026-09-11）

| 项 | 结果 |
|-|-|
| 中继延迟（直连，每次新建 TLS） | 230–300 ms/请求 |
| 中继延迟（经客户端，复用连接） | **38–72 ms/请求** |
| WebDAV 吞吐 | 上传 53 / 下载 55 Mbps；1 MiB 往返字节一致 |
| 会话隔离 | **严格按端口**：每端口一份 cookie，换端口即被踢回登录页 |
| 长期令牌 | **不存在**，`static_token` / `third_token` 均不可用 |
| `api_token` 有效期 | **约十几分钟**（`keepalive=false`：600 s 有效、1200 s 过期） |
| `keepalive=true` | **显著延长 token 寿命**，且不改变响应里其他任何字段；客户端已启用 |
| WebSocket 透传 | 客户端侧已由集成测试证明（101 + 双向回显）；**中继侧未证实** |

## 已知限制

1. **只支持 HTTP**。SSH(22) / SMB(445) / PostgreSQL(5444) 这类裸 TCP 过不去绿联中继。
2. 页面内写死的绝对 URL 不会被改写（`Location` 响应头已改写），可能把浏览器带到公网域名上。
3. **中继侧**是否支持 WebSocket 长连接未证实（**不是证伪**）。客户端自己的透传已由集成测试
   证明（101 升级 + 双向字节回显 + 会话 cookie 注入）；缺的是一个真实 WS 端点来验中继那一段。
   已扫过 6 个服务的 socket.io 握手与 4 个常见 WS 路径，**没有任何服务真的提供 WS 端点**，
   这条路已排除——需要时在 `nas-hello` 上加一个 WS 回显端点做可控实验。
4. 只能访问端口已发布到宿主的服务。
5. 客户端**必须持有账号密码**：`api_token` 只有十几分钟寿命，没有可长期保存的令牌。
   当前从 `UGREEN_PASSWORD` 读，尚未接入 Windows 凭据管理器（M2 补）。

## M2 统一网关：最终形态是"两条路并存"

网关（nginx + Authelia）**已经部署并可用**，但**收敛已被回滚** —— 各应用的宿主端口都发回来了。

| 通路 | 怎么走 | 谁在用 |
|-|-|-|
| **独立入口** | `https://app-<宿主端口>-<设备>.cn30.ugdocker.link`，绿联 SSO 门禁 | **手机绿联 App 的"外部链接"**、局域网直连、任何浏览器 |
| **网关（请求头）** | `X-Nas-Service: <服务名>` → Authelia 门禁 | 本客户端 |
| **网关（路径前缀）** | `https://app-8897-.../<服务名>/` | 浏览器，但**只有部分应用可用**（见下） |

为什么没有坚持收敛：**手机绿联 App 里的"外部链接"是按"端口有没有发布到宿主"自动生成的。**
删掉 `ports:` 就等于删掉了那些链接，而绿联 App 不可能发 `X-Nas-Service` 头，走不了网关。
这是硬性代价，不是实现细节 —— 详见图纸 `docs/nas-mirror-设计方案.md` 的 M2.6。

### 路径前缀能用与不能用（实测）

| 可用 | 白屏 |
|-|-|
| music-tag-web、webdav（原 nas-hello 也在其列，2026-09-11 已移除） | nas-console、openlist、account-panel、bili23-web、jmcomic-web、hermes |

白屏的原因：这些 SPA 的 HTML 里写死了 `/assets/...` 绝对路径，浏览器在 `/openlist/` 前缀下会去
入口根取 `/assets/...`，而那条路被"门户请求"接走、返回登录页。

复检命令：

```powershell
python ..\tools\check_prefix.py
```

> ⚠️ 写这类验证脚本时注意：SPA 对任何未知路径都会兜底返回 index.html，
> 所以**不能只看状态码**。判据必须是"取回来的是不是门户页"，
> 否则会把白屏误判成可用（这个坑我踩过）。

### 已知问题：hermes 的 8642

`app-8642-*` 显示 `500 failed to forward request`，因为 **hermes 容器内部根本没在 8642 上监听**
（宿主 `curl 127.0.0.1:8642` 返回 `000`）。端口发布正常，是应用自身的问题，
**与本次改动无关**（重建前后 command 与环境变量完全一致）。

### ✅ `sakura-pg` 的数据目录已对齐

原先运行中的容器挂的是**具名卷 `postgres_pgdata2`**，而 compose 声称用绑目录
`<部署根>/postgres/data` —— 谁跑一次 `docker compose up -d` 数据库就会被切走，
而 Authelia 的用户库就在这个库里。已按"以具名卷为准"修正声明，重建后三个库
（`authelia` / `postgres` / `sakura`）都在。

**规矩**：凡是网关要访问的容器，`sso-net` 必须在它**自己的 compose 里声明** ——
手工 `docker network connect` 加的成员身份，容器一重建就没了
（PG 和 nas-hello 都因此翻过车）。

在确认没有别处依赖之前，**不要删 NAS 上任何 docker 卷**。

