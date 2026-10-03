#!/bin/bash
# ============================================================
# r30-b 冒烟：启动链路可靠性（镜像同布局 /app→/tmp/dy-app 复现）
# 断言：
#   1. 全新卷启动 → 「DOCKYARD 启动成功」横幅 + boot-state=ready
#   2. healthcheck.sh 退出 0（三探测 + boot-state 语义）
#   3. server.log 无 prisma:query 洪水（查询日志默认关）
#   4. PostgreSQL 未配置 URL → 清晰严重错误 + exit 1（配置错误快速失败）
#   5. SQLite db push 失败模拟 → 3 次重试 + 高亮错误块 + 继续启动（不 exit）
#   6. boot-state=crashed → healthcheck 立即判死
#   7. boot-state=starting 宽限期语义（期内判活 / 超期走真实探测）
# ============================================================
set -u
PASS=0; FAIL=0
ck() { # $1=名称 $2=0/1（0=通过）
  if [ "$2" = "0" ]; then PASS=$((PASS+1)); echo "  ✓ $1"; else FAIL=$((FAIL+1)); echo "  ✗ $1"; fi
}
RUN=/tmp/dy-run2
APP=/tmp/dy-app

# 清理历史残留（本机历轮复现的孤儿进程，防端口冲突）
pkill -f "dy-app/mini-services" 2>/dev/null; pkill -f "dy-run2-start" 2>/dev/null; pkill -f "dy-app/server.js" 2>/dev/null; sleep 1

sed "s|/app|$APP|g" $APP/docker/start.sh > /tmp/dy-run2-start.sh; chmod +x /tmp/dy-run2-start.sh
sed "s|/app|$APP|g" $APP/docker/healthcheck.sh > /tmp/dy-run2-hc.sh; chmod +x /tmp/dy-run2-hc.sh
mkdir -p "$RUN"

# ---------- 场景 1-3：全新卷正常启动（后台运行，存活期探测）----------
rm -rf $APP/db $APP/storage; mkdir -p $APP/db $APP/storage
cd $APP
export PORT=3999 GATEWAY_PORT=3999 APP_INTERNAL_PORT=13999 VNC_BRIDGE_PORT=3995 WS_HUB_PORT=3993 WS_EVENT_PORT=3994
export DATABASE_PROVIDER=sqlite DATABASE_URL="file:$APP/db/custom.db" STORAGE_LOCAL_PATH=$APP/storage
export AUTH_SECRET=repro ENCRYPTION_KEY=1234567890abcdef1234567890abcdef CRON_SECRET=repro VNC_BRIDGE_SECRET=repro ADMIN_PASSWORD=Admin@2026 TZ=Asia/Shanghai
setsid timeout 75 sh /tmp/dy-run2-start.sh > "$RUN/round.log" 2>&1 &
ROUND_PID=$!

# 轮询等待启动成功横幅（最多 70s）
BANNER=1
for i in $(seq 1 70); do
  if grep -q "DOCKYARD 启动成功" "$RUN/round.log" 2>/dev/null; then BANNER=0; break; fi
  sleep 1
done
ck "1a 全新卷：「DOCKYARD 启动成功」横幅出现（≤70s）" "$BANNER"
grep -q "^ready" "$APP/storage/.boot-state" 2>/dev/null; ck "1b boot-state=ready 标记" "$?"
grep -q "数据库形态：SQLite" "$RUN/round.log"; ck "1c SQLite 形态日志" "$?"

# 3：查询日志洪水（server.log 不应出现 prisma:query；旧版每条 SQL 都打印）
QCOUNT=$(grep -c "prisma:query" "$APP/storage/server.log" 2>/dev/null || true); QCOUNT=${QCOUNT:-0}
[ "${QCOUNT:-0}" = "0" ]; ck "3 查询日志洪水已关（server.log prisma:query=0，实测 ${QCOUNT:-0}）" "$?"

# 2：healthcheck 真实探测（服务存活期）
sh /tmp/dy-run2-hc.sh; ck "2 healthcheck（ready）退出 0（网关全链路+桥+库文件）" "$?"

# 6：crashed 状态 → 立即判死
echo "crashed $(date +%s)" > $APP/storage/.boot-state
sh /tmp/dy-run2-hc.sh; RC=$?; [ "$RC" != "0" ]; ck "6 boot-state=crashed → healthcheck 立即判死（exit=$RC）" "$?"

# 7：starting 宽限期语义
echo "starting $(date +%s)" > $APP/storage/.boot-state
sh /tmp/dy-run2-hc.sh; ck "7 starting 宽限期内判活（迁移期编排器不杀容器）" "$?"
echo "ready $(date +%s)" > $APP/storage/.boot-state

# 收场景 1 的轮（TERM → EXIT 钩子清理子进程）
kill -TERM "-$ROUND_PID" 2>/dev/null || kill -TERM "$ROUND_PID" 2>/dev/null || true
sleep 3; pkill -f "dy-app/mini-services" 2>/dev/null; pkill -f "dy-app/server.js" 2>/dev/null; sleep 1

# 7b：超宽限期 starting + 服务已停 → 走真实探测判死（宽限期不是永久免死金牌）
echo "starting $(( $(date +%s) - 1200 ))" > $APP/storage/.boot-state
sh /tmp/dy-run2-hc.sh; RC=$?; [ "$RC" != "0" ]; ck "7b starting 超宽限期（20min 前）+ 服务停止 → 真实探测判死（exit=$RC）" "$?"

# ---------- 场景 4：PostgreSQL 未配置 URL → 快速失败 ----------
( export DATABASE_PROVIDER=postgres DATABASE_URL=""
  timeout 25 sh /tmp/dy-run2-start.sh > "$RUN/pg.log" 2>&1; echo "EXIT=$?" >> "$RUN/pg.log" )
grep -q "严重错误：DATABASE_PROVIDER=postgres 但 DATABASE_URL 不是" "$RUN/pg.log"; ck "4a PG 缺 URL：清晰严重错误（人读得懂）" "$?"
grep -q "EXIT=1" "$RUN/pg.log"; ck "4b PG 缺 URL：exit 1 快速失败（配置错误不无限等待）" "$?"

# ---------- 场景 5：SQLite db push 失败（只读目录）→ 重试+高亮+继续 ----------
( export DATABASE_URL="file:/proc/definitely-readonly/qa-fail.db"
  timeout 100 sh /tmp/dy-run2-start.sh > "$RUN/sqlite-fail.log" 2>&1; echo "EXIT=$?" >> "$RUN/sqlite-fail.log" )
grep -q "SQLite 结构推送失败（第 1/3 次" "$RUN/sqlite-fail.log"; ck "5a SQLite 失败：第 1/3 次重试日志可见" "$?"
grep -q "严重错误：数据库结构推送 3 次均失败" "$RUN/sqlite-fail.log"; ck "5b SQLite 失败：高亮错误块" "$?"
grep -q "排查：df -h" "$RUN/sqlite-fail.log"; ck "5c SQLite 失败：附排查指引（磁盘/权限）" "$?"
grep -q "启动 Dockyard 主服务" "$RUN/sqlite-fail.log"; ck "5d SQLite 失败后继续启动主服务（旧结构兼容语义，不 exit）" "$?"
grep -q "EXIT=124" "$RUN/sqlite-fail.log"; ck "5e 轮保持存活至 timeout（非自旋崩溃）" "$?"

pkill -f "dy-app/mini-services" 2>/dev/null; pkill -f "dy-app/server.js" 2>/dev/null; sleep 1

echo ""
echo "结果: $PASS pass, $FAIL fail"
[ "$FAIL" = "0" ] && exit 0 || exit 1
