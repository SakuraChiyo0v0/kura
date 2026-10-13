# AGENTS.md — Kura 蔵

本文件在工作于本目录时自动加载，只写 **Kura 自身**的定位、决策与约束。
通用规范（沟通方式、代码风格、Git 流程）见全局 `~/.dsh/AGENTS.md`，此处不重复。

---

## 一、Kura 是什么

绿联 NAS 的 Windows 桌面客户端。启动即在后台提供 NAS 访问能力，主窗口用来看状态、做操作。

- **范围**：只适配绿联 UGOS、单设备、单用户、只做 Windows。先做出基本的软件形态，不考虑多厂商 / 多系统 / 多用户。
- **技术栈**：TypeScript + Electron + React；界面用 Sakura UI（`@sakura-ui/react`、`@sakura-ui/tokens`），
  Electron 能力用 `@sakura-ui/electron` 与 `@sakura-ui/electron-react`。不引入第二套 UI 体系。

## 二、已定的决策（2026-10-13）

| 项 | 决定 |
|-|-|
| 端口映射核心 | **用 TS 重写** nas-mirror 的 Go 客户端，不做 Go sidecar（后续技术栈统一） |
| 文件 | 程序内文件管理器 **＋** 给本机其他程序提供 WebDAV 服务 |
| 终端 | 复用 NAS 上已有的 nas-console（`WS /api/tty`、`POST /api/exec`），客户端只做 xterm 界面 |
| 进阶功能 | 做成**按需安装的模块**（首个：rclone 挂载为磁盘，需 rclone + WinFsp） |
| 凭据 | 首次启动走引导，本地用 Electron `safeStorage`（DPAPI）加密保存 |
| 形态 | 托盘常驻、单实例、可开机自启；关窗口不退出，映射继续跑 |

## 三、架构原则

```
渲染进程（Sakura UI）  概览 │ 服务映射 │ 文件管理 │ 终端 │ 模块 │ 设置
        │ IPC
主进程   连接核心：绿联会话 / Authelia 网关 / lan·wan·auto / watchdog
         └ 本机回环端口映射 127.0.0.1:<端口>
              ↑ 文件管理器(WebDAV)  ↑ 终端(nas-console)  ↑ 外部程序 / rclone 模块
```

1. **一切能力都建在映射层之上**：文件管理器、终端、rclone、外部程序都只连本机回环地址。
   链路切换、会话续期、认证只在连接核心里处理一次，上层功能不认识绿联。
2. **长驻的东西放主进程**（映射、续期、探测、子进程），渲染进程只做界面，关掉窗口不影响服务。
3. **传输层不认识应用**：连接核心里不写任何具体应用的知识；需要"给某服务加个头"这类需求，
   做成通用配置能力（nas-mirror 设计方案 §十一的教训）。

## 四、重写映射核心时必须保住的行为

这些都是 nas-mirror 实测验证过、踩过坑才定下的，**改动或省略前先读来源**：

1. **只发起出站请求**，不开任何能从外部反向连进本机的通道。
2. **只监听回环地址**，配置成非回环要直接拒绝启动。
3. **不跟随重定向**：绿联中继用 `302 → UGOS 登录页` 伪装"未认证"，跟随了就永远发现不了失败。
4. **lan 模式拨局域网 IP，但 Host 头仍发公网域名**：Authelia 校验 cookie 域，用 IP 当 Host 会 401
   （日志：`no configured session cookie domain matches the url`）。
5. **认证失败分两类**：凭据类（401 / `status=KO`）停止重试、冷却 10 分钟；链路类（超时 / 5xx）台阶退避。
   网关 500（`auth_request` 子请求失败）也要能触发会话重建，Go 版这里有缺口。
6. **watchdog 主动探测**：按流量统计的状态在服务死掉时反而全绿，必须从本机监听地址走全链路探测。
7. **调用方主动断开不算失败**（`context canceled` 一类），否则状态长期一片红。
8. 只能映射**已发布到宿主的端口**；SSH / SMB 等裸 TCP 过不了中继。

重写以 Go 版测试（尤其 `mirror_integration_test.go`）为基线逐条翻译，证明行为没丢。

## 五、尚未证实（别当成已知事实）

- **绿联中继是否支持 WebSocket**：决定外网下终端能不能用。做终端前先拿 nas-console 的 `/api/tty` 实测；
  不支持就把终端标成"仅局域网"。
- **能否从登录结果自动拿到设备公网域名**：决定引导里要不要让用户手填。

## 六、参考来源

| 来源 | 位置 | 用途 |
|-|-|-|
| nas-mirror | `../../NAS-PROJECTS/nas-mirror/`（GitHub `SakuraChiyo0v0/nas-mirror`） | 映射核心的行为基线；`server/` 是 NAS 侧网关与服务清单，继续沿用 |
| nas-mirror 设计方案 | `../../NAS-PROJECTS/docs/nas-mirror-设计方案.md` 及 `docs/归档/` | 安全模型、链路实测、踩坑记录 |
| nas-console | GitHub `SakuraChiyo0v0/nas-console` | 终端与 exec 接口 |
| ugreen SDK | `../../NAS-PROJECTS/ts-dev-kits/packages/ugreen` | UGOS 登录链、WebDAV |
| Sakura UI | `../../NAS-PROJECTS/sakura-ui/` | 组件、tokens、Electron 包 |

**有冲突时以当次实测为准**：nas-mirror 的文档出现过"改了 A 处漏了 B 处"、"注释与运行状态不符"。

## 七、工作约定

- **不主动扩需求**：先给方案、说清代价，用户点头再动手。
- **不提交、不 push**，除非用户明确说了。
- **commit message 只写改了什么功能／行为**，必要时一句为什么；排查过程和弯路写进 `docs/归档/`。
- 每完成一件成体系的事，在 `docs/归档/` 加一份 `YYYY-MM-DD <主题>.md`，重点写「踩过的坑」：
  "我以为是 A，实测是 B，因为 C"。不改写历史，情况变了就补一句「已于 X 日变更」。
- **危险删除前先打印解析后的绝对路径并确认**，按已知路径逐个删，不用通配符递归（Windows 路径不区分大小写，出过事故）。
