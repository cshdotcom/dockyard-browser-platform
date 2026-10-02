"use server"

// ============================================================
// r22b：管理员按「接收者」维度强制清退共享
// 与 r13c 既有共享管控 action 并存（语义勿混淆）：
//   · adminRevokeShare / adminBatchRevokeShares / adminRevokeAllWorkspaceShares
//     （admin-workspaces.ts）：以「共享记录 / 工作区」为操作对象；
//   · 本文件：以「用户 / 用户组」为操作对象 —— 一次性清退其作为接收者收到的
//     全部未撤销 WorkspaceShare（targetUserId 维度批量置位 revokedAt）。
// 权限：SUPER_ADMIN / ADMIN；审计操作类型 SHARE_ADMIN_EVICT；返回撤销数量。
// ============================================================

import { actionHandler, type ActionResult } from "@/lib/api"
import { zodValidate, zId } from "@/lib/validators"
import { z } from "zod"
import { requireRole, requireWritableMode } from "@/lib/permissions"
import { db } from "@/lib/db"
import { writeAudit } from "@/lib/audit"

// ---- 清退目标搜索（共享总列表工具栏「按用户清退 / 按组清退」弹窗用）----
// 返回候选项及其当前生效（未撤销）共享条数，供弹窗内点选与确认文案展示
export async function adminSearchShareEvictTargetsAction(input: unknown): Promise<ActionResult<{
  items: {
    id: string
    label: string // 用户名 / 组名
    sub: string // 昵称·角色 / 描述
    memberCount: number // 组成员数（用户=1）
    activeCount: number // 当前生效（未撤销）共享条数
  }[]
}>> {
  return actionHandler(async () => {
    await requireRole(["SUPER_ADMIN", "ADMIN"])
    const { kind, q } = zodValidate(
      z.object({ kind: z.enum(["USER", "GROUP"]), q: z.string().max(64) }),
      input
    )
    const kw = q.trim()
    if (!kw) return { items: [] }

    if (kind === "USER") {
      const users = await db.user.findMany({
        where: { deletedAt: null, OR: [{ username: { contains: kw } }, { displayName: { contains: kw } }] },
        select: { id: true, username: true, displayName: true, role: true },
        orderBy: { username: "asc" },
        take: 10,
      })
      if (!users.length) return { items: [] }
      const grouped = await db.workspaceShare.groupBy({
        by: ["targetUserId"],
        where: { targetUserId: { in: users.map((u) => u.id) }, revokedAt: null },
        _count: { _all: true },
      })
      const countMap = new Map(grouped.map((g) => [g.targetUserId, g._count._all]))
      const ROLE_LABEL: Record<string, string> = {
        SUPER_ADMIN: "超级管理员", ADMIN: "管理员", GROUP_ADMIN: "组管理员", USER: "用户",
      }
      return {
        items: users.map((u) => ({
          id: u.id,
          label: u.username,
          sub: [u.displayName, ROLE_LABEL[u.role] || u.role].filter(Boolean).join(" · "),
          memberCount: 1,
          activeCount: countMap.get(u.id) ?? 0,
        })),
      }
    }

    const groups = await db.group.findMany({
      where: { deletedAt: null, name: { contains: kw } },
      select: { id: true, name: true, description: true },
      orderBy: { name: "asc" },
      take: 10,
    })
    const items: { id: string; label: string; sub: string; memberCount: number; activeCount: number }[] = []
    for (const g of groups) {
      const members = await db.groupUser.findMany({ where: { groupId: g.id }, select: { userId: true } })
      const userIds = [...new Set(members.map((m) => m.userId))]
      const activeCount = userIds.length
        ? await db.workspaceShare.count({ where: { targetUserId: { in: userIds }, revokedAt: null } })
        : 0
      items.push({
        id: g.id,
        label: g.name,
        sub: g.description || "",
        memberCount: userIds.length,
        activeCount,
      })
    }
    return { items }
  })
}

// ---- 清退预览（用户/组行菜单确认弹窗显示「将撤销 N 条」）----
export async function adminShareEvictPreviewAction(input: unknown): Promise<ActionResult<{
  label: string
  memberCount: number
  activeCount: number
}>> {
  return actionHandler(async () => {
    await requireRole(["SUPER_ADMIN", "ADMIN"])
    const { kind, id } = zodValidate(z.object({ kind: z.enum(["USER", "GROUP"]), id: zId }), input)

    if (kind === "USER") {
      const user = await db.user.findFirst({ where: { id, deletedAt: null }, select: { username: true } })
      if (!user) throw new Error("目标用户不存在")
      const activeCount = await db.workspaceShare.count({ where: { targetUserId: id, revokedAt: null } })
      return { label: user.username, memberCount: 1, activeCount }
    }

    const group = await db.group.findFirst({ where: { id, deletedAt: null }, select: { name: true } })
    if (!group) throw new Error("目标用户组不存在")
    const members = await db.groupUser.findMany({ where: { groupId: id }, select: { userId: true } })
    const userIds = [...new Set(members.map((m) => m.userId))]
    const activeCount = userIds.length
      ? await db.workspaceShare.count({ where: { targetUserId: { in: userIds }, revokedAt: null } })
      : 0
    return { label: group.name, memberCount: userIds.length, activeCount }
  })
}

// ---- 按用户清退：撤销该用户作为接收者的全部未撤销共享 ----
export async function adminEvictUserSharesAction(input: unknown): Promise<ActionResult<{ revoked: number }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireRole(["SUPER_ADMIN", "ADMIN"])
    const { targetUserId } = zodValidate(z.object({ targetUserId: zId }), input)
    const user = await db.user.findFirst({ where: { id: targetUserId, deletedAt: null }, select: { id: true, username: true } })
    if (!user) throw new Error("目标用户不存在")

    // 先取 id 再批量撤销（审计可精确到共享记录）
    const todo = await db.workspaceShare.findMany({
      where: { targetUserId, revokedAt: null },
      select: { id: true },
    })
    if (todo.length) {
      await db.workspaceShare.updateMany({
        where: { id: { in: todo.map((s) => s.id) } },
        data: { revokedAt: new Date() },
      })
    }
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "SHARE_ADMIN_EVICT",
      resourceType: "WORKSPACE",
      resourceId: null,
      resourceName: `用户 ${user.username} 收到的全部共享`,
      ownerUserId: null,
      after: { kind: "USER", targetUserId, targetUsername: user.username, revoked: todo.length, shareIds: todo.map((s) => s.id) },
      severity: "WARN",
    })
    return { revoked: todo.length }
  })
}

// ---- 按组清退：撤销组内全部成员作为接收者的未撤销共享 ----
export async function adminEvictGroupSharesAction(input: unknown): Promise<ActionResult<{
  revoked: number
  memberCount: number
}>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireRole(["SUPER_ADMIN", "ADMIN"])
    const { groupId } = zodValidate(z.object({ groupId: zId }), input)
    const group = await db.group.findFirst({ where: { id: groupId, deletedAt: null }, select: { id: true, name: true } })
    if (!group) throw new Error("目标用户组不存在")

    const members = await db.groupUser.findMany({ where: { groupId }, select: { userId: true } })
    const userIds = [...new Set(members.map((m) => m.userId))]

    const todo = userIds.length
      ? await db.workspaceShare.findMany({
          where: { targetUserId: { in: userIds }, revokedAt: null },
          select: { id: true, targetUserId: true },
        })
      : []
    if (todo.length) {
      await db.workspaceShare.updateMany({
        where: { id: { in: todo.map((s) => s.id) } },
        data: { revokedAt: new Date() },
      })
    }
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "SHARE_ADMIN_EVICT",
      resourceType: "WORKSPACE",
      resourceId: null,
      resourceName: `用户组 ${group.name} 全体成员收到的共享`,
      ownerUserId: null,
      after: {
        kind: "GROUP", groupId, groupName: group.name, memberCount: userIds.length,
        revoked: todo.length, shareIds: todo.map((s) => s.id),
        affectedUsers: [...new Set(todo.map((s) => s.targetUserId))],
      },
      severity: "WARN",
    })
    return { revoked: todo.length, memberCount: userIds.length }
  })
}
