#!/bin/bash
# ============================================================
# r30 启动崩溃循环复现器 —— 以镜像同语义完整执行 docker/start.sh
# （/app → /tmp/dy-app 路径改写；全新卷；自定义端口避开 dev 服务）
# ============================================================
set -u
RUN=/tmp/dy-run
rm -rf "$RUN"; mkdir -p "$RUN"
sed 's|/app|/tmp/dy-app|g' /tmp/dy-app/docker/start.sh > "$RUN/start.sh"
chmod +x "$RUN/start.sh"

# 全新卷（模拟用户首次部署）
rm -rf /tmp/dy-app/db /tmp/dy-app/storage
mkdir -p /tmp/dy-app/db /tmp/dy-app/storage

cd /tmp/dy-app
export PORT=3999 GATEWAY_PORT=3999 APP_INTERNAL_PORT=13999 VNC_BRIDGE_PORT=3995 WS_HUB_PORT=3993
export DATABASE_PROVIDER=sqlite
export DATABASE_URL="file:/tmp/dy-app/db/custom.db"
export STORAGE_LOCAL_PATH=/tmp/dy-app/storage
export AUTH_SECRET=repro-secret ENCRYPTION_KEY=1234567890abcdef1234567890abcdef
export CRON_SECRET=repro-cron VNC_BRIDGE_SECRET=repro-bridge ADMIN_PASSWORD=Admin@2026
export TZ=Asia/Shanghai

timeout 100 sh "$RUN/start.sh" > "$RUN/guard-round.log" 2>&1
CODE=$?
echo "===== start.sh exit=$CODE ====="
echo "----- 关键日志行 -----"
grep -n "dockyard-start\|严重错误\|警告\|Error\|error" "$RUN/guard-round.log" | head -40
echo "----- server.log 尾部 -----"
tail -n 20 /tmp/dy-app/storage/server.log 2>/dev/null
echo "----- gateway.log 尾部 -----"
tail -n 10 /tmp/dy-app/storage/gateway.log 2>/dev/null
echo "----- 健康探测 -----"
wget -q -O /dev/null --timeout=3 "http://127.0.0.1:3999/__gateway/health" && echo "GATEWAY HEALTH OK" || echo "GATEWAY HEALTH FAIL"
