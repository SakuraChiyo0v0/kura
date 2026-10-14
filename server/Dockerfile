# kura-server 镜像（一个镜像两个入口：serve / shell）。构建上下文是仓库根：
#   docker build -f server/Dockerfile -t kura-server .

# ---- 取 rclone：固定版本 + SHA256 校验，校验不过直接构建失败 ----
FROM node:24-alpine AS rclone
# rclone 版本与 server/src/webdav.ts 里的 rcloneRelease 必须一致（改一处就要改另一处）。
# ARG 名**不能**以 RCLONE_ 开头：ARG 在 RUN 期间就是环境变量，而 rclone 把所有 RCLONE_* 环境
# 变量当成同名命令行开关 —— RCLONE_VERSION=v1.75.2 会被读成 `--version v1.75.2`（布尔开关），
# `rclone version` 直接报错。所以这里用 RC_ 前缀。
ARG RC_VERSION=v1.75.2
ARG RC_SHA256=349ac8fba6ff65d6247043f1750cdcb518ec5d500ef91463a10d37c0ccdf3702
RUN apk add --no-cache curl unzip && \
    curl -fsSL -o /tmp/rclone.zip "https://downloads.rclone.org/${RC_VERSION}/rclone-${RC_VERSION}-linux-amd64.zip" && \
    echo "${RC_SHA256}  /tmp/rclone.zip" | sha256sum -c - && \
    unzip -j /tmp/rclone.zip "rclone-${RC_VERSION}-linux-amd64/rclone" -d /usr/local/bin && \
    chmod +x /usr/local/bin/rclone && \
    /usr/local/bin/rclone version

# ---- 编译 node-pty：原生模块，只在 kura-shell 容器里用，打包进镜像 ----
# 不在容器里现场编译（UGOS 内核 / glibc 不可控），构建阶段编译好、连 node_modules 一起 copy。
FROM node:24-alpine AS pty
RUN apk add --no-cache python3 make g++
WORKDIR /pty
RUN npm init -y >/dev/null && npm i --build-from-source node-pty@1.1.0

FROM node:24-alpine AS build
WORKDIR /src
# vendor/ 必须跟 package.json 一起先到：依赖里有 file:./vendor/sakura-ui/*.tgz，
# npm ci 在这一步就会去解析它们，晚一步就是 ENOENT（早先漏了，构建直接失败）。
COPY package.json package-lock.json ./
COPY vendor ./vendor
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
COPY server ./server
RUN node server/build.mjs

FROM node:24-alpine
# rclone 要用 `-L` 跟随符号链接；kura-shell 要 nsenter / bash 进宿主
RUN apk add --no-cache ca-certificates tzdata bash util-linux
COPY --from=rclone /usr/local/bin/rclone /usr/local/bin/rclone
# WORKDIR 必须在 COPY 之前：不然 node_modules 会落到 /node_modules，node 找不到（模块解析从 /app 往上找）
WORKDIR /app
COPY --from=pty /pty/node_modules ./node_modules
COPY --from=build /src/dist/server/ ./
ENV KURA_STATE=/state KURA_PORT=8080 NODE_ENV=production
EXPOSE 8080 8890
# 健康检查打免认证的 /api/health（serve 与 shell 都有）。
# 一个镜像两个入口，端口来源不同：serve 用 KURA_PORT，shell 用 KURA_SHELL_PORT。
# 上面 ENV 里 KURA_PORT=8080 对 shell 容器同样生效，所以不能只看 KURA_PORT —— 两个都试。
HEALTHCHECK --interval=30s --timeout=5s CMD sh -c 'wget -qO- "http://127.0.0.1:${KURA_PORT:-8080}/api/health" >/dev/null || wget -qO- "http://127.0.0.1:${KURA_SHELL_PORT:-8890}/api/health" >/dev/null || exit 1'
ENTRYPOINT ["node", "main.mjs"]
CMD ["serve"]
