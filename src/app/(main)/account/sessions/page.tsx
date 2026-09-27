import { db } from "@/lib/db"
import { requireAuth } from "@/lib/permissions"
import { parseListQuery, pageSkipTake, safeOrderBy, fmtDate } from "@/lib/utils-server"
import { countUnusedBackupCodes } from "@/lib/totp"
import { StatCard } from "@/components/shared/confirm"
import { MonitorSmartphone, ShieldCheck, LogOut, Clock } from "lucide-react"
import { SessionsTabs } from "./sessions-tabs"
import { SessionsTable, type SessionRow } from "./sessions-table"
import { DevicesTable, type TrustedDeviceRow } from "./devices-table"

// 登录设备管理（用户自助）：我的登录会话 + 受信任设备
// UA 解析：Chrome / Firefox / Edg / Safari / 浏览器与 OS 摘要（简单正则）
export const metadata = { title: "登录设备管理" }

function parseUa(ua: string | null): { browser: string; os: string } {
  const s = ua || ""
  let browser = "未知浏览器"
  if (/Edg\//.test(s)) browser = "Edge"
  else if (/OPR\//.test(s)) browser = "Opera"
  else if (/Chrome\//.test(s)) browser = "Chrome"
  else if (/Firefox\//.test(s)) browser = "Firefox"
  else if (/Safari\//.test(s) && /Version\//.test(s)) browser = "Safari"
  else if (/curl/i.test(s)) browser = "curl"
  else if (/python-requests/i.test(s)) browser = "Python"

  let os = "未知系统"
  if (/Windows NT/.test(s)) os = "Windows"
  else if (/Mac OS X|Macintosh/.test(s)) os = "macOS"
  else if (/Android/.test(s)) os = "Android"
  else if (/(iPhone|iPad|iOS)/.test(s)) os = "iOS"
  else if (/Linux/.test(s)) os = "Linux"

  return { browser, os }
}

export default async function SessionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const ctx = await requireAuth()
  const sp = await searchParams
  const q = parseListQuery(sp)
  const f = q.filters
  const tab = sp.tab === "devices" ? "devices" : "sessions"

  // ---- 登录会话列表 ----
  const where: Record<string, unknown> = { userId: ctx.userId }
  if (f.state === "active") {
    where.revokedAt = null
    where.expiresAt = { gt: new Date() }
  } else if (f.state === "revoked") {
    where.revokedAt = { not: null }
  }

  const [rows, total, activeCount, trustedCount, backupCodes] = await Promise.all([
    db.loginSession.findMany({
      where,
      ...pageSkipTake(q),
      orderBy: safeOrderBy(q, ["createdAt", "lastActiveAt", "expiresAt"], { createdAt: "desc" }),
    }),
    db.loginSession.count({ where }),
    db.loginSession.count({ where: { userId: ctx.userId, revokedAt: null, expiresAt: { gt: new Date() } } }),
    db.trustedDevice.count({ where: { userId: ctx.userId, revokedAt: null, expiresAt: { gt: new Date() } } }),
    countUnusedBackupCodes(ctx.userId),
  ])

  const sessions: SessionRow[] = rows.map((s) => {
    const { browser, os } = parseUa(s.userAgent)
    const isCurrent = s.id === ctx.loginSessionId
    const expired = !s.revokedAt && s.expiresAt <= new Date()
    return {
      id: s.id,
      ip: s.ip || "-",
      browser,
      os,
      deviceLabel: s.deviceLabel || `${browser} · ${os}`,
      trusted: s.trusted,
      isCurrent,
      rememberMe: s.rememberMe,
      revoked: !!s.revokedAt,
      revokedReason: s.revokedReason || null,
      expired,
      expiresAt: fmtDate(s.expiresAt),
      lastActiveAt: fmtDate(s.lastActiveAt),
      createdAt: fmtDate(s.createdAt),
    }
  })

  // ---- 受信任设备页签数据 ----
  let devices: TrustedDeviceRow[] = []
  let devicesTotal = 0
  if (tab === "devices") {
    const dw: Record<string, unknown> = { userId: ctx.userId }
    if (f.dstate === "active") {
      dw.revokedAt = null
      dw.expiresAt = { gt: new Date() }
    } else if (f.dstate === "revoked") {
      dw.revokedAt = { not: null }
    }
    const [dRows, dTotal] = await Promise.all([
      db.trustedDevice.findMany({
        where: dw,
        ...pageSkipTake(q),
        orderBy: safeOrderBy(q, ["createdAt", "lastUsedAt", "expiresAt"], { createdAt: "desc" }),
      }),
      db.trustedDevice.count({ where: dw }),
    ])
    devicesTotal = dTotal
    devices = dRows.map((d) => {
      const { browser, os } = parseUa(d.ua)
      return {
        id: d.id,
        label: d.label || `${browser} · ${os}`,
        browser,
        os,
        ip: d.ip || "-",
        revoked: !!d.revokedAt,
        expired: d.expiresAt <= new Date(),
        expiresAt: fmtDate(d.expiresAt),
        lastUsedAt: fmtDate(d.lastUsedAt),
        createdAt: fmtDate(d.createdAt),
      }
    })
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">登录设备管理</h1>
        <p className="text-sm text-muted-foreground mt-1">
          查看当前账号的登录会话与受信任设备，可随时踢出可疑设备（撤销后对应设备立即登出）
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard title="活跃会话" value={activeCount} sub="含当前设备" icon={<MonitorSmartphone className="h-4 w-4" />} />
        <StatCard title="受信任设备" value={trustedCount} sub="免 2FA 直接登录" icon={<ShieldCheck className="h-4 w-4" />} tone="success" />
        <StatCard
          title="剩余 2FA 备份码"
          value={backupCodes}
          sub={backupCodes === 0 ? "暂无备份码或已用尽，请前往账号安全页生成" : "紧急情况下可替代 TOTP 验证码"}
          icon={<Clock className="h-4 w-4" />}
          tone={backupCodes > 0 ? "default" : "warning"}
        />
        <StatCard title="历史会话总数" value={total} sub="含已下线记录" icon={<LogOut className="h-4 w-4" />} />
      </div>

      <SessionsTabs tab={tab}>
        {tab === "sessions" ? (
          <SessionsTable
            rows={sessions}
            total={total}
            page={q.page}
            pageSize={q.pageSize}
            keyword={q.keyword}
            sortField={q.sortField}
            sortOrder={q.sortOrder}
            filters={f}
          />
        ) : (
          <DevicesTable
            rows={devices}
            total={devicesTotal}
            page={q.page}
            pageSize={q.pageSize}
            keyword={q.keyword}
            sortField={q.sortField}
            sortOrder={q.sortOrder}
            filters={f}
            backupCodes={backupCodes}
          />
        )}
      </SessionsTabs>
    </div>
  )
}
