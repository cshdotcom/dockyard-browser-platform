#!/bin/bash
# CI 监控：轮询 GitHub Actions 运行状态直至本轮 push 的全部工作流结束
# 凭据经 GITHUB_TOKEN 环境变量注入（绝不硬编码入库，会被密钥扫描推送保护拦截）
TOKEN="${GITHUB_TOKEN:-}"
REPO="${GITHUB_REPO:-cshdotcom/dockyard-browser-platform}"
SHA="$1"
if [ -z "$SHA" ]; then SHA=$(git -C /home/z/my-project rev-parse HEAD); fi
echo "监控 commit: $SHA"

for i in $(seq 1 90); do
  RUNS=$(curl -s -H "Authorization: token $TOKEN" "https://api.github.com/repos/$REPO/actions/runs?head_sha=$SHA&per_page=20")
  TOTAL=$(echo "$RUNS" | python3 -c "
import json, sys
d = json.load(sys.stdin)
runs = d.get('workflow_runs', [])
print(len(runs))
")
  if [ "$TOTAL" = "0" ] || [ -z "$TOTAL" ]; then
    echo "[$i] 尚未发现运行中的工作流…"
    sleep 15
    continue
  fi
  STATUS=$(echo "$RUNS" | python3 -c "
import json, sys
d = json.load(sys.stdin)
runs = d.get('workflow_runs', [])
for r in runs:
    print(f\"{r['name']}|{r['status']}|{r.get('conclusion') or '-'}|{r['html_url']}\")
")
  echo "--- 轮询 #$i ($(date +%H:%M:%S)) ---"
  echo "$STATUS"
  DONE=$(echo "$STATUS" | awk -F'|' '$2 != "completed" {found=1} END {print (found ? "0" : "1")}')
  if [ "$DONE" = "1" ]; then
    echo "=== 全部工作流已完成 ==="
    echo "$STATUS" | awk -F'|' '{print $1, "→", $3}'
    FAILS=$(echo "$STATUS" | grep -cv "success" || true)
    if [ "$FAILS" = "0" ]; then
      echo "RESULT: ALL_SUCCESS"
    else
      echo "RESULT: HAS_FAILURES ($FAILS)"
    fi
    exit 0
  fi
  sleep 20
done
echo "RESULT: TIMEOUT"
exit 1
