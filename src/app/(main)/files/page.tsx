import { requireAuth } from "@/lib/permissions"
import { FileExplorerPanel, type Domain } from "@/components/file-explorer/file-explorer-panel"
import { Home, HardDrive, Server, FolderOpen, Video, Camera } from "lucide-react"
import { StatCard } from "@/components/shared/confirm"
import { promises as fsp } from "fs"
import path from "path"
import { db } from "@/lib/db"
import { ENV } from "@/lib/env"
import { dirSize } from "@/lib/file-explorer"
import { getUserStorageUsage } from "@/lib/storage-quota"

// ============================================================
// 我的文件（r28 用户空间 → r33 三域 + 深链定位）
// 编辑器（MD/TXT/HTML）/ 预览 / 上传下载（限速）/ 分享链接
// r33 新增：
//   · 「我的录像」「我的截图」只读域（录像/截图计入个人存储配额，可在此查看/下载）
//   · ?focus=<FileMetaId> 深链定位（站内信「录像完成/截图完成」与我的录像「更多」直达对应文件）
// ============================================================
export const metadata = { title: "我的文件" }

export default async function MyFilesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireAuth()
  const sp = await searchParams
  const focusId = typeof sp.focus === "string" ? sp.focus : ""

  const home = path.join(ENV.storageLocalPath, "home", ctx.userId)
  const [usedBytes, fileCount, recUsage] = await Promise.all([
    dirSize(home).catch(() => 0),
    countFiles(home),
    getUserStorageUsage(ctx.userId),
  ])

  // ---- focus 深链解析：FileMeta → 域 + 相对路径 + 文件名（定位到所在目录并高亮选中）----
  let focusInfo: { domain: Domain; path: string; fileName: string } | null = null
  if (focusId) {
    const meta = await db.fileMeta.findFirst({ where: { id: focusId, userId: ctx.userId, deletedAt: null } }).catch(() => null)
    if (meta?.storageKey) {
      const key = meta.storageKey
      if (key.startsWith(`recordings/${ctx.userId}/`)) {
        const rel = key.slice(`recordings/${ctx.userId}/`.length)
        focusInfo = { domain: "RECORDING", path: rel.split("/").slice(0, -1).join("/"), fileName: rel.split("/").pop() || meta.fileName }
      } else if (key.startsWith(`screenshots/${ctx.userId}/`)) {
        const rel = key.slice(`screenshots/${ctx.userId}/`.length)
        focusInfo = { domain: "SCREENSHOT", path: rel.split("/").slice(0, -1).join("/"), fileName: rel.split("/").pop() || meta.fileName }
      } else {
        // HOME/其他：文件名定位（若存在）
        focusInfo = { domain: "HOME", path: "", fileName: meta.fileName }
      }
    }
  }

  const initialDomain: Domain = focusInfo?.domain ?? "HOME"
  const domains: Array<{ key: Domain; label: string; icon: React.ReactNode }> = [
    { key: "HOME", label: "我的空间", icon: <Home className="h-3.5 w-3.5" /> },
    { key: "RECORDING", label: "我的录像", icon: <Video className="h-3.5 w-3.5" /> },
    { key: "SCREENSHOT", label: "我的截图", icon: <Camera className="h-3.5 w-3.5" /> },
  ]

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">我的文件</h1>
        <p className="text-sm text-muted-foreground mt-1">
          您的专属文件空间（编辑器 / 预览 / 上传下载 / 分享链接）；录像与截图统一计入个人存储配额，可在「存储与配额」查看用量明细
        </p>
      </div>

      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard title="云盘空间占用" value={fmtB(usedBytes)} sub="个人文件空间" icon={<FolderOpen className="h-4 w-4" />} />
        <StatCard title="文件数" value={fileCount} sub="云盘全部类型" icon={<HardDrive className="h-4 w-4" />} />
        <StatCard title="录像占用" value={fmtB(recUsage.recordingBytes)} sub={`${recUsage.recordingCount} 段 · 计入配额`} icon={<Video className="h-4 w-4" />} />
        <StatCard title="截图占用" value={fmtB(recUsage.screenshotBytes)} sub={`${recUsage.screenshotCount} 张 · 计入配额`} icon={<Camera className="h-4 w-4" />} />
      </div>

      <FileExplorerPanel
        initialDomain={initialDomain}
        initialPath={focusInfo?.path || ""}
        domains={domains}
        focusFileName={focusInfo?.fileName || ""}
      />
    </div>
  )
}

function fmtB(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

async function countFiles(dir: string, depth = 0): Promise<number> {
  if (depth > 8) return 0
  let count = 0
  const items = await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const item of items) {
    if (item.isDirectory()) count += await countFiles(path.join(dir, item.name), depth + 1)
    else count++
  }
  return count
}
