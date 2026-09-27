#!/bin/sh
# 健康自检：主服务HTTP可达 + 数据库文件存在
PORT="${PORT:-3000}"
wget -q -O /dev/null --timeout=3 "http://127.0.0.1:${PORT}/api/openapi/doc" || exit 1
[ -f /app/db/custom.db ] || exit 1
exit 0
