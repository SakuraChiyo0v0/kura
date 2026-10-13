# 2026-09-16 nas-mirror 服务端配置与仓库不一致（严重：照 README 部署会把线上网关打挂）

## 一句话

仓库里的 `nas-mirror/server/nginx/conf.d/default.conf` 与 `server/deploy/deploy.mjs` **是 M1 局域网 POC 形态**，
而 NAS 上跑的是 M2 的 9 服务 `map $svc_name` 版本。README 却写着"改网关请直接改这里，再用 `deploy.mjs` 部署到 NAS" ——
**照那句话执行会覆盖线上 nginx 配置，9 个服务当场全挂。**

## 怎么发现的

本轮只是"看一眼项目"，按 README 的指引核对 `server/` 是否真的等于线上，于是读了三处证据：

1. `server/nginx/conf.d/default.conf` 只有 76 行：自签证书 `listen 443 ssl`、只认识 `nas-hello`、
   **没有任何 map**（M2 的两条分流通路一条都没有）。
2. `server/deploy/deploy.mjs` 第 171 行会把上面那份 conf 上传覆盖
   `<部署根>/sso-gateway/nginx/conf.d/default.conf`，并在第 198 行 `up -d --force-recreate`；
   默认渲染的还是 `nip.io` + 自签证书那套。
3. 线上确实是 M2：客户端 `status.json` 里 9 个服务**全部**经网关 8897 出去（`X-Nas-Service: <服务名>`），
   请求数各 176–326、错误只剩几例真 TLS 超时 —— 一个只认识 nas-hello 的 conf 不可能做到这件事。

反过来说明：**线上配置并不在本仓库里**。

## 危害推演（不是理论，是这条命令的必然结果）

`deploy.mjs` 上传 POC conf → nginx 加载新配置 → 客户端发来的 `X-Nas-Service` 无人解析，
请求全部落进 POC 的 `location /`，被当成"门户请求"转给 Authelia → **9 个服务一起变成登录页/白屏**，
客户端状态页看起来"所有服务都坏了"，而症状与"绿联会话失效"高度相似，很容易往错的方向排。

同时 `--force-recreate` 会让会话作废、证书目录被自签证书盖掉。

## 为什么会有这份不一致

`server/` 是 2026-09-14 从 DSH 会话记录**重建**出来的（见 `2026-09-14 nas-mirror 会话记录重建与外网打通.md`），
当时 1047 处 diff 有 33 处没应用上，`default.conf` 就是没吃到 M2 改动的那一批。
**当时的核查只做了"有没有密码泄漏"，没做"内容与线上是否一致"。** 文件存在、大小正常，所以完全看不出来。

顺带纠正两处旧说法：

- 2026-09-14 归档里写的"`server/` 12 个服务的 compose 模板"，那批是**被清理掉的敏感副本**，
  现在仓库里只剩网关自己的编排；而 `docker-compose.nas.yml`（8897:80 / `sso-net` external）
  与 `authelia/*.tpl`（`__GATEWAY_HOST__` 占位）**是当前形态，没问题** —— 出问题的只有 nginx conf 与部署脚本。
- README 原来那句"服务端（`server/`）的唯一维护位置就是本仓库"是**未经验证的推断**，实测不成立。
  已在 README 顶部与 `skills/sso-gateway/SKILL.md` 写上警告。

## 会话记录里能捞回什么（试过了）

用按魔数切帧 + 递归 `JSON.parse` 字符串值的方法搜 97 个会话：`map $svc_name $svc_backend` 命中 368 处，
捞回 39 份候选配置。**但捞回来的不是一个版本，而是好几个历史版本**：

- 有 `~^/(?<first_segment>[A-Za-z0-9_-]+)` **通用捕获**那版（就是 skill 里"坑 1"记的那个会 404 掉整个门户的写法）；
- 有改成**白名单** `~^/nas-console(/|$)` 之后的版本；
- 还有含 `nas-hello`（2026-09-11 已下线）与 `webdav → 172.17.0.1:18005`（后来改成 `nas-webdav:8080`）的中间态。

**结论：捞回来的东西只能当参考，不能当"线上配置"回填** —— 这正是本项目硬约定 #6（不要迷信文档/记录，
有冲突以当次实测为准）的场景。要回填，必须从 NAS 取。

## 待办（本轮没做，需要 NAS 访问）

从 NAS 取线上配置对账，然后覆盖仓库副本并提交：

| 取什么 | 位置 |
|-|-|
| nginx 配置 | `<部署根>/sso-gateway/nginx/conf.d/default.conf`（以及是否存在 `protected-prefix.inc`） |
| Authelia 配置 | `<部署根>/sso-gateway/authelia/configuration.yml`（**注意脱敏**：含 jwt/session/encryption secret 与 PG 密码） |

取法三选一：① nas-console（宿主机 root shell，需 `nsc_` 令牌）② SSH（局域网内，凭据在 `%TEMP%\nas_poc_creds.txt`）
③ 用户手工 `cat` 后粘贴。

**在取回之前**，两份 POC 文件已加⚠️头注释，说明"这不是线上那份、别部署"。

## 处置结果（同日完成）

**取回方式**：用户给了 nas-console 自己的账号（`admin` + 它自己的密码；注意**不是** NAS 登录/sudo 那套 ——
先拿 NAS 那串试过，接口回 `{"error":"用户名或密码错误"}`）。走**本机镜像** `127.0.0.1:8890`
（客户端已经代持绿联 + Authelia 会话），`POST /api/login` → `POST /api/exec`。

**关键坑：`cat` 会丢字节。** 第一次用 `cat` 取 `default.conf`，`ls` 说 11632 字节、拿回来只有 9242
（少了 2390）。改用 `base64 -w0` 取、本地解码，并逐份 `stat -c %s` 对字节数 → 四份全部一致：

```
nginx/conf.d/default.conf            11632 字节  sha256 2df202943ee5… ✓
nginx/conf.d/protected-prefix.inc     1054 字节  sha256 90ca98396f54… ✓
docker-compose.yaml                   1955 字节  sha256 9ac8a2cbe68a… ✓
authelia/configuration.yml            1344 字节  sha256 1d5f65b342f8… ✓（只在本地比对，不进仓库）
```

**仓库已对齐**：`server/nginx/conf.d/default.conf`（含仓库里从来没有过的 `protected-prefix.inc`）
与 `server/docker-compose.nas.yml` 都换成了线上内容，只在文件头加了三行"取自线上 + 字节数 + sha"的说明。
`docker-compose.nas.yml` 与线上差一处实质内容：线上 nginx 服务有 `extra_hosts: host.docker.internal:host-gateway`。

**从线上配置里读出来、仓库和 skill 之前都没记的事实**（已补进 skill）：

- `client_max_body_size 20g`（server 级）：nginx 默认 1m，经网关传 >1 MiB 的文件会 413，
  而 `curl` 因 `Expect: 100-continue` 会把状态码显示成 `100`，极难看出真因 —— 这个坑仓库里没有任何记录。
- webdav 后端是 `http://<NAS局域网IP>:18005`（nas-webdav 容器，host 网络，根 = 整个文件系统），
  且是**故意写死局域网 IP**：绿联中继会转发任何绑通配地址的端口，`app-18005` 曾从公网可达（实测 401）。
- nas-hello 已从 map 与 location 里移除（2026-09-11）。
- `hermes` 的 location 多一条 `proxy_redirect`；`/webdav/` 路径前缀其实也在（skill 以前只说 music-tag-web 与 webdav 可用，这点对）。

**仍未处置（交用户决定）**：

- `server/deploy/deploy.mjs` 是 M1 POC 脚本，现在仓库里的 nginx 配置虽然对了，但它还会**用 `.env` 重渲染
  Authelia 配置**（本机没有 `.env`，会照 `.env.example` 生成 nip.io + 自签证书那套），跑一次照样能把线上打歪。
  留着的价值只有"历史参考"，倾向删除或改写成当前流程；已加⚠️头注释，未删。
- `server/authelia/configuration.yml.tpl` 与线上结构差一处：模板里 `access_control` 多一段 `rules`
  （线上只有 `default_policy`）。本轮**没动模板** —— 它只被那个不该用的脚本渲染。
- 线上 `authelia/configuration.yml` 的实际密钥值没有进仓库（只比了结构），符合"密钥不进 git"。

## 收尾（同日，用户决定后）

用户选择"删掉 `deploy.mjs` 和它的 M1 模板"，于是：

- **删除**：`server/deploy/deploy.mjs`（整个目录）、`server/authelia/configuration.yml.tpl`、
  `server/authelia/users_database.yml.tpl`。前两个是那条危险的部署路径；用户库模板本来也没用
  —— 线上 `users_database.yml` 是 `entrypoint.sh` 每次启动现生成的。
- **保留**：`authelia/entrypoint.sh`（**线上 compose 正在引用它**，删了就起不来）、
  `docker-compose.nas.yml`、`nginx/*`、`.gitignore`。误删 entrypoint 是这一步最大的风险点，删前逐条核对过。
- **改写** `server/.env.example`：原来那份是给渲染脚本用的（nip.io + JWT_SECRET + PG 密码……），
  改成只列运行时真正需要的三个键。依据是实测线上 `.env` 的**键名**（只取键名不看值）：
  `ADMIN_PASSWORD, ADMIN_USER, ADMIN_EMAIL` —— 三个，印证了"其余密钥早已渲染进 configuration.yml"。
- 代价（如实记）：Authelia 的配置从此**只在 NAS 上**（含密钥，不入库），仓库里没有它的表示。
  模板的结构差异（多一段 `access_control.rules`）也随之消失，不再需要处理。

## 踩过的坑（原文）

1. **"重建出来的文件存在" ≠ "内容和线上一致"。** 上轮核查只查了密码，没查一致性；文件大小正常，看不出问题。
   教训：对账要拿**线上实物**比，不是拿记录里"有这个文件"比。
2. **搜索脚本的统计和结果自相矛盾**：第一版把 `walk()` 已经给出的绝对路径又 `path.join(sessionsDir, f)`
   拼了一次 → 全部 ENOENT → 打印"扫描 0 个会话、命中 0 个"，**输出文件却有 36 KB**。
   我当时差点只读那行统计就下结论"记录里没有"。**统计与结果不一致时，看原始错误。**
3. **会话记录按项目分子目录**，顶层 `readdirSync` 只能拿到目录名 —— 必须递归（第一版就是这么空转的）。
4. **配置在日志里是"被 JSON 序列化进字符串"的**，且 `write` 全文与 `edit` 补丁两种形态都要收，
   否则只会拿到片段。同一文件同一内容要按 hash 去重，不然 978 个片段里 90% 是重复的。
5. 顺手把 `log.go` 那条已修的假告警对齐：状态页 `errors` 原先把调用方取消（`context canceled`）
   也算成服务错误。**306 条"代理失败"里 302 条是这一类**，真故障被淹掉 —— 已在 `mirror.go` 里按
   `callerGone()` 区分，并补了"真故障仍计数"的对照组测试。
