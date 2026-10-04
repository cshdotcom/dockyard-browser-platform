import Link from "next/link"
import { db } from "@/lib/db"
import { requireAuth } from "@/lib/permissions"
import { getConfigNumber } from "@/lib/config"
import { fmtBytes } from "@/lib/utils-server"
import { getStorageOverview } from "@/lib/storage-quota"
import { resolveTtlPolicyForUser, fmtTtlMinutes } from "@/lib/ttl-policy"
import { resolveIdlePolicyForUser, fmtIdleMinutes } from "@/lib/idle-policy"
import { StatCard } from "@/components/shared/confirm"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Badge } from "@/components/ui/badge"
import { Globe, HardDrive, Camera, KeyRound, UserCog, Database, Video, Image as ImageIcon, FolderOpen, Timer, Hourglass } from "lucide-react"
import { ProfileForm } from "./profile-form"
import { AvatarCard } from "./avatar-card"

// 个人资料：显示名 / 界面偏好（主题、每页条数）+ 个人配额仪表盘 + r33 存储与策略总览（管理员分配的全部配置 + 当前用量）
export const metadata = { title: "个人资料" }

export default async function ProfilePage() {
  const ctx = await requireAuth()
  const user = await db.user.findUnique({ where: { id: ctx.userId } })
  if (!user) return null

  const activeStatus = { status: { in: ["RUNNING", "CREATING", "IDLE"] }, deletedAt: null }

  // 个人配额与已用量
  const quota = (user.quota as Record<string, number> | null) || {}
  const [
    activeSessions,
    activeNovnc,
    diskUsedBytes,
    totalSessions,
    snapshotCount,
    tokenCount,
    defaultSessions,
    defaultNovnc,
    defaultDiskMb,
    storageOverview,
    ttlPolicy,
    idlePolicy,
  ] = await Promise.all([
    db.browserWorkspace.count({ where: { userId: ctx.userId, mode: "cdp_light", ...activeStatus } }),
    db.browserWorkspace.count({ where: { userId: ctx.userId, mode: "novnc_full", ...activeStatus } }),
    db.fileMeta
      .aggregate({ where: { userId: ctx.userId, deletedAt: null }, _sum: { size: true } })
      .then((r) => r._sum.size || 0),
    db.browserWorkspace.count({ where: { userId: ctx.userId, deletedAt: null } }),
    db.browserProfileSnapshot.count({ where: { userId: ctx.userId, deletedAt: null } }),
    db.apiToken.count({ where: { userId: ctx.userId, deletedAt: null } }),
    getConfigNumber("workspace.maxConcurrentSessions", 50),
    getConfigNumber("workspace.maxConcurrentNovnc", 20),
    getConfigNumber("storage.quotaPerUserMb", 2048),
    getStorageOverview(ctx.userId),
    resolveTtlPolicyForUser(ctx.userId),
    resolveIdlePolicyForUser(ctx.userId, ctx.role),
  ])

  // 无个人配额时回退全局默认上限
  const sessionsMax = quota.sessions ?? defaultSessions
  const novncMax = quota.novncSessions ?? defaultNovnc
  const diskUsedMb = diskUsedBytes / (1024 * 1024)

  // r33：存储配额统一口径（用户 > 组 > 全局三级链；旧 quota.diskMb 仅作回退显示）
  const stTotalMb = storageOverview.policy.totalMb > 0 ? storageOverview.policy.totalMb : (quota.diskMb ?? defaultDiskMb)
  const quotaCards = [
    {
      title: "CDP 会话配额",
      used: activeSessions,
      max: sessionsMax,
      label: `${activeSessions} / ${sessionsMax}`,
      pct: Math.min(100, Math.round((activeSessions / Math.max(sessionsMax, 1)) * 100)),
      hint: quota.sessions !== undefined ? "个人专属配额" : "跟随全局默认上限",
    },
    {
      title: "NoVNC 会话配额",
      used: activeNovnc,
      max: novncMax,
      label: `${activeNovnc} / ${novncMax}`,
      pct: Math.min(100, Math.round((activeNovnc / Math.max(novncMax, 1)) * 100)),
      hint: quota.novncSessions !== undefined ? "个人专属配额" : "跟随全局默认上限",
    },
    {
      title: "存储配额（录像+截图+云盘）",
      used: Number(storageOverview.usage.totalMb.toFixed(1)),
      max: stTotalMb,
      label: `${fmtBytes(storageOverview.usage.totalMb * 1024 * 1024)} / ${stTotalMb > 0 ? `${(stTotalMb / 1024).toFixed(2)}GB` : "不限"}`,
      pct: stTotalMb > 0 ? Math.min(100, Math.round((storageOverview.usage.totalMb / stTotalMb) * 100)) : 0,
      hint: storageOverview.policy.sourceLabel,
    },
  ]

  const prefs = (user.preferences as Record<string, unknown>) || {}
  const theme = (typeof prefs.theme === "string" ? prefs.theme : "system") as "light" | "dark" | "system"
  const pageSize = typeof prefs.pageSize === "number" ? (prefs.pageSize as number) : 20

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">个人资料</h1>
        <p className="text-sm text-muted-foreground mt-1">维护显示名与界面偏好，查看个人资源配额使用情况</p>
      </div>

      {/* 个人统计 */}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard title="累计创建会话" value={totalSessions} sub="含已结束/已删除" icon={<Globe className="h-4 w-4" />} />
        <StatCard title="当前活跃" value={activeSessions + activeNovnc} sub={`CDP ${activeSessions} · NoVNC ${activeNovnc}`} icon={<Globe className="h-4 w-4" />} tone="success" />
        <StatCard title="快照数量" value={snapshotCount} sub="浏览器配置快照" icon={<Camera className="h-4 w-4" />} />
        <StatCard title="API 令牌数" value={tokenCount} sub="未删除的有效令牌" icon={<KeyRound className="h-4 w-4" />} />
      </div>

      {/* 头像上传（独立空间存储） */}
      <AvatarCard
        userId={ctx.userId}
        name={user.displayName || user.username}
        hasAvatar={!!user.avatarPath}
      />

      {/* 资料表单 */}
      <ProfileForm
        username={user.username}
        displayName={user.displayName || ""}
        email={user.email || ""}
        emailVerified={user.emailVerified}
        theme={theme}
        pageSize={pageSize}
        role={user.role}
      />

      {/* 配额仪表盘 */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <HardDrive className="h-4 w-4" /> 个人配额仪表盘
          </CardTitle>
          <CardDescription>
            已用 / 上限实时对比；个人配额由管理员设定，未设定时跟随全局默认
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6 md:grid-cols-3">
          {quotaCards.map((c) => (
            <div key={c.title} className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">{c.title}</p>
                <Badge variant="outline" className="text-[10px]">{c.hint}</Badge>
              </div>
              <Progress
                value={c.pct}
                className="h-2.5"
                aria-label={`${c.title}使用 ${c.pct}%`}
              />
              <p className="text-xs text-muted-foreground tabular-nums flex justify-between">
                <span>{c.label}</span>
                <span className={c.pct >= 90 ? "text-red-600 font-medium" : c.pct >= 70 ? "text-orange-600" : ""}>
                  {c.pct}%{c.pct >= 90 ? "（接近上限）" : ""}
                </span>
              </p>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* r33：存储与配额总览 —— 管理员为个人（或所属组）分配的全部存储配置 + 当前用量明细 */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Database className="h-4 w-4" /> 存储与配额
          </CardTitle>
          <CardDescription>
            录像、截图与云盘文件统一计入个人存储配额（来源：{storageOverview.policy.sourceLabel}）；功能开关与分类限额由管理员分配
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* 总量进度条 */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">总用量</p>
              <span className="text-xs text-muted-foreground tabular-nums">
                {fmtBytes(storageOverview.usage.totalMb * 1024 * 1024)} / {stTotalMb > 0 ? `${(stTotalMb / 1024).toFixed(2)}GB` : "不限"}
                {storageOverview.pct != null && ` · ${storageOverview.pct}%`}
              </span>
            </div>
            {stTotalMb > 0 && (
              <Progress value={storageOverview.pct ?? 0} className="h-2.5" aria-label={`存储已用 ${storageOverview.pct ?? 0}%`} />
            )}
          </div>
          {/* 分类明细 */}
          <div className="grid gap-3 grid-cols-1 sm:grid-cols-3">
            <div className="rounded-lg border p-3 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium flex items-center gap-1.5"><Video className="h-3.5 w-3.5 text-teal-600" /> 录像</span>
                <Badge variant="outline" className="text-[10px]">
                  {storageOverview.policy.recordingAllowed ? (storageOverview.policy.category.recordingMb != null ? `限 ${(storageOverview.policy.category.recordingMb / 1024).toFixed(1)}GB` : "不限") : "已禁用"}
                </Badge>
              </div>
              <p className="text-sm tabular-nums font-medium">{fmtBytes(storageOverview.usage.recordingMb * 1024 * 1024)}</p>
              <p className="text-[11px] text-muted-foreground">{storageOverview.usage.recordingCount} 段 · 录屏计入配额</p>
            </div>
            <div className="rounded-lg border p-3 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium flex items-center gap-1.5"><ImageIcon className="h-3.5 w-3.5 text-blue-600" /> 截图</span>
                <Badge variant="outline" className="text-[10px]">
                  {storageOverview.policy.screenshotAllowed ? (storageOverview.policy.category.screenshotMb != null ? `限 ${(storageOverview.policy.category.screenshotMb / 1024).toFixed(1)}GB` : "不限") : "已禁用"}
                </Badge>
              </div>
              <p className="text-sm tabular-nums font-medium">{fmtBytes(storageOverview.usage.screenshotMb * 1024 * 1024)}</p>
              <p className="text-[11px] text-muted-foreground">{storageOverview.usage.screenshotCount} 张 · 截图计入配额</p>
            </div>
            <div className="rounded-lg border p-3 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium flex items-center gap-1.5"><FolderOpen className="h-3.5 w-3.5 text-amber-600" /> 云盘文件</span>
                <Badge variant="outline" className="text-[10px]">
                  {storageOverview.policy.uploadAllowed ? (storageOverview.policy.category.fileMb != null ? `限 ${(storageOverview.policy.category.fileMb / 1024).toFixed(1)}GB` : "不限") : "上传已禁"}
                </Badge>
              </div>
              <p className="text-sm tabular-nums font-medium">{fmtBytes(storageOverview.usage.fileMb * 1024 * 1024)}</p>
              <p className="text-[11px] text-muted-foreground">{storageOverview.usage.fileCount} 个文件</p>
            </div>
          </div>
          {/* 会话时长与闲置策略（管理员为本人/组分配） */}
          <div className="grid gap-3 grid-cols-1 sm:grid-cols-2">
            <div className="rounded-lg border p-3 flex items-start gap-2.5">
              <Timer className="h-4 w-4 mt-0.5 text-muted-foreground" />
              <div className="min-w-0">
                <p className="text-xs font-medium">沙箱最大时长（{ttlPolicy.sourceLabel}）</p>
                <p className="text-sm font-medium">{ttlPolicy.maxTtlMinutes > 0 ? fmtTtlMinutes(ttlPolicy.maxTtlMinutes) : "不限"}</p>
                <p className="text-[11px] text-muted-foreground">
                  {ttlPolicy.allowUnlimited ? "创建时可选「无限时长」" : "管理员已禁止「无限时长」：创建时必须选择有限时长"}
                </p>
              </div>
            </div>
            <div className="rounded-lg border p-3 flex items-start gap-2.5">
              <Hourglass className="h-4 w-4 mt-0.5 text-muted-foreground" />
              <div className="min-w-0">
                <p className="text-xs font-medium">闲置自动回收（{idlePolicy.defaultSourceLabel}）</p>
                <p className="text-sm font-medium">{fmtIdleMinutes(idlePolicy.defaultMinutes)}</p>
                <p className="text-[11px] text-muted-foreground">
                  超时未操作的沙箱将被自动回收；配置/Profile 保留可重启{idlePolicy.locked ? " · 管理员已锁定不可自行调整" : ""}
                </p>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 text-[11px] text-muted-foreground">
            <Link href="/files" className="underline">管理我的文件（含录像/截图）</Link>
            <Link href="/recordings" className="underline">我的录像（更多→在文件管理中打开）</Link>
          </div>
        </CardContent>
      </Card>

      {/* 账号信息只读摘要 */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <UserCog className="h-4 w-4" /> 账号信息
          </CardTitle>
          <CardDescription>账号安全相关字段为只读，如需变更请前往账号安全页</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 grid-cols-1 sm:grid-cols-2 text-sm">
          <div className="flex justify-between sm:block">
            <span className="text-muted-foreground">用户名</span>
            <p className="font-medium font-mono">{user.username}</p>
          </div>
          <div className="flex justify-between sm:block">
            <span className="text-muted-foreground">角色</span>
            <p className="font-medium">{user.role === "SUPER_ADMIN" ? "超级管理员" : user.role === "ADMIN" ? "管理员" : user.role === "GROUP_ADMIN" ? "组管理员" : "普通用户"}</p>
          </div>
          <div className="flex justify-between sm:block">
            <span className="text-muted-foreground">注册时间</span>
            <p className="font-medium">{user.createdAt.toISOString().slice(0, 10)}</p>
          </div>
          <div className="flex justify-between sm:block">
            <span className="text-muted-foreground">最近登录</span>
            <p className="font-medium">{user.lastLoginIp || "—"}</p>
          </div>
          {user.twoFactorEnabled && (
            <div className="sm:col-span-2">
              <Link href="/account/security" className="text-teal-600 underline text-xs">
                已开启双因素认证 → 前往账号安全管理
              </Link>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
