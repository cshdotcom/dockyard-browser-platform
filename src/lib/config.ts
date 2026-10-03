import { db } from "./db"
import { deepEqual } from "./utils"

// 系统配置内存缓存：启动加载全部配置；修改后主动刷新；版本快照 + 完整性校验 + 漂移检测

export interface SystemDefaults {
  [key: string]: { value: unknown; category: string; type: string; description: string }
}

// 全部默认配置（首次启动自动播种）
export const CONFIG_DEFAULTS: SystemDefaults = {
  "security.allowRegister": { value: true, category: "SECURITY", type: "boolean", description: "是否开放用户注册" },
  "security.requireEmailActivation": { value: false, category: "SECURITY", type: "boolean", description: "新注册账号需要邮箱激活" },
  "security.passwordMinLength": { value: 8, category: "SECURITY", type: "number", description: "密码最小长度" },
  "security.passwordRequireUpper": { value: true, category: "SECURITY", type: "boolean", description: "密码必须包含大写字母" },
  "security.passwordRequireLower": { value: true, category: "SECURITY", type: "boolean", description: "密码必须包含小写字母" },
  "security.passwordRequireDigit": { value: true, category: "SECURITY", type: "boolean", description: "密码必须包含数字" },
  "security.passwordRequireSpecial": { value: false, category: "SECURITY", type: "boolean", description: "密码必须包含特殊符号" },
  "security.passwordBanWeakDict": { value: true, category: "SECURITY", type: "boolean", description: "禁止弱密码字典" },
  "security.passwordHistoryCount": { value: 5, category: "SECURITY", type: "number", description: "禁止复用最近N次历史密码" },
  "security.maxLoginFailures": { value: 5, category: "SECURITY", type: "number", description: "连续密码错误锁定阈值" },
  "security.lockoutMinutes": { value: 15, category: "SECURITY", type: "number", description: "账号锁定时长（分钟）" },
  "security.ipBanEnabled": { value: true, category: "SECURITY", type: "boolean", description: "IP自动封禁开关（登录/API-Key连续失败达到阈值后封禁来源IP）" },
  "security.ipBanThreshold": { value: 10, category: "SECURITY", type: "number", description: "IP封禁阈值：窗口内连续失败次数（登录密码错误/无效API-Key）" },
  "security.ipBanWindowMinutes": { value: 15, category: "SECURITY", type: "number", description: "失败计数窗口（分钟，窗口内累计计数，窗口过后清零）" },
  "security.ipBanMinutes": { value: 30, category: "SECURITY", type: "number", description: "IP封禁时长（分钟，封禁期间拒绝该IP登录与API-Key鉴权）" },
  "security.ipBanApiCountEnabled": { value: true, category: "SECURITY", type: "boolean", description: "API-Key无效调用计入IP封禁计数（正常携带有效Key调用不计）" },
  "security.ipBanAlertEnabled": { value: true, category: "SECURITY", type: "boolean", description: "触发IP封禁时告警（站内+审计+邮件通道）" },
  "security.globalForce2fa": { value: false, category: "SECURITY", type: "boolean", description: "全局强制开启2FA" },
  "security.force2faAdminExempt": { value: false, category: "SECURITY", type: "boolean", description: "强制2FA豁免管理员（开启后 ADMIN/SUPER_ADMIN 不被门控拦截至后台可正常管理）" },
  "security.groupInheritForce2fa": { value: true, category: "SECURITY", type: "boolean", description: "用户组继承强制2FA策略" },
  "security.allowEmailCodeLogin": { value: true, category: "SECURITY", type: "boolean", description: "是否允许邮箱验证码登录" },
  "security.changePasswordRequireTotp": { value: true, category: "SECURITY", type: "boolean", description: "开启2FA时修改密码额外TOTP校验" },
  "security.emailCodeExpireSec": { value: 300, category: "SECURITY", type: "number", description: "邮箱验证码有效期（秒，默认5分钟）" },
  "security.emailCodeSendIntervalSec": { value: 60, category: "SECURITY", type: "number", description: "同一邮箱验证码发送间隔（秒）" },
  "security.emailCodeMaxSendPerHour": { value: 10, category: "SECURITY", type: "number", description: "同一邮箱每小时最多发送次数" },
  "security.remoteLoginAlert": { value: true, category: "SECURITY", type: "boolean", description: "异地新IP登录邮件告警" },
  "security.autoInvalidateTokensOnSecurityChange": { value: false, category: "SECURITY", type: "boolean", description: "账号安全变更时自动作废全部API-Token" },
  "security.defaultAllowInternalNetwork": { value: false, category: "SECURITY", type: "boolean", description: "网络策略全局默认：是否允许访问内网（用户/组未显式设置时生效，默认拒绝）" },
  "security.defaultAllowSecureLocationAccess": { value: false, category: "SECURITY", type: "boolean", description: "网络策略全局默认：是否允许访问容器内安全位置（CDP/VNC端口、file://、平台内部端点，默认拒绝）" },
  "security.trustedDeviceDays": { value: 30, category: "SECURITY", type: "number", description: "受信任设备有效期（天）" },
  "session.maxLifetimeHours": { value: 168, category: "SESSION", type: "number", description: "会话最大存活时间（小时）" },
  "session.idleTimeoutMin": { value: 30, category: "SESSION", type: "number", description: "闲置自动登出（分钟）" },
  "session.shortLivedHours": { value: 12, category: "SESSION", type: "number", description: "未勾选记住我的短期会话时长（小时）" },
  "session.rememberDays": { value: 30, category: "SESSION", type: "number", description: "记住我会话时长（天）" },
  "session.novncIdleTimeoutMin": { value: 30, category: "SESSION", type: "number", description: "NoVNC会话闲置回收（分钟）" },
  "workspace.maxConcurrentSessions": { value: 50, category: "GENERAL", type: "number", description: "全局并发浏览器会话上限" },
  "workspace.maxConcurrentNovnc": { value: 20, category: "GENERAL", type: "number", description: "全局NoVNC会话上限" },
  "workspace.reservedSessions": { value: 5, category: "GENERAL", type: "number", description: "全局预留会话水位（普通用户不可挤占）" },
  "workspace.reservedNovnc": { value: 3, category: "GENERAL", type: "number", description: "全局预留NoVNC水位" },
  "workspace.defaultTtlMinutes": { value: 0, category: "GENERAL", type: "number", description: "工作区默认硬TTL（分钟，0不限）" },
  "workspace.defaultIdleTimeoutMin": { value: 60, category: "GENERAL", type: "number", description: "工作区默认闲置超时（分钟）" },
  "workspace.prewarmEnabled": { value: false, category: "GENERAL", type: "boolean", description: "会话预热池开关" },
  "workspace.prewarmPoolSize": { value: 5, category: "GENERAL", type: "number", description: "预热池水位" },
  "workspace.cdpRateLimitPerMin": { value: 600, category: "GENERAL", type: "number", description: "单工作区CDP指令每分钟上限" },
  "workspace.createRateLimitPerMin": { value: 10, category: "GENERAL", type: "number", description: "单用户每分钟创建工作区上限" },
  "workspace.clipboardGlobal": { value: true, category: "GENERAL", type: "boolean", description: "NoVNC双向剪贴板全局开关" },
  "workspace.clipboardVncSync": { value: true, category: "GENERAL", type: "boolean", description: "VNC 通道 X 剪贴板透传开关（false=该沙箱 x11vnc 以 -nosel -noclipboard 启动，X 剪贴板不向 VNC 端透传；跨沙箱本就独立 X 显示天然隔离）" },
  "workspace.clipboardMaxChars": { value: 5000, category: "GENERAL", type: "number", description: "剪贴板最大字符数（防卡死）" },
  "workspace.vncDefaultMode": { value: "auto", category: "GENERAL", type: "string", description: "VNC默认输入模式：auto/mouse/touch" },
  "workspace.vncForceMode": { value: "", category: "GENERAL", type: "string", description: "VNC强制输入模式（空=不强制）" },
  "workspace.vncWatermark": { value: true, category: "GENERAL", type: "boolean", description: "VNC连接水印开关" },
  "workspace.vncAutoQuality": { value: true, category: "GENERAL", type: "boolean", description: "VNC网络自适应画质" },
  "vnc.sessionMaxMinutes": { value: 0, category: "GENERAL", type: "number", description: "VNC连接总时长全局默认上限（分钟，0=不限；三级策略：沙箱>用户>用户组>此全局默认）" },
  // —— r27：VNC 会话录像（企业级录屏审计）——
  "vnc.recordingEnabled": { value: false, category: "GENERAL", type: "boolean", description: "VNC 会话录像全局开关（四级策略链：沙箱>用户>用户组>此全局默认；开启后新启动的沙箱自动开录）" },
  "vnc.recordingFps": { value: 12, category: "GENERAL", type: "number", description: "录像帧率（fps，6-30；帧率越高越流畅、体积越大）" },
  "vnc.recordingSegmentMinutes": { value: 15, category: "GENERAL", type: "number", description: "录像分段时长（分钟，1-120；每段独立回放，降低单文件损坏风险）" },
  "vnc.recordingMaxMinutes": { value: 0, category: "GENERAL", type: "number", description: "单次会话最长录像时长（分钟，0=不限；到时自动停止该会话录像）" },
  "vnc.recordingRetentionDays": { value: 90, category: "GENERAL", type: "number", description: "录像保留天数（到期自动入回收站，0=永久保留）" },
  "vnc.recordingQuotaGb": { value: 5, category: "GENERAL", type: "number", description: "单用户录像存储配额（GB，0=不限；超额时最旧录像自动入回收站）" },
  "vnc.recordingUserVisible": { value: true, category: "GENERAL", type: "boolean", description: "用户空间是否可见自己的录像（关闭=仅管理后台可见，用户端隐藏）" },
  // —— r28：回放安全（水印/导出）全局默认（沙箱>用户>组>全局 四级链）——
  "vnc.playbackWatermark": { value: "on", category: "GENERAL", type: "string", description: "回放水印默认档：force 强制水印(不可关) | on 默认开(可临时关) | off 关闭" },
  "vnc.playbackAllowExport": { value: false, category: "GENERAL", type: "boolean", description: "回放导出/下载默认策略（false=仅在线回放；用户/组/沙箱可覆盖）" },
  "vnc.recordingManualStop": { value: false, category: "GENERAL", type: "boolean", description: "允许用户在沙箱停止前手动结束自己的录像（false=仅管理员可操作）" },
  "workspace.exitGuardDefault": { value: "fullscreen", category: "GENERAL", type: "string", description: "浏览器防退出默认档位（normal=现状/fullscreen=全屏守卫/kiosk=信息亭最强档；模板可按沙箱覆盖）" },
  "smtp.enabled": { value: false, category: "MAIL", type: "boolean", description: "邮件服务启用（关闭=控制台模拟模式）" },
  "smtp.host": { value: "", category: "MAIL", type: "string", description: "SMTP 服务器地址（后台可改，立即生效）" },
  "smtp.port": { value: 465, category: "MAIL", type: "number", description: "SMTP 端口（465=SSL / 587=STARTTLS）" },
  "smtp.secure": { value: true, category: "MAIL", type: "boolean", description: "是否使用 SSL 直连（465 true / 587 false）" },
  "smtp.user": { value: "", category: "MAIL", type: "string", description: "SMTP 认证用户名" },
  "smtp.pass": { value: "", category: "MAIL", type: "string", description: "SMTP 认证密码（AES 加密存储，界面上脱敏）" },
  "smtp.from": { value: "", category: "MAIL", type: "string", description: "发件人地址（空=使用认证用户名）" },
  "smtp.senderName": { value: "Dockyard 平台", category: "MAIL", type: "string", description: "发件人显示名" },
  "storage.mode": { value: "local", category: "STORAGE", type: "string", description: "文件存储模式 local|s3" },
  "storage.quotaPerUserMb": { value: 2048, category: "STORAGE", type: "number", description: "单用户磁盘配额MB" },
  "storage.quotaPerGroupMb": { value: 20480, category: "STORAGE", type: "number", description: "用户组磁盘配额MB" },
  "storage.retentionDays": { value: 30, category: "STORAGE", type: "number", description: "文件默认保留天数" },
  "storage.backupOnDelete": { value: false, category: "STORAGE", type: "boolean", description: "删除文件时备份开关" },
  "storage.virusScan": { value: false, category: "STORAGE", type: "boolean", description: "文件病毒扫描开关" },
  "storage.allowedExtensions": { value: "", category: "STORAGE", type: "string", description: "文件类型白名单（逗号分隔，空=不限）" },
  // —— r28：文件管理器治理（上传上限/下载限速/上传黑名单）——
  "files.maxUploadMB": { value: 512, category: "STORAGE", type: "number", description: "文件管理器单文件上传上限MB" },
  "files.transferKBps": { value: 0, category: "STORAGE", type: "number", description: "下载传输全局限速KB/s（0=不限；用户/组级可覆盖收紧）" },
  "files.denyExts": { value: "exe,bat,cmd,sh,msi,scr,vbs,js,jar,com,pyc", category: "STORAGE", type: "string", description: "上传禁止扩展名（逗号分隔，空=不限）" },
  "backup.enabled": { value: true, category: "STORAGE", type: "boolean", description: "定时备份开关" },
  "backup.retentionCount": { value: 7, category: "STORAGE", type: "number", description: "备份保留份数" },
  "backup.encrypt": { value: false, category: "STORAGE", type: "boolean", description: "备份AES加密开关" },
  "alert.webhookUrl": { value: "", category: "ALERT", type: "string", description: "全局告警webhook地址" },
  "alert.silenceStart": { value: "23:00", category: "ALERT", type: "string", description: "告警静默窗口开始" },
  "alert.silenceEnd": { value: "07:00", category: "ALERT", type: "string", description: "告警静默窗口结束" },
  "alert.silenceEnabled": { value: false, category: "ALERT", type: "boolean", description: "告警静默窗口开关" },
  "alert.suppressWindowSec": { value: 300, category: "ALERT", type: "number", description: "相同告警合并抑制窗口（秒）" },
  "alert.webhookMaxRetry": { value: 3, category: "ALERT", type: "number", description: "webhook最大重试次数" },
  "alert.criticalWebhookOnly": { value: false, category: "ALERT", type: "boolean", description: "仅严重级别走webhook" },
  // —— r23：邮件告警通道（预警中心：达到级别的告警同步发邮件）——
  "alert.emailEnabled": { value: false, category: "ALERT", type: "boolean", description: "告警邮件通知开关（达到最低级别时同步发送邮件）" },
  "alert.emailMinLevel": { value: "ERROR", category: "ALERT", type: "string", description: "邮件告警最低级别（ERROR=ERROR及以上，CRITICAL=仅严重）" },
  "alert.emailRecipients": { value: "", category: "ALERT", type: "string", description: "邮件告警收件人（逗号分隔邮箱；留空=自动发给全部管理员的邮箱）" },
  // —— r23：宿主机/节点资源预警（阈值可配置；磁盘按 Docker data-root 容器存储位置统计）——
  "alert.hostEnabled": { value: true, category: "ALERT", type: "boolean", description: "宿主机资源水位预警开关（CPU/内存/磁盘超阈值告警+邮件）" },
  "alert.cpuThresholdPct": { value: 80, category: "ALERT", type: "number", description: "CPU使用率预警阈值（%，0-100）" },
  "alert.memThresholdPct": { value: 85, category: "ALERT", type: "number", description: "内存使用率预警阈值（%，0-100）" },
  "alert.diskThresholdPct": { value: 85, category: "ALERT", type: "number", description: "磁盘使用率预警阈值（%，0-100；统计Docker容器存储所在文件系统）" },
  // —— r23：各功能预警开关（逐项可独立启停）——
  "alert.sessionQuotaEnabled": { value: true, category: "ALERT", type: "boolean", description: "全局会话配额水位预警开关" },
  "alert.singboxTrafficEnabled": { value: true, category: "ALERT", type: "boolean", description: "SingBox实例流量超限预警开关" },
  "alert.proxyFailEnabled": { value: true, category: "ALERT", type: "boolean", description: "代理节点故障预警开关" },
  "alert.backupFailEnabled": { value: true, category: "ALERT", type: "boolean", description: "数据库备份异常预警开关" },
  "alert.tokenExpireEnabled": { value: true, category: "ALERT", type: "boolean", description: "Token过期作废/到期提醒开关" },
  "alert.zombieReclaimEnabled": { value: true, category: "ALERT", type: "boolean", description: "僵死会话回收预警开关" },
  "alert.configDriftEnabled": { value: true, category: "ALERT", type: "boolean", description: "配置漂移预警开关" },
  "alert.taskFailEnabled": { value: true, category: "ALERT", type: "boolean", description: "定时任务连续失败预警开关" },
  "alert.quotaUserEnabled": { value: true, category: "ALERT", type: "boolean", description: "用户磁盘配额水位预警开关（超80%提醒）" },
  "log.retentionDays": { value: 90, category: "GENERAL", type: "number", description: "业务日志保留天数" },
  "log.auditRetentionDays": { value: 365, category: "GENERAL", type: "number", description: "审计日志保留天数" },
  "log.slowQueryMs": { value: 1000, category: "GENERAL", type: "number", description: "慢查询阈值ms" },
  "rate.anonymousQps": { value: 5, category: "SECURITY", type: "number", description: "匿名请求限流QPS" },
  "rate.userQps": { value: 30, category: "SECURITY", type: "number", description: "登录用户限流QPS" },
  "rate.tokenQps": { value: 100, category: "SECURITY", type: "number", description: "API-Token限流默认QPS" },
  "token.maxPerUser": { value: 10, category: "SECURITY", type: "number", description: "单用户Token最大数量" },
  "token.allowCreate": { value: true, category: "SECURITY", type: "boolean", description: "全局是否允许创建Token（组级/用户级策略可覆盖收紧）" },
  "token.allowPermanent": { value: true, category: "SECURITY", type: "boolean", description: "全局是否允许永久Token" },
  "token.maxLifetimeDays": { value: 365, category: "SECURITY", type: "number", description: "全平台Token最大有效时长（天，0=不限）" },
  "token.expireWarnDays": { value: 7, category: "SECURITY", type: "number", description: "Token到期提前告警天数" },
  "recycle.retentionMinutes": { value: 10080, category: "GENERAL", type: "number", description: "回收站保留时长（分钟，默认7天）" },
  "recycle.retentionDays": { value: 0, category: "GENERAL", type: "number", description: "回收站保留期全局默认（天；0=沿用旧分钟键/管理员可用组/用户/单条覆盖）" },
  "recycle.recoverWindowHours": { value: 0, category: "GENERAL", type: "number", description: "恢复时效限制（小时，0=不限）" },
  "recycle.userRestoreEnabled": { value: true, category: "GENERAL", type: "boolean", description: "用户自主恢复权限全局开关" },
  "recycle.requireReason": { value: false, category: "GENERAL", type: "boolean", description: "删除强制备注原因" },
  "maintenance.enabled": { value: false, category: "GENERAL", type: "boolean", description: "维护模式开关" },
  "maintenance.message": { value: "系统维护中，创建类操作暂不可用", category: "GENERAL", type: "string", description: "维护提示公告" },
  "readonly.enabled": { value: false, category: "GENERAL", type: "boolean", description: "系统只读模式" },
  "ui.siteName": { value: "Dockyard 浏览器工作平台", category: "UI", type: "string", description: "系统名称" },
  "ui.siteLogo": { value: "", category: "UI", type: "string", description: "系统Logo URL" },
  "ui.loginAnnouncement": { value: "", category: "UI", type: "string", description: "登录页公告" },
  "mcp.enabled": { value: true, category: "MCP", type: "boolean", description: "MCP/OpenAPI网关开关" },
  "share.globalAllow": { value: true, category: "GENERAL", type: "boolean", description: "工作区共享全局开关（false=全员禁止共享；四级管控第4层，用户/组/沙箱级可更精细覆盖）" },
  "mcp.perKeyPerSecond": { value: 20, category: "MCP", type: "number", description: "单Key每秒调用上限" },
  "mcp.perKeyPerMinute": { value: 300, category: "MCP", type: "number", description: "单Key每分钟上限" },
  "mcp.perKeyPerHour": { value: 5000, category: "MCP", type: "number", description: "单Key每小时上限" },
  "mcp.dangerEndpointEnabled": { value: false, category: "MCP", type: "boolean", description: "高危物理删除接口开关" },
  // —— r24-a：自定义任务执行体安全开关 ——
  "tasks.allowShellExec": { value: true, category: "TASKS", type: "boolean", description: "自定义任务 Shell 脚本执行体总开关（false=保存仍可，但执行时一律拒绝；危险黑名单不受此开关影响恒生效）" },
  "tasks.webhookAllowPrivate": { value: false, category: "TASKS", type: "boolean", description: "Webhook 任务允许内网/私网目标（默认拦截防 SSRF；需调用内网服务时由超管开启）" },
  "proxy.healthCheckIntervalSec": { value: 60, category: "NETWORK", type: "number", description: "代理健康探测间隔（秒）" },
  "proxy.probeTimeoutMs": { value: 5000, category: "NETWORK", type: "number", description: "代理探测超时（ms）" },
  "env.overrideDbConfig": { value: false, category: "GENERAL", type: "boolean", description: "环境变量覆盖数据库配置开关" },
}

type CacheShape = Map<string, { value: unknown; type: string; category: string; version: number }>

const g = globalThis as unknown as { __dockyardConfig?: CacheShape; __dockyardConfigLoadedAt?: number }

function cache(): CacheShape {
  if (!g.__dockyardConfig) g.__dockyardConfig = new Map()
  return g.__dockyardConfig
}

// 启动/按需加载全部配置到内存
export async function ensureConfigLoaded(force = false) {
  if (!force && g.__dockyardConfig && g.__dockyardConfig.size > 0) return
  const rows = await db.systemConfig.findMany()
  const m: CacheShape = new Map()
  for (const row of rows) {
    m.set(row.key, { value: JSON.parse(row.valueJson), type: row.valueType, category: row.category, version: row.version })
  }
  // 环境变量覆盖（env.overrideDbConfig 开启时）
  const envOverride = process.env.CONFIG_OVERRIDE === "true"
  if (envOverride) {
    for (const key of m.keys()) {
      const envKey = "DY_" + key.toUpperCase().replace(/\./g, "_")
      if (process.env[envKey] !== undefined) {
        const t = m.get(key)!.type
        const v = process.env[envKey]
        m.get(key)!.value = t === "boolean" ? v === "true" : t === "number" ? Number(v) : v
      }
    }
  }
  g.__dockyardConfig = m
  g.__dockyardConfigLoadedAt = Date.now()
}

// 播种默认配置（幂等）
export async function seedConfig() {
  for (const [key, def] of Object.entries(CONFIG_DEFAULTS)) {
    await db.systemConfig.upsert({
      where: { key },
      update: {},
      create: {
        key,
        valueJson: JSON.stringify(def.value),
        category: def.category,
        valueType: def.type,
        description: def.description,
      },
    })
  }
  await ensureConfigLoaded(true)
}

export async function getConfig<T>(key: string, fallback?: T): Promise<T> {
  await ensureConfigLoaded()
  const hit = cache().get(key)
  if (!hit) return (fallback ?? (CONFIG_DEFAULTS[key]?.value as T)) ?? (false as unknown as T)
  return hit.value as T
}

export async function getConfigNumber(key: string, fallback = 0): Promise<number> {
  const v = await getConfig<unknown>(key, fallback)
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

export async function getConfigBool(key: string, fallback = false): Promise<boolean> {
  const v = await getConfig<unknown>(key, fallback)
  return v === true || v === "true"
}

export async function getAllConfig(): Promise<{ key: string; value: unknown; type: string; category: string; description?: string; version: number }[]> {
  await ensureConfigLoaded()
  const rows = await db.systemConfig.findMany({ orderBy: [{ category: "asc" }, { key: "asc" }] })
  return rows.map((r) => ({ key: r.key, value: JSON.parse(r.valueJson), type: r.valueType, category: r.category, description: r.description ?? undefined, version: r.version }))
}

// 配置完整性校验：字段缺失、数值越界直接拒绝写入
export function validateConfigValue(key: string, value: unknown): { ok: boolean; message?: string; normalized: unknown } {
  const def = CONFIG_DEFAULTS[key]
  const type = def?.type
  if (type === "number") {
    const n = Number(value)
    if (!Number.isFinite(n)) return { ok: false, message: "数值格式非法", normalized: value }
    if (n < 0) return { ok: false, message: "数值不能为负数", normalized: value }
    return { ok: true, normalized: Math.round(n * 1000) / 1000, }
  }
  if (type === "boolean") {
    const b = value === true || value === "true"
    return { ok: true, normalized: b }
  }
  const s = String(value ?? "")
  if (s.length > 2000) return { ok: false, message: "配置值过长", normalized: s }
  return { ok: true, normalized: s }
}

// 写配置：版本快照 + 内存刷新 + 审计（由调用方记录审计）
export async function setConfig(key: string, value: unknown, operatorUserId?: string) {
  const check = validateConfigValue(key, value)
  if (!check.ok) throw new Error(check.message || "配置校验失败")
  const before = await db.systemConfig.findUnique({ where: { key } })
  const version = (before?.version ?? 0) + 1
  await db.systemConfig.upsert({
    where: { key },
    update: { valueJson: JSON.stringify(check.normalized), version, updatedByUserId: operatorUserId ?? null },
    create: {
      key,
      valueJson: JSON.stringify(check.normalized),
      category: CONFIG_DEFAULTS[key]?.category || "GENERAL",
      valueType: CONFIG_DEFAULTS[key]?.type || typeof check.normalized,
      version: 1,
      updatedByUserId: operatorUserId ?? null,
    },
  })
  await db.configVersion.create({
    data: {
      configKey: key,
      version,
      beforeJson: before?.valueJson ?? null,
      afterJson: JSON.stringify(check.normalized),
      operatorUserId: operatorUserId ?? null,
    },
  })
  await ensureConfigLoaded(true)
  return { key, before: before ? JSON.parse(before.valueJson) : null, after: check.normalized, version }
}

// 回滚到历史版本
export async function rollbackConfig(key: string, version: number, operatorUserId?: string) {
  const ver = await db.configVersion.findFirst({ where: { configKey: key, version } })
  if (!ver || !ver.afterJson) throw new Error("版本不存在")
  return setConfig(key, JSON.parse(ver.afterJson), operatorUserId)
}

// 配置漂移检测：数据库与内存快照比对（定时任务调用）
export async function detectConfigDrift(): Promise<string[]> {
  const rows = await db.systemConfig.findMany()
  const drifted: string[] = []
  for (const row of rows) {
    const mem = cache().get(row.key)
    if (!mem) continue
    if (!deepEqual(mem.value, JSON.parse(row.valueJson))) drifted.push(row.key)
  }
  return drifted
}

export function deepEqualNotNeeded() { return deepEqual } // re-export helper reference
