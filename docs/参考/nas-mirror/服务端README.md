# sso-gateway

> **现状（2026-09-16）**：网关已按表里的形态在 NAS 上运行，本目录与线上是这样对应的——
>
> | 文件 | 状态 |
> |-|-|
> | `nginx/conf.d/default.conf` | ✅ **已与线上逐字节对齐**（2026-09-16 取回校验） |
> | `nginx/conf.d/protected-prefix.inc` | ✅ 同上（本次新增，之前仓库里根本没有它） |
> | `nginx/conf.d/services-list.inc` | ⚙️ **生成物**：`/__services` 接口片段，由 `gen-services.sh` 写，别手改 |
> | `gen-services.sh` | 🛠️ 服务清单生成脚本（从 nginx map + `docker ps` 推导，见下） |
> | `nas-webdav/docker-compose.yaml` | 📦 **另一个服务端的编排**：把 `/volume1` 与 `/home` 两个数据目录以 WebDAV 暴露（rclone 容器）。只挂 `sso-net`、不发布端口、**不设自带认证**（认证由网关在边缘完成）；**系统树不在容器里**（2026-09-23 两次变更：先去掉认证，再改成只挂数据目录，见文件头与设计方案 §7.1） |
> | `files-admin/` | 🎛️ **WebDAV 暴露哪些目录的勾选页面**（Go；服务端组件）。只写 `filters.txt`、不碰 docker；重启 nas-webdav 由宿主 systemd path 单元做。见该目录 README |
> | `docker-compose.nas.yml` | ✅ 同上（上传到 NAS 时改名 `docker-compose.yaml`） |
> | `authelia/entrypoint.sh` | ✅ 线上 compose 正在用它（启动时按 `.env` 生成 `users_database.yml`） |
> | `deploy/deploy.mjs`、`authelia/*.tpl` | 🗑️ **已于 2026-09-16 删除**：M1 局域网 POC 遗留，会把线上 nginx 配置换成只认 nas-hello 的旧版、并用 nip.io + 自签证书重渲染 Authelia 配置。需要时从 git 历史里找回 |
> | `authelia/configuration.yml` | ❗**不在仓库里**（含 jwt/session/encryption 密钥与 PG 密码，`.gitignore` 也挡着）：真身在 NAS 上 |
> | `.env.example` | 线上 `.env` 在 NAS 上（root 600，不进仓库）；示例只列它真正需要的三个变量 |
>
> **线上以 NAS 的 `<部署根>/sso-gateway/` 为准。**
>
> **改配置的正确流程**（没有一键脚本，就是「改仓库 → 传上去 → 校验 → reload」）：
>
> ```bash
> # 1. 把改好的文件传到 NAS（经 nas-console 的 /api/exec，或 SSH 进去；不要用 scp，绿联上受限）
> #    <部署根>/sso-gateway/nginx/conf.d/ 、.../authelia/ 、.../docker-compose.yaml
> # 2. 先校验语法，通过才 reload —— 顺序不能反
> docker exec sso-gateway-nginx-1 nginx -t
> docker exec sso-gateway-nginx-1 nginx -s reload
> #    改的是 authelia/configuration.yml 或 compose 时：
> docker compose -p sso-gateway --project-directory <部署根>/sso-gateway up -d
> # 3. 用真实链路验一遍
> python ../tools/check_gateway.py --service nas-console
> ```
>
> 每个被改过的文件在 NAS 上都有 `.m2bak` 备份，回滚就是拷回去再 reload。
> 操作手册看 `../../skills/sso-gateway/SKILL.md`；这次对账的来龙去脉见
> `../../../docs/归档/2026-09-16 nas-mirror 服务端配置与仓库不一致.md`。
>
> **服务清单接口（`/__services`，2026-09-23 加）** ——给 nas-mirror 这类客户端"拉服务列表"用，
> 让客户端不必再手抄一份 `services[]`：
>
> ```bash
> # 网关里加了服务之后：重跑生成脚本 → 校验 → reload
> <部署根>/sso-gateway/gen-services.sh
> docker exec sso-gateway-nginx-1 nginx -t && docker exec sso-gateway-nginx-1 nginx -s reload
> # 客户端侧（带 Authelia 会话）就能拿到：
> curl -H 'Host: app-8897-<设备>.cn30.ugdocker.link' http://127.0.0.1:8897/__services
> ```
>
> 清单由 `gen-services.sh` 从**两处已有事实**推导：nginx 的 `map $svc_name`（服务名 → 容器:端口）
> 与 `docker ps` 的端口映射（容器端口 → 宿主端口、有没有发布）。产出两样：
> `nginx/conf.d/services-list.inc`（接口片段）与 `services.json`（给人看）。
>
> 三个**实测踩出来的约束**，别改回去：
>
> 1. **接口片段里不能用 `return 200 '<json>'`**：`return` 在 rewrite 阶段执行，会抢在
>    `auth_request`（access 阶段）之前 —— 无会话也能拿到清单，鉴权形同虚设。
>    必须让内容由内容阶段产生（当前用 `alias` 指向数据文件）。
> 2. **数据文件不能放在宿主挂载目录里**：`<部署根>/sso-gateway` 是 700，挂载进容器后
>    nginx 的 worker（uid 101）**连 777 的 default.conf 都读不到**（容器内文件却正常）。
>    所以脚本用 `docker cp` 把它放进容器自己的 `/etc/nginx/services.json`。
> 3. **容器重建后要重跑生成脚本**：那份数据文件在容器层，`compose up` / watchtower 重建就没了
>    （接口会 404，不会打挂别的）。所以"重建容器"之后的固定动作是：跑脚本 → `nginx -t` → reload。
>
> —— 以下正文是 **M1 局域网 PoC 时期的手册，已过时**，只作历史参考（入口是 `sso.<IP>.nip.io` 自签、
> 只有 nas-hello、`NAS-PROJECTS/sso-gateway/.env` 之类的路径也都不存在了）。
> **下文提到的 `deploy/deploy.mjs` 与 `authelia/*.tpl` 文件本身已于 2026-09-16 删除**（git 历史里可找回），
> 所以下面凡是"跑 `node deploy/deploy.mjs`"的步骤都不要再执行。

NAS 统一登录网关(M1 PoC):Authelia + nginx forward-auth + PostgreSQL 存储。
设计文档见 `NAS-PROJECTS/docs/sso-spec.md`。

## 拓扑(局域网 TLS 默认, 公网可切换)

```
浏览器 https://sso.<NAS局域网IP>.nip.io:8897   (nip.io 免改 hosts 解析到 NAS 局域网 IP)
   │
   ▼  nginx (容器内 443, 自签证书; 宿主 8897 -> 443)   ← TLS 由网关自己终结
   ├── /            → authelia:9091(门户/登录页, 公开)
   └── /nas-hello/  → auth-request 鉴权 → 通过后转发 nas-hello:3000
                         │ 未登录: 302 → 门户登录 → 回跳原地址
```

- **为什么局域网也要 https + 域名**:Authelia 的会话 Cookie 必须是 `Secure` 且 `Domain` 为含点的域名(不能是 IP/`localhost`),`authelia_url` 也必须是 https。所以开发阶段用 **`sso.<NAS_LAN_IP>.nip.io`**(公共 DNS 通配解析,免改 hosts)作为入口域名,网关内 nginx 自己用**自签证书**终结 TLS。
- **Cookie 只作用在 `sso.<NAS局域网IP>.nip.io` 这一个具体域名**(host-only),绝不设父域 `.ugdocker.link`(绿联共享域,会串号)。以后要接公网域名时,只需改 `.env` 的 `GATEWAY_HOST/URL` 并重建,会话互不影响。
- **单入口**:只有 nginx 的 8897 暴露;Authelia 不发布端口,只在 `sso-net` 内网。
- **存储**:复用 NAS `sakura-pg`(postgres:18),独立库 `authelia` + 专用账号 `authelia`。
- **用户**:Authelia 文件用户库(`authelia/users_database.yml`,argon2id),本期内置管理员。

## 目录

```
sso-gateway/
├── docker-compose.nas.yml        # 部署 compose(上传到 NAS 时改名 docker-compose.yaml)
├── .env.example                  # 变量样例(真实 .env 被 gitignore)
├── authelia/
│   ├── configuration.yml.tpl     # 配置模板(__PLACEHOLDER__ 由部署脚本渲染)
│   └── users_database.yml.tpl    # 用户库模板(密码 hash 由 authelia CLI 生成)
├── nginx/conf.d/default.conf     # 网关路由 + auth-request(443 ssl)
├── certs/                        # 自签证书(部署脚本生成, gitignore)
└── deploy/deploy.mjs             # 一键部署(渲染+证书+上传+建库+起服务)
```

## 部署(NAS 端)

前置(仅首次,部署脚本会自动执行,列出来供手工参考):

```bash
sudo docker network create sso-net
sudo docker network connect sso-net nas-hello   # 让网关能转发到被保护应用
sudo docker network connect sso-net sakura-pg   # 让 authelia 能连 PG
```

一键部署(Windows 本机,需 node + ssh2 + NAS 凭据):

```bash
cd NAS-PROJECTS/sso-gateway
cp .env.example .env        # 改 NAS_LAN_IP; 敏感值缺省自动随机生成
node deploy/deploy.mjs <NAS局域网IP>
```

脚本做的事:
1. 读取 `.env`;若 `GATEWAY_HOST/URL` 仍是旧版公网 `app-<port>-...ugdocker.link` 或缺失,自动切到 `sso.<NAS_LAN_IP>.nip.io`;
2. 生成本机自签证书(`certs/server.crt|key`,SAN 含 `sso.<IP>.nip.io`/`sso.lan`/NAS IP;已存在则复用);
3. sakura-pg 建库/角色 `authelia`(幂等)并设强密码;
4. 用 authelia CLI 生成管理员 argon2id 密码 hash;
5. 渲染 `configuration.yml` / `users_database.yml` 并上传到 `<部署根>/sso-gateway/`;
6. 上传 nginx 配置、compose、证书(目录 root:root 700,UGOS UI 规范);
7. `docker compose up -d --force-recreate`(宿主 8897 -> 容器 443)。

> 说明:本 PoC 用 CLI compose 直接部署在宿主 8897。UGOS Docker UI 的 `app-<port>...ugdocker.link`
> 公网隧道只给 UI 里创建的 compose 项目自动生成,局域网开发不需要它;容器在宿主 `0.0.0.0:8897`
> 已可访问。以后要公网,再到 UGOS UI 建项目导入同一 compose。

## M1 验证清单

入口:`https://sso.<NAS局域网IP>.nip.io:8897`

1. 未登录访问 `/nas-hello/` → 302 到门户,登录后**回跳** `/nas-hello/` 并返回 JSON;
2. 登出后再访问 `/nas-hello/` → 再次要求登录;
3. 命令行自测:`curl -k https://sso.<NAS局域网IP>.nip.io:8897/api/state`(自签证书需 `-k`)。

首次浏览器访问会提示"证书不受信任":开发自用直接点"继续前往"即可;
或把 `certs/server.crt` 装进系统信任根(需管理员)消除提示。
若 NAS 局域网 IP 变化,改 `.env` 的 `NAS_LAN_IP` 并重新 `node deploy/deploy.mjs`。

## 改管理员密码(compose 方式)

密码的**唯一来源**是 NAS 项目目录的 `.env`(`<部署根>/sso-gateway/.env`,root 600),compose 通过 `env_file` 读 `.env` 把 `ADMIN_PASSWORD` 注入 authelia;容器每次启动自动用官方 CLI 生成 argon2id 哈希写用户库,不需要手动改哈希。

```bash
# 1. SSH 到 NAS
sudo nano <部署根>/sso-gateway/.env      # 改 ADMIN_PASSWORD=新密码
# 2. 重建 authelia(entrypoint 会自动重新生成哈希)
cd <部署根>/sso-gateway
sudo docker compose -p sso-gateway up -d --force-recreate authelia
```

> 用户名/邮箱/显示名来自项目目录 `.env`(`ADMIN_USER`/`ADMIN_EMAIL` 必填;`ADMIN_DISPLAYNAME` 可选,默认同用户名);compose 与仓库文件里不写死个人信息。
> 注意:如果之后跑 `node deploy/deploy.mjs`,它会用**本机** `NAS-PROJECTS/sso-gateway/.env` 的 `ADMIN_PASSWORD` 覆盖 NAS 端 `.env`,两边要保持一致。
> 这也是历史遗留的**两个写入方**(部署脚本 + entrypoint 现算),2026-10-13 事故的直接成因就是三处凭据各说各话。稳态下只认 NAS 端 `.env` 一处;要么把部署脚本改成不下发凭据,要么两边一起改并重启客户端验证指纹一致。
## 凭据来源与「重建 vs 重启」（2026-10-13 事故补充）

**单一来源**：`<部署根>/sso-gateway/.env`。compose 的 `env_file` 把它注入容器环境变量，`entrypoint.sh` 每次启动据此重写 `/config/users_database.yml`。

**容器环境是创建时快照**：改完 `.env` 后必须 `docker compose -p sso-gateway up -d --force-recreate authelia`；`docker restart` 不刷新环境变量（entrypoint 启动日志里也固定提醒这一行）。

**两种凭据模式**：

- `ADMIN_PASSWORD_HASH`（推荐）：直接给 argon2id 哈希，容器环境里可以完全没有明文口令；轮换密码时重新生成哈希即可。
- `ADMIN_PASSWORD`（当前在用）：启动时用官方 CLI 现算哈希。

生成哈希：`authelia crypto hash generate argon2 --password '...' --no-confirm`。

**启动指纹**：容器每次启动打印 `sso-gateway: 凭据来源=… 用户=… 指纹=<sha256前8> (口令指纹) users_database.yml=N字节`，与 nas-mirror 客户端启动日志里的 `sha256前8` 对照即可确认两端是同一份凭据（不比对明文、不靠截图转述）。

**重建/重启 authelia 之后要重启 nas-mirror**：旧会话作废会让网关返回 500（nginx `auth_request` 子请求失败）或 200 + 门户页；客户端只在 401/302 时自愈，500 不触发。

**先看 authelia 自己的日志**：`is not authorized to user <anonymous>, responding with status code 401` 说明会话不被认，而不是容器没起来。

**不需要 reload nginx**：nginx 是动态解析 upstream 的。早前误判为「nginx 缓存了旧 IP，重建 authelia 后必须重载」，实测 nginx 容器未重启也会自行恢复，已纠正。
## SSO 挂了怎么自救（2026-10-13 事故后固化）

**先在 UGOS 终端跑这三条定位**（终端在 Docker 与 SSO 之外，网关全挂时它照样能进）：

```sh
docker ps -a --filter name=sso-gateway --format '{{.Names}}|{{.Status}}'
docker logs sso-gateway-authelia-1 2>&1 | grep -a 'sso-gateway:' | head -3   # 凭据来源与指纹
docker logs sso-gateway-authelia-1 2>&1 | tail -20                            # 起不来/会话被拒的真实原因
```

**按现象处置**：

| 现象 | 真实原因 | 处置 |
|-|-|-|
| 所有服务返回 500（nginx 页） | authelia 没起来，或会话不被认 | `docker restart sso-gateway-authelia-1`，然后**重启本机 nas-mirror** |
| 返回 200 但内容是门户登录页 | 同上（会话已作废） | 同上 |
| 登录报文 401 `status=KO` | 容器环境里的口令与客户端发的不一致 | 对比两端指纹（见上节），改 `.env` 后 `--force-recreate authelia`，再重启客户端 |

**一条铁律：重建/重启 authelia 之后必须重启 nas-mirror** —— 旧会话作废后客户端只在 401/302 时自愈，500 不会触发。

**不设 bypass**：`nginx/conf.d/default.conf` 的既定原则是「两条通路都必须经过 Authelia」。救援靠终端 + 上面这张表，不靠开后门。
## 公网接入(以后别人用, M2/M3 再做)

局域网只是开发模式,**不是锁死**。以后要公开给其他人访问,入口域名/TLS 归属会变,但网关、
用户库(PG)、会话体系完全不变,切换只动两处:

1. **改 `.env` 为公网域名**(部署脚本对显式值一律保留,不会改回局域网):
   - 走 UGOS `app-<port>` 隧道:`GATEWAY_HOST=app-8897-<设备>.cn30.ugdocker.link`、`GATEWAY_URL=https://...`;
   - 或以后你有自己的域名/反代,填那个域名即可。
2. **改 compose 端口映射**:`8897:443` → `8897:80`(由 UGOS/反代在外层终结 TLS 后回源到容器 80;
   nginx 已同时 `listen 80; listen 443 ssl;`,配置文件不用动)。
3. `node deploy/deploy.mjs` 重部署。

要点:
- **UGOS 公网隧道只对 UI 里创建的 compose 项目生成**:上公网时到 UGOS Docker UI 用同一份 compose 建项目(或让 UI 托管),不要只用 CLI 起。
- Cookie 仍是该公网域名 **host-only**,绝不设父域 `.ugdocker.link`(绿联共享域,会串号);想多域名共存再按 Authelia 多 cookie domain 配置。
- 自签证书只在局域网直连(443)时用;公网走 UGOS/反代时由外层提供可信证书。

## 接入下一个应用(M2 参考)

1. 把应用加入 `sso-net`:`sudo docker network connect sso-net <app>`;
2. nginx `default.conf` 加 `location /<app>/ { auth_request ...; proxy_pass ...; }`;
3. Authelia `configuration.yml` access_control 加对应 `path` 规则;
4. 关闭该应用原有端口发布(防绕过),restart 生效。

## 运维与安全注意

- **Authelia 与 nginx 都标了 `watchtower.enable=false`**:M1 期避免自动升级导致配置漂移,稳定后放开并跟进 4.4x 配置变更。
- **nas-hello 原 8899 端口仍可达**(M1 暂不动它);M2 收敛:去掉 8899 发布、只经网关访问。
- Cookie/Session:HttpOnly + Secure(https)+ SameSite=Lax;过期 12h、闲置 2h。
- `.env` 与渲染产物(authelia/configuration.yml、users_database.yml)、`certs/server.key` 含敏感内容,**禁止提交**。
- 登录限流在 Authelia `regulation`(5 次/2 分钟 → 封 5 分钟)。
