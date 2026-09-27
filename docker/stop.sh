#!/bin/sh
# Dockyard 停止脚本：优雅停止主服务与WS枢纽
log() { echo "[dockyard-stop] $1"; }
if [ -f /app/storage/server.pid ]; then kill "$(cat /app/storage/server.pid)" 2>/dev/null; fi
pkill -f "server.js" 2>/dev/null || true
pkill -f "ws-hub" 2>/dev/null || true
log "全部服务已停止"
