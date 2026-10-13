# 2026-09-23 nas-mirror 阶段 1：服务端暴露「服务清单」（/__services）

## 起因

用户提出一个正确的判断："这个 nas-mirror 完全不通用 —— 换个机器就得重新配；能不能只配服务端，
客户端只配"怎么连上服务端"，服务列表去服务端拉？"

问题是真的：`config.json` 里真正因机器而异的只有账号密码、`nas_lan_host`、`gateway_port`；
而 `services[]` 那十行描述的是 **NAS 上有什么**，却要在每台客户端上抄一遍、还得跟着 NAS 变化手动同步。
用户选定先做**阶段 1：服务端把清单生成并暴露出来**（受 Authelia 保护），客户端改造留到阶段 2。

## 做了什么

- **生成脚本** `server/gen-services.sh`（NAS 上 `<部署根>/sso-gateway/gen-services.sh`）：
  从两处**已有事实**推导清单，不新增需要人工维护的文件——
  1. nginx 配置里的 `map $svc_name $svc_backend`：服务名 → 后端容器:端口
  2. `docker ps` 的端口映射：容器端口 → **宿主端口**、以及"有没有发布到宿主"
- **接口** `GET /__services`（`location = /__services`，**过 `auth_request`**）返回那份清单。
- 产出两份：`nginx/conf.d/services-list.inc`（接口片段）与 `services.json`（给人看，放在 conf.d 之外）。
- 仓库侧同步：`server/gen-services.sh` 入库、`default.conf` 加上 include 行、
  `server/README.md` 与 `skills/sso-gateway/SKILL.md` 写入新的"加服务"流程。

### 推导结果与现有配置**等价**（这是阶段 2 的地基）

清单里 11 个服务，其中"已发布到宿主"的 8 个宿主端口与客户端手写的 10 条配置**完全吻合**：

| 服务 | 容器端口 | 推导出的宿主端口 | 客户端现有配置 |
|-|-|-|-|
| bili23-web | 8787 | **8788** | 8788 ✓ |
| music-tag-web | 8002 | **8022** | 8022 ✓ |
| nas-console / openlist / account-panel / jmcomic-web / hermes / hermes-api | 各自 | 与容器相同 | ✓ |
| webdav | （后端是宿主 IP <NAS局域网IP>:18005） | 未发布 | 客户端用 28006（历史遗留标签） |
| navidrome / astrahub | 4533 / 4310 | 未发布 | 客户端用容器端口 |

"未发布"这三个正好是"只能走网关、没有绿联外链"的那三个 —— 阶段 2 可以据此不给它们显示外链，
顺带解决之前记的那个死链问题。

## 三个坑（两个是我的错，一个是环境的）

### 坑 1（**我的错，且是安全漏洞**）：`return 200 '<json>'` 会绕过 `auth_request`

第一版把 JSON 内联进配置并用 `return 200` 输出。看起来优雅，实际是：**`return` 属于 rewrite 阶段，
会抢在 `auth_request`（access 阶段）之前执行** —— 无会话请求直接拿到清单，鉴权形同虚设。
发现方式是**对照实验**：拿"容器内、不带任何会话、正确 Host"去请求，本该 302，结果 **200**。
改成 `alias` 指向数据文件（内容阶段产生内容）后，同一实验变成 302 ✓。

### 坑 2（环境）：宿主挂载目录里的文件，容器里的 nginx worker 读不到

`alias` 指向 `/etc/nginx/conf.d/services.json`（宿主挂载）时，nginx 报
`open() ".../services.json" failed (13: Permission denied)`，即使文件是 644/666。
对照实验定位到边界：**同一个文件 root 能读、`docker exec -u nginx` 读不到**；
而容器内部的文件（`/etc/nginx/nginx.conf`）nginx 能读 ✓。
根因是 `<部署根>/sso-gateway` 是 `700`，经宿主挂载后这套 fuse 语义让 worker（uid 101）
连该目录下 777 的 `default.conf` 都读不到。
**没有去放宽目录权限**（那会牵动 `.env`、Authelia 配置这些密钥文件），
改成 `docker cp` 把数据文件放进**容器自己的文件系统** `/etc/nginx/services.json` 再 `alias`。
代价：容器重建后要重跑脚本（已写进文档与 skill）。

### 坑 3（验证方法）：reload 之后**立刻**验证，会打到还在服务的旧 worker

修好之后第一次验证"无会话应 302"仍显示 **200**，一度以为没修好。
看 access log 才发现那次请求的时间戳与 `nginx -s reload` **在同一秒** ——
nginx 优雅重载期间旧 worker 仍在处理请求，拿到的是旧配置。
隔几秒重测 → 302 ✓。**教训：改完 nginx 配置后的验证要留出重载窗口（或至少验两次）。**

## 与另一个会话的协作

动手前发现工作区里 `server/nginx/conf.d/default.conf` 有一份**不属于我**的改动
（2026-09-22 由另一个会话取的线上配置，新增 `navidrome` 与 `AstraHub` 的路由，且它用整文件上传的方式）。
处理方式：
1. 先把**它那份**原样提交（`19d21ea`），不让别人的工作悬在工作区；
2. 我的改动基于**当时的线上内容**精确构造（不手改、不猜），再叠加 include 行；
3. 提交前重新核对线上 sha 未变（`364e4ab3d8ed…`），确认没有并发写。

## 验证（阶段 1 的验收）

| 检查 | 结果 |
|-|-|
| `nginx -t` | syntax ok（不通过会自动回滚到 `.pre-services.bak`） |
| 无会话（容器内、正确 Host） | **302** → Authelia 门户 ✓（鉴权真的生效） |
| 带会话（经 nas-mirror 镜像 `127.0.0.1:8890/__services`） | **200**，1513 字节，JSON 合法、11 个服务 ✓ |
| 清单与本地配置等价 | 8 个已发布服务宿主端口全对 ✓ |
| 仓库副本与线上 | 去掉说明头后**逐字节一致**（sha256 前 12 位 `27703e12042ac775`，12406 字节） |

## 遗留风险 / 下一步

- **阶段 2 未做**：客户端还不认识这个接口，仍是手抄 `services[]`。阶段 2 要做：拉取 + 与本地显式配置合并
  （本地优先）、失败时用上次清单兜底、页面标注来源。
- 容器重建后 `/etc/nginx/services.json` 会消失（接口 404）；已在文档与 skill 里写成固定动作。
- 清单里包含"内网有哪些服务"，因此**必须**保持 Authelia 保护；新增接口时别再犯"rewrite 阶段绕过鉴权"。
- `webdav` 在清单里是"未发布"，而客户端配置里是 28006 —— 阶段 2 合并时应**保留本地显式值**，
  别把它改成推导值（否则会动到用户已经在用的 rclone / 映射驱动器）。
