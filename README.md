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
- **API-Token**：高熵明文仅返回一次（库内只存哈希）、**权限级别（只读 / 读写 / 管理级——管理位仅平台管理员可授予，普通用户自助签发通道已封堵提权路径）**、**功能范围 scope 白名单（browser/proxy/user/token/recycle/session/crx/resources 八大功能面，空=不限；与权限级别正交：只读只能查、读写可改、scope 限定能碰哪些功能）**、IP白名单、独立QPS、完整有效期管控（永久/定期/全局上限/到期告警/自动作废）；**管理员代管**：用户管理行菜单「API 密钥」可直接为用户创建/查看/修改/启停/吊销密钥（明文一次展示+转交提示，全程 WARN 级审计 TOKEN_ADMIN_*；管理级仅可授予管理员账号）；MCP 网关 tools/list 仅列出该密钥有权调用的工具，引擎逐操作强制权限位+scope 双重校验（越权 403 且不建任务记录）
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
- **NoVNC 重度会话（HelmPort）**：品牌化现代 RFB 查看器（**全自研 RFB 协议客户端，零第三方 VNC 依赖，Next.js/React 原生实现**）
  - 自研 RFB 3.3/3.7/3.8 协议栈：版本协商/安全握手/像素格式协商/Raw+CopyRect+桌面尺寸+光标伪编码（src/components/vnc/helmport/）
  - 单域名统一网关接入：HMAC 单次票据（60s 时效 + 防重放）→ VNC 网关桥 → 容器 RFB(TCP)
  - 断线自动重连（退避重试，每次自动重新取票）+ 画面停顿看门狗（15s 无帧强制重连）
  - 只读镜像双保险：客户端 viewOnly + 桥侧丢弃输入帧
  - 实时遥测 HUD（帧率/带宽/键鼠回显，WebSocket 数据面仪表化）
  - **中文剪贴板双通道**：自研 QEMU 扩展剪贴板（UTF-8 + zlib，CompressionStream 原生压缩）+ 平台审计中转代理
  - 归属水印（平铺斜置）/ 品牌签名截图 / 画质三档 / 触屏-鼠标模式记忆持久化（长按=右键/拖动=移动/滚轮=滚动）
- **硬隔离浏览器容器（防退出）**：
  - 只读根文件系统 + CapDrop=ALL + no-new-privileges + 非 root 运行
  - 唯一挂载本人 Profile 卷（其他用户资料不在容器命名空间内，任何形式不可读）
  - 下载目录/tmpfs 全部 noexec：下载可执行软件运行即报权限错误
  - 防退出三重自愈：镜像 supervisor 死循环（退出 1 秒内同一 Profile 拉起）+ RestartPolicy=always + 平台看门狗自动重建（连续 3 轮失败才转 ERROR）
  - CPU/内存/Pids 硬限制（禁 swap，超限 OOM 硬终止）+ dockyard-sessions 隔离网络（ICC=false 容器互访封禁，跨用户浏览器网络不可达）
- **网络访问管控（管理员按用户/组控制）**：
  - 两个独立维度：`允许访问内网`（RFC1918/链路本地/云元数据 169.254.169.254/mDNS）与 `允许访问容器内安全位置`（本机 CDP:9222/VNC:5900、file://、chrome:// 管理页、平台内部端点）
  - 三层解析：用户级覆盖 > 组级（含父组继承链）> 全局默认（security.defaultAllowInternalNetwork / security.defaultAllowSecureLocationAccess，默认全部拒绝）
  - 三层真实执行（纵深防御）：① Chromium 托管策略（只读 bind-mount /etc/chromium/policies/managed/dockyard.json，URLBlocklist 在 URL 分类阶段直接拦截 + WebRtcIPHandling 防泄漏 + ProxyMode 锁定）② Sing-Box 路由拦截（真实 CIDR + action=block）③ Docker 网络 ICC 封禁
  - 策略创建时快照落库（networkPolicyJson）；防闪退自愈/代理切换重建时重新解析（管理员收紧立即作用于新容器）
  - 管理入口：用户列表「网络策略」列（生效值+覆盖来源）+ 行菜单三态控制（允许/禁止/继承）；组编辑双开关；工作区详情安全面板可视化
  - 鉴权：SUPER_ADMIN/ADMIN 全量，GROUP_ADMIN 仅限本组；普通用户前端无入口 + 后端强制 403；变更全部落审计（WARN）+ 安全事件
- **域名黑白名单（三层作用域 + 真实拦截）**：
  - 规则作用域：全局（GLOBAL）/ 用户组（GROUP，含继承链）/ 用户（USER），用户生效规则 = 三层并集
  - 黑名单模式：命中即被 Chromium URLBlocklist 拦截；白名单模式（任一作用域存在 WHITE 规则即激活）：URLAllowlist 严格放行（`*` 全量阻断 + 白名单例外 `!` 前缀语义）
  - 执行层与内网/安全位置封禁合并写入同一份只读 bind-mount 托管策略文件；MCP/OpenAPI `browser.block_urls`/`allow_urls` 运行时叠加
  - 管理入口：规则管理页（作用域列/筛选/组、用户选择器）；工作区创建/重建时快照（domainMode/domainBlack/domainWhite）
- **IP 黑白名单（作用域化）**：RiskListRule 支持 GLOBAL/GROUP/USER 作用域，经策略下发中心批量下发
- **策略下发中心（/admin/policies，批量下发到用户/用户组）**：
  - 策略包四要素：内网开关（三态：不修改/强制允许/强制禁止）+ 容器安全位置开关（三态）+ 域名黑白名单（替换式）+ IP 黑白名单（替换式）
  - 全量前置快照（开关字段 + 同作用域域名/IP 规则）→ 一键回滚（含顺序回滚保护：更晚批次覆盖相同目标时必须先回滚新批次）
  - 逐目标失败隔离、影响面统计（组员数展开）、下发结果明细表；策略模板（3 个内置 + 自定义保存/加载/删除）
  - 鉴权：ADMIN 全量 / GROUP_ADMIN 仅本组目标（越权整批拒绝）；审计（POLICY_DEPLOY / POLICY_DEPLOY_ROLLBACK）+ 安全事件 + 限流
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
- **浏览器全量控制（browser.*，Steel-Browser 全功能复制，30 个动作）**：
  - 页面：navigate / screenshot(PNG base64) / scrape(text·html·links) / evaluate(JS，awaitPromise) / get_url / dom_snapshot / wait_for
  - 输入：click(选择器或坐标) / type(选择器或焦点) / press_key(含修饰键位掩码) / scroll / hover
  - 标签：get_tabs / new_tab / close_tab / activate_tab；历史：back / forward / reload(忽略缓存)
  - 网络：throttle(0.001精度含离线) / block_urls(运行时黑名单) / allow_urls(运行时白名单) / clear_url_filters / set_extra_headers
  - 指纹：set_user_agent / set_viewport / set_geolocation；数据：get_cookies(值脱敏) / set_cookies / get_logs(控制台·网络环形缓冲)
  - 会话：status / debug_info（连接池/浏览器版本/目标列表）
  - 双形态执行：真实 CDP（WebSocket 直连 + Target.attach + 各域命令）或模拟引擎（无集群全链路验证：虚拟DOM/标签页/截图/sharp PNG/白名单安全求值）
  - MCP 与 OpenAPI 共用同一执行层（BROWSER_ACTIONS 唯一事实源）；归属强制（本人或ADMIN权限位）+ 限流（180/分 MCP、120/分 REST）+ 全量审计
  - OpenAPI REST：POST /api/openapi/browser/<action>（目录 GET /api/openapi/browser；文档 /api/openapi/doc 自动生成 Browser Control 端点组）
  - 单目标结果载荷入任务 resultJson（截图/抓取/求值结果可经 task.status 回查，1MB 上限）
- 任务优先级（高/中/低）、失败隔离、进度追踪、暂停/继续/终止/重试、异常报告
- OpenAPI 3.0 文档自动生成（/api/openapi/doc）、资源查询统一归属字段输出
- APIKey鉴权：哈希/过期/IP白名单/三级限流（秒/分/时）/权限位掩码/调用日志（含wasExpired标记）
- Prometheus指标暴露（/api/metrics）

## 四、快速开始

### 管理员账号引导（三通道，均幂等，后期可修改）
| 通道 | 说明 |
|---|---|
| 环境变量（配置文件） | `ADMIN_USERNAME` / `ADMIN_EMAIL` / `ADMIN_PASSWORD`，首次启动 seed 自动创建超管；`ADMIN_PASSWORD_FORCE=1` 可强制同步密码 |
| 首启引导页 | 库中无任何管理员时自动开放 `/setup`（注册后永久关闭，登录页有引导入口） |
| 后期修改 | 登录后「账号与安全」：修改密码（旧密码+TOTP校验）/ 修改登录用户名（当前密码验证）/ 换绑邮箱（双邮箱验证码） |

### 演示账号（首次播种自动创建，SEED_DEMO=0 可关闭）
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
# host 模式：容器直接使用宿主机网络；对外仅 网页（GATEWAY_PORT，默认3000）+ CDP（CDP_SERVICE_PORT，默认9222）两个端口
# VNC/WS枢纽/事件注入全部回环监听，统一经入口网关嵌入网页端 —— 无需额外 -p 映射
docker run -d --name dockyard --network host \
  -e PORT=3000 \
  -e CDP_SERVICE_PORT=9222 \
  -e AUTH_SECRET=请修改为随机值 \
  -e ENCRYPTION_KEY=请修改为32字节密钥 \
  -e CRON_SECRET=请修改 \
  -e ADMIN_PASSWORD=初始超管密码 \
  -e DOCKER_API_URL=http://127.0.0.1:2375 \
  -e BROWSER_IMAGE=ghcr.io/cshdotcom/dockyard-browser-platform-browser:latest \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  -v dockyard-data:/app/db \
  -v dockyard-storage:/app/storage \
  ghcr.io/cshdotcom/dockyard-browser-platform:latest
```

镜像由 GitHub Actions 自动构建推送至 GHCR：
- 平台主镜像：`.github/workflows/docker-image.yml`
- 硬隔离浏览器镜像（supervisor 防退出）：`.github/workflows/docker-browser.yml`（`docker/browser/`）

> 镜像为 **All-In-One 独立服务端完整包**：内置全部依赖、WS枢纽、HelmPort VNC 网关桥（票据HMAC鉴权）、数据库初始化与自检，启动脚本自动执行 `prisma db push` + 种子 + 目录/端口自检（主服务/WS枢纽/VNC桥三进程统一托管与优雅退出）。入口为**守护式 guard**：主进程崩溃后自动整轮重启并将崩溃原因（server.log 尾部）输出至 `docker logs`，容器不会静默停止。
>
> 部署可选环境变量：`BUILTIN_CRON`（默认 1，镜像内置定时调度器，每 `CRON_INTERVAL_SEC` 秒（默认 300）触发一次引擎任务，可与外部 cron 并存）；`DOCKER_API_URL` 指向宿主 Docker Engine 时即可编排真实硬隔离浏览器沙箱。
>
> **会话 Cookie 安全属性（登录成功却登不进的处理）**：`COOKIE_SECURE` 缺省 `auto` —— 仅当 `AUTH_PUBLIC_URL` / `AUTH_URL` 为 `https://` 时启用 `Secure`；通过 `http://IP:端口` 明文访问时自动关闭，否则浏览器会丢弃带 `Secure` 的 Cookie（表现：提示登录成功但跳转被弹回登录页）。HTTPS 反代部署时可设 `COOKIE_SECURE=1` 强制开启。
>
> **公开域名配置（内网穿透 / 反向代理 / 域名部署）**：`PUBLIC_BASE_URL`（或 `APP_PUBLIC_URL` / `AUTH_PUBLIC_URL` / `AUTH_URL` / `NEXTAUTH_URL` 任一）设置为平台对外可达地址（如 `https://workspace.example.cn`）后：
> - 登录回调/重定向固定使用该域名（NextAuth `trustHost` 已启用，兼容任意 Host 头反代）
> - 工作区详情页展示**公网 CDP 网关端点**（`<域名>/api/cdp/command`）——外部工具（Puppeteer/Playwright/脚本）经此端点鉴权转发，无需触达内部网络；内部 `ws://steel-internal/...` 端点仅作运维参考
> - 未配置时自动使用请求 Host（网关同源转发场景无需任何配置）
> ```bash
> docker run -e PUBLIC_BASE_URL=https://workspace.example.cn ... ghcr.io/cshdotcom/dockyard-browser-platform
> ```

### 外部服务对接（生产环境）
| 环境变量 | 说明 | 缺省行为 |
|---|---|---|
| DOCKER_API_URL | Docker Engine HTTP API 地址 | 本地模拟容器模式 |
| BROWSER_IMAGE | 自托管硬隔离浏览器镜像 | GHCR 官方 dockyard-browser |
| STEEL_BROWSER_URL | Steel-Browser API（仅内网） | 模拟会话模式 |
| NOVNC_POOL_URL | NoVNC 池 API（仅内网） | 模拟桌面模式 |
| VNC_BRIDGE_PORT / VNC_BRIDGE_SECRET / VNC_BRIDGE_PUBLIC | HelmPort VNC 网关桥（端口/HMAC密钥/接入形态 gateway\|port\|url；gateway=经统一网关嵌入网页端，回环监听） | 3005 / 启动时随机生成 / gateway |
| GATEWAY_PORT / APP_INTERNAL_PORT / GATEWAY_TRANSFORM_PORTS | 统一入口网关（对外唯一 UI 端口 / Next 回环端口 / 允许透传的回环端口清单） | 3000 / 13000 / 3003,3004,3005 |
| SMTP_HOST/PORT/USER/PASS | 邮件服务 | 模拟邮件（服务端日志输出） |

未配置外部服务时平台全链路可跑（模拟适配器，含内置演示 RFB 帧缓冲引擎），生产配置后即真实调度。

### 定时任务（内置调度器，外部 cron 可选）
镜像默认内置定时调度器（每 5 分钟自动触发全部启用任务，`BUILTIN_CRON=0` 关闭，`CRON_INTERVAL_SEC` 调整间隔）。外部 cron 仍可叠加触发（接口侧内存锁防重入）：
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
mini-services/     gateway（统一入口网关：对外唯一 UI 端口，WS双向泵） ws-hub（回环） vnc-bridge（回环）
docker/            start/stop/healthcheck/entrypoint-guard（守护入口：崩溃自愈）脚本
```

## 六、安全设计要点

- 密码 bcrypt(12) 哈希；TOTP密钥/代理密码/NoVNC密钥 AES-256-GCM 加密落盘
- 登录接口不返回账号存在性；验证码/TOTP 拒绝时序攻击（恒定时间比较）
- 三层权限拦截：前端隐藏 → RSC过滤 → Server Action/Route Handler 强制校验
- 29项细粒度权限锁（全局/组/用户三层覆盖）
- 审计日志只插入（附 PostgreSQL 触发器脚本可加数据库层保护）
- 容器禁特权、禁挂载宿主目录、资源硬限制OOM
- 统一幂等指纹防重复提交；写操作维护模式/只读模式拦截
- 网络访问默认拒绝（deny-by-default）：内网/容器安全位置需管理员显式按用户或用户组授权；策略文件只读 bind-mount，沙箱内（只读根FS+非root+CapDrop=ALL）无法篡改
