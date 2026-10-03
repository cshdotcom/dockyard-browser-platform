# Dockyard 浏览器工作平台 — 部署指南

> 目标：**部署简单不复杂**。默认一个容器跑全部功能；需要扩展时按场景换用对应 compose 文件，全部形态共用同一镜像。

## 一、三步快速开始（单容器 · 默认）

```bash
# 1. 进入 deploy 目录
cd deploy

# 2. 编辑 docker-compose.yml，修改三个密钥 + 初始管理员密码
#    AUTH_SECRET / ENCRYPTION_KEY（32字节）/ CRON_SECRET / ADMIN_PASSWORD

# 3. 启动
docker compose up -d
```

浏览器打开 `http://<主机IP>:3000`，用 `admin` + 你设置的 `ADMIN_PASSWORD` 登录。

- 首次启动自动完成：数据库初始化 + 种子数据 + 目录/端口自检（`docker logs -f dockyard` 可见全过程）
- 数据全部持久化在两个卷：`dockyard-db`（数据库）/ `dockyard-storage`（沙箱 Profile、快照、UID 台账、审计归档）
- 升级不丢数据：`docker compose pull && docker compose up -d`

## 二、部署形态选择

| 形态 | 文件 | 适用 | 外部依赖 |
|---|---|---|---|
| **单容器**（默认） | `docker-compose.yml` | 绝大多数场景：中小团队、个人、POC | 零 |
| **平台 + PostgreSQL** | `docker-compose.postgres.yml` | 高并发、多实例、数据合规外置 | PostgreSQL 容器 |
| **平台 + 外部浏览器节点** | `docker-compose.external-browser.yml` | 浏览器负载独立扩缩容、分机部署 | 浏览器容器 |
| **平台 + Worker 执行节点** | `docker-compose.worker.yml` | Master/Worker 双包分布式（v1.8.0+） | 主控平台 |

所有形态的沙箱能力一致：每工作区独立进程树（Xvfb + Chromium + x11vnc）、每沙箱专属 Linux 用户（UID 台账持久化）、独立输入法（fcitx5）、剪贴板跨沙箱物理隔离、Chromium 企业策略（零内核 Patch）。

## 三、单容器形态要点（默认）

- **零外部依赖**：数据库（SQLite）+ 沙箱浏览器 + VNC 网关 + WS 枢纽 + 调度器全部在同一容器内，不挂载 docker.sock。
- **端口**：仅 `3000`（统一入口网关）。网页、VNC 画面、WebSocket 全部经此端口；CDP 远程接入（Puppeteer 等）时取消 `9222` 端口注释。
- **host 网络模式**：沙箱需要直连宿主机内网/本机代理时，注释 `ports:` 段并启用 `network_mode: host`。
- **多语言**：镜像内置 Noto 全家桶 + Unifont 兜底 + 34 种 locale —— 中/日/韩/俄/阿拉伯/泰/印地等常用语言网页零乱码；VNC 工具栏可切换每沙箱独立输入法。

## 四、Master/Worker 双包分布式（v1.8.0+）

v1.8.0 起发布**两个镜像**（CI 同批构建、同版本号）：

| 镜像 | 定位 |
|---|---|
| `ghcr.io/<repo>:<版本>` | **主管理平台完整包**（All-In-One）：管理后台 + 调度 + 权限/策略 + 嵌入式沙箱 + VNC + 网关，单机即完整平台 |
| `ghcr.io/<repo>-worker:<版本>` | **Worker 分布式执行节点**：纯净执行包 —— 无数据库 / 无管理后台 / 无自主决策，100% 受主控指令驱动（10s 心跳上报 CPU/内存/磁盘/沙箱数 + 文件分片通道 put/status/delete + 沙箱执行运行时） |

**Worker 部署三步**（`deploy/docker-compose.worker.yml`）：

1. 主控管理后台 →「工作节点」→ 注册节点：一次性展示 `WORKER_NODE_UUID` + `WORKER_API_KEY`（仅此一次，请立即保存；主控只存哈希）
2. 填入三个环境变量启动 Worker：`MASTER_API_URL` / `WORKER_NODE_UUID` / `WORKER_API_KEY`（三缺一拒绝启动）
3. 主控节点面板确认状态 `ONLINE`；资源水位/失联告警/自动迁移决策在主控侧（10s 心跳 × 3 次失联 → OFFLINE + CRITICAL 告警）

**驱逐语义**：主控删除或失效本节点 → Worker 进程自动退出（不再以失效凭据冲击主控），需重新注册换新凭据再部署。

**崩溃自愈**：Worker 崩溃 → 入口守护退避重启（5→10→20→30s 封顶）；`/health` 端点暴露节点 UUID、版本、心跳状态、是否被主控失效。

## 五、PostgreSQL 形态要点

- 平台启动自动 `prisma db push`（建表）+ 播种初始账号 + 审计防篡改触发器，无需手工 SQL。
- 数据库连接串在 `DATABASE_URL` 修改；两处密码保持一致（`POSTGRES_PASSWORD` 与连接串内密码）。
- **PG 暂不可达不再崩溃重启**（v1.8.0）：启动期无限退避重试（5→60s）等待数据库恢复，`docker logs` 有明确倒计时；数据库恢复后自动完成初始化并继续启动。

## 六、外部浏览器节点形态要点

- 浏览器节点使用硬隔离镜像（`docker/browser`）：只读根文件系统 + CapDrop=ALL + 下载目录 noexec + supervisor 防退出（用户关不掉浏览器）。
- 平台只连接不编排（`EXTERNAL_BROWSER_URL`）；浏览器崩溃 1 秒内同 Profile 自动拉起。
- **扩容多节点**：复制 `browser` 服务（改容器名），并在平台「网络与节点 → 浏览器节点」页登记新节点地址。
- 浏览器节点 Profile 独立卷 `dockyard-browser-profile` 持久化。

## 七、环境变量速查（全部可选，默认零配置可用）

| 变量 | 默认 | 说明 |
|---|---|---|
| `AUTH_SECRET` | 必改 | 登录会话签名密钥 |
| `ENCRYPTION_KEY` | 必改 | 凭据/票据加密密钥（32 字节） |
| `CRON_SECRET` | 必改 | 定时任务触发密钥 |
| `ADMIN_PASSWORD` | `Admin@2026` | 初始超管密码（仅首次播种生效） |
| `DATABASE_PROVIDER` | `sqlite` | `sqlite` / `postgres` |
| `DATABASE_URL` | SQLite 文件路径 | postgres 时填连接串 |
| `PUBLIC_BASE_URL` | 空 | 对外域名（邮件链接/分享链接/CDP 展示基准） |
| `EXTERNAL_BROWSER_URL` | 空 | 外部浏览器节点地址（`http://host:9222`） |
| `BROWSER_RUNTIME` | `auto` | `auto` / `embedded` / `external` / `docker` |
| `CDP_SERVICE_PORT` | `9222` | CDP 对外端口 |
| `TZ` | `Asia/Shanghai` | 时区 |
| `PRISMA_LOG_QUERY` | 空 | `1` = 打印每条 SQL（排障用；默认关闭防日志洪水） |
| `LOG_ROTATE_MB` | `20` | 服务日志轮转阈值 MB（超限归档 .1 并截断） |
| `BOOT_GRACE_SEC` | `900` | 启动宽限期秒数（数据库初始化/升级期间 healthcheck 不判死） |

## 八、常见问题

**怎么确认启动成功？（v1.8.0）**
`docker logs dockyard 2>&1 | grep "DOCKYARD 启动成功"` —— 命中即全部服务就绪（横幅含端口/数据库形态/初始账号摘要）。启动进行中日志可见 `[dockyard-start]` 前缀逐步推进；guard 崩溃轮会输出 `server.log` 尾部崩溃栈与退避倒计时（5→10→20→40→60s 封顶，不再疯狂自旋）。

**启动失败怎么办？**
`docker logs -f dockyard` 看完整启动自检日志。入口为守护式 guard：主进程崩溃自动整轮重启并输出崩溃原因，容器不会静默停止。连续 5 轮快速崩溃时 guard 会打出三步排查指引（server.log / vnc-bridge.log / 磁盘水位）。

**沙箱启动失败（VNC 创建错误）？**
平台已内置 3 次自动重试（自动换显示号/端口）+ 启动前磁盘自检；仍失败时工作区列表直接展示失败原因（ERROR 态），日志在 `dockyard-storage` 卷内 `sandboxes/<沙箱ID>/logs/`。

**数据怎么备份？**
方式一：后台「备份恢复」页（支持 AES 加密）。方式二：直接备份两个数据卷（平台停止时拷贝最安全）。

**想用已有 PostgreSQL？**
用 `docker-compose.postgres.yml` 但删掉 `postgres` 服务，把 `DATABASE_URL` 指向你的数据库。
