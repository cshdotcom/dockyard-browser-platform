#!/bin/bash
# r39 QA dev 守护：进程死即自动重启（3.5 小时 QA 期间保服务可用）
cd /home/z/my-project
mkdir -p storage/qa-r39
END=$(( $(date +%s) + 12900 ))  # ~3h35m
while [ $(date +%s) -lt $END ]; do
  if ! curl -s -o /dev/null --max-time 4 http://localhost:3000/login; then
    if ! pgrep -f "next dev" > /dev/null 2>&1; then
      echo "[guard] dev 死亡 $(date +%H:%M:%S) —— 重启" >> storage/qa-r39/dev-guard.log
      (NODE_OPTIONS="--max-old-space-size=1024" nohup bun run dev > dev.log 2>&1 &)
      sleep 30
    else
      sleep 20  # 编译窗口（进程在但暂时无响应）
    fi
  else
    sleep 15
  fi
done
echo "[guard] 完成 $(date +%H:%M:%S)" >> storage/qa-r39/dev-guard.log
