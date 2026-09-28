"use server"

// ============================================================
// 策略下发中心 Server Actions（鉴权包装层）
// 核心引擎在 src/lib/policy-engine.ts（可独立脚本调用/测试）：
//   deployPolicyBundle / rollbackPolicyBundle（operator 上下文参数化）
// 本文件职责：requireAdmin 鉴权 + ActionResult 封装 + 模板/查询动作
// ============================================================

import { actionHandler, type ActionResult } from "@/lib/api"
import { zodValidate, zId } from "@/lib/validators"
import { z } from "zod"
import { requireAdmin, adminGroupIds } from "@/lib/permissions"
import { db } from "@/lib/db"
import { writeAudit } from "@/lib/audit"
import { deployPolicyBundle, rollbackPolicyBundle, bundleSchema, type PolicyOperator } from "@/lib/policy-engine"

// ---- 下发（鉴权 → 引擎）----
export async function deployPolicyAction(input: unknown): Promise<ActionResult<{
  deploymentId: string
  status: string
  totalTargets: number
  successTargets: number
  failedTargets: number
  failures: Array<{ target: string; reason: string }>
  affectedUsers: number
}>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const operator: PolicyOperator = { userId: ctx.userId, username: ctx.username, role: ctx.role }
    return deployPolicyBundle(operator, input)
  })
}

// ---- 回滚（鉴权 → 引擎）----
export async function rollbackDeploymentAction(input: unknown): Promise<ActionResult<{ rolledBackTargets: number }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const operator: PolicyOperator = { userId: ctx.userId, username: ctx.username, role: ctx.role }
    return rollbackPolicyBundle(operator, input)
  })
}

// ============================================================
// 模板管理（复用策略包）
// ============================================================
const templateSchema = z.object({
  id: zId.optional(),
  name: z.string().min(1).max(64),
  description: z.string().max(300).optional().nullable(),
  bundle: bundleSchema,
})

export async function savePolicyTemplateAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const p = zodValidate(templateSchema, input)
    const dup = await db.policyTemplate.findFirst({ where: { name: p.name, deletedAt: null, ...(p.id ? { id: { not: p.id } } : {}) } })
    if (dup) throw new Error("同名策略模板已存在")

    const row = p.id
      ? await db.policyTemplate.update({
          where: { id: p.id },
          data: { name: p.name, description: p.description || null, bundleJson: JSON.stringify(p.bundle) },
        })
      : await db.policyTemplate.create({
          data: { name: p.name, description: p.description || null, bundleJson: JSON.stringify(p.bundle), createdByUserId: ctx.userId },
        })

    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: p.id ? "POLICY_TEMPLATE_UPDATE" : "POLICY_TEMPLATE_CREATE",
      resourceType: "POLICY_TEMPLATE",
      resourceId: row.id,
      resourceName: row.name,
      after: { name: row.name, bundle: p.bundle },
    })
    return { id: row.id }
  })
}

export async function deletePolicyTemplateAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const { id } = zodValidate(z.object({ id: zId }), input)
    const tpl = await db.policyTemplate.findUnique({ where: { id } })
    if (!tpl || tpl.deletedAt) throw new Error("模板不存在")
    if (tpl.builtin) throw new Error("内置模板不可删除")
    await db.policyTemplate.update({ where: { id }, data: { deletedAt: new Date() } })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "POLICY_TEMPLATE_DELETE",
      resourceType: "POLICY_TEMPLATE",
      resourceId: id,
      resourceName: tpl.name,
      severity: "WARN",
    })
    return { id }
  })
}

// ============================================================
// 查询
// ============================================================
export async function listDeploymentsAction(input: unknown): Promise<ActionResult<{
  rows: Array<{
    id: string
    name: string
    status: string
    totalTargets: number
    successTargets: number
    failedTargets: number
    createdByUsername: string
    deployedAt: string | null
    rolledBackAt: string | null
    bundleSummary: Record<string, unknown>
  }>
  total: number
}>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const { page, pageSize } = zodValidate(z.object({ page: z.number().int().min(1).default(1).optional(), pageSize: z.number().int().min(1).max(100).default(20).optional() }), input ?? {})
    const take = pageSize ?? 20
    const skip = ((page ?? 1) - 1) * take

    const [rows, total] = await Promise.all([
      db.policyDeployment.findMany({
        orderBy: { createdAt: "desc" },
        take,
        skip,
      }),
      db.policyDeployment.count(),
    ])

    const creatorIds = [...new Set(rows.map((r) => r.createdByUserId).filter(Boolean) as string[])]
    const creators = creatorIds.length ? await db.user.findMany({ where: { id: { in: creatorIds } }, select: { id: true, username: true } }) : []
    const usernameById = new Map(creators.map((c) => [c.id, c.username]))

    return {
      rows: rows.map((r) => {
        let bundle: Record<string, unknown> = {}
        try { bundle = JSON.parse(r.bundleJson) } catch { /* 兼容损坏 */ }
        return {
          id: r.id,
          name: r.name,
          status: r.status,
          totalTargets: r.totalTargets,
          successTargets: r.successTargets,
          failedTargets: r.failedTargets,
          createdByUsername: r.createdByUserId ? usernameById.get(r.createdByUserId) || "-" : "-",
          deployedAt: r.deployedAt?.toISOString() ?? null,
          rolledBackAt: r.rolledBackAt?.toISOString() ?? null,
          bundleSummary: bundle,
        }
      }),
      total,
    }
  })
}

export async function getDeploymentDetailAction(input: unknown): Promise<ActionResult<{
  id: string
  name: string
  status: string
  note: string | null
  bundle: Record<string, unknown> | null
  results: Array<{ targetId: string; targetType: string; targetName: string; ok: boolean; reason?: string }> | null
  targetUsers: string[]
  targetGroups: string[]
  deployedAt: string | null
  rolledBackAt: string | null
} | null>> {
  return actionHandler(async () => {
    await requireAdmin()
    const { id } = zodValidate(z.object({ id: zId }), input)
    const r = await db.policyDeployment.findUnique({ where: { id } })
    if (!r) return null
    return {
      id: r.id,
      name: r.name,
      status: r.status,
      note: r.note,
      bundle: r.bundleJson ? JSON.parse(r.bundleJson) : null,
      results: r.resultsJson ? JSON.parse(r.resultsJson) : null,
      targetUsers: (r.targetUsers as string[]) || [],
      targetGroups: (r.targetGroups as string[]) || [],
      deployedAt: r.deployedAt?.toISOString() ?? null,
      rolledBackAt: r.rolledBackAt?.toISOString() ?? null,
    }
  })
}

// 目标选择器数据（组 + 用户，供下发中心页面）
export async function policyTargetOptionsAction(): Promise<ActionResult<{
  groups: Array<{ id: string; name: string; memberCount: number; path: string }>
  users: Array<{ id: string; username: string; displayName: string | null; role: string; groupNames: string[] }>
}>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const [groups, users, memberships] = await Promise.all([
      db.group.findMany({ where: { deletedAt: null }, select: { id: true, name: true, parentId: true }, take: 200 }),
      db.user.findMany({ where: { deletedAt: null }, select: { id: true, username: true, displayName: true, role: true }, take: 500 }),
      db.groupUser.findMany({ select: { userId: true, groupId: true } }),
    ])
    const groupById = new Map(groups.map((g) => [g.id, g]))
    const groupsByUser = new Map<string, string[]>()
    for (const m of memberships) {
      const arr = groupsByUser.get(m.userId) || []
      arr.push(m.groupId)
      groupsByUser.set(m.userId, arr)
    }

    // 组管理员：仅返回本管理组
    const myAdminGroups = ctx.role === "GROUP_ADMIN" ? new Set(await adminGroupIds(ctx.userId)) : null

    const groupPath = (gid: string): string => {
      const names: string[] = []
      let cursor: string | null = gid
      const seen = new Set<string>()
      while (cursor && !seen.has(cursor)) {
        seen.add(cursor)
        const g = groupById.get(cursor)
        if (!g) break
        names.unshift(g.name)
        cursor = g.parentId
      }
      return names.join(" / ")
    }

    const memberCount = new Map<string, number>()
    for (const m of memberships) memberCount.set(m.groupId, (memberCount.get(m.groupId) || 0) + 1)

    return {
      groups: groups
        .filter((g) => !myAdminGroups || myAdminGroups.has(g.id))
        .map((g) => ({ id: g.id, name: g.name, memberCount: memberCount.get(g.id) || 0, path: groupPath(g.id) })),
      users: users
        .filter((u) => {
          if (!myAdminGroups) return true
          return (groupsByUser.get(u.id) || []).some((gid) => myAdminGroups.has(gid))
        })
        .map((u) => ({
          id: u.id,
          username: u.username,
          displayName: u.displayName,
          role: u.role,
          groupNames: (groupsByUser.get(u.id) || []).map((gid) => groupById.get(gid)?.name).filter(Boolean) as string[],
        })),
    }
  })
}

// 模板列表（含内置）
export async function listPolicyTemplatesAction(): Promise<ActionResult<Array<{ id: string; name: string; description: string | null; builtin: boolean; bundle: Record<string, unknown> | null }>>> {
  return actionHandler(async () => {
    await requireAdmin()
    const rows = await db.policyTemplate.findMany({ where: { deletedAt: null }, orderBy: [{ builtin: "desc" }, { createdAt: "desc" }], take: 100 })
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      builtin: r.builtin,
      bundle: r.bundleJson ? JSON.parse(r.bundleJson) : null,
    }))
  })
}
