# kura-server 镜像（S1：认证 + 反代 + 清单；S2 起加 rclone，S3 起加 kura-shell 入口）
# 构建上下文是仓库根：docker build -f server/Dockerfile -t kura-server .

FROM node:24-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN node server/build.mjs

FROM node:24-alpine
WORKDIR /app
COPY --from=build /src/dist/server/ ./
ENV KURA_STATE=/state KURA_PORT=8080 NODE_ENV=production
EXPOSE 8080
# 健康检查只打免认证的 /api/health
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/api/health >/dev/null || exit 1
ENTRYPOINT ["node", "main.mjs"]
CMD ["serve"]
