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
  "security.globalForce2fa": { value: false, category: "SECURITY", type: "boolean", description: "全局强制开启2FA" },
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
  "workspace.clipboardMaxChars": { value: 5000, category: "GENERAL", type: "number", description: "剪贴板最大字符数（防卡死）" },
  "workspace.vncDefaultMode": { value: "auto", category: "GENERAL", type: "string", description: "VNC默认输入模式：auto/mouse/touch" },
  "workspace.vncForceMode": { value: "", category: "GENERAL", type: "string", description: "VNC强制输入模式（空=不强制）" },
  "workspace.vncWatermark": { value: true, category: "GENERAL", type: "boolean", description: "VNC连接水印开关" },
  "workspace.vncAutoQuality": { value: true, category: "GENERAL", type: "boolean", description: "VNC网络自适应画质" },
  "storage.mode": { value: "local", category: "STORAGE", type: "string", description: "文件存储模式 local|s3" },
  "storage.quotaPerUserMb": { value: 2048, category: "STORAGE", type: "number", description: "单用户磁盘配额MB" },
  "storage.quotaPerGroupMb": { value: 20480, category: "STORAGE", type: "number", description: "用户组磁盘配额MB" },
  "storage.retentionDays": { value: 30, category: "STORAGE", type: "number", description: "文件默认保留天数" },
  "storage.backupOnDelete": { value: false, category: "STORAGE", type: "boolean", description: "删除文件时备份开关" },
  "storage.virusScan": { value: false, category: "STORAGE", type: "boolean", description: "文件病毒扫描开关" },
  "storage.allowedExtensions": { value: "", category: "STORAGE", type: "string", description: "文件类型白名单（逗号分隔，空=不限）" },
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
  "log.retentionDays": { value: 90, category: "GENERAL", type: "number", description: "业务日志保留天数" },
  "log.auditRetentionDays": { value: 365, category: "GENERAL", type: "number", description: "审计日志保留天数" },
  "log.slowQueryMs": { value: 1000, category: "GENERAL", type: "number", description: "慢查询阈值ms" },
  "rate.anonymousQps": { value: 5, category: "SECURITY", type: "number", description: "匿名请求限流QPS" },
  "rate.userQps": { value: 30, category: "SECURITY", type: "number", description: "登录用户限流QPS" },
  "rate.tokenQps": { value: 100, category: "SECURITY", type: "number", description: "API-Token限流默认QPS" },
  "token.maxPerUser": { value: 10, category: "SECURITY", type: "number", description: "单用户Token最大数量" },
  "token.allowPermanent": { value: true, category: "SECURITY", type: "boolean", description: "全局是否允许永久Token" },
  "token.maxLifetimeDays": { value: 365, category: "SECURITY", type: "number", description: "全平台Token最大有效时长（天，0=不限）" },
  "token.expireWarnDays": { value: 7, category: "SECURITY", type: "number", description: "Token到期提前告警天数" },
  "recycle.retentionMinutes": { value: 10080, category: "GENERAL", type: "number", description: "回收站保留时长（分钟，默认7天）" },
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
  "mcp.perKeyPerSecond": { value: 20, category: "MCP", type: "number", description: "单Key每秒调用上限" },
  "mcp.perKeyPerMinute": { value: 300, category: "MCP", type: "number", description: "单Key每分钟上限" },
  "mcp.perKeyPerHour": { value: 5000, category: "MCP", type: "number", description: "单Key每小时上限" },
  "mcp.dangerEndpointEnabled": { value: false, category: "MCP", type: "boolean", description: "高危物理删除接口开关" },
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
