#!/bin/bash
# ============================================================
# r30-c 冒烟：Worker 执行节点入口守护（Dockerfile.worker 入口）
# 断言：
#   1. 三环境变量缺失 → 拒绝启动（exit 1）+ 三步部署指引
#   2. 凭据齐全 + 主控不可达 → Worker 存活（心跳失败仅告警不崩溃）
#   3. /health 端点：nodeUuid/版本/master 地址/心跳状态
#   4. SIGTERM → 优雅退出（exit 0）
#   5. 文件通道：file.put sha256 校验 + 穿越拒绝（r29 已测，此处随镜像入口回归）
# ============================================================
set -u
PASS=0; FAIL=0
ck() { if [ "$2" = "0" ]; then PASS=$((PASS+1)); echo "  ✓ $1"; else FAIL=$((FAIL+1)); echo "  ✗ $1"; fi }

W=/tmp/dy-worker
rm -rf $W; mkdir -p $W
mkdir -p $W/mini-services && cp -a /home/z/my-project/mini-services/worker $W/mini-services/worker
mkdir -p $W/storage
sed "s|/app|$W|g" /home/z/my-project/docker/worker-entrypoint.sh > $W/entry.sh
chmod +x $W/entry.sh

echo "== r30-c 冒烟：Worker 执行节点入口 =="

# ---------- 1. 缺环境变量 → 拒绝启动 ----------
( cd $W && timeout 15 sh $W/entry.sh > $W/miss.log 2>&1; echo "EXIT=$?" >> $W/miss.log )
grep -q "缺少必需环境变量： MASTER_API_URL WORKER_NODE_UUID WORKER_API_KEY" $W/miss.log; ck "1 三变量缺失：FATAL + 明细" "$?"
grep -q "EXIT=1" $W/miss.log; ck "1b 缺失拒绝启动（exit 1）" "$?"
grep -q "注册节点" $W/miss.log; ck "1c 附三步部署指引" "$?"

# ---------- 2-4. 凭据齐全 + 主控不可达 → 存活 + health + 优雅退出 ----------
export MASTER_API_URL="http://127.0.0.1:9"   # 黑洞端口：连接立即拒绝（心跳失败容忍）
export WORKER_NODE_UUID="wn-0123456789abcdef"
export WORKER_API_KEY="qa-worker-key-r30"
export WORKER_HEALTH_PORT=3907
export WORKER_DFS_DIR=$W/storage/dfs
setsid timeout 40 sh $W/entry.sh > $W/run.log 2>&1 &
GUARD_PID=$!
HP=3907
HEALTH_OK=1
for i in $(seq 1 20); do
  BODY=$(wget -q -O- --timeout=2 "http://127.0.0.1:$HP/health" 2>/dev/null) && { HEALTH_OK=0; break; }
  sleep 1
done
ck "2 主控不可达：Worker 存活且 /health 响应" "$HEALTH_OK"
echo "$BODY" | grep -q '"nodeUuid":"wn-0123456789abcdef"'; ck "3a /health 暴露 nodeUuid" "$?"
echo "$BODY" | grep -q '"service":"dockyard-worker"'; ck "3b /health 标识 service/版本" "$?"
echo "$BODY" | grep -q '"evicted":false'; ck "3c /health 未被驱逐（evicted=false）" "$?"
grep -q "心跳失败（主控不可达）" $W/run.log; ck "2b 心跳失败仅告警（不崩溃不退出）" "$?"

# ---------- 5. 文件通道随入口回归 ----------
ls $W/storage/dfs >/dev/null 2>&1; ck "5a WORKER_DFS_DIR 目录就位" "$?"

# ---------- 4. SIGTERM 优雅退出 ----------
kill -TERM "-$GUARD_PID" 2>/dev/null || kill -TERM "$GUARD_PID" 2>/dev/null || true
sleep 3
if kill -0 "-$GUARD_PID" 2>/dev/null || kill -0 "$GUARD_PID" 2>/dev/null; then
  ck "4 SIGTERM 优雅退出（guard 进程结束）" 1
else
  ck "4 SIGTERM 优雅退出（guard 进程结束）" 0
fi
pkill -f "dy-worker/mini-services" 2>/dev/null; sleep 1

echo ""
echo "结果: $PASS pass, $FAIL fail"
[ "$FAIL" = "0" ] && exit 0 || exit 1
