# @sakurachiyo0v0/ugreen

绿联 UGOS / OpenList NAS WebDAV 上传 SDK：自动重放 UGOS 登录链路、缓存网关会话 cookie、把文件上传/列目录到 OpenList 虚拟路径。支持两种网关：**ugapp**（UGOS 应用市场的应用，如 OpenList 应用）与 **ugdocker**（Docker「对外访问」的容器）。

## 为什么需要它

OpenList 的 WebDAV / API 挂在绿联 app 网关（`ugapp.link`）后面，网关要求先建立 UGOS 会话 cookie（`ugreen-proxy-token`）。这个 cookie 由登录后的 JS 写入，无法手动复制长期使用。本包全自动重放整套流程：

1. `POST /ugreen/v1/verify/check` → 响应头 `X-Rsa-Token` 返回 RSA 公钥
2. 用该公钥按 RSA PKCS#1 v1.5 加密密码
3. `POST /ugreen/v1/verify/login` → 会话 cookie + `api_token` + 第二把公钥
4. `GET /ugreen/v1/gateway/proxy/onceToken?proxy_id=…`（ugapp）或 `GET /ugreen/v1/gateway/proxy/dockerToken?port=…`（ugdocker）→ 一次性令牌
5. `GET {appHost}/api/ugreen/auth?token=…` → HTML 里带「轮换后的」`ugreen-proxy-token`
6. WebDAV `PUT /dav/{目标路径}` → 201 Created

## 特性

- 自动登录 + 会话 cookie 缓存（默认内存，TTL 10 分钟，可插拔存储）
- 同时支持 ugapp / ugdocker 两种网关：按 `appHost` 后缀自动识别，也可显式指定 `kind`
- 上传时若被网关踢回（302/401），自动清缓存重登并重试一次
- 文件名非法字符清洗、路径规范化、凭据脱敏（错误消息不泄露密码/token）
- 带 CLI `sc-ugreen`（test / list / upload）

## 安装

同一 pnpm workspace 内：

```powershell
pnpm add @sakurachiyo0v0/ugreen@workspace:*
```

从 GitHub monorepo 安装（需在消费项目 `pnpm-workspace.yaml` 中授权构建脚本）：

```powershell
pnpm add "git+https://github.com/SakuraChiyo0v0/ts-dev-kits.git#path:/packages/ugreen"
```

## 快速开始

```ts
import { createUgAppClient } from "@sakurachiyo0v0/ugreen";

const client = createUgAppClient({
  appHost: "app-xxxxxxxx-<设备>-xxxxx.cn30.ugapp.link",
  proxyId: "xxxxxxxxxxxxxxxxxxxx",
  username: "<用户A>",
  password: "your-password",
  baseDir: "/<设备>/<用户A>/下载", // 可选，默认即此
});

// 上传（302/401 自动重登重试一次）
const r = await client.upload("test.png", Buffer.from("..."));
if (r.ok) console.log("已上传:", r.path);

// 列目录
const list = await client.list();
console.log(list);

// 连通性测试
const test = await client.test();
console.log(test);
```

### 连 Docker「对外访问」的容器（ugdocker）

Docker 容器开了「对外访问」后也有一个 `app-{port}-…ugdocker.link` 地址。配置一样，`proxyId` 填对外访问的**端口**，网关类型按地址后缀自动识别（也可显式 `kind: "ugdocker"`）：

```ts
import { createUgAppClient } from "@sakurachiyo0v0/ugreen";

const client = createUgAppClient({
  appHost: "app-5244-<设备>.cn30.ugdocker.link",
  proxyId: "5244",            // docker 对外访问端口
  username: "<用户A>",
  password: "your-password",
  baseDir: "/<设备>/<用户A>",
});

await client.upload("test.png", Buffer.from("..."));
await client.list();
```

### cookie 持久化（可选）

默认使用进程内内存缓存；需要跨进程/重启持久化时传入自定义 `CookieStore`：

```ts
import { createUgAppClient, type CookieStore } from "@sakurachiyo0v0/ugreen";

const sqliteStore: CookieStore = {
  get() {
    const row = db.prepare("SELECT cookie, saved_at FROM meta WHERE key='nas_cookie'").get();
    return row ? { cookie: row.cookie, savedAt: new Date(row.saved_at).getTime() } : null;
  },
  set(cookie, savedAt) {
    db.prepare("INSERT INTO meta (key, cookie, saved_at) VALUES ('nas_cookie', ?, ?) ON CONFLICT(key) DO UPDATE SET cookie=excluded.cookie, saved_at=excluded.saved_at").run(cookie, new Date(savedAt).toISOString());
  },
  clear() {
    db.prepare("DELETE FROM meta WHERE key='nas_cookie'").run();
  },
};
```

## CLI

```powershell
# 连通性测试
sc-ugreen test --app-host <host> --proxy-id <id> --username <user> --password <pass>

# 列目录
sc-ugreen list --app-host <host> --proxy-id <id> --username <user> --password <pass>

# 上传本地文件
sc-ugreen upload test.png --file ./test.png --app-host <host> --proxy-id <id> --username <user> --password <pass>
```

密码建议用环境变量（`UGREEN_APP_HOST` / `UGREEN_PROXY_ID` / `UGREEN_USERNAME` / `UGREEN_PASSWORD` / `UGREEN_BASE_DIR`），避免出现在进程列表。

> docker 网关时 `--proxy-id` 填对外访问端口（如 `5244`），网关类型按 `appHost` 后缀自动识别。

## 安全说明

- 密码为明文入参，仅用于本地登录链路；所有对外错误消息均脱敏。
- 会话 cookie 缓存包含网关凭据，持久化存储时请放在受保护的位置。
