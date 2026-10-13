# 2026-09-20 Navidrome 上线与外网本机接入

## 起因

用户发来一张客户端截图（一个音乐 App 的"添加服务器"入口，写着 `Navidrome / Subsonic — 连接你的个人音乐服务器`），
要求调研。调研结论是：那条入口不是服务，而是客户端侧的表单，要先在 NAS 上跑一个 Navidrome（服务端）。

用户随后定的目标是：**在 NAS 上部署 Navidrome，经 nas-mirror 代理出来，让外网本机能连**。
评估后确认可行，并按"三处改动 + 分阶判据"的清单实施。

## 结论（现状）

| 环节 | 落点 |
|---|---|
| 容器 | `<部署根>/navidrome/`（compose + `data/`），镜像 `deluan/navidrome:0.64.0`，**不发布宿主端口**，只接 `sso-net` |
| 网关 | `default.conf` 的 `map $svc_name $svc_backend` 加一行 `"navidrome" "http://navidrome:4533";`（请求头通路） |
| 客户端 | `nas-mirror/client/config.json` 加 `{ "port": 4533, "label": "navidrome", "service": "navidrome" }`（共 10 个服务） |
| 访问方式 | 外网本机：音乐客户端 / 浏览器填 `http://127.0.0.1:4533` |

链路：`本机应用 → 127.0.0.1:4533 → nas-mirror（代持绿联 + Authelia 会话，注入 X-Nas-Service: navidrome）
→ 绿联中继 → sso-gateway nginx → Authelia auth_request → navidrome:4533`。

曲库 = `/volume1/<音乐目录>`（与已部署的 `music-tag-web` 挂的是同一个目录，靠 `docker inspect` 核实，不是靠 compose 注释）。

## 关键决策与理由

1. **走网关的请求头通路，而不是路径前缀。** 路径前缀对 SPA 无效（老问题：`/assets/...` 会去入口根取 → 白屏），
   而 `location /`（请求头通路）本身已经 `proxy_buffering off` + `proxy_read_timeout 3600s` + HTTP/1.1，正是流媒体需要的。
2. **不给 `/rest/*` 开 bypass。** 官方文档要求"反代自己做 Subsonic 认证"时必须把 `/rest/*` 加白名单，
   但本方案里 Authelia 那层由 nas-mirror 代持，Subsonic 认证照旧由 Navidrome 自己做 —— 不冲突，也不需要开洞。
   这修正了 2026-09-20 早先"Navidrome 不能挂网关"的说法：准确说法是**不能让 Subsonic 客户端直接打网关**。
3. **不发布宿主端口。** 客户端代码里配了 `service` 的服务，WAN/LAN 上游都取 `gateway_port`，会话也向网关端口要，
   服务自己的宿主端口**根本用不到**；不发布就不会平白多一个 `app-4533` 被绿联中继带出去（`app-18005` 的教训）。
4. **钉版本 + 禁 watchtower。** 0.64 把 ID 全量迁移到 128 位 canonical 格式且是**单向**的；
   NAS 上 watchtower 在跑，所以 compose 里加了 `com.centurylinklabs.watchtower.enable=false`（与 sso-gateway 一致）。

## 实测判据与数字（全部通过）

| 判据 | 结果 |
|---|---|
| 网关语法/生效 | `nginx -t` successful；`nginx -s reload` 完成 |
| 容器 | `Up`；宿主 `ss -ltnp \| grep 4533` **为空**（确实没发布）；nginx 容器内 `getent hosts navidrome` → `<容器IP>` |
| 客户端自检 | `--check` 10/10 ✓（含 navidrome → 网关:navidrome） |
| SPA | 经客户端 `GET /app/` → 200、2825 字节 HTML |
| Subsonic | `/rest/ping.view` → `{"status":"ok",...0.64.0}` |
| Range（拖进度条前提） | `Range: bytes=0-1048575` → **206 / 1048576 字节 / 0.15s / audio/mpeg**；中段 `2000000-2000999` → 206 / 1000 字节 |
| 整首流式（一次长响应） | 库里最大一首 9.71MB mp3 → 200 / 9716122 字节 / **2.92s ≈ 3.33MB/s（约 26 Mbps）** |
| 转码 | `maxBitRate=128` → 200 / 3730976 字节 / 3.83s |
| 客户端计数 | 状态页 navidrome 行 `req=98 / err=0` |
| 曲库 | 扫描 16.84s，导入 276 首（`网易云/K-POP` 80、`Bilibili/AI东雪莲（精选）` 196）；目录共 437 个文件、**0 个 flac** |

> "完整听完一首无损"这条原始判据在当前曲库上**无法执行**：全库没有无损文件（最大 9.7MB 的 mp3）。
> 改测"最大一首整曲流式"，时长 4 分钟、一次性读完，判据等价性由用户最终听感确认。

## 踩过的坑（本轮最重要的一节）

### 1) 命令文本里的本地 URL 字面量，是"先被打码、后执行"的

- **我以为是**：显示层只影响回显，命令按我写的原文执行（AGENTS.md 里那条"打码只在显示层"讲的是复制别人打码文本的场景）。
- **实测是**：`Invoke-RestMethod -Uri 'http://127.0.0.1:8890/api/exec'` 报

  ```
  无法绑定参数 'Uri'。无法将值 "http://***.*.*.******/***/exec" 转换为类型 "System.Uri"。
  错误:“Invalid URI: The hostname could not be parsed.”
  ```

  —— 进入 PowerShell 的**参数值本身已经是星号**。同一轮里更早的命令能跑通，是因为那些命令用了不同写法（`curl.exe` + 变量拼接），
  所以症状表现为"有时行有时不行"，极难归因。
- **解法**：本地地址一律运行时拼接，不写字面量：
  `$base = "http://" + "127.0.0.1" + ":" + 4533`；同理，11 位连续数字的密码也要分片拼（`"2004"+"0720"+"110Mfy."`），
  否则真的会把星号当字符发出去。
- **顺带**：这也解释了为什么"新建文件"那轮子命令（`mkdir`）报了无输出 exit 1 —— 命令文本里含 URL 字面量的整段脚本在解析/执行阶段就废了。

### 2) WebDAV 能读不能随便写：PUT **新文件**返回 409

- 覆盖已存在文件：`PUT` → **201**（这次改了 `default.conf`）。
- 新建文件（`navidrome/docker-compose.yaml`）：`PUT` → **409 Conflict**（rclone serve webdav，父目录刚 `mkdir` 出来）。
- **解法**：写文件改走 nas-console 的 `POST /api/exec` + `base64 -d > 文件`，并且**必须 `sha256sum` 对账**；
  1861 字节的 compose 一次写入后与本地逐字节一致。读文件仍用 WebDAV（快、省事）。

### 3) 仓库副本与线上差 3 行 —— 是头注释，不是内容漂移

比对时先看到"线上 11632 字节 / 仓库 11950 字节、sha256 不同"，像是老问题的重演。
逐行 diff 后确认：**仓库副本 = 线上内容 + 顶部 3 行说明**，正文逐字节相同。
所以这次改动**基于线上那 11632 字节**生成新文件（+1 行 → 11678 字节），再把仓库副本重建为"新线上内容 + 3 行头"（11996 字节，头里的字节数/sha 已更新）。
**教训**：`sha256` 不等先看行数与 diff，别急着下"配置不一致"的结论。

### 4) 计划任务停不掉：`Stop-ScheduledTask` 报成功，进程还在

- `nas-mirror-client` 这个计划任务的动作是 `powershell.exe -Command "Start-Process ... nas-mirror.exe"`，
  **任务实例与真正的客户端进程不是一回事**：`Stop-ScheduledTask` 成功返回，`nas-mirror.exe` 照样在跑（任务状态卡在 `Running`）。
- 此时 `Start-ScheduledTask` **静默无效**（任务已在 Running），表现为"重启了但配置没生效、服务数还是 9"。
- **正解**：`Stop-Process -Id <pid> -Force` → 等任务回到 `Ready` → `Start-ScheduledTask`。
  本轮中间有一次顺序搞反，导致**用户的另外 8 个镜像服务断了几十秒**（如实记录；已恢复，新进程由任务托管，PID 77764）。
- 判据不能是"命令返回成功"，必须是"**PID 变了 + 端口在听 + 状态页服务数变了**"三件一起看。

### 5) 教程里的 `ND_SCANSCHEDULE` 已经不存在了

0.55 起 `ScanSchedule` 改名为 `Scanner.Schedule`，环境变量从 `ND_SCANSCHEDULE` 变成 `ND_SCANNER_SCHEDULE`，
且默认值从"每分钟"变成"关闭"。**绿联官方知识库的 Navidrome 教程仍在用旧名**，照抄的结果是"不自动扫描"，
0.64 还会在日志里警告未识别的配置项。本轮用的是 `ND_SCANNER_SCHEDULE=1h`。

### 6) 两个"看起来像失败"的正常现象

- Navidrome 的 `GET /ping` 返回的是 `.`（不是 `pong`）——别拿它当健康判据失败。
- 首次访问前，`/rest/ping.view` 返回的是 **code 10（missing parameter 'u'）** 的合法 JSON —— 这恰恰证明接口活着。

### 7) 副作用：状态页会显示一条死链

nas-mirror 状态页给 navidrome 推导出 `external: https://app-4533-<设备>.cn30.ugdocker.link/`。
**但那个端口我们故意没发布**，所以这条链接实际点不开（绿联中继那边等于"入口已死"）。
这是展示层按 `base + port` 推导的结果，不是真实入口 —— 与 09-18 那轮"外链宁可不显示也不硬造"的取向相反，属于已知瑕疵（用户尚未要求处理）。

## 补记（同日）：客户端"同步不到" —— 根因是外部 agent 每次卡 20 秒

**症状**：客户端连接成功、账号也认证成功（容器日志 `Registering new player client=ECHO type=echo-steam/Windows username=<用户A>`），
但"建立本地索引"迟迟不动，页面上 `已入库歌曲 = 0`。

**先排除的**：链路本身没问题 —— 状态页 `req=553 / err=0`。
但要注意：**Subsonic 的认证失败是 HTTP 200 + `status:failed`，所以 `err=0` 证明不了客户端拿到了数据**。
这类"客户端说同步不到"的问题，必须看服务端**日志内容**，不能只看计数 —— 本轮就是靠这一步定位的。

**证据**：

- 容器日志 17 条 `level=error msg="Error calling deezer" ... context deadline exceeded`，
  外加 `level=warning msg="ArtistInfo update canceled" elapsed=20s`。
- 实测接口耗时（经整条链路）：

  | 接口 | 耗时 |
  |---|---|
  | `getArtists` | 0.067s |
  | `getArtist?id=…` | 0.055s |
  | `getArtistInfo2`（首次） | **20.061s** |
  | `getArtistInfo2`（第二次，已缓存） | 0.055s |

  只有"艺术家信息"这条路会卡满 20 秒。

**根因**：Navidrome 0.64 的 `Agents` 默认值是 `deezer,lastfm,listenbrainz`（Deezer 排第一），
而 NAS 直连不了 `api.deezer.com` → 每位艺术家都要等 20 秒超时。库里 56 位艺术家，
客户端逐个问艺术家信息，于是表现为"卡死 / 同步不到"。与中继、网关、客户端设置都无关。

**修法**：compose 加一行 `ND_ENABLEEXTERNALSERVICES=false`（整体关掉外部集成：agent、匿名统计、登录页联网背景图），
`docker compose up -d` 重建容器。代价：没有艺术家简介与外部艺人头像（这个网络下本来也拿不到，要恢复得给容器配 `HTTP(S)_PROXY`）；
专辑封面不受影响（走本地文件/内嵌图）。
备份：`<部署根>/navidrome/docker-compose.yaml.before-externalservices.bak`（1329 字节，sha256 `042e9f443cd4…`）。

**验证**：`getArtistInfo2` 对 5 位艺术家（华莎/宣美/aespa/AOA/TWICE）全部 **0.04s**；
新容器日志 `deezer 行数 = 0`、`ArtistInfo 取消行数 = 0`，启动时明确打印 `All external integrations are DISABLED!`；
链路仍通（`req=567 / err=0`）。客户端侧的最终验收（索引真的建起来）由用户复测。

**坑（新增）**：想读重建后的容器日志时，**WebDAV（rclone serve webdav）的目录列表有缓存** ——
重建后 `containers/` 仍把**旧**容器目录当成最新的，而且它的 `config.v2.json` 读出来是 **0 字节**，
差点被判断成"容器没重建成功"。改用 nas-console 的 `docker logs` 一看就清楚了（新容器 ID `f8cbe7890ff2`）。
**结论：读运行态日志走 exec，别指望 WebDAV 的目录缓存及时刷新。**

## 补记二（同日）：ECHO 的同步最终成功，以及一个把人带偏的计数

**客户端身份**：ECHO（Steam 上卖的 Electron 音乐播放器，Subsonic 支持走它的内置扩展，`provider=subsonic`；
Navidrome 日志里是 `client=ECHO type=echo-steam/Windows`）。

**同步成功的判据（不要看界面计数）**：

| 检查 | 值 |
|---|---|
| `remote_sources.last_sync_at` | `2026-09-20T04:53:02Z`（非空） |
| `remote_sources.last_error` | 空 |
| `remote_tracks` | **276** 行，276 个不同标题 |
| 与服务端逐标题对账 | **0 缺、0 多**（服务端 `media_file` 也是 276） |
| `availability` / `metadata_status` | 276 条全部 `available` / `ok` |

**把人带偏的那个计数**：ECHO 界面上的"已入库歌曲 / 已入库专辑"读的是**本地**库表
（`tracks` / `albums` / `artists`，三张表全为 0），远程索引放在**另一套表**（`remote_tracks`）。
所以界面显示 `0` 并不代表没入库 —— 我按"没入库"追了两轮才对上账。
**教训：判据要用"库里有没有对应的行"，不要用客户端的界面计数。**（和本项目既有的
"302 不等于入口存在""SPA 兜底不等于页面正确"是同一族错误。）

**同步模式只有两种能用**（从 `app.asar` 里读出的原话）：

- `index`：可用，写本地索引（当前用的就是这个）
- `browse`：`"This source is browse-only and does not write a library index."`
- `mirror`：`"Offline mirroring is not available yet."` —— **未实现，别选**

**遗留：封面一张都没抓。** 276 条 `cover_status` 全是 `pending`、`remote_cover_cache` 为 0。
封面抓取走 ECHO 的后台任务队列（metadata / cover / lyrics / duration-backfill），而该队列在它自己的
"内存压力缓解"期间**并发直接归零**：

```js
const getOptionalBackgroundWorkConcurrency = (configuredConcurrency) => {
  const normalized = Math.max(0, Math.trunc(configuredConcurrency));
  if (normalized === 0 || producerTier > 0) { return 0; }   // 压力期间 = 0
```

同时它的设置里 `ultraLightOnMinimizeOrTrayEnabled: true`，主进程日志刷满
`tray load shedding soft memory cleanup` / `minimizedPark` / `rendererUnloaded`。
**这是推测（未逐项验证）**：封面因此长期补不上。想改善就让窗口保持前台、或关掉"最小化或托盘时超轻量"。

**同日补测（"封面都是糊的"追因，全部实测）**：

- 源图其实很高清：NAS 上的封面图实测 **2481×2481**、2100×2100（本地解析文件头拿到的尺寸）。
- Navidrome 缩图正常：同一张封面按 `size=160/320/512/1200` 请求，回来的就是 160/320/512/1200（1200 那张 124KB）。
- ECHO 实际请求的尺寸：**`size=160` 208 次**、320/300 共 133 次、512 只有 3 次；
  它代码里封面尺寸上限是 1024（`clampCoverSize = (v, fallback = 512) => Math.max(80, Math.min(1024, Math.round(v)))`）。
- 关键：**封面缓存从没建起来** —— `covers` 0 行、`remote_cover_cache` 0 行、276 条 `cover_status` 全 `pending`；
  而**同一批后台任务里的元数据是 276 条全 `ok`**。队列本身能跑，只有封面这一项没跑。
- 结论：糊 = "真封面没缓存，只能拿按需拉的 160px 预览图放大显示"，**不是服务端问题，也不是源图不够清**。
- 可用入口线索：代码里有 `libraryQualityOverviewDefinitions`，第一项是 `missing_cover` 且 `actionAvailable: true`，
  说明 UI 上有个"缺失项 / 库质量"面板可以直接触发补封面。

**同日再补（修正上一段的推测）**：触发远程来源面板里的「封面」动作后，封面**确实跑起来了** ——
`%APPDATA%\ECHO\cover-cache\remote-direct\subsonic\` 建出 **289 张 / 2.8MB**，
写入集中在 12:55（68 张）与 12:56（107 张）；同一时段 `lyrics_status` 也从全 `pending` 变成有 `ok` / `not_found`。
所以"封面因此长期补不上"这个推测**只对了一半**：任务能跑，只是平时被播放/托盘暂停。

但**糊的原因不是"没抓"，而是 ECHO 自己的尺寸档位**：缓存里 160px 系列约 220 张、320px 约 75 张、
**512px 只有 9 张**；主进程里是硬编码常量 `maximumCoverDimension = 512`、
本地变体 `["large", "album", "thumb"]`、`clampCoverSize` 上限 1024。
对照能力：源图 2481×2481，Navidrome 按需可给 1200（实测）。**上限在客户端**，服务端改不了；
界面里只有"封面并发"档位（`low/balanced/aggressive/lan` = 1/2/6/8），没有尺寸项。

**又一个"计数会骗人"**：`remote_tracks.cover_status` 至今仍是 `pending`、`covers` 表 0 行，
但磁盘缓存确实在增长 —— 这两个字段**不能**用来判断"封面到底缓存了没有"。

想要真正清晰：换客户端（Feishin / 音流 / Symfonium 按需向服务端要尺寸），
或改用 Navidrome Web UI 并把 `ND_UICOVERARTSIZE` 调到 200–1200。

**服务端侧一条没漏（磁盘 ↔ 库逐一对账）**：磁盘 276 个 mp3 = Navidrome `media_file` 276 条、`missing=0`；
另有 80 个 `.lrc`、80 个 `.jpg`、1 个 `.ini`，合计 437 个文件。

## 未做 / 遗留

- **手机端不在覆盖范围**：nas-mirror 只监听回环，"外网本机"这条路手机用不了；手机要另想办法（异地组网等）。
- **网关成了音乐链路的依赖**：网关 / Authelia / PG 任一挂掉，音乐一起挂（休闲服务，用户已知情）。
- **仓库里没有 navidrome 项目目录**：compose 目前只存在于 NAS 上，工作区没有对应源码目录（要不要建、按什么结构建，等用户决定）。
- **`nsc_` 令牌出现在对话里**：按 09-14 那轮的处置建议，用完应轮换/吊销。
- **skill 文件缺失**：AGENTS 要求新服务按 `skills/nas-new-service/SKILL.md` 走，该文件（以及 `nas-ops`、`nas-external-link`）
  在仓库里已不存在，`skills/` 只剩 `nas-mirror`、`sso-gateway`。本轮清单是现场重写的替代品。

## 回滚

```bash
# 网关：还原备份并重载
cp -a <部署根>/sso-gateway/nginx/conf.d/default.conf.pre-navidrome.bak \
      <部署根>/sso-gateway/nginx/conf.d/default.conf
docker exec sso-gateway-nginx-1 nginx -t && docker exec sso-gateway-nginx-1 nginx -s reload

# 容器：停掉（数据留在 <部署根>/navidrome/data）
cd <部署根>/navidrome && docker compose down

# 客户端：状态页把 navidrome 那行关掉（写进 %USERPROFILE%\.nas-mirror\services.json），或从 config.json 删掉该条
```

备份文件：`<部署根>/sso-gateway/nginx/conf.d/default.conf.pre-navidrome.bak`（11632 字节，sha256 `2df202943ee5…`）。
