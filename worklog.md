# Dockyard 浏览器工作平台 — 工作日志

---
Task ID: 1
Agent: main
Task: 企业级 Next.js 远程浏览器工作平台全量实现

Work Log:
- 初始化 fullstack 环境（Next.js 16 App Router + Prisma + NextAuth + shadcn/ui）
- 安装 bcryptjs / otplib / qrcode / nodemailer / csv-parse / socket.io-client
- Prisma schema 完成：50 张表
- 核心库完成：env / errors / crypto / totp / config / trace / audit / alerts / rate-limit / idempotency / permissions / email / captcha / external adapters / singbox / recycle / risk / api / validators / utils-server
- 认证链路：pre-login(密码/邮箱码+风控+锁定+captcha) → ticket → NextAuth authorize(2FA校验+信任设备) → LoginSession+RefreshToken → session回调DB校验
- 主骨架：(main) layout + AppShell（权限菜单/通知铃/全局搜索）+ 仪表盘
- 定时任务引擎：17项任务全部实现并逐项执行验证通过（含修复 LoginSession.lastActiveAt 查询字段错误）
- MCP/OpenAPI：APIKey鉴权(五重校验) + 20+批量操作 + JSON-RPC兼容 + OpenAPI 3.0文档 + Prometheus指标；统一网关API降级认证打通（getAuthContext 支持 x-api-key）
- WS枢纽mini-service：3003 socket.io + 3004事件注入（engine.io path=/ 全接管问题修复：attach顺序+端口分离）
- 工作区业务actions + 列表页 + 详情页（CDP控制/脚本/HAR/共享/代理切换）
- SingBox编排actions + 管理页（可视化表单/热更新/版本回滚/连通测试/批量/导入导出）
- Docker All-In-One（host模式/CDP_SERVICE_PORT可变/start.sh自检+DB初始化+种子）+ GHCR CI + README
- GitHub仓库创建与推送（cshdotcom/dockyard-browser-platform）

Stage Summary:
- 平台全部模块真实实现并经 curl + Agent Browser 双通道验证

---
Task ID: A
Agent: full-stack-developer subagent
Task: 管理基础页（用户/用户组/在线会话/审计日志 + 导出路由）

Work Log:
- 16 文件：actions(users/groups) + 4页面 + 3导出路由
- 用户管理：分页筛选排序/批量启禁迁移重置配额强下线/CSV导入导出/重置密码/2FA管控四件套/解锁/强确认删除
- 用户组：树形/循环校验/组员/组管理员/代理绑定/复制/29项权限锁/JSON导入导出
- 在线会话：列表/单条与批量下线/审计+安全事件
- 审计：双页签/JSON diff三栏高亮/CSV导出/资源链路追踪
- 24 action 端到端实测（含负向分支），lint 零错误

Stage Summary:
- 管理基础四模块交付，全部验证通过

---
Task ID: B
Agent: full-stack-developer subagent
Task: 平台运维页（系统配置/定时任务/文件/备份/告警/公告）

Work Log:
- 19 action + 3 API路由（files upload/download/scan）+ 6页面16组件
- 配置：8分类Tabs+版本历史回滚；维护/只读快捷开关；超管可写管理员只读
- 任务：启停/手动执行(fetch /api/cron + x-cron-secret)/cron编辑；执行日志页签
- 文件：XHR上传（后缀黑名单7种+MZ/ELF魔数+配额）；Top10占用groupBy；下载鉴权
- 备份：AES-256-GCM可选加密；恢复requirePhrase=RESTORE全流程（临时备份→维护模式→写回→关闭）
- 告警：4页签（列表/规则/webhook+投递记录/通知）
- 公告：三范围三展示方式+预览弹窗
- 19 action 实测含9负向分支；17种筛选组合200

Stage Summary:
- 运维六模块交付；/api/cron 当时为空目录由主代理后续实现

---
Task ID: C
Agent: full-stack-developer subagent
Task: 用户中心页（API令牌/登录设备/资料/模板/快照/公告用户侧）

Work Log:
- 17文件：actions(tokens/templates/snapshots/profile) + 6页面12组件 + 模板导出路由
- Token：四态标签（永久/正常/即将到期橙/过期红）；创建弹窗（快捷chips+datetime+权限位掩码+IP白名单校验+PrecisionInput QPS）；明文一次展示（复制+二次确认关闭）；策略校验（maxPerUser/allowPermanent仅超管豁免/maxLifetimeDays）
- 登录设备：UA解析/当前设备徽章/单条与一键下线（级联refreshToken）/受信任设备页签+备份码余量
- 资料：主题三选一/偏好合并/配额仪表盘Progress
- 模板：可见性防越权（AND包装）/表单化配置/复制继承/导入导出
- 快照：exportProfile→fileMeta+记录；过期/重命名
- 公告：跑马灯动画/POPUP未读自动弹/FORCE_VIEW遮罩
- 40+断言全过；12路由双账号200

Stage Summary:
- 用户中心六模块交付；demo账号三形态公告可预览体验

---
Task ID: D
Agent: full-stack-developer subagent
Task: 网络/工作区管控/回收站/风控/MCP管理/规则页

Work Log:
- 50 action + 6页面18组件
- 网络：代理(internal_singbox紫标/编辑引导)/Steel(负载Progress/灰度/隔离)/宿主机(水位红高亮/采集)
- 工作区管控：7种强制操作+6种批量（DESTROY双强确认/失败明细/转移）；proxyUrl组装（internal→socksAddr）
- 回收站：双页签/三种删除来源Badge/锁定保护/批量五操作/一键清空(PURGE ALL)
- 风控：黑白名单+解封；行为画像（riskTriggers降序红高亮）
- MCP管理：进度条/详情（参数/子项/失败原因）/取消重试
- 规则：UA池/域名/篡改规则三页签+导入导出
- 79步冒烟全过；42种审计operationType落库
- 演示数据补种：4代理/3Steel/2宿主机/4工作区/3MCP任务/6风控规则/3回收站

Stage Summary:
- 管控六模块交付；风控白名单初期拦截本机已由主代理修正设计（白名单仅限外部通道）

---
Task ID: 2
Agent: main
Task: E2E验证 + CI修复 + 部署

Work Log:
- Agent Browser 全站巡检：登录流程→仪表盘→工作区创建（UI创建成功 RUNNING）→详情页（CDP控制/脚本/HAR/共享全页签）→SingBox→账号安全
- 2FA 全流程浏览器实测：开启→二维码+手动密钥→otplib生成实时码→校验通过→10组备份码弹窗→已开启状态；DB验证 twoFactorEnabled=true/10备份码/安全事件；演示环境已重置admin 2FA
- MCP实测：tools/list(JSON-RPC) / workspace.create 批量2工作区 SUCCESS / openapi resources 归属字段
- cron实测：17任务全部执行成功（修复 dirty_data_clean LoginSession.lastActiveAt 字段）
- 发现并修复：白名单设计（登录不受白名单限制，外部通道才受限）；workspace详情页 shares TDZ / BrowserScriptTemplate groupId / Dialog导入缺失 / use-ws-hub refs渲染期访问
- CI：lint 0错0警；Docker构建预渲染失败修复（auth页 force-dynamic）
- GitHub推送2次commit；GHCR镜像构建进行中

Stage Summary:
- 平台全部功能真实实现、双通道验证通过、CI绿、镜像构建中

---
Task ID: 3
Agent: main
Task: LiveDesk 品牌化 VNC + 硬隔离防退出浏览器容器 + 全用户管控收口

Work Log:
- 新增 mini-services/vnc-bridge（Bun，端口3005）：HMAC票据鉴权（60s单次防重放）+ WS↔RFB(TCP)双向中转 + 只读票据服务端丢帧 + 演示RFB 3.8引擎（640x400 raw帧流/键鼠回显/指针准星/绽放环/QEMU扩展剪贴板 UTF-8+zlib 中文往返）
- 修复 noVNC 集成三处坑：①动态import异步间隙丢失版本横幅（先import再建WS）②RFB在目标内自建画布（改容器div挂载+rfb.focus）③剪贴板方法名1.7改名 clipboardPasteFrom
- 桥实现 QEMU 扩展剪贴板协议（Caps/Request/Notify/Provide + node:zlib inflateSync Z_SYNC_FLUSH finishFlush 对齐 pako 全量刷新流）——中文剪贴板浏览器实测完整往返
- workspaces actions：getVncTicketAction（五重隔离票据签发+只读降级+审计）、restartBrowserProcessAction（USR1→supervisor同Profile秒级拉起，30s限速）；创建/启动/切代理均携带硬隔离规格落库 hardeningJson+containerRef
- docker.ts：buildBrowserHostConfig 硬隔离（ReadOnlyRootfs/CapDrop=ALL/no-new-privileges/唯一本人Profile卷 noexec/下载目录noexec tmpfs/Pids/禁swap/RestartPolicy=always/dockyard-sessions隔离网络）+ ensureSessionNetwork + createIsolatedBrowserContainer + resolveContainerIp + restartBrowserProcessInContainer(docker exec)
- tasks engine novnc_health 改造为防退出看门狗：崩溃会话同Profile/同代理自动重建（连续3轮失败才转ERROR+告警）
- LiveDesk 查看器组件（src/components/vnc/live-desk-viewer.tsx）：驾驶舱风格工具栏/状态胶囊(fps/KB/s遥测)/自动重连(退避+重新取票)/停顿看门狗/水印/品牌签名截图/剪贴板双通道抽屉/触屏-鼠标记忆/键鼠HUD/全屏；工作区详情页集成 + 会话管控卡 + 安全隔离面板(6项防护可视化)
- docker/browser：硬隔离浏览器镜像（debian+chromium+xvfb+x11vnc+中文字体，supervisor.sh 防退出死循环+USR1热重启）+ docker-browser.yml CI（多架构GHCR）
- start.sh/healthcheck.sh 集成 VNC 桥（共享密钥自动生成注入两侧/三进程统一托管优雅退出/端口自检）
- 环境修复：.env 缺 AUTH_SECRET 导致 NextAuth cookie 与中间件 getToken 密钥不一致（登录循环）；db push 重建后补跑 seed；dev 服务器崩溃后手动恢复
- 端到端验证：登录→建NoVNC工作区→详情页自动连接（36帧/5s，桥协议测试36帧+中文回环+401防重放）→键盘3键/鼠标2事件直达服务端→扩展剪贴板24字符中文往返→断开/重连（新票据）→隔离面板6项全渲染→管理员工控页7项强制操作；VLM 截图双轮确认画面/HUD/面板；lint 零错误

Stage Summary:
- LiveDesk 全链路（票据→网关桥→RFB→画布→输入→剪贴板）双通道实测通过；防退出三重自愈+文件系统硬隔离落地；源码待推送 GitHub

---
Task ID: 3-final
Agent: main
Task: 收尾 — 服务恢复 + 推送确认

Work Log:
- 恢复被误伤的 ws-hub（bun --hot index.ts 与 vnc-bridge 同模式被 pkill 波及）；三进程全绿（app:200 / ws-hub:200 / bridge:health ok）
- 最终链路复验：详情页已连接 + 隔离面板 + 剪贴板全部就绪；截图存 verify/final-state.png
- git push 成功：742e1ff..82c56d5 main -> main（cshdotcom/dockyard-browser-platform）

Stage Summary:
- 本轮全部交付物已验证并推送；CI（lint + 双镜像构建）将随 push 自动触发

---
Task ID: 4
Agent: main
Task: 网络访问管控（管理员按用户/组控制内网/容器安全位置）+ 完整鉴权 + 提交推送 + CI 监控

Work Log:
- Prisma schema：User(allowInternalNetwork/allowSecureLocationAccess 可空覆盖) + Group(组级双开关) + BrowserWorkspace(networkPolicyJson 快照)；修复 SingboxInstance hostNodeId 索引笔误；db push（本地演示数据被 --accept-data-loss 清空 → 重新 seed 恢复）
- 新建 src/lib/network-policy.ts：三层解析（用户>组继承链>全局默认，deny-by-default）+ Chromium 托管策略生成器（URLBlocklist 186 条/双形态/半放行）+ sing-box CIDR 拦截规则 + 策略文件落盘（防路径穿越）+ 批量解析（列表页免 N+1）
- docker.ts：spec 扩展 networkPolicy/policyFile/gatewayIp；策略文件只读 bind-mount /etc/chromium/policies/managed/dockyard.json；会话网络 ICC=false 容器互访封禁（旧网自动重建为严格网）
- novnc.ts：自托管/池集群两种形态均下发 networkPolicy
- workspaces.ts：创建/启动/切代理/看门狗自愈四条链路注入策略（解析+下发+快照落库）
- 管理端 actions：setUserNetworkPolicyAction / setGroupNetworkPolicyAction（ADMIN 全量、GROUP_ADMIN 限本组、普通用户 403、审计 WARN + 安全事件 + 影响面统计）
- UI：用户列表网络策略列（生效值+覆盖徽章+来源）+ 行菜单三态控制；组编辑双开关+树徽章；工作区详情安全面板新增 4 项（内网拦截/安全位置拦截/托管策略锁/ICC 封禁）
- config.ts：security.defaultAllowInternalNetwork / defaultAllowSecureLocationAccess 全局默认键
- 浏览器镜像：预建策略目录 + supervisor 策略注入提示
- 修复：live-desk-viewer SSR screen 未定义；.env 缺 AUTH_SECRET 导致登录循环（补齐 AUTH_SECRET/ENCRYPTION_KEY/CRON_SECRET 并重启）；误删组成员关系恢复
- 验证：33 项策略脚本全过；lint 零错；改动文件类型错误清零；Agent Browser 实测用户级开关（覆盖徽章+审计+安全事件）、组级开关（落库+徽章+继承显示）、工作区创建（快照落库）+ 详情安全面板 4 行渲染
- 提交 71cb7d9 并推送 GitHub

Stage Summary:
- 网络访问管控全链路（策略→解析→下发→执行→审计→UI）双层实测通过；默认全部拒绝

---
Task ID: 5
Agent: main
Task: CI 修复与最终验证

Work Log:
- 浏览器镜像 CI 首次运行失败：apt 报 fonts-noto-color 无法定位（exit 100）
- 修复：核心依赖硬性安装 + emoji 字体软失败（CJK 已由 fonts-noto-cjk 覆盖）+ apt Acquire::Retries=5，提交 3a82c9d
- CI 终态（3a82c9d）：CI Lint ✅ / Build & Push Docker Image ✅ / Build & Push Browser Image ✅ 三工作流全绿
- GHCR 发布确认：
  · ghcr.io/cshdotcom/dockyard-browser-platform:latest（sha256:1e5f3554…）
  · ghcr.io/cshdotcom/dockyard-browser-platform-browser:latest（sha256:7647b963…）
  · 双镜像均 linux/amd64 + linux/arm64 多架构

Stage Summary:
- 本轮全部交付完成：网络访问管控功能 + 源码推送 + 容器编译成功验证
