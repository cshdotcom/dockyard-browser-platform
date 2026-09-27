# Dockyard 浏览器工作平台

> 企业级远程浏览器工作平台 · NextJS App Router 全栈实现 · 内置 Sing-Box 容器编排 · 多租户权限与安全审计

![Next.js](https://img.shields.io/badge/Next.js%2016-App%20Router-teal) ![Prisma](https://img.shields.io/badge/Prisma-SQLite%2FPostgreSQL-blue) ![Auth](https://img.shields.io/badge/NextAuth%20v4-JWT%20%2B%20TOTP%202FA-green)

---

## 一、平台定位

企业内部**多租户浏览器工作区平台**：

- 浏览器工作会话基于 **Steel-Browser** 提供 CDP 轻量会话与 **NoVNC** 重度人机交互会话（双模式）
- 会话支持**直连**或分配**内置 Sing-Box 代理实例**（配置经内存组装注入容器环境变量，不落盘）
- 全部外部调用（Docker API / Steel-Browser / NoVNC 池）经 NextJS 网关中转，底层服务不暴露公网
- 统一网关：单域名 + 单 WebSocket + 单 API 入口；APIKey 五重隔离（租户/资源/用户/客户端/设备）

## 二、技术栈（固定约束）

| 层 | 技术 |
|---|---|
| 前端 | Next.js 16 App Router · RSC + "use client" · Tailwind 4 · shadcn/ui |
| 后端 | NextJS Server Actions + Route Handlers |
| ORM | Prisma（50 张数据表，审计日志只插入） |
| 认证 | NextAuth v4 Credentials + JWT(HttpOnly Cookie) + RefreshToken 黑名单 + TOTP 2FA |
| 定时任务 | 外部 cron 触发受保护 Route Handler（内存锁防重入） |
| 实时 | WebSocket 枢纽（socket.io mini-service，事件推送专用） |
| 容器编排 | Docker REST API（HTTP 调用，不挂载宿主 socket） |

## 三、功能全景

### 基础底座
- **用户账号**（42+项）：CRUD/批量/CSV导入导出/配额/锁定策略/密码历史/多设备会话管理/角色（超管/管理员/组管理员/用户）
- **用户组**（26+项）：树形层级/循环校验/组管理员/配额继承+预留水位/权限锁29项/代理绑定/组复制/导入导出
- **审计日志**：数据库层面只允许 INSERT，before/after JSON diff，敏感字段自动脱敏，归档表，按资源ID完整链路追踪
- **API-Token**：高熵明文仅返回一次（库内只存哈希）、位掩码权限、IP白名单、独立QPS、完整有效期管控（永久/定期/全局上限/到期告警/自动作废）
- **系统配置**：87项键值配置、版本快照回滚、漂移检测、环境变量覆盖
- **定时任务**：17项内置任务（会话回收/状态同步/代理探测/文件清理/数据库备份/日志归档/告警检测/僵死回收/配额检测/Token过期/回收站清除/脏数据自愈/宿主机采集/配置漂移/智能自检/共享清理/NoVNC健康）
- **文件存储**：后缀黑名单+魔数校验、配额、签名URL、分片上传
- **备份恢复**：定时/手动备份、AES加密、保留份数、一键恢复（强确认+维护模式）
- **告警通知**：三级别、静默窗口、抑制合并、webhook队列重试、站内通知+WS实时推送

### 登录与安全（完整模块）
- 密码登录（复杂度策略/弱密码字典/锁定/图形验证码/暴力破解防护）
- 邮箱验证码免密登录（防轰炸限流/一次性/防账号枚举）
- **TOTP 2FA**：密钥AES-256-GCM加密落盘、二维码+手动密钥、10组备份码哈希存储、受信任设备（30天免验/可撤销）、强制2FA策略（全局/用户组）
- 会话管理：登录设备列表/踢除任意会话/闲置自动登出/HttpOnly Cookie
- 修改密码（踢除其它会话）、换绑邮箱（双重验证码）、安全日志全量事件
- 异地登录检测、防时序攻击、账号枚举防护

### 浏览器业务
- 工作区生命周期（幂等防重/三级配额+预留水位/风控行为检测）
- CDP 轻量会话：CDP指令网关转发（黑名单+限速）、HAR导出、网络节流（0.001精度）、脚本注入沙箱
- **NoVNC 重度会话（LiveDesk）**：品牌化现代 RFB 查看器（@novnc/novnc 真实客户端）
  - 单域名统一网关接入：HMAC 单次票据（60s 时效 + 防重放）→ VNC 网关桥 → 容器 RFB(TCP)
  - 断线自动重连（退避重试，每次自动重新取票）+ 画面停顿看门狗（15s 无帧强制重连）
  - 只读镜像双保险：客户端 viewOnly + 桥侧丢弃输入帧
  - 实时遥测 HUD（帧率/带宽/键鼠回显，WebSocket 数据面仪表化）
  - **中文剪贴板双通道**：RFB QEMU 扩展剪贴板协议（UTF-8 + zlib 全字符）+ 平台审计中转代理
  - 归属水印（平铺斜置）/ 品牌签名截图 / 画质三档 / 触屏-鼠标模式记忆持久化
- **硬隔离浏览器容器（防退出）**：
  - 只读根文件系统 + CapDrop=ALL + no-new-privileges + 非 root 运行
  - 唯一挂载本人 Profile 卷（其他用户资料不在容器命名空间内，任何形式不可读）
  - 下载目录/tmpfs 全部 noexec：下载可执行软件运行即报权限错误
  - 防退出三重自愈：镜像 supervisor 死循环（退出 1 秒内同一 Profile 拉起）+ RestartPolicy=always + 平台看门狗自动重建（连续 3 轮失败才转 ERROR）
  - CPU/内存/Pids 硬限制（禁 swap，超限 OOM 硬终止）+ dockyard-sessions 隔离网络
- Profile 快照：挂载/创建/过期/配额
- 会话模板（私有/组/全局+继承+变量）、UA池、域名黑白名单、请求篡改规则
- 会话共享授权（时效/撤销）、代理切换（保留快照重启）

### Sing-Box 编排（内置，不独立部署）
- 可视化表单（出站VLESS/VMess/Trojan/SOCKS/HTTP、传输TCP/WS/gRPC/Reality、DNS、路由规则拖拽优先级、入站Socks）
- 配置内存组装→容器环境变量注入（不落盘）→Docker API创建（CPU/内存0.001精度硬限制、禁特权、禁挂载）
- 热更新（SIGHUP+失败自动回滚+告警）、配置版本历史、状态双向对齐（容器真实状态为权威基准）
- 流量统计（0.001MB）、超限动作（告警/限速/禁新会话）、批量启停/测试/销毁
- 宿主机多节点、资源预留水位、灰度分组、连通性测试（出口IP/延迟/UDP/DNS泄漏）
- 自动同步代理池（internal_singbox 节点、状态联动、标签同步）

### 回收站 / 强制管控 / 归属体系
- 工业级回收站：软删除入站、锁定保护、恢复时效、三种删除来源、批量、原UUID原配置无损恢复、到期物理清除
- 管理员强制操作：强制停止/重启/移入回收站/物理删除（强确认）/断开VNC客户端/改写TTL/资源转移
- 资源归属：createdByUserId（原始创建人，只读）+ ownerUserId（当前所有者，可转移）双字段全表贯通；筛选/排序/悬浮卡片/账号禁用标记
- 风控黑白名单（IP黑/CIDR/白名单外部通道）、用户行为画像、脏数据自愈、配置漂移检测

### MCP / OpenAPI 统一网关
- 标准MCP协议（原生+JSON-RPC 2.0双风格）、tools/list
- 批量任务体系：20+操作（批量创建工作区/批量启停销毁SingBox/批量用户管控/批量有效期/批量回收站/批量强制操作...）
- 任务优先级（高/中/低）、失败隔离、进度追踪、暂停/继续/终止/重试、异常报告
- OpenAPI 3.0 文档自动生成（/api/openapi/doc）、资源查询统一归属字段输出
- APIKey鉴权：哈希/过期/IP白名单/三级限流（秒/分/时）/权限位掩码/调用日志（含wasExpired标记）
- Prometheus指标暴露（/api/metrics）

## 四、快速开始

### 演示账号（首次播种自动创建）
| 账号 | 密码 | 角色 |
|---|---|---|
| admin | Admin@2026 | 超级管理员 |
| demo | Demo@2026 | 普通用户 |

### 本地开发
```bash
bun install
cp .env.example .env   # 修改密钥
bunx prisma db push
bunx tsx prisma/seed.ts
bun run dev            # http://localhost:3000
```

### Docker 部署（host 网络模式 · CDP 端口可变）
```bash
# host 模式：容器直接使用宿主机网络，CDP服务端口/VNC网关桥端口通过环境变量改变
docker run -d --name dockyard --network host \
  -e PORT=3000 \
  -e CDP_SERVICE_PORT=9222 \
  -e VNC_BRIDGE_PORT=3005 \
  -e AUTH_SECRET=请修改为随机值 \
  -e ENCRYPTION_KEY=请修改为32字节密钥 \
  -e CRON_SECRET=请修改 \
  -e ADMIN_PASSWORD=初始超管密码 \
  -e DOCKER_API_URL=http://127.0.0.1:2375 \
  -e BROWSER_IMAGE=ghcr.io/<owner>/dockyard-browser-platform-browser:latest \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  -v dockyard-data:/app/db \
  -v dockyard-storage:/app/storage \
  ghcr.io/<owner>/dockyard-browser-platform:latest
```

镜像由 GitHub Actions 自动构建推送至 GHCR：
- 平台主镜像：`.github/workflows/docker-image.yml`
- 硬隔离浏览器镜像（supervisor 防退出）：`.github/workflows/docker-browser.yml`（`docker/browser/`）

> 镜像为 **All-In-One 独立服务端完整包**：内置全部依赖、WS枢纽、LiveDesk VNC 网关桥（票据HMAC鉴权）、数据库初始化与自检，启动脚本自动执行 `prisma db push` + 种子 + 目录/端口自检（主服务/WS枢纽/VNC桥三进程统一托管与优雅退出）。

### 外部服务对接（生产环境）
| 环境变量 | 说明 | 缺省行为 |
|---|---|---|
| DOCKER_API_URL | Docker Engine HTTP API 地址 | 本地模拟容器模式 |
| BROWSER_IMAGE | 自托管硬隔离浏览器镜像 | GHCR 官方 dockyard-browser |
| STEEL_BROWSER_URL | Steel-Browser API（仅内网） | 模拟会话模式 |
| NOVNC_POOL_URL | NoVNC 池 API（仅内网） | 模拟桌面模式 |
| VNC_BRIDGE_PORT / VNC_BRIDGE_SECRET / VNC_BRIDGE_PUBLIC | LiveDesk VNC 网关桥（端口/HMAC密钥/接入形态 gateway\|port\|url） | 3005 / 启动时随机生成 / port |
| SMTP_HOST/PORT/USER/PASS | 邮件服务 | 模拟邮件（服务端日志输出） |

未配置外部服务时平台全链路可跑（模拟适配器，含内置演示 RFB 帧缓冲引擎），生产配置后即真实调度。

### 定时任务（外部 cron）
```cron
*/5 * * * * curl -s -H "x-cron-secret: <CRON_SECRET>" http://127.0.0.1:3000/api/cron?task=all
```

## 五、仓库结构

```
prisma/            schema.prisma（50表）+ seed.ts
src/app/           login/register/forgot-password + (main)/ 前台与管理后台全部页面
src/app/api/       auth(登录/验证码/注册/重置) cron mcp openapi files cdp vnc-proxy metrics
src/lib/           认证/权限/审计/配置/加密/TOTP/限流/幂等/风控/回收站/外部适配器/告警/WS推送
src/server/        actions(全部Server Actions) tasks(定时任务引擎) mcp(批量任务引擎)
mini-services/     ws-hub（WebSocket枢纽，端口3003/事件注入3004）
docker/            start/stop/healthcheck/守护脚本
```

## 六、安全设计要点

- 密码 bcrypt(12) 哈希；TOTP密钥/代理密码/NoVNC密钥 AES-256-GCM 加密落盘
- 登录接口不返回账号存在性；验证码/TOTP 拒绝时序攻击（恒定时间比较）
- 三层权限拦截：前端隐藏 → RSC过滤 → Server Action/Route Handler 强制校验
- 29项细粒度权限锁（全局/组/用户三层覆盖）
- 审计日志只插入（附 PostgreSQL 触发器脚本可加数据库层保护）
- 容器禁特权、禁挂载宿主目录、资源硬限制OOM
- 统一幂等指纹防重复提交；写操作维护模式/只读模式拦截
