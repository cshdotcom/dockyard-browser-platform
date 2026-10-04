import { db } from "@/lib/db"
import { requireAdmin } from "@/lib/permissions"
import { parseListQuery, pageSkipTake, safeOrderBy, fmtDate, fmtBytes } from "@/lib/utils-server"
import { getConfigBool, getConfigNumber } from "@/lib/config"
import { StatCard } from "@/components/shared/confirm"
import { Button } from "@/components/ui/button"
import { FilesTable, type FileRow } from "./files-table"
import { buildFilesWhere } from "./where"
import { UploadCard } from "./upload-card"
import { TopUsersCard, type UserDiskRow } from "./top-users-card"
import { FileText, HardDrive, FilePlus2, ShieldCheck, Download } from "lucide-react"

// 文件存储管理（管理员）：分页列表 / 统计 / 用户占用 Top10 / 上传 / 下载 / 软删
// r28a 增强：
//   · 分布式节点筛选（默认主节点 storageNodeId=null；BrowserNode 多选；「全部节点」）
//   · 归属点击筛选（owner 列可点击 → userId 过滤）
//   · CSV 导出（/api/export/files 按当前筛选条件流式导出）
//   · isFavorite / storageNodeId 列展示 + 批量删除 / 批量立即过期
export const metadata = { title: "文件存储" }

export default async function AdminFilesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requireAdmin()
  const sp = await searchParams
  const q = parseListQuery(sp)
  const f = q.filters

  // ---- 筛选：category / 用户 / 关键词 / 存储节点（默认主节点） ----
  const where = buildFilesWhere({ category: f.category, userId: f.userId, keyword: q.keyword, node: f.node })

  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)

  const [rows, total, statAll, statSize, statToday, topUsers, userOptions, browserNodes, virusScanEnabled, quotaMb] = await Promise.all([
    db.fileMeta.findMany({
      where,
      ...pageSkipTake(q),
      orderBy: safeOrderBy(q, ["createdAt", "size", "fileName", "expireAt"], { createdAt: "desc" }),
    }),
    db.fileMeta.count({ where }),
    db.fileMeta.count({ where: { deletedAt: null } }),
    db.fileMeta.aggregate({ where: { deletedAt: null }, _sum: { size: true } }),
    db.fileMeta.count({ where: { deletedAt: null, createdAt: { gte: startOfToday } } }),
    // 按用户聚合磁盘占用 Top10
    db.fileMeta.groupBy({
      by: ["userId"],
      where: { deletedAt: null, userId: { not: null } },
      _sum: { size: true },
      _count: { id: true },
      orderBy: { _sum: { size: "desc" } },
      take: 10,
    }),
    // 用户筛选下拉（供选择上传者）
    db.user.findMany({
      where: { deletedAt: null },
      select: { id: true, username: true, displayName: true },
      orderBy: { username: "asc" },
      take: 200,
    }),
    // 分布式存储节点（节点筛选下拉；参照 admin/network 的 BrowserNode 查询）
    db.browserNode.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true, status: true },
      orderBy: { name: "asc" },
      take: 100,
    }),
    getConfigBool("storage.virusScan", false),
    getConfigNumber("storage.quotaPerUserMb", 2048),
  ])

  // 上传者 / 占用者用户名（内存 join，schema 无关联）
  const involvedUserIds = [...new Set([...rows.map((r) => r.userId).filter((v): v is string => !!v), ...topUsers.map((t) => t.userId).filter((v): v is string => !!v)])]
  const involvedUsers = involvedUserIds.length
    ? await db.user.findMany({ where: { id: { in: involvedUserIds } }, select: { id: true, username: true } })
    : []
  const userNameById = new Map(involvedUsers.map((u) => [u.id, u.username]))
  const nodeNameById = new Map(browserNodes.map((n) => [n.id, n.name]))

  const list: FileRow[] = rows.map((file) => ({
    id: file.id,
    fileName: file.fileName,
    size: file.size,
    sizeText: fmtBytes(file.size),
    category: file.category,
    userId: file.userId,
    username: file.userId ? userNameById.get(file.userId) || file.userId : null,
    workspaceId: file.workspaceId,
    storageNodeId: file.storageNodeId,
    nodeLabel: file.storageNodeId ? nodeNameById.get(file.storageNodeId) || file.storageNodeId.slice(0, 10) : null,
    isFavorite: file.isFavorite,
    expireAt: file.expireAt ? fmtDate(file.expireAt) : null,
    expired: !!file.expireAt && file.expireAt.getTime() < Date.now(),
    virusScanned: file.virusScanned,
    createdAt: fmtDate(file.createdAt),
  }))

  const topList: UserDiskRow[] = topUsers.map((t) => ({
    userId: t.userId || "",
    username: userNameById.get(t.userId || "") || t.userId || "未知用户",
    totalSize: t._sum.size || 0,
    totalSizeText: fmtBytes(t._sum.size || 0),
    fileCount: t._count.id,
  }))

  const myUsedAgg = await db.fileMeta.aggregate({ where: { userId: { not: null }, deletedAt: null }, _sum: { size: true } })

  // CSV 导出链接（按当前筛选条件；导出路由内复用同一 where 语义）
  const exportParams = new URLSearchParams()
  if (q.keyword) exportParams.set("keyword", q.keyword)
  if (f.category) exportParams.set("category", f.category)
  if (f.userId) exportParams.set("userId", f.userId)
  if (f.node) exportParams.set("node", f.node)
  const exportUrl = `/api/export/files${exportParams.size > 0 ? `?${exportParams.toString()}` : ""}`

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">文件存储</h1>
          <p className="text-sm text-muted-foreground mt-1">
            全平台文件管控：上传（后缀黑名单 + 魔数校验 + 配额）/ 下载鉴权 / 软删除入回收站 / 病毒扫描 / 过期管理 / 分布式节点筛选
          </p>
        </div>
        <Button variant="outline" asChild>
          <a href={exportUrl} title="按当前筛选条件导出 CSV">
            <Download className="mr-1 h-4 w-4" /> 导出 CSV（当前筛选）
          </a>
        </Button>
      </div>

      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard title="总文件数" value={statAll} sub="不含回收站软删" icon={<FileText className="h-4 w-4" />} />
        <StatCard title="总占用空间" value={fmtBytes(statSize._sum.size || 0)} sub="全部未删除文件" icon={<HardDrive className="h-4 w-4" />} />
        <StatCard title="今日新增" value={statToday} sub="当天上传文件" icon={<FilePlus2 className="h-4 w-4" />} tone="success" />
        <StatCard
          title="病毒扫描"
          value={virusScanEnabled ? "已开启" : "未开启"}
          sub={virusScanEnabled ? "上传后自动调用扫描接口" : "storage.virusScan=false"}
          icon={<ShieldCheck className="h-4 w-4" />}
          tone={virusScanEnabled ? "success" : "warning"}
        />
      </div>

      <div className="grid gap-6 grid-cols-1 xl:grid-cols-[2fr_1fr]">
        <div className="space-y-6">
          <UploadCard quotaMb={quotaMb} totalUsedBytes={myUsedAgg._sum.size || 0} virusScanEnabled={virusScanEnabled} />
          <FilesTable
            rows={list}
            total={total}
            page={q.page}
            pageSize={q.pageSize}
            keyword={q.keyword}
            sortField={q.sortField}
            sortOrder={q.sortOrder}
            filters={f}
            nodeOptions={browserNodes.map((n) => ({ label: `${n.name}（${n.status}）`, value: n.id }))}
            userOptions={userOptions.map((u) => ({ label: u.username, value: u.id }))}
          />
        </div>
        <TopUsersCard rows={topList} quotaMb={quotaMb} />
      </div>
    </div>
  )
}
