# ============================================================
# Dockyard Hardened Browser —— 硬隔离浏览器运行时镜像
# 由平台经 Docker API 直接编排（docker/browser/Dockerfile）
#
# 隔离保证（与平台 buildBrowserHostConfig 配合）：
#   1. 容器以非 root 用户 browser 运行
#   2. 根文件系统只读（ReadOnlyRootfs），仅 /tmp 等白名单 tmpfs 可写
#   3. 唯一持久卷：/home/browser/profile（该用户专属，noexec）
#      → 其他用户的资料/文件不在本容器 mount namespace 中，任何形式均不可读
#   4. 下载目录 /home/browser/downloads 为 noexec tmpfs
#      → 下载任何可执行软件，运行即报权限错误（Permission denied）
#   5. supervisor 死循环拉起浏览器：用户无法以任何形式退出
#      （关闭窗口/闪退/Ctrl+Q/OOM → 1 秒内同一 Profile 自动恢复）
#   6. 容器 RestartPolicy=always + 平台看门狗双重自愈
# ============================================================

FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    xvfb \
    x11vnc \
    xauth \
    x11-utils \
    procps \
    psmisc \
    fonts-noto-cjk \
    fonts-noto-color \
    fonts-liberation \
  && rm -rf /var/lib/apt/lists/*

# 非 root 运行用户（与平台 BROWSER_USER 常量一致）
RUN useradd -m -u 1000 -s /bin/sh browser \
  && mkdir -p /home/browser/profile /home/browser/downloads \
  && chown -R browser:browser /home/browser

# Chromium 托管策略目录：平台按用户/组网络策略生成 JSON，只读 bind-mount 到此目录
#（只读根 FS + 非 root + CapDrop=ALL → 沙箱内无法篡改，URLBlocklist 在 URL 分类阶段直接拦截）
RUN mkdir -p /etc/chromium/policies/managed && chmod 0755 /etc/chromium/policies/managed

COPY supervisor.sh /usr/local/bin/supervisor.sh
RUN chmod 0755 /usr/local/bin/supervisor.sh

ENV HOME=/home/browser \
    RESOLUTION=1280x800 \
    START_URL=about:blank \
    TZ=Asia/Shanghai

# VNC(RFB) 5900 / CDP 9222 —— 仅暴露给 dockyard-sessions 隔离网络内的平台与 VNC 桥
EXPOSE 5900 9222

USER browser

ENTRYPOINT ["/usr/local/bin/supervisor.sh"]
