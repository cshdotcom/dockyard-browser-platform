#!/bin/sh
# 健康自检：主服务HTTP可达 + 数据库文件存在 + VNC 网关桥存活
PORT="${PORT:-3000}"
VNC_BRIDGE_PORT="${VNC_BRIDGE_PORT:-3005}"
wget -q -O /dev/null --timeout=3 "http://127.0.0.1:${PORT}/api/openapi/doc" || exit 1
[ -f /app/db/custom.db ] || exit 1
wget -q -O /dev/null --timeout=3 "http://127.0.0.1:${VNC_BRIDGE_PORT}/health" || exit 1
exit 0
