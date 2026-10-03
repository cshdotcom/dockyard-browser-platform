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

# 核心依赖（硬性）+ 可选 emoji 字体（软失败：部分镜像源缺失不影响核心功能）
RUN apt-get update -o Acquire::Retries=5 \
    && apt-get install -y --no-install-recommends \
    chromium \
    xvfb \
    x11vnc \
    xauth \
    x11-utils \
    procps \
    psmisc \
    fonts-noto-cjk \
    fonts-liberation \
    # r25-c 多语言字体全覆盖（与平台主镜像同标准：零乱码）
    fonts-noto-core \
    fonts-noto-mono \
    fonts-noto-color-emoji \
    fonts-unifont \
    fontconfig \
  && (apt-get install -y --no-install-recommends fonts-noto-extra fonts-thai-tlwg fonts-lao fonts-khmeros fonts-sil-padauk \
      || echo "[warn] 部分区域字体包不可用，跳过（fonts-noto-core 已含对应文字体系）") \
  # fontconfig 全语言回退链（拉丁→CJK→emoji→unifont 兜底，任意文字均有字形）
  && printf '%s\n' \
    '<?xml version="1.0"?>' \
    '<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">' \
    '<fontconfig>' \
    '  <alias binding="strong"><family>sans-serif</family><prefer>' \
    '    <family>Liberation Sans</family>' \
    '    <family>Noto Sans</family>' \
    '    <family>Noto Sans CJK SC</family>' \
    '    <family>Noto Sans Arabic</family>' \
    '    <family>Noto Sans Hebrew</family>' \
    '    <family>Noto Sans Thai</family>' \
    '    <family>Noto Sans Devanagari</family>' \
    '    <family>Noto Color Emoji</family>' \
    '    <family>Unifont</family>' \
    '  </prefer></alias>' \
    '  <alias binding="strong"><family>serif</family><prefer>' \
    '    <family>Liberation Serif</family>' \
    '    <family>Noto Serif CJK SC</family>' \
    '    <family>Noto Color Emoji</family>' \
    '    <family>Unifont</family>' \
    '  </prefer></alias>' \
    '  <alias binding="strong"><family>monospace</family><prefer>' \
    '    <family>Liberation Mono</family>' \
    '    <family>Noto Sans Mono CJK SC</family>' \
    '    <family>Noto Color Emoji</family>' \
    '    <family>Unifont</family>' \
    '  </prefer></alias>' \
    '</fontconfig>' > /etc/fonts/local.conf \
  && fc-cache -f >/dev/null 2>&1 || true \
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
