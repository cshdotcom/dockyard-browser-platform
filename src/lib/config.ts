import { db } from "./db"
import { deepEqual } from "./utils"
// r38：CONFIG_DEFAULTS/SystemDefaults 抽出至 ./config-defaults（零依赖 —— seed/脚本安全引用）
// 本模块 re-export 保持历史 import 路径兼容；内部使用经本地 import 绑定。
import { CONFIG_DEFAULTS, type SystemDefaults } from "./config-defaults"
export { CONFIG_DEFAULTS }
export type { SystemDefaults }

// 系统配置内存缓存：启动加载全部配置；修改后主动刷新；版本快照 + 完整性校验 + 漂移检测

// 全部默认配置（首次启动自动播种）

type CacheShape = Map<string, { value: unknown; type: string; category: string; version: number }>

const g = globalThis as unknown as { __dockyardConfig?: CacheShape; __dockyardConfigLoadedAt?: number }

function cache(): CacheShape {
  if (!g.__dockyardConfig) g.__dockyardConfig = new Map()
  return g.__dockyardConfig
}

// 启动/按需加载全部配置到内存
// r37：30s TTL —— 多实例/外部写库（Worker 推送、运维直改）场景下配置传播不再依赖进程重启；
//      单机 setConfig 路径仍走 force 即时刷新（无延迟）
const CONFIG_CACHE_TTL_MS = 30_000
export async function ensureConfigLoaded(force = false) {
  const cacheFresh = g.__dockyardConfigLoadedAt !== undefined && Date.now() - g.__dockyardConfigLoadedAt < CONFIG_CACHE_TTL_MS
  if (!force && cacheFresh && g.__dockyardConfig && g.__dockyardConfig.size > 0) return
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
