#!/bin/bash
# r12 CI 监控：等待 main(a08ab04) + tag(v1.5.1) 全部 workflow 完成
# 凭据经 GITHUB_TOKEN 环境变量注入（绝不硬编码入库）
TOKEN="${GITHUB_TOKEN:-}"
REPO="cshdotcom/dockyard-browser-platform"
SHA="$(git -C /home/z/my-project rev-parse HEAD)"

echo "监控 commit: $SHA (tag v1.5.1)"
for i in $(seq 1 90); do
  OUT=$(curl -s -H "Authorization: token $TOKEN" "https://api.github.com/repos/$REPO/actions/runs?per_page=10" | python3 -c "
import json,sys
d = json.load(sys.stdin)
runs = [r for r in d.get('workflow_runs', []) if r['head_sha'].startswith('${SHA:0:10}') or r['head_tag'] == 'v1.5.1']
for r in runs:
    print(r['id'], r['name'][:45], r['status'], r.get('conclusion'))
print('TOTAL', len(runs))
")
  TOTAL=$(echo "$OUT" | grep '^TOTAL' | awk '{print $2}')
  DONE=$(echo "$OUT" | grep -v '^TOTAL' | awk '$3=="completed"' | wc -l)
  echo "[轮询 $i] 进行中/总数: $((TOTAL-DONE))/$TOTAL"
  echo "$OUT" | grep -v '^TOTAL' | head -8
  if [ "$TOTAL" -ge 3 ] && [ "$DONE" -eq "$TOTAL" ]; then
    echo "=== 全部完成 ==="
    echo "$OUT" | grep -v '^TOTAL'
    FAILS=$(echo "$OUT" | grep -v '^TOTAL' | awk '$4!="success"' | wc -l)
    [ "$FAILS" -gt 0 ] && echo "存在非 success 结论！" && exit 2
    echo "CI 全绿 ✅"
    exit 0
  fi
  sleep 20
done
echo "超时（90轮×20s）"
exit 1
