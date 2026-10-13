# files-admin —— "WebDAV 暴露哪些目录"的勾选页面

服务端组件。与 `../nas-webdav/`（rclone 容器）是一对：

```
浏览器 → 网关（Authelia 认证）→ files-admin 页面        ← 决定"暴露哪些目录"
                                     ↓ 写 filters.txt
                              宿主 systemd path 单元
                                     ↓ docker restart
                                  nas-webdav (rclone)   ← 真正搬运数据的
```

## 它做什么 / 不做什么

| 做 | 不做 |
|-|-|
| 列出**任意目录**（整个宿主根挂在容器的 `/host`）供勾选 | 不碰 docker（**没有** docker socket） |
| 勾选保存成 `selection.json`，并生成 rclone 的 `filters.txt` | 不重启任何容器（由宿主的 systemd 单元做） |
| 把每次变更写进 `audit.log` | 不做认证（由网关的 Authelia 做） |

**为什么重启不放在这个 Web 服务里**：重启容器需要 docker 权限，而 docker 权限等于 root
（能起任意容器把 `/` 挂进去）。一个"选目录"的网页不值得拿这个权限，所以把它拆出去交给宿主的
systemd path 单元 —— 这个服务只写文件。

## 勾选模型：白名单 + 反向排除

生成的 `filters.txt` 三段式（rclone 的规则是**先匹配先生效**，顺序即语义）：

```
# 1. 反向排除（必须排在放行之前，否则永远不生效）
- /volume1/<媒体目录>      - /volume1/<媒体目录>/**
# 2. 勾选放行
+ /volume1          + /volume1/**
# 3. 兜底：没放行的一律不可见
- /**
```

界面上是三态：勾了的目录显示 <b>放行</b>；被父目录覆盖的显示 <b>随上级放行</b>，
**再点一下它 = 单独排除**（这就是"挖洞"：勾 `/volume1` 但排除 `/volume1/@appstore`）；
被排除的显示 <b>已排除</b>，再点一下恢复。

**没有硬编码的"不该暴露"清单**：系统目录（`@*`、`.fscrypt`、`lost+found`）默认不可见只是因为
白名单兜底 —— 想暴露它们，勾上就行（2026-09-24 用户明确要求）。

> 实测过的两条 rclone 语义（别再想当然，见知识库）：
> ① `--exclude`/`+` 只有 `/路径/**` 那一版真的生效，只写目录名等于没写；
> ② **父目录不必额外放行** —— 只要某个子项被 include，路径上的目录就会出现在列表里（可以直接导航进去）。

## 手写规则（高级）

页面右下有一块 `textarea`，可以写**原始 rclone 过滤规则**，它们被放在生成文件的**最前面**
—— 手写的**优先于页面上的勾选与排除**，所以能表达"页面表达不了"的东西：通配、按名字批量挡。

```
- /volume1/@*/**            # 所有 @ 目录（含以后新建的）
- /volume1/#*/**            # 回收站
+ /volume1/<媒体目录>/番剧/**      # 强制放行（即使父目录被排除）
```

语法：每行 `+ 模式` 或 `- 模式`，空行与 `#` 开头是注释；校验只管形态（符号、长度、条数上限 200），
写错了由 rclone 在启动时报错 —— 页面上的「生效状态」会显示失败。

> ⚠️ **模式末尾必须带 `/**`**：实测只写目录名（`- /volume1/@*`）**不会生效** ——
> 列表里照样看得见、直连也进得去。这条踩过两次（第一次在 docker-compose 的 `--exclude` 上，
> 第二次在给用户看的示例里），所以写进了页面提示与测试。

## 可见性自检

页面上有一块"可见性自检"：输一个宿主路径，它按**最终规则**算出这条路径在 WebDAV 里可见不可见、
以及**是被哪一条规则决定的**（手写规则 / 排除 / 放行 / 白名单兜底）。用来回答
"我勾了 /volume1、又写了通配，那 /volume1/xxx 到底看不看得见"。

它模拟的是 rclone 的真实语义（都是实测出来的）：

1. 规则**从上往下、先匹配先生效**；
2. **`**` 匹配零个或多个段** —— 所以 `/x/**` **也匹配 `/x` 本身**（这是"只写目录名的规则不生效、
   必须写 `/**`"背后的机制）；
3. **目录**：只要它自己、或它**下面**有任何东西能被放行，它就可见（rclone 会把这样的父目录露出来
   好让人点进去）；反过来，整棵子树都被排除时目录本身也会消失。

第 3 条没法靠模式推导（要看实际内容），所以自检会**抽样实际子项**（最多 2 层 × 每层 16 项）来推断，
并在结论里注明"是抽样推断的"。规则列表与生成 `filters.txt` 用的是**同一份**（`buildRules`），
所以自检不会和实际生效的规则不一致。

> 真机对照：拿 10 条真实路径把"自检结论"与"实际 PROPFIND 状态码"逐条比对，**10/10 一致**。

## 部署（NAS 上）

```bash
# 1. 源码（本目录）放到 <部署根>/files-admin/src
# 2. 构建镜像（NAS 上不需要装 Go：用 golang 镜像多阶段构建）
docker build -t files-admin:local <部署根>/files-admin/src
# 3. 起容器
docker compose -p files-admin -f <部署根>/files-admin/docker-compose.yaml up -d
# 4. 装"保存后重启 nas-webdav"的宿主单元
cp <部署根>/files-admin/src/deploy/nas-webdav-apply.{path,service} /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now nas-webdav-apply.path
```

升级：改源码 → 重新 `docker build` → `docker compose -p files-admin up -d`（页面/接口无状态）。

首次部署要先有 `filters.txt` 再切 `nas-webdav`（**文件缺失或写坏时 rclone 起不来**）：
先起 files-admin，在页面上保存一次勾选，再 `docker compose -p nas-webdav up -d`。

## 网关登记（三处，缺一处就是"变成登录页"而不是 404）

```nginx
map $svc_name $svc_backend { "files-admin" "http://files-admin:18080"; }
map $uri $svc_from_path { ~^/files-admin(/|$) "files-admin"; }
location /files-admin/ { set $backend "http://files-admin:18080"; include protected-prefix.inc; … }
```

登记后重跑 `gen-services.sh`，让 `/__services` 也带上它（于是 nas-mirror 客户端会自动把它镜像到
本机 `127.0.0.1:18080`，方便直接用页面）。

## 文件

| 文件 | 说明 |
|-|-|
| `main.go` | 路径校验（白名单根是唯一防线）、目录列举、`filters.txt` 生成、审计 |
| `handlers.go` | `/`（页面）、`/api/tree`（懒加载）、`/api/state`、`/api/save` |
| `page.go` | 页面模板（服务端渲染 + 无前端库，沿用 nas-mirror 状态页那套做法） |
| `deploy/nas-webdav-apply.path` / `.service` | 宿主上监视 `filters.txt` → 重启 nas-webdav |
| `docker-compose.yaml` | 容器编排（只挂 `sso-net`、不发布端口） |
| `main_test.go` | 路径越界/系统项屏蔽/规则顺序与形态/保存落盘与审计 |

## 安全边界（明确写下来）

- **认证**：只在网关后面，复用 Authelia；容器不发布宿主端口，只挂 `sso-net`。
- **能选什么**：**任意路径**（含 `/etc`、`/root`）—— 这是使用者的明确选择。默认什么都不可见（白名单兜底）。
- **谁能改**：任何能登录网关的用户（当前是单用户环境）。**改这个页面 = 能改变对外暴露的数据面**，
  属于高权限操作 —— 变更都写进 `audit.log`。
- **不给 docker 权限**：如上。
- **符号链接**：rclone 带 `-L`（跟随链接）；勾选一个目录就等于把它下面的符号链接目标也一并暴露。
- **`/proc`、`/sys`、`/dev`**：nas-webdav 里用 tmpfs 空目录掩掉了（否则 `-L` 会沿
  `/proc/self/root/...` 无限递归），所以这几个目录即使勾上也是空的。
