# 2026-10-26 Docker socket 探测不再一次定生死

## 现象

Kura 报：

> NAS 上的 kura-server 还没有容器管理（镜像太旧，等 watchtower 换新）

直接连本机 Docker 隧道也 404，于是「`docker compose up` 这条路走不通」这个结论也随之而来。

## 实测：三句话两句是错的

| 报的话 | 实际 |
|-|-|
| 镜像太旧 | **镜像是最新的**（当天 20:59 构建） |
| 2375 连不上 Docker | 2375 上跑的是 **kura-server 的内置 docker 服务**，不是裸 Docker API，`/version` 本来就 404 |
| 等 watchtower 换新 | 换新永远等不到 —— 问题跟镜像版本无关 |

真正的原因在 kura-server 启动日志里：

```
2026-10-22T14:57:59Z INFO Docker socket 已找到 路径="/var/run/docker.sock" 来源="env"
2026-10-25T02:44:21Z INFO 没有可用的 Docker socket，Docker / 数据库功能不可用
```

10-25 02:43:52 容器重启（宿主刚起来），29 秒后探测判定「没有 socket」，**此后整个进程生命周期都不再重探**。
而我实测时（11:12）容器内两个路径 ping 都是 `200 OK` —— socket 早就好了，只是没人再去问它。

同时 `__services` 清单里**根本没有 `docker`** 这一条。因为 `main.ts` 里写的是：

```ts
...(hasDocker ? { docker: 2375 } : {})
```

启动时探不到，这条内置服务就永不登记。客户端只能拿到 404，然后把 404 翻译成「镜像太旧」。

## 坑在哪

1. **探测是一次性的，失败即永久**。容器跟着宿主重启时，dockerd 往往比容器慢一拍 —— 这是启动竞态的典型形状，
   却被做成了「必须人工重启才能恢复」的永久状态。
2. **失败被翻译成了错误的原因**。404 的真实含义只有「服务端没有这条路由」，可能是镜像旧，
   也可能是这一轮没挂上功能。原来那句「镜像太旧，等 watchtower」把人引向一个**永远等不到的修复**。
3. **`/version` 404 被当成了隧道坏掉的证据**。2375 是 kura-server 的内置服务端口，
   它只认 `/api/*`，不认 Docker 的 `/version`。拿它测「Docker 隧道通不通」从一开始就问错了对象。

## 改了什么

- `server/src/docker/socket.ts`：`findDockerSocket` **会轮询**（默认 3 轮 × 1 秒），不再是探一次就走。
- 新增 `DockerSocketResolver`：探不到**不判死**。探到了就缓存；没探到则冷却 10 秒后**下次有人用时再探**；
  调用方发现失效可以 `invalidate()` 丢掉缓存。并发调用共用同一次探测。
- `server/src/main.ts`：`docker` 内置服务**无条件登记**，socket 改成 getter 现取（`sockets.require()`）。
  启动那一刻探不到也没关系，第一次请求会先等一次探测再进 handler。
- `server/src/docker/engine.ts`：`socketPath` 支持 getter；拿不到 socket 时报一条人话，
  不是把 `undefined` 当路径用。
- `server/src/docker/autoupdate.ts`：`self` 也允许给 getter（socket 宿主路径要等探到才知道）。
- `src/core/docker-client.ts`：404 的文案改成**同时给出两种可能 + 一个真正有效的动作**：
  「先重启一次 kura-server 容器；还不行再看 `/__services` 里有没有 `docker`」。

顺带修了构建：`server/Dockerfile` 里 `docker-cli~29.8` / `docker-cli-compose~5.1` 因上游升到
29.9.2 / 5.6.1 解析不到（`unable to select packages`），跟到 `~29.9` / `~5.6`。
这是同一个坑的第二次（上次是 Alpine 重打包修订号）。已对过宿主：Engine 29.6.2 / Compose v5.1.3，
CLI 比 daemon 新一点是常规操作。

## 怎么验证的

- 单测 17 条（`server/test/socket.test.ts`），其中轮询与自愈各一条。
- **按规矩撤掉修复确认会变红**：
  - 把 `rounds` 默认改回 1 → 「第二轮才通」那条红；
  - 把冷却改成「miss 一次就永久判死」→「冷却过后再问就好了」那条红。
- 真机构建部署后：`__services` 里 `docker` 出现，容器页 16 个容器 / 14 个项目全部读出。

## 还留着的事

- 真机上 `KURA_SELF_DIR` 依然没配（老问题，见项目记忆），与本次无关。
- 没做「主动制造启动竞态」的复现验证（需要停容器并卡在探测窗口内，有把服务卡住的风险）。
  自愈逻辑由单测覆盖，且已确认测试能抓到回归。
- 部署时把 `ghcr.io/.../:latest` 覆盖成了本地构建的镜像，旧镜像留了 `kura-server:rollback` 标签可回退。
  等下一次 CI 推送新镜像后会自然覆盖回来。
