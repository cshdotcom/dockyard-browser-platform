# Dockyard 浏览器工作平台 — 工作日志

---
Task ID: 1
Agent: main
Task: 企业级 Next.js 远程浏览器工作平台全量实现

Work Log:
- 初始化 fullstack 环境（Next.js 16 App Router + Prisma + NextAuth + shadcn/ui）
- 安装 bcryptjs / otplib / qrcode / nodemailer / csv-parse
- Prisma schema 完成：50 张表（用户/2FA/会话/组/审计/Token/配置/任务/文件/备份/告警/工作区/模板/快照/脚本/规则/Steel/代理/宿主机/SingBox/MCP/回收站/风控/公告/行为画像/自检等）
- 核心库完成：env / errors / crypto(AES-GCM+bcrypt) / totp / config(缓存+版本+漂移) / trace / audit / alerts(webhook队列+静默+抑制) / rate-limit / idempotency / permissions(三层权限锁+配额水位) / email / external/docker / external/steel / external/novnc / singbox(配置组装) / recycle / risk / api / validators / utils-server

Stage Summary:
- 数据层与全部核心库就绪；下一步：NextAuth路由 + pre-login + captcha + middleware + 种子数据

---
Task ID: A
Agent: admin-accounts-agent
Task: 用户管理 / 用户组管理 / 在线会话管控 / 审计日志 / 三导出路由

Work Log:
- Server Actions：users.ts（15个：创建/编辑/重置密码/删除/批量启禁/迁移组/重置配额/单条+全设备强制下线/解锁/2FA四项管控/CSV导入含skip|update双模式与逐行错误报告）、groups.ts（9个：创建/编辑防循环/删除四重前置检查/组员/组管理员含canModifyQuota/代理绑定/复制/权限锁16项全集校验/JSON导入）
- 页面：/admin/users（RSC分页+关键词/角色/启用/2FA/锁定/时间区间筛选+多列排序+批量工具栏+行菜单+临时密码与备份码展示弹窗+CSV导入导出）；/admin/groups（树形缩进+展开折叠+组员/组管理员/代理/权限锁/复制/删除全套弹窗+JSON导入导出）；/admin/sessions（活跃会话列表+单条/全设备下线）；/admin/audit（双页签+JSON diff详情弹窗+资源ID链路过滤+CSV导出，只读）
- 导出：/api/export/users（CSV ?ids=）、/api/export/audit（CSV ?from&to&resourceId&operator）、/api/export/groups（JSON完整组配置可回灌）
- 关键坑：Prisma schema无@relation全部内存join；SQLite不支持skipDuplicates需先查后插；Json空值用Prisma.DbNull
- 验证：curl登录（tmp-cookies.txt）后4页面200、24个action经临时测试端点全量跑通（含负向分支）、审计链路落库核对、lint/tsc零错误；测试代码已从路由移除

Stage Summary:
- 管理后台账号体系四页全部就绪；后续代理可直接复用 agent-ctx/A-user-group-session-audit-admin.md 中的 Prisma join/登录验证经验

---
Task ID: B
Agent: ops-platform-agent
Task: 系统配置 / 定时任务 / 文件存储 / 备份恢复 / 告警中心 / 公告管理

Work Log:
- Server Actions 6 个文件 19 个 action：config（setConfig 单项/批量+rollback，仅超管）、tasks（启停/手动执行走内部 fetch POST /api/cron 带 x-cron-secret/编辑 cron+超时）、files（软删+回收站/立即过期/病毒扫描标记）、backups（立即备份 SQLite 文件复制+可选 AES-256-GCM+size≤1024 raiseAlert；恢复=临时备份→维护模式开关→写回db文件清WAL/SHM→CRITICAL审计）、alerts（告警处理/告警规则CRUD/webhook规则CRUD软删）、announcements（CRUD+启停+删除，schema无deletedAt故物理删除+全量快照审计）
- API 路由 3 个：/api/files/upload（FormData多文件：后缀黑名单7种+MZ/ELF魔数+storage.quotaPerUserMb配额+落盘storage/uploads/<uuid>.<ext>+fileMeta）、/api/files/download（admin/owner/shareTo鉴权+404 JSON+防路径穿越）、/api/files/scan（标记virusScanned+审计）
- 页面 6 个模块：/admin/config（8分类Tabs+版本历史页签按key分组回滚+维护/只读快捷卡片置顶+boolean→Switch/number→PrecisionInput(0.001)/长文本→Textarea+逐项与整体保存+管理员只读）、/admin/tasks（列表+执行日志双页签query驱动+手动执行结果弹窗展示cron {code,msg}+errorStack详情）、/admin/files（统计卡+XHR多文件上传进度条+病毒扫描联动+Top10用户占用groupBy+下载/过期/删除行操作）、/admin/backups（统计卡+保留策略卡+立即备份+恢复requirePhrase=RESTORE强确认+步骤进度弹窗+重启提示+风险Alert）、/admin/alerts（4页签：列表PENDING琥珀高亮+INFO蓝/WARN黄/CRITICAL红徽章、规则CRUD、webhook CRUD+投递记录20条、站内通知只读）、/admin/announcements（CRUD弹窗GLOBAL/GROUP/USER范围选择器+POPUP/MARQUEE/FORCE_VIEW三展示+预览弹窗含跑马灯动画与强制阅读勾选）
- 关键坑：①"use server"文件禁止导出同步函数（曾导出dbFilePath致500）；②Promise.all内三元查询使map元素退化any（改先赋const）；③备份恢复写回后目标记录不存在于恢复态（创建晚于快照）需容错；④SQLite journal_mode=delete覆盖写回后连接可用（实测恢复后全页200）；⑤配置/任务/备份action不调requireWritableMode（维护模式控制面防死锁）；⑥dev server崩溃后用setsid双fork拉起
- 验证：19个action经临时端点全量跑通含负向分支后删除；上传三连（正常成功/后缀拒绝/魔数拒绝）；下载内容一致+404/40100；备份创建921600B→恢复全流程→恢复后库读写正常；审计22种operationType落库核对；17种页面筛选组合200；lint/tsc零错误

Stage Summary:
- 运维平台六模块（配置/任务/文件/备份/告警/公告）全部就绪；细节经验沉淀 agent-ctx/B-config-task-file-backup-alert-announcement.md（同步函数禁导、groupBy排序、恢复容错、防死锁决策）

---
Task ID: C
Agent: self-service-agent
Task: 用户自服务六模块：我的API令牌 / 登录设备管理 / 个人资料 / 会话模板 / 快照管理 / 用户公告页

Work Log:
- Server Actions 4 文件 17 个 action：tokens（创建含 maxPerUser/allowPermanent仅超管豁免/maxLifetimeDays 策略校验+明文一次返回+IP白名单IPv4/CIDR正则+位掩码1/2/4/8、编辑含 expireChanged→blockEditTokenExpiry 锁、软删+回收站、启停）、templates（CRUD 版本自增+GROUP需在我组+GLOBAL仅管理员、deep copy→PRIVATE+parentId 继承、导入 JSON 逐条校验上限20条+blockImportTemplate）、snapshots（createSnapshot：归属+cdp_light+RUNNING 三重校验→Steel exportProfile→fileMeta[SNAPSHOT]+快照+审计+trackBehavior；过期时间 blockModifyResourceExpiry；重命名）、profile（displayName/preferences 合并旧值+blockEditProfile、revokeMySession 禁自我撤销+级联撤销 refreshToken+DEVICE_REVOKED 安全事件、一键下线全部其他、撤销受信任设备、公告已读幂等——因 announcements.ts 归 B 代理故放此）
- 页面 6 模块：/account/tokens（双页签：令牌列表含四态状态标签永久teal/正常emerald/即将到期orange/已过期red+掩码 prefix+••••+创建弹窗快捷有效期chips+自定义datetime-local+权限四复选+明文一次展示弹窗含复制/眼睛切换/AlertDialog二次确认关闭；调用日志页签按令牌筛选+状态码三色+耗时+wasExpired）、/account/sessions（UA服务端正则解析浏览器/OS+当前设备teal徽章+踢单台/一键下线全部+受信任设备页签含备份码剩余提示条）、/account/profile（displayName+邮箱只读引导换绑+主题三选一卡片+每页条数+配额仪表盘 Progress 缺省回退全局+个人统计四卡）、/templates（可见性=GLOBAL/我组GROUP/自己+父模板继承Badge+表单化配置UA下拉/时区/语言/变量JSON+复制/导出/导入/删除）、/snapshots（统计卡+磁盘配额用量+创建快照弹窗选 RUNNING cdp_light+过期/重命名/删除）、/announcements（MARQUEE 跑马灯 style 注入 keyframes+FORCE_VIEW 全屏遮罩必须我已阅读+POPUP 未读队列自动弹+列表卡片已读状态）
- Route：/api/export/template（requireAuth+可见性归属校验+JSON下载含 RFC5987 中文文件名+审计+blockExportData）
- 关键坑：①Prisma Json 字段写 null 必须 Prisma.DbNull（tags/ipWhitelist/preferences 三处）；②HTTP 响应头中文文件名须 filename*=UTF-8''encodeURIComponent 否则 ByteString 异常 500；③关键词搜索与可见性 OR 必须用 AND[visibility, keywordOR] 包装防越权可见；④tsc --noEmit 全量跑会拖垮 dev server（跑完崩溃，setsid 双 fork 拉起恢复）；⑤datetime-local 回填须本地时区拼接而非 toISOString().slice(0,16)（UTC 偏移）；⑥公告已读 action 归属限制放 profile.ts（announcements.ts 属 B 代理禁改）
- 验证：临时端点 40+ 断言全过（正例：sha256 哈希一致性/掩码7/版本自增/复制 parentOk+configCopied/导入2成功1跳过/快照 fileMeta SNAPSHOT/refreshToken 级联撤销/公告幂等；负例：超期40001/坏IP 40001/空权限40001/40400/STOPPED快照42002/过去时间40001/自我撤销40001/非法JSON 40001/超20条40001/他人公告40300）后删除端点；demo+admin 双账号 12 路由 200+匿名307+导出200；审计16种operationType全落库（missing:[]）；lint零错误/tsc本任务文件零错误/dev.log无⨯；补演示公告 MARQUEE+POPUP 各一条（demo 定向 FORCE_VIEW 恢复未读）

Stage Summary:
- 用户自服务六模块全部就绪（个人中心闭环：令牌→设备→资料；资源管理闭环：模板→快照；公告触达三形态）；细节经验沉淀 agent-ctx/C-self-service-agent.md（DbNull/RFC5987/查询组合防越权/tsc拖垮dev/时区闭环）

---
Task ID: D
Agent: network-ops-admin-agent
Task: 网络与节点 / 工作区管控 / 回收站 / 风控与画像 / MCP任务 / 规则管理

Work Log:
- Server Actions 6 文件 50 个 action：network（代理/Steel/宿主机 CRUD+健康探测+灰度切换+批量启停，proxy 密码 encrypt 落库，探测失败≥3次 FAILED/ISOLATED+raiseAlert，宿主机水位 CPU>80/磁盘>85 告警）、admin-workspaces（7 种强制操作：停止/重启（销毁+按原配置重建，novnc 密钥加密）/回收/物理删除（会话同步销毁+共享清理+DANGER 审计）/断 VNC/改TTL/转移 + 6 种批量逐条 try/catch 结果报告+trackBehavior BATCH）、recycle（恢复/清除/锁定/延期/五操作批量/一键清空 PURGE ALL 强确认）、risk（黑白名单 CRUD+过期解封+一键清理）、mcp-admin（详情含子项50/取消/重试入队，不做执行引擎）、rules（UA 池导入导出 JSON/域名规则/请求篡改三类型条件校验，ModifyRule 软删不进回收站）
- 页面 6 模块 12 客户端组件：/admin/network 三页签（internal_singbox 编辑引导 SingBox 管理；宿主机超阈值行红高亮自绘表格）、/admin/workspaces（批量工具栏+DESTROY 双强确认+批量失败明细弹窗+所有者文本筛选）、/admin/recycle（未恢复/已恢复双页签+删除来源三色+锁定保护）、/admin/risk（黑白名单+行为画像 riskTriggers 默认降序红高亮）、/admin/mcp（进度条+详情弹窗参数/结果/失败原因/子项）、/admin/rules（UA/域名/篡改三页签+模板绑定）
- 关键坑：①批量调用单 action 时 actionHandler 吞异常返回 code!=0 不抛出——循环必须检查 res.code；②DataTable 无行级 className，红高亮行改自绘表格；③新建路由首访 404（Turbopack 编译竞态）且文件夹名禁 _ 前缀（private folder）；④purgeAllRecycle 会真删底层资源（演示数据需重种子）；⑤tsc --noEmit 全量跑完再次拖垮 dev server，setsid 双 fork 拉起（复现 C 的坑）
- 种子演示数据：代理4（含 internal 关联 singbox 实例 sim 地址）/Steel3/宿主机2（含一台超阈值）/工作区4（RUNNING×2+ERROR+STOPPED）/MCP任务3+子项7/风控规则6/域名3/篡改3/回收站3（三种删除来源+锁定样例）/行为画像 demo 风控触发
- 验证：临时端点 79 步冒烟（正例46+负例23+状态机断言12）全过——含 internal 编辑拦截/绑定删除拦截/转移自己拦截/锁定清除拦截/重复恢复拦截/恢复双路径（软删update+硬删快照重建原UUID）；42 种 operationType 审计落库+强停/物删告警；35 个 URL 组合 200；匿名 307；lint/tsc 本任务文件 0 错误；dev.log 0 ⨯；测试端点已删除

Stage Summary:
- 网络运维六模块（节点/工作区/回收站/风控/MCP/规则）全部就绪；细节经验沉淀 agent-ctx/D-network-workspace-recycle-risk-mcp-rules.md（批量action返回码检查/自绘高亮表格/恢复双路径/purgeAll副作用）
