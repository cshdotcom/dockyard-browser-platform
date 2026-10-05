#!/bin/bash
# r38 QA dev 守护：进程死即自动重启（3 小时 QA 期间保服务可用）
cd /home/z/my-project
END=$(( $(date +%s) + 11500 ))  # ~3h10m
while [ $(date +%s) -lt $END ]; do
  if ! curl -s -o /dev/null --max-time 4 http://localhost:3000/login; then
    if ! pgrep -f "next dev" > /dev/null 2>&1; then
      echo "[guard] dev 死亡 $(date +%H:%M:%S) —— 重启" >> storage/qa-r38/dev-guard.log
      (NODE_OPTIONS="--max-old-space-size=1536" nohup bun run dev > dev.log 2>&1 &)
      sleep 30
    else
      sleep 20  # 编译窗口（进程在但暂时无响应）
    fi
  else
    sleep 15
  fi
done
echo "[guard] 完成 $(date +%H:%M:%S)" >> storage/qa-r38/dev-guard.log
