# kura-server 镜像（S1：认证 + 反代 + 清单；S2：rclone；S3 起加 kura-shell 入口）
# 构建上下文是仓库根：docker build -f server/Dockerfile -t kura-server .

# ---- 取 rclone：固定版本 + SHA256 校验，校验不过直接构建失败 ----
FROM node:24-alpine AS rclone
# rclone 版本与 server/src/webdav.ts 里的 rcloneRelease 必须一致（改一处就要改另一处）
ARG RCLONE_VERSION=v1.75.2
ARG RCLONE_SHA256=349ac8fba6ff65d6247043f1750cdcb518ec5d500ef91463a10d37c0ccdf3702
RUN apk add --no-cache curl unzip && \
    curl -fsSL -o /tmp/rclone.zip "https://downloads.rclone.org/${RCLONE_VERSION}/rclone-${RCLONE_VERSION}-linux-amd64.zip" && \
    echo "${RCLONE_SHA256}  /tmp/rclone.zip" | sha256sum -c - && \
    unzip -j /tmp/rclone.zip "rclone-${RCLONE_VERSION}-linux-amd64/rclone" -d /usr/local/bin && \
    chmod +x /usr/local/bin/rclone && \
    /usr/local/bin/rclone version

FROM node:24-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN node server/build.mjs

FROM node:24-alpine
# rclone 要用 `-L` 跟随符号链接，得有个 shell 环境；curl 留给 kura-shell 的入口脚本用
RUN apk add --no-cache ca-certificates tzdata
COPY --from=rclone /usr/local/bin/rclone /usr/local/bin/rclone
WORKDIR /app
COPY --from=build /src/dist/server/ ./
ENV KURA_STATE=/state KURA_PORT=8080 NODE_ENV=production
EXPOSE 8080
# 健康检查只打免认证的 /api/health
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/api/health >/dev/null || exit 1
ENTRYPOINT ["node", "main.mjs"]
CMD ["serve"]
