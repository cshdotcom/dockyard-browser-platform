#!/bin/sh
# ============================================================
# Dockyard All-In-One 启动脚本（r13c：三重启动可靠性修复）
# 自检 → 数据库初始化 → WS枢纽 → VNC桥 → 内置调度 → 主服务 → 统一网关
# 由 entrypoint-guard.sh 守护调用：本脚本退出（崩溃）时 guard 自动整轮重启
#
# r13c 关键修复（生产 EADDRINUSE 无限崩溃循环根因）：
#   1. trap 信号名兼容：dash(/bin/sh) 要求无 SIG 前缀 —— 旧写法 `trap ... SIGTERM`
#      在 set -e 下直接中止脚本（exit=1，主服务从未启动，子进程全部变孤儿）
#   2. trap 前置：进入脚本即装好信号钩子，启动过程中收到 TERM 也能完整清理
#   3. EXIT 兜底清理：任意退出路径（崩溃/信号/正常）都终止全部子进程，
#      杜绝孤儿 vnc-bridge/ws-hub 占端口导致下一轮 EADDRINUSE
#   4. 健康探测改用 wget（镜像内未装 curl，旧探测恒超时 60 秒）
#
# r30 启动可靠性硬化（用户实测"启动一直疯狂重启、日志从未显示启动成功"根因组）：
#   5. SQLite db push 真实退出码（旧管道 `| tail` 掩盖失败 → 结构缺失静默带病运行）：
#      输出落临时文件判真实退出码，失败重试 3 次 + 高亮错误 + 明确继续/终止语义
#   6. PostgreSQL 不可达不再 exit 退出（旧：exit 1 → guard 5s 疯狂整轮自旋）：
#      轮内无限重试 + 退避 + 倒计时日志，容器保持存活等待数据库恢复
#   7. 服务日志轮转（20MB 阈值 cp+截断）：r29 起 30 项定时任务高频写日志，
#      storage 卷被写满 → SQLite 写失败 → 服务崩溃 → 疯狂重启链的放大器
#   8. boot-state 标记（starting/ready/crashed）+ 启动成功高亮横幅：
#      healthcheck 依此判"启动宽限期"，docker logs 一眼可见启动是否成功
# ============================================================
set -e

APP_DIR="/app"
DB_PATH="/app/db/custom.db"
BOOT_STATE_FILE="/app/storage/.boot-state"
LOG_ROTATE_MB="${LOG_ROTATE_MB:-20}"

log() { echo "[dockyard-start] $1"; }
# 启动状态标记（healthcheck 读）：starting=启动中 / ready=全部就绪 / crashed=本轮崩溃
set_boot_state() {
  echo "$1 $(date +%s)" > "$BOOT_STATE_FILE" 2>/dev/null || true
}

# ---- 0. 子进程登记 + 信号钩子（必须在启动任何子进程之前装好）----
# ALL_PIDS 登记全部后台子进程；term_handler 处理 docker stop；
# cleanup_children 由 EXIT 兜底触发 —— 无论正常退出还是 set -e 崩溃中止，
# 都先杀干净子进程再退出，防止孤儿进程占端口（EADDRINUSE 崩溃循环根因）。
ALL_PIDS=""
MAIN_PID=""
cleanup_children() {
  # 幂等：对已退出 PID 的 kill 错误全部吞掉
  for CP in $ALL_PIDS; do kill -TERM "$CP" 2>/dev/null || true; done
  # 短等待让进程优雅退出，随后强杀残留
  sleep 2
  for CP in $ALL_PIDS; do kill -KILL "$CP" 2>/dev/null || true; done
}
term_handler() {
  log "收到终止信号，停止全部服务..."
  cleanup_children
  if [ -n "$MAIN_PID" ]; then wait "$MAIN_PID" 2>/dev/null || true; fi
  exit 0
}
# dash 兼容：信号名不带 SIG 前缀（带前缀在 dash 报 "bad trap" 且 trap 不生效）
trap term_handler TERM INT
trap cleanup_children EXIT

# ---- 0.5 日志转发：全部服务日志同步到容器 stdout（docker logs 直接可看）----
# 服务进程本身写各自日志文件（崩溃报告/持久留档），forward_log 用 tail -F 把
# 追加内容实时回显到 stdout —— docker logs 与文件双通道，互不影响 PID 语义。
forward_log() {
  # $1 = 日志文件路径；启动前 touch 保证 tail 立即可读；-F 容忍轮转重建
  mkdir -p "$(dirname "$1")" 2>/dev/null || true
  touch "$1" 2>/dev/null || true
  tail -n 0 -F "$1" 2>/dev/null &
  ALL_PIDS="$ALL_PIDS $!"
}
for LF in /app/storage/server.log /app/storage/ws-hub.log /app/storage/vnc-bridge.log /app/storage/gateway.log /app/storage/cron-ping.log; do
  forward_log "$LF"
done
log "日志双通道已启用：server/ws-hub/vnc-bridge/gateway/cron 输出同步至 docker logs"

# r30：本轮启动状态标记（healthcheck 依此区分「启动宽限期」与「真不健康」）
set_boot_state "starting"

# r30：服务日志轮转（后台守护，登记进 ALL_PIDS 随轮清理）
# 语义：阈值 20MB（LOG_ROTATE_MB 可调）→ cp 当前文件为 .1 留档 + 原地截断；
# 追加写进程（>> 重定向持 O_APPEND fd）与 tail -F（容忍截断自动续读）均不受影响。
# 防的是：30 项定时任务 + 页面请求长期运行把 storage 卷写满 → SQLite 写失败 →
# 服务崩溃 → guard 疯狂重启 —— 这是「启动一直疯狂」的磁盘层放大器。
(
  while :; do
    sleep 120
    for LF in /app/storage/server.log /app/storage/ws-hub.log /app/storage/vnc-bridge.log /app/storage/gateway.log; do
      SZ=$(stat -c %s "$LF" 2>/dev/null || echo 0)
      if [ "$SZ" -gt $((LOG_ROTATE_MB * 1024 * 1024)) ]; then
        cp -f "$LF" "$LF.1" 2>/dev/null || true
        : > "$LF" 2>/dev/null || true
        echo "[dockyard-start] 日志轮转：$LF 超过 ${LOG_ROTATE_MB}MB（$(($SZ / 1024 / 1024))MB），已归档 .1 并截断"
      fi
    done
  done
) &
ALL_PIDS="$ALL_PIDS $!"

# ---- 1. 启动自检（端口 / 数据库 / 权限 / 目录完整性）----
log "自检开始..."
if [ ! -d "$APP_DIR/.next" ]; then
  log "严重错误：.next 构建产物缺失，镜像不完整"
  exit 1
fi
mkdir -p /app/db /app/storage/uploads /app/storage/backups /app/storage/snapshots \
  /app/storage/sandboxes /app/storage/homes /app/storage/netpolicy \
  /app/storage/profiles /app/storage/system
# r24-e：沙箱用户 UID 台账（storage/system/sandbox-users.json，随卷持久化）
# 台账存在 → 容器重建后由平台按原 UID 复活沙箱专用用户（属主零冲突）；
# 台账不存在 → 全新部署（旧卷无沙箱账户，首次创建沙箱时自动建立台账）
if [ -f /app/storage/system/sandbox-users.json ]; then
  log "沙箱用户 UID 台账已就位（容器重建场景：沙箱启动时按台账原 UID 复活账户）"
  chmod 600 /app/storage/system/sandbox-users.json 2>/dev/null || true
else
  log "沙箱用户 UID 台账不存在（全新部署；首个沙箱创建时自动建立）"
fi
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
# 跨域名部署：VNC_BRIDGE_URL 显式指定桥对外地址（如 wss://vnc.example.com），
# 前端取票后按该地址建立 WebSocket（反代需透传 WS 升级头）
if [ -n "${VNC_BRIDGE_URL:-}" ]; then
  log "VNC 桥跨域名模式：$VNC_BRIDGE_URL（前端将直连该地址）"
fi
# r13c：平台公网域名配置透出（连接信息卡公网 CDP 端点 / 分享链接基准地址）
if [ -n "${PUBLIC_BASE_URL:-}" ]; then
  log "平台公网域名：$PUBLIC_BASE_URL（工作区详情将展示公网 CDP 网关端点）"
fi
# r14/22-d：外部浏览器分离部署（EXTERNAL_BROWSER_URL 填写则优先外部；未填默认单容器内嵌）
# 地址 = 自部署 docker/browser 硬隔离浏览器镜像的 CDP 端点（如 http://192.168.1.10:9222）
# 可选：EXTERNAL_BROWSER_CDP_PORT（默认 9222）/ EXTERNAL_BROWSER_VNC_PORT（RFB 端口，默认 5900）/
#       EXTERNAL_BROWSER_VNC_HOST（RFB 目标主机覆盖，默认从 URL 推导 —— CDP 与 VNC 分置两台主机时使用）
# 外部形态下 VNC 桥（3005）按票据拨号外部主机 5900；生命周期由外部镜像 supervisor 自管
if [ -n "${EXTERNAL_BROWSER_URL:-}" ]; then
  log "使用外部浏览器：$EXTERNAL_BROWSER_URL（分离部署，平台只连接不编排；VNC 桥将拨号 ${EXTERNAL_BROWSER_VNC_HOST:-URL主机}:${EXTERNAL_BROWSER_VNC_PORT:-5900}）"
else
  log "浏览器运行形态：单容器内嵌（EXTERNAL_BROWSER_URL 未配置，默认零外部依赖）"
fi

# 内部调度密钥（未显式配置时随机生成；内置调度器与外部 cron 均用它触发 /api/cron）
if [ -z "${CRON_SECRET:-}" ]; then
  CRON_SECRET=$( (openssl rand -hex 32 2>/dev/null || cat /proc/sys/kernel/random/uuid | tr -d '-') )
  export CRON_SECRET
fi

# ---- 2. 数据库结构初始化（幂等；22-d sqlite / r38 mysql / 22-d postgres 三形态）----
log "初始化数据库结构..."
cd "$APP_DIR"
DB_MODE="${DATABASE_PROVIDER:-${DB_PROVIDER:-sqlite}}"

# [r38] db-active.json 感知：GUI 绑定/迁移后的运行库优先（storage 卷持久）。
# 语义：db-active.json 存在且合法 → 结构推送目标跟随它（而非 env）—— env 后续
# 改类型时主应用仍锚定有数据的库运行，start.sh 同步把结构演进推到正确的库上。
DB_ACTIVE_FILE="/app/storage/db-active.json"
if [ -f "$DB_ACTIVE_FILE" ]; then
  DB_ACTIVE_PROVIDER=$(sed -n 's/.*"provider"[[:space:]]*:[[:space:]]*"\([a-z]*\)".*/\1/p' "$DB_ACTIVE_FILE" | head -1)
  case "$DB_ACTIVE_PROVIDER" in
    sqlite|postgres|mysql)
      if [ "$DB_ACTIVE_PROVIDER" != "$DB_MODE" ]; then
        log "检测到 db-active.json（GUI 配置库=${DB_ACTIVE_PROVIDER}）与 env（${DB_MODE}）不一致 → 结构推送跟随 GUI 配置库"
        DB_MODE="$DB_ACTIVE_PROVIDER"
      fi
      ;;
    esac
fi

if [ "$DB_MODE" = "mysql" ]; then
  # ---- MySQL / MariaDB 形态（r38：与 PG 同级全自动初始化）----
  case "${DATABASE_URL:-}" in
    mysql://*) ;;
    *)
      log "严重错误：DATABASE_PROVIDER=mysql 但 DATABASE_URL 不是 mysql:// 连接串（当前：${DATABASE_URL:-未设置}）"
      exit 1
      ;;
  esac
  log "数据库形态：MySQL/MariaDB → 启动自动初始化（结构推送 → 种子，全部幂等）"
  # 与 PG 相同的自愈语义：不可达不 exit（防 guard 疯狂自旋），轮内无限重试 + 退避
  MY_PUSH_OK=0
  MY_ATTEMPT=0
  MY_BACKOFF=5
  until [ "$MY_PUSH_OK" = "1" ]; do
    MY_ATTEMPT=$((MY_ATTEMPT + 1))
    if [ $((MY_ATTEMPT % 10)) = "1" ]; then
      log "MySQL 结构推送（第 ${MY_ATTEMPT} 次）：prisma db push --schema prisma/schema.mysql.prisma"
    fi
    if bunx prisma db push --schema prisma/schema.mysql.prisma --skip-generate --accept-data-loss >/tmp/my-push.log 2>&1; then
      MY_PUSH_OK=1
      tail -3 /tmp/my-push.log
      log "MySQL 结构推送成功（第 ${MY_ATTEMPT} 次尝试）"
      break
    fi
    if [ $((MY_ATTEMPT % 10)) = "1" ] || [ "$MY_ATTEMPT" = "3" ]; then
      tail -5 /tmp/my-push.log
      log "等待 MySQL 就绪：第 ${MY_ATTEMPT} 次失败（数据库暂不可达或账号权限不足？${MY_BACKOFF}s 后重试，无限等待直至恢复）"
    fi
    sleep "$MY_BACKOFF"
    MY_BACKOFF=$((MY_BACKOFF * 2))
    if [ "$MY_BACKOFF" -gt 60 ]; then MY_BACKOFF=60; fi
  done
  log "播种初始数据（幂等，mysql）..."
  ADMIN_PASSWORD="${ADMIN_PASSWORD:-Admin@2026}" bun prisma/seed-mysql.ts >/tmp/my-seed.log 2>&1 \
    && tail -3 /tmp/my-seed.log \
    || { tail -3 /tmp/my-seed.log; log "警告：mysql 种子执行失败（可能已初始化过或账号只读）"; }
  log "数据库已自动初始化（mysql）"
elif [ "$DB_MODE" = "postgres" ]; then
  # ---- PostgreSQL 形态：启动即自动建表 + 审计触发器 + 种子（无需人工导入 SQL）----
  case "${DATABASE_URL:-}" in
    postgresql://*|postgres://*) ;;
    *)
      log "严重错误：DATABASE_PROVIDER=postgres 但 DATABASE_URL 不是 postgresql:// 连接串（当前：${DATABASE_URL:-未设置}）"
      exit 1
      ;;
  esac
  log "数据库形态：PostgreSQL → 启动自动初始化（结构推送 → 审计触发器 → 种子，全部幂等）"
  # r30：PG 不可达不再 exit（旧：3 次失败 exit 1 → guard 5 秒后疯狂整轮自旋，
  # 用户观察即「启动一直疯狂、日志一直没有启动成功」）。改为轮内无限重试 + 退避，
  # 容器保持存活、boot-state=starting（healthcheck 宽限期内不判死），数据库恢复后
  # 自动完成初始化并继续启动 —— 拉起外部数据库慢/网络抖动场景天然自愈。
  PG_PUSH_OK=0
  PG_ATTEMPT=0
  PG_BACKOFF=5
  until [ "$PG_PUSH_OK" = "1" ]; do
    PG_ATTEMPT=$((PG_ATTEMPT + 1))
    if [ $((PG_ATTEMPT % 10)) = "1" ]; then
      log "PostgreSQL 结构推送（第 ${PG_ATTEMPT} 次）：prisma db push --schema prisma/schema.postgres.prisma"
    fi
    # 输出落临时文件再回显（dash 管道退出码取尾命令，不能用于成败判定）
    if bunx prisma db push --schema prisma/schema.postgres.prisma --skip-generate --accept-data-loss >/tmp/pg-push.log 2>&1; then
      PG_PUSH_OK=1
      tail -3 /tmp/pg-push.log
      log "PostgreSQL 结构推送成功（第 ${PG_ATTEMPT} 次尝试）"
      break
    fi
    if [ $((PG_ATTEMPT % 10)) = "1" ] || [ "$PG_ATTEMPT" = "3" ]; then
      tail -5 /tmp/pg-push.log
      log "等待 PostgreSQL 就绪：第 ${PG_ATTEMPT} 次失败（数据库暂不可达或账号权限不足？${PG_BACKOFF}s 后重试，无限等待直至恢复）"
    fi
    sleep "$PG_BACKOFF"
    PG_BACKOFF=$((PG_BACKOFF * 2))
    if [ "$PG_BACKOFF" -gt 60 ]; then PG_BACKOFF=60; fi
  done
  # 审计不可篡改触发器（幂等；失败不阻断启动 —— 可稍后手工执行 db/postgres/audit_triggers.sql）
  if bun prisma/postgres/apply-triggers.ts >/tmp/pg-triggers.log 2>&1; then
    tail -2 /tmp/pg-triggers.log
    log "审计不可篡改触发器已应用（AuditLog 仅允许 INSERT）"
  else
    tail -3 /tmp/pg-triggers.log
    log "警告：审计触发器应用失败（平台仍将启动；可手工执行 db/postgres/audit_triggers.sql 补齐）"
  fi
  log "播种初始数据（幂等，postgres）..."
  ADMIN_PASSWORD="${ADMIN_PASSWORD:-Admin@2026}" bun prisma/seed-postgres.ts >/tmp/pg-seed.log 2>&1 \
    && tail -3 /tmp/pg-seed.log \
    || { tail -3 /tmp/pg-seed.log; log "警告：postgres 种子执行失败（可能已初始化过或账号只读）"; }
  log "数据库已自动初始化（postgres）"
else
  # ---- SQLite 形态（默认，零外部依赖；行为与历史版本完全一致）----
  log "数据库形态：SQLite（默认）→ $DB_PATH"
  # r30：真实退出码判定（旧写法 `db push ... | tail -2 || log` 的退出码取自 tail，
  # 恒为 0 —— 结构推送真实失败时被完全掩盖：种子失败、表缺失、运行时全链路带病，
  # 且日志仅剩一句"警告"极易漏看）。现改为：输出落临时文件 → 判真实退出码 →
  # 失败重试 3 次（升级旧卷时 ALTER/重建耗时或瞬时锁竞争天然自愈）→ 仍失败则
  # 高亮错误块 + 附排查指引；旧卷已有结构时"沿用现有数据库"语义保持（失败不阻断，
  # 升级场景存量表仍在，服务可用，缺失新表的功能页会报错并可见于日志）。
  SQLITE_OK=0
  SQLITE_ATTEMPT=0
  while [ "$SQLITE_ATTEMPT" -lt 3 ]; do
    SQLITE_ATTEMPT=$((SQLITE_ATTEMPT + 1))
    if bunx prisma db push --skip-generate --accept-data-loss >/tmp/sqlite-push.log 2>&1; then
      SQLITE_OK=1
      tail -2 /tmp/sqlite-push.log
      break
    fi
    tail -5 /tmp/sqlite-push.log
    log "警告：SQLite 结构推送失败（第 ${SQLITE_ATTEMPT}/3 次，10 秒后重试 —— 瞬时锁竞争或卷 IO 抖动）"
    sleep 10
  done
  if [ "$SQLITE_OK" != "1" ]; then
    echo ""
    echo "=============================================================="
    log "严重错误：数据库结构推送 3 次均失败 —— SQLite 卷可能只读/损坏/磁盘满"
    log "排查：df -h /app/storage /app/db（磁盘是否写满）；ls -l /app/db（属主/权限）"
    log "处置：修复卷权限或释放磁盘后，容器将自动重试（guard 整轮自愈）"
    echo "=============================================================="
    # 不 exit：保留旧结构继续启动（升级兼容语义），错误已在 docker logs 高亮可见
  fi
fi

# ---- 3. 种子数据（幂等：默认配置/超管账号/内置任务/内置策略模板）----
# 管理员引导三通道（互为补充，均幂等，后期可经「账号与安全」页修改）：
#   · ADMIN_USERNAME / ADMIN_EMAIL / ADMIN_PASSWORD 环境变量 → 首启自动创建超管
#   · ADMIN_PASSWORD_FORCE=1 → 启动时用环境变量密码覆盖已有管理员密码
#   · 未配置且库中无管理员 → 登录页引导跳转 /setup 首启注册页
if [ "$DB_MODE" = "sqlite" ]; then
  log "播种初始数据（幂等，sqlite）..."
  ADMIN_PASSWORD="${ADMIN_PASSWORD:-Admin@2026}" bun prisma/seed.ts 2>&1 | tail -3 || log "警告：种子执行失败（可能已初始化过）"
fi

# ---- 4. WS 枢纽（回环端口 ${WS_HUB_PORT:-3003}，事件注入 3004；对外统一经网关 XTransformPort 透传）----
log "启动 WebSocket 枢纽（回环）..."
(cd mini-services/ws-hub && PORT=${WS_HUB_PORT:-3003} BIND_ADDR=127.0.0.1 exec bun index.ts >> /app/storage/ws-hub.log 2>&1) &
ALL_PIDS="$ALL_PIDS $!"

# ---- 4.5 HelmPort VNC 网关桥（票据HMAC鉴权 + RFB TCP中转）----
# 回环绑定（VNC_BRIDGE_PUBLIC=port 时对外 0.0.0.0 供独立端口直连）；默认 gateway 模式经统一网关嵌入网页端
# 桥内部自带端口占用重试（EADDRINUSE 退避重绑，最多 30 次），不再一崩即溃
BRIDGE_BIND="${VNC_BRIDGE_PUBLIC:-gateway}"
if [ "$BRIDGE_BIND" = "port" ]; then BIND_HOST=0.0.0.0; else BIND_HOST=127.0.0.1; fi
log "启动 VNC 网关桥（${BIND_HOST}，模式 $BRIDGE_BIND）..."
(cd mini-services/vnc-bridge && VNC_BRIDGE_PORT=$VNC_BRIDGE_PORT BIND_HOST=$BIND_HOST exec bun index.ts >> /app/storage/vnc-bridge.log 2>&1) &
ALL_PIDS="$ALL_PIDS $!"

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
  ALL_PIDS="$ALL_PIDS $!"
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
# Next 监听回环内部端口（对外流量统一由网关转发）
PORT=$APP_INTERNAL_PORT bun "$SERVER_JS" >> /app/storage/server.log 2>&1 &
MAIN_PID=$!
ALL_PIDS="$ALL_PIDS $MAIN_PID"

# ---- 6. 统一入口网关（对外唯一 UI 端口 $GATEWAY_PORT：Next/桥/HUB 全透传，含 WebSocket）----
log "启动统一入口网关：http://0.0.0.0:${GATEWAY_PORT}（VNC/WS 经网关嵌入，对外仅 网页+CDP 两端口）..."
(cd mini-services/gateway && GATEWAY_PORT=$GATEWAY_PORT APP_INTERNAL_PORT=$APP_INTERNAL_PORT \
  GATEWAY_TRANSFORM_PORTS="${GATEWAY_TRANSFORM_PORTS:-${WS_HUB_PORT:-3003},3004,${VNC_BRIDGE_PORT}}" \
  exec bun index.ts >> /app/storage/gateway.log 2>&1) &
GATEWAY_PID=$!
ALL_PIDS="$ALL_PIDS $GATEWAY_PID"

# 健康探测：网关就绪后再进入主等待（网关就绪 = 全链路可用）
# 镜像内只装 wget 不装 curl —— 旧版误用 curl 恒报超时（127 command-not-found）
GATEWAY_WAIT=0
until wget -q -O /dev/null --timeout=3 "http://127.0.0.1:${GATEWAY_PORT}/__gateway/health" 2>/dev/null || [ $GATEWAY_WAIT -ge 60 ]; do
  sleep 1; GATEWAY_WAIT=$((GATEWAY_WAIT + 1))
done
if [ $GATEWAY_WAIT -lt 60 ]; then
  log "统一网关就绪：端口 $GATEWAY_PORT（对外服务已全部开通）"
else
  log "警告：网关健康探测超时（进程仍在运行，可能启动缓慢或异常，查看 storage/gateway.log）"
fi

# r30：主服务穿透探测（网关→Next 全链路验证，非仅网关自身存活）
# 探测 /api/openapi/doc（公开轻量路由，与 healthcheck 同口径），最多等 40s
APP_WAIT=0
until wget -q -O /dev/null --timeout=3 "http://127.0.0.1:${GATEWAY_PORT}/api/openapi/doc" 2>/dev/null || [ $APP_WAIT -ge 40 ]; do
  sleep 1; APP_WAIT=$((APP_WAIT + 1))
done
APP_OK=0
if [ $APP_WAIT -lt 40 ]; then APP_OK=1; fi

# r30：启动成功高亮横幅 + boot-state=ready
# （用户诉求："日志一直没有启动成功" —— 此前成功仅一行普通日志、且极易被
#   prisma 查询日志洪水冲走。现在：洪水已关 + 专属横幅块 + 状态文件三重可观测）
if [ "$APP_OK" = "1" ]; then
  set_boot_state "ready"
  echo ""
  echo "=============================================================="
  echo "  DOCKYARD 启动成功（全部服务就绪）"
  echo "  ----------------------------------------------------------"
  echo "  网页端      : http://<主机IP>:${GATEWAY_PORT}"
  echo "  数据库形态  : ${DB_MODE}$(if [ "$DB_MODE" = "sqlite" ]; then echo "（$DB_PATH）"; fi)"
  echo "  主服务      : 回环 127.0.0.1:${APP_INTERNAL_PORT}（经统一网关对外）"
  echo "  VNC 桥      : 回环 ${VNC_BRIDGE_PORT}（gateway 模式，网页端嵌入）"
  echo "  初始账号    : admin / \${ADMIN_PASSWORD:-Admin@2026}（首启播种，后台可改）"
  echo "  排障        : docker logs <容器> 搜「DOCKYARD 启动成功」即本横幅"
  echo "=============================================================="
  log "启动成功：网关 ${GATEWAY_WAIT}s 就绪 + 主服务全链路探测通过（${APP_WAIT}s）"
else
  # 主服务穿透失败：网关在、Next 未响应 —— 保持 starting 状态并高亮告警（不判死，
  # Next 冷启动/首次请求编译慢属正常；guard 在主进程真退出时才整轮重启）
  log "警告：主服务全链路探测 40s 未通过（Next 仍在启动或异常；boot-state 保持 starting）"
fi

# 主等待：主服务退出（含崩溃）→ EXIT 钩子自动清理全部子进程 → guard 下一轮干净重启
wait "$MAIN_PID"
