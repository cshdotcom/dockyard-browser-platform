import { db } from "@/lib/db"
import { requireAuth, userGroupIds } from "@/lib/permissions"
import { parseListQuery, pageSkipTake, safeOrderBy, fmtDate } from "@/lib/utils-server"
import { StatCard } from "@/components/shared/confirm"
import { FileCode2, Globe, Layers, GitBranch } from "lucide-react"
import { TemplatesTable, type TemplateRow } from "./templates-table"

// 会话模板（用户侧）：可见范围 = GLOBAL 全局模板 / 我所在组的 GROUP 模板 / 我自己的模板
export const metadata = { title: "会话模板" }

export default async function TemplatesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const ctx = await requireAuth()
  const sp = await searchParams
  const q = parseListQuery(sp)
  const f = q.filters

  const gids = await userGroupIds(ctx.userId)

  // 可见范围：GLOBAL / 我所在组 GROUP / 我自己的
  const visibility = {
    OR: [
      { scope: "GLOBAL" },
      { scope: "GROUP", groupId: { in: gids } },
      { userId: ctx.userId },
    ],
  }
  const where: Record<string, unknown> = { deletedAt: null }
  if (f.scope) where.scope = f.scope
  if (q.keyword) {
    // 关键词与可见范围 AND 组合
    where.AND = [
      visibility,
      { OR: [{ name: { contains: q.keyword } }, { description: { contains: q.keyword } }] },
    ]
  } else {
    Object.assign(where, visibility)
  }

  const [rows, total, totalCount, globalCount, groupCount] = await Promise.all([
    db.browserTemplate.findMany({
      where,
      ...pageSkipTake(q),
      orderBy: safeOrderBy(q, ["createdAt", "name", "version", "updatedAt"], { createdAt: "desc" }),
    }),
    db.browserTemplate.count({ where }),
    db.browserTemplate.count({
      where: {
        deletedAt: null,
        OR: [{ scope: "GLOBAL" }, { scope: "GROUP", groupId: { in: gids } }, { userId: ctx.userId }],
      },
    }),
    db.browserTemplate.count({ where: { deletedAt: null, scope: "GLOBAL" } }),
    db.browserTemplate.count({ where: { deletedAt: null, scope: "GROUP", groupId: { in: gids } } }),
  ])

  // 创建人 / 父模板 / 组名（内存 join）
  const creatorIds = [...new Set(rows.map((r) => r.createdByUserId).filter((v): v is string => !!v))]
  const parentIds = [...new Set(rows.map((r) => r.parentId).filter((v): v is string => !!v))]
  const groupIdsInPage = [...new Set(rows.map((r) => r.groupId).filter((v): v is string => !!v))]
  const [creators, parents, groups] = await Promise.all([
    creatorIds.length ? db.user.findMany({ where: { id: { in: creatorIds } }, select: { id: true, username: true, displayName: true } }) : [],
    parentIds.length
      ? db.browserTemplate.findMany({ where: { id: { in: parentIds } }, select: { id: true, name: true, deletedAt: true } })
      : [],
    groupIdsInPage.length ? db.group.findMany({ where: { id: { in: groupIdsInPage } }, select: { id: true, name: true } }) : [],
  ])
  const creatorMap = new Map<string, string>(creators.map((c): [string, string] => [c.id, c.displayName || c.username]))
  const parentMap = new Map<string, string>(parents.map((p): [string, string] => [p.id, p.name + (p.deletedAt ? "（已删除）" : "")]))
  const groupMap = new Map<string, string>(groups.map((g): [string, string] => [g.id, g.name]))

  const list: TemplateRow[] = rows.map((t) => {
    let config: { ua?: string; timezone?: string; locale?: string; variables?: Record<string, string> } = {}
    try {
      config = JSON.parse(t.configJson)
    } catch {
      config = {}
    }
    return {
      id: t.id,
      name: t.name,
      description: t.description || "",
      scope: t.scope,
      scopeLabel: t.scope === "PRIVATE" ? "私有" : t.scope === "GROUP" ? "组共享" : "全局",
      groupName: t.groupId ? groupMap.get(t.groupId) || t.groupId : null,
      version: t.version,
      tags: Array.isArray(t.tags) ? (t.tags as string[]) : [],
      parentId: t.parentId,
      parentName: t.parentId ? parentMap.get(t.parentId) || t.parentId : null,
      isOwner: t.userId === ctx.userId,
      creatorName: t.createdByUserId ? creatorMap.get(t.createdByUserId) || t.createdByUserId : "系统",
      createdAt: fmtDate(t.createdAt),
      updatedAt: fmtDate(t.updatedAt),
      config: {
        ua: config.ua || "",
        timezone: config.timezone || "",
        locale: config.locale || "",
        variables: config.variables || {},
        exitGuard: (config as { exitGuard?: "normal" | "fullscreen" | "kiosk" }).exitGuard,
        policyJson: (config as { policyJson?: Record<string, unknown> }).policyJson,
      },
    }
  })

  // 表单选择器数据：启用的 UA 记录 + 我的组
  const [uaOptions, myGroups] = await Promise.all([
    db.uaRecord.findMany({ where: { enabled: true }, orderBy: { label: "asc" }, select: { id: true, ua: true, label: true, category: true } }),
    db.group.findMany({ where: { id: { in: gids }, deletedAt: null }, select: { id: true, name: true } }),
  ])

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">会话模板</h1>
        <p className="text-sm text-muted-foreground mt-1">
          浏览器会话的 UA / 时区 / 语言等预设配置，支持模板继承与 JSON 导入导出
        </p>
      </div>

      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard title="可见模板" value={totalCount} sub={`当前筛选 ${total} 条`} icon={<FileCode2 className="h-4 w-4" />} />
        <StatCard title="全局模板" value={globalCount} sub="管理员维护，全员可用" icon={<Globe className="h-4 w-4" />} />
        <StatCard title="组共享模板" value={groupCount} sub="我所在组" icon={<Layers className="h-4 w-4" />} />
        <StatCard title="继承模板" value={rows.filter((r) => r.parentId).length} sub="本页含父模板引用" icon={<GitBranch className="h-4 w-4" />} />
      </div>

      <TemplatesTable
        rows={list}
        total={total}
        page={q.page}
        pageSize={q.pageSize}
        keyword={q.keyword}
        sortField={q.sortField}
        sortOrder={q.sortOrder}
        filters={f}
        uaOptions={uaOptions.map((u) => ({ id: u.id, ua: u.ua, label: `${u.label}${u.category === "MOBILE" ? "（移动）" : ""}` }))}
        myGroups={myGroups.map((g) => ({ id: g.id, name: g.name }))}
        isAdmin={ctx.role === "SUPER_ADMIN" || ctx.role === "ADMIN"}
      />
    </div>
  )
}
