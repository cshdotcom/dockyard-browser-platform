#!/bin/sh
# ============================================================
# Dockyard 浏览器 supervisor —— 防退出核心（容器 PID 1）
# 职责：
#   · Xvfb 虚拟显示 + x11vnc(RFB 5900) 常驻
#   · Chromium 死循环拉起：任何形式的浏览器退出（用户关闭窗口、Ctrl+Q、
#     崩溃闪退、OOM 被杀、段错误）都在 1 秒内以【同一 Profile】自动恢复
#   · 响应 SIGUSR1（平台 restartBrowserProcess 经 docker exec 触发进程级重启）
#   · r36：pulseaudio 虚拟声卡 + dockyard-mix 空沉 + .monitor 监听源
#     （远程声音回传：平台 ffmpeg 抓 dockyard-mix.monitor 编码回传控制端）
# 读取环境变量：
#   RESOLUTION 显示分辨率（默认 1280x800）
#   START_URL  启动页（平台按模板/用户配置下发）
#   PROXY_URL  代理服务器（socks5/http，按代理节点下发）
#   EXIT_GUARD 防退出档位 r27（normal/fullscreen/kiosk；见 guard_args）
#   REC_DIR    录像目录 r27（策略命中下发；容器内 ffmpeg x11grab 分段落盘）
#   REC_FPS/REC_SEGSEC/REC_MAXSEC/REC_SIZE 录像参数
#   DY_AUDIO_ENABLED 0/1 声音回传链路开关（默认 1；镜像含 pulseaudio 即启用）
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

# ---- 2.2 r36：pulseaudio 虚拟声卡（远程声音回传链路）----
# 容器无真实声卡：pulse 用户模式 daemon + null sink（dockyard-mix）作为
# Chromium 默认输出 → 其 .monitor 监听源即“虚拟扬声器回放流”。
# 平台侧 ffmpeg -f pulse -i dockyard-mix.monitor 抓取后编码回传控制端。
# ReadOnlyRootfs：socket/运行时目录放 /tmp（tmpfs 可写）。
# XDG_RUNTIME_DIR 指向 /tmp/pulse：chromium 与 ffmpeg 都经由 PULSE_SERVER 寻址。
AUDIO_READY=0
if [ "${DY_AUDIO_ENABLED:-1}" = "1" ] && command -v pulseaudio >/dev/null 2>&1; then
  export XDG_RUNTIME_DIR=/tmp/pulse
  mkdir -p "$XDG_RUNTIME_DIR/pulse" 2>/dev/null || true
  if pulseaudio --daemonize=yes --exit-idle-time=-1 --disallow-exit -n \
      --load="module-native-protocol-unix" \
      --load="module-null-sink sink_name=dockyard-mix sink_properties=device.description=DockyardRemoteAudio" \
      --log-target=stderr --log-level=error >>/tmp/pulse.log 2>&1; then
    # 等待 native socket 就绪（最多 4s）
    i=0
    while [ "$i" -lt 40 ]; do
      [ -S "$XDG_RUNTIME_DIR/pulse/native" ] && break
      sleep 0.1
      i=$((i + 1))
    done
    if [ -S "$XDG_RUNTIME_DIR/pulse/native" ]; then
      AUDIO_READY=1
      log "pulseaudio 虚拟声卡就绪（dockyard-mix / 远程声音回传链路可用）"
    else
      log "WARN: pulseaudio 启动但 native socket 未就绪 → 声音回传降级不可用"
    fi
  else
    log "WARN: pulseaudio 启动失败 → 声音回传降级不可用（不影响其余功能）"
  fi
else
  log "提示：镜像未安装 pulseaudio 或 DY_AUDIO_ENABLED=0 → 声音回传不可用（503 优雅降级）"
fi

# ---- 3. USR1 → 浏览器进程级重启（平台运维通道） ----
CHROME_PID=""
REC_PID=""
restart_chrome() {
  if [ -n "$CHROME_PID" ]; then
    log "收到 USR1：重启浏览器进程（同一 Profile）"
    kill "$CHROME_PID" 2>/dev/null || true
  fi
}
trap restart_chrome USR1

stop_recording() {
  if [ -n "${REC_PID:-}" ] && [ -n "${REC_DIR:-}" ]; then
    log "录像收尾：ffmpeg 优雅落盘"
    kill -TERM "$REC_PID" 2>/dev/null || true
    i=0; while [ "$i" -lt 20 ] && kill -0 "$REC_PID" 2>/dev/null; do sleep 0.1; i=$((i + 1)); done
    kill -KILL "$REC_PID" 2>/dev/null || true
    REC_PID=""
  fi
}
trap 'stop_recording; [ -n "$CHROME_PID" ] && kill "$CHROME_PID" 2>/dev/null' TERM INT

# r27-e：防退出档位 → chromium 参数（容器无 WM：标题栏关闭/最小化按钮本就不存在）
#   fullscreen —— 全屏守卫：--start-fullscreen + 错误弹窗抑制 + Ctrl+Q 长按确认
#   kiosk     —— 信息亭最强档：--kiosk（无地址栏/无菜单 →「更多菜单→退出」入口物理不存在）
GUARD_ARGS=""
FEATURE_ARGS="--disable-features=ExitWarningBubble"
case "${EXIT_GUARD:-normal}" in
  kiosk)
    GUARD_ARGS="--kiosk --noerrdialogs --disable-infobars"
    FEATURE_ARGS="--enable-features=ExitWarningBubble"
    ;;
  fullscreen)
    GUARD_ARGS="--start-fullscreen --noerrdialogs"
    FEATURE_ARGS="--enable-features=ExitWarningBubble"
    ;;
esac
[ -n "$GUARD_ARGS" ] && log "防退出档位：${EXIT_GUARD}（${GUARD_ARGS}）"

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

# ---- 3.5 r27：VNC 会话录像（策略命中 → 容器内 ffmpeg 分段落盘）----
start_recording() {
  [ -z "${REC_DIR:-}" ] && return 0
  command -v ffmpeg >/dev/null 2>&1 || { log "WARN: ffmpeg 缺失 → 录像不可用"; return 0; }
  mkdir -p "$REC_DIR" 2>/dev/null || { log "WARN: 录像目录不可创建"; return 0; }
  REC_START=$(ls "$REC_DIR"/seg-*.mp4 2>/dev/null | wc -l)
  REC_ARGS="-nostats -loglevel error -f x11grab -draw_mouse 1 -framerate ${REC_FPS:-12} -video_size ${REC_SIZE:-1280x800} -i :99"
  REC_ARGS="$REC_ARGS -c:v libx264 -preset veryfast -crf 30 -pix_fmt yuv420p -g $(( ${REC_FPS:-12} * 3 )) -movflags +frag_keyframe+empty_moov"
  if [ "${REC_MAXSEC:-0}" -gt 0 ] 2>/dev/null; then REC_ARGS="$REC_ARGS -t ${REC_MAXSEC}"; fi
  REC_ARGS="$REC_ARGS -f segment -segment_time ${REC_SEGSEC:-900} -segment_start_number $REC_START -reset_timestamps 1"
  ffmpeg $REC_ARGS "$REC_DIR/seg-%03d.mp4" >/dev/null 2>&1 &
  REC_PID=$!
  log "VNC 录像已启动（fps=${REC_FPS:-12} 分段=${REC_SEGSEC:-900}s → $REC_DIR）"
}
start_recording

# ---- 4. 防退出主循环 ----
# 浏览器退出（任何原因）→ wait 返回 → 1 秒后以同一 user-data-dir 拉起
# 用户“闪退后立即打开”得到的永远是同一个配置的浏览器环境
# r28：Chromium 原生沙箱优先（渲染进程零 syscall：病毒网页无法读写任何本地文件）
# 3 秒 headless 探测（无 --no-sandbox）；失败 → 单次回退（OS 用户级隔离仍然生效）
# r36：【--no-sandbox 警告条根因修复】容器 CapDrop=ALL + no-new-privileges +
#   Docker 默认 seccomp（封 clone CLONE_NEWUSER/unshare）→ Chromium 原生沙箱
#   SUID/userns 两条通道均不可用 → 必须回退 --no-sandbox → Chromium 显示
#   "You are using an unsupported command-line flag: --no-sandbox" infobar。
#   处置（三层，与业界容器化 Chromium 部署一致 ChromeDriver/Puppeteer 同源手法）：
#   1. 回退时同步附加 --test-type：bad_flag_prompt.cc 对 --test-type 短路，
#      警告条不再出现（容器级隔离依然完整：非 root+CapDrop+只读根+noexec 卷）
#   2. 管理员可部署自定义 seccomp profile（deploy/seccomp/dockyard-chromium.json）
#      并在后台 docker.browserSecurityOpt 填入 → 容器启用原生沙箱 → 探测直
#      接通过，永不回退（安全性最高的部署形态）
#   3. 沙箱回退仅“单次”决策（probe 每容器启动重评，环境升级后自动恢复原生沙箱）
SANDBOX_ARGS=""
TEST_TYPE_ARGS=""
probe_chrome_sandbox() {
  chromium --headless=new --user-data-dir=/tmp/chrome-sbx-probe --dump-dom about:blank >/dev/null 2>&1
  local rc=$?
  rm -rf /tmp/chrome-sbx-probe
  [ "$rc" -eq 0 ] && return 0 || return 1
}
if probe_chrome_sandbox; then
  log "Chromium 原生沙箱探测通过（渲染进程零 syscall）"
else
  SANDBOX_ARGS="--no-sandbox"
  # --test-type：抑制 Chromium 坏标志警告条（bad-flags infobar；ChromeDriver 同款）
  # DY_CHROME_TEST_TYPE=0 可显式关闭（保留警告条用于调试环境）
  if [ "${DY_CHROME_TEST_TYPE:-1}" = "1" ]; then
    TEST_TYPE_ARGS="--test-type"
  fi
  log "WARN: Chromium 沙箱不可用（容器 namespace/seccomp 受限）→ 回退 --no-sandbox + --test-type（OS 用户级隔离 + 容器级隔离兜底；管理员可部署 seccomp profile 启用原生沙箱）"
fi
RESTARTS=0
while :; do
  # r36：声音回传（pulse 环境注入：Chromium 输出定向 dockyard-mix 虚拟声卡）
  if [ "$AUDIO_READY" = "1" ]; then
    export PULSE_SERVER="$XDG_RUNTIME_DIR/pulse/native"
  fi
  chromium \
    --user-data-dir=/home/browser/profile \
    $SANDBOX_ARGS \
    $TEST_TYPE_ARGS \
    --disable-gpu \
    --no-first-run \
    --disable-session-crashed-bubble \
    --hide-crash-restore-bubble \
    --restore-last-session \
    --start-maximized \
    $GUARD_ARGS \
    --remote-debugging-address=0.0.0.0 \
    --remote-debugging-port=9222 \
    --download.default_directory=/home/browser/downloads \
    $FEATURE_ARGS \
    $PROXY_ARGS \
    "${START_URL:-about:blank}" &
  CHROME_PID=$!
  wait "$CHROME_PID" 2>/dev/null || true
  CHROME_PID=""
  # r27：录像进程保活（ffmpeg 意外退出 → 分段续录，不丢已落盘部分）
  if [ -n "${REC_DIR:-}" ] && ! kill -0 "${REC_PID:-0}" 2>/dev/null; then
    start_recording
  fi
  RESTARTS=$((RESTARTS + 1))
  log "浏览器进程退出（第 ${RESTARTS} 次），1 秒后以同一 Profile 自动拉起"
  sleep 1
done
