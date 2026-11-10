# 2026-11-10 WebDAV 前缀模式：href 与 Destination 都得对齐

## 起因

另一个应用（`steam-screenshot-manager`）把 kura-server 的 WebDAV 当备份盘，连接时一路 404。
查下来不是那个应用挑食：网关的**路径前缀模式**（`/webdav/<路径>`）只把请求前缀剥掉了，
没有处理另外两个方向。

## 实测（192.168.31.254:8898，现网 kura-server）

| 请求 | 结果 |
|-|-|
| `PROPFIND /`、`/dav/`、`/files/`、`/home/` | 404（不是 WebDAV 入口） |
| `PROPFIND /webdav/` | 207 ✅ |
| `PROPFIND /webdav/` 的响应 href | `/home/`、`/volume1/` ← **没有 `/webdav` 前缀** |
| `MKCOL /webdav/ssm-probe-top` | 404（`/ssm-probe-top` 不在放行范围内，按设计隐藏） |
| `MKCOL /webdav/home/AmeChan/AmeBackup/X` | 201 ✅ |

## 坑

- **我以为是** rclone（`golang.org/x/net/webdav`）吐的 href 不对。**实测是** rclone 只按它自己的根给
  `/home/`，前缀是网关剥掉的，所以补前缀的责任在范围层（`handleDavRequest`）这一侧，rclone 那边动不了。
- **我以为是**只有列表（PROPFIND）受影响。**实测是** `Destination` 反着也错：客户端发的是
  `http://host:8898/webdav/home/u/b.txt`，范围层拿它做放行判断（对 `/home` 的规则必然判成范围外 → 403）、
  再原样转给上游（上游只认 `/home/u/b.txt` → 对不上）。**前缀模式下 MOVE/COPY 是双错的。**
- 客户端本机 WebDAV（18006）没有前缀，所以这两个问题只在网关形态下出现，本机自测发现不了。

## 改法

`src/core/dav-server.ts`：

- `DavHandlerOptions.hrefBase`：网关的路径前缀，默认空。
- `stripHrefBase()`：进来时先把 `Destination` 的前缀剥掉，再做范围判断与转发。
- `rewriteHrefBase()`：出去时把 multistatus 里每个 `<href>` 补上前缀（绝对 URL 原样保留）。
- kura-server 的 `builtins.webdav.request` 把 `target.prefix` 传下去（`BuiltinHandler.request` 增加可选的第四参）。

## 验证

`src/core/dav.test.ts` 新增「网关路径前缀（/webdav）」一组：列表 href 带前缀、按 href 拼下一跳能取到、
MOVE 的 Destination 带前缀仍落到正确路径。全套 `npx vitest run src/core/dav.test.ts` 22 项通过，
`server/test/webdav.test.ts` 8 项通过，`npx tsc --noEmit` 干净。

## 没动的地方

- 范围外路径仍然回 404「不存在」（按设计不暴露存在性）；根目录不能建库是范围配置问题，不是缺陷。
- 没有顺手改 MOVE/COPY 的其它语义，也没碰认证。
