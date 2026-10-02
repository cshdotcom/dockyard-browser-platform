#!/bin/sh
# ============================================================
# Dockyard 嵌入式沙箱监督脚本（单容器全内置形态）— 每工作区一棵进程树
# 由平台 embedded-sandbox.ts 以 detached 子进程拉起（非 PID 1）：
#   · Xvfb :<display> 常驻 + x11vnc（仅 127.0.0.1:<rfbPort>）
#   · Chromium 防退出死循环：任何形式退出（关窗口/闪退/OOM/被杀）
#     1 秒内以【同一 Profile】自动拉起 —— 与容器模式 supervisor 语义一致
#   · USR1 → 浏览器进程级重启（策略文件重写后即时生效通道）
#   · TERM → 级联终止全树（chromium/x11vnc/Xvfb）优雅退出
#   · 状态心跳 state.json：平台重启后据此重新收养（re-adopt）
# Chromium 以独立 Linux 用户（DY_USER，root 环境时）+ unshare -Urm
# 用户/挂载命名空间运行：每沙箱策略文件私有 bind 到
# /etc/chromium/policies/managed/dockyard.json（视图仅本树可见，零特权）。
# ============================================================
set -u

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')][${DY_SANDBOX_ID}] $*" >>"${DY_LOG_DIR}/supervisor.log"; }

SANDBOX_DIR="${DY_SANDBOX_DIR:?missing DY_SANDBOX_DIR}"
LOG_DIR="${DY_LOG_DIR:?missing DY_LOG_DIR}"
DISPLAY_NUM="${DY_DISPLAY:?missing DY_DISPLAY}"
RFB_PORT="${DY_RFB_PORT:?missing DY_RFB_PORT}"
CDP_PORT="${DY_CDP_PORT:?missing DY_CDP_PORT}"
XVFB_BIN="${DY_XVFB_BIN:-Xvfb}"
X11VNC_BIN="${DY_X11VNC_BIN:-x11vnc}"
INNER="${DY_INNER:?missing DY_INNER}"
export HOME="${DY_USER_HOME:-$SANDBOX_DIR}"
export DISPLAY=":$DISPLAY_NUM"

AM_ROOT=0
[ "$(id -u)" = "0" ] && AM_ROOT=1

# 以沙箱 Linux 用户执行（root 环境）；非 root 开发环境以当前用户运行（隔离降级）
# 注：后台进程必须直接命令调用（setpriv/unshare/prlimit 全链 exec → $! 即真实命令 PID）；
# 经函数包装后台化会多一层子壳 → TERM 只杀包装壳 → 实际进程孤儿化（已实证修复）
as_user() {
  if [ "$AM_ROOT" = "1" ] && [ -n "${DY_USER:-}" ]; then
    setpriv --reuid="$DY_USER" --regid="$DY_USER" --init-groups -- "$@"
  else
    "$@"
  fi
}
# 后台启动（返回真实命令 PID）：root+独立用户 → setpriv 直接降权 exec；否则直接运行
bg_user() {
  if [ "$AM_ROOT" = "1" ] && [ -n "${DY_USER:-}" ]; then
    setpriv --reuid="$DY_USER" --regid="$DY_USER" --init-groups -- "$@" &
  else
    "$@" &
  fi
}

write_state() {
  # 状态心跳（平台 re-adopt 与看门狗的权威数据源）
  cat >"$SANDBOX_DIR/state.json" <<EOF
{
  "id": "${DY_SANDBOX_ID}",
  "userId": "${DY_USER_ID:-}",
  "profileKey": "${DY_PROFILE_KEY:-}",
  "workspaceId": "${DY_WORKSPACE_ID:-}",
  "linuxUser": "${DY_USER:-}",
  "display": ${DISPLAY_NUM},
  "rfbPort": ${RFB_PORT},
  "cdpPort": ${CDP_PORT},
  "supervisorPid": $$,
  "chromePid": ${CHROME_PID:-0},
  "xvfbPid": ${XVFB_PID:-0},
  "vncPid": ${VNC_PID:-0},
  "policyFile": "${DY_POLICY_FILE:-}",
  "profileDir": "${DY_PROFILE_DIR:-}",
  "downloadsDir": "${DY_DOWNLOADS_DIR:-}",
  "startedAt": ${STARTED_AT:-$(date +%s000)},
  "restarts": ${RESTARTS:-0},
  "status": "${1:-running}",
  "ts": $(date +%s000)
}
EOF
}

STARTED_AT=$(date +%s000)
RESTARTS=0
XVFB_PID=""
VNC_PID=""
CHROME_PID=""
CLEANED=0

cleanup() {
  [ "$CLEANED" = "1" ] && return
  CLEANED=1
  log "收到终止信号：级联停止沙箱进程树"
  [ -n "$IME_PID" ] && kill "$IME_PID" 2>/dev/null
  # fcitx5 守护双保险：按沙箱专用用户扫杀（root+独立用户形态；共享用户形态不扫，避免误伤其他沙箱）
  [ "$AM_ROOT" = "1" ] && [ -n "${DY_USER:-}" ] && pkill -TERM -u "$DY_USER" -x fcitx5 2>/dev/null
  [ -n "$CHROME_PID" ] && kill "$CHROME_PID" 2>/dev/null
  [ -n "$VNC_PID" ] && kill "$VNC_PID" 2>/dev/null
  [ -n "$XVFB_PID" ] && kill "$XVFB_PID" 2>/dev/null
  sleep 1
  # 双保险：按沙箱专属特征（display/RFB 端口/CDP 端口全局唯一）扫杀残留，
  # 杜绝 PID 追踪链任何环节断裂导致的进程泄漏
  pkill -TERM -f "Xvfb :$DISPLAY_NUM" 2>/dev/null
  pkill -TERM -f "rfbport $RFB_PORT" 2>/dev/null
  pkill -TERM -f "remote-debugging-port=$CDP_PORT" 2>/dev/null
  sleep 1
  pkill -KILL -f "Xvfb :$DISPLAY_NUM" 2>/dev/null
  pkill -KILL -f "rfbport $RFB_PORT" 2>/dev/null
  pkill -KILL -f "remote-debugging-port=$CDP_PORT" 2>/dev/null
  [ -n "$CHROME_PID" ] && kill -9 "$CHROME_PID" 2>/dev/null
  [ -n "$VNC_PID" ] && kill -9 "$VNC_PID" 2>/dev/null
  [ -n "$XVFB_PID" ] && kill -9 "$XVFB_PID" 2>/dev/null
  # 清理 X lock/socket（避免 display 占用残留）
  rm -f "/tmp/.X${DISPLAY_NUM}-lock" "/tmp/.X11-unix/X${DISPLAY_NUM}" 2>/dev/null
  write_state stopped
  log "沙箱已停止"
  exit 0
}
trap cleanup TERM INT
trap '[ -n "$CHROME_PID" ] && kill "$CHROME_PID" 2>/dev/null; log "USR1：浏览器进程级重启（同一 Profile）"' USR1

# ---- 0. r24-c 输入法（IME）：每沙箱独立 fcitx5 实例 ----
# 仅本沙箱 X 显示作用域：与其他沙箱/其他在线会话完全隔离；
# 以沙箱专用用户运行（root 环境），监督树成员之一（崩溃自愈）；
# 偏好输入法（DY_IME_ENGINE）通过预写 fcitx5 profile 落地；布局由 setxkbmap 应用。
IME_PID=""
export XMODIFIERS="@im=fcitx"
IME_ENABLED=0
start_ime() {
  command -v fcitx5 >/dev/null 2>&1 || return 0
  if [ "$AM_ROOT" = "1" ] && [ -z "${DY_USER:-}" ]; then return 0; fi # 共享用户形态不启 fcitx5（避免跨沙箱串扰）
  IME_ENABLED=1
  bg_user fcitx5 --replace >/dev/null 2>&1
  IME_PID=$!
  log "fcitx5 输入法守护已拉起（display :$DISPLAY_NUM，作用域=本沙箱）"
}
apply_ime_prefs() {
  # 键盘布局偏好（setxkbmap 作用于本显示）
  if [ -n "${DY_KB_LAYOUT:-}" ] && command -v setxkbmap >/dev/null 2>&1; then
    if as_user setxkbmap -display ":$DISPLAY_NUM" "$DY_KB_LAYOUT" 2>>"$LOG_DIR/ime.log"; then
      log "键盘布局已应用：$DY_KB_LAYOUT"
    else
      log "WARN: 键盘布局 $DY_KB_LAYOUT 应用失败（回退默认）"
    fi
  fi
  # 输入法引擎切换（fcitx5 就绪后 remote 切换；最多重试 5 次×0.4s）
  if [ -n "${DY_IME_ENGINE:-}" ] && command -v fcitx5-remote >/dev/null 2>&1; then
    i=0
    while [ "$i" -lt 5 ]; do
      if as_user env DISPLAY=":$DISPLAY_NUM" XMODIFIERS="@im=fcitx" fcitx5-remote -s "$DY_IME_ENGINE" >/dev/null 2>&1; then
        log "输入法已切换：$DY_IME_ENGINE"
        return 0
      fi
      sleep 0.4
      i=$((i + 1))
    done
    log "WARN: 输入法 $DY_IME_ENGINE 切换未确认（可稍后在 VNC 工具栏手动切换）"
  fi
}

# root 环境：Profile/下载/家目录/日志目录归属沙箱 Linux 用户（700 隔离，互不可读）
# 【修复】logs 目录原先归 root（平台 mkdir），而 x11vnc/chromium 内层脚本以
# setpriv 降权后的 DY_USER 运行 → x11vnc -o 打开 $LOG_DIR/x11vnc.log 报
# Permission denied → x11vnc 立即退出 → 平台报「x11vnc 未就绪」启动失败。
# Ubuntu 多用户方案：目录所有权交给沙箱专用用户；root 侧 supervisor.log/
# state.json/chromium.log 由 root 写入（root 无视 DAC，不受 700 影响）。
if [ "$AM_ROOT" = "1" ] && [ -n "${DY_USER:-}" ]; then
  chown -R "$DY_USER" "${DY_PROFILE_DIR:-/nonexistent}" "${DY_DOWNLOADS_DIR:-/nonexistent}" "$HOME" "$LOG_DIR" 2>/dev/null
  chmod 700 "${DY_PROFILE_DIR:-/nonexistent}" "$HOME" "$LOG_DIR" 2>/dev/null
fi

start_xvfb() {
  bg_user "$XVFB_BIN" ":$DISPLAY_NUM" -screen 0 "${DY_RESOLUTION:-1280x800x24}" -nolisten tcp
  XVFB_PID=$!
  # 等待 X 就绪（lock + unix socket；最多 5s）
  i=0
  while [ "$i" -lt 50 ]; do
    if [ -e "/tmp/.X${DISPLAY_NUM}-lock" ] && [ -e "/tmp/.X11-unix/X${DISPLAY_NUM}" ]; then
      return 0
    fi
    kill -0 "$XVFB_PID" 2>/dev/null || break
    sleep 0.1
    i=$((i + 1))
  done
  if kill -0 "$XVFB_PID" 2>/dev/null; then
    log "WARN: X 就绪探测超时（继续运行）"
    return 0
  fi
  log "ERROR: Xvfb 启动失败（display :$DISPLAY_NUM）"
  return 1
}

# ---- 1. 虚拟显示 ----
if ! start_xvfb; then
  write_state stopped
  exit 1
fi
log "Xvfb 就绪 :$DISPLAY_NUM（${DY_RESOLUTION:-1280x800x24}）"

# ---- 2. VNC（仅回环；平台 VNC 桥票据中转，容器外不可触达） ----
# r24-d 剪贴板隔离策略：DY_CLIPBOARD=0 → -nosel -noclipboard（X 剪贴板/选区
# 不向 VNC 端透传；跨沙箱天然隔离之外，再做会话级策略关闭）
VNC_CLIP_FLAGS=""
[ "${DY_CLIPBOARD:-1}" = "0" ] && VNC_CLIP_FLAGS="-nosel -noclipboard"
start_vnc() {
  # 日志预创建：即使目录 chown 失败，root 预创建 + 授权后降权进程也可写
  # （-o 打开失败会导致 x11vnc 直接退出，必须双重保障）
  if [ ! -e "$LOG_DIR/x11vnc.log" ]; then
    : >"$LOG_DIR/x11vnc.log" 2>/dev/null || true
  fi
  [ "$AM_ROOT" = "1" ] && [ -n "${DY_USER:-}" ] && chown "$DY_USER" "$LOG_DIR/x11vnc.log" 2>/dev/null
  bg_user "$X11VNC_BIN" -display ":$DISPLAY_NUM" -forever -shared \
    -rfbport "$RFB_PORT" -localhost -nopw -noxdamage -repeat -quiet $VNC_CLIP_FLAGS \
    -o "$LOG_DIR/x11vnc.log"
  VNC_PID=$!
}
start_vnc
log "x11vnc 监听 127.0.0.1:$RFB_PORT"

  if [ -n "${DY_POLICY_FILE:-}" ] && [ -f "${DY_POLICY_FILE:-}" ]; then
    log "每沙箱 Chromium 托管策略已注入（unshare 私有挂载命名空间）"
  fi
  if [ -n "${DY_PROXY_URL:-}" ]; then
    log "启用代理：$DY_PROXY_URL"
  fi

  # unshare 用户+挂载命名空间可用性一次性探测（不可用时 inner 走降级路径）
  UNSHARE_OK=1
  if [ "$AM_ROOT" = "1" ] && [ -n "${DY_USER:-}" ]; then
    setpriv --reuid="$DY_USER" --regid="$DY_USER" --init-groups -- unshare -Urm true 2>/dev/null || UNSHARE_OK=0
  else
    unshare -Urm true 2>/dev/null || UNSHARE_OK=0
  fi
  [ "$UNSHARE_OK" = "1" ] && log "unshare 用户/挂载命名空间可用：每沙箱私有策略视图已启用" \
    || log "WARN: unshare 不可用 → Chromium 以共享视图运行（策略降级为全局基线）"

# ---- 3. 防退出主循环 ----
# 浏览器退出（任何原因）→ wait 返回 → 1 秒后同一 user-data-dir 拉起
# Xvfb 意外死亡 → 先重建显示再拉起浏览器（整机自愈语义）
start_ime
# 偏好输入法/布局应用（fcitx5 后台就绪窗口内重试）
apply_ime_prefs &
while :; do
  if ! kill -0 "${XVFB_PID:-0}" 2>/dev/null; then
    log "Xvfb 意外退出，重建虚拟显示"
    if ! start_xvfb; then
      write_state stopped
      exit 1
    fi
  fi
  # x11vnc 意外退出（OOM/异常）→ 同一端口重建 VNC 服务（整机自愈语义）
  if ! kill -0 "${VNC_PID:-0}" 2>/dev/null; then
    log "x11vnc 意外退出，重建 VNC 服务（端口 $RFB_PORT）"
    start_vnc
  fi
  # fcitx5 意外退出 → 重建输入法守护（作用域仍为本显示；不重放偏好，可手动切换）
  if [ "$IME_ENABLED" = "1" ] && ! kill -0 "${IME_PID:-0}" 2>/dev/null; then
    log "fcitx5 意外退出，重建输入法守护"
    start_ime
  fi
  # setpriv/unshare/sh/prlimit 全链 exec —— $! 即 chromium 主进程 PID
  if [ "$UNSHARE_OK" = "1" ]; then
    if [ "$AM_ROOT" = "1" ] && [ -n "${DY_USER:-}" ]; then
      setpriv --reuid="$DY_USER" --regid="$DY_USER" --init-groups -- unshare -Urm sh "$INNER" >>"$LOG_DIR/chromium.log" 2>&1 &
    else
      unshare -Urm sh "$INNER" >>"$LOG_DIR/chromium.log" 2>&1 &
    fi
  else
    if [ "$AM_ROOT" = "1" ] && [ -n "${DY_USER:-}" ]; then
      setpriv --reuid="$DY_USER" --regid="$DY_USER" --init-groups -- sh "$INNER" >>"$LOG_DIR/chromium.log" 2>&1 &
    else
      sh "$INNER" >>"$LOG_DIR/chromium.log" 2>&1 &
    fi
  fi
  CHROME_PID=$!
  write_state running
  wait "$CHROME_PID" 2>/dev/null || true
  # USR1 打断 wait 后 Chromium 可能仍在终止中：等待真正退出（防同 Profile 双实例锁冲突）
  j=0
  while [ "$j" -lt 20 ] && kill -0 "$CHROME_PID" 2>/dev/null; do
    wait "$CHROME_PID" 2>/dev/null || true
    j=$((j + 1))
  done
  CHROME_PID=""
  RESTARTS=$((RESTARTS + 1))
  log "浏览器进程退出（第 ${RESTARTS} 次），1 秒后以同一 Profile 自动拉起"
  write_state running
  sleep 1
done
