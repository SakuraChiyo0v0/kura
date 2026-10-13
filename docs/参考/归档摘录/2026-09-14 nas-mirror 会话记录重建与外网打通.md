# 2026-09-14 nas-mirror 从 DSH 会话记录重建 + 外网打通 bili23-web

## 起因

用户在外网，要"用之前做的 nas-mirror"访问 NAS。但 `NAS-PROJECTS/` 下**没有** `nas-mirror` —— 它是
**2026-09-13 06:29–06:32 我一次误删（递归强制删除时路径不区分大小写命中了真实工作区）时没抢救到的**。
`.rescue/` 里只有 `bili23-web` 与 `ts-dev-kits` 的残留，GitHub 上也没有同名仓库。

## 怎么找回来的

`~/.dsh/sessions/` 里的会话日志（`.jsonl.zstd`）。**关键坑**：这些文件是**多个独立 zstd 帧**拼接的，
`zlib.zstdDecompressSync` 只解第一帧（只出 227 字节元数据 ✓ 一度以为"搜不到就是没有"）。
按 **zstd 魔数 `28 B5 2F FD` 切帧逐帧解压**后，65 个会话解出 **2.3 亿字符**，`nas-mirror` 出现在
**25 个会话**里。

再从会话里提取文件操作重建源码。工具参数在日志里是**被 JSON 序列化进字符串**的
（`"{\"file_path\":...}"`），只按对象键找会一无所获 —— 要**递归 JSON.parse 字符串值**。

重放策略（最关键的一步）：

1. `write` 提供完整内容、`meta.diffs[]`（`path`/`oldText`/`newText`）提供精确补丁；
2. **路径要规范化**：同一文件出现过 `nas-mirror/client/x.go` 与 `C:\...\NAS-PROJECTS\nas-mirror\client\x.go`
   两种写法 —— 不归一就会被当成两个文件、历史被劈开；
3. **必须用游标顺序匹配**：`oldText` 常在同一文件的**多处**都能匹配，`replace` 命中第一处就错位
   （症状：`config.go` 里 `ServiceConfig`、`LinkConfig`、各 `default*` 全被声明两次、import 跑到声明后面）；
   改成"每处 diff 从上次落点往后找"后 → 996/1047 成功，`go build` 直接过。

外部对账来源（本次只用了第1条）：飞书（当时同步过 4 篇文档 + 一个 skill）、GitHub 私有仓库
`sso-gateway`、NAS 上正在跑的 `<部署根>/*`。

## 结果

```
恢复 51 个文件 → NAS-PROJECTS/nas-mirror/
  client/  Go 客户端（config/mirror/session/status/mode/authelia/ugreen/log + 测试）
  server/  12 个服务的 docker-compose 模板（含 sso-gateway 的 nginx 配置）
  tools/   probe_external.py / check_gateway.py / check_local.py / check_prefix.py
另还原 skills/nas-mirror、skills/sso-gateway、docs/nas-mirror-设计方案.md、
docs/归档/2026-09-11 nas-mirror 建设与收尾.md

go build ✓   go vet ✓   go test ./... → ok nas-mirror 21.6s（全部单元测试通过）
nas-mirror.exe 13.13 MB 已启动；状态页 127.0.0.1:8898
```

## 外网打通 bili23-web

镜像里的其它 6 个服务直接 200，**只有 bili23-web 全路径 404**。
排查结论：**盘上的 `default.conf` 其实早已包含 bili23-web 的 map/location**，
是**运行中的 nginx 没 reload** —— 改了文件没生效。

（顺带纠正一个我先前的错误判断：我根据 compose 里没有 `networks:` 就断定容器没接入 `sso-net`，
实地执行时 daemon 回 `endpoint with name bili23-web already exists in network sso-net` ——
**网络是接了的**，我判断错了。但 compose 里声明 `sso-net` 仍然是必须的：
watchtower 每次更新都重建容器，手工 connect 的网络会丢。）

执行（通过镜像里的 nas-console，即宿主机 root shell；用它的 API Token + 自写的
最小 WebSocket 客户端连 `/api/tty`，收发明文文本帧）：

```
docker network connect sso-net bili23-web   → already exists（无副作用）
docker exec sso-gateway-nginx-1 nginx -t    → syntax is ok / test is successful
docker exec sso-gateway-nginx-1 nginx -s reload → signal process started
```

验证（外网、经镜像）：

```
http://127.0.0.1:8788/         → 200
/api/health                    → 0.2.0 / fc9488e
登录 ✓  任务 23  产物 203  下载目录 /volume1/<媒体目录>/<子目录>
```

## 踩过的坑（原文）

1. **会话日志的解压**：只解第一帧 → 得到 227 字节 → 误判"记录里没有 nas-mirror"。要按魔数切帧。
2. **工具参数是 JSON-in-string**：不递归 parse 就是 0 命中。
3. **路径不归一** → 文件历史被劈成两份，重建出的文件比真实的小一半。
4. **diff 的 `oldText` 不唯一** → `replace` 错位 → 语法错误与重复声明；必须游标顺序匹配。
5. **`Resolve-Path` 与 WebDAV 读到的行尾/缩进**：我用 `curl | Out-String` 打印时自己加了 2 空格前缀，
   于是把 `labels:` 的真实 4 空格缩进误看成 6 空格，锚点匹配失败两次。
6. **nas-console 的 `/exec`、`/ws` 返回 200 是 SPA 兜底**，不是真接口（本项目文档里早记过这个坑）。
7. **令牌**：用户为这次操作发来的 nas-console API Token 出现在对话里，建议用完即**轮换/吊销**。

## 未完成

- 33 处 diff 未应用、7 个文件只有片段（`client/config.json`、`config.example.json` 等）、
  `nas-ui-kit` 整目录未找回；可用飞书备份 + NAS 上在跑的 compose 对账补齐；
- `git` 里 `deploy/docker-compose.nas.yml` 的 `sso-net` 声明**尚未提交**；
- 客户端目前是**本会话的后台进程**；要开机自启可跑恢复出来的 `client/install-autostart.ps1`。

## 2026-09-16 复查：上面三条的现状

> 按"不改写历史"的规矩，原文保留，变更补在这里。

- **`config.json` / `config.example.json` 已不是片段**：两份都完整可用（实测客户端按它跑了 55 小时、
  9 个服务全部经网关出去）。`nas-ui-kit` 仍未找回。
- **`sso-net` 声明已提交**：仓库现在只有一条提交，`server/docker-compose.nas.yml` 里 42~43 行
  就是 `networks: sso-net`。
- **客户端已不再是"本会话的后台进程"**：以独立进程从 2026-09-14 11:23 运行至今（PID 32292，`auto` 模式，
  当前判定局域网不可达、走外网中继）。
- ⚠️ **追加发现的严重问题**：这次重建的 `server/` **并不完整** —— `nginx/conf.d/default.conf` 与
  `deploy/deploy.mjs` 停在了 **M1 局域网 POC 形态**，与线上 9 服务的 `map $svc_name` 版本不一致。
  详见 `2026-09-16 nas-mirror 服务端配置与仓库不一致.md`。