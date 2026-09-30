# ============================================================
# Dockyard 浏览器工作平台 — All-In-One 独立服务端完整包
# 内置：Next.js 主服务(standalone) + WS枢纽 + Prisma + 全部依赖
# 部署：支持 host 网络模式 / 桥接模式；CDP服务端口可用环境变量改变
# ============================================================

# ---- 依赖安装层 ----
FROM oven/bun:1.3-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# ---- 构建层 ----
FROM oven/bun:1.3-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# 数据库 schema 生成 Prisma Client（构建时需要）
RUN bunx prisma generate
# Next.js standalone 构建（产物自带 server.js + 精简 node_modules）
ENV DATABASE_URL="file:/app/db/build-placeholder.db"
RUN bunx next build

# ---- 运行层（All-In-One 独立包）----
FROM oven/bun:1.3-alpine AS runner
WORKDIR /app
# Prisma 查询引擎在 musl 上动态链接 OpenSSL 3；busybox wget 供健康检查/内置调度器使用
RUN apk add --no-cache openssl
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    CDP_SERVICE_PORT=9222 \
    WS_HUB_PORT=3003 \
    DATABASE_URL="file:/app/db/custom.db" \
    STORAGE_LOCAL_PATH=/app/storage \
    HOSTNAME=0.0.0.0

# 运行层完整依赖（All-In-One：无外部依赖、免编译环境）
COPY --from=deps /app/node_modules ./node_modules
# Next.js standalone 产物
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
# 源码资产：prisma schema / 种子 / 定时脚本 / WS枢纽 / 前端引用资源
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/mini-services ./mini-services
COPY --from=builder /app/src/lib/config.ts ./src/lib/config.ts

# 启动/停止/守护/自检脚本（自动初始化数据库 + 守护自愈 + 自检）
COPY docker/start.sh docker/stop.sh docker/healthcheck.sh docker/entrypoint-guard.sh /app/docker/
RUN chmod +x /app/docker/*.sh \
    && mkdir -p /app/db /app/storage/backups /app/storage/uploads \
    && echo "dockyard" > /app/.app-marker

# 数据卷：数据库 / 文件存储 / 备份
VOLUME ["/app/db", "/app/storage"]

# 主服务端口（host 模式下由 PORT 环境变量控制）
EXPOSE 3000 3003
# CDP 服务后台端口（可用 CDP_SERVICE_PORT 环境变量改变）
EXPOSE 9222

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD /app/docker/healthcheck.sh

# 守护式入口：主进程崩溃自动整轮重启（崩溃原因输出 docker logs）；docker stop 优雅终止
# 此前直接执行 start.sh：主进程任何异常退出都会让容器静默停止
ENTRYPOINT ["/app/docker/entrypoint-guard.sh"]
