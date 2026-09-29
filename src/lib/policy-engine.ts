// ============================================================
// 策略下发中心（管理员按用户/用户组批量下发访问控制策略）
// 策略包内容：
//   · allowInternalNetwork        允许访问内网（null=不修改）
//   · allowSecureLocationAccess   允许访问容器内安全位置（null=不修改）
//   · domainRules                 域名黑白名单（null=不修改；替换目标作用域全部规则）
//   · ipRules                     IP 黑白名单（null=不修改；替换目标作用域全部规则）
//   · endpointRules               端点级精确限制 host:port（null=不修改；替换目标作用域全部规则）
// 定时生效（SCHEDULED）：
//   · effectiveAt 指定未来时刻 → 批次 PENDING 落库，不立即变更
//   · 定时任务 policy_deployment_activation（每分钟）到点自动激活执行
//   · 激活前可取消（CANCELLED）；激活后照常支持快照回滚
// 安全模型：
//   · ADMIN/SUPER_ADMIN：任意用户/用户组
//   · GROUP_ADMIN：仅本组及组内用户（越权目标整批拒绝）
//   · 全量前置快照 → 一键回滚；逐目标失败隔离；审计 + 安全事件 + 影响面统计
// ============================================================

import { zodValidate, zId } from "@/lib/validators"
import { z } from "zod"
import { adminGroupIds } from "@/lib/permissions"
import { db } from "@/lib/db"
import { writeAudit, writeSecurityEvent } from "@/lib/audit"
import { rateLimit } from "@/lib/rate-limit"
import { normalizeDomainPattern } from "@/lib/domain-policy"
import { normalizeEndpointPattern } from "@/lib/endpoint-policy"

// ---- 策略包结构 ----
export interface PolicyBundle {
  allowInternalNetwork: boolean | null
  allowSecureLocationAccess: boolean | null
  domainRules: { mode: "BLACKLIST" | "WHITELIST"; patterns: string[] } | null
  ipRules: { mode: "BLACKLIST" | "WHITELIST"; values: string[] } | null
  endpointRules: { mode: "BLACKLIST" | "WHITELIST"; patterns: string[] } | null
}

export const bundleSchema = z.object({
  allowInternalNetwork: z.boolean().nullable().default(null),
  allowSecureLocationAccess: z.boolean().nullable().default(null),
  domainRules: z
    .object({
      mode: z.enum(["BLACKLIST", "WHITELIST"]),
      patterns: z.array(z.string().min(1).max(253)).max(200),
    })
    .nullable()
    .default(null),
  ipRules: z
    .object({
      mode: z.enum(["BLACKLIST", "WHITELIST"]),
      values: z.array(z.string().min(1).max(64)).max(100),
    })
    .nullable()
    .default(null),
  endpointRules: z
    .object({
      mode: z.enum(["BLACKLIST", "WHITELIST"]),
      patterns: z.array(z.string().min(1).max(253)).max(200),
    })
    .nullable()
    .default(null),
})

export const deploySchema = z.object({
  name: z.string().min(1, "下发批次名称不能为空").max(120),
  note: z.string().max(500).optional().nullable(),
  bundle: bundleSchema,
  targetUserIds: z.array(zId).max(200).default([]),
  targetGroupIds: z.array(zId).max(100).default([]),
  // 定时生效：ISO / datetime-local 字符串；留空 = 立即生效
  effectiveAt: z.string().min(4).max(40).optional().nullable(),
})

// ---- 生效时间解析 ----
export function parseEffectiveAt(raw?: string | null): { mode: "IMMEDIATE" | "SCHEDULED"; at: Date | null; error?: string } {
  if (!raw || !raw.trim()) return { mode: "IMMEDIATE", at: null }
  // datetime-local（无时区后缀）按服务器本地时区解析；ISO 带时区则按绝对时刻
  const t = Date.parse(raw.trim())
  if (Number.isNaN(t)) return { mode: "IMMEDIATE", at: null, error: "定时生效时间格式不正确（需 ISO 或 datetime-local 格式）" }
  const now = Date.now()
  if (t < now - 60_000) return { mode: "IMMEDIATE", at: null, error: "定时生效时间已过去，请选择未来时间或立即下发" }
  if (t > now + 365 * 24 * 3600 * 1000) return { mode: "IMMEDIATE", at: null, error: "定时生效时间最远一年" }
  if (t <= now + 5_000) return { mode: "IMMEDIATE", at: null } // 5 秒内视为立即
  return { mode: "SCHEDULED", at: new Date(t) }
}

// ---- IP 值合法性（CIDR / 单 IP）----
function validIpValue(v: string): boolean {
  const s = v.trim()
  if (/^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/.test(s)) return true
  if (/^[0-9a-fA-F:]+(\/\d{1,3})?$/.test(s) && s.includes(":")) return true
  return false
}

// ---- 目标快照（回滚依据；保留规则原始 deploymentId —— 回滚恢复时不污染）----
interface TargetSnapshot {
  targetType: "USER" | "GROUP"
  targetId: string
  targetName: string
  fields: { allowInternalNetwork?: boolean | null; allowSecureLocationAccess?: boolean | null }
  domainRules: Array<{ pattern: string; type: string; enabled: boolean; note: string | null; priority: number; deploymentId: string | null }>
  ipRules: Array<{ type: string; value: string; mode: string; note: string | null; deploymentId: string | null }>
  endpointRules: Array<{ pattern: string; type: string; enabled: boolean; note: string | null; priority: number; deploymentId: string | null }>
}

// ============================================================
// 下发主流程
// ============================================================
export interface PolicyOperator {
  userId: string
  username: string
  role: string // SUPER_ADMIN | ADMIN | GROUP_ADMIN
}

export interface DeployResult {
  deploymentId: string
  status: string
  totalTargets: number
  successTargets: number
  failedTargets: number
  failures: Array<{ target: string; reason: string }>
  affectedUsers: number
  scheduled: boolean
  effectiveAt: string | null
}

export async function deployPolicyBundle(operator: PolicyOperator, input: unknown): Promise<DeployResult> {
  const ctx = operator
  const p = zodValidate(deploySchema, input)

  // 限流：下发为高危批量操作
  if (!rateLimit(`policyDeploy:${ctx.userId}`, 10, 60_000).allowed) throw new Error("下发操作过于频繁，请稍后再试")

  const totalTargets = p.targetUserIds.length + p.targetGroupIds.length
  if (totalTargets === 0) throw new Error("请至少选择一个下发目标（用户或用户组）")
  if (
    p.bundle.allowInternalNetwork === null &&
    p.bundle.allowSecureLocationAccess === null &&
    !p.bundle.domainRules &&
    !p.bundle.ipRules &&
    !p.bundle.endpointRules
  ) {
    throw new Error("策略包为空：请至少配置一项下发内容")
  }

  // ---- 定时生效时间 ----
  const eff = parseEffectiveAt(p.effectiveAt)
  if (eff.error) throw new Error(eff.error)

  // ---- 目标解析 + 越权过滤（GROUP_ADMIN 仅本组）----
  const myAdminGroups = ctx.role === "GROUP_ADMIN" ? await adminGroupIds(ctx.userId) : null
  const users = p.targetUserIds.length
    ? await db.user.findMany({ where: { id: { in: p.targetUserIds }, deletedAt: null }, select: { id: true, username: true, displayName: true } })
    : []
  const groups = p.targetGroupIds.length
    ? await db.group.findMany({ where: { id: { in: p.targetGroupIds }, deletedAt: null, enabled: true }, select: { id: true, name: true } })
    : []

  const usersById = new Map(users.map((u) => [u.id, u]))
  const groupsById = new Map(groups.map((g) => [g.id, g]))
  if (usersById.size + groupsById.size !== totalTargets) throw new Error("部分目标不存在或已删除，请刷新后重试")

  if (myAdminGroups) {
    // 组管理员：组目标必须在本管理组集合内；用户目标必须至少属于一个本管理组
    for (const gid of p.targetGroupIds) {
      if (!myAdminGroups.includes(gid)) throw new Error(`组管理员仅可下发本组目标（越权组已拦截）`)
    }
    if (p.targetUserIds.length) {
      const memberships = await db.groupUser.findMany({
        where: { userId: { in: p.targetUserIds }, groupId: { in: myAdminGroups } },
        select: { userId: true },
      })
      const covered = new Set(memberships.map((m) => m.userId))
      for (const uid of p.targetUserIds) {
        if (!covered.has(uid)) throw new Error(`组管理员仅可下发本组成员（越权用户 ${usersById.get(uid)?.username || uid} 已拦截）`)
      }
    }
  }

  // ---- 域名模式规范化（下发前统一清洗）----
  let domainPatterns: string[] = []
  if (p.bundle.domainRules) {
    const invalid: string[] = []
    for (const raw of p.bundle.domainRules.patterns) {
      const n = normalizeDomainPattern(raw)
      if (!n) invalid.push(raw)
      else domainPatterns.push(n)
    }
    if (invalid.length > 0) throw new Error(`非法域名模式：${invalid.slice(0, 3).join("、")}${invalid.length > 3 ? " 等" : ""}`)
    domainPatterns = [...new Set(domainPatterns)]
    if (p.bundle.domainRules.mode === "WHITELIST" && domainPatterns.length === 0) {
      throw new Error("白名单模式下名单不能为空（否则目标用户将被全量阻断）")
    }
  }
  if (p.bundle.ipRules) {
    const invalidIps = p.bundle.ipRules.values.filter((v) => !validIpValue(v))
    if (invalidIps.length > 0) throw new Error(`非法 IP/CIDR：${invalidIps.slice(0, 3).join("、")}${invalidIps.length > 3 ? " 等" : ""}`)
  }
  // ---- 端点模式规范化 ----
  let endpointPatterns: string[] = []
  if (p.bundle.endpointRules) {
    const invalidEp: string[] = []
    for (const raw of p.bundle.endpointRules.patterns) {
      const n = normalizeEndpointPattern(raw)
      if (!n) invalidEp.push(raw)
      else endpointPatterns.push(n)
    }
    if (invalidEp.length > 0) throw new Error(`非法端点模式（支持 host:port / host:* / CIDR:port / [::1]:port）：${invalidEp.slice(0, 3).join("、")}${invalidEp.length > 3 ? " 等" : ""}`)
    endpointPatterns = [...new Set(endpointPatterns)]
    if (p.bundle.endpointRules.mode === "WHITELIST" && endpointPatterns.length === 0) {
      throw new Error("端点放行例外名单不能为空")
    }
  }

  // ---- 落库：下发批次 ----
  const scheduled = eff.mode === "SCHEDULED"
  const deployment = await db.policyDeployment.create({
    data: {
      name: p.name,
      note: p.note || null,
      bundleJson: JSON.stringify({
        allowInternalNetwork: p.bundle.allowInternalNetwork,
        allowSecureLocationAccess: p.bundle.allowSecureLocationAccess,
        domainRules: p.bundle.domainRules ? { mode: p.bundle.domainRules.mode, patterns: domainPatterns } : null,
        ipRules: p.bundle.ipRules,
        endpointRules: p.bundle.endpointRules ? { mode: p.bundle.endpointRules.mode, patterns: endpointPatterns } : null,
      }),
      targetUsers: p.targetUserIds,
      targetGroups: p.targetGroupIds,
      status: scheduled ? "PENDING" : "RUNNING",
      effectiveMode: eff.mode,
      effectiveAt: eff.at,
      deployedAt: scheduled ? null : new Date(),
      totalTargets,
      createdByUserId: ctx.userId,
    },
  })

  // ---- 定时批次：仅排期，不变更任何策略 ----
  if (scheduled) {
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "POLICY_DEPLOY_SCHEDULED",
      resourceType: "POLICY_DEPLOYMENT",
      resourceId: deployment.id,
      resourceName: p.name,
      after: {
        bundle: JSON.parse(deployment.bundleJson),
        groups: groups.map((g) => g.name),
        users: users.map((u) => u.username),
        effectiveAt: eff.at?.toISOString(),
        totalTargets,
      },
      severity: "INFO",
    })
    await writeSecurityEvent({
      userId: ctx.userId,
      username: ctx.username,
      eventType: "POLICY_DEPLOY_SCHEDULED",
      success: true,
      detail: `定时策略下发「${p.name}」已排期：目标 ${totalTargets}，生效时刻 ${eff.at?.toISOString()}（到点由定时任务自动激活）`,
    })
    return {
      deploymentId: deployment.id,
      status: "PENDING",
      totalTargets,
      successTargets: 0,
      failedTargets: 0,
      failures: [],
      affectedUsers: 0,
      scheduled: true,
      effectiveAt: eff.at ? eff.at.toISOString() : null,
    }
  }

  // ---- 立即执行 ----
  const outcome = await applyDeploymentToTargets(deployment.id, JSON.parse(deployment.bundleJson) as PolicyBundle, ctx)

  return {
    deploymentId: deployment.id,
    status: outcome.status,
    totalTargets,
    successTargets: outcome.successTargets,
    failedTargets: outcome.failedTargets,
    failures: outcome.failures,
    affectedUsers: outcome.affectedUsers,
    scheduled: false,
    effectiveAt: null,
  }
}

// ============================================================
// 执行核心（立即下发 / 定时激活共用）
// ============================================================
interface ApplyOutcome {
  status: string
  successTargets: number
  failedTargets: number
  failures: Array<{ target: string; reason: string }>
  affectedUsers: number
}

async function applyDeploymentToTargets(deploymentId: string, bundle: PolicyBundle, operator: PolicyOperator): Promise<ApplyOutcome> {
  const deployment = await db.policyDeployment.findUnique({ where: { id: deploymentId } })
  if (!deployment) throw new Error("下发批次不存在")
  const targetUserIds = (deployment.targetUsers as string[]) || []
  const targetGroupIds = (deployment.targetGroups as string[]) || []

  const users = targetUserIds.length
    ? await db.user.findMany({ where: { id: { in: targetUserIds }, deletedAt: null }, select: { id: true, username: true, displayName: true } })
    : []
  const groups = targetGroupIds.length
    ? await db.group.findMany({ where: { id: { in: targetGroupIds }, deletedAt: null, enabled: true }, select: { id: true, name: true } })
    : []

  const snapshots: TargetSnapshot[] = []
  const results: Array<{ targetId: string; targetType: string; targetName: string; ok: boolean; reason?: string }> = []
  let affectedUsers = 0

  const applyToTarget = async (targetType: "USER" | "GROUP", targetId: string, targetName: string) => {
    // 前置快照
    const snapshot: TargetSnapshot = {
      targetType,
      targetId,
      targetName,
      fields: {},
      domainRules: [],
      ipRules: [],
      endpointRules: [],
    }
    const scopeWhere = targetType === "USER" ? { scopeType: "USER", userId: targetId } : { scopeType: "GROUP", groupId: targetId }

    if (targetType === "USER") {
      const u = await db.user.findUnique({ where: { id: targetId }, select: { allowInternalNetwork: true, allowSecureLocationAccess: true } })
      snapshot.fields = { allowInternalNetwork: u?.allowInternalNetwork ?? null, allowSecureLocationAccess: u?.allowSecureLocationAccess ?? null }
    } else {
      const g = await db.group.findUnique({ where: { id: targetId }, select: { allowInternalNetwork: true, allowSecureLocationAccess: true } })
      snapshot.fields = { allowInternalNetwork: g?.allowInternalNetwork ?? null, allowSecureLocationAccess: g?.allowSecureLocationAccess ?? null }
    }
    const prevDomain = await db.domainRule.findMany({ where: scopeWhere })
    snapshot.domainRules = prevDomain.map((r) => ({ pattern: r.pattern, type: r.type, enabled: r.enabled, note: r.note, priority: r.priority, deploymentId: r.deploymentId ?? null }))
    const prevIp = await db.riskListRule.findMany({ where: { ...scopeWhere, type: { in: ["IP_BLACK", "IP_WHITE"] } } })
    snapshot.ipRules = prevIp.map((r) => ({ type: r.type, value: r.value, mode: r.mode, note: r.note, deploymentId: r.deploymentId ?? null }))
    const prevEp = await db.networkEndpointRule.findMany({ where: scopeWhere })
    snapshot.endpointRules = prevEp.map((r) => ({ pattern: r.pattern, type: r.type, enabled: r.enabled, note: r.note, priority: r.priority ?? 0, deploymentId: r.deploymentId ?? null }))
    snapshots.push(snapshot)

    // 1) 开关覆盖
    const fieldUpdate: Record<string, boolean> = {}
    if (bundle.allowInternalNetwork !== null && bundle.allowInternalNetwork !== undefined) fieldUpdate.allowInternalNetwork = bundle.allowInternalNetwork
    if (bundle.allowSecureLocationAccess !== null && bundle.allowSecureLocationAccess !== undefined) fieldUpdate.allowSecureLocationAccess = bundle.allowSecureLocationAccess
    if (Object.keys(fieldUpdate).length > 0) {
      if (targetType === "USER") await db.user.update({ where: { id: targetId }, data: fieldUpdate })
      else await db.group.update({ where: { id: targetId }, data: fieldUpdate })
    }

    // 2) 域名规则替换（同作用域全量替换，打 deploymentId 标记便于追溯）
    if (bundle.domainRules) {
      await db.domainRule.deleteMany({ where: scopeWhere })
      if (bundle.domainRules.patterns.length > 0) {
        const type = bundle.domainRules.mode === "WHITELIST" ? "WHITE" : "BLACK"
        await db.domainRule.createMany({
          data: bundle.domainRules.patterns.map((pattern) => ({
            pattern,
            type,
            enabled: true,
            note: `策略下发：${deployment.name}`,
            scopeType: targetType,
            groupId: targetType === "GROUP" ? targetId : null,
            userId: targetType === "USER" ? targetId : null,
            deploymentId: deployment.id,
            createdByUserId: operator.userId,
          })),
        })
      }
    }

    // 3) IP 黑白名单替换
    if (bundle.ipRules) {
      await db.riskListRule.deleteMany({ where: { ...scopeWhere, type: { in: ["IP_BLACK", "IP_WHITE"] } } })
      if (bundle.ipRules.values.length > 0) {
        const type = bundle.ipRules.mode === "WHITELIST" ? "IP_WHITE" : "IP_BLACK"
        await db.riskListRule.createMany({
          data: bundle.ipRules.values.map((value) => ({
            type,
            value: value.trim(),
            mode: "PERMANENT",
            note: `策略下发：${deployment.name}`,
            scopeType: targetType,
            groupId: targetType === "GROUP" ? targetId : null,
            userId: targetType === "USER" ? targetId : null,
            deploymentId: deployment.id,
            createdByUserId: operator.userId,
          })),
        })
      }
    }

    // 4) 端点级精确限制规则替换（host:port）
    if (bundle.endpointRules) {
      await db.networkEndpointRule.deleteMany({ where: scopeWhere })
      if (bundle.endpointRules.patterns.length > 0) {
        const type = bundle.endpointRules.mode === "WHITELIST" ? "WHITE" : "BLACK"
        await db.networkEndpointRule.createMany({
          data: bundle.endpointRules.patterns.map((pattern) => ({
            pattern,
            type,
            enabled: true,
            note: `策略下发：${deployment.name}`,
            scopeType: targetType,
            groupId: targetType === "GROUP" ? targetId : null,
            userId: targetType === "USER" ? targetId : null,
            deploymentId: deployment.id,
            createdByUserId: operator.userId,
          })),
        })
      }
    }

    if (targetType === "USER") affectedUsers++
    else {
      const cnt = await db.groupUser.count({ where: { groupId: targetId } })
      affectedUsers += cnt
    }
  }

  let successTargets = 0
  const failures: Array<{ target: string; reason: string }> = []
  for (const g of groups) {
    try {
      await applyToTarget("GROUP", g.id, g.name)
      results.push({ targetId: g.id, targetType: "GROUP", targetName: g.name, ok: true })
      successTargets++
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      results.push({ targetId: g.id, targetType: "GROUP", targetName: g.name, ok: false, reason })
      failures.push({ target: `组：${g.name}`, reason })
    }
  }
  for (const u of users) {
    try {
      await applyToTarget("USER", u.id, u.displayName || u.username)
      results.push({ targetId: u.id, targetType: "USER", targetName: u.displayName || u.username, ok: true })
      successTargets++
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      results.push({ targetId: u.id, targetType: "USER", targetName: u.displayName || u.username, ok: false, reason })
      failures.push({ target: `用户：${u.displayName || u.username}`, reason })
    }
  }

  const status = failures.length === 0 ? "SUCCESS" : successTargets > 0 ? "PARTIAL" : "FAILED"
  await db.policyDeployment.update({
    where: { id: deployment.id },
    data: {
      status,
      successTargets,
      failedTargets: failures.length,
      resultsJson: JSON.stringify(results),
      snapshotJson: JSON.stringify(snapshots),
      finishedAt: new Date(),
      activatedAt: deployment.activatedAt ?? new Date(),
    },
  })

  // 审计 + 安全事件（高危批量操作）
  const viaScheduled = deployment.effectiveMode === "SCHEDULED"
  await writeAudit({
    operatorUserId: operator.userId,
    operatorName: operator.username,
    operationType: viaScheduled ? "POLICY_DEPLOY_ACTIVATED" : "POLICY_DEPLOY",
    resourceType: "POLICY_DEPLOYMENT",
    resourceId: deployment.id,
    resourceName: deployment.name,
    after: {
      bundle: JSON.parse(JSON.stringify(bundle)),
      groups: groups.map((g) => g.name),
      users: users.map((u) => u.username),
      success: successTargets,
      failed: failures.length,
      affectedUsers,
      via: viaScheduled ? "定时到点自动激活" : "立即下发",
    },
    severity: failures.length > 0 ? "WARN" : "INFO",
  })
  await writeSecurityEvent({
    userId: operator.userId,
    username: operator.username,
    eventType: viaScheduled ? "POLICY_DEPLOY_ACTIVATED" : "POLICY_DEPLOY",
    success: status !== "FAILED",
    detail: `${viaScheduled ? "定时策略到点激活" : "策略下发"}「${deployment.name}」：目标 ${targetUserIds.length + targetGroupIds.length}（组 ${groups.length}/用户 ${users.length}），影响用户约 ${affectedUsers}，成功 ${successTargets} / 失败 ${failures.length}`,
  })

  return { status, successTargets, failedTargets: failures.length, failures, affectedUsers }
}

// ============================================================
// 定时激活（由定时任务 policy_deployment_activation 每分钟调用）
// ============================================================
export async function activateDueScheduledDeployments(log: (m: string) => void): Promise<{ activated: number; failed: number }> {
  const due = await db.policyDeployment.findMany({
    where: { status: "PENDING", effectiveMode: "SCHEDULED", effectiveAt: { lte: new Date() } },
    orderBy: { effectiveAt: "asc" },
    take: 50,
  })
  let activated = 0
  let failed = 0
  for (const d of due) {
    // 先置 RUNNING 防并发重复激活（内存锁之外的双保险）
    const claimed = await db.policyDeployment.updateMany({
      where: { id: d.id, status: "PENDING" },
      data: { status: "RUNNING", deployedAt: new Date() },
    })
    if (claimed.count === 0) continue

    // 以批次创建者为操作者（定时激活继承下发人上下文）
    let operator: PolicyOperator
    if (d.createdByUserId) {
      const u = await db.user.findUnique({ where: { id: d.createdByUserId }, select: { id: true, username: true, role: true, deletedAt: true } })
      if (u && !u.deletedAt) operator = { userId: u.id, username: u.username, role: u.role }
      else operator = { userId: d.createdByUserId, username: "(已删除用户)", role: "ADMIN" }
    } else {
      operator = { userId: "system", username: "system", role: "SUPER_ADMIN" }
    }

    try {
      const bundle = JSON.parse(d.bundleJson) as PolicyBundle
      const outcome = await applyDeploymentToTargets(d.id, bundle, operator)
      log(`激活「${d.name}」：${outcome.status}（成功 ${outcome.successTargets}/${d.totalTargets}，失败 ${outcome.failedTargets}）`)
      if (outcome.status === "FAILED") failed++
      else activated++
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      await db.policyDeployment.update({
        where: { id: d.id },
        data: { status: "FAILED", failedTargets: d.totalTargets, resultsJson: JSON.stringify([{ targetId: "-", targetType: "BATCH", targetName: d.name, ok: false, reason }]), finishedAt: new Date() },
      }).catch(() => {})
      log(`激活「${d.name}」失败：${reason}`)
      failed++
    }
  }
  return { activated, failed }
}

// ============================================================
// 取消定时批次（激活前）
// ============================================================
export async function cancelScheduledDeployment(operator: PolicyOperator, input: unknown): Promise<{ id: string; name: string }> {
  const { id } = zodValidate(z.object({ id: zId }), input)
  if (!rateLimit(`policyCancel:${operator.userId}`, 10, 60_000).allowed) throw new Error("操作过于频繁，请稍后再试")

  const deployment = await db.policyDeployment.findUnique({ where: { id } })
  if (!deployment) throw new Error("下发批次不存在")
  if (deployment.status !== "PENDING") throw new Error("仅定时待生效（PENDING）批次可取消；已激活批次请使用回滚")
  if (deployment.effectiveAt && deployment.effectiveAt.getTime() <= Date.now()) throw new Error("该批次已到生效时刻（激活中），无法取消")

  await db.policyDeployment.update({
    where: { id },
    data: { status: "CANCELLED", cancelledAt: new Date(), cancelledByUserId: operator.userId, finishedAt: new Date() },
  })

  await writeAudit({
    operatorUserId: operator.userId,
    operatorName: operator.username,
    operationType: "POLICY_DEPLOY_CANCEL",
    resourceType: "POLICY_DEPLOYMENT",
    resourceId: id,
    resourceName: deployment.name,
    after: { cancelledAt: new Date().toISOString(), effectiveAt: deployment.effectiveAt?.toISOString() },
    severity: "WARN",
  })
  await writeSecurityEvent({
    userId: operator.userId,
    username: operator.username,
    eventType: "POLICY_DEPLOY_CANCEL",
    success: true,
    detail: `取消定时策略下发「${deployment.name}」（原定生效 ${deployment.effectiveAt?.toISOString() ?? "-"}），策略未发生任何变更`,
  })
  return { id, name: deployment.name }
}

// ============================================================
// 回滚（恢复下发前快照）
// ============================================================
export async function rollbackPolicyBundle(operator: PolicyOperator, input: unknown): Promise<{ rolledBackTargets: number }> {
  const ctx = operator
  const { id } = zodValidate(z.object({ id: zId }), input)
  if (!rateLimit(`policyRollback:${ctx.userId}`, 10, 60_000).allowed) throw new Error("回滚操作过于频繁，请稍后再试")

  const deployment = await db.policyDeployment.findUnique({ where: { id } })
  if (!deployment) throw new Error("下发批次不存在")
  if (deployment.status === "ROLLED_BACK") throw new Error("该批次已回滚，请勿重复操作")
  if (deployment.status === "CANCELLED") throw new Error("该批次已取消（策略从未生效），无需回滚")
  if (deployment.status === "PENDING") throw new Error("该批次尚未激活生效，请先取消或等待定时激活")
  if (!deployment.snapshotJson) throw new Error("该批次缺少前置快照，无法回滚")

  // 顺序回滚保护：若有更晚的批次覆盖相同目标且尚未回滚，提示先回滚新批次
  const myUsers = (deployment.targetUsers as string[]) || []
  const myGroups = (deployment.targetGroups as string[]) || []
  const laterDeployments = await db.policyDeployment.findMany({
    where: { createdAt: { gt: deployment.createdAt }, status: { in: ["SUCCESS", "PARTIAL", "RUNNING"] } },
    select: { id: true, name: true, targetUsers: true, targetGroups: true },
    take: 50,
  })
  const overlapping = laterDeployments.filter((d) => {
    const du = (d.targetUsers as string[]) || []
    const dg = (d.targetGroups as string[]) || []
    return du.some((u) => myUsers.includes(u)) || dg.some((g) => myGroups.includes(g))
  })
  if (overlapping.length > 0) {
    throw new Error(`存在更晚下发且覆盖相同目标的批次（如「${overlapping[0].name}」），请先回滚最新批次以保证快照一致性`)
  }

  const snapshots = JSON.parse(deployment.snapshotJson) as TargetSnapshot[]
  let rolledBackTargets = 0

  for (const snap of snapshots) {
    const scopeWhere = snap.targetType === "USER" ? { scopeType: "USER", userId: snap.targetId } : { scopeType: "GROUP", groupId: snap.targetId }
    // 1) 恢复开关字段
    const restore: Record<string, boolean | null> = {}
    if (snap.fields.allowInternalNetwork !== undefined) restore.allowInternalNetwork = snap.fields.allowInternalNetwork
    if (snap.fields.allowSecureLocationAccess !== undefined) restore.allowSecureLocationAccess = snap.fields.allowSecureLocationAccess
    if (Object.keys(restore).length > 0) {
      if (snap.targetType === "USER") await db.user.update({ where: { id: snap.targetId }, data: restore }).catch(() => {})
      else await db.group.update({ where: { id: snap.targetId }, data: restore }).catch(() => {})
    }
    // 2) 清空该作用域规则 → 完整恢复快照（顺序回滚保护下，作用域内必为本批次产物；
    //    链式回滚时上一批次恢复的规则会被下一批次快照正确覆盖；
    //    恢复时保留快照中的原始 deploymentId —— 不污染为回滚批次号）
    await db.domainRule.deleteMany({ where: scopeWhere }).catch(() => {})
    if (snap.domainRules.length > 0) {
      await db.domainRule.createMany({
        data: snap.domainRules.map((r) => ({
          pattern: r.pattern,
          type: r.type,
          enabled: r.enabled,
          note: r.note,
          priority: r.priority,
          scopeType: snap.targetType,
          groupId: snap.targetType === "GROUP" ? snap.targetId : null,
          userId: snap.targetType === "USER" ? snap.targetId : null,
          deploymentId: r.deploymentId ?? null,
          createdByUserId: ctx.userId,
        })),
      }).catch(() => {})
    }
    // 3) IP 规则恢复
    await db.riskListRule.deleteMany({ where: { ...scopeWhere, type: { in: ["IP_BLACK", "IP_WHITE"] } } }).catch(() => {})
    if (snap.ipRules.length > 0) {
      await db.riskListRule.createMany({
        data: snap.ipRules.map((r) => ({
          type: r.type,
          value: r.value,
          mode: r.mode,
          note: r.note,
          scopeType: snap.targetType,
          groupId: snap.targetType === "GROUP" ? snap.targetId : null,
          userId: snap.targetType === "USER" ? snap.targetId : null,
          deploymentId: r.deploymentId ?? null,
          createdByUserId: ctx.userId,
        })),
      }).catch(() => {})
    }
    // 4) 端点规则恢复
    await db.networkEndpointRule.deleteMany({ where: scopeWhere }).catch(() => {})
    if (snap.endpointRules.length > 0) {
      await db.networkEndpointRule.createMany({
        data: snap.endpointRules.map((r) => ({
          pattern: r.pattern,
          type: r.type,
          enabled: r.enabled,
          note: r.note,
          priority: r.priority,
          scopeType: snap.targetType,
          groupId: snap.targetType === "GROUP" ? snap.targetId : null,
          userId: snap.targetType === "USER" ? snap.targetId : null,
          deploymentId: r.deploymentId ?? null,
          createdByUserId: ctx.userId,
        })),
      }).catch(() => {})
    }
    rolledBackTargets++
  }

  await db.policyDeployment.update({
    where: { id },
    data: { status: "ROLLED_BACK", rolledBackAt: new Date(), rolledBackByUserId: ctx.userId },
  })

  await writeAudit({
    operatorUserId: ctx.userId,
    operatorName: ctx.username,
    operationType: "POLICY_DEPLOY_ROLLBACK",
    resourceType: "POLICY_DEPLOYMENT",
    resourceId: id,
    resourceName: deployment.name,
    after: { rolledBackTargets },
    severity: "WARN",
  })
  await writeSecurityEvent({
    userId: ctx.userId,
    username: ctx.username,
    eventType: "POLICY_DEPLOY_ROLLBACK",
    success: true,
    detail: `回滚策略下发「${deployment.name}」：恢复目标 ${rolledBackTargets} 个`,
  })

  return { rolledBackTargets }
}
