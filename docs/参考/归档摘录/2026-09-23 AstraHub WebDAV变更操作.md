# AstraHub WebDAV 变更操作

本批（0.40.0）实现 DAV-C06/C07：`webdav.move`、`webdav.copy`、`webdav.remove`。98 操作、ZIP SHA256 `8a3d2079…0403`。

## 踩过的坑

- **夹具的 hook 必须第一个跑**：我把 MOVE/COPY/DELETE 的服务端语义插在鉴权之后、`hook?.(req,res)` 之前，于是"局部失败""连接断开"这类用 hook 注入的测试全部失效——请求被我的正常分支处理掉了，测试当然拿不到预期错误。插入位置本身是逻辑，不只是格式。
- **批量替换会替换所有匹配**：第一次插入用了一个在文件里出现两次的锚点，处理块被插进了另一个测试的 hook 里，编译直接炸。**插代码前先数锚点出现次数**（`Select-String -Pattern ... .Count`），必要时挑唯一锚点。
- **夹具的路径包含连接前缀**：fixture 内部用完整 pathname（`/dav/...`），而平台 API 里的路径是连接根相对（`/...`）。我的断言一开始混用两套，`directories.has('/box')` 永远是 false。写断言前先确认"这是谁的视角"。
- **旧的"覆盖"是默认行为，不是选项**：旧实现 `moveFile/copyFile` 一律 `overwrite: true`；新契约默认 `Overwrite: F`，把"覆盖"变成必须显式声明的决定。删除同理：旧实现直接 DELETE，没有任何"仅空目录"检查，服务端可能整棵删掉——现在非空目录**在发出 DELETE 之前**就被拒绝，并如实给出直接子项数。

## 结果

0.40.0 已安装：98 操作（新增 `webdav.move/copy/remove`，平台 HTTP 放行 `MOVE`/`COPY`/`DELETE`）。既有 WebDAV 测试夹具补上三个方法的服务端语义，`tests/local-webdav.test.ts` 32/32 通过（含 5 项新增：默认不覆盖与显式覆盖、目录移动 Depth: infinity 并带走子项、拒绝先于网络、非空目录在 DELETE 前被拒、207 与中断不伪装成功）。

三环境（源码/包内/本机）用自建夹具服务器跑真实验收，结果一致：`MOVE/COPY` 带 `Overwrite: F`、重复复制返回 `WEBDAV_EXISTS`、显式覆盖发送 `Overwrite: T`、目录移动带 `Depth: infinity`、非空目录被 `WEBDAV_DIRECTORY_NOT_EMPTY` 拦下、递归删除返回 `directChildren=1`、删除文件返回 `kind=file`。媒体探测在同版本上回归通过。

**本机没有已配置的 WebDAV 连接**，因此验收全部走本地夹具服务器，不代表对具体 NAS 的可用性保证；这一点写进了验收记录。本地 Git 提交，未 push。
