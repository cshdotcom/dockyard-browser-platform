import Link from "next/link"
import { db } from "@/lib/db"
import { requireAuth } from "@/lib/permissions"
import { getConfig, getConfigNumber } from "@/lib/config"
import { fmtDate } from "@/lib/utils-server"
import { getStorageOverview } from "@/lib/storage-quota"
import { StatCard } from "@/components/shared/confirm"
import { StatusBadge } from "@/components/shared/data-table"
import { TrendChart } from "./trend-chart"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Globe, Server, Megaphone, Bell, Activity, Cpu, Database } from "lucide-react"

export const metadata = { title: "仪表盘" }

export default async function DashboardPage() {
  const ctx = await requireAuth()
  const isAdmin = ctx.role === "SUPER_ADMIN" || ctx.role === "ADMIN"

  const activeStatus = { status: { in: ["RUNNING", "CREATING", "IDLE"] }, deletedAt: null }

  const [myWorkspaces, globalActive, novncActive, singboxRunning, pendingAlerts, totalUsers, singboxes, recentAudit] = await Promise.all([
    db.browserWorkspace.count({ where: { userId: ctx.userId, ...activeStatus } }),
    db.browserWorkspace.count({ where: activeStatus }),
    db.browserWorkspace.count({ where: { mode: "novnc_full", ...activeStatus } }),
    db.singboxInstance.count({ where: { status: "RUNNING", deletedAt: null } }),
    db.alert.count({ where: { handleStatus: "PENDING" } }),
    db.user.count({ where: { deletedAt: null } }),
    db.singboxInstance.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { id: true, name: true, status: true, cpuLimit: true, memLimitMb: true, currentSessions: true, maxSessions: true },
    }),
    db.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: 8, select: { id: true, operationType: true, resourceType: true, operatorName: true, createdAt: true, severity: true } }),
  ])

  // 近7天创建趋势
  const days: { day: string; sessions: number; vnc: number }[] = []
  for (let i = 6; i >= 0; i--) {
    const start = new Date(Date.now() - i * 86400_000)
    start.setHours(0, 0, 0, 0)
    const end = new Date(start.getTime() + 86400_000)
    const [c, v] = await Promise.all([
      db.browserWorkspace.count({ where: { createdAt: { gte: start, lt: end } } }),
      db.browserWorkspace.count({ where: { mode: "novnc_full", createdAt: { gte: start, lt: end } } }),
    ])
    days.push({ day: `${start.getMonth() + 1}/${start.getDate()}`, sessions: c, vnc: v })
  }

  const siteName = await getConfig<string>("ui.siteName", "Dockyard")
  const myQuota = await getConfigNumber("workspace.maxConcurrentSessions", 50)
  // r33：个人存储用量（录像+截图+云盘统一口径；三级策略链解析）
  const storageOverview = await getStorageOverview(ctx.userId)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">仪表盘</h1>
        <p className="text-sm text-muted-foreground mt-1">
          欢迎回来，{ctx.displayName || ctx.username} · {siteName}
        </p>
      </div>

      <div className="grid gap-4 grid-cols-1 min-[420px]:grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 min-w-0">
        <StatCard title="我的活跃工作区" value={myWorkspaces} sub="CDP + NoVNC 运行中" icon={<Globe className="h-4 w-4" />} />
        <StatCard title="平台活跃工作区" value={isAdmin ? globalActive : "—"} sub={isAdmin ? "全部用户合计" : "仅管理员可见"} icon={<Activity className="h-4 w-4" />} />
        <StatCard title="NoVNC 重度会话" value={isAdmin ? novncActive : "—"} sub={isAdmin ? "全局运行中" : "仅管理员可见"} icon={<Globe className="h-4 w-4" />} tone="warning" />
        <StatCard
          title="待处理告警"
          value={isAdmin ? pendingAlerts : "—"}
          sub={isAdmin ? "告警中心待处理" : "仅管理员可见"}
          icon={<Bell className="h-4 w-4" />}
          tone={isAdmin && pendingAlerts > 0 ? "danger" : "default"}
        />
      </div>

      <div className="grid gap-4 grid-cols-1 lg:grid-cols-3 min-w-0">
        <div className="lg:col-span-2 space-y-4 min-w-0">
          <TrendChart data={days} />
          {/* r33：个人存储与配额概览（仪表盘直达；管理员为个人/组分配的配置与当前用量） */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Database className="h-4 w-4" /> 我的存储与配额
              </CardTitle>
              <CardDescription>
                录像 · 截图 · 云盘文件统一计量（来源：{storageOverview.policy.sourceLabel}）
                {!storageOverview.policy.storageEnabled && " · 存储类功能已被管理员停用"}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium">{storageOverview.pct != null ? `已用 ${storageOverview.pct}%` : "当前用量"}</span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {(storageOverview.usage.totalMb / 1024).toFixed(2)}GB
                  {storageOverview.policy.totalMb > 0 ? ` / ${(storageOverview.policy.totalMb / 1024).toFixed(2)}GB` : "（不限）"}
                </span>
              </div>
              {storageOverview.policy.totalMb > 0 && (
                <Progress value={storageOverview.pct ?? 0} className="h-2" aria-label={`存储已用 ${storageOverview.pct ?? 0}%`} />
              )}
              <div className="grid grid-cols-3 gap-2 text-center text-xs">
                <div className="rounded-md border p-2">
                  <p className="text-muted-foreground">录像</p>
                  <p className="font-medium tabular-nums">{(storageOverview.usage.recordingMb / 1024).toFixed(2)}GB · {storageOverview.usage.recordingCount}段</p>
                </div>
                <div className="rounded-md border p-2">
                  <p className="text-muted-foreground">截图</p>
                  <p className="font-medium tabular-nums">{(storageOverview.usage.screenshotMb / 1024).toFixed(2)}GB · {storageOverview.usage.screenshotCount}张</p>
                </div>
                <div className="rounded-md border p-2">
                  <p className="text-muted-foreground">云盘文件</p>
                  <p className="font-medium tabular-nums">{(storageOverview.usage.fileMb / 1024).toFixed(2)}GB · {storageOverview.usage.fileCount}个</p>
                </div>
              </div>
              <div className="flex gap-3 text-xs text-muted-foreground">
                <Link href="/account/profile" className="underline">配置明细（时长/闲置/配额分配）</Link>
                <Link href="/files" className="underline">管理文件</Link>
              </div>
            </CardContent>
          </Card>
          {isAdmin && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Server className="h-4 w-4" /> SingBox 实例概览
                </CardTitle>
                <CardDescription>
                  全局运行实例 {singboxRunning} 个 · 平台用户 {totalUsers} 人
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>实例名称</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead className="text-right">CPU限制</TableHead>
                      <TableHead className="text-right">内存限制</TableHead>
                      <TableHead className="text-right">会话占用</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {singboxes.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={5} className="text-center text-muted-foreground py-6">
                          暂无实例，<Link href="/admin/singbox" className="text-teal-600 underline">去创建第一个 SingBox 实例</Link>
                        </TableCell>
                      </TableRow>
                    )}
                    {singboxes.map((s) => (
                      <TableRow key={s.id}>
                        <TableCell className="font-medium">{s.name}</TableCell>
                        <TableCell><StatusBadge status={s.status} /></TableCell>
                        <TableCell className="text-right tabular-nums">{s.cpuLimit} 核</TableCell>
                        <TableCell className="text-right tabular-nums">{s.memLimitMb} MB</TableCell>
                        <TableCell className="text-right tabular-nums">{s.currentSessions}{s.maxSessions > 0 ? ` / ${s.maxSessions}` : ""}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </div>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">最近操作审计</CardTitle>
            <CardDescription>全平台最近业务操作（只读，不可篡改）</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {recentAudit.length === 0 && <p className="text-sm text-muted-foreground text-center py-8">暂无审计记录</p>}
            {recentAudit.map((a) => (
              <div key={a.id} className="flex items-start justify-between gap-2 border-b last:border-0 pb-2 last:pb-0">
                <div className="min-w-0">
                  <p className="text-sm truncate">
                    <StatusBadge status={a.severity} /> {a.operationType}
                  </p>
                  <p className="text-xs text-muted-foreground truncate">{a.operatorName || "系统"} · {a.resourceType}</p>
                </div>
                <span className="text-[10px] text-muted-foreground whitespace-nowrap">{fmtDate(a.createdAt)}</span>
              </div>
            ))}
            {isAdmin && (
              <Link href="/admin/audit" className="block text-xs text-teal-600 underline text-center pt-2">
                查看全部审计日志 →
              </Link>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
