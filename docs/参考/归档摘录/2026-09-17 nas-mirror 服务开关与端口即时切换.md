# 2026-09-17 nas-mirror 客户端：按服务即时开关 + 即时改本机端口

## 起因

用户看过状态页后提需求：**"能够单独的自定义设置端口号、单独的开启关闭开关"**。
定位阶段确认了两件事：

1. "按服务改端口"其实**已经有了** —— `services[].local_port`，只是只能改配置文件、改完要重启；
2. "按服务开关"完全没有，而且**监听器是启动时一次性建好的**（`main.go` 里 `net.Listen` + `http.Server`），
   页面此前只能切"链路模式"。

用户选定范围：**状态页即时开关 + 即时改端口**；改动**另存 `services.json`，不动 `config.json`**。

## 做了什么

- 新增 `client/service.go`：
  - `serviceRuntime` —— 一个服务的监听生命周期（`SetEnabled` / `SetPort` / `Stop`），带自己的锁。
  - `serviceStore` —— 页面改动的落盘（`%USERPROFILE%\.nas-mirror\services.json`，键是 **NAS 端口**）。
- `client/main.go`：改用 runtime 启动；启动时用 store 里的覆盖值（`enabled` / `local_port`）决定端口与开关。
- `client/status.go`：`/service` 接口 + 页面每行一个「开/关」按钮与端口输入框；`/status.json` 增加
  `nas_port` / `local_port` / `enabled` / `running` / `listen_error`。
- `client/config.go`：新增 `services[].enabled`（默认 true）作为"首次运行的默认值"。

## 几个刻意的设计决定（都有测试兜着）

1. **意图与实际分开**：`enabled`（开关）与 `running`（真在监听）是两个字段。开启失败时
   **意图照旧落盘**，页面显示"监听失败"而不是弹回"已关闭" —— 否则用户会以为没点上。
2. **改端口失败要回滚**：先释放旧端口再绑新端口，**新端口绑不上就退回原端口**；
   退回也失败才置为关闭，并把两个原因都写进 `last_error`。绝不能因为改端口把服务弄没了。
3. **状态另存一个文件**：`config.json` 里全是 `_说明` 这类注释键，用 `encoding/json` 重写会把它们
   全部丢掉（用户手写的说明就是配置的一半价值）。所以页面改动写 `services.json`，想回默认值就删掉它。
4. **冲突提前说清楚**：改端口时先查"是不是状态页在用"、"是不是本客户端另一个服务在用"，
   报"端口 8890 已经被 nas-console 占用"，而不是让 bind 返回 `address already in use`。
5. **关服务只关监听、不关会话**：会话仍按端口在后台续期，重新开启后不用等重新登录。
6. **按服务粒度保住了原有的致命性**：启动时就该起来的服务，`Serve` 出错仍然上报主循环（进程退出，原行为）；
   运行期由页面起的服务出错只记日志 + `last_error`，不拖垮整个客户端。

## 验证（真机，不是只看单测）

- 单测 90 项全过（新增 8 项：落盘往返、坏文件、启停释放端口、改端口回滚、关着的服务不占端口、
  接口的 404/400/409、失败保留意图）。判据用**"能不能重新绑上那个端口"**，不是看进程状态。
- 真机（重启客户端后逐个打接口）：

  | 操作 | 结果 |
  |-|-|
  | 关 hermes-api(8642) | 200；`enabled=false/running=false`；**8642 真的连不上了** |
  | 改到状态页 8898 / 到 nas-console 的 8890 / 到 0 | 全部 400，报错里点名是谁占的 |
  | 不存在的服务 / 非 POST | 404 / 405 |
  | 关着时把端口改成 18642 → 再开启 | 200；18642 可连、**8642 已释放**；`services.json` 落盘 |
  | 端口被别的进程占着时开启 | 409 + 真实的 bind 报错；`enabled=true/running=false`；页面显示"监听失败" |
  | 删掉 `services.json` 重启 | 9 个服务全部回到配置里的端口、全部在监听 |

- 临时状态已清理：测试用的 `services.json` 已删除，客户端以配置默认值重新启动。

## 踩过的坑

1. **PowerShell 7 的 `Invoke-WebRequest` 遇到 4xx/5xx 会抛异常**，而我的 catch 里用的是
   `.NET Framework` 时代的 `$_.Exception.Response.GetResponseStream()` —— PS7 里那是
   `HttpResponseMessage`，**没有这个方法**，于是校验用例全都"没输出"。
   我一度以为接口没被调用。**正确做法是加 `-SkipHttpErrorCheck` 直接拿响应看状态码**。
   又一次印证本项目硬约定 #4：没有输出的"通过"不算通过。
2. **`gofmt -l` 报的 4 个文件不是我弄脏的**。用 `git show HEAD:client/x.go > tmp && gofmt -l tmp`
   跟改动前对比，确认 `authelia.go`/`mode.go`/`config.go`/`status.go` 本来就是未格式化状态
   （中文全角括号后的注释空格、map 字面量对齐）。**不动无关文件**，只在报告里提一句。
3. 页面原本用 `<meta http-equiv="refresh" content="5">` 自动刷新 —— 加了输入框之后这会**把用户
   打到一半的端口号冲掉**，而且会打断正在进行的 POST。改成 JS 定时器 + `busy` 标记：
   输入框获得焦点或请求在途时不刷新。

## 遗留风险 / 未做

- 关着的服务**改端口不做绑定预检**（只有开启时才真绑），所以"填了个被占的端口"要到开启时才发现，
  报错在 `listen_error` 里。
- `--mode` 那样的命令行入口没给服务开关加（`--service` / `--port`），页面与 HTTP 接口是唯一入口。
- `services.json` 与 `config.json` 里 `services[]` 的对应关系靠 **NAS 端口**；若以后改了某个服务的
  `port`，它在 `services.json` 里的状态会变成"孤儿"（不会出错，只是失效）。
