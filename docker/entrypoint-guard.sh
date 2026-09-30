#!/bin/sh
# ============================================================
# Dockyard 容器进程守护（PID 1）：
#   · 主进程崩溃 → 记录崩溃原因（server.log 尾部输出 stderr，docker logs 可见）
#     → 5 秒后自动重启全部服务（进程级自愈，docker --restart 之外的保险）
#   · docker stop / restart → 正确转发 SIGTERM，优雅停止后不再重启
# 此前 ENTRYPOINT 直接指向 start.sh：主进程一旦异常退出容器即整体停止
# （用户观察到的"启动没有错误、容器莫名其妙停了"的放大器）。
# ============================================================
GUARD_CHILD=""
STOPPING=0

on_term() {
  STOPPING=1
  echo "[guard] 收到终止信号，正在停止全部服务..." >&2
  if [ -n "$GUARD_CHILD" ]; then
    kill -TERM "$GUARD_CHILD" 2>/dev/null || true
    # 等待 start.sh 自身 trap 完成子进程清理（最多 15 秒，超时强杀）
    n=0
    while kill -0 "$GUARD_CHILD" 2>/dev/null && [ "$n" -lt 15 ]; do
      sleep 1
      n=$((n + 1))
    done
    kill -KILL "$GUARD_CHILD" 2>/dev/null || true
  fi
  exit 0
}
trap on_term SIGTERM SIGINT

ROUND=0
while :; do
  ROUND=$((ROUND + 1))
  echo "[guard] 第 ${ROUND} 轮启动主服务（$(date '+%Y-%m-%d %H:%M:%S')）..." >&2
  /app/docker/start.sh &
  GUARD_CHILD=$!
  wait "$GUARD_CHILD"
  CODE=$?
  GUARD_CHILD=""
  if [ "$STOPPING" = "1" ]; then
    exit 0
  fi
  echo "[guard] 主进程退出（exit=${CODE}），崩溃原因线索（server.log 尾部）：" >&2
  tail -n 15 /app/storage/server.log 2>/dev/null >&2 || true
  echo "[guard] 5 秒后自动重启（进程级自愈）..." >&2
  sleep 5
done
