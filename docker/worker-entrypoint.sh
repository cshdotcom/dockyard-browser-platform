#!/bin/sh
# ============================================================
# Dockyard Worker 纯净工作节点入口守护（PID 1，r30）
# 镜像：Dockerfile.worker（分布式部署执行节点）
#
# 启动前置（三环境变量缺一即拒绝启动 —— 与 worker/index.ts 同语义）：
#   · MASTER_API_URL     主控平台地址（如 http://master:3000）
#   · WORKER_NODE_UUID   节点 UUID（wn- 前缀 16 位 hex，主控注册时生成）
#   · WORKER_API_KEY     节点 API Key（注册时一次性展示，仅哈希存主控）
#
# 守护语义：
#   · Worker 进程崩溃（非驱逐）→ 退避重启（5→10→20→30s 封顶），稳态重置
#   · exit=2（主控 403 拒绝）/ exit=3（节点已删除）→ 识别为「节点失效」：
#     停止重启并保持容器退出 —— 该节点需在主控重新注册获得新凭据，
#     避免以失效凭据疯狂冲击主控心跳接口
#   · docker stop → SIGTERM 优雅退出（worker 自身关闭 health 服务）
# ============================================================
WORKER_APP=/app/mini-services/worker
STOPPING=0
CONSEC_CRASH=0

on_term() {
  STOPPING=1
  echo "[worker-guard] 收到终止信号，停止 Worker..." >&2
  if [ -n "$CHILD" ]; then
    kill -TERM "$CHILD" 2>/dev/null || true
    n=0
    while kill -0 "$CHILD" 2>/dev/null && [ "$n" -lt 10 ]; do
      sleep 1
      n=$((n + 1))
    done
    kill -KILL "$CHILD" 2>/dev/null || true
  fi
  exit 0
}
trap on_term TERM INT

# 入口即校验（worker 进程自身还会二重校验；此处给出人读得懂的指引）
MISSING=""
[ -z "${MASTER_API_URL:-}" ] && MISSING="$MISSING MASTER_API_URL"
[ -z "${WORKER_NODE_UUID:-}" ] && MISSING="$MISSING WORKER_NODE_UUID"
[ -z "${WORKER_API_KEY:-}" ] && MISSING="$MISSING WORKER_API_KEY"
if [ -n "$MISSING" ]; then
  echo "==============================================================" >&2
  echo "[worker-guard] FATAL：缺少必需环境变量：$MISSING" >&2
  echo "[worker-guard] 三步部署：" >&2
  echo "  1. 主控管理后台 →「工作节点」→ 注册节点（一次性展示 UUID + API Key，请立即保存）" >&2
  echo "  2. docker run -e MASTER_API_URL=http://master:3000 \\" >&2
  echo "       -e WORKER_NODE_UUID=wn-xxxxxxxxxxxxxxxx \\" >&2
  echo "       -e WORKER_API_KEY=<注册时展示的 Key> ghcr.io/<repo>-worker" >&2
  echo "  3. 主控节点面板确认状态 ONLINE（10s 心跳）" >&2
  echo "==============================================================" >&2
  exit 1
fi

mkdir -p /app/storage/dfs /app/storage/sandboxes /app/storage/homes /app/storage/recordings
export WORKER_DFS_DIR="${WORKER_DFS_DIR:-/app/storage/dfs}"

ROUND=0
CHILD=""
while :; do
  ROUND=$((ROUND + 1))
  echo "[worker-guard] 第 ${ROUND} 轮启动 Worker（$(date '+%Y-%m-%d %H:%M:%S')）..." >&2
  cd "$WORKER_APP"
  bun index.ts &
  CHILD=$!
  wait "$CHILD"
  CODE=$?
  CHILD=""
  if [ "$STOPPING" = "1" ]; then
    exit 0
  fi
  # 主控判定节点失效（403 拒绝/已删除）→ 不再重启，保持退出让运维重新注册
  if [ "$CODE" = "2" ] || [ "$CODE" = "3" ]; then
    echo "[worker-guard] 节点已被主控失效（exit=$CODE：2=凭据被拒/已驱逐，3=节点已删除）" >&2
    echo "[worker-guard] 请到主控管理后台重新注册节点并以新凭据部署（容器保持退出，不再冲击主控）" >&2
    exit "$CODE"
  fi
  CONSEC_CRASH=$((CONSEC_CRASH + 1))
  if [ "$CONSEC_CRASH" -gt 5 ]; then CONSEC_CRASH=5; fi
  case "$CONSEC_CRASH" in
    1) SLEEP=5 ;;
    2) SLEEP=10 ;;
    3) SLEEP=20 ;;
    4) SLEEP=30 ;;
    *) SLEEP=30 ;;
  esac
  echo "[worker-guard] Worker 进程退出（exit=$CODE，连续崩溃 ${CONSEC_CRASH} 次），${SLEEP}s 后退避重启..." >&2
  tail -n 10 /app/storage/worker.log 2>/dev/null >&2 || true
  sleep "$SLEEP"
done
