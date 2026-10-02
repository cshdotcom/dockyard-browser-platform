import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getAuthContext } from "@/lib/permissions"
import { apiHandler } from "@/lib/api"

// ============================================================
// 全局搜索（r23 全面增强）
// · 搜索范围：该用户有权限使用的所有资源（普通用户=自己的+共享给我的；管理员=全平台）
//   工作区 / SingBox实例 / 用户 / 用户组 / 代理节点 / 宿主机 / 脚本模板 / 文件 /
//   API-Key / 公告 / 回收站 / 告警 / 备份 / 审计日志(管理员) / 定时任务(管理员)
// · 筛选栏：类型多选（types=ws,user,group,...）/ 日期范围（from,to）/ 用户过滤（user=xxx，管理员）
// · 每类 take 5（type 单选时 take 20）；结果按类型分组，标注权限语义（如「共享给我」）
// ============================================================

interface SearchItem {
  id: string
  label: string
  sub?: string
  href: string
}
interface SearchGroup {
  group: string
  type: string
  items: SearchItem[]
}

const ALL_TYPES = [
  "ws", "singbox", "user", "group", "proxy", "host", "file",
  "token", "announce", "recycle", "alert", "backup", "audit", "task",
] as const
type SearchType = (typeof ALL_TYPES)[number]

const TYPE_LABEL: Record<SearchType, string> = {
  ws: "浏览器工作区",
  singbox: "SingBox 实例",
  user: "用户",
  group: "用户组",
  proxy: "代理节点",
  host: "宿主机/节点",
  file: "文件",
  token: "API-Key",
  announce: "公告",
  recycle: "回收站",
  alert: "告警",
  backup: "备份",
  audit: "审计日志",
  task: "定时任务",
}

function parseDate(v: string | null): Date | null {
  if (!v) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

export async function GET(req: NextRequest) {
  return apiHandler(async () => {
    const ctx = await getAuthContext()
    if (!ctx) return NextResponse.json({ code: 40100, msg: "未登录" })
    const sp = req.nextUrl.searchParams
    const q = (sp.get("q") || "").trim()
    if (q.length < 2) {
      return NextResponse.json({ code: 0, msg: "ok", data: { groups: [], types: typeCatalog(ctx.role) } })
    }

    const isAdmin = ctx.role === "SUPER_ADMIN" || ctx.role === "ADMIN"
    const kw = { contains: q }
    const typesParam = (sp.get("types") || "").split(",").map((s) => s.trim()).filter((s) => (ALL_TYPES as readonly string[]).includes(s))
    const types = typesParam.length > 0 ? (typesParam as SearchType[]) : [...ALL_TYPES]
    // 单一类型时放宽条数（聚焦浏览）
    const take = types.length === 1 ? 20 : 5
    const from = parseDate(sp.get("from"))
    const to = parseDate(sp.get("to"))
    // 用户过滤（管理员）：按用户名过滤资源归属
    const userFilter = (sp.get("user") || "").trim().toLowerCase()

    // 用户过滤 → 解析为 userId 集合
    let filterUserIds: string[] | null = null
    let filterUserLabel = ""
    if (isAdmin && userFilter) {
      const users = await db.user.findMany({
        where: { OR: [{ username: { contains: userFilter } }, { displayName: { contains: userFilter } }, { email: { contains: userFilter } }], deletedAt: null },
        select: { id: true, username: true },
        take: 10,
      })
      filterUserIds = users.map((u) => u.id)
      filterUserLabel = users.map((u) => u.username).join("、")
    }

    const dateRange = <T extends { lt?: Date; gt?: Date }>(field: T) => {
      const out: Record<string, Date> = {}
      if (from) out.gte = from
      if (to) out.lte = to
      return Object.keys(out).length > 0 ? { ...field, ...out } : undefined
    }

    const wants = (t: SearchType) => types.includes(t)
    const groups: SearchGroup[] = []

    // ---- 工作区（普通用户：自己的 + 共享给我的；管理员：全部或按用户过滤） ----
    if (wants("ws")) {
      let where: Record<string, unknown> = { deletedAt: null, OR: [{ name: kw }, { uuid: kw }] }
      if (!isAdmin) {
        const sharedToMe = await db.workspaceShare.findMany({
          where: { targetUserId: ctx.userId, revokedAt: null, OR: [{ expireAt: null }, { expireAt: { gt: new Date() } }] },
          select: { workspaceId: true },
        })
        where = { deletedAt: null, OR: [{ name: kw }, { uuid: kw }], AND: [{ OR: [{ userId: ctx.userId }, { id: { in: sharedToMe.map((s) => s.workspaceId) } }] }] }
      } else if (filterUserIds) {
        where = { deletedAt: null, OR: [{ name: kw }, { uuid: kw }], userId: { in: filterUserIds } }
      }
      if (from || to) where.createdAt = dateRange({})
      const rows = await db.browserWorkspace.findMany({ where, take, select: { id: true, name: true, uuid: true, status: true, userId: true, mode: true } })
      // 共享给我的标记
      const myShared = isAdmin ? new Set<string>() : new Set(
        (await db.workspaceShare.findMany({ where: { targetUserId: ctx.userId, revokedAt: null, workspaceId: { in: rows.map((r) => r.id) } }, select: { workspaceId: true } })).map((s) => s.workspaceId)
      )
      if (rows.length > 0) {
        groups.push({
          group: TYPE_LABEL.ws, type: "ws",
          items: rows.map((w) => ({
            id: w.id,
            label: `${w.name} · ${w.uuid.slice(0, 12)}`,
            sub: `${w.status === "RUNNING" ? "运行中" : w.status === "DESTROYED" ? "已销毁" : w.status}${myShared.has(w.id) ? " · 共享给我" : w.userId === ctx.userId ? " · 我的" : ""}`,
            href: `/workspaces/${w.id}`,
          })),
        })
      }
    }

    // ---- 管理员专属类型 ----
    if (isAdmin) {
      if (wants("singbox")) {
        const where: Record<string, unknown> = { deletedAt: null, OR: [{ name: kw }, { remark: kw }] }
        const rows = await db.singboxInstance.findMany({ where, take, select: { id: true, name: true, status: true } })
        if (rows.length) groups.push({ group: TYPE_LABEL.singbox, type: "singbox", items: rows.map((s) => ({ id: s.id, label: s.name, sub: s.status, href: `/admin/singbox?focus=${s.id}` })) })
      }
      if (wants("user")) {
        const where: Record<string, unknown> = { deletedAt: null, OR: [{ username: kw }, { email: kw }, { displayName: kw }] }
        if (from || to) where.createdAt = dateRange({})
        const rows = await db.user.findMany({ where, take, select: { id: true, username: true, displayName: true, email: true, role: true, enabled: true } })
        if (rows.length) groups.push({ group: TYPE_LABEL.user, type: "user", items: rows.map((u) => ({ id: u.id, label: u.username, sub: `${u.displayName || u.email || ""}${u.enabled ? "" : " · 已禁用"}`, href: `/admin/users?focus=${u.id}` })) })
      }
      if (wants("group")) {
        const rows = await db.group.findMany({ where: { deletedAt: null, OR: [{ name: kw }, { description: kw }] }, take, select: { id: true, name: true, description: true } })
        if (rows.length) groups.push({ group: TYPE_LABEL.group, type: "group", items: rows.map((g) => ({ id: g.id, label: g.name, sub: g.description || "", href: `/admin/groups?focus=${g.id}` })) })
      }
      if (wants("proxy")) {
        const rows = await db.proxyNode.findMany({ where: { deletedAt: null, OR: [{ name: kw }, { host: kw }] }, take, select: { id: true, name: true, status: true } })
        if (rows.length) groups.push({ group: TYPE_LABEL.proxy, type: "proxy", items: rows.map((p) => ({ id: p.id, label: p.name, sub: p.status, href: `/admin/network?focus=${p.id}` })) })
      }
      if (wants("host")) {
        const rows = await db.hostNode.findMany({ where: { deletedAt: null, OR: [{ name: kw }, { dockerApiUrl: kw }] }, take, select: { id: true, name: true, status: true, cpuUsedPct: true, diskUsedPct: true } })
        if (rows.length) groups.push({ group: TYPE_LABEL.host, type: "host", items: rows.map((h) => ({ id: h.id, label: h.name, sub: `${h.status} · CPU ${h.cpuUsedPct}% · 磁盘 ${h.diskUsedPct}%`, href: `/admin/network?tab=hosts&focus=${h.id}` })) })
      }
      if (wants("token")) {
        const where: Record<string, unknown> = { deletedAt: null, OR: [{ name: kw }, { tokenPrefix: kw }] }
        if (filterUserIds) where.userId = { in: filterUserIds }
        if (from || to) where.createdAt = dateRange({})
        const rows = await db.apiToken.findMany({ where, take, select: { id: true, name: true, tokenPrefix: true, userId: true, enabled: true } })
        if (rows.length) {
          const owners = await db.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.userId))] } }, select: { id: true, username: true } })
          const oMap = new Map(owners.map((o) => [o.id, o.username]))
          groups.push({ group: TYPE_LABEL.token, type: "token", items: rows.map((t) => ({ id: t.id, label: t.name, sub: `${t.tokenPrefix}… · ${oMap.get(t.userId) || "未知"}${t.enabled ? "" : " · 已禁用"}`, href: `/admin/users?focus=${t.userId}&tab=tokens` })) })
        }
      }
      if (wants("alert")) {
        const where: Record<string, unknown> = { OR: [{ title: kw }, { content: kw }] }
        if (from || to) where.createdAt = dateRange({})
        const rows = await db.alert.findMany({ where, orderBy: { createdAt: "desc" }, take, select: { id: true, title: true, level: true, handleStatus: true, createdAt: true } })
        if (rows.length) groups.push({ group: TYPE_LABEL.alert, type: "alert", items: rows.map((a) => ({ id: a.id, label: a.title, sub: `${a.level} · ${new Date(a.createdAt).toLocaleString("zh-CN")}`, href: `/admin/alerts?focus=${a.id}` })) })
      }
      if (wants("backup")) {
        const bWhere: Record<string, unknown> = { OR: [{ status: kw }, { type: kw }] }
        if (from || to) bWhere.createdAt = dateRange({})
        const rows = await db.backupRecord.findMany({
          where: bWhere as never,
          orderBy: { createdAt: "desc" }, take,
          select: { id: true, status: true, sizeBytes: true, createdAt: true, type: true },
        }).catch(() => [])
        if (rows.length) groups.push({ group: TYPE_LABEL.backup, type: "backup", items: rows.map((b) => ({ id: b.id, label: `${b.type} 备份 · ${Math.round(b.sizeBytes / 1024)}KB`, sub: `${b.status} · ${new Date(b.createdAt).toLocaleString("zh-CN")}`, href: "/admin/backups" })) })
      }
      if (wants("audit")) {
        const where: Record<string, unknown> = { OR: [{ operationType: kw }, { resourceName: kw }, { operatorName: kw }, { resourceId: kw }] }
        if (from || to) where.createdAt = dateRange({})
        if (filterUserIds) where.operatorUserId = { in: filterUserIds }
        const rows = await db.auditLog.findMany({ where, orderBy: { createdAt: "desc" }, take, select: { id: true, operationType: true, resourceName: true, operatorName: true, severity: true, createdAt: true } })
        if (rows.length) groups.push({ group: TYPE_LABEL.audit, type: "audit", items: rows.map((a) => ({ id: a.id, label: `${a.operationType} · ${a.resourceName || a.id.slice(0, 8)}`, sub: `${a.operatorName} · ${new Date(a.createdAt).toLocaleString("zh-CN")}${a.severity !== "INFO" ? ` · ${a.severity}` : ""}`, href: `/admin/audit?focus=${a.id}` })) })
      }
      if (wants("task")) {
        const rows = await db.scheduleTask.findMany({ where: { OR: [{ code: kw }, { name: kw }, { description: kw }] }, take, select: { code: true, name: true, enabled: true, isCustom: true } })
        if (rows.length) groups.push({ group: TYPE_LABEL.task, type: "task", items: rows.map((t) => ({ id: t.code, label: t.name, sub: `${t.isCustom ? "自定义" : "内置"} · ${t.enabled ? "启用" : "停用"}`, href: `/admin/tasks?focus=${t.code}` })) })
      }
    }

    // ---- 用户可见类型（自己的资源） ----
    if (wants("file") && isAdmin) {
      const where: Record<string, unknown> = { deletedAt: null, fileName: kw }
      if (filterUserIds) where.userId = { in: filterUserIds }
      if (from || to) where.createdAt = dateRange({})
      const rows = await db.fileMeta.findMany({ where, take, select: { id: true, fileName: true, size: true, category: true } }).catch(() => [])
      if (rows.length) groups.push({ group: TYPE_LABEL.file, type: "file", items: rows.map((f) => ({ id: f.id, label: f.fileName, sub: `${Math.round(f.size / 1024)}KB · ${f.category || "FILE"}`, href: `/admin/files?focus=${f.id}` })) })
    }
    if (wants("announce")) {
      // Announcement 无 deletedAt 字段（以 enabled 管理展示），此处过滤会 500 —— 修复：仅按关键词+日期过滤
      const where: Record<string, unknown> = { OR: [{ title: kw }, { content: kw }] }
      if (from || to) where.createdAt = dateRange({})
      const rows = await db.announcement.findMany({ where, orderBy: { createdAt: "desc" }, take, select: { id: true, title: true, type: true, createdAt: true } })
      if (rows.length) groups.push({ group: TYPE_LABEL.announce, type: "announce", items: rows.map((a) => ({ id: a.id, label: a.title, sub: `${a.type} · ${new Date(a.createdAt).toLocaleString("zh-CN")}`, href: isAdmin ? `/admin/announcements?focus=${a.id}` : `/announcements?focus=${a.id}` })) })
    }
    if (wants("recycle")) {
      const where: Record<string, unknown> = { restoredAt: null, OR: [{ resourceName: kw }, { resourceType: kw }] }
      if (isAdmin && filterUserIds) where.ownerUserId = { in: filterUserIds }
      if (from || to) where.createdAt = dateRange({})
      const rows = await db.recycleBin.findMany({ where, orderBy: { createdAt: "desc" }, take, select: { id: true, resourceName: true, resourceType: true, purgeAt: true } }).catch(() => [])
      if (rows.length) groups.push({ group: TYPE_LABEL.recycle, type: "recycle", items: rows.map((r) => ({ id: r.id, label: `${r.resourceName || r.id.slice(0, 10)}`, sub: `${r.resourceType}${r.purgeAt ? ` · 将清除于 ${new Date(r.purgeAt).toLocaleString("zh-CN")}` : " · 保留中"}`, href: "/admin/recycle" })) })
    }

    return NextResponse.json({
      code: 0,
      msg: "ok",
      data: {
        groups,
        types: typeCatalog(ctx.role),
        filters: { appliedTypes: types, from: from?.toISOString() ?? null, to: to?.toISOString() ?? null, user: filterUserLabel || null },
      },
    })
  })
}

function typeCatalog(role: string): { type: string; label: string; adminOnly: boolean }[] {
  const isAdmin = role === "SUPER_ADMIN" || role === "ADMIN"
  return ALL_TYPES.filter((t) => !adminOnly(t) || isAdmin).map((t) => ({ type: t, label: TYPE_LABEL[t], adminOnly: adminOnly(t) }))
}
function adminOnly(t: SearchType): boolean {
  return ["singbox", "user", "group", "proxy", "host", "alert", "backup", "audit", "task"].includes(t)
}
