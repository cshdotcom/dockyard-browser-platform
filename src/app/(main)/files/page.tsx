import { requireAuth } from "@/lib/permissions"
import { FileExplorerPanel } from "@/components/file-explorer/file-explorer-panel"
import { Home, HardDrive, Server, FolderOpen } from "lucide-react"
import { StatCard } from "@/components/shared/confirm"
import { promises as fsp } from "fs"
import path from "path"
import { ENV } from "@/lib/env"
import { dirSize } from "@/lib/file-explorer"

// ============================================================
// 我的文件（r28 用户空间）：用户专属空间文件管理器
// 编辑器（MD/TXT/HTML）/ 预览 / 上传下载（限速）/ 分享链接
// ============================================================
export const metadata = { title: "我的文件" }

export default async function MyFilesPage() {
  const ctx = await requireAuth()
  const home = path.join(ENV.storageLocalPath, "home", ctx.userId)
  const usedBytes = await dirSize(home).catch(() => 0)
  const fileCount = await countFiles(home)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">我的文件</h1>
        <p className="text-sm text-muted-foreground mt-1">
          您的专属文件空间（编辑器 / 预览 / 上传下载 / 分享链接；上传下载受管理员限速策略管控）
        </p>
      </div>

      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2">
        <StatCard title="空间占用" value={fmtB(usedBytes)} sub="个人文件空间" icon={<FolderOpen className="h-4 w-4" />} />
        <StatCard title="文件数" value={fileCount} sub="全部类型" icon={<HardDrive className="h-4 w-4" />} />
      </div>

      <FileExplorerPanel
        initialDomain="HOME"
        domains={[{ key: "HOME", label: "我的空间", icon: <Home className="h-3.5 w-3.5" /> }]}
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
