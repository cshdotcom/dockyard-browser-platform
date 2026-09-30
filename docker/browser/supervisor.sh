#!/bin/sh
# ============================================================
# Dockyard 浏览器 supervisor —— 防退出核心（容器 PID 1）
# 职责：
#   · Xvfb 虚拟显示 + x11vnc(RFB 5900) 常驻
#   · Chromium 死循环拉起：任何形式的浏览器退出（用户关闭窗口、Ctrl+Q、
#     崩溃闪退、OOM 被杀、段错误）都在 1 秒内以【同一 Profile】自动恢复
#   · 响应 SIGUSR1（平台 restartBrowserProcess 经 docker exec 触发进程级重启）
# 读取环境变量：
#   RESOLUTION 显示分辨率（默认 1280x800）
#   START_URL  启动页（平台按模板/用户配置下发）
#   PROXY_URL  代理服务器（socks5/http，按代理节点下发）
# ============================================================
set -u
export HOME=/home/browser

log() { echo "[browser-supervisor] $1"; }

# ---- 1. 虚拟显示 ----
Xvfb :99 -screen 0 "${RESOLUTION:-1280x800x24}" -nolisten tcp &
XVFB_PID=$!

# 等待 X 就绪（最多 5 秒）
i=0
while [ "$i" -lt 50 ]; do
  if xdpyinfo -display :99 >/dev/null 2>&1; then break; fi
  sleep 0.1
  i=$((i + 1))
done
log "Xvfb 就绪：${RESOLUTION:-1280x800x24}"

# ---- 2. VNC 服务（仅容器网络命名空间内可达，由平台 VNC 桥中转） ----
x11vnc -display :99 -forever -shared -rfbport 5900 -nopw -noxdamage -repeat -quiet -o /tmp/x11vnc.log &
log "x11vnc 监听 :5900"

# ---- 3. USR1 → 浏览器进程级重启（平台运维通道） ----
CHROME_PID=""
restart_chrome() {
  if [ -n "$CHROME_PID" ]; then
    log "收到 USR1：重启浏览器进程（同一 Profile）"
    kill "$CHROME_PID" 2>/dev/null || true
  fi
}
trap restart_chrome USR1

PROXY_ARGS=""
if [ -n "${PROXY_URL:-}" ]; then
  PROXY_ARGS="--proxy-server=${PROXY_URL}"
  log "启用代理：${PROXY_URL}"
fi

# 网络访问管控：平台按管理员策略下发 /etc/chromium/policies/managed/dockyard.json
#（URLBlocklist 拦截内网/安全位置 + ProxyMode 锁定；文件只读 bind-mount，此处仅提示存在性）
if [ -f /etc/chromium/policies/managed/dockyard.json ]; then
  log "网络策略托管策略已注入（Chromium managed policy）"
fi

# ---- 4. 防退出主循环 ----
# 浏览器退出（任何原因）→ wait 返回 → 1 秒后以同一 user-data-dir 拉起
# 用户“闪退后立即打开”得到的永远是同一个配置的浏览器环境
RESTARTS=0
while :; do
  chromium \
    --user-data-dir=/home/browser/profile \
    --no-sandbox \
    --disable-gpu \
    --no-first-run \
    --disable-session-crashed-bubble \
    --hide-crash-restore-bubble \
    --restore-last-session \
    --start-maximized \
    --remote-debugging-address=0.0.0.0 \
    --remote-debugging-port=9222 \
    --download.default_directory=/home/browser/downloads \
    --disable-quic \
    --force-webrtc-ip-handling-policy=disable_non_proxied_udp \
    --disable-features=ExitWarningBubble,WebRtcAllowInputVolumeAdjustment \
    $PROXY_ARGS \
    "${START_URL:-about:blank}" &
  CHROME_PID=$!
  wait "$CHROME_PID" 2>/dev/null || true
  CHROME_PID=""
  RESTARTS=$((RESTARTS + 1))
  log "浏览器进程退出（第 ${RESTARTS} 次），1 秒后以同一 Profile 自动拉起"
  sleep 1
done
