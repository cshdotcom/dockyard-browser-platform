#!/usr/bin/env python3
"""守护化（setsid）重启 Next dev 服务器 —— 跨 Bash 会话存活"""
import subprocess
import sys
import time
import os
import signal
import urllib.request

CWD = "/home/z/my-project"


def kill_dev():
    """终止现有 next dev 进程树（bash 包装 + node + tee）"""
    out = subprocess.run(["ps", "-eo", "pid,args"], capture_output=True, text=True).stdout
    for line in out.splitlines():
        line = line.strip()
        if not line:
            continue
        pid, _, args = line.partition(" ")
        if "next dev" in args and "grep" not in args and "ps -eo" not in args:
            try:
                os.kill(int(pid), signal.SIGTERM)
                print(f"[daemon] SIGTERM → {pid} ({args[:60]})")
            except ProcessLookupError:
                pass
    time.sleep(2)
    # 二次强杀
    for line in out.splitlines():
        line = line.strip()
        if not line:
            continue
        pid, _, args = line.partition(" ")
        if "next dev" in args and "grep" not in args:
            try:
                os.kill(int(pid), signal.SIGKILL)
            except ProcessLookupError:
                pass


def start_dev():
    """setsid 守护化启动（新会话脱离当前 Bash 进程组）"""
    subprocess.Popen(
        ["bash", "-c", f"cd {CWD} && exec {CWD}/node_modules/.bin/next dev -p 3000 >> dev.log 2>&1"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    print("[daemon] next dev 已守护化启动（setsid）")


def wait_ready(timeout=60):
    for i in range(timeout):
        try:
            with urllib.request.urlopen("http://localhost:3000/login", timeout=3) as r:
                if r.status in (200, 307):
                    print(f"[daemon] dev 服务器就绪（{i+1}s）")
                    return True
        except Exception:
            pass
        time.sleep(1)
    print("[daemon] 等待就绪超时")
    return False


if __name__ == "__main__":
    kill_dev()
    time.sleep(1)
    start_dev()
    ok = wait_ready()
    sys.exit(0 if ok else 1)
