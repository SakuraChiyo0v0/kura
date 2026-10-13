# AstraHub 设置中心与 WebDAV 真机通路（2026-09-24）

## 这一轮做了什么

- 按设计稿实现 **本机设置中心**（新命令 `astrahub ui`）：回环随机端口 + 入口令牌 + 同源校验 + 空闲 10 分钟自退；六个区块（总览／连接／账号／网络／本机工具／关于）。
- WebDAV 连接闭环：新增／编辑／保存／检测／删除本机配置；补平台缺口能力 `webdav.connection.remove`（只删本机配置，与删远端文件的 `webdav.remove` 分开）。
- 账号页：按实际登记服务列出登录／重新登录（后台执行、轮询状态、可取消）、固定用途的密钥新增或替换、删除仍被连接引用的凭据时拒绝。
- 本机工具页：媒体工具登记与版本校验、只读候选探测、字体登记、能力开关（措辞改为「已开启；是否可用未做在线检查」）。
- 界面外观：日间／夜间／跟随系统三选一，**偏好存平台配置**（`uiTheme`）而不是浏览器存储。
- 数据行为修复：网络设置改为整体校验后一次提交；WebDAV 凭据编辑改为「先写连接元数据、再原地写新秘密」。
- 无障碍：17 个表单标签与输入框关联、`:focus-visible` 焦点环、`aria-current`／`aria-pressed`。
- 平台新增 **受控会话刷新**（`RequestOptions.sessionRefresh`，默认关闭、只允许 GET），用于 Steam 激活码兑换；实测无效码返回 `resultCode 14`，说明通路打通。
- 文档：新增 `docs/78-WebDAV能力总览.md`（12 个操作、认证、边界、23 个错误码、真机验证）与 `docs/README.md` 索引（69 份）；解开 67 号撞号（B站用户卡片改到 79）。
- **真机验证**：NAS 经 nas-mirror 客户端的本机镜像端口完成 check／list／mkdir／upload／stat／download，上传与下载 SHA256 一致。

## 关键决定与原因

| 决定 | 原因 |
| --- | --- |
| 外观偏好存平台配置，不用 localStorage | 设置页与登录页的端口每次随机，localStorage 按「协议+主机+端口」隔离，**跨次启动记不住** |
| 总览页不主动联网，检测由按钮触发 | 设计稿要求总览只显示配置状态；自动联网会让首页依赖外部可达性 |
| 检测结果落盘（`webdav.checks` 命名空间，带时间戳与错误码） | 「上次检测成功」要能跨页面存活，否则重开就回到「未检测」；删连接时一并清理 |
| 删除本机连接与删除远端文件分成两个能力 | 语义完全不同，合成一个迟早会误删远端 |
| 激活码兑换先补平台会话刷新 | store 写接口要求「先 302 刷新会话再提交」，而平台原先禁止非 GET 跟随重定向 |
| 写请求不跟随重定向、不自动重试 | 一次写可能被提交两次；未知结果返回 `WEBDAV_WRITE_UNCERTAIN`／`STEAM_REDEEM_UNKNOWN` 让人去核对 |

## 踩过的坑（带原始现象）

1. **PowerShell `Set-Content -NoNewline` 把整份 HTML 压成一行**。写完不报错，`Select-String` 统计「`label for=` 命中 1 处」也没引起怀疑——因为 `Select-String` 按**行**计数，文件只有一行就只算 1。发现后从 git 恢复重做。教训：重写大文件不要用 `-NoNewline`；计数用 `[regex]::Matches((Get-Content -Raw))`。
2. **第二次同类事故**：用 `write` 重建 `tests/local-webdav.test.ts` 时，`lines` 只有我刚读的一行（`offset 435, limit 1`），435 行的测试文件被截成几十行，整个文件报「1 test / 1 fail」。同样靠 `git checkout` 恢复，之后改用「尾部锚点 + edit」追加。
3. **验证脚本自己的错导致两次假失败**：URL 少一个斜杠（`.../s/<token>api/overview`）→ 所有请求 `CALL_FAILED`；路由名写成 `connections/check`（实际是 `connections.check`）→ `UI_ROUTE_NOT_FOUND`。教训：出现「全都不通」时先怀疑验证脚本。
4. **把 nas-mirror 的「客户端」当成「服务端」**：用户说「他里面有一个 webdav 的项目」，我去查 NAS 上的 `nas-webdav` 容器、又去试 SSH（`Connection refused`），直到用户一句「启动 nas-mirror 的客户端啊」才纠正。教训：术语有歧义先问一句。
5. **密码写错差点误判产品**：用固定 WebDAV 服务验收时我传了别的密码，得到 `WEBDAV_UNAUTHORIZED`；这其实是正确映射，当时差点当成「凭据链路有问题」。
6. **文档与实现不符**：`skills/sso-gateway/SKILL.md` 写着 webdav 后端是 host 网络 + `<NAS局域网IP>:18005`，实际 compose 在 2026-09-23 已改成只挂 `sso-net`、不发布端口、不设认证。已订正并保留历史。
7. **并发会话的提交多次扫走我的未提交改动**（本轮至少 5 次）；其中一次把 `src/operations/index.ts` 里对不存在文件的 import 提交进 HEAD，**仓库在 HEAD 上编译不过**。修复：删悬空注册并提交。教训：改完尽快提交、只暂存自己范围的文件。
8. **Steam 兑换一开始被判成「做不了」**：实测三层（302 被拒 → 换 store 域会话仍被打回 → 带全 Cookie 仍被拒）后定性为「平台缺会话刷新能力」；补上 `sessionRefresh` 后一次通过。教训：区分「协议不支持」与「我们缺能力」。

## 被实测推翻的结论

- 「AstraHub 的 WebDAV 无法在真实 NAS 上验证」→ 经 nas-mirror 镜像端口完全可行，实测 0.2 秒返回 `reachable`。
- 「登录页只有深色」→ 它本来就有 `prefers-color-scheme` 的日间配色，缺的是手动切换与共用偏好。
- 「检测应该做成自动」→ 与设计稿「总览不主动联网」冲突，改为用户点击触发 + 结果落盘。

## 数字与位置

- 提交：`d38a578`（检测结果落盘）、`ef04eca`（总览检测）、`2cea697`（67 号改名）、`d5c2168`（WebDAV 总览文档）、`844dfd4`（文档索引）、`78f37c9`（外观偏好共用）、`050009c`（网络原子保存 + 凭据顺序）、`400adb9` 与 `cd2da50`（打包缺陷）、`f2da9f8`（会话刷新 + 激活码兑换）。
- 验收记录：`astrahub/docs/migration/56-本机设置中心验收.md`（共八节）。
- 真机数据：NAS 根 31 个条目；上传 111 B，SHA256 `da6a44e6…` 在上传与下载两侧一致。

## 追加：设置中心"加载慢"的根因（同日）

现象：页面首屏要等 3–4 秒。逐端点计时后发现**每次调用都慢**（不是冷热问题）：

- `capabilityStatus()` 里有一句 `await credentials.available()`，它**每次都真的做一次 DPAPI 往返**；DPAPI 助手每 spawn 一次约 0.6 s；
- `auth.status` 要逐条解密会话信封（一条 = 一次 PowerShell 进程）；
- 页面首屏还用 `Promise.all` 等这三项全部返回才渲染，等于把等待放大。

改法（不动安全模型）：

1. `LocalCredentials.available()` 进程内缓存探测结果——DPAPI 能力在一个进程生命周期内不会变；
2. `LocalCredentials.get()` 加进程内解密缓存，键是凭据引用、值是「密文指纹 + 明文」，重新 set／remove 即失效；
3. UI 启动时预热一次能力状态，把那 0.6 s 挪到浏览器打开之前。

实测（同一数据根）：overview 2412 → 182／14／7 ms；capabilities 2260 → 7 ms；accounts 3324 → 7 ms；首屏三个并发约 3.4 s → 26 ms；安装版首次页面加载 169 ms。

教训：**"慢"要先量再改**（我一开始猜是前端体积或网络，实际是服务端每次起 PowerShell）；
另外 `pnpm typecheck` 是 `--noEmit`，改完必须跑会产出的 `tsc`，否则 dist 里根本不是新代码——这一条我当天踩了一次。
