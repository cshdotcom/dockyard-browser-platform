# ============================================================
# Dockyard 浏览器工作平台 — 单容器全内置完整包（r13）
# 一个容器 = 整个平台，零外部服务：
#   · Next.js 主服务(standalone) + WS枢纽(3003/3004) + VNC网关桥(3005)
#   · 每工作区嵌入式沙箱进程树：Xvfb + Chromium + x11vnc（同容器内编排）
#   · sing-box 代理进程（同容器进程模式，不再需要外部容器/镜像）
#   · Prisma（SQLite 默认；可选 PostgreSQL：DATABASE_PROVIDER=postgres + DATABASE_URL）+ 全部依赖
# 部署：支持 host 网络模式 / 桥接模式；零 Docker-in-Docker、零外部镜像依赖
# ============================================================

# ---- 依赖安装层 ----
FROM oven/bun:1.3 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# ---- 构建层 ----
FROM oven/bun:1.3 AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# 数据库 schema 生成 Prisma Client（构建时需要）
# [22-d] 双客户端：默认 SQLite（@prisma/client）+ 可选 PostgreSQL（独立产物
#   node_modules/@prisma/client-postgres —— prisma/schema.postgres.prisma 由主 schema 派生）
RUN bunx prisma generate
RUN bunx prisma generate --schema prisma/schema.postgres.prisma
# Next.js standalone 构建（产物自带 server.js + 精简 node_modules）
ENV DATABASE_URL="file:/app/db/build-placeholder.db"
RUN bunx next build

# ---- 运行层（单容器全内置：平台 + 浏览器 + VNC + sing-box）----
FROM oven/bun:1.3 AS runner
WORKDIR /app
ARG TARGETARCH
ARG SINGBOX_VERSION=1.10.7

# 全内置运行时组件：
#   chromium/xvfb/x11vnc  —— 嵌入式沙箱进程树（每工作区独立显示/VNC/CDP）
#   util-linux(setpriv/prlimit/unshare) —— 沙箱用户降权 + 进程数硬上限 + 用户/挂载命名空间
#   fonts-noto-cjk        —— 中文/日文/韩文渲染
#   openssl               —— Prisma 查询引擎链接库 + 密钥生成
#   iproute2(ss)          —— 端口占用自检；wget —— 健康检查/内置调度器
#   fcitx5 输入法全家桶（r24-c 每沙箱独立实例，常用语言全覆盖）：
#     fcitx5 + chinese-addons（拼音/双拼/五笔/注音/仓颉）
#     fcitx5-table / table-other（各语言码表）
#     fcitx5-frontend-gtk3/gtk4 + qt5（应用侧 IM 模块）
#     fcitx5-hangul（韩文）、fcitx5-mozc（日文，尽力）、fcitx5-unikey（越南文，尽力）
#     x11-xkb-utils（setxkbmap 键盘布局）+ locales（多语言 locale）
RUN apt-get update -o Acquire::Retries=5 \
    && apt-get install -y --no-install-recommends \
      chromium \
      xvfb \
      x11vnc \
      # r27：VNC 会话录像引擎（嵌入式沙箱进程树内 ffmpeg x11grab 分段 + ffprobe 时长探测）
      ffmpeg \
      xauth \
      procps \
      psmisc \
      util-linux \
      fonts-noto-cjk \
      fonts-liberation \
      # r25-c 多语言字体全覆盖（浏览器内容零乱码）：
      #   fonts-noto-core —— 拉丁/希腊/西里尔/阿拉伯/希伯来/天城文/孟加拉/泰米尔/
      #                     泰/高棉/老挝/缅甸/格鲁吉亚/亚美尼亚/提格雷纳等 100+ 文字体系
      #   fonts-noto-mono / extra —— 等宽字形与补充字重
      #   fonts-noto-color-emoji —— 彩色 emoji（网页 ubiquitous）
      #   fonts-unifont —— 终极兜底（任意码位均有字形，绝不出现豆腐块□）
      fonts-noto-core \
      fonts-noto-mono \
      fonts-noto-extra \
      fonts-noto-color-emoji \
      fonts-unifont \
      fontconfig \
      openssl \
      ca-certificates \
      wget \
      iproute2 \
      fcitx5 \
      fcitx5-chinese-addons \
      fcitx5-table \
      fcitx5-table-other \
      fcitx5-frontend-gtk3 \
      fcitx5-frontend-gtk4 \
      fcitx5-frontend-qt5 \
      fcitx5-config-qt \
      x11-xkb-utils \
      locales \
      dbus-x11 \
    && (apt-get install -y --no-install-recommends fcitx5-mozc \
        || echo "[warn] fcitx5-mozc 不可用，跳过（日文输入以 fcitx5-table 日文码表兜底）") \
    && (apt-get install -y --no-install-recommends fcitx5-hangul fcitx5-unikey fcitx5-thai fcitx5-arabic \
        || echo "[warn] 部分语言输入法包不可用，跳过（以键盘布局兜底）") \
    && (apt-get install -y --no-install-recommends fonts-thai-tlwg fonts-lao fonts-khmeros fonts-sil-padauk fonts-sil-abyssinica \
        || echo "[warn] 部分区域字体包不可用，跳过（Noto core 已含对应文字体系）") \
    # r25-c 常用语言 locale 扩充（输入法候选窗/应用本地化/网页内容 lang 检测）：
    #   中简繁/日韩 + 欧洲主要语言 + 俄/乌/希腊/土耳其 + 阿拉伯/希伯来/波斯 + 印地/泰/越/印尼 + 商
    && for loc in en_US.UTF-8 en_GB.UTF-8 zh_CN.UTF-8 zh_TW.UTF-8 zh_HK.UTF-8 ja_JP.UTF-8 ko_KR.UTF-8 \
        de_DE.UTF-8 fr_FR.UTF-8 es_ES.UTF-8 es_MX.UTF-8 pt_BR.UTF-8 pt_PT.UTF-8 it_IT.UTF-8 \
        nl_NL.UTF-8 sv_SE.UTF-8 da_DK.UTF-8 fi_FI.UTF-8 nb_NO.UTF-8 pl_PL.UTF-8 cs_CZ.UTF-8 \
        hu_HU.UTF-8 ro_RO.UTF-8 el_GR.UTF-8 ru_RU.UTF-8 uk_UA.UTF-8 tr_TR.UTF-8 \
        ar_SA.UTF-8 he_IL.UTF-8 fa_IR.UTF-8 hi_IN.UTF-8 th_TH.UTF-8 vi_VN.UTF-8 id_ID.UTF-8; do \
        sed -i "/^# $loc /s/^# //" /etc/locale.gen 2>/dev/null || true; \
        grep -q "^$loc " /etc/locale.gen 2>/dev/null || echo "$loc UTF-8" >> /etc/locale.gen; \
      done \
    && (locale-gen || echo "[warn] locale-gen 部分失败（不影响核心功能）") \
    # r25-c fontconfig 全语言回退链（Chromium 等 X 应用经 fontconfig 逐文字体系选字体：
    # 拉丁→CJK→阿拉伯/希伯来/泰/天城→emoji→unifont，任意文字均有字形，零乱码）
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
      '  <alias binding="strong"><family>system-ui</family><prefer>' \
      '    <family>Liberation Sans</family>' \
      '    <family>Noto Sans</family>' \
      '    <family>Noto Sans CJK SC</family>' \
      '    <family>Noto Color Emoji</family>' \
      '  </prefer></alias>' \
      '</fontconfig>' > /etc/fonts/local.conf \
    && fc-cache -f >/dev/null 2>&1 || true \
    && rm -rf /var/lib/apt/lists/* \
    # X socket 目录（Xvfb 挂载 unix socket 用）
    && mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix \
    # Chromium 托管策略挂载点：每沙箱经 unshare 私有挂载命名空间 bind 各自策略文件至此路径
    && mkdir -p /etc/chromium/policies/managed \
    && echo "{}" > /etc/chromium/policies/managed/dockyard.json

# sing-box 二进制（容器内进程模式；按目标架构下载，失败不阻断镜像构建——代理为可选功能）
RUN set -e; \
    SBARCH="$( [ "$TARGETARCH" = "arm64" ] && echo arm64 || echo amd64 )"; \
    wget -q -T 30 -O /tmp/sing-box.tar.gz \
      "https://github.com/SagerNet/sing-box/releases/download/v${SINGBOX_VERSION}/sing-box-${SINGBOX_VERSION}-linux-${SBARCH}.tar.gz" \
      && tar -xzf /tmp/sing-box.tar.gz -C /tmp \
      && mv "/tmp/sing-box-${SINGBOX_VERSION}-linux-${SBARCH}/sing-box" /usr/local/bin/sing-box \
      && chmod +x /usr/local/bin/sing-box \
      && rm -rf /tmp/sing-box* \
    || echo "[warn] sing-box 下载失败（代理功能将保持模拟模式，不影响其余功能）"

# ---- 跨域名部署（r13c 文档化；按需 docker run -e 覆盖）----
# PUBLIC_BASE_URL   ：平台对外域名（如 https://browser.example.com）→ 工作区详情「连接信息」展示公网 CDP 网关端点
#                     （Puppeteer/Playwright/外部脚本接入用）；同时作为邮件链接/分享链接的基准地址
# VNC_BRIDGE_URL    ：VNC 桥独立域名（如 wss://vnc.example.com）→ 前端取票后直连该地址（反代需透传 WS 升级头）；
#                     未配置时 VNC 经统一网关嵌入当前访问域名（默认，零配置）
# VNC_BRIDGE_PUBLIC : gateway（默认，回环仅网关）| port（独立端口对外，需 -p 映射）| url（跨域名直连，配合 VNC_BRIDGE_URL）
# 更多部署形态见 README「跨域名部署」章节
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    CDP_SERVICE_PORT=9222 \
    WS_HUB_PORT=3003 \
    WS_EVENT_PORT=3004 \
    VNC_BRIDGE_PORT=3005 \
    BROWSER_RUNTIME=auto \
    DATABASE_PROVIDER=sqlite \
    DATABASE_URL="file:/app/db/custom.db" \
    STORAGE_LOCAL_PATH=/app/storage \
    HOSTNAME=0.0.0.0

# 运行层完整依赖（All-In-One：无外部依赖、免编译环境）
COPY --from=deps /app/node_modules ./node_modules
# Next.js standalone 产物
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
# 源码资产：prisma schema / 种子 / 定时脚本 / WS枢纽 / VNC桥 / 前端引用资源
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/mini-services ./mini-services
COPY --from=builder /app/src/lib/config.ts ./src/lib/config.ts
# [22-d] PostgreSQL 支持：
#   · 双 Prisma Client（sqlite 默认 + postgres 可选）查询引擎显式落镜像（NFT 动态加载路径无法静态追踪）
#   · db/postgres（init.sql / audit_triggers.sql / apply-triggers.ts）→ /app/prisma/postgres
#     （不放在 /app/db —— 该路径是数据卷挂载点，旧卷挂载会遮蔽镜像内文件）
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma/client-postgres ./node_modules/@prisma/client-postgres
COPY --from=builder /app/db/postgres ./prisma/postgres

# 启动/停止/守护/自检 + 嵌入式沙箱监督脚本
COPY docker/start.sh docker/stop.sh docker/healthcheck.sh docker/entrypoint-guard.sh /app/docker/
COPY docker/embedded/sandbox-launch.sh /app/docker/embedded/sandbox-launch.sh
RUN chmod +x /app/docker/*.sh /app/docker/embedded/*.sh \
    && mkdir -p /app/db /app/storage/backups /app/storage/uploads /app/storage/snapshots \
      /app/storage/sandboxes /app/storage/homes /app/storage/netpolicy \
      /app/storage/profiles /app/storage/system \
    && echo "dockyard" > /app/.app-marker

# 数据卷：数据库 / 文件存储（含 Profile/沙箱状态/策略文件）
VOLUME ["/app/db", "/app/storage"]

# 对外仅 2 端口：网页端（GATEWAY_PORT，默认 3000）+ CDP 网关（CDP_SERVICE_PORT，默认 9222）
# Next/WS枢纽/VNC桥 全部回环（127.0.0.1）监听，统一经入口网关嵌入；host 网络模式不额外暴露
EXPOSE 3000 9222
# VNC 直连可选形态（VNC_BRIDGE_PUBLIC=port 时启动参数会绑定 0.0.0.0，需要时手动 -p 映射）
# EXPOSE 3005

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD /app/docker/healthcheck.sh

# 守护式入口：主进程崩溃自动整轮重启（崩溃原因输出 docker logs）；docker stop 优雅终止
ENTRYPOINT ["/app/docker/entrypoint-guard.sh"]
