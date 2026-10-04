import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { apiHandler } from "@/lib/api"
import { requireAdmin } from "@/lib/permissions"
import { writeAudit } from "@/lib/audit"
import { maskSensitive } from "@/lib/crypto"
import { csvEscape, fmtDate } from "@/lib/utils-server"
import { filterGroups } from "@/app/(main)/admin/groups/filter"

interface ExportGroup {
  name: string
  description: string | null
  parentName: string | null
  enabled: boolean
  inheritParentQuota: boolean
  quota: Record<string, number | null> | null
  reservedQuota: Record<string, number | null> | null
  force2fa: boolean
  tags: string[]
  permissionLocks: Record<string, boolean>
  userIds: string[]
  proxyNodeIds: string[]
  admins: { userId: string; canModifyQuota: boolean }[]
}

// ============================================================
// 用户组导出：GET /api/export/groups
//   · 默认（无 format 参数）：JSON 完整组配置（含组员/代理绑定，可直接供导入使用）—— 兼容既有「导出JSON」按钮
//   · r28b format=csv：流式 CSV（500 行/批 ReadableStream 分块输出）
//     - 筛选参数与页面 URL 完全同语义：keyword / enabled / createdFrom / createdTo（当前筛选结果导出，非全量）
//     - ids 参数：仅导出选中组（优先于筛选参数）
//     - RFC5987 中文文件名（filename*=UTF-8''… + ASCII fallback）+ BOM
//     - 列：组名/父组/启用/成员数/组管理员数/配额摘要/权限锁数/创建时间（附加 描述/强制2FA/代理绑定/标签/组ID）
// ============================================================

export async function GET(req: NextRequest) {
  return apiHandler(async () => {
    const ctx = await requireAdmin()
    const sp = req.nextUrl.searchParams
    const format = (sp.get("format") || "json").toLowerCase()
    const idsParam = sp.get("ids")
    const ids = idsParam ? idsParam.split(",").map((s) => s.trim()).filter(Boolean) : null

    if (format === "csv") {
      return exportCsv(ctx, sp, ids)
    }

    // ---------------- JSON 导出（原有语义保留） ----------------
    const [groups, memberships, groupAdmins, groupProxies, allUsers, allProxyNodes] = await Promise.all([
      db.group.findMany({
        where: ids && ids.length > 0 ? { id: { in: ids }, deletedAt: null } : { deletedAt: null },
        orderBy: { createdAt: "asc" },
      }),
      db.groupUser.findMany({
        select: { groupId: true, userId: true },
      }),
      db.groupAdmin.findMany({
        select: { groupId: true, userId: true, canModifyQuota: true },
      }),
      db.groupProxy.findMany({
        select: { groupId: true, proxyNodeId: true },
      }),
      db.user.findMany({ where: { deletedAt: null }, select: { id: true } }),
      db.proxyNode.findMany({ where: { deletedAt: null }, select: { id: true } }),
    ])

    const activeUserIds = new Set(allUsers.map((u) => u.id))
    const activeProxyIds = new Set(allProxyNodes.map((p) => p.id))

    const membersByGroup = new Map<string, string[]>()
    for (const m of memberships) {
      if (!activeUserIds.has(m.userId)) continue
      const arr = membersByGroup.get(m.groupId) || []
      arr.push(m.userId)
      membersByGroup.set(m.groupId, arr)
    }
    const adminsByGroup = new Map<string, { userId: string; canModifyQuota: boolean }[]>()
    for (const a of groupAdmins) {
      if (!activeUserIds.has(a.userId)) continue
      const arr = adminsByGroup.get(a.groupId) || []
      arr.push({ userId: a.userId, canModifyQuota: a.canModifyQuota })
      adminsByGroup.set(a.groupId, arr)
    }
    const proxiesByGroup = new Map<string, string[]>()
    for (const gp of groupProxies) {
      if (!activeProxyIds.has(gp.proxyNodeId)) continue
      const arr = proxiesByGroup.get(gp.groupId) || []
      arr.push(gp.proxyNodeId)
      proxiesByGroup.set(gp.groupId, arr)
    }
    const nameById = new Map(groups.map((g) => [g.id, g.name]))

    const items: ExportGroup[] = groups.map((g) => {
      const policy = (g.policy as Record<string, unknown> | null) || {}
      const tags = Array.isArray(g.tags) ? (g.tags as unknown[]).filter((t): t is string => typeof t === "string") : []
      return {
        name: g.name,
        description: g.description,
        parentName: g.parentId ? nameById.get(g.parentId) || null : null,
        enabled: g.enabled,
        inheritParentQuota: g.inheritParentQuota,
        quota: (g.quota as Record<string, number | null> | null) || null,
        reservedQuota: (g.reservedQuota as Record<string, number | null> | null) || null,
        force2fa: g.force2fa,
        tags,
        permissionLocks: (policy.permissionLocks as Record<string, boolean> | undefined) || {},
        userIds: membersByGroup.get(g.id) || [],
        proxyNodeIds: proxiesByGroup.get(g.id) || [],
        admins: adminsByGroup.get(g.id) || [],
      }
    })

    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "EXPORT",
      resourceType: "GROUP",
      severity: "WARN",
      after: maskSensitive({ count: items.length }),
      extra: { exportFormat: "json" },
    })

    const payload = { exportedAt: new Date().toISOString(), total: items.length, groups: items }
    return new Response(JSON.stringify(payload, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="dockyard-groups-${Date.now()}.json"`,
      },
    })
  })
}

// ---------------- r28b：CSV 流式导出 ----------------
async function exportCsv(
  ctx: { userId: string; username: string },
  sp: URLSearchParams,
  ids: string[] | null
) {
  // 计数与名称预取（成员数 / 组管理员数 / 代理绑定数 / 父组名 / keyword 组员搜索）
  const [groupAdmins, memberships, groupProxies, allUsers] = await Promise.all([
    db.groupAdmin.findMany({ select: { groupId: true } }),
    db.groupUser.findMany({ select: { groupId: true, userId: true }, take: 5000 }),
    db.groupProxy.findMany({ select: { groupId: true } }),
    db.user.findMany({ where: { deletedAt: null }, select: { id: true, username: true } }),
  ])
  const adminCountByGroup = new Map<string, number>()
  for (const a of groupAdmins) adminCountByGroup.set(a.groupId, (adminCountByGroup.get(a.groupId) || 0) + 1)
  const memberCountByGroup = new Map<string, number>()
  for (const m of memberships) memberCountByGroup.set(m.groupId, (memberCountByGroup.get(m.groupId) || 0) + 1)
  const proxyCountByGroup = new Map<string, number>()
  for (const p of groupProxies) proxyCountByGroup.set(p.groupId, (proxyCountByGroup.get(p.groupId) || 0) + 1)
  const usernameById = new Map(allUsers.map((u) => [u.id, u.username]))

  // 全量组行（组表为小表：全量预取 + 共享筛选语义内存过滤，保证与页面筛选 100% 一致）
  const groups = await db.group.findMany({ where: { deletedAt: null }, orderBy: { createdAt: "asc" } })
  const rowsWithTags = groups.map((g) => ({
    ...g,
    tags: Array.isArray(g.tags) ? (g.tags as unknown[]).filter((t): t is string => typeof t === "string") : [],
  }))
  const nameById = new Map(groups.map((g) => [g.id, g.name]))

  let selected: typeof rowsWithTags
  if (ids && ids.length > 0) {
    const idSet = new Set(ids)
    selected = rowsWithTags.filter((g) => idSet.has(g.id))
  } else {
    // 复用页面筛选语义（keyword / enabled / createdFrom / createdTo → 命中组本身，不含祖先链）
    const { matched } = filterGroups(rowsWithTags, memberships, usernameById, {
      keyword: sp.get("keyword") || undefined,
      enabled: sp.get("enabled") || undefined,
      createdFrom: sp.get("createdFrom") || undefined,
      createdTo: sp.get("createdTo") || undefined,
    })
    selected = rowsWithTags.filter((g) => matched.has(g.id))
  }

  const headers = [
    "组名", "描述", "父组", "启用", "强制2FA", "成员数", "组管理员数",
    "配额摘要", "权限锁数", "代理绑定数", "标签", "创建时间", "组ID",
  ]

  const BATCH_SIZE = 500
  const encoder = new TextEncoder()
  let cursor = 0

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // BOM（Excel UTF-8 识别）+ 表头
      controller.enqueue(encoder.encode("\uFEFF" + headers.join(",") + "\n"))
    },
    pull(controller) {
      try {
        const batch = selected.slice(cursor, cursor + BATCH_SIZE)
        cursor += batch.length
        const lines: string[] = []
        for (const g of batch) {
          const quota = (g.quota as Record<string, number | null> | null) || {}
          const locks = ((g.policy as Record<string, unknown> | null)?.permissionLocks as Record<string, boolean> | undefined) || {}
          const lockCount = Object.values(locks).filter(Boolean).length
          const quotaBrief = [
            quota.sessions != null ? `${quota.sessions}会话` : null,
            quota.novncSessions != null ? `${quota.novncSessions}NoVNC` : null,
            quota.diskMb != null ? `${quota.diskMb}MB` : null,
            quota.proxyBandwidthMb != null ? `${quota.proxyBandwidthMb}MB带宽` : null,
          ]
            .filter(Boolean)
            .join("/")
          const row = [
            g.name,
            g.description || "",
            g.parentId ? nameById.get(g.parentId) || "" : "",
            g.enabled ? "true" : "false",
            g.force2fa ? "true" : "false",
            String(memberCountByGroup.get(g.id) || 0),
            String(adminCountByGroup.get(g.id) || 0),
            quotaBrief,
            String(lockCount),
            String(proxyCountByGroup.get(g.id) || 0),
            g.tags.join(" | "),
            fmtDate(g.createdAt),
            g.id,
          ]
          lines.push(row.map(csvEscape).join(","))
        }
        if (lines.length > 0) {
          controller.enqueue(encoder.encode(lines.join("\n") + "\n"))
        }
        if (cursor >= selected.length) {
          controller.close()
        }
      } catch (e) {
        controller.error(e)
      }
    },
  })

  await writeAudit({
    operatorUserId: ctx.userId,
    operatorName: ctx.username,
    operationType: "EXPORT",
    resourceType: "GROUP",
    severity: "WARN",
    after: maskSensitive({
      count: selected.length,
      exportFormat: "csv",
      filters: ids && ids.length > 0 ? { ids: ids.length } : {
        keyword: sp.get("keyword") || null,
        enabled: sp.get("enabled") || null,
        createdFrom: sp.get("createdFrom") || null,
        createdTo: sp.get("createdTo") || null,
      },
      streamed: true,
    }),
  })

  const ts = Date.now()
  const asciiFallback = `dockyard-groups-${ts}.csv`
  const encodedName = encodeURIComponent(`dockyard-用户组-${ts}.csv`).replace(/['()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())

  return new Response(stream, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodedName}`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  })
}
