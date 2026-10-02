# ============================================================
# Dockyard 浏览器工作平台 — 单容器全内置完整包（r13）
# 一个容器 = 整个平台，零外部服务：
#   · Next.js 主服务(standalone) + WS枢纽(3003/3004) + VNC网关桥(3005)
#   · 每工作区嵌入式沙箱进程树：Xvfb + Chromium + x11vnc（同容器内编排）
#   · sing-box 代理进程（同容器进程模式，不再需要外部容器/镜像）
#   · Prisma(SQLite) + 全部依赖
# 部署：支持 host 网络模式 / 桥接模式；零 Docker-in-Docker、零外部镜像依赖
# ============================================================

# ---- 依赖安装层 ----
FROM oven/bun:1.3 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# ---- 构建层 ----
FROM oven/bun:1.3 AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# 数据库 schema 生成 Prisma Client（构建时需要）
RUN bunx prisma generate
# Next.js standalone 构建（产物自带 server.js + 精简 node_modules）
ENV DATABASE_URL="file:/app/db/build-placeholder.db"
RUN bunx next build

# ---- 运行层（单容器全内置：平台 + 浏览器 + VNC + sing-box）----
FROM oven/bun:1.3 AS runner
WORKDIR /app
ARG TARGETARCH
ARG SINGBOX_VERSION=1.10.7

# 全内置运行时组件：
#   chromium/xvfb/x11vnc  —— 嵌入式沙箱进程树（每工作区独立显示/VNC/CDP）
#   util-linux(setpriv/prlimit/unshare) —— 沙箱用户降权 + 进程数硬上限 + 用户/挂载命名空间
#   fonts-noto-cjk        —— 中文/日文/韩文渲染
#   openssl               —— Prisma 查询引擎链接库 + 密钥生成
#   iproute2(ss)          —— 端口占用自检；wget —— 健康检查/内置调度器
RUN apt-get update -o Acquire::Retries=5 \
    && apt-get install -y --no-install-recommends \
      chromium \
      xvfb \
      x11vnc \
      xauth \
      procps \
      psmisc \
      util-linux \
      fonts-noto-cjk \
      fonts-liberation \
      openssl \
      ca-certificates \
      wget \
      iproute2 \
    && (apt-get install -y --no-install-recommends fonts-noto-color \
        || echo "[warn] fonts-noto-color 不可用，跳过（CJK 字体已含于 fonts-noto-cjk）") \
    && rm -rf /var/lib/apt/lists/* \
    # X socket 目录（Xvfb 挂载 unix socket 用）
    && mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix \
    # Chromium 托管策略挂载点：每沙箱经 unshare 私有挂载命名空间 bind 各自策略文件至此路径
    && mkdir -p /etc/chromium/policies/managed \
    && echo "{}" > /etc/chromium/policies/managed/dockyard.json

# sing-box 二进制（容器内进程模式；按目标架构下载，失败不阻断镜像构建——代理为可选功能）
RUN set -e; \
    SBARCH="$( [ "$TARGETARCH" = "arm64" ] && echo arm64 || echo amd64 )"; \
    wget -q -T 30 -O /tmp/sing-box.tar.gz \
      "https://github.com/SagerNet/sing-box/releases/download/v${SINGBOX_VERSION}/sing-box-${SINGBOX_VERSION}-linux-${SBARCH}.tar.gz" \
      && tar -xzf /tmp/sing-box.tar.gz -C /tmp \
      && mv "/tmp/sing-box-${SINGBOX_VERSION}-linux-${SBARCH}/sing-box" /usr/local/bin/sing-box \
      && chmod +x /usr/local/bin/sing-box \
      && rm -rf /tmp/sing-box* \
    || echo "[warn] sing-box 下载失败（代理功能将保持模拟模式，不影响其余功能）"

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    CDP_SERVICE_PORT=9222 \
    WS_HUB_PORT=3003 \
    WS_EVENT_PORT=3004 \
    VNC_BRIDGE_PORT=3005 \
    BROWSER_RUNTIME=auto \
    DATABASE_URL="file:/app/db/custom.db" \
    STORAGE_LOCAL_PATH=/app/storage \
    HOSTNAME=0.0.0.0

# 运行层完整依赖（All-In-One：无外部依赖、免编译环境）
COPY --from=deps /app/node_modules ./node_modules
# Next.js standalone 产物
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
# 源码资产：prisma schema / 种子 / 定时脚本 / WS枢纽 / VNC桥 / 前端引用资源
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/mini-services ./mini-services
COPY --from=builder /app/src/lib/config.ts ./src/lib/config.ts

# 启动/停止/守护/自检 + 嵌入式沙箱监督脚本
COPY docker/start.sh docker/stop.sh docker/healthcheck.sh docker/entrypoint-guard.sh /app/docker/
COPY docker/embedded/sandbox-launch.sh /app/docker/embedded/sandbox-launch.sh
RUN chmod +x /app/docker/*.sh /app/docker/embedded/*.sh \
    && mkdir -p /app/db /app/storage/backups /app/storage/uploads /app/storage/snapshots \
      /app/storage/sandboxes /app/storage/homes /app/storage/netpolicy \
    && echo "dockyard" > /app/.app-marker

# 数据卷：数据库 / 文件存储（含 Profile/沙箱状态/策略文件）
VOLUME ["/app/db", "/app/storage"]

# 对外仅 2 端口：网页端（GATEWAY_PORT，默认 3000）+ CDP 网关（CDP_SERVICE_PORT，默认 9222）
# Next/WS枢纽/VNC桥 全部回环（127.0.0.1）监听，统一经入口网关嵌入；host 网络模式不额外暴露
EXPOSE 3000 9222
# VNC 直连可选形态（VNC_BRIDGE_PUBLIC=port 时启动参数会绑定 0.0.0.0，需要时手动 -p 映射）
# EXPOSE 3005

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD /app/docker/healthcheck.sh

# 守护式入口：主进程崩溃自动整轮重启（崩溃原因输出 docker logs）；docker stop 优雅终止
ENTRYPOINT ["/app/docker/entrypoint-guard.sh"]
