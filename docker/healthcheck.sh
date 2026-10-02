#!/bin/sh
# 健康自检：统一网关 HTTP 可达（含 Next 透传链）+ 数据库文件存在 + VNC 网关桥存活（回环）
PORT="${PORT:-3000}"
GATEWAY_PORT="${GATEWAY_PORT:-$PORT}"
VNC_BRIDGE_PORT="${VNC_BRIDGE_PORT:-3005}"
wget -q -O /dev/null --timeout=3 "http://127.0.0.1:${GATEWAY_PORT}/api/openapi/doc" || exit 1
[ -f /app/db/custom.db ] || exit 1
wget -q -O /dev/null --timeout=3 "http://127.0.0.1:${VNC_BRIDGE_PORT}/health" || exit 1
exit 0
