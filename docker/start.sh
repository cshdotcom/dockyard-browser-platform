#!/bin/sh
# ============================================================
# Dockyard All-In-One 启动脚本（r13：单容器全内置）
# 自检 → 数据库初始化 → WS枢纽 → VNC桥 → 内置调度 → 主服务
# 自检：端口占用 / 数据库连通 / 目录权限 / 嵌入式浏览器组件
# 由 entrypoint-guard.sh 守护调用：本脚本退出（崩溃）时 guard 自动整轮重启
# ============================================================
set -e

APP_DIR="/app"
DB_PATH="/app/db/custom.db"

log() { echo "[dockyard-start] $1"; }

# ---- 0. 日志转发：全部服务日志同步到容器 stdout（docker logs 直接可看）----
# 服务进程本身写各自日志文件（崩溃报告/持久留档），forward_log 用 tail -F 把
# 追加内容实时回显到 stdout —— docker logs 与文件双通道，互不影响 PID 语义。
forward_log() {
  # $1 = 日志文件路径；启动前 touch 保证 tail 立即可读；-F 容忍轮转重建
  mkdir -p "$(dirname "$1")" 2>/dev/null || true
  touch "$1" 2>/dev/null || true
  tail -n 0 -F "$1" 2>/dev/null &
}
LOG_PIDS=""
for LF in /app/storage/server.log /app/storage/ws-hub.log /app/storage/vnc-bridge.log /app/storage/gateway.log /app/storage/cron-ping.log; do
  forward_log "$LF"
  LOG_PIDS="$LOG_PIDS $!"
done
log "日志双通道已启用：server/ws-hub/vnc-bridge/gateway/cron 输出同步至 docker logs"

# ---- 1. 启动自检（端口 / 数据库 / 权限 / 目录完整性）----
log "自检开始..."
if [ ! -d "$APP_DIR/.next" ]; then
  log "严重错误：.next 构建产物缺失，镜像不完整"
  exit 1
fi
mkdir -p /app/db /app/storage/uploads /app/storage/backups /app/storage/snapshots \
  /app/storage/sandboxes /app/storage/homes /app/storage/netpolicy
touch /app/storage/.write-test 2>/dev/null || { log "严重错误：存储目录不可写"; exit 1; }
rm -f /app/storage/.write-test

# 端口占用检测（host 模式下防冲突提示；iproute2(ss)，旧环境回退 netstat）
# 端口拓扑（仅 2 端口对外）：GATEWAY_PORT（对外 UI，默认 3000）+ CDP_SERVICE_PORT（默认 9222）
#   · Next 主服务：APP_INTERNAL_PORT（默认 13000，回环）
#   · WS 枢纽/事件注入：3003/3004（回环）
#   · VNC 桥：VNC_BRIDGE_PORT（默认 3005，回环；VNC_BRIDGE_PUBLIC=port 模式时对外）
PORT="${PORT:-3000}"
GATEWAY_PORT="${GATEWAY_PORT:-$PORT}"
APP_INTERNAL_PORT="${APP_INTERNAL_PORT:-13000}"
VNC_BRIDGE_PORT="${VNC_BRIDGE_PORT:-3005}"
port_listen() {
  if command -v ss >/dev/null 2>&1; then ss -ltn 2>/dev/null; elif command -v netstat >/dev/null 2>&1; then netstat -ltn 2>/dev/null; else true; fi
}
if port_listen | grep -q ":$GATEWAY_PORT "; then
  log "警告：对外网关端口 $GATEWAY_PORT 已被占用（host 模式请用 PORT/GATEWAY_PORT 环境变量改端口）"
fi
if port_listen | grep -q ":$VNC_BRIDGE_PORT "; then
  log "警告：VNC 桥端口 $VNC_BRIDGE_PORT 已被占用（可用 VNC_BRIDGE_PORT 环境变量改端口）"
fi
log "自检通过：端口拓扑 —— 对外仅 网关 $GATEWAY_PORT + CDP ${CDP_SERVICE_PORT:-9222}；内部 Next $APP_INTERNAL_PORT / 桥 $VNC_BRIDGE_PORT"

# ---- 1.5 嵌入式沙箱运行时能力探测（单容器全内置核心组件）----
# chromium/xvfb/x11vnc 齐备 → BROWSER_RUNTIME=auto 自动进入单容器内嵌形态（默认）
if [ "${BROWSER_RUNTIME:-auto}" = "auto" ] || [ "${BROWSER_RUNTIME:-auto}" = "embedded" ]; then
  EMB_OK=1
  for b in chromium Xvfb x11vnc; do
    command -v "$b" >/dev/null 2>&1 || EMB_OK=0
  done
  if [ "$EMB_OK" = "1" ]; then
    log "嵌入式沙箱运行时就绪：chromium + Xvfb + x11vnc（单容器内嵌，零外部服务）"
    if unshare -Urm true 2>/dev/null; then
      log "用户/挂载命名空间可用：每沙箱私有 Chromium 托管策略已启用"
    else
      log "警告：unshare 用户命名空间不可用（内核/安全模块限制）→ 每沙箱策略降级为全局基线；可尝试 docker run --cap-add SYS_ADMIN"
    fi
  else
    log "警告：容器内缺少 chromium/xvfb/x11vnc 组件 → 浏览器会话以演示模式运行（镜像异常或手动裁剪）"
  fi
fi
if command -v /usr/local/bin/sing-box >/dev/null 2>&1; then
  log "sing-box 容器内进程模式就绪（代理编排无需外部容器）"
fi

# VNC 桥共享密钥（未显式配置时随机生成，同进程树内两侧一致，绝不回显）
if [ -z "${VNC_BRIDGE_SECRET:-}" ]; then
  VNC_BRIDGE_SECRET=$( (openssl rand -hex 32 2>/dev/null || cat /proc/sys/kernel/random/uuid | tr -d '-') )
  export VNC_BRIDGE_SECRET
fi
# VNC 桥公网接入形态：gateway = 经统一入口网关嵌入网页端（默认，回环监听不对外）；port = 独立端口直连（需 -p 映射）
export VNC_BRIDGE_PUBLIC="${VNC_BRIDGE_PUBLIC:-gateway}"

# 内部调度密钥（未显式配置时随机生成；内置调度器与外部 cron 均用它触发 /api/cron）
if [ -z "${CRON_SECRET:-}" ]; then
  CRON_SECRET=$( (openssl rand -hex 32 2>/dev/null || cat /proc/sys/kernel/random/uuid | tr -d '-') )
  export CRON_SECRET
fi

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

# ---- 4. WS 枢纽（回环端口 ${WS_HUB_PORT:-3003}，事件注入 3004；对外统一经网关 XTransformPort 透传）----
log "启动 WebSocket 枢纽（回环）..."
(cd mini-services/ws-hub && PORT=${WS_HUB_PORT:-3003} BIND_ADDR=127.0.0.1 bun index.ts >> /app/storage/ws-hub.log 2>&1) &
WS_PID=$!

# ---- 4.5 HelmPort VNC 网关桥（票据HMAC鉴权 + RFB TCP中转）----
# 回环绑定（VNC_BRIDGE_PUBLIC=port 时对外 0.0.0.0 供独立端口直连）；默认 gateway 模式经统一网关嵌入网页端
BRIDGE_BIND="${VNC_BRIDGE_PUBLIC:-gateway}"
if [ "$BRIDGE_BIND" = "port" ]; then BIND_HOST=0.0.0.0; else BIND_HOST=127.0.0.1; fi
log "启动 VNC 网关桥（${BIND_HOST}，模式 $BRIDGE_BIND）..."
(cd mini-services/vnc-bridge && VNC_BRIDGE_PORT=$VNC_BRIDGE_PORT BIND_HOST=$BIND_HOST bun index.ts >> /app/storage/vnc-bridge.log 2>&1) &
BRIDGE_PID=$!

# ---- 4.6 内置定时任务调度器（默认开启；与外部 cron 可并存 —— 接口侧内存锁防重入）----
# 环回 TCP 触发受保护 /api/cron（此前依赖用户手工配置外部 crontab，漏配时
# 闲置回收/看门狗/定时策略激活等引擎任务全部静默停摆）
if [ "${BUILTIN_CRON:-1}" = "1" ]; then
  log "启动内置定时调度器（间隔 ${CRON_INTERVAL_SEC:-300}s，BUILTIN_CRON=0 可关闭）..."
  (
    CRON_WAIT=20
    CRON_INTERVAL="${CRON_INTERVAL_SEC:-300}"
    sleep "$CRON_WAIT" # 等主服务完成启动
    while :; do
      wget -q -O /dev/null --timeout=20 --header="x-cron-secret: ${CRON_SECRET}" \
        "http://127.0.0.1:${APP_INTERNAL_PORT}/api/cron?task=all" 2>/dev/null || true
      sleep "$CRON_INTERVAL"
    done
  ) >> /app/storage/cron-ping.log 2>&1 &
  CRON_PID=$!
else
  CRON_PID=""
fi

# ---- 5. Next.js 主服务（standalone）----
# 镜像布局：COPY .next/standalone ./ → server.js 位于 /app/server.js（standalone 约定根布局）
# 兼容两种布局探测，杜绝路径错误导致的静默崩溃（历史缺陷：误指向 .next/standalone/server.js
# → bun 模块找不到退出 → 错误仅写入 server.log，docker logs 表现为“无错误但容器停止”）
if [ -f "$APP_DIR/server.js" ]; then
  SERVER_JS="$APP_DIR/server.js"
elif [ -f "$APP_DIR/.next/standalone/server.js" ]; then
  SERVER_JS="$APP_DIR/.next/standalone/server.js"
else
  log "严重错误：standalone 主服务产物缺失（server.js 不存在）"
  exit 1
fi
log "启动 Dockyard 主服务（回环）：http://127.0.0.1:${APP_INTERNAL_PORT}（server.js=${SERVER_JS}）"
export HOSTNAME=127.0.0.1
cd "$APP_DIR"
term_handler() {
  log "收到终止信号，停止全部服务..."
  if [ -n "$GATEWAY_PID" ]; then kill "$GATEWAY_PID" 2>/dev/null || true; fi
  if [ -n "$MAIN_PID" ]; then kill "$MAIN_PID" 2>/dev/null || true; fi
  kill $WS_PID $BRIDGE_PID 2>/dev/null || true
  if [ -n "$CRON_PID" ]; then kill "$CRON_PID" 2>/dev/null || true; fi
  for LP in $LOG_PIDS; do kill "$LP" 2>/dev/null || true; done
  if [ -n "$MAIN_PID" ]; then wait "$MAIN_PID" 2>/dev/null || true; fi
  exit 0
}
trap term_handler SIGTERM SIGINT
# Next 监听回环内部端口（对外流量统一由网关转发）
PORT=$APP_INTERNAL_PORT bun "$SERVER_JS" >> /app/storage/server.log 2>&1 &
MAIN_PID=$!

# ---- 6. 统一入口网关（对外唯一 UI 端口 $GATEWAY_PORT：Next/桥/HUB 全透传，含 WebSocket）----
log "启动统一入口网关：http://0.0.0.0:${GATEWAY_PORT}（VNC/WS 经网关嵌入，对外仅 网页+CDP 两端口）..."
(cd mini-services/gateway && GATEWAY_PORT=$GATEWAY_PORT APP_INTERNAL_PORT=$APP_INTERNAL_PORT \
  GATEWAY_TRANSFORM_PORTS="${GATEWAY_TRANSFORM_PORTS:-${WS_HUB_PORT:-3003},3004,${VNC_BRIDGE_PORT}}" \
  bun index.ts >> /app/storage/gateway.log 2>&1) &
GATEWAY_PID=$!

# 健康探测：网关就绪后再进入主等待（网关就绪 = 全链路可用）
GATEWAY_WAIT=0
until curl -sf "http://127.0.0.1:${GATEWAY_PORT}/__gateway/health" >/dev/null 2>&1 || [ $GATEWAY_WAIT -ge 60 ]; do
  sleep 1; GATEWAY_WAIT=$((GATEWAY_WAIT + 1))
done
if [ $GATEWAY_WAIT -lt 60 ]; then
  log "统一网关就绪：端口 $GATEWAY_PORT（对外服务已全部开通）"
else
  log "警告：网关健康探测超时（进程仍在运行，可能启动缓慢或异常，查看 storage/gateway.log）"
fi

wait $MAIN_PID
