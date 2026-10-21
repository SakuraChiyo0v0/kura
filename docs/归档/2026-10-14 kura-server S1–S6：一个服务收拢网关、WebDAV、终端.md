# 2026-10-14 · kura-server S1–S5：一个服务收拢网关、WebDAV、终端

把 NAS 侧原本三个独立的东西（sso-gateway 网关、nas-webdav、nas-console）收成**一个服务**：
一个镜像、一份 `.env`、一个端口。复刻的人不用再装三个容器加一个宿主 systemd 单元。

代码在 `server/`，设计见 `docs/kura-server 设计.md`。设置页、`repo` 结构都在设计文档里，
这里只写**做了什么、踩了什么坑**。

S1–S5 全在本机做、没碰 NAS；S6 的镜像链路也已接通（CI 构建推 ghcr），**真机部署仍待做**，每条命令要用户确认。

## 做了什么

| 步 | 内容 | 状态 |
|-|-|-|
| S1 | 认证（照抄 Authelia 协议）+ 反代 + 服务清单 | 已做，客户端不改代码连得上 |
| S2 | WebDAV：容器内 rclone + 复用客户端那份范围层 | 已做，范围语义与现网 files-admin 一致 |
| S3 | kura-shell：特权容器里的真 PTY 终端 + exec + 内部令牌 | 已做，resize 生效 |
| S4 | 管理页 `/_kura/` 与登录页 | 已做 |
| S5 | 客户端合并凭据、打开 resize、终端不再提 nas-console | 已做 |
| S6 | 镜像自动发布、compose、NAS 并行部署 | 镜像链路已接通；**NAS 部署未做**（要碰 NAS） |

一个镜像两个入口：`kura-server serve`（网关那套）与 `kura-server shell`（终端执行器）。

## 踩过的坑（写下来别再犯）

### 1. 客户端改端口后不生效 —— 真 bug，被集成测试撞出来

S1 的集成测试直接用客户端自己的 `Mirror` 把 kura-server 当网关跑，结果发现：
本机端口被占时，界面上「就地改端口」保存后仍然不通。查下去是 `ServiceListener.setPort` 只记下新端口、
**没有真的重新监听** —— 得再拨一次开关才绑上。已修（现在是改完直接在新端口起来），补了单测。
这条是「重写以 Go 版测试为基线」的意外收获：新写一个调用方，反而照出了老代码的缺口。

### 2. rclone 的默认规则表达不了 `/volume1/@*`

现网 files-admin 靠 rclone 的 glob 挡「所有 `@` 开头的系统目录（含以后新建的）」。我们的范围层
按**路径前缀**判断，写不了通配。选择是：给排除规则加单段通配（`/volume1/@*`），
还是退成只管 `/volume1/@appstore` 这种具体名字。选了前者 —— 但**只给排除加**，放行目录仍然是从
目录树勾出来的字面路径（白名单本来就是具体目录）。放行规则加通配会让「可见性自检」变得很难解释。

### 3. 中文标签进 HTTP 头会炸

kura-server 把「谁在用终端」经 `x-kura-user` 传给 kura-shell 做审计。API Token 的 label 是用户起的，
可能是中文 —— 而 HTTP 头只能是 ASCII，Node 直接抛 `ERR_INVALID_CHAR`。改成 `encodeURIComponent`
传、审计时解回来。同理，WebSocket 转发给 kura-shell 时要带上客户端的握手头（`Upgrade` 等），
漏了就是握手一直挂到超时。

### 4. 终端其实不需要第二层凭据

原以为客户端要保留「终端账号密码」这一组。实测发现：映射层的内部通道会把**网关会话 cookie**
注入所有转发请求（`buildUpstreamHeaders` 的 `mergeCookie`），所以 kura-server 的 `/api/tty`
直接认网关会话 —— 客户端留空即可。现网独立 nas-console 才需要它自己那套。S5 据此改了文案与默认行为，
并把 `ConsoleSession` 在无凭据时也照连（服务端拒绝时再提示）。

### 5. resize 早先为什么关着

`src/core/console.ts` 里 `resize()` 一直是个空实现，注释写着「nas-console 用 script 包一层、
resize 被当输入」。这是**服务端**的限制，不是客户端的。kura-shell 换成 node-pty（真 PTY），
所以 S5 把 resize 打开了。代价：现网独立 nas-console 会把那串 JSON 打进终端 —— 属已知退化，
等 NAS 上统一到 kura-server 后消失。

## 与现网那套的差异（有意为之）

- **暴露范围在内存里**：改完下一个请求生效，不像现网要「写 filters.txt → 宿主 systemd → 重启容器」。
  代价：范围要在管理页改（或手改 `state/webdav.json`），不能再直接编辑 filters.txt。
- **终端只认内部令牌**：kura-shell 不认用户，per-user 的授权在 kura-server 决定一次。
- **API Token 明文存 `state/tokens.json`**：要能吊销后原样显示给用户（像家里的钥匙，用户有权看到自己那把），
  和密码哈希不是一回事。
- **会话 cookie 不绑域名**（比 Authelia 宽松）：入口只有绿联中继与局域网，设计文档 §十三已记，供判断。

## S6：镜像怎么发、怎么自动更新（沿用现成那套）

镜像不由本机 `docker build`，改由 **GitHub Actions** 构建推 `ghcr.io/sakurachiyo0v0/kura-server`
（`.github/workflows/kura-server-image.yml`，照 NAS-PROJECTS 里 account-panel 那份改的）：
push 到 main 命中 `server/**` 或 `src/core/**` 就重建，推 `:latest` / `:<版本>` / `:<sha7>`。
NAS 上的 watchtower 轮询到 `latest` digest 变了就自动 pull + 重建。整条链路与 NAS 上其它 app 一致。

**一个仓库两个入口、两个容器，都开 watchtower。**

### 6. 坑：watchtower 只重建「镜像变了的那一个」，内部令牌不能每次启动都换

这是接通链路时发现的真问题。watchtower 是**按容器各自重建**的，不是重读 compose 起一套：
它比对每个容器自己的镜像 digest。早先 kura-server 每次启动都 `internalToken()` 生成新令牌、
经共享卷写给 kura-shell；kura-shell 启动时**读一次**记住。

于是：只改了 kura-server、watchtower 单独重建它 → 换了新令牌 → 还在跑的 kura-shell 拿的是旧令牌
→ 它 401 拒掉所有请求 → **终端全断**。容器都在 `Up`，日志也不报错，最难查的那种。

改法两条，缺一不可：

- kura-server 侧 `readOrCreateToken`：共享卷上**已经有令牌就沿用**，没有（首次启动）才生成并写下去。
- kura-shell 侧把令牌做成**每次请求现读**（`ShellOptions.token` 接受 `() => string`）：
  万一还是换了（比如清了卷），不用重启 kura-shell 就跟上。

顺带一个：`kura-shell` 容器里镜像 ENV `KURA_PORT=8080` 同样生效，而它实际监听 `8890`。
Dockerfile 的 HEALTHCHECK 原写成只看 `KURA_PORT`，于是 shell 容器的健康检查一直探测错端口 ——
改成两个都试。这条同样是靠读代码发现的，本机构建不了没法实测。

### 7. 坑：Dockerfile 里 `ARG RCLONE_VERSION` 会让 rclone 起不来

镜像从没在本机构建过，第一次真构建（CI）就炸在取 rclone 那步：

```
CRITICAL: Invalid value when setting --version from environment variable RCLONE_VERSION="v1.75.2":
invalid argument "v1.75.2" for "--version" flag: strconv.ParseBool: parsing "v1.75.2": invalid syntax
```

原因是 **`ARG` 在 `RUN` 期间就是环境变量**，而 rclone 把所有 `RCLONE_*` 环境变量当成同名命令行
开关 —— `RCLONE_VERSION=v1.75.2` 被读成 `--version v1.75.2`，而 `--version` 是布尔开关，解析
`v1.75.2` 直接失败。改了变量名（`RC_VERSION`）就好。

这条只有真构建才会撞到，纯读代码看不出来。也是"交给 CI 真跑一次"的价值。

## 真机部署（2026-10-14 当天做完）

在真 NAS（UGREEN <型号>，Docker 29.6.2 / Compose v5.1.3）上并行起了网关端口，旧的
sso-gateway（8897）、nas-console（8890）**一个都没停**。部署在 `/volume1/docker/kura-server/`
（700 root:root，`.env` 600），两个容器 `kura-server` / `kura-shell` 均 healthy。

**怎么做的**：本机不在 NAS 局域网、SSH 也不通（公网只开 443/80）。走 NAS 上现成的
**nas-console `POST /api/exec`**（宿主 root shell，经绿联中继可达）执行所有命令 —— 不用 SSH 也能部署。
文件用 `base64 -d` 写入 + `sha256sum` 对账（沿用 NAS-PROJECTS 的既定做法）。

`.env` 的账号密码直接取客户端已有的**网关凭据**（从 Kura 的 DPAPI 保险箱解出来在内存里算 argon2id
哈希，只打印指纹 `d41afd40`、明文不落任何地方）。这样**客户端把网关端口从 8897 改成 8898 就能用，
不用改账号密码**。

### 8. 坑：`.env` 里的 argon2id 哈希被 Compose 插值吃掉了

`main.ts` 注释写「compose 的 env_file 原样读取，$ 不用转义」—— **是错的**。实测：Compose 对
`.env` 做插值（`env_file` 指示的那个文件也一样），`$argon2id$v=19$m=65536…` 里的 `$argon2id`、
`$v`、`$m`、盐全被当变量展开成空串，kura-server 报「密码哈希格式不对」起不来
（日志里还带一串 `The "v" variable is not set. Defaulting to a blank string.`）。

三种写法的实测结果（busybox 打印 `env | grep`）：

| `.env` 里写法 | 容器拿到的值 |
|-|-|
| `A=$argon2id$v=19` | `=19`（被吃） |
| `B=$$argon2id$$v=19` | `$argon2id$v=19`（对） |
| `C='$argon2id$v=19'` | `$argon2id$v=19`（对，且**无警告**） |

选了**单引号**（比逐处 `$$` 干净）。`main.ts` 里那条注释待改（本次没动代码，记录在此）。

### 9. 坑：kura-server 的 docker.sock 挂载与 UGOS

compose 里那行 `/var/run/docker.sock` 是**注释着的**（可选）。没挂也行：`/__services` 里
所有服务的 `host_port` 都算 0、`published=false`，客户端照常能用，只是全走网关。真机验证时
确认了这一点 —— 清单 12 个服务都返回了。

## 没验证过的（更新）

- ~~镜像没在 CI 真构建过~~ → **已在 CI 真构建成功**并推 ghcr。第一次就抓到了第 7 条那个 rclone ARG 坑。
- ~~node-pty / musl 二进制能否在 UGOS 内核跑~~ → **通过**。`docker exec kura-shell node -e 'require("node-pty")'` OK；
  终端真开起来了（见下）。
- ~~绿联中继是否支持 WebSocket~~ → **支持，实测通过**。这是本项目悬了几轮的未知项，现在有结论：
  - **对照**（nas-console 8890 经中继，`wss://app-<端口>-<设备>.<节点>.ugdocker.link/api/tty?token=nsc_…`）：
    291ms 升级成功，PTY 回显正常。
  - **kura-server**（8898 经中继，先 `/api/firstfactor` 换会话，再带 `x-nas-service: nas-console`
    升 `/api/tty`）：745ms 升级成功，收到 PTY 回显 `KURA_WS_OK_42`（真宿主 shell，resize 也发了）。
  - **结论：外网下终端可用**，不降级。
- **`pid: host` + `nsenter` 在 node:24-alpine 上** → **通过**。宿主 `<机型>-<序列>`、root、内核 6.18.15，
  看得到 447 个宿主进程。
- **还没做的**：客户端切到 8898 的**逐项验收**（映射、文件、本机 WebDAV、终端 UI 全流程）。
  上面都是服务端直连验证，UI 层还没走过。
- 客户端 v0.2–v0.3 归档里那条「清单里四个服务偶尔不出现」的偶发问题，与本次无关，仍未定位。

### 一个探路细节：JS 侧开 WS 要手动带 `x-nas-service`

浏览器/`ws` 客户端直连 kura-server 的 `/api/tty` 时，kura-server 靠 **`x-nas-service: nas-console`**
这个头才知道要转给谁（这是客户端映射层内部的分流协议）。漏了它，`resolve()` 认不出服务 → 401。
Kura 客户端自己转发时会自动带上，所以只影响手工脚本；记下来免得再撞。
