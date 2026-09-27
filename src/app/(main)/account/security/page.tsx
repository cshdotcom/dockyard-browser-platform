import { db } from "@/lib/db"
import { requireAuth, needs2faSetup } from "@/lib/permissions"
import { countUnusedBackupCodes } from "@/lib/totp"
import { getConfigBool } from "@/lib/config"
import { fmtDate } from "@/lib/utils-server"
import { SecurityTabs, type SecurityTabData } from "./security-tabs"

export const metadata = { title: "账号安全" }

export default async function SecurityPage({
  searchParams,
}: {
  searchParams: Promise<{ force2fa?: string; mustChange?: string }>
}) {
  const ctx = await requireAuth()
  const sp = await searchParams
  const forced = (sp.force2fa === "1" || (await needs2faSetup())) && sp.force2fa !== "0"
  const mustChange = sp.mustChange === "1"

  const [user, backupCount, securityEvents] = await Promise.all([
    db.user.findUnique({ where: { id: ctx.userId } }),
    countUnusedBackupCodes(ctx.userId),
    db.securityEvent.findMany({
      where: { userId: ctx.userId },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
  ])

  const trustedDevices = await db.trustedDevice.findMany({
    where: { userId: ctx.userId, revokedAt: null },
    orderBy: { lastUsedAt: "desc" },
  })

  const data: SecurityTabData = {
    username: ctx.username,
    email: user?.email ?? null,
    emailVerified: user?.emailVerified ?? false,
    twoFactorEnabled: user?.twoFactorEnabled ?? false,
    backupCodeCount: backupCount,
    trustedDevices: trustedDevices.map((d) => ({
      id: d.id,
      label: d.label ?? "未知设备",
      ua: (d.ua ?? "").slice(0, 80),
      ip: d.ip ?? "-",
      lastUsed: fmtDate(d.lastUsedAt),
      expiresAt: fmtDate(d.expiresAt),
    })),
    events: securityEvents.map((e) => ({
      id: e.id,
      eventType: e.eventType,
      success: e.success,
      detail: e.detail ?? "",
      ip: e.ip ?? "-",
      createdAt: fmtDate(e.createdAt),
    })),
    hasPassword: !!user?.passwordHash,
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">账号安全</h1>
        <p className="text-sm text-muted-foreground mt-1">双因素认证、密码、邮箱绑定与安全日志管理</p>
      </div>

      {(forced || mustChange) && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/40 p-4 text-sm text-amber-800 dark:text-amber-200">
          {forced
            ? "管理员已对您的账号强制开启双因素认证策略：请完成 2FA 设置后才能正常使用平台全部功能。"
            : "安全策略要求您立即修改初始密码后再继续操作。"}
        </div>
      )}

      <SecurityTabs data={data} force2fa={forced} />
    </div>
  )
}
