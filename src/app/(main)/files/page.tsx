import { db } from "@/lib/db"
import { requireAuth } from "@/lib/permissions"
import { fmtBytes, fmtDate } from "@/lib/utils-server"
import { getConfigNumber } from "@/lib/config"
import { StatCard } from "@/components/shared/confirm"
import { FilesClient } from "./files-client"
import type { UserFileRow } from "./types"
import { HardDrive, FileText, Share2, Star } from "lucide-react"

// ============================================================
// 用户云盘 /files（r28a）：登录用户专属
//   · 安全视图：仅本人文件（userId = 当前用户）；PROFILE / BACKUP 永不展示
//     （浏览器 Profile 绝不暴露给用户；AVATAR / RECORDING / SCREENSHOT /
//       SNAPSHOT / LOG / REPORT / GENERAL 正常可见）
//   · 管理员访问 /files 同样只看自己的云盘（全站视图走 /admin/files）
//   · ?focus=<FileMeta.id>：通知直达 —— 自动定位高亮 + 打开预览
//   · 交互（多标签页 / 收藏夹 / 预览 / 在线编辑 / 分享 / 批量）见 files-client.tsx
// ============================================================

export const metadata = { title: "我的云盘" }

const MAX_ROWS = 2000 // 单用户云盘 UI 渲染上限（超出提示分目录浏览）

export default async function MyFilesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const ctx = await requireAuth()
  const sp = await searchParams
  const focusRaw = sp.focus
  const focus = typeof focusRaw === "string" && focusRaw.trim() ? focusRaw.trim() : undefined

  const where = {
    userId: ctx.userId,
    deletedAt: null,
    purgedAt: null,
    category: { notIn: ["PROFILE", "BACKUP"] },
  }

  const [files, usedAgg, visibleCount, favCount, shareCount, me, defaultQuotaMb] = await Promise.all([
    db.fileMeta.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: MAX_ROWS,
      select: {
        id: true, fileName: true, storageKey: true, size: true, mime: true,
        category: true, isFavorite: true, createdAt: true, expireAt: true,
      },
    }),
    // 配额占用：全部本人未删除文件（含头像/录像等，与管理端配额口径一致）
    db.fileMeta.aggregate({ where: { userId: ctx.userId, deletedAt: null, purgedAt: null }, _sum: { size: true } }),
    db.fileMeta.count({ where }),
    db.fileMeta.count({ where: { ...where, isFavorite: true } }),
    db.fileShare.count({ where: { createdByUserId: ctx.userId, revokedAt: null } }),
    db.user.findUnique({ where: { id: ctx.userId }, select: { quota: true } }),
    getConfigNumber("storage.quotaPerUserMb", 2048),
  ])

  const rows: UserFileRow[] = files.map((f) => {
    const key = f.storageKey.includes("/") ? f.storageKey.slice(0, f.storageKey.lastIndexOf("/")) : ""
    return {
      id: f.id,
      fileName: f.fileName,
      storageKey: f.storageKey,
      folder: key,
      size: f.size,
      mime: f.mime,
      category: f.category,
      isFavorite: f.isFavorite,
      createdAt: fmtDate(f.createdAt),
      expireAt: f.expireAt ? fmtDate(f.expireAt) : null,
      expired: !!f.expireAt && f.expireAt.getTime() < Date.now(),
    }
  })

  const usedBytes = usedAgg._sum.size || 0
  const quotaMb = (me?.quota as Record<string, number> | null)?.diskMb ?? defaultQuotaMb
  const quotaBytes = quotaMb > 0 ? quotaMb * 1024 * 1024 : 0
  const quotaPct = quotaBytes > 0 ? Math.min(100, (usedBytes / quotaBytes) * 100) : null

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">我的云盘</h1>
        <p className="text-sm text-muted-foreground mt-1">
          个人文件空间：预览 / 在线编辑 / 收藏 / 公开分享 / 批量管理 —— 配额与分享全程审计留痕
        </p>
      </div>

      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="我的配额"
          value={fmtBytes(usedBytes)}
          sub={`配额 ${quotaMb > 0 ? `${quotaMb} MB` : "不限"}${quotaPct != null ? ` · 已用 ${quotaPct.toFixed(0)}%` : ""}`}
          icon={<HardDrive className="h-4 w-4" />}
          tone={quotaPct != null && quotaPct >= 90 ? "danger" : quotaPct != null && quotaPct >= 80 ? "warning" : "default"}
        />
        <StatCard title="文件数" value={visibleCount} sub="不含系统私有类型" icon={<FileText className="h-4 w-4" />} />
        <StatCard title="有效分享" value={shareCount} sub="我创建的未撤销分享" icon={<Share2 className="h-4 w-4" />} />
        <StatCard title="收藏文件" value={favCount} sub="星标收藏夹" icon={<Star className="h-4 w-4" />} tone="success" />
      </div>

      <FilesClient
        rows={rows}
        focus={focus}
        truncated={visibleCount > rows.length}
        quotaPct={quotaPct}
      />
    </div>
  )
}
