# kura-server 设计（草案，待用户过目）

把 NAS 侧的 sso-gateway（nginx + Authelia）、nas-webdav（rclone）、files-admin、nas-console 合成**一个服务**：
一个 compose、一份 `.env`、一个对外端口。客户端只有 Kura，服务端只有 kura-server。

已定（2026-10-14，用户「按推荐来」）：
- 一个 compose 里**两个容器**：对外的 `kura-server`（普通权限）+ 只在内部网络上的 `kura-shell`（特权，终端与 exec）
- WebDAV 第一阶段**沿用 rclone**（作为子进程），范围检查由 TS 层在前面做
- 代码放 Kura 仓库的 `server/`，与客户端共用范围规则与协议定义

## 一、结构

```
绿联中继 / 局域网 ──► 宿主 :8897
                        │
              ┌─────────▼──────────────────────────────┐
              │ kura-server（普通容器）                 │
              │  认证（单用户，argon2id）               │
              │  反代：X-Nas-Service / 路径前缀 → 应用  │
              │  /__services 清单                       │
              │  WebDAV 范围层 ─► rclone 子进程(回环)   │──► 宿主 /（只读或读写挂载）
              │  管理页（暴露范围、服务清单、状态）     │
              └─────────┬──────────────────────────────┘
                        │ kura-internal 网络（不发布端口）
              ┌─────────▼──────────┐
              │ kura-shell（特权）  │  PTY（node-pty，支持 resize）、exec、审计
              │ privileged+pid:host │  只认 kura-server 带来的内部令牌
              └─────────────────────┘

其他应用容器（openlist、navidrome…）照旧，接入 sso-net，由 kura-server 反代
```

**为什么拆两个容器**：kura-server 直接面对外网（经中继），认证与反代代码量大、出问题的面也大；
终端要宿主 root。放一起 = 认证或反代任何一个漏洞都直接变成宿主 root。拆开后，特权容器只做一件事、
只听内部网络、只认一个随机令牌，攻击面小到可以逐行审。

## 二、和客户端的契约：保持不变

客户端的映射核心（`src/core/session.ts`、`authelia.ts`、`proxy.ts`）**一行不改**也能连新服务。
新服务按现在网关的外部行为实现：

| 现在（nginx + Authelia） | kura-server |
|-|-|
| `POST /api/firstfactor` `{username,password,keepMeLoggedIn}` → `200 {"status":"OK"}` + `Set-Cookie: authelia_session=…` | 同。cookie 名保留 `authelia_session`（客户端按 `authelia` 前缀收集） |
| 凭据错 → `401 {"status":"KO","message":…}` | 同。客户端据此停止重试、冷却 10 分钟 |
| 未认证访问受保护路径 → `302` 到门户 | 同（无 Accept: text/html 时回 `401`，客户端两种都认） |
| `X-Nas-Service: <名>` 请求头分流；没有头时按 `/<名>/` 路径前缀 | 同。头优先，路径前缀用**白名单**（只认清单里的名字，Authelia 自己的路径不会被当成服务名 —— 现网踩过） |
| `GET /__services` → `{"services":[{name,container_port,host_port,published}]}`（需认证） | 同。数据来源改为配置文件 + docker 端口查询，见 §五 |
| 会话 Host 校验（cookie 域只认公网域名，局域网 Host 发 IP 会 401） | **不再需要**：kura-server 的会话不绑域名。客户端照发公网域名 Host 也没关系 |

好处：**新旧两套能并行、随时切回**。迁移时客户端只改「网关端口」一个数字。

## 三、认证

- 单用户。`.env`：`KURA_USER`、`KURA_PASSWORD_HASH`（argon2id；提供 `kura-server hash` 子命令生成）。
  启动时打印凭据**指纹**（sha256 前 8 位），沿用 Authelia entrypoint 的做法——两端对不上一眼看出。
- 会话：服务端内存 + 落盘（`/state/sessions.json`，重启不掉线），默认 30 天滑动过期（对应现在的 keepMeLoggedIn）。
  cookie：`HttpOnly`、`SameSite=Lax`、不设 Domain。
- 防爆破：同一来源 5 分钟内失败 5 次封 10 分钟，失败文案带封禁到期时间（客户端已能解析 `banned until …`）。
- 不做：多用户、二次验证、OIDC。现在 Authelia 实际只用了 one_factor 单用户。

## 四、反代

- 后端表：`/state/services.yaml`（见 §五），`name → http://容器名:端口`，用 Docker 内置 DNS 解析。
- 转发头与现网 `protected-prefix.inc` 一致：`Remote-User`、`X-Forwarded-*`、WebSocket 透传、长超时、不缓冲。
- 路径前缀模式剥掉 `/<名>` 再转发；对绝对路径跳转的应用（hermes 那种）按配置项 `rewriteRedirect: true` 重新加前缀。
- **不跟随重定向、不改写应用自己的 cookie**（与客户端的反代同一原则）。
- 上传体积不限（现网 nginx 为此改过 `client_max_body_size 20g`，踩坑记录见设计方案）。

## 五、服务清单

`/state/services.yaml`（管理页可编辑，也可手改）：

```yaml
services:
  - name: openlist
    backend: http://openlist:5244
  - name: navidrome
    backend: http://navidrome:4533
  - name: hermes
    backend: http://hermes:9119
    rewriteRedirect: true
```

`/__services` 输出时，`host_port / published` 通过 docker API 查容器端口映射得到（只读访问
`/var/run/docker.sock`，**只调 `GET /containers/json`**，代码里白名单这一个接口）。
没给 docker.sock 时 `published=false`，客户端照样能用（走网关）。

内置服务**不在 services.yaml 里**，固定出现在清单上：`webdav`、`nas-console`（名字不变，客户端不用改）。

> 取舍：gen-services.sh 的「从 nginx 配置解析 + docker cp 进容器」两个坑（`return 200` 绕过鉴权、挂载目录 700 读不到）
> 都不存在了——清单由服务自己在内容阶段生成，必然先过认证。

## 六、WebDAV

- kura-server 容器内起 `rclone serve webdav /host --addr 127.0.0.1:18005 -L`（只监听容器回环，外面摸不到）。
- 前面套 **`server/` 复用的 `dav-scope` + `dav-server` 范围层**（和客户端本机 WebDAV 同一份代码）：
  放行 / 排除 / 只读，改了即时生效 —— 不再需要 `filters.txt`、files-admin 容器、宿主 systemd 单元、重启 rclone。
- 挂载：`/:/host`（读写），`/proc /sys /dev` 用 tmpfs 掩掉（rclone `-L` 会沿 `/proc/self/root` 无限递归，现网踩过）。
- 默认范围：只放行 `/volume1` 与 `/home`，排除 `/volume1/@*`、`/volume1/.fscrypt`、`/volume1/lost+found`
  ——对应现网 2026-09-24 用户定下的最终形态。
- rclone 版本固定、镜像里带，SHA256 校验（同客户端模块）。rclone 挂了自动拉起并在状态页显示。

## 七、终端（kura-shell 容器）

- 沿用 nas-console 的执行机制：`privileged + pid:host`，`nsenter -t 1 -m -u -i -n -p` 进宿主。
- PTY 改用 **node-pty**（真 PTY，支持 resize）。nas-console 用 `script` 包装、resize 被当成输入（已读源码确认），这是它的老毛病。
- 协议（kura-server ↔ kura-shell，内部）：WebSocket，上行文本帧 = 输入、`{"type":"resize",cols,rows}` = 改尺寸；
  下行文本帧 = 输出。`POST /exec {cmd,cwd?,timeout?}` → `{exitCode,stdout,stderr,durationMs}`。
- 认证：kura-shell **不认用户**，只认 kura-server 启动时生成、经共享卷传过去的随机令牌（每次启动换一个）。
  kura-shell 不发布端口、只挂 `kura-internal` 网络。
- 对外：kura-server 把 `nas-console` 这个名字的请求（`WS /api/tty`、`POST /api/exec`）认证后转给 kura-shell；
  外部 API Token（`nsc_…`）由 kura-server 管理，供脚本 / AI 调 exec。
- 审计：每次会话开关、每条 exec 记 `/state/audit.log`（谁、何时、命令、退出码、耗时）。
- 并发上限默认 4 个 PTY。

客户端改动：终端改发 resize（`src/core/console.ts` 里留着的 `resize()` 打开）；登录方式里 nas-console 账号密码
与网关账号合并为同一个 —— **设置里少填一组凭据**。

## 八、管理页

`/_kura/`（需认证）：
- 状态：rclone 是否在跑、kura-shell 是否连通、会话数、最近审计
- 暴露范围：放行 / 排除 / 只读 + 可见性自检（与客户端本机 WebDAV 页同一套 UI 逻辑）
- 服务清单：增删改 services.yaml
- API Token：生成、查看、吊销

## 九、部署

```yaml
# server/deploy/docker-compose.yaml（草稿）
services:
  kura-server:
    image: ghcr.io/sakurachiyo0v0/kura-server:<版本>
    restart: unless-stopped
    ports: ["8897:8080"]
    env_file: .env
    volumes:
      - ./state:/state
      - /:/host
      - { type: tmpfs, target: /host/proc }
      - { type: tmpfs, target: /host/sys }
      - { type: tmpfs, target: /host/dev }
      - /var/run/docker.sock:/var/run/docker.sock:ro   # 可选：只用来查端口映射
      - shell-token:/run/kura-shell
    networks: [sso-net, kura-internal]

  kura-shell:
    image: ghcr.io/sakurachiyo0v0/kura-server:<版本>
    command: ["shell"]
    restart: unless-stopped
    privileged: true
    pid: host
    volumes:
      - shell-token:/run/kura-shell:ro
      - ./state/audit:/audit
    networks: [kura-internal]

networks:
  sso-net: { external: true }   # 其他应用容器已经在这上面
  kura-internal: { internal: true }

volumes:
  shell-token:
```

复刻步骤：`docker network create sso-net`（已有就跳过）→ 写 `.env`（`kura-server hash` 生成哈希）→
`docker compose up -d`。**不再需要 Postgres、不再需要宿主 systemd 单元、不再需要跑生成脚本。**

同一个镜像两个入口（`serve` / `shell`），发布一次。

## 十、迁移（碰 NAS 时，逐步确认）

1. kura-server 先用 **8898** 端口与旧网关并行，旧的一个都不停。
2. 客户端设置里把网关端口改成 8898，逐项验收：其他应用映射、文件、本机 WebDAV、终端（含外网）。
3. 确认后把 8897 让给新服务（停旧 nginx → 改端口 → 起新服务），客户端端口改回。
4. 旧 compose、`/volume1/docker/{sso-gateway,nas-webdav,files-admin,nas-console}` **保留**一段时间，删除另行确认、逐个路径。

**回滚**：任何一步不对，停新服务、旧的本来就没停。

## 十一、仓库结构

```
server/
  src/
    auth.ts        登录、会话、防爆破、argon2
    proxy.ts       反代（头、WebSocket、路径前缀、跳转改写）
    registry.ts    services.yaml + docker 端口查询 → /__services
    webdav.ts      rclone 子进程管理 + 复用 src/core/dav-*
    shell/         kura-shell：node-pty、exec、内部令牌、审计
    admin/         管理页
    main.ts        入口：serve / shell / hash
  test/            用假应用、假 rclone 的集成测试；kura-shell 用本机 bash/powershell 测
  Dockerfile
  deploy/docker-compose.yaml、.env.example
src/core/dav-scope.ts、dav-server.ts  ← 客户端与服务端共用（纯 Node，本来就不依赖 Electron）
```

## 十二、分步与验收

| 步 | 内容 | 判据 |
|-|-|-|
| S1 | 认证 + 反代 + 清单 | 现有客户端**不改代码**连上（假应用 + 冒烟），302/401/KO 行为与现网一致 |
| S2 | WebDAV（rclone 子进程 + 范围层） | 范围语义与现网 files-admin 一致；客户端文件页、本机 WebDAV、rclone 挂载全通 |
| S3 | kura-shell + 终端转发 + exec + Token | 终端可用且 **resize 生效**；特权容器只认内部令牌（测试里拿错令牌必须 401） |
| S4 | 管理页 | 范围、清单、Token 都能在页面上改 |
| S5 | 客户端合并凭据、打开 resize | 设置里只剩一组网关凭据 |
| S6 | 镜像与 compose、NAS 并行部署（**需你确认每条命令**） | 8898 上逐项验收通过 |

S1–S5 都在本机做、不碰 NAS。

## 十三、风险与未证实

- **绿联中继是否支持 WebSocket**：仍未实测，决定外网终端能不能用。S6 第一件事测它。
- **node-pty 在容器里的原生编译**：要在 Alpine/Debian 镜像里编译，镜像构建阶段处理；UGOS 内核上没跑过。
- **`pid: host` + `nsenter` 在新镜像里**：nas-console 实测可行，换基础镜像后需重测。
- **会话 cookie 去掉域绑定**：比 Authelia 宽松（现在任何 Host 都认）。因为入口只有绿联中继与局域网，风险可接受，写在这里供你判断。
- 自己写认证意味着安全由我们负责：argon2id、恒定时间比较、防爆破、会话随机 256 位，S1 写测试逐条覆盖。
