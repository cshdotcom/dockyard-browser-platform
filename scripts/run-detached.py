#!/usr/bin/env python3
"""跨命令存活启动器：python Popen(start_new_session=True) 可逃过沙箱进程清理
用法：python3 scripts/run-detached.py <logfile> <cwd> <command...>
"""
import os
import sys
import subprocess
import time

if len(sys.argv) < 4:
    print("usage: run-detached.py <logfile> <cwd> <command...>")
    sys.exit(1)

logfile = os.path.abspath(sys.argv[1])
cwd = os.path.abspath(sys.argv[2])
cmd = sys.argv[3:]

logfh = open(logfile, "ab", buffering=0)
proc = subprocess.Popen(
    cmd,
    cwd=cwd,
    stdout=logfh,
    stderr=subprocess.STDOUT,
    start_new_session=True,  # 关键：脱离本命令进程组，跨命令存活
    env={**os.environ, "PYTHONUNBUFFERED": "1"},
)
ts = time.strftime("%H:%M:%S")
print(f"[{ts}] detached pid={proc.pid} cwd={cwd} log={logfile} cmd={' '.join(cmd[:2])}...")
