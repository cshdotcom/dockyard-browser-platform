import { db } from "@/lib/db"
import { requireAdmin } from "@/lib/permissions"
import { parseListQuery, pageSkipTake, safeOrderBy, fmtDate, fmtBytes } from "@/lib/utils-server"
import { getConfigBool, getConfigNumber } from "@/lib/config"
import { StatCard } from "@/components/shared/confirm"
import { FilesTable, type FileRow } from "./files-table"
import { UploadCard } from "./upload-card"
import { TopUsersCard, type UserDiskRow } from "./top-users-card"
import { FileText, HardDrive, FilePlus2, ShieldCheck } from "lucide-react"
import { FileExplorerPanel } from "@/components/file-explorer/file-explorer-panel"
import { Home, Server } from "lucide-react"

// 文件存储管理（管理员）：分页列表 / 统计 / 用户占用 Top10 / 上传 / 下载 / 软删
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
  // r31：深链定位（用户资料直达 /admin/files?domain=STORAGE&path=home/<userId>）
  const deepDomain = (sp.domain as string | undefined) || ""
  const deepPath = (sp.path as string | undefined) || ""
  const initialDomain = deepDomain === "ROOT_FS" || deepDomain === "STORAGE" || deepDomain === "HOME" ? deepDomain : "STORAGE"

  // ---- 筛选：category / 用户 / 关键词 ----
  const where: Record<string, unknown> = { deletedAt: null }
  if (f.category) where.category = f.category
  if (f.userId) where.userId = f.userId
  if (q.keyword) where.OR = [{ fileName: { contains: q.keyword } }, { storageKey: { contains: q.keyword } }]

  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)

  const [rows, total, statAll, statSize, statToday, topUsers, userOptions, virusScanEnabled, quotaMb] = await Promise.all([
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
    getConfigBool("storage.virusScan", false),
    getConfigNumber("storage.quotaPerUserMb", 2048),
  ])

  // 上传者 / 占用者用户名（内存 join，schema 无关联）
  const involvedUserIds = [...new Set([...rows.map((r) => r.userId).filter((v): v is string => !!v), ...topUsers.map((t) => t.userId).filter((v): v is string => !!v)])]
  const involvedUsers = involvedUserIds.length
    ? await db.user.findMany({ where: { id: { in: involvedUserIds } }, select: { id: true, username: true } })
    : []
  const userNameById = new Map(involvedUsers.map((u) => [u.id, u.username]))

  const list: FileRow[] = rows.map((file) => ({
    id: file.id,
    fileName: file.fileName,
    size: file.size,
    sizeText: fmtBytes(file.size),
    category: file.category,
    userId: file.userId,
    username: file.userId ? userNameById.get(file.userId) || file.userId : null,
    workspaceId: file.workspaceId,
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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">文件存储</h1>
        <p className="text-sm text-muted-foreground mt-1">
          全平台文件管控：上传（后缀黑名单 + 魔数校验 + 配额）/ 下载鉴权 / 软删除入回收站 / 病毒扫描 / 过期管理
        </p>
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

      <div className="rounded-xl border bg-card p-4 space-y-4">
        <div>
          <h2 className="text-lg font-semibold">全盘文件管理器</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            容器全盘（只读浏览 + 非敏感区受控写）/ 平台存储 / 用户空间三域切换；编辑器 / 预览 / 压缩解压 / 深度搜索 / 批量操作
          </p>
        </div>
        <FileExplorerPanel
          initialDomain={initialDomain as "ROOT_FS" | "STORAGE" | "HOME"}
          initialPath={deepPath || undefined}
          domains={[
            { key: "ROOT_FS", label: "容器全盘", icon: <Server className="h-3.5 w-3.5" /> },
            { key: "STORAGE", label: "平台存储", icon: <HardDrive className="h-3.5 w-3.5" /> },
            { key: "HOME", label: "我的空间", icon: <Home className="h-3.5 w-3.5" /> },
          ]}
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
            userOptions={userOptions.map((u) => ({ label: u.username, value: u.id }))}
          />
        </div>
        <TopUsersCard rows={topList} quotaMb={quotaMb} />
      </div>
    </div>
  )
}
