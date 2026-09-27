import Link from "next/link"
import { db } from "@/lib/db"
import { requireAuth } from "@/lib/permissions"
import { getConfigNumber, getConfigBool } from "@/lib/config"
import { fmtBytes } from "@/lib/utils-server"
import { StatCard } from "@/components/shared/confirm"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Badge } from "@/components/ui/badge"
import { Globe, HardDrive, Camera, KeyRound, UserCog } from "lucide-react"
import { ProfileForm } from "./profile-form"

// 个人资料：显示名 / 界面偏好（主题、每页条数）+ 个人配额仪表盘 + 个人统计
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
  ])

  // 无个人配额时回退全局默认上限
  const sessionsMax = quota.sessions ?? defaultSessions
  const novncMax = quota.novncSessions ?? defaultNovnc
  const diskMaxMb = quota.diskMb ?? defaultDiskMb
  const diskUsedMb = diskUsedBytes / (1024 * 1024)

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
      title: "磁盘配额",
      used: Number(diskUsedMb.toFixed(1)),
      max: diskMaxMb,
      label: `${fmtBytes(diskUsedBytes)} / ${diskMaxMb} MB`,
      pct: Math.min(100, Math.round((diskUsedMb / Math.max(diskMaxMb, 1)) * 100)),
      hint: quota.diskMb !== undefined ? "个人专属配额" : "跟随全局默认上限",
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
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard title="累计创建会话" value={totalSessions} sub="含已结束/已删除" icon={<Globe className="h-4 w-4" />} />
        <StatCard title="当前活跃" value={activeSessions + activeNovnc} sub={`CDP ${activeSessions} · NoVNC ${activeNovnc}`} icon={<Globe className="h-4 w-4" />} tone="success" />
        <StatCard title="快照数量" value={snapshotCount} sub="浏览器配置快照" icon={<Camera className="h-4 w-4" />} />
        <StatCard title="API 令牌数" value={tokenCount} sub="未删除的有效令牌" icon={<KeyRound className="h-4 w-4" />} />
      </div>

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

      {/* 账号信息只读摘要 */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <UserCog className="h-4 w-4" /> 账号信息
          </CardTitle>
          <CardDescription>账号安全相关字段为只读，如需变更请前往账号安全页</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 text-sm">
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
