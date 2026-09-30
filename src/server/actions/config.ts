"use server"

// 系统配置 Server Actions：仅超级管理员可写（管理员可查看）
// 注意：配置面是维护/只读模式的控制开关本身，若调用 requireWritableMode 会导致维护模式下无法关闭维护模式（死锁），
// 因此配置写入只做角色校验（SUPER_ADMIN），不做可写模式拦截。

import { z } from "zod"
import { db } from "@/lib/db"
import { actionHandler, type ActionResult } from "@/lib/api"
import { requireRole } from "@/lib/permissions"
import { writeAudit } from "@/lib/audit"
import { zodValidate } from "@/lib/validators"
import { setConfig, rollbackConfig, CONFIG_DEFAULTS } from "@/lib/config"
import { bizError, ErrorCode } from "@/lib/errors"
import { verifySmtpConnection, invalidateSmtpCache, encryptSmtpPassword } from "@/lib/email"

// ---- 1. 保存配置（单项或批量整体保存） ----

const zConfigValue = z.union([z.string().max(2000), z.number(), z.boolean()])

const setConfigSchema = z.object({
  items: z
    .array(z.object({ key: z.string().min(1).max(100), value: zConfigValue }))
    .min(1, "至少包含一个配置项")
    .max(50, "单次最多保存50个配置项"),
})

export interface ConfigUpdateResult {
  key: string
  before: unknown
  after: unknown
  version: number
}

export async function setConfigAction(
  input: unknown
): Promise<ActionResult<{ updated: string[]; results: ConfigUpdateResult[] }>> {
  return actionHandler(async () => {
    const ctx = await requireRole(["SUPER_ADMIN"])
    const p = zodValidate(setConfigSchema, input)

    // 校验 key 合法性：必须在默认配置清单或已存在于库中（防止写入野键）
    const results: ConfigUpdateResult[] = []
    for (const item of p.items) {
      const existsInDb = await db.systemConfig.findUnique({ where: { key: item.key }, select: { key: true } })
      if (!CONFIG_DEFAULTS[item.key] && !existsInDb) {
        throw bizError(ErrorCode.PARAM_ERROR, `未知配置项：${item.key}`)
      }
      // setConfig 内部完成：数值校验/精度对齐 + 版本快照 + 内存缓存刷新
      const r = await setConfig(item.key, item.value, ctx.userId)
      results.push({ key: r.key, before: r.before, after: r.after, version: r.version })
      await writeAudit({
        operatorUserId: ctx.userId,
        operatorName: ctx.username,
        operationType: "CONFIG_UPDATE",
        resourceType: "CONFIG",
        resourceId: item.key,
        resourceName: item.key,
        before: { value: r.before },
        after: { value: r.after, version: r.version },
        severity: item.key.startsWith("security.") || item.key.startsWith("maintenance.") || item.key.startsWith("readonly.") ? "WARN" : "INFO",
        extra: { batchSize: p.items.length },
      })
    }
    return { updated: results.map((r) => r.key), results }
  })
}

// ---- 2. 回滚配置到历史版本 ----

const rollbackSchema = z.object({
  key: z.string().min(1).max(100),
  version: z.number().int().min(1),
})

export async function rollbackConfigAction(
  input: unknown
): Promise<ActionResult<{ key: string; before: unknown; after: unknown; version: number; rollbackTo: number }>> {
  return actionHandler(async () => {
    const ctx = await requireRole(["SUPER_ADMIN"])
    const p = zodValidate(rollbackSchema, input)

    const current = await db.systemConfig.findUnique({ where: { key: p.key } })
    if (!current) throw bizError(ErrorCode.NOT_FOUND, "配置项不存在")
    if (current.version === p.version) {
      throw bizError(ErrorCode.CONFLICT, "该版本即当前生效版本，无需回滚")
    }
    const ver = await db.configVersion.findFirst({ where: { configKey: p.key, version: p.version } })
    if (!ver || !ver.afterJson) throw bizError(ErrorCode.NOT_FOUND, "历史版本不存在")

    const r = await rollbackConfig(p.key, p.version, ctx.userId)
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "CONFIG_ROLLBACK",
      resourceType: "CONFIG",
      resourceId: p.key,
      resourceName: p.key,
      before: { value: JSON.parse(current.valueJson), version: current.version },
      after: { value: r.after, version: r.version, rollbackTo: p.version },
      severity: "WARN",
    })
    return { key: r.key, before: r.before, after: r.after, version: r.version, rollbackTo: p.version }
  })
}

// ---- 3. SMTP 邮箱服务器配置（后台可改，保存后 30 秒内热生效） ----
// 密码 AES 加密落库；保存后立即清空邮件传输器缓存；全部写审计
const smtpSchema = z.object({
  enabled: z.boolean(),
  host: z.string().max(200).regex(/^[a-zA-Z0-9._:-]*$/, "服务器地址格式非法"),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean(),
  user: z.string().max(200),
  pass: z.string().max(500), // 空字符串=不修改现有密码
  from: z.string().max(200),
  senderName: z.string().max(100),
})

export async function setSmtpConfigAction(input: unknown): Promise<ActionResult<{ updatedKeys: string[]; masked: { host: string; user: string } }>> {
  return actionHandler(async () => {
    const ctx = await requireRole(["SUPER_ADMIN"])
    const p = zodValidate(smtpSchema, input)
    if (p.enabled && !p.host) throw bizError(ErrorCode.PARAM_ERROR, "启用邮件服务必须填写 SMTP 服务器地址")

    const items: { key: string; value: string | number | boolean }[] = [
      { key: "smtp.enabled", value: p.enabled },
      { key: "smtp.host", value: p.host },
      { key: "smtp.port", value: p.port },
      { key: "smtp.secure", value: p.secure },
      { key: "smtp.user", value: p.user },
      { key: "smtp.from", value: p.from },
      { key: "smtp.senderName", value: p.senderName },
    ]
    // 密码：空=保留现状；非空=加密后落库（界面永不明文回显）
    if (p.pass) items.push({ key: "smtp.pass", value: encryptSmtpPassword(p.pass) })

    for (const item of items) {
      const r = await setConfig(item.key, item.value, ctx.userId)
      await writeAudit({
        operatorUserId: ctx.userId, operatorName: ctx.username,
        operationType: "SMTP_CONFIG_UPDATE", resourceType: "CONFIG",
        resourceId: item.key, resourceName: item.key,
        before: { value: item.key === "smtp.pass" ? "（密码不回显）" : r.before },
        after: { value: item.key === "smtp.pass" ? "（AES 加密落库）" : r.after, version: r.version },
        severity: "WARN",
      })
    }
    invalidateSmtpCache()
    const masked = { host: p.host, user: p.user ? `${p.user.slice(0, 2)}***${p.user.slice(-2)}` : "" }
    return { updatedKeys: items.map((i) => i.key), masked }
  })
}

// ---- 4. SMTP 测试（真实连接握手 + 可选发送测试邮件；普通管理员可用） ----
export async function testSmtpAction(input: unknown): Promise<ActionResult<{ ok: boolean; verified: boolean; sent: boolean; message: string; source: string }>> {
  return actionHandler(async () => {
    const ctx = await requireRole(["SUPER_ADMIN", "ADMIN"])
    const { to } = zodValidate(z.object({ to: z.string().email().optional().or(z.literal("")) }), input)
    invalidateSmtpCache() // 测试前强制重建传输器（最新配置）
    const result = await verifySmtpConnection(to || undefined)
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username,
      operationType: "SMTP_TEST", resourceType: "CONFIG", resourceId: "smtp",
      after: { ok: result.ok, verified: result.verified, sent: result.sent, target: to || null, source: result.source },
      severity: result.ok ? "INFO" : "WARN",
    })
    return result
  })
}
