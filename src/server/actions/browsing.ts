"use server"

// ============================================================
// r28：浏览历史 / 书签 Server Actions
// 角色矩阵（与录像管理同构）：
//   USER        → 用户空间：仅本人沙箱的历史/书签（按沙箱 tab 切换）；本地删除标记
//   GROUP_ADMIN → 所辖用户组内全部
//   ADMIN+      → 全站：筛选/搜索/日期/批量/导出
// 沙箱隔离：记录绑定 workspaceId，用户端强制 ws.userId === ctx.userId
// ============================================================

import { actionHandler, type ActionResult } from "@/lib/api"
import { zodValidate, zId } from "@/lib/validators"
import { z } from "zod"
import { requireAuth, requireAdmin } from "@/lib/permissions"
import { db } from "@/lib/db"
import { writeAudit } from "@/lib/audit"
import { trackBehavior } from "@/lib/risk"
import { collectWorkspaceHistory, collectWorkspaceBookmarks, collectAllRunningBrowsing } from "@/lib/browsing-collector"
import { Prisma } from "@prisma/client"

export interface HistoryRow {
  id: string
  workspaceId: string
  workspaceName: string
  workspaceUuid: string | null
  url: string
  title: string | null
  domain: string | null
  visitAt: string
  dwellMs: number
  incognitoHint: boolean
}

export interface BookmarkRow {
  id: string
  workspaceId: string
  workspaceName: string
  workspaceUuid: string | null
  guid: string | null
  url: string
  title: string | null
  folder: string | null
  dateAdded: string | null
  removedAt: string | null
}

// ---- 角色可见范围（USER=本人；GROUP_ADMIN=所辖组；ADMIN+=全站）----
async function historyScope(ctx: { userId: string; role: string }): Promise<Prisma.BrowseHistoryEntryWhereInput> {
  if (ctx.role === "SUPER_ADMIN" || ctx.role === "ADMIN") return {}
  if (ctx.role === "GROUP_ADMIN") {
    const groups = await db.groupAdmin.findMany({ where: { userId: ctx.userId } })
    const gids = groups.map((g) => g.groupId)
    if (gids.length === 0) return { userId: ctx.userId }
    const members = await db.groupUser.findMany({ where: { groupId: { in: gids } }, select: { userId: true } })
    const uids = [...new Set([ctx.userId, ...members.map((m) => m.userId)])]
    return { userId: { in: uids } }
  }
  return { userId: ctx.userId }
}

async function bookmarkScope(ctx: { userId: string; role: string }): Promise<Prisma.BookmarkEntryWhereInput> {
  if (ctx.role === "SUPER_ADMIN" || ctx.role === "ADMIN") return {}
  if (ctx.role === "GROUP_ADMIN") {
    const groups = await db.groupAdmin.findMany({ where: { userId: ctx.userId } })
    const gids = groups.map((g) => g.groupId)
    if (gids.length === 0) return { userId: ctx.userId }
    const members = await db.groupUser.findMany({ where: { groupId: { in: gids } }, select: { userId: true } })
    const uids = [...new Set([ctx.userId, ...members.map((m) => m.userId)])]
    return { userId: { in: uids } }
  }
  return { userId: ctx.userId }
}

const listHistorySchema = z.object({
  keyword: z.string().max(120).optional(),
  workspaceId: zId.optional(),
  workspaceIds: z.array(zId).max(200).optional(),
  userId: zId.optional(),
  username: z.string().max(60).optional(),
  domain: z.string().max(200).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  includeDeleted: z.boolean().optional(),
  page: z.number().int().min(1).max(10000).default(1),
  pageSize: z.number().int().min(10).max(200).default(20),
})

// ---- 1. 浏览历史列表（用户端自动按本人过滤；管理端全量筛选）----
export async function listHistoryAction(input: unknown): Promise<ActionResult<{ rows: HistoryRow[]; total: number; page: number; pageSize: number }>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const p = zodValidate(listHistorySchema, input)

    const scope = await historyScope(ctx)
    // 用户端强制只能看自己的（管理端可指定用户筛选）
    const isPrivileged = ctx.role === "ADMIN" || ctx.role === "SUPER_ADMIN" || ctx.role === "GROUP_ADMIN"
    if (!isPrivileged && p.userId && p.userId !== ctx.userId) {
      return { rows: [], total: 0, page: p.page, pageSize: p.pageSize }
    }

    const where: Prisma.BrowseHistoryEntryWhereInput = {
      ...scope,
      ...(p.userId && (isPrivileged || p.userId === ctx.userId) ? { userId: p.userId } : {}),
      ...(p.workspaceId ? { workspaceId: p.workspaceId } : {}),
      ...(p.workspaceIds && p.workspaceIds.length > 0 ? { workspaceId: { in: p.workspaceIds } } : {}),
      ...(p.includeDeleted ? {} : { deletedAt: null }),
      ...(p.domain ? { domain: { contains: p.domain } } : {}),
      ...((p.from || p.to) ? { visitAt: { ...(p.from ? { gte: new Date(p.from) } : {}), ...(p.to ? { lte: new Date(p.to) } : {}) } } : {}),
      ...(p.keyword ? {
        OR: [
          { url: { contains: p.keyword } },
          { title: { contains: p.keyword } },
          { domain: { contains: p.keyword } },
        ],
      } : {}),
    }

    const [rows, total] = await Promise.all([
      db.browseHistoryEntry.findMany({
        where,
        orderBy: { visitAt: "desc" },
        skip: (p.page - 1) * p.pageSize,
        take: p.pageSize,
      }),
      db.browseHistoryEntry.count({ where }),
    ])

    // username 筛选（管理端）：先解出符合的用户 id 集
    let filteredRows = rows
    if (p.username) {
      const users = await db.user.findMany({ where: { username: { contains: p.username }, deletedAt: null }, select: { id: true } })
      const ids = new Set(users.map((u) => u.id))
      filteredRows = rows.filter((r) => ids.has(r.userId || ""))
    }

    // 沙箱/用户名称映射（沙箱删除后仍可读）
    const wsIds = [...new Set(filteredRows.map((r) => r.workspaceId))]
    const wsRows = wsIds.length ? await db.browserWorkspace.findMany({ where: { id: { in: wsIds } }, select: { id: true, name: true } }) : []
    const wsMap = new Map<string, string>(wsRows.map((w) => [w.id, w.name]))

    const out = filteredRows.map((r) => ({
      id: r.id,
      workspaceId: r.workspaceId,
      workspaceName: wsMap.get(r.workspaceId) || "已删除沙箱",
      workspaceUuid: r.workspaceUuid,
      url: r.url,
      title: r.title,
      domain: r.domain,
      visitAt: r.visitAt.toISOString(),
      dwellMs: r.dwellMs,
      incognitoHint: r.incognitoHint,
    }))
    return { rows: out, total, page: p.page, pageSize: p.pageSize }
  })
}

const listBookmarksSchema = z.object({
  keyword: z.string().max(120).optional(),
  workspaceId: zId.optional(),
  workspaceIds: z.array(zId).max(200).optional(),
  userId: zId.optional(),
  username: z.string().max(60).optional(),
  url: z.string().max(300).optional(),
  includeRemoved: z.boolean().optional(),
  page: z.number().int().min(1).max(10000).default(1),
  pageSize: z.number().int().min(10).max(200).default(20),
})

// ---- 2. 书签列表 ----
export async function listBookmarksAction(input: unknown): Promise<ActionResult<{ rows: BookmarkRow[]; total: number; page: number; pageSize: number }>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const p = zodValidate(listBookmarksSchema, input)
    const scope = await bookmarkScope(ctx)
    const isPrivileged = ctx.role === "ADMIN" || ctx.role === "SUPER_ADMIN" || ctx.role === "GROUP_ADMIN"
    if (!isPrivileged && p.userId && p.userId !== ctx.userId) {
      return { rows: [], total: 0, page: p.page, pageSize: p.pageSize }
    }

    const where: Prisma.BookmarkEntryWhereInput = {
      ...scope,
      ...(p.userId && (isPrivileged || p.userId === ctx.userId) ? { userId: p.userId } : {}),
      ...(p.workspaceId ? { workspaceId: p.workspaceId } : {}),
      ...(p.workspaceIds && p.workspaceIds.length > 0 ? { workspaceId: { in: p.workspaceIds } } : {}),
      ...(p.includeRemoved ? {} : { removedAt: null }),
      ...(p.url ? { url: { contains: p.url } } : {}),
      ...(p.keyword ? {
        OR: [
          { url: { contains: p.keyword } },
          { title: { contains: p.keyword } },
          { folder: { contains: p.keyword } },
        ],
      } : {}),
    }

    const [rows, total] = await Promise.all([
      db.bookmarkEntry.findMany({
        where,
        orderBy: [{ workspaceId: "asc" }, { position: "asc" }],
        skip: (p.page - 1) * p.pageSize,
        take: p.pageSize,
      }),
      db.bookmarkEntry.count({ where }),
    ])

    let filteredRows = rows
    if (p.username) {
      const users = await db.user.findMany({ where: { username: { contains: p.username }, deletedAt: null }, select: { id: true } })
      const ids = new Set(users.map((u) => u.id))
      filteredRows = rows.filter((r) => ids.has(r.userId || ""))
    }

    const wsIds = [...new Set(filteredRows.map((r) => r.workspaceId))]
    const wsRows = wsIds.length ? await db.browserWorkspace.findMany({ where: { id: { in: wsIds } }, select: { id: true, name: true } }) : []
    const wsMap = new Map<string, string>(wsRows.map((w) => [w.id, w.name]))

    const out = filteredRows.map((r) => ({
      id: r.id,
      workspaceId: r.workspaceId,
      workspaceName: wsMap.get(r.workspaceId) || "已删除沙箱",
      workspaceUuid: r.workspaceUuid,
      guid: r.guid,
      url: r.url,
      title: r.title,
      folder: r.folder,
      dateAdded: r.dateAdded?.toISOString() || null,
      removedAt: r.removedAt?.toISOString() || null,
    }))
    return { rows: out, total, page: p.page, pageSize: p.pageSize }
  })
}

// ---- 3. 我的沙箱清单（用户端 tab 切换用；含每沙箱计数）----
export async function myBrowsingWorkspacesAction(): Promise<ActionResult<Array<{ id: string; name: string; uuid: string | null; status: string; historyCount: number; bookmarkCount: number }>>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const isPrivileged = ctx.role === "ADMIN" || ctx.role === "SUPER_ADMIN" || ctx.role === "GROUP_ADMIN"
    const workspaces = await db.browserWorkspace.findMany({
      where: isPrivileged ? {} : { userId: ctx.userId, deletedAt: null },
      select: { id: true, name: true, uuid: true, status: true },
      orderBy: { lastActiveAt: "desc" },
      take: 100,
    })
    const ids = workspaces.map((w) => w.id)
    const [histCounts, bmCounts] = ids.length ? await Promise.all([
      db.browseHistoryEntry.groupBy({ by: ["workspaceId"], where: { workspaceId: { in: ids }, deletedAt: null }, _count: { _all: true } }),
      db.bookmarkEntry.groupBy({ by: ["workspaceId"], where: { workspaceId: { in: ids }, removedAt: null }, _count: { _all: true } }),
    ]) : [[], []]
    const histMap = new Map(histCounts.map((h: { workspaceId: string; _count: { _all: number } }) => [h.workspaceId, h._count._all]))
    const bmMap = new Map(bmCounts.map((b: { workspaceId: string; _count: { _all: number } }) => [b.workspaceId, b._count._all]))
    return workspaces.map((w) => ({
      id: w.id, name: w.name, uuid: w.uuid, status: w.status,
      historyCount: histMap.get(w.id) || 0,
      bookmarkCount: bmMap.get(w.id) || 0,
    }))
  })
}

// ---- 4. 用户本地删除标记（自己的沙箱、自己的记录；审计归档）----
const localDeleteSchema = z.object({
  ids: z.array(zId).min(1).max(100),
  kind: z.enum(["history", "bookmark"]),
  workspaceId: zId.optional(),
})

export async function localDeleteBrowsingAction(input: unknown): Promise<ActionResult<{ deleted: number }>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const p = zodValidate(localDeleteSchema, input)
    const now = new Date()

    if (p.kind === "history") {
      const rows = await db.browseHistoryEntry.findMany({ where: { id: { in: p.ids }, deletedAt: null } })
      // 用户只能删自己的；管理员可代删（审计）
      const mine = rows.filter((r) => r.userId === ctx.userId || ctx.role === "ADMIN" || ctx.role === "SUPER_ADMIN")
      for (const r of mine) {
        await db.browseHistoryEntry.update({ where: { id: r.id }, data: { deletedAt: now } })
        await writeAudit({
          operatorUserId: ctx.userId, operatorName: ctx.username,
          operationType: "HISTORY_LOCAL_DELETE", resourceType: "HISTORY", resourceId: r.id, resourceName: r.title || r.url,
          ownerUserId: r.userId || undefined,
          after: { workspaceId: r.workspaceId, url: r.url.slice(0, 300), deletedAt: now.toISOString(), by: ctx.username },
          severity: "INFO",
        }).catch(() => null)
      }
      await trackBehavior(ctx.userId, "DELETE").catch(() => {})
      return { deleted: mine.length }
    } else {
      const rows = await db.bookmarkEntry.findMany({ where: { id: { in: p.ids }, removedAt: null } })
      const mine = rows.filter((r) => r.userId === ctx.userId || ctx.role === "ADMIN" || ctx.role === "SUPER_ADMIN")
      for (const r of mine) {
        await db.bookmarkEntry.update({ where: { id: r.id }, data: { removedAt: now } })
        await writeAudit({
          operatorUserId: ctx.userId, operatorName: ctx.username,
          operationType: "BOOKMARK_LOCAL_DELETE", resourceType: "BOOKMARK", resourceId: r.id, resourceName: r.title || r.url,
          ownerUserId: r.userId || undefined,
          after: { workspaceId: r.workspaceId, url: r.url.slice(0, 300), removedAt: now.toISOString(), by: ctx.username },
          severity: "INFO",
        }).catch(() => null)
      }
      return { deleted: mine.length }
    }
  })
}

// ---- 5. 手动触发采集（管理员；单沙箱或全量）----
const collectSchema = z.object({
  workspaceId: zId.optional(),
  scope: z.enum(["workspace", "all"]).default("workspace"),
})

export async function triggerBrowsingCollectAction(input: unknown): Promise<ActionResult<{ history: { inserted: number; merged: number }; bookmarks: { upserted: number; removed: number } }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const p = zodValidate(collectSchema, input)

    let history = { inserted: 0, merged: 0 }
    let bookmarks = { upserted: 0, removed: 0 }

    if (p.scope === "all") {
      const r = await collectAllRunningBrowsing()
      history = { inserted: r.historyInserted, merged: r.historyMerged }
      bookmarks = { upserted: r.bookmarkUpserted, removed: r.bookmarkRemoved }
    } else if (p.workspaceId) {
      const ws = await db.browserWorkspace.findUnique({ where: { id: p.workspaceId } })
      if (!ws) return { history, bookmarks }
      const h = await collectWorkspaceHistory(ws)
      history = { inserted: h.inserted, merged: h.merged }
      const b = await collectWorkspaceBookmarks(ws)
      bookmarks = { upserted: b.upserted, removed: b.removed }
    }

    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username,
      operationType: "BROWSING_COLLECT_TRIGGER", resourceType: "SYSTEM",
      after: { scope: p.scope, workspaceId: p.workspaceId, history, bookmarks },
      severity: "INFO",
    }).catch(() => null)
    return { history, bookmarks }
  })
}

// ---- 6. 导出（管理端；脱敏选项）----
const exportSchema = z.object({
  kind: z.enum(["history", "bookmark"]),
  userId: zId.optional(),
  workspaceId: zId.optional(),
  keyword: z.string().max(120).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.number().int().min(1).max(5000).default(1000),
  mask: z.boolean().default(true),
})

export async function exportBrowsingAction(input: unknown): Promise<ActionResult<{ fileName: string; rows: Array<Record<string, string | number | null>> }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const p = zodValidate(exportSchema, input)
    const maskUrl = (u: string) => (p.mask ? u.replace(/([?&](token|key|pass|password|session|sid|auth)=[^&]{2,})/gi, "$1=***") : u)

    if (p.kind === "history") {
      const where: Prisma.BrowseHistoryEntryWhereInput = {
        deletedAt: null,
        ...(p.userId ? { userId: p.userId } : {}),
        ...(p.workspaceId ? { workspaceId: p.workspaceId } : {}),
        ...(p.keyword ? { OR: [{ url: { contains: p.keyword } }, { title: { contains: p.keyword } }, { domain: { contains: p.keyword } }] } : {}),
        ...((p.from || p.to) ? { visitAt: { ...(p.from ? { gte: new Date(p.from) } : {}), ...(p.to ? { lte: new Date(p.to) } : {}) } } : {}),
      }
      const rows = await db.browseHistoryEntry.findMany({ where, orderBy: { visitAt: "desc" }, take: p.limit })
      const wsIds = [...new Set(rows.map((r) => r.workspaceId))]
      const uIds = [...new Set(rows.map((r) => r.userId).filter(Boolean))] as string[]
      const wsRows = wsIds.length ? await db.browserWorkspace.findMany({ where: { id: { in: wsIds } }, select: { id: true, name: true } }) : []
      const uRows = uIds.length ? await db.user.findMany({ where: { id: { in: uIds } }, select: { id: true, username: true } }) : []
    const wsMap = new Map<string, string>(wsRows.map((w) => [w.id, w.name]))
      const uMap = new Map<string, string>(uRows.map((u) => [u.id, u.username]))
      await writeAudit({
        operatorUserId: ctx.userId, operatorName: ctx.username,
        operationType: "BROWSING_EXPORT", resourceType: "HISTORY",
        after: { rows: rows.length, mask: p.mask, kind: p.kind }, severity: "WARN",
      })
      return {
        fileName: `browse-history-${Date.now()}.csv`,
        rows: rows.map((r): Record<string, string | number> => ({
          时间: r.visitAt.toISOString(), 用户: uMap.get(r.userId || "") || "-", 沙箱: wsMap.get(r.workspaceId) || "-",
          标题: r.title || "-", 域名: r.domain || "-", URL: maskUrl(r.url),
          停留秒: Math.round(r.dwellMs / 1000), 无痕提示: r.incognitoHint ? "是" : "否",
        })),
      }
    } else {
      const where: Prisma.BookmarkEntryWhereInput = {
        removedAt: null,
        ...(p.userId ? { userId: p.userId } : {}),
        ...(p.workspaceId ? { workspaceId: p.workspaceId } : {}),
        ...(p.keyword ? { OR: [{ url: { contains: p.keyword } }, { title: { contains: p.keyword } }, { folder: { contains: p.keyword } }] } : {}),
      }
      const rows = await db.bookmarkEntry.findMany({ where, orderBy: [{ workspaceId: "asc" }, { position: "asc" }], take: p.limit })
        const wsIds2 = [...new Set(rows.map((r) => r.workspaceId))]
      const uIds2 = [...new Set(rows.map((r) => r.userId).filter(Boolean))] as string[]
      const wsRows2 = wsIds2.length ? await db.browserWorkspace.findMany({ where: { id: { in: wsIds2 } }, select: { id: true, name: true } }) : []
      const uRows2 = uIds2.length ? await db.user.findMany({ where: { id: { in: uIds2 } }, select: { id: true, username: true } }) : []
      const wsMap2 = new Map<string, string>(wsRows2.map((w) => [w.id, w.name]))
      const uMap2 = new Map<string, string>(uRows2.map((u) => [u.id, u.username]))
      await writeAudit({
        operatorUserId: ctx.userId, operatorName: ctx.username,
        operationType: "BROWSING_EXPORT", resourceType: "BOOKMARK",
        after: { rows: rows.length, mask: p.mask, kind: p.kind }, severity: "WARN",
      })
      return {
        fileName: `bookmarks-${Date.now()}.csv`,
        rows: rows.map((r): Record<string, string> => ({
          用户: uMap2.get(r.userId || "") || "-", 沙箱: wsMap2.get(r.workspaceId) || "-",
          标题: r.title || "-", 文件夹: r.folder || "-", URL: maskUrl(r.url),
          添加时间: r.dateAdded?.toISOString() || "-",
        })),
      }
    }
  })
}
