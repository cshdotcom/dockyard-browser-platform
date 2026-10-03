#!/usr/bin/env python3
"""mini-services 守护启动（vnc-bridge :3005 + ws-hub :3003/3004 + cdp-gateway :3006）

为什么用 python Popen(start_new_session=True) 而不是 bash setsid：
  实测沙箱 Bash 工具在命令结束时清理本命令派生的进程（setsid+disown 也逃不掉），
  而 python subprocess.Popen(start_new_session=True) 启动的进程可跨命令长期存活
  （next dev 即此模式，已验证存活 20+ 分钟）。
幂等：端口已被监听时跳过（不重复启动）。
"""
import json
import subprocess
import sys
import time
import urllib.request

BRIDGE = "/home/z/my-project/mini-services/vnc-bridge"
HUB = "/home/z/my-project/mini-services/ws-hub"
CDPGW = "/home/z/my-project/mini-services/cdp-gateway"


def port_alive(port: int, probe: str = "/health") -> bool:
    try:
        with urllib.request.urlopen(f"http://localhost:{port}{probe}", timeout=2) as r:
            return r.status == 200
    except Exception:
        # socket.io 根路径返回 400 也算活着
        return False


def http_code(port: int) -> int:
    try:
        with urllib.request.urlopen(f"http://localhost:{port}/", timeout=2) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception:
        return 0


def launch(cwd: str, args: list[str], logfile: str) -> subprocess.Popen | None:
    out = open(logfile, "ab")
    return subprocess.Popen(
        ["bash", "-c", f"cd {cwd} && exec {' '.join(args)}"],
        stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT,
        start_new_session=True,
    )


def main() -> int:
    started = []
    # vnc-bridge（health 200 判活）
    if not port_alive(3005):
        launch(BRIDGE, ["bun", "index.ts"], "/home/z/my-project/vnc-bridge.log")
        started.append("vnc-bridge")
    else:
        print("[services] vnc-bridge 已在运行（:3005 health ok）")
    # ws-hub（socket.io 根路径 400 判活；0 = 端口没人听）
    if http_code(3003) == 0:
        launch(HUB, ["bun", "--hot", "index.ts"], "/home/z/my-project/ws-hub.log")
        started.append("ws-hub")
    else:
        print("[services] ws-hub 已在运行（:3003 有响应）")
    # cdp-gateway（r28：CDP 外网网关桥，health 200 判活）
    if not port_alive(3006):
        launch(CDPGW, ["bun", "index.ts"], "/home/z/my-project/cdp-gateway.log")
        started.append("cdp-gateway")
    else:
        print("[services] cdp-gateway 已在运行（:3006 health ok）")

    # 等待就绪
    ok = {"vnc-bridge": False, "ws-hub": False, "cdp-gateway": False}
    for _ in range(20):
        if "vnc-bridge" in started or ok["vnc-bridge"]:
            ok["vnc-bridge"] = port_alive(3005)
        else:
            ok["vnc-bridge"] = True
        if "ws-hub" in started or ok["ws-hub"]:
            ok["ws-hub"] = http_code(3003) != 0
        else:
            ok["ws-hub"] = True
        if "cdp-gateway" in started or ok["cdp-gateway"]:
            ok["cdp-gateway"] = port_alive(3006)
        else:
            ok["cdp-gateway"] = True
        if all(ok.values()):
            break
        time.sleep(1)
    print(json.dumps({"started": started, "ready": ok}, ensure_ascii=False))
    return 0 if all(ok.values()) else 1


if __name__ == "__main__":
    sys.exit(main())
