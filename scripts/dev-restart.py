#!/usr/bin/env python3
"""重启 next dev（start_new_session 长驻）"""
import subprocess, os, sys, time
subprocess.Popen(
    ["bun", "run", "dev"],
    cwd="/home/z/my-project",
    stdout=open("/home/z/my-project/dev.log", "a"),
    stderr=subprocess.STDOUT,
    start_new_session=True,
    env={**os.environ, "PORT": "3000"},
)
time.sleep(2)
print("started")
