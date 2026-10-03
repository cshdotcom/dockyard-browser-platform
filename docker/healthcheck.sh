#!/bin/sh
# ============================================================
# 健康自检（r30 硬化）
# 旧版三探测：网关 openapi/doc + /app/db/custom.db 存在 + VNC 桥存活
# 旧版三问题（用户实测「启动一直疯狂重启、日志一直没有启动成功」的可能触发链）：
#   1. PostgreSQL 模式下 /app/db/custom.db 永不存在 → 恒 unhealthy →
#      带健康门禁的编排器（swarm/portainer-autoheal/k8s）无限重启容器
#   2. 升级旧卷时 db push/seed 可超过 start-period+retries 窗口 → 误判死亡
#   3. guard 崩溃轮内服务半启动，探测抖动
# r30 新语义：
#   · boot-state（start.sh/guard 维护）= starting 且 15 分钟宽限期内 → 视为健康
#     （正在初始化数据库/升级结构，不判死 —— 编排器不会重启正在迁移的容器）
#   · boot-state = crashed → 立即 unhealthy（guard 已在退避重启，无需等满 3 次）
#   · boot-state = ready / 无标记 → 走真实三探测（网关全链路 + 桥 + sqlite 卷）
#   · SQLite/PostgreSQL 形态感知：postgres 部署不要求 custom.db 文件
# ============================================================
PORT="${PORT:-3000}"
GATEWAY_PORT="${GATEWAY_PORT:-$PORT}"
VNC_BRIDGE_PORT="${VNC_BRIDGE_PORT:-3005}"
BOOT_STATE_FILE="/app/storage/.boot-state"
BOOT_GRACE_SEC="${BOOT_GRACE_SEC:-900}"

# ---- 启动状态宽限期（数据库初始化/结构升级期间不判死）----
if [ -f "$BOOT_STATE_FILE" ]; then
  STATE_LINE=$(cat "$BOOT_STATE_FILE" 2>/dev/null || true)
  STATE=$(echo "$STATE_LINE" | awk '{print $1}')
  STATE_TS=$(echo "$STATE_LINE" | awk '{print $2}')
  NOW=$(date +%s)
  AGE=$(( NOW - STATE_TS ))
  if [ "$STATE" = "starting" ] && [ "$AGE" -lt "$BOOT_GRACE_SEC" ]; then
    # 启动进行中（db push/种子/服务拉起）：视为健康，等待完成
    exit 0
  fi
  if [ "$STATE" = "crashed" ]; then
    # 本轮已崩溃（guard 退避重启中）：立即报告不健康，让编排器/看门狗尽早介入
    exit 1
  fi
fi

# ---- 真实探测（ready 或无状态标记时的全链路校验）----
wget -q -O /dev/null --timeout=3 "http://127.0.0.1:${GATEWAY_PORT}/api/openapi/doc" || exit 1
# SQLite 形态才要求库文件（postgres 模式库在外部，文件不存在不是故障）
DB_MODE="${DATABASE_PROVIDER:-${DB_PROVIDER:-sqlite}}"
if [ "$DB_MODE" != "postgres" ]; then
  [ -f /app/db/custom.db ] || exit 1
fi
wget -q -O /dev/null --timeout=3 "http://127.0.0.1:${VNC_BRIDGE_PORT}/health" || exit 1
exit 0
