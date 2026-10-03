// ============================================================
// 全局搜索「功能与设置」目录（r25-a 命令面板化）
//
// 语义：全局搜索不止搜资源（工作区/用户/审计…），还能搜【当前账号可用的所有功能】：
//   · 页面直达（按角色过滤：普通用户只见工作台+个人中心；管理员另见全部后台页）
//   · 设置项直达（CONFIG_DEFAULTS 动态生成 ~120 条，深链 /admin/config?tab=X&key=Y）
//   · 高频动作（新建沙箱 /workspaces?create=1 等）
// 匹配：标题 / 描述 / 关键词同义词（不区分大小写，contains 语义）
// 服务端在 /api/search 中按 ctx.role 过滤后下发，前端零权限判断。
// ============================================================

import { CONFIG_DEFAULTS } from "@/lib/config"

export type FunctionRole = "USER" | "GROUP_ADMIN" | "ADMIN" | "SUPER_ADMIN"

export interface SearchableFunction {
  id: string
  title: string
  desc: string
  href: string
  group: string // 分组标签（展示用）
  keywords: string[]
  roles: FunctionRole[] // 可见角色
}

const ALL: FunctionRole[] = ["USER", "GROUP_ADMIN", "ADMIN", "SUPER_ADMIN"]
const ADMIN_ROLES: FunctionRole[] = ["GROUP_ADMIN", "ADMIN", "SUPER_ADMIN"]
const SENIOR: FunctionRole[] = ["ADMIN", "SUPER_ADMIN"]

// ---- 页面与高频动作（人工精选 + 同义词扩充）----
const PAGE_ENTRIES: SearchableFunction[] = [
  // 工作台
  { id: "p-dashboard", title: "仪表盘", desc: "平台总览：资产统计、近期动态、快捷入口", href: "/dashboard", group: "工作台", keywords: ["首页", "总览", "overview", "dashboard", "概览", "统计"], roles: ALL },
  { id: "p-workspaces", title: "浏览器工作区", desc: "我的沙箱列表：创建 / 启动 / VNC 接入 / 共享", href: "/workspaces", group: "工作台", keywords: ["沙箱", "浏览器", "工作区", "workspace", "vnc", "远程浏览器", "sandbox", "打开浏览器"], roles: ALL },
  { id: "p-workspace-create", title: "新建工作区（沙箱）", desc: "一键创建隔离浏览器沙箱", href: "/workspaces?create=1", group: "工作台", keywords: ["新建沙箱", "创建沙箱", "新建工作区", "创建工作区", "创建浏览器", "new workspace", "create"], roles: ALL },
  { id: "p-templates", title: "会话模板", desc: "预置规格（分辨率/代理/首页）快速创建沙箱", href: "/templates", group: "工作台", keywords: ["模板", "template", "规格", "预设"], roles: ALL },
  { id: "p-snapshots", title: "Profile 快照", desc: "浏览器资料归档：导出 / 恢复 / 过期管理", href: "/snapshots", group: "工作台", keywords: ["快照", "snapshot", "profile", "归档", "备份资料"], roles: ALL },
  { id: "p-announcements", title: "平台公告", desc: "平台通知与公告（弹窗/跑马灯/常驻）", href: "/announcements", group: "工作台", keywords: ["公告", "通知", "announcement", "notice"], roles: ALL },
  { id: "p-my-recordings", title: "我的录像", desc: "我的工作区 VNC 会话录像：回放 / 下载（用户空间）", href: "/recordings", group: "工作台", keywords: ["我的录像", "录像", "回放", "录屏", "my recording", "会话录像", "播放"], roles: ALL },
  { id: "p-my-files", title: "我的文件", desc: "专属文件空间：编辑器 / 预览 / 上传下载 / 分享链接", href: "/files", group: "工作台", keywords: ["我的文件", "文件", "上传", "下载", "分享", "编辑器", "files", "网盘", "云盘"], roles: ALL },
  { id: "p-my-browsing", title: "我的浏览数据", desc: "本人沙箱的浏览历史 / 书签（沙箱隔离）", href: "/browsing", group: "工作台", keywords: ["浏览历史", "历史记录", "书签", "收藏", "我的浏览", "history", "bookmark"], roles: ALL },

  // 个人中心
  { id: "a-profile", title: "个人资料", desc: "头像 / 昵称 / 主题偏好 / 配额总览", href: "/account/profile", group: "个人中心", keywords: ["资料", "头像", "昵称", "主题", "偏好", "profile"], roles: ALL },
  { id: "a-security", title: "账号安全", desc: "修改密码 / 两步验证（2FA）/ 备份码 / 信任设备", href: "/account/security", group: "个人中心", keywords: ["密码", "改密码", "2fa", "两步验证", "双因素", "totp", "otp", "安全", "security", "备份码"], roles: ALL },
  { id: "a-sessions", title: "登录设备", desc: "在线会话管理：查看 / 下线 / 撤销信任 / 删除记录", href: "/account/sessions", group: "个人中心", keywords: ["设备", "登录记录", "下线", "会话", "device", "session", "踢下线"], roles: ALL },
  { id: "a-tokens", title: "我的 API 令牌", desc: "API-Key 管理：创建 / 权限范围 / 分钟限流", href: "/account/tokens", group: "个人中心", keywords: ["api", "令牌", "token", "key", "密钥", "apikey", "接口"], roles: ALL },
  { id: "a-audit", title: "我的操作审计", desc: "本人最近操作记录（登录/操作/安全事件）", href: "/audit", group: "个人中心", keywords: ["我的审计", "操作记录", "审计"], roles: ALL },

  // 管理后台
  { id: "m-users", title: "用户管理", desc: "账号全生命周期：创建/启禁/配额/2FA/批量导入导出", href: "/admin/users", group: "管理后台", keywords: ["用户", "账号", "user", "成员", "批量导入", "csv"], roles: ADMIN_ROLES },
  { id: "m-groups", title: "用户组管理", desc: "树形组织：组员/组管理员/权限锁/代理绑定", href: "/admin/groups", group: "管理后台", keywords: ["用户组", "组", "group", "组织", "部门", "成员组"], roles: ADMIN_ROLES },
  { id: "m-policies", title: "策略下发中心", desc: "按用户/组批量下发网络与访问策略 + 灰度 + 回滚", href: "/admin/policies", group: "管理后台", keywords: ["策略", "下发", "policy", "灰度", "批量下发", "访问控制"], roles: ADMIN_ROLES },
  { id: "m-crx", title: "CRX 插件管控", desc: "插件库 / 五级策略合并 / 安装状态 / 扩展审计", href: "/admin/crx", group: "管理后台", keywords: ["插件", "扩展", "crx", "chrome插件", "extension", "插件库", "扩展审计"], roles: ADMIN_ROLES },
  { id: "m-sessions", title: "在线会话管控", desc: "全部在线会话：查看 / 强制下线 / 批量管理", href: "/admin/sessions", group: "管理后台", keywords: ["在线", "会话管控", "online", "强制下线", "踢人"], roles: ADMIN_ROLES },
  { id: "m-recordings", title: "录像管理", desc: "VNC 会话录像审计：回放 / 下载 / 取证备注 / 回收站", href: "/admin/recordings", group: "管理后台", keywords: ["录像", "录屏", "回放", "播放", "video", "recording", "会话录像", "审计录像", "取证"], roles: ADMIN_ROLES },
  { id: "m-dfs", title: "分布式文件存储", desc: "9 大条件路由：沙箱绑定落地/10MB直沉/中转24h/冷热分层/水位调度/多副本/修复/随迁", href: "/admin/dfs", group: "管理后台", keywords: ["分布式存储", "文件对象", "副本", "冷热分层", "水位", "中转", "直沉", "dfs", "存储"], roles: ADMIN_ROLES },
  { id: "m-monitor-center", title: "实时监控中心", desc: "16 宫格沙箱画面轮巡 / 远程键鼠注入 / 强制跳转 / 消息推送 / 双模式监控授权", href: "/admin/monitor", group: "管理后台", keywords: ["监控", "实时监控", "宫格", "轮巡", "远程控制", "键鼠", "注入", "强制跳转", "消息推送", "监视", "monitor"], roles: ADMIN_ROLES },
  { id: "m-hardware-perms", title: "硬件权限管控", desc: "17 项硬件权限四级链（摄像头/麦克风/定位/剪贴板/USB…）全局默认档", href: "/admin/config?tab=HARDWARE&key=hardware.defaults", group: "管理后台", keywords: ["硬件权限", "摄像头", "麦克风", "定位", "蓝牙", "usb", "串口", "传感器", "剪贴板", "hardware", "权限"], roles: ADMIN_ROLES },
  { id: "m-browsing", title: "浏览数据管理", desc: "全站浏览历史 / 书签明文库：筛选 / 搜索 / 导出 / 批量", href: "/admin/browsing", group: "管理后台", keywords: ["浏览历史", "历史", "书签", "明文", "访问记录", "用户浏览", "上网行为"], roles: ADMIN_ROLES },
  { id: "m-worknodes", title: "Worker 节点", desc: "Master/Worker 分布式：节点注册 / 心跳监控 / 驱逐", href: "/admin/worknodes", group: "平台运维", keywords: ["worker", "节点", "分布式", "集群", "心跳", "注册", "驱逐", "region"], roles: ADMIN_ROLES },
  { id: "m-feature-flags", title: "功能开关", desc: "全平台功能型开关总览：一键启停 / 版本快照 / 审计", href: "/admin/feature-flags", group: "管理后台", keywords: ["功能开关", "开关", "feature", "flag", "启停", "禁用功能", "功能治理"], roles: ADMIN_ROLES },
  { id: "m-permissions", title: "权限中心", desc: "30 项权限锁三级分配矩阵（全局/用户组/用户）+ 沙箱级策略入口", href: "/admin/permissions", group: "管理后台", keywords: ["权限中心", "权限锁", "permission", "锁死", "禁止创建", "禁止导出", "权限分配", "权限矩阵", "block"], roles: ADMIN_ROLES },
  { id: "m-workspaces", title: "工作区管控", desc: "全部用户沙箱：运维操作 / 共享管控 / 冻结封存", href: "/admin/workspaces", group: "管理后台", keywords: ["沙箱管理", "工作区管控", "全部工作区", "admin workspace", "冻结", "封存"], roles: ADMIN_ROLES },

  // 平台运维
  { id: "o-singbox", title: "SingBox 实例", desc: "代理核心编排：可视化配置 / 热更新 / 连通测试", href: "/admin/singbox", group: "平台运维", keywords: ["singbox", "代理核心", "实例", "proxy core"], roles: ADMIN_ROLES },
  { id: "o-network", title: "网络与节点", desc: "代理节点 / 浏览器节点 / 宿主机资源与水位", href: "/admin/network", group: "平台运维", keywords: ["网络", "节点", "代理", "proxy", "node", "宿主机", "host", "负载", "浏览器节点"], roles: ADMIN_ROLES },
  { id: "o-config", title: "系统配置", desc: "全部平台参数：安全/邮件/会话/存储/预警/任务", href: "/admin/config", group: "平台运维", keywords: ["设置", "配置", "config", "参数", "settings", "系统设置"], roles: ADMIN_ROLES },
  { id: "o-tasks", title: "定时任务", desc: "调度中心：内置任务 + 自定义任务（shell/链/webhook）", href: "/admin/tasks", group: "平台运维", keywords: ["定时任务", "任务", "计划任务", "cron", "调度", "自定义任务", "脚本任务"], roles: ADMIN_ROLES },
  { id: "o-files", title: "文件存储", desc: "文件管理：上传 / 扫描 / 下载 / 占用排行", href: "/admin/files", group: "平台运维", keywords: ["文件", "存储", "file", "上传", "下载", "占用"], roles: ADMIN_ROLES },
  { id: "o-backups", title: "备份恢复", desc: "平台备份：创建 / 加密 / 恢复 / 批量删除", href: "/admin/backups", group: "平台运维", keywords: ["备份", "恢复", "backup", "还原", "快照备份"], roles: ADMIN_ROLES },

  // 安全与审计
  { id: "s-audit", title: "审计日志", desc: "全平台审计：操作/安全/CRX 扩展事件 + 导出", href: "/admin/audit", group: "安全与审计", keywords: ["审计", "日志", "audit", "操作日志", "审计日志", "安全事件", "扩展审计"], roles: ADMIN_ROLES },
  { id: "s-alerts", title: "告警中心", desc: "告警列表 / 规则 / WebHook / 通知记录", href: "/admin/alerts", group: "安全与审计", keywords: ["告警", "预警", "alert", "报警", "webhook", "通知", "告警规则"], roles: ADMIN_ROLES },
  { id: "s-ipban", title: "IP 封禁", desc: "封禁记录：手动封禁 / 解封 / 批量管理", href: "/admin/ipban", group: "安全与审计", keywords: ["ip封禁", "封禁", "ban", "解封", "黑名单", "拦截"], roles: ADMIN_ROLES },
  { id: "s-recycle", title: "回收站", desc: "四类回收资源：恢复 / 清除 / 批量操作", href: "/admin/recycle", group: "安全与审计", keywords: ["回收站", "recycle", "恢复删除", "已删除", "清除"], roles: ADMIN_ROLES },
  { id: "s-risk", title: "风控与画像", desc: "黑白名单 / 行为画像 / 风险触发记录", href: "/admin/risk", group: "安全与审计", keywords: ["风控", "画像", "risk", "黑白名单", "行为分析", "封禁名单"], roles: ADMIN_ROLES },
  { id: "s-announcements", title: "公告管理", desc: "发布/编辑平台公告：三范围三展示方式", href: "/admin/announcements", group: "安全与审计", keywords: ["发布公告", "公告管理", "announcement", "通知管理"], roles: ADMIN_ROLES },
  { id: "s-mcp", title: "MCP 任务", desc: "MCP 批量自动化任务：进度 / 取消 / 重试", href: "/admin/mcp", group: "安全与审计", keywords: ["mcp", "批量任务", "自动化", "批量操作"], roles: ADMIN_ROLES },
]

// ---- 高频设置项（人工补充同义词，深链到配置页定位）----
const FEATURED_SETTINGS: SearchableFunction[] = [
  { id: "c-mail", title: "邮件通道（SMTP）", desc: "发件服务器 / 发件人 / 测试发送 / 预警邮件", href: "/admin/config?tab=MAIL", group: "设置项", keywords: ["邮件", "邮箱", "smtp", "发件", "email", "邮件服务器", "发邮件"], roles: ADMIN_ROLES },
  { id: "c-recording", title: "VNC 会话录像开关", desc: "录像总开关 / 帧率 / 分段 / 保留期 / 配额 / 用户可见", href: "/admin/config?tab=GENERAL&key=vnc.recordingEnabled", group: "设置项", keywords: ["录像开关", "开启录像", "录屏", "帧率", "保留期", "录像配额", "回放开关", "recording"], roles: ADMIN_ROLES },
  { id: "c-exitguard", title: "浏览器防退出档位", desc: "normal/fullscreen/kiosk 三档 + 关闭/最小化/菜单退出隐藏说明", href: "/admin/config?tab=GENERAL&key=workspace.exitGuardDefault", group: "设置项", keywords: ["防退出", "退出", "关闭按钮", "最小化", "kiosk", "信息亭", "全屏", "exitguard", "禁止退出"], roles: ADMIN_ROLES },
  { id: "c-alert", title: "预警中心配置", desc: "邮件预警 / CPU / 内存 / 磁盘水位阈值 / 九类功能预警", href: "/admin/config?tab=ALERT", group: "设置项", keywords: ["预警", "阈值", "告警配置", "水位", "邮件提醒", "alert"], roles: ADMIN_ROLES },
  { id: "c-security", title: "安全防护配置", desc: "IP 封禁阈值 / 强制 2FA / 注册开关 / 密码策略", href: "/admin/config?tab=SECURITY", group: "设置项", keywords: ["安全配置", "封禁配置", "2fa", "注册", "密码策略", "security"], roles: ADMIN_ROLES },
  { id: "c-clipboard", title: "剪贴板 VNC 透传开关", desc: "workspace.clipboardVncSync：关闭后沙箱剪贴板不向 VNC 端透传", href: "/admin/config?tab=GENERAL&key=workspace.clipboardVncSync", group: "设置项", keywords: ["剪贴板", "clipboard", "复制粘贴", "透传", "clipboardvncsync"], roles: ADMIN_ROLES },
  { id: "c-shell-exec", title: "自定义任务 Shell 执行开关", desc: "tasks.allowShellExec：自定义定时任务执行脚本的总开关", href: "/admin/config?tab=TASKS&key=tasks.allowShellExec", group: "设置项", keywords: ["shell任务", "执行脚本", "allowshellexec", "自定义任务开关"], roles: ADMIN_ROLES },
  { id: "c-register", title: "开放用户注册", desc: "security.allowRegister：是否允许自注册新账号", href: "/admin/config?tab=SECURITY&key=security.allowRegister", group: "设置项", keywords: ["注册", "allowregister", "开放注册", "自注册"], roles: ADMIN_ROLES },
  { id: "c-force2fa", title: "强制两步验证", desc: "security.globalForce2fa：未绑定 2FA 的账号被硬阻断", href: "/admin/config?tab=SECURITY&key=security.globalForce2fa", group: "设置项", keywords: ["强制2fa", "force2fa", "两步验证强制", "双因素强制", "globalforce2fa"], roles: ADMIN_ROLES },
  { id: "c-maintenance", title: "维护模式", desc: "平台只读 / 维护公告横幅", href: "/admin/config?tab=GENERAL", group: "设置项", keywords: ["维护模式", "只读", "maintenance", "停机维护"], roles: ADMIN_ROLES },
]

// ---- 由 CONFIG_DEFAULTS 动态生成的设置项条目（全量覆盖）----
// 标题 = 配置描述；关键词 = 配置键 + 键的英文片段；深链 = /admin/config?tab=<分类>&key=<键>
function settingsEntries(): SearchableFunction[] {
  const out: SearchableFunction[] = []
  for (const [key, meta] of Object.entries(CONFIG_DEFAULTS)) {
    if (key === "smtp.pass") continue // 敏感项不进搜索索引
    const tab = meta.category
    const seg = key.split(".").map((s) => s.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase())
    out.push({
      id: `cfg-${key}`,
      title: meta.description || key,
      desc: `设置项 ${key}`,
      href: `/admin/config?tab=${tab}&key=${encodeURIComponent(key)}`,
      group: "设置项",
      keywords: [key, ...seg, String(meta.value)],
      roles: meta.category === "MCP" ? SENIOR : ADMIN_ROLES,
    })
  }
  return out
}

let cachedAll: SearchableFunction[] | null = null
function allEntries(): SearchableFunction[] {
  if (!cachedAll) cachedAll = [...PAGE_ENTRIES, ...FEATURED_SETTINGS, ...settingsEntries()]
  return cachedAll
}

function roleAllowed(entry: SearchableFunction, role: string): boolean {
  return entry.roles.includes(role as FunctionRole)
}

export interface FunctionSearchHit {
  id: string
  title: string
  desc: string
  href: string
  group: string
}

// ---- 主入口：按关键词搜功能（角色过滤 + 同义词匹配 + 评分排序）----
export function searchFunctions(q: string, role: string, limit = 30): FunctionSearchHit[] {
  const needle = q.trim().toLowerCase()
  if (!needle) return []
  const hits: (FunctionSearchHit & { score: number })[] = []
  for (const e of allEntries()) {
    if (!roleAllowed(e, role)) continue
    const title = e.title.toLowerCase()
    let score = -1
    if (title.includes(needle)) score = title.startsWith(needle) ? 100 : 80
    else if (e.keywords.some((k) => k.toLowerCase().includes(needle))) score = 60
    else if (e.desc.toLowerCase().includes(needle)) score = 40
    if (score > 0) {
      hits.push({ id: e.id, title: e.title, desc: e.desc, href: e.href, group: e.group, score })
    }
  }
  hits.sort((a, b) => b.score - a.score)
  return hits.slice(0, limit).map(({ score: _s, ...rest }) => rest)
}

// 类型目录探针：该角色可见的功能条目总数（/api/search types 目录用）
export function functionCatalogSize(role: string): number {
  return allEntries().filter((e) => roleAllowed(e, role)).length
}
