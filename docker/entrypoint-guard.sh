#!/bin/sh
# 守护进程脚本：崩溃自动重启（docker run --restart 之外的进程级守护）
while true; do
  /app/docker/start.sh
  echo "[guard] 主进程退出，5秒后自动重启..." >&2
  sleep 5
done
