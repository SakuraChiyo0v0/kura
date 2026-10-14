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

## 没验证过的

- **镜像从没在本机构建过**（本机 Docker 没起）。Dockerfile 是照着设计文档写的，node-pty 那段
  （Alpine 里 `python3 make g++` 编译）尤其没跑过 —— 现在交给 CI 真跑一次，成败以 CI 为准。
- **node-pty 二进制建于 Alpine(musl)，要在 UGOS 宿主机内核上跑**：这是最可能出问题的一处，
  真机部署时终端能不能开、能不能 resize，看它。
- **绿联中继是否支持 WebSocket** 仍未实测 —— 决定外网下终端能不能用。部署后第一件事测它。
- **`pid: host` + `nsenter` 在 node:24-alpine 上**：nas-console 在别的基础镜像上实测可行，换镜像要重测。
- 客户端 v0.2–v0.3 归档里那条「清单里四个服务偶尔不出现」的偶发问题，与本次无关，仍未定位。
