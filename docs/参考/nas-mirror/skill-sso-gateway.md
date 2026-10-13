---
name: sso-gateway
description: 运维 NAS 上的统一认证网关（nginx + Authelia，宿主 8897），按请求头或路径前缀把请求分流到各容器并统一鉴权。用于新增受网关保护的服务、排查 502/401、调整 Authelia 策略、以及理解"为什么某个入口打不开"。绿联外网链路本身见 nas-external-link；客户端见 nas-mirror。
---

# 统一网关（sso-gateway）

**下文路径一律相对工作区根目录（`NAS-PROJECTS`）**，命令也从那里执行。

**线上配置以 NAS 上的 `<部署根>/sso-gateway/` 为准。** 仓库里的 `nas-mirror/server/` 已于
2026-09-16 与线上对齐：`nginx/conf.d/default.conf`、`nginx/conf.d/protected-prefix.inc`、
`docker-compose.nas.yml` 三份都是从线上取回、逐字节校验过的（文件头记着字节数与 sha256 前 12 位）。
M1 时期的 `deploy/deploy.mjs` 与 `authelia/*.tpl` **已删除**（它们会把线上 nginx 配置换成只认 nas-hello
的旧版、并用 nip.io + 自签证书重渲染 Authelia 配置；需要时从 git 历史里找回）。
Authelia 的 `configuration.yml` **不在仓库里**（含密钥），真身在 NAS 上。
改配置没有一键脚本，流程是「改仓库 → 传到 NAS → `nginx -t` → `nginx -s reload`」，
详见 `nas-mirror/server/README.md`；当年为什么会不一致见
`docs/归档/2026-09-16 nas-mirror 服务端配置与仓库不一致.md`。

| 项 | 值 |
|---|---|
| 入口 | `https://app-8897-<设备>.cn30.ugdocker.link`（宿主 8897 → nginx 容器 80，**由绿联外层终结 TLS**） |
| 组件 | `nginx:alpine`（单入口 + `auth_request`）+ `authelia/authelia:4.39.20` |
| 网络 | `sso-net`（external，所有受保护容器都必须接入） |
| 存储 | `sakura-pg` 的 `authelia` 库 |
| 用户库 | 容器启动时由 `entrypoint.sh` 用 `ADMIN_PASSWORD` 生成 argon2id 哈希写入 |

## 两条分流通路（并存）

| 通路 | 怎么走 | 谁在用 |
|---|---|---|
| **请求头** | `X-Nas-Service: <服务名>` | nas-mirror 客户端 |
| **路径前缀** | `https://<入口>/<服务名>/...` | 浏览器，**只有部分应用可用** |

两条路都过 Authelia —— 这是网关存在的全部意义，**不要为省事给任何一条开 bypass**。

## 线上实现里几个容易漏掉的点（2026-09-16 从线上配置逐条核对）

- **`client_max_body_size 20g` 写在 `server` 级**。nginx 默认只有 1m，经网关传任何大于 1 MiB 的文件都会
  413；又因为客户端带 `Expect: 100-continue`，`curl` 的 `%{http_code}` 会显示成 `100`，极难看出真因。
  新增文件类服务不用管，它已经在 server 级生效。
- **`webdav` 的后端是 `http://nas-webdav:18005`**（rclone 容器）。
  **2026-09-23 起它只挂 `sso-net`、不发布任何端口、也不设自己的认证**：宿主上没有任何监听，
  局域网与绿联中继都摸不到（实测宿主 `curl <NAS局域网IP>:18005` → `000`），认证只剩边缘那两层 ——
  **外部（客户端、浏览器）对 WebDAV 那层认证完全无感**，nas-mirror 不用再代填 Basic。
  暴露范围**由过滤器决定**（2026-09-24 最终形态）：容器挂整个 `/`，但只读
  `/cfg/filters.txt`（files-admin 页面生成，三段：排除 → 放行 → 兜底 `- /**`）。
  ⇒ **看不到什么由过滤器保证，不由挂载保证**：要暴露 `/etc`、`/root` 只需在页面上勾一下。
  这条边界是**刻意放开的**（用户明确要求"能勾任何目录"），底线是网关认证 + `audit.log`；
  `/proc /sys /dev` 仍在容器里用 tmpfs 掩成空目录（否则 `-L` 会沿 `/proc/self/root/…` 无限递归）。
  编排见 `nas-mirror/server/nas-webdav/docker-compose.yaml`。
  代价（明确接受）：无认证 + 同网络 ⇒ `sso-net` 上其它容器也能无凭据读写这两个目录；
  想收紧就给它单独一条网络、只让网关加入。
  （旧形态是 host 网络 + 绑 `<NAS局域网IP>:18005` + WebDAV 自带 Basic：那是为了躲中继，
  代价是写死 IP、换 IP 静默 502，且"未认证"是三层认证里最弱的一环。）
- **路径前缀的兜底是 `return 418` → `@portal`**：解析不出服务名就当门户请求转给 Authelia。
  白名单 map 缺一项的后果不是 404 而是"变成登录页"，容易误判成会话问题。
- **`hermes` 多一条 `proxy_redirect`**：它未登录时跳自己的 `/login` 且发绝对 URL，不重写就会甩掉 `/hermes/`
  前缀、跑到入口根上。新增这类"会自己跳转的应用"时要照抄这一条。
- **WebSocket 透传靠三行 map/头**（`$connection_upgrade` + `Upgrade`/`Connection`），`proxy_buffering off`、
  读写超时 3600s —— 少了任何一项，长连接应用会在网关这里静默断。

## 新增一个受保护服务（三处 + 一步）

> 现成例子（2026-09-24 加的）：**`files-admin`** —— WebDAV"暴露哪些目录"的勾选页面。
> 它同时演示了两件事：① 三处登记照抄即可；② **服务容器只挂 `sso-net`、不发布宿主端口**，
> 认证全靠本网关。见 `nas-mirror/server/files-admin/`。

1. 在 `nginx-default.conf` 的 **`map $svc_name $svc_backend`** 里加一行 `"服务名" "http://容器名:端口";`
   （注意是**容器内端口**，不是宿主端口——例如 bili23-web 是 `8787` 而非 `8788`）
2. 在同文件的 **`map $uri $svc_from_path`** 里加一行 `~^/服务名(/|$) "服务名";`
   （**这条是白名单**，见下方坑 1；`hermes-api` 这类前缀重合的要排在短的之前）
3. 在 **`location /服务名/`** 加一块（照抄已有的：`set $backend` + `include protected-prefix.inc`
   + `rewrite` 剥前缀 + `proxy_pass $backend`），以及一个 `location = /服务名 { return 301 /服务名/; }`
4. 把该容器**声明式**接入 `sso-net`（写进它自己的 compose，别用 `docker network connect`），然后：

```bash
# 4.1 重新生成「服务清单」—— nas-mirror 客户端靠它自动发现服务，加了服务别忘了这一步
<部署根>/sso-gateway/gen-services.sh

# 4.2 先校验语法，通过才 reload
docker exec sso-gateway-nginx-1 nginx -t
docker exec sso-gateway-nginx-1 nginx -s reload
docker exec sso-gateway-authelia-1 ...            # 改 Authelia 配置后需要重启该容器
```

生成的清单可以用 `GET /__services` 读到（**受 Authelia 保护**：浏览器登录后能看到，
客户端用它拉服务列表）。两个实测约束别踩：接口片段**不能**用 `return`（rewrite 阶段会绕过
`auth_request`）、数据文件必须放进**容器内**（宿主挂载的目录 worker 读不到）。
详见 `nas-mirror/server/README.md` 与 `nas-mirror/server/gen-services.sh` 头部注释。

## 踩过的四个坑（改这套配置前必读）

**坑 1：路径前缀必须是白名单，不能"取第一段当服务名"。**
写成通用捕获后，Authelia 自己的 `/api/firstfactor`、`/static/…` 也会被解析成服务名 `api`，
于是被送进应用分支、查不到后端 → **404，整个门户登不进来**。

**坑 2：nginx 的 `resolver` 不读 `/etc/hosts`。**
`proxy_pass` 用变量时（本配置为了分流必须用变量），nginx 用 `resolver`（Docker 内置 DNS）解析，
而内置 DNS **不认识** `host.docker.internal` —— 那只是 `extra_hosts` 写进容器 `/etc/hosts` 的。
写域名会得到 `host.docker.internal could not be resolved` 并返回 502。
**必须写 IP 字面量。** 取哪个 IP 看需求：`172.17.0.1`（Docker 默认网桥网关 = 宿主机，不随局域网 IP 变化）
或局域网 IP。不过 **2026-09-23 起 `webdav` 已改用容器名 `nas-webdav:18005`** —— 因为后端改成只挂
`sso-net`、不发布宿主端口了（容器名由 Docker 内置 DNS 解析，不再需要 IP、也不再怕换 IP）。

**坑 3：`auth_request` 会把客户端的 `Authorization` 头带进鉴权子请求。**
WebDAV 客户端带 `Authorization: Basic <NAS账号>`，Authelia 会拿它当**自己的** Basic 凭据去查用户库，
库里只有 `<网关用户>`、没有 `<用户A>` → 整个鉴权失败，哪怕会话 cookie 完全有效。Authelia 原话：

```
failed to validate Authorization header with basic scheme:
failed to retrieve user details for user <用户A>: user not found
```

修法：在 `location = /internal/authelia/authz` 里加 `proxy_set_header Authorization "";`。
这个 Basic 凭据属于后端 WebDAV，与 SSO 层无关。

**坑 4：`protected-prefix.inc` 的后缀不能是 `.conf`。**
主 `nginx.conf` 是 `include /etc/nginx/conf.d/*.conf;`，用 `.conf` 会被通配符二次包含、直接报错。

## Authelia 的两个硬约束

1. **它要求请求 URL 的域名匹配 `session.cookies[].domain`**，否则直接 401，日志原话：
   `unable to retrieve session cookie domain provider: no configured session cookie domain matches the url '...'`。
   所以局域网模式下拨号用局域网 IP、但 **Host 头必须是公网域名**。
2. **`access_control` 只有 `default_policy: 'one_factor'`，没有任何按路径的规则**，
   这是刻意的：经 `authz` 的请求都是应用请求，而应用自己也有 `/api/` 路径（如 nas-console），
   一旦写 `resources: ['^/api/']` 的 bypass 就等于给鉴权开天窗。

## 验证

```powershell
# 走真实绿联链路：登录 Authelia + 访问受保护应用（凭据经 SSH 从 NAS 的 .env 读取，不打印）
python nas-mirror\tools\check_gateway.py --service nas-console

# 路径前缀下浏览器能不能真用（判据是"取回来的是不是门户页"，不是状态码）
python nas-mirror\tools\check_prefix.py
```

`check_gateway.py` 期望看到：门户 200 → 未登录 302 跳登录 → 未知服务名 404 → 登录 `status=OK` →
拿到 `authelia_session` → 带会话访问 200。

## 已知限制

- **路径前缀对 SPA 无效**：SPA 的 HTML 里写死 `/assets/...`，子路径下浏览器会去入口根取，
  而那条路被"门户请求"接走、返回登录页 → 白屏。实测可用的是 music-tag-web 与 webdav
  （原在列的 nas-hello 已于 2026-09-11 移除）。**别凭这段话记，用下面的 `check_prefix.py` 现测**。
  `sub_filter` 改写也救不了（JS 包里的 `fetch('/api/...')` 改不到，会"页面能开、功能全坏"）。
- **不要让网关上依赖任何单个应用**：它是单点，网关挂 = 所有走网关的客户端一起挂。
  各应用仍有独立的 `app-<端口>` 入口，那条路不受网关影响。
- `hermes` 的 8642 端口一直是 500 —— 容器内部根本没在 8642 上监听，与网关无关。

## 回滚

NAS 上每个被改过的文件都有 `.m2bak` 备份：

```bash
ls <部署根>/sso-gateway/*.m2bak <部署根>/sso-gateway/nginx/conf.d/*.m2bak \
   <部署根>/sso-gateway/authelia/*.m2bak
```

**彻底拆掉网关**：停掉 `sso-gateway-nginx-1` 与 `sso-gateway-authelia-1` 即可，
其余服务的独立入口不受影响（前提是它们的 `ports:` 已恢复）。
