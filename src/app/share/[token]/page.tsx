import { promises as fsp } from "fs"
import path from "path"
import { db } from "@/lib/db"
import { getAuthContext } from "@/lib/permissions"
import { ENV } from "@/lib/env"
import { ShareBrowserPanel } from "./share-browser"

// ============================================================
// r31：分享链接落地页 /share/[token]（修复旧 404：分享创建返回的 URL 此前无对应页面）
//   PUBLIC  → 免登录可访问（直接预览/下载）
//   LOGIN   → 任意登录用户
//   USERS   → 指定用户 ∪ 用户组名单
// 文件 → 在线预览（图片/视频/音频/PDF/文本/Markdown）+ 下载
// 文件夹 → 目录浏览 + 搜索 + 多选 + 单文件预览下载 + 整夹/所选 zip 打包
// 过期/撤销/超限/未登录 → 明确状态页（不再裸 404/403 JSON）
// ============================================================

export const metadata = { title: "文件分享" }

export const dynamic = "force-dynamic"

function StatusPage({ icon, title, desc }: { icon: string; title: string; desc: string }) {
  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-slate-100 dark:from-slate-900 dark:to-slate-950 flex items-center justify-center p-6">
      <div className="w-full max-w-md rounded-2xl border bg-card p-8 text-center shadow-sm">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-muted text-2xl">{icon}</div>
        <h1 className="text-lg font-semibold">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground leading-relaxed">{desc}</p>
        <a href="/login" className="mt-6 inline-flex items-center rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90">
          前往登录
        </a>
      </div>
    </div>
  )
}

export default async function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  if (!/^[a-f0-9]{48}$/.test(token)) return <StatusPage icon="🔗" title="链接格式非法" desc="该分享链接的格式不正确，请向分享发起人确认完整链接。" />

  const link = await db.fileShareLink.findUnique({ where: { token } }).catch(() => null)
  if (!link) return <StatusPage icon="🔍" title="分享不存在" desc="该分享链接不存在（可能从未创建或已被物理清除）。" />
  if (link.revokedAt) return <StatusPage icon="⛔" title="分享已被撤销" desc="分享发起人或管理员已撤销该链接，内容不再可访问。" />
  if (link.expiresAt && link.expiresAt.getTime() < Date.now()) {
    return <StatusPage icon="⏰" title="分享已过期" desc={`该分享已于 ${link.expiresAt.toLocaleString("zh-CN")} 到期。请联系分享发起人延期。`} />
  }
  if (link.maxViews && link.viewCount >= link.maxViews) {
    return <StatusPage icon="👁" title="查看次数已达上限" desc={`该分享的查看次数已用尽（上限 ${link.maxViews} 次）。`} />
  }

  // ---- 权限模式 ----
  if (link.accessMode !== "PUBLIC") {
    const viewer = await getAuthContext().catch(() => null)
    if (!viewer) {
      return <StatusPage icon="🔐" title="该分享需要登录后访问" desc="分享发起人将此链接设置为「登录可见」。请登录后回到本链接继续访问（登录后会自动跳回）。" />
    }
    if (link.accessMode === "USERS") {
      const isAdmin = viewer.role === "SUPER_ADMIN" || viewer.role === "ADMIN"
      const allow = (link.allowedUsers as { userIds?: string[]; groupIds?: string[] } | null) || {}
      const inUsers = (allow.userIds || []).includes(viewer.userId)
      let inGroups = false
      if ((allow.groupIds || []).length > 0) {
        inGroups = !!(await db.groupUser.findFirst({ where: { userId: viewer.userId, groupId: { in: allow.groupIds! } }, select: { id: true } }))
      }
      if (!isAdmin && viewer.userId !== link.ownerUserId && !inUsers && !inGroups) {
        return <StatusPage icon="🚫" title="您不在该分享的授权名单中" desc="分享发起人未将您的账号或所在用户组加入授权名单。请联系发起人补充授权。" />
      }
    }
  }

  // ---- 解析分享目标 ----
  const owner = await db.user.findUnique({ where: { id: link.ownerUserId }, select: { username: true, displayName: true } })
  const home = path.join(ENV.storageLocalPath, "home", link.ownerUserId)
  const rootAbs = (link.domain === "HOME" ? path.resolve(home, link.filePath) : path.resolve(path.resolve(ENV.storageLocalPath), link.filePath))
  const st = await fsp.stat(rootAbs).catch(() => null)
  if (!st) {
    return <StatusPage icon="🗑" title="分享文件已不存在" desc="分享指向的文件已被移动或删除。请联系分享发起人。" />
  }

  const isDir = st.isDirectory()
  const sizeBytes = isDir ? link.sizeBytes : st.size

  return (
    <ShareBrowserPanel
      token={token}
      share={{
        fileName: link.fileName,
        isDir,
        sizeBytes,
        accessMode: link.accessMode,
        expiresAt: link.expiresAt?.toISOString() || null,
        maxViews: link.maxViews,
        maxDownloads: link.maxDownloads,
        viewCount: link.viewCount,
        downloadCount: link.downloadCount,
        note: link.note,
        ownerName: owner?.displayName || owner?.username || "未知用户",
        createdAt: link.createdAt.toISOString(),
        targetUsers: ((link.allowedUsers as { userIds?: string[] } | null)?.userIds || []).length,
        targetGroups: ((link.allowedUsers as { groupIds?: string[] } | null)?.groupIds || []).length,
      }}
    />
  )
}
