#!/bin/sh
# ============================================================
# Dockyard 容器进程守护（PID 1）：
#   · 主进程崩溃 → 记录崩溃原因（server.log 尾部输出 stderr，docker logs 可见）
#     → 5 秒后自动重启全部服务（进程级自愈，docker --restart 之外的保险）
#   · docker stop / restart → 正确转发 SIGTERM，优雅停止后不再重启
# 此前 ENTRYPOINT 直接指向 start.sh：主进程一旦异常退出容器即整体停止
# （用户观察到的"启动没有错误、容器莫名其妙停了"的放大器）。
#
# r13c 关键修复：
#   1. trap 信号名 dash 兼容（无 SIG 前缀；旧写法 "bad trap" → docker stop 无优雅退出）
#   2. start.sh 经 setsid 独立进程组启动：崩溃退出后按进程组整组清理，
#      杜绝孤儿 vnc-bridge/ws-hub 残留占端口 → 下一轮 EADDRINUSE 无限循环
#      （用户日志实证：vnc-bridge 3046 EADDRINUSE 222 次 + guard 20+ 轮循环）
# ============================================================
GUARD_CHILD=""
STOPPING=0

on_term() {
  STOPPING=1
  echo "[guard] 收到终止信号，正在停止全部服务..." >&2
  if [ -n "$GUARD_CHILD" ]; then
    # 整个进程组一起 TERM（start.sh 的 EXIT 钩子也会做子进程清理，双保险）
    kill -TERM "-$GUARD_CHILD" 2>/dev/null || kill -TERM "$GUARD_CHILD" 2>/dev/null || true
    # 等待 start.sh 自身 trap 完成子进程清理（最多 15 秒，超时强杀整组）
    n=0
    while kill -0 "$GUARD_CHILD" 2>/dev/null && [ "$n" -lt 15 ]; do
      sleep 1
      n=$((n + 1))
    done
    kill -KILL "-$GUARD_CHILD" 2>/dev/null || true
    kill -KILL "$GUARD_CHILD" 2>/dev/null || true
  fi
  exit 0
}
# dash 兼容：信号名不带 SIG 前缀
trap on_term TERM INT

ROUND=0
while :; do
  ROUND=$((ROUND + 1))
  echo "[guard] 第 ${ROUND} 轮启动主服务（$(date '+%Y-%m-%d %H:%M:%S')）..." >&2
  # setsid：start.sh 成为新会话/进程组组长（PGID=PID），其派生的全部子进程
  # （WS枢纽/VNC桥/网关/主服务/cron/tail）同组 —— 退出后可按组精确清理
  setsid /app/docker/start.sh &
  GUARD_CHILD=$!
  wait "$GUARD_CHILD"
  CODE=$?
  # 立即清理崩溃轮残留的整组孤儿进程（start.sh EXIT 钩子之外的兜底；幂等）
  # 必须在重置 GUARD_CHILD 之前执行：wait 返回后组内孤儿仍在，按 PGID 整组击杀
  kill -TERM "-$GUARD_CHILD" 2>/dev/null || true
  kill -KILL "-$GUARD_CHILD" 2>/dev/null || true
  GUARD_CHILD=""
  if [ "$STOPPING" = "1" ]; then
    exit 0
  fi
  echo "[guard] 主进程退出（exit=${CODE}），崩溃原因线索（server.log 尾部）：" >&2
  tail -n 15 /app/storage/server.log 2>/dev/null >&2 || true
  tail -n 8 /app/storage/ws-hub.log 2>/dev/null >&2 || true
  tail -n 8 /app/storage/vnc-bridge.log 2>/dev/null >&2 || true
  echo "[guard] 5 秒后自动重启（进程级自愈）..." >&2
  sleep 5
done
