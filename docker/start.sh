#!/bin/sh
# ============================================================
# Dockyard All-In-One 启动脚本：自检 → 数据库初始化 → WS枢纽 → 主服务
# 自检：端口占用 / 数据库连通 / 目录权限
# ============================================================
set -e

APP_DIR="/app"
DB_PATH="/app/db/custom.db"

log() { echo "[dockyard-start] $1"; }

# ---- 1. 启动自检（端口 / 数据库 / 权限 / 目录完整性）----
log "自检开始..."
if [ ! -d "$APP_DIR/.next" ]; then
  log "严重错误：.next 构建产物缺失，镜像不完整"
  exit 1
fi
mkdir -p /app/db /app/storage/uploads /app/storage/backups /app/storage/snapshots
touch /app/storage/.write-test 2>/dev/null || { log "严重错误：存储目录不可写"; exit 1; }
rm -f /app/storage/.write-test

# 端口占用检测（host 模式下防冲突提示）
PORT="${PORT:-3000}"
VNC_BRIDGE_PORT="${VNC_BRIDGE_PORT:-3005}"
if command -v netstat >/dev/null 2>&1; then
  if netstat -ltn 2>/dev/null | grep -q ":$PORT "; then
    log "警告：端口 $PORT 已被占用（host 模式请用 PORT 环境变量改端口）"
  fi
  if netstat -ltn 2>/dev/null | grep -q ":$VNC_BRIDGE_PORT "; then
    log "警告：VNC 桥端口 $VNC_BRIDGE_PORT 已被占用（可用 VNC_BRIDGE_PORT 环境变量改端口）"
  fi
fi
log "自检通过：构建产物/目录权限正常；主服务端口 $PORT；CDP服务端口 ${CDP_SERVICE_PORT:-9222}；VNC桥端口 $VNC_BRIDGE_PORT"

# VNC 桥共享密钥（未显式配置时随机生成，同进程树内两侧一致，绝不回显）
if [ -z "${VNC_BRIDGE_SECRET:-}" ]; then
  VNC_BRIDGE_SECRET=$( (openssl rand -hex 32 2>/dev/null || cat /proc/sys/kernel/random/uuid | tr -d '-') )
  export VNC_BRIDGE_SECRET
fi
# VNC 桥公网接入形态：port = 同主机独立端口直连（单域名反代部署可改为 gateway）
export VNC_BRIDGE_PUBLIC="${VNC_BRIDGE_PUBLIC:-port}"

# ---- 2. 数据库结构初始化（幂等）----
log "初始化数据库结构..."
cd "$APP_DIR"
bunx prisma db push --skip-generate --accept-data-loss 2>&1 | tail -2 || log "警告：数据库结构推送失败（将沿用现有数据库）"

# ---- 3. 种子数据（幂等：默认配置/超管账号/内置任务/内置策略模板）----
# 管理员引导三通道（互为补充，均幂等，后期可经「账号与安全」页修改）：
#   · ADMIN_USERNAME / ADMIN_EMAIL / ADMIN_PASSWORD 环境变量 → 首启自动创建超管
#   · ADMIN_PASSWORD_FORCE=1 → 启动时用环境变量密码覆盖已有管理员密码
#   · 未配置且库中无管理员 → 登录页引导跳转 /setup 首启注册页
log "播种初始数据（幂等）..."
ADMIN_PASSWORD="${ADMIN_PASSWORD:-Admin@2026}" bun prisma/seed.ts 2>&1 | tail -3 || log "警告：种子执行失败（可能已初始化过）"

# ---- 4. WS 枢纽（端口 ${WS_HUB_PORT:-3003}，事件注入 3004）----
log "启动 WebSocket 枢纽..."
(cd mini-services/ws-hub && PORT=${WS_HUB_PORT:-3003} bun index.ts >> /app/storage/ws-hub.log 2>&1) &
WS_PID=$!

# ---- 4.5 HelmPort VNC 网关桥（票据HMAC鉴权 + RFB TCP中转，端口 $VNC_BRIDGE_PORT）----
log "启动 VNC 网关桥..."
(cd mini-services/vnc-bridge && VNC_BRIDGE_PORT=$VNC_BRIDGE_PORT bun index.ts >> /app/storage/vnc-bridge.log 2>&1) &
BRIDGE_PID=$!

# ---- 5. Next.js 主服务（standalone）----
log "启动 Dockyard 主服务：http://0.0.0.0:${PORT}"
export HOSTNAME=0.0.0.0
cd "$APP_DIR"
term_handler() {
  log "收到终止信号，停止全部服务..."
  kill $WS_PID $BRIDGE_PID 2>/dev/null || true
  exit 0
}
trap term_handler SIGTERM SIGINT
bun .next/standalone/server.js >> /app/storage/server.log 2>&1 &
MAIN_PID=$!
wait $MAIN_PID
